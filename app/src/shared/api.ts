// Types shared by the main process, the preload bridge and the renderer.

/** One export() call's files in a project's out/ folder, grouped by base name. */
export interface OutputGroup {
  name: string;
  png?: string; // paths relative to the project folder, e.g. "out/bracket.png"
  stls: string[];
  tmf?: string;
  step?: string;
  /** A multicolour print: one STL per colour, already in place (from out/<name>_colors/colors.json). */
  colors?: ColorPiece[];
  mtime: number; // newest file in the group, ms
  /** When the PNG was written, ms. export() writes it after the STLs, so it marks a finished export. */
  pngMtime?: number;
}

export interface ColorPiece {
  label: string; // e.g. "black"
  stl: string; // path relative to the project folder
  color: string; // "#rrggbb"
}

/** One export() name's files, as a numbered version of a part. */
export interface PartVersion extends OutputGroup {
  version: number; // "bracket" is 1, "bracket_v2" is 2, …
}

/** A part and its versions: export names "<part>", "<part>_v2", "<part>_v3"… */
export interface Part {
  name: string;
  versions: PartVersion[]; // oldest first; the last is the latest
  mtime: number; // newest version's
}

export interface ProjectInfo {
  name: string;
  scripts: string[]; // .py files in the project folder
  outputs: OutputGroup[]; // newest first
  parts: Part[]; // outputs grouped into parts with versions, newest first
  mtime: number;
}

/** Nozzles the A1 takes, mm. The fitted one is kept in printer.json at the repo root (see print3d/slicer.py). */
export const NOZZLES = ["0.2", "0.4", "0.6", "0.8"] as const;
export type Nozzle = (typeof NOZZLES)[number];

export type PermissionMode = "default" | "acceptEdits" | "auto" | "plan";

export interface ChatSettings {
  model: string; // SDK model value, e.g. "opus" or "claude-opus-5-5"
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode: PermissionMode;
}

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

/** An image attached to a chat message. */
export interface ImageAttachment {
  name: string; // file name to save under the project's ref/ folder
  file: string; // base64 of the image as saved (the original, or a PNG for SVGs)
  /** base64 of the copy Claude sees, scaled to at most 1568 px */
  preview: string;
  previewType: "image/png" | "image/jpeg";
}

export interface SavedSession {
  id: string;
  title: string;
  updated: number;
}

/**
 * A transcript entry the renderer draws. Content blocks follow the
 * Anthropic Messages API shape (text, thinking, tool_use, tool_result, image).
 */
export type ChatItem =
  | { kind: "user"; id: string; content: unknown }
  | { kind: "assistant"; id: string; content: unknown; parentToolUseId: string | null }
  | { kind: "result"; id: string; ok: boolean; text: string; costUsd: number; durationMs: number; turns: number }
  | { kind: "info"; id: string; text: string; level: "info" | "error" };

/** Events the main process pushes for a project's chat. */
export type AgentEvent =
  | { type: "items"; project: string; items: ChatItem[] }
  | { type: "status"; project: string; busy: boolean; sessionId?: string; model?: string }
  | { type: "permission"; project: string; request: PermissionRequest }
  | { type: "permission-done"; project: string; id: string };

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string; // the SDK's prompt sentence, when it gives one
  canAlwaysAllow: boolean;
}

export type PermissionAnswer =
  | { behavior: "allow"; always?: boolean; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface RunOutput {
  runId: string;
  project: string;
  script: string;
  chunk?: string;
  exitCode?: number | null;
}

/** The API the preload script exposes on window.studio. */
export interface StudioApi {
  root: () => Promise<string>;
  changeRoot: () => Promise<void>;
  /** The nozzle fitted to the printer. */
  getNozzle: () => Promise<Nozzle>;
  /** Exports made from now on are sliced for this nozzle. */
  setNozzle: (nozzle: Nozzle) => Promise<void>;
  listProjects: () => Promise<ProjectInfo[]>;
  createProject: (name: string) => Promise<void>;
  readText: (project: string, file: string) => Promise<string>;
  /** Save a project's .py script. */
  writeScript: (project: string, file: string, text: string) => Promise<void>;
  runScript: (project: string, script: string) => Promise<string>; // returns runId
  openInBambu: (project: string, file: string) => Promise<void>;
  openFolder: (project: string) => Promise<void>;
  /** Asks for confirmation, then moves the part's files (and optionally its script) to the Trash. */
  deletePart: (project: string, part: string) => Promise<boolean>;
  onProjectsChanged: (cb: () => void) => () => void;
  onRunOutput: (cb: (o: RunOutput) => void) => () => void;

  listModels: () => Promise<ModelOption[]>;
  listSessions: (project: string) => Promise<SavedSession[]>;
  openSession: (project: string, sessionId: string | null) => Promise<ChatItem[]>;
  send: (project: string, text: string, settings: ChatSettings, images?: ImageAttachment[]) => Promise<void>;
  interrupt: (project: string) => Promise<void>;
  updateSettings: (project: string, settings: ChatSettings) => Promise<void>;
  answerPermission: (project: string, id: string, answer: PermissionAnswer) => Promise<void>;
  onAgentEvent: (cb: (e: AgentEvent) => void) => () => void;
}
