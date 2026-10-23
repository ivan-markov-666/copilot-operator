'use client';

/**
 * The steps waiting for the operator, on every page, right under the navigation.
 *
 * A step that waits for a decision used to be shown on the Sessions page and on its own session's
 * page, and nowhere else. An operator reading the history, editing Settings or on the import page
 * saw nothing, and the run simply looked stuck — for a download held for approval in an unattended
 * run, all night. So the question is asked wherever the operator is: this sits in the layout, below
 * the navigation, sticks to the top of the window while the page scrolls, and says in the tab's
 * title that something is waiting, for an operator looking at another window altogether.
 *
 * It polls, like the rest of the interface: every two seconds, which is what a person answering a
 * question notices as "at once".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, type Approval } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';
import { confirmDialog } from './dialog';
import { usePoll } from '../lib/usePoll';
import { useActivity } from '../lib/activity';
import { tabTitle } from '../lib/actors';
import { PlanView } from './planView';
import { ActorChip } from './actor';

const EVERY_MS = 2_000;
/** How long the tab says how the last message ended once the operator has the page in front of them. */
const SEEN_MS = 12_000;

export function GlobalApprovals() {
  const { t } = useT();
  const pathname = usePathname();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const known = useRef<Record<string, string>>({});
  /** Sessions that are conversations of the workbench's chat, which asks about their steps itself. */
  const chats = useRef<Set<string>>(new Set());
  const askedFor = useRef('');

  const load = useCallback(async () => {
    try {
      const waiting = await api.approvals();
      setApprovals(waiting);
      /*
       * Session names only when there is something to name, so an idle interface asks for one list,
       * and at most once per set of unknown sessions. The names used to sit in the callback's own
       * dependencies: every fetch made a new object, the callback changed, the effect ran it again
       * at once — and a session the list did not contain (deleted while its step waited) kept that
       * going with no pause at all.
       */
      const unknown = [...new Set(waiting.map((a) => a.sessionId).filter((id) => !(id in known.current)))];
      const key = unknown.sort().join(',');
      if (unknown.length > 0 && key !== askedFor.current) {
        askedFor.current = key;
        const sessions = await api.sessions().catch(() => []);
        for (const s of sessions) {
          known.current[s.id] = s.name;
          if (s.kind === 'chat') chats.current.add(s.id);
        }
        setNames({ ...known.current });
      }
    } catch {
      /* the API is down or the key is missing; the pages say which */
    }
  }, []);

  usePoll(load, EVERY_MS);

  /*
   * The tab says so too, for an operator whose attention is in another window: what waits for them first, else that the
   * bot is at work and who (2026-10-22: "when the bot works, let it show in the tab that says copilot-operator").
   */
  const activity = useActivity();
  /*
   * The dots of "Working..." go round, and the last message's end is said until the operator has had the page in
   * front of them for SEEN_MS: kept while they are in another window, gone a moment after they look (2026-10-23).
   */
  const [tick, setTick] = useState(0);
  const lookedAt = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) lookedAt.current = Date.now();
      setTick((n) => n + 1);
    }, 450);
    return () => clearInterval(id);
  }, []);
  const lastAt = activity?.last ? Date.parse(activity.last.at) : 0;
  const title = tabTitle(approvals.length, activity, (tick % 3) + 1, !!activity?.last && lookedAt.current - lastAt < SEEN_MS);
  useEffect(() => {
    document.title = title;
  }, [title]);

  /*
   * On the workbench the chat asks about its own commands, in the conversation (2026-10-17, "like Windsurf"); the
   * banner would say it a second time over the whole window. Every other page still shows them here. A session not
   * read yet is held back for the moment it takes, rather than flashing the banner up and away. A chat's model or plan
   * card is not a command and is not asked about in the conversation, which points up here for it ("the card at the
   * top"): hidden too, it left a chat waiting with nothing to answer (2026-10-17). A chat's plan is asked about in the
   * conversation since 2026-10-20 (plan mode, "as in Claude Code"), so only its model card is left up here.
   */
  const shown =
    pathname === '/'
      ? approvals.filter((a) => a.sessionId in known.current && (!chats.current.has(a.sessionId) || !!a.model))
      : approvals;
  if (shown.length === 0) return null;

  return (
    <section className="approval-banner" role="alert" aria-live="assertive">
      <h2>{t('approval.waitingHere')}</h2>
      <p className="small">{t('approval.waitingHereWhy')}</p>
      {shown.map((a) => (
        <ApprovalCard key={a.id} approval={a} sessionName={names[a.sessionId] ?? a.sessionId} onDecided={() => void load()} />
      ))}
    </section>
  );
}

/**
 * One waiting step: the command in full, which session is asking, and the four answers. The session's
 * name is on every card because, in a run of several, which session is asking is half the question.
 */
function ApprovalCard({ approval, sessionName, onDecided }: { approval: Approval; sessionName: string; onDecided: () => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // A ref, not only `busy`: a double click's second press lands before the re-render that disables.
  const deciding = useRef(false);

  const decide = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    if (deciding.current) return;
    if (action === 'run-all' && !(await confirmDialog(t('approval.runAllConfirm')))) return;
    deciding.current = true;
    setBusy(true);
    setErr('');
    try {
      await api.decide(approval.id, action);
    } catch (e) {
      // Said on the card: a decision that did not arrive leaves the step waiting, and pressing
      // again with no idea why the first press did nothing is the worst way to find out.
      setErr((e as Error).message);
    } finally {
      deciding.current = false;
      setBusy(false);
      onDecided();
    }
  };

  // Not a step: a task's plan, waiting to be approved before the work starts (plan mode, 2026-10-13).
  if (approval.plan) return <PlanCard approval={approval} sessionName={sessionName} onDecided={onDecided} />;

  /*
   * Not a step: the chat could not be put on the chosen model, and the operator is asked to choose it in
   * the Copilot window, then say so here (2026-10-06). The run waits on this card in every mode.
   */
  if (approval.model) {
    const m = approval.model;
    return (
      <div className="approval">
        <div className="row">
          <strong>{t(m.manual ? 'approval.manualTitle' : 'approval.modelTitle')}</strong>
          {approval.actor && <ActorChip actor={approval.actor} how="asks" />}
          <Link href="/">{sessionName}</Link>
          <span className="muted small">{fmtTime(approval.createdAt)}</span>
        </div>
        {/*
          The review's own conversation (operator, 2026-10-20): said so plainly, before anything else on the card, with why
          another, stronger model is worth choosing for it.
        */}
        {m.review && (
          <div className="approval-review" role="note">
            <strong>{t('approval.reviewModelTitle')}</strong>
            <span>{t('approval.reviewModelWhy')}</span>
          </div>
        )}
        {/* Two chats (2026-10-20): which of the two conversations the model is for. */}
        {m.role && (
          <div className="approval-review" role="note">
            <strong>{t(m.role === 'lead' ? 'approval.leadModelTitle' : 'approval.workerModelTitle')}</strong>
            <span>{t(m.role === 'lead' ? 'approval.leadModelWhy' : 'approval.workerModelWhy')}</span>
          </div>
        )}
        <p>{m.manual ? (m.asked ? t('approval.manualAsk', { model: m.asked }) : t('approval.manualAskAny')) : t('approval.modelAsk', { model: m.asked })}</p>
        <p className="muted small">{t('approval.modelShown', { shown: m.shown ?? '—' })}</p>
        {!m.manual && <p className="reason small">{t('approval.modelWhy', { why: m.why, tries: m.tries })}</p>}
        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void decide('run')}>
            {t(m.manual ? 'approval.manualReady' : 'approval.modelChosen')}
          </button>
          {/*
            Not for a model chosen by hand (2026-10-19, "why two buttons?"): there both went on, on the model the chat is
            on, and only the record differed. Kept where the bot could not choose it, where they are different answers.
          */}
          {!m.manual && (
            <button disabled={busy} onClick={() => void decide('skip')}>
              {t('approval.modelAsItIs')}
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => void decide('abort')}>
            {t('approval.modelStop')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="approval">
      <div className="row">
        <strong>{t('approval.title', { n: approval.stepId })}</strong>
        {approval.actor && <ActorChip actor={approval.actor} how="asks" />}
        <Link href="/">{sessionName}</Link>
        <span className="muted small">{fmtTime(approval.createdAt)}</span>
      </div>
      <pre style={{ margin: '8px 0' }}>{approval.description}</pre>
      {approval.platform && <p className="reason small">{t('approval.platform', { platform: approval.platform })}</p>}
      {approval.network && <p className="reason small">{t('approval.network')}</p>}
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide('run')}>
          {t('approval.run')}
        </button>
        {!approval.network && !approval.platform && (
          <button disabled={busy} onClick={() => void decide('run-all')} title={t('approval.runAllWhy')}>
            {t('approval.runAll')}
          </button>
        )}
        <button disabled={busy} onClick={() => void decide('skip')}>
          {t('approval.skip')}
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('abort')}>
          {t('approval.abort')}
        </button>
      </div>
    </div>
  );
}

/**
 * A task's plan, waiting before the work starts: the plan in full, a note the chat gets with the
 * answer, and three answers — approve it, ask for another (the note says what to change, so it is
 * required), or stop the task. In the chat's conversation it is shown where it was asked for, with no session name.
 */
export function PlanCard({ approval, sessionName, onDecided }: { approval: Approval; sessionName?: string; onDecided: (ok: boolean) => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const deciding = useRef(false);
  const p = approval.plan!;

  const decide = async (action: 'approve' | 'revise' | 'stop') => {
    if (deciding.current) return;
    if (action === 'revise' && !note.trim()) {
      setErr(t('pm.reviseNeedsNote'));
      return;
    }
    if (action === 'stop' && !(await confirmDialog(t('pm.stopConfirm')))) return;
    deciding.current = true;
    setBusy(true);
    setErr('');
    let ok = false;
    try {
      await api.decidePlan(approval.id, action, note);
      ok = true;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      deciding.current = false;
      setBusy(false);
      onDecided(ok);
    }
  };

  return (
    <div className="approval">
      <div className="row">
        <strong>{t('pm.cardTitle', { title: p.title })}</strong>
        {approval.actor && <ActorChip actor={approval.actor} how="asks" />}
        {sessionName !== undefined && <Link href="/">{sessionName}</Link>}
        <span className="muted small">{fmtTime(approval.createdAt)}</span>
      </div>
      <p className="small">{t('pm.cardWhy')}</p>
      <PlanView plan={p.plan} showApproval={false} />
      <label htmlFor={`plan-note-${approval.id}`}>{t('pm.note')}</label>
      <textarea
        id={`plan-note-${approval.id}`}
        className="prose"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('pm.notePlaceholder')}
        style={{ minHeight: 70 }}
        disabled={busy}
      />
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide('approve')}>
          {t('pm.approve')}
        </button>
        <button disabled={busy} onClick={() => void decide('revise')} title={t('pm.reviseWhy')}>
          {t('pm.revise')}
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('stop')}>
          {t('pm.stop')}
        </button>
      </div>
    </div>
  );
}
