// Chat panel: transcript, tool calls, permission prompts and the composer.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatItem,
  ChatSettings,
  ImageAttachment,
  ModelOption,
  PermissionAnswer,
  PermissionRequest,
  SavedSession,
} from "../shared/api";

type Block = { type: string; [k: string]: any };

const blocks = (content: unknown): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const MAX_PREVIEW_PX = 1568; // the longest edge Claude takes without downscaling
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const base64Of = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function drawScaled(img: HTMLImageElement, maxPx: number, background?: string) {
  const w0 = img.naturalWidth || 1024;
  const h0 = img.naturalHeight || 1024;
  const k = Math.min(1, maxPx / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w0 * k));
  canvas.height = Math.max(1, Math.round(h0 * k));
  const ctx = canvas.getContext("2d")!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Read a dropped or pasted image: keep the original for ref/, and make a scaled copy for Claude. */
async function toAttachment(file: File): Promise<ImageAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 30 MB`);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const svg = file.type === "image/svg+xml";
    let name = !file.name || file.name === "image.png" ? "pasted.png" : file.name;
    if (svg) name = name.replace(/\.svg$/i, "") + ".png"; // the tracer reads raster images
    const fileData = svg ? drawScaled(img, 2048).toDataURL("image/png").split(",")[1] : await base64Of(file);

    let previewType: ImageAttachment["previewType"] = "image/png";
    let preview = drawScaled(img, MAX_PREVIEW_PX).toDataURL("image/png").split(",")[1];
    if (preview.length > 4_000_000) {
      previewType = "image/jpeg";
      preview = drawScaled(img, MAX_PREVIEW_PX, "#ffffff").toDataURL("image/jpeg", 0.9).split(",")[1];
    }
    return { name, file: fileData, preview, previewType };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One-line summary of a tool call for its card header. */
function toolSummary(name: string, input: Record<string, any>, root: string): string {
  const rel = (p?: string) => (p && root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p ?? "");
  switch (name) {
    case "Bash":
      return input.description || input.command;
    case "Read":
    case "Write":
    case "Edit":
      return rel(input.file_path);
    case "Glob":
    case "Grep":
      return input.pattern;
    case "WebSearch":
      return input.query;
    case "WebFetch":
      return input.url;
    case "TodoWrite":
      return `${input.todos?.length ?? 0} items`;
    default:
      return "";
  }
}

function ToolResult({ result }: { result?: Block }) {
  if (!result) return <p className="tool-pending">Waiting for the result…</p>;
  const parts = blocks(result.content);
  return (
    <div className="tool-result" data-state={result.is_error ? "failed" : "done"}>
      {parts.map((p, i) =>
        p.type === "image" && p.source?.type === "base64" ? (
          // PNGs here are the part renders, printed like the Preview tab; photos keep their colours.
          p.source.media_type === "image/png" ? (
            <span key={i} className="print tool-print">
              <img className="tool-image" src={`data:image/png;base64,${p.source.data}`} alt="Render Claude checked" />
            </span>
          ) : (
            <img key={i} className="tool-image" src={`data:${p.source.media_type};base64,${p.source.data}`} alt="Image Claude read" />
          )
        ) : p.type === "text" ? (
          <pre key={i}>{p.text}</pre>
        ) : null,
      )}
    </div>
  );
}

function ToolCard({ block, result, root }: { block: Block; result?: Block; root: string }) {
  const [open, setOpen] = useState(false);
  const input = block.input ?? {};
  const hasImage = blocks(result?.content).some((p) => p.type === "image");
  return (
    <div className="tool" data-state={!result ? "running" : result.is_error ? "failed" : "done"}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary">{toolSummary(block.name, input, root)}</span>
        <span className="tool-state">{!result ? "Running" : result.is_error ? "Failed" : ""}</span>
      </button>
      {(open || hasImage) && (
        <div className="tool-body">
          {open && block.name === "Bash" && <pre className="cmd">$ {input.command}</pre>}
          {open && block.name === "Edit" && (
            <pre className="diff">
              {String(input.old_string ?? "").split("\n").map((l) => `- ${l}\n`)}
              {String(input.new_string ?? "").split("\n").map((l) => `+ ${l}\n`)}
            </pre>
          )}
          {open && block.name === "Write" && <pre className="cmd">{String(input.content ?? "").slice(0, 4000)}</pre>}
          {(open || hasImage) && <ToolResult result={result} />}
        </div>
      )}
    </div>
  );
}

function Transcript({ items, root }: { items: ChatItem[]; root: string }) {
  const results = useMemo(() => {
    const map = new Map<string, Block>();
    for (const it of items)
      if (it.kind === "user") for (const b of blocks(it.content)) if (b.type === "tool_result") map.set(b.tool_use_id, b);
    return map;
  }, [items]);

  return (
    <>
      {items.map((it) => {
        switch (it.kind) {
          case "user": {
            const texts = blocks(it.content).filter(
              (b) => b.type === "text" && !/^\s*<[a-z-]+>/.test(b.text), // skip CLI-internal tags and the attachments note
            );
            const images = blocks(it.content).filter((b) => b.type === "image" && b.source?.type === "base64");
            if (!texts.length && !images.length) return null;
            return (
              <div key={it.id} className="turn-user">
                <p className="who">You</p>
                {images.length > 0 && (
                  <div className="user-images">
                    {images.map((b, i) => (
                      <img key={i} src={`data:${b.source.media_type};base64,${b.source.data}`} alt="Image you attached" />
                    ))}
                  </div>
                )}
                {texts.map((b, i) => (
                  <p key={i} className="user-text">
                    {b.text}
                  </p>
                ))}
              </div>
            );
          }
          case "assistant":
            return (
              <div key={it.id} className="turn-claude">
                {blocks(it.content).map((b, i) =>
                  b.type === "text" ? (
                    <Markdown key={i} text={b.text} />
                  ) : b.type === "tool_use" ? (
                    <ToolCard key={i} block={b} result={results.get(b.id)} root={root} />
                  ) : b.type === "thinking" && b.thinking ? (
                    <details key={i} className="thinking">
                      <summary>thinking</summary>
                      <Markdown text={b.thinking} />
                    </details>
                  ) : null,
                )}
              </div>
            );
          case "result":
            return (
              <p key={it.id} className="result" data-state={it.ok ? "done" : "failed"}>
                {it.ok ? "Done" : `Stopped (${it.text})`} in {(it.durationMs / 1000).toFixed(0)}&nbsp;s, {it.turns} turns, $
                {it.costUsd.toFixed(3)}
              </p>
            );
          case "info":
            return (
              <p key={it.id} className="info" data-level={it.level} role={it.level === "error" ? "alert" : undefined}>
                {it.text}
              </p>
            );
        }
      })}
    </>
  );
}

function QuestionForm({ req, answer }: { req: PermissionRequest; answer: (a: PermissionAnswer) => void }) {
  const questions = (req.input.questions as any[]) ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: any, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      return {
        ...p,
        [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label],
      };
    });
  const answers = Object.fromEntries(
    questions.map((q) => [q.question, other[q.question]?.trim() || (picked[q.question] ?? []).join(", ")]),
  );
  const complete = questions.every((q) => answers[q.question]);

  return (
    <div className="permission" role="group" aria-label="Claude has a question">
      {questions.map((q) => (
        <div key={q.question} className="q">
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {(q.options ?? []).map((o: any) => (
              <button
                type="button"
                key={o.label}
                className="q-option"
                aria-pressed={(picked[q.question] ?? []).includes(o.label)}
                onClick={() => toggle(q, o.label)}
              >
                <b>{o.label}</b>
                <span>{o.description}</span>
              </button>
            ))}
          </div>
          <input
            className="input"
            aria-label={`Another answer to: ${q.question}`}
            placeholder="Another answer"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
          />
        </div>
      ))}
      <div className="perm-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!complete}
          onClick={() => answer({ behavior: "allow", updatedInput: { ...req.input, answers } })}
        >
          Answer
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => answer({ behavior: "deny", message: "The user dismissed the question." })}>
          Skip
        </button>
      </div>
    </div>
  );
}

function PermissionCard({ req, root, answer }: { req: PermissionRequest; root: string; answer: (a: PermissionAnswer) => void }) {
  if (req.toolName === "AskUserQuestion") return <QuestionForm req={req} answer={answer} />;
  const input = req.input as Record<string, any>;
  return (
    <div className="permission" role="group" aria-label="Permission request">
      <div className="perm-title">{req.title ?? `Allow ${req.toolName}?`}</div>
      <pre className="cmd">
        {req.toolName === "Bash"
          ? `$ ${input.command}`
          : req.toolName === "Edit"
            ? `${toolSummary("Edit", input, root)}\n- ${input.old_string}\n+ ${input.new_string}`
            : req.toolName === "Write"
              ? `${toolSummary("Write", input, root)}\n\n${String(input.content ?? "").slice(0, 3000)}`
              : JSON.stringify(input, null, 2)}
      </pre>
      <div className="perm-actions">
        <button type="button" className="btn btn--primary" onClick={() => answer({ behavior: "allow" })}>
          Allow
        </button>
        {req.canAlwaysAllow && (
          <button type="button" className="btn btn--quiet" onClick={() => answer({ behavior: "allow", always: true })}>
            Allow for this chat
          </button>
        )}
        <button type="button" className="btn btn--quiet" onClick={() => answer({ behavior: "deny", message: "The user denied this action." })}>
          Deny
        </button>
      </div>
    </div>
  );
}

const EFFORTS: ChatSettings["effort"][] = ["low", "medium", "high", "xhigh", "max"];
const MODES: { value: ChatSettings["permissionMode"]; label: string }[] = [
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "plan", label: "Plan only" },
];

export interface ChatProps {
  project: string;
  root: string;
  items: ChatItem[];
  busy: boolean;
  permissions: PermissionRequest[];
  sessions: SavedSession[];
  sessionId?: string;
  models: ModelOption[];
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onInterrupt: () => void;
  onAnswer: (id: string, a: PermissionAnswer) => void;
  onOpenSession: (id: string | null) => void;
}

export function Chat(p: ChatProps) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output while the user is at the bottom
  const lastTop = useRef(0);

  // Scroll on any growth, not just new items: images get their height only once decoded.
  // Also follow when the transcript box itself shrinks (composer grows, window resizes).
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = () => {
      if (!stick.current) return;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };
    follow();
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Only an upward scroll unsticks. Content growing below never moves scrollTop up, so the
  // late scroll event from our own scroll-to-bottom can't be mistaken for the user leaving.
  const onScroll = (el: HTMLDivElement) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) stick.current = true;
    else if (el.scrollTop < lastTop.current - 1) stick.current = false;
    lastTop.current = el.scrollTop;
  };

  // Permission questions need an answer: always bring a new one into view.
  const permCount = p.permissions.length;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !permCount) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [permCount]);

  // Attachments belong to the project they were added in.
  useEffect(() => {
    setImages([]);
    setAttachError("");
  }, [p.project]);

  const attach = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setAttachError("");
    const results = await Promise.allSettled(list.map(toAttachment));
    setImages((cur) => [...cur, ...results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) setAttachError(`Couldn't read ${failed.length} image${failed.length > 1 ? "s" : ""}: ${failed[0].reason?.message ?? failed[0].reason}`);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && !images.length) return;
    stick.current = true; // sending jumps back to the bottom
    p.onSend(text, images);
    setDraft("");
    setImages([]);
    setAttachError("");
  };

  return (
    <section
      className="chat"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      <header className="chat-head">
        <select
          className="input"
          aria-label="Chats in this project"
          value={p.sessionId ?? ""}
          onChange={(e) => p.onOpenSession(e.target.value || null)}
          disabled={p.busy}
        >
          <option value="">New chat</option>
          {p.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} ({new Date(s.updated).toLocaleDateString()})
            </option>
          ))}
        </select>
        <button type="button" className="btn btn--quiet" onClick={() => p.onOpenSession(null)} disabled={p.busy}>
          New chat
        </button>
      </header>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => onScroll(e.currentTarget)}
      >
        <div className="transcript-inner" ref={content}>
          {!p.items.length && (
            <div className="chat-empty">
              <h2>Describe a part</h2>
              <p>
                Describe a part for <strong>{p.project}</strong>, or ask for a change to one of its scripts. Name what it holds or
                fits, its sizes and the screws it takes. Claude writes the build123d script, runs it, checks the preview and slices it
                for the A1.
              </p>
              <p className="example">A wall hook for a 30&nbsp;mm broom handle, two M4 screws, 5&nbsp;kg load.</p>
              <p>
                Or start from a picture: paste or drop a logo, a silhouette, a sketch with dimensions or a photo of a part, and say
                how big it should be. It's saved in the project's <code>ref/</code> folder.
              </p>
              <p className="example">Make this logo into a 60&nbsp;mm keychain, 3&nbsp;mm thick.</p>
            </div>
          )}
          <Transcript items={p.items} root={p.root} />
          {p.permissions.map((r) => (
            <PermissionCard key={r.id} req={r} root={p.root} answer={(a) => p.onAnswer(r.id, a)} />
          ))}
          {p.busy && !p.permissions.length && (
            <p className="working" role="status">
              Claude is working…
            </p>
          )}
        </div>
      </div>

      <footer className="composer">
        {images.length > 0 && (
          <ul className="attachments" aria-label="Attached images">
            {images.map((img, i) => (
              <li key={i}>
                <img src={`data:${img.previewType};base64,${img.preview}`} alt={img.name} title={img.name} />
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${img.name}`}
                  onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachError && (
          <p className="info" data-level="error" role="alert">
            {attachError}
          </p>
        )}
        <textarea
          className="input"
          aria-label="Message to Claude"
          value={draft}
          placeholder={
            p.busy
              ? "Send a follow-up (queued until Claude finishes)…"
              : images.length
                ? "What should it become? Size, thickness, use…"
                : "Describe a part or a change, or paste an image…"
          }
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            attach(files);
          }}
          onKeyDown={(e) => {
            // Enter while an input method is composing confirms the composition, not the message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
        <div className="composer-bar">
          <select className="input" aria-label="Model" value={p.settings.model} onChange={(e) => p.onSettings({ ...p.settings, model: e.target.value })}>
            {p.models.map((m) => (
              <option key={m.value} value={m.value} title={m.description}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Effort, applied from the next message"
            value={p.settings.effort}
            onChange={(e) => p.onSettings({ ...p.settings, effort: e.target.value as ChatSettings["effort"] })}
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                Effort {e}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Permissions"
            value={p.settings.permissionMode}
            onChange={(e) => p.onSettings({ ...p.settings, permissionMode: e.target.value as ChatSettings["permissionMode"] })}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) attach(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn--quiet" onClick={() => picker.current?.click()} title="Attach images (or paste / drop them)">
            Image…
          </button>
          <span className="spacer" />
          {p.busy && (
            <button type="button" className="btn btn--quiet" onClick={p.onInterrupt}>
              Stop
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!draft.trim() && !images.length}>
            Send
          </button>
        </div>
      </footer>
    </section>
  );
}
