/**
 * What a commit made by the runner should not carry.
 *
 * `commitOnFinish` commits everything the task left in the working tree, and that is the right
 * default: the runner cannot know which of the model's files are the work. But it can know
 * what tool output looks like. A nine-task plan wrote its `.gitignore` exactly as told, nine
 * entries, and the second web task still committed `web/tsconfig.tsbuildinfo` — the build had
 * turned on `incremental` in a file the plan had dictated the contents of, the reviewer saw the
 * path in its list of changed files and said nothing, and the plan's own audit looked for
 * `node_modules`, `.next` and `dist` and found none. Nobody was wrong; nobody was looking for
 * that.
 *
 * So the runner looks, once. A file that is installed, built, cached or logged rather than
 * written, or one that holds secrets, is pointed out to the model before the task can end —
 * through the same channel as the operator's checks — with the instruction to ignore it or to
 * say why it belongs. Pointed out once: a second `done` with the file still there commits it
 * and records it as suspicious on the task, where a person will see it. The alternative,
 * refusing to commit, leaves the tree dirty and the next task refusing to start over it.
 */

export type Suspicious = { path: string; reason: string };

/** Directory names that are installed, built or cached rather than written. */
const GENERATED_DIRS: Record<string, string> = {
  node_modules: 'installed by the package manager',
  dist: 'build output',
  build: 'build output',
  out: 'build output',
  '.next': "Next.js's build output",
  '.nuxt': "Nuxt's build output",
  '.svelte-kit': "SvelteKit's build output",
  coverage: 'test coverage output',
  '.turbo': 'a build cache',
  '.cache': 'a cache',
  '.parcel-cache': 'a build cache',
  __pycache__: 'compiled Python',
  '.pytest_cache': 'a test cache',
  '.mypy_cache': 'a type-checker cache',
  '.venv': 'a Python virtual environment',
  venv: 'a Python virtual environment',
};

/** File names, or endings, that a tool writes and nobody reads. */
const GENERATED_FILES: Array<[test: (name: string) => boolean, reason: string]> = [
  [(n) => n.endsWith('.tsbuildinfo'), "TypeScript's incremental build state"],
  [(n) => n.endsWith('.log'), 'a log file'],
  [(n) => n === '.DS_Store' || n === 'Thumbs.db' || n === 'desktop.ini', "the operating system's folder metadata"],
  [(n) => n.endsWith('.pyc'), 'compiled Python'],
];

/** `.env` and its variants, except the ones that exist to be committed. */
function isSecretsFile(name: string): boolean {
  if (!name.startsWith('.env')) return false;
  const rest = name.slice('.env'.length);
  if (rest === '') return true;
  if (!rest.startsWith('.')) return false;
  const suffix = rest.slice(1).toLowerCase();
  return suffix !== 'example' && suffix !== 'sample' && suffix !== 'template';
}

/**
 * Why a path should not be committed, or null when it looks like work.
 *
 * `key` is what to report: for a file, the file; for anything under a generated folder, the
 * folder — `api/node_modules/` once, not fifteen thousand lines under it.
 */
export function looksGenerated(path: string): { reason: string; key: string } | null {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return null;
  for (const [i, dir] of parts.slice(0, -1).entries()) {
    const reason = GENERATED_DIRS[dir];
    if (reason) return { reason: `a \`${dir}/\` folder, ${reason}`, key: `${parts.slice(0, i + 1).join('/')}/` };
  }
  const last = parts[parts.length - 1];
  // A folder `git status` lists as one entry, with a trailing slash.
  if (/[\\/]$/.test(path) && GENERATED_DIRS[last]) return { reason: `a \`${last}/\` folder, ${GENERATED_DIRS[last]}`, key: `${parts.join('/')}/` };
  const file = parts.join('/');
  for (const [test, reason] of GENERATED_FILES) if (test(last)) return { reason, key: file };
  if (isSecretsFile(last)) return { reason: 'a secrets file', key: file };
  return null;
}

/** The paths, out of a list, that should not be committed — one entry per file or folder. */
export function findSuspicious(paths: string[]): Suspicious[] {
  const seen = new Map<string, Suspicious>();
  for (const path of paths) {
    const hit = looksGenerated(path);
    if (hit && !seen.has(hit.key)) seen.set(hit.key, { path: hit.key, reason: hit.reason });
  }
  return [...seen.values()];
}

/** What the model is told, once, before the commit. */
export function suspiciousDetail(found: Suspicious[]): string {
  const list = found.map((s) => `${s.path} (${s.reason})`).join('; ');
  return (
    `${found.length} file(s) that look like tool output or secrets are in the working tree and would be committed ` +
    `with this task: ${list}. Add them to .gitignore — they are installed, built or generated, not written — and ` +
    'take them out of the index if git already tracks them. If one of them truly belongs in the repository, leave ' +
    'it and say why in your summary: it will be committed and marked.'
  );
}
