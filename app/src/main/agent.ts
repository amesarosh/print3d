// Runs one Claude Agent SDK session per project and relays it to the renderer.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  ChatItem,
  ChatSettings,
  ImageAttachment,
  ModelOption,
  PermissionAnswer,
  SavedSession,
} from "../shared/api";

/** Async queue used as the SDK's streaming prompt, so one session takes many messages. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting?: (r: IteratorResult<T>) => void;
  private closed = false;

  push(item: T) {
    if (this.waiting) {
      this.waiting({ value: item, done: false });
      this.waiting = undefined;
    } else this.items.push(item);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

interface LiveSession {
  q: Query;
  inbox: Inbox<SDKUserMessage>;
  settings: ChatSettings;
  sessionId?: string;
  /** A turn is running (from a send until its result). */
  busy: boolean;
  /** The nozzle Claude was last told about. */
  nozzle?: string;
  pending: Map<string, PendingPermission>;
}

/** Remembers which SDK sessions belong to which project (the SDK lists them per directory, not per project). */
class SessionIndex {
  private data: Record<string, SavedSession[]> = {};
  constructor(private file: string) {}

  async load() {
    if (!existsSync(this.file)) return;
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      // A damaged index only loses the chat list, not the chats; start a new one rather than fail to launch.
    }
  }

  list(project: string): SavedSession[] {
    return [...(this.data[project] ?? [])].sort((a, b) => b.updated - a.updated);
  }

  async touch(project: string, id: string, title?: string) {
    const list = (this.data[project] ??= []);
    const existing = list.find((s) => s.id === id);
    if (existing) existing.updated = Date.now();
    else list.push({ id, title: title ?? "Untitled chat", updated: Date.now() });
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2));
  }
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** Built-in tools the chat gets; everything else is left out to save tokens. */
const APP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion", "WebSearch", "WebFetch"];

function appPrompt(project: string): string {
  return [
    "You are running inside Print3D Studio, a desktop app for this repository.",
    `The user is working on the project in \`projects/${project}/\`. Unless they say otherwise, keep new scripts and files in that folder.`,
    "Follow CLAUDE.md. After writing or changing a script, run it with `uv run`, then Read both the preview (out/<name>.png) and the check image (out/check/<name>.png) and act on the `print:` notes before saying it is done.",
    "Aim for a part the user would be proud to print, not the first shape that meets the numbers. Follow \"Making it look good\" in CLAUDE.md: sculpt figures and organic shapes with print3d.sculpt, finish functional parts with soften(), and expect to look, fix and rerun two or three times (with draft=True while shaping). Use `uv run -m print3d.view` for a close-up or a cross-section when a detail is hard to judge.",
    "The app shows the project's out/ folder itself: the PNG preview, an interactive 3D view of the STLs, and a button that opens the 3MF in Bambu Studio. So don't tell the user how to open files; say what you made, the print settings you chose and why, the slicer's time and filament estimate, and anything that needs their decision.",
    "Use the AskUserQuestion tool when a dimension or design choice is unknown.",
    "When changing an existing part, follow \"Parts and versions\" in CLAUDE.md: a new iteration goes in <part>_v<N+1>.py, exported as <part>_v<N+1>.",
    "When the user attaches images, they are saved in the project's ref/ folder (the <attachments> note gives the paths). Follow the \"From an image\" section of CLAUDE.md.",
  ].join("\n");
}

export class Agent {
  private live = new Map<string, LiveSession>();
  /** Session to resume on the next send, per project (null = start fresh). */
  private resumeId = new Map<string, string | null>();
  /** The first message of a chat that has no session id yet; it becomes the chat's title. */
  private firstPrompt = new Map<string, string>();
  private index: SessionIndex;
  private models?: ModelOption[];

  constructor(
    private root: string,
    dataDir: string,
    private emit: (e: AgentEvent) => void,
    /** Claude Code binary to run; needed when packaged, since the SDK would look inside app.asar. */
    private claudePath?: string,
  ) {
    this.index = new SessionIndex(path.join(dataDir, "sessions.json"));
  }

  init() {
    return this.index.load();
  }

  listSessions(project: string) {
    return this.index.list(project);
  }

  /** Switch the project's chat to a saved session (or a new one) and return its transcript. */
  async openSession(project: string, sessionId: string | null): Promise<ChatItem[]> {
    this.close(project);
    this.resumeId.set(project, sessionId);
    if (!sessionId) return [];
    let messages: Awaited<ReturnType<typeof getSessionMessages>>;
    try {
      messages = await getSessionMessages(sessionId, { dir: this.root });
    } catch (err) {
      const text = `Couldn't load this chat's earlier messages: ${(err as Error).message}`;
      return [{ kind: "info", id: randomUUID(), text, level: "error" }];
    }
    return messages.flatMap((m): ChatItem[] => {
      if (m.parent_tool_use_id) return [];
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (m.type === "assistant") return [{ kind: "assistant", id: m.uuid, content, parentToolUseId: null }];
      if (m.type === "user") return [{ kind: "user", id: m.uuid, content }];
      return [];
    });
  }

  async send(
    project: string,
    text: string,
    settings: ChatSettings,
    images: (ImageAttachment & { path: string })[] = [],
    nozzle?: string,
  ) {
    let s = this.live.get(project);
    // Effort is fixed when a session starts, so restart (resuming the same conversation) to change it.
    // Not during a turn, though: that would cut off the work in progress. It applies on the next idle send.
    if (s && !s.busy && s.settings.effort !== settings.effort) {
      this.resumeId.set(project, s.sessionId ?? null);
      this.close(project);
      s = undefined;
    }
    // The model or permission mode may have changed while another project's chat was shown.
    if (s) await this.updateSettings(project, settings);
    else s = this.start(project, settings);
    s.busy = true;

    const id = randomUUID();
    if (!text && images.length) text = images.length > 1 ? "Make a model from these images." : "Make a model from this image.";
    // Claude sees the scaled copies; the note (hidden in the transcript) says where the originals are.
    // Notes for Claude that the transcript hides: where attachments are, and the nozzle when it
    // is new to this session (the user can change it at any time in the sidebar).
    const notes: string[] = [];
    if (images.length)
      notes.push(
        `<attachments>\nThe user attached ${images.length > 1 ? "these images" : "this image"}, saved at full resolution as:\n${images.map((i) => `- ${i.path}`).join("\n")}\n</attachments>`,
      );
    if (nozzle && nozzle !== s.nozzle) {
      notes.push(
        `<printer>\nThe printer has a ${nozzle} mm nozzle fitted${s.nozzle ? ` (it was ${s.nozzle} mm)` : ""}. export() slices for it; design walls and details for it (see "Print settings" in CLAUDE.md).\n</printer>`,
      );
      s.nozzle = nozzle;
    }
    const content =
      images.length || notes.length
        ? [
            ...images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.previewType, data: img.preview },
            })),
            ...notes.map((note) => ({ type: "text" as const, text: note })),
            { type: "text" as const, text },
          ]
        : text;
    this.emit({ type: "items", project, items: [{ kind: "user", id, content }] });
    this.emit({ type: "status", project, busy: true, sessionId: s.sessionId });
    s.inbox.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    if (s.sessionId) await this.index.touch(project, s.sessionId);
    else this.firstPrompt.set(project, text);
  }

  private start(project: string, settings: ChatSettings): LiveSession {
    const inbox = new Inbox<SDKUserMessage>();
    const pending = new Map<string, PendingPermission>();
    const resume = this.resumeId.get(project) ?? undefined;

    const canUseTool: CanUseTool = (toolName, input, opts) =>
      new Promise((resolve) => {
        const id = randomUUID();
        pending.set(id, { resolve, input, suggestions: opts.suggestions });
        opts.signal.addEventListener(
          "abort",
          () => {
            if (pending.delete(id)) {
              this.emit({ type: "permission-done", project, id });
              resolve({ behavior: "deny", message: "Cancelled" });
            }
          },
          { once: true },
        );
        this.emit({
          type: "permission",
          project,
          request: {
            id,
            toolName,
            input,
            title: opts.title,
            canAlwaysAllow: !!opts.suggestions?.length && toolName !== "AskUserQuestion",
          },
        });
      });

    const q = query({
      prompt: inbox,
      options: {
        cwd: this.root,
        pathToClaudeCodeExecutable: this.claudePath,
        model: settings.model,
        effort: settings.effort,
        permissionMode: settings.permissionMode,
        canUseTool,
        resume,
        // Keep the context small: only the project's settings and CLAUDE.md, the tools this app
        // needs, and none of the user's own MCP servers, claude.ai connectors, skills or plugins.
        settingSources: ["project", "local"],
        tools: APP_TOOLS,
        mcpServers: {},
        strictMcpConfig: true,
        skills: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: appPrompt(project) },
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "print3d-studio/0.2.0" },
      },
    });

    const session: LiveSession = { q, inbox, settings, pending, sessionId: resume, busy: false };
    this.live.set(project, session);
    void this.pump(project, session);
    return session;
  }

  /** Forward SDK messages to the renderer until the session ends. */
  private async pump(project: string, s: LiveSession) {
    try {
      for await (const msg of s.q) {
        await this.handle(project, s, msg);
      }
    } catch (err) {
      if (this.live.get(project) === s) {
        this.info(project, `Agent stopped: ${(err as Error).message}`, "error");
      }
    } finally {
      if (this.live.get(project) === s) {
        this.live.delete(project);
        this.resumeId.set(project, s.sessionId ?? null);
        this.emit({ type: "status", project, busy: false, sessionId: s.sessionId });
      }
    }
  }

  private async handle(project: string, s: LiveSession, msg: SDKMessage) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          const isNew = s.sessionId !== msg.session_id;
          s.sessionId = msg.session_id;
          this.emit({ type: "status", project, busy: true, sessionId: msg.session_id, model: msg.model });
          if (isNew) {
            const title = (this.firstPrompt.get(project) ?? "").replace(/\s+/g, " ").slice(0, 80);
            await this.index.touch(project, msg.session_id, title || undefined);
          }
        } else if (msg.subtype === "api_retry") {
          this.info(project, "API error, retrying…", "info");
        }
        return;
      case "assistant":
        if (msg.parent_tool_use_id) return; // subagent internals
        if (msg.error) this.info(project, `Error: ${msg.error}`, "error");
        this.emit({
          type: "items",
          project,
          items: [{ kind: "assistant", id: msg.uuid, content: msg.message.content, parentToolUseId: null }],
        });
        return;
      case "user":
        if (msg.parent_tool_use_id || msg.isSynthetic) return;
        this.emit({
          type: "items",
          project,
          items: [{ kind: "user", id: msg.uuid ?? randomUUID(), content: msg.message.content }],
        });
        return;
      case "result": {
        const ok = msg.subtype === "success" && !msg.is_error;
        s.busy = false;
        this.emit({
          type: "items",
          project,
          items: [
            {
              kind: "result",
              id: msg.uuid,
              ok,
              text: msg.subtype === "success" ? "" : msg.subtype.replace(/_/g, " "),
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              turns: msg.num_turns,
            },
          ],
        });
        this.emit({ type: "status", project, busy: false, sessionId: s.sessionId });
        return;
      }
    }
  }

  answerPermission(project: string, id: string, answer: PermissionAnswer) {
    const s = this.live.get(project);
    const p = s?.pending.get(id);
    if (!s || !p) return;
    s.pending.delete(id);
    this.emit({ type: "permission-done", project, id });
    if (answer.behavior === "deny") {
      p.resolve({ behavior: "deny", message: answer.message });
    } else {
      p.resolve({
        behavior: "allow",
        updatedInput: answer.updatedInput ?? p.input,
        updatedPermissions: answer.always ? p.suggestions : undefined,
      });
    }
  }

  async interrupt(project: string) {
    const s = this.live.get(project);
    if (!s) return;
    for (const [id, p] of s.pending) {
      p.resolve({ behavior: "deny", message: "Interrupted by the user", interrupt: true });
      this.emit({ type: "permission-done", project, id });
    }
    s.pending.clear();
    await s.q.interrupt();
  }

  async updateSettings(project: string, settings: ChatSettings) {
    const s = this.live.get(project);
    if (!s) return;
    if (settings.model !== s.settings.model) await s.q.setModel(settings.model);
    if (settings.permissionMode !== s.settings.permissionMode) await s.q.setPermissionMode(settings.permissionMode);
    s.settings = { ...settings, effort: s.settings.effort }; // effort applies on the next send
  }

  /** Ask Claude Code which models this account can use; falls back to the aliases. */
  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    const inbox = new Inbox<SDKUserMessage>();
    const q = query({ prompt: inbox, options: { cwd: this.root, settingSources: [], pathToClaudeCodeExecutable: this.claudePath } });
    let timer: NodeJS.Timeout | undefined;
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), 20000))),
      ]);
      this.models = models.map((m) => ({ value: m.value, label: m.displayName, description: m.description }));
      return this.models;
    } catch {
      return FALLBACK_MODELS; // not remembered, so the next call asks again
    } finally {
      clearTimeout(timer);
      inbox.close();
      q.close();
    }
  }

  close(project: string) {
    const s = this.live.get(project);
    if (!s) return;
    this.live.delete(project);
    for (const [id, p] of s.pending) {
      p.resolve({ behavior: "deny", message: "Session closed" });
      this.emit({ type: "permission-done", project, id });
    }
    s.pending.clear();
    s.inbox.close();
    s.q.close();
    this.emit({ type: "status", project, busy: false, sessionId: s.sessionId });
  }

  closeAll() {
    for (const project of [...this.live.keys()]) this.close(project);
  }

  private info(project: string, text: string, level: "info" | "error") {
    this.emit({ type: "items", project, items: [{ kind: "info", id: randomUUID(), text, level }] });
  }
}
