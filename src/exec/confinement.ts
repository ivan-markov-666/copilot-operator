/**
 * The project and nothing else.
 *
 * Every other gate in this runner is about *what* a command is: a technique on the refused list, a
 * program not on the allowlist. None of them knew *where* a command reached. A step could read the
 * operator's SSH key, write into their AppData, delete from `C:\Windows`, change a service or open
 * the firewall, and every one of those passed — cmdlets are not programs, so the allowlist never
 * saw them, and nothing anywhere knew what "the project" was. Probed before this was written:
 * of eighteen operations reaching outside the project, four were stopped, and those four only
 * because `netsh`, `setx` and `winget` happen not to be on the program list.
 *
 * The rule the operator set is short: this runner works in the project folders, and nowhere else.
 * The project folders are the session's own and every folder registered in Settings — a test
 * suite legitimately starts the application from the repository next to it, and a plan across a
 * front end, a back end and its tests is one piece of work. Everything outside them belongs to the
 * machine and the person who owns it, and none of it is the task's business.
 *
 * Four things are refused, all by reading the command line:
 *
 *   paths outside      an absolute path, a UNC share, `..` that climbs out, a location built from
 *                      the operator's profile or the system (`~`, `$env:APPDATA`, `%TEMP%`…).
 *                      Reads as well as writes: what a step prints goes to the chat, so reading
 *                      a key outside the project is sending it there.
 *   the registry       and the other providers that are not the file system. The project has no
 *                      business in any of them, reading or writing.
 *   the machine        services, the network and the firewall, local users, the clock, Windows
 *                      features, disks, machine-wide modules. Management of the computer.
 *   global installs    `npm -g`, `dotnet tool -g`, `cargo install`, `go install`, `pip install`
 *                      into the machine's own Python. The same tool installed into the project
 *                      (`npm install -D`, a `.venv`) is the ordinary way and stays open.
 *
 * What this is not, and it has to be said where somebody will read it: a boundary. It reads what a
 * step *says*, which is exactly what the operator asked for — whatever the chat proposes that
 * reaches outside the project is not run. It cannot see what a program does once it is running:
 * `node build.js`, `npm run x` and a test suite can each read and write anywhere the account can,
 * and a path assembled from variables at run time is invisible here. Confinement that holds against
 * that is the operating system's to give — a separate Windows account whose file permissions reach
 * the project folders and nothing of the operator's — and the README says how.
 */
import { win32 } from 'node:path';

export type Confinement = {
  /** Absolute folders the work may reach: the session's own, and every project in Settings. */
  roots: string[];
  /** Where the command runs. Relative paths are resolved against it. */
  cwd: string;
};

function normalise(p: string): string {
  return win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Whether a path lies within one of the roots. By path segments, not by string prefix: a root of
 * `C:\Projects\calc` must not admit `C:\Projects\calculator-evil`, which starts with the same
 * characters and is somewhere else entirely.
 */
export function isWithin(path: string, roots: string[]): boolean {
  const target = normalise(path);
  return roots.some((r) => {
    if (!r.trim()) return false;
    const root = normalise(r);
    return target === root || target.startsWith(`${root}\\`);
  });
}

/** Roots as a set: resolved, de-duplicated, empty ones dropped. */
export function projectRoots(folders: Array<string | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const f of folders) {
    const t = (f ?? '').trim();
    if (!t) continue;
    const abs = win32.resolve(t);
    seen.set(normalise(abs), abs);
  }
  return [...seen.values()];
}

// --- what gets read out of a command line -------------------------------------------------

/** Quoted strings, with their content. The content of either kind is searched for paths. */
const QUOTED = /(["'])((?:(?!\1)[^\r\n])*)\1/g;

/** A drive-absolute path, `C:\x` or `C:/x`, not glued to a word, a slash or a dot. */
const DRIVE_BARE = /(?<![\w/\\.])([A-Za-z]:[\\/][^\s"'`;|&<>,(){}]*)/g;

/** Where a drive-absolute path starts, inside quoted text that may hold several. */
const DRIVE_START = /(?<![\w/\\.])[A-Za-z]:[\\/]/g;

/** A share: `\\host\share`, and the device forms `\\?\` and `\\.\`. */
const UNC = /(?:^|[^\\])(\\\\(?:[?.]\\|[A-Za-z0-9._$-]+\\[A-Za-z0-9._$ -]))/;

/** A path written as a file URI, which reads a local file through a web cmdlet. */
const FILE_URI = /\bfile:\/{2,3}([A-Za-z]:[\\/][^\s"'`;|&<>]*)/gi;

/**
 * Locations that belong to the operator or to the system, however they are spelled. Kept to the
 * location-bearing names: `$env:PATH`, `$env:NODE_ENV` and the rest are not places and stay open.
 */
const LOCATION_VARS =
  'USERPROFILE|HOMEDRIVE|HOMEPATH|HOMESHARE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|WINDIR|SystemRoot|SystemDrive|' +
  'ProgramFiles(?:\\(x86\\))?|ProgramW6432|ProgramData|ALLUSERSPROFILE|PUBLIC|OneDrive\\w*|CommonProgramFiles\\w*';
const ENV_LOCATION = new RegExp(`\\$\\{?env:(${LOCATION_VARS})\\}?|%(${LOCATION_VARS})%`, 'i');
const HOME_VAR = /\$HOME\b/i;
/** `~` as the start of a path, and not the `~` of `HEAD~1` or `@~1.2`. */
const TILDE = /(?:^|[\s"'=(,])~(?=[\\/]|$|[\s"'`;|&)])/;

/** Changing to the root of the current drive, which needs no drive letter to leave the project. */
const CD_TO_ROOT = /(?:^|[\s;|&({])(?:Set-Location|Push-Location|cd|chdir|sl|pushd)\s+["']?[\\/]["']?(?=$|[\s;|&)}])/i;

/** A path segment that climbs: `..` on its own, or between separators. */
const CLIMBS = /(?:^|[\\/])\.\.(?:$|[\\/])/;

/** Every whitespace- or separator-delimited token, quoted content split the same way. */
function tokens(command: string): string[] {
  const out: string[] = [];
  const rest = command.replace(QUOTED, (_whole, _q, inner: string) => {
    out.push(...inner.split(/\s+/));
    return ' ';
  });
  out.push(...rest.split(/[\s;|&<>(){},]+/));
  // An argument written `name=value` or `-Name:value` carries its path after the separator.
  return out
    .filter(Boolean)
    .flatMap((t) => {
      const m = /^-{1,2}[\w-]+[:=](.+)$/.exec(t) ?? /^[\w.-]+=(.+)$/.exec(t);
      return m ? [t, m[1]!] : [t];
    });
}

/** Every drive-absolute path in a command, quoted ones whole even when they hold spaces. */
function drivePaths(command: string): string[] {
  const found: string[] = [];
  const rest = command.replace(QUOTED, (whole, _q, inner: string) => {
    // A quoted string may carry several paths — `cmd /c "copy C:\a C:\b"` — so each one runs from
    // where it starts to where the next begins, rather than the first swallowing the rest.
    const starts = [...inner.matchAll(DRIVE_START)].map((m) => m.index ?? 0);
    starts.forEach((start, i) => found.push(inner.slice(start, starts[i + 1] ?? inner.length).trim()));
    return ' '.repeat(whole.length);
  });
  for (const m of rest.matchAll(DRIVE_BARE)) found.push(m[1]!);
  for (const m of command.matchAll(FILE_URI)) found.push(m[1]!);
  return found;
}

// --- the machine, as opposed to the project -----------------------------------------------

const PROVIDERS = /\b(?:HKLM|HKCU|HKCR|HKU|HKCC):|\bRegistry::|\bCert:\\|\bWSMan:\\/i;

/** Cmdlet families that manage the computer. Each entry is a reason a person would recognise. */
const MACHINE: Array<{ what: string; pattern: RegExp }> = [
  { what: 'services', pattern: /\b(?:Get|Set|New|Remove|Start|Stop|Restart|Suspend|Resume)-Service\b/i },
  { what: 'the network and the firewall', pattern: /\b\w+-Net(?:Firewall\w*|IPAddress|IPConfiguration|IPInterface|Adapter\w*|Route|NeighborCache|ConnectionProfile|Nat\w*|Qos\w*)\b|\b\w+-DnsClient\w*\b/i },
  { what: 'local users and groups', pattern: /\b\w+-Local(?:User|Group|GroupMember)\b/i },
  { what: 'the clock, the locale and the time zone', pattern: /\bSet-(?:Date|TimeZone|Culture|WinSystemLocale|WinUserLanguageList|WinHomeLocation)\b/i },
  { what: 'Windows features and packages', pattern: /\b\w+-(?:WindowsOptionalFeature|WindowsFeature|WindowsCapability|WindowsPackage|AppxPackage|AppxProvisionedPackage)\b/i },
  { what: 'machine-wide PowerShell modules', pattern: /\b(?:Install|Uninstall|Update)-(?:Module|Package|Script|PackageProvider|PSResource)\b|\b(?:Register|Set|Unregister)-PSRepository\b/i },
  { what: 'disks and volumes', pattern: /\b\w+-(?:Disk|PhysicalDisk|VirtualDisk|Partition|Volume|StoragePool)\b/i },
  { what: 'the execution policy', pattern: /\bSet-ExecutionPolicy\b/i },
  { what: 'printers', pattern: /\b\w+-Printer\w*\b/i },
  { what: 'the computer itself', pattern: /\b(?:Rename|Add|Remove|Checkpoint|Restore|Stop|Restart)-Computer\b|\b(?:Enable|Disable)-(?:PSRemoting|WSManCredSSP|ComputerRestore)\b/i },
  { what: 'BitLocker and the TPM', pattern: /\b\w+-(?:BitLocker\w*|Tpm\w*)\b/i },
  { what: 'network shares', pattern: /\b\w+-(?:SmbShare|SmbMapping|SmbServerConfiguration)\b/i },
];

/** Installs that land outside the project, and the ordinary way to do the same inside it. */
const GLOBAL_INSTALL: Array<{ what: string; pattern: RegExp; instead: string }> = [
  { what: 'a global npm or pnpm install', pattern: /\b(?:npm|pnpm)(?:\.cmd)?\b[^|;&\n]*\s(?:-g|--global|--location[= ]global)(?=\s|$)/i, instead: 'install it into the project (`npm install -D <pkg>`) and run it with `npx`' },
  { what: 'a global yarn install', pattern: /\byarn(?:\.cmd)?\s+global\s+add\b/i, instead: 'add it to the project (`yarn add -D <pkg>`)' },
  { what: 'a global bun install', pattern: /\bbun(?:\.exe)?\b[^|;&\n]*\s(?:-g|--global)(?=\s|$)/i, instead: 'add it to the project (`bun add -d <pkg>`)' },
  { what: 'a global .NET tool', pattern: /\bdotnet(?:\.exe)?\s+tool\s+(?:install|update)\b[^|;&\n]*\s(?:-g|--global)(?=\s|$)/i, instead: 'use a local tool manifest (`dotnet new tool-manifest`, then `dotnet tool install <tool>`)' },
  { what: '`cargo install`, which installs into the user profile', pattern: /\bcargo(?:\.exe)?\s+install\b/i, instead: 'add it as a dependency of the project' },
  { what: '`go install`, which installs outside the module', pattern: /\bgo(?:\.exe)?\s+install\b/i, instead: 'run it with `go run <pkg>@<version>` from the project' },
];

/**
 * `pip install` into whatever Python is first on the PATH — the machine's, not the project's.
 * Allowed when the interpreter or pip is itself a path inside the project (a `.venv`), which the
 * path check then confirms, or when the install is aimed at a folder with `--target`/`--prefix`.
 */
function pipRefusal(command: string): string | null {
  const m = /(?:^|[\s;|&(])(["']?)([^\s"';|&()]*?)(pip3?|python3?|py)(?:\.exe)?\1\b[^|;&\n]*?\binstall\b[^|;&\n]*/i.exec(command);
  if (!m) return null;
  const clause = m[0];
  if (!/\b(?:pip3?)\b[^|;&\n]*\binstall\b|-m\s+pip\s+install\b/i.test(clause)) return null;
  if (/\s--user\b/i.test(clause)) return 'refused: `pip install --user` installs into the operator\'s profile, outside the project. Create a virtual environment in the project (`python -m venv .venv`) and install into that (`.venv\\Scripts\\python -m pip install <pkg>`).';
  const qualified = /[\\/]/.test(m[2] ?? '');
  const aimed = /\s(?:--target|-t|--prefix|--root)(?:[\s=])/i.test(clause);
  if (qualified || aimed) return null;
  return 'refused: `pip install` with the Python on the PATH installs into the machine\'s own Python, outside the project. Create a virtual environment in the project (`python -m venv .venv`) and install into that: `.venv\\Scripts\\python -m pip install <pkg>`.';
}

// --- the verdict ---------------------------------------------------------------------------

function outside(what: string, c: Confinement): string {
  return (
    `refused: ${what} — this runner works only inside the project folders (${c.roots.join(', ')}), and ` +
    'nothing outside them is the task\'s business. Use a path inside the project. If the task genuinely ' +
    'needs something from elsewhere on the machine, say so in `notes` and end `blocked`: that is for the ' +
    'operator to arrange, not for a step to reach for.'
  );
}

/**
 * Why a command reaches outside the project, or null.
 *
 * Checked in order of how plainly the command says it, so the reason given is the most specific one:
 * the machine's own settings first, then an install that lands outside, then any path at all.
 */
export function confinementRefusal(command: string, c: Confinement): string | null {
  if (PROVIDERS.test(command)) {
    return outside('the registry and the other non-file providers belong to the machine, not the project', c);
  }
  for (const { what, pattern } of MACHINE) {
    if (pattern.test(command)) return outside(`this manages ${what}, which is the computer's, not the project's`, c);
  }
  for (const { what, pattern, instead } of GLOBAL_INSTALL) {
    if (pattern.test(command)) {
      return `refused: ${what} lands outside the project folders. ${instead[0]!.toUpperCase()}${instead.slice(1)}.`;
    }
  }
  const pip = pipRefusal(command);
  if (pip) return pip;

  const env = ENV_LOCATION.exec(command);
  if (env) return outside(`\`${env[0]}\` is a location on the machine — the operator's profile or the system — not in the project`, c);
  if (HOME_VAR.test(command) || TILDE.test(command)) {
    return outside('`~` and `$HOME` are the operator\'s profile, not the project', c);
  }
  if (UNC.test(command)) return outside('a network share is not the project', c);
  if (CD_TO_ROOT.test(command)) return outside('this changes to the root of the drive', c);

  for (const p of drivePaths(command)) {
    if (!isWithin(p, c.roots)) return outside(`\`${p}\` is outside the project`, c);
  }
  for (const t of tokens(command)) {
    if (!CLIMBS.test(t)) continue;
    const resolved = win32.resolve(c.cwd, t);
    if (!isWithin(resolved, c.roots)) return outside(`\`${t}\` climbs out of the project to ${resolved}`, c);
  }
  return null;
}
