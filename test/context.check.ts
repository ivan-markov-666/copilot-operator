import {
  resolveDesktopDir, defaultExportDir, desktopIsSynced, resolveOneDriveRoot,
  checkSelection, COPILOT_ACCEPTED,
  buildManifest, readManifest, writeManifest, diffAgainstManifest, describeDiff, MANIFEST_NAME,
} from '../src/context/contextFiles.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

console.log('Desktop        :', resolveDesktopDir());
console.log('export dir     :', defaultExportDir());
console.log('OneDrive root  :', resolveOneDriveRoot());
console.log('desktop synced :', desktopIsSynced());
console.log('accepts .ts    :', COPILOT_ACCEPTED.has('.ts'), '| accepts .txt:', COPILOT_ACCEPTED.has('.txt'));

const dir = join(tmpdir(), 'cop-ctx-check');
const mf = join(dir, MANIFEST_NAME);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'src__app.ts.txt'), 'export const a = 1;\n');
await writeFile(join(dir, 'src__lib__util.ts.txt'), 'export const b = 2;\n');

const chk = await checkSelection(dir);
console.log('\ncheck ok       :', chk.ok, '| files', chk.files.length);
for (const n of chk.notes) console.log('  note:', n);

console.log('\n--- incremental behaviour ---');
let cur = await buildManifest(dir);
let d = diffAgainstManifest(cur, await readManifest(mf));
console.log('run 1:', describeDiff(d), 'attach ->', d.toAttach.join(', '));
await writeManifest(mf, cur);

cur = await buildManifest(dir);
d = diffAgainstManifest(cur, await readManifest(mf));
console.log('run 2 (no edits):', describeDiff(d), 'attach ->', d.toAttach.length ? d.toAttach.join(', ') : '(nothing)');

await writeFile(join(dir, 'src__app.ts.txt'), 'export const a = 42;\n');
await writeFile(join(dir, 'src__new.ts.txt'), 'export const c = 3;\n');
await rm(join(dir, 'src__lib__util.ts.txt'));
cur = await buildManifest(dir);
d = diffAgainstManifest(cur, await readManifest(mf));
console.log('run 3 (1 edit, 1 new, 1 deleted):', describeDiff(d));
console.log('        attach ->', d.toAttach.join(', '), '| removed ->', d.removed.join(', '));

await writeFile(join(dir, 'src__app.ts.txt'), 'export const a = 42;\n');
cur = await buildManifest(dir);
const d2 = diffAgainstManifest(cur, await readManifest(mf));
console.log('rewrite identical bytes -> still detected as changed?', d2.changed.includes('src__app.ts.txt'), '(true = correct, it differs from run 1)');

await rm(dir, { recursive: true, force: true });
