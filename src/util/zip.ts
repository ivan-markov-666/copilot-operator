/**
 * A .zip archive, written with what Node has (2026-10-23, the bot's folder exported from the System page): each file
 * deflated with `zlib`, its CRC-32, a local header, and the central directory at the end. No package to install, and
 * Windows opens it as it opens any .zip.
 *
 * Written as it goes (second bug hunt, 2026-11-19): `ZipWriter` sends each file to the download as it is packed, one
 * file in memory at a time, deflated off the API's thread — the whole archive was built in memory first, with every
 * run's records a few gigabytes, and the API answered nothing while it was. And ZIP64 where the plain format runs out
 * (more than 65,535 files, or past 4 GB), where it failed or wrote an archive no tool could open.
 */
import { deflateRaw, deflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import type { Writable } from 'node:stream';

export type ZipEntry = { name: string; data: Buffer; mtime?: Date };

const deflateLater = promisify(deflateRaw);
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The date and time of a file in the archive, as DOS kept them. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A file ready to go in: its name, how it is kept (stored or deflated), its bytes as kept, and what describes it. */
type Packed = { name: Buffer; method: 0 | 8; body: Buffer; crc: number; size: number; time: number; date: number };

function packed(entry: ZipEntry, deflated: Buffer): Packed {
  // Forward slashes, no leading one, UTF-8 names (flag 0x0800).
  const name = Buffer.from(entry.name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
  const stored = deflated.length >= entry.data.length;
  const { time, date } = dosTime(entry.mtime ?? new Date());
  return { name, method: stored ? 0 : 8, body: stored ? entry.data : deflated, crc: crc32(entry.data), size: entry.data.length, time, date };
}

/** ZIP64's extra field: the values the plain fields could not hold, in the order the format gives them. */
function zip64Extra(values: number[]): Buffer {
  if (values.length === 0) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return extra;
}

function localHeader(p: Packed): Buffer {
  const big = p.size >= MAX32 || p.body.length >= MAX32;
  // In a local header, ZIP64 carries both sizes when either needs it.
  const extra = big ? zip64Extra([p.size, p.body.length]) : Buffer.alloc(0);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(big ? 45 : 20, 4);
  head.writeUInt16LE(0x0800, 6);
  head.writeUInt16LE(p.method, 8);
  head.writeUInt16LE(p.time, 10);
  head.writeUInt16LE(p.date, 12);
  head.writeUInt32LE(p.crc, 14);
  head.writeUInt32LE(big ? MAX32 : p.body.length, 18);
  head.writeUInt32LE(big ? MAX32 : p.size, 22);
  head.writeUInt16LE(p.name.length, 26);
  head.writeUInt16LE(extra.length, 28);
  return Buffer.concat([head, p.name, extra]);
}

function centralHeader(p: Packed, offset: number): Buffer {
  const sizeBig = p.size >= MAX32;
  const bodyBig = p.body.length >= MAX32;
  const offsetBig = offset >= MAX32;
  const extra = zip64Extra([...(sizeBig ? [p.size] : []), ...(bodyBig ? [p.body.length] : []), ...(offsetBig ? [offset] : [])]);
  const needs = sizeBig || bodyBig || offsetBig ? 45 : 20;
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(needs, 4);
  head.writeUInt16LE(needs, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(p.method, 10);
  head.writeUInt16LE(p.time, 12);
  head.writeUInt16LE(p.date, 14);
  head.writeUInt32LE(p.crc, 16);
  head.writeUInt32LE(bodyBig ? MAX32 : p.body.length, 20);
  head.writeUInt32LE(sizeBig ? MAX32 : p.size, 24);
  head.writeUInt16LE(p.name.length, 28);
  head.writeUInt16LE(extra.length, 30);
  head.writeUInt32LE(offsetBig ? MAX32 : offset, 42);
  return Buffer.concat([head, p.name, extra]);
}

/** The end of the archive: with ZIP64's record and its locator first when the plain end cannot hold the counts. */
function endRecords(count: number, dirOffset: number, dirSize: number): Buffer {
  const big = count >= MAX16 || dirOffset >= MAX32 || dirSize >= MAX32;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(big ? MAX16 : count, 8);
  end.writeUInt16LE(big ? MAX16 : count, 10);
  end.writeUInt32LE(big ? MAX32 : dirSize, 12);
  end.writeUInt32LE(big ? MAX32 : dirOffset, 16);
  if (!big) return end;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(dirSize), 40);
  record.writeBigUInt64LE(BigInt(dirOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(dirOffset + dirSize), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end]);
}

/** A whole archive in memory: for a few small files. An export goes through `ZipWriter`. */
export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const p = packed(entry, deflateRawSync(entry.data));
    const local = localHeader(p);
    parts.push(local, p.body);
    central.push(centralHeader(p, offset));
    offset += local.length + p.body.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([...parts, directory, endRecords(entries.length, offset, directory.length)]);
}

/**
 * An archive written to `out` as it goes: each file deflated off the API's thread and sent, then the next, waiting
 * while the reader has not taken what was sent. Only the central directory is kept until the end. A download the
 * reader gave up on stops it.
 */
export class ZipWriter {
  private offset = 0;
  private count = 0;
  private readonly central: Buffer[] = [];

  constructor(private readonly out: Writable) {}

  async add(entry: ZipEntry): Promise<void> {
    const p = packed(entry, await deflateLater(entry.data));
    const at = this.offset;
    await this.send(localHeader(p));
    await this.send(p.body);
    this.central.push(centralHeader(p, at));
    this.count += 1;
  }

  async finish(): Promise<void> {
    const directory = Buffer.concat(this.central);
    const at = this.offset;
    await this.send(directory);
    await this.send(endRecords(this.count, at, directory.length));
  }

  private async send(b: Buffer): Promise<void> {
    if (this.out.destroyed) throw new Error('the download was given up on');
    this.offset += b.length;
    if (this.out.write(b)) return;
    await new Promise<void>((resolve) => {
      const go = (): void => {
        this.out.off('drain', go);
        this.out.off('close', go);
        resolve();
      };
      this.out.on('drain', go);
      this.out.on('close', go);
    });
    if (this.out.destroyed) throw new Error('the download was given up on');
  }
}
