"""Finishing touches for build123d parts: the difference between a block and a product.

    from print3d.finish import soften
    part = soften(part, radius=1.5)           # round the edges, chamfer the ones on the bed

OCC's fillet fails on the whole part if a single edge can't take the radius, and now and
then returns torn faces without saying so. soften() works down from the radius asked for,
checks each result still closes, and says what it did.
"""

import copy

import trimesh
from build123d import Part, chamfer, fillet

BED_EPS = 1e-4


def _sound(part) -> bool:
    """True if the part still meshes as one closed surface. OCC sometimes returns a fillet
    it calls valid whose faces are torn or folded; those must not get into a print."""
    # On a copy: meshing a shape loosens its bounding boxes, which the edge tests below rely on.
    verts, tris = copy.deepcopy(part).tessellate(0.02, 0.2)
    mesh = trimesh.Trimesh([tuple(v) for v in verts], tris)
    mesh.update_faces(mesh.nondegenerate_faces(height=1e-6))
    return mesh.is_watertight


def _try(op, part, edges, size):
    try:
        out = op(edges, size)
        before, after = part.bounding_box(), out.bounding_box()
        inside = all(getattr(after.min, a) > getattr(before.min, a) - 1e-3 and
                     getattr(after.max, a) < getattr(before.max, a) + 1e-3 for a in "XYZ")
        return out if out.is_valid and inside and out.volume > 0.5 * part.volume and _sound(out) else None
    except Exception:  # OCC raises many kinds of error for an impossible fillet
        return None


def _low(edge, below: float) -> bool:
    """True if the whole edge is at or under a height (judged by its ends and its middle)."""
    return max([v.Z for v in edge.vertices()] + [edge.center().Z]) < below + BED_EPS


def soften(part: Part, radius: float = 1.0, bed_chamfer: float = 0.4, min_radius: float = 0.25,
           quiet: bool = False) -> Part:
    """Round every edge of `part` by `radius` mm and chamfer the edges resting on the bed by
    `bed_chamfer` (a fillet there would curl up off the plate; the chamfer also hides
    elephant's foot). Do this last, after all holes and cuts.

    If the part can't take `radius` everywhere (a thin wall, a small step), the radius is
    halved until it can, down to `min_radius`; the line it prints says what was used. For a
    big radius on the outline and a small one elsewhere, fillet the outline's edges yourself
    first (e.g. `fillet(part.edges().filter_by(Axis.Z), 6)`), then soften the rest.
    Rounding an edge moves it, so on parts that must fit something, check the fit after.
    """
    floor = min(v.Z for v in part.vertices())
    if bed_chamfer > 0:
        bed = [e for e in part.edges() if _low(e, floor)]
        out = bed and _try(chamfer, part, bed, bed_chamfer)
        if out:
            part = out
        else:
            bed_chamfer = 0
    # The chamfer's own edges are too close together to round.
    edges = [e for e in part.edges() if not _low(e, floor + bed_chamfer)]
    used, r = None, radius
    while edges and r >= min_radius:
        out = _try(fillet, part, edges, r)
        if out:
            part, used = out, r
            break
        r /= 2
    if not quiet:
        print("soften: " + (f"rounded {len(edges)} edges at {used:g} mm" + ("" if used == radius else f" (asked {radius:g})")
                            if used else f"no rounding possible at {min_radius:g} mm or more")
              + (f", chamfered the bed edges {bed_chamfer:g} mm" if bed_chamfer > 0 else ""))
    return part
