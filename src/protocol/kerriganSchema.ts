/**
 * Kerrigan's contract, as a schema (operator, 2026-11-12: "I paste Kerrigan into a chat, give her the task, she gives me
 * the prompt and tells me plan mode, two chats, the reviewer, which skill; I run the bot; when it asks me something I
 * take the question to her and do what she says; at the end she reads the result and goes on with a new prompt, in a
 * new chat or the same — automate that").
 *
 * The prose she is given is `prompts/kerrigan1.md`; this is the enforcement. She runs nothing: every reply is one
 * decision — a message to a chat with its settings, the answer to a card of the chat's, a question for the operator,
 * her report, or a stop — and anything that does not validate here is sent back with the reason, as a chat's reply in
 * the wrong shape is. Lenient where nothing runs on it, as the lead's: prose that came as an object or a list is read
 * as the text it means.
 */
import { z } from 'zod';
import { findJsonCandidates, stripCitations, stripLineNumbers, type ParseFail } from './parser.js';
import { proseOfValue } from './leadSchema.js';
import { MIN_SUMMARY_CHARS } from './replySchema.js';
import type { RetryChoice } from '../session/model.js';

const prose = z.preprocess((v) => (v === undefined || v === null ? undefined : proseOfValue(v)), z.string().optional());
const proseList = z.preprocess(
  (v) =>
    v === undefined || v === null
      ? []
      : typeof v === 'string'
        ? v.split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim()).filter(Boolean)
        : Array.isArray(v)
          ? v.map((x) => proseOfValue(x)).filter((x) => x.trim() !== '')
          : [proseOfValue(v)],
  z.array(z.string()),
);
/** A yes or no, as a chat may say it: true, "true", "yes", 1. */
const flag = z.preprocess((v) => {
  if (typeof v === 'string') return /^(true|yes|on|1)$/i.test(v.trim()) ? true : /^(false|no|off|0|)$/i.test(v.trim()) ? false : v;
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean());
/** A number of an answer, as a chat may write it: 2, "2", "2." or "option 2". */
const number = z.preprocess((v) => {
  if (typeof v === 'string') {
    const m = /^\D*(\d+)/.exec(v.trim());
    return m ? Number(m[1]) : v;
  }
  return v;
}, z.number().int().min(1).max(50));

export const RETRY_CHOICES: readonly RetryChoice[] = ['same', 'fresh', 'continue', 'restore', 'accept'];

export const KerriganReplySchema = z
  .object({
    /**
     * `send` — a message to a chat (`prompt`), new or the one sent to last (`chat`), with its settings. `answer` — the card
     * the runner put to her, answered: an option by its number (`option`), several (`options`), her own words (`text`),
     * a plan approved or sent back (`decision`, `note`), or a subtask's retry (`choice`). `ask` — a question for the
     * operator; to a card, leaving it to them (`why`, `suggestion`). `done` — her report (`report`). `blocked` — it
     * cannot go on (`summary`, `needed`).
     */
    status: z.enum(['send', 'answer', 'ask', 'done', 'blocked'], {
      message:
        'status is one of "send", "answer", "ask", "done", "blocked". "continue", "delegate", "plan" and "handoff" are the chats\' and the lead\'s: ' +
        'what a chat is to do goes in a "send"; a card is answered with "answer"; a question for the person is "ask".',
    }),
    understanding: prose,
    notes: prose,
    /** Where she looked before she decided, as she names them. */
    sources: proseList.default([]),

    // send
    chat: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['new', 'same'], { message: 'chat is "new" or "same".' })).optional(),
    title: prose,
    prompt: prose,
    planMode: flag.optional(),
    twoChats: flag.optional(),
    review: flag.optional(),
    skill: z.preprocess((v) => (v === undefined || v === null ? undefined : String(v).trim().replace(/^\//, '')), z.string().optional()),

    // answer
    option: number.optional(),
    /*
     * The numbers of the answers chosen (status "answer", read by number there), or the answers she offers the person
     * (status "ask"): kept as written (third hunt, 2026-11-20). Read as numbers here, "Use Node 20" became 20 on the card.
     */
    options: z.preprocess((v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]), z.array(z.union([z.number(), z.string()])).optional()),
    text: prose,
    decision: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['approve', 'revise'], { message: 'decision is "approve" or "revise".' })).optional(),
    note: prose,
    choice: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(RETRY_CHOICES as [RetryChoice, ...RetryChoice[]], { message: `choice is one of ${RETRY_CHOICES.map((c) => `"${c}"`).join(', ')}.` })).optional(),

    // ask
    question: prose,
    why: prose,
    multiple: flag.default(false),
    suggestion: prose,

    // done / blocked
    report: prose,
    evidence: proseList.default([]),
    summary: prose,
    needed: prose,
  })
  .refine((r) => r.status !== 'send' || (r.prompt ?? '').trim().length >= 20, {
    message: 'status "send" requires a "prompt": the message for the chat, in full — what to do, what it is for, the result and its form, and how it is known to be done.',
    path: ['prompt'],
  })
  .refine((r) => r.status !== 'send' || !!r.chat, {
    message: 'status "send" requires "chat": "new" for a new conversation, "same" for the one you sent to last.',
    path: ['chat'],
  })
  .refine((r) => r.status !== 'done' || (r.report ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message: 'status "done" requires a "report" for the person: what was done, what shows it, and what is left, in full.',
    path: ['report'],
  })
  .refine((r) => r.status !== 'blocked' || (r.summary ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message: 'status "blocked" requires a "summary": what was done and found, with its evidence.',
    path: ['summary'],
  })
  .refine((r) => r.status !== 'blocked' || (r.needed ?? '').trim().length > 0, {
    message: 'status "blocked" requires "needed": what would let the work go on.',
    path: ['needed'],
  });
export type KerriganReply = z.infer<typeof KerriganReplySchema>;

export type KerriganParseOk = { ok: true; reply: KerriganReply; json: string };
export type KerriganParseResult = KerriganParseOk | ParseFail;

/** Her reply, found, validated and cleaned of citation markers. */
export function parseKerriganReply(markdown: string): KerriganParseResult {
  const candidates = findJsonCandidates(markdown);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-json-block', detail: 'The reply contained no fenced ```json block and no JSON object at all.' };
  }
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const raw of candidates) {
    for (const text of [raw, stripLineNumbers(raw)]) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        errors.push(`JSON.parse failed: ${(e as Error).message}`);
        continue;
      }
      const result = KerriganReplySchema.safeParse(value);
      if (!result.success) {
        errors.push(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
        for (const i of result.error.issues) paths.add(i.path.join('.') || '(root)');
        continue;
      }
      const r = result.data;
      const clean = (s: string | undefined): string | undefined => stripCitations(s)?.trim() || undefined;
      return {
        ok: true,
        reply: {
          ...r,
          understanding: clean(r.understanding),
          notes: clean(r.notes),
          prompt: clean(r.prompt),
          title: clean(r.title),
          text: clean(r.text),
          note: clean(r.note),
          question: clean(r.question),
          why: clean(r.why),
          suggestion: clean(r.suggestion),
          report: clean(r.report),
          summary: clean(r.summary),
          needed: clean(r.needed),
        },
        json: text.trim(),
      };
    }
  }
  return { ok: false, reason: 'invalid-json', detail: errors.slice(0, 4).join(' | '), ...(paths.size > 0 ? { paths: [...paths] } : {}) };
}

const EXAMPLE = [
  '```json',
  '{"status": "send", "notes": "what you decided and why", "sources": ["the mail from …, 3 Nov"], "chat": "new", "title": "Fix the login test", "prompt": "the message for the chat, in full", "planMode": true, "twoChats": false, "review": true, "skill": ""}',
  '```',
  'or {"status": "answer", "option": 1, "why": "…"} — or "options": [1, 3], or "text": "…"; for a plan {"status": "answer", "decision": "approve"} or "revise" with "note"; for a subtask {"status": "answer", "option": 1}',
  'or {"status": "ask", "question": "…", "why": "…", "options": ["…", "…"]} — to a card: {"status": "ask", "why": "…", "suggestion": "…"}',
  'or {"status": "done", "report": "what was done, what shows it, what is left", "evidence": ["…"]}',
  'or {"status": "blocked", "summary": "what was done and found", "needed": "what would let it go on"}',
].join('\n');

/** The message that asks her for the same answer again, in the format. */
export function kerriganFormatErrorMessage(fail: ParseFail, attempt: number, maxAttempts: number): string {
  return [
    `Your last reply did not match Kerrigan's format (format retry ${attempt} of ${maxAttempts}).`,
    fail.reason === 'no-json-block' ? 'There was no fenced json code block in it.' : `The json block did not validate: ${fail.detail}`,
    'Only the format is wrong: nothing from that reply was acted on. Send the same answer again, reformatted, as exactly one fenced code block tagged json. For example:',
    EXAMPLE,
  ].join('\n');
}

/** A first reply without the assignment restated. */
export const KERRIGAN_UNDERSTANDING_FIRST =
  'Before anything else, restate the person\'s assignment in "understanding": the goal, the result they want and its form, ' +
  'the constraints, and how it will be known to be done. Send your reply again with it; nothing from the last one was acted on.';
