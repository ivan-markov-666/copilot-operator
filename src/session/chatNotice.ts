/**
 * What the chat's window says when the work on a message has ended and the window is left open for the next one
 * (2026-10-19: "when the chat is done, let the browser show a message — the task has finished — and an OK under
 * it"). In the language the workbench was in when the message was written; the card is drawn by `showNotice`.
 */
import type { TaskStatus } from './model.js';
import type { WindowNotice } from '../transport/copilotTransport.js';

export type NoticeLang = 'en' | 'bg';

/** A message of the run, as it ended. */
export type NoticeTask = { title: string; status: TaskStatus; reason?: string; summary?: string };

const WORDS = {
  en: {
    done: 'The task is done',
    stopped: 'The task was stopped',
    failed: 'The task ended unfinished',
    notStarted: 'The task could not start',
    doneLine: 'Copilot finished it. What was done is in the copilot-operator chat.',
    stoppedLine: 'It was stopped; nothing more is sent.',
    blockedLine: 'Copilot could not finish it',
    failedLine: 'It ended with an error',
    limitLine: 'It stopped at a limit from the settings',
    notStartedLine: 'Nothing was sent',
    statusOf: { done: 'done', aborted: 'stopped', blocked: 'blocked', failed: 'failed', 'limit-reached': 'at a limit', queued: 'not started' } as Record<string, string>,
    keep: 'This window stays open for your next message. You can close it at any time.',
    ok: 'OK',
    quote: (s: string) => `“${s}”`,
  },
  bg: {
    done: 'Заданието е изпълнено',
    stopped: 'Заданието е спряно',
    failed: 'Заданието приключи незавършено',
    notStarted: 'Заданието не можа да започне',
    doneLine: 'Copilot го завърши. Какво е направено, виждате в чата на copilot-operator.',
    stoppedLine: 'Спряно е; нищо повече не се изпраща.',
    blockedLine: 'Copilot не успя да го завърши',
    failedLine: 'Завърши с грешка',
    limitLine: 'Спря при ограничение от настройките',
    notStartedLine: 'Нищо не беше изпратено',
    statusOf: { done: 'изпълнено', aborted: 'спряно', blocked: 'незавършено', failed: 'с грешка', 'limit-reached': 'при ограничение', queued: 'не започна' } as Record<string, string>,
    keep: 'Прозорецът остава отворен за следващото ви съобщение. Можете да го затворите по всяко време.',
    ok: 'ОК',
    quote: (s: string) => `„${s}“`,
  },
} as const;

/** A reason as a line: its first sentence or so, since the whole of it is in the chat. */
function brief(text: string | undefined, max = 220): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The card for a run of the chat that has ended: how its message(s) ended, and that the window stays open. */
export function chatNotice(lang: NoticeLang, tasks: NoticeTask[], error?: string): WindowNotice {
  const w = WORDS[lang] ?? WORDS.en;
  const ran = tasks.filter((t) => t.status !== 'queued');
  const unfinished = ran.filter((t) => t.status !== 'done' && t.status !== 'aborted');
  const stopped = ran.some((t) => t.status === 'aborted');
  const kind = unfinished.length > 0 ? 'failed' : stopped ? 'stopped' : ran.length > 0 ? 'done' : error ? 'notStarted' : 'stopped';
  const subject = tasks.length === 1 ? w.quote(tasks[0]!.title) : undefined;
  const lines: string[] = [];
  if (tasks.length > 1) {
    for (const t of tasks) lines.push(`${w.quote(t.title)} — ${w.statusOf[t.status] ?? t.status}`);
  } else if (kind === 'done') {
    lines.push(w.doneLine);
  } else if (kind === 'stopped') {
    lines.push(w.stoppedLine);
  } else if (kind === 'notStarted') {
    lines.push(`${w.notStartedLine}: ${brief(error)}`);
  } else {
    const t = unfinished[0]!;
    const said = t.status === 'blocked' ? w.blockedLine : t.status === 'limit-reached' ? w.limitLine : w.failedLine;
    const why = brief(t.status === 'blocked' ? t.summary || t.reason : t.reason || t.summary);
    lines.push(why ? `${said}: ${why}` : `${said}.`);
  }
  lines.push(w.keep);
  return {
    tone: kind === 'done' ? 'done' : kind === 'stopped' ? 'stopped' : 'failed',
    title: w[kind],
    ...(subject ? { subject } : {}),
    lines,
    button: w.ok,
  };
}
