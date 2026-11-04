/**
 * What "Copy all" takes from a card the bot addressed to the operator (operator, 2026-11-04: "for every such message from
 * the bot to the user, let me copy what it gives me as information; the text and the choices too"). No browser and no
 * chat: `cardCopy` and its neighbours, kind by kind, from top to bottom, whatever a card has and leaves out. That each
 * card shows the button last, and that it reaches the clipboard, is in ui-flows.
 *
 *   npm run check:card-copy
 */
import type { Approval, Parked, TaskPlan } from '../web/lib/api.js';
import { afterStopCopy, cardCopy, parkedCopy } from '../web/lib/cardCopy.js';
import { en } from '../web/lib/lang/en.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const say = (key: string, vars?: Record<string, string | number>): string =>
  (en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
const base: Approval = { id: 'a1', sessionId: 's1', taskId: 't1', stepId: 3, description: 'npm test', createdAt: '2026-11-04T10:00:00.000Z' };
const plan: TaskPlan = { existing: 'Only README.md.', approach: 'One file.', steps: ['write it', 'read it'], files: ['a.txt'], verification: 'It reads back.', risks: 'None.', version: 1, at: '2026-11-04T10:00:00.000Z' };
const planText = `## ${en['pm.existing']}\n\nOnly README.md.\n\n## ${en['pm.approach']}\n\nOne file.\n\n## ${en['pm.steps']}\n\n1. write it\n2. read it\n\n## ${en['pm.files']}\n\n- \`a.txt\`\n\n## ${en['pm.verification']}\n\nIt reads back.\n\n## ${en['pm.risks']}\n\nNone.`;

console.log('--- a command ---');
t.check('the heading and the command, nothing it does not have', cardCopy(say, base), `${en['chat.askTitle']}\n\n\`\`\`\nnpm test\n\`\`\``);
t.check('its own heading where it has one', cardCopy(say, base, say('approval.title', { n: 3 })).split('\n\n')[0], say('approval.title', { n: 3 }));
t.check(
  'its warnings and the scripts it runs, each in full',
  cardCopy(say, {
    ...base,
    platform: 'Azure',
    readOnly: 'not only reading',
    network: 'a download',
    scripts: [
      { path: 'tools/a.ps1', kind: 'ps1', text: 'Write-Output 1', cut: true },
      { path: 'package.json', kind: 'npm', script: 'build', text: 'tsc' },
      { path: 'tools/gone.ps1', kind: 'ps1', problem: 'It is not there.' },
    ],
  }).split('\n\n'),
  [
    en['chat.askTitle'],
    '```\nnpm test\n```',
    say('approval.platform', { platform: 'Azure' }),
    en['approval.readOnly'],
    en['approval.network'],
    en['approval.scripts'],
    `tools/a.ps1\n${en['ho.cut']}\n\`\`\`\nWrite-Output 1\n\`\`\``,
    `${say('approval.scriptOf', { name: 'build', path: 'package.json' })}\n\`\`\`\ntsc\n\`\`\``,
    'tools/gone.ps1\nIt is not there.',
  ],
);

console.log('--- a question ---');
const question = { text: 'Which one?', why: 'They differ.', options: ['First', 'Second'], commands: ['npm test', null] };
t.check(
  'who asks, the question, why, every answer in order, the recommended one and what one runs said, how it is answered',
  cardCopy(say, { ...base, actor: 'lead', question }).split('\n\n'),
  [
    en['lead.question'],
    'Which one?',
    'They differ.',
    `${en['chat.copyOne']}\n1. First (${en['chat.optionRecommended']})\n   ${say('chat.optionRuns', { cmd: 'npm test' })}\n2. Second`,
    say('chat.copyWrite', { answer: en['lead.answer'], send: en['lead.send'] }),
  ],
);
t.check('asked by the chat, it says so', cardCopy(say, { ...base, actor: 'worker', question }).split('\n\n')[0], en['chat.question']);
t.check(
  'more than one may be chosen: it says how',
  cardCopy(say, { ...base, question: { ...question, multiple: true } }).split('\n\n').slice(-2).map((x) => x.split('\n')[0]),
  [say('chat.copyMany', { send: en['chat.sendChosen'] }), say('chat.copyWriteMany', { answer: en['lead.answer'], send: en['chat.sendChosen'] })],
);

console.log('--- commands to run yourself ---');
const handed = cardCopy(say, { ...base, question: { text: 'To read the claims.', options: [], handoff: { commands: ['npx tsx a.ts'], cwd: 'C:\\w', expect: 'It prints 42.', files: [] } } });
t.check('the card of its own, which opens with what it is for', [handed.split('\n\n')[0], handed.split('\n\n')[2]], [say('ho.historyTitle', { n: 1 }), 'To read the claims.']);

console.log('--- a plan ---');
t.check('its heading, what it says, the whole plan', cardCopy(say, { ...base, plan: { title: 'Add a file', plan } }), `${say('pm.cardTitle', { title: 'Add a file' })}\n\n${en['pm.cardWhy']}\n\n${planText}`);

console.log('--- a subtask cut off ---');
const retry: NonNullable<Approval['retry']> = {
  n: 2,
  title: 'Write the file',
  attempt: 1,
  maxAttempts: 3,
  category: 'TRANSIENT_CHAT_FAILURE',
  reason: 'The chat was lost.',
  sideEffects: 'unknown',
  changed: Array.from({ length: 10 }, (_, i) => `f${i}.txt`),
  choices: ['same', 'fresh', 'continue', 'restore', 'accept'],
};
t.check(
  'which, how far, why, what it left, every file, every choice',
  cardCopy(say, { ...base, retry }).split('\n\n'),
  [
    `${say('retry.title', { n: 2 })}\nWrite the file`,
    `${say('retry.attempt', { k: 1, m: 3 })} · ${en['retry.catTransient']}`,
    say('retry.reason', { reason: 'The chat was lost.' }),
    en['retry.unknown'],
    say('retry.changed', { files: retry.changed.join(', ') }),
    [en['chat.copyOffered'], `1. ${en['retry.same']}`, `2. ${en['retry.fresh']}`, `3. ${en['retry.continue']}`, `4. ${en['retry.restore']}`, `5. ${en['retry.accept']}`].join('\n'),
  ],
);
t.check('what it does not have leaves no gap', cardCopy(say, { ...base, retry: { ...retry, reason: '', sideEffects: 'none', changed: [] } }).split('\n\n').length, 3);

console.log('--- the model ---');
const model = { asked: 'Think deeper', shown: 'Auto', why: 'The menu did not open.', tries: 2 };
t.check(
  'the bot could not: what to do, what is shown, why',
  cardCopy(say, { ...base, model }).split('\n\n'),
  [en['approval.modelTitle'], say('approval.modelAsk', { model: 'Think deeper' }), say('approval.modelShown', { shown: 'Auto' }), say('approval.modelWhy', { why: 'The menu did not open.', tries: 2 })],
);
t.check(
  'by hand, for the review, with no model named: as the card says it',
  cardCopy(say, { ...base, model: { asked: '', shown: null, why: '', tries: 0, manual: true, review: true } }).split('\n\n'),
  [en['approval.manualTitle'], `${en['approval.reviewModelTitle']}\n${en['approval.reviewModelWhy']}`, en['approval.manualAskAny'], say('approval.modelShown', { shown: '—' })],
);
t.check('whose it is, in two chats', cardCopy(say, { ...base, model: { ...model, role: 'lead' } }).split('\n\n')[1], `${en['approval.leadModelTitle']}\n${en['approval.leadModelWhy']}`);

console.log('--- a task set aside, and a subtask after a Stop ---');
const parked = (kind: Parked['kind'], approval: Approval): string => parkedCopy(say, { kind, at: '2026-11-04T10:00:00.000Z', approval }, '10:00');
const head = (what: string): string => `${en['pk.title']}\n\n${say('pk.since', { at: '10:00', what })}\n\n`;
t.check('a command', parked('command', base), `${head(en['pk.waitsCommand'])}${cardCopy(say, base)}`);
t.check('a plan', parked('plan', { ...base, plan: { title: 'Add a file', plan } }), `${head(en['pk.waitsPlan'])}${cardCopy(say, { ...base, plan: { title: 'Add a file', plan } })}`);
t.check('a question', parked('question', { ...base, question }), `${head(en['pk.waitsQuestion'])}${cardCopy(say, { ...base, question })}`);
t.check('a subtask', parked('retry', { ...base, retry }), `${head(en['pk.waitsRetry'])}${cardCopy(say, { ...base, retry })}`);
t.check('the model, which no card holds', parked('model', { ...base, model }), `${head(en['pk.waitsModel'])}${en['pk.modelWhy']}`);
t.check('a password, which no card holds', parked('password', base), `${head(en['pk.waitsPassword'])}${en['pk.passwordWhy']}`);
t.check('after a Stop: the subtask, what can be done, the two answers', afterStopCopy(say, 2, 'Write the file'), `${say('lead.subtask', { n: 2, title: 'Write the file' })}\n\n${en['retry.afterStopWhy']}\n\n${en['chat.copyOffered']}\n1. ${en['retry.same']}\n2. ${en['retry.fresh']}`);

t.finish();
