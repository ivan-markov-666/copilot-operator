import { buildChatName, makeRunId, parseChatId, MAX_CHAT_NAME } from '../src/transport/chatSession.js';
import { landed, sentTextHead } from '../src/transport/acceptance.js';
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

/*
 * A message that landed but was not counted.
 *
 * Copilot virtualises a long conversation — four turn elements rendered for a chat of 48 —
 * and acceptance used to be "the rendered count went up". A findings message landed twice
 * and drew a reply, and was declared not accepted. The size now comes from the app's own
 * aria-setsize (not testable without a page); this is the second signal, what a person would
 * look at: the newest user bubble changed, and it begins with what was sent.
 */
console.log('\n--- landed: the newest user message is the one that was sent ---');
const sent = 'An independent review of your work found 1 problem(s). The reviewer is a\nseparate conversation that was given the task and the files you changed, ran the work itself, and\ndid not see your summary.\n\nWhat it checked: ...';
const shownAfter = 'An independent review of your work found 1 problem(s). The reviewer is a separate conversation that was given the task and the files you changed, ran the work itself, and did not see your summary. What it checked: ... iteration-6.txt';
console.log('head                    :', JSON.stringify(sentTextHead(sent).slice(0, 60)) + '…');
console.log('changed and matches     :', landed(sent, shownAfter, 'Terminal output for "web-smoke", iteration 6: 1 step(s)'), '(expect true)');
console.log('unchanged since before  :', landed(sent, shownAfter, shownAfter), '(expect false — that is the previous message)');
console.log('changed but different   :', landed(sent, 'Terminal output for "web-smoke", iteration 7', 'x'), '(expect false)');
console.log('nothing shown           :', landed(sent, '', 'x'), '(expect false)');
console.log('same prefix, other round:', landed('An independent review of your work found 1 problem(s). The reviewer is a separate conversation that was given the task and the files you changed, ran the work itself, and did not see your summary. Round 2.', shownAfter, shownAfter), '(expect false — unchanged newest bubble)');
