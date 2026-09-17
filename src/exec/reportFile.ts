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

  const header =
    `RESULTS run=${opts.runId} iteration=${opts.iteration} steps=${results.length}\n`;
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
