// Electron main process: window, file protocol, IPC, project watcher and agent.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import type { AgentEvent, ChatSettings, ImageAttachment, Nozzle, PermissionAnswer, RunOutput } from "../shared/api";
import { Agent } from "./agent";
import { Projects } from "./projects";
import { startMemoryLog } from "./memlog";

const here = path.dirname(fileURLToPath(import.meta.url)); // app/dist, or app.asar/dist when packaged
// Same data folder (~/.config/print3d-studio) for `npm start` and the installed app.
app.setPath("userData", path.join(app.getPath("appData"), "print3d-studio"));
const configFile = path.join(app.getPath("userData"), "config.json");

let ROOT = "";
let projects: Projects;
let agent: Agent;
let win: BrowserWindow | undefined;
// The agent and watcher can still emit while the app shuts down, after the window is gone.
const send = (channel: string, payload?: unknown) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
};

const isRepo = (dir?: string) => !!dir && existsSync(path.join(dir, "projects"));

function savedRoot(): string | undefined {
  try {
    return JSON.parse(readFileSync(configFile, "utf8")).root;
  } catch {
    return undefined;
  }
}

/** Ask for the repo folder (the one containing projects/) and remember it. */
async function chooseRoot(): Promise<string | undefined> {
  for (;;) {
    const res = await dialog.showOpenDialog({
      title: "Choose your 3D printing repo (the folder that contains projects/)",
      defaultPath: ROOT || os.homedir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return undefined;
    const dir = res.filePaths[0];
    if (isRepo(dir)) {
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, JSON.stringify({ root: dir }, null, 2));
      return dir;
    }
    await dialog.showMessageBox({ type: "warning", message: `${dir} has no projects/ folder. Choose the repo's top folder.` });
  }
}

/**
 * Apps started from the desktop menu don't get the login shell's PATH, so
 * uv (~/.local/bin) and friends would be missing for scripts and Claude's Bash tool.
 */
function fixPath() {
  const dirs: string[] = [];
  try {
    const out = execFileSync(process.env.SHELL || "/bin/bash", ["-ilc", 'printf "__PATH__%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    dirs.push(...(out.split("__PATH__")[1] ?? "").split(":"));
  } catch {
    // no usable login shell: keep the PATH the app was started with
  }
  dirs.push(...(process.env.PATH ?? "").split(":"), path.join(os.homedir(), ".local/bin"));
  process.env.PATH = [...new Set(dirs.filter(Boolean))].join(":");
}

/** When packaged, the SDK's Claude Code binary is unpacked next to app.asar. */
function claudeBinary(): string | undefined {
  if (!app.isPackaged) return undefined;
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked/node_modules/@anthropic-ai",
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    "claude",
  );
}

// proj://files/<project>/<path> serves files from inside projects/ only.
protocol.registerSchemesAsPrivileged([
  { scheme: "proj", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R) {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)));
}

function registerIpc() {
  handle("root", () => ROOT);
  handle("root:change", async () => {
    const dir = await chooseRoot();
    if (dir && dir !== ROOT) {
      app.relaunch();
      app.exit(0);
    }
  });
  handle("printer:nozzle", () => projects.nozzle());
  handle("printer:setNozzle", (n: Nozzle) => projects.setNozzle(n));
  handle("projects:list", () => projects.list());
  handle("projects:create", (name: string) => projects.create(name));
  handle("projects:readText", (p: string, f: string) => projects.readText(p, f));
  handle("projects:writeScript", (p: string, f: string, text: string) => projects.writeScript(p, f, text));
  handle("projects:run", (p: string, script: string) => {
    const runId = randomUUID();
    projects.run(p, script, runId, (o: RunOutput) => send("run:output", o));
    return runId;
  });
  handle("projects:openInBambu", (p: string, f: string) => projects.openInBambu(p, f));
  handle("projects:deletePart", async (p: string, part: string) => {
    const { files, script, scriptShared } = await projects.partFiles(p, part);
    const opts = {
      type: "warning" as const,
      title: "Delete part",
      message: `Delete the part "${part}"?`,
      detail: `Moves ${files.length} file${files.length === 1 ? "" : "s"} to the Trash:\n${files.join("\n")}`,
      buttons: ["Cancel", "Move to Trash"],
      defaultId: 1,
      cancelId: 0,
      ...(script && {
        checkboxLabel: scriptShared ? `Also delete ${script} (it exports other parts too)` : `Also delete ${script}`,
        checkboxChecked: !scriptShared,
      }),
    };
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (res.response !== 1) return false;
    if (script && res.checkboxChecked) files.push(script);
    for (const f of files) await shell.trashItem(projects.resolve(p, f));
    return true;
  });
  handle("projects:openFolder", async (p: string) => {
    const err = await shell.openPath(projects.resolve(p));
    if (err) throw new Error(err);
  });

  handle("agent:models", () => agent.listModels());
  handle("agent:sessions", (p: string) => agent.listSessions(p));
  handle("agent:open", (p: string, id: string | null) => agent.openSession(p, id));
  handle("agent:send", async (p: string, text: string, s: ChatSettings, images: ImageAttachment[] = []) => {
    const saved = await Promise.all(images.map((img) => projects.saveRef(p, img.name, Buffer.from(img.file, "base64"))));
    return agent.send(p, text, s, images.map((img, i) => ({ ...img, path: saved[i] })), await projects.nozzle());
  });
  handle("agent:interrupt", (p: string) => agent.interrupt(p));
  handle("agent:settings", (p: string, s: ChatSettings) => agent.updateSettings(p, s));
  handle("agent:permission", (p: string, id: string, a: PermissionAnswer) => agent.answerPermission(p, id, a));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: "Print3D Studio",
    icon: path.join(here, "icon.png"),
    backgroundColor: "#16181d",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => (win = undefined));
  win.removeMenu();
  // Links in chat open in the system browser, never inside the app. Markdown links are plain
  // <a href>, which arrive as a navigation; target="_blank" and window.open arrive as a new window.
  const openLink = (url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => {
    e.preventDefault();
    openLink(e.url);
  });
  win.loadFile(path.join(here, "index.html"));
  if (process.env.STUDIO_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });

  // Test hook: STUDIO_SCREENSHOT=<file> saves a screenshot after load and quits.
  const shot = process.env.STUDIO_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        // Optional test script, e.g. clicking a tab, run just before the capture.
        if (process.env.STUDIO_SCREENSHOT_JS) {
          await win!.webContents.executeJavaScript(process.env.STUDIO_SCREENSHOT_JS);
          await new Promise((r) => setTimeout(r, 1500));
        }
        const img = await win!.webContents.capturePage();
        await writeFile(shot, img.toPNG());
        app.quit();
      }, Number(process.env.STUDIO_SCREENSHOT_DELAY ?? 2500)),
    );
  }
}

app.whenReady().then(async () => {
  protocol.handle("proj", async (req) => {
    try {
      const [project, ...rest] = decodeURIComponent(new URL(req.url).pathname).replace(/^\//, "").split("/");
      const res = await net.fetch(pathToFileURL(projects.resolve(project, rest.join("/"))).toString());
      // The page is a file:// origin, so fetch() (used for STLs) needs CORS headers.
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  fixPath();
  // The repo: PRINT3D_ROOT, the saved choice, in development the folder holding app/, else ask.
  const devRoot = app.isPackaged ? undefined : path.resolve(here, "..", "..");
  const root = [process.env.PRINT3D_ROOT, savedRoot(), devRoot].find(isRepo) ?? (await chooseRoot());
  if (!root) return app.quit();
  ROOT = path.resolve(root);
  projects = new Projects(ROOT);
  agent = new Agent(ROOT, app.getPath("userData"), (e: AgentEvent) => send("agent:event", e), claudeBinary());

  startMemoryLog(path.join(app.getPath("userData"), "memory.log"));
  await agent.init();
  registerIpc();
  projects.watch(() => send("projects:changed"));
  createWindow();
}).catch((err: Error) => {
  dialog.showErrorBox("Print3D Studio could not start", err.stack ?? err.message);
  app.exit(1);
});

app.on("before-quit", () => agent?.closeAll());
app.on("window-all-closed", () => app.quit());
