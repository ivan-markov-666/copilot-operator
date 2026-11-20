/**
 * Everything the bot has kept, as one file (operator, 2026-10-23: "an option to export everything saved so far under
 * this profile — we keep it in the bot's folder anyway"): its settings, conversations, skills, level 2 templates and
 * logs — `data/` — and, when asked for, every run's records — `runs/`. A `manifest.json` says what is in it and what
 * was left out, and why: the API's key, which belongs to this machine alone, and the Edge profile, which holds the
 * Microsoft 365 sign-in — a file carrying that would sign anybody who has it in as the operator.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Writable } from 'node:stream';
import type { InstallLayout } from './layout.js';
import { ZipWriter, type ZipEntry } from '../util/zip.js';

/** Files of the data folder never exported, by name: this machine's key and the API's own bookkeeping. */
const NEVER = new Set(['api-token', 'dev-pids.json', '.cop-lock.json', 'api.lock.json']);

type Found = { path: string; size: number; mtime: Date };

function filesUnder(dir: string): Found[] {
  const out: Found[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push({ path: p, size: st.size, mtime: st.mtime });
    }
  };
  walk(dir);
  return out;
}

const dataFiles = (layout: InstallLayout): Found[] => filesUnder(layout.dataDir).filter((f) => !NEVER.has(relative(layout.dataDir, f.path).replace(/\\/g, '/')));

/** How much an export would hold: the data folder, and the runs' records if asked for. */
export function exportSizes(layout: InstallLayout): { data: number; dataFiles: number; runs: number; runsFiles: number } {
  const data = dataFiles(layout);
  const runs = filesUnder(layout.runsDir);
  return { data: data.reduce((n, f) => n + f.size, 0), dataFiles: data.length, runs: runs.reduce((n, f) => n + f.size, 0), runsFiles: runs.length };
}

/** What an export holds: its files, named as they go in the archive (`data/…`, `runs/…`), and its manifest. */
export type ExportPlan = { files: Array<{ name: string; path: string; mtime: Date }>; manifest: Record<string, unknown>; now: Date };

export function exportPlan(layout: InstallLayout, opts: { runs: boolean; version: string; now?: Date }): ExportPlan {
  const now = opts.now ?? new Date();
  const named = (root: string, under: string) => (f: Found) => ({ name: `${under}/${relative(root, f.path).replace(/\\/g, '/')}`, path: f.path, mtime: f.mtime });
  const data = dataFiles(layout);
  const runs = opts.runs ? filesUnder(layout.runsDir) : [];
  const manifest = {
    exportedBy: `copilot-operator ${opts.version}`,
    exportedAt: now.toISOString(),
    from: layout.homeDir,
    holds: [
      { what: 'data/', files: data.length, is: 'settings, conversations, skills, level 2 templates, logs' },
      ...(opts.runs ? [{ what: 'runs/', files: runs.length, is: "every run's records: transcripts, replies, reports" }] : []),
    ],
    leftOut: [
      { what: 'data/api-token', why: "the key of this machine's API: it belongs to this machine alone" },
      { what: 'edge-profile/', why: 'the Edge profile holds the Microsoft 365 sign-in; anybody with it would be signed in as you' },
      ...(opts.runs ? [] : [{ what: 'runs/', why: 'not asked for' }]),
    ],
  };
  return { files: [...data.map(named(layout.dataDir, 'data')), ...runs.map(named(layout.runsDir, 'runs'))], manifest, now };
}

/** The manifest as it goes in, with the files that could not be read named. */
function manifestEntry(plan: ExportPlan, notRead: Array<{ what: string; why: string }>): ZipEntry {
  const manifest = notRead.length > 0 ? { ...plan.manifest, notRead } : plan.manifest;
  return { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: plan.now };
}

/** The files of an export, read now, and its manifest last: for a few small files. An export goes through `writeExport`. */
export function exportEntries(layout: InstallLayout, opts: { runs: boolean; version: string; now?: Date }): ZipEntry[] {
  const plan = exportPlan(layout, opts);
  const entries: ZipEntry[] = [];
  const notRead: Array<{ what: string; why: string }> = [];
  for (const f of plan.files) {
    try {
      entries.push({ name: f.name, data: readFileSync(f.path), mtime: f.mtime });
    } catch (e) {
      notRead.push({ what: f.name, why: (e as Error).message });
    }
  }
  return [...entries, manifestEntry(plan, notRead)];
}

/**
 * An export written to the download as it goes (second bug hunt, 2026-11-19): one file read at a time, off the API's
 * thread, the archive never whole in memory. A file that cannot be read — held by another program, gone since it was
 * listed — is named in the manifest, which goes in last, and the rest go on: it failed the whole export, which the
 * page's link then saved as a file of its own, the reason not shown.
 */
export async function writeExport(plan: ExportPlan, out: Writable): Promise<{ files: number; notRead: number }> {
  const zip = new ZipWriter(out);
  const notRead: Array<{ what: string; why: string }> = [];
  let files = 0;
  for (const f of plan.files) {
    let data: Buffer;
    try {
      data = await readFile(f.path);
    } catch (e) {
      notRead.push({ what: f.name, why: (e as Error).message });
      continue;
    }
    await zip.add({ name: f.name, data, mtime: f.mtime });
    files += 1;
  }
  await zip.add(manifestEntry(plan, notRead));
  await zip.finish();
  return { files, notRead: notRead.length };
}

/** The export's file name: copilot-operator-export-20261023-1142.zip. */
export function exportFileName(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `copilot-operator-export-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}.zip`;
}
