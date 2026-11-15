"""Sculpt organic shapes: figures, food, animals, anything that isn't made of flat faces and holes.

A shape is a signed distance field: a number for every point of a grid, negative inside the
shape, positive outside, about the distance to the surface in mm. Fields are plain numpy
arrays, so they combine with ordinary arithmetic, and blend into each other like clay
with smooth_union(). mesh() turns the finished field into a watertight mesh for export().

    from print3d import export, sculpt as sc

    g = sc.Grid((-30, -20, 0), (30, 20, 40), voxel=0.3)      # the space to sculpt in, mm
    body = sc.ellipsoid(g.P, (0, 0, 14), (22, 15, 14))
    head = sc.sphere(g.P, (16, 0, 26), 10)
    f = sc.smooth_union(body, head, k=6)                      # k: how wide the blend is, mm
    eyes = sc.sphere(sc.mirror(g.P, "y"), (23, 4, 29), 1.6)   # mirror: both sides at once
    f = sc.smooth_union(f, eyes, k=0.5)
    f = sc.printable(f, g)                                    # fill overhangs to a 45° slope
    part = sc.mesh(f, g)                                      # flat on z=0
    export(part, "creature")

Mixing with build123d: cut(), join() and common() take meshes and build123d parts alike, e.g.
`part = sc.cut(part, pocket_solid)`. For two colours, sculpt the whole shape, then
`base, paint = sc.split(whole, region)` and export both with `colors=`.

Use voxel=0.6 while working out the shape (8x faster) and 0.25-0.3 for the final run.
"""

from collections.abc import Sequence

import manifold3d
import numpy as np
import pyvista as pv
import trimesh
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree

Field = np.ndarray
Point = tuple[np.ndarray, np.ndarray, np.ndarray]  # x, y, z coordinate arrays (they broadcast)
AXES = {"x": 0, "y": 1, "z": 2}


class Grid:
    """The box of space a shape is sampled in. `lo` and `hi` are opposite corners in mm; make it
    a little larger than the shape. `P` is the (x, y, z) of every sample, to pass to the shapes."""

    PAD = 2  # voxels added on every side, so a shape that reaches lo/hi still closes

    def __init__(self, lo: Sequence[float], hi: Sequence[float], voxel: float = 0.3):
        lo, hi = np.asarray(lo, float), np.asarray(hi, float)
        self.voxel = float(voxel)
        # Offset by half a voxel: flat faces at round numbers (z=0) then fall between samples.
        self.origin = lo - (self.PAD + 0.5) * self.voxel
        self.shape = tuple(int(n) for n in np.ceil((hi - lo) / self.voxel).astype(int) + 2 * self.PAD + 2)
        self.axes = [(self.origin[i] + self.voxel * np.arange(self.shape[i])).astype(np.float32) for i in range(3)]
        self.at: tuple[slice, slice, slice] = (slice(None),) * 3

    @property
    def P(self) -> Point:
        return tuple(np.meshgrid(*self.axes, indexing="ij", sparse=True))

    def full(self, field: Field | float) -> Field:
        """A writable array of the grid's full shape (shapes of one or two axes come out smaller)."""
        return np.array(np.broadcast_to(np.asarray(field, np.float32), self.shape))

    def around(self, center: Sequence[float], radius: float) -> "Grid":
        """The part of the grid within `radius` of a point, for adding many small details fast:
            sub = g.around(c, 4)
            f[sub.at] = sc.smooth_union(f[sub.at], sc.sphere(sub.P, c, 2), 0.5)     # f = g.full(f) first
        """
        sub = object.__new__(Grid)
        sub.voxel, sub.origin = self.voxel, self.origin
        sub.at = tuple(
            slice(max(0, int((center[i] - radius - self.origin[i]) / self.voxel)),
                  min(self.shape[i], int((center[i] + radius - self.origin[i]) / self.voxel) + 2))
            for i in range(3))
        sub.axes = [self.axes[i][sub.at[i]] for i in range(3)]
        sub.shape = tuple(len(a) for a in sub.axes)
        return sub


# --- Moving the coordinates (apply to g.P, then build the shape in the moved frame) -----------------

def move(p: Point, by: Sequence[float]) -> Point:
    """Shapes built on the result are shifted by `by`."""
    return (p[0] - by[0], p[1] - by[1], p[2] - by[2])


def rotate(p: Point, axis: str, degrees: float, about: Sequence[float] = (0, 0, 0)) -> Point:
    """Shapes built on the result are turned `degrees` round `axis` ("x", "y" or "z") through `about`."""
    i = AXES[axis]
    j, k = (i + 1) % 3, (i + 2) % 3
    c, s = np.cos(np.radians(degrees)), np.sin(np.radians(degrees))
    u, v = p[j] - about[j], p[k] - about[k]
    out = [None, None, None]
    out[i] = p[i]
    out[j] = c * u + s * v + about[j]
    out[k] = -s * u + c * v + about[k]
    return tuple(out)


def mirror(p: Point, axis: str = "x") -> Point:
    """Shapes built on the result appear on both sides of the plane axis=0 (place them on the + side)."""
    out = list(p)
    out[AXES[axis]] = np.abs(out[AXES[axis]])
    return tuple(out)


def stretch(p: Point, factors: Sequence[float], about: Sequence[float] = (0, 0, 0)) -> Point:
    """Shapes built on the result are scaled by `factors` (x, y, z). Distances are no longer
    exact, so blend radii act a little differently along the stretched axis."""
    return tuple((p[i] - about[i]) / factors[i] + about[i] for i in range(3))


# --- Shapes (negative inside) ----------------------------------------------------------------

def _len(*v):
    return np.sqrt(sum(c * c for c in v))


def sphere(p: Point, center, r: float) -> Field:
    return _len(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - r


def ellipsoid(p: Point, center, radii) -> Field:
    q = [(p[i] - center[i]) / radii[i] for i in range(3)]
    k0 = _len(*q)
    k1 = _len(*(q[i] / radii[i] for i in range(3)))
    return k0 * (k0 - 1) / np.maximum(k1, 1e-6)


def capsule(p: Point, a, b, r: float, r2: float | None = None) -> Field:
    """A rod with round ends from a to b. With r2 it tapers from radius r at a to r2 at b
    (limbs, tails, horns, drumsticks)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ba = b - a
    pa = [p[i] - a[i] for i in range(3)]
    l2 = float(ba @ ba)
    if r2 is None or abs(r - r2) < 1e-9 or l2 < 1e-12:
        h = np.clip(sum(pa[i] * ba[i] for i in range(3)) / max(l2, 1e-12), 0, 1)
        return _len(*(pa[i] - ba[i] * h for i in range(3))) - r
    rr = r - r2
    a2, il2 = l2 - rr * rr, 1.0 / l2
    y = sum(pa[i] * ba[i] for i in range(3))
    z = y - l2
    x2 = sum((pa[i] * l2 - ba[i] * y) ** 2 for i in range(3))
    y2, z2 = y * y * l2, z * z * l2
    k = np.sign(rr) * rr * rr * x2
    return np.where(np.sign(z) * a2 * z2 > k, np.sqrt(x2 + z2) * il2 - r2,
                    np.where(np.sign(y) * a2 * y2 < k, np.sqrt(x2 + y2) * il2 - r,
                             (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r))


def box(p: Point, center, size, radius: float = 0.0) -> Field:
    """A box of full `size` (x, y, z); `radius` rounds every edge."""
    q = [np.abs(p[i] - center[i]) - (size[i] / 2 - radius) for i in range(3)]
    outside = _len(*(np.maximum(c, 0) for c in q))
    return outside + np.minimum(np.maximum(np.maximum(q[0], q[1]), q[2]), 0) - radius


def cylinder(p: Point, a, b, r: float, radius: float = 0.0) -> Field:
    """A flat-ended cylinder from a to b; `radius` rounds its rims."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ba = b - a
    length = float(np.linalg.norm(ba))
    pa = [p[i] - a[i] for i in range(3)]
    t = sum(pa[i] * ba[i] for i in range(3)) / length  # distance along the axis
    radial = np.sqrt(np.maximum(sum(c * c for c in pa) - t * t, 0))
    dx, dy = radial - (r - radius), np.abs(t - length / 2) - (length / 2 - radius)
    return np.minimum(np.maximum(dx, dy), 0) + _len(np.maximum(dx, 0), np.maximum(dy, 0)) - radius


def torus(p: Point, center, major: float, minor: float, axis: str = "z") -> Field:
    """A ring of tube radius `minor`, `major` from its centre, lying square to `axis`."""
    i = AXES[axis]
    j, k = (i + 1) % 3, (i + 2) % 3
    ring = _len(p[j] - center[j], p[k] - center[k]) - major
    return _len(ring, p[i] - center[i]) - minor


def halfspace(p: Point, point, normal) -> Field:
    """Everything behind a plane: inside is the side `normal` points away from."""
    n = np.asarray(normal, float) / np.linalg.norm(normal)
    return sum((p[i] - point[i]) * n[i] for i in range(3))


# --- Combining ------------------------------------------------------------------------------

def union(*fields: Field) -> Field:
    return np.minimum.reduce(np.broadcast_arrays(*fields)) if len(fields) > 1 else fields[0]


def intersect(*fields: Field) -> Field:
    return np.maximum.reduce(np.broadcast_arrays(*fields)) if len(fields) > 1 else fields[0]


def subtract(a: Field, b: Field) -> Field:
    return np.maximum(a, -b)


def smooth_union(a: Field, b: Field, k: float) -> Field:
    """Join two shapes with a fillet about `k` mm wide. Small k keeps a crease (a limb meeting
    a body), large k melts them into one form."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smooth_subtract(a: Field, b: Field, k: float) -> Field:
    """Carve b out of a with a rounded rim (eye sockets, grooves, dimples)."""
    return -smooth_union(-a, b, k)


def smooth_intersect(a: Field, b: Field, k: float) -> Field:
    return -smooth_union(-a, -b, k)


def offset(f: Field, by: float) -> Field:
    """Grow the shape by `by` mm (negative shrinks it). Also rounds convex corners when grown."""
    return f - by


def shell(f: Field, thickness: float) -> Field:
    """Keep only a skin of this thickness on the inside of the surface."""
    return np.maximum(f, -(f + thickness))


def noise(grid: Grid, scale: float, seed: int = 0) -> Field:
    """Smooth random bumps about `scale` mm across, values roughly -1 to 1 (standard deviation
    0.5). Add `amplitude * sc.noise(g, 2.5)` to a field for skin, bark, stone or dough texture;
    keep the amplitude under a third of the scale so the bumps stay printable."""
    raw = np.random.default_rng(seed).standard_normal(grid.shape).astype(np.float32)
    out = gaussian_filter(raw, scale / grid.voxel / 2)
    return out * (0.5 / max(float(out.std()), 1e-9))


def printable(f: Field, grid: Grid, angle: float = 45.0) -> Field:
    """Fill in under every overhang so nothing leans more than `angle` from vertical, like wax
    running down. A chin, a belly or an outstretched arm then prints without support: each
    gets a web under it that tapers inwards at that angle until it meets the part or the bed.
    Call it last, after all the shapes and textures are in.

    It cannot save something whose lowest point hangs free (a drooping hand, a nose pointing
    down): the web under it tapers to nothing in mid-air. Rest such a tip on the body or the
    bed, or turn it upwards; export() reports these as "starts in mid-air".
    """
    f = grid.full(f)
    # Working down: a point is filled if the layer above is solid there and for `reach` to every
    # side (one layer's worth of lean). "Solid to every side" is the largest field value nearby.
    reach = np.tan(np.radians(angle))  # in voxels per layer
    passes = max(1, int(np.ceil(reach)))
    t = reach / passes
    steps = [(dx, dy, t / np.hypot(dx, dy)) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
    nx, ny = f.shape[:2]
    pad = np.full((nx + 2, ny + 2), np.float32(1e3))  # outside the grid is empty
    for k in range(f.shape[2] - 2, -1, -1):
        solid = f[:, :, k + 1]
        for _ in range(passes):
            pad[1:-1, 1:-1] = solid
            shrunk = solid.copy()
            for dx, dy, w in steps:
                beside = pad[1 + dx:nx + 1 + dx, 1 + dy:ny + 1 + dy]
                np.maximum(shrunk, solid + (beside - solid) * w, out=shrunk)
            solid = shrunk
        np.minimum(f[:, :, k], solid, out=f[:, :, k])
    return f


# --- Fields to meshes, and mesh booleans ------------------------------------------------------

def as_manifold(part) -> manifold3d.Manifold:
    """A manifold3d solid from a mesh, a build123d part or a Manifold."""
    if isinstance(part, manifold3d.Manifold):
        return part
    if not isinstance(part, trimesh.Trimesh):
        verts, tris = part.tessellate(0.01, 0.1)  # build123d / OCC shape
        part = trimesh.Trimesh([tuple(v) for v in verts], tris)  # merges the vertices faces share
        part.update_faces(part.nondegenerate_faces(height=1e-6))  # slivers at sphere poles and fillet corners
        part.remove_unreferenced_vertices()
        if part.volume < 0:
            part.invert()
    solid = manifold3d.Manifold(manifold3d.Mesh(vert_properties=np.asarray(part.vertices, np.float32),
                                                tri_verts=np.asarray(part.faces, np.uint32)))
    if solid.status() != manifold3d.Error.NoError:
        raise ValueError(f"not a closed solid ({solid.status().name}); it must be watertight to cut or join")
    return solid


def to_trimesh(solid, min_volume: float = 1.0) -> trimesh.Trimesh:
    """A mesh that stays watertight when saved as STL. Pieces under `min_volume` mm³ are dropped
    (specks that booleans and textures leave behind).

    Marching cubes and booleans leave some points a few µm apart where two sheets nearly
    touch; STL's 32-bit numbers merge them, which opens the mesh. Tiny edges are removed,
    and any points still that close are nudged 5 µm towards their own faces.
    """
    out = as_manifold(solid).simplify(0.01).to_mesh()
    verts, faces = out.vert_properties[:, :3].astype(np.float64), np.asarray(out.tri_verts)
    for _ in range(5):
        mesh = trimesh.Trimesh(verts, faces, process=False)
        pairs = cKDTree(verts).query_pairs(1e-3, output_type="ndarray")
        if not len(pairs) and _survives_stl(mesh):
            break
        near = np.unique(pairs.ravel()) if len(pairs) else np.arange(0)
        if not len(near):
            break
        sums = np.zeros_like(verts)
        np.add.at(sums, faces.ravel(), np.repeat(verts[faces].mean(axis=1), 3, axis=0))
        hits = np.bincount(faces.ravel(), minlength=len(verts))[:, None]
        towards = sums[near] / np.maximum(hits[near], 1) - verts[near]
        norm = np.linalg.norm(towards, axis=1, keepdims=True)
        ok = norm[:, 0] > 1e-9
        verts[near[ok]] += 0.005 * towards[ok] / norm[ok]
    mesh = trimesh.Trimesh(verts, faces, process=False)
    if min_volume > 0 and mesh.body_count > 1:
        pieces = [c for c in mesh.split(only_watertight=False) if abs(c.volume) >= min_volume]
        if pieces and len(pieces) < mesh.body_count:
            mesh = trimesh.util.concatenate(pieces)
    return mesh


def _survives_stl(mesh: trimesh.Trimesh) -> bool:
    data = trimesh.util.wrap_as_stream(mesh.export(file_type="stl"))
    return trimesh.load_mesh(data, file_type="stl").is_volume


def mesh(f: Field, grid: Grid, floor: float | None = 0.0, min_volume: float = 1.0) -> trimesh.Trimesh:
    """The surface of a field (where it is 0) as a watertight mesh. Everything below `floor` is
    cut off exactly flat, so the part sits on the bed; floor=None keeps the whole shape."""
    f = grid.full(f)
    if floor is not None:
        # Cut one voxel low with the grid, then trim exactly: a cut on a grid plane would leave holes.
        f = np.maximum(f, (floor - grid.voxel) - grid.P[2])
    edge = min(f[0].min(), f[-1].min(), f[:, 0].min(), f[:, -1].min(), f[:, :, 0].min(), f[:, :, -1].min())
    if edge < 0:
        raise ValueError("the shape reaches the edge of the Grid; make the Grid larger"
                         + ("" if floor is not None else " or pass floor="))
    f[f == 0] = 1e-4  # a surface exactly through a sample makes marching cubes leave holes
    image = pv.ImageData(dimensions=grid.shape, spacing=(grid.voxel,) * 3, origin=tuple(grid.origin))
    image.point_data["d"] = f.ravel(order="F")
    surf = image.contour([0.0], scalars="d", method="contour").triangulate().clean()
    if surf.n_cells == 0:
        raise ValueError("the field has no surface inside the Grid (nothing is negative)")
    raw = trimesh.Trimesh(surf.points, surf.faces.reshape(-1, 4)[:, 1:])
    raw.fix_normals()
    if raw.volume < 0:  # fix_normals can leave a single shell inside out
        raw.invert()
    solid = as_manifold(raw)
    if floor is not None:
        solid = solid.trim_by_plane((0, 0, 1), floor)
    return to_trimesh(solid, min_volume)


def cut(part, *tools) -> trimesh.Trimesh:
    """`part` with the tools removed. Parts can be meshes or build123d solids."""
    solid = as_manifold(part)
    for tool in tools:
        solid -= as_manifold(tool)
    return to_trimesh(solid)


def join(*parts) -> trimesh.Trimesh:
    """All the parts as one solid."""
    solid = as_manifold(parts[0])
    for part in parts[1:]:
        solid += as_manifold(part)
    return to_trimesh(solid)


def common(a, b) -> trimesh.Trimesh:
    """The volume the two share."""
    return to_trimesh(as_manifold(a) ^ as_manifold(b))


def split(whole, region) -> tuple[trimesh.Trimesh, trimesh.Trimesh]:
    """Two touching parts for a two-colour print: `whole` outside the region, and inside it.
    The region can be any solid or mesh, e.g. a sculpted skin `sc.mesh(sc.shell(f, 1.2) ...)`,
    a build123d box round the feet, or a traced logo extruded through the surface."""
    whole, region = as_manifold(whole), as_manifold(region)
    return to_trimesh(whole - region), to_trimesh(whole ^ region)
