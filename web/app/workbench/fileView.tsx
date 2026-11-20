'use client';

/**
 * A file of the open project folder, in an editor as an IDE has it (2026-10-20: "clicking a file, it can be edited; a
 * colorizer for the different languages, with automatic recognition at least by the extension"): since 2026-10-22 the
 * editor of VS Code itself (Monaco, see codeEditor.tsx), its language found by itself or chosen; saved with "Save"
 * or Ctrl+S.
 *
 * Saved over the version it was opened at: a file the chat changed meanwhile is not overwritten without asking, and
 * one with no edit of the operator's follows the disk as it changes. A binary or very large file is said to be one and
 * not opened.
 */
import { MarkdownView } from './markdownView';
import { ErrorBoundary } from '../errorBoundary';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dropDraft, dropOwnDraft, keepDraft, readDraft } from '../../lib/drafts';
import { api, type WorkspaceFile } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { LANGUAGES, detectLanguage, languageName, type LangId } from '../../lib/highlight';
import { FileIcon } from './fileIcon';
import { CodeEditor } from './codeEditor';

/** Where to put the cursor when the file is opened from a search or "Go to File": a line, and the match on it. */
export type GoTo = { line: number; from?: number; to?: number; n: number };
/** How a Markdown file is shown (2026-10-21): its text, as it reads, or the two side by side. */
type MdView = 'code' | 'split' | 'preview';
const MD_VIEW_KEY = 'cop.md.view';

/** `dir`: the folder the file was opened in — its edit is kept in this browser for it, and saved only there. */
export function FileView({ dir, path, onDirty, goTo, onOpenFile }: { dir: string; path: string; onDirty?: (path: string, dirty: boolean) => void; goTo?: GoTo; onOpenFile?: (path: string) => void }) {
  const { t } = useT();
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  /** The file changed on disk under an edit: the operator chooses to read it again or to save over it. */
  const [conflict, setConflict] = useState(false);
  /**
   * The file is not on disk any more — deleted or renamed under the editor (second bug hunt, 2026-11-19): said, the text
   * kept, and saved there again at a press. The tab kept the old text with nothing said, and a save then failed.
   */
  const [gone, setGone] = useState(false);
  const [choice, setChoice] = useState<'auto' | LangId>('auto');
  /** Goes up when the text is set from outside the editor — read from disk, put back — so the editor takes it. */
  const [reset, setReset] = useState(0);

  const dirty = !!file && file.text !== null && text !== file.text;
  useEffect(() => onDirty?.(path, dirty), [path, dirty, onDirty]);

  /**
   * The file as it is on disk now. Opened, an edit kept in this browser for it comes back over it, on the version it
   * was made on (2026-11-19), so a file changed on disk since is said, as under any edit; read again, the edit goes.
   */
  const load = useCallback(
    async (withDraft: boolean) => {
      try {
        const f = await api.workspaceFile(path, dir).catch((e: unknown) => {
          /*
           * Gone from disk, with an edit kept for it (third hunt, 2026-11-20): the edit comes back, said to be of a file no
           * longer there, with "Save it here again". Only the server's "no such file" was shown, the edit out of reach.
           */
          const kept = withDraft && (e as { status?: number }).status === 404 ? readDraft(dir, path) : null;
          if (!kept) throw e;
          setGone(true);
          return { path, text: '', binary: false, tooLarge: false, size: 0, ...(kept.version ? { version: kept.version } : {}) } as WorkspaceFile;
        });
        const draft = withDraft ? readDraft(dir, path) : null;
        if (!withDraft) dropDraft(dir, path);
        if (draft && f.text !== null && draft.text !== f.text) {
          setFile({ ...f, version: draft.version ?? f.version });
          setText(draft.text);
        } else {
          if (draft) dropDraft(dir, path);
          setFile(f);
          setText(f.text ?? '');
        }
        setReset((n) => n + 1);
        setConflict(false);
        setErr('');
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [path, dir],
  );
  const read = useCallback(() => load(false), [load]);
  useEffect(() => {
    setFile(null);
    setSaid('');
    setConflict(false);
    void load(true);
  }, [load]);
  /*
   * The edit kept as it is typed, a moment after the last key, and at once when the editor goes — its tab closed, the
   * page left — so nothing typed is lost (2026-11-19).
   */
  const pending = useRef<{ text: string; version?: string } | null>(null);
  /** The text this editor last kept: only that is dropped when it is clean again, never another browser tab's edit. */
  const kept = useRef<string | null>(null);
  const flush = useCallback(() => {
    if (!pending.current) return;
    keepDraft(dir, path, pending.current.text, pending.current.version);
    kept.current = pending.current.text;
    pending.current = null;
  }, [dir, path]);
  useEffect(() => {
    if (!file || file.text === null) return;
    if (!dirty) {
      pending.current = null;
      dropOwnDraft(dir, path, kept.current);
      kept.current = null;
      return;
    }
    pending.current = { text, ...(file.version ? { version: file.version } : {}) };
    const later = setTimeout(flush, 300);
    return () => clearTimeout(later);
  }, [dirty, text, file, dir, path, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);
  // A change on disk — the chat's, another program's: with no edit the editor follows it, under one it says so.
  usePoll(
    async () => {
      if (!file?.version || busy) return;
      const f = await api.workspaceFile(path, dir).catch((e: unknown) => {
        if ((e as { status?: number }).status === 404) setGone(true);
        return null;
      });
      if (f) setGone(false);
      if (!f?.version || f.version === file.version) return;
      if (dirty) setConflict(true);
      else {
        setFile(f);
        setText(f.text ?? '');
        setReset((n) => n + 1);
      }
    },
    4_000,
    !!file,
  );

  const lang: LangId = choice === 'auto' ? detectLanguage(path, file?.text ?? '') : choice;
  /*
   * A Markdown file opens as it reads (operator, 2026-10-21: "let .md files be seen formatted, not as text"), as the
   * choice was left in this browser; its text to edit, or both side by side, a press away (Ctrl+Shift+V).
   */
  const isMarkdown = detectLanguage(path, '') === 'markdown';
  const [mdView, setMdViewState] = useState<MdView>('preview');
  useEffect(() => {
    try {
      const kept = window.localStorage.getItem(MD_VIEW_KEY);
      if (kept === 'code' || kept === 'split' || kept === 'preview') setMdViewState(kept);
    } catch {
      /* no storage: as it reads */
    }
  }, []);
  const setMdView = (v: MdView): void => {
    setMdViewState(v);
    try {
      window.localStorage.setItem(MD_VIEW_KEY, v);
    } catch {
      /* kept for this tab only */
    }
  };
  const view: MdView = isMarkdown ? mdView : 'code';
  /*
   * Ctrl+Shift+V from the file as it reads (second bug hunt, 2026-11-19): only the editor had the key, and with no editor
   * shown it did nothing. Not in a box being written in, where it pastes without formatting, nor in the editor of a
   * side-by-side view, which has the key itself.
   */
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isMarkdown || view === 'code') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'v') return;
      // The tab in front only: the others are kept, hidden, each with its own view.
      if (!root.current || root.current.closest('[hidden]')) return;
      const at = e.target as HTMLElement | null;
      if (at?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor')) return;
      e.preventDefault();
      setMdView('code');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const save = async (over = false, again = false): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    setSaid('');
    try {
      const r = await api.saveWorkspaceFile(path, text, over || again ? undefined : file.version, dir, again);
      setFile({ ...file, text, version: r.version, size: r.size });
      setConflict(false);
      setGone(false);
      setSaid(t('ed.saved'));
    } catch (e) {
      if ((e as { status?: number }).status === 409) setConflict(true);
      else if ((e as { status?: number }).status === 404) setGone(true);
      else setSaid((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Opened at a line (from the search, or Go to File with :42): a Markdown file shown as it reads shows its text beside it.
  useEffect(() => {
    if (goTo && isMarkdown && mdView === 'preview') setMdViewState('split');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.n]);

  if (err && !file) return <p className="err small">{err}</p>;
  if (!file) return <p className="muted small">{t('wb.loading')}</p>;
  if (file.binary || file.tooLarge) {
    return (
      <div className="wb-file">
        <p className="muted small">{t('wb.fileOnDisk', { path: file.path })}</p>
        <p className="muted">{file.binary ? t('wb.binary') : t('wb.tooLarge')}</p>
      </div>
    );
  }
  return (
    <div className="ed" ref={root}>
      <div className="ed-bar">
        <FileIcon path={path} />
        <span className="ed-path" title={file.path}>{file.path}</span>
        <span className={`small ${dirty ? 'ed-dirty' : 'muted'}`} role="status">
          {dirty ? t('ed.unsaved') : said || t('ed.clean')}
        </span>
        <span className="grow" />
        {isMarkdown && (
          <span className="segmented ed-md-view" role="group" aria-label={t('ed.view')} title={t('ed.viewWhy')}>
            {(['code', 'split', 'preview'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={mdView === v} onClick={() => setMdView(v)}>
                {t(v === 'code' ? 'ed.viewCode' : v === 'split' ? 'ed.viewSplit' : 'ed.viewPreview')}
              </button>
            ))}
          </span>
        )}
        <label htmlFor={`ed-lang-${path}`} className="sr-only">{t('ed.language')}</label>
        <select id={`ed-lang-${path}`} className="ed-lang" value={choice} onChange={(e) => setChoice(e.target.value as 'auto' | LangId)} title={t('ed.language')}>
          <option value="auto">{t('ed.langAuto', { name: languageName(detectLanguage(path, file.text ?? '')) })}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button type="button" className="quiet small" disabled={!dirty || busy} onClick={() => { setText(file.text ?? ''); setReset((n) => n + 1); setSaid(''); }}>
          {t('ed.revert')}
        </button>
        <button type="button" className="primary small" disabled={!dirty || busy} onClick={() => void save()} title="Ctrl+S">
          {t('ed.save')}
        </button>
      </div>
      {gone && (
        <div className="notice caution small ed-gone" role="alert">
          <span>{t('ed.goneFromDisk')}</span>
          <button type="button" className="small" disabled={busy} onClick={() => void save(false, true)}>{t('ed.saveAgain')}</button>
        </div>
      )}
      {conflict && !gone && (
        <div className="notice caution small ed-conflict" role="alert">
          <span>{t('ed.changedOnDisk')}</span>
          <button type="button" className="small" onClick={() => void read()}>{t('ed.reload')}</button>
          <button type="button" className="small danger" onClick={() => void save(true)}>{t('ed.saveOver')}</button>
        </div>
      )}
      <div className={`ed-body ed-show-${view}`}>
        {view !== 'code' && (
          <div className="ed-preview">
            <ErrorBoundary resetKey={text}>
              <MarkdownView text={text} path={path} onOpenFile={(p) => onOpenFile?.(p)} />
            </ErrorBoundary>
          </div>
        )}
        {view !== 'preview' && (
          <CodeEditor
            path={path}
            value={text}
            language={lang}
            onChange={setText}
            onSave={() => void save()}
            onToggleMarkdown={isMarkdown ? () => setMdView(mdView === 'code' ? 'preview' : 'code') : undefined}
            goTo={goTo}
            label={t('ed.label', { path: file.path })}
            reset={reset}
          />
        )}
      </div>
    </div>
  );
}
