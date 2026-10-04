/**
 * The run log: a JSONL transcript on disk plus a readable line on the console.
 *
 * Everything the bot does is appended to `runs/<runId>/transcript.jsonl`, including every
 * prompt sent, every reply received, every command and its exit code, and every file hash.
 * A run that goes wrong is then reconstructable without guessing, which matters when the
 * thing being audited is a machine running model-written commands.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export class RunLog {
  private readonly stream: WriteStream;
  readonly dir: string;

  constructor(
    readonly runId: string,
    runsDir: string,
    private readonly quiet = false,
  ) {
    this.dir = join(runsDir, runId);
    mkdirSync(this.dir, { recursive: true });
    this.stream = createWriteStream(join(this.dir, 'transcript.jsonl'), { flags: 'a' });
  }

  /** Structured record for the transcript; nothing is printed unless `human` is given. */
  event(type: string, data: Record<string, unknown> = {}, human?: string, level: LogLevel = 'info'): void {
    /*
     * The level and the sentence go into the transcript too. Without them the runner export's list of
     * problems was always empty — it looks for warn and error — and an event read back said only its type
     * (live run 2026-10-03).
     */
    this.stream.write(
      JSON.stringify({ at: new Date().toISOString(), type, ...data, ...(human && data.message === undefined ? { message: human } : {}), ...(level !== 'info' ? { level } : {}) }) + '\n',
    );
    if (human && !this.quiet) {
      const prefix = level === 'error' ? '  !! ' : level === 'warn' ? '  ! ' : '  ';
      process.stdout.write(prefix + human + '\n');
    }
  }

  /** Console-only, for things too noisy or too transient for the transcript. */
  say(text: string): void {
    if (!this.quiet) process.stdout.write(text + '\n');
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
