/**
 * The lead's contract, as a schema (operator, 2026-10-20: "two chats — chat A takes the whole, complex task, breaks it
 * into steps and directs; chat B carries out the small technical tasks and reports back").
 *
 * The prose the lead is given is `prompts/lead1.md`; this is the enforcement. The lead never runs anything: its replies
 * say what to do next — give the worker a subtask, propose the plan, ask the operator, deliver the result, or stop —
 * and anything that does not validate here is sent back with the reason, as a worker's reply in the wrong shape is.
 * Lenient where nothing runs on it: a list that came as one string, an answer that came as an object (the fields of a
 * bug report, say) are read as the text they mean rather than refused.
 */
import { z } from 'zod';
import { findJsonCandidates, stripCitations, stripLineNumbers, type ParseFail } from './parser.js';
import { MIN_SUMMARY_CHARS, PlanSchema } from './replySchema.js';

/** A value that is meant as prose, in whatever shape it came: an object or a list is written out as text. */
export function proseOfValue(value: unknown, depth = 0): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        const text = proseOfValue(v, depth + 1);
        return text.includes('\n') ? `${pad}- ${text.trimStart()}` : `${pad}- ${text}`;
      })
      .join('\n');
  }
  // An object's fields, each on its line in the order they came: "**Title**: …".
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      const text = proseOfValue(v, depth + 1);
      return typeof v === 'object' && v !== null ? `${pad}**${k}**:\n${text}` : `${pad}**${k}**: ${text}`;
    })
    .join('\n');
}

const prose = z.preprocess((v) => (v === undefined ? undefined : proseOfValue(v)), z.string().optional());
const proseList = z.preprocess(
  (v) =>
    v === undefined
      ? []
      : typeof v === 'string'
        ? v.split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim()).filter(Boolean)
        : Array.isArray(v)
          ? v.map((x) => proseOfValue(x)).filter((x) => x.trim() !== '')
          : [proseOfValue(v)],
  z.array(z.string()),
);

/** One subtask for the worker: what it is to find out or do, what it needs to know, and what to report back. */
export const SubtaskSchema = z.object({
  title: z.preprocess((v) => proseOfValue(v), z.string().trim().min(3, 'subtask.title must name the subtask in a few words.').max(140)),
  goal: z.preprocess((v) => proseOfValue(v), z.string().trim().min(15, 'subtask.goal must say what the worker is to find out or do, in a sentence or more.')),
  context: prose.default(''),
  steps: proseList.default([]),
  report: z.preprocess((v) => proseOfValue(v), z.string().trim().min(10, 'subtask.report must say what the worker reports back to you, and in which shape.')),
  doneWhen: prose.default(''),
  readOnly: z.boolean().default(false),
  freshWorker: z.boolean().default(false),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

export const LeadReplySchema = z
  .object({
    /**
     * What the lead does next.
     *
     * `delegate` — give the worker this subtask (`subtask`). `plan` — the plan of the whole assignment (`plan`), for the
     * operator to approve when they approve plans. `ask` — a question only the operator can answer (`question`).
     * `done` — the result, in the form the assignment asked for (`answer`). `blocked` — it cannot be taken further
     * without the operator (`summary`, `needed`).
     */
    status: z.enum(['delegate', 'plan', 'ask', 'done', 'blocked']),
    understanding: prose,
    notes: prose,
    plan: PlanSchema.optional(),
    subtask: SubtaskSchema.optional(),
    question: prose,
    why: prose,
    options: proseList.default([]),
    answer: prose,
    evidence: proseList.default([]),
    summary: prose,
    needed: prose,
  })
  .refine((r) => r.status !== 'delegate' || !!r.subtask, {
    message: 'status "delegate" requires a "subtask": {"title", "goal", "context", "steps", "report", "doneWhen", "readOnly", "freshWorker"}.',
  })
  .refine((r) => r.status !== 'plan' || !!r.plan, {
    message: 'status "plan" requires a "plan": {"existing", "approach", "steps": [the stages], "files", "verification", "risks"}.',
  })
  .refine((r) => r.status !== 'ask' || (r.question ?? '').trim().length >= 10, {
    message: 'status "ask" requires a "question" for the operator: what only a person can decide, said in full.',
  })
  .refine((r) => r.status !== 'done' || (r.answer ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message: 'status "done" requires an "answer": the result, in the form the assignment asked for, in full.',
  })
  .refine((r) => r.status !== 'blocked' || (r.summary ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message: 'status "blocked" requires a "summary": what was done and found, with its evidence, so the work can be picked up.',
  })
  .refine((r) => r.status !== 'blocked' || (r.needed ?? '').trim().length > 0, {
    message: 'status "blocked" requires "needed": what would let the work go on.',
  });
export type LeadReply = z.infer<typeof LeadReplySchema>;

export type LeadParseOk = { ok: true; reply: LeadReply; json: string };
export type LeadParseResult = LeadParseOk | ParseFail;

/** The lead's reply, found, validated and cleaned of citation markers. */
export function parseLeadReply(markdown: string): LeadParseResult {
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
      const result = LeadReplySchema.safeParse(value);
      if (!result.success) {
        errors.push(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
        for (const i of result.error.issues) paths.add(i.path.join('.') || '(root)');
        continue;
      }
      const r = result.data;
      const clean = (s: string | undefined): string | undefined => stripCitations(s)?.trim() || undefined;
      return {
        ok: true,
        reply: { ...r, understanding: clean(r.understanding), notes: clean(r.notes), answer: clean(r.answer), summary: clean(r.summary), question: clean(r.question) },
        json: text.trim(),
      };
    }
  }
  return { ok: false, reason: 'invalid-json', detail: errors.slice(0, 4).join(' | '), ...(paths.size > 0 ? { paths: [...paths] } : {}) };
}

const LEAD_EXAMPLE = [
  '```json',
  '{"status": "delegate", "notes": "what you decide and why", "subtask": {"title": "Run the tests", "goal": "Find out which tests fail now.", "context": "Change nothing.", "steps": [], "report": "The totals, and for each failing test its name and its error, quoted.", "doneWhen": "The suite ran once.", "readOnly": true, "freshWorker": false}}',
  '```',
  'or {"status": "plan", "plan": {"existing": "…", "approach": "…", "steps": ["…"], "files": [], "verification": "…"}}',
  'or {"status": "ask", "question": "…", "why": "…", "options": ["…", "…"]}',
  'or {"status": "done", "answer": "the result, in the form asked for", "evidence": ["…"]}',
  'or {"status": "blocked", "summary": "what was done and found", "needed": "what would let it go on"}',
].join('\n');

/** The message that asks the lead for the same answer again, in the format. */
export function leadFormatErrorMessage(fail: ParseFail, attempt: number, maxAttempts: number): string {
  return [
    `Your last reply did not match the lead's format (format retry ${attempt} of ${maxAttempts}).`,
    fail.reason === 'no-json-block' ? 'There was no fenced json code block in it.' : `The json block did not validate: ${fail.detail}`,
    'Only the format is wrong: nothing from that reply was acted on. Send the same answer again, reformatted, as exactly one fenced code block tagged json. For example:',
    LEAD_EXAMPLE,
  ].join('\n');
}

/** A first reply without the assignment restated. */
export const UNDERSTANDING_FIRST =
  'Before anything else, restate the assignment in "understanding": the goal, the result to deliver and its exact form ' +
  '(every field asked for), the constraints, and how you will know it is done. Send your reply again with it; nothing ' +
  'from the last one was acted on.';
