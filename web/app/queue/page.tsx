'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ModelCatalogue, type Queue, type QueueBusy, type QueueItem, type Skill, type Workspace } from '../../lib/api';
import { useT, type Key } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useDots } from '../../lib/useDots';
import { ModelPicker } from '../modelPicker';
import { InfoTip } from '../popover';
import { confirmDialog } from '../dialog';
import { QueueGraph } from './queueGraph';

/**
 * The queue of tasks (operator, 2026-10-24: "an option to prepare several tasks that run in a queue"): written
 * beforehand, each with its name, its own model, where it works (the folder as it is, or a new branch from main), one
 * chat or two (a lead and a worker, with the worker's model), whether it is reviewed and on which model, and the earlier
 * tasks it depends on; run one after another while nobody watches, each in a new chat. A task whose dependency failed is
 * skipped and the queue goes on with the next (`src/queue/queue.ts`). The picture above the list shows the order and
 * the threads between the tasks (`queueGraph.tsx`). A task may carry one of Settings' skills; one added while a message of
 * the chat works starts after it (2026-10-25).
 */
type Draft = {
  name: string;
  prompt: string;
  model: string;
  dependsOn: string[];
  branch: QueueItem['branch'];
  review: boolean;
  reviewModel: string;
  lead: boolean;
  workerModel: string;
  skill: string;
};
type Edit = Omit<QueueItem, 'status'> & { status?: QueueItem['status'] };

const EMPTY: Draft = { name: '', prompt: '', model: '', dependsOn: [], branch: 'folder', review: true, reviewModel: '', lead: false, workerModel: '', skill: '' };
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

/** A task's name, or its first line where it has none, as the bot says it (`itemTitle`). */
const titleOf = (x: Pick<QueueItem, 'name' | 'prompt'>): string => x.name?.trim() || x.prompt.split(/\r?\n/)[0]!.trim().slice(0, 80) || '…';
const asEdit = (x: QueueItem): Edit => ({
  id: x.id,
  ...(x.name ? { name: x.name } : {}),
  prompt: x.prompt,
  model: x.model,
  dependsOn: x.dependsOn,
  branch: x.branch,
  review: x.review,
  ...(x.reviewModel ? { reviewModel: x.reviewModel } : {}),
  ...(x.lead ? { lead: true } : {}),
  ...(x.workerModel ? { workerModel: x.workerModel } : {}),
  ...(x.skill ? { skill: x.skill } : {}),
});
const fromDraft = (d: Draft): Omit<Edit, 'id'> => ({
  ...(d.name.trim() ? { name: d.name.trim() } : {}),
  prompt: d.prompt,
  model: d.model,
  dependsOn: d.dependsOn,
  branch: d.branch,
  review: !d.lead && d.review,
  ...(!d.lead && d.review && d.reviewModel ? { reviewModel: d.reviewModel } : {}),
  ...(d.lead ? { lead: true, ...(d.workerModel ? { workerModel: d.workerModel } : {}) } : {}),
  ...(d.skill ? { skill: d.skill } : {}),
});
/** The skills a task of the open folder may carry: the ones for every project and the ones for it, as the chat offers them. */
const folderKey = (d: string): string => d.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
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
  const [skills, setSkills] = useState<Skill[]>([]);
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
    api.skills().then((r) => setSkills(r.skills)).catch(() => undefined);
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
  /*
   * Added while something else works — a message sent from the chat, say (operator, 2026-10-25: "I think of another
   * task for after it, go to Queue and add it; it starts after the one running") — the queue is started with it, and
   * its first task waits for that work to end. Otherwise "Run the queue" starts it, as before.
   */
  const startsAfter = !!queue?.busy && !queue.running && !editing;
  const submit = async () => {
    const edits = items.map(asEdit);
    const at = editing ? edits.findIndex((x) => x.id === editing) : -1;
    if (at >= 0) edits[at] = { id: edits[at]!.id, ...fromDraft(draft) };
    else edits.push({ id: newItemId(items), ...fromDraft(draft) });
    const after = startsAfter;
    if (await save(edits)) {
      setDraft(EMPTY);
      setEditing(null);
      if (after) await act(api.runQueue);
    }
  };
  const edit = (x: QueueItem) => {
    setEditing(x.id);
    setDraft({
      name: x.name ?? '',
      prompt: x.prompt,
      model: x.model,
      dependsOn: x.dependsOn,
      branch: x.branch,
      review: x.review,
      reviewModel: x.reviewModel ?? '',
      lead: !!x.lead,
      workerModel: x.workerModel ?? '',
      skill: x.skill ?? '',
    });
    document.getElementById('queue-name')?.focus();
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
    if (!(await confirmDialog(t('q.removeConfirm', { title: titleOf(x) })))) return;
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

  const skillsHere = skills.filter((k) => !k.projectDir || (ws?.ok && folderKey(k.projectDir) === folderKey(ws.dir)));
  // A skill a task was given that this folder no longer offers is still shown, so an edit does not drop it unseen.
  const skillChoices = draft.skill && !skillsHere.some((k) => k.name === draft.skill) ? [...skillsHere, { name: draft.skill, description: '', text: '', projectDir: '' }] : skillsHere;
  const running = items.findIndex((x) => x.status === 'running');
  /*
   * Stopped while a task of it works: "Stop the queue" is off and says it is stopping, its dots going round, until that
   * task has stopped (2026-10-26, as the chat's "Stop").
   */
  const stopping = !!queue && !queue.running && running >= 0;
  const stopDots = useDots(stopping);
  const waiting = items.filter((x) => x.status === 'waiting').length;
  const summary =
    queue?.running && running >= 0
      ? t('q.runningNow', { n: running + 1, of: items.length })
      : t('q.counts', { waiting, done: items.filter((x) => x.status === 'done').length, failed: items.filter((x) => ['failed', 'skipped', 'stopped'].includes(x.status)).length });
  // What a task may depend on: the tasks before it (all of them, for a new one).
  const earlier = editing ? items.slice(0, Math.max(0, numberOf(editing) - 1)) : items;
  /*
   * A task that would wait for a model to be chosen by hand, as the bot judges it (`waitsByHand`): none of its own and
   * none in Settings for its chat, or for its review. The queue does not start then.
   */
  const unnamed =
    !!catalogue &&
    items.some(
      (x) =>
        x.status === 'waiting' &&
        ((!x.model && !(x.lead ? catalogue.defaultLeadModel || catalogue.defaultModel : catalogue.defaultModel)) || (!x.lead && x.review && !x.reviewModel && !catalogue.defaultReviewModel)),
    );

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
        {unnamed && (
          <p className="why warned-text queue-no-model">
            {t('q.noModel')} <Link href="/settings#model">{t('q.byHandLink')}</Link>
          </p>
        )}
        {queue?.busy && <BusyLine busy={queue.busy} running={queue.running} />}
        <div className="row queue-controls">
          {queue?.running || stopping ? (
            <button onClick={() => void act(api.stopQueue)} disabled={busy || stopping} aria-busy={stopping || undefined}>
              {stopping ? (
                <>
                  {t('q.stopping')}
                  <span className="saving-dots">{stopDots}</span>
                </>
              ) : (
                t('q.stop')
              )}
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
        <QueueGraph items={items} titleOf={titleOf} />
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
                  <span className="queue-title">{titleOf(x)}</span>
                </div>
                <div className="queue-meta small muted">
                  {x.lead ? (
                    <>
                      <span>{t('q.leadOn')}</span>
                      <span>{t('q.leadIs', { model: x.model || t('q.settingsModel') })}</span>
                      <span>{t('q.workerIs', { model: x.workerModel || t('q.settingsModel') })}</span>
                    </>
                  ) : (
                    <span>{x.model || t('q.settingsModel')}</span>
                  )}
                  <span>{x.branch === 'main' ? t('q.branchMain') : t('q.branchFolder')}</span>
                  {x.review && <span>{x.reviewModel ? t('q.reviewOnModel', { model: x.reviewModel }) : t('q.reviewOn')}</span>}
                  {x.dependsOn.length > 0 && <span>{t('q.dependsOnList', { list: x.dependsOn.map((d) => `#${numberOf(d)}`).join(', ') })}</span>}
                  {x.skill && <span className="queue-skill">{t('q.skillIs', { name: x.skill })}</span>}
                </div>
                {x.name && x.name.trim() !== x.prompt.trim() && <div className="small queue-prompt">{x.prompt.split(/\r?\n/)[0]}</div>}
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
        <div className="settings-field">
          <div className="field-label">
            <label htmlFor="queue-name">{t('q.name')}</label>
            <InfoTip label={t('info.about', { name: t('q.name') })} text={t('q.nameWhy')} />
          </div>
          <div className="field-control">
            <input id="queue-name" type="text" maxLength={80} value={draft.name} placeholder={draft.prompt ? titleOf({ prompt: draft.prompt }) : ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
        </div>
        <label htmlFor="queue-prompt">{t('q.prompt')}</label>
        <textarea id="queue-prompt" rows={5} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        <div className="settings-field">
          <div className="field-label check-label">
            <input id="queue-lead" type="checkbox" checked={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.checked })} />
            <label htmlFor="queue-lead">{t('q.lead')}</label>
            <InfoTip label={t('info.about', { name: t('q.lead') })} text={t('q.leadWhy')} />
          </div>
        </div>
        <div className="settings-field">
          <div className="field-label">
            <label htmlFor="queue-model">{draft.lead ? t('q.leadModel') : t('q.model')}</label>
            <InfoTip label={t('info.about', { name: draft.lead ? t('q.leadModel') : t('q.model') })} text={draft.lead ? t('q.leadModelWhy') : t('q.modelWhy')} />
          </div>
          <div className="field-control">
            <ModelPicker
              id="queue-model"
              chosen={draft.model}
              onChange={(name) => setDraft({ ...draft, model: name })}
              none={t('q.modelSettings', { name: (draft.lead ? catalogue?.defaultLeadModel || catalogue?.defaultModel : catalogue?.defaultModel) || '—' })}
              catalogue={catalogue}
            />
          </div>
        </div>
        {draft.lead && (
          <div className="settings-field">
            <div className="field-label">
              <label htmlFor="queue-worker-model">{t('q.workerModel')}</label>
              <InfoTip label={t('info.about', { name: t('q.workerModel') })} text={t('q.workerModelWhy')} />
            </div>
            <div className="field-control">
              <ModelPicker
                id="queue-worker-model"
                chosen={draft.workerModel}
                onChange={(name) => setDraft({ ...draft, workerModel: name })}
                none={t('q.modelSettings', { name: catalogue?.defaultModel || draft.model || catalogue?.defaultLeadModel || '—' })}
                catalogue={catalogue}
              />
            </div>
          </div>
        )}
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
        {/* With two chats the lead judges the worker's reports: no review of its own, as in the chat. */}
        {!draft.lead && (
          <>
            <div className="settings-field">
              <div className="field-label check-label">
                <input id="queue-review" type="checkbox" checked={draft.review} onChange={(e) => setDraft({ ...draft, review: e.target.checked })} />
                <label htmlFor="queue-review">{t('q.review')}</label>
                <InfoTip label={t('info.about', { name: t('q.review') })} text={t('q.reviewWhy')} />
              </div>
            </div>
            {draft.review && (
              <div className="settings-field">
                <div className="field-label">
                  <label htmlFor="queue-review-model">{t('q.reviewModel')}</label>
                  <InfoTip label={t('info.about', { name: t('q.reviewModel') })} text={t('q.reviewModelWhy')} />
                </div>
                <div className="field-control">
                  <ModelPicker
                    id="queue-review-model"
                    chosen={draft.reviewModel}
                    onChange={(name) => setDraft({ ...draft, reviewModel: name })}
                    none={t('q.modelSettings', { name: catalogue?.defaultReviewModel || '—' })}
                    catalogue={catalogue}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {/*
          One of Settings' skills (operator, 2026-10-25), as the chat's box offers them: the ones for every project and for
          the open folder; and beside them, always, the way to Settings' skills.
        */}
        <div className="settings-field">
          <div className="field-label">
            <label htmlFor="queue-skill">{t('q.skill')}</label>
            <InfoTip label={t('info.about', { name: t('q.skill') })} text={t('q.skillWhy')} />
          </div>
          <div className="field-control queue-skill-pick">
            <select id="queue-skill" value={draft.skill} onChange={(e) => setDraft({ ...draft, skill: e.target.value })}>
              <option value="">{t('chat.skillNone')}</option>
              {skillChoices.map((k) => (
                <option key={k.name} value={k.name} title={k.description || undefined}>
                  /{k.name}
                </option>
              ))}
            </select>
            <Link href="/settings#skills" className="button-link plain small" title={t('chat.skillsLinkWhy')}>
              {t('chat.skillsLink')}
            </Link>
          </div>
        </div>
        {/* Only where there is an earlier task to depend on (operator, 2026-10-24). */}
        {earlier.length > 0 && (
          <fieldset className="queue-depends">
            <legend className="field-label">
              <span className="field-name">{t('q.dependsOn')}</span>
              <InfoTip label={t('info.about', { name: t('q.dependsOn') })} text={t('q.dependsOnWhy')} />
            </legend>
            {earlier.map((o) => (
              <label key={o.id} className="queue-dep">
                <input
                  type="checkbox"
                  checked={draft.dependsOn.includes(o.id)}
                  onChange={(e) => setDraft({ ...draft, dependsOn: e.target.checked ? [...draft.dependsOn, o.id] : draft.dependsOn.filter((d) => d !== o.id) })}
                />
                <span>
                  #{numberOf(o.id)} {titleOf(o)}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="row">
          <button className="primary" onClick={() => void submit()} disabled={busy || !draft.prompt.trim()} title={startsAfter ? t('q.addAfterWhy') : undefined}>
            {editing ? t('q.save') : startsAfter ? t('q.addAfter') : t('q.add')}
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

/**
 * What works now, other than the queue's own task (2026-10-25): a message of the chat, with the way to it; a reading of
 * the models; the sign-in. The queue waits for it, or would; a task added now starts after it.
 */
function BusyLine({ busy, running }: { busy: QueueBusy; running: boolean }) {
  const { t } = useT();
  const what = busy.kind === 'chat' ? t('q.busyChat', { title: busy.title }) : busy.kind === 'models' ? t('q.busyModels') : t('q.busyLogin');
  return (
    <p className="small queue-busy" role="status">
      <span className="wb-live" aria-hidden="true" /> {t(running ? 'q.busyRunning' : 'q.busyIdle', { what })}{' '}
      {busy.kind === 'chat' && (
        <Link
          href="/"
          onClick={() => {
            try {
              window.localStorage.setItem(THREAD_KEY, busy.sessionId);
            } catch {
              /* the chat opens on its last one */
            }
          }}
        >
          {t('q.openChat')}
        </Link>
      )}
    </p>
  );
}
