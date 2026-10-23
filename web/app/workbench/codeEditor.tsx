'use client';

/**
 * The editor of VS Code in the workbench (operator, 2026-10-22: "an IDE in the browser that looks like VS Code, at
 * least its main features for working on a project" — Monaco Editor, MIT): colours, line numbers, find and replace,
 * several cursors, folding, the minimap, IntelliSense for TypeScript, JavaScript, JSON, CSS and HTML, VS Code's keys.
 *
 * Bundled with the page and loaded only when a file is opened, as mermaid is; nothing is fetched from the internet,
 * and its workers are modules of the page's own (./monaco/*.worker.ts). Its theme follows the page's, light or dark,
 * and its size the page's text size. The file's text stays the file view's: what is typed is handed up, and a text
 * set from outside — read again from disk, put back — replaces the editor's when it differs.
 *
 * For checks and for the page itself, the editor is on its element as `copEditor`.
 */
import { useEffect, useRef, useState } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { LangId } from '../../lib/highlight';
import { useT } from '../../lib/i18n';
import type { GoTo } from './fileView';

type Monaco = typeof MonacoNs;
let loading: Promise<Monaco> | null = null;

/** Monaco, once for the page, with its workers set up and the page's two themes defined. */
function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_id: string, label: string): Worker {
        if (label === 'json') return new Worker(new URL('./monaco/json.worker.ts', import.meta.url), { type: 'module' });
        if (label === 'css' || label === 'scss' || label === 'less') return new Worker(new URL('./monaco/css.worker.ts', import.meta.url), { type: 'module' });
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new Worker(new URL('./monaco/html.worker.ts', import.meta.url), { type: 'module' });
        if (label === 'typescript' || label === 'javascript') return new Worker(new URL('./monaco/ts.worker.ts', import.meta.url), { type: 'module' });
        return new Worker(new URL('./monaco/editor.worker.ts', import.meta.url), { type: 'module' });
      },
    };
    const monaco = await import('monaco-editor');
    /*
     * No problems marked (operator, 2026-10-23: "red underlines where it finds a problem — it does not see node_modules,
     * it is not an IDE; hide the underlining altogether"): the language services check a file alone, without the
     * project's packages or settings, so what they found was mostly not so. Their colours, completion and hover stay.
     */
    const quiet = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true };
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions(quiet);
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions(quiet);
    monaco.json.jsonDefaults.setDiagnosticsOptions({ ...monaco.json.jsonDefaults.diagnosticsOptions, validate: false });
    for (const css of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) css.setOptions({ ...css.options, validate: false });
    return monaco;
  })();
  return loading;
}

/** Our names of languages (lib/highlight.ts) as Monaco knows them; the ones it has not, as text or the nearest. */
const MONACO_LANG: Partial<Record<LangId, string>> = { plain: 'plaintext', batch: 'bat', vue: 'html', toml: 'ini', makefile: 'plaintext' };
export const monacoLanguage = (id: LangId): string => MONACO_LANG[id] ?? id;

/** The page's theme and text size, as Monaco is to show them. */
function pageLook(): { dark: boolean; size: number; background: string; ink: string } {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const scale = parseFloat(css.getPropertyValue('--scale')) || 1;
  return { dark: root.dataset.theme === 'dark', size: Math.round(13 * scale * 10) / 10, background: css.getPropertyValue('--bg').trim() || '#ffffff', ink: css.getPropertyValue('--ink').trim() || '#000000' };
}

function applyLook(monaco: Monaco, editor: MonacoNs.editor.IStandaloneCodeEditor | null): void {
  const look = pageLook();
  // VS Code's own light and dark themes, on the page's background.
  monaco.editor.defineTheme('cop-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': look.dark ? '#ffffff' : look.background } });
  monaco.editor.defineTheme('cop-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': look.dark ? look.background : '#1e1e1e' } });
  monaco.editor.setTheme(look.dark ? 'cop-dark' : 'cop-light');
  editor?.updateOptions({ fontSize: look.size });
}

export function CodeEditor({
  path,
  value,
  language,
  onChange,
  onSave,
  onToggleMarkdown,
  goTo,
  label,
  reset,
}: {
  path: string;
  value: string;
  language: LangId;
  onChange: (text: string) => void;
  onSave: () => void;
  /** Ctrl+Shift+V, for a Markdown file: its text or as it reads. */
  onToggleMarkdown?: () => void;
  goTo?: GoTo;
  label: string;
  /** Changed whenever `value` was set from outside rather than typed here: then the editor takes it. */
  reset: number;
}) {
  const { t } = useT();
  const host = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState('');
  // The latest of the callbacks, for the commands the editor keeps from when it was made.
  const latest = useRef({ onChange, onSave, onToggleMarkdown });
  latest.current = { onChange, onSave, onToggleMarkdown };

  useEffect(() => {
    let gone = false;
    let observer: MutationObserver | null = null;
    void loadMonaco()
      .then((monaco) => {
        if (gone || !host.current) return;
        monacoRef.current = monaco;
        const model = monaco.editor.createModel(value, monacoLanguage(language), monaco.Uri.file(`/workspace/${path}`));
        const editor = monaco.editor.create(host.current, {
          model,
          automaticLayout: true,
          ariaLabel: label,
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          detectIndentation: true,
          fixedOverflowWidgets: true,
          // And whatever marks a problem all the same — any language's, any service's — is not drawn (2026-10-23).
          renderValidationDecorations: 'off',
        });
        editorRef.current = editor;
        applyLook(monaco, editor);
        (host.current as HTMLDivElement & { copEditor?: unknown }).copEditor = editor;
        model.onDidChangeContent(() => latest.current.onChange(model.getValue()));
        /*
         * Actions, not commands: a command added to one editor is the last one's when several are open (Monaco keeps
         * it for the page), and Ctrl+S in a file saved the one opened after it (found 2026-10-22).
         */
        editor.addAction({ id: 'cop.save', label: t('ed.save'), keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => latest.current.onSave() });
        editor.addAction({
          id: 'cop.markdownView',
          label: t('ed.viewPreview'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV],
          precondition: undefined,
          run: () => latest.current.onToggleMarkdown?.(),
        });
        // The page's theme and text size, followed as they change.
        observer = new MutationObserver(() => applyLook(monaco, editor));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-textsize'] });
        setReady(true);
      })
      .catch((e: unknown) => setFailed((e as Error).message));
    return () => {
      gone = true;
      observer?.disconnect();
      const editor = editorRef.current;
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
    // Made once for the file; its text and language follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /*
   * A text set from outside — read again from disk, put back — comes with a new `reset`, and replaces the editor's, as
   * an edit Ctrl+Z undoes. What is typed is handed up and comes back as `value` a render later, never applied: put
   * back, a render that came behind a burst of keys undid what was typed since and moved the cursor (found
   * 2026-10-22, before it was so: fast typing came out scrambled).
   */
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset, ready]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && monacoRef.current) monacoRef.current.editor.setModelLanguage(model, monacoLanguage(language));
  }, [language, ready]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel: label });
  }, [label]);

  /*
   * Opened at a line — from the search, or "Go to File" with :42: the cursor there, the match chosen, the line a third
   * of the way down, as VS Code puts it.
   */
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!goTo || !editor || !monaco || !model) return;
    const line = Math.max(1, Math.min(goTo.line, model.getLineCount()));
    const len = model.getLineLength(line);
    const from = Math.min(goTo.from ?? 0, len) + 1;
    const to = Math.min(goTo.to ?? goTo.from ?? 0, len) + 1;
    const range = new monaco.Range(line, from, line, to);
    editor.setSelection(range);
    editor.revealRangeNearTopIfOutsideViewport(range);
    editor.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.n, ready]);

  return (
    <div className="ed-code">
      {!ready && !failed && <p className="muted small ed-code-loading">{t('ed.loading')}</p>}
      {failed && <p className="err small">{t('ed.failed', { reason: failed })}</p>}
      <div ref={host} className="ed-monaco" data-ready={ready ? 'yes' : undefined} />
    </div>
  );
}
