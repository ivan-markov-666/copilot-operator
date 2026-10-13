/**
 * What the bot's terminal showed, kept so it can be downloaded from the page.
 *
 * Asked for on 2026-10-13: when a run does not start at all, the operator wants to see the error, and
 * a place to download what happened in the terminal. The terminal is the console the API runs in —
 * `npm start` or `cop start` — and what it printed was on that screen only: a stack trace from
 * Playwright about the browser profile, a refusal from git, scrolled away or closed with the window.
 *
 * Everything this process writes to stdout and stderr is copied, line by line with the time it was
 * written, into a ring of the latest lines in memory and into `<data>/logs/terminal.log` on disk (the
 * data folder is narrowed to this account; see `api/dataAcl.ts`), which rolls over to `terminal.1.log`
 * at 5 MB. Writing to the console is not changed in any way: the copy is taken on the side, and a copy
 * that fails is dropped rather than allowed to break the write it was copying.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type TerminalLine = { at: string; stream: 'out' | 'err'; text: string };

const MAX_LINES = 5_000;
const MAX_LINE = 4_000;
const ROLL_AT = 5 * 1024 * 1024;

const ring: TerminalLine[] = [];
const partial: Record<'out' | 'err', string> = { out: '', err: '' };
let installed = false;
let file: string | null = null;
let written = 0;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The file the lines go to, once `captureTerminal` was given a folder. */
export function terminalLogFile(): string | null {
  return file;
}

/**
 * Starts copying this process's console, once; a later call only points the copy at another folder.
 * Lines written before a folder is known are kept in memory and written to the file when it is.
 */
export function captureTerminal(dir?: string): void {
  if (dir) setFolder(dir);
  if (installed) return;
  installed = true;
  for (const stream of ['out', 'err'] as const) {
    const target = stream === 'out' ? process.stdout : process.stderr;
    const original = target.write.bind(target) as (...args: unknown[]) => boolean;
    target.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        take(stream, typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '');
      } catch {
        /* the copy is never allowed to break the write */
      }
      return original(chunk, ...rest);
    }) as typeof target.write;
  }
}

function setFolder(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const next = join(dir, 'terminal.log');
    if (next === file) return;
    const first = file === null;
    file = next;
    written = sizeOf(next);
    // What was printed before the folder was known — the start-up — goes in first.
    if (first && ring.length > 0) append(ring.map(format).join(''));
  } catch {
    file = null;
  }
}

function take(stream: 'out' | 'err', text: string): void {
  if (!text) return;
  const parts = (partial[stream] + text).split(/\r?\n/);
  partial[stream] = parts.pop() ?? '';
  // A line that never ends (a progress bar) is still kept, in pieces.
  if (partial[stream].length > MAX_LINE) {
    parts.push(partial[stream]);
    partial[stream] = '';
  }
  const at = new Date().toISOString();
  const out: TerminalLine[] = [];
  for (const raw of parts) {
    const clean = raw.replace(ANSI, '').replace(/\r/g, '');
    if (!clean.trim()) continue;
    out.push({ at, stream, text: clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)} …` : clean });
  }
  if (out.length === 0) return;
  ring.push(...out);
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
  if (file) append(out.map(format).join(''));
}

function format(l: TerminalLine): string {
  return `${l.at} ${l.stream === 'err' ? 'ERR' : 'OUT'} ${l.text}\n`;
}

function append(text: string): void {
  if (!file) return;
  try {
    if (written + text.length > ROLL_AT) {
      try {
        renameSync(file, file.replace(/\.log$/, '.1.log'));
      } catch {
        /* nothing to roll over yet */
      }
      written = 0;
    }
    appendFileSync(file, text, 'utf8');
    written += Buffer.byteLength(text);
  } catch {
    /* a full disk or a locked file costs the copy, not the console */
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The lines kept in memory from `from` to `to` (both inclusive, ISO times), the latest `max` of them. */
export function terminalLines(opts: { from?: string; to?: string; max?: number } = {}): TerminalLine[] {
  const within = ring.filter((l) => (!opts.from || l.at >= opts.from) && (!opts.to || l.at <= opts.to));
  return opts.max !== undefined && within.length > opts.max ? within.slice(within.length - opts.max) : within;
}

/** The lines as the download shows them: local time, the stream, the text. */
export function formatTerminal(list: TerminalLine[]): string {
  return list.map((l) => `${localTime(l.at)} ${l.stream === 'err' ? 'ERR' : '   '} ${l.text}`).join('\n');
}

/** `2026-10-13 10:22:31.123` in this machine's time zone. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
