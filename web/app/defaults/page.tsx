'use client';

/**
 * What every new session starts with: which folders, which model does the work, and which
 * model reviews it.
 *
 * Its own page rather than a row on the system page, because the system page answers "is this
 * machine set up", which is read once, and this answers "what am I working on", which changes
 * whenever the work does. Every folder field and every model picker in the app links here, so
 * this is also where somebody arrives the first time they wonder where a default comes from.
 *
 * The folders are one default and a named list. One is what a new session is pointed at; the
 * list is the rest of the repositories the same person works in — a front end, a back end, a
 * test suite — which every folder field then offers by name and the plan brief lists by path.
 */

import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type ModelCatalogue, type ProjectDefault, type ProjectMirrorSelection } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';
import { confirmDialog } from '../dialog';
import { ModelPicker } from '../modelPicker';
import { DirTree } from '../dirTree';

/** What the operator says contains the runner. Mirrors `execution.isolation` in the config. */
type Isolation = 'none' | 'none-accepted' | 'separate-account' | 'sandbox' | 'vm';
type StartMode = 'confirm' | 'unattended';
type NetworkFetch = 'ask' | 'refuse' | 'run';

export default function DefaultsPage() {
  const { t } = useT();
  /*
   * One model list for the whole page.
   *
   * The two model sections each read the catalogue for themselves, so "Read the list from
   * Copilot" in one of them left the other showing what had been read before — and the review
   * section, which is exactly where a different model is worth choosing, had no way to read it
   * at all. Reading the picker opens the browser with the bot's profile, so it must happen once
   * and be shared, not twice.
   */
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  useEffect(() => {
    api.models().then(setCatalogue).catch(() => undefined);
  }, []);

  const refreshModels = async () => {
    if (!(await confirmDialog(t('model.refreshConfirm')))) return;
    setRefreshing(true);
    setRefreshMsg(t('model.refreshing'));
    try {
      const fresh = await api.models().then(() => api.refreshModels());
      setCatalogue(fresh);
      setRefreshMsg(fresh.options.length === 0 ? (fresh.note ?? t('model.none')) : t('model.refreshed', { n: fresh.options.length }));
    } catch (e) {
      setRefreshMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const shared = { catalogue, setCatalogue, refreshModels, refreshing, refreshMsg };

  return (
    <>
      <div className="panel">
        <h2>{t('def.title')}</h2>
        <p className="muted small">{t('def.intro')}</p>
        <p className="why">{t('def.autoSave')}</p>
      </div>
      <ProjectSection />
      <ModelSection {...shared} />
      <ReviewModelSection {...shared} />
      <ExecutionSection />
    </>
  );
}

/** What the two model sections share: one catalogue, one way to read it again. */
type SharedModels = {
  catalogue: ModelCatalogue | null;
  setCatalogue: (c: ModelCatalogue) => void;
  refreshModels: () => Promise<void>;
  refreshing: boolean;
  refreshMsg: string;
};

/**
 * Saves a value a moment after the typing stops, and on demand.
 *
 * Every field on this page used to end in a Save button, and a page of Save buttons is a page
 * of ways to lose an edit: change the folder, forget the button, wonder later why the session
 * started somewhere else. A select or a checkbox is a decision the moment it moves, so it is
 * written at once; text needs the pause, or every keystroke would be a request.
 */
function useDebouncedSave<T>(save: (value: T) => Promise<unknown>, ms = 900): (value: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const latest = useRef(save);
  latest.current = save;
  /*
   * Leaving the page writes what is still waiting, rather than dropping it. It used to clear the
   * timer, so a number typed and followed within the pause by a click on another tab was shown as
   * accepted and never saved — "saved as you type" with the last thing typed missing.
   */
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) void latest.current(pending.current.value);
  }, []);
  return (value: T) => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = { value };
    timer.current = setTimeout(() => {
      pending.current = null;
      void latest.current(value);
    }, ms);
  };
}

/**
 * A whole number between `min` and `max`, typed freely.
 *
 * The three number fields under Execution used to clamp on every keystroke: emptying the field
 * to type a new value turned it into the minimum at once, and the digits typed next landed after
 * it — select 60, delete it, type 10, and the field read 510 and then 200. The text is now the
 * operator's while they type; `onChange` hears only a value that is already whole and in range,
 * and the clamp happens once, when the field is left, where it can no longer fight the typing.
 */
function BoundedNumber({
  id,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  // A value that arrives from outside (the settings loading) replaces the text; one the typing
  // produced is the same number and changes nothing.
  useEffect(() => setText((current) => (whole(current) === value ? current : String(value))), [value]);
  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = whole(e.target.value);
        if (n !== null && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        const n = whole(text);
        const settled = n === null ? value : Math.max(min, Math.min(max, n));
        setText(String(settled));
        if (settled !== value) onChange(settled);
      }}
      // Wide enough for "10800" at every text size; the width is in characters, so it scales with them.
      style={{ width: '9ch' }}
      disabled={disabled}
    />
  );
}

/** The text as a whole number, or null while it is empty, half-typed or fractional. */
function whole(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

/** The button that does nothing anyone needs, and says so. */
function SavedNote({ msg, onSave }: { msg: string; onSave?: () => void }) {
  const { t } = useT();
  return (
    <div className="row" style={{ marginTop: 6 }}>
      {onSave && (
        <button className="quiet" onClick={onSave} title={t('def.saveAnywayWhy')}>
          {t('def.saveAnyway')}
        </button>
      )}
      <span className="muted small" role="status">
        {msg || t('def.savedAutomatically')}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The folders
// ---------------------------------------------------------------------------------------

function ProjectSection() {
  const { t } = useT();
  const [project, setProject] = useState<ProjectDefault | null>(null);
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // The row being added to the named list. Kept apart from the list itself so a half-typed
  // entry is never saved by a click meant for something else.
  const [newName, setNewName] = useState('');
  const [newDir, setNewDir] = useState('');

  const load = useCallback(async () => {
    try {
      const p = await api.project();
      setProject(p);
      setDir(p.rootDir);
      setName(p.name);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Parameters<typeof api.setProject>[0], done: (p: ProjectDefault) => string) => {
    setBusy(true);
    setMsg('');
    try {
      const p = await api.setProject(patch);
      setProject(p);
      setDir(p.rootDir);
      setMsg(done(p));
      setErr('');
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDefault = (value: string) => save({ rootDir: value }, (p) => (p.rootDir ? t('proj.saved', { dir: p.rootDir }) : t('proj.cleared')));
  const saveName = (value: string) => save({ name: value }, () => t('proj.nameSaved'));
  const dirLater = useDebouncedSave(saveDefault);
  const nameLater = useDebouncedSave(saveName);

  const browse = async (into: (path: string) => void, start: string) => {
    setBusy(true);
    try {
      const picked = await api.browseFolder(start.trim() || undefined);
      if (picked.ok) into(picked.path);
      else if (!picked.cancelled) setErr(picked.reason ?? '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const others = project?.others ?? [];
  const plain = (list: typeof others) => list.map((o) => ({ name: o.name, rootDir: o.rootDir, ...(o.mirror ? { mirror: o.mirror } : {}) }));

  const toggleDesktop = (on: boolean) => save({ mirrorToDesktop: on }, (p) => (p.mirrorToDesktop ? t('proj.mirrorOn', { root: p.contextRoot }) : t('proj.mirrorOff')));
  const saveDefaultFolders = (sel: ProjectMirrorSelection) => save({ mirror: sel }, () => t('proj.foldersSaved'));
  const saveOtherFolders = (name: string, sel: ProjectMirrorSelection) =>
    save({ others: plain(others.map((o) => (o.name === name ? { ...o, mirror: sel } : o))) }, () => t('proj.foldersSaved'));

  const addOther = async () => {
    const ok = await save({ others: [...plain(others), { name: newName.trim(), rootDir: newDir.trim() }] }, (p) => t('proj.othersSaved', { n: p.others.length }));
    if (ok) {
      setNewName('');
      setNewDir('');
    }
  };

  const removeOther = (name: string) =>
    save({ others: plain(others.filter((o) => o.name !== name)) }, (p) => t('proj.othersSaved', { n: p.others.length }));

  return (
    <div className="panel" id="project">
      <h2>{t('proj.title')}</h2>
      <p className="muted small">{t('proj.intro')}</p>
      {err && <div className="err">{err}</div>}

      {project && (
        <div className={`option${project.mirrorToDesktop ? ' warned' : ''}`} style={{ marginBottom: 12 }}>
          <label>
            <input type="checkbox" checked={project.mirrorToDesktop} onChange={(e) => void toggleDesktop(e.target.checked)} disabled={busy} />
            <span>{t('proj.mirrorToDesktop')}</span>
          </label>
          <p className="why">{t('proj.mirrorToDesktopWhy', { root: project.contextRoot })}</p>
        </div>
      )}

      {/*
        One shape for every project, the default included.
        The default used to be two auto-saving fields with a paragraph of repository advice under
        them, while the others were an add-row and a table of text that could not be edited at
        all: to correct a path you removed the project and typed it again, and the same fact —
        whether the folder is a git repository — was a full notice for one and a three-word badge
        for the others. Nothing about being the default makes any of that necessary. It is the
        first entry in one list, marked, and every entry is read and written the same way.
      */}
      <p className="muted small">{t('proj.listIntro')}</p>

      <ProjectEntry
        name={name}
        dir={dir}
        repoOk={!!project?.repoOk}
        repoProblem={project?.repoProblem}
        mirror={project?.mirror}
        isDefault
        busy={busy}
        onNameInput={(v) => {
          setName(v);
          nameLater(v);
        }}
        onName={(v) => void saveName(v)}
        onDirInput={(v) => {
          setDir(v);
          dirLater(v);
        }}
        onDir={(v) => void saveDefault(v)}
        onBrowse={() => void browse((path) => void saveDefault(path), dir)}
        onRemove={project?.rootDir ? () => void saveDefault('') : undefined}
        removeLabel={t('proj.clear')}
        onFolders={saveDefaultFolders}
      />
      <SavedNote msg={msg} />
      {project && !project.rootDir && <p className="muted small" style={{ marginTop: 8 }}>{t('proj.none')}</p>}

      {others.map((o, i) => (
        <ProjectEntry
          // By place, not by name: renaming a project must not remount the row under the cursor.
          key={`other-${i}`}
          name={o.name}
          dir={o.rootDir}
          repoOk={o.repoOk}
          repoProblem={o.repoProblem}
          mirror={o.mirror}
          busy={busy}
          onName={(v) => void save({ others: plain(others.map((x) => (x.name === o.name ? { ...x, name: v } : x))) }, () => t('proj.nameSaved'))}
          onDir={(v) => void save({ others: plain(others.map((x) => (x.name === o.name ? { ...x, rootDir: v } : x))) }, () => t('proj.othersSaved', { n: others.length }))}
          onBrowse={() =>
            void browse(
              (path) => void save({ others: plain(others.map((x) => (x.name === o.name ? { ...x, rootDir: path } : x))) }, () => t('proj.othersSaved', { n: others.length })),
              o.rootDir,
            )
          }
          onRemove={() => void removeOther(o.name)}
          removeLabel={t('proj.otherRemove')}
          onFolders={(sel) => saveOtherFolders(o.name, sel)}
        />
      ))}

      <h3 id="others">{t('proj.addTitle')}</h3>
      <p className="muted small">{t('proj.othersIntro')}</p>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="text"
          aria-label={t('proj.entryName')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('proj.entryName')}
          disabled={busy}
          style={{ width: 160 }}
        />
        <input
          type="text"
          className="grow"
          aria-label={t('proj.entryDir')}
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          placeholder="C:\Projects\my-app-tests"
          disabled={busy}
        />
        <button onClick={() => void browse((p) => setNewDir(p), newDir)} disabled={busy}>
          {t('mirror.browse')}
        </button>
        <button className="primary" onClick={() => void addOther()} disabled={busy || !newName.trim() || !newDir.trim()}>
          {t('proj.otherAdd')}
        </button>
      </div>

      <h3>{t('proj.affects')}</h3>
      <ul className="muted small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>{t('proj.affectsNew')}</li>
        <li>{t('proj.affectsExisting')}</li>
        <li>{t('proj.affectsPlan')}</li>
        <li>{t('proj.affectsNever')}</li>
      </ul>
    </div>
  );
}

/**
 * Which of one project's folders go to the Desktop: the two lists, the two switches, and the
 * tree that fills the lists by clicking. Saved per project, because a test suite wants its
 * `tests` and `fixtures` where an API wants its `src` and nothing else.
 */
/**
 * One project, however it is held.
 *
 * The default lives in `project.rootDir`/`project.name` and the others in `project.others[]`,
 * which is a difference in where the setting is stored and was never a difference the operator
 * should have had to see. They read and write the same way here; only the chip says which one
 * new sessions start in.
 */
function ProjectEntry({
  name,
  dir,
  repoOk,
  repoProblem,
  mirror,
  isDefault = false,
  busy,
  onNameInput,
  onName,
  onDirInput,
  onDir,
  onBrowse,
  onRemove,
  removeLabel,
  onFolders,
}: {
  name: string;
  dir: string;
  repoOk: boolean;
  repoProblem?: string;
  mirror?: ProjectMirrorSelection;
  isDefault?: boolean;
  busy: boolean;
  /** Every keystroke, for an entry that saves as it is typed (the default one, debounced). */
  onNameInput?: (value: string) => void;
  /** The finished value, when the field is left and it differs from what is saved. */
  onName: (value: string) => void;
  onDirInput?: (value: string) => void;
  onDir: (value: string) => void;
  onBrowse: () => void;
  onRemove?: () => void;
  removeLabel: string;
  onFolders: (sel: ProjectMirrorSelection) => Promise<boolean>;
}) {
  const { t } = useT();
  const id = useId();
  /*
   * What is typed lives here until the field is left. The other projects saved on every keystroke
   * and showed only what the save returned, so typed characters snapped back while a save was out,
   * the field went grey during each save, and a rename remounted the row and lost the cursor. The
   * text fields are never disabled: a save in progress is no reason to stop someone typing.
   */
  const [nameDraft, setNameDraft] = useState(name);
  const [dirDraft, setDirDraft] = useState(dir);
  useEffect(() => setNameDraft(name), [name]);
  useEffect(() => setDirDraft(dir), [dir]);
  return (
    <div className="panel inner" style={{ marginTop: 10 }}>
      <div className="row">
        <div style={{ width: 'min(200px, 100%)' }}>
          <label htmlFor={`${id}-name`}>{t('proj.entryName')}</label>
          <input
            id={`${id}-name`}
            type="text"
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              onNameInput?.(e.target.value);
            }}
            onBlur={() => {
              if (nameDraft !== name || onNameInput) onName(nameDraft);
            }}
            placeholder={dir ? (dir.replace(/[\/]+$/, '').split(/[\/]/).pop() ?? '') : t('proj.namePlaceholder')}
          />
        </div>
        <div className="grow">
          <label htmlFor={`${id}-dir`}>{t('proj.entryDir')}</label>
          <input
            id={`${id}-dir`}
            type="text"
            value={dirDraft}
            onChange={(e) => {
              setDirDraft(e.target.value);
              onDirInput?.(e.target.value);
            }}
            onBlur={() => {
              if (dirDraft !== dir || onDirInput) onDir(dirDraft);
            }}
            placeholder="C:\Projects\my-app"
          />
        </div>
        <button onClick={onBrowse} disabled={busy}>
          {t('mirror.browse')}
        </button>
        {onRemove && (
          <button className="quiet" onClick={onRemove} disabled={busy}>
            {removeLabel}
          </button>
        )}
      </div>

      <div className="row small" style={{ marginTop: 6 }}>
        {isDefault && (
          <span className="chip" title={t('proj.isDefaultWhy')}>
            {t('proj.isDefault')}
          </span>
        )}
        {dir && (
          <span className={`badge ${repoOk ? 'done' : ''}`} title={repoOk ? t('proj.isRepo') : repoProblem}>
            {repoOk ? t('proj.otherRepo') : t('proj.otherNotRepo')}
          </span>
        )}
        {dir && !repoOk && <span className="muted">{repoProblem || t('proj.notRepoWhy')}</span>}
      </div>

      {dir && (
        <details className="small" style={{ marginTop: 8 }}>
          <summary>{t('proj.folders')}</summary>
          <ProjectFolders rootDir={dir} value={mirror} onSave={onFolders} busy={busy} />
        </details>
      )}
    </div>
  );
}


function ProjectFolders({
  rootDir,
  value,
  onSave,
  busy,
}: {
  rootDir: string;
  value?: ProjectMirrorSelection;
  onSave: (sel: ProjectMirrorSelection) => Promise<boolean>;
  busy: boolean;
}) {
  const { t } = useT();
  const [include, setInclude] = useState((value?.includeDirs ?? []).join('\n'));
  const [exclude, setExclude] = useState((value?.excludeDirs ?? []).join('\n'));
  const [respectGitignore, setRespectGitignore] = useState(value?.respectGitignore ?? true);
  const [includeEnvFiles, setIncludeEnvFiles] = useState(value?.includeEnvFiles ?? false);

  const lines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);
  const [msg, setMsg] = useState('');

  const write = async (next: Partial<ProjectMirrorSelection>) => {
    const sel: ProjectMirrorSelection = {
      includeDirs: lines(include),
      excludeDirs: lines(exclude),
      respectGitignore,
      includeEnvFiles,
      ...next,
    };
    // `onSave` says whether it worked and shows its own error; "saved" only when it was.
    if (await onSave(sel)) setMsg(t('proj.foldersSaved'));
  };
  const writeLater = useDebouncedSave(write);

  /*
   * One way in for both lists, because there were three and only one of them saved.
   *
   * The two text areas and the tree are three ways of editing the same pair of lists, and each
   * had a handler of its own: the "out" box saved, the "in" box only filled the field, and the
   * tree filled both fields and saved neither. So typing a directory to include, or clicking one
   * in the tree, looked exactly like it had worked and was gone by the next load — and the only
   * reason it ever seemed to work was that toggling `.gitignore` or `.env` afterwards wrote
   * whatever happened to be in the boxes at that moment.
   *
   * Both lists are passed explicitly rather than read back out of state, because a save
   * scheduled from a change cannot see the state that change has not applied yet.
   */
  const apply = (nextInclude: string[], nextExclude: string[]) => {
    setInclude(nextInclude.join('\n'));
    setExclude(nextExclude.join('\n'));
    writeLater({ includeDirs: nextInclude, excludeDirs: nextExclude });
  };

  const toggleEnv = async (on: boolean) => {
    if (on && !(await confirmDialog(t('mirror.envWarn')))) return;
    setIncludeEnvFiles(on);
    void write({ includeEnvFiles: on });
  };

  return (
    <div style={{ marginTop: 8 }}>
      <p className="muted small">{t('proj.foldersHint')}</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <label>{t('mirror.include')}</label>
          <textarea
            value={include}
            onChange={(e) => {
              setInclude(e.target.value);
              writeLater({ includeDirs: lines(e.target.value), excludeDirs: lines(exclude) });
            }}
            placeholder={'src\ntests'} style={{ minHeight: 70 }}
          />
        </div>
        <div className="grow">
          <label>{t('mirror.exclude')}</label>
          <textarea
            value={exclude}
            onChange={(e) => {
              setExclude(e.target.value);
              writeLater({ includeDirs: lines(include), excludeDirs: lines(e.target.value) });
            }}
            placeholder={'src/generated'}
            style={{ minHeight: 70 }}
          />
        </div>
      </div>
      <DirTree
        rootDir={rootDir}
        respectGitignore={respectGitignore}
        includeEnvFiles={includeEnvFiles}
        include={lines(include)}
        exclude={lines(exclude)}
        onChange={apply}
      />
      <div className="option">
        <label>
          <input
            type="checkbox"
            checked={respectGitignore}
            onChange={(e) => {
              setRespectGitignore(e.target.checked);
              void write({ respectGitignore: e.target.checked });
            }}
          />
          <span>{t('mirror.gitignore')}</span>
        </label>
      </div>
      <div className={`option${includeEnvFiles ? ' warned' : ''}`}>
        <label>
          <input type="checkbox" checked={includeEnvFiles} onChange={(e) => void toggleEnv(e.target.checked)} />
          <span>{t('mirror.env')}</span>
        </label>
      </div>
      <SavedNote msg={busy ? '' : msg} />
    </div>
  );
}

/**
 * How a run behaves: how long a task may go on, and what happens when one does not end done.
 *
 * The retry count is a decision the operator meets after every blocked task. The two ceilings —
 * iterations and minutes per task — are what a long task runs into, and until 2026-09-28 they were
 * only in the settings file; a task cut off by them can be continued in its own chat ("Continue").
 * The review rounds and the rest of `limits` stay in the file.
 */
function ExecutionSection() {
  const { t } = useT();
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  // The settings as the last write left them, read synchronously by the next one. See `write`.
  const rawRef = useRef<Record<string, unknown> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [retries, setRetries] = useState(2);
  const [iterations, setIterations] = useState(60);
  const [minutes, setMinutes] = useState(240);
  const [replySec, setReplySec] = useState(900);
  const [isolation, setIsolation] = useState<Isolation>('none');
  const [startMode, setStartMode] = useState<StartMode>('confirm');
  const [networkFetch, setNetworkFetch] = useState<NetworkFetch>('ask');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        rawRef.current = s.raw;
        setRaw(s.raw);
        /*
         * Read from `raw`, which is the settings file, and not from `resolved`, which carries only
         * the resolved *paths* (profileDir, cwd, runsDir…) and never had an `execution` or `limits`
         * on it at all. Reading it there did not fail, it silently fell through to the default, so
         * the retry field showed 2 on a machine that had saved 0 and the value it displayed was
         * never the value in force. Both fields now read the branch they write back to.
         */
        const limits = ((s.raw.limits as Record<string, unknown>) ?? {}) as {
          retryBlockedInFreshChat?: number;
          maxIterations?: number;
          maxRunMinutes?: number;
        };
        setRetries(typeof limits.retryBlockedInFreshChat === 'number' ? limits.retryBlockedInFreshChat : 2);
        setIterations(typeof limits.maxIterations === 'number' ? limits.maxIterations : 60);
        setMinutes(typeof limits.maxRunMinutes === 'number' ? limits.maxRunMinutes : 240);
        const copilot = ((s.raw.copilot as Record<string, unknown>) ?? {}) as { replyTimeoutSec?: number };
        setReplySec(typeof copilot.replyTimeoutSec === 'number' ? copilot.replyTimeoutSec : 900);
        const exec = ((s.raw.execution as Record<string, unknown>) ?? {}) as {
          isolation?: Isolation;
          mode?: StartMode;
          networkFetch?: NetworkFetch;
        };
        setIsolation(exec.isolation ?? 'none');
        setStartMode(exec.mode ?? 'confirm');
        setNetworkFetch(exec.networkFetch ?? 'ask');
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  /*
   * One field's value, written into the whole settings object.
   *
   * Every field here saves the whole object, so two writes in flight at once — a number field's
   * pause ending while a select is being saved — would each start from the object as it was before
   * the other, and the second would put back what the first had changed. They used to be kept
   * apart by disabling every field while one saved, which also took the focus out of a number
   * field in the middle of typing it: the pause fired a save, the field went grey, and the next
   * digits went nowhere. Now each write waits for the one before and is built on the object that
   * one produced, so nothing has to be disabled.
   */
  const write = (branch: 'limits' | 'execution' | 'copilot', key: string, value: unknown): Promise<void> => {
    const run = async () => {
      if (!rawRef.current) return;
      /*
       * The file as it is now, not as this section first read it. The other sections of this page
       * save through their own calls — the models, the projects — and a write built on the copy read
       * when the page opened put back whatever they had changed since: choose a model, then change a
       * limit, and the old model was back.
       */
      const base = await api
        .settings()
        .then((s) => s.raw)
        .catch(() => rawRef.current as Record<string, unknown>);
      const next = { ...base, [branch]: { ...((base[branch] as Record<string, unknown>) ?? {}), [key]: value } };
      setMsg('');
      try {
        await api.saveSettings(next);
        rawRef.current = next;
        setRaw(next);
        setMsg(t('exec.saved'));
        setErr('');
      } catch (e) {
        setErr((e as Error).message);
      }
    };
    const done = queue.current.then(run);
    queue.current = done.catch(() => undefined);
    return done;
  };
  const saveRetriesLater = useDebouncedSave((n: number) => write('limits', 'retryBlockedInFreshChat', n));
  const saveIterationsLater = useDebouncedSave((n: number) => write('limits', 'maxIterations', n));
  const saveMinutesLater = useDebouncedSave((n: number) => write('limits', 'maxRunMinutes', n));
  const saveReplyLater = useDebouncedSave((n: number) => write('copilot', 'replyTimeoutSec', n));

  /*
   * The fields that change what a run is allowed to do rather than how hard it tries. Saved
   * immediately on choosing, like the other selects on this page.
   */
  const saveExecution = (key: 'isolation' | 'mode' | 'networkFetch', value: string) => write('execution', key, value);

  return (
    <div className="panel" id="execution">
      <h2>{t('exec.title')}</h2>
      <p className="muted small">{t('exec.intro')}</p>
      {err && <div className="err">{err}</div>}
      <label htmlFor="retry-blocked">{t('exec.retryBlocked')}</label>
      <div className="row">
        <BoundedNumber
          id="retry-blocked"
          value={retries}
          min={0}
          max={5}
          onChange={(n) => {
            setRetries(n);
            saveRetriesLater(n);
          }}
          disabled={!raw}
        />
        <span className="muted small">{t('exec.retryBlockedTimes')}</span>
      </div>
      <p className="why">{t('exec.retryBlockedWhy')}</p>

      <label htmlFor="max-iterations">{t('exec.maxIterations')}</label>
      <div className="row">
        <BoundedNumber
          id="max-iterations"
          value={iterations}
          min={5}
          max={200}
          onChange={(n) => {
            setIterations(n);
            saveIterationsLater(n);
          }}
          disabled={!raw}
        />
        <span className="muted small">{t('exec.maxIterationsUnit')}</span>
      </div>
      <p className="why">{t('exec.maxIterationsWhy')}</p>

      <label htmlFor="max-minutes">{t('exec.maxRunMinutes')}</label>
      <div className="row">
        <BoundedNumber
          id="max-minutes"
          value={minutes}
          min={10}
          max={1440}
          onChange={(n) => {
            setMinutes(n);
            saveMinutesLater(n);
          }}
          disabled={!raw}
        />
        <span className="muted small">{t('exec.maxRunMinutesUnit')}</span>
      </div>
      <p className="why">{t('exec.maxRunMinutesWhy')}</p>

      <label htmlFor="reply-timeout">{t('exec.replyTimeout')}</label>
      <div className="row">
        <BoundedNumber
          id="reply-timeout"
          value={replySec}
          min={60}
          max={10800}
          onChange={(n) => {
            setReplySec(n);
            saveReplyLater(n);
          }}
          disabled={!raw}
        />
        <span className="muted small">{t('exec.replyTimeoutUnit')}</span>
      </div>
      <p className="why">{t('exec.replyTimeoutWhy')}</p>

      <label htmlFor="isolation">{t('exec.isolation')}</label>
      <select
        id="isolation"
        value={isolation}
        onChange={(e) => {
          const v = e.target.value as Isolation;
          setIsolation(v);
          void saveExecution('isolation', v);
        }}
        disabled={!raw}
      >
        <option value="none">{t('exec.isolationNone')}</option>
        <option value="none-accepted">{t('exec.isolationNoneAccepted')}</option>
        <option value="separate-account">{t('exec.isolationAccount')}</option>
        <option value="sandbox">{t('exec.isolationSandbox')}</option>
        <option value="vm">{t('exec.isolationVm')}</option>
      </select>
      <p className="why">{t('exec.isolationWhy')}</p>

      {/*
        The two choices that make a run go without anybody. Placed after the isolation claim
        because that claim is what allows an unattended run on this machine at all; these two only
        decide how much such a run still asks. Both are about unattended runs: a step-by-step run
        shows every step, whatever is chosen here.
      */}
      <label htmlFor="start-mode">{t('exec.startMode')}</label>
      <select
        id="start-mode"
        value={startMode}
        onChange={(e) => {
          const v = e.target.value as StartMode;
          setStartMode(v);
          void saveExecution('mode', v);
        }}
        disabled={!raw}
      >
        <option value="confirm">{t('exec.startModeAsk')}</option>
        <option value="unattended">{t('exec.startModeAuto')}</option>
      </select>
      <p className="why">{t('exec.startModeWhy')}</p>

      <label htmlFor="network-fetch">{t('exec.networkFetch')}</label>
      <select
        id="network-fetch"
        value={networkFetch}
        onChange={(e) => {
          const v = e.target.value as NetworkFetch;
          setNetworkFetch(v);
          void saveExecution('networkFetch', v);
        }}
        disabled={!raw}
      >
        <option value="ask">{t('exec.networkFetchAsk')}</option>
        <option value="refuse">{t('exec.networkFetchRefuse')}</option>
        <option value="run">{t('exec.networkFetchRun')}</option>
      </select>
      <SavedNote msg={msg} />
      <p className="why">{t('exec.networkFetchWhy')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The models: one for the work, one for the second opinion
// ---------------------------------------------------------------------------------------

function ModelSection({ catalogue, setCatalogue, refreshModels, refreshing, refreshMsg }: SharedModels) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const chosen = catalogue?.defaultModel ?? '';

  /** Chosen is saved. A model picker has no half-typed state to protect. */
  const save = async (name: string) => {
    setBusy(true);
    setMsg('');
    try {
      const saved = await api.setDefaultModel(name);
      if (catalogue) setCatalogue({ ...catalogue, defaultModel: saved.defaultModel });
      setMsg(saved.defaultModel ? t('def.modelSaved', { name: saved.defaultModel }) : t('def.modelCleared'));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" id="model">
      <h2>{t('def.modelTitle')}</h2>
      <p className="muted small">{t('def.modelIntro')}</p>
      {err && <div className="err">{err}</div>}

      <label htmlFor="default-model">{t('def.modelField')}</label>
      <div className="row">
        <ModelPicker
          id="default-model"
          chosen={chosen}
          onChange={(name) => void save(name)}
          none={t('def.modelNone')}
          catalogue={catalogue}
          disabled={busy || refreshing}
        />
        <button className="quiet" onClick={() => void save('')} disabled={busy || !chosen}>
          {t('proj.clear')}
        </button>
        <button onClick={() => void refreshModels()} disabled={busy || refreshing}>
          {t('model.refresh')}
        </button>
      </div>
      <SavedNote msg={msg || refreshMsg} />

      <p className="muted small" style={{ marginTop: 8 }}>
        {catalogue?.readAt
          ? t('model.readAt', { t: fmtTime(catalogue.readAt), n: catalogue.options.length })
          : t('model.neverRead')}
      </p>

      <h3>{t('proj.affects')}</h3>
      <ul className="muted small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>{t('def.modelAffectsNew')}</li>
        <li>{t('def.modelAffectsExisting')}</li>
        <li>{t('def.modelAffectsBatch')}</li>
      </ul>
    </div>
  );
}

function ReviewModelSection({ catalogue, setCatalogue, refreshModels, refreshing, refreshMsg }: SharedModels) {
  const { t } = useT();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const chosen = catalogue?.defaultReviewModel ?? '';

  const save = async (name: string) => {
    setBusy(true);
    setMsg('');
    try {
      const saved = await api.setDefaultReviewModel(name);
      if (catalogue) setCatalogue({ ...catalogue, defaultReviewModel: saved.defaultReviewModel });
      setMsg(saved.defaultReviewModel ? t('def.reviewSaved', { name: saved.defaultReviewModel }) : t('def.reviewCleared'));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sameAsWork = chosen !== '' && chosen === (catalogue?.defaultModel ?? '');

  return (
    <div className="panel" id="review">
      <h2>{t('def.reviewTitle')}</h2>
      <p className="muted small">{t('def.reviewIntro')}</p>
      {err && <div className="err">{err}</div>}

      <label htmlFor="default-review-model">{t('def.reviewField')}</label>
      <div className="row">
        <ModelPicker
          id="default-review-model"
          chosen={chosen}
          onChange={(name) => void save(name)}
          none={t('def.reviewNone')}
          catalogue={catalogue}
          disabled={busy || refreshing}
        />
        <button className="quiet" onClick={() => void save('')} disabled={busy || !chosen}>
          {t('proj.clear')}
        </button>
        {/* The same list, read from the same place: a model chosen here is chosen from what
            the chat actually offers, and reading it in one section updates the other. */}
        <button onClick={() => void refreshModels()} disabled={busy || refreshing}>
          {t('model.refresh')}
        </button>
      </div>
      {sameAsWork && (
        <p className="why" style={{ color: 'var(--warn)' }}>
          {t('def.reviewSame')}
        </p>
      )}
      <SavedNote msg={msg || refreshMsg} />

      <h3>{t('proj.affects')}</h3>
      <ul className="muted small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>{t('def.reviewAffectsNew')}</li>
        <li>{t('def.reviewAffectsExisting')}</li>
        <li>{t('def.reviewAffectsBatch')}</li>
      </ul>

      <div className="row" style={{ marginTop: 12 }}>
        <Link href="/" className="button-link plain">
          {t('proj.toSessions')}
        </Link>
        <Link href="/import" className="button-link quiet">
          {t('proj.toImport')}
        </Link>
      </div>
    </div>
  );
}
