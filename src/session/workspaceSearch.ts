/**
 * Searching the open folder's code, as VS Code's Search view does (operator, 2026-10-21: "an option to search code in
 * the files, designed and working as in VS Code, so most programmers find it easy").
 *
 * `git grep` does the reading: fast, it skips what .gitignore leaves out and files that are not text, it searches the
 * files not committed yet as well (`--untracked`), and in a folder that is not a repository it reads the folder as it
 * is (`--no-index`). It runs as a process of its own with a time limit, so a pattern that would take forever stops
 * the search, not the bot. The options are VS Code's: match case, whole word, a regular expression (PCRE), and the
 * files to include and to exclude as globs — `*.ts` in any folder, `src/**` from the root.
 *
 * What comes back is grouped by file, each line with where its matches are, for the page to mark them; long lines are
 * cut around the first match. There is a ceiling on matches in all and in one file, said when it is reached.
 */
import { spawn } from 'node:child_process';
import { looksLikeRepo, SAFE_GIT } from '../vcs/git.js';

export type SearchOptions = { matchCase?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string };
/** One line with matches: `text` and `ranges` as shown (a long line cut), `column` and `length` the first match in the line itself. */
export type SearchMatch = { line: number; text: string; ranges: Array<[number, number]>; column?: number; length?: number };
export type SearchFile = { path: string; matches: SearchMatch[] };
export type SearchResult = { files: SearchFile[]; total: number; truncated: boolean; ms: number; problem?: string };

export const MAX_MATCHES = 2000;
const MAX_PER_FILE = 300;
const PREVIEW = 240;
const TIMEOUT_MS = 20_000;

/**
 * A glob as VS Code takes one, as git's pathspecs: a bare `*.ts` is for every folder, one with a slash is from the
 * root, and a name with no wildcard (`dist`, `src/api`) is that file or everything in that folder.
 */
function pathspecs(glob: string, exclude: boolean): string[] {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!g) return [];
  const magic = exclude ? ':(exclude,glob)' : ':(glob)';
  const base = g.includes('/') ? g : `**/${g}`;
  return /[*?[]/.test(g) ? [`${magic}${base}`] : [`${magic}${base}`, `${magic}${base}/**`];
}

function globs(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Where the matches are in a line, for the page to mark: by the same rules as the search, as near as JavaScript can. */
export function rangesIn(text: string, query: string, opts: SearchOptions): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let re: RegExp;
  try {
    const body = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, `gu${opts.matchCase ? '' : 'i'}`);
  } catch {
    return out;
  }
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) break;
    out.push([m.index!, m.index! + m[0].length]);
    if (out.length >= 50) break;
  }
  return out;
}

/** A line as the results show it: whole when short, else cut around its first match. */
function preview(line: string, ranges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  if (line.length <= PREVIEW) return { text: line, ranges };
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, first - 60);
  const end = Math.min(line.length, start + PREVIEW);
  const lead = start > 0 ? '…' : '';
  const shift = start - lead.length;
  return {
    text: `${lead}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
    ranges: ranges.filter(([a]) => a >= start && a < end).map(([a, b]) => [a - shift, Math.min(b, end) - shift] as [number, number]),
  };
}

export async function searchWorkspace(dir: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const started = Date.now();
  if (!query) return { files: [], total: 0, truncated: false, ms: 0 };
  const repo = looksLikeRepo(dir);
  const args = [
    ...SAFE_GIT,
    '-c', 'core.quotepath=false',
    '-c', 'grep.lineNumber=true',
    'grep', '--no-color', '-I', '-n', '-z',
    `--max-count=${MAX_PER_FILE}`,
    ...(repo ? ['--untracked'] : ['--no-index', '--exclude-standard']),
    ...(opts.matchCase ? [] : ['-i']),
    ...(opts.wholeWord ? ['-w'] : []),
    opts.regex ? '-P' : '-F',
    '-e', query,
    '--',
    ...globs(opts.include).flatMap((g) => pathspecs(g, false)),
    ...globs(opts.exclude).flatMap((g) => pathspecs(g, true)),
  ];
  return await new Promise<SearchResult>((resolveSearch) => {
    const child = spawn('git', args, { cwd: dir, windowsHide: true });
    const files = new Map<string, SearchFile>();
    let total = 0;
    let truncated = false;
    let rest = '';
    let errText = '';
    let done = false;
    const finish = (problem?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveSearch({ files: [...files.values()], total, truncated, ms: Date.now() - started, ...(problem ? { problem } : {}) });
    };
    const timer = setTimeout(() => {
      truncated = true;
      child.kill();
      finish(total === 0 ? 'the search took too long and was stopped; narrow it down' : undefined);
    }, TIMEOUT_MS);
    const take = (line: string): void => {
      // path NUL line NUL text — or path NUL line:text, as the git version writes it.
      const a = line.indexOf('\0');
      if (a < 0) return;
      const path = line.slice(0, a);
      const after = line.slice(a + 1);
      const m = /^(\d+)[\0:]([\s\S]*)$/.exec(after);
      if (!m) return;
      const text = m[2]!.replace(/\r$/, '');
      const found = rangesIn(text, query, opts);
      const shown = preview(text, found);
      const file = files.get(path) ?? { path, matches: [] };
      file.matches.push({ line: Number(m[1]), ...shown, ...(found[0] ? { column: found[0][0], length: found[0][1] - found[0][0] } : {}) });
      files.set(path, file);
      // Matches, as VS Code counts them: two on one line are two.
      total += Math.max(1, found.length);
      if (total >= MAX_MATCHES) {
        truncated = true;
        child.kill();
        finish();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      rest += chunk;
      let i: number;
      while (!done && (i = rest.indexOf('\n')) >= 0) {
        take(rest.slice(0, i));
        rest = rest.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errText += chunk;
    });
    child.on('error', (e) => finish(`git could not be started: ${e.message}`));
    child.on('close', (code) => {
      if (rest) take(rest);
      // 1 is "nothing found"; anything above it is git saying the search itself is wrong — a pattern, a glob.
      if (code !== null && code > 1 && total === 0) finish(errText.split('\n').find((l) => l.trim())?.replace(/^fatal:\s*/, '') || `git grep ended with ${code}`);
      else finish();
    });
  });
}
