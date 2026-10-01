/**
 * Settings for the API: the same shape as `run.yaml`, kept as `data/settings.json`.
 *
 * The UI edits this file through the API. Anything not present falls back to the schema
 * defaults, so an empty file is a valid, safe configuration.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadConfigObject, type ResolvedConfig, type RunConfig } from '../config/schema.js';
import { writeFileAtomically } from '../session/store.js';

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
   * The raw object as saved, or `{}` when there is no file yet (or an empty one).
   *
   * A file that is there but cannot be read as settings is an error, never `{}`. Read as empty,
   * it was written over by the next save of one setting — choosing a default model rewrote it as
   * `{copilot: {defaultModel}}` — and everything else the operator had set was gone, without a
   * word or a copy, while the program ran on the defaults in the meantime: another runs folder,
   * no project, the stock limits. A file whose values the schema refuses already stops `load` with
   * the reason; one that is not settings at all is refused the same way, by name, until the
   * operator mends it or deletes it.
   */
  async raw(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`Could not read ${this.path}: ${(e as Error).message}`);
    }
    // A file saved by hand in Notepad or Windows PowerShell may start with a byte-order mark,
    // which JSON.parse refuses; it is not part of the settings, and the file is not broken.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (body.trim() === '') return {};
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (e) {
      throw new Error(`${this.path} is not valid JSON (${(e as Error).message}). ${Settings.LEFT_ALONE}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${this.path} does not hold an object of settings. ${Settings.LEFT_ALONE}`);
    }
    return value as Record<string, unknown>;
  }

  /** What every refusal of an unreadable file says, so the way out is in the same message. */
  private static readonly LEFT_ALONE = 'Mend it, or delete it to start again from the defaults; nothing has been saved over it.';

  /** Parsed, defaulted and resolved against the project root. */
  async load(): Promise<ResolvedConfig> {
    const raw = await this.raw();
    return await loadConfigObject({ ...this.installDefaults, ...raw, dataDir: this.dataDir }, this.projectRoot, this.path);
  }

  /**
   * Validates before saving, so a bad edit is rejected rather than stored.
   *
   * A file on disk that cannot be read is not written over either, even by a whole set of
   * settings: the page that sends one built it on a copy read before the file broke, and whatever
   * the operator has put in the file since, by hand, would go without a word, which is the silent
   * replacement `raw` refuses, by another route. The write itself is atomic, because a crash in the
   * middle of a plain write is one way a settings file stops parsing.
   */
  async save(value: Record<string, unknown>): Promise<ResolvedConfig> {
    const resolved = await loadConfigObject({ ...this.installDefaults, ...value, dataDir: this.dataDir }, this.projectRoot, this.path);
    await this.raw();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomically(this.path, JSON.stringify(value, null, 2));
    return resolved;
  }

  /** The schema defaults, for the UI to show what "not set" means. */
  async defaults(): Promise<RunConfig> {
    const resolved = await loadConfigObject({}, this.projectRoot, 'defaults');
    const { configPath: _c, baseDir: _b, resolved: _r, ...cfg } = resolved;
    return cfg;
  }
}
