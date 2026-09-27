/**
 * Who, besides the operator, can read or change the data folder.
 *
 * `data/` holds the API token, the settings (the deny list, the allowlist, the isolation claim),
 * every session and the level-1 contract that is sent to Copilot. Checked on 2026-09-27: under
 * `C:\Projects` it inherits `Authenticated Users: Modify` — every account on the machine could read
 * the token and rewrite what the bot will run. A token that any local account can read guards
 * nothing, which `security.ts` had already said in as many words.
 *
 * So at start the folder is narrowed to the account the API runs as, plus SYSTEM (which backup and
 * the machine's own protection need), with inheritance from the parent cut; and then it is read
 * back, by SID so that a translated Windows gives the same answer, and the API refuses to start if
 * anybody else is still on it. Administrators are deliberately not added: they can take ownership
 * of anything, and granting them access by default is granting it to every elevated process.
 *
 * Windows only. Elsewhere the folder's mode is the owner's business and this does nothing.
 */
import { spawnSync } from 'node:child_process';
import { winPsEnv } from '../exec/winps.js';

const SYSTEM_SID = 'S-1-5-18';

export type DataAclOutcome = { ok: true } | { ok: false; reason: string };

/** Narrows `dir` to this account and SYSTEM, then checks nobody else is on it. */
export function secureDataDir(dir: string, env: NodeJS.ProcessEnv = process.env): DataAclOutcome {
  if (process.platform !== 'win32') return { ok: true };
  const who = `${env.USERDOMAIN ?? ''}\\${env.USERNAME ?? ''}`;
  spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/grant:r', `*${SYSTEM_SID}:(OI)(CI)F`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const read = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
        // .NET directly rather than Get-Acl: no module to load, and the rules come back as SIDs.
        `$rules = (New-Object System.IO.DirectoryInfo '${dir.replace(/'/g, "''")}').GetAccessControl().` +
        `GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]); ` +
        `$sids = $rules | ForEach-Object { $_.IdentityReference.Value }; ` +
        `@{ me = $me; sids = @($sids) } | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: winPsEnv(env) },
  );
  if (read.status !== 0) return { ok: false, reason: `could not read the permissions of ${dir}` };
  try {
    const { me, sids } = JSON.parse(read.stdout) as { me: string; sids: string[] };
    // A rule that could not be read is not evidence of nobody; fail closed.
    if (!me || sids.length === 0 || sids.some((x) => !x)) return { ok: false, reason: `could not read the permissions of ${dir}` };
    const others = [...new Set(sids)].filter((s) => s !== me && s !== SYSTEM_SID);
    if (others.length > 0) {
      return {
        ok: false,
        reason:
          `${dir} can also be opened by ${others.join(', ')}. It holds the API token and the settings, so it must be ` +
          `readable by this account (and SYSTEM) only. Remove the others with icacls, or move the data folder ` +
          `(COP_DATA_DIR) somewhere private such as %LOCALAPPDATA%.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `could not read the permissions of ${dir}` };
  }
}
