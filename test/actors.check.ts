/**
 * Who works, or asks, unit by unit (operator, 2026-10-22: "show clearly what the bot is doing and who works — plan
 * mode, the lead, the worker, the reviewer; on the cards for a model or a command, say who asks; LIVE beside Chat;
 * and in the tab"). No browser and no chat: the functions the runner, the API and the page say it with.
 *
 * - `actorOfSession`: who a conversation is before its first message — the worker or the lead of two chats, the chat
 *   that plans first (the session's plan mode over Settings'), else the worker;
 * - the authorizer hands the asker whose step it is, so the card can say so;
 * - a new attempt does not inherit who was at work in the last one;
 * - the words: the actor's name with its subtask or round, the LIVE mark's sentence, the tab's title (what waits
 *   first, then who is at work), and the short time on the operator's own messages.
 *
 *   npm run check:actors
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTOR_WORDS, actorOfSession } from '../src/orchestrator/taskRunner.js';
import { makeAuthorizer, type AuthorizeContext } from '../src/exec/authorizer.js';
import { TASK_FIELD_ON_RERUN } from '../src/session/store.js';
import type { Actor } from '../src/session/model.js';
import type { Step } from '../src/protocol/replySchema.js';
import { actorLabel, fmtClock, isWorking, liveText, tabTitle, ACTOR_INFO, ACTOR_NAME } from '../web/lib/actors.js';
import { en } from '../web/lib/lang/en.js';
import type { Activity } from '../web/lib/api.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const ACTORS: Actor[] = ['plan', 'lead', 'worker', 'review'];
const say = (key: string, vars?: Record<string, string | number>): string =>
  (en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));

console.log('--- who a conversation is, before its first message ---');
{
  const none = {};
  t.check('the worker of two chats', actorOfSession({ workerOf: 's-lead' }, none), 'worker');
  t.check('the lead of two chats', actorOfSession({ lead: {} }, none), 'lead');
  t.check('the worker of two chats even with plan mode on: the lead plans', actorOfSession({ workerOf: 's-lead', planMode: 'approve' }, none), 'worker');
  t.check('a chat in plan mode plans first', actorOfSession({ planMode: 'approve' }, none), 'plan');
  t.check('plan mode from Settings when the session says nothing', actorOfSession({}, { execution: { planMode: 'auto' } }), 'plan');
  t.check("the session's own \"off\" over Settings' plan mode", actorOfSession({ planMode: 'off' }, { execution: { planMode: 'auto' } }), 'worker');
  t.check('else the chat that does the work', actorOfSession({}, none), 'worker');
  t.check('every actor has words in the transcript', ACTORS.map((a) => typeof ACTOR_WORDS[a] === 'string' && ACTOR_WORDS[a].length > 3), [true, true, true, true]);
}

console.log('\n--- the authorizer hands the asker whose step it is ---');
{
  const seen: Array<AuthorizeContext['actor']> = [];
  const auth = makeAuthorizer({ mode: 'confirm', denyPatterns: [], allowedPrograms: [], isolation: 'none-accepted' }, async (_step, ctx) => {
    seen.push(ctx.actor);
    return { action: 'run' };
  });
  const step = { id: 1, cmd: 'Get-ChildItem -Name', shell: 'pwsh' } as Step;
  for (const actor of ['plan', 'worker', 'review'] as const) await auth.authorize(step, { iteration: 1, actor });
  await auth.authorize(step, { iteration: 1 });
  t.check("each step's card is told whose it is (plan, worker, reviewer), and an older caller none", seen, ['plan', 'worker', 'review', undefined]);
}

console.log('\n--- a new attempt does not inherit who was at work ---');
t.check('`acting` belongs to the attempt that ended and is cleared on the next', TASK_FIELD_ON_RERUN.acting, 'cleared');

console.log("\n--- the words: the actor's name, the LIVE mark, the tab's title ---");
{
  t.check('each actor has a name and a sentence of what it does', ACTORS.map((a) => [!!en[ACTOR_NAME[a]], (en[ACTOR_INFO[a]] ?? '').length > 30]), ACTORS.map(() => [true, true]));
  t.check('the names, in English', ACTORS.map((a) => actorLabel(say, a)), ['Plan mode', 'Lead', 'Worker', 'Reviewer']);
  t.check('the worker on a subtask says which', actorLabel(say, 'worker', { subtask: 3 }), 'Worker · subtask 3');
  t.check("the reviewer says the review's round", actorLabel(say, 'review', { round: 2 }), 'Reviewer · round 2');

  const working = (extra: Partial<Activity> = {}): Activity => ({ running: true, sessions: 1, starting: false, ...extra });
  const idle: Activity = { running: false, sessions: 0, starting: false };
  t.check('at work: a run going, or one being started — not idle, nor no answer', [isWorking(working()), isWorking({ ...idle, starting: true }), isWorking(idle), isWorking(null)], [true, true, false, false]);
  t.check('LIVE says who is at work', liveText(say, working({ acting: { actor: 'review', since: '', round: 1 } })), 'The bot is working — Reviewer · round 1');
  t.check('or that it works, when nobody is named yet', liveText(say, working()), 'The bot is working');
  t.check('or that it is paused', liveText(say, working({ paused: true, acting: { actor: 'worker', since: '' } })), 'The bot is paused');

  t.check('the tab: idle is the name alone', tabTitle(say, 0, idle), 'copilot-operator');
  t.check('the tab: who is at work', tabTitle(say, 0, working({ acting: { actor: 'lead', since: '' } })), '● Lead at work — copilot-operator');
  t.check('the tab: the worker on its subtask', tabTitle(say, 0, working({ acting: { actor: 'worker', since: '', subtask: 2 } })), '● Worker · subtask 2 at work — copilot-operator');
  t.check('the tab: at work, nobody named yet', tabTitle(say, 0, working()), '● working — copilot-operator');
  t.check('the tab: paused', tabTitle(say, 0, working({ paused: true })), '● paused — copilot-operator');
  t.check('the tab: what waits for the operator comes first', tabTitle(say, 2, working({ acting: { actor: 'plan', since: '' } })), '(2) waiting for you — copilot-operator');
}

console.log("\n--- the short time on the operator's own messages ---");
{
  const now = new Date(2026, 9, 22, 18, 0);
  t.check('today: the hour and minute', fmtClock(new Date(2026, 9, 22, 9, 5).toISOString(), 'en-GB', now), '09:05');
  t.check('another day: with the day', fmtClock(new Date(2026, 9, 21, 9, 5).toISOString(), 'en-GB', now), '21 Oct 09:05');
  t.check('no time, nothing', fmtClock(undefined, 'en-GB', now), '');
}

/*
 * The operator's own messages are filled (2026-10-23: "easy to notice — another colour if need be"): their white text
 * reads on the fill, and the fill stands out of the panel it sits on, in both themes, by WCAG's contrast.
 */
console.log("\n--- the operator's messages stand out, and read ---");
{
  const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web', 'app', 'globals.css'), 'utf8');
  const block = (selector: string): string => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  const token = (b: string, name: string): string => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(b)?.[1] ?? '';
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  for (const [theme, selector] of [['light', ':root'], ['dark', ":root[data-theme='dark']"]] as const) {
    const b = block(selector);
    const [fill, ink, soft, panel] = [token(b, 'you-bg'), token(b, 'you-ink'), token(b, 'you-soft'), token(b, 'panel')];
    t.truthy(`${theme}: its text reads on the fill (≥ 4.5)`, contrast(ink, fill) >= 4.5, `${ink} on ${fill}: ${contrast(ink, fill).toFixed(2)}`);
    t.truthy(`${theme}: and so does its heading (≥ 4.5)`, contrast(soft, fill) >= 4.5, `${soft} on ${fill}: ${contrast(soft, fill).toFixed(2)}`);
    t.truthy(`${theme}: the fill stands out of the panel (≥ 3)`, contrast(fill, panel) >= 3, `${fill} on ${panel}: ${contrast(fill, panel).toFixed(2)}`);
  }
}

t.finish();
