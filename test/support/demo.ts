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
// The open folder is the demo's repository, and the chat answers whatever is typed: it lists the folder,
// writes a file named after the message, reads it back, and says it is done.
await h.call('PUT', '/settings', { ...(await h.call<{ raw: Record<string, unknown> }>('GET', '/settings')).raw, project: { rootDir: h.repo, name: 'demo-project' } });
let n = 0;
h.chat.fallback = (m) => {
  if (m.text.includes('Terminal output for')) return reply.done(`Done. I listed the folder and wrote note-${n}.txt with your message in it, then read it back to check it is there.`);
  n += 1;
  return reply.steps('Get-ChildItem -Name', `Set-Content -Path note-${n}.txt -Value 'message ${n}' -Encoding utf8`, `Get-Content note-${n}.txt`);
};
console.log(`\nDEMO READY: http://127.0.0.1:${h.api.port}/\n`);
await new Promise(() => undefined);
