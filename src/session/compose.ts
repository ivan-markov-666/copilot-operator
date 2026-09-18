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
};

const LEVEL2_HEADER = '## Project instructions (level 2)';
const TASK_HEADER = '## Task';

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
    const taskMessage = `${level2Block(input.level2)}\n\n${taskBlock}`;
    return {
      messages: [input.level1.trim(), taskMessage],
      firstMessage: `${input.level1.trim()}\n\n---\n\n${taskMessage}`,
    };
  }

  const reminder =
    `New task in this same conversation. The level 1 contract you received at the start of ` +
    `this conversation still applies unchanged: same format, same rules, same stop word, ` +
    `and a full "summary" when you finish. Step numbering restarts at 1.`;
  const taskMessage = `${reminder}\n\n${level2Block(input.level2)}\n\n${taskBlock}`;
  return { messages: [taskMessage], firstMessage: taskMessage };
}
