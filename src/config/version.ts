/**
 * The version of the copilot-operator that is running, from its own package.json.
 *
 * It was a literal, '0.1.0', and stayed that through thirteen releases, so a bug report's
 * `cop --version` named a version that never had the bug. Read where the code is — `src/` under
 * tsx, `dist/src/` in a clone, `node_modules/copilot-operator/dist/src/` once installed — so it
 * cannot drift from what npm installed. botRootDir() falls back to the working directory when it
 * finds no package.json of ours, and that one is the user's project's: its version is not ours to
 * print, so the name is checked and anything else says "unknown".
 *
 * Written into every export and attempt record too: a report sent as a screenshot from another
 * machine could not say which version made it, and the operator had to be asked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { botRootDir } from '../exec/workDir.js';

let cached: string | undefined;

export function botVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(join(botRootDir(), 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (pkg.name === 'copilot-operator' && typeof pkg.version === 'string' && pkg.version) return (cached = pkg.version);
  } catch {
    // No readable package.json: say so rather than guess.
  }
  return 'unknown';
}
