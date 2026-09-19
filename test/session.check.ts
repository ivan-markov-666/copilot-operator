import { composeOpening } from '../src/session/compose.js';
import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

console.log('--- compose: first task in a session ---');
const first = composeOpening({
  level1: '# Level 1\nContract text.',
  level2: 'We use pnpm. Never touch main.',
  prompt: 'Run the unit tests.',
  taskTitle: 'unit tests',
  taskNumber: 1,
  contractAlreadySent: false,
});
console.log('messages          :', first.messages.length, '(expect 2: contract, then level2+task)');
console.log('first is contract :', first.messages[0].startsWith('# Level 1'));
console.log('second has level2 :', first.messages[1].includes('We use pnpm'), '| has task:', first.messages[1].includes('Run the unit tests'));
console.log('firstMessage keeps both:', first.firstMessage.includes('Contract text') && first.firstMessage.includes('Run the unit tests'));

console.log('\n--- compose: later task, same conversation ---');
const later = composeOpening({
  level1: '# Level 1', level2: '', prompt: 'Now lint.', taskTitle: 'lint', taskNumber: 2, contractAlreadySent: true,
});
console.log('messages          :', later.messages.length, '(expect 1)');
console.log('reminds contract  :', later.messages[0].includes('still applies unchanged'));
console.log('empty level2 said :', later.messages[0].includes('(none for this task)'));
console.log('task numbered     :', later.messages[0].includes('## Task 2: lint'));

console.log('\n--- store round trip ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-store-'));
const store = new SessionStore(dir, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const l1 = await store.getLevel1();
console.log('level1 shipped    :', !l1.customised, '| length', l1.content.length);
await store.setLevel1('# custom');
console.log('level1 customised :', (await store.getLevel1()).customised);
await store.resetLevel1();
console.log('level1 reset      :', !(await store.getLevel1()).customised);

const s = await store.createSession('payments', { enabled: true, rootDir: 'C:/x', includeDirs: ['src'] });
const t1 = await store.addTask(s.id, { title: 'first', level2: 'L2', prompt: 'do a' });
await store.addTask(s.id, { title: '', level2: '', prompt: 'do b with a very long prompt that becomes the title when none is given' });
const loaded = await store.getSession(s.id);
console.log('tasks persisted   :', loaded?.tasks.length, '| titles:', loaded?.tasks.map((t) => t.title).join(' / '));
await store.updateTask(s.id, t1.id, (t) => { t.status = 'done'; t.summary = 'did a'; });
console.log('task updated      :', (await store.getSession(s.id))?.tasks[0].summary);
console.log('\n--- what can be deleted ---');
const active = await store.addTask(s.id, { title: 'in flight', level2: '', prompt: 'do c' });
await store.updateTask(s.id, active.id, (t) => { t.status = 'waiting-approval'; });
try { await store.deleteTask(s.id, active.id); console.log('delete running    : ALLOWED (wrong)'); }
catch (e) { console.log('delete running    : refused (correct) -', (e as Error).message); }
await store.deleteTask(s.id, t1.id);
console.log('delete done task  : allowed, tasks left:', (await store.getSession(s.id))?.tasks.length);

console.log('\n--- running a finished task again ---');
const retry = await store.addTask(s.id, { title: 'flaky', level2: 'L2', prompt: 'do it' });
await store.updateTask(s.id, retry.id, (t) => {
  t.status = 'failed';
  t.runId = 'run-one';
  t.iterations = 3;
  t.summary = undefined;
  t.reason = 'the chat went down';
  t.startedAt = '2026-09-18T10:00:00.000Z';
  t.finishedAt = '2026-09-18T10:05:00.000Z';
});
const requeued = await store.rerunTask(s.id, retry.id);
console.log('status now        :', requeued.status, '| attempt:', requeued.attempt, '| iterations:', requeued.iterations);
console.log('live fields clear :', requeued.runId === undefined && requeued.reason === undefined && requeued.finishedAt === undefined);
console.log('kept the attempt  :', JSON.stringify(requeued.attempts?.map((a) => `${a.status}/${a.runId}/${a.iterations} iters/${a.reason}`)));
try { await store.rerunTask(s.id, retry.id); console.log('re-running a queued task: ALLOWED (wrong)'); }
catch (e) { console.log('re-running a queued task: refused (correct) -', (e as Error).message); }
console.log('second attempt id :', `sessionId-taskId${(requeued.attempt ?? 1) > 1 ? `-a${requeued.attempt}` : ''}`, '(the run folder of attempt 1 is untouched)');

console.log('\n--- editing a task that has already run ---');
await store.updateTask(s.id, retry.id, (t) => {
  t.status = 'done';
  t.runId = 'run-two';
  t.summary = 'it worked the second time';
  t.iterations = 1;
});
const edited = await store.rerunTask(s.id, retry.id, { title: 'flaky, reworded', prompt: 'do it differently' });
console.log('task now          :', edited.status, '| attempt:', edited.attempt, '| title:', edited.title, '| prompt:', edited.prompt);
console.log('old attempts kept :', edited.attempts?.length);
console.log('what attempt 2 ran:', JSON.stringify(edited.attempts?.[1] && { prompt: edited.attempts[1].prompt, summary: edited.attempts[1].summary }));
console.log('the edit did NOT touch it:', edited.attempts?.[1]?.prompt === 'do it' && edited.attempts?.[1]?.summary === 'it worked the second time');

console.log('\n--- recovery after the process was killed mid-task ---');
const killed = await store.createSession('killed');
const kt = await store.addTask(killed.id, { title: 'was waiting', level2: '', prompt: 'do d' });
const kq = await store.addTask(killed.id, { title: 'still queued', level2: '', prompt: 'do e' });
await store.updateTask(killed.id, kt.id, (t) => { t.status = 'waiting-approval'; });
await store.updateSession(killed.id, (x) => { x.status = 'running'; });
const recovered = await store.recoverInterrupted();
const after = await store.getSession(killed.id);
console.log('reported          :', recovered.filter((r) => r.sessionId === killed.id).map((r) => r.title).join(', '), '(expect: was waiting)');
console.log('other sessions too:', recovered.length > 1, '(the pass covers every session, not just this one)');
console.log('stuck task now    :', after?.tasks.find((t) => t.id === kt.id)?.status, '| reason:', after?.tasks.find((t) => t.id === kt.id)?.reason?.slice(0, 48));
console.log('queued untouched  :', after?.tasks.find((t) => t.id === kq.id)?.status, '(expect queued)');
console.log('session freed     :', after?.status, '(expect idle)');
console.log('now deletable     :', await store.deleteTask(killed.id, kt.id).then(() => 'yes').catch((e: Error) => `no: ${e.message}`));
console.log('second pass finds :', (await store.recoverInterrupted()).length, '(expect 0)');
await store.savePreset('Payments team', 'Use pnpm.');
console.log('presets           :', (await store.listPresets()).map((p) => p.name).join(', '));
console.log('sessions listed   :', (await store.listSessions()).length);
console.log('raw file is json  :', JSON.parse(await readFile(join(dir, 'sessions', `${s.id}.json`), 'utf8')).name);

console.log('\n--- event bus ---');
const bus = new EventBus();
const got: string[] = [];
const off = bus.subscribe(s.id, (e) => got.push(e.type));
bus.publish({ sessionId: s.id, type: 'a', level: 'info' });
bus.publish({ sessionId: 'other', type: 'b', level: 'info' });
bus.publish({ sessionId: s.id, type: 'c', level: 'info' });
off();
bus.publish({ sessionId: s.id, type: 'd', level: 'info' });
console.log('subscriber saw    :', got.join(','), '(expect a,c)');
console.log('history           :', bus.recent(s.id).map((e) => e.type).join(','), '(expect a,c,d)');
await rm(dir, { recursive: true, force: true });
