/**
 * The allowlist: which external programs a command line is permitted to start.
 *
 * Every other gate in this runner asks "is this one of the things we know to be bad?" — the
 * deny list and `dangerous.ts` both work that way, and both say, in as many words, that it is a
 * race the writer eventually wins. This gate asks the opposite question, the one a security team
 * asks of a tool it is being told to trust: "what is this thing allowed to run at all?" For a
 * runner whose whole job is to build and test software, the answer is a *finite* list — the
 * project's toolchain and a handful of ordinary inspection utilities — where the set of bad
 * things is infinite. Naming the small set is more honest, and more defensible, than chasing the
 * large one, so a program that is neither known-good nor known-bad is refused rather than run.
 *
 * What this is not: a boundary. Allowing `node` allows `node -e "<anything>"`; allowing a shell
 * allows a script inside it. The allowlist raises the floor — an unknown binary dropped on the
 * machine, a living-off-the-land tool not yet on the deny list — it does not seal the room. The
 * room is sealed by isolation (a separate account or a sandbox), which the README recommends and
 * which nothing in software here replaces. This sits *on top of* `dangerous.ts`, never instead of
 * it: the known-bad floor is checked first, so its precise message wins, and this catches the
 * long tail the floor was never going to enumerate.
 *
 * Deliberately generous where the cost of a wrong answer differs. Mistaking a real external
 * program for a shell built-in lets it through — but `dangerous.ts` and, in confirm mode, a human
 * are still in the way. Mistaking a built-in (`Get-ChildItem`, `ls`, `if`) for an external
 * program refuses honest work and breaks a run. The second error is the worse one for a tool that
 * has to keep working, so the classifier errs towards "built-in", and the allowlist's job is the
 * clear case: a token that really is an external executable and really is not on the list.
 *
 * An empty `allowedPrograms` turns the gate off, so a machine can opt out and nothing that ran
 * before this existed starts failing on an upgrade.
 */
import { extname } from 'node:path';

/**
 * Windows executable extensions. A token carrying one of these names a program by file, whatever
 * the stem, so it is always checked; a token with any other extension (`config.json`, `app.ts`)
 * is an argument, not a program head, and is left alone.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl',
]);

/**
 * Bare names that begin a statement but are not external programs: PowerShell language keywords,
 * the common cmdlet aliases, and the `cmd` built-ins. Kept to the forms that actually turn up at
 * the head of a build or test command; anything shaped `Verb-Noun` is treated as a cmdlet by rule
 * and does not need listing here. Lower-cased on both sides at the point of use.
 */
const SHELL_WORDS = new Set([
  // PowerShell language
  'if', 'else', 'elseif', 'switch', 'for', 'foreach', 'while', 'do', 'until', 'function', 'filter',
  'param', 'begin', 'process', 'end', 'return', 'break', 'continue', 'throw', 'try', 'catch', 'finally',
  'trap', 'data', 'in', 'exit',
  // PowerShell common aliases (bare)
  'ls', 'dir', 'gci', 'gc', 'cat', 'type', 'cd', 'chdir', 'sl', 'pushd', 'popd', 'gl', 'pwd',
  'cp', 'copy', 'cpi', 'mv', 'move', 'mi', 'rm', 'del', 'erase', 'ri', 'rd', 'rmdir',
  'ni', 'md', 'mkdir', 'ren', 'rename', 'echo', 'write', 'cls', 'clear',
  'gi', 'gp', 'sp', 'si', 'gm', 'gu', 'gv', 'sv', 'select', 'where', 'foreach-object', 'where-object',
  'sort', 'group', 'measure', 'ft', 'fl', 'fw', 'fh', 'oh', 'out-host', 'tee',
  'sls', 'gcm', 'gmo', 'ipmo', 'man', 'help', 'more', 'h', 'history', 'r',
  'gsv', 'gps', 'ps', 'kill', 'sleep', 'start', 'saps', 'spps', 'sasv', 'spsv',
  'iwr', 'irm', 'wget', 'curl', // PowerShell aliases for Invoke-WebRequest/Invoke-RestMethod; the raw .exe forms are allowlisted by name if wanted, and iwr|iex is caught by dangerous.ts
  // cmd built-ins
  'set', 'call', 'goto', 'rem', 'pause', 'title', 'color', 'path', 'prompt', 'setlocal', 'endlocal',
  'pushd', 'popd', 'ver', 'vol', 'date', 'time', 'exist', 'not', 'defined', 'errorlevel',
]);

/**
 * The heads of every statement in a command line: the first token after the start and after each
 * separator that begins a new command (`|`, `;`, `&`, `&&`, `||`, a newline, a `(` sub-expression
 * or a `{` script block). Quote- and depth-aware so a separator inside `'...'`, `"..."` or an
 * argument list does not split a statement, and a back-tick before a newline continues it.
 *
 * Best effort by design. The point is to find the programs a line would obviously start, not to
 * be a PowerShell parser; a construction it cannot read yields no head for that fragment, and the
 * fragment then rests on `dangerous.ts` and the human, which is where the honest limit was always
 * going to be anyway.
 */
export function commandHeads(command: string): string[] {
  const heads: string[] = [];
  const boundaries = new Set(['|', ';', '&', '\n', '(', '{']);
  let expectStart = true;
  let quote: string | null = null;
  let i = 0;

  const readToken = (from: number): { text: string; end: number } => {
    let j = from;
    let text = '';
    let q: string | null = null;
    while (j < command.length) {
      const ch = command[j]!;
      if (q) {
        if (ch === q) q = null;
        else text += ch;
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        q = ch;
        j += 1;
        continue;
      }
      if (/\s/.test(ch) || boundaries.has(ch) || ch === ')' || ch === '}') break;
      text += ch;
      j += 1;
    }
    return { text, end: j };
  };

  while (i < command.length) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (expectStart && !/\s/.test(ch) && !boundaries.has(ch) && ch !== ')' && ch !== '}') {
      const { text, end } = readToken(i);
      if (text) heads.push(text);
      i = end;
      expectStart = false;
      continue;
    }
    if (boundaries.has(ch)) {
      // A back-tick immediately before a newline is a line continuation, not a new statement.
      if (ch === '\n' && command[i - 1] === '`') {
        i += 1;
        continue;
      }
      expectStart = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return heads;
}

/**
 * The external-program name a statement head invokes, normalised for the allowlist, or null when
 * the head is not an external program (a cmdlet, an alias, a keyword, a variable, a parameter, or
 * a token carrying a non-executable extension). Directory and extension are stripped, so
 * `C:\tools\Foo.EXE`, `.\foo`, and `foo` all reduce to `foo`.
 */
export function externalProgram(head: string): string | null {
  const token = head.trim();
  if (!token) return null;
  if (token.startsWith('$') || token.startsWith('-') || token.startsWith('@') || token.startsWith('.') && token.length === 1) return null;
  if (token.includes('$')) return null; // an expanded name is not a literal program; dangerous.ts handles the assembled-name trick

  const leaf = token.replace(/^.*[\\/]/, '').replace(/^['"]|['"]$/g, '');
  const ext = extname(leaf).toLowerCase();
  const stem = ext ? leaf.slice(0, -ext.length) : leaf;
  if (!stem) return null;

  // A token with an extension names a program only when that extension is an executable one; a
  // `.json`, `.ts` or `.txt` at the head is a file being acted on, not a program being run.
  if (ext && !EXECUTABLE_EXTENSIONS.has(ext)) return null;

  const lower = stem.toLowerCase();
  // `Verb-Noun` with no extension is a cmdlet, not a program on disk.
  if (!ext && /^[a-z][a-z]*-[a-z][a-z0-9]*$/i.test(stem)) return null;
  if (!ext && SHELL_WORDS.has(lower)) return null;

  return lower;
}

/**
 * An allowlisted program used as a general-purpose code evaluator, or a shell wrapped inside a
 * shell — the two forms that make the allowlist meaningless — or null.
 *
 * Both are ordinary and useful, which is why they are refused only where nobody is watching.
 * `node -e "<anything>"` is `node`, which is allowlisted, and it runs whatever string follows;
 * `cmd /c "<anything>"` is `cmd`, which is allowlisted, and the program it really starts sits
 * inside a quoted argument where `commandHeads` cannot see it, so the allowlist never gets to
 * judge it. In confirm mode that is fine: a person reads the line and decides. In an unattended
 * run there is no person, and an allowlist that any allowlisted interpreter can be used to escape
 * is a statement nobody should be asked to trust.
 *
 * Deliberately narrow, and an *additional* restriction, so a form it fails to recognise leaves the
 * run exactly where it was rather than opening anything. The honest way to do the same work is to
 * put the code in a file the project keeps and run that file, where it can be read afterwards.
 */
/*
 * Each pattern requires the evaluating switch to come before the first argument that is not a
 * switch, which is what tells `node -e "<code>"` apart from `node server.js -p 3000` — the second
 * is a port for the application and has nothing to do with evaluation. Matching the switch
 * anywhere on the line refused honest work, which is the error this gate can least afford.
 */
const INLINE_CODE: Array<{ what: string; pattern: RegExp }> = [
  { what: 'node -e', pattern: /\bnode(\.exe)?\s+(-\S+\s+)*?-(e|-eval)\b/i },
  { what: 'deno eval', pattern: /\bdeno(\.exe)?\s+eval\b/i },
  { what: 'bun -e', pattern: /\bbun(\.exe)?\s+(-\S+\s+)*?-e\b/i },
  { what: 'python -c', pattern: /\b(python3?|py)(\.exe)?\s+(-\S+\s+)*?-c\b/i },
  { what: 'perl -e', pattern: /\bperl(\.exe)?\s+(-\S+\s+)*?-e\b/i },
  { what: 'ruby -e', pattern: /\bruby(\.exe)?\s+(-\S+\s+)*?-e\b/i },
  { what: 'php -r', pattern: /\bphp(\.exe)?\s+(-\S+\s+)*?-r\b/i },
  { what: 'a nested PowerShell', pattern: /\b(pwsh|powershell)(\.exe)?\s+(-\S+\s+)*?-c(ommand)?\b/i },
  { what: 'a nested cmd', pattern: /\bcmd(\.exe)?\s+(\/\S+\s+)*?\/c\b/i },
];

export function inlineCodeRefusal(command: string): string | null {
  for (const { what, pattern } of INLINE_CODE) {
    if (pattern.test(command)) {
      return (
        `refused in an unattended run: \`${what}\` uses an allowed program to run code that the allowlist ` +
        `cannot see, so the list stops meaning anything when nobody is watching. Put the code in a file the ` +
        `project keeps and run that file, or run this task in confirm mode where a person reads the line.`
      );
    }
  }
  return null;
}

/**
 * Why a command may not run under the allowlist, or null.
 *
 * `allowedPrograms` entries are matched by stem, case-insensitively, with any executable
 * extension ignored, so `git`, `git.exe` and `GIT` are one entry. An empty list disables the
 * gate. The message names the program and says where to allow it, because a false positive here
 * is a legitimate tool this project happens to need, and the fix is one line of config — not a
 * reason to weaken the gate for everyone.
 */
export function programRefusal(command: string, allowedPrograms: string[]): string | null {
  if (!allowedPrograms || allowedPrograms.length === 0) return null;
  const allowed = new Set(
    allowedPrograms.map((p) => p.trim().toLowerCase().replace(/\.(exe|com|bat|cmd|ps1|msi)$/i, '')).filter(Boolean),
  );
  for (const head of commandHeads(command)) {
    const program = externalProgram(head);
    if (program && !allowed.has(program)) {
      return (
        `refused: "${program}" is not in execution.allowedPrograms. This machine runs only the project's ` +
        `declared toolchain; if ${program} is a legitimate part of this project's build or tests, add it to ` +
        `execution.allowedPrograms. Do not rename or wrap it to get it past.`
      );
    }
  }
  return null;
}
