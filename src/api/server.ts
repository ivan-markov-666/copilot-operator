/**
 * The API server: routes, the guard in front of them, the data folder's permissions, recovery of
 * whatever the previous process left running. See `main.ts` for the process around it.
 */
import 'reflect-metadata';
import { Catch, ConflictException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { OperatorService } from './operator.service.js';
import { SettingsUnusableError } from './settings.js';
import { ensureApiToken, localApiGuard } from './security.js';
import { secureDataDir } from './dataAcl.js';
import { pruneRuns } from '../session/retention.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { installLayout } from '../config/layout.js';

export type StartOptions = {
  /** Defaults to COP_API_PORT, then 4000. */
  port?: number;
  /** Defaults to COP_WEB_ORIGIN, then the dev UI's `http://localhost:3210`. */
  webOrigin?: string;
  /** Leaves out the "listening on" lines, for checks that start and stop a server many times. */
  quiet?: boolean;
  /**
   * The prebuilt interface to serve, when this is not a package install (which finds its own).
   * The browser checks use it to put the page and the API on one origin, the way a package runs.
   * A checkout serves none unless it is named here, whatever is built in its `dist/web`.
   */
  webDir?: string;
};

export type StartedApi = {
  app: NestExpressApplication;
  port: number;
  token: string;
  dataDir: string;
  close: () => Promise<void>;
};

/**
 * A settings file that cannot be used, answered the same way on every route: 409, with the message
 * that names the file and says what to do (see `SettingsUnusableError`).
 *
 * Here, once, because the routes that meet it are most of them: every one whose work reads the
 * settings. Left to the default it was "Internal server error" wherever a route did not wrap its
 * errors, which included the Defaults page, the Project page and the model picker.
 */
@Catch(SettingsUnusableError)
class SettingsUnusableFilter extends BaseExceptionFilter {
  override catch(e: SettingsUnusableError, host: ArgumentsHost): void {
    super.catch(new ConflictException(e.message), host);
  }
}

/**
 * Everything `main` used to do, as a function that returns the running server instead of owning the
 * process. `main.ts` calls it and turns a failure into an exit code; the end-to-end checks call it
 * with a scripted chat in place (see `transport/chatTransport.ts`) and close it when they are done.
 * A refusal to start is thrown rather than ending the process, so a check that trips one is told why.
 */
export async function startApi(opts: StartOptions = {}): Promise<StartedApi> {
  const PORT = opts.port ?? Number(process.env.COP_API_PORT ?? 4000);
  const WEB_ORIGIN = opts.webOrigin ?? process.env.COP_WEB_ORIGIN ?? 'http://localhost:3210';
  const log = opts.quiet ? (): void => undefined : (line: string): void => console.log(line);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: opts.quiet ? ['error', 'warn'] : ['error', 'warn', 'log'] });
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
  app.useGlobalFilters(new SettingsUnusableFilter(app.getHttpAdapter()));

  /*
   * Who may drive this. Mounted before routing so it covers every route including the SSE stream,
   * and so that no controller has to remember. See `security.ts` for why "it is only on localhost"
   * was never the whole answer — a page in the operator's ordinary browser and any other process
   * on the machine were both callers all along.
   */
  const layout = installLayout();
  const dataDir = layout.dataDir;
  const webDir = opts.webDir ?? layout.webDir;
  await mkdir(dataDir, { recursive: true });
  if (layout.mode === 'package') {
    /*
     * The records folder sits inside the project, so it must be invisible to the project's git:
     * version control refuses to branch on a tree with untracked files, and the records are not
     * the project's work. A `.gitignore` of `*` inside the folder says so without touching the
     * project's own .gitignore.
     */
    const ignore = join(layout.homeDir, '.gitignore');
    if (!existsSync(ignore)) await writeFile(ignore, '*\n', 'utf8');
  }
  // Before the token is read: a token any local account can read guards nothing. See `dataAcl.ts`.
  const acl = secureDataDir(dataDir);
  if (!acl.ok) throw new Error(`copilot-operator api will not start: ${acl.reason}`);
  const token = await ensureApiToken(dataDir);
  // The dev UI's origin, and this process's own for the interface it serves itself.
  const allowedOrigins = [WEB_ORIGIN, WEB_ORIGIN.replace('localhost', '127.0.0.1'), `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  app.use(localApiGuard({ token, port: PORT, allowedOrigins, servesInterface: webDir !== null }));
  if (webDir) {
    // The prebuilt interface, from the package: one process, one port, no dev server.
    app.useStaticAssets(webDir, { extensions: ['html'], index: 'index.html' });
  }

  /*
   * The settings, read before the port is open and before anything the last process left is
   * recovered. A file the API cannot use stops it here, with the reason; read after the recovery,
   * it stopped the API once the tasks were already marked aborted but not yet settled (their record
   * goes in the runs folder the file names), and nothing comes back to settle them.
   */
  const ops = app.get(OperatorService);
  const cfg = await ops.settings.load().catch(async (e: unknown) => {
    await app.close();
    throw e;
  });

  await app.listen(PORT, '127.0.0.1');

  // Close whatever the previous process left open before anyone can look at it, rather than
  // waiting for the first request to trigger it.
  await ops.bootstrap();

  /*
   * runs/ holds every step's raw output and, on a failure, a screenshot of the signed-in page —
   * as much the bot's records as data/ is, and until 2026-09-27 left with whatever permissions its
   * parent folder had. Narrowed the same way, and pruned to the configured retention.
   */
  await mkdir(cfg.resolved.runsDir, { recursive: true });
  const runsAcl = secureDataDir(cfg.resolved.runsDir);
  if (!runsAcl.ok) {
    await app.close();
    throw new Error(`copilot-operator api will not start: ${runsAcl.reason}`);
  }
  for (const [name, dir] of [['data', dataDir], ['runs', cfg.resolved.runsDir]] as Array<[string, string]>) {
    if (/onedrive/i.test(dir) || /^\\\\/.test(dir)) {
      console.warn(`  warning: the ${name} folder (${dir}) is under OneDrive or on a network share; keep the bot's records on a local disk (COP_DATA_DIR, runsDir)`);
    }
  }
  const pruned = await pruneRuns(cfg.resolved.runsDir, cfg.runsRetentionDays);
  if (pruned.length > 0) log(`  removed ${pruned.length} run folder(s) older than ${cfg.runsRetentionDays} days (runsRetentionDays)`);

  // Said by what is served, not by what the layout found, so the lines match the guard's choice above.
  if (webDir) {
    log(`copilot-operator is running for ${layout.projectRoot}`);
    log(`  open http://127.0.0.1:${PORT}/ in your browser`);
    log(`  records are kept in ${layout.homeDir}`);
  } else {
    log(`copilot-operator api listening on http://127.0.0.1:${PORT}/api  (web origin ${WEB_ORIGIN})`);
    log(`  requests need the token in ${join(dataDir, 'api-token')}; npm start hands it to the UI`);
  }

  return { app, port: PORT, token, dataDir, close: () => app.close() };
}
