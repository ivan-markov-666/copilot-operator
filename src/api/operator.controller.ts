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

type Msg = { data: string; type?: string; id?: string };

function fail(e: unknown): never {
  throw new BadRequestException((e as Error).message);
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
  updateTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() body: Record<string, string>): Promise<unknown> {
    return this.ops.updateTask(id, taskId, body).catch(fail);
  }

  @Delete('sessions/:id/tasks/:taskId')
  async deleteTask(@Param('id') id: string, @Param('taskId') taskId: string): Promise<{ ok: true }> {
    await this.ops.deleteTask(id, taskId).catch(fail);
    return { ok: true };
  }

  @Get('sessions/:id/tasks/:taskId/log')
  async taskLog(@Param('id') id: string, @Param('taskId') taskId: string, @Res() res: Response): Promise<void> {
    const text = await this.ops.taskLog(id, taskId);
    if (text === null) {
      res.status(404).send('no log yet');
      return;
    }
    res.type('text/plain; charset=utf-8').send(text);
  }

  @Get('sessions/:id/tasks/:taskId/files')
  taskFiles(@Param('id') id: string, @Param('taskId') taskId: string): Promise<unknown> {
    return this.ops.taskFiles(id, taskId);
  }

  @Get('sessions/:id/tasks/:taskId/files/:kind/:name')
  async taskFile(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Param('kind') kind: 'reports' | 'artifacts' | 'replies',
    @Param('name') name: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!['reports', 'artifacts', 'replies'].includes(kind)) {
      res.status(400).send('bad kind');
      return;
    }
    const text = await this.ops.taskFile(id, taskId, kind, name);
    if (text === null) {
      res.status(404).send('not found');
      return;
    }
    res.type('text/plain; charset=utf-8').send(text);
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
  decide(@Param('id') id: string, @Body() body: { action: 'run' | 'skip' | 'abort' }): unknown {
    if (!['run', 'skip', 'abort'].includes(body?.action)) throw new BadRequestException('action must be run, skip or abort');
    return this.ops.decide(id, body.action);
  }

  // --- helpers for the UI -----------------------------------------------------------------

  @Get('dirs')
  dirs(@Query('root') root: string): Promise<string[]> {
    if (!root) throw new BadRequestException('root is required');
    return this.ops.dirs(root);
  }
}
