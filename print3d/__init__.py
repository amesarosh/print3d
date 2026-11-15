"""Export, check and preview parts for printing on a Bambu A1.

Usage in a project script (projects/<project>/<name>.py):
    from print3d import export
    export(part, "bracket")
    export({"body": body, "lid": lid}, "case")  # several parts on one plate
    export(part, "bracket", draft=True)         # quick look while shaping: no slicing

Files go to the running script's own out/ folder (projects/<project>/out/):
<name>.png is the preview, check/<name>.png shows the back, underside and cross-sections.
"""

import json
import sys
from pathlib import Path

import numpy as np
import trimesh
from build123d import Compound, export_step, export_stl

from . import slicer
from .analyze import Analysis, analyze
from .preview import render, render_check, side_by_side


def out_dir() -> Path:
    """The out/ folder next to the script being run, created if needed."""
    out = Path(sys.modules["__main__"].__file__).resolve().parent / "out"
    out.mkdir(exist_ok=True)
    return out


BED = (256, 256, 256)  # Bambu A1 build volume, mm

# Slicer warnings that do not apply to an open-frame A1 with its stock textured plate.
HARMLESS_WARNINGS = {"not_support_traditional_timelapse", "bed_temperature_too_high_than_filament"}


def export(parts, name: str, process: str | None = None, filament: str = slicer.FILAMENT,
           settings: dict | None = None, colors: dict | None = None, draft: bool = False) -> Path:
    """Write STL(s), STEP, preview PNG and a sliced Bambu Studio project 3MF.

    `parts` is one build123d part, or a dict of {label: part} for multi-part
    prints. Each part must already be in its print orientation; the slicer
    arranges them on the plate. `process` is a quality tier ("Fine", "Optimal", "Standard",
    "Draft", "Extra Draft") or a preset name; it is matched to the nozzle fitted to the
    printer (slicer.resolve_process). `filament` is a preset name; `settings` overrides
    individual process values (see slicer.make_project).

    Multicolour (AMS): give `colors` as {label: "#rrggbb"} for every part. The
    parts then stay where they are and print as one object, each in its colour.
    `<name>.stl` is then the whole object fused into one solid (what the app shows
    and the check tests); the per-colour STLs go in `out/<name>_colors/`, with a
    colors.json listing each STL's colour for the app's 3D view.
    A part can also be a trimesh.Trimesh (a sculpt or a heightfield); those get no STEP.

    Besides the size and the check, each part gets printability notes (overhangs, places
    that start in mid-air, bed contact, thinnest wall), and `out/check/<name>.png` shows
    them with the back, the underside and two cross-sections.

    `draft=True` stops after the meshes and pictures: no STEP and no slicing, so a look at
    a shape in progress takes seconds. Any older 3MF of that name is removed, so a stale
    one can't be printed by mistake. Returns the PNG's path then, else the 3MF's.
    """
    out = out_dir()
    if not isinstance(parts, dict):
        parts = {None: parts}
    if colors and (missing := [label for label in parts if label not in colors]):
        raise ValueError(f"colors has no entry for {missing}; give one colour per part label")
    step, png, tmf = (out / f"{name}.{ext}" for ext in ("step", "png", "3mf"))
    part_dir = out / f"{name}_colors" if colors else out
    part_dir.mkdir(exist_ok=True)

    stls, meshes, notes = [], [], []
    for label, part in parts.items():
        stl = part_dir / (f"{name}_{label}.stl" if label else f"{name}.stl")
        if isinstance(part, trimesh.Trimesh):
            part.export(stl)
        else:
            export_stl(part, str(stl), tolerance=0.01, angular_tolerance=0.1)
        mesh = clean(trimesh.load_mesh(stl))
        mesh.export(stl)
        report(mesh, f"{name}_{label}" if label else name, one_body=not colors, on_bed=not colors)
        if not colors:
            notes.append(printability(mesh, f"{name}_{label}" if label else name))
        stls.append(stl)
        meshes.append(mesh)
    solids = [p for p in parts.values() if not isinstance(p, trimesh.Trimesh)]
    if solids and not draft:
        export_step(Compound(solids) if len(solids) > 1 else solids[0], str(step))
    if colors:
        if len(solids) == len(parts):
            # Fuse the exact solids, then mesh once: separately meshed parts don't share
            # matching triangles on curved faces, so a mesh-level fuse leaves gaps.
            fused = solids[0].fuse(*solids[1:]) if len(solids) > 1 else solids[0]
            export_stl(fused, str(out / f"{name}.stl"), tolerance=0.01, angular_tolerance=0.1)
            whole = clean(trimesh.load_mesh(out / f"{name}.stl"))
        else:
            whole = fuse(meshes)
            if not whole.is_watertight or whole.body_count > 1:
                # Parts that don't share an exact grid (e.g. a sculpted mesh cut by
                # build123d parts): join them with a proper mesh boolean instead.
                whole = union(meshes)
        whole.export(out / f"{name}.stl")
        report(whole, f"{name} (all colours)")
        found = printability(whole, f"{name} (all colours)")
        # For the app's 3D view: which STL is which colour. Written before the PNG, which
        # the app takes as the sign that an export's meshes are complete.
        (part_dir / "colors.json").write_text(json.dumps(
            [{"label": label, "stl": stl.name, "color": colors[label]} for label, stl in zip(parts, stls)], indent=1))
        pieces = [(m, colors[label]) for m, label in zip(meshes, parts)]
    else:
        whole = side_by_side(meshes)
        pieces = [(whole, None)]
        found = Analysis(overhang=np.concatenate([n.overhang for n in notes]),
                         contact=np.concatenate([n.contact for n in notes]))
    check = out / "check" / f"{name}.png"
    check.parent.mkdir(exist_ok=True)
    try:
        render_check(pieces, whole, found.overhang, found.contact, check, name)
    except Exception as err:  # an extra view; the export itself must not depend on it
        print(f"[{name}] check image failed: {err}")
        check = None
    render(pieces, png, name)  # last: the app takes the PNG as the sign that an export is complete

    shown = [out / f"{name}.stl", part_dir] if colors else stls
    if draft:
        tmf.unlink(missing_ok=True)
        print(f"[{name}] draft: not sliced, no 3MF or STEP. Run without draft=True when the shape is right.")
        print("files: " + "\n       ".join(map(str, [*shown, png, *([check] if check else [])])))
        return png

    est = slicer.make_project(stls, tmf, process, filament, settings,
                              colors=[colors[label] for label in parts] if colors else None)
    print(f"[{name}] slice: {slicer.NOZZLE} mm nozzle, {est['process']} + {filament}, {settings or 'no overrides'}")
    print(f"[{name}] estimate: {est['time']}, {est['weight_g']:.1f} g")
    for w in sorted(set(est["warnings"]) - HARMLESS_WARNINGS):
        print(f"[{name}] slicer warning: {w}")
    print("files: " + "\n       ".join(map(str, [tmf, *shown, *([step] if solids else []), png,
                                                  *([check] if check else [])])))
    return tmf


def fuse(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    """Join touching meshes into one solid by dropping the faces they share (both copies).
    Exact for parts built on a shared grid (print3d.image.relief_mesh); for parts that
    only overlap it is just a concatenation."""
    mesh = trimesh.util.concatenate(meshes)
    mesh.merge_vertices(digits_vertex=4)
    key = np.sort(mesh.faces, axis=1)
    _, inverse, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    mesh.update_faces(counts[inverse.ravel()] == 1)
    mesh.remove_unreferenced_vertices()
    return mesh


def union(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    """Exact boolean union of closed meshes (manifold3d). Faces that coincide exactly
    leave zero-volume slivers in the result; those are dropped."""
    import manifold3d as mf

    total = mf.Manifold()
    for m in meshes:
        total += mf.Manifold(mf.Mesh(vert_properties=np.asarray(m.vertices, np.float32),
                                     tri_verts=np.asarray(m.faces, np.uint32)))
    pieces = [p for p in total.decompose() if abs(p.volume()) > 1e-3]
    total = sum(pieces[1:], pieces[0]) if pieces else total
    out = total.to_mesh()
    return trimesh.Trimesh(out.vert_properties[:, :3], out.tri_verts, process=False)  # keep manifold3d topology


def clean(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Remove the zero-area slivers OCC's tessellator leaves at fillet corners and sphere poles."""
    if mesh.is_volume:
        return mesh  # already closed; merging close points or dropping tiny triangles could open holes
    mesh.merge_vertices(digits_vertex=4)
    mesh.update_faces(mesh.nondegenerate_faces(height=1e-6))
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    if not mesh.is_watertight:
        trimesh.repair.fill_holes(mesh)
    trimesh.repair.fix_normals(mesh)
    return mesh


def report(mesh: trimesh.Trimesh, name: str, one_body: bool = True, watertight: bool = True,
           on_bed: bool = True) -> None:
    """Size, volume and the printability check. Colour parts of a multicolour print
    may be several islands and sit on another part (one_body=False, on_bed=False); their
    assembly is several touching meshes (watertight=False)."""
    size = mesh.extents
    print(f"[{name}] size: {size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} mm")
    print(f"[{name}] volume: {mesh.volume / 1000:.2f} cm³ "
          f"(~{mesh.volume / 1000 * 1.24:.1f} g PLA at 100% infill)")
    problems = []
    if watertight and not mesh.is_watertight:
        problems.append("mesh is not watertight")
    if one_body and mesh.body_count > 1:
        problems.append(f"{mesh.body_count} separate bodies")
    if any(s > b for s, b in zip(sorted(size), sorted(BED))):
        problems.append(f"does not fit the A1 bed {BED}")
    if on_bed and abs(mesh.bounds[0][2]) > 1e-6:
        problems.append(f"bottom is at z={mesh.bounds[0][2]:.2f}, not z=0")
    print(f"[{name}] check: " + ("OK" if not problems else "; ".join(problems)))


def printability(mesh: trimesh.Trimesh, name: str) -> Analysis:
    """Print what a slicer would struggle with (see print3d.analyze) and return the analysis."""
    found = analyze(mesh)
    for line in found.lines():
        print(f"[{name}] print: {line}")
    return found
