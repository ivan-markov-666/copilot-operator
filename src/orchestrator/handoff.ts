/**
 * Commands the operator runs themselves (operator, 2026-10-26: "the script is made, but the user runs it; the bot gives
 * the commands for the user to run and the result it expects"). The runner never runs a script written during the
 * work (`exec/scriptFiles.ts`); the chat hands it over with `"status": "handoff"` and the operator gets a card: the
 * lines in order, the folder, what should be seen, and the script files they run, read from disk with their SHA-256,
 * so what the operator reads is what they run. A line the runner would refuse outright is marked on the card: the
 * card is not a way round the rules, and the operator is told so before running it in their own terminal.
 *
 * What the operator sends back goes to the chat in the same words wherever it was answered: on the card in the
 * conversation, or on a queue task's card answered after it was set aside.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Handoff } from '../protocol/replySchema.js';
import type { HandoffCard } from '../session/model.js';
import { dangerousRefusal } from '../exec/dangerous.js';
import { botSelfRefusal } from '../exec/network.js';
import { matchDenyPattern } from '../exec/policy.js';

/** The most of one script shown on the card; its hash is of all of it. */
const MAX_SHOWN_BYTES = 64 * 1024;
/** A script larger than this is not read for the card at all. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

const inside = (roots: string[], path: string): boolean =>
  roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

/** The card for a handoff: the folder resolved in the project, each script read with its hash, the lines the runner refuses. */
export function handoffCard(h: Handoff, cwd: string, roots: string[], denyPatterns: string[]): HandoffCard {
  const folder = resolve(cwd, h.cwd ?? '.');
  const files: HandoffCard['files'] = h.files.map((f) => {
    const full = resolve(folder, f);
    const path = relative(cwd, full).replace(/\\/g, '/') || f;
    if (!inside(roots, full)) return { path: f, problem: 'outside the project' };
    if (!existsSync(full)) return { path, problem: 'not there' };
    try {
      const size = statSync(full).size;
      if (size > MAX_READ_BYTES) return { path, problem: `too large to show (${Math.round(size / 1024)} KB)` };
      const bytes = readFileSync(full);
      const text = bytes.subarray(0, MAX_SHOWN_BYTES).toString('utf8');
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), text, ...(bytes.length > MAX_SHOWN_BYTES ? { cut: true } : {}) };
    } catch (e) {
      return { path, problem: (e as Error).message };
    }
  });
  const warnings: string[] = [];
  h.commands.forEach((line, i) => {
    const deny = matchDenyPattern(line, denyPatterns);
    const why = dangerousRefusal(line) ?? botSelfRefusal(line) ?? (deny ? `refused: matches deny pattern /${deny}/` : null);
    if (why) warnings.push(`${i + 1}: ${why.replace(/^refused:\s*/, '')}`);
  });
  return {
    commands: h.commands,
    cwd: folder,
    expect: h.expect,
    files,
    ...(inside(roots, folder) ? {} : { outside: true }),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** What the chat is told of the commands it handed over: what they printed when the operator ran them, or that they did not. */
export function handoffResultMessage(h: Pick<HandoffCard, 'commands' | 'expect'>, ran: boolean, text: string): string {
  const lines = h.commands.map((c) => `  ${c}`).join('\n');
  const said = text.trim();
  if (!ran) {
    return (
      `The operator did not run the commands you handed over:\n${lines}\n\n${said ? `They say: ${said}\n\n` : ''}` +
      'Go on with the work without them, or end blocked and say in "needed" what has to be run.'
    );
  }
  const fence = said.includes('```') ? '~~~~' : '```';
  return (
    `The operator ran the commands you handed over, themselves:\n${lines}\n\n` +
    `What it printed, as they gave it:\n\n${fence}\n${said || '(nothing)'}\n${fence}\n\n` +
    `You expected: ${h.expect}\n\nCompare the two and go on with the work from here, in the same format.`
  );
}

/** What the chat is told when nobody is there to run them: the terminal's run, or one with nobody to ask. */
export const HANDOFF_NOBODY =
  'Nobody is here to run the commands you handed over: this run has nobody to ask. Go on with the work without them, ' +
  'or end blocked and say in "needed" what the operator has to run and what it should show.';
