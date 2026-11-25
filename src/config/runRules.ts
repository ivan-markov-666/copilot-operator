/**
 * The rules a run goes by (operator, 2026-11-25: "an option in Settings that passes over the runner's policy — mainly
 * when Kerrigan directs, but for the others too"). `execution.ignoreRules` says when: never, as it was; in the
 * conversations Kerrigan directs, the chats she sends to with them; or always.
 *
 * Passed over, the operator's choice of scope that day:
 *
 *   - the list of refused commands — except its git patterns: what reaches the remote or throws work away stays refused;
 *   - the list of programs the bot may start;
 *   - the boxes of scripts: the project's and the bot's own run, with no card, so nothing is handed over to be run by hand.
 *
 * Not passed over, whatever it says: the techniques of `dangerous.ts`, the bot's own things, the repository's internals,
 * the project's folders, what Settings say of downloads, of platforms and of programs set to read only, isolation — and
 * an administrator's `policy.lock.json`, which is applied again here, on top, so that it still only tightens.
 */
import { SCRIPT_KINDS, type ScriptRules } from '../exec/scriptKinds.js';
import { applyPolicyLock, type LockablePolicy } from './lockedPolicy.js';
import { chatDenyPatterns, type ResolvedConfig } from './schema.js';

/** Git commands one of which a pattern of the list refuses when it is about git: such a pattern is kept. */
const GIT_KEPT = ['git push origin main', 'git reset --hard', 'git clean -fd', 'git rebase main', 'git branch -D x', 'git remote set-url origin x', 'git config a.b c'];

const refusesGit = (pattern: string): boolean => {
  try {
    const re = new RegExp(pattern, 'i');
    return GIT_KEPT.some((c) => re.test(c));
  } catch {
    return GIT_KEPT.some((c) => c.toLowerCase().includes(pattern.toLowerCase()));
  }
};

export type RunRules = Pick<ResolvedConfig['execution'], 'denyPatterns' | 'allowedPrograms' | 'scripts' | 'writtenScripts'> & { rulesIgnored: boolean };

/** Whether Settings pass the lists over in this run. */
export function rulesIgnoredIn(choice: ResolvedConfig['execution']['ignoreRules'], kerrigan: boolean): boolean {
  return choice === 'always' || (choice === 'kerrigan' && kerrigan);
}

/** The lists and the boxes as this run goes by them. `chat`: a chat's, whose git is the operator's. `kerrigan`: she directs it. */
export function runRules(cfg: ResolvedConfig, run: { chat: boolean; kerrigan: boolean }): RunRules {
  const e = cfg.execution;
  const denyPatterns = run.chat ? chatDenyPatterns(e.denyPatterns) : e.denyPatterns;
  if (!rulesIgnoredIn(e.ignoreRules, run.kerrigan)) {
    return { denyPatterns, allowedPrograms: e.allowedPrograms, scripts: e.scripts, writtenScripts: e.writtenScripts, rulesIgnored: false };
  }
  let policy: LockablePolicy = {
    mode: e.mode,
    allowedPrograms: [],
    denyPatterns: denyPatterns.filter(refusesGit),
    scripts: Object.fromEntries(SCRIPT_KINDS.map((k) => [k, { own: true, written: true }])) as ScriptRules,
    writtenScripts: 'run',
  };
  for (const lock of cfg.policyLocks ?? []) policy = applyPolicyLock(policy, lock).policy;
  return { denyPatterns: policy.denyPatterns, allowedPrograms: policy.allowedPrograms, scripts: policy.scripts!, writtenScripts: policy.writtenScripts!, rulesIgnored: true };
}

/**
 * What the chat is told of it in the opening, where the base prompt says otherwise; nothing when the rules are in force.
 * Only what holds: a lock that keeps a list, or the bot's scripts from running, is not said away.
 */
export function rulesNote(e: { rulesIgnored?: boolean; allowedPrograms: string[]; scripts: ScriptRules; writtenScripts: string }): string | undefined {
  if (!e.rulesIgnored) return undefined;
  const scripts = SCRIPT_KINDS.every((k) => e.scripts[k].written) && e.writtenScripts === 'run';
  return [
    '## Rules the operator has set aside in this run',
    '',
    'Where the base prompt says otherwise, this holds:',
    '',
    e.allowedPrograms.length === 0 ? '- **Any program may be started**: the list of allowed programs is not applied.' : '',
    '- **The list of refused commands is not applied** — except its Git commands: what pushes, rewrites history or throws work away stays refused.',
    scripts
      ? '- **The runner runs the scripts you write as part of the work itself**, with nobody asked: write such a file in one step and run it in the next, never both in one line. Never write a script only to run something: that goes in the step itself.'
      : '',
    scripts
      ? '- **Do not hand commands over** (`"status": "handoff"`) that the runner can run: send them as steps. Hand over only what needs the person themselves — a sign-in, a password, a device.'
      : '',
    '',
    'Everything else stands: the project\'s folders, the runner\'s own things, the repository\'s internals, the refused techniques, downloads, platforms and programs set to read only. A step refused for one of those is not to be written another way.',
  ]
    .filter((line, i, all) => line || (i > 0 && all[i - 1] !== ''))
    .join('\n');
}

/** Commands handed over that the runner can run itself go back to the chat, each once, and at most so many in a task. */
export const MAX_HANDOFF_RETURNS = 3;
export const HANDOFF_AS_STEPS =
  'Not shown to the operator: in this run the operator has set the runner\'s lists aside, and the runner runs these commands, and the scripts you wrote, itself. ' +
  'Send them as steps now, one command a step, and read what they print. Only when they need the person themselves — a sign-in, a password, a device — hand them over again, ' +
  'the same commands, and say in "why" what only the person can do.';
