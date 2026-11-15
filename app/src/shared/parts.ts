// Naming rules shared by the main process and the renderer.

/**
 * The script that most likely exports `name`: "<stem>.py" where the export name is the stem
 * or extends it with "_<label>", longest stem first ("case_v2.py" before "case.py").
 */
export function scriptFor(scripts: string[], name: string): string | undefined {
  return [...scripts]
    .sort((a, b) => b.length - a.length)
    .find((s) => {
      const stem = s.replace(/\.py$/, "");
      return name === stem || name.startsWith(`${stem}_`);
    });
}
