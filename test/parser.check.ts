import { parseReply, extractFencedBlocks, stripLineNumbers } from '../src/protocol/parser.js';
import { mergeDeviations, describeDeviations, resolveDeviations, mergeDisputes, describeDisputes } from '../src/protocol/replySchema.js';

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

/*
 * Deviations: an instruction not followed as written, as data.
 *
 * Two product decisions were taken by a model in one run — an older TypeScript pinned so a
 * removed option would still parse, a tsconfig value restored after every build because the
 * build rewrote it — and both were recorded only in `notes`, which nothing reads. The field is
 * where such a decision goes so that the commit, the register and the reviewer all see it.
 */
console.log('\n--- deviations: what could not be done as written, as data ---');
const deviation = {
  instruction: 'tsconfig.json with moduleResolution node',
  did: 'moduleResolution bundler',
  why: 'TS5108: moduleResolution=node10 has been removed; TypeScript 6.0.3 was installed',
};
const devCase = (label: string, obj: unknown): void => {
  const r = parseReply(block(obj), opts);
  console.log(r.ok ? `${label.padEnd(32)} ok   deviations=${r.reply.deviations.length}` : `${label.padEnd(32)} FAIL ${r.detail.slice(0, 80)}`);
};
devCase('declared mid-task, on continue', { status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npx tsc --noEmit' }], deviations: [deviation] });
devCase('declared on done', { status: 'done', steps: [], summary, deviations: [deviation] });
devCase('left out entirely', { status: 'done', steps: [], summary });
devCase('missing why (reject)', { status: 'done', steps: [], summary, deviations: [{ instruction: 'x', did: 'y' }] });
devCase('blank why (reject)', { status: 'done', steps: [], summary, deviations: [{ ...deviation, why: '  ' }] });

const merged = mergeDeviations(
  [deviation],
  [
    { ...deviation, instruction: '  TSCONFIG.JSON with   moduleResolution node ', why: 'refined: TypeScript 6 removed node10' },
    { instruction: 'jsx preserve', did: 'restored the value after each build', why: 'next build rewrites tsconfig.json' },
  ],
);
console.log('merged by instruction     :', merged.length, '(expect 2 — the repeat is one deviation, later wording wins)');
console.log('later wording kept        :', merged[0].why.startsWith('refined') ? 'yes' : 'NO');

/*
 * The closing reply is the final account.
 *
 * A deviation declared mid-way and undone since — Node16 set, then back to `node` once
 * TypeScript was pinned — stood in the commit as a fact. A `done` that lists deviations
 * replaces the list; one that lists none keeps it, because forgetting is the common case.
 */
const midWay = [{ instruction: 'moduleResolution node', did: 'Node16', why: 'TS5108' }];
const closing = [{ instruction: 'typescript latest', did: 'pinned 5.9.2', why: 'TS5108 under 6' }];
console.log('continue adds             :', resolveDeviations(midWay, 'continue', closing).length, '(expect 2)');
console.log('done replaces             :', resolveDeviations(midWay, 'done', closing).map((d) => d.did).join(', '), '(expect pinned 5.9.2)');
console.log('blocked replaces          :', resolveDeviations(midWay, 'blocked', closing).length, '(expect 1)');
console.log('done with none keeps      :', resolveDeviations(midWay, 'done', []).length, '(expect 1)');

/*
 * Disputes: a wrong review finding, answered as data.
 *
 * One run's reviewer searched a page for label text the task never specified, and the
 * implementer, having objected in prose to nobody, renamed the labels. The field is the
 * objection with an address: the finding's id and the evidence, for the next reviewer.
 */
console.log('\n--- disputed: a wrong finding, answered where it can be read ---');
const dispute = { finding: 'r1f2', why: 'The labels are A and B, as the task defines them.', evidence: 'Invoke-WebRequest returned HTML with <label for="a">A</label> and <label for="b">B</label>.' };
const disCase = (label: string, obj: unknown): void => {
  const r = parseReply(block(obj), opts);
  console.log(r.ok ? `${label.padEnd(32)} ok   disputed=${r.reply.disputed.length}` : `${label.padEnd(32)} FAIL ${r.detail.slice(0, 80)}`);
};
disCase('disputed, on continue', { status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npx next build' }], disputed: [dispute] });
disCase('disputed, on done', { status: 'done', steps: [], summary, disputed: [dispute] });
disCase('missing evidence (reject)', { status: 'done', steps: [], summary, disputed: [{ finding: 'r1f2', why: 'wrong' }] });
const mergedDisputes = mergeDisputes([dispute], [{ ...dispute, finding: 'R1F2', why: 'refined: the review searched for text the task never gave' }, { finding: 'r1f1', why: 'x', evidence: 'y' }]);
console.log('merged by finding id      :', mergedDisputes.length, '(expect 2)');
console.log(describeDisputes(mergedDisputes).split('\n').map((l) => '  ' + l).join('\n'));
console.log(
  describeDeviations(merged)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
);
