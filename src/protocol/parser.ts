/**
 * Turns one Copilot reply into a validated set of steps.
 *
 * The input is the **raw markdown** of the reply, obtained by clicking "Copy Response" and
 * reading the clipboard. It is never the rendered DOM text: code blocks in the Copilot UI are
 * virtualized and interleave line numbers with the code, and a reply has already been
 * observed coming back from `innerText` with a chunk of valid JSON simply missing.
 */
import { ReplySchema, type Reply, type Step } from './replySchema.js';
import { ReviewSchema, type Review } from './reviewSchema.js';

export type ParseOk = {
  ok: true;
  reply: Reply;
  done: boolean;
  blocked: boolean;
  json: string;
  /** Prose fields that arrived in another shape and were read as text; see `normaliseProse`. */
  coerced?: string[];
};
export type ParseFail = {
  ok: false;
  reason: string;
  detail: string;
  /** The fields the schema rejected, as dotted paths (`tried.0`, `steps.1.cmd`), for the message back. */
  paths?: string[];
};

/** The same, for a reviewing conversation, which answers in its own contract. */
export type ReviewParseOk = { ok: true; review: Review; verdict: 'continue' | 'pass' | 'fail'; json: string };
export type ReviewParseResult = ReviewParseOk | ParseFail;
export type ParseResult = ParseOk | ParseFail;

/** Every fenced block in a markdown string, with its info string. */
export function extractFencedBlocks(markdown: string): Array<{ lang: string; body: string }> {
  const blocks: Array<{ lang: string; body: string }> = [];
  // Fences of three or more backticks or tildes; the closing fence must be at least as long.
  const re = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push({ lang: (m[3] ?? '').trim().toLowerCase(), body: m[4] ?? '' });
  }
  return blocks;
}

/**
 * Strips the line numbers the chat's code widget injects, as a last-resort repair when the
 * text came from the DOM rather than the clipboard. A line that is nothing but digits, in a
 * block whose other lines are not, is a gutter number.
 */
export function stripLineNumbers(body: string): string {
  const lines = body.split(/\r?\n/);
  const numbered = lines.filter((l) => /^\s*\d+\s*$/.test(l)).length;
  if (numbered < 2 || numbered * 2 < lines.length - numbered) return body;
  return lines.filter((l) => !/^\s*\d+\s*$/.test(l)).join('\n');
}

function findJsonCandidates(markdown: string): string[] {
  const blocks = extractFencedBlocks(markdown);
  const out: string[] = [];

  for (const b of blocks) {
    if (b.lang === 'json') out.push(b.body);
  }
  // Copilot sometimes tags the block `JSON` in the widget but emits no info string.
  if (out.length === 0) {
    for (const b of blocks) {
      if (b.lang === '' && b.body.trimStart().startsWith('{')) out.push(b.body);
    }
  }
  // Nothing fenced at all: fall back to the outermost braces in the reply.
  if (out.length === 0) {
    const first = markdown.indexOf('{');
    const last = markdown.lastIndexOf('}');
    if (first >= 0 && last > first) out.push(markdown.slice(first, last + 1));
  }
  return out;
}

/** Removes Copilot's 【n-hash】 citation markers and the whitespace they leave behind. */
export function stripCitations(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.replace(/\s*【[^】]*】/g, '').replace(/[ 	]+$/gm, '').trim();
}

/*
 * Prose that arrived in another shape.
 *
 * `tried`, `needed`, `notes` and `summary` are sentences for a person to read; nothing in them is
 * run. A chat that writes `tried` as a list of objects — `{"approach": "…", "result": "…"}` — has
 * said exactly what was asked, in a shape the schema did not expect, and refusing the whole reply
 * for it cost a format round each time and, three in a row, the task: it ended "failed" with the
 * work done and its results already recorded. So these fields are read as text whatever shape they
 * come in, and the reading is reported. The fields that are acted on — `status`, `steps` and
 * everything in them — are never coerced: a step the runner would have to guess at is not run.
 */
const PROSE_KEYS = ['approach', 'what', 'tried', 'attempt', 'action', 'description', 'text', 'summary', 'detail', 'result', 'outcome', 'why', 'reason', 'needed'];

function proseOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(proseOf).filter((x) => x.trim()).join('\n');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const named = PROSE_KEYS.filter((k) => typeof record[k] === 'string' && (record[k] as string).trim()).map((k) => record[k] as string);
    if (named.length > 0) return named.join(' — ');
    const strings = Object.values(record).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return strings.length > 0 ? strings.join(' — ') : JSON.stringify(value);
  }
  return String(value);
}

export function normaliseProse(value: unknown): { value: unknown; coerced: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, coerced: [] };
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const coerced: string[] = [];
  for (const key of ['notes', 'summary', 'needed']) {
    if (key in out && out[key] !== undefined && typeof out[key] !== 'string') {
      out[key] = proseOf(out[key]);
      coerced.push(key);
    }
  }
  if ('tried' in out && out.tried !== undefined) {
    const tried = out.tried;
    if (typeof tried === 'string') {
      out.tried = tried.trim() ? [tried] : [];
      coerced.push('tried');
    } else if (Array.isArray(tried) && tried.some((t) => typeof t !== 'string')) {
      out.tried = tried.map(proseOf).filter((t) => t.trim() !== '');
      tried.forEach((t, i) => {
        if (typeof t !== 'string') coerced.push(`tried.${i}`);
      });
    }
  }
  return { value: out, coerced };
}

/** What each field must look like, said in the message that asks for a reformatted reply. */
const FIELD_SHAPES: Array<[RegExp, string]> = [
  [/^status$/, '"status" is one of "continue", "done", "blocked"'],
  [/^steps(\.|$)/, '"steps" is a list of {"id": 1, "type": "command", "cmd": "the command"} ("shell", "expect", "timeoutSec" optional)'],
  [/^tried(\.|$)/, '"tried" is a list of plain strings, one sentence per approach'],
  [/^deviations(\.|$)/, '"deviations" is a list of {"instruction": "…", "did": "…", "why": "…"} with plain strings'],
  [/^disputed(\.|$)/, '"disputed" is a list of {"finding": "…", "why": "…", "evidence": "…"} with plain strings'],
  [/^(summary|notes|needed)$/, '"summary", "notes" and "needed" are plain strings'],
];

const FORMAT_EXAMPLE = [
  '```json',
  '{"status": "continue", "notes": "what this round does", "steps": [{"id": 1, "type": "command", "cmd": "npm test"}]}',
  '```',
  'or, to end: {"status": "done", "summary": "several sentences on what was done and what it shows"}',
  'or {"status": "blocked", "summary": "…", "tried": ["first approach", "second approach"], "needed": "what would unblock it"}',
].join('\n');

export type ParseOptions = {
  /** The word that ends the run when Copilot writes it. Blank means there is none. */
  stopMarker: string;
  /** Default shell for steps that do not name one. */
  defaultShell: 'pwsh' | 'powershell' | 'cmd';
};

export function parseReply(markdown: string, opts: ParseOptions): ParseResult {
  const candidates = findJsonCandidates(markdown);
  const paths = new Set<string>();

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no-json-block',
      detail: 'The reply contained no fenced ```json block and no JSON object at all.',
    };
  }

  const errors: string[] = [];
  for (const raw of candidates) {
    for (const text of [raw, stripLineNumbers(raw)]) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        errors.push(`JSON.parse failed: ${(e as Error).message}`);
        continue;
      }
      const prose = normaliseProse(value);
      const result = ReplySchema.safeParse(prose.value);
      if (!result.success) {
        errors.push(
          result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        );
        for (const i of result.error.issues) paths.add(i.path.join('.') || '(root)');
        continue;
      }

      const reply = result.data;
      // Copilot appends citation markers such as 【1-8313d0】 to prose it grounded in a file.
      // They mean nothing outside the chat and would otherwise end up in the UI and the log.
      reply.notes = stripCitations(reply.notes);
      reply.summary = stripCitations(reply.summary);
      const steps = reply.steps.map<Step>((s) => ({ ...s, shell: s.shell ?? opts.defaultShell }));
      // A blank stop word is no stop word. The setting is free text, and every reply contains the
      // empty string and nearly every one a space, so searching for either would read each
      // `continue` that carries a summary as done and close the task after one round.
      const marker = opts.stopMarker.trim();
      const markerHit = marker !== '' && markdown.includes(marker);
      const hasSummary = (reply.summary ?? '').trim().length > 0;

      // The stop word alone is not enough to end a task any more: the summary is the
      // deliverable, and a marker without one would let a task close with nothing to show.
      // status "done" already guarantees a summary through the schema.
      // A reply that gives up says so in `status`, and the stop word cannot override it: a
      // model that writes "Край" under an explanation of why it cannot finish has ended the
      // task, not completed it, and reading that as `done` would file a failure as a success.
      const blocked = reply.status === 'blocked';

      return {
        ok: true,
        reply: { ...reply, steps },
        done: reply.status === 'done' || (markerHit && hasSummary && !blocked),
        blocked,
        json: text.trim(),
        ...(prose.coerced.length > 0 ? { coerced: prose.coerced } : {}),
      };
    }
  }

  return {
    ok: false,
    reason: 'invalid-json',
    detail: errors.slice(0, 4).join(' | '),
    ...(paths.size > 0 ? { paths: [...paths] } : {}),
  };
}

/**
 * The same job for a reviewing conversation: find the json, validate it, hand it back.
 *
 * A sibling of `parseReply` rather than a generalisation of it. The two contracts differ in
 * what they are allowed to say and in what ends them, and folding them into one parameterised
 * function would mean every future change to either has to be reasoned about twice. The parts
 * genuinely in common — finding the block, repairing line numbers, stripping citations — are
 * shared as they are.
 *
 * There is no stop word here. A review ends through its verdict and nothing else, because a
 * reviewer writing the implementer's stop word is a reviewer quoting the work, not finishing.
 */
export function parseReview(markdown: string, opts: { defaultShell: ParseOptions['defaultShell'] }): ReviewParseResult {
  const candidates = findJsonCandidates(markdown);

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no-json-block',
      detail: 'The reply contained no fenced ```json block and no JSON object at all.',
    };
  }

  const errors: string[] = [];
  for (const raw of candidates) {
    for (const text of [raw, stripLineNumbers(raw)]) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        errors.push(`JSON.parse failed: ${(e as Error).message}`);
        continue;
      }
      const result = ReviewSchema.safeParse(value);
      if (!result.success) {
        errors.push(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
        continue;
      }

      const review = result.data;
      review.notes = stripCitations(review.notes);
      review.summary = stripCitations(review.summary);
      const steps = review.steps.map<Step>((x) => ({ ...x, shell: x.shell ?? opts.defaultShell }));

      return { ok: true, review: { ...review, steps }, verdict: review.status, json: text.trim() };
    }
  }

  return { ok: false, reason: 'invalid-json', detail: errors.slice(0, 4).join(' | ') };
}

/** The message sent back when a reply did not validate. Names the problem, nothing else. */
/**
 * The message that asks for the same answer again, in the format.
 *
 * It names each rejected field with the shape it must have, gives a valid example, and says what
 * did not happen: nothing from the rejected reply was run, so the results of the steps before it
 * stand and the answer only needs reformatting. Without that last part a chat told "invalid" tends
 * to start the round again, or to keep the same shape and change the wording, and the rounds run out.
 */
export function formatErrorMessage(fail: ParseFail, attempt: number, maxAttempts: number): string {
  const shapes = [...new Set((fail.paths ?? []).flatMap((p) => FIELD_SHAPES.filter(([re]) => re.test(p)).map(([, s]) => s)))];
  return [
    `Your last reply did not match the required format (format retry ${attempt} of ${maxAttempts}).`,
    fail.reason === 'no-json-block'
      ? 'There was no fenced json code block in it.'
      : `The json block did not validate: ${fail.detail}`,
    shapes.length > 0 ? `What those fields must be: ${shapes.join('; ')}.` : '',
    'Only the format is wrong. Nothing from that reply was run, and the results of the steps before it stand.',
    'Send the same answer again, reformatted, as exactly one fenced code block tagged json — do not start over and do not change what it asks for. For example:',
    FORMAT_EXAMPLE,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Spots a command that arrived damaged rather than badly written.
 *
 * Copilot's own output pipeline eats a `[label]:` sequence, apparently reading it the way
 * markdown reads a link-reference definition. PowerShell writes static calls as
 * `[math]::Round(...)`, which contains exactly that sequence, so what reaches the runner is
 * `:Round(...)`. Observed live three iterations in a row, and confirmed from the chat itself:
 * the mangled form was already on screen, and Copilot's own notes complained that ":Round"
 * had been emitted instead of "[math]::".
 *
 * The damage is not repairable here, because the type name is gone and guessing it would run
 * a command nobody wrote. So it is detected, refused, and explained back to Copilot.
 */
export function findLikelyDamage(command: string): string | null {
  // A method call whose type literal has been eaten: `{:Round(`, `= :Round(`, `+ ::Round(`.
  // `]` and `$name` before the colons are the intact forms, `[math]::Round` and `$m::Round`,
  // so they must not match.
  const eaten = /(^|[^\w.$:\]]):{1,2}[A-Za-z_]\w*\s*\(/.exec(command);
  if (eaten) {
    return (
      `"${eaten[0].trim()}" looks like a .NET static call whose type was lost in transit: ` +
      '`[math]::Round(...)` arrives as `:Round(...)` because the chat consumes `[label]:`'
    );
  }
  return null;
}

/** What to tell Copilot when a command arrived damaged, with alternatives that survive. */
export function damageGuidance(): string {
  /*
   * The advice has to cover the call that was actually made, not one example of it.
   *
   * It named `[math]::Round` and offered number formatting, because rounding was the first
   * casualty. A later run lost `[regex]::Escape`, `[regex]::Matches` and `[math]::Min` — and
   * a model told only how to format a number has nothing to take from that. So the general
   * rule leads (put the type in a variable, which works for every static call there is), and
   * the native PowerShell way follows for the shapes that keep coming up.
   */
  return [
    'A command you sent arrived with its type literal missing: `[regex]::Escape(...)` reached',
    'the runner as `:Escape(...)`. Anything of the form `[name]:` is consumed before it gets',
    'here, so no .NET static call written that way can survive.',
    '**The rule that always works: put the type in a variable first, then call through it.**',
    '`$re = [regex]; $re::Escape($x)` · `$m = [math]; $m::Round($x, 2)` — the variable has no',
    'bracket before the colons, so nothing eats it. A space before `::` is a syntax error, not',
    'a workaround.',
    'Where PowerShell has its own way of doing it, that is shorter and safer still:',
    'to escape for a match, compare with `-like` or use `.Replace()` and drop the regex;',
    'to find every match, `Select-String -Pattern ... -AllMatches` and read `.Matches.Groups`;',
    'for the smallest or largest, `Measure-Object -Minimum -Maximum`;',
    'to format a number, `"{0:N2}" -f $x` or `$x.ToString("N2")`.',
  ].join(' ');
}
