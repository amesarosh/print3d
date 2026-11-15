"""Turn 2D images into build123d faces: logos, silhouettes, signs, stencils.

Usage in a project script:
    from print3d.image import outline, regions
    faces = outline(REF / "logo.png", width=60)          # mm, the traced shape's width
    part = extrude(faces, 3)

    for r in regions(REF / "badge.png", width=80, colors=3):
        print(r.color, r.area)                          # one entry per colour, background first

Faces lie on the XY plane, centred on the origin, with image "up" as +Y.
Each call prints a short report and saves an overlay of the trace on the
image to out/trace/<name>.png, so the agent can check what was picked up.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import trimesh
from build123d import Compound, Face, Vector, Wire
from PIL import Image

from . import out_dir

WORK_PX = 2000  # images are resampled so the long edge is at least this, for smooth outlines


@dataclass
class Region:
    color: str  # "#rrggbb", the cluster's mean colour
    faces: list[Face]
    area: float  # mm²
    background: bool  # the colour that covers most of the image border


def load(path) -> tuple[np.ndarray, np.ndarray | None, float]:
    """RGB array, alpha mask (None if the image has no real transparency), and the upsampling factor."""
    img = Image.open(path)
    img = img.convert("RGBA")
    rgba = np.asarray(img)
    k = max(1.0, WORK_PX / max(rgba.shape[:2]))
    if k > 1:
        rgba = cv2.resize(rgba, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
    alpha = rgba[..., 3]
    has_alpha = (alpha < 128).mean() > 0.01
    return rgba[..., :3].copy(), (alpha >= 128) if has_alpha else None, k


def blur_px(smooth_mm: float, scale: float, k: float) -> float:
    """Blur radius in working pixels: the asked smoothing, but at least most of a source pixel to hide its steps."""
    return max(smooth_mm / scale, 0.8 * k) if smooth_mm > 0 else 0


def border(mask: np.ndarray) -> np.ndarray:
    return np.concatenate([mask[0], mask[-1], mask[:, 0], mask[:, -1]])


def silhouette(rgb: np.ndarray, alpha, invert: bool | None, threshold: int | None, blur_px: float) -> np.ndarray:
    """Foreground mask: the opaque pixels, or the side of a brightness threshold that doesn't fill the border."""
    if alpha is not None and threshold is None:
        mask = alpha
    else:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        if blur_px > 0:
            gray = cv2.GaussianBlur(gray, (0, 0), blur_px)
        t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        mask = gray < (threshold if threshold is not None else t)  # dark pixels
        if alpha is not None:
            mask &= alpha
        elif invert is None and border(mask).mean() > 0.5:
            mask = ~mask  # the border is dark, so the subject is light
    if invert:
        mask = ~mask
    return mask


def contours(mask: np.ndarray, eps_px: float, min_px: float):
    """Outer contours with their holes, simplified, small specks dropped."""
    found, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return []
    shapes = []
    for i, c in enumerate(found):
        if hier[0][i][3] != -1 or cv2.contourArea(c) < min_px:
            continue  # a hole (handled with its parent) or a speck
        holes, j = [], hier[0][i][2]
        while j != -1:
            if cv2.contourArea(found[j]) >= min_px:
                holes.append(found[j])
            j = hier[0][j][0]
        simp = [cv2.approxPolyDP(x, eps_px, True)[:, 0, :] for x in [c, *holes]]
        if len(simp[0]) >= 3:
            shapes.append([s for s in simp if len(s) >= 3])
    return shapes


def to_faces(shapes, scale: float, center: np.ndarray) -> list[Face]:
    def wire(pts):
        return Wire.make_polygon([Vector((x - center[0]) * scale, (center[1] - y) * scale) for x, y in pts], close=True)

    faces = []
    for outer, *holes in shapes:
        face = Face(wire(outer), [wire(h) for h in holes])
        faces.append(face if face.normal_at().Z > 0 else -face)
    return faces


def fit(mask: np.ndarray, width, height) -> tuple[float, np.ndarray]:
    """mm per pixel and the pixel centre, so the mask's bounding box gets the asked size."""
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise ValueError("nothing traced: the image looks empty at this threshold")
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    if width is None and height is None:
        raise ValueError("give width= or height= in mm")
    scale = width / (x1 - x0) if width is not None else height / (y1 - y0)
    return scale, np.array([(x0 + x1) / 2, (y0 + y1) / 2])


def thin_area(mask: np.ndarray, min_px: float) -> np.ndarray:
    """Pixels in parts of the shape narrower than min_px (lost by an opening of that diameter)."""
    d = max(3, round(min_px) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))
    opened = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    # Grow back a little, so pixel noise along smooth edges doesn't count as thin.
    opened = cv2.dilate(opened, np.ones((3, 3), np.uint8), iterations=max(1, d // 8)).astype(bool)
    return mask & ~opened


def overlay(rgb, layers, name: str) -> Path:
    """Save the image with traced outlines (and thin areas in red) for checking."""
    vis = (rgb * 0.45 + 140).astype(np.uint8)
    for shapes, color, thin in layers:
        if thin is not None:
            vis[thin] = (230, 30, 30)
        for shape in shapes:
            cv2.polylines(vis, [s.reshape(-1, 1, 2) for s in shape], True, color, max(2, vis.shape[1] // 600))
    k = 1400 / max(vis.shape[:2])
    if k < 1:
        vis = cv2.resize(vis, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    path = out_dir() / "trace" / f"{name}.png"
    path.parent.mkdir(exist_ok=True)
    Image.fromarray(vis).save(path)
    return path


def outline(path, width: float | None = None, height: float | None = None, *, invert: bool | None = None,
            threshold: int | None = None, smooth: float = 0.15, tolerance: float = 0.03, min_area: float = 0.5,
            min_feature: float = 1.0, name: str | None = None) -> list[Face]:
    """Trace the subject of an image (dark on light, light on dark, or opaque on transparent) as faces.

    width / height: size of the traced shape's bounding box in mm (give one).
    invert: trace the background instead; None picks the side that doesn't fill the border.
    threshold: 0–255 grey level, dark pixels below it are the subject (default: Otsu).
    smooth: blur in mm before thresholding, rounds off pixel steps and noise.
    tolerance: how far the simplified outline may stray from the trace, mm.
    min_area: drop islands and holes smaller than this, mm².
    min_feature: report (and show in red) parts narrower than this, mm.
    """
    name = name or Path(path).stem
    rgb, alpha, k = load(path)
    rough = silhouette(rgb, alpha, invert, threshold, 0)
    scale, _ = fit(rough, width, height)
    mask = silhouette(rgb, alpha, invert, threshold, blur_px(smooth, scale, k))
    if alpha is not None and threshold is None and smooth > 0:  # smooth the alpha edge too
        mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), blur_px(smooth, scale, k)) > 0.5
    scale, center = fit(mask, width, height)
    shapes = contours(mask, max(tolerance / scale, 0.5 * k), min_area / scale**2)
    faces = to_faces(shapes, scale, center)

    thin = thin_area(mask, min_feature / scale)
    png = overlay(rgb, [(shapes, (0, 90, 220), thin)], name)
    size = Compound(faces).bounding_box().size if faces else Vector()
    print(f"[trace {name}] {len(faces)} faces, {sum(len(f.inner_wires()) for f in faces)} holes, "
          f"{size.X:.1f} x {size.Y:.1f} mm, {sum(f.area for f in faces):.0f} mm²")
    thin_mm2 = thin.sum() * scale**2
    if thin_mm2 > 0.5:
        print(f"[trace {name}] warning: {thin_mm2:.1f} mm² is narrower than {min_feature} mm (red in the overlay)")
    print(f"[trace {name}] overlay: {png}")
    return faces


def regions(path, width: float | None = None, height: float | None = None, *, colors: int = 2,
            smooth: float = 0.15, tolerance: float = 0.03, min_area: float = 0.5, overlap: float = 0.2,
            name: str | None = None) -> list[Region]:
    """Split an image into `colors` colour regions (k-means) and trace each one.

    Sizes refer to the bounding box of everything that isn't the background colour.
    Returned background first, then the rest by area, largest first. Regions other
    than the background grow by `overlap` mm, so neighbours fuse into one body when unioned.
    """
    name = name or Path(path).stem
    rgb, alpha, k = load(path)
    small = cv2.resize(rgb, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.5)
    _, _, centers = cv2.kmeans(lab, colors, None, crit, 3, cv2.KMEANS_PP_CENTERS)

    full = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    labels = np.argmin(np.stack([((full - c) ** 2).sum(-1) for c in centers]), axis=0)
    labels = cv2.medianBlur(labels.astype(np.uint8), 5)
    if alpha is not None:
        labels[~alpha] = 255  # transparent: no region

    bg = np.bincount(border(labels), minlength=256)[:colors].argmax() if alpha is None else -1
    scale, center = fit((labels != bg) & (labels != 255), width, height)
    grow_px = round(overlap / scale)

    out, layers = [], []
    palette = [(0, 90, 220), (220, 120, 0), (0, 160, 60), (160, 0, 160), (0, 150, 160), (120, 120, 0)]
    for i in range(colors):
        mask = labels == i
        if smooth > 0:
            mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), blur_px(smooth, scale, k)) > 0.5
        if i != bg and grow_px > 0:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow_px + 1,) * 2)
            mask = cv2.dilate(mask.astype(np.uint8), kernel).astype(bool)
        shapes = contours(mask, max(tolerance / scale, 0.5 * k), min_area / scale**2)
        r, g, b = cv2.cvtColor(np.uint8([[centers[i]]]), cv2.COLOR_LAB2RGB)[0, 0]
        faces = to_faces(shapes, scale, center)
        out.append(Region(f"#{r:02x}{g:02x}{b:02x}", faces, sum(f.area for f in faces), i == bg))
        layers.append((shapes, palette[i % len(palette)], None))

    out.sort(key=lambda r: (not r.background, -r.area))
    png = overlay(rgb, layers, name)
    for r in out:
        print(f"[trace {name}] {r.color}{' (background)' if r.background else ''}: "
              f"{len(r.faces)} faces, {r.area:.0f} mm²")
    print(f"[trace {name}] overlay: {png}")
    return out


# --- Heightfield reliefs (photo reliefs, multicolour skins) ----------------------------------------


def no_diagonals(labels: np.ndarray, max_iter: int = 50) -> np.ndarray:
    """Relabel cells so no label touches itself only corner to corner (that would make a
    non-manifold edge in relief_mesh). Fills one of the other two cells of each such 2×2 block."""
    labels = labels.copy()
    for _ in range(max_iter):
        a, b, c, d = labels[:-1, :-1], labels[:-1, 1:], labels[1:, :-1], labels[1:, 1:]
        diag1 = (a == d) & (a != b) & (a != c)  # a and d alone: give b to a
        diag2 = (b == c) & (b != a) & (b != d)  # b and c alone: give a to b
        if not (diag1.any() or diag2.any()):
            return labels
        r, k = np.nonzero(diag1)
        labels[r, k + 1] = labels[r, k]
        r, k = np.nonzero(diag2 & ~diag1)
        labels[r, k] = labels[r, k + 1]
    raise RuntimeError("no_diagonals did not converge")


def corner_heights(cell_h: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Heights at the cell corners ((H+1)×(W+1)): the mean of the in-mask cells around each corner."""
    h = np.pad(np.where(mask, cell_h, 0.0), 1)
    m = np.pad(mask.astype(float), 1)
    s = h[:-1, :-1] + h[:-1, 1:] + h[1:, :-1] + h[1:, 1:]
    n = m[:-1, :-1] + m[:-1, 1:] + m[1:, :-1] + m[1:, 1:]
    return s / np.maximum(n, 1)


def relief_mesh(region: np.ndarray, bottom: np.ndarray, top: np.ndarray, cell: float,
                origin=(0.0, 0.0)) -> trimesh.Trimesh:
    """Watertight mesh of the grid cells in `region` (H×W bool, row 0 = image top),
    between the corner height maps `bottom` and `top` ((H+1)×(W+1), mm).

    Corner heights are shared, so regions built from the same maps meet exactly:
    a core from 0 to `top - skin` plus one skin per colour from `top - skin` to `top`
    gives touching parts for a multicolour print. Run no_diagonals() on the labels first.
    `origin` is the XY position of the grid's top-left corner; +Y is image up.
    """
    H, W = region.shape
    n = (H + 1) * (W + 1)
    ii, jj = np.mgrid[0:H + 1, 0:W + 1]
    xy = np.stack([origin[0] + jj * cell, origin[1] - ii * cell], -1).reshape(-1, 2)
    verts = np.vstack([np.column_stack([xy, top.ravel()]), np.column_stack([xy, bottom.ravel()])])

    def idx(i, j):  # top vertex; + n for the bottom one
        return i * (W + 1) + j

    r, c = np.nonzero(region)
    a, b, cc, d = idx(r, c), idx(r + 1, c), idx(r + 1, c + 1), idx(r, c + 1)
    tris = [np.column_stack(t) for t in ((a, b, cc), (a, cc, d), (a + n, cc + n, b + n), (a + n, d + n, cc + n))]
    want = [np.tile([0, 0, 1.0], (len(r), 1))] * 2 + [np.tile([0, 0, -1.0], (len(r), 1))] * 2

    pad = np.pad(region, 1)
    for dr, dc, p, q in [(-1, 0, (0, 0), (0, 1)), (1, 0, (1, 0), (1, 1)),
                         (0, -1, (0, 0), (1, 0)), (0, 1, (0, 1), (1, 1))]:
        open_ = ~pad[r + 1 + dr, c + 1 + dc]  # neighbour outside the region: a wall on that side
        rr, ck = r[open_], c[open_]
        p0, p1 = idx(rr + p[0], ck + p[1]), idx(rr + q[0], ck + q[1])
        tris += [np.column_stack([p0, p1, p1 + n]), np.column_stack([p0, p1 + n, p0 + n])]
        want += [np.tile([dc, -dr, 0.0], (len(rr), 1))] * 2

    faces, want = np.vstack(tris), np.vstack(want)
    tri = verts[faces]
    normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    flip = (normal * want).sum(1) < 0
    faces[flip] = faces[flip][:, ::-1]
    mesh = trimesh.Trimesh(verts, faces, process=False)
    mesh.remove_unreferenced_vertices()
    return mesh
