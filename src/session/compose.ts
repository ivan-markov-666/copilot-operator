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
import type { TaskContinuation } from './model.js';
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
  /** Set for a task with a scope: which paths it may change. See `vcs/scope.ts`. */
  scopeNote?: string;
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
};

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
  const notes = [input.workDirNote, input.readOnlyNote, input.scopeNote, input.vcsNote, input.shellNote].map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
  return notes.length > 0 ? `${notes.join('\n\n')}\n\n` : '';
}

/**
 * What a read-only task is told. The rule is enforced by the runner from the working tree,
 * so the note is a warning about a fact, not a request.
 */
export const READ_ONLY_NOTE = [
  '## Read-only task',
  '',
  'This task must not change any file: it reads, runs and reports. The runner fails it if the',
  'working tree has changed when it ends, whatever the summary says, and commits the change on',
  "the task's branch so it is not lost. If a review finding asks you to change something, that",
  'is a finding about the task, not about the work: dispute it rather than comply.',
].join('\n');

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
function whyItStopped(c: TaskContinuation): string {
  if (c.how === 'interrupted') {
    const where = c.interruption ? `\n\n${describeInterruption(c.interruption)}\n\n` : ' ';
    return (
      'The runner stopped unexpectedly while this task was in progress — the program was closed, the machine went off or it ' +
      'crashed; nothing you did failed — and it has now started again. The files are as your work left them, and what had ' +
      `changed is committed on this branch.${where}`.trimEnd()
    );
  }
  if (c.how === 'stopped') {
    return 'It was stopped by the operator before it finished — not because anything failed. The files are as you left them.';
  }
  const why = c.stoppedBecause ? ` (${c.stoppedBecause})` : '';
  return `It stopped because the runner's limit was reached${why} — not because anything failed. The files are as you left them.`;
}

export function composeOpening(input: ComposeInput): { messages: string[]; firstMessage: string } {
  const taskBlock =
    `${TASK_HEADER} ${input.taskNumber}: ${input.taskTitle.trim() || 'untitled'}\n\n${input.prompt.trim()}`;

  /*
   * Carrying on in the same conversation: the assignment is already in it, so it is not sent
   * again — sending it would read as a new task and start the work over. Only when the
   * conversation was lost does the task go out in full, with a line saying it is a continuation.
   */
  if (input.continuing && input.contractAlreadySent) {
    const message =
      `Continue task ${input.taskNumber}: ${input.taskTitle.trim() || 'untitled'}, in this same conversation. ` +
      `${whyItStopped(input.continuing)} ` +
      `Do not start over and do not repeat work that is done: start from ` +
      `your plan, say in \`notes\` which stages are done and which one you are on, and carry on. ` +
      `The assignment is the one you were given above; it has not changed. Step numbering restarts at 1.\n\n` +
      `${runnerBlock(input)}`.trimEnd();
    return { messages: [message], firstMessage: message };
  }
  const continuationLine = input.continuing
    ? `\n\nThis continues an earlier attempt at this task. ${whyItStopped(input.continuing)} ` +
      `Look at what is already done before changing anything, and carry on from there.`
    : input.buildsOn
      ? `\n\nThis task was done once already (attempt ${input.buildsOn.fromAttempt}), and that work is in your ` +
        `working tree. The text above is a new instruction for it: look at what is there first, build on it, and ` +
        `change or undo it only where the new instruction asks. Verify the result as for any task.`
      : '';

  if (!input.contractAlreadySent) {
    const taskMessage = `${runnerBlock(input)}${level2Block(input.level2)}\n\n${taskBlock}${continuationLine}`;
    return {
      messages: [input.level1.trim(), taskMessage],
      firstMessage: `${input.level1.trim()}\n\n---\n\n${taskMessage}`,
    };
  }

  const reminder =
    `New task in this same conversation. The level 1 contract you received at the start of ` +
    `this conversation still applies unchanged: same format, same rules, same stop word, ` +
    `and a full "summary" when you finish. Step numbering restarts at 1.`;
  const taskMessage = `${reminder}\n\n${runnerBlock(input)}${level2Block(input.level2)}\n\n${taskBlock}${continuationLine}`;
  return { messages: [taskMessage], firstMessage: taskMessage };
}
