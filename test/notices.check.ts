/**
 * The licences of what the web interface is built from (2026-10-22), as scripts/thirdPartyNotices.mjs collects them
 * for the package build: every package the web workspace needs at run time — Next.js, React, mermaid, Monaco and all
 * they bring — with its licence text, and none of the repository's dev tools; one entry a package and version.
 *
 *   npm run check:notices
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tally } from './support/harness.js';

type Entry = { name: string; version: string; license: string; text: string | null };
const { bundledPackages, noticesText } = (await import(pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'thirdPartyNotices.mjs')).href)) as {
  bundledPackages: (root: string, workspace?: string) => Entry[];
  noticesText: (list: Entry[], product: string) => string;
};

const t = new Tally();
const root = join(import.meta.dirname, '..');
const list = bundledPackages(root, 'web');
const find = (name: string): Entry | undefined => list.find((p) => p.name === name);

t.truthy('the interface\'s own packages are there', ['next', 'react', 'react-dom', 'mermaid', 'monaco-editor'].every((n) => !!find(n)), list.map((p) => p.name));
t.truthy('and what they bring with them', ['dompurify', 'marked', 'scheduler'].every((n) => !!find(n)), list.map((p) => p.name));
t.truthy('Monaco with its MIT licence, as it ships it', find('monaco-editor')?.license === 'MIT' && (find('monaco-editor')?.text ?? '').includes('Microsoft Corporation'), find('monaco-editor'));
t.check('none of the repository\'s dev tools, nor the API\'s own packages', ['typescript', 'tsx', 'playwright', '@nestjs/core', 'zod'].filter((n) => !!find(n)), []);
t.check('one entry a package and version', list.length, new Set(list.map((p) => `${p.name}@${p.version}`)).size);
const text = noticesText(list, 'copilot-operator');
t.truthy('the file names each one with its licence, then its text', text.startsWith("Third-party software in copilot-operator's web interface") && text.includes(`monaco-editor ${find('monaco-editor')?.version} — MIT`), text.slice(0, 400));

t.finish();
