/**
 * Whether the packages installed in a clone are the ones its package-lock.json names, for the direct
 * dependencies of the root and of each workspace.
 *
 * A checkout that git alone moved on — a pull, a merge, a switch of branch — keeps the node_modules of
 * the commit it was on. A build or a dev server started on it then fails deep inside Next or tsc, on a
 * module it cannot find: 0.1.54 added mermaid to web/, and `npm publish` in a checkout fast-forwarded
 * to it stopped at "Can't resolve 'mermaid'" after the API was compiled. Checked first, it is one line
 * per package and the command that fixes it.
 *
 * Plain .mjs on node's own modules: it runs before anything is built or known to be installed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Each direct dependency of the root and of its workspaces whose installed copy is missing, or is not
 * the version package-lock.json names: `{ name, of, wanted, found }`, `of` being '' for the root and
 * the workspace's folder otherwise, `found` null when nothing is installed. Empty when there is no
 * lockfile to compare with. A dependency the lockfile does not name is npm's to say, and is left out;
 * so is a workspace's link to another, and an optional one that is not installed.
 */
export function notInstalled(root) {
  const lock = readJson(join(root, 'package-lock.json'));
  const packages = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : null;
  if (!packages) return [];
  // The root is the entry '', a workspace an entry by its folder: the keys with no node_modules in them.
  const projects = Object.keys(packages).filter((k) => !/(^|\/)node_modules\//.test(k));
  const out = [];
  for (const ws of projects) {
    const manifest = readJson(join(root, ws, 'package.json')) ?? packages[ws] ?? {};
    const optional = manifest.optionalDependencies ?? {};
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(optional)]);
    for (const name of [...names].sort()) {
      // npm puts a workspace's dependency in its own node_modules only when the root's holds another version.
      const key = [ws ? `${ws}/node_modules/${name}` : null, `node_modules/${name}`].find((k) => k && packages[k]);
      if (!key) continue;
      const entry = packages[key];
      if (entry.link || typeof entry.version !== 'string') continue;
      const found = readJson(join(root, key, 'package.json'))?.version ?? null;
      if (found === entry.version) continue;
      if (found === null && (name in optional || entry.optional)) continue;
      out.push({ name, of: ws, wanted: entry.version, found });
    }
  }
  return out;
}

/** What `notInstalled` found, one line a package, as the build and `npm start` say it. */
export function notInstalledLines(list) {
  return list.map(({ name, of, wanted, found }) => `${name}${of ? ` (${of})` : ''}: package-lock.json names ${wanted}, ${found === null ? 'not installed' : `${found} is installed`}`);
}
