/**
 * Everything the bot keeps, exported as one .zip (operator, 2026-10-23: "an option to export everything saved so far
 * under this profile"):
 *
 * - the archive is a real .zip: Windows' own `tar` opens it, and every file comes out as it went in, names and bytes;
 * - `data/` goes in, `runs/` only when asked for; the API's key never, nor the Edge profile; a manifest says so;
 * - through the API: `GET /api/home/export` answers a .zip, and `/api/home/export/size` what it would hold.
 *
 *   npm run check:export
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createZip, crc32 } from '../src/util/zip.js';
import { exportEntries, exportFileName, exportPlan, exportSizes, writeExport } from '../src/config/exportHome.js';
import type { InstallLayout } from '../src/config/layout.js';
import { startHarness, Tally } from './support/harness.js';

const t = new Tally();
const base = mkdtempSync(join(tmpdir(), 'cop-export-'));
const unzip = (zip: Buffer, name: string): string => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const file = join(base, `${name}.zip`);
  writeFileSync(file, zip);
  // Windows' own tar (bsdtar), not another that a shell put first on the PATH.
  const r = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar could not open it: ${r.stderr}`);
  return dir;
};

try {
  console.log('--- a real .zip ---');
  t.check('CRC-32 as everyone computes it', crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  const text = 'Здравей — hello, '.repeat(200);
  const small = Buffer.from([1, 2, 3]);
  const opened = unzip(createZip([{ name: 'a/settings.json', data: Buffer.from(text, 'utf8') }, { name: 'b/tiny.bin', data: small }, { name: 'empty.txt', data: Buffer.alloc(0) }]), 'plain');
  t.check("Windows' own tar opens it, every file as it went in", [readFileSync(join(opened, 'a', 'settings.json'), 'utf8') === text, readFileSync(join(opened, 'b', 'tiny.bin')).equals(small), readFileSync(join(opened, 'empty.txt')).length], [true, true, 0]);

  /*
   * More files than the plain format counts (second bug hunt, 2026-11-19): every run's records are many small files, and
   * past 65,535 the archive could not be written. ZIP64 then, which Windows' own tar reads.
   */
  const many = Array.from({ length: 70_000 }, (_, i) => ({ name: `runs/r${Math.floor(i / 1000)}/f${i}.txt`, data: Buffer.from(String(i)) }));
  const bigFile = join(base, 'many.zip');
  writeFileSync(bigFile, createZip(many));
  const listed = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', bigFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const listedNames = listed.stdout.split(/\r?\n/).filter(Boolean);
  t.check('70,000 files: written, and every one listed by tar', [listed.status, listedNames.length, listedNames.at(-1)], [0, 70_000, 'runs/r69/f69999.txt']);

  console.log('\n--- what goes in, and what never does ---');
  const home = join(base, 'home');
  const layout = { mode: 'package', homeDir: home, dataDir: join(home, 'data'), runsDir: join(home, 'runs') } as InstallLayout;
  mkdirSync(join(home, 'data', 'sessions'), { recursive: true });
  mkdirSync(join(home, 'runs', 'r1'), { recursive: true });
  mkdirSync(join(home, 'edge-profile', 'Default'), { recursive: true });
  writeFileSync(join(home, 'data', 'settings.json'), '{"copilot":{"defaultModel":"Think deeper"}}', 'utf8');
  writeFileSync(join(home, 'data', 'api-token'), 'a'.repeat(64), 'utf8');
  writeFileSync(join(home, 'data', 'sessions', 's1.json'), '{"id":"s1"}', 'utf8');
  writeFileSync(join(home, 'runs', 'r1', 'task-log.txt'), 'the run', 'utf8');
  writeFileSync(join(home, 'edge-profile', 'Default', 'Cookies'), 'signed in', 'utf8');

  const names = exportEntries(layout, { runs: false, version: '9.9.9' }).map((e) => e.name).sort();
  t.check('data/ goes in, with a manifest; the key, the runs and the Edge profile do not', names, ['data/sessions/s1.json', 'data/settings.json', 'manifest.json']);
  const withRuns = exportEntries(layout, { runs: true, version: '9.9.9' });
  t.check('asked for, the runs go in too', withRuns.map((e) => e.name).sort(), ['data/sessions/s1.json', 'data/settings.json', 'manifest.json', 'runs/r1/task-log.txt']);
  const manifest = JSON.parse(withRuns.find((e) => e.name === 'manifest.json')!.data.toString('utf8')) as { exportedBy: string; leftOut: Array<{ what: string }> };
  t.check('the manifest says which bot made it, and what was left out', [manifest.exportedBy, manifest.leftOut.map((x) => x.what)], ['copilot-operator 9.9.9', ['data/api-token', 'edge-profile/']]);
  const out = unzip(createZip(withRuns), 'home-opened');
  t.check('opened, the files are as they were', [readFileSync(join(out, 'data', 'settings.json'), 'utf8'), readFileSync(join(out, 'runs', 'r1', 'task-log.txt'), 'utf8'), existsSync(join(out, 'data', 'api-token'))], ['{"copilot":{"defaultModel":"Think deeper"}}', 'the run', false]);
  t.check('its size, counted without the key', exportSizes(layout), { data: 43 + 11, dataFiles: 2, runs: 7, runsFiles: 1 });

  /*
   * Written as it goes (second bug hunt, 2026-11-19): the archive was built whole in memory first, and a file that could
   * not be read failed the whole export, which the page's link saved as a file holding the error. Now one file at a time
   * to the download, and one that cannot be read is named in the manifest, the rest going in.
   */
  const plan = exportPlan(layout, { runs: true, version: '9.9.9' });
  unlinkSync(join(home, 'runs', 'r1', 'task-log.txt'));
  const sink = new PassThrough({ highWaterMark: 16 });
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const wrote = await writeExport(plan, sink);
  const streamed = unzip(Buffer.concat(chunks), 'streamed');
  const said = JSON.parse(readFileSync(join(streamed, 'manifest.json'), 'utf8')) as { notRead?: Array<{ what: string }> };
  t.check('streamed: the files that could be read, and the one that could not named in the manifest', [wrote, readFileSync(join(streamed, 'data', 'settings.json'), 'utf8'), (said.notRead ?? []).map((x) => x.what)], [{ files: 2, notRead: 1 }, '{"copilot":{"defaultModel":"Think deeper"}}', ['runs/r1/task-log.txt']]);
  writeFileSync(join(home, 'runs', 'r1', 'task-log.txt'), 'the run', 'utf8');
  t.check('named for when it was made', exportFileName(new Date(2026, 9, 23, 9, 5)), 'copilot-operator-export-20261023-0905.zip');

  console.log('\n--- through the API ---');
  const h = await startHarness({});
  try {
    const size = await h.call<{ dataFiles: number }>('GET', '/home/export/size');
    t.truthy('the size of an export, before it is made', typeof size.dataFiles === 'number' && size.dataFiles >= 1, size);
    const res = await fetch(`http://127.0.0.1:${h.api.port}/api/home/export`, { headers: { 'x-cop-token': h.api.token } });
    const body = Buffer.from(await res.arrayBuffer());
    t.check('GET /api/home/export answers a .zip, as a file to save', [res.status, res.headers.get('content-type')?.split(';')[0], /attachment; filename=.*copilot-operator-export-\d{8}-\d{4}\.zip/.test(res.headers.get('content-disposition') ?? ''), body.subarray(0, 2).toString()], [200, 'application/zip', true, 'PK']);
    const got = unzip(body, 'api');
    t.check('holding the settings and the manifest, and never the key', [existsSync(join(got, 'manifest.json')), existsSync(join(got, 'data', 'api-token'))], [true, false]);
    const refused = await fetch(`http://127.0.0.1:${h.api.port}/api/home/export`);
    t.check('and without the key, nothing', refused.status, 401);
  } finally {
    await h.stop();
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}

t.finish();
