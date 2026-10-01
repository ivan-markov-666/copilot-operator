/**
 * Settings for the API: the same shape as `run.yaml`, kept as `data/settings.json`.
 *
 * The UI edits this file through the API. Anything not present falls back to the schema
 * defaults, so an empty file is a valid, safe configuration.
 */
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadConfigObject, RunConfigSchema, type ResolvedConfig, type RunConfig } from '../config/schema.js';
import { readHandWritten } from '../config/handWritten.js';
import type { InstallLayout } from '../config/layout.js';
import { writeFileAtomically } from '../session/store.js';

/**
 * A settings file that is there and cannot be used: it cannot be read, it is not JSON, it is not an
 * object of settings, or the schema refuses what it holds.
 *
 * Its own class because it is not the fault of the request that meets it, and every request that
 * reads the settings meets it, not only the saves. As a plain error it was "Internal server error"
 * on the Defaults page, the Project page and the model picker, the very pages the operator opens to
 * find out what is wrong. The server answers this one the same way on every route, with this
 * message (see `server.ts`), and `cop doctor` says it too, since the API will not start on it.
 */
export class SettingsUnusableError extends Error {
  constructor(
    readonly path: string,
    /** What is wrong, said of the file: "is not valid JSON (…)". */
    readonly problem: string,
  ) {
    // What every refusal says, so the way out is in the same message.
    super(`${path} ${problem}. Mend it, or delete it to start again from the defaults; nothing has been saved over it.`);
    this.name = 'SettingsUnusableError';
  }
}

/**
 * The text of a settings file as settings: `{}` when it is empty, an error when it is not an object
 * of settings. The one reading of the file, for the API and for `cop doctor`, so the two cannot
 * disagree about whether it is broken.
 *
 * A file that is there but cannot be read as settings is an error, never `{}`. Read as empty, it
 * was written over by the next save of one setting — choosing a default model rewrote it as
 * `{copilot: {defaultModel}}` — and everything else the operator had set was gone, without a word
 * or a copy, while the program ran on the defaults in the meantime: another runs folder, no project,
 * the stock limits.
 */
export function parseSettings(text: string, path: string): Record<string, unknown> {
  // A file saved by hand in Notepad or Windows PowerShell may start with a byte-order mark, which
  // JSON.parse refuses; it is not part of the settings, and the file is not broken. Read through
  // `readHandWritten`, the mark has gone already and said how the file is encoded, UTF-16 included;
  // a text handed here with the mark still on it is read the same.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (e) {
    throw new SettingsUnusableError(path, `is not valid JSON (${(e as Error).message})`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsUnusableError(path, 'does not hold an object of settings');
  }
  return value as Record<string, unknown>;
}

/**
 * Refuses settings the schema does not allow, as a problem of the file they were read from. For
 * what is on disk, never for a request's own edit, which is the request's problem (see `save`).
 */
export function checkSettings(value: Record<string, unknown>, path: string): void {
  const parsed = RunConfigSchema.safeParse(value);
  if (parsed.success) return;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new SettingsUnusableError(path, `holds settings that are not allowed (${issues})`);
}

/**
 * The settings of this install, with the defaults its layout implies: the one way they are built,
 * for the API and for `cop doctor`, so the doctor reads them as the API that it vouches for will.
 */
export function settingsOf(layout: InstallLayout): Settings {
  return new Settings(
    layout.projectRoot,
    layout.dataDir,
    layout.mode === 'package' ? { runsDir: layout.runsDir, level1File: join(layout.promptsDir, 'level1.md') } : {},
  );
}

export class Settings {
  private readonly path: string;

  constructor(
    readonly projectRoot: string,
    readonly dataDir: string,
    /**
     * Defaults that depend on how the program is installed, applied under whatever the file says.
     * A package keeps its runs in the project's records folder and reads its contract from the
     * package; a checkout's own defaults (`./runs`, `prompts/level1.md`) need nothing here.
     */
    private readonly installDefaults: Record<string, unknown> = {},
  ) {
    this.path = join(dataDir, 'settings.json');
  }

  /**
   * The raw object as saved, or `{}` when there is no file yet (or an empty one). A file that is
   * there and is not settings is refused by name (see `parseSettings`) until the operator mends it
   * or deletes it.
   */
  async raw(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readHandWritten(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new SettingsUnusableError(this.path, `could not be read (${(e as Error).message})`);
    }
    return parseSettings(text, this.path);
  }

  /**
   * Parsed, defaulted and resolved against the project root.
   *
   * A file whose values the schema refuses stops here with the reason, as it always has; it is the
   * file's problem, not the request's, so it is refused as one (see `SettingsUnusableError`).
   * Anything else that stops the load is not this file's, and goes on as it is: a policy lock that
   * does not parse is a `PolicyLockUnusableError`, answered by name on every route as this one is.
   */
  async load(): Promise<ResolvedConfig> {
    const value = { ...this.installDefaults, ...(await this.raw()), dataDir: this.dataDir };
    try {
      return await loadConfigObject(value, this.projectRoot, this.path);
    } catch (e) {
      checkSettings(value, this.path);
      throw e;
    }
  }

  /**
   * Validates before saving, so a bad edit is rejected rather than stored.
   *
   * A file on disk that cannot be read is not written over either, even by a whole set of
   * settings: the page that sends one built it on a copy read before the file broke, and whatever
   * the operator has put in the file since, by hand, would go without a word, which is the silent
   * replacement `raw` refuses, by another route.
   */
  async save(value: Record<string, unknown>): Promise<ResolvedConfig> {
    return await this.write(() => value);
  }

  /**
   * Changes part of the settings: `change` is given what the file holds and returns all of it, as
   * it is to be saved.
   *
   * For a save of one setting (the default model, the review model, the project), which must keep
   * every other. The read and the write are one turn on the file, so two such saves at once each
   * change what the other left: read before the turn, both read the same file, and the one written
   * second put back the setting the first had just changed, though both answered 200. `change` is
   * synchronous so it cannot wait for the file's turn from inside it; it may throw to refuse, and
   * then nothing is written.
   */
  async update(change: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<ResolvedConfig> {
    return await this.write(change);
  }

  /**
   * The one way the file is written: read, changed, validated and replaced in the file's turn (see
   * `writeFileAtomically`). The read refuses a file that cannot be read, so nothing is ever saved
   * over one. The write is atomic, because a crash in the middle of a plain write is one way a
   * settings file stops parsing.
   */
  private async write(next: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<ResolvedConfig> {
    await mkdir(dirname(this.path), { recursive: true });
    let resolved: ResolvedConfig | undefined;
    await writeFileAtomically(this.path, async () => {
      const value = next(await this.raw());
      resolved = await loadConfigObject({ ...this.installDefaults, ...value, dataDir: this.dataDir }, this.projectRoot, this.path);
      return JSON.stringify(value, null, 2);
    });
    return resolved as ResolvedConfig;
  }

  /** The schema defaults, for the UI to show what "not set" means. */
  async defaults(): Promise<RunConfig> {
    const resolved = await loadConfigObject({}, this.projectRoot, 'defaults');
    const { configPath: _c, baseDir: _b, resolved: _r, ...cfg } = resolved;
    return cfg;
  }
}
