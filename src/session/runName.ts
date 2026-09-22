/**
 * What a run is called when nobody typed anything.
 *
 * "Unnamed run" was the heading on half the register, and it is not a cosmetic complaint: the
 * register's whole organising idea is that finished work is grouped under the run that produced
 * it, so a group labelled with nothing has thrown the grouping away. It showed up hardest in the
 * two places naming is least convenient — continuing after a failure, and "Run again from here",
 * which starts the same kind of run from a task card that has no field to type into and so never
 * named anything at all.
 *
 * The rule is: the name is the work's, plus which go at it this is. A session continued from a
 * run called `rules-engine` produces `rules-engine #2`, then `#3`; one whose earlier run had no
 * name takes the session's own name; across several sessions it takes the task the trouble was
 * about, and failing that says how many sessions it is. The number is counted over every name
 * ever used rather than over the sessions in hand, so two runs can never share a heading.
 *
 * `#2` rather than "attempt 2" because this is decided on the server, which has no business
 * guessing which language the operator reads, and because it survives the export file names
 * intact — those strip anything that is not a letter, a digit, a dot, a space or a hyphen.
 *
 * It lives here, apart from the service, so that the rule can be asked questions directly. A
 * naming rule re-implemented inside its own test is a rule with nothing holding it.
 */
import type { Session } from './model.js';

/** A trailing ` #12` taken off, so the counter never stacks up into `name #2 #3`. */
function stripNumber(name: string): string {
  return name.replace(/\s*#\d+$/, '').trim();
}

export function suggestRunName(all: Session[], sessionIds: string[], about?: string): string {
  const wanted = new Set(sessionIds);
  /** Every name any run has ever carried, wherever it was written down. */
  const used = new Set<string>();
  /** The names these particular sessions last ran under, newest first. */
  const theirs: Array<{ name: string; at: string }> = [];

  for (const session of all) {
    const groups = [session.runGroup, ...session.tasks.flatMap((t) => [t.runGroup, ...(t.attempts ?? []).map((a) => a.runGroup)])];
    for (const group of groups) {
      if (!group?.name) continue;
      used.add(group.name);
      if (wanted.has(session.id)) theirs.push({ name: group.name, at: group.startedAt });
    }
  }

  theirs.sort((a, b) => b.at.localeCompare(a.at));
  const chosen = all.filter((s) => wanted.has(s.id));
  const base =
    stripNumber(theirs[0]?.name ?? '') ||
    (chosen.length === 1 ? chosen[0].name.trim() : '') ||
    (about ?? '').trim() ||
    // Nothing to go on: say what it is rather than leave it blank again.
    (chosen.length > 0 ? `${chosen.length} sessions` : 'run');

  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} #${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}
