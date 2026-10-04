/**
 * What the text a task wrote should not contain, checked before it is committed.
 *
 * `commitHygiene.ts` looks at which files would be committed. This looks inside them, because the
 * damage a Windows shell does to text is invisible to a formatter and to a reviewer reading a diff
 * in a browser: PowerShell 5.1's `Set-Content -Encoding utf8` puts a byte-order mark in front of a
 * JSON file and `JSON.parse` then refuses it; text read in one code page and written in another
 * comes out as `Ã©` or, for Cyrillic, `Ð°` and `Р°`; a decoder that gave up leaves `�`; a terminal's
 * colour codes pasted into a file leave ESC characters; one file ends up half CRLF and half LF.
 * Also a private key or an access token written into a file, which a path check cannot see.
 *
 * Every finding is about what THIS task did. A file is compared with the same file at the commit the
 * task started from, and a kind of problem already there is not reported: a repository that has
 * always had CRLF and LF mixed in one file is not this task's fault, and blaming it would send the
 * chat to "fix" a file it was never asked to touch.
 *
 * Used as a check the runner adds by itself when it is going to commit (`content-clean`, see
 * `checks.ts`), with the same rule as the path check: pointed out to the chat once; a second "done"
 * with the problem still there is committed and the finding stays on the task where a person sees it.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitBytes } from './git.js';
import { looksGenerated } from './commitHygiene.js';

export type IntegrityKind =
  | 'bom'
  | 'replacement-char'
  | 'mojibake'
  | 'control-chars'
  | 'mixed-line-endings'
  | 'line-endings-changed'
  | 'binary-in-text'
  | 'oversized'
  | 'secret';

/**
 * How line endings are handled where the file is committed.
 *
 * `normalized`: git converts them on commit (`core.autocrlf` true or input, or a `text` attribute), so
 * what the working tree holds is not what is committed and line endings are not this check's business
 * — on this machine `core.autocrlf` is true globally, which made every here-string write a "problem".
 * `style`: the ending most of the repository's text files are committed with, when one clearly is.
 */
export type LineEndingRule = { normalized: boolean; style?: 'lf' | 'crlf' };

const endingsOf = (bytes: Buffer): { crlf: number; lf: number } => {
  const text = bytes.toString('latin1');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return { crlf, lf: (text.match(/\n/g) ?? []).length - crlf };
};

export type IntegrityFinding = { path: string; kind: IntegrityKind; detail: string };

/** Written files larger than this are almost always generated output. */
export const OVERSIZED_BYTES = 1024 * 1024;

/** Files that are binary by nature: their bytes are not text and are not looked into. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'avif', 'psd',
  'pdf', 'zip', '7z', 'gz', 'tgz', 'bz2', 'xz', 'rar', 'jar', 'war', 'nupkg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib', 'pdb', 'class', 'wasm',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'sqlite', 'db', 'mdb', 'pfx', 'p12', 'der',
]);

/**
 * Text formats where a byte-order mark breaks the reader: JSON.parse, a shell's shebang line, YAML
 * and TOML parsers, Node's module loader for the first line. A BOM in these is reported even in a
 * new file; in any other text file only when the file had none before.
 */
const BOM_BREAKS = new Set(['json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'sh', 'bash', 'yml', 'yaml', 'toml', 'py', 'env', 'html', 'css', 'scss', 'md']);

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/*
 * Mojibake: UTF-8 bytes decoded in a single-byte code page and written back as UTF-8.
 *
 * Latin text through Windows-1252 turns "é" into "Ã©" and "’" into "â€™". Cyrillic through
 * Windows-1252 turns "а" into "Ð°"; through Windows-1251, into "Р°". The second character is what
 * gives it away: it is one of the characters the code page puts at bytes 0x80–0xBF, which real text
 * almost never places right after "Ã", "Ð", "Ñ", "Р" or "С". Plain "Ра" (Cyrillic Р then а) is
 * ordinary Bulgarian and does not match, because "а" is not in that range.
 */
const CP1252_HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ -¿';
const CP1251_HIGH = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї';
const MOJIBAKE = new RegExp(`[ÃÂÐÑâ][${CP1252_HIGH}]|[РС][${CP1251_HIGH}]`, 'g');

/** Control characters other than tab, line feed and carriage return; NUL is counted as binary. */
const CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/*
 * Credentials by their shape. Only formats that are unambiguous — a private key block, and tokens
 * whose prefix is the issuer's own — so a test fixture that says `password = "secret"` is not one.
 */
const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, 'an API secret key'],
  [/AccountKey=[A-Za-z0-9+/=]{40,}/, 'an Azure storage account key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];

type Traits = Partial<Record<IntegrityKind, string>>;

/** Every kind of problem a file's bytes show, with a short description of each. */
export function traitsOf(path: string, bytes: Buffer): Traits {
  const t: Traits = {};
  if (bytes.length > OVERSIZED_BYTES) t.oversized = `${(bytes.length / 1024 / 1024).toFixed(1)} MB, far more than anyone writes by hand`;
  // A NUL in the first 8 KB is how git itself decides a file is binary.
  if (bytes.subarray(0, 8192).includes(0)) {
    t['binary-in-text'] = 'NUL bytes in what should be a text file';
    return t;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) t.bom = 'starts with a UTF-8 byte-order mark';
  const text = bytes.toString('utf8');
  const replacement = (text.match(/�/g) ?? []).length;
  if (replacement > 0) t['replacement-char'] = `${replacement} "�" (text that was decoded with the wrong encoding, or invalid UTF-8)`;
  const mojibake = text.match(MOJIBAKE) ?? [];
  // Two or more, so one stray pair in a legitimate string does not count.
  if (mojibake.length >= 2) t.mojibake = `${mojibake.length} sequences such as "${mojibake.slice(0, 3).join('", "')}" (UTF-8 read in another code page)`;
  const control = (text.match(CONTROL) ?? []).length;
  if (control > 0) t['control-chars'] = `${control} control character(s)${text.includes('\u001B[') ? ', including terminal colour codes' : ''}`;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) t['mixed-line-endings'] = `${crlf} CRLF and ${lf} LF line ending(s) in one file`;
  for (const [re, what] of SECRETS) {
    if (re.test(text)) {
      t.secret = `what looks like ${what}`;
      break;
    }
  }
  return t;
}

/**
 * The problems `now` has that `before` did not. `before` is null for a file the task created.
 *
 * A BOM in a new file counts only for formats it breaks; in a changed file, whenever the file had
 * none. Size counts only when the file crossed the line in this task.
 */
export function newProblems(path: string, now: Buffer, before: Buffer | null, endings: LineEndingRule = { normalized: false }): IntegrityFinding[] {
  const ext = extensionOf(path);
  if (BINARY_EXTENSIONS.has(ext)) return [];
  const had = before ? traitsOf(path, before) : {};
  const has = traitsOf(path, now);
  const out: IntegrityFinding[] = [];
  for (const [kind, detail] of Object.entries(has) as Array<[IntegrityKind, string]>) {
    if (had[kind]) continue;
    if (kind === 'bom' && !before && !BOM_BREAKS.has(ext)) continue;
    if (kind === 'mixed-line-endings' && endings.normalized) continue;
    out.push({ path, kind, detail });
  }
  /*
   * A whole file turned from one ending to the other is a change on every line, and a mixed-endings
   * test cannot see it: each version is consistent on its own. Found live on 2026-10-03, a task told to
   * keep a JSON file's formatting rewrote it from LF to CRLF and it was committed that way. Not where git
   * converts endings on commit.
   */
  if (!endings.normalized && !has['mixed-line-endings']) {
    const n = endingsOf(now);
    const only = n.crlf > 0 && n.lf === 0 ? 'crlf' : n.lf > 0 && n.crlf === 0 ? 'lf' : null;
    if (only && before) {
      const b = endingsOf(before);
      const was = b.crlf > 0 && b.lf === 0 ? 'crlf' : b.lf > 0 && b.crlf === 0 ? 'lf' : null;
      if (was && was !== only) out.push({ path, kind: 'line-endings-changed', detail: `every line ending changed from ${was.toUpperCase()} to ${only.toUpperCase()}` });
    }
    /*
     * A new file is not held to the repository's style: every file PowerShell's Set-Content writes ends
     * its lines in CRLF, so on a repository without line-ending conversion that cost nearly every task a
     * round. A file changed from one ending to the other is the change that misleads a diff.
     */
  }
  return out;
}

/** Whether git converts line endings in this repository on commit, and the style its files have. */
export async function lineEndingRule(dir: string): Promise<LineEndingRule> {
  const auto = (await gitBytes(dir, ['config', '--get', 'core.autocrlf'])).stdout.toString('utf8').trim().toLowerCase();
  if (auto === 'true' || auto === 'input') return { normalized: true };
  const eol = await gitBytes(dir, ['ls-files', '--eol']);
  let lf = 0;
  let crlf = 0;
  for (const line of eol.stdout.toString('utf8').split('\n')) {
    // i/lf    w/lf    attr/text=auto   path
    const m = /^i\/(\S*)\s+w\/\S*\s+attr\/(\S*)/.exec(line);
    if (!m) continue;
    if (/(^|\s)(text|eol=)/.test(m[2] ?? '') && !/-text/.test(m[2] ?? '')) return { normalized: true };
    if (m[1] === 'lf') lf += 1;
    else if (m[1] === 'crlf') crlf += 1;
  }
  const total = lf + crlf;
  const style = total >= 3 && lf / total >= 0.8 ? 'lf' : total >= 3 && crlf / total >= 0.8 ? 'crlf' : undefined;
  return { normalized: false, ...(style ? { style } : {}) };
}

/** The problems the task added to these working-tree paths, compared with `baseCommit`. */
export async function scanChanges(dir: string, paths: string[], baseCommit: string | undefined, limit = 400): Promise<IntegrityFinding[]> {
  const found: IntegrityFinding[] = [];
  const endings = await lineEndingRule(dir);
  for (const rel of paths.slice(0, limit)) {
    if (rel.endsWith('/') || looksGenerated(rel)) continue;
    const abs = join(dir, rel);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) continue;
    if (BINARY_EXTENSIONS.has(extensionOf(rel))) continue;
    // A very large file is not read: its size is the finding, compared with the size it had before.
    if (info.size > OVERSIZED_BYTES * 4) {
      const was = baseCommit ? await gitBytes(dir, ['cat-file', '-s', `${baseCommit}:${rel.replace(/\\/g, '/')}`]) : null;
      const wasSize = was?.ok ? Number(was.stdout.toString('utf8').trim()) : 0;
      if (wasSize <= OVERSIZED_BYTES) {
        found.push({ path: rel, kind: 'oversized', detail: `${(info.size / 1024 / 1024).toFixed(1)} MB, far more than anyone writes by hand` });
      }
      continue;
    }
    const now = await readFile(abs).catch(() => null);
    if (!now) continue;
    let before: Buffer | null = null;
    if (baseCommit) {
      const shown = await gitBytes(dir, ['show', `${baseCommit}:${rel.replace(/\\/g, '/')}`]);
      before = shown.ok ? shown.stdout : null;
    }
    found.push(...newProblems(rel, now, before, endings));
  }
  return found;
}

/** What the chat is told, once, before the commit. */
export function integrityDetail(found: IntegrityFinding[]): string {
  const list = found.slice(0, 20).map((f) => `${f.path}: ${f.detail}`).join('; ');
  return (
    `${found.length} problem(s) in the text of files this task changed, none of them there before it: ${list}` +
    `${found.length > 20 ? `; and ${found.length - 20} more` : ''}. Write the files again as UTF-8 without a byte-order mark ` +
    '(in PowerShell 5.1: $f = [IO.File]; $f::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) — not Set-Content -Encoding utf8), ' +
    'the line endings the file and the repository already use (Set-Content adds a Windows line ending after the last line: use -NoNewline and end the here-string with an empty line), ' +
    'no terminal colour codes, and no credentials — load those from the environment. ' +
    'If one of these is intended, leave it and say why in your summary: it will be committed and the finding kept on the task.'
  );
}
