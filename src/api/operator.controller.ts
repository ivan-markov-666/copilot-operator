/**
 * The HTTP surface. Thin on purpose: every route hands straight to the service.
 *
 * Bound to localhost only (see main.ts). There is no authentication because there is no
 * network: this API runs on the operator's own machine and drives that machine's browser.
 *
 * What is here is what the chat and its workbench use, with Settings and Kerrigan (2026-10-20: the sessions, the task
 * register and the plan from JSON were removed, and their routes with them).
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Res, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { Response } from 'express';
import { OperatorService } from './operator.service.js';
import { SettingsUnusableError } from './settings.js';
import { PolicyLockUnusableError } from '../config/lockedPolicy.js';
import { CHANGED_ON_DISK } from '../session/workspace.js';
import { join } from 'node:path';
import { DefaultPickerLocators, type PickerLocators } from '../transport/locators.js';
import { platformTools } from '../exec/platforms.js';
import { readOnlyCapable } from '../exec/readOnly.js';

function fail(e: unknown): never {
  // A settings file or a policy lock that cannot be used is not the request's fault, and every route
  // that reads the settings meets it, wrapped here or not: it is passed on as it is, for the server
  // to answer the same way on all of them (see `server.ts`).
  if (e instanceof SettingsUnusableError || e instanceof PolicyLockUnusableError) throw e;
  throw new BadRequestException((e as Error).message);
}

/**
 * `fail` for a route that writes its own response, as the downloads do: the request's own problem
 * as plain text with a 400, and a settings file or a policy lock that cannot be used passed on to
 * the server's answer for it. Each download answered both itself, so a broken file came back as a
 * bad request there and as a 409 everywhere else.
 */
function failText(res: Response, e: unknown): void {
  if (e instanceof SettingsUnusableError || e instanceof PolicyLockUnusableError) throw e;
  res.status(400).send((e as Error).message);
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
  /*
   * Named explicitly rather than read from the parameter's type. Nest normally learns what to inject
   * from the metadata `tsc` emits for a decorated class, and that metadata exists only when the code
   * was compiled by `tsc`: run through tsx or any other esbuild-based loader — which is how every
   * check in test/ runs, including the ones that start this API — the type is gone and `ops` arrived
   * as undefined, so every route failed with a TypeError. With the token named, both ways work.
   */
  constructor(@Inject(OperatorService) private readonly ops: OperatorService) {}

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
  async settings(): Promise<{
    raw: Record<string, unknown>;
    defaults: unknown;
    resolved: unknown;
    picker: { defaults: PickerLocators; dirs: { run: string; read: string } };
    programs: { platforms: Record<string, string>; readOnly: string[]; inForce: string[] };
  }> {
    const [raw, defaults, resolved] = await Promise.all([this.ops.settings.raw(), this.ops.settings.defaults(), this.ops.settings.load()]);
    /*
     * The model menu's locators (2026-10-24): their defaults, which Settings shows and puts back, and where the
     * pictures of a choice are kept — a run's beside its browser's other files, a reading of the list in its own.
     */
    const picker = { defaults: DefaultPickerLocators, dirs: { run: join(resolved.resolved.runsDir, '_browser'), read: join(resolved.resolved.runsDir, '_models') } };
    /*
     * The programs the bot may start (2026-10-26): which of them reach a platform with the operator's access, which can
     * be set to read only, and the list in force, which a policy lock may have narrowed.
     */
    const programs = { platforms: platformTools(), readOnly: readOnlyCapable(), inForce: resolved.execution.allowedPrograms };
    return { raw, defaults, resolved: resolved.resolved, picker, programs };
  }

  @Put('settings')
  async saveSettings(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    await this.ops.settings.save(body).catch(fail);
    return { ok: true };
  }

  // --- level 1 ----------------------------------------------------------------------------

  /** The contract the bot gives Copilot, as it ships: shown in Settings to read, changed only by an update of the bot. */
  @Get('level1')
  level1(): Promise<{ content: string }> {
    return this.ops.getLevel1();
  }

  // --- Kerrigan -------------------------------------------------------------------------------

  /** Kerrigan, the persona to give another chat: what copilot-operator is and how a task is best written for it. */
  @Get('kerrigan')
  kerrigan(@Query('lang') lang?: string, @Query('skill') skill?: string): Promise<unknown> {
    // Any language code of the interface: in one she is not written out in, the page fills in the controls' names.
    const code = typeof lang === 'string' && /^[a-z]{2,3}$/.test(lang) ? lang : 'en';
    // `skill`: the one chosen beside her button, whose instructions go with her text (2026-10-26).
    return this.ops.kerrigan(code, typeof skill === 'string' && skill.trim() ? skill : undefined).catch(fail);
  }

  // --- the chat's conversations (sessions of kind `chat`) -------------------------------------

  @Get('sessions')
  sessions(): Promise<unknown> {
    return this.ops.listSessions();
  }

  @Get('sessions/:id')
  async session(@Param('id') id: string): Promise<unknown> {
    const s = await this.ops.getSession(id);
    if (!s) throw new NotFoundException();
    return s;
  }

  /** The conversation's model, chosen in the chat (and the rest of a session's settings). */
  @Put('sessions/:id')
  updateSession(@Param('id') id: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.ops.updateSession(id, body as never).catch(fail);
  }

  /** The attempt as a story: what was sent, answered, run and how it ended. `run` picks an earlier attempt. */
  @Get('sessions/:id/tasks/:taskId/story')
  async taskStory(@Param('id') id: string, @Param('taskId') taskId: string, @Query('run') run?: string): Promise<unknown> {
    const story = await this.ops.taskStory(id, taskId, run);
    if (!story) throw new NotFoundException('This task has not run yet, or that attempt is not its own.');
    return story;
  }

  /**
   * What a task changed: the files between the commit it started from and the one it produced.
   * `run` picks an earlier attempt. See `taskChanges`.
   */
  @Get('sessions/:id/tasks/:taskId/changes')
  taskChanges(@Param('id') id: string, @Param('taskId') taskId: string, @Query('run') run?: string): Promise<unknown> {
    return this.ops.taskChanges(id, taskId, run?.trim() || undefined).catch(fail);
  }

  /** One of those files, before and after. Only a file the task changed can be asked for. */
  @Get('sessions/:id/tasks/:taskId/changes/file')
  taskChangeFile(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Query('path') path?: string,
    @Query('run') run?: string,
  ): Promise<unknown> {
    if (!path) throw new BadRequestException('path is required');
    return this.ops.taskChangeFile(id, taskId, path, run?.trim() || undefined).catch(fail);
  }

  /** One task's whole exchange with Copilot, as a JSON file (see `taskExchange.ts`). */
  @Get('sessions/:id/tasks/:taskId/exchange')
  async taskExchange(@Param('id') id: string, @Param('taskId') taskId: string, @Res() res: Response): Promise<void> {
    try {
      const { fileName, content } = await this.ops.taskExchange(id, taskId);
      res.type('application/json; charset=utf-8');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      failText(res, e);
    }
  }

  @Get('sessions/:id/events')
  events(@Param('id') id: string): unknown {
    return this.ops.recentEvents(id);
  }

  // --- run control ------------------------------------------------------------------------

  @Post('sessions/:id/start')
  start(@Param('id') id: string, @Body() body: { mode?: 'confirm' | 'unattended' }): Promise<unknown> {
    return this.ops.start(id, body?.mode === 'unattended' ? 'unattended' : 'confirm');
  }

  /** Starts that did not get as far as a first task, newest first; `unanswered=1` only those no press was answered with. */
  @Get('start/failures')
  startFailures(@Query('unanswered') unanswered?: string): unknown {
    return this.ops.recentStartFailures(unanswered === '1' || unanswered === 'true');
  }

  /** One of them as a text file: the error, where it stopped, the run's record, the events and the console. */
  @Get('start/failures/:id/report')
  async startFailureReport(@Param('id') id: string, @Res() res: Response): Promise<void> {
    try {
      const { fileName, content } = await this.ops.startFailureReport(id);
      res.type('text/plain; charset=utf-8');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      failText(res, e);
    }
  }

  /** How much an export of the bot's folder would hold (2026-10-23). */
  @Get('home/export/size')
  exportSize(): unknown {
    return this.ops.exportSizes();
  }

  /** Everything the bot has kept, as a .zip: `data/`, and `runs/` with `?runs=1`. See `config/exportHome.ts`. */
  @Get('home/export')
  exportHome(@Query('runs') runs: string | undefined, @Res() res: Response): void {
    try {
      const { fileName, content } = this.ops.exportHome(runs === '1' || runs === 'true');
      res.type('application/zip');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      failText(res, e);
    }
  }

  /** What the bot's console showed, the latest lines, as a text file. See `log/terminal.ts`. */
  @Get('terminal')
  async terminal(@Res() res: Response): Promise<void> {
    try {
      const { fileName, content } = await this.ops.terminalReport();
      res.type('text/plain; charset=utf-8');
      res.setHeader('content-disposition', contentDisposition(fileName));
      res.send(content);
    } catch (e) {
      failText(res, e);
    }
  }

  @Post('sessions/:id/stop')
  stop(@Param('id') id: string): Promise<unknown> {
    return this.ops.stop(id);
  }

  /** "Pause": the running work holds at its next message or command. */
  @Post('sessions/:id/pause')
  pause(@Param('id') id: string): unknown {
    try {
      return this.ops.pause(id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** "Continue": the paused work goes on. */
  @Post('sessions/:id/resume')
  resume(@Param('id') id: string): unknown {
    return this.ops.resume(id);
  }

  // --- the workspace and its chat ---------------------------------------------------------------

  /** The project folder the workbench has open, its files on disk, and one of them. */
  @Get('workspace')
  workspace(): Promise<unknown> {
    return this.ops.workspace().catch(fail);
  }

  @Get('workspace/files')
  workspaceFiles(): Promise<unknown> {
    return this.ops.workspaceFiles().catch(fail);
  }

  /** The folder's code searched, as VS Code's Search view (2026-10-21): the text, and its options as 1 or nothing. */
  @Get('workspace/search')
  workspaceSearch(
    @Query('q') q?: string,
    @Query('case') matchCase?: string,
    @Query('word') wholeWord?: string,
    @Query('regex') regex?: string,
    @Query('include') include?: string,
    @Query('exclude') exclude?: string,
  ): Promise<unknown> {
    const on = (v?: string): boolean => v === '1' || v === 'true';
    return this.ops.workspaceSearch(q ?? '', { matchCase: on(matchCase), wholeWord: on(wholeWord), regex: on(regex), include: include ?? '', exclude: exclude ?? '' }).catch(fail);
  }

  /** A picture of the folder, for a Markdown preview (2026-10-21). Served so it can only be shown, never run. */
  @Get('workspace/raw')
  async workspaceRaw(@Query('path') path: string | undefined, @Res() res: Response): Promise<void> {
    if (!path) throw new BadRequestException('path is required');
    const r = await this.ops.workspaceRaw(path).catch(fail);
    res.setHeader('Content-Type', r.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'no-store');
    res.end(r.bytes);
  }

  @Get('workspace/file')
  workspaceFile(@Query('path') path?: string): Promise<unknown> {
    if (!path) throw new BadRequestException('path is required');
    return this.ops.workspaceFile(path).catch(fail);
  }

  /**
   * The editor saving a file of the open folder. `base` is the version it was opened at; a file changed on disk since
   * is refused with 409, so the page can offer to read it again or to save over it (by sending no `base`).
   */
  @Put('workspace/file')
  async saveWorkspaceFile(@Body() body: { path?: unknown; text?: unknown; base?: unknown } = {}): Promise<unknown> {
    if (typeof body?.path !== 'string' || !body.path) throw new BadRequestException('path is required');
    if (typeof body.text !== 'string') throw new BadRequestException('text is required');
    try {
      return await this.ops.saveWorkspaceFile(body.path, body.text, typeof body.base === 'string' && body.base ? body.base : undefined);
    } catch (e) {
      if ((e as { code?: string }).code === CHANGED_ON_DISK) throw new ConflictException((e as Error).message);
      fail(e);
    }
  }

  /** The open folder's git: the changes, staged and not, and the branch's commits. Read-only. */
  /**
   * The bot's folder, chosen on the System page (2026-10-22): `dir` a folder, or null for the default; `copy` to copy
   * what is in the folder now. Read at the bot's next start.
   */
  @Put('home')
  setHome(@Body() body: { dir?: unknown; copy?: unknown } = {}): Promise<unknown> {
    if (body.dir !== null && typeof body.dir !== 'string') throw new BadRequestException('dir must be the path of a folder, or null for the default');
    return this.ops.setHome(body.dir === null ? null : (body.dir as string), body.copy === true).catch(fail);
  }

  @Get('workspace/git')
  workspaceGit(): Promise<unknown> {
    return this.ops.workspaceGit().catch(fail);
  }

  /**
   * A new branch from main, from the chat (2026-10-26): what it would start from — `fetch` true fetches the remote's
   * main first, through Git's own password window when it asks — and then the branch made, the uncommitted changes
   * taken to it (`carry: take`) or put aside (`carry: aside`), after checking the folder is what the preview read.
   */
  @Post('workspace/new-branch/preview')
  newBranchPreview(@Body() body: { fetch?: unknown } = {}): Promise<unknown> {
    return this.ops.newBranchPreview(body?.fetch !== false).catch(fail);
  }

  @Post('workspace/new-branch')
  newBranchCreate(@Body() body: { name?: unknown; carry?: unknown; fingerprint?: unknown } = {}): Promise<unknown> {
    return this.ops.newBranchCreate(body ?? {}).catch(fail);
  }

  /** Everything the branch changed against `base` (a branch of the list it gives), as a pull request shows it. Read-only. */
  @Get('workspace/git/branch')
  workspaceBranch(@Query('base') base?: string): Promise<unknown> {
    return this.ops.workspaceBranch(base || undefined).catch(fail);
  }

  /** The two numbers on the Git button: files not committed, and files on this branch against `base`. Read-only. */
  @Get('workspace/git/counts')
  workspaceGitCounts(@Query('base') base?: string): Promise<unknown> {
    return this.ops.workspaceGitCounts(base || undefined).catch(fail);
  }

  @Get('workspace/git/commit')
  workspaceCommit(@Query('sha') sha?: string): Promise<unknown> {
    if (!sha) throw new BadRequestException('sha is required');
    return this.ops.workspaceCommit(sha).catch(fail);
  }

  /** A file of those lists, its two versions: `area` staged, changes, commit (with `commit`) or branch (`commit`: the base). */
  @Get('workspace/git/file')
  workspaceGitFile(@Query('area') area?: string, @Query('path') path?: string, @Query('commit') commit?: string): Promise<unknown> {
    if (!path) throw new BadRequestException('path is required');
    if (area !== 'staged' && area !== 'changes' && area !== 'commit' && area !== 'branch') throw new BadRequestException('area must be staged, changes, commit or branch');
    if (area === 'commit' && !commit) throw new BadRequestException('commit is required');
    return this.ops.workspaceGitFile(area, path, commit).catch(fail);
  }

  /** The chat's conversations, newest first. */
  @Get('chat/threads')
  chatThreads(): Promise<unknown> {
    return this.ops.chatThreads().catch(fail);
  }

  /** A message in the chat: a task of its conversation (made in the open folder if there is none), or a note while it works. */
  @Post('chat')
  chatSend(@Body() body: { text?: unknown; threadId?: unknown; model?: unknown; manualModel?: unknown; lang?: unknown; planMode?: unknown; review?: unknown; reviewModel?: unknown; lead?: unknown; workerModel?: unknown; workerManualModel?: unknown; skill?: unknown } = {}): Promise<unknown> {
    if (typeof body?.text !== 'string' || !body.text.trim()) throw new BadRequestException('text is required');
    return this.ops
      .chatSend({
        text: body.text,
        ...(typeof body.threadId === 'string' && body.threadId ? { threadId: body.threadId } : {}),
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model } : {}),
        ...(body.manualModel === true ? { manualModel: true } : {}),
        // The page's language, any of the interface's (`web/lib/lang/languages.ts`): the window's card says it in it.
        ...(typeof body.lang === 'string' && /^[a-z]{2,3}$/.test(body.lang) ? { lang: body.lang } : {}),
        ...(body.planMode === true ? { planMode: true } : {}),
        ...(typeof body.review === 'boolean' ? { review: body.review } : {}),
        // The review's model, chosen beside the box (2026-10-21); left out, Settings' review model.
        ...(typeof body.reviewModel === 'string' && body.reviewModel.trim() ? { reviewModel: body.reviewModel } : {}),
        // Two chats, for a new conversation: a lead that directs and a worker that carries out (2026-10-20).
        ...(body.lead === true ? { lead: true } : {}),
        ...(typeof body.workerModel === 'string' && body.workerModel.trim() ? { workerModel: body.workerModel } : {}),
        ...(body.workerManualModel === true ? { workerManualModel: true } : {}),
        // The skill chosen for this message (2026-10-21), by its name.
        ...(typeof body.skill === 'string' && body.skill.trim() ? { skill: body.skill } : {}),
      })
      .catch(fail);
  }

  // --- the queue of tasks (2026-10-24) -------------------------------------------------------------------

  /** The tasks prepared to run one after another, each in a new chat, and whether the queue is running. */
  @Get('queue')
  queue(): Promise<unknown> {
    return this.ops.queue().catch(fail);
  }

  /** The list as the page edits it: added, changed, moved, taken out, put back to wait. */
  @Put('queue')
  setQueue(@Body() body: { items?: unknown } = {}): Promise<unknown> {
    return this.ops.setQueue(body?.items).catch(fail);
  }

  @Post('queue/run')
  runQueue(): Promise<unknown> {
    return this.ops.runQueue().catch(fail);
  }

  @Post('queue/stop')
  stopQueue(): Promise<unknown> {
    return this.ops.stopQueue().catch(fail);
  }

  /** The queue's own settings (2026-10-26): how long a task may wait for the operator before it is set aside. */
  @Put('queue/settings')
  setQueueSettings(@Body() body: { parkAfterSec?: unknown } = {}): Promise<unknown> {
    return this.ops.setQueueSettings(body ?? {}).catch(fail);
  }

  /** The operator's answer to a task the queue set aside while it waited (2026-10-26); `{ stop: true }` stops it. */
  @Post('queue/items/:id/answer')
  answerParked(@Param('id') id: string, @Body() body: Record<string, unknown> = {}): Promise<unknown> {
    return this.ops.answerParked(id, body ?? {}).catch(fail);
  }

  /** Back to before a message: the folder as it was then, that message and the ones after it taken out. */
  @Post('chat/:id/rewind')
  async chatRewind(@Param('id') id: string, @Body() body: { taskId?: unknown } = {}): Promise<unknown> {
    if (typeof body?.taskId !== 'string' || !body.taskId) throw new BadRequestException('taskId is required');
    const r = await this.ops.chatRewind(id, body.taskId).catch(fail);
    if (!r.ok) throw new BadRequestException(r.problem);
    return r;
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

  /** A subtask that failed for a technical reason (two chats, 2026-10-25): one of its card's choices. */
  @Post('approvals/:id/retry')
  answerRetry(@Param('id') id: string, @Body() body: { choice?: unknown }): unknown {
    const result = this.ops.answerRetry(id, typeof body?.choice === 'string' ? body.choice : '');
    if (!result.ok) throw new BadRequestException(result.problem);
    return result;
  }

  /** After a Stop (two chats, 2026-10-25): the stopped message carried on with one of its subtasks tried again first. */
  @Post('chat/:id/tasks/:taskId/retry-subtask')
  chatRetrySubtask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() body: { n?: unknown; fresh?: unknown } = {}): Promise<unknown> {
    const n = Number(body?.n);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException('n, the subtask\'s number, is required');
    return this.ops.chatRetrySubtask(id, taskId, n, body?.fresh === true).catch(fail);
  }

  /** The lead's question (two chats): the operator's answer, as text. Stopping the task is `approvals/:id` with abort. */
  @Post('approvals/:id/answer')
  answerQuestion(@Param('id') id: string, @Body() body: { text?: unknown; ran?: unknown }): unknown {
    const result = this.ops.answerQuestion(id, typeof body?.text === 'string' ? body.text : '', body?.ran === false ? false : undefined);
    if (!result.ok) throw new BadRequestException(result.problem);
    return result;
  }

  /** A plan waiting for approval (plan mode): approve it, with a note or not; ask for another; or stop the task. */
  @Post('approvals/:id/plan')
  decidePlan(@Param('id') id: string, @Body() body: { action?: string; note?: unknown }): unknown {
    if (!['approve', 'revise', 'stop'].includes(body?.action ?? '')) throw new BadRequestException('action must be approve, revise or stop');
    const result = this.ops.decidePlan(id, body.action as 'approve', typeof body?.note === 'string' ? body.note : undefined);
    if (!result.ok) throw new BadRequestException(result.problem);
    return result;
  }

  /**
   * Is anything running? Answered from memory, so it is safe to ask from every page.
   */
  @Get('activity')
  activity(): unknown {
    return this.ops.activity();
  }

  // --- the project being worked on -----------------------------------------------------------

  /** The folder the chat works in. */
  @Get('project')
  project(): Promise<unknown> {
    return this.ops.project();
  }

  /** Stores it. A field left out is kept; an empty `rootDir` clears the default. */
  @Put('project')
  setProject(
    @Body()
    body: {
      rootDir?: string;
      name?: string;
      level2?: string;
      readOnly?: boolean;
      others?: Array<{ name: string; rootDir: string; level2?: string; readOnly?: boolean }>;
    },
  ): Promise<unknown> {
    const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    const others = Array.isArray(body?.others)
      ? body.others.map((o) => ({
          name: String(o?.name ?? ''),
          rootDir: String(o?.rootDir ?? ''),
          ...(typeof o?.level2 === 'string' ? { level2: o.level2 } : {}),
          ...(typeof o?.readOnly === 'boolean' ? { readOnly: o.readOnly } : {}),
        }))
      : undefined;
    return this.ops
      .setProject({ rootDir: text(body?.rootDir), name: text(body?.name), level2: text(body?.level2), readOnly: flag(body?.readOnly), ...(others ? { others } : {}) })
      .catch(fail);
  }

  // --- skills (2026-10-21) ---------------------------------------------------------------------

  @Get('skills')
  skills(): Promise<unknown> {
    return this.ops.skills();
  }

  /** The whole list, as Settings show it: each skill's name, what it is for, its instructions and its project. */
  @Put('skills')
  setSkills(@Body() body: { skills?: unknown } = {}): Promise<unknown> {
    if (!Array.isArray(body?.skills)) throw new BadRequestException('skills must be a list');
    return this.ops.setSkills(body.skills as Array<Record<string, unknown>>).catch(fail);
  }

  // --- the model picker ---------------------------------------------------------------------

  /** The cached list. Returns null when the picker has never been read on this machine. */
  @Get('models')
  models(): Promise<unknown> {
    return this.ops.models();
  }

  /** "Sign in" from Settings: opens the bot's Edge and waits for the operator to sign in. See `OperatorService.login`. */
  @Post('login')
  login(@Body() body: { account?: string }): Promise<unknown> {
    return this.ops.login(body?.account).catch(fail);
  }

  /**
   * Re-reads the picker from the live chat. Slow on purpose: it opens the browser with the
   * bot profile, so it cannot run while a session is running.
   */
  @Post('models/refresh')
  refreshModels(): Promise<unknown> {
    return this.ops.refreshModels().catch(fail);
  }

  /** The model a new conversation starts on. An empty name means "leave the chat alone". */
  @Put('models/default')
  setDefaultModel(@Body() body: { model?: string }): Promise<unknown> {
    return this.ops.setDefaultModel(body?.model ?? '').catch(fail);
  }

  /** The model the lead of two chats starts on (2026-10-23). An empty name leaves its chat on whatever it is. */
  @Put('models/lead-default')
  setDefaultLeadModel(@Body() body: { model?: string }): Promise<unknown> {
    return this.ops.setDefaultLeadModel(body?.model ?? '').catch(fail);
  }

  /** The model of the independent review. An empty name means "the session's own". */
  @Put('models/review-default')
  setDefaultReviewModel(@Body() body: { model?: string }): Promise<unknown> {
    return this.ops.setDefaultReviewModel(body?.model ?? '').catch(fail);
  }

  // --- helpers for the UI -----------------------------------------------------------------

  /**
   * Opens the machine's own folder dialog. A POST because it has a visible effect: a window
   * appears on the operator's desktop and waits for them.
   */
  @Post('browse-folder')
  browseFolder(@Body() body: { start?: string }): Promise<unknown> {
    return this.ops.browseFolder(body?.start);
  }
}
