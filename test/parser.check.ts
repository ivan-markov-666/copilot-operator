import { parseReply, extractFencedBlocks, stripLineNumbers } from '../src/protocol/parser.js';

const opts = { stopMarker: 'Край', defaultShell: 'pwsh' as const };
const show = (label: string, md: string) => {
  const r = parseReply(md, opts);
  if (r.ok) console.log(`${label.padEnd(26)} ok   done=${r.done} steps=${r.reply.steps.length} ${JSON.stringify(r.reply.steps.map(s => s.type + ':' + (s as any).cmd ?? s))}`);
  else console.log(`${label.padEnd(26)} FAIL ${r.reason}: ${r.detail.slice(0, 70)}`);
};

show('plain json block', 'Here you go.\n\n```json\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]}\n```\n');
show('untagged block', '```\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]}\n```');
show('no fence at all', 'Sure: {"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]} done.');
show('done + marker', 'All finished. Край\n\n```json\n{"status":"done","steps":[],"notes":"all good"}\n```');
show('done via marker only', '```json\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"echo hi"}]}\n```\nКрай');
show('long step', '```json\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"npm test","expect":"long","timeoutSec":7200,"idleTimeoutSec":600}]}\n```');
show('download step', '```json\n{"status":"continue","steps":[{"id":1,"type":"download","file":"x.ps1","run":true,"args":["-WhatIf"]}]}\n```');
show('continue with no steps', '```json\n{"status":"continue","steps":[]}\n```');
show('bad shell', '```json\n{"status":"continue","steps":[{"id":1,"type":"command","shell":"bash","cmd":"ls"}]}\n```');
show('prose only', 'I think you should check the service and then reboot.');
show('two blocks, json second', '```powershell\nGet-Date\n```\n\n```json\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]}\n```');

console.log('\n--- line-number repair (DOM fallback) ---');
const gutter = '1\n{"status":"continue","steps":[\n2\n{"id":1,"type":"command","cmd":"Get-Date"}]}';
console.log('stripped ->', JSON.stringify(stripLineNumbers(gutter)));
show('DOM-style with gutter', '```json\n' + gutter + '\n```');

console.log('\n--- default shell applied ---');
const r = parseReply('```json\n{"status":"continue","steps":[{"id":1,"type":"command","cmd":"Get-Date"}]}\n```', opts);
if (r.ok) console.log('shell =', r.reply.steps[0].shell);
console.log('fenced blocks found in a mixed reply:', extractFencedBlocks('```ts\na\n```\n```json\n{}\n```').map(b => b.lang).join(', '));
