/**
 * The HTTP surface. Thin on purpose: every route hands straight to the service.
 *
 * Bound to localhost only (see main.ts). There is no authentication because there is no
 * network: this API runs on the operator's own machine and drives that machine's browser.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, Sse, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { OperatorService } from './operator.service.js';
import type { TaskCheck } from '../session/model.js';

type Msg = { data: string; type?: string; id?: string };

function fail(e: unknown): never {
  throw new BadRequestException((e as Error).message);
}

/**
 * A `content-disposition` header a session name cannot break.
 *
 * Header values are ASCII. A session called "тест4" produced a file name with Cyrillic in it,
 * and Node refused to send the header at all, so the download failed with an error that said
 * nothing about names. The fix is the standard pair: an ASCII fallback for anything old, and
 * `filename*` with the real name percent-encoded for every current browser.
 */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

@Controller()
export class OperatorController {
  constructor(private readonly ops: OperatorService) {}

  @Get('health')
  health(): { ok: true; time: string } {
    return { ok: true, time: new Date().toISOString() };
  }

  @Get('doctor')
  doctor(): Promise<Record<string, unknown>> {
    return this.ops.doctor();
  }

  // --- settings ---------------------------------------------------------------------------

  @Get('settings')
  async settings(): Promise<{ raw: Record<string, unknown>; defaults: unknown; resolved: unknown }> {
    const [raw, defaults, resolved] = await Promise.all([this.ops.settings.raw(), this.ops.settings.defaults(), this.ops.settings.load()]);
    return { raw, defaults, resolved: resolved.resolved };
  }

  @Put('settings')
  async saveSettings(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    await this.ops.settings.save(body).catch(fail);
    return { ok: true };
  }

  // --- level 1 ----------------------------------------------------------------------------

  @Get('level1')
  level1(): Promise<{ content: string; customised: boolean }> {
    return this.ops.getLevel1();
  }

  @Put('level1')
  async setLevel1(@Body() body: { content: string }): Promise<{ ok: true }> {
    if (typeof body?.content !== 'string' || body.content.trim().length < 100) {
      throw new BadRequestException('Level 1 must be a real contract, not a few words.');
    }
    await this.ops.setLevel1(body.content);
    return { ok: true };
  }

  @Delete('level1')
  resetLevel1(): Promise<{ content: string; customised: boolean }> {
    return this.ops.resetLevel1();
  }

  // --- level 2 presets --------------------------------------------------------------------

  @Get('presets')
  presets(): Promise<unknown> {
    return this.ops.listPresets();
  }

  @Put('presets/:name')
  savePreset(@Param('name') name: string, @Body() body: { content: string }): Promise<unknown> {
    return this.ops.savePreset(name, body?.content ?? '').catch(fail);
  }

  @Delete('presets/:name')
  async deletePreset(@Param('name') name: string): Promise<{ ok: true }> {
    await this.ops.deletePreset(name);
    return { ok: true };
  }

  // --- sessions ---------------------------------------------------------------------------

  @Get('sessions')
  sessions(): Promise<unknown> {
    return this.ops.listSessions();
  }

  @Post('sessions')
  createSession(@Body() body: { name: string; mirror?: Record<string, unknown> }): Promise<unknown> {
    return this.ops.createSession(body?.name ?? '', body?.mirror as never).catch(fail);
  }

  @Get('sessions/:id')
  async session(@Param('id') id: string): Promise<unknown> {
    const s = await this.ops.getSession(id);
    if (!s) throw new NotFoundException();
    return s;
  }

  /** Name, model, queue behaviour, files, version control and the independent review. */
  @Put('sessions/:id')
  updateSession(@Param('id') id: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.ops.updateSession(id, body as never).catch(fail);
  }

  @Delete('sessions/:id')
  async deleteSession(@Param('id') id: string): Promise<{ ok: true }> {
    await this.ops.deleteSession(id).catch(fail);
    return { ok: true };
  }

  @Post('sessions/:id/tasks')
  addTask(@Param('id') id: string, @Body() body: { title?: string; level2?: string; prompt: string }): Promise<unknown> {
    return this.ops.addTask(id, { title: body?.title ?? '', level2: body?.level2 ?? '', prompt: body?.prompt ?? '' }).catch(fail);
  }

  @Put('sessions/:id/tasks/:taskId')
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: { title?: string; level2?: string; prompt?: string; vcsPlan?: { branch?: string; commitMessage?: string }; checks?: TaskCheck[] },
  ): Promise<unknown> {
    return this.ops.updateTask(id, taskId, body).catch(fail);
  }

  @Delete('sessions/:id/tasks/:taskId')
  async deleteTask(@Param('id') id: string, @Param('taskId') taskId: string): Promise<{ ok: true }> {
    await this.ops.deleteTask(id, taskId).catch(fail);
    return { ok: true };
  }

  /**
   * Puts a finished task back in the queue, keeping the earlier attempt on the record.
   *
   * A body with `title`, `prompt` or `level2` edits the task on the way: the attempt that
   * already ran keeps the text it ran with, and the next one uses the new text.
   */
  @Post('sessions/:id/tasks/:taskId/rerun')
  rerunTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body?: { title?: string; level2?: string; prompt?: string; vcsPlan?: { branch?: string; commitMessage?: string }; checks?: TaskCheck[] },
  ): Promise<unknown> {
    return this.ops.rerunTask(id, taskId, body ?? {}).catch(fail);
  }

  /** What going back to before this task would do. Changes nothing. */
  @Get('sessions/:id/tasks/:taskId/restore')
  restorePreview(@Param('id') id: string, @Param('taskId') taskId: string): Promise<unknown> {
    return this.ops.restorePreview(id, taskId).catch(fail);
  }

  /** Does it: a new branch at the commit that task started from, checked out. */
  @Post('sessions/:id/tasks/:taskId/restore')
  restore(@Param('id') id: string, @Param('taskId') taskId: string): Promise<unknown> {
    return this.ops.restore(id, taskId).catch(fail);
  }

  /** What starting the run again from this task would re-queue, and do to the code. */
  @Get('sessions/:id/tasks/:taskId/restart')
  restartPlan(@Param('id') id: string, @Param('taskId') taskId: string): Promise<unknown> {
    return this.ops.restartPlan(id, taskId).catch(fail);
  }

  /** Restores the code, queues this task and everything after it, and starts the run again. */
  @Post('sessions/:id/tasks/:taskId/restart')
  restartFrom(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: { restore?: boolean; start?: boolean; mode?: 'confirm' | 'unattended'; onFailure?: 'stop' | 'continue' },
  ): Promise<unknown> {
    return this.ops.restartFrom(id, taskId, body ?? {}).catch(fail);
  }

  @Get('sessions/:id/tasks/:taskId/log')
  async taskLog(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Res() res: Response,
    @Query('run') run?: string,
  ): Promise<void> {
    const text = await this.ops.taskLog(id, taskId, run);
    if (text === null) {
      res.status(404).send('no log yet');
      return;
    }
    res.type('text/plain; charset=utf-8').send(text);
  }

  @Get('sessions/:id/tasks/:taskId/files')
  taskFiles(@Param('id') id: string, @Param('taskId') taskId: string, @Query('run') run?: string): Promise<unknown> {
    return this.ops.taskFiles(id, taskId, run);
  }

  @Get('sessions/:id/tasks/:taskId/files/:kind/:name')
  async taskFile(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Param('kind') kind: 'reports' | 'artifacts' | 'replies',
    @Param('name') name: string,
    @Res() res: Response,
    @Query('run') run?: string,
  ): Promise<void> {
    if (!['reports', 'artifacts', 'replies'].includes(kind)) {
      res.status(400).send('bad kind');
      return;
    }
    const text = await this.ops.taskFile(id, taskId, kind, name, run);
    if (text === null) {
      res.status(404).send('not found');
      return;
    }
    res.type('text/plain; charset=utf-8').send(text);
  }

  /**
   * Downloads the record of selected tasks.
   *
   * `tasks` is a comma-separated list of task ids, or absent for every task that has run.
   * `variant` is `full` for the whole conversation, or `outcome` for the first and the last
   * message only, which is the expected-and-actual pair.
   */
  @Get('sessions/:id/export')
  async exportTasks(
    @Param('id') id: string,
    @Res() res: Response,
    @Query('tasks') tasks?: string,
    @Query('variant') variant?: string,
  ): Promise<void> {
    const ids = (tasks ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const kind = variant === 'full' ? 'full' : 'outcome';
    try {
      const { fileName, content } = await this.ops.exportTasks(id, ids, kind);
      res.type('text/plain; charset=utf-8');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  }

  /**
   * Everything that happened across several sessions, as one JSON file.
   *
   * `sessions` is a comma-separated list of ids; leaving it out means the sessions of the last
   * batch. Meant for handing to somebody — or something — that has to work out why a run went
   * the way it did.
   */
  @Get('debug/export')
  async debugExport(@Res() res: Response, @Query('sessions') sessions?: string): Promise<void> {
    const ids = (sessions ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const { fileName, content } = await this.ops.debugExport(ids);
      res.type('application/json; charset=utf-8');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  }

  // --- run control ------------------------------------------------------------------------

  @Post('sessions/:id/start')
  start(@Param('id') id: string, @Body() body: { mode?: 'confirm' | 'unattended' }): Promise<unknown> {
    return this.ops.start(id, body?.mode === 'unattended' ? 'unattended' : 'confirm');
  }

  @Post('sessions/:id/stop')
  stop(@Param('id') id: string): Promise<unknown> {
    return this.ops.stop(id);
  }

  // --- running several sessions in turn ------------------------------------------------------

  /** The batch in progress, or the last one that ran. Null when none ever has. */
  @Get('batch')
  batch(): unknown {
    return this.ops.batchState();
  }

  /**
   * Runs the queued tasks of several sessions, one after another, in the order given.
   *
   * `onFailure` is about the sessions, not the tasks inside them: `stop` gives up on the rest
   * once a session fails, `continue` works through all of them.
   */
  @Post('batch/start')
  startBatch(
    @Body()
    body: {
      sessionIds?: string[];
      mode?: 'confirm' | 'unattended';
      onFailure?: 'stop' | 'continue';
      model?: string;
      /** The model the independent review runs on, for every session in this run. */
      reviewModel?: string;
    },
  ): Promise<unknown> {
    if (!Array.isArray(body?.sessionIds)) throw new BadRequestException('sessionIds must be a list of session ids');
    return this.ops
      .startBatch(
        body.sessionIds,
        body?.mode === 'unattended' ? 'unattended' : 'confirm',
        body?.onFailure === 'continue' ? 'continue' : 'stop',
        // Absent or empty means every session keeps the model it already has, which is not the
        // same as "no model": an empty string on a session means "leave the chat alone".
        body?.model,
        // The same for the review: absent means each session keeps whatever it is set to.
        body?.reviewModel,
      )
      .catch(fail);
  }

  @Post('batch/stop')
  stopBatch(): Promise<unknown> {
    return this.ops.stopBatch();
  }

  // --- plans ---------------------------------------------------------------------------------

  /**
   * The text the operator pastes into a chat model to have a plan written.
   *
   * One text per language and nothing else to choose. It used to be assembled from answers
   * given on the import page — version control on or off, which folder — and those are now
   * questions the brief tells the model to ask, because the model is the one in the
   * conversation and the answers belong to a session rather than to the whole document.
   */
  @Get('plan/brief')
  async planBrief(@Query('lang') lang?: string): Promise<{ text: string }> {
    return { text: await this.ops.planBrief({ lang: lang ?? 'en' }) };
  }

  /** Checks a pasted plan without importing anything, and says what it would duplicate. */
  @Post('plan/check')
  checkPlan(@Body() body: { text?: string }): Promise<unknown> {
    return this.ops.checkPlan(body?.text ?? '').catch(fail);
  }

  /**
   * Creates the sessions and tasks a plan describes, and starts nothing.
   *
   * A plan that does not validate comes back as 200 with `ok: false` rather than as an error,
   * because the list of what is wrong is the useful part of that answer and the UI shows it
   * to the operator to hand back to the chat.
   */
  @Post('plan/import')
  importPlan(@Body() body: { text?: string }): Promise<unknown> {
    return this.ops.importPlan(body?.text ?? '').catch(fail);
  }

  @Get('sessions/:id/events')
  events(@Param('id') id: string): unknown {
    return this.ops.recentEvents(id);
  }

  /** Live events as server-sent events. The browser's EventSource reconnects on its own. */
  @Sse('sessions/:id/stream')
  stream(@Param('id') id: string): Observable<Msg> {
    return new Observable<Msg>((subscriber) => {
      for (const e of this.ops.recentEvents(id)) subscriber.next({ data: JSON.stringify(e) });
      const off = this.ops.subscribe(id, (e) => subscriber.next({ data: JSON.stringify(e) }));
      const keepAlive = setInterval(() => subscriber.next({ data: JSON.stringify({ type: 'ping', at: new Date().toISOString() }) }), 25_000);
      return () => {
        off();
        clearInterval(keepAlive);
      };
    });
  }

  // --- approvals --------------------------------------------------------------------------

  @Get('approvals')
  approvals(@Query('session') session?: string): unknown {
    return this.ops.pendingApprovals(session);
  }

  @Post('approvals/:id')
  decide(@Param('id') id: string, @Body() body: { action: 'run' | 'skip' | 'abort' | 'run-all' }): unknown {
    if (!['run', 'skip', 'abort', 'run-all'].includes(body?.action)) {
      throw new BadRequestException('action must be run, run-all, skip or abort');
    }
    return this.ops.decide(id, body.action);
  }

  /** Turns asking on or off in the middle of a run. */
  @Post('sessions/:id/mode')
  setMode(@Param('id') id: string, @Body() body: { mode?: 'confirm' | 'unattended' }): unknown {
    if (body?.mode !== 'confirm' && body?.mode !== 'unattended') {
      throw new BadRequestException('mode must be confirm or unattended');
    }
    return this.ops.setRunMode(id, body.mode);
  }

  /**
   * Is anything running? Answered from memory, so it is safe to ask from every page.
   */
  @Get('activity')
  activity(): unknown {
    return this.ops.activity();
  }

  // --- the project being worked on -----------------------------------------------------------

  /** The folder new sessions start pointed at, and whether it can carry version control. */
  @Get('project')
  project(): Promise<unknown> {
    return this.ops.project();
  }

  /** Stores it. A field left out is kept; an empty `rootDir` clears the default. */
  @Put('project')
  setProject(@Body() body: { rootDir?: string; others?: Array<{ name: string; rootDir: string }> }): Promise<unknown> {
    return this.ops.setProject({ rootDir: body?.rootDir, others: body?.others }).catch(fail);
  }

  /**
   * Whether a folder can be used for version control at all, asked before the choice is made.
   *
   * Separate from the session's own preflight because that one only speaks when version
   * control is already on, and the question here is whether it may be turned on.
   */
  @Get('repo')
  repo(@Query('dir') dir?: string): { ok: boolean; problem?: string } {
    const problem = this.ops.repoProblem(dir ?? '');
    return problem ? { ok: false, problem } : { ok: true };
  }

  /** Can version control do its job in this session right now? */
  @Get('sessions/:id/vcs')
  vcsStatus(@Param('id') id: string): Promise<unknown> {
    return this.ops.vcsStatus(id).catch(fail);
  }

  // --- the model picker ---------------------------------------------------------------------

  /** The cached list. Returns null when the picker has never been read on this machine. */
  @Get('models')
  models(): Promise<unknown> {
    return this.ops.models();
  }

  /**
   * Re-reads the picker from the live chat. Slow on purpose: it opens the browser with the
   * bot profile, so it cannot run while a session is running.
   */
  @Post('models/refresh')
  refreshModels(): Promise<unknown> {
    return this.ops.refreshModels().catch(fail);
  }

  /** The model new sessions start on. An empty name means "leave the chat alone". */
  @Put('models/default')
  setDefaultModel(@Body() body: { model?: string }): Promise<unknown> {
    return this.ops.setDefaultModel(body?.model ?? '').catch(fail);
  }

  /** The model a new session's independent review runs on. An empty name means "the session's own". */
  @Put('models/review-default')
  setDefaultReviewModel(@Body() body: { model?: string }): Promise<unknown> {
    return this.ops.setDefaultReviewModel(body?.model ?? '').catch(fail);
  }

  // --- the registry of every task -----------------------------------------------------------

  @Get('tasks')
  tasks(): Promise<unknown> {
    return this.ops.taskRegistry();
  }

  // --- helpers for the UI -----------------------------------------------------------------

  @Get('dirs')
  dirs(@Query('root') root: string, @Query('gitignore') gitignore?: string): Promise<string[]> {
    if (!root) throw new BadRequestException('root is required');
    return this.ops.dirs(root, gitignore !== '0' && gitignore !== 'false');
  }

  /**
   * Opens the machine's own folder dialog. A POST because it has a visible effect: a window
   * appears on the operator's desktop and waits for them.
   */
  @Post('browse-folder')
  browseFolder(@Body() body: { start?: string }): Promise<unknown> {
    return this.ops.browseFolder(body?.start);
  }

  @Post('mirror/preview')
  preview(@Body() body: { rootDir?: string; includeDirs?: string[]; excludeDirs?: string[]; respectGitignore?: boolean; includeEnvFiles?: boolean }): Promise<unknown> {
    if (!body?.rootDir?.trim()) throw new BadRequestException('rootDir is required');
    return this.ops
      .previewMirror({
        rootDir: body.rootDir.trim(),
        includeDirs: body.includeDirs ?? [],
        excludeDirs: body.excludeDirs ?? [],
        respectGitignore: body.respectGitignore ?? true,
        includeEnvFiles: body.includeEnvFiles ?? false,
      })
      .catch(fail);
  }
}
