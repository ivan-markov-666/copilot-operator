/**
 * Settings for the API: the same shape as `run.yaml`, kept as `data/settings.json`.
 *
 * The UI edits this file through the API. Anything not present falls back to the schema
 * defaults, so an empty file is a valid, safe configuration.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfigObject, type ResolvedConfig, type RunConfig } from '../config/schema.js';

export class Settings {
  private readonly path: string;

  constructor(
    readonly projectRoot: string,
    readonly dataDir: string,
  ) {
    this.path = join(dataDir, 'settings.json');
  }

  /** The raw object as saved, or `{}` when there is no file yet. */
  async raw(): Promise<Record<string, unknown>> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Parsed, defaulted and resolved against the project root. */
  async load(): Promise<ResolvedConfig> {
    const raw = await this.raw();
    return await loadConfigObject({ ...raw, dataDir: this.dataDir }, this.projectRoot, this.path);
  }

  /** Validates before saving, so a bad edit is rejected rather than stored. */
  async save(value: Record<string, unknown>): Promise<ResolvedConfig> {
    const resolved = await loadConfigObject({ ...value, dataDir: this.dataDir }, this.projectRoot, this.path);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(value, null, 2), 'utf8');
    return resolved;
  }

  /** The schema defaults, for the UI to show what "not set" means. */
  async defaults(): Promise<RunConfig> {
    const resolved = await loadConfigObject({}, this.projectRoot, 'defaults');
    const { configPath: _c, baseDir: _b, resolved: _r, ...cfg } = resolved;
    return cfg;
  }
}
