/**
 * The folder each part of a line runs in (2026-11-03). `Push-Location 'rules-engine'; .\switch-env.ps1 qa` runs the
 * script of `rules-engine`, and the scripts a line runs (`scriptFiles.ts`) were looked for in the folder the line
 * started in: the project's own committed script was "not one of the project's own — it does not exist", the chat was
 * told to hand it over, and the card of commands handed over could not show it.
 *
 * So a line is read statement by statement, as the shell runs it, and a statement that changes the folder — `cd`,
 * `Set-Location`, `Push-Location` and `Pop-Location`, by their aliases too, and cmd's `cd /d`, `pushd` and `popd` —
 * changes it for what follows. Only a folder written out is followed: one chosen at run time (`cd $dir`, `cd ~`,
 * `cd %X%`) leaves the folder as it was, which is what every reader here did before, and a script then looked for in
 * the wrong folder is not found and not run. A change inside a block or a condition is not followed either.
 */
import { resolve } from 'node:path';

/** A stretch of the line, as written, and the folder it runs in. */
export type LineSegment = { text: string; cwd: string };

/** Where the top-level statements of a PowerShell line start and end. */
function powerShellStatements(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  const cut = (end: number, next: number): void => {
    if (end > start) out.push([start, end]);
    start = next;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '`') {
      i += 1;
      continue;
    }
    if (c === "'" || c === '‘' || c === '’') {
      // '' inside a single-quoted string is a quote.
      for (i += 1; i < s.length; i++) {
        if (s[i] === "'" || s[i] === '‘' || s[i] === '’') {
          if (s[i + 1] === "'") i += 1;
          else break;
        }
      }
      continue;
    }
    if (c === '"' || c === '“' || c === '”') {
      for (i += 1; i < s.length; i++) {
        if (s[i] === '`') i += 1;
        else if (s[i] === '"' || s[i] === '“' || s[i] === '”') {
          if (s[i + 1] === '"') i += 1;
          else break;
        }
      }
      continue;
    }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && (s[i + 2] === '\n' || (s[i + 2] === '\r' && s[i + 3] === '\n'))) {
      const close = s.indexOf(`\n${s[i + 1]}@`, i + 2);
      i = close < 0 ? s.length : close + 2;
      continue;
    }
    if (c === '<' && s[i + 1] === '#') {
      const close = s.indexOf('#>', i + 2);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl - 1;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '\n')) cut(i, i + 1);
    else if (depth === 0 && (c === '&' || c === '|') && s[i + 1] === c) {
      cut(i, i + 2);
      i += 1;
    }
  }
  cut(s.length, s.length);
  return out;
}

/** Where cmd's commands start and end: `&`, `&&`, `||` and newlines, outside quotes and brackets. */
function cmdStatements(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  const cut = (end: number, next: number): void => {
    if (end > start) out.push([start, end]);
    start = next;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '^' && !quoted) {
      i += 1;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '\n') cut(i, i + 1);
    else if (depth === 0 && (c === '&' || c === '|') && s[i + 1] === c) {
      cut(i, i + 2);
      i += 1;
    } else if (depth === 0 && c === '&') cut(i, i + 1);
  }
  cut(s.length, s.length);
  return out;
}

/** A folder written out in full, its quotes taken off; null for one chosen at run time. */
function literalFolder(arg: string, cmd: boolean): string | null {
  let a = arg.trim();
  const q = a[0];
  if (q === '"' || (!cmd && q === "'")) {
    if (a.length < 2 || a[a.length - 1] !== q) return null;
    a = a.slice(1, -1);
    if (q === "'") a = a.replace(/''/g, "'");
  } else if (!cmd && /\s/.test(a)) {
    return null;
  }
  if (!a || a === '-' || a === '+' || a.startsWith('~')) return null;
  if (cmd ? /[%!]/.test(a) : /[$`(){}@]/.test(a) || (q === '"' && /[$`]/.test(a))) return null;
  // A PowerShell drive other than a file system's (`HKLM:`, `Env:`): not a folder.
  if (/^[A-Za-z]{2,}:/.test(a)) return null;
  return a;
}

type Move = { to: string } | { push: string } | { pop: true };

/** What a statement does to the folder, when it does anything a reader can follow. */
function moveOf(statement: string, cmd: boolean): Move | null {
  const s = statement.trim();
  if (cmd) {
    if (/^popd$/i.test(s)) return { pop: true };
    const m = /^(cd|chdir|pushd)(?:\s+\/d)?\s+(.+)$/i.exec(s);
    if (!m) return null;
    const to = literalFolder(m[2]!, true);
    if (to === null) return null;
    return m[1]!.toLowerCase() === 'pushd' ? { push: to } : { to };
  }
  if (/^(?:Pop-Location|popd)$/i.test(s)) return { pop: true };
  const m = /^(Set-Location|sl|cd|chdir|Push-Location|pushd)(?:\s+-(?:Path|LiteralPath)(?::)?)?\s+(.+)$/i.exec(s);
  if (!m) return null;
  const to = literalFolder(m[2]!, false);
  if (to === null) return null;
  return /^(?:Push-Location|pushd)$/i.test(m[1]!) ? { push: to } : { to };
}

/**
 * The line cut where it changes folder, each stretch with the folder it runs in. A line that changes none is one
 * stretch, in `cwd`: what every reader here was given before.
 */
export function foldersAlong(command: string, cwd: string, shell?: string): LineSegment[] {
  const cmd = shell === 'cmd';
  const statements = cmd ? cmdStatements(command) : powerShellStatements(command);
  const out: LineSegment[] = [];
  const stack: string[] = [];
  let folder = cwd;
  let from = 0;
  for (const [start, end] of statements) {
    const move = moveOf(command.slice(start, end), cmd);
    if (!move) continue;
    const next = 'pop' in move ? (stack.pop() ?? folder) : resolve(folder, 'to' in move ? move.to : move.push);
    if ('push' in move) stack.push(folder);
    if (next === folder) continue;
    out.push({ text: command.slice(from, end), cwd: folder });
    folder = next;
    from = end;
  }
  out.push({ text: command.slice(from), cwd: folder });
  return out.filter((s, i) => i === out.length - 1 || s.text.trim());
}
