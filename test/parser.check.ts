import { parseReply, extractFencedBlocks, stripLineNumbers } from '../src/protocol/parser.js';

const opts = { stopMarker: 'Край', defaultShell: 'pwsh' as const };
const show = (label: string, md: string): void => {
  const r = parseReply(md, opts);
  if (r.ok) {
    const steps = r.reply.steps.map((s) => (s.type === 'command' ? `command:${s.cmd}` : `download:${s.file}`));
    console.log(`${label.padEnd(30)} ok   done=${String(r.done).padEnd(5)} steps=${r.reply.steps.length} ${JSON.stringify(steps)}`);
  } else {
    console.log(`${label.padEnd(30)} FAIL ${r.reason}: ${r.detail.slice(0, 60)}`);
  }
};

const summary =
  'Checked the Windows Update service, collected the pending list, found nothing waiting. Nothing further is needed.';
const block = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';

show('plain json block', 'Here you go.\n\n' + block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }] }));
show('untagged block', '```\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]}\n```');
show('no fence at all', 'Sure: {"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]} done.');
show('done + summary + marker', 'All finished. Край\n\n' + block({ status: 'done', steps: [], summary }));
show('done, NO summary (reject)', 'Край\n\n' + block({ status: 'done', steps: [], notes: 'all good' }));
show('done, summary too short', block({ status: 'done', steps: [], summary: 'done.' }));
show('marker + summary, continue', block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'echo hi' }], summary }) + '\nКрай');
show('marker, no summary (not done)', block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'echo hi' }] }) + '\nКрай');
show('long step', block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npm test', expect: 'long', timeoutSec: 7200, idleTimeoutSec: 600 }] }));
show('download step', block({ status: 'continue', steps: [{ id: 1, type: 'download', file: 'x.ps1', run: true, args: ['-WhatIf'] }] }));
show('continue with no steps', block({ status: 'continue', steps: [] }));
show('bad shell', block({ status: 'continue', steps: [{ id: 1, type: 'command', shell: 'bash', cmd: 'ls' }] }));
show('prose only', 'I think you should check the service and then reboot.');
show('two blocks, json second', '```powershell\nGet-Date\n```\n\n' + block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }] }));

console.log('\n--- line-number repair (DOM fallback) ---');
const gutter = '1\n{"status":"continue","steps":[\n2\n{"id":1,"type":"command","cmd":"Get-Date"}]}';
console.log('stripped ->', JSON.stringify(stripLineNumbers(gutter)));
show('DOM-style with gutter', '```json\n' + gutter + '\n```');

console.log('\n--- default shell applied ---');
const r = parseReply(block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }] }), opts);
if (r.ok) console.log('shell =', r.reply.steps[0].shell);
console.log('fenced blocks found in a mixed reply:', extractFencedBlocks('```ts\na\n```\n```json\n{}\n```').map((b) => b.lang).join(', '));
