/**
 * The model the page offers now for a name chosen earlier.
 *
 * Microsoft renames models in the picker: "GPT 5.6 Think deeper" became "GPT 5.6 Sol Think deeper" (seen
 * live on 2026-10-04), and a name saved in Settings or a plan then matched nothing, so every run went on
 * the chat's default. The picker on the page is the source of truth, so a name it no longer offers is
 * looked for there under its new form: the same words with others added ("Sol"), or the same words with
 * another version number ("5.7" for "5.6"). Only one answer is taken; two that fit as well are not guessed
 * between, and the first word (the family, "GPT") must stay the same, so "Think deeper" never turns into a
 * vendor's model.
 */
import type { ModelOption } from './copilotTransport.js';

/**
 * A model name as compared: the page writes the same model "GPT 5.6 Sol Think deeper" one day and
 * "GPT-5.6 Sol Think deeper" the next (both read live, 2026-10-04 and -05), so case, dashes and spacing
 * do not make a different model.
 */
export function normModel(name: string): string {
  return name.toLowerCase().replace(/[-‐‑‒–—_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normModel(a) === normModel(b);
}

/**
 * Whether the picker button, which shortens a name by dropping words from its end ("GPT-5.6 Sol Think
 * deeper" shows "GPT-5.6 Sol Think"), shows this model. Whole words from the start only: any piece of the
 * name counted before, so "Think deeper" on the button was taken for "GPT-5.6 Sol Think deeper" chosen.
 */
export function buttonShows(shown: string | null | undefined, asked: string): boolean {
  if (!shown) return false;
  const s = normModel(shown);
  const a = normModel(asked);
  return s.length > 0 && (s === a || a.startsWith(`${s} `));
}

const words = (name: string): string[] => normModel(name).split(' ').filter(Boolean);
const isVersion = (w: string): boolean => /^v?\d+(?:\.\d+)*$/.test(w);
const versionOf = (ws: string[]): number[] => (ws.find(isVersion) ?? '').replace(/^v/, '').split('.').map(Number).filter((n) => !Number.isNaN(n));

function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function pageModelFor(wanted: string, options: readonly ModelOption[]): ModelOption | null {
  const offered = options.filter((o) => !o.disabled && o.name.trim());
  const exact = offered.find((o) => sameModel(o.name, wanted));
  if (exact) return exact;
  const want = words(wanted);
  if (want.length === 0) return null;

  /** The options whose words hold all of `need`, same first word, fewest words added; null when two tie. */
  const closest = (need: string[], strip: (ws: string[]) => string[]): ModelOption | null => {
    const fits = offered
      .map((o) => ({ o, ws: strip(words(o.name)) }))
      .filter(({ ws }) => ws[0] === need[0] && need.every((w) => ws.includes(w)))
      .map(({ o, ws }) => ({ o, extra: ws.length - need.length }));
    if (fits.length === 0) return null;
    const least = Math.min(...fits.map((f) => f.extra));
    const best = fits.filter((f) => f.extra === least);
    if (best.length === 1) return best[0]!.o;
    // The same name in several versions: the newest, which is what the line-up moved on to.
    const byVersion = [...best].sort((a, b) => newer(versionOf(words(b.o.name)), versionOf(words(a.o.name))));
    return newer(versionOf(words(byVersion[0]!.o.name)), versionOf(words(byVersion[1]!.o.name))) > 0 ? byVersion[0]!.o : null;
  };

  return closest(want, (ws) => ws) ?? closest(want.filter((w) => !isVersion(w)), (ws) => ws.filter((w) => !isVersion(w)));
}
