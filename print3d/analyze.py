"""Printability analysis of a mesh in its print orientation: what a slicer would struggle with.

    a = analyze(mesh)
    for line in a.lines(): print(line)

Finds overhangs that need support, places where the print would start in mid-air, the area
touching the bed and the thinnest wall. `a.overhang` and `a.contact` are per-face masks, which
the check image (print3d.preview.render_check) paints red and blue.
"""

from dataclasses import dataclass, field

import numpy as np
import pyvista as pv
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .slicer import LINE_WIDTH

# A face counts as an overhang when it leans further than this from vertical. The design rule
# is 45°; the margin keeps 45° chamfers and their tessellation noise from being flagged.
OVERHANG_DEG = 50.0
MIN_OVERHANG_AREA = 1.0  # mm²: smaller patches print fine and are not listed
MIN_WALL = round(2 * LINE_WIDTH, 1)  # mm, two lines of the fitted nozzle
BED_EPS = 0.05  # mm above the lowest point that still counts as "on the bed"
MAX_BRIDGE = 20.0  # mm: a flat ceiling narrower than this is bridged without support
LIP = 0.4  # mm, a bit over one layer: a dip shallower than this joins the material beside it as it prints
THICKNESS_SAMPLES = 3000


@dataclass
class Analysis:
    overhang: np.ndarray  # per face: leans past OVERHANG_DEG and is not on the bed
    contact: np.ndarray  # per face: lies on the bed
    overhang_area: float = 0.0  # mm², patches of at least MIN_OVERHANG_AREA
    patches: list[dict] = field(default_factory=list)  # largest first: area, center
    bridges: list[float] = field(default_factory=list)  # spans (mm) of flat ceilings short enough to bridge
    contact_area: float = 0.0  # mm²
    air_starts: list[np.ndarray] = field(default_factory=list)  # points where a layer begins on nothing
    thin: tuple[float, np.ndarray] | None = None  # thinnest wall found (mm) and where

    def lines(self) -> list[str]:
        """The findings as sentences, problems first. Empty problems are stated as fine."""
        def at(p):
            return f"x={p[0]:.0f}, y={p[1]:.0f}, z={p[2]:.1f}"

        out = []
        if self.patches:
            worst = self.patches[0]
            out.append(
                f"overhangs: {self.overhang_area:.0f} mm² lean past {OVERHANG_DEG:.0f}° in {len(self.patches)} "
                f"place{'s' if len(self.patches) > 1 else ''} and need support or a redesign; largest "
                f"{worst['area']:.0f} mm² at {at(worst['center'])}")
        else:
            out.append(f"overhangs: none past {OVERHANG_DEG:.0f}°")
        if self.bridges:
            out.append(f"bridges: {len(self.bridges)} flat ceiling{'s' if len(self.bridges) > 1 else ''}, widest "
                       f"{max(self.bridges):.0f} mm (fine up to {MAX_BRIDGE:.0f} mm)")
        if self.air_starts:
            pts = "; ".join(at(p) for p in self.air_starts[:4])
            more = f" and {len(self.air_starts) - 4} more" if len(self.air_starts) > 4 else ""
            out.append(f"starts in mid-air at {len(self.air_starts)} point{'s' if len(self.air_starts) > 1 else ''} "
                       f"({pts}{more}): nothing is printed below, so these need support")
        out.append(f"bed contact: {self.contact_area:.0f} mm²")
        if self.thin is not None:
            t, p = self.thin
            note = f", under the {MIN_WALL} mm minimum" if t < MIN_WALL - 0.05 else ""
            out.append(f"thinnest wall: about {t:.1f} mm at {at(p)}{note}")
        return out

    @property
    def ok(self) -> bool:
        return not self.patches and not self.air_starts and (self.thin is None or self.thin[0] >= MIN_WALL - 0.05)


def analyze(mesh: trimesh.Trimesh, thickness: bool = True) -> Analysis:
    normals, areas = mesh.face_normals, mesh.area_faces
    centers = mesh.triangles_center
    floor = mesh.bounds[0][2]
    low = mesh.vertices[mesh.faces][:, :, 2].max(axis=1) < floor + BED_EPS
    contact = low & (normals[:, 2] < -0.99)
    overhang = (normals[:, 2] < -np.sin(np.radians(OVERHANG_DEG))) & ~low
    a = Analysis(overhang=np.zeros(len(mesh.faces), bool), contact=contact, contact_area=float(areas[contact].sum()))

    surf = pv.wrap(mesh)
    a.air_starts = sorted((p for p in _air_starts(mesh, floor) if _open_below(surf, p, floor)), key=lambda p: p[2])

    if overhang.any():
        adj = mesh.face_adjacency
        adj = adj[overhang[adj].all(axis=1)]
        n = len(mesh.faces)
        _, label = connected_components(coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(n, n)),
                                        directed=False)
        label = np.where(overhang, label, -1)
        ids, inverse = np.unique(label[overhang], return_inverse=True)
        patch_area = np.bincount(inverse, weights=areas[overhang])
        for i in np.argsort(-patch_area):
            if patch_area[i] < MIN_OVERHANG_AREA:
                break
            faces = label == ids[i]
            span = _bridge_span(mesh, faces, normals, areas)
            if span is not None and span <= MAX_BRIDGE:
                a.bridges.append(span)
                continue
            w = areas[faces]
            center = (centers[faces] * w[:, None]).sum(0) / w.sum()
            if not _open_below(surf, centers[faces][np.argmin(np.linalg.norm(centers[faces] - center, axis=1))], floor):
                continue
            a.overhang |= faces
            a.patches.append({"area": float(patch_area[i]), "center": center})
        a.overhang_area = float(sum(p["area"] for p in a.patches))

    if thickness:
        try:
            a.thin = _thinnest_wall(mesh)
        except Exception:  # an estimate only; never fail an export over it
            a.thin = None
    return a


def _air_starts(mesh: trimesh.Trimesh, floor: float) -> list[np.ndarray]:
    """Lowest points of downward-facing surface that have nothing lower attached: a layer would
    begin there on thin air. A flat ceiling held up by its walls is not one (that's a bridge)."""
    z = mesh.vertices[:, 2]
    e = mesh.edges_unique
    n = len(z)
    lowest_nb = np.full(n, np.inf)
    np.minimum.at(lowest_nb, e[:, 0], z[e[:, 1]])
    np.minimum.at(lowest_nb, e[:, 1], z[e[:, 0]])
    has_lower = lowest_nb < z - 1e-6
    # Plateaus: vertices joined by level edges. One is a start only if no vertex in it has a lower neighbour.
    level = e[np.abs(z[e[:, 0]] - z[e[:, 1]]) < 1e-6]
    _, plateau = connected_components(coo_matrix((np.ones(len(level)), (level[:, 0], level[:, 1])), shape=(n, n)),
                                      directed=False)
    supported = np.bincount(plateau, weights=has_lower) > 0
    start = ~supported[plateau] & (z > floor + BED_EPS) & (mesh.vertex_normals[:, 2] < -0.2)
    if not start.any():
        return []
    nbrs = coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    found = []
    for i in np.unique(plateau[start])[:200]:
        seeds = np.flatnonzero(start & (plateau == i))
        if _stands_alone(seeds, z, nbrs):
            found.append(mesh.vertices[seeds].mean(axis=0))
    return found


def _open_below(surf: pv.PolyData, point: np.ndarray, floor: float) -> bool:
    """True if there is air under a point of the surface. Touching colour parts leave faces
    inside the joined mesh that rest on the part below; those are not overhangs."""
    start = np.asarray(point, float) - (0, 0, 1e-3)
    hits, _ = surf.ray_trace(start, (start[0], start[1], floor - 1.0), first_point=False)
    if not len(hits):
        return True
    depth = np.unique(np.round(start[2] - hits[:, 2], 3))
    # From air, a line down to below the bed crosses the surface an even number of times.
    return len(depth) % 2 == 0 and depth[0] > LIP / 2


def _stands_alone(seeds: np.ndarray, z: np.ndarray, nbrs) -> bool:
    """True if the surface round a low point keeps rising: walking outwards without climbing
    more than LIP never reaches anything lower. False for a shallow dimple in an underside."""
    z0 = z[seeds[0]]
    seen, stack = set(seeds.tolist()), seeds.tolist()
    while stack and len(seen) < 20000:
        v = stack.pop()
        for nb in nbrs.indices[nbrs.indptr[v]:nbrs.indptr[v + 1]]:
            if z[nb] < z0 - 1e-6:
                return False
            if nb not in seen and z[nb] <= z0 + LIP:
                seen.add(int(nb))
                stack.append(int(nb))
    return True


def _bridge_span(mesh: trimesh.Trimesh, faces: np.ndarray, normals: np.ndarray, areas: np.ndarray) -> float | None:
    """The narrow width (mm) of a flat, level ceiling; None if the patch isn't one. A rounded
    or chamfered rim round the ceiling still counts, as long as most of the patch is level."""
    level = faces & (normals[:, 2] < -0.985)
    if areas[level].sum() < 0.5 * areas[faces].sum():
        return None
    xy = mesh.vertices[np.unique(mesh.faces[level])][:, :2]
    xy = xy - xy.mean(axis=0)
    _, _, axes = np.linalg.svd(xy, full_matrices=False)
    return float(np.ptp(xy @ axes[-1]))


def _thinnest_wall(mesh: trimesh.Trimesh) -> tuple[float, np.ndarray] | None:
    """Sample the surface, look straight through the material from each sample, and take the
    low end of the distances to the far side. Only roughly parallel far sides count, so the
    wedge of material at a sharp edge or chamfer isn't mistaken for a thin wall."""
    if len(mesh.faces) < 4:
        return None
    rng = np.random.default_rng(0)
    areas = mesh.area_faces
    picks = rng.choice(len(mesh.faces), size=min(THICKNESS_SAMPLES, len(mesh.faces)), replace=False,
                       p=areas / areas.sum()) if len(mesh.faces) > THICKNESS_SAMPLES else np.arange(len(mesh.faces))
    normals, centers = mesh.face_normals, mesh.triangles_center
    surf = pv.wrap(mesh)
    reach = float(np.linalg.norm(mesh.extents)) * 1.1
    found = []
    for f in picks:
        origin = centers[f] - normals[f] * 1e-3
        points, cells = surf.ray_trace(origin, origin - normals[f] * reach, first_point=False)
        if not len(cells):
            continue
        d = np.linalg.norm(points - origin, axis=1)
        i = int(np.argmin(d))
        if d[i] > 1e-3 and normals[cells[i]] @ normals[f] < -0.7:
            found.append((d[i], f))
    if len(found) < 20:
        return None
    found.sort(key=lambda x: x[0])
    t, f = found[len(found) // 100]  # the 1st percentile: a real wall, not one stray ray
    return float(t), centers[f]
