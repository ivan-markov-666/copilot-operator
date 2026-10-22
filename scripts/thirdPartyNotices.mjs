/**
 * The licences of the packages the web interface is built from, for the package to carry beside them (2026-10-22).
 *
 * The interface is bundled: Next.js and React, mermaid, Monaco and every package they bring are copied into
 * dist/web as compiled code, and their licences — MIT for most — ask that their notice go with every copy. The
 * minifier keeps a few of them and drops the rest, so the package build writes them all into one file instead:
 * every package the web workspace depends on for running (not its dev dependencies), found through package-lock.json
 * as npm installed it, with its licence text as the package ships it.
 *
 * Plain .mjs on node's own modules, as the build script that calls it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Where npm put `name` for the package at `from` (a lockfile key): its own node_modules, then each one above it. */
function resolveKey(packages, from, name) {
  let at = from;
  for (;;) {
    const key = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!at) return null;
    const cut = at.lastIndexOf('/node_modules/');
    at = cut >= 0 ? at.slice(0, cut) : '';
  }
}

/** A package's licence file, as it ships it: LICENSE, LICENCE, COPYING, in any case and with any ending. */
function licenceText(dir) {
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
  return name ? readFileSync(join(dir, name), 'utf8').trim() : null;
}

/**
 * Every package `workspace` needs at run time, with its version, its licence and the licence's text: one entry a
 * name and version, sorted by name.
 */
export function bundledPackages(root, workspace = 'web') {
  const lock = readJson(join(root, 'package-lock.json'));
  const packages = lock?.packages;
  if (!packages || !packages[workspace]) return [];
  const seen = new Map();
  const queue = Object.keys(packages[workspace].dependencies ?? {}).map((name) => ({ from: workspace, name }));
  while (queue.length > 0) {
    const { from, name } = queue.shift();
    const key = resolveKey(packages, from, name);
    if (!key) continue;
    const entry = packages[key];
    if (entry.link) {
      // A workspace of the repository: its own dependencies, not itself.
      const target = entry.resolved;
      for (const dep of Object.keys(packages[target]?.dependencies ?? {})) queue.push({ from: target, name: dep });
      continue;
    }
    const id = `${name}@${entry.version}`;
    if (seen.has(id)) continue;
    const dir = join(root, key);
    const manifest = readJson(join(dir, 'package.json')) ?? {};
    // An optional package not installed on this machine (another platform's binary) is not in what was built.
    if (!existsSync(dir)) continue;
    seen.set(id, { name, version: entry.version, license: entry.license ?? manifest.license ?? 'unknown', text: licenceText(dir) });
    for (const dep of [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {})]) queue.push({ from: key, name: dep });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

/** The notices file: what it is, then each package with its licence and the licence's text. */
export function noticesText(list, product) {
  const head = [
    `Third-party software in ${product}'s web interface`,
    '',
    'The interface (dist/web) is built from the packages below, which are bundled into it. Each is the work of its',
    'authors, under the licence named; the licence text is the one the package ships.',
    '',
  ];
  const body = list.map((p) => [`${'='.repeat(78)}`, `${p.name} ${p.version} — ${p.license}`, `${'='.repeat(78)}`, p.text ?? `(The package ships no licence file; its package.json names the licence: ${p.license}.)`, ''].join('\n'));
  return `${[...head, ...body].join('\n')}\n`;
}
