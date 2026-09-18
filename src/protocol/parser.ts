/**
 * Turns one Copilot reply into a validated set of steps.
 *
 * The input is the **raw markdown** of the reply, obtained by clicking "Copy Response" and
 * reading the clipboard. It is never the rendered DOM text: code blocks in the Copilot UI are
 * virtualized and interleave line numbers with the code, and a reply has already been
 * observed coming back from `innerText` with a chunk of valid JSON simply missing.
 */
import { ReplySchema, type Reply, type Step } from './replySchema.js';

export type ParseOk = { ok: true; reply: Reply; done: boolean; json: string };
export type ParseFail = { ok: false; reason: string; detail: string };
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

export type ParseOptions = {
  /** The word that ends the run when Copilot writes it. */
  stopMarker: string;
  /** Default shell for steps that do not name one. */
  defaultShell: 'pwsh' | 'powershell' | 'cmd';
};

export function parseReply(markdown: string, opts: ParseOptions): ParseResult {
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
      const result = ReplySchema.safeParse(value);
      if (!result.success) {
        errors.push(
          result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        );
        continue;
      }

      const reply = result.data;
      // Copilot appends citation markers such as 【1-8313d0】 to prose it grounded in a file.
      // They mean nothing outside the chat and would otherwise end up in the UI and the log.
      reply.notes = stripCitations(reply.notes);
      reply.summary = stripCitations(reply.summary);
      const steps = reply.steps.map<Step>((s) => ({ ...s, shell: s.shell ?? opts.defaultShell }));
      const markerHit = markdown.includes(opts.stopMarker);
      const hasSummary = (reply.summary ?? '').trim().length > 0;

      // The stop word alone is not enough to end a task any more: the summary is the
      // deliverable, and a marker without one would let a task close with nothing to show.
      // status "done" already guarantees a summary through the schema.
      return {
        ok: true,
        reply: { ...reply, steps },
        done: reply.status === 'done' || (markerHit && hasSummary),
        json: text.trim(),
      };
    }
  }

  return {
    ok: false,
    reason: 'invalid-json',
    detail: errors.slice(0, 4).join(' | '),
  };
}

/** The message sent back when a reply did not validate. Names the problem, nothing else. */
export function formatErrorMessage(fail: ParseFail, attempt: number, maxAttempts: number): string {
  return [
    `Your last reply did not match the required format (attempt ${attempt} of ${maxAttempts}).`,
    fail.reason === 'no-json-block'
      ? 'There was no fenced json code block in it.'
      : `The json block did not validate: ${fail.detail}`,
    'Resend the same answer as exactly one fenced code block tagged json, with the fields',
    'status, steps and notes, and nothing else tagged json in the reply.',
  ].join(' ');
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
  return [
    'A command you sent arrived with its type literal missing: `[math]::Round(...)` reached',
    'the runner as `:Round(...)`. Anything of the form `[name]:` is consumed before it gets',
    'here, so .NET static calls written that way cannot survive. Use one of these instead,',
    'all of which are verified to work in PowerShell:',
    '  $m = [math]; $m::Round($x, 2)',
    '  "{0:N2}" -f $x',
    '  $x.ToString("N2")',
    'Putting a space before `::` does not work and is a syntax error.',
  ].join(' ');
}
