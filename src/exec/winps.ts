/**
 * The environment the bot's own Windows PowerShell calls are started with.
 *
 * Found on 2026-09-27: when the bot is started from a PowerShell 7 terminal, its environment carries
 * PowerShell 7's `PSModulePath`, and a Windows PowerShell 5.1 started from it looks for its own
 * built-in modules in PowerShell 7's folders first — `Get-Acl` then fails with "the module could not
 * be loaded", and so can any cmdlet that lives in a module. Without the variable, Windows PowerShell
 * builds its default path, which is the one it was written for. Every call the bot makes to
 * `powershell` goes through this, so the answer does not depend on which terminal started it.
 */
export function winPsEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'psmodulepath') out[k] = v;
  return out;
}
