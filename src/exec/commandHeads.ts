/**
 * Which programs a command line invokes: the name at the head of every command, and nothing else.
 *
 * The allowlist (`programs.ts`) judges the programs a line starts, so it needs the one thing this
 * file finds — the command invocations — and it needs nothing else mistaken for one. The version
 * before this split the line at every `(`, `{`, `|`, `;`, `&` and newline and took the first token
 * after each as a command. That is how PowerShell reads a statement and not how it reads the
 * inside of one, and it failed both ways:
 *
 *   refusing honest work   `if (!(Test-Path x))` gave the program `!`; `("a" + "b")` gave `+`;
 *                          `@('a','b')` and `.Replace('\', '/')` gave `,` or the string itself;
 *                          `('\bTODO')` gave `\b`, which the path-stripping then turned into `b`;
 *                          a hashtable's keys, a `2>&1` redirection's `1`, a `# comment`, an
 *                          index `[0]` — each "a program not on the list", each refused.
 *   letting work through   `$out = nmap ...` (a command after an assignment), `& "C:\x\y.exe"`
 *                          (a quoted call), `"$(nmap ...)"` (a subexpression in a string) and
 *                          `foreach ($f in nmap ...)` were never seen at all.
 *
 * So this is a lexer that follows PowerShell's two parsing modes, which is the whole distinction
 * the old splitter lacked. At the start of a statement, after a pipe and after `&&`, `||` or `=`,
 * PowerShell is at a *command position*: a bare word there is a command, and anything else — a
 * string, a number, a variable, an operator, `(`, `[`, `@(` — begins an *expression*, whose bare
 * words are never commands. Strings, here-strings, comments, method-call arguments, index and
 * type brackets and hashtable keys are read and stepped over as the data they are; script blocks,
 * `( )`, `$( )` and `@( )` — including a `$( )` inside a double-quoted string — hold statements
 * again and are read as such, so a command nested anywhere is still found.
 *
 * Why a lexer and not PowerShell's own parser, which would be exact: the parser is a .NET call
 * (`[System.Management.Automation.Language.Parser]::ParseInput`), reachable only by starting a
 * PowerShell process for every step — a process per command on a machine whose security team
 * counts them — and blocked outright under Constrained Language Mode, which the corporate machines
 * this runs on commonly enforce. A gate that works only where nobody locked the machine down is
 * not a gate. This one is synchronous, starts nothing, and reads the same everywhere.
 *
 * Fail-closed where it cannot be sure. An unterminated string or here-string, a bracket that is
 * never closed or closed by the wrong thing, a program chosen at run time (`& $exe`, `& (...)`, a
 * name built from a variable) — each makes the scan `uncertain`, and the allowlist refuses an
 * uncertain line rather than guess which programs it would start. None of those is something an
 * honest build or test step needs: PowerShell itself rejects the first three.
 *
 * `cmd` is read by its own, much smaller rules (`scanCmd`), because none of PowerShell's apply to
 * it — `'` is not a quote there, `^` escapes, `(` groups only at a command position.
 */

export type HeadScan = {
  /** The name at the head of every command invocation, in the order they appear, as written. */
  heads: string[];
  /** Why the line could not be read with certainty, when it could not. See the file comment. */
  uncertain?: string;
};

/** Scans a command line as the shell that will run it reads it. */
export function scanCommandHeads(command: string, shell: string = 'pwsh'): HeadScan {
  return shell === 'cmd' ? scanCmd(command) : new PowerShellScan(command).run();
}

// ------------------------------------------------------------------------------------------
// PowerShell
// ------------------------------------------------------------------------------------------

/** How deep brackets, blocks and subexpressions may nest before the line is called unreadable. */
const MAX_DEPTH = 64;

/** Keywords followed by conditions, blocks, flags or labels — none of whose bare words run. */
const BLOCK_KEYWORDS = new Set([
  'if', 'elseif', 'else', 'while', 'until', 'do', 'for', 'foreach', 'try', 'catch', 'finally', 'trap',
  'begin', 'process', 'end', 'clean', 'dynamicparam', 'data', 'param', 'default', 'using', 'exit', 'break',
  'continue', 'in', 'parallel', 'sequence', 'inlinescript',
]);
/** Keywords followed by a pipeline: the next bare word is a command. */
const PIPELINE_KEYWORDS = new Set(['return', 'throw']);
/** Keywords followed by a name that is being defined, not run. */
const NAMING_KEYWORDS = new Set(['function', 'filter', 'workflow', 'configuration']);
/** Keywords whose body is members, not statements. */
const TYPE_KEYWORDS = new Set(['class', 'enum', 'interface']);

/** What ends a bare word in command mode, besides white space. */
const WORD_BREAK = new Set([';', '|', '&', '(', ')', '{', '}', ',', '>', '<', '\n']);

// PowerShell takes the typographic quotes as quotes, and a model copying text writes them.
const isSingleQuote = (c: string): boolean => c === "'" || c === '\u2018' || c === '\u2019' || c === '\u201a' || c === '\u201b';
const isDoubleQuote = (c: string): boolean => c === '"' || c === '\u201c' || c === '\u201d' || c === '\u201e';
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff';
const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
/** The characters that end a statement or a pipeline element, where every reader stops. */
const isTerminator = (c: string): boolean => c === '' || c === ';' || c === '\n' || c === '|' || c === ')' || c === '}' || c === '&';

type Word = { literal: string; end: number; dynamic: boolean };

class PowerShellScan {
  private readonly heads: string[] = [];
  private uncertain?: string;
  private depth = 0;

  constructor(private readonly s: string) {}

  run(): HeadScan {
    this.statements(0, null);
    return this.uncertain ? { heads: this.heads, uncertain: this.uncertain } : { heads: this.heads };
  }

  private fail(why: string): void {
    this.uncertain ??= why;
  }

  private at(i: number): string {
    return this.s[i] ?? '';
  }

  /** Enters one level of nesting; false (and uncertain) past the limit. */
  private enter(): boolean {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      this.fail('it nests deeper than the runner reads');
      return false;
    }
    return true;
  }

  /**
   * Steps over white space, line continuations and comments; with `lines`, over newlines too, and
   * with `statements` over `;` as well — the separators between statements.
   */
  private skip(i: number, over: 'inline' | 'lines' | 'statements' = 'inline'): number {
    for (;;) {
      const c = this.at(i);
      if (c === '') return i;
      if (isSpace(c)) {
        i += 1;
        continue;
      }
      if (c === '`' && (this.at(i + 1) === '\n' || (this.at(i + 1) === '\r' && this.at(i + 2) === '\n'))) {
        i += this.at(i + 1) === '\r' ? 3 : 2;
        continue;
      }
      // A `#` where a token starts begins a comment to the end of the line; inside a word it is a
      // character of the word, which is why this is only ever asked at a token's start.
      if (c === '#') {
        const nl = this.s.indexOf('\n', i);
        i = nl < 0 ? this.s.length : nl;
        continue;
      }
      if (c === '<' && this.at(i + 1) === '#') {
        const close = this.s.indexOf('#>', i + 2);
        if (close < 0) {
          this.fail('a <# comment is never closed');
          return this.s.length;
        }
        i = close + 2;
        continue;
      }
      if (c === '\n' && over !== 'inline') {
        i += 1;
        continue;
      }
      if (c === ';' && over === 'statements') {
        i += 1;
        continue;
      }
      return i;
    }
  }

  /**
   * Statements up to `closer` (the `)` or `}` the caller opened) or the end of the line. Returns
   * the index just past the closer. `kind` says what the statements are: ordinary ones, the
   * entries of a hashtable, or the clauses of a switch.
   */
  private statements(i: number, closer: ')' | '}' | null, kind: 'statements' | 'hashtable' | 'switch' = 'statements'): number {
    if (!this.enter()) return this.s.length;
    try {
      for (;;) {
        i = this.skip(i, 'statements');
        const c = this.at(i);
        if (c === '') {
          if (closer) this.fail(`a "${closer === ')' ? '(' : '{'}" is never closed`);
          return i;
        }
        if (c === ')' || c === '}') {
          if (c === closer) return i + 1;
          this.fail(closer ? `"${c}" closes what "${closer}" should have` : `an unmatched "${c}"`);
          return this.s.length;
        }
        const before = i;
        i = kind === 'hashtable' ? this.hashEntry(i) : kind === 'switch' ? this.switchClause(i) : this.pipeline(i);
        // Every reader consumes at least what it stops on or returns at a terminator the loop
        // understands; this is the guarantee that a character nobody handles cannot spin it.
        if (i === before) i += 1;
      }
    } finally {
      this.depth -= 1;
    }
  }

  /** One statement: pipeline elements joined by `|`, `&&`, `||`, or ended by a background `&`. */
  private pipeline(i: number): number {
    for (;;) {
      i = this.element(i);
      i = this.skip(i);
      const c = this.at(i);
      if (c === '|' || c === '&') {
        i += this.at(i + 1) === c ? 2 : 1;
        i = this.skip(i, 'lines');
        continue;
      }
      return i;
    }
  }

  /** A command position: whatever starts here is either a command, a keyword or an expression. */
  private element(i: number): number {
    i = this.skip(i);
    const c = this.at(i);
    const n = this.at(i + 1);
    if (c === '' || c === ';' || c === '\n' || c === '|' || c === ')' || c === '}') return i;
    if (c === '&' && n !== '&') return this.invocation(i + 1);
    if (c === '&') return i;
    // `. .\script.ps1` — the dot-source operator; `.\x` and `..\x` are paths and read as words.
    if (c === '.' && (isSpace(n) || n === '{' || isSingleQuote(n) || isDoubleQuote(n) || n === '$' || n === '(')) return this.invocation(i + 1);
    if (c === '{') return this.expression(this.statements(i + 1, '}'), true);
    // A loop label, `:outer foreach (...)`.
    if (c === ':' && isIdent(n)) return this.element(this.readWord(i).end);
    if (this.startsExpression(i)) return this.expression(i, true);

    const word = this.readWord(i);
    const lower = word.literal.toLowerCase();
    if (!word.dynamic) {
      if (lower === 'switch') return this.switchStatement(word.end);
      if (NAMING_KEYWORDS.has(lower)) return this.keywordRest(this.readWord(this.skip(word.end)).end);
      if (TYPE_KEYWORDS.has(lower)) return this.typeDefinition(word.end);
      if (PIPELINE_KEYWORDS.has(lower)) return this.element(word.end);
      if (BLOCK_KEYWORDS.has(lower)) return this.keywordRest(word.end);
    }
    if (word.dynamic) this.fail(`the command "${word.literal}" is built from a variable, so which program it starts is known only when it runs`);
    else if (word.literal) this.heads.push(word.literal);
    return this.commandArgs(word.end);
  }

  /**
   * Whether what starts at `i` is an expression rather than a command name: a variable, a string,
   * a number, an operator, a bracket, an array or hashtable.
   */
  private startsExpression(i: number): boolean {
    const c = this.at(i);
    if (c === '$' || c === '@' || c === '(' || c === '[' || c === '!' || c === '+' || c === '-' || c === ',' || c === '*' || c === '/') return true;
    if (isSingleQuote(c) || isDoubleQuote(c)) return true;
    // A number, but not a program whose name begins with digits (`7z`).
    const m = /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)(?:[ld]|kb|mb|gb|tb|pb)?/i.exec(this.s.slice(i, i + 40));
    if (m) {
      const after = this.at(i + m[0].length);
      return !/[A-Za-z0-9_\\/:]/.test(after);
    }
    return false;
  }

  /**
   * After `&` or `.`: the thing invoked. A literal name or a quoted literal path is a command head;
   * a script block is read as statements; anything else — a variable, a subexpression, a string
   * with a variable in it — chooses the program at run time, and the scan is uncertain.
   */
  private invocation(i: number): number {
    i = this.skip(i);
    const c = this.at(i);
    if (c === '{') return this.commandArgs(this.statements(i + 1, '}'));
    if (isTerminator(c)) {
      this.fail('a call operator has nothing after it');
      return i;
    }
    if (c === '$' || c === '(' || c === '[' || c === '@') {
      this.fail('the program after "&" or "." is chosen at run time, so which program it starts is known only when it runs');
      return this.commandArgs(i);
    }
    const word = this.readWord(i);
    if (word.dynamic) this.fail(`the program "${word.literal}" is built from a variable, so which program it starts is known only when it runs`);
    else if (word.literal) this.heads.push(word.literal);
    return this.commandArgs(word.end);
  }

  /** A command's arguments, up to the end of its pipeline element. Nested statements are read. */
  private commandArgs(i: number): number {
    for (;;) {
      i = this.skip(i);
      const c = this.at(i);
      const n = this.at(i + 1);
      if (isTerminator(c)) return i;
      // `--%` hands the rest of the line to the program untouched, up to a pipe or a newline.
      if (c === '-' && n === '-' && this.at(i + 2) === '%') {
        while (i < this.s.length && this.at(i) !== '\n' && this.at(i) !== '|') i += 1;
        continue;
      }
      const redirect = this.redirection(i);
      if (redirect > i) {
        i = redirect;
        continue;
      }
      if (c === ',') {
        i += 1;
        continue;
      }
      const nested = this.nested(i, 'statements');
      if (nested !== null) {
        i = nested;
        continue;
      }
      const word = this.readWord(i);
      i = word.end > i ? word.end : i + 1;
    }
  }

  /**
   * An expression, up to the end of its pipeline element. Its bare words are operators, member
   * names and operands — never commands — with two exceptions that begin a command position: an
   * assignment at the statement's own level (`$out = git status`), and the `in` of a `foreach`
   * (`foreach ($f in Get-ChildItem)`), whose right-hand side is a pipeline.
   */
  private expression(i: number, statementLevel: boolean): number {
    for (;;) {
      i = this.skip(i);
      const c = this.at(i);
      if (isTerminator(c)) return i;
      if (c === '=' && statementLevel) return this.element(i + 1);
      const redirect = this.redirection(i);
      if (redirect > i) {
        i = redirect;
        continue;
      }
      const nested = this.nested(i, 'expression');
      if (nested !== null) {
        i = nested;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (isIdent(this.at(j))) j += 1;
        if (this.s.slice(i, j).toLowerCase() === 'in' && !isIdent(this.at(i - 1)) && this.at(i - 1) !== '-' && this.at(i - 1) !== '.') {
          return this.element(j);
        }
        i = j;
        continue;
      }
      i += 1;
    }
  }

  /**
   * The inside of `[ ]`, of a method call's `( )`, or of a class or enum body: expressions and
   * names, separated by commas and newlines, up to `closer`. Nothing here is at a command position
   * except what nests statements again (a `( )` that is not a call, a script block, `$( )`).
   */
  private expressionList(i: number, closer: ')' | ']' | '}'): number {
    if (!this.enter()) return this.s.length;
    try {
      for (;;) {
        i = this.skip(i, 'lines');
        const c = this.at(i);
        if (c === '') {
          this.fail(`a "${closer === ')' ? '(' : closer === ']' ? '[' : '{'}" is never closed`);
          return i;
        }
        if (c === closer) return i + 1;
        if (c === ')' || c === ']' || c === '}') {
          this.fail(`"${c}" closes what "${closer}" should have`);
          return this.s.length;
        }
        const nested = this.nested(i, 'expression');
        if (nested !== null) {
          i = nested;
          continue;
        }
        i += 1;
      }
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * The constructs that read the same wherever they appear: strings, here-strings, subexpressions,
   * arrays, hashtables, script blocks, brackets. Returns the index past the construct, or null
   * when none starts at `i`. `mode` decides what a plain `( )` is: in command mode an argument that
   * holds statements, in expression mode a call's arguments when it follows a member name and a
   * grouping (statements) otherwise.
   */
  private nested(i: number, mode: 'statements' | 'expression'): number | null {
    const c = this.at(i);
    const n = this.at(i + 1);
    if (isSingleQuote(c)) return this.singleQuoted(i).end;
    if (isDoubleQuote(c)) return this.doubleQuoted(i).end;
    if (c === '@' && (isSingleQuote(n) || isDoubleQuote(n))) return this.hereString(i);
    if (c === '@' && n === '(') return this.statements(i + 2, ')');
    if (c === '@' && n === '{') return this.statements(i + 2, '}', 'hashtable');
    if (c === '$' && n === '(') return this.statements(i + 2, ')');
    if (c === '$' && n === '{') {
      const close = this.s.indexOf('}', i + 2);
      if (close < 0) {
        this.fail('a ${ variable name is never closed');
        return this.s.length;
      }
      return close + 1;
    }
    if (c === '{') return this.statements(i + 1, '}');
    if (c === '(') return mode === 'expression' && this.isCallParen(i) ? this.expressionList(i + 1, ')') : this.statements(i + 1, ')');
    if (c === '[' && mode === 'expression') return this.expressionList(i + 1, ']');
    return null;
  }

  /**
   * Whether the `(` at `i` opens a call's arguments: it follows a name directly, and the name
   * follows `.` or `::` (a method: `$p.Replace(`, `[regex]::Match(`) or `[` (an attribute or a
   * generic: `[Parameter(Mandatory)]`). `-not(` and `-join(` are operators followed by a
   * grouping, and read as one.
   */
  private isCallParen(i: number): boolean {
    let j = i - 1;
    while (j >= 0 && isIdent(this.at(j))) j -= 1;
    if (j === i - 1) return false;
    const before = this.at(j);
    return before === '.' || before === ':' || before === '[';
  }

  /** A redirection at `i` (`>`, `>>`, `2>`, `2>&1`, `*>&1`), or `i` when there is none. */
  private redirection(i: number): number {
    const m = /^(?:[1-6*]?>>?(?:&[1-6])?)/.exec(this.s.slice(i, i + 5));
    return m ? i + m[0].length : i;
  }

  /** A bare word, with the quoted parts and escapes inside it resolved. */
  private readWord(i: number): Word {
    let literal = '';
    let dynamic = false;
    let j = i;
    while (j < this.s.length) {
      const c = this.at(j);
      if (c === '`') {
        const n = this.at(j + 1);
        if (n === '' || n === '\n' || n === '\r') break;
        literal += n;
        j += 2;
        continue;
      }
      if (isSingleQuote(c)) {
        const q = this.singleQuoted(j);
        literal += q.literal;
        j = q.end;
        continue;
      }
      if (isDoubleQuote(c)) {
        const q = this.doubleQuoted(j);
        literal += q.literal;
        dynamic ||= q.dynamic;
        j = q.end;
        continue;
      }
      if (c === '$') {
        dynamic = true;
        const n = this.at(j + 1);
        if (n === '(') {
          j = this.statements(j + 2, ')');
          continue;
        }
        if (n === '{') {
          const close = this.s.indexOf('}', j + 2);
          j = close < 0 ? this.s.length : close + 1;
          continue;
        }
        literal += c;
        j += 1;
        continue;
      }
      if (isSpace(c) || WORD_BREAK.has(c)) break;
      literal += c;
      j += 1;
    }
    return { literal, end: j, dynamic };
  }

  /** `'...'`, where `''` is a quote. Literal: nothing inside expands. */
  private singleQuoted(i: number): { literal: string; end: number } {
    let literal = '';
    let j = i + 1;
    while (j < this.s.length) {
      const c = this.at(j);
      if (isSingleQuote(c)) {
        if (isSingleQuote(this.at(j + 1))) {
          literal += "'";
          j += 2;
          continue;
        }
        return { literal, end: j + 1 };
      }
      literal += c;
      j += 1;
    }
    this.fail('a single-quoted string is never closed');
    return { literal, end: this.s.length };
  }

  /**
   * `"..."`, where a back-tick escapes and `""` is a quote. A `$( )` inside runs, so it is read as
   * statements; a variable inside makes the text dynamic.
   */
  private doubleQuoted(i: number): { literal: string; end: number; dynamic: boolean } {
    let literal = '';
    let dynamic = false;
    let j = i + 1;
    while (j < this.s.length) {
      const c = this.at(j);
      if (c === '`') {
        literal += this.at(j + 1);
        j += 2;
        continue;
      }
      if (isDoubleQuote(c)) {
        if (isDoubleQuote(this.at(j + 1))) {
          literal += '"';
          j += 2;
          continue;
        }
        return { literal, end: j + 1, dynamic };
      }
      if (c === '$' && this.at(j + 1) === '(') {
        dynamic = true;
        j = this.statements(j + 2, ')');
        continue;
      }
      if (c === '$' && /[A-Za-z_{:?]/.test(this.at(j + 1))) dynamic = true;
      literal += c;
      j += 1;
    }
    this.fail('a double-quoted string is never closed');
    return { literal, end: this.s.length, dynamic };
  }

  /**
   * `@'...'@` and `@"..."@`: the header ends its line, the body runs to a line that begins with
   * the closing quote and `@`. A double-quoted one expands, so its `$( )` are read as statements.
   */
  private hereString(i: number): number {
    const quote = this.at(i + 1);
    const double = isDoubleQuote(quote);
    let j = i + 2;
    while (isSpace(this.at(j))) j += 1;
    if (this.at(j) !== '\n') {
      this.fail('a here-string header must end its line');
      return this.s.length;
    }
    const closing = new RegExp(`\\n[${double ? '"\u201c\u201d\u201e' : "'\u2018\u2019\u201a\u201b"}]@`, 'g');
    closing.lastIndex = j;
    const m = closing.exec(this.s);
    if (!m) {
      this.fail('a here-string is never closed');
      return this.s.length;
    }
    const bodyEnd = m.index;
    if (double) {
      let k = j + 1;
      while (k < bodyEnd) {
        if (this.at(k) === '`') {
          k += 2;
          continue;
        }
        if (this.at(k) === '$' && this.at(k + 1) === '(') {
          k = this.statements(k + 2, ')');
          if (k > bodyEnd) {
            this.fail('a $( ) inside a here-string runs past its end');
            return this.s.length;
          }
          continue;
        }
        k += 1;
      }
    }
    return bodyEnd + m[0].length;
  }

  /**
   * The rest of a statement that began with a keyword: conditions and parameter blocks are
   * statements, blocks are statements, and the bare words between them — `else`, flags, labels,
   * the name after `function` — are not commands.
   */
  private keywordRest(i: number): number {
    for (;;) {
      i = this.skip(i);
      const c = this.at(i);
      if (isTerminator(c)) return i;
      if (c === '(') {
        i = this.statements(i + 1, ')');
        continue;
      }
      const nested = this.nested(i, 'expression');
      if (nested !== null) {
        i = nested;
        continue;
      }
      const word = this.readWord(i);
      i = word.end > i ? word.end : i + 1;
    }
  }

  /** `switch [-flags] (value) { clause { block } ... }`. */
  private switchStatement(i: number): number {
    for (;;) {
      i = this.skip(i, 'lines');
      const c = this.at(i);
      if (isTerminator(c)) return i;
      if (c === '(') {
        i = this.statements(i + 1, ')');
        continue;
      }
      if (c === '{') return this.statements(i + 1, '}', 'switch');
      const nested = this.nested(i, 'expression');
      if (nested !== null) {
        i = nested;
        continue;
      }
      const word = this.readWord(i);
      i = word.end > i ? word.end : i + 1;
    }
  }

  /** One clause of a switch: a condition (a value, a word, or a script block) and its block. */
  private switchClause(i: number): number {
    i = this.skip(i);
    if (this.at(i) === '{') {
      i = this.statements(i + 1, '}');
    } else {
      for (;;) {
        i = this.skip(i);
        const c = this.at(i);
        if (c === '{' || isTerminator(c)) break;
        const nested = this.nested(i, 'expression');
        if (nested !== null) {
          i = nested;
          continue;
        }
        const word = this.readWord(i);
        i = word.end > i ? word.end : i + 1;
      }
    }
    i = this.skip(i, 'lines');
    return this.at(i) === '{' ? this.statements(i + 1, '}') : i;
  }

  /** `class Name : Base { members }` and `enum Name { A; B }`: the body is members, not statements. */
  private typeDefinition(i: number): number {
    for (;;) {
      i = this.skip(i, 'lines');
      const c = this.at(i);
      if (isTerminator(c)) return i;
      if (c === '{') return this.expressionList(i + 1, '}');
      const word = this.readWord(i);
      i = word.end > i ? word.end : i + 1;
    }
  }

  /** One `key = value` of a hashtable. The key is data; the value is a statement. */
  private hashEntry(i: number): number {
    for (;;) {
      i = this.skip(i);
      const c = this.at(i);
      if (c === '=') return this.pipeline(i + 1);
      if (isTerminator(c)) return i;
      const nested = this.nested(i, 'expression');
      if (nested !== null) {
        i = nested;
        continue;
      }
      i += 1;
    }
  }
}

// ------------------------------------------------------------------------------------------
// cmd
// ------------------------------------------------------------------------------------------

/**
 * `cmd`'s rules, which are few: `"` quotes, `^` escapes, `&`, `&&`, `||`, `|` and newlines
 * separate commands, and `(` groups only where a command could start or after `if`/`for ... do`/
 * `else` — elsewhere, as in `echo (done)`, it is text. `rem` and `::` are comments; `call` runs
 * the word after it; `if` and `for` are read past their conditions to the command they guard.
 * A variable (`%x%`, `!x!`) in a command's name is a name known only at run time.
 */
function scanCmd(src: string): HeadScan {
  const heads: string[] = [];
  let uncertain: string | undefined;
  const fail = (why: string): void => {
    uncertain ??= why;
  };

  const segments: string[] = [];
  let current = '';
  let quoted = false;
  let groups = 0;
  const atCommandStart = (): boolean => /^\s*@?\s*$/.test(current) || /^\s*@?\s*(?:if\b.*|for\b.*\bdo|else)\s*$/i.test(current);
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '^') {
      current += src[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      current += c;
      continue;
    }
    // `2>&1`: the `&` of a redirection names a stream, it does not separate commands.
    if (c === '&' && (current.endsWith('>') || current.endsWith('<'))) {
      current += c;
      continue;
    }
    if (c === '&' || c === '|' || c === '\n') {
      if (src[i + 1] === c) i += 1;
      segments.push(current);
      current = '';
      continue;
    }
    if (c === '(' && atCommandStart()) {
      groups += 1;
      segments.push(current);
      current = '';
      continue;
    }
    if (c === ')' && groups > 0) {
      groups -= 1;
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  segments.push(current);
  if (quoted) fail('a double-quoted string is never closed');
  if (groups > 0) fail('a "(" is never closed');

  for (const segment of segments) {
    let tokens: string[] = segment.replace(/^\s*@/, '').match(/"[^"]*"|\S+/g) ?? [];
    // Redirections are not the command: `>nul`, `2>&1`, `<in.txt`, with or without a space.
    tokens = tokens.filter((t, k) => !/^\d?[<>]/.test(t) && !(k > 0 && /^\d?[<>]>?$/.test(tokens[k - 1]!)));
    let k = 0;
    const word = (): string => (tokens[k] ?? '').toLowerCase();
    if (word() === 'rem' || word().startsWith('::')) continue;
    if (word() === 'else') k += 1;
    if (word() === 'if') {
      k += 1;
      if (word() === '/i') k += 1;
      if (word() === 'not') k += 1;
      if (word() === 'exist' || word() === 'defined' || word() === 'errorlevel') k += 2;
      else if (tokens[k]?.includes('==')) k += 1;
      else k += 3; // a EQU b
    } else if (word() === 'for') {
      const doAt = tokens.findIndex((t) => t.toLowerCase() === 'do');
      k = doAt < 0 ? tokens.length : doAt + 1;
    }
    if (word() === 'call') k += 1;
    const head = tokens[k];
    if (!head || head.startsWith(':')) continue;
    const literal = head.replace(/"/g, '');
    if (/%[^%\s]+%|![^!\s]+!/.test(literal)) {
      fail(`the command "${literal}" is built from a variable, so which program it starts is known only when it runs`);
      continue;
    }
    heads.push(literal);
  }
  return uncertain ? { heads, uncertain } : { heads };
}
