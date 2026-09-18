import { writeReport, clip, stripAnsi } from '../src/exec/reportFile.js';
import { staticCheck, describeStep } from '../src/exec/policy.js';
import type { RunResult } from '../src/exec/runner.js';
import type { Step } from '../src/protocol/replySchema.js';
import { RunConfigSchema } from '../src/config/schema.js';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mk = (
  id: number,
  outcome: RunResult['outcome'],
  exitCode: number,
  stdout = '',
  stderr = '',
): RunResult => ({
  id,
  shell: 'pwsh',
  command: `cmd-${id}`,
  exitCode,
  outcome,
  durationMs: 1200,
  stdout,
  stderr,
  truncated: false,
  logPath: `C:/logs/${id}.log`,
  lastOutputAgoMs: 0,
});

const dir = join(tmpdir(), 'cop-report-check');

console.log('--- ANSI stripping ---');
const ESC = String.fromCharCode(27);
const coloured = ESC + '[32;1mWindowsEdition : ' + ESC + '[0mWindows 10 Pro';
console.log('coloured    :', JSON.stringify(coloured));
console.log('stripped    :', JSON.stringify(stripAnsi(coloured)));
const psText = '[pscustomobject]@{A=1}; [double]$x; [math]::Round($x,2)';
console.log('powershell  :', stripAnsi(psText) === psText ? 'untouched (correct)' : 'DAMAGED: ' + stripAnsi(psText));

await rm(dir, { recursive: true, force: true });

const one = await writeReport(
  [mk(1, 'completed', 0, 'hello\n'), mk(2, 'idle-timeout', -1, 'partial\n', 'stuck\n')],
  {
    runId: 'r1',
    iteration: 3,
    dir,
    fileNameTemplate: 'iteration-{n}.txt',
    maxReportBytes: 8 * 1024 * 1024,
    maxOutputChars: 1000,
    redactPatterns: [],
  },
);
console.log('single file :', one.names.join(', '), `${one.bytes} bytes, ${one.parts} part(s)`);
console.log('--- content ---');
console.log((await readFile(one.paths[0], 'utf8')).trimEnd());

const big = 'x'.repeat(5000);
const split = await writeReport(
  [mk(1, 'completed', 0, big), mk(2, 'completed', 0, big), mk(3, 'completed', 0, big)],
  {
    runId: 'r1',
    iteration: 4,
    dir,
    fileNameTemplate: 'iteration-{n}.txt',
    maxReportBytes: 7000,
    maxOutputChars: 100000,
    redactPatterns: [],
  },
);
console.log('\nsplit       :', split.names.join(', '), `${split.parts} parts`);

const red = await writeReport([mk(1, 'completed', 0, 'token=abc123 and user=ivan\n')], {
  runId: 'r1',
  iteration: 5,
  dir,
  fileNameTemplate: 'iteration-{n}.txt',
  maxReportBytes: 8e6,
  maxOutputChars: 1000,
  redactPatterns: ['token=\\w+'],
});
const redLine = (await readFile(red.paths[0], 'utf8'))
  .split('\n')
  .find((l) => l.includes('user=ivan'));
console.log('redacted    :', JSON.stringify(redLine));
console.log('clip        :', clip('a'.repeat(500), 200).includes('omitted'));

console.log('\n--- policy, using the shipped default deny list ---');
const defaults = RunConfigSchema.parse({ openingMessages: [{ text: 'x' }] });
const cfg = {
  mode: 'unattended' as const,
  denyPatterns: defaults.execution.denyPatterns,
  allowedScriptExtensions: defaults.execution.allowedScriptExtensions,
};
const steps: Step[] = [
  { id: 1, type: 'command', shell: 'pwsh', cmd: 'Get-Date' },
  { id: 2, type: 'command', shell: 'pwsh', cmd: 'Remove-Item C:\\data -Recurse -Force' },
  { id: 3, type: 'command', shell: 'cmd', cmd: 'shutdown /r /t 0' },
  { id: 4, type: 'command', shell: 'cmd', cmd: 'format C: /q' },
  { id: 5, type: 'command', shell: 'pwsh', cmd: 'reg delete HKLM\\Software\\Foo /f' },
  { id: 6, type: 'command', shell: 'pwsh', cmd: 'vssadmin delete shadows /all' },
  { id: 7, type: 'download', file: 'tool.exe', run: true, args: [] },
  { id: 8, type: 'download', file: 'fix.ps1', run: true, args: [] },
];
for (const s of steps) {
  const d = staticCheck(s, cfg);
  const verdict = d && d.action !== 'run' ? `${d.action}: ${d.reason}` : 'allowed';
  console.log(`  ${s.id}. ${describeStep(s).padEnd(44)} ${verdict}`);
}

await rm(dir, { recursive: true, force: true });
