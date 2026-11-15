import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  ChatItem,
  ChatSettings,
  ModelOption,
  Nozzle,
  OutputGroup,
  Part,
  PermissionAnswer,
  PermissionRequest,
  ProjectInfo,
  RunOutput,
  SavedSession,
} from "../shared/api";
import { NOZZLES } from "../shared/api";
import { scriptFor } from "../shared/parts";
import { Chat, type ChatProps } from "./Chat";
import { ScriptEditor, type ScriptEditorHandle } from "./ScriptEditor";
import { StlViewer, useParts, type PartSource, type PartsState } from "./StlViewer";
import { api, errorText } from "./studio";
import "@fontsource/chakra-petch/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";

interface ChatState {
  items: ChatItem[];
  busy: boolean;
  permissions: PermissionRequest[];
  sessionId?: string;
}
interface RunState {
  runId: string;
  script: string;
  log: string;
  exitCode?: number | null;
  running: boolean;
}

const emptyChat: ChatState = { items: [], busy: false, permissions: [] };
const fileUrl = (project: string, rel: string) => `proj://files/${project}/${rel}`;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable or full: the choice just isn't remembered
  }
}

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** The script to show for an output group: the one that exports it, else the project's first. */
const scriptOf = (project: ProjectInfo, group?: OutputGroup) =>
  (group && scriptFor(project.scripts, group.name)) ?? project.scripts[0];

const mm = (n: number) => n.toFixed(1);

/** A preview PNG is four views in a 2 x 2 grid; a thumbnail shows the iso view (top left), printed as a cyanotype. */
function Thumb({ src }: { src?: string }) {
  if (!src) return <span className="thumb thumb--empty" aria-hidden="true" />;
  return (
    <span className="thumb print" aria-hidden="true">
      <img src={src} alt="" />
    </span>
  );
}

function Sidebar(props: {
  projects: ProjectInfo[];
  selected?: string;
  busy: Set<string>;
  root: string;
  nozzle?: Nozzle;
  onNozzle: (nozzle: Nozzle) => void;
  onSelect: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  const create = async () => {
    try {
      const n = name.trim().toLowerCase().replace(/\s+/g, "_");
      await api.createProject(n);
      setCreating(false);
      setName("");
      setError(undefined);
      props.onSelect(n);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="wordmark">Print3D Studio</div>
      <div className="side-head">
        <h2>Projects</h2>
        <button type="button" className="btn btn--quiet btn--s" onClick={() => setCreating(!creating)} aria-expanded={creating}>
          New
        </button>
      </div>
      {creating && (
        <div className="new-project">
          <label htmlFor="new-project-name">Folder name</label>
          <input
            id="new-project-name"
            className="input"
            autoFocus
            placeholder="wall_hook"
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "new-project-error" : undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          {error && (
            <p className="field-error" id="new-project-error">
              {error}
            </p>
          )}
        </div>
      )}
      <ul className="project-list">
        {props.projects.map((p) => {
          const latest = p.outputs[0];
          return (
            <li key={p.name}>
              <button
                type="button"
                className="project"
                aria-current={p.name === props.selected ? "page" : undefined}
                onClick={() => props.onSelect(p.name)}
              >
                <Thumb src={latest?.png && `${fileUrl(p.name, latest.png)}?v=${latest.mtime}`} />
                <span className="project-text">
                  <span className="project-name">{p.name}</span>
                  <span className="project-meta">
                    {props.busy.has(p.name)
                      ? "Claude is working"
                      : `${p.scripts.length} script${p.scripts.length === 1 ? "" : "s"}, ${ago(p.mtime)}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="side-foot">
        <label className="side-setting">
          <span>Nozzle</span>
          <select
            className="input"
            value={props.nozzle ?? ""}
            disabled={!props.nozzle}
            onChange={(e) => props.onNozzle(e.target.value as Nozzle)}
            title="The nozzle fitted to the printer. Parts are sliced for it the next time their script runs."
          >
            {NOZZLES.map((n) => (
              <option key={n} value={n}>
                {n} mm
              </option>
            ))}
          </select>
        </label>
        <span className="side-root" title={props.root}>
          {props.root.replace(/^\/home\/[^/]+/, "~")}
        </span>
        <button type="button" className="btn btn--quiet btn--s" onClick={() => api.changeRoot()}>
          Change folder
        </button>
      </div>
    </nav>
  );
}

/** The drawing's title block: the part, its measured size, its files and the print action. */
function TitleBlock(props: {
  part: Part;
  group: OutputGroup & { version: number };
  parts: PartsState;
  script?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { group, parts } = props;
  const versions = props.part.versions.length;
  const files = [group.tmf && "3MF", group.step && "STEP", group.stls.length && `${group.stls.length} STL`, group.png && "PNG"]
    .filter(Boolean)
    .join(", ");
  return (
    <dl className="titleblock">
      <div className="tb-cell tb-part">
        <dt>Part</dt>
        <dd>
          {props.part.name}
          {versions > 1 && (
            <span className="tb-version">
              v{group.version} of {versions}
            </span>
          )}
        </dd>
      </div>
      <div className="tb-cell tb-size">
        <dt>Size, W × D × H</dt>
        <dd className="num">
          {parts.status === "ready" && parts.assembled ? (
            <>
              <span className="tb-line">
                {mm(parts.size.x)} × {mm(parts.size.y)} × {mm(parts.size.z)}&nbsp;mm
              </span>
              <span className="tb-colors" aria-label={`${parts.parts.length} colours`}>
                {parts.parts.map((p) => (
                  <span key={p.label} className="tb-color" title={p.color}>
                    <span className="swatch" style={{ background: p.color }} aria-hidden="true" />
                    {p.label}
                  </span>
                ))}
              </span>
            </>
          ) : parts.status === "ready"
            ? parts.parts.map((p) => (
                <span key={p.label || "part"} className="tb-line">
                  {p.label && <span className="tb-label">{p.label}</span>}
                  {mm(p.size.x)} × {mm(p.size.y)} × {mm(p.size.z)}&nbsp;mm
                </span>
              ))
            : parts.status === "loading"
              ? "Measuring…"
              : "Not measured"}
        </dd>
      </div>
      <div className="tb-cell">
        <dt>Files</dt>
        <dd>{files}</dd>
      </div>
      <div className="tb-cell">
        <dt>Script</dt>
        <dd className="num">{props.script ?? "None"}</dd>
      </div>
      <div className="tb-cell">
        <dt>Exported</dt>
        <dd>{ago(group.mtime)}</dd>
      </div>
      <div className="tb-cell tb-action">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!group.tmf}
          onClick={props.onOpen}
          title={group.tmf ? undefined : "This part has no 3MF yet. Run its script to slice it."}
        >
          Open in Bambu Studio
        </button>
        <button type="button" className="btn btn--quiet btn--s btn--danger" onClick={props.onDelete}>
          {versions > 1 ? `Delete v${group.version}…` : "Delete part…"}
        </button>
      </div>
    </dl>
  );
}

const VIEWS = [
  { id: "3d", label: "3D" },
  { id: "script", label: "Script" },
] as const;

function Workspace(props: {
  project: ProjectInfo;
  run?: RunState;
  onRun: (script: string) => Promise<void>;
  onClearRun: () => void;
  /** Set to this workspace's unsaved-changes check, so the app can ask before switching project. */
  leaveGuard: RefObject<() => boolean>;
}) {
  const { project } = props;
  const [selected, setSelected] = useState<string>(); // part name
  const [version, setVersion] = useState<number>(); // undefined: the latest
  const [view, setView] = useState<"3d" | "script">("3d");
  const [script, setScript] = useState<string>();
  const [error, setError] = useState<string>();
  const editor = useRef<ScriptEditorHandle>(null);
  /** False if the user has unsaved edits and doesn't want to drop them. */
  const canLeave = () => !editor.current?.dirty() || confirm(`Discard your unsaved changes to ${activeScript}?`);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    props.leaveGuard.current = canLeave;
  });

  const part = project.parts.find((p) => p.name === selected) ?? project.parts[0];
  const latest = part?.versions[part.versions.length - 1];
  const group = part?.versions.find((v) => v.version === version) ?? latest;
  const activeScript = script && project.scripts.includes(script) ? script : scriptOf(project, group);

  const choose = (name?: string, v?: number, force = false) => {
    if (!force && !canLeave()) return;
    setSelected(name);
    setVersion(v);
    setScript(undefined); // follow the chosen version's script
  };

  useEffect(() => choose(undefined, undefined, true), [project.name]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [props.run?.log]);

  const act = (fn: () => Promise<unknown>) => fn().catch((e: unknown) => setError(errorText(e)));
  // A multicolour print shows its colour pieces; otherwise the exported STLs.
  const sources = useMemo<PartSource[]>(
    () =>
      !group
        ? []
        : group.colors?.length
          ? group.colors.map((c) => ({ url: fileUrl(project.name, c.stl), label: c.label, color: c.color }))
          : group.stls.map((s) => ({ url: fileUrl(project.name, s) })),
    [group, project.name],
  );
  // Reload the 3D view once per export, when the PNG (written last) changes, not on every file it writes.
  const parts = useParts(sources, group?.name ?? "", group?.pngMtime ?? group?.mtime ?? 0);
  const enabled = { "3d": !!(group?.stls.length || group?.colors?.length), script: project.scripts.length > 0 };
  const run = props.run;

  return (
    <main className="workspace">
      <header className="ws-head">
        <h1>{project.name}</h1>
        <button type="button" className="btn btn--quiet" onClick={() => act(() => api.openFolder(project.name))}>
          Open folder
        </button>
      </header>

      {project.parts.length > 0 && (
        <nav className="sheets" aria-label="Parts in this project">
          {project.parts.map((p) => {
            const last = p.versions[p.versions.length - 1];
            return (
              <button
                type="button"
                key={p.name}
                className="sheet-tab"
                aria-current={p.name === part?.name ? "true" : undefined}
                onClick={() => p.name !== part?.name && choose(p.name)}
                title={p.versions.length > 1 ? `${p.name}, ${p.versions.length} versions` : p.name}
              >
                <Thumb src={last.png && `${fileUrl(project.name, last.png)}?v=${last.mtime}`} />
                <span>{p.name}</span>
                {p.versions.length > 1 && <span className="sheet-version">v{last.version}</span>}
              </button>
            );
          })}
        </nav>
      )}

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button
              type="button"
              role="tab"
              key={v.id}
              aria-selected={view === v.id}
              disabled={!enabled[v.id]}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {part && part.versions.length > 1 && (
          <div className="seg versions" role="tablist" aria-label={`Versions of ${part.name}`}>
            {part.versions.map((v) => (
              <button
                type="button"
                role="tab"
                key={v.name}
                aria-selected={v.name === group?.name}
                onClick={() => choose(part.name, v === latest ? undefined : v.version)}
                title={`${v.name}, exported ${ago(v.mtime)}${v === latest ? " (latest)" : ""}`}
              >
                v{v.version}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {project.scripts.length > 0 && (
          <>
            <select className="input" aria-label="Script" value={activeScript} onChange={(e) => canLeave() && setScript(e.target.value)}>
              {project.scripts.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() =>
                activeScript &&
                act(async () => {
                  if (editor.current?.dirty()) await editor.current.save(); // run what's on screen
                  await props.onRun(activeScript);
                })
              }
              title={editor.current?.dirty() ? "Saves your changes, then runs the script" : undefined}
              disabled={run?.running}
              aria-busy={run?.running || undefined}
            >
              {run?.running ? "Running…" : "Run script"}
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="banner" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--quiet btn--s" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <div className={`sheet ${view === "3d" && enabled["3d"] ? "sheet--grid" : ""}`}>
        {activeScript && (
          // Stays mounted while you look at the 3D view, so unsaved edits survive.
          <div className="editor-slot" hidden={view !== "script"}>
            <ScriptEditor ref={editor} project={project.name} file={activeScript} mtime={project.mtime} />
          </div>
        )}
        {!group && view !== "script" ? (
          <div className="empty">
            <h2>No parts yet</h2>
            <p>Describe one in the chat. Claude writes the script, runs it, and the part appears here.</p>
          </div>
        ) : view === "3d" && enabled["3d"] ? (
          parts.status === "ready" ? (
            <StlViewer parts={parts.parts} assembled={parts.assembled} />
          ) : parts.status === "loading" ? (
            <p className="empty" aria-live="polite">
              Loading the part…
            </p>
          ) : (
            <div className="empty" role="alert">
              <h2>The part did not load</h2>
              <p>{parts.message} Run the script again to rewrite it.</p>
            </div>
          )
        ) : view === "script" ? null : (
          <p className="empty">This part has nothing to show in this view.</p>
        )}
      </div>

      {part && group && (
        <TitleBlock
          part={part}
          group={group}
          parts={parts}
          script={activeScript}
          onOpen={() => group.tmf && act(() => api.openInBambu(project.name, group.tmf!))}
          onDelete={() =>
            act(async () => {
              if (await api.deletePart(project.name, group.name)) choose(part.versions.length > 1 ? part.name : undefined);
            })
          }
        />
      )}

      {run && (
        <section className="runlog" aria-label="Script output">
          <header className="runlog-head">
            <span className="num">uv run {run.script}</span>
            <span className="runlog-state" data-state={run.running ? "running" : run.exitCode === 0 ? "ok" : "failed"}>
              {run.running ? "Running" : run.exitCode === 0 ? "Finished" : `Failed, exit ${run.exitCode}`}
            </span>
            <span className="spacer" />
            {!run.running && (
              <button type="button" className="btn btn--quiet btn--s" onClick={props.onClearRun}>
                Close
              </button>
            )}
          </header>
          <pre ref={logRef}>{run.log}</pre>
        </section>
      )}
    </main>
  );
}

function App() {
  const [root, setRoot] = useState("");
  const [nozzle, setNozzle] = useState<Nozzle>();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => load("selected", undefined));
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [sessions, setSessions] = useState<Record<string, SavedSession[]>>({});
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [models, setModels] = useState<ModelOption[]>([{ value: "opus", label: "Opus" }]);
  const [settings, setSettings] = useState<ChatSettings>(() =>
    load("settings", { model: "opus", effort: "high", permissionMode: "acceptEdits" }),
  );
  const opened = useRef(new Set<string>());
  /** Each project's session id as last reported, to refresh its chat list when a new one starts. */
  const knownSession = useRef<Record<string, string | undefined>>({});
  const leaveGuard = useRef<() => boolean>(() => true);

  // The nozzle is re-read with the projects, so a change made outside the app shows up on the next refresh.
  const refresh = useCallback(() => {
    api.getNozzle().then(setNozzle);
    return api.listProjects().then(setProjects);
  }, []);

  const changeNozzle = (n: Nozzle) => {
    setNozzle(n);
    api.setNozzle(n).catch(() => api.getNozzle().then(setNozzle));
  };

  useEffect(() => {
    api.root().then(setRoot);
    refresh();
    api.listModels().then((m) => m.length && setModels(m));
    const offChange = api.onProjectsChanged(refresh);
    const offRun = api.onRunOutput((o: RunOutput) =>
      setRuns((r) => {
        const cur = r[o.project];
        if (!cur || cur.runId !== o.runId) return r;
        return {
          ...r,
          [o.project]: {
            ...cur,
            log: cur.log + (o.chunk ?? ""),
            ...(o.exitCode !== undefined ? { exitCode: o.exitCode, running: false } : {}),
          },
        };
      }),
    );
    const offAgent = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === "status" && e.sessionId && e.sessionId !== knownSession.current[e.project]) {
        knownSession.current[e.project] = e.sessionId;
        api.listSessions(e.project).then((s) => setSessions((x) => ({ ...x, [e.project]: s })));
      }
      setChats((all) => {
        const c = all[e.project] ?? emptyChat;
        switch (e.type) {
          case "items": {
            // Streamed assistant messages can repeat an id; replace rather than duplicate.
            const items = [...c.items];
            for (const it of e.items) {
              const i = items.findIndex((x) => x.id === it.id);
              if (i >= 0) items[i] = it;
              else items.push(it);
            }
            return { ...all, [e.project]: { ...c, items } };
          }
          case "status":
            return { ...all, [e.project]: { ...c, busy: e.busy, sessionId: e.sessionId ?? c.sessionId } };
          case "permission":
            return { ...all, [e.project]: { ...c, permissions: [...c.permissions, e.request] } };
          case "permission-done":
            return { ...all, [e.project]: { ...c, permissions: c.permissions.filter((p) => p.id !== e.id) } };
        }
      });
    });
    return () => {
      offChange();
      offRun();
      offAgent();
    };
  }, [refresh]);

  const project = projects.find((p) => p.name === selected) ?? projects[0];

  const openSession = useCallback(async (name: string, id: string | null) => {
    const items = await api.openSession(name, id);
    knownSession.current[name] = id ?? undefined;
    setChats((all) => ({ ...all, [name]: { ...emptyChat, items, sessionId: id ?? undefined } }));
  }, []);

  // First visit to a project: show its most recent chat (resumed on the next message).
  useEffect(() => {
    if (!project || opened.current.has(project.name)) return;
    opened.current.add(project.name);
    api.listSessions(project.name).then((list) => {
      setSessions((x) => ({ ...x, [project.name]: list }));
      openSession(project.name, list[0]?.id ?? null);
    });
  }, [project?.name, openSession]);

  const changeSettings = (s: ChatSettings) => {
    setSettings(s);
    save("settings", s);
    if (project) api.updateSettings(project.name, s);
  };

  const select = (name: string) => {
    if (name !== project?.name && !leaveGuard.current()) return; // unsaved script edits
    setSelected(name);
    save("selected", name);
  };

  const run = async (script: string) => {
    if (!project) return;
    const runId = await api.runScript(project.name, script);
    setRuns((r) => ({ ...r, [project.name]: { runId, script, log: "", running: true } }));
  };

  const sendMessage = (name: string, ...args: Parameters<ChatProps["onSend"]>) =>
    api.send(name, args[0], settings, args[1]).catch((e: unknown) => {
      const item: ChatItem = { kind: "info", id: crypto.randomUUID(), text: `Couldn't send the message: ${errorText(e)}`, level: "error" };
      setChats((all) => {
        const c = all[name] ?? emptyChat;
        return { ...all, [name]: { ...c, items: [...c.items, item] } };
      });
    });

  const busy = new Set(Object.entries(chats).filter(([, c]) => c.busy).map(([n]) => n));
  const chat = (project && chats[project.name]) || emptyChat;

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selected={project?.name}
        busy={busy}
        root={root}
        nozzle={nozzle}
        onNozzle={changeNozzle}
        onSelect={select}
      />
      {project ? (
        <>
          <Workspace
            project={project}
            run={runs[project.name]}
            onRun={run}
            onClearRun={() => setRuns(({ [project.name]: _closed, ...rest }) => rest)}
            leaveGuard={leaveGuard}
          />
          <Chat
            project={project.name}
            root={root}
            items={chat.items}
            busy={chat.busy}
            permissions={chat.permissions}
            sessions={sessions[project.name] ?? []}
            sessionId={chat.sessionId}
            models={models}
            settings={settings}
            onSettings={changeSettings}
            onSend={(text, images) => sendMessage(project.name, text, images)}
            onInterrupt={() => api.interrupt(project.name)}
            onAnswer={(id, a: PermissionAnswer) => api.answerPermission(project.name, id, a)}
            onOpenSession={(id) => openSession(project.name, id)}
          />
        </>
      ) : (
        <main className="workspace empty">Create a project to get started.</main>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
