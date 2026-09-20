/**
 * Naming an Edge crash, so a run that dies says why.
 *
 * When the browser process goes away, every Playwright call afterwards fails with "Target
 * page, context or browser has been closed", which explains nothing: a closed window, a
 * second Edge on the same profile and a crash all read the same. But Edge writes a minidump
 * into the profile's `Crashpad/reports` the instant it crashes, with the process type and the
 * version in `watson_metadata` next to it. A run that ended that way can point at the report
 * — which is what made the attachment crash diagnosable at all: three reports, one per
 * attempt, `ProcessType=browser`, the same `SubCode`, and the click was the cause.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type EdgeCrash = {
  /** The minidump's path. */
  report: string;
  /** When it was written, ISO. */
  at: string;
  /** `browser`, `renderer`, `gpu-process`, ... Only a browser-process crash ends the run. */
  processType?: string;
  version?: string;
  subCode?: string;
};

/** The last values of the fields that matter, out of the binary metadata file. */
export function parseWatsonMetadata(text: string): Pick<EdgeCrash, 'processType' | 'version' | 'subCode'> {
  const last = (re: RegExp): string | undefined => {
    let value: string | undefined;
    for (const m of text.matchAll(re)) value = m[1];
    return value;
  };
  return {
    processType: last(/ProcessType=([A-Za-z-]+)/g),
    version: last(/ApplicationVersion=([0-9.]+)/g),
    subCode: last(/SubCode=(0x[0-9A-Fa-f]+)/g),
  };
}

/** The newest minidump written within `sinceMs`, with what the metadata says about it. */
export async function findRecentCrash(profileDir: string, sinceMs = 5 * 60_000, now = Date.now()): Promise<EdgeCrash | null> {
  const dir = join(profileDir, 'Crashpad', 'reports');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.dmp'));
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    if (s.mtimeMs < now - sinceMs) continue;
    if (!newest || s.mtimeMs > newest.mtime) newest = { path, mtime: s.mtimeMs };
  }
  if (!newest) return null;
  const meta = await readFile(join(profileDir, 'Crashpad', 'watson_metadata'), 'latin1').catch(() => '');
  return { report: newest.path, at: new Date(newest.mtime).toISOString(), ...parseWatsonMetadata(meta) };
}

/** One sentence for a task's reason and the log. */
export function describeCrash(c: EdgeCrash): string {
  const what = c.processType ? `Edge's ${c.processType} process crashed` : 'Edge crashed';
  const details = [c.version ? `Edge ${c.version}` : '', c.subCode ? `code ${c.subCode}` : ''].filter(Boolean).join(', ');
  return `${what}${details ? ` (${details})` : ''} at ${c.at}; report: ${c.report}`;
}
