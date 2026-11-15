"""Look closer at an exported part: one large view from any side, zoomed or cut open.

    uv run -m print3d.view projects/hooks/out/s_hook                  # iso view
    uv run -m print3d.view projects/hooks/out/s_hook --from back      # or left, right, top, bottom, front,
                                                                      # or a direction "x,y,z" the camera sits in
    uv run -m print3d.view <...> --at 10,0,25 --radius 8              # close-up of the 8 mm round a point
    uv run -m print3d.view <...> --cut x=0                            # cross-section at x=0 (also y=, z=)

The argument is an export's path without extension (out/<name>). Writes out/check/<name>_view.png,
or the path given with -o, and prints it. Multicolour exports are shown in their colours.
"""

import argparse
import json
from pathlib import Path

import trimesh

from .preview import render_view

DIRECTIONS = {
    "iso": (0.55, -1, 0.7), "front": (0, -1, 0), "back": (0, 1, 0), "left": (-1, 0, 0), "right": (1, 0, 0),
    "top": (0, 0, 1), "bottom": (0, 0, -1), "iso-back": (-0.55, 1, 0.7), "under": (0.55, -1, -0.8),
}


def load(base: Path) -> list[tuple[trimesh.Trimesh, str | None]]:
    """The export's pieces: its colour parts if it has them, else its STL(s)."""
    colors = base.parent / f"{base.name}_colors" / "colors.json"
    if colors.exists():
        return [(trimesh.load_mesh(colors.parent / c["stl"]), c["color"]) for c in json.loads(colors.read_text())]
    stls = [base.with_suffix(".stl")] if base.with_suffix(".stl").exists() else sorted(base.parent.glob(f"{base.name}_*.stl"))
    if not stls:
        raise SystemExit(f"no STL for {base}; give the export's path without extension, e.g. projects/x/out/part")
    if len(stls) == 1:
        return [(trimesh.load_mesh(stls[0]), None)]
    from .preview import side_by_side
    return [(side_by_side([trimesh.load_mesh(s) for s in stls]), None)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export", type=Path, help="projects/<project>/out/<name>, no extension")
    ap.add_argument("--from", dest="view", default="iso", help=f"{', '.join(DIRECTIONS)} or x,y,z")
    ap.add_argument("--at", help="x,y,z to centre a close-up on")
    ap.add_argument("--radius", type=float, help="mm shown round --at (default: a sixth of the part)")
    ap.add_argument("--cut", help="x=<mm>, y=<mm> or z=<mm>: show a cross-section there")
    ap.add_argument("-o", "--out", type=Path)
    args = ap.parse_args()

    base = args.export.with_suffix("") if args.export.suffix in (".stl", ".png", ".3mf", ".step") else args.export
    view = DIRECTIONS.get(args.view) or tuple(float(v) for v in args.view.split(","))
    section = None
    if args.cut:
        axis, value = args.cut.split("=")
        section = ("xyz".index(axis.strip().lower()), float(value))
        if args.view == "iso":  # look at the cut face, a little from above
            view = [(1, 0.3, 0.25), (-0.3, -1, 0.25), (0.4, -0.6, 1)][section[0]]
    focus = tuple(float(v) for v in args.at.split(",")) if args.at else None
    out = args.out or base.parent / "check" / f"{base.name}_view.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    title = " ".join(filter(None, [base.name, f"from {args.view}", args.at and f"at {args.at}", args.cut and f"cut {args.cut}"]))
    render_view(load(base), out, view=view, focus=focus, radius=args.radius, section=section, title=title)
    print(out)


if __name__ == "__main__":
    main()
