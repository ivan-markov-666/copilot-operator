/**
 * The projects on the Desktop: one folder each under `copilot-operator-context`.
 *
 * There used to be one flat folder for whatever the running session was mirroring. That was
 * right for one project and wrong for three: every session's sync deleted the previous
 * project's files ("no longer part of the selection"), and once the copies reached the chat
 * as attachments, `src--main.ts.txt` from the API and `src--main.ts.txt` from the web app
 * were the same name. So each project now has its own folder, named after it, and every
 * flattened file carries the project's name in front — a file is then identifiable on the
 * Desktop, in OneDrive and in the chat.
 *
 * Which projects: the ones on the Settings page — the default and the named others — each
 * with its own selection of directories. The switch for keeping them all on the Desktop is
 * `project.mirrorToDesktop`; a session's own mirror (the files attached to its first message)
 * uses the same folder for its project whether or not the switch is on.
 */
import { basename, join, resolve } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import type { ResolvedConfig, ProjectMirrorSelection } from '../config/schema.js';
import { mirrorProject, type MirrorResult } from './projectMirror.js';
import { defaultExportDir } from './contextFiles.js';

export type KnownProject = {
  name: string;
  rootDir: string;
  isDefault: boolean;
  mirror: ProjectMirrorSelection;
  /** Whether this project is kept on the Desktop when the switch is on. Each project's own choice. */
  desktop: boolean;
};

const EMPTY_SELECTION: ProjectMirrorSelection = { includeDirs: [], excludeDirs: [], respectGitignore: true, includeEnvFiles: false };

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return a.trim() !== '' && b.trim() !== '' && norm(a) === norm(b);
}

/** A project's name as a folder: what the operator typed, made safe for a file system. */
export function safeProjectName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '') || 'project';
}

/** The projects on the Settings page, the default first, each with its selection. */
export function knownProjects(cfg: ResolvedConfig): KnownProject[] {
  const out: KnownProject[] = [];
  const root = (cfg.project?.rootDir ?? '').trim();
  if (root) {
    out.push({ name: (cfg.project?.name ?? '').trim() || basename(root) || 'project', rootDir: root, isDefault: true, mirror: cfg.project?.mirror ?? EMPTY_SELECTION, desktop: cfg.project?.desktop !== false });
  }
  for (const o of cfg.project?.others ?? []) out.push({ name: o.name, rootDir: o.rootDir, isDefault: false, mirror: o.mirror ?? EMPTY_SELECTION, desktop: o.desktop !== false });
  return out;
}

/** What to call the folder for a session's project: its Settings name, else the folder's own. */
export function projectNameFor(rootDir: string, cfg: ResolvedConfig): string {
  const known = knownProjects(cfg).find((p) => sameFolder(p.rootDir, rootDir));
  return safeProjectName(known?.name ?? basename(resolve(rootDir)) ?? 'project');
}

/** The Desktop folder that holds one subfolder per project. */
export function contextRoot(cfg: ResolvedConfig): string {
  return cfg.resolved.mirrorTargetDir ?? defaultExportDir();
}

export function projectTargetDir(cfg: ResolvedConfig, projectName: string): string {
  return join(contextRoot(cfg), safeProjectName(projectName));
}

/**
 * Files left directly in the context root by the flat layout this replaced. They would
 * otherwise sit in OneDrive as stale copies with no project in their name, which is exactly
 * the confusion the folders exist to end. Only files, only ours by the look of them.
 */
export async function removeLegacyFlatMirror(cfg: ResolvedConfig): Promise<string[]> {
  const root = contextRoot(cfg);
  const removed: string[] = [];
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, entry);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (!/\.txt$/i.test(entry) && !entry.includes('--')) continue;
    await rm(path, { force: true }).catch(() => undefined);
    removed.push(entry);
  }
  return removed;
}

export type ProjectMirrorOutcome = { name: string; rootDir: string; targetDir: string; result: MirrorResult };

/** Brings one project's Desktop folder in line with its selection. */
export async function mirrorKnownProject(cfg: ResolvedConfig, project: KnownProject): Promise<ProjectMirrorOutcome> {
  const name = safeProjectName(project.name);
  const targetDir = projectTargetDir(cfg, name);
  const result = await mirrorProject({
    rootDir: project.rootDir,
    includeDirs: project.mirror.includeDirs.length ? project.mirror.includeDirs : ['.'],
    excludeDirs: project.mirror.excludeDirs,
    targetDir,
    namePrefix: name,
    separator: cfg.projectMirror.separator,
    txtMode: cfg.projectMirror.txtMode,
    respectGitignore: project.mirror.respectGitignore,
    ignoreDirs: cfg.projectMirror.ignoreDirs,
    includeEnvFiles: project.mirror.includeEnvFiles,
    maxFileBytes: cfg.projectMirror.maxFileBytes,
  });
  return { name, rootDir: project.rootDir, targetDir, result };
}

/**
 * Every known project that is kept on the Desktop, when the switch is on; nothing when it is off.
 *
 * The switch is the master control and each project has its own tick under it. A project whose
 * tick is off has its Desktop folder removed here, for the same reason the switch going off
 * removes them all: a stale copy of a code base in the cloud is worse than none.
 */
export async function mirrorAllProjects(cfg: ResolvedConfig): Promise<ProjectMirrorOutcome[]> {
  if (!cfg.project?.mirrorToDesktop) return [];
  await removeLegacyFlatMirror(cfg);
  const out: ProjectMirrorOutcome[] = [];
  for (const p of knownProjects(cfg)) {
    if (p.desktop) out.push(await mirrorKnownProject(cfg, p));
    else await removeProjectFolder(cfg, p);
  }
  return out;
}

async function removeProjectFolder(cfg: ResolvedConfig, p: KnownProject): Promise<boolean> {
  const dir = projectTargetDir(cfg, p.name);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Removes every known project's folder from the Desktop. The switch going off. */
export async function removeProjectMirrors(cfg: ResolvedConfig): Promise<string[]> {
  const removed: string[] = [];
  for (const p of knownProjects(cfg)) {
    if (await removeProjectFolder(cfg, p)) removed.push(projectTargetDir(cfg, p.name));
  }
  return removed;
}
