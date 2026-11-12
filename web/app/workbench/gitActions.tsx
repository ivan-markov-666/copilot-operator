'use client';

/**
 * The operator's own commit and push, at the top of the Git view (operator, 2026-11-11: "add committing and pushing; a
 * commit may not go through, and the operator must be able to see why"), as VS Code's Source Control has them: the
 * message, "Commit" (or "Commit all" when nothing is staged), "Push" with how many commits go (or "Publish branch" for a
 * branch the remote has not got yet).
 *
 * Each is started and then followed (`api.gitOp`), every line git and the project's hooks print shown as it comes; one
 * that did not go through says why in a sentence over git's own words, and when the reason is one the operator can
 * mend here, offers it: their name and e-mail for git; the project's hooks that are not its own, named with why, to go
 * on without them, run them all the same (remembered as they are), or not at all. See `vcs/operatorGit.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type GitHookChoice, type GitOp, type WorkspaceGit } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { useT } from '../../lib/i18n';
import type { Key } from '../../lib/lang/types';
import { CopyButton } from '../copyButton';
import type { Tab } from './workbench';

/** The message being written, kept for the folder in this browser until it is committed. */
const draftKey = (dir: string): string => `cop.git.message:${dir.toLowerCase()}`;
/** The last result the operator closed, so a reload does not bring it back. */
const SEEN_KEY = 'cop.git.opSeen';
const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const keep = (key: string, value: string): void => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* no storage: kept for this page only */
  }
};

export function GitActions({ state, onChanged, onOpen }: { state: WorkspaceGit; onChanged: () => void; onOpen: (tab: Tab) => void }) {
  const { t } = useT();
  const [message, setMessage] = useState('');
  const [op, setOp] = useState<GitOp | null>(null);
  const [problem, setProblem] = useState('');
  const [starting, setStarting] = useState(false);
  const ended = useRef('');
  // The view's own reading of the folder, as it is now: a new one each render must not read the commit again.
  const changedNow = useRef(onChanged);
  changedNow.current = onChanged;
  const dir = state.dir;
  useEffect(() => {
    setMessage(read(draftKey(dir)));
  }, [dir]);
  const write = useCallback(
    (text: string): void => {
      setMessage(text);
      keep(draftKey(dir), text);
    },
    [dir],
  );

  const follow = useCallback(
    () =>
      api
        .gitOp()
        .then(({ op: now }) => {
          if (!now || now.id === read(SEEN_KEY)) return setOp(null);
          setOp(now);
          // Ended since it was last read: the view reads the folder again, and a commit made empties the message.
          if (now.state !== 'running' && ended.current !== now.id) {
            ended.current = now.id;
            changedNow.current();
            if (now.kind === 'commit' && now.state === 'done' && now.message !== undefined && read(draftKey(dir)).trim() === now.message.trim()) write('');
          }
        })
        .catch(() => undefined),
    [dir, write],
  );
  useEffect(() => {
    void follow();
  }, [follow]);
  usePoll(follow, 1_000, op?.state === 'running');

  const running = op?.state === 'running' || starting;
  const staged = state.staged.length;
  const changed = state.changes.length;
  const all = staged === 0;
  const files = all ? changed : staged;
  const up = state.upstream;
  const onBranch = !!state.branch && state.branch !== 'HEAD';

  const start = (how: () => Promise<GitOp>): void => {
    setProblem('');
    setStarting(true);
    how()
      .then((o) => {
        keep(SEEN_KEY, '');
        setOp(o);
      })
      .catch((e: unknown) => setProblem((e as Error).message))
      .finally(() => setStarting(false));
  };
  const commit = (choice: GitHookChoice = {}, text = message, everything = all): void => start(() => api.gitCommit(text, everything, choice));
  const push = (choice: GitHookChoice = {}): void => start(() => api.gitPush(choice));
  /** The same commit or push again, as the operator chose about the hooks. */
  const again = (o: GitOp, choice: GitHookChoice): void => (o.kind === 'commit' ? commit(choice, o.message ?? message, o.all ?? all) : push(choice));
  const dismiss = (): void => {
    if (op) keep(SEEN_KEY, op.id);
    setOp(null);
  };

  const commitTitle = !message.trim() ? t('git.commitNeedsMessage') : files === 0 ? t('git.nothingToCommit') : all ? t('git.commitAllWhy', { n: changed }) : t('git.commitWhy', { n: staged });
  const target = up?.name ?? '';
  const pushTitle = !up ? t('git.publishWhy') : up.behind > 0 && up.ahead > 0 ? t('git.pushBehind', { target, n: up.behind }) : up.ahead === 0 ? t('git.pushNothing', { target }) : t('git.pushWhy', { target, n: up.ahead });

  return (
    <div className="wb-git-actions">
      <label htmlFor="wb-git-message" className="sr-only">{t('git.message')}</label>
      <textarea
        id="wb-git-message"
        className="wb-git-message"
        rows={2}
        value={message}
        placeholder={t('git.messagePlaceholder')}
        onChange={(e) => write(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && message.trim() && files > 0 && !running) {
            e.preventDefault();
            commit();
          }
        }}
        disabled={running}
      />
      <div className="wb-git-buttons">
        <button type="button" className="primary" onClick={() => commit()} disabled={running || !message.trim() || files === 0} title={commitTitle}>
          ✓ {all ? t('git.commitAll') : t('git.commit')}
          {files > 0 && <span className="wb-badge">{files}</span>}
        </button>
        {/* Nothing to push: no button, as the upstream line over it already says "0 ahead". */}
        {onBranch && !(up && up.ahead === 0) && (
          <button type="button" onClick={() => push()} disabled={running} title={pushTitle}>
            {up ? t('git.push', { n: up.ahead }) : t('git.publish')}
          </button>
        )}
      </div>
      {problem && (
        <p className="err small" role="alert">
          {problem}
        </p>
      )}
      {op && <OpResult op={op} onAgain={again} onDismiss={dismiss} onOpen={onOpen} onIdentity={(o) => again(o, {})} />}
    </div>
  );
}

/** A commit or push: running, done, refused with why, or waiting for the operator about the project's hooks. */
function OpResult({ op, onAgain, onDismiss, onOpen, onIdentity }: { op: GitOp; onAgain: (op: GitOp, choice: GitHookChoice) => void; onDismiss: () => void; onOpen: (tab: Tab) => void; onIdentity: (op: GitOp) => void }) {
  const { t } = useT();
  const target = op.target ?? '';
  const short = (op.commit ?? '').slice(0, 8);
  const head =
    op.state === 'running'
      ? op.kind === 'commit'
        ? t('git.op.committing')
        : t('git.op.pushing', { target })
      : op.state === 'hooks'
        ? t('git.op.hooksAsk')
        : op.state === 'done'
          ? op.kind === 'commit'
            ? t('git.op.committed', { sha: short, branch: op.branch ?? 'HEAD' })
            : op.upToDate
              ? t('git.op.upToDate', { target })
              : op.published
                ? t('git.op.published', { target })
                : t('git.op.pushed', { target })
          : op.kind === 'commit'
            ? t('git.op.commitFailed')
            : t('git.op.pushFailed');
  return (
    <div className={`wb-git-op s-${op.state}`} role={op.state === 'failed' ? 'alert' : 'status'} aria-live="polite" data-awaits={op.state === 'hooks' ? 'git-hooks' : undefined}>
      <div className="wb-git-op-head">
        {op.state === 'running' && <span className="wb-live" aria-hidden="true" />}
        <strong className="grow">{head}</strong>
        {op.state !== 'running' && (
          <button type="button" className="wb-icon-btn" onClick={onDismiss} title={t('git.op.dismiss')} aria-label={t('git.op.dismiss')}>
            ✕
          </button>
        )}
      </div>
      {op.state === 'failed' && op.cause && <p className="wb-git-why">{t(`git.why.${op.cause}` as Key)}</p>}
      {op.passwordWindow && op.state === 'running' && <p className="wb-git-why">{t('git.op.passwordWindow')}</p>}
      {op.state !== 'running' && op.state !== 'hooks' && op.hooks !== 'none' && <p className="muted small">{op.hooks === 'run' ? t('git.op.hooksRan') : t('git.op.hooksSkipped')}</p>}
      {op.state === 'hooks' && op.flagged && (
        <>
          <ul className="wb-git-hooks">
            {op.flagged.map((h) => (
              <li key={h.path}>
                <code>{h.path}</code> — {t(`git.hookWhy.${h.why}` as Key)}{' '}
                {!/^[A-Za-z]:|^\//.test(h.path) && (
                  <button type="button" className="quiet small" onClick={() => onOpen({ kind: 'file', path: h.path })}>
                    {t('git.hooks.open')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="wb-git-buttons">
            <button type="button" onClick={() => onAgain(op, { hooks: 'skip' })} title={t('git.hooks.skipWhy')}>
              {t('git.hooks.skip')}
            </button>
            <button type="button" onClick={() => onAgain(op, { trust: op.flagged!.map((h) => ({ path: h.path, sha: h.sha })) })} title={t('git.hooks.trustWhy')}>
              {t('git.hooks.trust')}
            </button>
            <button type="button" className="quiet" onClick={onDismiss}>
              {t('git.hooks.cancel')}
            </button>
          </div>
        </>
      )}
      {op.state === 'failed' && op.cause === 'identity' && op.kind === 'commit' && <IdentityForm onSaved={() => onIdentity(op)} />}
      {op.state === 'failed' && op.cause === 'hook' && (
        <div className="wb-git-buttons">
          <button type="button" onClick={() => onAgain(op, { hooks: 'skip' })} title={t('git.hooks.skipWhy')}>
            {t('git.hooks.skip')}
          </button>
        </div>
      )}
      {(op.output || op.state === 'failed') && (
        <details className="wb-git-output" open={op.state === 'failed' || op.state === 'running'}>
          <summary>
            {t('git.op.output')} <code>{op.command}</code>
          </summary>
          <pre>{op.cut ? '…\n' : ''}{op.output || '—'}</pre>
          {op.output && <CopyButton text={op.output} what="git.op.copy" />}
        </details>
      )}
    </div>
  );
}

/** The operator's name and e-mail for git, which a first commit asks for: saved, and the commit made again. */
function IdentityForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [global, setGlobal] = useState(true);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api
      .gitIdentity()
      .then((i) => {
        setName((n) => n || i.name);
        setEmail((e) => e || i.email);
      })
      .catch(() => undefined);
  }, []);
  return (
    <form
      className="wb-git-identity"
      onSubmit={(e) => {
        e.preventDefault();
        setProblem('');
        setSaving(true);
        api
          .setGitIdentity(name, email, global)
          .then(onSaved)
          .catch((err: unknown) => setProblem((err as Error).message))
          .finally(() => setSaving(false));
      }}
    >
      <p className="small">
        <strong>{t('git.identity.title')}</strong>
      </p>
      <label>
        {t('git.identity.name')}
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>
      <label>
        {t('git.identity.email')}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <label className="check">
        <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> {t('git.identity.global')}
      </label>
      {problem && <p className="err small">{problem}</p>}
      <button type="submit" disabled={saving || !name.trim() || !email.trim()}>
        {t('git.identity.save')}
      </button>
    </form>
  );
}
