/**
 * A session with no model of its own follows the one chosen in Settings, and the import page keeps
 * named personas.
 *
 * Both asked for on 2026-09-28. The models used to be copied onto a session when it was created, so
 * a model chosen in Settings after an import reached none of the sessions that import had made; the
 * session showed "whatever the chat is set to" and ran on it. Now the session keeps only a model it
 * was given — by the plan or in its own picker — and otherwise uses Settings at the time it runs.
 *
 *   npm run check:models
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorService } from '../src/api/operator.service.js';
import { effectiveModels } from '../src/orchestrator/taskRunner.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log('--- which model a session runs on ---');
{
  /*
   * The order since 0.1.33 (operator's rule, 2026-10-06; see test/settings-precedence.check.ts): the
   * operator's own choice on the session's page or the run panel, then Settings, then the plan's. A model
   * whose origin is not recorded — a session from before the rule — counts as the plan's.
   */
  const settings = { copilot: { defaultModel: 'GPT 5.6 Think deeper', defaultReviewModel: 'Think deeper' } } as never;
  check('none of its own: Settings', effectiveModels({ model: undefined, review: undefined } as never, settings), {
    model: 'GPT 5.6 Think deeper',
    reviewModel: 'Think deeper',
    modelFrom: 'settings',
    reviewModelFrom: 'settings',
  });
  check(
    "the operator's own choice wins",
    effectiveModels({ model: 'Quick response', modelSource: 'operator', review: { enabled: true, model: 'Auto' }, reviewModelSource: 'operator' } as never, settings),
    { model: 'Quick response', reviewModel: 'Auto', modelFrom: 'session', reviewModelFrom: 'session' },
  );
  check(
    "a model of unrecorded origin gives way to Settings, as the plan's does",
    effectiveModels({ model: 'Quick response', review: { enabled: true, model: 'Auto' } } as never, settings),
    { model: 'GPT 5.6 Think deeper', reviewModel: 'Think deeper', modelFrom: 'settings', reviewModelFrom: 'settings' },
  );
  check('nothing anywhere: nothing', effectiveModels({ model: '' } as never, { copilot: {} } as never), { model: '', reviewModel: '', modelFrom: 'none', reviewModelFrom: 'none' });
}

const data = await mkdtemp(join(tmpdir(), 'cop-models-'));
process.env.COP_DATA_DIR = data;
try {
  const ops = new OperatorService();
  await ops.store.init();

  console.log('\n--- a model chosen in Settings after the session was made still reaches it ---');
  const s = await ops.createSession('made-first');
  check('a new session keeps no model of its own', s.model ?? null, null);
  await ops.setDefaultModel('GPT 5.6 Think deeper');
  const cfg = await ops.settings.load();
  const again = await ops.store.getSession(s.id);
  check('and so runs on the one chosen afterwards', effectiveModels(again!, cfg).model, 'GPT 5.6 Think deeper');

  console.log('\n--- named personas ---');
  const saved = await ops.savePersona('playwright тестове', '{"approach":"write the spec first"}');
  check('saved under its name, Cyrillic kept', saved.name, 'playwright тестове');
  await ops.savePersona('api-service', '{"approach":"contract first"}');
  const list = await ops.listPersonas();
  check('listed by name', list.map((p) => p.name), ['api-service', 'playwright тестове']);
  check('with the content as given', list.find((p) => p.name === 'api-service')?.content, '{"approach":"contract first"}');
  await ops.savePersona('api-service', '{"approach":"v2"}');
  check('saving under the same name replaces it', (await ops.listPersonas()).find((p) => p.name === 'api-service')?.content, '{"approach":"v2"}');
  await ops.deletePersona('api-service');
  check('and deleting removes only that one', (await ops.listPersonas()).map((p) => p.name), ['playwright тестове']);
  let refused = false;
  try {
    await ops.deletePersona('..\\..\\settings');
  } catch {
    refused = true;
  }
  check('a name that climbs out is refused', refused, true);
  check('the box itself was never touched', (await ops.getContext('persona', 'en')).customised, false);
} finally {
  await rm(data, { recursive: true, force: true });
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
