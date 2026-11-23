/**
 * How Kerrigan's messages run, as the person chose it (operator, 2026-11-23: "let the user decide how the task is
 * developed — whether Kerrigan uses plan mode, two chats, the review, or none of them; and an automatic mode, as Kerrigan
 * judges"; "yes, the skill too"; "yes, a change while she works reaches the next new chat").
 *
 * Each of plan mode, two chats and the review is automatic (hers to choose for each message), or fixed by the person on or
 * off; the skill is hers, or the one the person chose for the task, or none. What the person fixed is the runner's to
 * enforce, not hers to remember: her "send" is carried out with the person's choice whatever she wrote, and she is told
 * where hers was changed. Nothing is sent back to her for it — a reply sent back is one more round, and the goal is the
 * fewest stops.
 */
import type { KerriganReply } from '../protocol/kerriganSchema.js';
import type { KerriganHow } from '../session/model.js';

export type FixedKey = 'planMode' | 'twoChats' | 'review' | 'skill';

/** The skill as the person chose it for the task: a name (every message with it), none, or hers to choose. */
export type SkillFixed = { name: string } | 'none' | undefined;

export type Fixing = {
  /** Her reply, with the person's choices in it. */
  reply: KerriganReply;
  /** Which of the four the person fixed. */
  fixed: FixedKey[];
  /** Where hers was changed, as she is told it. */
  changed: string[];
};

/**
 * Her "send", carried out as the person chose. `lastTwoChats`: whether the chat she sent to last is one of two chats —
 * undefined when there is none. Two chats is how a chat begins, so a message to the "same" chat keeps its kind: the
 * person's choice reaches her next "new" chat.
 */
export function fixedByPerson(r: KerriganReply, how: KerriganHow | undefined, skill: SkillFixed, lastTwoChats: boolean | undefined): Fixing {
  const reply: KerriganReply = { ...r };
  const fixed: FixedKey[] = [];
  const changed: string[] = [];
  const set = (key: 'planMode' | 'twoChats' | 'review', to: boolean, note?: string): void => {
    fixed.push(key);
    if (!!reply[key] !== to) changed.push(`"${key}": ${to} (you wrote ${!!reply[key]})${note ? ` — ${note}` : ''}`);
    reply[key] = to;
  };
  if (how?.planMode) set('planMode', how.planMode === 'on');
  if (how?.twoChats) {
    const want = how.twoChats === 'on';
    if (reply.chat === 'same' && lastTwoChats !== undefined) {
      // The chat she carries on keeps how it began; the person's choice is for the next new one.
      fixed.push('twoChats');
      if (!!reply.twoChats !== lastTwoChats) changed.push(`"twoChats": ${lastTwoChats} (you wrote ${!!reply.twoChats}) — the chat you carry on is ${lastTwoChats ? 'one of two chats' : 'one chat'}, and stays so`);
      reply.twoChats = lastTwoChats;
      if (want !== lastTwoChats) changed.push(`the person chose "twoChats": ${want}: it is how your next "new" chat begins`);
    } else set('twoChats', want);
  }
  if (how?.review) {
    set('review', how.review === 'on', how.review === 'on' && reply.twoChats ? 'with two chats the lead judges the work, so there is no review of its own' : undefined);
  }
  if (skill) {
    const want = skill === 'none' ? '' : skill.name;
    fixed.push('skill');
    const had = (reply.skill ?? '').trim();
    if (had !== want) changed.push(`"skill": "${want}" (you wrote "${had}")`);
    reply.skill = want;
  }
  return { reply, fixed, changed };
}

/** The person's choices, as the task tells her before she begins. */
export function howSaid(how: KerriganHow | undefined, skill: SkillFixed): string {
  const word = (v: 'on' | 'off'): string => (v === 'on' ? 'always on' : 'always off');
  const parts: string[] = [];
  const free: string[] = [];
  for (const key of ['planMode', 'twoChats', 'review'] as const) {
    const v = how?.[key];
    if (v) parts.push(`\`${key}\` ${word(v)}`);
    else free.push(`\`${key}\``);
  }
  if (skill === 'none') parts.push('no skill (`"skill": ""`)');
  else if (skill) parts.push(`the skill \`${skill.name}\` with every message`);
  else free.push('`skill`');
  if (parts.length === 0) return 'How your messages run is yours to choose for each one: `planMode`, `twoChats`, `review` and `skill`.';
  return [
    `The person fixed how your messages run for this task: ${parts.join('; ')}. The runner sends every message of yours so, whatever you write, and tells you where yours was changed; the person may change it while you work.`,
    free.length > 0 ? ` Yours to choose for each message: ${free.join(', ')}.` : '',
    how?.planMode === 'off' ? ' Without plan mode no plan comes to you before a chat changes anything: give it smaller, clearer pieces of work, one message each.' : '',
    how?.review === 'off' ? ' Without the review nobody checks the work but you: ask the chat to show the tests and what they printed.' : '',
  ].join('');
}
