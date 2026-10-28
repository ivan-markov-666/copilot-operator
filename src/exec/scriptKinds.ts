/**
 * The kinds of script the operator decides about in Settings (2026-10-27): "whether I allow ts files, ps1 files, npm …
 * to choose whether they run only for scripts that are already there, and another box for scripts the bot created".
 *
 * Two boxes for each kind:
 *
 *   own       the project's: there before the work began (see `notTheProjects` and `writtenDuringTheWork` in
 *             `scriptFiles.ts`, and `npmScripts.ts` for package.json's scripts). On by default — the project's tools
 *             and the application run as before.
 *   written   written by the bot during the work, `.cop-tmp` included. Off by default: such a script is handed to the
 *             operator to run (`status: "handoff"`), as since 2026-10-26. Ticked, the runner runs it itself; whether it
 *             asks first is `execution.writtenScripts` (see `PolicyConfig`).
 *
 * A box only lets a kind run. Every other rule — the refused techniques, the allowlist of programs, the project's
 * folders, the network hold — still applies, to the line and to the text of a PowerShell, cmd or bash script it runs.
 */
export const SCRIPT_KINDS = ['ts', 'js', 'py', 'ps1', 'cmd', 'sh', 'other', 'npm'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

export type ScriptRule = { own: boolean; written: boolean };
export type ScriptRules = Record<ScriptKind, ScriptRule>;

/** What an unattended run does with a script the bot wrote that its kind's box lets run: ask on a card first, or run it. */
export type WrittenScriptsChoice = 'ask' | 'run';

/** As before the boxes existed: the project's scripts run, the bot's are handed over. */
export const DEFAULT_SCRIPT_RULES: ScriptRules = Object.fromEntries(SCRIPT_KINDS.map((k) => [k, { own: true, written: false }])) as ScriptRules;

/** The file extensions of each kind, without the dot. npm's scripts are not files: they are package.json's "scripts". */
export const SCRIPT_EXTENSIONS: Record<Exclude<ScriptKind, 'npm'>, readonly string[]> = {
  ts: ['ts', 'mts', 'cts', 'tsx'],
  js: ['js', 'mjs', 'cjs', 'jsx'],
  py: ['py', 'pyw'],
  ps1: ['ps1', 'psm1'],
  cmd: ['cmd', 'bat'],
  sh: ['sh', 'bash', 'zsh'],
  other: ['rb', 'pl', 'php'],
};

/**
 * The kind of a script file, by its extension, or null when no box decides it. The Windows Script Host's scripts (`.vbs`,
 * `.wsf`, a `.js` given to `wscript` or `cscript`: `byScriptHost`) are none of them: the script host is a refused
 * technique (`dangerous.ts`) whatever the boxes say, so only the project's own are let past this rule, as before.
 */
export function kindOfFile(path: string, byScriptHost = false): Exclude<ScriptKind, 'npm'> | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!ext || byScriptHost) return null;
  for (const [kind, exts] of Object.entries(SCRIPT_EXTENSIONS) as Array<[Exclude<ScriptKind, 'npm'>, readonly string[]]>) {
    if (exts.includes(ext)) return kind;
  }
  return null;
}

/** The rules as Settings hold them, filled in where a kind is not there (a settings file older than the boxes). */
export function scriptRulesOf(value: Partial<Record<string, Partial<ScriptRule>>> | undefined): ScriptRules {
  const out = {} as ScriptRules;
  for (const kind of SCRIPT_KINDS) {
    const v = value?.[kind];
    out[kind] = { own: v?.own ?? DEFAULT_SCRIPT_RULES[kind].own, written: v?.written ?? DEFAULT_SCRIPT_RULES[kind].written };
  }
  return out;
}

/** The kinds whose scripts written by the bot may run, for the chat's opening and the run's record. */
export function writtenKindsAllowed(rules: ScriptRules): ScriptKind[] {
  return SCRIPT_KINDS.filter((k) => rules[k].written);
}

/** How a kind is named to the chat: its extensions, or package.json's scripts. */
export function kindForChat(kind: ScriptKind): string {
  return kind === 'npm' ? 'package.json "scripts" (npm run, npm test, pnpm, yarn)' : SCRIPT_EXTENSIONS[kind].map((e) => `.${e}`).join(' ');
}

/**
 * What the chat is told of the operator's boxes, in the opening, when they are not the defaults: which kinds of file of
 * code it writes as part of the work the runner runs itself, and which of the project's own it does not run. Nothing
 * when they are as shipped. Either way it never writes a script only to run something (operator, 2026-10-28).
 */
export function scriptsNote(rules: ScriptRules, written: WrittenScriptsChoice): string | undefined {
  const mine = SCRIPT_KINDS.filter((k) => rules[k].written);
  const notOwn = SCRIPT_KINDS.filter((k) => !rules[k].own);
  if (mine.length === 0 && notOwn.length === 0) return undefined;
  const lines = ['## Scripts on this machine', ''];
  if (mine.length > 0) {
    lines.push(
      `The operator lets the runner run files of these kinds that you write as part of the work — code of the project: ${mine.map(kindForChat).join('; ')}. ` +
        'Write such a file in one step and run it in the next, never both in one line, ' +
        (written === 'ask' ? 'and the operator is shown it, in full, before it runs. ' : 'and it runs as any other step. ') +
        'Its text passes the same rules as a step. Still, never write a script only to run something: that goes in the step itself.',
    );
  }
  if (notOwn.length > 0) {
    if (mine.length > 0) lines.push('');
    lines.push(
      `The operator does not let the runner run the project's own scripts of these kinds: ${notOwn.map(kindForChat).join('; ')}. ` +
        'Do what they do in the step itself.',
    );
  }
  return lines.join('\n');
}
