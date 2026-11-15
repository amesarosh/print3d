"""Show or change the nozzle fitted to the printer.

    uv run -m print3d.nozzle          # the current nozzle and the quality presets it has
    uv run -m print3d.nozzle 0.4      # switch (writes printer.json at the repo root)

Exports made after the switch are sliced for the new nozzle. 3MFs made before it are not:
run their scripts again.
"""

import sys

from . import slicer


def main() -> None:
    if len(sys.argv) > 1:
        try:
            value = slicer.set_nozzle(sys.argv[1].removesuffix("mm"))
        except ValueError as err:
            raise SystemExit(str(err)) from None
        print(f"nozzle set to {value} mm. Run a part's script again to re-slice it for this nozzle.")
        return
    presets = slicer.process_presets()
    for n in slicer.NOZZLES:
        rows = ", ".join(f"{tier} {h:.2f}" for h, tier, _ in presets[n]) or "no presets found"
        print(f"{'*' if n == slicer.NOZZLE else ' '} {n} mm   {rows}")
    print(f"\nfitted: {slicer.NOZZLE} mm (walls and raised details at least {2 * slicer.LINE_WIDTH:.1f} mm)")


if __name__ == "__main__":
    main()
