"""Build sliced Bambu Studio (or OrcaSlicer) project 3MFs for the Bambu A1.

The slicers' command lines don't resolve preset inheritance, so each preset is
flattened here (parent settings first, then the child's overrides) before it's
passed in.
"""

import json
import os
import re
import subprocess
import tempfile
import zipfile
from functools import cache
from pathlib import Path

SLICERS = {
    # Bambu Studio is the one in use; the flatpak keeps its user presets in ~/.var/app.
    "bambu": {
        "app": "com.bambulab.BambuStudio", "branch": "stable", "share": "BambuStudio",
        "user": next((Path.home() / ".var/app/com.bambulab.BambuStudio/config/BambuStudio/user").glob("[0-9]*"), None),
        "filament": "ELEGOO PLA Matte @Bambu Lab A1 {nozzle} nozzle",
    },
    # OrcaSlicer pinned to stable: the 2.5 alpha packs its profiles in a format this can't read.
    "orca": {
        "app": "com.orcaslicer.OrcaSlicer", "branch": "stable", "share": "OrcaSlicer",
        "user": Path.home() / ".var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer/user/default",
        "filament": "Elegoo PLA Matte @BBL A1",
    },
}
SLICER = "bambu"

NOZZLES = ("0.2", "0.4", "0.6", "0.8")  # what the A1 takes, mm
CONFIG = Path(__file__).resolve().parents[1] / "printer.json"  # {"nozzle": "0.6"}, at the repo root


def nozzle() -> str:
    """The nozzle fitted to the printer: PRINT3D_NOZZLE if set (for one run), else printer.json.
    Change it with `uv run -m print3d.nozzle 0.4` or in the app's sidebar."""
    value = os.environ.get("PRINT3D_NOZZLE")
    if not value:
        try:
            value = json.loads(CONFIG.read_text())["nozzle"]
        except (OSError, ValueError, KeyError):
            value = "0.4"  # what the A1 ships with
    value = f"{float(value):.1f}"
    if value not in NOZZLES:
        raise ValueError(f"nozzle {value!r} is not one of {', '.join(NOZZLES)}")
    return value


def set_nozzle(value: str) -> str:
    value = f"{float(value):.1f}"
    if value not in NOZZLES:
        raise ValueError(f"nozzle {value!r} is not one of {', '.join(NOZZLES)}")
    CONFIG.write_text(json.dumps({"nozzle": value}, indent=2) + "\n")
    return value


NOZZLE = nozzle()  # read once: every script run is a new process
LINE_WIDTH = float(NOZZLE) + 0.02  # mm, the slicer's default line for this nozzle
PRINTER = f"Bambu Lab A1 {NOZZLE} nozzle"
# A quality tier that every nozzle has; resolve_process() turns it into this nozzle's preset.
PROCESS = "Optimal"
FILAMENT = SLICERS[SLICER]["filament"].format(nozzle=NOZZLE)
PLATE = "Textured PEI Plate"  # the plate the A1 ships with; sets the bed temperature

# Project-level keys that aren't in process presets but the CLI accepts with them.
# Multicolour purge: "flush_multiplier": ["0.6"] scales every colour change's purge;
# "flush_volumes_matrix" (mm³, row = from slot, column = to slot) sets each pair.
PROJECT_KEYS = {"flush_multiplier", "flush_volumes_matrix"}


@cache
def _system_profiles(slicer: str) -> Path:
    app, branch = SLICERS[slicer]["app"], SLICERS[slicer]["branch"]
    loc = subprocess.run(["flatpak", "info", "--user", "--show-location", f"{app}//{branch}"],
                         capture_output=True, text=True, check=True).stdout.strip()
    return Path(loc) / "files/share" / SLICERS[slicer]["share"] / "profiles/BBL"


@cache
def _index(kind: str, slicer: str = SLICER) -> dict[str, Path]:
    """Map preset name -> file for one kind (machine, process, filament)."""
    found = {}
    roots = [_system_profiles(slicer) / kind]
    if SLICERS[slicer]["user"]:
        roots.append(SLICERS[slicer]["user"] / kind)
    for root in roots:
        for f in root.rglob("*.json"):
            try:
                found[json.loads(f.read_text())["name"]] = f
            except (KeyError, ValueError):
                pass
    return found


def flatten(kind: str, name: str, slicer: str = SLICER) -> dict:
    try:
        data = json.loads(_index(kind, slicer)[name].read_text())
    except KeyError:
        raise ValueError(f"no {kind} preset named {name!r} in {slicer}") from None
    parent = data.get("inherits")
    merged = flatten(kind, parent, slicer) if parent else {}
    merged.update(data)
    merged["name"] = name
    merged["type"] = kind  # user presets can lack it; the CLI needs it
    merged.pop("inherits", None)
    return merged


# "0.24mm Optimal @BBL A1 0.6 nozzle"; presets for the 0.4 nozzle have no nozzle suffix.
_PRESET = re.compile(r"^(\d\.\d+)mm (.+?) @BBL A1(?: (\d\.\d) nozzle)?$")


def process_presets(slicer: str = SLICER) -> dict[str, list[tuple[float, str, str]]]:
    """The A1's process presets by nozzle: {"0.6": [(0.24, "Optimal", full name), ...]}, thinnest first."""
    table: dict[str, list[tuple[float, str, str]]] = {n: [] for n in NOZZLES}
    for name in _index("process", slicer):
        if m := _PRESET.match(name):
            table.setdefault(m[3] or "0.4", []).append((float(m[1]), m[2], name))
    return {n: sorted(v) for n, v in table.items()}


def resolve_process(process: str | None, slicer: str = SLICER) -> tuple[str, str | None]:
    """The preset to slice with on the fitted nozzle, and a note if it isn't the one asked for.

    `process` can be a quality tier ("Fine", "Optimal", "Standard", "Draft", "Extra Draft":
    every nozzle has these), a preset without its nozzle ("0.24mm Optimal"), or a full
    preset name. A preset made for another nozzle is swapped for this nozzle's closest
    match: the same layer height relative to the nozzle, and the same tier if there is one.
    """
    process = (process or PROCESS).strip()
    table = process_presets(slicer)
    mine = table[NOZZLE]
    if not mine:
        raise ValueError(f"{slicer} has no process presets for the A1's {NOZZLE} mm nozzle")
    known = {name: (n, h, tier) for n, rows in table.items() for h, tier, name in rows}

    def closest(ratio: float, tier: str | None) -> str:
        return min(mine, key=lambda row: (round(abs(row[0] / float(NOZZLE) - ratio), 3), row[1] != tier))[2]

    if process in known:
        made_for, height, tier = known[process]
        if made_for == NOZZLE:
            return process, None
        chosen = closest(height / float(made_for), tier)
        return chosen, f"{process!r} is for a {made_for} mm nozzle; the printer has {NOZZLE} mm, so using {chosen!r}"
    if process in _index("process", slicer):
        return process, None  # a custom preset: taken as it is
    tiers = [row for row in mine if row[1].lower() == process.lower()]
    if tiers:  # some tiers come in several heights: take the middle of the road
        return min(tiers, key=lambda row: abs(row[0] / float(NOZZLE) - 0.4))[2], None
    for name, (made_for, height, tier) in known.items():
        if name.split(" @")[0].lower() == process.lower() or tier.lower() == process.lower():
            chosen = closest(height / float(made_for), tier)
            if name.split(" @")[0] == chosen.split(" @")[0]:
                return chosen, None
            return chosen, f"no {process!r} preset for the {NOZZLE} mm nozzle; using {chosen!r}"
    options = ", ".join(dict.fromkeys(row[1] for row in mine))
    raise ValueError(f"no process preset {process!r}. For the {NOZZLE} mm nozzle give a tier ({options}) "
                     f"or one of: {', '.join(row[2] for row in mine)}")


def make_project(stls: list[Path], out_3mf: Path, process: str | None = None,
                 filament: str = FILAMENT, settings: dict | None = None,
                 plate: str = PLATE, slicer: str = SLICER, colors: list[str] | None = None) -> dict:
    """Write a sliced A1 project 3MF holding `stls`, arranged on one plate.
    Returns the slice estimate, with the preset used as "process" (see resolve_process).

    `settings` overrides process values, e.g. {"wall_loops": "3",
    "sparse_infill_density": "15%", "enable_support": "0"}. Values are strings,
    as in the slicer's own preset files. `slicer` is "bambu" or "orca".

    `colors` ("#rrggbb", one per STL) makes a multicolour print for the AMS: the
    STLs are kept where they are and merged into one object, each part printed
    with a filament of its colour (one filament slot per distinct colour, in order).
    """
    app, branch = SLICERS[slicer]["app"], SLICERS[slicer]["branch"]
    if colors and len(colors) != len(stls):
        raise ValueError(f"{len(colors)} colours for {len(stls)} STLs; give one colour per STL")
    process, note = resolve_process(process, slicer)
    if note:
        print(f"note: {note}")
    proc = flatten("process", process, slicer)
    for key, value in (settings or {}).items():
        if key not in proc and key not in PROJECT_KEYS:
            raise ValueError(f"unknown process setting {key!r}")
        proc[key] = value
    proc["curr_bed_type"] = plate

    with tempfile.TemporaryDirectory(dir=out_3mf.parent) as tmp:
        tmp = Path(tmp)
        for kind, data in {"machine": flatten("machine", PRINTER, slicer), "process": proc}.items():
            (tmp / f"{kind}.json").write_text(json.dumps(data, indent=1))
        fil = flatten("filament", filament, slicer)
        slots = list(dict.fromkeys(c.upper() for c in colors)) if colors else [None]
        for i, color in enumerate(slots):
            (tmp / f"filament{i}.json").write_text(json.dumps(fil | ({"filament_colour": [color]} if color else {}), indent=1))
        multi = ["--load-filament-ids", ",".join(str(slots.index(c.upper()) + 1) for c in colors),
                 "--assemble"] if colors else []
        result = subprocess.run(
            ["flatpak", "run", f"--filesystem={tmp}", f"--filesystem={out_3mf.parent}",
             *{f"--filesystem={s.parent}" for s in stls}, f"--branch={branch}", app,
             "--load-settings", f"{tmp}/machine.json;{tmp}/process.json",
             "--load-filaments", ";".join(f"{tmp}/filament{i}.json" for i in range(len(slots))), *multi,
             "--arrange", "1", "--slice", "0", "--export-3mf", str(out_3mf),
             *map(str, stls)],
            capture_output=True, text=True, timeout=600, check=False,  # the return code is checked below
            cwd=tmp)  # the CLI drops result.json and logs in its working directory
    if result.returncode != 0 or not out_3mf.exists():
        log = (result.stdout + result.stderr).strip().splitlines()
        raise RuntimeError(f"{app} failed:\n" + "\n".join(log[-15:]))
    return _estimate(out_3mf) | {"process": process}


def _estimate(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        info = z.read("Metadata/slice_info.config").decode()
        warnings = re.findall(r'<warning msg="([^"]+)"', info)

    def get(key: str) -> str | None:
        m = re.search(rf'key="{key}" value="([^"]*)"', info)
        return m[1] if m else None

    seconds = int(float(get("prediction") or 0))
    return {"time": f"{seconds // 3600}h {seconds % 3600 // 60}m",
            "weight_g": float(get("weight") or 0), "warnings": warnings}
