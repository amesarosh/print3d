// Writes the app's memory use to a log every minute, plus any crashed process, so that
// a crash (e.g. systemd-oomd killing the app) leaves a trail in ~/.config/print3d-studio/memory.log.
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { app } from "electron";

const INTERVAL_MS = 60_000;
const MAX_BYTES = 1_000_000; // then the log moves to memory.log.1 and starts over

/**
 * Memory of the app's whole cgroup in MB: Electron plus everything it starts (Claude Code,
 * scripts, the slicer). This is the number systemd-oomd judges. Linux only.
 */
function cgroupMB(): number | undefined {
  try {
    const rel = readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1];
    if (!rel) return;
    return Math.round(Number(readFileSync(`/sys/fs/cgroup${rel.trim()}/memory.current`, "utf8")) / 2 ** 20);
  } catch {
    return;
  }
}

export function startMemoryLog(file: string) {
  const write = (line: string) => {
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, file + ".1");
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never break the app
    }
  };

  const sample = () => {
    // Electron's own processes (main, window, GPU, ...), resident memory in MB.
    const byType = new Map<string, number>();
    for (const m of app.getAppMetrics()) {
      byType.set(m.type, (byType.get(m.type) ?? 0) + m.memory.workingSetSize / 1024);
    }
    const electron = [...byType].map(([t, kb]) => `${t}=${Math.round(kb)}`).join(" ");
    const total = cgroupMB();
    write(`${total !== undefined ? `total=${total}MB ` : ""}electron(MB): ${electron}`);
  };

  write(`app started, pid ${process.pid}`);
  sample();
  setInterval(sample, INTERVAL_MS).unref();

  app.on("render-process-gone", (_e, _wc, d) => write(`window process gone: ${d.reason} (exit ${d.exitCode})`));
  app.on("child-process-gone", (_e, d) => write(`${d.type} process gone: ${d.reason} (exit ${d.exitCode})`));
}
