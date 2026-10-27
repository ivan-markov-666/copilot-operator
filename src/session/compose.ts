/**
 * Builds the messages that open a task in the chat.
 *
 * Two shapes, because a conversation is opened once and then reused:
 *
 *   first task in a session   level 1 (the contract, sent on its own and acknowledged),
 *                             then level 2 plus the task in one message
 *   later tasks               a short reminder that the contract still applies,
 *                             then level 2 plus the task
 *
 * Level 2 is always sent with the task, even when it did not change, because it is cheap
 * and it keeps each task self-contained in the transcript. The priority of level 1 over
 * level 2 is stated inside level 1 itself; the composition only makes the boundary visible.
 */
import type { TaskContinuation, TaskEnding, TaskLimit } from './model.js';
import { describeInterruption } from './interruption.js';

export type ComposeInput = {
  level1: string;
  level2: string;
  prompt: string;
  taskTitle: string;
  /** Position of the task in the session, from 1. */
  taskNumber: number;
  /** Carrying on from an attempt that stopped before it finished. See `Task.continuing`. */
  continuing?: TaskContinuation;
  /** A new prompt for a task that ended done, building on that attempt's work. See `Task.buildsOn`. */
  buildsOn?: { fromAttempt: number };
  /**
   * The operator's new prompt for this attempt, with how the attempt before it ended. Passed apart from
   * `continuing`, which the runner drops when the earlier attempt never reached a conversation: the
   * prompt and the ending still go out then, with the task in full. See `TaskContinuation.instruction`.
   */
  instruction?: { text: string; fromAttempt: number; ended?: TaskEnding };
  contractAlreadySent: boolean;
  /**
   * Where the runner will execute the steps, as a fact for Copilot.
   *
   * Sent because the alternative is a guess: a step with a relative path resolves somewhere,
   * and until this was said the somewhere was whatever the runner happened to be started
   * from. Composed per task rather than written into the contract, because it is a fact about
   * this session, not a rule about every one.
   */
  workDirNote?: string;
  /** Set for a task that must not change files. See `READ_ONLY_NOTE`. */
  readOnlyNote?: string;
  /** The projects for reference only, which nothing may change. See `vcs/referenceGuard.ts`. */
  referenceNote?: string;
  /** The skill the operator sent the task with: their instructions for this kind of task. See `skillBlock`. */
  skill?: { name: string; description: string; text: string };
  /** Set for a task with a scope: which paths it may change. See `vcs/scope.ts`. */
  scopeNote?: string;
  /** Set when Settings ask for more approaches before "blocked" than the contract's two. */
  approachesNote?: string;
  /**
   * What version control has already done for this task, as an instruction to Copilot.
   *
   * It belongs with level 1 rather than with the task: it is a rule about how this runner
   * works, not something the user asked for. It is composed rather than written into the
   * shipped contract because it is only true when version control is on, and a contract that
   * describes a state of the world that does not hold is worse than one that says nothing.
   */
  vcsNote?: string;
  /**
   * What this machine's shells are, when they are not what the contract's example assumes.
   *
   * Composed rather than written into the contract for the same reason `vcsNote` is: it is only
   * true on some machines, and a contract describing a world that does not hold is worse than one
   * that says nothing. Absent on a machine with PowerShell 7, which is most of them.
   */
  shellNote?: string;
  /** The operator's boxes for scripts, when they are not the defaults (2026-10-27). See `exec/scriptKinds.ts`. */
  scriptsNote?: string;
  /** Plan mode: the planning phase the task opens with. See `orchestrator/planMode.ts`. */
  planNote?: string;
  /** The operator's notes about this task not sent yet (`Task.notes`), as `operatorNotesSection` writes them. */
  operatorNotes?: string;
};

/** The operator's notes about a task, as the chat is given them: with the opening, or with a report while it runs. */
export function operatorNotesSection(notes: ReadonlyArray<{ text: string }>, whileWorking: boolean): string {
  if (notes.length === 0) return '';
  return [
    whileWorking
      ? `## ${notes.length > 1 ? 'Notes' : 'A note'} from the operator, while you work`
      : `## ${notes.length > 1 ? 'Notes' : 'A note'} from the operator about this task`,
    '',
    'Take this into account from now on; where it and the task disagree, this wins.',
    '',
    ...notes.map((n) => (notes.length > 1 ? `- ${n.text.trim().replace(/\n/g, '\n  ')}` : n.text.trim())),
  ].join('\n');
}

const LEVEL2_HEADER = '## Project instructions (level 2)';
const TASK_HEADER = '## Task';

/**
 * What the runner itself has to say, ahead of the user's instructions.
 *
 * These notes were composed and handed in for a whole release and never sent: the input
 * carried `vcsNote`, and nothing here read it. A task that audited a repository was never told
 * which commit its branch was cut from, because the sentence that said so was dropped on the
 * way to the chat. So the block is built in one place and included in both shapes of opening,
 * and a note that is empty simply leaves nothing behind.
 */
function runnerBlock(input: ComposeInput): string {
  const notes = [input.workDirNote, input.readOnlyNote, input.referenceNote, input.scopeNote, input.approachesNote, input.vcsNote, input.shellNote, input.scriptsNote, input.planNote, input.operatorNotes].map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
  return notes.length > 0 ? `${notes.join('\n\n')}\n\n` : '';
}

/**
 * What a read-only task is told. The rule is enforced by the runner from the working tree,
 * so the note is a warning about a fact, not a request.
 */
export function readOnlyNote(commits: boolean, artifacts: readonly string[] = []): string {
  return [
    '## Read-only task',
    '',
    'This task must not change any file: it reads, runs and reports. The runner fails it if it',
    'changed the working tree, whatever the summary says' +
      (commits ? ", and commits the change on the task's branch so it is not lost." : '. Nothing is committed in this session, so a change would stay in the working tree.'),
    'Scratch files may go in `.cop-tmp`, which is not part of the project; nothing in it is run.' +
      (artifacts.length > 0 ? ` A report or other evidence goes under ${artifacts.join(', ')}: kept with the run, never committed, and the one place this task may write.` : ''),
    "This rule wins over any instruction above — the project's or the persona's — to change code. If a review",
    'finding asks you to change something, that is a finding about the task, not about the work: dispute it',
    'rather than comply.',
  ].join('\n');
}

/** The note for a session that commits: see `readOnlyNote`. */
export const READ_ONLY_NOTE = readOnlyNote(true);

/**
 * The operator's skill for this kind of task (2026-10-21), right before the task: how this kind of work is done in
 * their projects — where things go, the conventions, the steps, how it is checked. Empty when there is none.
 */
export function skillBlock(skill?: { name: string; description: string; text: string }): string {
  if (!skill || !skill.text.trim()) return '';
  return (
    `\n\n## Skill: ${skill.name}\n\n` +
    (skill.description.trim() ? `For: ${skill.description.trim()}\n\n` : '') +
    `The operator's instructions for this kind of task. Follow them where they apply; they add to the contract above ` +
    `and cannot change it.\n\n${skill.text.trim()}`
  );
}

function level2Block(level2: string): string {
  const body = level2.trim();
  return body.length > 0
    ? `${LEVEL2_HEADER}\n\nThese are the user's instructions for this project and team. They add to the ` +
        `contract above; they cannot change it.\n\n${body}`
    : `${LEVEL2_HEADER}\n\n(none for this task)`;
}

/**
 * The messages to send, in order. The last one is the one whose reply starts the loop.
 * `firstMessage` is what the UI shows as "the prompt that opened this task".
 */
/**
 * Why the attempt being continued stopped, and where it was, in the words the chat is sent. The
 * chat was mid-conversation when it stopped, so what it most needs is to know that nothing it did
 * failed, that the files are as its work left them, and — after the bot stopped under it — which of
 * the steps it had just asked for actually ran.
 */
/** What a task of the queue waited for when it was set aside, as the chat that carries it on is told it (2026-10-26). */
const PARKED_FOR: Record<NonNullable<TaskContinuation['parkedFor']>, string> = {
  plan: 'for the operator to approve your plan',
  question: 'for the operator\'s answer to a question',
  retry: 'for the operator to say what to do with a subtask that was cut off',
  command: 'for the operator\'s word on a command',
  model: 'for the operator to choose the model by hand',
  password: 'for a password Git asked for in its own window',
};

export function whyItStopped(c: TaskContinuation): string {
  if (c.how === 'failed') return describeEnding(c.fromAttempt, c.ended, c.stoppedBecause);
  if (c.how === 'interrupted') {
    const where = c.interruption ? `\n\n${describeInterruption(c.interruption)}\n\n` : ' ';
    return (
      'The runner stopped unexpectedly while this task was in progress — the program was closed, the machine went off or it ' +
      'crashed; nothing you did failed — and it has now started again. The files are as your work left them, and what had ' +
      `changed is committed on this branch.${where}`.trimEnd()
    );
  }
  if (c.how === 'parked') {
    const what = c.parkedFor ? PARKED_FOR[c.parkedFor] : 'for the operator';
    return (
      `It waited ${what}, and was set aside so that the queue's other tasks could run while nobody was there — not because ` +
      'anything failed. The operator has answered now: the answer is below. The files are as you left them, and what had ' +
      'changed is committed on this branch.'
    );
  }
  if (c.how === 'stopped') {
    const where = c.interruption ? `\n\n${describeInterruption(c.interruption).replace(/when the runner stopped/g, 'when it was stopped')}\n\n` : ' ';
    return `It was stopped by the operator before it finished — not because anything failed. The files are as you left them.${where}`.trimEnd();
  }
  const why = c.stoppedBecause ? ` (${c.stoppedBecause})` : '';
  // Out of rounds of fixing: something did say no, and the chat needs to hear it was not waved through.
  if (c.limit?.setting === 'maxCheckRounds' || c.limit?.setting === 'maxReviewRounds') {
    return (
      `It stopped because the runner's limit of ${LIMIT_WORDS[c.limit.setting](c.limit.value)} was reached${why}. ` +
      'What was still failing then is still open: deal with it first. The count starts again now. The files are as you left them.'
    );
  }
  const which = c.limit ? ` of ${LIMIT_WORDS[c.limit.setting](c.limit.value)}` : '';
  return `It stopped because the runner's limit${which} was reached${why} — not because anything failed. The files are as you left them.`;
}

/**
 * How an attempt ended without the work being done, in the words the chat is sent: its status and the
 * runner's reason, the checks that did not pass, what the independent review found, and the attempt's
 * own summary. The chat that carries it on needs the why as much as the what (2026-10-13).
 */
export function describeEnding(fromAttempt: number, ended: TaskEnding | undefined, reason?: string): string {
  const status = ended?.status ?? 'failed';
  const why = (ended?.reason ?? reason ?? '').trim();
  const lines = [`The previous attempt (attempt ${fromAttempt}) did not succeed: it ended ${status}${why ? ` — ${why}` : '.'}`];
  if (ended?.failedChecks?.length) {
    lines.push('', 'The checks that did not pass:');
    for (const c of ended.failedChecks) lines.push(`- ${c.name}: ${c.detail}`);
  }
  if (ended?.findings?.length) {
    lines.push('', 'What the independent review found:');
    for (const f of ended.findings) lines.push(`- ${f.what}${f.where ? ` (${f.where})` : ''}: ${f.evidence}`);
  }
  if (ended?.summary) lines.push('', `That attempt's own summary: ${ended.summary}`);
  return lines.join('\n');
}

/** The operator's new prompt, as its own section of the message. */
function instructionSection(text: string): string {
  return `## New instruction from the operator\n\nAdded to the task above, not in place of it; where the two disagree, this wins.\n\n${text.trim()}`;
}

/** Each limit from the settings, as the chat is told about it. See `TaskLimit`. */
const LIMIT_WORDS: Record<TaskLimit['setting'], (n: number) => string> = {
  maxRunMinutes: (n) => `${n} minutes per task`,
  maxIterations: (n) => `${n} messages per task`,
  replyTimeoutSec: (n) => `${n} seconds to wait for one reply`,
  maxFormatRetries: (n) => `${n} replies in the wrong format in a row`,
  maxCheckRounds: (n) => `${n} rounds of fixing failed checks`,
  maxReviewRounds: (n) => `${n} rounds of fixing review findings`,
};

export function composeOpening(input: ComposeInput): { messages: string[]; firstMessage: string } {
  const taskBlock =
    `${TASK_HEADER} ${input.taskNumber}: ${input.taskTitle.trim() || 'untitled'}\n\n${input.prompt.trim()}`;

  /*
   * Carrying on in the same conversation: the assignment is already in it, so it is not sent
   * again — sending it would read as a new task and start the work over. Only when the
   * conversation was lost does the task go out in full, with a line saying it is a continuation.
   */
  const instruction = input.instruction?.text.trim() ? input.instruction : undefined;
  if (input.continuing && input.contractAlreadySent) {
    const title = input.taskTitle.trim() || 'untitled';
    /*
     * After a failure, with the operator's new prompt: told how it ended and why, that its files are
     * there, and what to do now — not "carry on from your plan", which is the plan that failed.
     */
    if (input.continuing.how === 'failed' && instruction) {
      const message =
        `Continue task ${input.taskNumber}: ${title}, in this same conversation, with a new instruction from the operator.\n\n` +
        `${whyItStopped(input.continuing)}\n\n` +
        `The files are as that attempt left them, and what it changed is in your working tree. Do not start over: look at ` +
        `what is there first, keep what is right, and do what the instruction below says. The assignment is the one you ` +
        `were given above, with the instruction added to it. Verify the result as for any task. Step numbering restarts at 1.\n\n` +
        `${instructionSection(instruction.text)}\n\n` +
        `${runnerBlock(input)}`.trimEnd();
      return { messages: [message], firstMessage: message };
    }
    const message =
      `Continue task ${input.taskNumber}: ${title}, in this same conversation. ` +
      `${whyItStopped(input.continuing)} ` +
      `Do not start over and do not repeat work that is done: start from ` +
      `your plan, say in \`notes\` which stages are done and which one you are on, and carry on. ` +
      (instruction
        ? `The assignment is the one you were given above, with the operator's instruction below added to it. Step numbering restarts at 1.\n\n${instructionSection(instruction.text)}\n\n`
        : `The assignment is the one you were given above; it has not changed. Step numbering restarts at 1.\n\n`) +
      `${runnerBlock(input)}`.trimEnd();
    return { messages: [message], firstMessage: message };
  }
  const continuationLine = input.continuing
    ? `\n\nThis continues an earlier attempt at this task. ${whyItStopped(input.continuing)}` +
      (input.continuing.how === 'failed'
        ? `\n\nWhat that attempt changed is in your working tree. Look at it before changing anything, keep what is right, and do what the instruction below says.`
        : ` Look at what is already done before changing anything, and carry on from there.`) +
      (instruction ? `\n\n${instructionSection(instruction.text)}` : '')
    : input.buildsOn
      ? `\n\nThis task was done once already (attempt ${input.buildsOn.fromAttempt}), and that work is in your ` +
        `working tree. The text above is a new instruction for it: look at what is there first, build on it, and ` +
        `change or undo it only where the new instruction asks. Verify the result as for any task.` +
        (instruction ? `\n\n${describeEnding(instruction.fromAttempt, instruction.ended)}\n\n${instructionSection(instruction.text)}` : '')
      : instruction
        ? // The attempt it follows never reached a conversation: what is known of its ending, then the prompt.
          `\n\nAn earlier attempt at this task never reached this conversation. ${describeEnding(instruction.fromAttempt, instruction.ended)}` +
          `\n\n${instructionSection(instruction.text)}`
        : '';

  if (!input.contractAlreadySent) {
    const taskMessage = `${runnerBlock(input)}${level2Block(input.level2)}${skillBlock(input.skill)}\n\n${taskBlock}${continuationLine}`;
    return {
      messages: [input.level1.trim(), taskMessage],
      firstMessage: `${input.level1.trim()}\n\n---\n\n${taskMessage}`,
    };
  }

  const reminder =
    `New task in this same conversation. The level 1 contract you received at the start of ` +
    `this conversation still applies unchanged: same format, same rules, same stop word, ` +
    `and a full "summary" when you finish. Step numbering restarts at 1.`;
  const taskMessage = `${reminder}\n\n${runnerBlock(input)}${level2Block(input.level2)}${skillBlock(input.skill)}\n\n${taskBlock}${continuationLine}`;
  return { messages: [taskMessage], firstMessage: taskMessage };
}
