// Exposes a narrow, typed API to the renderer as window.studio.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { StudioApi } from "./shared/api";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: StudioApi = {
  root: () => ipcRenderer.invoke("root"),
  changeRoot: () => ipcRenderer.invoke("root:change"),
  getNozzle: () => ipcRenderer.invoke("printer:nozzle"),
  setNozzle: (nozzle) => ipcRenderer.invoke("printer:setNozzle", nozzle),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  createProject: (name) => ipcRenderer.invoke("projects:create", name),
  readText: (project, file) => ipcRenderer.invoke("projects:readText", project, file),
  writeScript: (project, file, text) => ipcRenderer.invoke("projects:writeScript", project, file, text),
  runScript: (project, script) => ipcRenderer.invoke("projects:run", project, script),
  openInBambu: (project, file) => ipcRenderer.invoke("projects:openInBambu", project, file),
  deletePart: (project, part) => ipcRenderer.invoke("projects:deletePart", project, part),
  openFolder: (project) => ipcRenderer.invoke("projects:openFolder", project),
  onProjectsChanged: (cb) => subscribe("projects:changed", cb),
  onRunOutput: (cb) => subscribe("run:output", cb),

  listModels: () => ipcRenderer.invoke("agent:models"),
  listSessions: (project) => ipcRenderer.invoke("agent:sessions", project),
  openSession: (project, id) => ipcRenderer.invoke("agent:open", project, id),
  send: (project, text, settings, images) => ipcRenderer.invoke("agent:send", project, text, settings, images),
  interrupt: (project) => ipcRenderer.invoke("agent:interrupt", project),
  updateSettings: (project, settings) => ipcRenderer.invoke("agent:settings", project, settings),
  answerPermission: (project, id, answer) => ipcRenderer.invoke("agent:permission", project, id, answer),
  onAgentEvent: (cb) => subscribe("agent:event", cb),
};

contextBridge.exposeInMainWorld("studio", api);
