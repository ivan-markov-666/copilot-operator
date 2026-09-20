/**
 * Whether a message the runner sent is the one the chat now shows as its newest.
 *
 * The second of two acceptance signals. The first is the conversation's size as the app
 * reports it; this one is what a person would check — the newest user bubble says what was
 * just typed — and it is what keeps a retry from sending a message that already landed. A
 * message is judged to have landed when the newest user text changed since before the send
 * and now begins with what was sent, compared on collapsed whitespace and the first stretch
 * only, because the page renders attachments and links inside the same bubble.
 */

const HEAD_CHARS = 120;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The part of a sent message that the newest user bubble is expected to begin with. */
export function sentTextHead(text: string): string {
  return collapse(text).slice(0, HEAD_CHARS);
}

/**
 * True when the newest user message is the one that was sent.
 *
 * `shownBefore` is what the newest user message said before sending; requiring it to have
 * changed is what stops an earlier message that happens to start the same way — two review
 * rounds' findings messages do — from counting as this one.
 */
export function landed(sentText: string, shownNow: string, shownBefore: string): boolean {
  const head = sentTextHead(sentText);
  if (head.length === 0) return false;
  const now = collapse(shownNow);
  if (now.length === 0 || now === collapse(shownBefore)) return false;
  return now.startsWith(head);
}
