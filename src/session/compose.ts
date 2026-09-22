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

export type ComposeInput = {
  level1: string;
  level2: string;
  prompt: string;
  taskTitle: string;
  /** Position of the task in the session, from 1. */
  taskNumber: number;
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
  const notes = [input.workDirNote, input.readOnlyNote, input.vcsNote, input.shellNote].map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
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
export function composeOpening(input: ComposeInput): { messages: string[]; firstMessage: string } {
  const taskBlock =
    `${TASK_HEADER} ${input.taskNumber}: ${input.taskTitle.trim() || 'untitled'}\n\n${input.prompt.trim()}`;

  if (!input.contractAlreadySent) {
    const taskMessage = `${runnerBlock(input)}${level2Block(input.level2)}\n\n${taskBlock}`;
    return {
      messages: [input.level1.trim(), taskMessage],
      firstMessage: `${input.level1.trim()}\n\n---\n\n${taskMessage}`,
    };
  }

  const reminder =
    `New task in this same conversation. The level 1 contract you received at the start of ` +
    `this conversation still applies unchanged: same format, same rules, same stop word, ` +
    `and a full "summary" when you finish. Step numbering restarts at 1.`;
  const taskMessage = `${reminder}\n\n${runnerBlock(input)}${level2Block(input.level2)}\n\n${taskBlock}`;
  return { messages: [taskMessage], firstMessage: taskMessage };
}
