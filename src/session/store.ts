/**
 * Where sessions, level-2 presets and the level-1 contract live on disk.
 *
 * JSON files, not a database. A single operator on one machine gets nothing from a
 * database except a dependency, and files can be read, diffed and backed up with nothing
 * installed. Writes go through a temp file and a rename, so a crash mid-write cannot leave a
 * half-written session behind.
 */
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session, Task, Level2Preset, MirrorSettings } from './model.js';
import { newId } from './model.js';

export const DEFAULT_MIRROR: MirrorSettings = {
  enabled: false,
  rootDir: '',
  includeDirs: [],
  excludeDirs: [],
};

export class SessionStore {
  readonly dir: string;
  private readonly sessionsDir: string;
  private readonly presetsDir: string;
  private readonly level1Path: string;

  constructor(dataDir: string, private readonly defaultLevel1Path: string) {
    this.dir = resolve(dataDir);
    this.sessionsDir = join(this.dir, 'sessions');
    this.presetsDir = join(this.dir, 'level2');
    this.level1Path = join(this.dir, 'level1.md');
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.presetsDir, { recursive: true });
  }

  // --- level 1 --------------------------------------------------------------------------

  /** The contract in force: the user's edited copy if there is one, else the shipped one. */
  async getLevel1(): Promise<{ content: string; customised: boolean }> {
    if (existsSync(this.level1Path)) {
      return { content: await readFile(this.level1Path, 'utf8'), customised: true };
    }
    return { content: await readFile(this.defaultLevel1Path, 'utf8'), customised: false };
  }

  async setLevel1(content: string): Promise<void> {
    await this.atomicWrite(this.level1Path, content);
  }

  async resetLevel1(): Promise<void> {
    await rm(this.level1Path, { force: true });
  }

  // --- level 2 presets ------------------------------------------------------------------

  async listPresets(): Promise<Level2Preset[]> {
    const names = (await readdir(this.presetsDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.md'))
      .sort();
    const out: Level2Preset[] = [];
    for (const n of names) {
      const path = join(this.presetsDir, n);
      const content = await readFile(path, 'utf8');
      const { mtime } = await import('node:fs').then((fs) => fs.statSync(path));
      out.push({ name: n.slice(0, -3), content, updatedAt: mtime.toISOString() });
    }
    return out;
  }

  async savePreset(name: string, content: string): Promise<Level2Preset> {
    const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim();
    if (!safe) throw new Error('Preset name is empty after removing unsafe characters.');
    await this.atomicWrite(join(this.presetsDir, `${safe}.md`), content);
    return { name: safe, content, updatedAt: new Date().toISOString() };
  }

  async deletePreset(name: string): Promise<void> {
    await rm(join(this.presetsDir, `${name}.md`), { force: true });
  }

  // --- sessions -------------------------------------------------------------------------

  async listSessions(): Promise<Session[]> {
    const files = (await readdir(this.sessionsDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse();
    const out: Session[] = [];
    for (const f of files) {
      const s = await this.readSession(join(this.sessionsDir, f));
      if (s) out.push(s);
    }
    return out;
  }

  async getSession(id: string): Promise<Session | null> {
    return await this.readSession(join(this.sessionsDir, `${id}.json`));
  }

  async createSession(name: string, mirror: Partial<MirrorSettings> = {}): Promise<Session> {
    const session: Session = {
      id: newId(),
      name: name.trim() || 'untitled',
      createdAt: new Date().toISOString(),
      status: 'idle',
      contractSent: false,
      mirror: { ...DEFAULT_MIRROR, ...mirror },
      tasks: [],
    };
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: Session): Promise<void> {
    await this.atomicWrite(join(this.sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
  }

  async deleteSession(id: string): Promise<void> {
    await rm(join(this.sessionsDir, `${id}.json`), { force: true });
  }

  /** Applies a change under a fresh read, so two writers cannot clobber each other. */
  async updateSession(id: string, mutate: (s: Session) => void): Promise<Session> {
    const s = await this.getSession(id);
    if (!s) throw new Error(`Session ${id} does not exist.`);
    mutate(s);
    await this.saveSession(s);
    return s;
  }

  async addTask(sessionId: string, input: { title: string; level2: string; prompt: string }): Promise<Task> {
    const task: Task = {
      id: newId('t-'),
      title: input.title.trim() || input.prompt.trim().slice(0, 60) || 'untitled task',
      level2: input.level2,
      prompt: input.prompt,
      status: 'queued',
      createdAt: new Date().toISOString(),
      iterations: 0,
    };
    await this.updateSession(sessionId, (s) => {
      s.tasks.push(task);
    });
    return task;
  }

  async updateTask(sessionId: string, taskId: string, mutate: (t: Task) => void): Promise<Task> {
    let found: Task | undefined;
    await this.updateSession(sessionId, (s) => {
      found = s.tasks.find((t) => t.id === taskId);
      if (!found) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
      mutate(found);
    });
    return found as Task;
  }

  async deleteTask(sessionId: string, taskId: string): Promise<void> {
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t && t.status !== 'queued') {
        throw new Error('Only a queued task can be deleted.');
      }
      s.tasks = s.tasks.filter((x) => x.id !== taskId);
    });
  }

  // --- helpers --------------------------------------------------------------------------

  private async readSession(path: string): Promise<Session | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Session;
    } catch {
      return null;
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  }
}
