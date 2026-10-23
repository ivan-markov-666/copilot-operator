/**
 * Everything the bot has kept, as one file (operator, 2026-10-23: "an option to export everything saved so far under
 * this profile — we keep it in the bot's folder anyway"): its settings, conversations, skills, level 2 templates and
 * logs — `data/` — and, when asked for, every run's records — `runs/`. A `manifest.json` says what is in it and what
 * was left out, and why: the API's key, which belongs to this machine alone, and the Edge profile, which holds the
 * Microsoft 365 sign-in — a file carrying that would sign anybody who has it in as the operator.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InstallLayout } from './layout.js';
import type { ZipEntry } from '../util/zip.js';

/** Files of the data folder never exported, by name: this machine's key and the API's own bookkeeping. */
const NEVER = new Set(['api-token', 'dev-pids.json', '.cop-lock.json']);

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

/** The files of an export, named as they go in the archive (`data/…`, `runs/…`), and its manifest first. */
export function exportEntries(layout: InstallLayout, opts: { runs: boolean; version: string; now?: Date }): ZipEntry[] {
  const now = opts.now ?? new Date();
  const entries: ZipEntry[] = [];
  const add = (root: string, under: string) => (f: Found): void => {
    entries.push({ name: `${under}/${relative(root, f.path).replace(/\\/g, '/')}`, data: readFileSync(f.path), mtime: f.mtime });
  };
  const data = dataFiles(layout);
  data.forEach(add(layout.dataDir, 'data'));
  const runs = opts.runs ? filesUnder(layout.runsDir) : [];
  runs.forEach(add(layout.runsDir, 'runs'));
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
  return [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: now }, ...entries];
}

/** The export's file name: copilot-operator-export-20261023-1142.zip. */
export function exportFileName(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `copilot-operator-export-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}.zip`;
}
