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
      const steps = reply.steps.map<Step>((s) => ({ ...s, shell: s.shell ?? opts.defaultShell }));
      const markerHit = markdown.includes(opts.stopMarker);

      return {
        ok: true,
        reply: { ...reply, steps },
        done: reply.status === 'done' || markerHit,
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
