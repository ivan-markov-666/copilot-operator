/**
 * The operator's persona: the approach of the agent that carries out the tasks.
 *
 * It is one of the three parts of Kerrigan that come from the operator, and the only one that reaches
 * execution directly: the import writes it into every task's level 2. That makes three properties
 * worth pinning, and the third is the one a quiet regression would cost most.
 *
 *   it arrives        on every task, whichever branch the rest of level 2 takes, and first
 *   it can be taken   back out exactly, even when the operator's text has headings of its own
 *   it round-trips    import → plan export → import again gives exactly one persona — the one in
 *                     the field at the second import — and the session's goal survives the trip
 *
 * The round trip runs through the real importer, store and exporter rather than through copies of
 * their logic, because the failure it guards against lives in the gap between them: the exporter
 * finds a session's goal by looking at the head of level 2, and a persona put in front of it moves
 * the goal away from the head.
 *
 * And the brief: a persona present is used and not copied, a missing one is asked for before any
 * plan, and nobody is ever asked to name one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeLevel2, importPlan, personaBlock, withoutPersona, PERSONA_HEADER, PERSONA_END } from '../src/plan/importPlan.js';
import { checkPlan } from '../src/plan/schema.js';
import { buildPlanExport } from '../src/session/exports.js';
import { SessionStore } from '../src/session/store.js';
import { planBrief } from '../src/plan/brief.js';
import type { Session } from '../src/session/model.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const count = (text: string, needle: string): number => text.split(needle).length - 1;

// A persona with headings and a rule of its own, which is exactly what "cut at the next heading" breaks.
const PERSONA = [
  '## Responsible for',
  'Implementing the change and proving it works. Not the release.',
  '',
  '## Phases',
  '1. Read. 2. Change. 3. Verify.',
  '',
  '---',
  'Hand back a summary with the test output.',
].join('\n');
const OTHER = 'Read-only audit. Change nothing; report what you find.';

const session = { goal: 'Make the calculator add.', level2: 'Use TypeScript. Run npm test.' };
const plain = { level2: '' };
const ownTask = { level2: 'This task only: touch nothing outside src/.' };

console.log('--- it arrives on every task, first ---');
const shared = composeLevel2(session as never, plain as never, PERSONA);
const own = composeLevel2(session as never, ownTask as never, PERSONA);
check('a task using the session level 2 gets it', shared.startsWith(PERSONA_HEADER), true);
check('a task with level 2 of its own gets it too', own.startsWith(PERSONA_HEADER), true);
check('and the task keeps its own instructions', own.includes('This task only'), true);
check('the session goal is still there', shared.includes('Make the calculator add.'), true);
check('no persona leaves level 2 exactly as it was', composeLevel2(session as never, plain as never, ''), composeLevel2(session as never, plain as never));

console.log('\n--- it can be taken back out exactly ---');
check('the block closes with its own line', personaBlock(PERSONA).endsWith(PERSONA_END), true);
check('its own headings and rules do not cut it short', withoutPersona(shared), composeLevel2(session as never, plain as never));
check('a level 2 without one is left alone', withoutPersona('Use TypeScript.'), 'Use TypeScript.');
check('composing twice replaces rather than stacks', count(composeLevel2({ ...session, level2: shared } as never, plain as never, OTHER), PERSONA_HEADER), 1);
check('and the one that stays is the new one', composeLevel2({ ...session, level2: shared } as never, plain as never, OTHER).includes('Read-only audit'), true);

console.log('\n--- import, export, import again ---');
const plan = {
  version: 1,
  plan: 'persona round trip',
  onFailure: 'stop',
  conversation: 'per-session',
  sessions: [
    {
      name: 'calc',
      goal: 'Make the calculator add.',
      onFailure: 'stop',
      level2: 'Use TypeScript. Run npm test.',
      vcs: { enabled: false },
      tasks: [
        { title: 'add', prompt: 'Implement add(a, b) in src/calc.ts and a test for it in test/calc.test.ts.', expected: 'npm test passes.' },
        { title: 'sub', prompt: 'Implement sub(a, b) in src/calc.ts and a test for it in test/calc.test.ts.', expected: 'npm test passes.' },
      ],
    },
  ],
};
const checked = checkPlan(JSON.stringify(plan));
check('the plan used here is itself valid', checked.ok, true);

const dir = await mkdtemp(join(tmpdir(), 'cop-persona-'));
try {
  const store = new SessionStore(dir, join(process.cwd(), 'prompts', 'level1.md'));
  await store.init();
  if (!checked.ok) throw new Error('plan did not validate');

  const first = await importPlan(store, checked.plan, '', '', PERSONA);
  const imported = (await store.getSession(first.sessions[0]!.id)) as Session;
  check('every imported task carries the persona', imported.tasks.every((t) => t.level2.startsWith(PERSONA_HEADER)), true);
  check('exactly once each', imported.tasks.every((t) => count(t.level2, PERSONA_HEADER) === 1), true);

  const exported = buildPlanExport({ sessions: [imported], label: 'round trip' }) as { sessions: Array<{ goal: string; level2: string; tasks: Array<{ level2?: string }> }> };
  const s0 = exported.sessions[0]!;
  const exportedText = JSON.stringify(exported);
  check('the plan export leaves the persona out', exportedText.includes(PERSONA_HEADER), false);
  check('the session goal survives, in its own field', s0.goal, 'Make the calculator add.');
  check('the session level 2 survives, without it', s0.level2, 'Use TypeScript. Run npm test.');
  check('no task is given a level 2 of its own by the trip', s0.tasks.every((t) => t.level2 === undefined), true);

  const again = checkPlan(JSON.stringify(exported));
  check('the export is a valid plan', again.ok, true);
  if (!again.ok) throw new Error('export did not validate');
  const second = await importPlan(store, again.plan, '', '', OTHER);
  const reimported = (await store.getSession(second.sessions[0]!.id)) as Session;
  check('importing again gives exactly one persona per task', reimported.tasks.every((t) => count(t.level2, PERSONA_HEADER) === 1), true);
  check('and it is the one in the field now', reimported.tasks.every((t) => t.level2.includes('Read-only audit') && !t.level2.includes('Implementing the change')), true);
  check('the goal came back as the goal', reimported.tasks.every((t) => t.level2.includes('## Goal of this session')), true);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('\n--- what the brief asks of Kerrigan ---');
for (const lang of ['en', 'bg'] as const) {
  const present = planBrief({ lang, organisation: 'org', persona: PERSONA, work: 'work' });
  const missing = planBrief({ lang, organisation: 'org', personaExample: '{"persona":{}}', work: 'work' });
  const firstRun = planBrief({ lang, organisationExample: '{}', personaExample: '{"persona":{}}', workExample: '{}' });
  const noCopy = lang === 'bg' ? 'Не я копирай в `level2`' : 'Do not copy it into `level2`';
  const missingStep = lang === 'bg' ? 'липсва подходът' : 'the approach is missing';
  const noName = lang === 'bg' ? 'Никога не' : 'Never give it a name';
  const noOrgName = lang === 'bg' ? 'Не питай как се казва организацията' : 'Do not ask what the organisation or a project is called';

  check(`${lang}: a persona present is in the brief`, present.includes('Implementing the change'), true);
  check(`${lang}: and Kerrigan is told not to copy it`, present.includes(noCopy), true);
  check(`${lang}: a missing one is asked for before planning`, missing.includes(missingStep), true);
  check(`${lang}: that step forbids a name`, missing.includes(noName), true);
  check(`${lang}: with everything missing, phase 0 asks for it instead`, firstRun.includes(missingStep), false);
  check(`${lang}: phase 0 forbids naming it`, firstRun.includes(noName), true);
  check(`${lang}: and does not ask what anything is called`, firstRun.includes(noOrgName), true);
}

console.log('\n--- the conversation opens with who she is, then the phase ---');
for (const lang of ['en', 'bg'] as const) {
  const greeting = lang === 'bg' ? 'Здравей, аз съм Kerrigan, Queen of Blades! Ще ти помагам с' : "Hello, I'm Kerrigan, Queen of Blades! I'll help you with";
  const phaseRule = lang === 'bg' ? '**Казвай в коя фаза си.**' : '**Say which phase you are in.**';
  // Every state a first conversation can begin in: nothing written, the persona missing, all written.
  for (const [state, brief] of [
    ['first run', planBrief({ lang, organisationExample: '{}', personaExample: '{}', workExample: '{}' })],
    ['persona missing', planBrief({ lang, organisation: 'org', personaExample: '{}', work: 'work' })],
    ['all written', planBrief({ lang, organisation: 'org', persona: 'approach', work: 'work' })],
  ] as const) {
    check(`${lang}, ${state}: the greeting is there`, brief.includes(greeting), true);
    check(`${lang}, ${state}: and comes before the phase line`, brief.indexOf(greeting) < brief.indexOf(phaseRule), true);
  }
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
