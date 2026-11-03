/**
 * Lines that stop what they should not (operator, 2026-11-03: "this command stops the cop package — it kills its
 * terminal outright"). Two of them, read with the lexer (`commandHeads.ts`) so that a word in a string is not taken
 * for a command:
 *
 *   - `stopsTheBot`: a line or a script that stops processes by the name the bot runs under — `node`, which is the bot
 *     itself, its API and its web page, and `msedge`, the window its chat is in — or by the bot's own port. An
 *     environment switch that "restarts the server" with `Stop-Process -Name node` stops the bot with it, whichever
 *     terminal it is typed in. The runner refuses it in a step; the card of commands handed over says so.
 *   - `endsTheShell`: a line handed to the operator that ends the PowerShell it is typed in — `exit`, and its kin. The
 *     chat writes one out of habit, to pass on an exit code, as a step run in a process of its own would; typed into
 *     the operator's open terminal, it closes that terminal, and what it printed with it, which is what the operator
 *     was asked to send back.
 */
import { scanCommandHeads, type CommandCall } from './commandHeads.js';

/** The programs and cmdlets that stop processes: by name, by id, or by a filter given to them. */
const KILL_HEADS = new Set([
  'stop-process', 'spps', 'kill', 'taskkill', 'tskill', 'pkill', 'killall', 'kill-port', 'fkill', 'wmic',
  'remove-ciminstance', 'invoke-cimmethod', 'invoke-wmimethod', 'remove-wmiobject',
]);
/** The cmdlets that list processes, to hand to one that stops them. */
const LIST_HEADS = new Set(['get-process', 'gps', 'ps', 'get-ciminstance', 'gcim', 'get-wmiobject', 'gwmi']);
/** The cmdlets and programs that say which process listens on a port. */
const PORT_HEADS = new Set(['get-nettcpconnection', 'get-netudpendpoint', 'findstr', 'select-string', 'sls', 'grep', 'kill-port', 'fkill']);
/** A process stopped by a method of its own: `(Get-Process node).Kill()`, a CIM instance's `Terminate()`. */
const KILL_METHOD = /\.\s*(?:Kill|Terminate)\s*\(/i;
/** A filter by name on a list of processes: `Where-Object { $_.Name -eq 'node' }`, `-Filter "Name='node.exe'"`. */
const NAME_FILTER = /\b(?:Process)?Name\b['"]?\s*(?:-[ic]?(?:eq|like|match)\s*|=\s*\\?)['"]?\*?(node|msedge)(?:\.exe)?\b/i;

/** The bot's own processes, by the names a line stops them under. */
const BOT_PROCESSES: Array<{ name: string; what: string }> = [
  { name: 'node', what: 'the bot itself runs on node (its API and its web page)' },
  { name: 'msedge', what: "the bot's chat is in an Edge window" },
];
/** The operator's terminal, by the names a line stops it under. */
const SHELL_PROCESSES = ['pwsh', 'powershell', 'cmd', 'windowsterminal', 'conhost', 'wt'];

/** A head as compared: its file name, lower case, without the extension Windows adds. */
const headName = (head: string): string => (head.split(/[\\/]/).pop() ?? head).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');

/** The words in a call's literal arguments, quoted ones split too: `"IMAGENAME eq node.exe"` gives three. */
function words(call: CommandCall): string[] {
  return call.args.filter((a) => !a.dynamic).flatMap((a) => a.literal.split(/[\s,;=()'"]+/)).filter(Boolean);
}

/** The programs that stop a process only when told to: `wmic … delete`, `Invoke-CimMethod -MethodName Terminate`. */
const KILL_WHEN_TOLD = new Set(['wmic', 'invoke-cimmethod', 'invoke-wmimethod']);

/** Whether the call stops processes: a cmdlet or program for it, or `npx kill-port`. */
function isKill(call: CommandCall): boolean {
  const head = headName(call.head);
  if (head === 'npx') return words(call).some((w) => /^(?:kill-port|fkill(?:-cli)?)$/i.test(w));
  if (!KILL_HEADS.has(head)) return false;
  return !KILL_WHEN_TOLD.has(head) || words(call).some((w) => /^(?:delete|terminate)$/i.test(w));
}

/** Whether a word, as a process name with PowerShell's and taskkill's wildcards, takes in `name`. */
function namesProcess(word: string, name: string): boolean {
  if (/^[-/]/.test(word)) return false;
  const bare = word.replace(/\.exe$/i, '');
  if (!/[*?[]/.test(bare)) return bare.toLowerCase() === name;
  const pattern = bare.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    return new RegExp(`^${pattern}$`, 'i').test(name);
  } catch {
    return false;
  }
}

/** The process among `names` that the line stops by name, or null. */
function stoppedByName(text: string, calls: CommandCall[], names: string[]): string | null {
  const kills = calls.filter(isKill);
  if (kills.length === 0 && !KILL_METHOD.test(text)) return null;
  const named = (call: CommandCall): string | null => {
    for (const w of words(call)) {
      const hit = names.find((n) => namesProcess(w, n));
      if (hit) return hit;
    }
    return null;
  };
  for (const c of kills) {
    const hit = named(c);
    if (hit) return hit;
  }
  for (const c of calls.filter((x) => LIST_HEADS.has(headName(x.head)))) {
    const hit = named(c);
    if (hit) return hit;
  }
  const filter = NAME_FILTER.exec(text);
  if (filter && names.includes(filter[1]!.toLowerCase())) return filter[1]!.toLowerCase();
  return null;
}

/** The bot's port that the line stops a process on, or null: `Get-NetTCPConnection -LocalPort 4000 | … Stop-Process`. */
function stoppedByPort(text: string, calls: CommandCall[], ports: number[]): number | null {
  if (!calls.some(isKill) && !KILL_METHOD.test(text)) return null;
  for (const c of calls) {
    const head = headName(c.head);
    if (!PORT_HEADS.has(head) && head !== 'npx') continue;
    for (const w of words(c)) {
      const n = Number(w.replace(/^:/, ''));
      if (Number.isInteger(n) && ports.includes(n)) return n;
    }
  }
  return null;
}

/**
 * Why a line or a script must not run because it stops the bot, or null. `ports` are the bot's own (`botPorts`).
 */
export function stopsTheBot(text: string, ports: number[]): string | null {
  const { calls } = scanCommandHeads(text);
  const name = stoppedByName(text, calls, BOT_PROCESSES.map((p) => p.name));
  const port = name ? null : stoppedByPort(text, calls, ports);
  if (!name && port === null) return null;
  const what = name ? `every process named ${name}, and ${BOT_PROCESSES.find((p) => p.name === name)!.what}` : `the process on port ${port}, which is the bot's own`;
  return (
    `refused: this stops ${what}, so it stops the bot too, and the task with it. Stop only the process the work started: ` +
    'by the id Start-Process -PassThru gave for it, or by the port it listens on (Get-NetTCPConnection -LocalPort <its port>), ' +
    'never by the name node or msedge.'
  );
}

/**
 * Why a line typed into the operator's own terminal would end that terminal, or null: `exit` anywhere outside a
 * string, `[Environment]::Exit`, `$host.SetShouldExit`, its own process stopped by `$PID`, or the shell stopped by name.
 */
export function endsTheShell(line: string): string | null {
  const scan = scanCommandHeads(line);
  if (scan.exits) return '"exit" closes the PowerShell it is typed in';
  if (/\[\s*(?:System\.)?Environment\s*\]\s*::\s*Exit\s*\(/i.test(line)) return '[Environment]::Exit closes the PowerShell it is typed in';
  if (/\$host\s*\.\s*SetShouldExit\s*\(/i.test(line)) return '$host.SetShouldExit closes the PowerShell it is typed in';
  if (/\bGetCurrentProcess\s*\(\s*\)\s*\.\s*Kill\s*\(/i.test(line)) return 'stopping its own process closes the PowerShell it is typed in';
  const own = scan.calls.some((c) => isKill(c) && c.args.some((a) => /^\$pid$/i.test(a.literal.trim())));
  if (own || /\b(?:Stop-Process|spps|kill)\b[^;|\n]*\$PID\b/i.test(line)) return 'stopping $PID closes the PowerShell it is typed in';
  const shell = stoppedByName(line, scan.calls, SHELL_PROCESSES);
  if (shell) return `stopping every ${shell} process closes the terminal it is typed in`;
  return null;
}
