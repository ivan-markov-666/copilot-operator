/**
 * What never leaves the machine in a report, whatever the configuration says.
 *
 * Everything a step prints goes to the chat as an attachment, and `report.redactPatterns`
 * was empty by default: on a development machine with toy projects that was harmless, and
 * on a work machine it is a token in a stack trace, a connection string in an error message
 * or a private key a step printed by mistake, uploaded to the tenant's Copilot as a file. The
 * operator's own patterns still apply on top; these are the shapes that are secrets wherever
 * they appear, and they are applied always.
 *
 * Each shape keeps enough of the original for the model to understand what was there — a
 * `password=` keeps its name, a URL keeps its host — because a report full of anonymous
 * `[REDACTED]` is a report the model cannot reason about.
 */

export type RedactionHit = { name: string; count: number };

type Shape = { name: string; pattern: RegExp; replace: string | ((...m: string[]) => string) };

/** Words that follow `password:` in code and type listings and are not passwords. */
const NOT_A_VALUE = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'required', 'optional', 'redacted']);

const SHAPES: Shape[] = [
  {
    name: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----',
  },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: '[REDACTED JWT]' },
  { name: 'bearer token', pattern: /\b(bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, replace: '$1 [REDACTED]' },
  { name: 'AWS access key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED AWS KEY]' },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: '[REDACTED GITHUB TOKEN]' },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[REDACTED SLACK TOKEN]' },
  { name: 'Azure key', pattern: /\b(AccountKey|SharedAccessSignature)=[^;\s"']+/gi, replace: '$1=[REDACTED]' },
  { name: 'credentials in a URL', pattern: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: '$1[REDACTED]@' },
  {
    name: 'secret assignment',
    // `password=...`, `api_key: ...`, `"client_secret": "..."` — the name is kept, the value goes.
    // The separator is kept as written — `": "` in JSON, `=` in a connection string — so the
    // line still reads as what it was.
    pattern: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|token)\b(["']?\s*[=:]\s*)(["']?)([^\s"';,]{8,})\3/gi,
    replace: (_m: string, name: string, sep: string, quote: string, value: string) =>
      NOT_A_VALUE.has(value.toLowerCase()) ? _m : `${name}${sep}${quote}[REDACTED]${quote}`,
  },
];

/** Which shapes a text contains, and how many of each. For the event, not for the text. */
export function findSecrets(text: string): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const s of SHAPES) {
    let count = 0;
    for (const m of text.matchAll(s.pattern)) {
      // A shape with a replacer can decline a match (`password: string`); only real ones count.
      if (typeof s.replace === 'function' && s.replace(...(m as unknown as string[])) === m[0]) continue;
      count += 1;
    }
    if (count > 0) hits.push({ name: s.name, count });
  }
  return hits;
}

/**
 * The text with every secret-shaped string replaced, then the operator's own patterns.
 *
 * A pattern from the configuration that is not a valid regular expression is applied as a
 * plain string, as it always was, so a typo in one cannot switch redaction off.
 */
export function redactSecrets(text: string, extraPatterns: string[] = []): string {
  let out = text;
  for (const s of SHAPES) out = out.replace(s.pattern, s.replace as string);
  for (const p of extraPatterns) {
    try {
      out = out.replace(new RegExp(p, 'gi'), '[REDACTED]');
    } catch {
      out = out.split(p).join('[REDACTED]');
    }
  }
  return out;
}
