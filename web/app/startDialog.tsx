'use client';

/**
 * The start window: where the work starts, asked every time a run is started.
 *
 * Asked for on 2026-10-13. Every button that starts work — the Sessions page's run panel, a session's
 * own Start, "Run this task", the register's Continue and "Run only this one again" — opens this first,
 * and only its own button starts anything. For each session it offers the branch the work starts from:
 *
 *   a local branch, as it is in the folder (main, or any other one listed);
 *   a remote branch, the code as it is on the server — fetched when the button is pressed, through
 *   Git's own password window when the SSH key has a passphrase (src/vcs/remoteAuth.ts), so the bot
 *   never sees it; the name can be typed (a branch a colleague just pushed) or picked from the list,
 *   which "Get the list of branches from the remote" fetches;
 *   the session before it, for a chain in one repository;
 *
 * and whether the work goes on a new branch cut from it (as usual) or on that branch itself. A session
 * that has started already keeps its start, and one without version control has nothing to choose:
 * both are said, not offered. See src/vcs/startChoice.ts for what each choice does.
 *
 * When the start does not happen, the window stays open and says why, with where it stopped and the
 * files that show what happened (startFailure.tsx); a version control problem brings its fixes in here.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api, type RepoBranches, type RunVcsGroup, type StartChoice, type StartFetch, type StartOptions, type StartReply } from '../lib/api';
import { useFmtTime, useT } from '../lib/i18n';
import { useModalFocus } from '../lib/useModalFocus';
import { RunVcsPanel } from './runVcs';
import { StartFailureNotice } from './startFailure';

export type StartRequest = {
  /** The sessions the button would start, in run order. */
  sessionIds: string[];
  mode: 'confirm' | 'unattended';
  /** What the button did before this window existed, given where each session starts. */
  start: (starts: Record<string, StartChoice>) => Promise<StartReply>;
};

/** How the window ended: started, or not — with the last answer when a start was tried, for the page to keep showing. */
export type StartOutcome = { started: boolean; reply?: StartReply };

type Req = StartRequest & { id: number; resolve: (outcome: StartOutcome) => void };

let host: ((r: Req) => void) | null = null;
/** Calls that arrive before the host mounts, which only happens during hydration. */
const pending: Req[] = [];
let next = 1;

/** Opens the start window; resolves once the run has started, or when the window was closed without. */
export function openStartDialog(r: StartRequest): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const req: Req = { ...r, id: next++, resolve };
    if (host) host(req);
    else pending.push(req);
  });
}

/** Mounted once, by the layout: shows the start window whenever a page asks for it. */
export function StartDialogHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  useEffect(() => {
    host = (r) => setQueue((q) => [...q, r]);
    if (pending.length > 0) {
      const early = pending.splice(0, pending.length);
      setQueue((q) => [...q, ...early]);
    }
    return () => {
      host = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return (
    <StartDialog
      key={current.id}
      req={current}
      onDone={(outcome) => {
        current.resolve(outcome);
        setQueue((q) => q.slice(1));
      }}
    />
  );
}

/**
 * One session's choice as it is being made: every field kept, so switching back and forth loses nothing.
 * `keep`: the start it has stays — prepared before this run (a starting snapshot), or recorded when it
 * ran — and nothing is sent for it. `current`: the branch the repository is on now (a session that ran).
 */
type Draft = { from: 'local' | 'remote' | 'previous-session' | 'keep' | 'current'; local: string; remote: string; remoteBranch: string; onBranch: boolean };

type FetchGroup = { key: string; dir: string; remote: string; branches: string[] };

type Phase =
  | { kind: 'choose' }
  | { kind: 'fetching'; what: string }
  | { kind: 'fetchFailed'; group: FetchGroup; result: StartFetch }
  | { kind: 'starting' }
  | { kind: 'failed'; reply: StartReply };

const repoKey = (dir: string): string => dir.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

function draftFrom(choice: StartChoice | undefined, repo: RepoBranches | undefined): Draft {
  const remote = repo?.remotes.find((r) => r.name === 'origin')?.name ?? repo?.remotes[0]?.name ?? '';
  const local = repo?.current ?? repo?.local[0]?.name ?? 'main';
  if (!choice) return { from: 'local', local, remote, remoteBranch: 'main', onBranch: false };
  if (choice.from === 'previous-session') return { from: 'previous-session', local, remote, remoteBranch: local, onBranch: false };
  if (choice.from === 'local') return { from: 'local', local: choice.branch, remote, remoteBranch: choice.branch, onBranch: !!choice.onBranch };
  return { from: 'remote', local: repo?.local.some((b) => b.name === choice.branch) ? choice.branch : local, remote: choice.remote, remoteBranch: choice.branch, onBranch: !!choice.onBranch };
}

function StartDialog({ req, onDone: done }: { req: Req; onDone: (outcome: StartOutcome) => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const uid = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const goRef = useRef<HTMLButtonElement | null>(null);
  const [opts, setOpts] = useState<StartOptions | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [repos, setRepos] = useState<Record<string, RepoBranches>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [note, setNote] = useState('');
  const [listBusy, setListBusy] = useState('');
  const [listMsg, setListMsg] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<RunVcsGroup[]>([]);
  const [copied, setCopied] = useState(false);
  /** Remotes the operator chose to go on with as last fetched, for this window. */
  const skipped = useRef(new Set<string>());
  /** The last answer to a start, handed back when the window closes. */
  const last = useRef<StartReply | undefined>(undefined);
  const onDone = (started: boolean) => done({ started, ...(last.current ? { reply: last.current } : {}) });

  const busy = phase.kind === 'fetching' || phase.kind === 'starting' || listBusy !== '';

  /**
   * The sessions and their branches, and each session's choice as the server now has it. `keepChoices`:
   * "Read the branches again" — what is shown is read afresh, what the operator chose stays chosen.
   */
  const loadOptions = (keepChoices = false): Promise<void> =>
    api
      .startOptions(req.sessionIds)
      .then((o) => {
        setOpts(o);
        const byKey: Record<string, RepoBranches> = {};
        for (const r of o.repos) byKey[repoKey(r.repoDir)] = r;
        setRepos(byKey);
        const d: Record<string, Draft> = {};
        for (const s of o.sessions) {
          if (!s.vcs || !s.repoDir || (s.fixed && !s.choice)) continue;
          const draft = draftFrom(s.choice, byKey[repoKey(s.repoDir)]);
          /*
           * Prepared on the run panel — approved file by file — or recorded when it ran: kept unless the
           * operator chooses otherwise. A session that ran offers its own start first, and the rest beside it.
           */
          d[s.id] = s.prepared || s.fixed ? { ...draft, from: 'keep' } : draft;
        }
        setDrafts((before) => (keepChoices ? { ...d, ...Object.fromEntries(Object.entries(before).filter(([id]) => id in d)) } : d));
      })
      .catch((e: unknown) => setLoadErr((e as Error).message));
  useEffect(() => {
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.sessionIds]);

  useModalFocus(boxRef, true, goRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (!busy) onDone(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onDone]);

  const repoOf = (dir?: string): RepoBranches | undefined => (dir ? repos[repoKey(dir)] : undefined);
  const setDraft = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] as Draft), ...patch } }));
  const putRepo = (r?: RepoBranches) => {
    if (r) setRepos((all) => ({ ...all, [repoKey(r.repoDir)]: r }));
  };

  /** The choices as the API takes them, and the remotes to fetch first; or what is still missing. */
  const build = (): { starts: Record<string, StartChoice>; groups: FetchGroup[] } | { problem: string } => {
    const starts: Record<string, StartChoice> = {};
    const fetches = new Map<string, FetchGroup>();
    for (const s of opts?.sessions ?? []) {
      const d = drafts[s.id];
      const repo = repoOf(s.repoDir);
      if (!d || !s.repoDir || !repo || repo.problem || d.from === 'keep') continue;
      // Another start for a session that has run: said as such, or the server keeps the one it has.
      const again = s.fixed ? { rechoose: true } : {};
      if (d.from === 'previous-session') {
        starts[s.id] = { from: 'previous-session', ...again };
      } else if (d.from === 'current') {
        if (!repo.current) return { problem: t('startdlg.needBranch', { name: s.name }) };
        starts[s.id] = { from: 'local', branch: repo.current, ...(d.onBranch ? { onBranch: true } : {}), ...again };
      } else if (d.from === 'local') {
        if (!d.local || !repo.local.some((b) => b.name === d.local)) return { problem: t('startdlg.needBranch', { name: s.name }) };
        starts[s.id] = { from: 'local', branch: d.local, ...(d.onBranch ? { onBranch: true } : {}), ...again };
      } else {
        const branch = d.remoteBranch.trim();
        if (!d.remote || !branch) return { problem: t('startdlg.needBranch', { name: s.name }) };
        starts[s.id] = { from: 'remote', remote: d.remote, branch, ...(d.onBranch ? { onBranch: true } : {}), ...again };
        const at = `${repoKey(s.repoDir)}|${d.remote}`;
        const g = fetches.get(at) ?? { key: at, dir: repo.repoDir, remote: d.remote, branches: [] };
        if (!g.branches.includes(branch)) g.branches.push(branch);
        fetches.set(at, g);
      }
    }
    // Keyed by the branches too: going on without fetching was agreed for these, not for the next ones chosen.
    return { starts, groups: [...fetches.values()].map((g) => ({ ...g, key: `${g.key}|${[...g.branches].sort().join(',')}` })) };
  };

  const loadVcs = () => {
    api
      .runVcs(req.sessionIds)
      .then(setGroups)
      .catch(() => setGroups([]));
  };
  /*
   * A fix pressed in the version control panel can change where a session starts ("Use the current branch
   * instead"): the choice is read back from the sessions, so "Try to start again" does not send the old one.
   */
  const afterFix = () => {
    loadVcs();
    void loadOptions();
  };

  /** Back to the choice: what was agreed about fetching holds for the start it was agreed for, not the next one. */
  const backToChoice = () => {
    skipped.current.clear();
    setPhase({ kind: 'choose' });
  };

  const go = async (how: { skipFetch?: boolean } = {}) => {
    setNote('');
    const built = build();
    if ('problem' in built) {
      setNote(built.problem);
      return;
    }
    if (!how.skipFetch) {
      for (const g of built.groups) {
        if (skipped.current.has(g.key)) continue;
        setPhase({ kind: 'fetching', what: g.branches.map((b) => `${g.remote}/${b}`).join(', ') });
        const r: StartFetch = await api.startFetch(g.dir, g.remote, g.branches).catch((e: unknown) => ({ ok: false, problem: (e as Error).message, missing: [] }));
        putRepo(r.repo);
        if (!r.ok) {
          setPhase({ kind: 'fetchFailed', group: g, result: r });
          return;
        }
      }
    }
    setPhase({ kind: 'starting' });
    let reply: StartReply;
    try {
      reply = await req.start(built.starts);
    } catch (e) {
      reply = { started: false, reason: (e as Error).message };
    }
    last.current = reply;
    if (reply.started) {
      onDone(true);
      return;
    }
    setPhase({ kind: 'failed', reply });
    if (reply.failure?.stage === 'preflight') loadVcs();
  };

  /** "Get the list of branches from the remote": the whole remote fetched, through the password window if it asks. */
  const refreshList = async (dir: string, remote: string) => {
    const key = `${repoKey(dir)}|${remote}`;
    setListBusy(key);
    setListMsg((m) => ({ ...m, [repoKey(dir)]: t('startdlg.fetching', { what: remote }) }));
    try {
      const r = await api.startFetch(dir, remote);
      putRepo(r.repo);
      setListMsg((m) => ({ ...m, [repoKey(dir)]: r.ok ? '' : `${t('startdlg.fetchFailed', { what: remote })} ${r.problem ?? r.fetched?.detail ?? ''}${r.fetched?.auth ? ` ${t('prep.fetchAuth')}` : ''}` }));
    } catch (e) {
      setListMsg((m) => ({ ...m, [repoKey(dir)]: (e as Error).message }));
    } finally {
      setListBusy('');
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setNote(t('plan.copyFailed'));
    }
  };

  const anyRemote = Object.values(drafts).some((d) => d.from === 'remote');
  /** Where a session's work will start, in a few words, when that can be said: "feature/x @ 1a2b3c4d". */
  const whereOf = (s: StartOptions['sessions'][number]): string | undefined => {
    const d = drafts[s.id];
    const repo = repoOf(s.repoDir);
    if (!d || !repo) return undefined;
    const at = (c?: string | null): string => (c ? ` @ ${c.slice(0, 8)}` : '');
    if (d.from === 'keep') return s.fixed && s.started?.branch ? `${s.started.branch}${at(s.started.tipNow ?? s.started.recorded)}` : undefined;
    if (d.from === 'current') return repo.current ? `${repo.current}${at(repo.head)}` : undefined;
    if (d.from === 'local') return `${d.local}${at(repo.local.find((b) => b.name === d.local)?.commit)}`;
    if (d.from === 'remote') return d.remoteBranch.trim() ? `${d.remote}/${d.remoteBranch.trim()}` : undefined;
    return undefined;
  };
  /*
   * The button says where the work starts when there is one session to say it of (operator's report,
   * 2026-10-13: "Start without asking" did not say on which branch, at which commit).
   */
  const withVcs = (opts?.sessions ?? []).filter((s) => s.vcs);
  const onlyWhere = withVcs.length === 1 ? whereOf(withVcs[0]!) : undefined;
  const goLabel = onlyWhere
    ? t(req.mode === 'unattended' ? 'startdlg.goUnattendedOn' : 'startdlg.goStepOn', { where: onlyWhere })
    : req.mode === 'unattended'
      ? t('startdlg.goUnattended')
      : t('startdlg.goStep');

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && onDone(false)}>
      <div
        ref={boxRef}
        className="modal wide start-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        onClick={(e) => e.stopPropagation()}
        style={{ overflowWrap: 'anywhere' }}
      >
        <h2 id={`${uid}-title`}>{t('startdlg.title')}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {t('startdlg.intro')}{' '}
          {opts && phase.kind === 'choose' && (
            // What the repository is like now — after a checkout or a pull outside the bot — read again.
            <button type="button" className="quiet" onClick={() => void loadOptions(true)} disabled={busy}>
              {t('startdlg.refresh')}
            </button>
          )}
        </p>

        {loadErr && <StartFailureNotice reason={loadErr} />}
        {!opts && !loadErr && <p className="small" role="status">{t('startdlg.loading')}</p>}

        {opts && (phase.kind === 'choose' || phase.kind === 'fetching' || phase.kind === 'starting') &&
          opts.sessions.map((s) => {
            const repo = repoOf(s.repoDir);
            const d = drafts[s.id];
            const name = `start-${uid}-${s.id}`;
            const remoteBranches = repo?.remotes.find((r) => r.name === d?.remote)?.branches ?? [];
            return (
              <fieldset key={s.id} className="option" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '8px 12px', margin: '10px 0' }}>
                <legend style={{ padding: '0 4px' }}>
                  <strong>{s.name}</strong>
                </legend>
                {s.repoDir && <p className="muted small" style={{ margin: '2px 0 6px' }}>{t('startdlg.repoOn', { repo: s.repoDir, branch: repo?.current ?? 'HEAD' })}</p>}
                {!s.vcs ? (
                  <p className="small">{t('startdlg.vcsOff')}</p>
                ) : !repo || repo.problem || !d ? (
                  s.fixed ? (
                    <p className="small">{t('startdlg.fixed', { start: s.fixed })}</p>
                  ) : (
                    <p className="err small">{t('startdlg.repoProblem', { problem: repo?.problem ?? '' })}</p>
                  )
                ) : s.fixed && s.rechooseBlocked ? (
                  <>
                    <p className="small">{t('startdlg.fixed', { start: s.fixed })}</p>
                    <p className="muted small">{t('startdlg.rechooseBlocked', { tasks: s.rechooseBlocked })}</p>
                  </>
                ) : (
                  <>
                    {s.fixed && (
                      <>
                        <p className="small" style={{ margin: '2px 0' }}>{t('startdlg.fixed', { start: s.fixed })}</p>
                        {s.started?.branch && (
                          <p className="small" style={{ margin: '2px 0' }}>
                            {s.started.tipNow
                              ? t('startdlg.branchNow', { branch: s.started.branch, now: s.started.tipNow.slice(0, 8), recorded: (s.started.recorded ?? '').slice(0, 8) })
                              : t('startdlg.branchGone', { branch: s.started.branch, recorded: (s.started.recorded ?? '').slice(0, 8) })}
                            {s.started.remote ? ` ${t('startdlg.branchRemote', { name: s.started.remote.name, commit: s.started.remote.commit.slice(0, 8) })}` : ''}
                          </p>
                        )}
                        {/* Said when the repository is on another branch: the operator's report, a checkout made outside the bot. */}
                        {repo.current && s.started?.branch && repo.current !== s.started.branch && s.started.mode !== 'per-task' && (
                          <p className="notice caution small" style={{ margin: '4px 0' }}>
                            {t('startdlg.differs', { current: repo.current, head: (repo.head ?? '').slice(0, 8), branch: s.started.branch })}
                          </p>
                        )}
                        <div className="option">
                          <label>
                            <input type="radio" name={name} checked={d.from === 'keep'} onChange={() => setDraft(s.id, { from: 'keep' })} disabled={busy} />
                            <span>{s.started?.branch ? t('startdlg.keepStarted', { branch: s.started.branch }) : t('startdlg.keepStartedNoBranch')}</span>
                          </label>
                        </div>
                        {repo.current && repo.current !== s.started?.branch && (
                          <div className="option">
                            <label>
                              <input type="radio" name={name} checked={d.from === 'current'} onChange={() => setDraft(s.id, { from: 'current' })} disabled={busy} />
                              <span>{t('startdlg.useCurrent', { branch: repo.current, commit: (repo.head ?? '').slice(0, 8) })}</span>
                            </label>
                          </div>
                        )}
                      </>
                    )}
                    {s.prepared && (
                      <div className="option">
                        <label>
                          <input type="radio" name={name} checked={d.from === 'keep'} onChange={() => setDraft(s.id, { from: 'keep' })} disabled={busy} />
                          <span>{t('startdlg.keep')}</span>
                        </label>
                        <p className="why">{t('startdlg.prepared', { start: s.prepared })}</p>
                      </div>
                    )}
                    <div className="option">
                      <label>
                        <input type="radio" name={name} checked={d.from === 'local'} onChange={() => setDraft(s.id, { from: 'local' })} disabled={busy} />
                        <span>{t('startdlg.local')}</span>
                      </label>
                      <div className="row" style={{ marginTop: 4 }}>
                        <select
                          aria-label={t('startdlg.localBranch')}
                          value={d.local}
                          onChange={(e) => setDraft(s.id, { from: 'local', local: e.target.value })}
                          disabled={busy}
                          style={{ width: 'auto', minWidth: 240, maxWidth: '100%' }}
                        >
                          {!repo.local.some((b) => b.name === d.local) && <option value={d.local}>{d.local}</option>}
                          {repo.local.map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name} · {b.commit.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="why">{t('startdlg.localWhy')}</p>
                    </div>

                    <div className="option">
                      <label>
                        <input type="radio" name={name} checked={d.from === 'remote'} onChange={() => setDraft(s.id, { from: 'remote' })} disabled={busy || repo.remotes.length === 0} />
                        <span>{t('startdlg.remote')}</span>
                      </label>
                      {repo.remotes.length === 0 ? (
                        <p className="muted small">{t('startdlg.noRemote')}</p>
                      ) : (
                        <>
                          <div className="row" style={{ marginTop: 4 }}>
                            {repo.remotes.length > 1 && (
                              <select aria-label={t('startdlg.remoteName')} value={d.remote} onChange={(e) => setDraft(s.id, { from: 'remote', remote: e.target.value })} disabled={busy} style={{ width: 'auto' }}>
                                {repo.remotes.map((r) => (
                                  <option key={r.name} value={r.name}>
                                    {r.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {repo.remotes.length === 1 && <code>{d.remote}/</code>}
                            <input
                              type="text"
                              aria-label={t('startdlg.remoteBranch')}
                              list={`${name}-remote`}
                              value={d.remoteBranch}
                              onChange={(e) => setDraft(s.id, { from: 'remote', remoteBranch: e.target.value })}
                              onFocus={() => d.from !== 'remote' && setDraft(s.id, { from: 'remote' })}
                              disabled={busy}
                              style={{ width: 'auto', minWidth: 240, flex: '1 1 240px' }}
                              placeholder="main"
                            />
                            <datalist id={`${name}-remote`}>
                              {remoteBranches.map((b) => (
                                <option key={b.name} value={b.name} />
                              ))}
                            </datalist>
                            <button type="button" onClick={() => void refreshList(repo.repoDir, d.remote)} disabled={busy || !d.remote}>
                              {t('startdlg.refreshRemote')}
                            </button>
                          </div>
                          <p className="why">{t('startdlg.remoteWhy')}</p>
                          <p className="muted small" style={{ margin: '2px 0' }}>
                            {repo.lastFetched
                              ? t('startdlg.lastFetched', { when: fmtTime(repo.lastFetched) })
                              : remoteBranches.length > 0
                                ? t('startdlg.lastFetchedUnknown')
                                : t('startdlg.neverFetched')}
                          </p>
                          {listMsg[repoKey(repo.repoDir)] && <p className="small" role="status">{listMsg[repoKey(repo.repoDir)]}</p>}
                        </>
                      )}
                    </div>

                    {s.previousOffered && (
                      <div className="option">
                        <label>
                          <input type="radio" name={name} checked={d.from === 'previous-session'} onChange={() => setDraft(s.id, { from: 'previous-session' })} disabled={busy} />
                          <span>{t('startdlg.previous')}</span>
                        </label>
                        <p className="why">{t('startdlg.previousWhy')}</p>
                      </div>
                    )}

                    <div className="option">
                      <label>
                        <input type="checkbox" checked={d.onBranch && (d.from === 'local' || d.from === 'remote' || d.from === 'current')} onChange={(e) => setDraft(s.id, { onBranch: e.target.checked })} disabled={busy || (d.from !== 'local' && d.from !== 'remote' && d.from !== 'current')} />
                        <span>{t('startdlg.onBranch')}</span>
                      </label>
                      <p className="why">{t('startdlg.onBranchWhy')}</p>
                    </div>
                    {s.fixed && d.from !== 'keep' && <p className="notice caution small">{t('startdlg.rechooseNote')}</p>}
                  </>
                )}
              </fieldset>
            );
          })}

        {phase.kind === 'fetching' && (
          <p className="notice small" role="status">
            {t('startdlg.fetching', { what: phase.what })}
          </p>
        )}
        {phase.kind === 'starting' && (
          <p className="notice small" role="status">
            {t('startdlg.starting')}
          </p>
        )}

        {phase.kind === 'fetchFailed' && (
          <div className="notice caution" role="alert">
            <p style={{ marginTop: 0 }}>
              <strong>{t('startdlg.fetchFailed', { what: phase.group.branches.map((b) => `${phase.group.remote}/${b}`).join(', ') })}</strong>{' '}
              <code>{phase.result.problem ?? phase.result.fetched?.detail ?? ''}</code>
            </p>
            {phase.result.missing.length > 0 && <p className="small">{t('startdlg.missing', { names: phase.result.missing.join(', ') })}</p>}
            {phase.result.fetched?.auth && <p className="small">{t('prep.fetchAuth')}</p>}
            <div className="row">
              <button type="button" className="primary" onClick={() => void go()}>
                {t('startdlg.retryFetch')}
              </button>
              {(() => {
                const r = repoOf(phase.group.dir);
                const known = r?.remotes.find((x) => x.name === phase.group.remote)?.branches ?? [];
                const all = phase.group.branches.every((b) => known.some((k) => k.name === b));
                return all ? (
                  <button
                    type="button"
                    onClick={() => {
                      skipped.current.add(phase.group.key);
                      void go();
                    }}
                  >
                    {t('startdlg.useFetched')}
                  </button>
                ) : null;
              })()}
              <button type="button" className="quiet" onClick={backToChoice}>
                {t('startdlg.back')}
              </button>
            </div>
            {(() => {
              const r = repoOf(phase.group.dir);
              const known = r?.remotes.find((x) => x.name === phase.group.remote)?.branches ?? [];
              const unknown = phase.group.branches.filter((b) => !known.some((k) => k.name === b));
              return unknown.length > 0 ? (
                <p className="muted small">{t('startdlg.useFetchedNo', { what: unknown.map((b) => `${phase.group.remote}/${b}`).join(', ') })}</p>
              ) : phase.result.lastFetched ? (
                <p className="muted small">{t('prep.lastFetched', { when: fmtTime(phase.result.lastFetched) })}</p>
              ) : null;
            })()}
            {phase.result.fetchCommand && (
              <>
                <p className="small" style={{ marginTop: 8 }}>{t('prep.ownTerminal')}</p>
                <pre className="sync-cmd">{phase.result.fetchCommand}</pre>
                <div className="row">
                  <button type="button" onClick={() => void copy(phase.result.fetchCommand ?? '')}>
                    {t('prep.copyFetch')}
                  </button>
                  {copied && <span className="badge done">{t('prep.copied')}</span>}
                </div>
              </>
            )}
          </div>
        )}

        {phase.kind === 'failed' && (
          <>
            <StartFailureNotice failure={phase.reply.failure} reason={phase.reply.reason} />
            {phase.reply.failure?.stage === 'preflight' && groups.some((g) => !g.ready) && (
              <>
                <p className="small">{t('startdlg.vcsFix')}</p>
                <RunVcsPanel groups={groups} sessionIds={req.sessionIds} onChange={afterFix} />
              </>
            )}
          </>
        )}

        {note && (
          <p className="err small" role="alert">
            {note}
          </p>
        )}
        {phase.kind === 'choose' && anyRemote && <p className="why">{t('prep.password')}</p>}

        <div className="row modal-actions">
          <button type="button" className="quiet" onClick={() => onDone(false)} disabled={busy}>
            {t('dialog.cancel')}
          </button>
          {phase.kind === 'failed' ? (
            <>
              <button type="button" onClick={backToChoice}>
                {t('startdlg.back')}
              </button>
              <button type="button" className="primary" onClick={() => void go({ skipFetch: true })}>
                {t('startdlg.tryAgain')}
              </button>
            </>
          ) : (
            phase.kind !== 'fetchFailed' && (
              <button ref={goRef} type="button" className="primary" onClick={() => void go()} disabled={busy || !opts}>
                {goLabel}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
