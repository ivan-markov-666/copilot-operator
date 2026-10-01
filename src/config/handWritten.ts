/**
 * The text of a file a person writes by hand to configure this program: `data/settings.json`, a
 * `policy.lock.json`, a `run.yaml` and the files it names.
 *
 * Windows writes such a file in more than one encoding, and each is the file its writer meant.
 * Notepad and Windows PowerShell's `Set-Content -Encoding utf8` put a UTF-8 byte-order mark in
 * front of it; Windows PowerShell 5.1's `>` and `Out-File`, without an `-Encoding`, write UTF-16,
 * little-endian, with its own mark. Read as UTF-8 and nothing else, the first was refused as "not
 * valid JSON" over a character nobody can see, and the second over two replacement characters and
 * a NUL between every letter, of a file that looks right in Notepad. So the mark, where there is
 * one, says how the rest is encoded, and is not part of the text. A file without one is UTF-8, as
 * everything this program writes is.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

export function decodeHandWritten(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Node decodes UTF-16 only little-endian, so a big-endian file has each pair of bytes swapped
    // first, in a copy. A last odd byte is half a character and cannot be one.
    const body = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return body.swap16().toString('utf16le');
  }
  return bytes.toString('utf8');
}

/** `readFile(path, 'utf8')` for a hand-written file: the same errors, the text by its mark. */
export async function readHandWritten(path: string): Promise<string> {
  return decodeHandWritten(await readFile(path));
}

/** The same, for the command line's synchronous checks. */
export function readHandWrittenSync(path: string): string {
  return decodeHandWritten(readFileSync(path));
}
