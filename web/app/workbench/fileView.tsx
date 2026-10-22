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
import { useCallback, useEffect, useState } from 'react';
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

export function FileView({ path, onDirty, goTo, onOpenFile }: { path: string; onDirty?: (path: string, dirty: boolean) => void; goTo?: GoTo; onOpenFile?: (path: string) => void }) {
  const { t } = useT();
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  /** The file changed on disk under an edit: the operator chooses to read it again or to save over it. */
  const [conflict, setConflict] = useState(false);
  const [choice, setChoice] = useState<'auto' | LangId>('auto');
  /** Goes up when the text is set from outside the editor — read from disk, put back — so the editor takes it. */
  const [reset, setReset] = useState(0);

  const dirty = !!file && file.text !== null && text !== file.text;
  useEffect(() => onDirty?.(path, dirty), [path, dirty, onDirty]);

  /** The file as it is on disk now, over whatever the editor holds. */
  const read = useCallback(async () => {
    try {
      const f = await api.workspaceFile(path);
      setFile(f);
      setText(f.text ?? '');
      setReset((n) => n + 1);
      setConflict(false);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setFile(null);
    setSaid('');
    setConflict(false);
    void read();
  }, [read]);
  // A change on disk — the chat's, another program's: with no edit the editor follows it, under one it says so.
  usePoll(
    async () => {
      if (!file?.version || busy) return;
      const f = await api.workspaceFile(path).catch(() => null);
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
  const save = async (over = false): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    setSaid('');
    try {
      const r = await api.saveWorkspaceFile(path, text, over ? undefined : file.version);
      setFile({ ...file, text, version: r.version, size: r.size });
      setConflict(false);
      setSaid(t('ed.saved'));
    } catch (e) {
      if ((e as { status?: number }).status === 409) setConflict(true);
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
    <div className="ed">
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
      {conflict && (
        <div className="notice caution small ed-conflict" role="alert">
          <span>{t('ed.changedOnDisk')}</span>
          <button type="button" className="small" onClick={() => void read()}>{t('ed.reload')}</button>
          <button type="button" className="small danger" onClick={() => void save(true)}>{t('ed.saveOver')}</button>
        </div>
      )}
      <div className={`ed-body ed-show-${view}`}>
        {view !== 'code' && (
          <div className="ed-preview">
            <MarkdownView text={text} path={path} onOpenFile={(p) => onOpenFile?.(p)} />
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
