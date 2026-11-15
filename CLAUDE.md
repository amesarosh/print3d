# 3D printing parts with Print3d

This project designs parts for a **Bambu Lab A1** (256 × 256 × 256 mm bed, PLA by default) as build123d Python scripts. The nozzle changes: check it with `uv run -m print3d.nozzle` before designing.

## Layout

- `print3d/`: shared tools.
  - `__init__.py`: `export()` and the check. `analyze.py`: printability notes. `preview.py`: the renders. `slicer.py`: slicing.
  - `sculpt.py`: organic shapes (figures, animals, food) as blended fields. `finish.py`: `soften()` rounds a build123d part's edges.
  - `image.py`: tracing flat graphics and photo reliefs. `view.py`: close-ups and cross-sections of an exported part.
- `projects/<project>/`: one folder per project, holding everything for it:
  - `<name>.py`: one script per part or variant (a project can have several).
  - `ref/`: inputs such as manufacturer STEP models, downloaded 3MF/STL files and reference images.
  - `out/`: generated files (3MF, STL, STEP, PNG). `export()` writes to the running script's `out/`.
- New work goes in a new project folder; related parts and variants share one.

## Parts and versions

The export name says which part a file belongs to and which version it is:

- `<part>` is version 1, `<part>_v2` is version 2, and so on. The app shows these as one part with a version switcher.
- **A new iteration of the same part** (a redesign, a fix after a test print): copy the latest script to `<part>_v<N+1>.py` and export it as `<part>_v<N+1>`. Leave the old scripts and outputs alone, so the user can compare and go back.
- **A small tweak the user doesn't need to keep the old version of** (a typo, a tolerance they asked to change right after seeing it): edit the latest version's script in place.
- **A separate part** (a lid for a box, a different holder) or **a variant made alongside it** (slim/regular, left/right) gets its own name, never ending in `_v<number>`. Multi-part prints (`export({"body": …, "lid": …}, name)`) stay one part.

## Workflow

1. Write the script in `projects/<project>/<name>.py`. Copy the import header from `projects/sculpt_demo/whale.py`. End the script with `export(part, "<name>", process=..., settings={...})`, choosing print settings that suit the part (see the same script).
2. Run it: `uv run projects/<project>/<name>.py`. This writes `out/<name>.3mf` (a sliced Bambu Studio project with all print settings), `.stl`, `.step`, `.png` and `out/check/<name>.png`, and prints the size, the check, `print:` notes (overhangs, places that start in mid-air, bridges, bed contact, thinnest wall) and the slicer's time and filament estimate.
3. **Look at the result before saying it's done.** Read both pictures:
   - `out/<name>.png`: iso, front, right and top. Does it look like what was asked for, and would the user be pleased with it?
   - `out/check/<name>.png`: the back, the underside (red = overhang that needs support, blue = touching the bed) and two cross-sections (wall thickness, cavities, anything hidden inside).
   - Unsure about a detail? Look closer rather than guess: `uv run -m print3d.view projects/<project>/out/<name> --from back`, `--at x,y,z --radius 8` for a close-up, `--cut x=0` for a section. It prints the PNG's path.
4. Fix what you see and what the `print:` notes report, and run again. Expect two or three rounds on anything with a shape to get right; the first render is a draft, not the result. While shaping, pass `draft=True` to `export()`: it skips slicing, so a round takes seconds. The final run must be without it (a draft leaves no 3MF).
5. The user opens the 3MF in Bambu Studio and prints: `flatpak run com.bambulab.BambuStudio projects/<project>/out/<name>.3mf`. (The slicer module can still slice with OrcaSlicer: set `SLICER = "orca"` in `print3d/slicer.py`.)

## Making it look good

A part that only meets its dimensions looks like a block. What makes it look designed depends on what it is, so decide that first:

- **A functional part** (bracket, holder, case, adapter): model it in build123d.
- **A figure or anything organic** (animal, character, food, plant, a hat for a decoration): sculpt it with `print3d.sculpt`. Boxes and cylinders glued together never look like a creature.
- **A flat graphic** (logo, sign, keychain, stencil): trace it, see "From an image".
- Mix them freely: a sculpted figure on a build123d base, a traced logo cut into a case (`sculpt.cut()`, `join()` and `split()` take meshes and build123d parts alike).

Before writing code, picture the finished object and note its main forms, its proportions and the two or three features that make it recognisable. Those must survive at print size.

### Functional parts (build123d)

- Finish with `soften(part, radius)` from `print3d.finish`: it rounds every edge and chamfers the ones on the bed, and reports the radius it managed. 1–2 mm suits most parts. For a generous outline, fillet the vertical edges yourself first (`fillet(part.edges().filter_by(Axis.Z), 5)`), then `soften` the rest.
- Give it proportions, not just clearances: consistent wall thickness, ribs or gussets where a wall meets a base, holes and slots aligned and evenly spaced, the same radius repeated.
- Thin flat plates look cheap and warp: a rim, a rib or a slight crown costs little.
- Text and logos: at least 6 mm tall with 1.2 mm strokes, raised or recessed 0.6–1 mm, on a face that prints upright or on top.

### Sculpted parts (print3d.sculpt)

Read `projects/sculpt_demo/whale.py` first; `print3d/sculpt.py` documents every function.

- A shape is a field on a `Grid`: build simple shapes (`ellipsoid`, `capsule`, `sphere`, `box`, `cylinder`, `torus`), place them with `rotate` / `move` / `mirror`, and blend them with `smooth_union(a, b, k)`. `k` is the width of the blend in mm: large for forms that grow out of each other (neck into body), small to keep a crease (a limb against a body).
- Work coarse to fine, checking the render at each stage: (1) the big masses and the silhouette from the front, side and top; (2) secondary forms such as limbs, ears, tail; (3) carved and raised detail with `smooth_subtract` / `smooth_union`; (4) surface texture with `noise`. Don't add detail to a silhouette that is still wrong.
- Exaggerate. Printed small in one colour, subtle forms vanish: make heads, eyes, hands and other identifying features larger than life, grooves at least 1 mm wide and deep, raised details at least 1.2 mm.
- Use `mirror(g.P, "y")` for everything that comes in pairs, so the figure is symmetric.
- Finish with `printable(f, g)`, then `mesh(f, g)`. `printable` fills under every overhang to a 45° slope, so the figure prints without support. It can't rescue a tip that hangs free below its root (a drooping hand, a chin lower than the neck): rest such tips on the body or the bed, or point them up. The `print:` notes and the red in the check image show what is left.
- Sink the figure 1–2 mm into the bed (`mesh(f, g, floor=...)`) or stand it on a base, so it has a wide flat footprint.
- Colours: sculpt the whole shape, then `split(whole, region)` gives two touching parts for `export(..., colors=...)`. Put colour boundaries where the object has them (belly, clothing, eyes); with the AMS lite every colour change on a layer costs time and purge, so prefer few colours in large areas.
- Use `voxel=0.6` with `draft=True` while shaping and `voxel=0.3` for the final run.

## Print settings (print3d/slicer.py)

- **Nozzle.** The user swaps nozzles (0.2, 0.4, 0.6 or 0.8 mm). The fitted one is in `printer.json` at the repo root; they change it in the app's sidebar or with `uv run -m print3d.nozzle 0.4`. `uv run -m print3d.nozzle` shows it with its presets, and every export's `slice:` line names it. Only change it yourself if the user asks. `PRINT3D_NOZZLE=0.4 uv run …` overrides it for one run.
- It picks the printer `Bambu Lab A1 <nozzle> nozzle` and filament `ELEGOO PLA Matte @Bambu Lab A1 <nozzle> nozzle` (the user's Bambu Studio profile). Plate `Textured PEI Plate`.
- `process` is a quality tier, so a script works with any nozzle: `"Fine"`, `"Optimal"` (default), `"Standard"`, `"Draft"` or `"Extra Draft"`. Layer heights for 0.2 / 0.4 / 0.6 / 0.8 mm nozzles: Fine 0.06 / 0.12 / 0.18 / 0.24, Optimal 0.08 / 0.16 / 0.24 / 0.32, Standard 0.10 / 0.20 / 0.30 / 0.40, Draft 0.12 / 0.24 / 0.36 / 0.48. A full preset name (`"0.20mm Standard @BBL A1"`, as older scripts have) still works: one made for another nozzle is swapped for the fitted nozzle's equivalent, with a `note:` line saying which.
- A printed line is about the nozzle's width: keep walls and raised details at least two lines (0.4 mm nozzle: 0.8 mm; 0.6: 1.2 mm; 0.8: 1.6 mm). The wider the nozzle, the softer text and fine detail come out; where this file gives a size for the 0.6 nozzle, scale it. A part designed for one nozzle may need its thin features checked on another: the `print:` notes use the fitted nozzle's minimum wall.
- `settings` overrides process keys using the slicer's names and string values, e.g. `wall_loops`, `sparse_infill_density`, `sparse_infill_pattern`, `enable_support`, `support_type`, `brim_type`, `top_shell_layers`. An unknown key raises an error. For multicolour prints it also takes `flush_multiplier` (e.g. `["0.6"]`, scales the purge on every colour change) and `flush_volumes_matrix`.
- Tell the user which settings you chose and why.
- Multicolour (AMS lite): `export({"core": a, "white": b, …}, name, colors={"core": "#1A1A1A", "white": "#F2F2F2", …})` keeps the parts in place and prints them as one object, one filament slot per distinct colour. Parts can be `trimesh.Trimesh` too. For photo reliefs, `print3d.image.relief_mesh()` builds touching core and colour-skin parts from height maps (see `projects/image_test/tuxedo_cat_v2.py`).

## Design rules

- All dimensions in mm, as named constants at the top of the script so they're easy to change.
- Place the part flat on z=0, in the orientation it should print in.
- Minimise overhangs past 45° and avoid bridges longer than ~20 mm. Chamfer bottom edges instead of filleting them (`soften()` does both). The `print:` notes list every overhang past 50°, each point that would start in mid-air, and the thinnest wall: fix them in the design, or turn on supports and say why.
- Minimum wall: two lines of the fitted nozzle (see "Print settings"); 2 mm+ for anything that takes load.
- Clearances: 0.2 mm per side for sliding fits, 0.1 mm for press fits. Holes print slightly small: add 0.2–0.3 mm to the diameter.
- Common hardware: M3 clearance hole 3.4 mm, M3 heat-set insert hole 4.0 mm; M4 clearance 4.5 mm; M5 clearance 5.5 mm.
- The check must say OK (one watertight body, fits the bed, sits on z=0).
- Ask about unknown dimensions (what it attaches to, screw sizes) rather than guessing.

## From an image

When the user gives an image (in the app it's saved to `projects/<project>/ref/`), look at it first and decide which kind it is:

1. **Flat graphic** (logo, silhouette, icon, lettering, cookie-cutter or stencil shape): trace it with `print3d.image`.
   - `outline(REF / "logo.png", width=60)` returns build123d faces of the subject (dark on light, light on dark, or opaque on transparent), centred on the origin, image-up as +Y. `width`/`height` is the traced shape's size in mm. Then `extrude`, add a base plate, a keyring hole, etc.
   - `regions(REF / "badge.png", width=80, colors=3)` splits by colour (background first) for multi-height parts: a base from all non-background regions, then raise or recess each colour by a layer or more. Regions overlap by 0.2 mm so they fuse.
   - Both print a report and save an overlay at `out/trace/<name>.png`. **Read the overlay** and check the trace caught the right shape; adjust `invert`, `threshold`, `smooth` or `colors` if not. Red in the overlay is narrower than `min_feature`: thicken it (`offset`) or drop it, as walls under ~1.2 mm print poorly.
   - Parts must be one body: join separate islands (letters, dots) with a base plate or bridges.
2. **Drawing, sketch or photo of an object** (a bracket with dimensions, a photo of a broken part, a product shot): don't trace. Read the shape and dimensions from the picture and model it parametrically like any other part. Take sizes from dimension labels or a reference object in the photo; ask (AskUserQuestion) for any size you can't read, especially the overall size and anything it must fit.

Either way, ask for the overall size if the user didn't give one, say which interpretation you took, and compare the final `out/<name>.png` against the source image before finishing. For a photo of something organic (a pet, a toy, a character), sculpt it (`print3d.sculpt`) using the photo for proportions and features.

## Enclosures for electronics

- Get the manufacturer's STEP model into the project's `ref/<board>/` and place it in the design (see `projects/xiao_cam_case/xiao_cam_case.py`). Check `(part & board).volume == 0` instead of trusting datasheet numbers.
- Multi-part prints: pass a dict to `export({"body": body, "lid": lid}, name)`, with each part already in its print orientation.
- Pick a print orientation with no unsupported flat ceilings; bevel undersides to 45° or keep bridges under ~20 mm.
