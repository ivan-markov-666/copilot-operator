/**
 * The native "pick a folder" dialog, for the Browse button in the web UI.
 *
 * A browser cannot hand a page a real directory path: the file input gives file names and the
 * File System Access API gives a handle, never `C:\Projects\my-app`. But the API is a local
 * process on the same machine as the browser, so it can open Windows' own folder dialog and
 * report back what was picked. That is the only way the UI can offer a picker and still end up
 * with the absolute path the mirror needs.
 *
 * The dialog is Windows-only by nature. Anywhere else this reports that plainly and the user
 * types the path, which has always worked.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export type FolderPick =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; reason: string };

/** Nothing is interpolated into the script; the start folder goes in as an environment variable. */
const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the project folder'
$dialog.ShowNewFolderButton = $false
if ($env:COP_PICKER_START -and (Test-Path -LiteralPath $env:COP_PICKER_START)) {
  $dialog.SelectedPath = $env:COP_PICKER_START
}
# An owner window that is always on top, so the dialog lands in front of the browser
# instead of behind it.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write('PICKED:' + $dialog.SelectedPath)
} else {
  [Console]::Out.Write('CANCELLED')
}
`;

/** Windows PowerShell first: it is always present and its dialog is the familiar one. */
function shellCandidates(): Array<{ exe: string; args: string[] }> {
  return [
    { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', SCRIPT] },
    { exe: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT] },
  ];
}

/** Only one dialog at a time: a second one would sit behind the first with no way to reach it. */
let open = false;

export async function pickFolder(startDir?: string, timeoutMs = 5 * 60_000): Promise<FolderPick> {
  if (process.platform !== 'win32') {
    return { ok: false, cancelled: false, reason: 'The folder dialog is Windows-only. Type the path instead.' };
  }
  if (open) {
    return { ok: false, cancelled: false, reason: 'A folder dialog is already open. Finish it first.' };
  }

  open = true;
  try {
    for (const { exe, args } of shellCandidates()) {
      const result = await run(exe, args, startDir, timeoutMs);
      if (result.kind === 'unavailable') continue;
      return result.pick;
    }
    return { ok: false, cancelled: false, reason: 'PowerShell was not found, so the dialog could not be opened.' };
  } finally {
    open = false;
  }
}

function run(
  exe: string,
  args: string[],
  startDir: string | undefined,
  timeoutMs: number,
): Promise<{ kind: 'done'; pick: FolderPick } | { kind: 'unavailable' }> {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, COP_PICKER_START: startDir && existsSync(startDir) ? startDir : '' },
    });

    let out = '';
    let err = '';
    let settled = false;
    const settle = (value: { kind: 'done'; pick: FolderPick } | { kind: 'unavailable' }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle({ kind: 'done', pick: { ok: false, cancelled: false, reason: 'The folder dialog timed out.' } });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      settle({ kind: 'unavailable' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const text = out.trim();
      if (text.startsWith('PICKED:')) {
        settle({ kind: 'done', pick: { ok: true, path: text.slice('PICKED:'.length).trim() } });
      } else if (text === 'CANCELLED') {
        settle({ kind: 'done', pick: { ok: false, cancelled: true } });
      } else {
        settle({ kind: 'done', pick: { ok: false, cancelled: false, reason: err.trim() || 'The folder dialog returned nothing.' } });
      }
    });
  });
}
