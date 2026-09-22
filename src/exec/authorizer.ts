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
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export type AuthorizeContext = {
  sessionId?: string;
  taskId?: string;
  iteration: number;
  scriptPath?: string;
  /**
   * The downloaded script's own text, when the step is about to run one.
   *
   * Approval used to be shown the file's name and nothing else — `[download] collect-logs.ps1
   * (run with pwsh)` — which is exactly as much as the automated gate could see, and exactly
   * the reason neither of them noticed what was inside. A person cannot approve a decision
   * they were not shown, and asking them to approve a file name is asking them to approve a
   * file name.
   */
  scriptBody?: string;
};

export interface StepAuthorizer {
  authorize(step: Step, ctx: AuthorizeContext): Promise<PolicyDecision>;
}

/** Runs the static rules, then, unless unattended, asks the human through `ask`. */
export function makeAuthorizer(
  cfg: PolicyConfig,
  ask: (step: Step, ctx: AuthorizeContext) => Promise<PolicyDecision>,
): StepAuthorizer {
  return {
    async authorize(step, ctx) {
      const blocked = staticCheck(step, cfg);
      if (blocked) return blocked;
      if (cfg.mode === 'unattended') return { action: 'run' };
      return await ask(step, ctx);
    },
  };
}

/** The terminal version: Enter runs, `s` skips, `q` aborts. */
export function terminalAuthorizer(cfg: PolicyConfig, print: (s: string) => void): StepAuthorizer {
  return makeAuthorizer(cfg, async (step, ctx) => {
    print('');
    print(`  step ${step.id}: ${describeStep(step, ctx.scriptPath)}`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question('  [Enter] run  [s] skip  [q] abort > ')).trim().toLowerCase();
      if (answer === 'q') return { action: 'abort', reason: 'aborted by the operator' };
      if (answer === 's') return { action: 'skip', reason: 'skipped by the operator' };
      return { action: 'run' };
    } finally {
      rl.close();
    }
  });
}

/** Everything runs after the static rules. Only for runs the user explicitly marked so. */
export function unattendedAuthorizer(cfg: PolicyConfig): StepAuthorizer {
  return makeAuthorizer({ ...cfg, mode: 'unattended' }, async () => ({ action: 'run' }));
}
