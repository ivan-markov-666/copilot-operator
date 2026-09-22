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

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type ModelCatalogue, type ProjectDefault, type ProjectMirrorSelection } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';
import { confirmDialog } from '../dialog';
import { ModelPicker } from '../modelPicker';
import { DirTree } from '../dirTree';

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
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (value: T) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void latest.current(value), ms);
  };
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
        onName={(v) => {
          setName(v);
          nameLater(v);
        }}
        onNameBlur={() => void saveName(name)}
        onDir={(v) => {
          setDir(v);
          dirLater(v);
        }}
        onDirBlur={() => void saveDefault(dir)}
        onBrowse={() => void browse((path) => void saveDefault(path), dir)}
        onRemove={project?.rootDir ? () => void saveDefault('') : undefined}
        removeLabel={t('proj.clear')}
        onFolders={saveDefaultFolders}
      />
      <SavedNote msg={msg} />
      {project && !project.rootDir && <p className="muted small" style={{ marginTop: 8 }}>{t('proj.none')}</p>}

      {others.map((o) => (
        <ProjectEntry
          key={o.name}
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
  onName,
  onNameBlur,
  onDir,
  onDirBlur,
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
  onName: (value: string) => void;
  onNameBlur?: () => void;
  onDir: (value: string) => void;
  onDirBlur?: () => void;
  onBrowse: () => void;
  onRemove?: () => void;
  removeLabel: string;
  onFolders: (sel: ProjectMirrorSelection) => Promise<boolean>;
}) {
  const { t } = useT();
  return (
    <div className="panel inner" style={{ marginTop: 10 }}>
      <div className="row">
        <div style={{ width: 200 }}>
          <label>{t('proj.entryName')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
            onBlur={onNameBlur}
            placeholder={dir ? (dir.replace(/[\/]+$/, '').split(/[\/]/).pop() ?? '') : t('proj.namePlaceholder')}
            disabled={busy}
          />
        </div>
        <div className="grow">
          <label>{t('proj.entryDir')}</label>
          <input type="text" value={dir} onChange={(e) => onDir(e.target.value)} onBlur={onDirBlur} placeholder="C:\Projects\my-app" disabled={busy} />
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
    await onSave(sel);
    setMsg(t('proj.foldersSaved'));
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
 * How a run behaves when a task does not end done — the one number worth a field here.
 *
 * The rest of `limits` stays in the settings file: iterations, minutes, review rounds are
 * tuned once by whoever set the machine up. This one is a decision the operator meets after
 * every blocked task, so it sits where they can change it without opening a file.
 */
function ExecutionSection() {
  const { t } = useT();
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [retries, setRetries] = useState(2);
  const [saved, setSaved] = useState(2);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setRaw(s.raw);
        const limits = (s.resolved.limits ?? {}) as { retryBlockedInFreshChat?: number };
        const n = typeof limits.retryBlockedInFreshChat === 'number' ? limits.retryBlockedInFreshChat : 2;
        setRetries(n);
        setSaved(n);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const save = async (value: number) => {
    if (!raw) return;
    setBusy(true);
    setMsg('');
    try {
      const limits = { ...((raw.limits as Record<string, unknown>) ?? {}), retryBlockedInFreshChat: value };
      const next = { ...raw, limits };
      await api.saveSettings(next);
      setRaw(next);
      setSaved(value);
      setMsg(t('exec.saved'));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveLater = useDebouncedSave(save);

  return (
    <div className="panel" id="execution">
      <h2>{t('exec.title')}</h2>
      <p className="muted small">{t('exec.intro')}</p>
      {err && <div className="err">{err}</div>}
      <label htmlFor="retry-blocked">{t('exec.retryBlocked')}</label>
      <div className="row">
        <input
          id="retry-blocked"
          type="number"
          min={0}
          max={5}
          value={retries}
          onChange={(e) => {
            const n = Math.max(0, Math.min(5, Number(e.target.value) || 0));
            setRetries(n);
            saveLater(n);
          }}
          onBlur={() => retries !== saved && void save(retries)}
          style={{ width: 90 }}
          disabled={busy || !raw}
        />
        <span className="muted small">{t('exec.retryBlockedTimes')}</span>
      </div>
      <SavedNote msg={msg} />
      <p className="why">{t('exec.retryBlockedWhy')}</p>
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
        <Link href="/">
          <button>{t('proj.toSessions')}</button>
        </Link>
        <Link href="/import">
          <button className="quiet">{t('proj.toImport')}</button>
        </Link>
      </div>
    </div>
  );
}
