/**
 * Who decides whether a step runs.
 *
 * The static rules (deny list, script extensions) are the same everywhere and live in
 * `policy.ts`. What differs is the human part: at the terminal it is a keypress, in the web
 * UI it is a button, and in unattended mode there is none. That difference is this interface,
 * so the runner does not know or care which one it is talking to.
 */
import type { Step } from '../protocol/replySchema.js';
import { staticCheck, describeStep, type PolicyConfig, type PolicyDecision } from './policy.js';
import type { Confinement } from './confinement.js';
import { networkFetchReason, networkFetchRefusal } from './network.js';
import { scriptNetworkReason } from './policy.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export type AuthorizeContext = {
  sessionId?: string;
  taskId?: string;
  iteration: number;
  /** The project folders and where the step runs. See `confinement.ts`. */
  confinement?: Confinement;
};

export interface StepAuthorizer {
  authorize(step: Step, ctx: AuthorizeContext): Promise<PolicyDecision>;
}

/**
 * Why a step is being put to a person even though nobody would normally be asked — today only a
 * command that fetches from the network (see `network.ts`). Absent for an ordinary confirm-mode
 * question.
 */
export type HeldFor = { network: string };

export type Ask = (step: Step, ctx: AuthorizeContext, held?: HeldFor) => Promise<PolicyDecision>;

/**
 * Runs the static rules, then, unless unattended, asks the human through `ask`.
 *
 * A step that fetches from the network is the exception to "unless unattended": by default it is
 * asked about in every mode, with `held` saying why, because the runs nobody is watching are
 * exactly the ones in which a download followed by a second step that runs it would otherwise go
 * unseen. The operator may choose otherwise for unattended runs (`cfg.networkFetch`): `refuse`
 * answers the chat at once instead of waiting for anybody, `run` treats the fetch like any other
 * step. Only for unattended runs — a watched run shows the fetch like every other step, and the
 * person reading it is the whole point of watching. `cfg` is read on every call, not captured, so
 * a run switched to unattended half-way is judged as one from its next step on.
 *
 * `signal` is the run's Stop, and it is asked first, before any rule and before the mode: a step
 * proposed after Stop is aborted in every mode. It used to be asked only inside `ask`, which an
 * unattended run never reaches, so in a run started unattended — or switched to it by "run the rest
 * without asking" — a Stop that landed between the runner's own look at the signal and this answer
 * let one more step run.
 */
export function makeAuthorizer(cfg: PolicyConfig, ask: Ask, signal?: AbortSignal): StepAuthorizer {
  return {
    async authorize(step, ctx) {
      if (signal?.aborted) return { action: 'abort', reason: 'stopped by the operator', by: 'operator' };
      const blocked = staticCheck(step, cfg, undefined, ctx.confinement);
      if (blocked) return blocked;
      const cwd = ctx.confinement?.cwd;
      const network = networkFetchReason(step.cmd, cwd) ?? (cwd ? scriptNetworkReason(step.cmd, cwd) : null);
      if (network) {
        if (cfg.mode === 'unattended' && cfg.networkFetch === 'refuse') return { action: 'skip', reason: networkFetchRefusal(network) };
        if (cfg.mode === 'unattended' && cfg.networkFetch === 'run') return { action: 'run' };
        return await ask(step, ctx, { network });
      }
      if (cfg.mode === 'unattended') return { action: 'run' };
      return await ask(step, ctx);
    },
  };
}

/** The terminal version: Enter runs, `s` skips, `q` aborts. */
export function terminalAuthorizer(cfg: PolicyConfig, print: (s: string) => void): StepAuthorizer {
  return makeAuthorizer(cfg, async (step, _ctx, held) => {
    print('');
    print(`  step ${step.id}: ${describeStep(step)}`);
    if (held) print(`  held: ${held.network}`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question('  [Enter] run  [s] skip  [q] abort > ')).trim().toLowerCase();
      if (answer === 'q') return { action: 'abort', reason: 'aborted by the operator', by: 'operator' };
      if (answer === 's') return { action: 'skip', reason: 'skipped by the operator', by: 'operator' };
      return { action: 'run' };
    } finally {
      rl.close();
    }
  });
}

/**
 * Everything runs after the static rules. Only for runs the user explicitly marked so.
 *
 * A step held for a person (a network fetch) is refused here, with the reason, because this form
 * has nobody to ask — `ask` and `refuse` come to the same thing at a terminal nobody is at. Only
 * `networkFetch: run` lets one through, and that is decided in `makeAuthorizer` before this is
 * reached. The web UI does not use it: its unattended runs keep the approval screen for exactly
 * those steps.
 */
export function unattendedAuthorizer(cfg: PolicyConfig): StepAuthorizer {
  return makeAuthorizer({ ...cfg, mode: 'unattended' }, async (_step, _ctx, held) =>
    held ? { action: 'skip', reason: networkFetchRefusal(held.network) } : { action: 'run' },
  );
}
