/**
 * Writes the terminal output of one iteration to disk, as the `.txt` file that gets attached
 * to the chat.
 *
 * The composer rejects messages beyond roughly 120 000 characters and a single verbose
 * command can pass that on its own, so the output never travels as message text. Attachments
 * carry no such limit, which is the whole reason this file exists.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult } from './runner.js';

export type ReportOptions = {
  runId: string;
  /** The task this report belongs to, by the name the conversation was given for it. */
  task?: string;
  iteration: number;
  dir: string;
  fileNameTemplate: string;
  maxReportBytes: number;
  maxOutputChars: number;
  redactPatterns: string[];
};

export type WrittenReport = {
  /** Absolute paths, in order. More than one when the report had to be split. */
  paths: string[];
  /** File names only, for the covering message. */
  names: string[];
  bytes: number;
  parts: number;
};

/**
 * Removes terminal colour codes.
 *
 * `NO_COLOR` covers the shells this runs, but a program that colours unconditionally would
 * otherwise fill the report Copilot reads with escape sequences. Belt as well as braces,
 * because the cost of a stray escape is a confused model.
 */
// The escape character is what makes this safe. Without it the pattern would match a
// plain `[`, and PowerShell output is full of `[pscustomobject]` and `[double]`, so the
// cleanup would quietly eat real characters.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Replaces anything the user asked to keep off the wire. Applied to the whole report. */
export function redact(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) {
    try {
      out = out.replace(new RegExp(p, 'gi'), '[REDACTED]');
    } catch {
      out = out.split(p).join('[REDACTED]');
    }
  }
  return out;
}

/** Keeps the head and the tail of an over-long stream and says how much was dropped. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[... ${dropped} characters omitted ...]\n\n${text.slice(-half)}`;
}

function sectionFor(r: RunResult, maxOutputChars: number): string {
  const head =
    `--- step ${r.id} (${r.shell}, ${r.outcome}, exit ${r.exitCode}, ` +
    `${(r.durationMs / 1000).toFixed(1)}s)\n$ ${r.command}\n`;
  const out = clip(r.stdout, maxOutputChars);
  const err = r.stderr.trim().length > 0 ? `[stderr]\n${clip(r.stderr, maxOutputChars)}\n` : '';
  const note = r.truncated ? `[note] output was truncated; the full stream is in ${r.logPath}\n` : '';
  return `${head}${out}${out.endsWith('\n') ? '' : '\n'}${err}${note}`;
}

/**
 * Builds the report and writes it, splitting on step boundaries when it would exceed
 * `maxReportBytes`. Splitting mid-step is never done: a half-printed stack trace is worse
 * than two files.
 */
export async function writeReport(
  results: RunResult[],
  opts: ReportOptions,
): Promise<WrittenReport> {
  await mkdir(opts.dir, { recursive: true });

  /*
   * The header identifies the report by the task's own name.
   *
   * It used to lead with `run=<id>`, and that one string cost three runs. The id names a folder
   * on this machine and appears nowhere else Copilot can see: not in the task message, not in
   * the contract, nowhere. Two tasks in one conversation therefore produce two reports bearing
   * two identifiers that were never introduced — and a model asked to reconcile a result with
   * the task it belongs to reasons, correctly, that it was never told which task owns this id.
   * Observed three times, ending the last one in "the result belongs to run s922, but no task
   * instructions for that run were supplied in this conversation". The task had been supplied;
   * the id had not.
   *
   * So the title leads, because the title is what the task message announced, and the folder
   * name follows with a label saying whose bookkeeping it is.
   */
  const label = opts.task?.trim() ? `task="${opts.task.trim()}"` : `run=${opts.runId}`;
  const folder = opts.task?.trim() ? ` (runner's own folder: ${opts.runId})` : '';
  const header = `RESULTS ${label} iteration=${opts.iteration} steps=${results.length}${folder}\n`;
  const footer = 'END RESULTS\n';
  const sections = results.map((r) => redact(sectionFor(r, opts.maxOutputChars), opts.redactPatterns));

  const chunks: string[][] = [[]];
  let size = Buffer.byteLength(header) + Buffer.byteLength(footer);
  for (const s of sections) {
    const bytes = Buffer.byteLength(s);
    const current = chunks[chunks.length - 1];
    if (current.length > 0 && size + bytes > opts.maxReportBytes) {
      chunks.push([s]);
      size = Buffer.byteLength(header) + Buffer.byteLength(footer) + bytes;
    } else {
      current.push(s);
      size += bytes;
    }
  }

  const parts = chunks.length;
  const paths: string[] = [];
  const names: string[] = [];
  let total = 0;

  for (let i = 0; i < parts; i += 1) {
    const base = opts.fileNameTemplate.replace('{n}', String(opts.iteration));
    const name =
      parts === 1 ? base : base.replace(/(\.[^.]+)$/, `-part${i + 1}$1`);
    const partHeader =
      parts === 1 ? header : header.replace('\n', ` part=${i + 1}/${parts}\n`);
    const body = `${partHeader}${chunks[i].join('')}${footer}`;
    const path = join(opts.dir, name);
    await writeFile(path, body, 'utf8');
    paths.push(path);
    names.push(name);
    total += Buffer.byteLength(body);
  }

  return { paths, names, bytes: total, parts };
}
