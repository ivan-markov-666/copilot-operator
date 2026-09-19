/**
 * The include/exclude rule, in the browser.
 *
 * This is the same rule as `findSelectionConflicts` in `src/context/projectMirror.ts`, and it
 * is deliberately in two places: the API refuses a contradictory selection because it must,
 * and the page detects it while the person is still typing, because telling them after a
 * round trip is telling them too late. The API remains the authority; this is only how the
 * form stays honest.
 */
export type ConflictKind = 'same' | 'excluded-parent';
export type SelectionConflict = { include: string; exclude: string; kind: ConflictKind };

export function normalizeDirPath(dir: string): string {
  const cleaned = dir.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return cleaned === '' ? '.' : cleaned;
}

function isUnder(child: string, parent: string): boolean {
  if (parent === '.') return child !== '.';
  return child.toLowerCase().startsWith(`${parent.toLowerCase()}/`);
}

export function findSelectionConflicts(includeDirs: string[], excludeDirs: string[]): SelectionConflict[] {
  const includes = includeDirs.map(normalizeDirPath).filter(Boolean);
  const excludes = excludeDirs.map(normalizeDirPath).filter(Boolean);
  const out: SelectionConflict[] = [];

  for (const inc of includes) {
    for (const exc of excludes) {
      if (inc.toLowerCase() === exc.toLowerCase()) out.push({ include: inc, exclude: exc, kind: 'same' });
      else if (isUnder(inc, exc)) out.push({ include: inc, exclude: exc, kind: 'excluded-parent' });
    }
  }
  return out;
}

/** Lines of a textarea as a list of directories, blank lines dropped. */
export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}
