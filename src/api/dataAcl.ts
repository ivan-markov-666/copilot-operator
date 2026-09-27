/**
 * Who, besides the operator, can read or change a folder the bot keeps its records in.
 *
 * `data/` holds the API token, the settings (the deny list, the allowlist, the isolation claim),
 * every session and the level-1 contract that is sent to Copilot; `runs/` holds every step's raw
 * output. Checked on 2026-09-27: under `C:\Projects` a folder inherits `Authenticated Users:
 * Modify` — every account on the machine could read the token and rewrite what the bot will run.
 * A token that any local account can read guards nothing, which `security.ts` had already said in
 * as many words.
 *
 * So at start each folder is narrowed to the account the API runs as, plus SYSTEM (which backup
 * and the machine's own protection need), with inheritance from the parent cut; and then it is
 * read back, by SID so that a translated Windows gives the same answer, and the API refuses to
 * start if anybody else is still on it. Administrators are deliberately not added: they can take
 * ownership of anything, and granting them access by default is granting it to every elevated
 * process.
 *
 * Written to work under PowerShell's Constrained Language Mode, which corporate machines commonly
 * enforce (verified 2026-09-27): the ACL is read as SDDL through `Get-Acl`, a cmdlet, and the
 * account's SID through `Get-CimInstance`, another — neither the .NET `DirectoryInfo` call the
 * first version used nor `WindowsIdentity` is allowed there. `icacls` is a system executable.
 *
 * Windows only. Elsewhere the folder's mode is the owner's business and this does nothing.
 */
import { spawnSync } from 'node:child_process';
import { winPsEnv } from '../exec/winps.js';

const SYSTEM_SID = 'S-1-5-18';

/** SDDL's two-letter names for well-known principals, as `Get-Acl` prints them. */
const SDDL_ALIASES: Record<string, string> = {
  SY: 'S-1-5-18', // SYSTEM
  BA: 'S-1-5-32-544', // Administrators
  BU: 'S-1-5-32-545', // Users
  AU: 'S-1-5-11', // Authenticated Users
  WD: 'S-1-1-0', // Everyone
  CO: 'S-1-3-0', // Creator Owner
  CG: 'S-1-3-1', // Creator Group
  OW: 'S-1-3-4', // Owner Rights
  IU: 'S-1-5-4', // Interactive
  RC: 'S-1-5-12', // Restricted Code
  AN: 'S-1-5-7', // Anonymous
  LS: 'S-1-5-19', // Local Service
  NS: 'S-1-5-20', // Network Service
  SO: 'S-1-5-32-549', // Server Operators
  PU: 'S-1-5-32-547', // Power Users
  RD: 'S-1-5-32-555', // Remote Desktop Users
};

export type DataAclOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The SIDs an SDDL string's DACL grants anything to, aliases expanded. Only access-allowed
 * entries count: a deny entry for somebody is not access. Exported for the check.
 */
export function principalsInSddl(sddl: string): string[] {
  const dacl = /D:([^:]*)/.exec(sddl)?.[1] ?? '';
  const out = new Set<string>();
  for (const ace of dacl.matchAll(/\(([^)]*)\)/g)) {
    const parts = ace[1]!.split(';');
    const type = (parts[0] ?? '').trim().toUpperCase();
    const sid = (parts[5] ?? '').trim();
    if (!sid || (type !== 'A' && type !== 'OA')) continue;
    out.add(SDDL_ALIASES[sid.toUpperCase()] ?? sid);
  }
  return [...out];
}

/** Narrows `dir` to this account and SYSTEM, then checks nobody else is on it. */
export function secureDataDir(dir: string, env: NodeJS.ProcessEnv = process.env): DataAclOutcome {
  if (process.platform !== 'win32') return { ok: true };
  const who = `${env.USERDOMAIN ?? ''}\\${env.USERNAME ?? ''}`;
  spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/grant:r', `*${SYSTEM_SID}:(OI)(CI)F`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const quoted = dir.replace(/'/g, "''");
  const user = (env.USERNAME ?? '').replace(/'/g, "''");
  const domain = (env.USERDOMAIN ?? '').replace(/'/g, "''");
  const read = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // The account's SID from WMI first (allowed in Constrained Language Mode), .NET second.
      `$sid = (Get-CimInstance Win32_UserAccount -Filter "Name='${user}' AND Domain='${domain}'" -ErrorAction SilentlyContinue | Select-Object -First 1).SID; ` +
        `if (-not $sid) { try { $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $sid = '' } }; ` +
        `$sddl = (Get-Acl -LiteralPath '${quoted}').Sddl; ` +
        `@{ me = [string]$sid; sddl = [string]$sddl } | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: winPsEnv(env) },
  );
  const unreadable = { ok: false as const, reason: `could not read the permissions of ${dir}` };
  if (read.status !== 0) return unreadable;
  try {
    const { me, sddl } = JSON.parse(read.stdout) as { me: string; sddl: string };
    const principals = principalsInSddl(sddl);
    // A rule that could not be read is not evidence of nobody; fail closed.
    if (!me || principals.length === 0) return unreadable;
    const others = principals.filter((s) => s !== me && s !== SYSTEM_SID);
    if (others.length > 0) {
      return {
        ok: false,
        reason:
          `${dir} can also be opened by ${others.join(', ')}. It holds the bot's records, so it must be readable by this ` +
          `account (and SYSTEM) only. Remove the others with icacls, or move the folder (COP_DATA_DIR, runsDir) somewhere ` +
          `private such as %LOCALAPPDATA%.`,
      };
    }
    return { ok: true };
  } catch {
    return unreadable;
  }
}
