/**
 * Starts the API on localhost.
 *
 *   node dist/src/api/main.js
 *
 * Only 127.0.0.1 is bound, because this process drives the operator's own browser and runs
 * commands on this machine. Exposing it on a network interface would hand that to anyone who
 * could reach the port.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { OperatorService } from './operator.service.js';
import { ensureApiToken, localApiGuard } from './security.js';
import { botRootDir } from '../exec/workDir.js';
import { secureDataDir } from './dataAcl.js';
import { pruneRuns } from '../session/retention.js';
import { mkdir } from 'node:fs/promises';

const PORT = Number(process.env.COP_API_PORT ?? 4000);
const WEB_ORIGIN = process.env.COP_WEB_ORIGIN ?? 'http://localhost:3210';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  // A plan pasted from a chat carries every task's text at once, which the 100 KB default
  // refuses with a message about entity size that says nothing about plans.
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({
    origin: [WEB_ORIGIN, WEB_ORIGIN.replace('localhost', '127.0.0.1')],
    /*
     * The one header the page has to be able to read.
     *
     * A browser hands script only a handful of response headers across origins, and
     * `content-disposition` is not among them unless it is named here. The UI is on
     * `localhost:3210` and this is on `127.0.0.1:4000`, so every fetch is cross-origin: without
     * this, a download built from a blob cannot find out what the file is called, and the
     * carefully composed `copilot-operator-bundle-2-tasks-2-sessions-<stamp>.json` arrives as
     * whatever the client guessed. The plain `<a download>` exports never noticed, because the
     * browser reads the header itself for those and never shows it to the page.
     */
    exposedHeaders: ['content-disposition'],
  });
  app.setGlobalPrefix('api');

  /*
   * Who may drive this. Mounted before routing so it covers every route including the SSE stream,
   * and so that no controller has to remember. See `security.ts` for why "it is only on localhost"
   * was never the whole answer — a page in the operator's ordinary browser and any other process
   * on the machine were both callers all along.
   */
  const dataDir = process.env.COP_DATA_DIR ?? join(botRootDir(), 'data');
  // Before the token is read: a token any local account can read guards nothing. See `dataAcl.ts`.
  const acl = secureDataDir(dataDir);
  if (!acl.ok) {
    console.error(`copilot-operator api will not start: ${acl.reason}`);
    process.exit(1);
  }
  const token = await ensureApiToken(dataDir);
  const allowedOrigins = [WEB_ORIGIN, WEB_ORIGIN.replace('localhost', '127.0.0.1')];
  app.use(localApiGuard({ token, port: PORT, allowedOrigins }));

  await app.listen(PORT, '127.0.0.1');

  // Close whatever the previous process left open before anyone can look at it, rather than
  // waiting for the first request to trigger it.
  const ops = app.get(OperatorService);
  await ops.bootstrap();

  /*
   * runs/ holds every step's raw output and, on a failure, a screenshot of the signed-in page —
   * as much the bot's records as data/ is, and until 2026-09-27 left with whatever permissions its
   * parent folder had. Narrowed the same way, and pruned to the configured retention.
   */
  const cfg = await ops.settings.load();
  await mkdir(cfg.resolved.runsDir, { recursive: true });
  const runsAcl = secureDataDir(cfg.resolved.runsDir);
  if (!runsAcl.ok) {
    console.error(`copilot-operator api will not start: ${runsAcl.reason}`);
    process.exit(1);
  }
  for (const [name, dir] of [['data', dataDir], ['runs', cfg.resolved.runsDir]] as Array<[string, string]>) {
    if (/onedrive/i.test(dir) || /^\\\\/.test(dir)) {
      console.warn(`  warning: the ${name} folder (${dir}) is under OneDrive or on a network share; keep the bot's records on a local disk (COP_DATA_DIR, runsDir)`);
    }
  }
  const pruned = await pruneRuns(cfg.resolved.runsDir, cfg.runsRetentionDays);
  if (pruned.length > 0) console.log(`  removed ${pruned.length} run folder(s) older than ${cfg.runsRetentionDays} days (runsRetentionDays)`);

  console.log(`copilot-operator api listening on http://127.0.0.1:${PORT}/api  (web origin ${WEB_ORIGIN})`);
  console.log(`  requests need the token in ${join(dataDir, 'api-token')} — the UI is given it once, by the link \`npm start\` prints`);
}

/*
 * A stray rejection must not end a run.
 *
 * Node's default for an unhandled rejection is to crash, which for this process means killing
 * the browser, the queue and every session still waiting behind it — for a promise nobody was
 * even reading any more. That happened: a losing `Promise.race` branch inside a download
 * rejected when the window closed and took a batch of three sessions with it. The cause is
 * fixed where it was, but the class of fault is not worth dying for, so it is logged loudly and
 * the process carries on. A task that genuinely failed still fails, through its own error path.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection (the run continues):', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (error) => {
  console.error('[api] uncaught exception (the run continues):', error.stack ?? error.message);
});

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
