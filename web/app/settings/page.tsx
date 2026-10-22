'use client';

/**
 * Settings: the folders the chat works in, the sign-in to Copilot, the models, and how a task runs.
 *
 * Its own page rather than a row on the system page, because the system page answers "is this
 * machine set up", which is read once, and this answers "what am I working on", which changes
 * whenever the work does.
 *
 * Laid out as one grid since 2026-10-20 (operator: "align the buttons, the inputs and the other
 * elements"): every field is a row — its name with an ⓘ that says what it is for and how it helps,
 * then the control — so the inputs, selects and buttons line up down the page. The explanations
 * that stood under every field went into those ⓘ, and the "what this changes" lists, which spoke of
 * sessions that are gone, went with them. The base prompt is shown here to read (its own page, where
 * it could be edited, went: it changes only when the bot is updated), and each project carries its
 * level 2, which Kerrigan takes with her.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, type ModelCatalogue, type ProjectDefault, type Skill } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';
import { confirmDialog } from '../dialog';
import { ModelPicker } from '../modelPicker';
import { InfoTip } from '../popover';
import { BranchIcon } from '../branchIcon';

/** What the operator says contains the runner. Mirrors `execution.isolation` in the config. */
type Isolation = 'none' | 'none-accepted' | 'separate-account' | 'sandbox' | 'vm';
type StartMode = 'confirm' | 'unattended';
type NetworkFetch = 'ask' | 'refuse' | 'run';

/** The longest level 2 a project may have; the server holds it to the same (`MAX_PROJECT_LEVEL2`). */
const MAX_LEVEL2 = 8000;

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
    <div className="settings">
      <div className="panel">
        <h2>{t('def.title')}</h2>
        <p className="muted small">{t('def.intro')}</p>
        <p className="why">{t('def.autoSave')}</p>
      </div>
      <Level1Section />
      <ProjectSection />
      <SkillsSection />
      <LoginSection />
      <ModelSection {...shared} />
      <ReviewModelSection {...shared} />
      <ExecutionSection />
    </div>
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

/** A field's name with its ⓘ: what the field is for and how it helps. */
function FieldName({ htmlFor, label, info, as = 'label' }: { htmlFor?: string; label: string; info: string; as?: 'label' | 'span' }) {
  const { t } = useT();
  return (
    <div className="field-label">
      {as === 'label' ? <label htmlFor={htmlFor}>{label}</label> : <span className="field-name">{label}</span>}
      <InfoTip label={t('info.about', { name: label })} text={info} />
    </div>
  );
}

/** One row of the grid: the name on the left, the control (and its unit) on the right. */
function Field({ id, label, info, unit, children }: { id: string; label: string; info: string; unit?: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <FieldName htmlFor={id} label={label} info={info} />
      <div className="field-control">
        {children}
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * Saves a value a moment after the typing stops, and on demand.
 *
 * Every field on this page used to end in a Save button, and a page of Save buttons is a page
 * of ways to lose an edit: change the folder, forget the button, wonder later why the chat
 * worked somewhere else. A select or a checkbox is a decision the moment it moves, so it is
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
      className="number"
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
    <div className="row saved-note">
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
// Skills (operator, 2026-10-21): instructions for a kind of task that comes back
// ---------------------------------------------------------------------------------------

const EMPTY_SKILL: Skill = { name: '', description: '', text: '', projectDir: '' };

/**
 * The skills: each one a name to call it by (after `/` at the start of a message, or from the list under the chat's
 * box), a line on what it is for, the project it is for or every project, and the instructions that go with the
 * message. Saved as the rest of the page is — a field when it is left, the instructions a moment after typing stops.
 */
function SkillsSection() {
  const { t } = useT();
  const [list, setList] = useState<Skill[] | null>(null);
  const [limits, setLimits] = useState({ maxText: 8000, maxDescription: 300 });
  const [projects, setProjects] = useState<Array<{ name: string; dir: string }>>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Skill>(EMPTY_SKILL);

  useEffect(() => {
    api
      .skills()
      .then((r) => {
        setList(r.skills);
        setLimits({ maxText: r.maxText, maxDescription: r.maxDescription });
      })
      .catch((e: unknown) => setErr((e as Error).message));
    api
      .project()
      .then((p) => setProjects([...(p.rootDir ? [{ name: p.name || p.rootDir, dir: p.rootDir }] : []), ...p.others.map((o) => ({ name: o.name, dir: o.rootDir }))]))
      .catch(() => undefined);
  }, []);

  const save = async (next: Skill[]): Promise<boolean> => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.setSkills(next);
      setList(r.skills);
      setMsg(t('skills.saved', { n: r.skills.length }));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const all = list ?? [];
  const add = async () => {
    if (await save([...all, { ...draft, name: draft.name.trim().toLowerCase() }])) setDraft(EMPTY_SKILL);
  };
  const remove = async (i: number) => {
    if (!(await confirmDialog(t('skills.removeConfirm', { name: all[i]!.name }), { okLabel: t('skills.remove'), danger: true }))) return;
    await save(all.filter((_, j) => j !== i));
  };

  return (
    <section className="panel" id="skills" aria-labelledby="skills-title">
      <h2 id="skills-title">{t('skills.title')}</h2>
      <p className="muted small">{t('skills.intro')}</p>
      {err && <div className="err">{err}</div>}
      {list && list.length === 0 && <p className="muted small">{t('skills.none')}</p>}
      {all.map((k, i) => (
        <SkillEntry
          // By place: renaming a skill must not remount the row under the cursor.
          key={`skill-${i}`}
          skill={k}
          projects={projects}
          limits={limits}
          onChange={(changed) => save(all.map((x, j) => (j === i ? changed : x)))}
          onRemove={() => void remove(i)}
          busy={busy}
        />
      ))}
      <SavedNote msg={msg} />

      <h3 id="skills-add">{t('skills.addTitle')}</h3>
      <SkillEntry skill={draft} projects={projects} limits={limits} onDraft={setDraft} busy={busy} />
      <div className="row">
        <button className="primary" onClick={() => void add()} disabled={busy || !draft.name.trim() || !draft.text.trim()}>
          {t('skills.add')}
        </button>
      </div>
    </section>
  );
}

/** A waste bin, beside Delete. */
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.5h7l.7-9.5M6.6 6.6v4.8M9.4 6.6v4.8" />
    </svg>
  );
}

/**
 * One skill's fields. A saved one is written as it is edited (`onChange`); the new one only keeps what is typed
 * (`onDraft`) until "Add the skill".
 */
function SkillEntry({
  skill,
  projects,
  limits,
  onChange,
  onDraft,
  onRemove,
  busy,
}: {
  skill: Skill;
  projects: Array<{ name: string; dir: string }>;
  limits: { maxText: number; maxDescription: number };
  onChange?: (skill: Skill) => Promise<boolean>;
  onDraft?: (skill: Skill) => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const id = useId();
  const [shown, setShown] = useState(skill);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setShown(skill);
  }, [skill]);
  const edit = (patch: Partial<Skill>): Skill => {
    const next = { ...shown, ...patch };
    setShown(next);
    onDraft?.(next);
    return next;
  };
  const textLater = useDebouncedSave(async (next: Skill) => {
    typing.current = false;
    if (onChange && next.text !== skill.text) await onChange(next);
  }, 1200);
  const leave = (): void => {
    if (onChange && (shown.name !== skill.name || shown.description !== skill.description)) void onChange(shown);
  };
  return (
    <div className={`panel inner skill-entry${onChange ? '' : ' skill-new'}`}>
      {/* A saved skill's name and Delete on top of it, where they are seen (operator, 2026-10-21: "an option to delete a skill"). */}
      {onRemove && (
        <div className="skill-head">
          <span className="skill-title">/{shown.name}</span>
          <button type="button" className="danger skill-delete" onClick={onRemove} disabled={busy} aria-label={t('skills.removeOne', { name: shown.name })} title={t('skills.removeOne', { name: shown.name })}>
            <TrashIcon />
            {t('skills.remove')}
          </button>
        </div>
      )}
      <div className="project-fields">
        <div>
          <FieldName htmlFor={`${id}-name`} label={t('skills.name')} info={t('skills.nameInfo')} />
          <div className="input-with-buttons skill-name-box">
            <span className="skill-slash" aria-hidden="true">/</span>
            <input id={`${id}-name`} type="text" value={shown.name} onChange={(e) => edit({ name: e.target.value })} onBlur={leave} placeholder="new-test" spellCheck={false} />
          </div>
        </div>
        <div>
          <FieldName htmlFor={`${id}-description`} label={t('skills.description')} info={t('skills.descriptionInfo')} />
          <input id={`${id}-description`} type="text" value={shown.description} maxLength={limits.maxDescription} onChange={(e) => edit({ description: e.target.value })} onBlur={leave} />
        </div>
        <div>
          <FieldName htmlFor={`${id}-project`} label={t('skills.project')} info={t('skills.projectInfo')} />
          <div className="input-with-buttons">
            <select
              id={`${id}-project`}
              value={shown.projectDir}
              onChange={(e) => {
                const next = edit({ projectDir: e.target.value });
                if (onChange) void onChange(next);
              }}
            >
              <option value="">{t('skills.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.dir} value={p.dir}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="project-level2">
        <FieldName htmlFor={`${id}-text`} label={t('skills.text')} info={t('skills.textInfo', { n: limits.maxText.toLocaleString() })} />
        <textarea
          id={`${id}-text`}
          className="prose"
          rows={5}
          maxLength={limits.maxText}
          value={shown.text}
          onChange={(e) => {
            const next = edit({ text: e.target.value });
            // A saved skill is written a moment after the typing stops; the new one's text is only kept until it is added.
            if (onChange) {
              typing.current = true;
              textLater(next);
            }
          }}
          placeholder={t('skills.textPlaceholder')}
        />
        <span className="muted small">{t('skills.count', { n: shown.text.length.toLocaleString(), max: limits.maxText.toLocaleString() })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The base prompt, to read
// ---------------------------------------------------------------------------------------

/**
 * The base prompt (level 1), shown and not edited (operator, 2026-10-20): "it changes at system level, when we
 * update the bot". Folded, with what it is said plainly above the fold, where it cannot be missed.
 */
function Level1Section() {
  const { t } = useT();
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .level1()
      .then((r) => setText(r.content))
      .catch((e) => setErr(t('l1.failed', { reason: (e as Error).message })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="panel" id="level1" aria-labelledby="level1-title">
      <div className="row section-title">
        <h2 id="level1-title">{t('l1.title')}</h2>
        <span className="badge">{t('l1.readOnly')}</span>
      </div>
      <div className="callout" role="note">
        {t('l1.what')}
      </div>
      {err && <div className="err">{err}</div>}
      <details className="l1-text">
        <summary>{t('l1.show')}</summary>
        <pre className="l1-pre">{text ?? '…'}</pre>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// The projects
// ---------------------------------------------------------------------------------------

type Patch = Parameters<typeof api.setProject>[0];

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

  const save = async (patch: Patch, done: (p: ProjectDefault) => string) => {
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
  const plain = (list: typeof others) => list.map((o) => ({ name: o.name, rootDir: o.rootDir, level2: o.level2, readOnly: o.readOnly }));
  const saveOther = (o: (typeof others)[number], change: Partial<{ name: string; rootDir: string; level2: string; readOnly: boolean }>, done: (p: ProjectDefault) => string) =>
    save({ others: plain(others.map((x) => (x.name === o.name ? { ...x, ...change } : x))) }, done);

  const addOther = async () => {
    const ok = await save({ others: [...plain(others), { name: newName.trim(), rootDir: newDir.trim(), level2: '', readOnly: false }] }, (p) => t('proj.othersSaved', { n: p.others.length }));
    if (ok) {
      setNewName('');
      setNewDir('');
    }
  };

  const removeOther = (name: string) => save({ others: plain(others.filter((o) => o.name !== name)) }, (p) => t('proj.othersSaved', { n: p.others.length }));

  return (
    <section className="panel" id="project" aria-labelledby="project-title">
      <h2 id="project-title">{t('proj.title')}</h2>
      <p className="muted small">{t('proj.intro')}</p>
      {err && <div className="err">{err}</div>}

      {/*
        One shape for every project, the chat's included: name, folder, its git and branch, and its level 2. The first is
        where the chat works, and says so; every entry is read and written the same way.
      */}
      <ProjectEntry
        name={name}
        dir={dir}
        repoOk={!!project?.repoOk}
        repoProblem={project?.repoProblem}
        branch={project?.branch}
        level2={project?.level2 ?? ''}
        readOnly={project?.readOnly === true}
        onReadOnly={(v) => save({ readOnly: v }, () => t(v ? 'proj.readOnlyOn' : 'proj.readOnlyOff', { name: name || dir }))}
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
        onLevel2={(v) => save({ level2: v }, () => t('proj.level2Saved', { name: name || dir }))}
        onRemove={project?.rootDir ? () => void saveDefault('') : undefined}
        removeLabel={t('proj.clear')}
      />
      {project && !project.rootDir && <p className="muted small">{t('proj.none')}</p>}

      {others.map((o, i) => (
        <ProjectEntry
          // By place, not by name: renaming a project must not remount the row under the cursor.
          key={`other-${i}`}
          name={o.name}
          dir={o.rootDir}
          repoOk={o.repoOk}
          repoProblem={o.repoProblem}
          branch={o.branch}
          level2={o.level2}
          readOnly={o.readOnly === true}
          onReadOnly={(v) => saveOther(o, { readOnly: v }, () => t(v ? 'proj.readOnlyOn' : 'proj.readOnlyOff', { name: o.name }))}
          busy={busy}
          onName={(v) => void saveOther(o, { name: v }, () => t('proj.nameSaved'))}
          onDir={(v) => void saveOther(o, { rootDir: v }, () => t('proj.othersSaved', { n: others.length }))}
          onBrowse={() => void browse((path) => void saveOther(o, { rootDir: path }, () => t('proj.othersSaved', { n: others.length })), o.rootDir)}
          onLevel2={(v) => saveOther(o, { level2: v }, () => t('proj.level2Saved', { name: o.name }))}
          onRemove={() => void removeOther(o.name)}
          removeLabel={t('proj.otherRemove')}
        />
      ))}
      <SavedNote msg={msg} />

      <h3 id="others">{t('proj.addTitle')}</h3>
      <p className="muted small">{t('proj.othersIntro')}</p>
      <div className="project-fields add-project">
        <div>
          <FieldName htmlFor="new-project-name" label={t('proj.entryName')} info={t('proj.nameInfo')} />
          <input id="new-project-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('proj.entryName')} disabled={busy} />
        </div>
        <div>
          <FieldName htmlFor="new-project-dir" label={t('proj.entryDir')} info={t('proj.dirInfo')} />
          <div className="input-with-buttons">
            <input id="new-project-dir" type="text" value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="C:\Projects\my-app-tests" disabled={busy} />
            <button onClick={() => void browse((p) => setNewDir(p), newDir)} disabled={busy}>
              {t('mirror.browse')}
            </button>
            <button className="primary" onClick={() => void addOther()} disabled={busy || !newName.trim() || !newDir.trim()}>
              {t('proj.otherAdd')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One project, however it is held.
 *
 * The chat's lives in `project.rootDir`/`project.name`/`project.level2` and the others in `project.others[]`,
 * which is a difference in where the setting is stored and was never a difference the operator should have
 * had to see. They read and write the same way here; only the chip says which one the chat works in.
 */
function ProjectEntry({
  name,
  dir,
  repoOk,
  repoProblem,
  branch,
  level2,
  readOnly,
  onReadOnly,
  isDefault = false,
  busy,
  onNameInput,
  onName,
  onDirInput,
  onDir,
  onBrowse,
  onLevel2,
  onRemove,
  removeLabel,
}: {
  name: string;
  dir: string;
  repoOk: boolean;
  repoProblem?: string;
  branch?: string;
  level2: string;
  /** For reference only (operator, 2026-10-21): the bot changes nothing in it. */
  readOnly: boolean;
  onReadOnly: (value: boolean) => Promise<unknown>;
  isDefault?: boolean;
  busy: boolean;
  /** Every keystroke, for an entry that saves as it is typed (the chat's, debounced). */
  onNameInput?: (value: string) => void;
  /** The finished value, when the field is left and it differs from what is saved. */
  onName: (value: string) => void;
  onDirInput?: (value: string) => void;
  onDir: (value: string) => void;
  onBrowse: () => void;
  onLevel2: (value: string) => Promise<unknown>;
  onRemove?: () => void;
  removeLabel: string;
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
  const [level2Draft, setLevel2Draft] = useState(level2);
  const typingLevel2 = useRef(false);
  // The box shows the choice at once, and goes back only if it could not be saved.
  const [readOnlyShown, setReadOnlyShown] = useState(readOnly);
  useEffect(() => setReadOnlyShown(readOnly), [readOnly]);
  useEffect(() => setNameDraft(name), [name]);
  useEffect(() => setDirDraft(dir), [dir]);
  // The saved text replaces the field only when nobody is typing in it.
  useEffect(() => {
    if (!typingLevel2.current) setLevel2Draft(level2);
  }, [level2]);
  const level2Later = useDebouncedSave(async (v: string) => {
    typingLevel2.current = false;
    if (v !== level2) await onLevel2(v);
  }, 1200);
  return (
    <div className="panel inner project-entry">
      <div className="row project-tags">
        {isDefault && (
          <span className="chip" title={t('proj.isDefaultWhy')}>
            {t('proj.isDefault')}
          </span>
        )}
        {readOnlyShown && (
          <span className="badge reference" title={t('proj.readOnlyInfo')}>
            {t('proj.readOnlyBadge')}
          </span>
        )}
        {dir && (
          <span className={`badge ${repoOk ? 'done' : ''}`} title={repoOk ? t('proj.isRepo') : repoProblem}>
            {repoOk ? t('proj.otherRepo') : t('proj.otherNotRepo')}
          </span>
        )}
        {/* The branch checked out there now (operator, 2026-10-20: "show which branch is chosen"). */}
        {dir && repoOk && branch && (
          <span className="branch-tag">
            <span className="badge branch">
              <BranchIcon /> {branch === 'HEAD' ? t('proj.detached') : t('proj.branch', { name: branch })}
            </span>
            <InfoTip label={t('info.about', { name: t('proj.branch', { name: branch }) })} text={t('proj.branchInfo')} />
          </span>
        )}
      </div>
      {dir && !repoOk && <p className="muted small">{repoProblem || t('proj.notRepoWhy')}</p>}

      {/* For reference only (operator, 2026-10-21): read, never changed — whatever a command changes there is put back. */}
      <div className="field-label check-label project-readonly">
        <input
          id={`${id}-readonly`}
          type="checkbox"
          checked={readOnlyShown}
          onChange={(e) => {
            const v = e.target.checked;
            setReadOnlyShown(v);
            void onReadOnly(v).then((ok) => {
              if (ok === false) setReadOnlyShown(!v);
            });
          }}
        />
        <label htmlFor={`${id}-readonly`}>{t('proj.readOnly')}</label>
        <InfoTip label={t('info.about', { name: t('proj.readOnly') })} text={t('proj.readOnlyInfo')} />
      </div>

      <div className="project-fields">
        <div>
          <FieldName htmlFor={`${id}-name`} label={t('proj.entryName')} info={t('proj.nameInfo')} />
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
            placeholder={dir ? (dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : t('proj.namePlaceholder')}
          />
        </div>
        <div>
          <FieldName htmlFor={`${id}-dir`} label={t('proj.entryDir')} info={t('proj.dirInfo')} />
          <div className="input-with-buttons">
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
            <button onClick={onBrowse} disabled={busy}>
              {t('mirror.browse')}
            </button>
            {onRemove && (
              <button className="quiet" onClick={onRemove} disabled={busy}>
                {removeLabel}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Level 2 (operator, 2026-10-20): what is written here goes into Kerrigan, saved or copied. */}
      <div className="project-level2">
        <FieldName htmlFor={`${id}-level2`} label={t('proj.level2')} info={t('proj.level2Info', { n: MAX_LEVEL2.toLocaleString() })} />
        <textarea
          id={`${id}-level2`}
          className="prose"
          rows={4}
          maxLength={MAX_LEVEL2}
          value={level2Draft}
          onChange={(e) => {
            typingLevel2.current = true;
            setLevel2Draft(e.target.value);
            level2Later(e.target.value);
          }}
          placeholder={t('proj.level2Placeholder')}
        />
        <span className="muted small">{t('proj.level2Count', { n: level2Draft.length.toLocaleString(), max: MAX_LEVEL2.toLocaleString() })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Signing in, and the models: one for the work, one for the second opinion
// ---------------------------------------------------------------------------------------

/**
 * "Sign in to Copilot": what `cop login` does in a terminal, from here.
 *
 * The bot works in an Edge profile of its own, and it has to be signed in to Microsoft 365 once
 * before anything can run or the models can be read. The button opens that window and waits; the
 * person signs in there themselves — the bot never types a password — and the window closes when
 * the chat appears. An account, when given, is asked for by name after signing the profile out,
 * because Edge on a work machine otherwise picks whichever account Windows knows.
 */
function LoginSection() {
  const { t } = useT();
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const signIn = async () => {
    setBusy(true);
    setErr('');
    setMsg(t('login.waiting'));
    try {
      const r = await api.login(account);
      if (r.ok) setMsg(r.message);
      else {
        setMsg('');
        setErr(r.message);
      }
    } catch (e) {
      setMsg('');
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" id="login" aria-labelledby="login-title">
      <h2 id="login-title">{t('login.title')}</h2>
      <p className="muted small">{t('login.intro')}</p>
      {err && <div className="err">{err}</div>}
      <Field id="login-account" label={t('login.account')} info={t('login.accountWhy')}>
        <input id="login-account" type="email" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="name@company.com" disabled={busy} />
        <button className="primary" onClick={() => void signIn()} disabled={busy}>
          {busy ? t('login.busy') : t('login.button')}
        </button>
      </Field>
      {msg && (
        <div className="small" role="status">
          {msg}
        </div>
      )}
    </section>
  );
}

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
    <section className="panel" id="model" aria-labelledby="model-title">
      <h2 id="model-title">{t('def.modelTitle')}</h2>
      <p className="muted small">{t('def.modelIntro')}</p>
      {err && <div className="err">{err}</div>}

      <Field id="default-model" label={t('def.modelField')} info={t('def.modelInfo')}>
        <ModelPicker id="default-model" chosen={chosen} onChange={(name) => void save(name)} none={t('def.modelNone')} catalogue={catalogue} disabled={busy || refreshing} />
        <button className="quiet" onClick={() => void save('')} disabled={busy || !chosen}>
          {t('proj.clear')}
        </button>
        <button onClick={() => void refreshModels()} disabled={busy || refreshing}>
          {t('model.refresh')}
        </button>
      </Field>
      <p className="muted small field-after">
        {catalogue?.readAt ? t('model.readAt', { t: fmtTime(catalogue.readAt), n: catalogue.options.length }) : t('model.neverRead')}
      </p>
      <ManualModelToggle />
      <SavedNote msg={msg || refreshMsg} />
    </section>
  );
}

/**
 * Choose the model by hand (operator's workaround, 2026-10-06): the bot leaves the picker alone and asks, on
 * a card, for the model to be chosen in the Copilot window. Saved into `copilot.manualModel` at once.
 */
function ManualModelToggle() {
  const { t } = useT();
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .settings()
      .then((s) => {
        // Not in the file: the default, which is on since 2026-10-17.
        const saved = (s.raw.copilot as Record<string, unknown> | undefined)?.manualModel;
        const byDefault = (s.defaults as { copilot?: { manualModel?: boolean } } | undefined)?.copilot?.manualModel;
        setOn(typeof saved === 'boolean' ? saved : byDefault !== false);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const save = async (value: boolean) => {
    setOn(value);
    try {
      const s = await api.settings();
      await api.saveSettings({ ...s.raw, copilot: { ...((s.raw.copilot as Record<string, unknown>) ?? {}), manualModel: value } });
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="settings-field">
      <div className="field-label check-label">
        <input id="manual-model" type="checkbox" checked={on === true} disabled={on === null} onChange={(e) => void save(e.target.checked)} />
        <label htmlFor="manual-model">{t('def.manualModel')}</label>
        <InfoTip label={t('info.about', { name: t('def.manualModel') })} text={t('def.manualModelWhy')} />
      </div>
      {err && <div className="err">{err}</div>}
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
    <section className="panel" id="review" aria-labelledby="review-title">
      <h2 id="review-title">{t('def.reviewTitle')}</h2>
      <p className="muted small">{t('def.reviewIntro')}</p>
      {err && <div className="err">{err}</div>}

      <Field id="default-review-model" label={t('def.reviewField')} info={t('def.reviewInfo')}>
        <ModelPicker id="default-review-model" chosen={chosen} onChange={(name) => void save(name)} none={t('def.reviewNone')} catalogue={catalogue} disabled={busy || refreshing} />
        <button className="quiet" onClick={() => void save('')} disabled={busy || !chosen}>
          {t('proj.clear')}
        </button>
        {/* The same list, read from the same place: a model chosen here is chosen from what
            the chat actually offers, and reading it in one section updates the other. */}
        <button onClick={() => void refreshModels()} disabled={busy || refreshing}>
          {t('model.refresh')}
        </button>
      </Field>
      {sameAsWork && <p className="why field-after warned-text">{t('def.reviewSame')}</p>}
      <SavedNote msg={msg || refreshMsg} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// How a task runs
// ---------------------------------------------------------------------------------------

/**
 * How a task runs: how long it may go on, what happens at a limit, and what may run without anybody.
 *
 * The retry count is a decision the operator meets after every blocked task. The two ceilings —
 * iterations and minutes per task — are what a long task runs into; a task cut off by them can be
 * continued in its own chat ("Continue"). Plan first is not here any more (2026-10-20): the chat
 * chooses it per conversation, under its box, and no other run is left to follow the setting.
 */
function ExecutionSection() {
  const { t } = useT();
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  // The settings as the last write left them, read synchronously by the next one. See `write`.
  const rawRef = useRef<Record<string, unknown> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [retries, setRetries] = useState(2);
  /** Times a task a limit stopped is carried on by itself (`limits.autoContinue`). */
  const [autoContinue, setAutoContinue] = useState(3);
  const [approaches, setApproaches] = useState(2);
  const [reviewRounds, setReviewRounds] = useState(2);
  const [iterations, setIterations] = useState(60);
  const [minutes, setMinutes] = useState(240);
  /** The most subtasks the lead of a two-chat conversation may give for one message (`limits.maxSubtasks`). */
  const [subtasks, setSubtasks] = useState(20);
  const [replySec, setReplySec] = useState(900);
  /** The most characters of one message sent as text (`limits.maxMessageChars`, 2026-10-22); longer, the rest goes attached. */
  const [messageChars, setMessageChars] = useState(120_000);
  /** The pause between messages (`pacing.gap*`, 2026-10-21): on or off, its shortest time, and a random one up to the longest. */
  const [gapOn, setGapOn] = useState(false);
  const [gapSec, setGapSec] = useState(60);
  const [gapRandom, setGapRandom] = useState(false);
  const [gapMax, setGapMax] = useState(90);
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
          minApproachesBeforeBlocked?: number;
          maxReviewRounds?: number;
          maxIterations?: number;
          maxRunMinutes?: number;
          autoContinue?: number;
          maxSubtasks?: number;
          maxMessageChars?: number;
        };
        setAutoContinue(typeof limits.autoContinue === 'number' ? limits.autoContinue : 3);
        setRetries(typeof limits.retryBlockedInFreshChat === 'number' ? limits.retryBlockedInFreshChat : 2);
        setApproaches(typeof limits.minApproachesBeforeBlocked === 'number' ? limits.minApproachesBeforeBlocked : 2);
        setReviewRounds(typeof limits.maxReviewRounds === 'number' ? limits.maxReviewRounds : 2);
        setIterations(typeof limits.maxIterations === 'number' ? limits.maxIterations : 60);
        setMinutes(typeof limits.maxRunMinutes === 'number' ? limits.maxRunMinutes : 240);
        setSubtasks(typeof limits.maxSubtasks === 'number' ? limits.maxSubtasks : 20);
        setMessageChars(typeof limits.maxMessageChars === 'number' ? limits.maxMessageChars : 120_000);
        const pacing = ((s.raw.pacing as Record<string, unknown>) ?? {}) as { gapEnabled?: boolean; gapSec?: number; gapRandom?: boolean; gapMaxSec?: number };
        setGapOn(pacing.gapEnabled === true);
        setGapSec(typeof pacing.gapSec === 'number' ? pacing.gapSec : 60);
        setGapRandom(pacing.gapRandom === true);
        setGapMax(typeof pacing.gapMaxSec === 'number' ? pacing.gapMaxSec : 90);
        const copilot = ((s.raw.copilot as Record<string, unknown>) ?? {}) as { replyTimeoutSec?: number };
        setReplySec(typeof copilot.replyTimeoutSec === 'number' ? copilot.replyTimeoutSec : 900);
        const exec = ((s.raw.execution as Record<string, unknown>) ?? {}) as { isolation?: Isolation; mode?: StartMode; networkFetch?: NetworkFetch };
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
   * the other, and the second would put back what the first had changed. Each write waits for the one
   * before and is built on the object that one produced, so nothing has to be disabled.
   */
  const write = (branch: 'limits' | 'execution' | 'copilot' | 'pacing', key: string, value: unknown): Promise<void> => {
    const run = async () => {
      if (!rawRef.current) return;
      /*
       * The file as it is now, not as this section first read it. The other sections of this page
       * save through their own calls — the models, the projects — and a write built on the copy read
       * when the page opened put back whatever they had changed since.
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
  const saveAutoContinueLater = useDebouncedSave((n: number) => write('limits', 'autoContinue', n));
  const saveApproachesLater = useDebouncedSave((n: number) => write('limits', 'minApproachesBeforeBlocked', n));
  const saveReviewRoundsLater = useDebouncedSave((n: number) => write('limits', 'maxReviewRounds', n));
  const saveIterationsLater = useDebouncedSave((n: number) => write('limits', 'maxIterations', n));
  const saveMinutesLater = useDebouncedSave((n: number) => write('limits', 'maxRunMinutes', n));
  const saveSubtasksLater = useDebouncedSave((n: number) => write('limits', 'maxSubtasks', n));
  const saveReplyLater = useDebouncedSave((n: number) => write('copilot', 'replyTimeoutSec', n));
  const saveMessageCharsLater = useDebouncedSave((n: number) => write('limits', 'maxMessageChars', n));
  const saveGapSecLater = useDebouncedSave((n: number) => write('pacing', 'gapSec', n));
  const saveGapMaxLater = useDebouncedSave((n: number) => write('pacing', 'gapMaxSec', n));
  const saveExecution = (key: 'isolation' | 'mode' | 'networkFetch', value: string) => write('execution', key, value);

  /** The number fields, in the order a task meets them. */
  const numbers: Array<{ id: string; label: string; info: string; unit: string; value: number; min: number; max: number; set: (n: number) => void; later: (n: number) => void }> = [
    // Keep going until done (2026-10-14): first, as it decides whether a limit ends the work at all.
    { id: 'auto-continue', label: t('exec.autoContinue'), info: t('exec.autoContinueWhy'), unit: t('exec.autoContinueUnit'), value: autoContinue, min: 0, max: 20, set: setAutoContinue, later: saveAutoContinueLater },
    { id: 'min-approaches', label: t('exec.minApproaches'), info: t('exec.minApproachesWhy'), unit: t('exec.minApproachesUnit'), value: approaches, min: 2, max: 20, set: setApproaches, later: saveApproachesLater },
    { id: 'max-review-rounds', label: t('exec.maxReviewRounds'), info: t('exec.maxReviewRoundsWhy'), unit: t('exec.maxReviewRoundsUnit'), value: reviewRounds, min: 1, max: 6, set: setReviewRounds, later: saveReviewRoundsLater },
    { id: 'retry-blocked', label: t('exec.retryBlocked'), info: t('exec.retryBlockedWhy'), unit: t('exec.retryBlockedTimes'), value: retries, min: 0, max: 5, set: setRetries, later: saveRetriesLater },
    { id: 'max-iterations', label: t('exec.maxIterations'), info: t('exec.maxIterationsWhy'), unit: t('exec.maxIterationsUnit'), value: iterations, min: 5, max: 200, set: setIterations, later: saveIterationsLater },
    { id: 'max-minutes', label: t('exec.maxRunMinutes'), info: t('exec.maxRunMinutesWhy'), unit: t('exec.maxRunMinutesUnit'), value: minutes, min: 10, max: 1440, set: setMinutes, later: saveMinutesLater },
    // Two chats (2026-10-20): the lead's subtasks for one message, each a task of the worker's with the limits above.
    { id: 'max-subtasks', label: t('exec.maxSubtasks'), info: t('exec.maxSubtasksWhy'), unit: t('exec.maxSubtasksUnit'), value: subtasks, min: 1, max: 100, set: setSubtasks, later: saveSubtasksLater },
    { id: 'reply-timeout', label: t('exec.replyTimeout'), info: t('exec.replyTimeoutWhy'), unit: t('exec.replyTimeoutUnit'), value: replySec, min: 60, max: 10800, set: setReplySec, later: saveReplyLater },
    // How long one message to the chat may be as text (operator, 2026-10-22); the rest of a longer one goes attached.
    { id: 'max-message-chars', label: t('exec.maxMessageChars'), info: t('exec.maxMessageCharsWhy'), unit: t('exec.maxMessageCharsUnit'), value: messageChars, min: 1000, max: 1_000_000, set: setMessageChars, later: saveMessageCharsLater },
  ];

  return (
    <section className="panel" id="execution" aria-labelledby="execution-title">
      <h2 id="execution-title">{t('exec.title')}</h2>
      <p className="muted small">{t('exec.intro')}</p>
      {err && <div className="err">{err}</div>}
      {numbers.map((f) => (
        <Field key={f.id} id={f.id} label={f.label} info={f.info} unit={f.unit}>
          <BoundedNumber
            id={f.id}
            value={f.value}
            min={f.min}
            max={f.max}
            onChange={(n) => {
              f.set(n);
              f.later(n);
            }}
            disabled={!raw}
          />
        </Field>
      ))}

      {/*
        A pause between messages (operator, 2026-10-21: "how often a message may be sent; and a random time, between 60
        and 90 seconds, say — as a box that appears when the first box is ticked"). The time shows when the box is
        ticked, and with it a second box for a random time, and under that the longest.
      */}
      <div className="settings-field">
        <div className="field-label check-label">
          <input
            id="gap-on"
            type="checkbox"
            checked={gapOn}
            disabled={!raw}
            onChange={(e) => {
              setGapOn(e.target.checked);
              void write('pacing', 'gapEnabled', e.target.checked);
            }}
          />
          <label htmlFor="gap-on">{t('exec.gap')}</label>
          <InfoTip label={t('info.about', { name: t('exec.gap') })} text={t('exec.gapWhy')} />
        </div>
      </div>
      {gapOn && (
        <Field id="gap-sec" label={t('exec.gapSec')} info={t('exec.gapSecWhy')} unit={t('exec.gapUnit')}>
          <BoundedNumber
            id="gap-sec"
            value={gapSec}
            min={1}
            max={3600}
            onChange={(n) => {
              setGapSec(n);
              saveGapSecLater(n);
            }}
            disabled={!raw}
          />
        </Field>
      )}
      {gapOn && (
        <div className="settings-field gap-random">
          <div className="field-label check-label">
            <input
              id="gap-random"
              type="checkbox"
              checked={gapRandom}
              disabled={!raw}
              onChange={(e) => {
                setGapRandom(e.target.checked);
                void write('pacing', 'gapRandom', e.target.checked);
                // The longest is never less than the shortest.
                if (e.target.checked && gapMax < gapSec) {
                  setGapMax(gapSec);
                  saveGapMaxLater(gapSec);
                }
              }}
            />
            <label htmlFor="gap-random">{t('exec.gapRandom')}</label>
            <InfoTip label={t('info.about', { name: t('exec.gapRandom') })} text={t('exec.gapRandomWhy')} />
          </div>
        </div>
      )}
      {gapOn && gapRandom && (
        <Field id="gap-max" label={t('exec.gapMax')} info={t('exec.gapMaxWhy')} unit={t('exec.gapUnit')}>
          <BoundedNumber
            id="gap-max"
            value={gapMax}
            min={gapSec}
            max={3600}
            onChange={(n) => {
              setGapMax(n);
              saveGapMaxLater(n);
            }}
            disabled={!raw}
          />
        </Field>
      )}

      <Field id="isolation" label={t('exec.isolation')} info={t('exec.isolationWhy')}>
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
      </Field>

      {/*
        The two choices that make a run go without anybody. Placed after the isolation claim
        because that claim is what allows an unattended run on this machine at all; these two only
        decide how much such a run still asks.
      */}
      <Field id="start-mode" label={t('exec.startMode')} info={t('exec.startModeWhy')}>
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
      </Field>

      <Field id="network-fetch" label={t('exec.networkFetch')} info={t('exec.networkFetchWhy')}>
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
      </Field>
      <SavedNote msg={msg} />
    </section>
  );
}
