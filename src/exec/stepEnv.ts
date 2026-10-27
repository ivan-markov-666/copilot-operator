/**
 * The environment a command step is started with — named, not inherited.
 *
 * Steps used to be given the bot's whole environment. Found on 2026-09-27: that included the API
 * token (put there by `npm start` for the web build), so a model-written step could read it and
 * call the API that approves its own held steps, switches a run to unattended and edits the deny
 * list. It also carried whatever else the operator's shell happened to hold — cloud keys, CI tokens
 * — to be printed into a results file that goes to the chat.
 *
 * So a step gets the variables Windows and the toolchains need to work, by name, and nothing else:
 * the system folders and the user's profile folders (npm, dotnet and pip keep their caches there),
 * `PATH`, the processor facts some builds read, the toolchain homes, and the proxy and certificate
 * settings a company network needs for `npm install` to reach its registry. `PSModulePath` is left
 * out on purpose — see `winps.ts` for what it breaks in Windows PowerShell. Anything a project truly
 * needs beyond this is named by the operator in `execution.passEnv`.
 *
 * And three are set, not passed:
 *
 *   npm_config_ignore_scripts=true   `npm install` no longer runs the install scripts of what it
 *   YARN_ENABLE_SCRIPTS=0            downloads. A package's `postinstall` is code fetched from a
 *                                    registry and executed with nobody reading it — exactly the
 *                                    download-then-run the operator ruled out (2026-09-27). The
 *                                    honest cost: packages that build something when installed
 *                                    (esbuild, sharp, Playwright's browsers) may not work until the
 *                                    operator installs them by hand.
 *   NEXT_TELEMETRY_DISABLED=1        a Next.js project's build would otherwise report to a third
 *                                    party from this machine.
 */

/** Passed through when present, compared without regard to case as Windows does. */
const PASSED = [
  // Windows itself
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC',
  // the user's folders, where toolchains keep caches and settings
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  // toolchain homes
  'JAVA_HOME', 'DOTNET_ROOT', 'GOROOT', 'GOPATH', 'CARGO_HOME', 'RUSTUP_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'PNPM_HOME',
  // a company network: the proxy and the company's own certificate authority
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'PIP_INDEX_URL',
  // language and time, so output reads the same as at the operator's own prompt
  'LANG', 'LC_ALL', 'TZ',
];

/**
 * Names that pass whatever they are called: a toolchain's telemetry switch is always the operator's to set — a switch,
 * and only with a switch's value (audit, 2026-10-27: `TELEMETRY_CONNECTION_STRING` passed by its name).
 */
const PASSED_BY_SHAPE = /telemetry|_optout$|^do_not_track$|_nologo$/i;
const A_SWITCH = /^(?:0|1|true|false|yes|no|on|off)$/i;

const FORCED: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  npm_config_ignore_scripts: 'true',
  YARN_ENABLE_SCRIPTS: '0',
  // No toolchain reports home from a step: a company's opt-outs, set for every build tool that
  // honours them, so that the step's own traffic is the project's and nothing else.
  NEXT_TELEMETRY_DISABLED: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  POWERSHELL_TELEMETRY_OPTOUT: '1',
  DO_NOT_TRACK: '1',
  // Git masks the Authorization headers in its traces; a step that turned that off would print the stored token
  // (audit, 2026-10-27). Turning it off on the line is refused (`dangerous.ts`, credential-capture).
  GIT_TRACE_REDACT: '1',
};

/** Names a step must never be given, even if the operator lists them: the bot's own keys. */
const NEVER = /^(NEXT_PUBLIC_COP_|COP_)/i;

/**
 * `askpass`: Git for Windows' own password window (operator, 2026-10-26: "if the chat works with git and a password is
 * needed, the bot stops, a window opens for the operator to type it, and the work goes on; every time one is asked").
 * Set, not passed: ssh and git ask through it — and Git Credential Manager through its own window — so a `git push` or
 * `git fetch` a step runs asks the operator there, and the answer goes from the window straight to git, never through
 * the step's output. No terminal prompt: a step has none. See `remoteAuth.ts`; a step that names any of this itself
 * is refused (`dangerous.ts`, credential-capture).
 */
export function stepEnvironment(from: NodeJS.ProcessEnv = process.env, extra: string[] = [], askpass?: string): NodeJS.ProcessEnv {
  const wanted = new Set([...PASSED, ...extra].map((n) => n.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || NEVER.test(k)) continue;
    if (wanted.has(k.toLowerCase()) || (PASSED_BY_SHAPE.test(k) && A_SWITCH.test(v.trim()))) out[k] = v;
  }
  const asking = askpass
    ? { GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto', DISPLAY: from.DISPLAY || 'needs-to-be-defined' }
    : {};
  return { ...out, ...FORCED, ...asking };
}
