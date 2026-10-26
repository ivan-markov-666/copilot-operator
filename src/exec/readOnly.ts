/**
 * Programs set to read only (operator, 2026-10-26: "give the bot az, with me signing in myself and the bot never
 * learning my credentials; but it is important that it runs without writing, for reference only"). A program on the
 * allowlist that reaches a platform with the operator's access is put to the operator on every command
 * (`platforms.ts`). Set to read only, its commands are read by their own words instead:
 *
 *   reads      `az vm list`, `az group show`, `az graph query`: run without a card, as any other command does
 *   refused    a change (create, delete, update, start, deploy…), a sign-in or sign-out, a secret shown (keys, tokens,
 *              connection strings, app settings), `az rest`, a download: sent back to the chat with why
 *   unclear    a verb known neither way, a word known only when it runs, or the program named where it is not run
 *              directly (a string, `cmd /c`, `Start-Process`): held on a card in every mode, even when Settings agree
 *              with what the bot proposes, since the operator said this program must not write
 *
 * The sign-in is the operator's own: `az login` in their terminal. The bot's commands use it as it is and never see a
 * password, which Microsoft's own window takes. The bot never signs in or out, and az's token cache is outside the
 * project, where no command may reach (`confinement.ts`).
 *
 * The honest limit, the same as everywhere in this folder: this reads the command line. A program the project contains,
 * such as a script that calls Azure's API, is not seen. What makes "read only" true is the account: one with only the
 * Reader role has Azure itself refuse every change.
 */
import { scanCommandHeads, type CallArg } from './commandHeads.js';
import { externalProgram } from './programs.js';

export type ReadOnlyVerdict =
  | { kind: 'refused'; reason: string }
  | { kind: 'unclear'; program: string; why: string }
  | { kind: 'reads'; programs: string[] };

/** What one invocation does, read by its program's rule. */
type Reading = { kind: 'reads' } | { kind: 'refused'; reason: string } | { kind: 'unclear'; why: string };

/** The programs whose commands can be told apart, reading from changing, each by its own rule. */
const RULES: Record<string, (args: CallArg[]) => Reading> = { az: azReading };

/** The programs that may be set to read only: the ones with a rule. */
export function readOnlyCapable(): string[] {
  return Object.keys(RULES);
}

const normalise = (p: string): string => p.trim().toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');

/**
 * What a line does with the programs set to read only, or null when it starts none of them. Refused at the first
 * invocation that changes something; unclear when one cannot be read, or when a program is named more often than the
 * line runs it directly — the rest of its mentions are where its words cannot be read.
 */
export function readOnlyVerdict(command: string, shell: string | undefined, readOnlyPrograms: string[] | undefined): ReadOnlyVerdict | null {
  const set = new Set((readOnlyPrograms ?? []).map(normalise).filter((p) => p in RULES));
  if (set.size === 0) return null;
  const scan = scanCommandHeads(command, shell ?? 'pwsh');
  const runs = new Map<string, number>();
  const programs: string[] = [];
  let unclear: { program: string; why: string } | null = null;
  for (const call of scan.calls) {
    const program = externalProgram(call.head);
    if (!program || !set.has(program)) continue;
    runs.set(program, (runs.get(program) ?? 0) + 1);
    const r = RULES[program]!(call.args);
    if (r.kind === 'refused') return r;
    if (r.kind === 'unclear') unclear ??= { program, why: r.why };
    else if (!programs.includes(program)) programs.push(program);
  }
  for (const program of set) {
    if (mentions(command, program) > (runs.get(program) ?? 0)) {
      unclear ??= { program, why: `${program} is named where its words cannot be read (in a string, a nested shell, Start-Process or a name built at run time)` };
    }
  }
  if (unclear) return { kind: 'unclear', ...unclear };
  return programs.length > 0 ? { kind: 'reads', programs } : null;
}

/** Why a line must not run because a program set to read only would change something, or null. */
export function readOnlyRefusal(command: string, shell: string | undefined, readOnlyPrograms: string[] | undefined): string | null {
  const v = readOnlyVerdict(command, shell, readOnlyPrograms);
  return v?.kind === 'refused' ? v.reason : null;
}

/**
 * The same for the text of a script the line runs, and for a check, which run with nobody asked: a command that cannot
 * be read as only reading has nobody to put it to, so it is refused as well.
 */
export function readOnlyUnaskedRefusal(command: string, shell: string | undefined, readOnlyPrograms: string[] | undefined): string | null {
  const v = readOnlyVerdict(command, shell, readOnlyPrograms);
  if (v?.kind === 'refused') return v.reason;
  if (v?.kind === 'unclear') return readOnlyUnclearRefusal(v.program, v.why);
  return null;
}

/** What the chat is told of a command that could not be read as only reading and had nobody to ask. */
export function readOnlyUnclearRefusal(program: string, why: string): string {
  return (
    `refused: ${program} is set to read only here, and this could not be read as only reading (${why}); ` +
    `nobody is there to judge it. Call ${program} directly on the step's own line, with a command that only reads — list, show or query.`
  );
}

/** How many times the line names the program as a word of its own: `az`, `az.cmd`, `'az'`; not `az.txt` or `lazy`. */
function mentions(command: string, program: string): number {
  const name = program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.match(new RegExp(`(?<![\\w.\\\\/$@-])${name}(?:\\.(?:cmd|exe|bat))?(?![\\w.\\\\/-])`, 'gi'))?.length ?? 0;
}

// ------------------------------------------------------------------------------------------
// az
// ------------------------------------------------------------------------------------------

/** A word of the command that shows a secret: keys, tokens, passwords, connection strings, app settings. */
const AZ_SECRET = /(?:^|-)(?:keys?|credentials?|secrets?|passwords?|tokens?|sas|connection-strings?|appsettings|publishing-profiles?|kubeconfig)(?:$|-)/;
/** The verbs that only read. `get-…`, `list-…` and `show-…` after the secrets are taken out. */
const AZ_READ = /^(?:list|show|query|exists|wait|version|what-if|(?:list|show|get)-[a-z0-9-]+|check-name(?:-availability)?)$/;
/** The verbs that change something, in Azure or in az's own setup; and the ones named after them (`create-for-rbac`). */
const AZ_WRITE =
  /^(?:create|delete|update|set|unset|add|remove|start|stop|restart|reboot|deploy|redeploy|reimage|deallocate|generalize|capture|resize|scale|swap|assign|unassign|purge|recover|restore|backup|renew|regenerate|rotate|reset|import|upload|sync|move|lock|unlock|enable|disable|approve|reject|attach|detach|connect|disconnect|apply|cancel|abort|run|invoke|execute|install|uninstall|register|unregister|grant|revoke|push|tag|untag|migrate|upgrade|failover|promote|convert|link|unlink|clear|flush|cordon|drain|retry|rerun|trigger|publish|release|merge|close|reopen|accept|archive|unarchive|schedule|power-off|rollback|repair|refresh|replace|rename|copy|patch|put|post|send|mount|unmount|activate|deactivate|pause|resume|suspend|terminate|kill)(?:-[a-z0-9-]+)?$/;

/**
 * One `az` invocation. Its command is the group path and the verb at its end, the words before the first option:
 * `az storage account list --query ...` is `storage account list`, read by `list`. `--help` anywhere only prints help.
 */
function azReading(args: CallArg[]): Reading {
  if (args.some((a) => !a.dynamic && /^(?:--help|-h)$/i.test(a.literal))) return { kind: 'reads' };
  const path: string[] = [];
  for (const a of args) {
    if (a.dynamic) return { kind: 'unclear', why: 'a word of the az command is known only when it runs' };
    if (a.literal.startsWith('-')) break;
    path.push(a.literal.toLowerCase());
  }
  // `az`, `az --version`: nothing but the version or the help.
  if (path.length === 0) return { kind: 'reads' };
  const p = path.join(' ');
  if (path[0] === 'rest') {
    return { kind: 'refused', reason: 'refused: "az rest" sends any request to Azure, one that changes something too, and az is set to read only here. Use the resource\'s own list, show or query command.' };
  }
  if (path.some((w) => w === 'login' || w === 'logout')) {
    return {
      kind: 'refused',
      reason: `refused: "az ${p}" signs in or out. The operator signs in with az login themselves; the bot uses that sign-in as it is and never signs in, out or as anyone else. If az says nobody is signed in, end blocked and say so in notes.`,
    };
  }
  if (path[0] === 'account' && (path[1] === 'set' || path[1] === 'clear')) {
    return { kind: 'refused', reason: `refused: "az account ${path[1]}" changes the subscription the operator's own az uses. Name it on the command instead: --subscription <name or id>.` };
  }
  if (path[0] === 'interactive' || path[0] === 'init') {
    return { kind: 'refused', reason: `refused: "az ${p}" waits for a person to type, and nobody types into a step. Run the command itself.` };
  }
  if (path.some((w) => AZ_SECRET.test(w))) {
    return {
      kind: 'refused',
      reason: `refused: "az ${p}" shows a secret (a key, a token, a password, a connection string or app settings), and az is set to read only here: what a step prints goes to the chat. Read the resource with show or list, which leave the secrets out.`,
    };
  }
  // `az find "<words>"` takes what it looks for after it; every other command ends at its verb.
  if (path[0] === 'find') return { kind: 'reads' };
  const verb = path.at(-1)!;
  if (/^download(?:-|$)/.test(verb)) {
    return { kind: 'refused', reason: `refused: "az ${p}" downloads a file, and the bot does not download files; az is set to read only here. Read with list, show or query.` };
  }
  if (AZ_WRITE.test(verb)) {
    return {
      kind: 'refused',
      reason: `refused: "az ${p}" changes something, and az is set to read only here (for reference): its commands may look, never change. Read with list, show or query; if something has to change, say in notes what and leave it to the operator.`,
    };
  }
  if (AZ_READ.test(verb)) return { kind: 'reads' };
  return { kind: 'unclear', why: `"az ${p}" is not known as only reading` };
}
