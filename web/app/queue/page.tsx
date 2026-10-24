'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ModelCatalogue, type Queue, type QueueItem, type Workspace } from '../../lib/api';
import { useT, type Key } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { ModelPicker } from '../modelPicker';
import { InfoTip } from '../popover';
import { confirmDialog } from '../dialog';

/**
 * The queue of tasks (operator, 2026-10-24: "an option to prepare several tasks that run in a queue"): written
 * beforehand, each with its own model, where it works (the folder as it is, or a new branch from main), whether it is
 * reviewed, and the earlier tasks it depends on; run one after another while nobody watches, each in a new chat. A task
 * whose dependency failed is skipped and the queue goes on with the next (`src/queue/queue.ts`).
 */
type Draft = { prompt: string; model: string; dependsOn: string[]; branch: QueueItem['branch']; review: boolean };
type Edit = Omit<QueueItem, 'status'> & { status?: QueueItem['status'] };

const EMPTY: Draft = { prompt: '', model: '', dependsOn: [], branch: 'folder', review: true };
/** Where the chat keeps the conversation it shows (`workbench/cascade.tsx`): "Open the chat" puts the task's there. */
const THREAD_KEY = 'cop.chat.thread';

const STATUS: Record<QueueItem['status'], Key> = {
  waiting: 'q.waiting',
  running: 'q.running',
  done: 'q.done',
  failed: 'q.failed',
  skipped: 'q.skipped',
  stopped: 'q.stopped',
};

const titleOf = (prompt: string): string => prompt.split(/\r?\n/)[0]!.trim().slice(0, 80) || '…';
const asEdit = (x: QueueItem): Edit => ({ id: x.id, prompt: x.prompt, model: x.model, dependsOn: x.dependsOn, branch: x.branch, review: x.review });
function newItemId(items: QueueItem[]): string {
  let n = items.length + 1;
  while (items.some((x) => x.id === `q${n}`)) n += 1;
  return `q${n}`;
}

export default function QueuePage() {
  const { t } = useT();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [byHand, setByHand] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /** The task being edited, or null while a new one is written. */
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const read = useCallback(() => api.queue().then(setQueue).catch((e) => setErr((e as Error).message)), []);
  usePoll(read, queue?.running ? 2000 : 6000);
  useEffect(() => {
    api.models().then(setCatalogue).catch(() => undefined);
    api.workspace().then(setWs).catch(() => undefined);
    // Chosen by hand in Settings, every task of the queue would wait for the operator: said here.
    api
      .settings()
      .then((s) => {
        const copilot = (s.raw.copilot as { manualModel?: boolean } | undefined) ?? {};
        const byDefault = (s.defaults as { copilot?: { manualModel?: boolean } } | undefined)?.copilot?.manualModel !== false;
        setByHand(typeof copilot.manualModel === 'boolean' ? copilot.manualModel : byDefault);
      })
      .catch(() => undefined);
  }, []);

  const items = queue?.items ?? [];
  const numberOf = (id: string): number => items.findIndex((x) => x.id === id) + 1;

  const save = async (next: Edit[]): Promise<boolean> => {
    setBusy(true);
    setErr('');
    try {
      setQueue(await api.setQueue(next));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    const edits = items.map(asEdit);
    const at = editing ? edits.findIndex((x) => x.id === editing) : -1;
    if (at >= 0) edits[at] = { ...edits[at]!, ...draft };
    else edits.push({ id: newItemId(items), ...draft });
    if (await save(edits)) {
      setDraft(EMPTY);
      setEditing(null);
    }
  };
  const edit = (x: QueueItem) => {
    setEditing(x.id);
    setDraft({ prompt: x.prompt, model: x.model, dependsOn: x.dependsOn, branch: x.branch, review: x.review });
    document.getElementById('queue-prompt')?.focus();
  };
  const move = (id: string, by: -1 | 1) => {
    const edits = items.map(asEdit);
    const i = edits.findIndex((x) => x.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= edits.length) return;
    [edits[i], edits[j]] = [edits[j]!, edits[i]!];
    void save(edits);
  };
  const remove = async (x: QueueItem) => {
    if (!(await confirmDialog(t('q.removeConfirm', { title: titleOf(x.prompt) })))) return;
    // The tasks that depended on it no longer do: it is not there to wait for.
    void save(items.filter((o) => o.id !== x.id).map((o) => ({ ...asEdit(o), dependsOn: o.dependsOn.filter((d) => d !== x.id) })));
  };
  const again = (id: string) => void save(items.map((o) => (o.id === id ? { ...asEdit(o), status: 'waiting' as const } : asEdit(o))));
  const act = async (call: () => Promise<Queue>) => {
    setBusy(true);
    setErr('');
    try {
      setQueue(await call());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remember = (sessionId: string) => {
    try {
      window.localStorage.setItem(THREAD_KEY, sessionId);
    } catch {
      /* the chat opens on its last one */
    }
  };

  const running = items.findIndex((x) => x.status === 'running');
  const waiting = items.filter((x) => x.status === 'waiting').length;
  const summary = queue?.running && running >= 0
    ? t('q.runningNow', { n: running + 1, of: items.length })
    : t('q.counts', { waiting, done: items.filter((x) => x.status === 'done').length, failed: items.filter((x) => ['failed', 'skipped', 'stopped'].includes(x.status)).length });
  // What a task may depend on: the tasks before it (all of them, for a new one).
  const earlier = editing ? items.slice(0, Math.max(0, numberOf(editing) - 1)) : items;

  return (
    <div className="queue-page">
      {err && (
        <div className="panel err" role="alert">
          {err}
        </div>
      )}
      <section className="panel" id="queue" aria-labelledby="queue-title">
        <h2 id="queue-title">{t('q.title')}</h2>
        <p className="muted small">{t('q.intro')}</p>
        {ws && <p className="small queue-folder">{ws.ok ? t('q.folder', { dir: ws.dir }) : t('q.noFolder')}</p>}
        {byHand && (
          <p className="why warned-text queue-by-hand">
            {t('q.byHand')} <Link href="/settings#model">{t('q.byHandLink')}</Link>
          </p>
        )}
        {/* A task on Settings' model with none there would wait for a choice by hand: the queue does not start (`queueWithoutModel`). */}
        {catalogue && !catalogue.defaultModel && items.some((x) => x.status === 'waiting' && !x.model) && (
          <p className="why warned-text queue-no-model">
            {t('q.noModel')} <Link href="/settings#model">{t('q.byHandLink')}</Link>
          </p>
        )}
        <div className="row queue-controls">
          {queue?.running ? (
            <button onClick={() => void act(api.stopQueue)} disabled={busy}>
              {t('q.stop')}
            </button>
          ) : (
            <button className="primary" onClick={() => void act(api.runQueue)} disabled={busy || waiting === 0 || !queue}>
              {t('q.run')}
            </button>
          )}
          {queue && (
            <span className="muted small" role="status">
              {summary}
            </span>
          )}
        </div>
        {!queue ? (
          <p className="muted small">{t('q.loading')}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t('q.empty')}</p>
        ) : (
          <ol className="queue-list">
            {items.map((x, i) => (
              <li key={x.id} className={`queue-item is-${x.status}${editing === x.id ? ' is-editing' : ''}`} data-id={x.id}>
                <div className="queue-head">
                  <span className="queue-n">{i + 1}</span>
                  <span className={`queue-status s-${x.status}`}>{t(STATUS[x.status])}</span>
                  <span className="queue-title">{titleOf(x.prompt)}</span>
                </div>
                <div className="queue-meta small muted">
                  <span>{x.model || t('q.settingsModel')}</span>
                  <span>{x.branch === 'main' ? t('q.branchMain') : t('q.branchFolder')}</span>
                  {x.review && <span>{t('q.reviewOn')}</span>}
                  {x.dependsOn.length > 0 && <span>{t('q.dependsOnList', { list: x.dependsOn.map((d) => `#${numberOf(d)}`).join(', ') })}</span>}
                </div>
                {x.why && <div className="small queue-why">{x.why}</div>}
                <div className="row queue-actions">
                  {x.sessionId && (
                    <Link href="/" onClick={() => remember(x.sessionId!)}>
                      {t('q.openChat')}
                    </Link>
                  )}
                  {x.status !== 'running' && (
                    <>
                      {x.status === 'waiting' ? (
                        <button className="quiet" onClick={() => edit(x)} disabled={busy}>
                          {t('q.edit')}
                        </button>
                      ) : (
                        <button className="quiet" onClick={() => again(x.id)} disabled={busy}>
                          {t('q.again')}
                        </button>
                      )}
                      <button className="quiet" onClick={() => move(x.id, -1)} disabled={busy || i === 0} aria-label={t('q.up')} title={t('q.up')}>
                        ↑
                      </button>
                      <button className="quiet" onClick={() => move(x.id, 1)} disabled={busy || i === items.length - 1} aria-label={t('q.down')} title={t('q.down')}>
                        ↓
                      </button>
                      <button className="quiet" onClick={() => void remove(x)} disabled={busy}>
                        {t('q.remove')}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel" id="queue-add" aria-labelledby="queue-add-title">
        <h2 id="queue-add-title">{editing ? t('q.editTitle', { n: numberOf(editing) }) : t('q.addTitle')}</h2>
        <label htmlFor="queue-prompt">{t('q.prompt')}</label>
        <textarea id="queue-prompt" rows={5} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        <div className="settings-field">
          <div className="field-label">
            <label htmlFor="queue-model">{t('q.model')}</label>
            <InfoTip label={t('info.about', { name: t('q.model') })} text={t('q.modelWhy')} />
          </div>
          <div className="field-control">
            <ModelPicker id="queue-model" chosen={draft.model} onChange={(name) => setDraft({ ...draft, model: name })} none={t('q.modelSettings', { name: catalogue?.defaultModel || '—' })} catalogue={catalogue} />
          </div>
        </div>
        <div className="settings-field">
          <div className="field-label">
            <label htmlFor="queue-branch">{t('q.branch')}</label>
            <InfoTip label={t('info.about', { name: t('q.branch') })} text={t('q.branchWhy')} />
          </div>
          <div className="field-control">
            <select id="queue-branch" value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value === 'main' ? 'main' : 'folder' })}>
              <option value="folder">{t('q.branchFolder')}</option>
              <option value="main">{t('q.branchMain')}</option>
            </select>
          </div>
        </div>
        <div className="settings-field">
          <div className="field-label check-label">
            <input id="queue-review" type="checkbox" checked={draft.review} onChange={(e) => setDraft({ ...draft, review: e.target.checked })} />
            <label htmlFor="queue-review">{t('q.review')}</label>
            <InfoTip label={t('info.about', { name: t('q.review') })} text={t('q.reviewWhy')} />
          </div>
        </div>
        <fieldset className="queue-depends">
          <legend className="field-label">
            <span className="field-name">{t('q.dependsOn')}</span>
            <InfoTip label={t('info.about', { name: t('q.dependsOn') })} text={t('q.dependsOnWhy')} />
          </legend>
          {earlier.length === 0 ? (
            <p className="muted small">{t('q.noEarlier')}</p>
          ) : (
            earlier.map((o) => (
              <label key={o.id} className="queue-dep">
                <input
                  type="checkbox"
                  checked={draft.dependsOn.includes(o.id)}
                  onChange={(e) => setDraft({ ...draft, dependsOn: e.target.checked ? [...draft.dependsOn, o.id] : draft.dependsOn.filter((d) => d !== o.id) })}
                />
                <span>
                  #{numberOf(o.id)} {titleOf(o.prompt)}
                </span>
              </label>
            ))
          )}
        </fieldset>
        <div className="row">
          <button className="primary" onClick={() => void submit()} disabled={busy || !draft.prompt.trim()}>
            {editing ? t('q.save') : t('q.add')}
          </button>
          {editing && (
            <button
              className="quiet"
              onClick={() => {
                setEditing(null);
                setDraft(EMPTY);
              }}
            >
              {t('q.cancel')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
