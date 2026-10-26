/**
 * Who decides whether a step runs.
 *
 * The static rules (deny list, script extensions) are the same everywhere and live in
 * `policy.ts`. What differs is the human part: at the terminal it is a keypress, in the web
 * UI it is a button, and in unattended mode there is none. That difference is this interface,
 * so the runner does not know or care which one it is talking to.
 */
import type { Step } from '../protocol/replySchema.js';
import type { Actor } from '../session/model.js';
import { staticCheck, describeStep, type PolicyConfig, type PolicyDecision } from './policy.js';
import type { Confinement } from './confinement.js';
import { networkFetchReason, networkFetchRefusal } from './network.js';
import { scriptNetworkReason } from './policy.js';
import { platformOf, platformReason } from './platforms.js';
import { readOnlyUnclearRefusal, readOnlyVerdict } from './readOnly.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export type AuthorizeContext = {
  sessionId?: string;
  taskId?: string;
  iteration: number;
  /** The project folders and where the step runs. See `confinement.ts`. */
  confinement?: Confinement;
  /** Whose step it is: the chat writing its plan, the worker or the reviewer — the card says so (2026-10-22). */
  actor?: Actor;
};

export interface StepAuthorizer {
  authorize(step: Step, ctx: AuthorizeContext): Promise<PolicyDecision>;
}

/**
 * Why a step is being put to a person even though nobody would normally be asked — today only a
 * command that fetches from the network (see `network.ts`). Absent for an ordinary confirm-mode
 * question.
 */
export type HeldFor = {
  network?: string;
  platform?: string;
  /** A program set to read only, whose command could not be read as only reading: why (`readOnly.ts`, 2026-10-26). */
  readOnly?: string;
  /** That program. */
  readOnlyProgram?: string;
};

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
      /*
       * A platform reached with the operator's access (2026-10-23): asked in every mode, unless Settings agree to it. A
       * program set to read only (2026-10-26) is not asked about when the line only reads with it; when it cannot be
       * read as reading, it is asked about in every mode, Settings' agreement or not — the operator said it must not write.
       */
      const reading = readOnlyVerdict(step.cmd, step.shell, cfg.readOnlyPrograms);
      const unclear = reading?.kind === 'unclear' ? reading : null;
      const platform = unclear
        ? (platformReason(step.cmd, step.shell) ?? platformOf(unclear.program) ?? unclear.program)
        : cfg.platformAccess === 'allow'
          ? null
          : platformReason(step.cmd, step.shell, reading?.kind === 'reads' ? new Set(reading.programs) : undefined);
      const held: HeldFor = { ...(platform ? { platform } : {}), ...(unclear ? { readOnly: unclear.why, readOnlyProgram: unclear.program } : {}) };
      if (network) {
        if (cfg.mode === 'unattended' && cfg.networkFetch === 'refuse') return { action: 'skip', reason: networkFetchRefusal(network) };
        if (!platform && cfg.mode === 'unattended' && cfg.networkFetch === 'run') return { action: 'run' };
        return await ask(step, ctx, { network, ...held });
      }
      if (platform) return await ask(step, ctx, held);
      if (cfg.mode === 'unattended') return { action: 'run' };
      return await ask(step, ctx);
    },
  };
}

/** What the chat is told when a command to a platform was held and nobody was there to allow it. */
export function platformRefusal(platform: string): string {
  return (
    `refused: this command reaches ${platform} with the operator's access, which only the operator may allow, and this run has ` +
    'nobody to ask. Do the work without it, or say in `notes` what is needed there and end `blocked`.'
  );
}

/** The terminal version: Enter runs, `s` skips, `q` aborts. */
export function terminalAuthorizer(cfg: PolicyConfig, print: (s: string) => void): StepAuthorizer {
  return makeAuthorizer(cfg, async (step, _ctx, held) => {
    print('');
    print(`  step ${step.id}: ${describeStep(step)}`);
    if (held?.network) print(`  held: ${held.network}`);
    if (held?.platform) print(`  held: it reaches ${held.platform} with your access`);
    if (held?.readOnly) print(`  held: ${held.readOnlyProgram ?? 'the program'} is set to read only, and this could not be read as only reading (${held.readOnly})`);
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
    held?.network
      ? { action: 'skip', reason: networkFetchRefusal(held.network) }
      : held?.readOnly
        ? { action: 'skip', reason: readOnlyUnclearRefusal(held.readOnlyProgram ?? 'the program', held.readOnly) }
        : held?.platform
          ? { action: 'skip', reason: platformRefusal(held.platform) }
          : { action: 'run' },
  );
}
