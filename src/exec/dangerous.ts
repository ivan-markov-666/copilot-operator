/**
 * The techniques this runner refuses outright, whatever the configuration says.
 *
 * `execution.denyPatterns` is the operator's list: editable, sensible, and about damage — a
 * wiped folder, a formatted drive, a reset repository. This is a different list and it exists
 * for a different reader. A security team watching the workstation does not see intent; it sees
 * `certutil.exe` decoding a base64 blob into a `.js` file in `%TEMP%` and something executing
 * it, and it is right to treat that as a compromise, because that is precisely what a malware
 * loader looks like. That the parent process happened to be an automation tool driven by a
 * language model is not exculpatory. It is the whole problem.
 *
 * So these patterns are not defaults. They are not in the config schema, they cannot be edited
 * away, and a `settings.json` written before they existed still gets them. The operator's list
 * is applied on top; it can add, never subtract. A tool that executes commands written by a
 * model has no business leaving its guard rails where the model's own output could one day
 * suggest widening them.
 *
 * What is here, and why each one:
 *
 *   living-off-the-land binaries   `certutil`, `bitsadmin`, `mshta`, `regsvr32`, `rundll32`,
 *                                  `wscript`, `cscript`, `forfiles`, `installutil`. All are
 *                                  signed Microsoft tools with a legitimate purpose and an
 *                                  overwhelmingly illegitimate reputation; every one of them
 *                                  is on every EDR's watch list. None is needed to build, test
 *                                  or inspect a software project, which is all this runner is
 *                                  for, so refusing them costs nothing real.
 *   decode and run                 `-EncodedCommand`, `FromBase64String`, `Invoke-Expression`.
 *                                  The point of encoding a command is that a person reading the
 *                                  log cannot see what it does, and the point of this runner's
 *                                  log is that they can.
 *   fetch and run                  `DownloadString`/`DownloadFile` into execution, `iwr | iex`.
 *                                  Code that arrives at run time was never approved by anybody.
 *   execution out of Temp          Nothing this runner legitimately does lives there: downloaded
 *                                  scripts go to the run's own `artifacts/` folder, under the
 *                                  project, where they are hashed and kept.
 *   tampering and persistence      Defender exclusions, scheduled tasks, Run keys, new services.
 *                                  A build step does not need to outlive the build.
 *
 * Deliberately **not** here: `node`, `npm`, `npx`, `git`, `tsc`, `dotnet`, `python`. They are
 * the job. A guard that stops the work is a guard that gets switched off.
 *
 * And the honest limit, the same one `policy.ts` states about the deny list: this is not a
 * security boundary. It raises the cost of the ordinary accident and the ordinary injected
 * instruction. A determined attacker with a language model to write for them will find a
 * phrasing no regular expression here anticipated. The boundary is a separate Windows account
 * or a sandbox, which the README recommends and which this does not replace.
 */

/** One refused technique: what it is called, how it is recognised, and why it is refused. */
export type DangerousTechnique = {
  /** Short name, used in the refusal and in the log, so the reason is searchable. */
  name: string;
  pattern: RegExp;
  /** One sentence the operator and a reviewer can both act on. */
  why: string;
};

export const DANGEROUS_TECHNIQUES: DangerousTechnique[] = [
  {
    name: 'certutil',
    pattern: /\bcertutil(\.exe)?\b/i,
    why: 'certutil is a certificate tool routinely used to decode base64 payloads and fetch files; every EDR treats it as an indicator of compromise. Use PowerShell to read or convert files.',
  },
  {
    name: 'bitsadmin',
    pattern: /\bbitsadmin(\.exe)?\b/i,
    why: 'bitsadmin transfers files in the background out of sight of the run log. Use Invoke-WebRequest to a file, in a step of its own.',
  },
  {
    name: 'script-host',
    pattern: /\b(wscript|cscript|mshta)(\.exe)?\b/i,
    why: 'the Windows Script Host and mshta run .js, .vbs, .hta and remote pages as code. Nothing about building or testing a project needs them.',
  },
  {
    name: 'proxy-execution',
    pattern: /\b(regsvr32|rundll32|installutil|msbuild\s+[^|]*\/p:|wmic[^|]*process[^|]*call[^|]*create)\b/i,
    why: 'these run code through a signed Microsoft binary so that it is not the process an observer expects. Run the tool itself instead.',
  },
  {
    name: 'forfiles',
    pattern: /\bforfiles(\.exe)?\b/i,
    why: 'forfiles executes a command per matched file and is a common way to launch something under an innocuous parent. Use Get-ChildItem with a loop.',
  },
  {
    name: 'encoded-command',
    // PowerShell takes any unambiguous prefix, so `-e`, `-en` and `-enc` are the same switch as
    // `-EncodedCommand`; anchoring on the whole word let `powershell -e <blob>` straight past. The
    // short form is tied to a PowerShell invocation and a base64-shaped argument, so that `grep -e`
    // and `node -e` are left alone.
    pattern: /(-|\/)(EncodedCommand|enc)\b|\b(powershell|pwsh)(\.exe)?\b[^|\n]*\s(-|\/)e[a-z]*\s+["']?[A-Za-z0-9+\/=]{16,}/i,
    why: 'an encoded command is a command nobody reading the log can see. Write it out in full.',
  },
  {
    name: 'decode-and-run',
    pattern: /FromBase64String|\bcertutil[^|\n]*-decode\b|\[System\.Text\.Encoding\][^|\n]*GetString\s*\(/i,
    why: 'decoding a blob into code and running it hides what ran. If the content matters, write it to a file in the project and run that.',
  },
  {
    name: 'invoke-expression',
    pattern: /\b(Invoke-Expression|iex)\b/i,
    why: 'Invoke-Expression runs a string as code, so what actually ran is decided at run time and never appears in the step. Call the command directly.',
  },
  {
    name: 'fetch-and-run',
    pattern: /(DownloadString|DownloadFile)\s*\(|\b(Invoke-WebRequest|iwr|curl|wget)\b[^|\n]*\|\s*(iex|Invoke-Expression|bash|sh|pwsh|powershell)\b/i,
    why: 'code fetched at run time was approved by nobody. Download to a file in a step of its own, so it is hashed and kept, and run it in the next one.',
  },
  {
    name: 'run-from-temp',
    // Any path with a Temp component, however it is spelled — `%TEMP%`, `$env:TEMP`,
    // `$env:LOCALAPPDATA\\Temp`, `C:\\Windows\\Temp`, `/tmp/`. Matching the one literal spelling
    // `\\AppData\\Local\\Temp` was matching one of several.
    pattern: /(%TEMP%|\$env:TEMP|[\\\/]Temp[\\\/]|\/tmp\/)[^\s"';|]*\.(exe|js|jse|vbs|vbe|ps1|bat|cmd|hta|wsf|scr|dll|msi)\b/i,
    why: 'this runner never executes anything out of Temp: what it downloads goes to the run\'s own artifacts folder, hashed and kept. A binary or script run from Temp is the shape of a dropper.',
  },
  {
    name: 'defender-tampering',
    pattern: /\b(Add-MpPreference|Set-MpPreference|Remove-MpPreference)\b|\bDefender\b[^|\n]*\b(Disable|Exclusion)\b/i,
    why: 'nothing this runner does requires changing the machine\'s antivirus settings, and doing so is what an attacker does first.',
  },
  {
    name: 'persistence',
    pattern: /\b(schtasks\s+[^|\n]*\/create|New-ScheduledTask|Register-ScheduledTask|New-Service|sc\s+create)\b|\\CurrentVersion\\Run\b/i,
    why: 'a build or test step has no reason to outlive the run. Anything that survives a reboot is persistence and is for a person to set up deliberately.',
  },
  {
    name: 'obfuscated-name',
    /*
     * Not a technique but the shape of hiding one, and worth more than chasing names.
     *
     * Attacking the list above found four ways past it that never touched a banned word:
     * `cert^util` (cmd eats the caret), `cert""util` (the shell eats the empty quotes),
     * `$a='cert'+'util'; & $a`, and `& (Get-Command cert*til)`. Every one runs
     * `certutil` and none of them spells it. Chasing spellings is a race the writer wins, so
     * this matches the hiding instead: a caret or an empty quote pair inside a word, a command
     * name assembled from pieces, a name resolved by wildcard. None of the four has an honest
     * use in a step that builds or tests a project — an honest step writes the name out.
     */
    pattern: /\w\^\w|\w(\"\"|'')\w|&\s*\(?\s*\$\w|\bGet-Command\s+[^\s|]*\*|\$\w+\s*=\s*['"][^'"]*['"]\s*\+/i,
    why: 'the command name is hidden rather than written — a caret or empty quotes inside a word, a name built from pieces, or one resolved by wildcard. Write the command out in full; if it is one of the refused tools, it stays refused however it is spelled.',
  },
];

/**
 * Why this text must not be run, or null.
 *
 * The same function answers for a command line and for the body of a downloaded script, because
 * the distinction never mattered to the machine: `pwsh -File payload.ps1` and the `certutil`
 * line inside `payload.ps1` produce the same process tree, and only one of them was ever being
 * looked at.
 */
export function dangerousRefusal(text: string): string | null {
  for (const technique of DANGEROUS_TECHNIQUES) {
    if (technique.pattern.test(text)) {
      return `refused: ${technique.name}. ${technique.why}`;
    }
  }
  return null;
}

/**
 * The same, for a file that was downloaded and is about to be executed.
 *
 * Reported with the line it was found on, because a refused script is a script somebody now has
 * to read, and "somewhere in these two hundred lines" is not a place to start.
 */
export function dangerousInScript(fileName: string, body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const refusal = dangerousRefusal(line);
    if (refusal) {
      return `${fileName} line ${i + 1} ${refusal}\n    ${line.trim().slice(0, 200)}`;
    }
  }
  return null;
}
