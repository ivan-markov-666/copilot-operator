/**
 * A line diff, laid out side by side: the text before on the left, after on the right, one row per
 * pair of lines, so a single table holds both and scrolling it moves them together.
 *
 * The comparison is Myers' algorithm — the one git uses — after the lines both texts share at the
 * start and at the end are set aside, which for a task's edit to a file is nearly all of it. For
 * the rare pair that differs almost everywhere (a file rewritten, a generated one), the search is
 * capped: past `MAX_EDIT` differences the middle is shown as removed and then added in full, which
 * is still a true account of the change, only not the shortest one.
 */

export type DiffOp = { kind: 'same' | 'del' | 'add'; a?: number; b?: number };

/** One side of a row: its line number (1-based) and its text. */
export type DiffSide = { no: number; text: string };

/**
 * A row of the side-by-side view. `change` pairs a removed line with the added line that took its
 * place; `del` and `add` have one side only.
 */
export type DiffRow = { kind: 'same' | 'change' | 'del' | 'add'; left?: DiffSide; right?: DiffSide };

/** What the view shows: rows, and unchanged stretches folded into a gap that can be opened. */
export type DiffItem = { type: 'row'; row: DiffRow; index: number } | { type: 'gap'; from: number; count: number };

const MAX_EDIT = 2000;

/** The lines of a text, without a final empty line for a trailing newline. */
export function linesOf(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The operations that turn `a` into `b`, line by line. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'same', a: i, b: i });
  for (const op of myers(a.slice(start, endA), b.slice(start, endB))) {
    ops.push({ kind: op.kind, ...(op.a !== undefined ? { a: op.a + start } : {}), ...(op.b !== undefined ? { b: op.b + start } : {}) });
  }
  for (let i = 0; endA + i < a.length; i += 1) ops.push({ kind: 'same', a: endA + i, b: endB + i });
  return ops;
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ kind: 'add' as const, b: j }));
  if (m === 0) return a.map((_, i) => ({ kind: 'del' as const, a: i }));
  const max = n + m;
  // One more than the furthest diagonal on each side: the snapshot below reads k = -d-1 .. d+1, and
  // a negative start would make `slice` count from the end of the array.
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Each step keeps only the diagonals it reached, so the history is O(D²) rather than O(D·(N+M)).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT); d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  // Too different to search to the end: all of the old middle out, all of the new in.
  return [...a.map((_, i) => ({ kind: 'del' as const, a: i })), ...b.map((_, j) => ({ kind: 'add' as const, b: j }))];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const vd = trace[d]!; // diagonals -d-1 .. d+1 as they were before step d
    const at = (k: number): number => vd[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'same', a: x, b: y });
    }
    if (x === prevX) ops.push({ kind: 'add', b: prevY });
    else ops.push({ kind: 'del', a: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'same', a: x, b: y });
  }
  return ops.reverse();
}

/**
 * The operations as side-by-side rows. A run of removed lines followed by added ones is paired line
 * for line, so an edited line sits opposite what it became; what is left over has one side only.
 */
export function sideBySide(before: string[], after: string[]): DiffRow[] {
  const ops = diffLines(before, after);
  const rows: DiffRow[] = [];
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op.kind === 'same') {
      rows.push({ kind: 'same', left: { no: op.a! + 1, text: before[op.a!]! }, right: { no: op.b! + 1, text: after[op.b!]! } });
      i += 1;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < ops.length && ops[i]!.kind !== 'same') {
      const o = ops[i]!;
      if (o.kind === 'del') dels.push(o.a!);
      else adds.push(o.b!);
      i += 1;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p += 1) {
      const l = dels[p];
      const r = adds[p];
      rows.push({
        kind: l !== undefined && r !== undefined ? 'change' : l !== undefined ? 'del' : 'add',
        ...(l !== undefined ? { left: { no: l + 1, text: before[l]! } } : {}),
        ...(r !== undefined ? { right: { no: r + 1, text: after[r]! } } : {}),
      });
    }
  }
  return rows;
}

/**
 * The rows with unchanged stretches longer than twice the context folded into gaps. `open` holds
 * the row index each opened gap starts at; `whole` shows every row.
 */
export function foldRows(rows: DiffRow[], context = 3, open: ReadonlySet<number> = new Set(), whole = false): DiffItem[] {
  if (whole) return rows.map((row, index) => ({ type: 'row' as const, row, index }));
  const items: DiffItem[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== 'same') {
      items.push({ type: 'row', row: rows[i]!, index: i });
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'same') j += 1;
    const lead = i === 0 ? 0 : context; // lines kept after the change above
    const tail = j === rows.length ? 0 : context; // lines kept before the change below
    const hidden = j - i - lead - tail;
    if (hidden > 1 && !open.has(i + lead)) {
      for (let k = i; k < i + lead; k += 1) items.push({ type: 'row', row: rows[k]!, index: k });
      items.push({ type: 'gap', from: i + lead, count: hidden });
      for (let k = j - tail; k < j; k += 1) items.push({ type: 'row', row: rows[k]!, index: k });
    } else {
      for (let k = i; k < j; k += 1) items.push({ type: 'row', row: rows[k]!, index: k });
    }
    i = j;
  }
  return items;
}

/**
 * The part of a changed line that differs from the line opposite: what the two share at the start
 * and at the end is left plain, and the middle is marked.
 */
export function changedSpan(left: string, right: string): { start: number; leftEnd: number; rightEnd: number } {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let l = left.length;
  let r = right.length;
  while (l > start && r > start && left[l - 1] === right[r - 1]) {
    l -= 1;
    r -= 1;
  }
  return { start, leftEnd: l, rightEnd: r };
}
