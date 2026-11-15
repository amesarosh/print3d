// The Script view: a CodeMirror editor for a project's .py file, with save, revert and on-disk change detection.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { api, errorText } from "./studio";

/** Muted hues on the night sheet: enough to tell code apart, still reading as one drawing. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "oklch(78% 0.09 300)" },
  { tag: [t.string, t.docString], color: "oklch(80% 0.09 145)" },
  { tag: [t.number, t.bool, t.null], color: "oklch(82% 0.1 65)" },
  { tag: t.comment, color: "oklch(62% 0.02 248)", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "oklch(82% 0.09 230)" },
  { tag: t.function(t.variableName), color: "oklch(86% 0.05 230)" },
  { tag: t.className, color: "oklch(84% 0.08 190)" },
  { tag: t.self, color: "oklch(78% 0.09 300)", fontStyle: "italic" },
  { tag: t.propertyName, color: "oklch(88% 0.02 245)" },
  { tag: t.constant(t.variableName), color: "oklch(84% 0.08 65)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--color-paper-3)", color: "var(--color-ink)", fontSize: "var(--text-sm)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-outlier)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--color-ink)", padding: "var(--space-sm) 0" },
    ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
    ".cm-gutters": { backgroundColor: "var(--color-paper-3)", color: "var(--color-muted)", border: "none", borderRight: "1px solid var(--color-rule-2)" },
    ".cm-activeLine": { backgroundColor: "oklch(88% 0.01 245 / 0.04)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-ink)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "oklch(70% 0.06 245 / 0.3)",
    },
    ".cm-matchingBracket": { backgroundColor: "oklch(70% 0.06 245 / 0.25)", outline: "none" },
  },
  { dark: true },
);

export interface ScriptEditorHandle {
  dirty: () => boolean;
  save: () => Promise<void>;
}

export function ScriptEditor(props: { project: string; file: string; mtime: number; ref?: Ref<ScriptEditorHandle> }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const saved = useRef(""); // the text on disk as of the last load or save
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    const v = view.current;
    if (!v) return;
    const text = v.state.doc.toString();
    setSaving(true);
    try {
      await api.writeScript(props.project, props.file, text);
      saved.current = text;
      setDirty(false);
      setDiskChanged(false);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const setDoc = (text: string) => {
    saved.current = text;
    view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: text } });
    setDirty(false);
    setDiskChanged(false);
  };

  useImperativeHandle(props.ref, () => ({ dirty: () => dirty, save }), [dirty, props.project, props.file]);

  // One editor per file: create it, load the text.
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          python(),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (saveRef.current().catch(() => {}), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== saved.current);
          }),
        ],
      }),
    });
    view.current = v;
    saved.current = ""; // nothing loaded yet; the previous file's text must not count as this one's
    let live = true;
    api.readText(props.project, props.file).then(
      (text) => live && setDoc(text),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
      v.destroy();
      view.current = null;
      setDirty(false);
      setDiskChanged(false);
      setError(undefined);
    };
  }, [props.project, props.file]);

  // Something under the project changed (often Claude editing): pick up the file if it differs.
  useEffect(() => {
    let live = true;
    api.readText(props.project, props.file).then((text) => {
      if (!live || text === saved.current) return;
      if (view.current && view.current.state.doc.toString() === saved.current) setDoc(text);
      else setDiskChanged(true);
    }, () => {});
    return () => {
      live = false;
    };
  }, [props.mtime]);

  const revert = () => api.readText(props.project, props.file).then(setDoc, (e) => setError(errorText(e)));

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="num">{props.file}</span>
        <span className="editor-state" data-state={dirty ? "dirty" : "saved"}>
          {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn--quiet btn--s" onClick={revert} disabled={!dirty || saving}>
          Revert
        </button>
        <button
          type="button"
          className="btn btn--primary btn--s"
          onClick={() => save().catch(() => {})}
          disabled={!dirty || saving}
          title="Save (Ctrl+S)"
        >
          Save
        </button>
      </div>
      {diskChanged && (
        <div className="banner" role="alert">
          <p>{props.file} changed on disk while you were editing.</p>
          <button type="button" className="btn btn--quiet btn--s" onClick={revert}>
            Load the disk version
          </button>
          <button type="button" className="btn btn--quiet btn--s" onClick={() => setDiskChanged(false)}>
            Keep mine
          </button>
        </div>
      )}
      {error && (
        <div className="banner" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="editor-host" ref={host} />
    </div>
  );
}
