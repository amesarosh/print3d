"""Renders of a part for checking it by eye: the preview, the check image and close-ups.

- render():       <name>.png, four views (iso, front, right, top). The app shows this one.
- render_check(): check/<name>.png, what the preview hides: the back, the underside with
                  overhangs in red and bed contact in blue, and two cross-sections.
- render_view():  one view from any direction, optionally zoomed on a point or cut open
                  (used by `python -m print3d.view`).
"""

from pathlib import Path

import numpy as np
import pyvista as pv
import trimesh
import vtk

SIZE = 1568  # px, the longest edge Claude reads without downscaling
BODY = "#5b9be0"  # default colour of a plain part
EDGE = "#1d2b3a"
OVERHANG_RGB, CONTACT_RGB, PLAIN_RGB = (226, 54, 46), (64, 124, 224), (205, 209, 214)

VIEWS = [  # (title, camera direction from the part, camera up). Front is -Y.
    ("iso (front-right)", (0.55, -1, 0.7), (0, 0, 1)),
    ("front", (0, -1, 0), (0, 0, 1)),
    ("right", (1, 0, 0), (0, 0, 1)),
    ("top", (0, 0, 1), (0, 1, 0)),
]

Piece = tuple[trimesh.Trimesh, str | None]  # (mesh, "#rrggbb" or None for the default colour)


def side_by_side(meshes: list[trimesh.Trimesh], gap: float = 10) -> trimesh.Trimesh:
    """Lay meshes out left to right along X for the preview."""
    placed, x = [], 0.0
    for m in meshes:
        m = m.copy()
        m.apply_translation([x - m.bounds[0][0], 0, 0])
        x = m.bounds[1][0] + gap
        placed.append(m)
    return trimesh.util.concatenate(placed)


def _plotter(rows: int, cols: int, size: tuple[int, int]) -> pv.Plotter:
    pv.OFF_SCREEN = True
    plotter = pv.Plotter(shape=(rows, cols), off_screen=True, window_size=size, border=False,
                         lighting="three lights")
    return plotter


def _aim(plotter: pv.Plotter, lo, hi, view, up, margin: float = 1.2) -> None:
    """Orthographic camera looking along -view, framed on the box lo..hi."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    centre = (lo + hi) / 2
    view = np.asarray(view, float) / np.linalg.norm(view)
    cam = plotter.camera
    cam.focal_point = centre
    cam.position = centre + view * max(np.linalg.norm(hi - lo), 1.0) * 3
    cam.up = up
    plotter.enable_parallel_projection()
    right = np.cross(-view, up)
    right /= np.linalg.norm(right)
    top = np.cross(right, -view)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) - centre
    w, h = plotter.renderer.GetSize()
    cam.parallel_scale = max(np.abs(corners @ top).max(), np.abs(corners @ right).max() * h / max(w, 1), 0.5) * margin
    plotter.reset_camera_clipping_range()


def _shade(plotter: pv.Plotter, mesh: trimesh.Trimesh | pv.PolyData, color=None, **kw) -> None:
    """Matte surface, smooth where the model is smooth and creased where it has edges."""
    surf = mesh if isinstance(mesh, pv.PolyData) else pv.wrap(mesh)
    if surf.n_cells == 0:
        return
    opts = dict(smooth_shading=True, split_sharp_edges=True, feature_angle=30, specular=0.15, ambient=0.22, diffuse=0.9)
    opts.update(kw)
    plotter.add_mesh(surf, color=color, **opts)


def _edges(mesh: trimesh.Trimesh) -> pv.PolyData:
    return pv.wrap(mesh).extract_feature_edges(feature_angle=35, boundary_edges=False, non_manifold_edges=False,
                                               manifold_edges=False)


def _depth(plotter: pv.Plotter, extent: float) -> None:
    """Soft contact shadows in creases, which make forms and gaps readable. Skipped where unsupported."""
    try:
        plotter.enable_ssao(radius=extent * 0.06, bias=extent * 0.004, kernel_size=64)
        plotter.enable_anti_aliasing("ssaa")
    except Exception:
        pass


def _draw(plotter: pv.Plotter, pieces: list[Piece], edges: pv.PolyData | None) -> None:
    for mesh, color in pieces:
        _shade(plotter, mesh, color or BODY)
    if edges is not None and edges.n_cells:
        plotter.add_mesh(edges, color=EDGE, line_width=1.6)


def _bounds(pieces: list[Piece]) -> tuple[np.ndarray, np.ndarray]:
    lo = np.min([m.bounds[0] for m, _ in pieces], axis=0)
    hi = np.max([m.bounds[1] for m, _ in pieces], axis=0)
    return lo, hi


def render(pieces: list[Piece], path: Path, name: str) -> None:
    """The preview: four shaded orthographic views. Plain parts get feature edges; a textured
    multicolour relief would only be cluttered by them."""
    lo, hi = _bounds(pieces)
    e = hi - lo
    colored = any(c for _, c in pieces)
    edges = None if colored else _edges(trimesh.util.concatenate([m for m, _ in pieces]))
    plotter = _plotter(2, 2, (SIZE, SIZE))
    for i, (title, view, up) in enumerate(VIEWS):
        plotter.subplot(i // 2, i % 2)
        plotter.set_background("white")
        _draw(plotter, pieces, edges)
        plotter.add_text(title, font_size=13, color="black")
        _aim(plotter, lo, hi, view, up)
        _depth(plotter, float(np.linalg.norm(e)))
        if i == 0:
            plotter.show_axes()
    plotter.subplot(0, 0)
    plotter.add_text(f"\n\n{name}  {e[0]:.1f} x {e[1]:.1f} x {e[2]:.1f} mm", font_size=10, color="#444444")
    plotter.screenshot(str(path))
    plotter.close()


def _cut(mesh: trimesh.Trimesh, origin, normal, color: str) -> pv.PolyData:
    """The part of a closed mesh on the +normal side of a plane, with the cut face filled in a darker tone."""
    poly = pv.wrap(mesh)
    base = np.array(pv.Color(color).float_rgb)
    plane = vtk.vtkPlane()
    plane.SetOrigin(*map(float, origin))
    plane.SetNormal(*map(float, normal))
    planes = vtk.vtkPlaneCollection()
    planes.AddItem(plane)
    clip = vtk.vtkClipClosedSurface()
    clip.SetInputData(poly)
    clip.SetClippingPlanes(planes)
    clip.SetScalarModeToColors()
    clip.SetBaseColor(*base)
    clip.SetClipColor(*(base * 0.45))
    clip.Update()
    return pv.wrap(clip.GetOutput())


def _draw_cut(plotter: pv.Plotter, pieces: list[Piece], origin, normal) -> None:
    for mesh, color in pieces:
        cut = _cut(mesh, origin, normal, color or BODY)
        if cut.n_cells:
            # Flat shading: the cut face and the skin must not blend into each other.
            plotter.add_mesh(cut, scalars=cut.active_scalars_name, rgb=True, smooth_shading=False,
                             specular=0.1, ambient=0.3, diffuse=0.85)
            outline = pv.wrap(mesh).slice(normal=normal, origin=origin)
            if outline.n_cells:
                plotter.add_mesh(outline, color="black", line_width=2.2)


def _painted(mesh: trimesh.Trimesh, overhang: np.ndarray, contact: np.ndarray) -> pv.PolyData:
    surf = pv.wrap(mesh)
    rgb = np.tile(np.array(PLAIN_RGB, np.uint8), (len(mesh.faces), 1))
    rgb[contact] = CONTACT_RGB
    rgb[overhang] = OVERHANG_RGB
    surf.cell_data["rgb"] = rgb
    return surf


def render_check(pieces: list[Piece], whole: trimesh.Trimesh, overhang: np.ndarray, contact: np.ndarray,
                 path: Path, name: str) -> None:
    """What the preview can't show. `whole` is the mesh that was analysed (same placement as
    `pieces`), with its per-face overhang and bed-contact masks."""
    lo, hi = _bounds(pieces)
    extent = float(np.linalg.norm(hi - lo))
    # Cut through the centre of mass: on a lopsided part the middle of the bounding box can miss the body.
    centre = np.asarray(whole.center_mass if whole.is_watertight else whole.centroid, float)
    colored = any(c for _, c in pieces)
    edges = None if colored else _edges(trimesh.util.concatenate([m for m, _ in pieces]))
    plotter = _plotter(2, 2, (SIZE, SIZE))

    plotter.subplot(0, 0)
    plotter.set_background("white")
    _draw(plotter, pieces, edges)
    plotter.add_text("iso (back-left)", font_size=13, color="black")
    _aim(plotter, lo, hi, (-0.55, 1, 0.7), (0, 0, 1))
    _depth(plotter, extent)
    plotter.show_axes()

    plotter.subplot(0, 1)
    plotter.set_background("white")
    plotter.add_mesh(_painted(whole, overhang, contact), scalars="rgb", rgb=True, smooth_shading=False,
                     specular=0.0, ambient=0.3, diffuse=0.55)
    plotter.add_text("underside, from the front-right\nred: overhang needing support   blue: on the bed",
                     font_size=11, color="black")
    _aim(plotter, lo, hi, (0.55, -1, -0.8), (0, 0, 1), margin=1.3)

    # Sections look at the cut face: the half in front of the plane is removed.
    for col, (axis, view, label) in enumerate([(0, (1, 0.25, 0.2), "X"), (1, (-0.25, -1, 0.2), "Y")]):
        plotter.subplot(1, col)
        plotter.set_background("white")
        normal = np.zeros(3)
        normal[axis] = -view[axis] / abs(view[axis])
        _draw_cut(plotter, pieces, centre, normal)
        plotter.add_text(f"section at {label}={centre[axis]:.1f} (cut face darker)", font_size=11, color="black")
        _aim(plotter, lo, hi, view, (0, 0, 1))
    plotter.screenshot(str(path))
    plotter.close()


def render_view(pieces: list[Piece], path: Path, view=(0.55, -1, 0.7), focus=None, radius: float | None = None,
                section: tuple[int, float] | None = None, title: str = "", size: int = 1200) -> None:
    """One large view. `focus` and `radius` (mm) zoom in on a point; `section` = (axis, value)
    cuts the part open at that coordinate, keeping the side away from the camera."""
    lo, hi = _bounds(pieces)
    if focus is not None:
        r = radius or float(np.linalg.norm(hi - lo)) / 6
        lo, hi = np.asarray(focus, float) - r, np.asarray(focus, float) + r
    view = np.asarray(view, float)
    up = (0, 1, 0) if abs(view[2]) > 0.95 * np.linalg.norm(view) else (0, 0, 1)
    plotter = _plotter(1, 1, (size, size))
    plotter.set_background("white")
    if section is not None:
        axis, value = section
        origin = (_bounds(pieces)[0] + _bounds(pieces)[1]) / 2
        origin[axis] = value
        normal = np.zeros(3)
        normal[axis] = -1.0 if view[axis] >= 0 else 1.0
        _draw_cut(plotter, pieces, origin, normal)
    else:
        colored = any(c for _, c in pieces)
        _draw(plotter, pieces, None if colored else _edges(trimesh.util.concatenate([m for m, _ in pieces])))
        _depth(plotter, float(np.linalg.norm(hi - lo)))
    if title:
        plotter.add_text(title, font_size=11, color="black")
    _aim(plotter, lo, hi, view, up, margin=1.1)
    plotter.show_axes()
    plotter.screenshot(str(path))
    plotter.close()
