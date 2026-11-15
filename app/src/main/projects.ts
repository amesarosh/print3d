// Reads the repo's projects/ folder and runs project scripts.
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NOZZLES, type Nozzle, type OutputGroup, type Part, type ProjectInfo, type RunOutput } from "../shared/api";
import { scriptFor } from "../shared/parts";

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OUTPUT_EXT = new Set([".png", ".stl", ".3mf", ".step"]);
const VERSIONED = /^(.+)_v(\d+)$/;

/** A file's modification time in ms, or undefined if it has gone (exports delete and rewrite files while we scan). */
const mtimeOf = (file: string) => stat(file).then((s) => s.mtimeMs, () => undefined);

/** Group export names into parts: "bracket", "bracket_v2" and "bracket_v3" are versions 1–3 of "bracket". */
export function groupParts(outputs: OutputGroup[]): Part[] {
  const parts = new Map<string, Part>();
  for (const g of outputs) {
    const m = VERSIONED.exec(g.name);
    const name = m ? m[1] : g.name;
    const part = parts.get(name) ?? { name, versions: [], mtime: 0 };
    part.versions.push({ ...g, version: m ? Number(m[2]) : 1 });
    part.mtime = Math.max(part.mtime, g.mtime);
    parts.set(name, part);
  }
  for (const p of parts.values()) p.versions.sort((a, b) => a.version - b.version);
  return [...parts.values()].sort((a, b) => b.mtime - a.mtime);
}

export class Projects {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, "projects");
  }

  private get printerFile() {
    return path.join(this.root, "printer.json");
  }

  /** The nozzle fitted to the printer, from printer.json (0.4, what the A1 ships with, if unset). */
  async nozzle(): Promise<Nozzle> {
    try {
      const value = Number(JSON.parse(await readFile(this.printerFile, "utf8")).nozzle).toFixed(1);
      return (NOZZLES as readonly string[]).includes(value) ? (value as Nozzle) : "0.4";
    } catch {
      return "0.4";
    }
  }

  async setNozzle(nozzle: Nozzle): Promise<void> {
    if (!NOZZLES.includes(nozzle)) throw new Error(`Not an A1 nozzle: ${nozzle}`);
    await writeFile(this.printerFile, `${JSON.stringify({ nozzle }, null, 2)}\n`);
  }

  /** Absolute path of a file inside a project, refusing anything that escapes it. */
  resolve(project: string, file = ""): string {
    if (!PROJECT_NAME.test(project)) throw new Error(`Bad project name: ${project}`);
    const base = path.join(this.dir, project);
    const full = path.resolve(base, file);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`Path escapes project: ${file}`);
    return full;
  }

  async list(): Promise<ProjectInfo[]> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((e) => e.isDirectory() && PROJECT_NAME.test(e.name)).map((e) => this.info(e.name)),
    );
    return projects.sort((a, b) => b.mtime - a.mtime);
  }

  async info(name: string): Promise<ProjectInfo> {
    const base = this.resolve(name);
    const files = await readdir(base, { withFileTypes: true });
    const scripts = files.filter((f) => f.isFile() && f.name.endsWith(".py")).map((f) => f.name).sort();
    let mtime = (await stat(base)).mtimeMs;
    for (const s of scripts) mtime = Math.max(mtime, (await mtimeOf(path.join(base, s))) ?? 0);

    const outputs = await this.outputs(base);
    if (outputs[0]) mtime = Math.max(mtime, outputs[0].mtime);
    return { name, scripts, outputs, parts: groupParts(outputs), mtime };
  }

  /**
   * Group out/ files by the name passed to export(): "case.png", "case.3mf",
   * "case_body.stl" and "case_lid.stl" all belong to "case".
   */
  private async outputs(base: string): Promise<OutputGroup[]> {
    let names: string[];
    try {
      names = await readdir(path.join(base, "out"));
    } catch {
      return [];
    }
    const files = names.filter((n) => OUTPUT_EXT.has(path.extname(n).toLowerCase()));
    const stems = files.filter((n) => /\.(png|3mf)$/i.test(n)).map((n) => n.replace(/\.[^.]+$/, ""));
    const groups = new Map<string, OutputGroup>(stems.map((s) => [s, { name: s, stls: [], mtime: 0 }]));
    const owner = (stem: string) =>
      groups.get(stem) ??
      // a part STL "<name>_<label>": pick the longest group name it extends
      [...groups.values()].filter((g) => stem.startsWith(g.name + "_")).sort((a, b) => b.name.length - a.name.length)[0];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const g = owner(file.slice(0, -ext.length));
      if (!g) continue;
      const rel = `out/${file}`;
      const mtime = await mtimeOf(path.join(base, rel));
      if (mtime === undefined) continue;
      if (ext === ".png") {
        g.png = rel;
        g.pngMtime = mtime;
      } else if (ext === ".3mf") g.tmf = rel;
      else if (ext === ".step") g.step = rel;
      else g.stls.push(rel);
      g.mtime = Math.max(g.mtime, mtime);
    }
    for (const g of groups.values()) {
      g.stls.sort();
      await this.readColors(base, g);
    }
    return [...groups.values()].sort((a, b) => b.mtime - a.mtime);
  }

  /** Attach a multicolour export's pieces, listed in out/<name>_colors/colors.json by export(). */
  private async readColors(base: string, g: OutputGroup) {
    const dir = `out/${g.name}_colors`;
    try {
      const file = path.join(base, dir, "colors.json");
      const list = JSON.parse(await readFile(file, "utf8")) as { label: string; stl: string; color: string }[];
      g.colors = list
        .filter((c) => /^#[0-9a-f]{6}$/i.test(c.color) && /^[^/\\]+\.stl$/i.test(c.stl))
        .map((c) => ({ label: String(c.label), stl: `${dir}/${c.stl}`, color: c.color }));
      g.mtime = Math.max(g.mtime, (await stat(file)).mtimeMs);
    } catch {
      // not a multicolour export
    }
  }

  /**
   * The files of one part (an output group) and the script that most likely
   * exports it (see scriptFor). `scriptShared` is true when other parts come from that script too.
   */
  async partFiles(project: string, part: string) {
    const info = await this.info(project);
    const group = info.outputs.find((g) => g.name === part);
    if (!group) throw new Error(`No part named ${part}`);
    const files = [group.png, group.tmf, group.step, ...group.stls].filter((f): f is string => !!f);
    if (group.colors) files.push(`out/${group.name}_colors`); // the per-colour STLs
    const script = scriptFor(info.scripts, part);
    const scriptShared = !!script && info.outputs.some((g) => g.name !== part && scriptFor(info.scripts, g.name) === script);
    return { files, script, scriptShared };
  }

  async create(name: string): Promise<void> {
    if (!PROJECT_NAME.test(name)) throw new Error("Use lowercase letters, digits, _ or - for the project name.");
    await mkdir(this.resolve(name), { recursive: false });
  }

  /**
   * Save an attached image to the project's ref/ folder under a safe, unused
   * name and return its path relative to the repo root.
   */
  async saveRef(project: string, name: string, data: Buffer): Promise<string> {
    const ext = (path.extname(name).toLowerCase().match(/^\.(png|jpe?g|webp|gif|bmp)$/) ?? [".png"])[0];
    const stem =
      path
        .basename(name, path.extname(name))
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60) || "image";
    const dir = this.resolve(project, "ref");
    await mkdir(dir, { recursive: true });
    for (let i = 1; ; i++) {
      const file = path.join(dir, `${stem}${i > 1 ? `_${i}` : ""}${ext}`);
      try {
        await writeFile(file, data, { flag: "wx" }); // fails if the name is taken
        return path.relative(this.root, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }

  /** Overwrite a .py script in the project, via a temp file so a crash can't leave it half-written. */
  async writeScript(project: string, file: string, text: string): Promise<void> {
    if (!file.endsWith(".py")) throw new Error("Only .py scripts can be saved");
    const full = this.resolve(project, file);
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, full);
  }

  readText(project: string, file: string): Promise<string> {
    return readFile(this.resolve(project, file), "utf8");
  }

  /** Run `uv run projects/<project>/<script>` from the repo root, streaming output. */
  run(project: string, script: string, runId: string, emit: (o: RunOutput) => void): void {
    if (!script.endsWith(".py")) throw new Error("Only .py scripts can be run");
    const file = this.resolve(project, script);
    const child = spawn("uv", ["run", path.relative(this.root, file)], {
      cwd: this.root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const send = (chunk: Buffer) => emit({ runId, project, script, chunk: chunk.toString() });
    child.stdout.on("data", send);
    child.stderr.on("data", send);
    child.on("error", (err) => {
      emit({ runId, project, script, chunk: `${err.message}\n` });
      emit({ runId, project, script, exitCode: null });
    });
    child.on("close", (code) => emit({ runId, project, script, exitCode: code }));
  }

  /** Open a 3MF in Bambu Studio (Flatpak), detached from the app. */
  openInBambu(project: string, file: string): void {
    const full = this.resolve(project, file);
    if (!full.endsWith(".3mf")) throw new Error("Only .3mf files open in Bambu Studio");
    const child = spawn("flatpak", ["run", "com.bambulab.BambuStudio", full], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // reported to the user only if flatpak is missing; nothing to clean up
    child.unref();
  }

  /** Call onChange (debounced) whenever anything under projects/ changes. */
  watch(onChange: () => void): FSWatcher {
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(this.dir, { recursive: true }, (_event, file) => {
      if (file && /__pycache__|\.pyc$|~$|\.swp$|\.tmp$/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 300);
    });
    // Folders vanish mid-scan during exports; an unhandled "error" event would take the app down.
    watcher.on("error", () => {});
    return watcher;
  }
}
