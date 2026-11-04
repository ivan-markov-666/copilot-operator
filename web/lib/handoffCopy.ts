/**
 * What the card "Run this yourself" says, as one text (operator, 2026-11-04: "a button at the very bottom, 'Copy all',
 * that copies the text as well as the commands; all that the bot tells me in such a message"): the card from top to
 * bottom, in the words it shows, and each script it keeps folded, in full. Plain functions over a translator, so the
 * card and what is copied from it read the same lines, and a check can hold them to it.
 */
import type { HandoffCard } from './api';
import type { Key } from './lang/types';

type Translate = (key: Key, vars?: Record<string, string | number>) => string;

/** What the chat says of the commands: how they end, what they reach, what they change. Left out, the card says so. */
export function declaredLines(t: Translate, card: HandoffCard): Array<{ label: string; value: string | undefined }> {
  return [
    { label: t('ho.exit'), value: card.exit },
    { label: t('ho.network'), value: card.network },
    { label: t('ho.platforms'), value: card.platforms },
    { label: t('ho.changes'), value: card.changes },
  ];
}

/** What the bot reads in the lines and the scripts themselves, beside what the chat says of them. */
export function seenLines(t: Translate, card: HandoffCard): string[] {
  return [
    ...(card.seen?.network ? [t('ho.seenNetwork', { what: card.seen.network })] : []),
    ...(card.seen?.platform ? [t('ho.seenPlatform', { platform: card.seen.platform })] : []),
  ];
}

/** In a fence longer than any run of backticks in the text, so a script that prints Markdown stays whole when pasted. */
function fenced(text: string): string {
  const ticks = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
}

/** What "Copy all" takes; `why` is the text the card opens with. The same from the card, a queue's and the history's. */
export function handoffCopy(t: Translate, card: HandoffCard, why: string): string {
  const revision = card.revision ?? 1;
  return [
    [t('ho.historyTitle', { n: revision }), ...(revision > 1 ? [t('ho.revisionNew')] : [])].join('\n'),
    t('ho.intro'),
    why,
    [`${t('ho.folder')} ${card.cwd}`, ...(card.outside ? [t('ho.outside')] : [])].join('\n'),
    `${t('ho.commands')}\n${fenced(card.commands.join('\n'))}`,
    (card.warnings?.length ?? 0) > 0 ? [t('ho.warn'), ...card.warnings!.map((w) => `- ${w}`)].join('\n') : '',
    `${t('ho.expect')}\n${card.expect}`,
    declaredLines(t, card).map(({ label, value }) => `${label} ${value || t('ho.notSaid')}`).join('\n'),
    seenLines(t, card).join('\n'),
    ...card.files.map((f) =>
      [
        `${f.path} — ${f.problem ?? t('ho.files')}`,
        ...(f.abs ? [`${t('ho.abs')} ${f.abs}`] : []),
        ...(f.cut ? [t('ho.cut')] : []),
        ...(f.text !== undefined ? [fenced(f.text)] : []),
      ].join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}
