import { buildChatName, makeRunId, parseChatId, MAX_CHAT_NAME } from '../src/transport/chatSession.js';
import { buildCoveringMessage, assertSendable } from '../src/protocol/reporter.js';
import type { RunResult } from '../src/exec/runner.js';

const runId = makeRunId(new Date('2026-09-17T19:12:00'));
const cases: Array<[string, string]> = [
  [runId, 'windows-update'],
  [runId, 'run the full regression test suite for the payments service'],
  [runId, 'тест на кирилица и интервали'],
  [runId, ''],
];
for (const [r, label] of cases) {
  const n = buildChatName(r, label);
  console.log(`${String(n.length).padStart(2)} chars  ${n}  ${n.length <= MAX_CHAT_NAME ? 'ok' : 'TOO LONG'}`);
}
console.log('parseChatId:', parseChatId('https://m365.cloud.microsoft/chat/conversation/8cdb5dc4-f45b-4ce7-846a-f851bff59534?es=SSR'));
console.log('parseChatId(new chat):', parseChatId('https://m365.cloud.microsoft/chat?es=SSR'));

const mk = (id: number, outcome: RunResult['outcome'], exitCode: number): RunResult => ({
  id, shell: 'pwsh', command: 'x', exitCode, outcome, durationMs: 1, stdout: '', stderr: '',
  truncated: false, logPath: '', lastOutputAgoMs: 0,
});

console.log('\n--- covering messages ---');
console.log(buildCoveringMessage({ iteration: 3, results: [mk(1,'completed',0), mk(2,'completed',1)], attachments: ['iteration-3.txt'] }));
console.log();
console.log(buildCoveringMessage({ iteration: 7, results: [mk(1,'idle-timeout',-1)], attachments: ['iteration-7-part1.txt','iteration-7-part2.txt'], parts: 2 }));
console.log();
console.log(buildCoveringMessage({ iteration: 9, results: [], attachments: [] }));

try { assertSendable('   ', ['iteration-3.txt']); } catch (e) { console.log('\nguard:', (e as Error).message); }
console.log('guard passes with text:', (assertSendable('ok', ['f.txt']), true));
