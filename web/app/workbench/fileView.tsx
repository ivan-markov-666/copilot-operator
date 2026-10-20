'use client';

/**
 * A file of the open project folder, in an editor as an IDE has it (2026-10-20: "clicking a file, it can be edited; a
 * colorizer for the different languages, with automatic recognition at least by the extension"). The text in colour
 * by its language — found by itself, or chosen — with line numbers; edited in place, saved with "Save" or Ctrl+S.
 *
 * Saved over the version it was opened at: a file the chat changed meanwhile is not overwritten without asking, and
 * one with no edit of the operator's follows the disk as it changes. Tab indents (Shift+Tab takes it back), Escape
 * gives the keyboard back to the page. A binary or very large file is said to be one and not opened.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type WorkspaceFile } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { LANGUAGES, detectLanguage, highlight, languageName, type LangId } from '../../lib/highlight';
import { FileIcon } from './fileIcon';

/** Past this many characters the text is shown without colour, so typing stays quick. */
const COLOUR_LIMIT = 400_000;

export function FileView({ path, onDirty }: { path: string; onDirty?: (path: string, dirty: boolean) => void }) {
  const { t } = useT();
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  /** The file changed on disk under an edit: the operator chooses to read it again or to save over it. */
  const [conflict, setConflict] = useState(false);
  const [choice, setChoice] = useState<'auto' | LangId>('auto');
  const input = useRef<HTMLTextAreaElement | null>(null);
  const shown = useRef<HTMLPreElement | null>(null);
  const gutter = useRef<HTMLPreElement | null>(null);

  const dirty = !!file && file.text !== null && text !== file.text;
  useEffect(() => onDirty?.(path, dirty), [path, dirty, onDirty]);

  /** The file as it is on disk now, over whatever the editor holds. */
  const read = useCallback(async () => {
    try {
      const f = await api.workspaceFile(path);
      setFile(f);
      setText(f.text ?? '');
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
      }
    },
    4_000,
    !!file,
  );

  const lang: LangId = choice === 'auto' ? detectLanguage(path, file?.text ?? '') : choice;
  const coloured = useMemo(() => (text.length > COLOUR_LIMIT ? highlight(text, 'plain') : highlight(text, lang)), [text, lang]);
  const lines = useMemo(() => {
    const n = text.split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i += 1) s += `${i}\n`;
    return s;
  }, [text]);

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

  const follow = (): void => {
    // The coloured copy and the numbers move with the text under them.
    const el = input.current;
    if (!el) return;
    if (shown.current) {
      shown.current.scrollTop = el.scrollTop;
      shown.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };
  useEffect(follow, [coloured]);

  /** Tab indents the line or the lines chosen, Shift+Tab takes it back; through the browser's own edit, so Ctrl+Z undoes it. */
  const indent = (el: HTMLTextAreaElement, back: boolean): void => {
    const unit = /^\t/m.test(el.value) && !/^ {2,}\S/m.test(el.value) ? '\t' : '  ';
    const { selectionStart: a, selectionEnd: b, value } = el;
    if (a === b && !back) {
      if (!document.execCommand('insertText', false, unit)) el.setRangeText(unit, a, b, 'end');
      setText(el.value);
      return;
    }
    const from = value.lastIndexOf('\n', a - 1) + 1;
    const to = b > a && value[b - 1] === '\n' ? b - 1 : b;
    const chunk = value.slice(from, to);
    const next = chunk
      .split('\n')
      .map((l) => (back ? l.replace(unit === '\t' ? /^\t/ : /^ {1,2}/, '') : unit + l))
      .join('\n');
    el.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, next)) el.setRangeText(next, from, to, 'select');
    el.setSelectionRange(from, from + next.length);
    setText(el.value);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      indent(e.currentTarget, e.shiftKey);
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

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
        <label htmlFor={`ed-lang-${path}`} className="sr-only">{t('ed.language')}</label>
        <select id={`ed-lang-${path}`} className="ed-lang" value={choice} onChange={(e) => setChoice(e.target.value as 'auto' | LangId)} title={t('ed.language')}>
          <option value="auto">{t('ed.langAuto', { name: languageName(detectLanguage(path, file.text ?? '')) })}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button type="button" className="quiet small" disabled={!dirty || busy} onClick={() => { setText(file.text ?? ''); setSaid(''); }}>
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
      <div className="ed-body">
        <pre ref={gutter} className="ed-gutter" aria-hidden="true">{lines}</pre>
        <div className="ed-area">
          <pre ref={shown} className="ed-shown" aria-hidden="true">
            <code dangerouslySetInnerHTML={{ __html: `${coloured}\n` }} />
          </pre>
          <textarea
            ref={input}
            className="ed-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onScroll={follow}
            onKeyDown={onKey}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            aria-label={t('ed.label', { path: file.path })}
          />
        </div>
      </div>
    </div>
  );
}
