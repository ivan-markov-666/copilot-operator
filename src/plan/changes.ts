/**
 * Kerrigan's answer about work that already exists (operator's request, 2026-10-14: "no dead end — the user
 * tells Kerrigan what happened and she proposes how to go on; even when the tasks are done she may judge the
 * implementation wrong and ask for more"). A plan only ever made new sessions, so everything she advised about
 * a session that had run had to be done by hand, or became a copy of it in a new chat.
 *
 * Two halves, both plain text so they work with any chat: `kerriganReport` writes what happened — each session
 * and task with its id, how it ended and why, what it changed — together with the operator's note and the exact
 * form of the answer; `checkChanges` reads her answer, a list of changes to those sessions and tasks, against
 * them as they are now, and says in words what each would do before anything is done. The service applies them
 * one by one through the same paths the buttons use, so a change is held to the same rules as a click.
 */
import { z } from 'zod';
import { TaskInput, extractJson, type PlanIssue } from './schema.js';
import { canFollowUp, clipText, isContinuable, type Session, type Task } from '../session/model.js';

const SessionRef = z.string({ error: 'Each change names its "session": the id from the report (s-…), or its exact name.' }).trim().min(1);
const TaskRef = z.union([z.string().trim().min(1), z.number().int().positive()], {
  error: 'Each change names its "task": the id from the report (t-…), its number in the session, or its exact title.',
});

export const ChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addTask'), session: SessionRef, after: TaskRef.optional(), task: TaskInput }),
  z.object({
    op: z.literal('editTask'),
    session: SessionRef,
    task: TaskRef,
    title: z.string().trim().min(3).max(120).optional(),
    prompt: z.string().trim().min(30, 'A new prompt needs a real instruction, not a few words.').optional(),
    checks: TaskInput.shape.checks.optional(),
    scope: TaskInput.shape.scope.optional(),
  }),
  z.object({ op: z.literal('removeTask'), session: SessionRef, task: TaskRef }),
  z.object({ op: z.literal('continue'), session: SessionRef, task: TaskRef, instruction: z.string().trim().min(10, 'Say what to do now: "instruction" is the new prompt the task carries on with.') }),
  z.object({ op: z.literal('newPrompt'), session: SessionRef, task: TaskRef, prompt: z.string().trim().min(30, 'A new prompt needs a real instruction, not a few words.') }),
  z.object({ op: z.literal('runAgain'), session: SessionRef, task: TaskRef, prompt: z.string().trim().min(30).optional() }),
  z.object({ op: z.literal('undo'), session: SessionRef, task: TaskRef, how: z.enum(['this', 'back'], { error: '"how" is "this" (take only this task\'s work out) or "back" (go back to before it, and queue the tasks after it too).' }) }),
  z.object({ op: z.literal('accept'), session: SessionRef, task: TaskRef, note: z.string().trim().optional() }),
  z.object({ op: z.literal('note'), session: SessionRef, task: TaskRef, text: z.string().trim().min(1) }),
], {
  error: (i) => (i.code === 'invalid_union' ? '"op" must be one of addTask, editTask, removeTask, continue, newPrompt, runAgain, undo, accept, note.' : undefined),
});

export type Change = z.infer<typeof ChangeSchema>;

export const ChangesSchema = z.object({
  version: z.literal(1, 'Set "version": 1.'),
  notes: z.string().trim().default(''),
  changes: z.array(ChangeSchema).min(1, 'An answer with "changes" needs at least one.'),
});

/** One change, found against the sessions as they are now, with what it would do in words. */
export type ResolvedChange = { index: number; change: Change; sessionId: string; sessionName: string; taskId?: string; taskTitle?: string; says: string };

export type ChangesCheck =
  | { ok: true; notes: string; changes: ResolvedChange[]; warnings: string[] }
  | { ok: false; issues: PlanIssue[]; warnings: string[] };

/** Whether the pasted text is an answer with changes rather than a plan of new sessions. */
export function looksLikeChanges(text: string): boolean {
  try {
    const raw = JSON.parse(extractJson(text ?? '')) as unknown;
    return !!raw && typeof raw === 'object' && Array.isArray((raw as { changes?: unknown }).changes);
  } catch {
    return false;
  }
}

const RUNNING = ['running', 'waiting-approval'];

function findSession(sessions: Session[], ref: string): Session | undefined {
  return sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.name === ref) ?? sessions.find((s) => s.name.toLowerCase() === ref.toLowerCase());
}

function findTask(session: Session, ref: string | number): Task | undefined {
  if (typeof ref === 'number' || /^\d+$/.test(ref)) return session.tasks[Number(ref) - 1];
  return session.tasks.find((t) => t.id === ref) ?? session.tasks.find((t) => t.title === ref) ?? session.tasks.find((t) => t.title.toLowerCase() === ref.toLowerCase());
}

/** Reads Kerrigan's answer and finds each change against the sessions as they are now. Nothing is changed. */
export function checkChanges(text: string, sessions: Session[]): ChangesCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text ?? ''));
  } catch (e) {
    return { ok: false, warnings: [], issues: [{ path: '', message: `This is not valid JSON: ${(e as Error).message}.` }] };
  }
  const parsed = ChangesSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, warnings: [], issues: parsed.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, ''), message: i.message })) };
  }
  const issues: PlanIssue[] = [];
  const warnings: string[] = [];
  const changes: ResolvedChange[] = [];
  parsed.data.changes.forEach((change, index) => {
    const path = `changes[${index}]`;
    const session = findSession(sessions, change.session);
    if (!session) {
      issues.push({ path: `${path}.session`, message: `No session "${change.session}". Use the id from the report (s-…) or the session's exact name.` });
      return;
    }
    const base = { index, change, sessionId: session.id, sessionName: session.name };
    if (change.op === 'addTask') {
      const after = change.after !== undefined ? findTask(session, change.after) : undefined;
      if (change.after !== undefined && !after) {
        issues.push({ path: `${path}.after`, message: `Session "${session.name}" has no task "${change.after}" to put the new one after.` });
        return;
      }
      changes.push({ ...base, says: `add task "${change.task.title}" to "${session.name}"${after ? `, after "${after.title}"` : ', at the end'}, queued` });
      return;
    }
    const task = findTask(session, change.task);
    if (!task) {
      issues.push({ path: `${path}.task`, message: `Session "${session.name}" has no task "${change.task}". Use the id from the report (t-…), its number, or its exact title.` });
      return;
    }
    const named = { ...base, taskId: task.id, taskTitle: task.title };
    const refuse = (message: string): void => {
      issues.push({ path: `${path}.op`, message: `"${task.title}" in "${session.name}" is ${task.status}: ${message}` });
    };
    if (RUNNING.includes(task.status)) return refuse('it is running now; nothing can be changed on it until it stops.');
    switch (change.op) {
      case 'editTask':
        if (task.status !== 'queued') return refuse('only a queued task is edited; for one that ran use "runAgain" with a "prompt", "continue" or "newPrompt".');
        changes.push({ ...named, says: `edit "${task.title}": ${['title', 'prompt', 'checks', 'scope'].filter((k) => (change as Record<string, unknown>)[k] !== undefined).join(', ') || 'nothing'}` });
        return;
      case 'removeTask':
        if (task.status !== 'queued') return refuse('only a queued task is removed; a task that ran keeps its record.');
        changes.push({ ...named, says: `remove the queued task "${task.title}"` });
        return;
      case 'continue':
        if (!isContinuable(task) && !canFollowUp(task)) return refuse('only a task that failed, blocked or stopped is carried on; for a done one use "newPrompt".');
        changes.push({ ...named, says: `carry "${task.title}" on in its own chat and branch, from where it got to, with the new prompt` });
        return;
      case 'newPrompt':
        if (task.status !== 'done') return refuse('"newPrompt" builds on a done task\'s work; for a failed one use "continue".');
        changes.push({ ...named, says: `give the done task "${task.title}" a new prompt that builds on its work, queued` });
        return;
      case 'runAgain':
        if (task.status === 'queued') return refuse('it is queued already; use "editTask" to change it.');
        changes.push({ ...named, says: `run "${task.title}" again from where it first started${change.prompt ? ', with a new prompt' : ''}, queued` });
        return;
      case 'undo':
        if (task.status === 'queued' || !task.startedAt) return refuse('it has not run since it was queued; there is nothing of it to undo.');
        changes.push({ ...named, says: change.how === 'this' ? `undo only "${task.title}": its work taken out, the tasks after it kept; it is queued again` : `go back to before "${task.title}": it and the tasks after it queued again` });
        return;
      case 'accept':
        if (!['failed', 'blocked', 'limit-reached', 'aborted'].includes(task.status)) return refuse('only a task that ended without being done is accepted as done.');
        changes.push({ ...named, says: `accept "${task.title}" as done${change.note ? ', with a note' : ''}` });
        return;
      case 'note':
        if (task.status !== 'queued') warnings.push(`The note for "${task.title}" (${task.status}) goes out only when it runs again.`);
        changes.push({ ...named, says: `a note to the chat for "${task.title}"` });
        return;
    }
  });
  if (issues.length > 0) return { ok: false, issues, warnings };
  return { ok: true, notes: parsed.data.notes, changes, warnings };
}

// --- the report ------------------------------------------------------------------------------

const clip = (s: string | undefined, n: number): string => (clipText(s, n) ?? '').replace(/\s+/g, ' ').trim();

function taskLines(task: Task, index: number): string[] {
  const out = [`${index + 1}. "${task.title}" — id ${task.id} — ${task.status}${(task.attempt ?? 1) > 1 ? `, attempt ${task.attempt}` : ''}`];
  if (task.accepted) out.push(`   accepted as done by the operator (it had ended ${task.accepted.was})${task.accepted.note ? `: ${clip(task.accepted.note, 300)}` : ''}`);
  const undone = task.attempts?.at(-1)?.undone;
  if (task.status === 'queued' && undone) out.push(`   its last attempt was undone by the operator (${undone.how === 'this' ? 'only its work taken out' : 'back to before it'})`);
  if (task.continuing?.instruction) out.push(`   carried on with the operator's prompt: ${clip(task.continuing.instruction, 400)}`);
  if (task.status === 'queued') out.push(`   prompt: ${clip(task.prompt, 500)}`);
  if (task.summary && task.status !== 'queued') out.push(`   summary: ${clip(task.summary, 600)}`);
  if (task.reason && task.reason !== task.summary && task.status !== 'done') out.push(`   why it stopped: ${clip(task.reason, 600)}`);
  const failed = (task.checkResults ?? []).filter((c) => !c.passed);
  if (failed.length > 0) out.push(`   checks that did not pass: ${failed.slice(0, 6).map((c) => `${c.name} (${clip(c.detail, 160)})`).join('; ')}`);
  if (task.review?.verdict) {
    const findings = (task.review.findings ?? []).slice(0, 5).map((f) => `${clip(f.what, 200)}${f.where ? ` [${clip(f.where, 80)}]` : ''}`);
    out.push(`   review: ${task.review.verdict}${findings.length > 0 ? ` — ${findings.join('; ')}` : ''}`);
  }
  const files = (task.vcs?.files ?? []).map((f) => f.path);
  if (files.length > 0) out.push(`   changed: ${files.slice(0, 25).join(', ')}${files.length > 25 ? ` and ${files.length - 25} more` : ''}`);
  if (task.vcs?.branch) out.push(`   branch ${task.vcs.branch}${task.vcs.commit ? ` at ${task.vcs.commit.slice(0, 8)}` : ''}`);
  const notes = task.notes ?? [];
  if (notes.length > 0) out.push(`   operator's notes: ${notes.slice(-3).map((n) => clip(n.text, 200)).join(' | ')}`);
  return out;
}

/**
 * What happened, for Kerrigan: the sessions, each task with its id, how it ended and why, and what it changed;
 * the operator's note; and the exact form of the answer. Plain text, for any chat.
 */
export function kerriganReport(sessions: Session[], opts: { note?: string; taskIds?: string[]; at?: string } = {}): string {
  const only = new Set(opts.taskIds ?? []);
  const lines: string[] = [
    '# What happened — for Kerrigan',
    '',
    `The operator sends you the state of their work as copilot-operator recorded it (${opts.at ?? new Date().toISOString()}), and asks you to look at it`,
    'and propose how to go on — whether the tasks failed, stopped, or are done but not what was meant.',
    '',
  ];
  if (opts.note?.trim()) lines.push('## The operator says', '', opts.note.trim(), '');
  for (const s of sessions) {
    const vcs = s.vcs?.enabled ? `${s.vcs.branchMode === 'per-task' ? 'a branch per task' : 'one branch for the session, a commit per task'} in ${s.vcs.repoDir || '(no folder)'}` : 'no version control';
    lines.push(`## Session "${s.name}" — id ${s.id}`, '', `${vcs}; ${s.onFailure === 'continue' ? 'independent tasks' : 'one chain: a failed task stops the ones after it'}.`, '');
    s.tasks.forEach((t, i) => {
      if (only.size > 0 && !only.has(t.id)) return;
      lines.push(...taskLines(t, i));
    });
    lines.push('');
  }
  lines.push(
    '## How to answer',
    '',
    'First tell the operator, in their language and in a few sentences, what you think happened and what you propose.',
    'Then give the changes as one JSON object in a ```json block, which the operator pastes on the import page;',
    'it shows each change in words before anything is done. Name sessions and tasks by the ids above.',
    '',
    '```json',
    '{"version": 1, "notes": "why, in one or two sentences", "changes": [',
    '  {"op": "continue", "session": "s-…", "task": "t-…", "instruction": "what to do now — the task goes on from where it got to, in its own chat and branch"},',
    '  {"op": "addTask", "session": "s-…", "after": "t-…", "task": {"title": "…", "prompt": "…", "expected": "…", "checks": [], "scope": []}}',
    ']}',
    '```',
    '',
    'The changes, one object each:',
    '- "continue" {task, instruction} — a task that failed, blocked or stopped goes on from where it got to, with your prompt added to its own.',
    '- "newPrompt" {task, prompt} — a done task gets a new prompt that builds on its work (more to do, or done wrong).',
    '- "runAgain" {task, prompt?} — a task that ran starts over from where it first started, optionally with a corrected prompt; its earlier work is not used.',
    '- "undo" {task, how} — "this": only this task\'s work is taken out of the session\'s branch, the tasks after it kept; "back": the branch goes back to before it, and it and the tasks after it are queued again. Nothing is deleted.',
    '- "accept" {task, note?} — a task that did not end done is accepted as done (for example, the operator finished it by hand).',
    '- "addTask" {task, after?} — a new task in an existing session, after the task named (else at the end); "task" has the fields of a plan\'s task.',
    '- "editTask" {task, title?, prompt?, checks?, scope?} — a queued task, changed before it runs.',
    '- "removeTask" {task} — a queued task that is no longer wanted.',
    '- "note" {task, text} — information for the chat about a task, sent with its next message.',
    '',
    'Nothing runs by itself after the import: the operator starts the run. For work that belongs in a new session, answer with a plan as before.',
  );
  return lines.join('\n');
}
