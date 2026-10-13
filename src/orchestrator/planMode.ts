/**
 * Plan mode: what the chat is told, and how a plan is written down (asked for on 2026-10-13).
 *
 * The operator asked for a plan before every task: look at the code base, at what is already there,
 * and only then begin. The contract already asked for "a short numbered plan in `notes`" in the first
 * reply — but in the same reply as the first steps, so the work had begun before the plan was read by
 * anybody, and nothing kept the plan apart, showed it, or held the work to it. In plan mode the task
 * opens with a phase of its own: read-only steps, then a reply with status "plan" and nothing else; the
 * work begins only once the plan is approved — by the operator, or by the runner — and the independent
 * review is given the plan to check the work against. See `PlanMode` in session/model.ts.
 *
 * The texts are here, apart from the loop, so a check can hold them.
 */
import type { PlanMode, TaskPlan } from '../session/model.js';
import type { PlanReply } from '../protocol/replySchema.js';

/** Planning rounds after which the chat is reminded that a plan is what ends the phase. */
export const PLAN_NUDGE_AFTER = 12;

/** What the opening message says about the phase, for a task in plan mode. */
export function planModeNote(mode: Exclude<PlanMode, 'off'>, enforced: boolean, asks: boolean): string {
  return [
    '## Plan first (plan mode)',
    '',
    'Before you change anything in this task, look at the project and make a plan. In this phase you only',
    'read: list the folders, open the files the task touches, read the git log, search for what the task',
    'names — find what is already implemented, what is missing and what a change would affect.',
    enforced
      ? 'Change nothing yet: the runner puts back any change made in this phase, and tells you.'
      : 'Change nothing yet: nothing in this phase may change a file.',
    'When you have seen enough, reply with status "plan" and no steps:',
    '',
    '```json',
    '{"status": "plan", "notes": "…", "plan": {"existing": "what is already there that the task touches: files, functions, behaviour", "approach": "how you will do it", "steps": ["first stage", "second stage"], "files": ["the files you will create or change"], "verification": "how you will show the result works", "risks": "risks and open questions"}}',
    '```',
    '',
    mode === 'approve' && asks
      ? 'The operator reads the plan, and approves it or asks for another with what to change.'
      : 'The runner approves the plan and tells you so.',
    'Begin the work only once you are told the plan is approved. Then carry it out; when it has to change,',
    'say so in `notes` and why. The independent review checks the work against the approved plan.',
  ].join('\n');
}

/** The plan as the chat gave it, recorded. */
export function planFrom(reply: PlanReply, version: number, revisions: TaskPlan['revisions'] = []): TaskPlan {
  return {
    existing: reply.existing.trim(),
    approach: reply.approach.trim(),
    steps: reply.steps.map((x) => x.trim()).filter(Boolean),
    files: reply.files.map((x) => x.trim()).filter(Boolean),
    verification: reply.verification.trim(),
    ...(reply.risks?.trim() ? { risks: reply.risks.trim() } : {}),
    version,
    at: new Date().toISOString(),
    ...(revisions.length > 0 ? { revisions } : {}),
  };
}

/** The plan in words: for the record, the reviewer and the approval card's plain-text form. */
export function describePlan(plan: Pick<TaskPlan, 'existing' | 'approach' | 'steps' | 'files' | 'verification' | 'risks'>): string {
  return [
    `What is already there: ${plan.existing}`,
    `Approach: ${plan.approach}`,
    'Stages:',
    ...plan.steps.map((x, i) => `${i + 1}. ${x}`),
    ...(plan.files.length > 0 ? [`Files it will create or change: ${plan.files.join(', ')}`] : []),
    `Verification: ${plan.verification}`,
    ...(plan.risks ? [`Risks and open questions: ${plan.risks}`] : []),
  ].join('\n');
}

/** Approved: the work begins. */
export function planApprovedMessage(approval: NonNullable<TaskPlan['approved']>): string {
  const by =
    approval.by === 'operator'
      ? 'The operator approved your plan.'
      : `Your plan is approved by the runner${approval.why ? ` (${approval.why})` : ''}.`;
  return [
    by,
    ...(approval.note?.trim() ? ['', 'With this from the operator, which wins where it and the plan disagree:', '', approval.note.trim()] : []),
    '',
    'Carry it out now: reply with status "continue" and the steps of its first stage. Keep to the plan; when it',
    'has to change, say so in `notes` and why — a change the plan did not foresee is declared, not hidden.',
    'Verify the result as the plan says before you report done. Step numbering restarts at 1.',
  ].join('\n');
}

/** The operator asked for another plan. */
export function planReviseMessage(comment: string, version: number): string {
  return [
    `The operator read version ${version} of your plan and asks for another. What to change:`,
    '',
    comment.trim(),
    '',
    'You are still in the planning phase: change nothing. Look at what you need to, then reply with status',
    '"plan" and the whole revised plan — not only what changed.',
  ].join('\n');
}

/** A plan sent when none is asked for: the phase is over, or the session is not in plan mode. */
export const PLAN_NOT_NOW =
  'No plan is asked for now: the planning phase is over and the plan stands. Carry on with the work — reply with status ' +
  '"continue" and steps, or end the task. When the plan has to change, say so in `notes` and why.';

/** "done" in the planning phase: nothing has been done yet. */
export const PLAN_FIRST =
  'Not yet: this task is in the planning phase, and nothing has been changed. Reply with status "plan" and the plan; ' +
  'the work begins once it is approved.';

/** Said after many planning rounds. */
export function planNudge(rounds: number): string {
  return `You have read the project for ${rounds} rounds in the planning phase. Send the plan now, with status "plan"; what you have not looked at yet can go under "risks".`;
}

/** The plan section of the reviewer's brief. */
export function planForReviewer(plan: TaskPlan): string {
  return [
    '## The plan the work was to follow',
    '',
    `The implementer made this plan before it changed anything, and it was approved${plan.approved?.by === 'operator' ? ' by the operator' : ''}.`,
    'Check that the work follows it: a stage left out, a file changed that the plan does not name, or another',
    'approach — none of them declared in the implementer\'s notes or deviations with a reason — is a finding',
    'with "about": "work". A departure the implementer declared and justified is not a fault in itself; judge',
    'whether the reason holds. The work is still judged against the task as written first.',
    ...(plan.approved?.note ? ['', `The operator added: ${plan.approved.note}`] : []),
    '',
    describePlan(plan),
  ].join('\n');
}
