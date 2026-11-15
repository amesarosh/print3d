// The preload bridge, and helpers for calling it.
import type { StudioApi } from "../shared/api";

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export const api = window.studio;

/** An error's message without the wrapper Electron puts around errors thrown in the main process. */
export const errorText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
