/**
 * A throwaway copy of the program to look at by hand: the real API and interface on a free port, a temporary
 * data folder and repository, and the scripted chat in place of Copilot — never the operator's own data, never
 * Edge. It runs a small plan so the workbench has every kind of task to show (done, blocked, queued), prints the
 * address, and stays up until it is stopped.
 *
 *   npm run build:package && npx tsx test/support/demo.ts
 */
import { join } from 'node:path';
import { startHarness } from './harness.js';
import { reply } from './fakeChat.js';

const webDir = join(import.meta.dirname, '..', '..', 'dist', 'web');
const h = await startHarness({ webDir, settings: { limits: { retryBlockedInFreshChat: 0 } } });
const task = (title: string, file: string, text: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});
const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);
const [a, b] = await h.importPlan({
  version: 1,
  sessions: [
    { name: 'okta-validation', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'okta-validation' }, review: { enabled: false },
      tasks: [task('Add the schema', 'schema.txt', 'v2'), task('Okta validation tests', 'okta.txt', 'tests'), task('Document the rules', 'docs.txt', 'docs')] },
    { name: 'tiff-splitting', onFailure: 'continue', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'tiff-splitting' }, review: { enabled: false },
      tasks: [task('Split multi-page TIFFs', 'split.txt', 'split')] },
  ],
});
h.chat.script(write('schema.txt', 'v2'), reply.done(), ...reply.triedThenBlocked());
await h.run(a!.id);
h.chat.script(write('split.txt', 'split'), reply.done());
await h.run(b!.id);
console.log(`\nDEMO READY: http://127.0.0.1:${h.api.port}/\n`);
await new Promise(() => undefined);
