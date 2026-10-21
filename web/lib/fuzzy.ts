/**
 * Finding a file by a few letters of its name, as VS Code's "Go to File" (Ctrl+P) does (2026-10-21).
 *
 * The letters typed must come in order; where they fall decides the order of the list: in the file's name before its
 * folders, one after another rather than scattered, at the start of a word (after `/`, `.`, `-`, `_`, a lower letter
 * then an upper one) rather than inside one, and a shorter path first. A query with a slash in it is matched against
 * the whole path. Spaces split it into parts that must all be found.
 */

export type FuzzyHit = { path: string; score: number; nameHits: number[]; dirHits: number[] };

const isStart = (s: string, i: number): boolean => i === 0 || /[/\\._\-\s]/.test(s[i - 1]!) || (/[a-z]/.test(s[i - 1]!) && /[A-Z]/.test(s[i]!));

/** Where the letters of `q` fall in `s`, in order, and how well; null when they do not all. */
function matchIn(s: string, q: string): { score: number; hits: number[] } | null {
  const lower = s.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q.toLowerCase()) {
    // The nearest place, preferring the start of a word not far ahead.
    let at = lower.indexOf(ch, from);
    if (at < 0) return null;
    for (let j = at; j >= 0 && j < lower.length && j < at + 12; j = lower.indexOf(ch, j + 1)) {
      if (isStart(s, j)) {
        at = j;
        break;
      }
    }
    score += 1;
    if (at === last + 1) score += 5;
    if (isStart(s, at)) score += 3;
    if (s[at] === ch) score += 1;
    hits.push(at);
    last = at;
    from = at + 1;
  }
  return { score: score - Math.max(0, hits[0]!) * 0.05, hits };
}

export function fuzzyFile(path: string, query: string): FuzzyHit | null {
  const q = query.trim();
  if (!q) return { path, score: 0, nameHits: [], dirHits: [] };
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  let score = 0;
  const nameHits: number[] = [];
  const dirHits: number[] = [];
  for (const part of q.split(/\s+/).filter(Boolean)) {
    if (part.includes('/')) {
      const whole = matchIn(path, part);
      if (!whole) return null;
      score += whole.score;
      for (const h of whole.hits) (h > slash ? nameHits.push(h - slash - 1) : dirHits.push(h));
      continue;
    }
    const inName = matchIn(name, part);
    if (inName) {
      score += inName.score + 10 + (name.toLowerCase().startsWith(part.toLowerCase()) ? 8 : 0);
      nameHits.push(...inName.hits);
      continue;
    }
    const whole = matchIn(path, part);
    if (!whole) return null;
    score += whole.score;
    for (const h of whole.hits) (h > slash ? nameHits.push(h - slash - 1) : dirHits.push(h));
  }
  return { path, score: score - path.length * 0.01 - (dir ? dir.split('/').length * 0.2 : 0), nameHits, dirHits };
}

/** The files that match, best first; at most `limit`. */
export function fuzzyFiles(paths: string[], query: string, limit = 50): FuzzyHit[] {
  const out: FuzzyHit[] = [];
  for (const p of paths) {
    const hit = fuzzyFile(p, query);
    if (hit) out.push(hit);
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** "src/app.ts:42" → the file part and the line, as Go to File takes them. */
export function splitLine(query: string): { query: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?\s*$/.exec(query);
  return m ? { query: m[1]!, line: Number(m[2]) } : { query };
}
