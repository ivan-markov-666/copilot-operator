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

/*
 * Giving up honestly.
 *
 * The bar is in the schema rather than in the prose on purpose: a model that has stopped trying
 * will also stop reading instructions carefully, so what makes `blocked` mean something is that
 * a reply which does not meet it is sent back. Two different approaches, written down, and a
 * summary of where things stand.
 */
console.log('\n--- blocked: the honest way out, and what it costs to use it ---');
const tried = [
  'Connected with the connection string in the task; the server refused with host not found.',
  'Checked whether the host resolves with Resolve-DnsName; it does not.',
];
const blockedSummary =
  'Nothing was changed. The task targets a database host that does not resolve from this machine, so no connection could be made. The migration files were read and are valid.';

const blockedCase = (label: string, obj: unknown): void => {
  const r = parseReply(block(obj), opts);
  if (r.ok) {
    console.log(
      `${label.padEnd(32)} ok   blocked=${String(r.blocked).padEnd(5)} done=${String(r.done).padEnd(5)} tried=${r.reply.tried.length}`,
    );
  } else {
    console.log(`${label.padEnd(32)} FAIL ${r.detail.slice(0, 92)}`);
  }
};

blockedCase('blocked, done properly', { status: 'blocked', steps: [], tried, summary: blockedSummary, needed: 'The real host name.' });
blockedCase('blocked, one approach only', { status: 'blocked', steps: [], tried: [tried[0]], summary: blockedSummary });
blockedCase('blocked, no tried at all', { status: 'blocked', steps: [], summary: blockedSummary });
blockedCase('blocked, no summary', { status: 'blocked', steps: [], tried });
blockedCase('blocked, but carrying steps', { status: 'blocked', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }], tried, summary: blockedSummary });
blockedCase('done, but carrying steps', { status: 'done', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }], summary });

// The stop word must not turn a giving-up reply into a successful one.
const withMarker = parseReply(block({ status: 'blocked', steps: [], tried, summary: blockedSummary }) + '\nКрай', opts);
console.log(
  'marker cannot fake done          :',
  withMarker.ok ? `done=${withMarker.done} blocked=${withMarker.blocked}` : 'FAIL',
  '(expect done=false blocked=true)',
);

console.log('\n--- line-number repair (DOM fallback) ---');
const gutter = '1\n{"status":"continue","steps":[\n2\n{"id":1,"type":"command","cmd":"Get-Date"}]}';
console.log('stripped ->', JSON.stringify(stripLineNumbers(gutter)));
show('DOM-style with gutter', '```json\n' + gutter + '\n```');

console.log('\n--- default shell applied ---');
const r = parseReply(block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }] }), opts);
if (r.ok) console.log('shell =', r.reply.steps[0].shell);
console.log('fenced blocks found in a mixed reply:', extractFencedBlocks('```ts\na\n```\n```json\n{}\n```').map((b) => b.lang).join(', '));
