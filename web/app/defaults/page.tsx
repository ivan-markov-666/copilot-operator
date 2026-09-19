'use client';

/**
 * What every new session starts with: which folder, and which model.
 *
 * Its own page rather than a row on the system page, because the system page answers "is this
 * machine set up", which is read once, and this answers "what am I working on", which changes
 * whenever the work does. Every folder field and every model picker in the app links here, so
 * this is also where somebody arrives the first time they wonder where a default comes from.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ModelCatalogue, type ProjectDefault } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';

export default function DefaultsPage() {
  const { t } = useT();

  return (
    <>
      <div className="panel">
        <h2>{t('def.title')}</h2>
        <p className="muted small">{t('def.intro')}</p>
      </div>
      <ProjectSection />
      <ModelSection />
    </>
  );
}

// ---------------------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------------------

function ProjectSection() {
  const { t } = useT();
  const [project, setProject] = useState<ProjectDefault | null>(null);
  const [dir, setDir] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await api.project();
      setProject(p);
      setDir(p.rootDir);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (value: string) => {
    setBusy(true);
    setMsg('');
    try {
      const p = await api.setProject(value);
      setProject(p);
      setDir(p.rootDir);
      setMsg(p.rootDir ? t('proj.saved', { dir: p.rootDir }) : t('proj.cleared'));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setBusy(true);
    try {
      const picked = await api.browseFolder(dir.trim() || undefined);
      if (picked.ok) await save(picked.path);
      else if (!picked.cancelled) setErr(picked.reason ?? '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" id="project">
      <h2>{t('proj.title')}</h2>
      <p className="muted small">{t('proj.intro')}</p>
      {err && <div className="err">{err}</div>}

      <label htmlFor="proj-dir">{t('proj.field')}</label>
      <div className="row">
        <input
          id="proj-dir"
          type="text"
          className="grow"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder="C:\Projects\my-app"
          disabled={busy}
        />
        <button onClick={() => void browse()} disabled={busy}>
          {t('mirror.browse')}
        </button>
        <button className="primary" onClick={() => void save(dir)} disabled={busy || dir.trim() === (project?.rootDir ?? '')}>
          {t('proj.save')}
        </button>
        <button className="quiet" onClick={() => void save('')} disabled={busy || !project?.rootDir}>
          {t('proj.clear')}
        </button>
      </div>
      {msg && (
        <div className="muted small" role="status" style={{ marginTop: 6 }}>
          {msg}
        </div>
      )}

      {project && !project.rootDir && <p className="muted small" style={{ marginTop: 8 }}>{t('proj.none')}</p>}

      {project?.rootDir && project.repoOk && (
        <div className="notice calm" style={{ marginTop: 10 }}>
          <strong>{t('proj.isRepo')}</strong>
        </div>
      )}
      {project?.rootDir && !project.repoOk && (
        <div className="notice caution" style={{ marginTop: 10 }}>
          <strong>{t('proj.notRepo')}</strong>
          <div className="small" style={{ marginTop: 4 }}>{project.repoProblem}</div>
          <div className="muted small" style={{ marginTop: 6 }}>{t('proj.notRepoWhy')}</div>
        </div>
      )}

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

// ---------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------

function ModelSection() {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [chosen, setChosen] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .models()
      .then((c) => {
        setCatalogue(c);
        setChosen(c.defaultModel);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const save = async (name: string) => {
    setBusy(true);
    setMsg('');
    try {
      const saved = await api.setDefaultModel(name);
      setCatalogue((c) => (c ? { ...c, defaultModel: saved.defaultModel } : c));
      setChosen(saved.defaultModel);
      setMsg(saved.defaultModel ? t('def.modelSaved', { name: saved.defaultModel }) : t('def.modelCleared'));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!window.confirm(t('model.refreshConfirm'))) return;
    setBusy(true);
    setMsg(t('model.refreshing'));
    try {
      const fresh = await api.refreshModels();
      setCatalogue(fresh);
      setMsg(fresh.options.length === 0 ? (fresh.note ?? t('model.none')) : t('model.refreshed', { n: fresh.options.length }));
    } catch (e) {
      setErr((e as Error).message);
      setMsg('');
    } finally {
      setBusy(false);
    }
  };

  const all = catalogue?.options ?? [];
  const known = all.some((o) => o.name === chosen);
  const ungrouped = all.filter((o) => !o.group);
  const grouped = new Map<string, typeof all>();
  for (const o of all) {
    if (!o.group) continue;
    grouped.set(o.group, [...(grouped.get(o.group) ?? []), o]);
  }

  return (
    <div className="panel" id="model">
      <h2>{t('def.modelTitle')}</h2>
      <p className="muted small">{t('def.modelIntro')}</p>
      {err && <div className="err">{err}</div>}

      <label htmlFor="default-model">{t('def.modelField')}</label>
      <div className="row">
        <select
          id="default-model"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          disabled={busy}
          style={{ width: 'auto', minWidth: 280 }}
        >
          <option value="">{t('def.modelNone')}</option>
          {chosen && !known && <option value={chosen}>{t('model.notInList', { name: chosen })}</option>}
          {ungrouped.map((o) => (
            <option key={o.name} value={o.name} disabled={o.disabled}>
              {o.name}
              {o.disabled ? ` — ${t('model.unavailable')}` : ''}
            </option>
          ))}
          {[...grouped.entries()].map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((o) => (
                <option key={o.name} value={o.name} disabled={o.disabled}>
                  {o.name}
                  {o.disabled ? ` — ${t('model.unavailable')}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="primary" onClick={() => void save(chosen)} disabled={busy || chosen === (catalogue?.defaultModel ?? '')}>
          {t('proj.save')}
        </button>
        <button className="quiet" onClick={() => void save('')} disabled={busy || !catalogue?.defaultModel}>
          {t('proj.clear')}
        </button>
        <button onClick={() => void refresh()} disabled={busy}>
          {t('model.refresh')}
        </button>
      </div>
      {msg && (
        <div className="muted small" role="status" style={{ marginTop: 6 }}>
          {msg}
        </div>
      )}

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
