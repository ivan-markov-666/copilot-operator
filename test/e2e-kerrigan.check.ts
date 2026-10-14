/**
 * Kerrigan and existing work, end to end through the API with the scripted chat of test/support/fakeChat.ts
 * (asked for on 2026-10-14: no dead end — the operator tells Kerrigan what happened, she proposes how to go on,
 * and her answer changes the sessions that exist instead of making copies of them).
 *
 * - the report names every session and task by id, how each ended and why, and the operator's note, and says
 *   how to answer;
 * - her answer is read against the sessions as they are, each change said in words, and refused with the
 *   reason when it names what is not there or does not fit the task's state;
 * - applied, the changes go through the paths the buttons use: a blocked task carried on with her prompt, a
 *   queued one edited and given a note, a task added between two, a done one given a new prompt; nothing starts;
 * - the run then does them, in order.
 *
 *   npm run check:e2e-kerrigan
 */
import { startHarness, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Full = TaskView & { continuing?: { how?: string; instruction?: string }; buildsOn?: { fromAttempt: number }; notes?: Array<{ text: string; sentAt?: string }> };
type Check = { ok: boolean; changes?: Array<{ says: string; taskId?: string }>; issues?: Array<{ path: string; message: string }> };

const task = (title: string, file: string, text: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});
const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);
const session = (h: Harness, name: string, tasks: unknown[]): Record<string, unknown> => ({
  name, onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name }, review: { enabled: false }, tasks,
});

console.log('\n--- what happened goes to Kerrigan; her changes come back and are applied to the sessions that exist ---');
const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 } } });
try {
  const [a, b] = await h.importPlan({
    version: 1,
    sessions: [
      session(h, 'main-work', [task('schema', 'a.txt', 'one'), task('okta-tests', 'b.txt', 'two'), task('docs', 'c.txt', 'three')]),
      session(h, 'side-work', [task('readme', 'r.txt', 'readme')]),
    ],
  });
  h.chat.script(write('a.txt', 'one'), reply.done(), ...reply.triedThenBlocked());
  const ranA = await h.run(a!.id);
  h.chat.script(write('r.txt', 'readme'), reply.done());
  await h.run(b!.id);
  const [schema, okta, docs] = ranA.tasks as Full[];
  t.check('main-work: done, blocked, still queued', ranA.tasks.map((x) => x.status), ['done', 'blocked', 'queued']);

  const note = 'The Okta tests need the tenant id from the .env.example file.';
  const report = (await h.call<{ text: string }>('POST', '/kerrigan/report', { sessionIds: [a!.id], note })).text;
  t.truthy('the report names the session and every task by id, with its state', report.includes(`id ${a!.id}`) && [schema!, okta!, docs!].every((x) => report.includes(`id ${x.id}`)) && report.includes('— blocked'), report.slice(0, 1200));
  t.truthy('says why the blocked one stopped, and carries the operator\'s note', report.includes('why it stopped:') && report.includes(note), report.slice(0, 1500));
  t.truthy('and how to answer, with every change', report.includes('## How to answer') && ['"continue"', '"newPrompt"', '"runAgain"', '"undo"', '"accept"', '"addTask"', '"editTask"', '"removeTask"', '"note"'].every((op) => report.includes(op)), report.slice(-1600));
  t.truthy('the other session is left out when only one is asked for', !report.includes('side-work'));

  const wrong = await h.call<Check>('POST', '/changes/check', {
    text: JSON.stringify({ version: 1, changes: [
      { op: 'continue', session: 'nobody', task: 1, instruction: 'Carry on with the tenant id.' },
      { op: 'editTask', session: a!.id, task: schema!.id, prompt: 'Rewrite the schema file so that it holds exactly the text uno.' },
      { op: 'newPrompt', session: a!.id, task: okta!.id, prompt: 'Make the tests pass with the tenant id from .env.example.' },
    ] }),
  });
  t.check('an answer that names what is not there, or does not fit, is refused change by change',
    wrong.issues?.map((i) => i.path), ['changes[0].session', 'changes[1].op', 'changes[2].op']);
  t.truthy('each with why', /only a queued task is edited/.test(JSON.stringify(wrong.issues)) && /builds on a done task/.test(JSON.stringify(wrong.issues)), wrong.issues);

  const answer = 'I think the Okta task blocked for want of the tenant id; here is how to go on.\n\n```json\n' + JSON.stringify({
    version: 1,
    notes: 'Carry the blocked task on with the tenant id, check the schema first, and keep the docs short.',
    changes: [
      { op: 'continue', session: a!.id, task: okta!.id, instruction: 'The tenant id is in .env.example: create b.txt holding exactly the text two.' },
      { op: 'addTask', session: 'main-work', after: 1, task: task('schema-check', 's.txt', 'checked') },
      { op: 'editTask', session: a!.id, task: 'docs', prompt: 'Create c.txt in the repository root holding exactly the text three, in one line.' },
      { op: 'note', session: a!.id, task: docs!.id, text: 'No trailing spaces.' },
      { op: 'newPrompt', session: 'side-work', task: 1, prompt: 'Add a second line to r.txt so that it also says more, after readme.' },
    ],
  }) + '\n```';
  const ok = await h.call<Check>('POST', '/changes/check', { text: answer });
  t.check('her answer, pasted with her words around it, is read and each change said in words', [ok.ok, ok.changes?.length], [true, 5]);
  t.truthy('naming what each does', /carry "okta-tests" on/.test(ok.changes?.[0]?.says ?? '') && /add task "schema-check" to "main-work", after "schema"/.test(ok.changes?.[1]?.says ?? ''), ok.changes);
  t.check('nothing changed by checking', (await h.session(a!.id)).tasks.map((x) => x.status), ['done', 'blocked', 'queued']);

  const applied = await h.call<{ ok: boolean; applied: unknown[] }>('POST', '/changes/apply', { text: answer });
  t.check('applied, all five', [applied.ok, applied.applied.length], [true, 5]);
  const after = (await h.session(a!.id)).tasks as Full[];
  t.check('the new task sits after the first; the blocked one and the docs wait', after.map((x) => [x.title, x.status]), [['schema', 'done'], ['schema-check', 'queued'], ['okta-tests', 'queued'], ['docs', 'queued']]);
  t.check('the blocked task goes on with her prompt, from where it got to', [after[2]!.continuing?.how, after[2]!.continuing?.instruction], ['failed', 'The tenant id is in .env.example: create b.txt holding exactly the text two.']);
  t.check('the queued one has the new prompt and a note', [after[3]!.prompt, after[3]!.notes?.map((n) => n.text)], ['Create c.txt in the repository root holding exactly the text three, in one line.', ['No trailing spaces.']]);
  const side = (await h.session(b!.id)).tasks[0] as Full;
  t.check('the done task in the other session is queued with the new prompt, building on its work', [side.status, side.buildsOn?.fromAttempt], ['queued', 1]);
  t.check('nothing was started', (await h.call<{ running: boolean }>('GET', '/activity')).running, false);

  h.chat.script(
    write('s.txt', 'checked'), reply.done(),
    (m) => {
      t.truthy('the carried-on task gets her prompt', m.text.includes('The tenant id is in .env.example'), m.text.slice(-600));
      return write('b.txt', 'two');
    },
    reply.done(),
    (m) => {
      t.truthy('the edited task goes out with its new prompt and the note', m.text.includes('in one line.') && m.text.includes('No trailing spaces.'), m.text.slice(-800));
      return write('c.txt', 'three');
    },
    reply.done(),
  );
  const ran = await h.run(a!.id);
  t.check('the run does them in order, all done', ran.tasks.map((x) => x.status), ['done', 'done', 'done', 'done']);
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  t.check('every scripted reply was used', h.chat.pending, 0);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
