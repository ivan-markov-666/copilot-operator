/**
 * Colours for source code, as an IDE's editor shows it (2026-10-20: "a colorizer for the different programming
 * languages, with automatic recognition, at least by the file's extension"). No library: a small scanner per family of
 * languages — the C-like ones, the hash-commented ones, markup, style sheets, JSON, YAML, Markdown, SQL, INI — which
 * knows each language's comments, strings, numbers and keywords. That is what the eye needs from colour; a parser
 * that knows the grammar would add little and weigh a great deal.
 *
 * The language is found from the file's extension, its name (Dockerfile, Makefile), its first line (`#!/usr/bin/env
 * python`) and, last, what it starts with (`{`, `<?xml`). The result is HTML with every character escaped, so it can be
 * put into the page as it is.
 */

export type LangId =
  | 'plain' | 'typescript' | 'javascript' | 'json' | 'css' | 'scss' | 'html' | 'xml' | 'markdown' | 'powershell'
  | 'python' | 'csharp' | 'java' | 'kotlin' | 'go' | 'rust' | 'c' | 'cpp' | 'shell' | 'batch' | 'yaml' | 'sql'
  | 'php' | 'ruby' | 'ini' | 'toml' | 'dockerfile' | 'makefile' | 'swift' | 'dart' | 'lua' | 'vue';

/** The languages the editor offers by name, in the order of its menu. */
export const LANGUAGES: Array<{ id: LangId; name: string }> = [
  { id: 'plain', name: 'Plain text' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'json', name: 'JSON' },
  { id: 'html', name: 'HTML' },
  { id: 'xml', name: 'XML' },
  { id: 'css', name: 'CSS' },
  { id: 'scss', name: 'SCSS' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'powershell', name: 'PowerShell' },
  { id: 'batch', name: 'Batch (cmd)' },
  { id: 'shell', name: 'Shell' },
  { id: 'python', name: 'Python' },
  { id: 'csharp', name: 'C#' },
  { id: 'java', name: 'Java' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'go', name: 'Go' },
  { id: 'rust', name: 'Rust' },
  { id: 'c', name: 'C' },
  { id: 'cpp', name: 'C++' },
  { id: 'swift', name: 'Swift' },
  { id: 'dart', name: 'Dart' },
  { id: 'php', name: 'PHP' },
  { id: 'ruby', name: 'Ruby' },
  { id: 'lua', name: 'Lua' },
  { id: 'sql', name: 'SQL' },
  { id: 'yaml', name: 'YAML' },
  { id: 'toml', name: 'TOML' },
  { id: 'ini', name: 'INI / config' },
  { id: 'dockerfile', name: 'Dockerfile' },
  { id: 'makefile', name: 'Makefile' },
  { id: 'vue', name: 'Vue' },
];

const BY_EXTENSION: Record<string, LangId> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', har: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  html: 'html', htm: 'html', xhtml: 'html', svelte: 'html', vue: 'vue',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', config: 'xml', resx: 'xml', plist: 'xml', vbproj: 'xml', fsproj: 'xml', nuspec: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'batch', cmd: 'batch',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  py: 'python', pyw: 'python', pyi: 'python',
  cs: 'csharp', csx: 'csharp',
  java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'kotlin',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  swift: 'swift', dart: 'dart', php: 'php', rb: 'ruby', lua: 'lua',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini', gitconfig: 'ini', npmrc: 'ini',
  dockerfile: 'dockerfile', mk: 'makefile',
};

const BY_NAME: Record<string, LangId> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  '.gitignore': 'shell', '.gitattributes': 'shell', '.dockerignore': 'shell', '.npmignore': 'shell', '.prettierignore': 'shell', '.eslintignore': 'shell',
  '.env': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.gitconfig': 'ini', '.babelrc': 'json', '.prettierrc': 'json', '.eslintrc': 'json',
  'tsconfig.json': 'json', 'package.json': 'json', 'gemfile': 'ruby', 'rakefile': 'ruby', 'jenkinsfile': 'java',
};

/** The language of a file: by its name, its extension, its first line, and last what it starts with. */
export function detectLanguage(path: string, text = ''): LangId {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('.env.')) return 'ini';
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && BY_EXTENSION[name.slice(dot + 1)]) return BY_EXTENSION[name.slice(dot + 1)];
  const first = text.slice(0, 200).split(/\r?\n/)[0] ?? '';
  const shebang = /^#!.*\b(python\d?|node|deno|bun|bash|sh|zsh|pwsh|powershell|ruby|php|lua)\b/.exec(first);
  if (shebang) {
    const prog = shebang[1]!;
    if (prog.startsWith('python')) return 'python';
    if (prog === 'node' || prog === 'deno' || prog === 'bun') return 'javascript';
    if (prog === 'pwsh' || prog === 'powershell') return 'powershell';
    if (prog === 'ruby') return 'ruby';
    if (prog === 'php') return 'php';
    if (prog === 'lua') return 'lua';
    return 'shell';
  }
  const start = text.trimStart().slice(0, 100);
  if (/^<\?xml\b/.test(start)) return 'xml';
  if (/^<!doctype html|^<html\b/i.test(start)) return 'html';
  if (/^[{[]/.test(start)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      /* not JSON after all */
    }
  }
  return 'plain';
}

export function languageName(id: LangId): string {
  return LANGUAGES.find((l) => l.id === id)?.name ?? id;
}

// --- the scanners --------------------------------------------------------------------------------

type Tok = 'com' | 'str' | 'num' | 'kw' | 'type' | 'lit' | 'fn' | 'tag' | 'attr' | 'prop' | 'meta' | 'var' | 'head' | 'em' | 'code' | 'link' | 'op';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (t: Tok, s: string): string => `<span class="hl-${t}">${esc(s)}</span>`;

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

type CLike = {
  line?: string[];
  block?: Array<[string, string]>;
  quotes: string[];
  /** Quotes in which a newline does not end the string. */
  multiline?: string[];
  keywords: Set<string>;
  types?: Set<string>;
  literals?: Set<string>;
  caseless?: boolean;
  /** `$name` and `@name` and the like are variables or annotations. */
  sigil?: RegExp;
  /** A word followed by `(` is a function. */
  calls?: boolean;
};

const JS_KW = words(`break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set as satisfies`);
const TS_KW = new Set([...JS_KW, ...words(`interface type enum implements namespace module declare abstract private protected public readonly keyof infer is asserts override accessor unique`)]);
const TS_TYPES = words(`string number boolean bigint symbol object unknown any never void undefined Record Partial Required Readonly Pick Omit Promise Array Map Set Date Error RegExp`);
const LITS = words(`true false null undefined NaN Infinity`);

const SPECS: Partial<Record<LangId, CLike>> = {
  typescript: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'], multiline: ['`'], keywords: TS_KW, types: TS_TYPES, literals: LITS, calls: true, sigil: /^@[A-Za-z_]\w*/ },
  javascript: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'], multiline: ['`'], keywords: JS_KW, literals: LITS, calls: true },
  csharp: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false null'),
    keywords: words(`abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var record init required get set value where yield partial`),
    types: words(`bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic Task List Dictionary`),
  },
  java: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false null'),
    keywords: words(`abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield`),
    types: words(`boolean byte char double float int long short void String Object List Map Integer`), sigil: /^@[A-Za-z_]\w*/,
  },
  kotlin: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false null'),
    keywords: words(`as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg`),
    types: words(`Int Long Short Byte Double Float Boolean Char String Unit Any Nothing List Map Set`), sigil: /^@[A-Za-z_]\w*/,
  },
  go: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'], multiline: ['`'], calls: true, literals: words('true false nil iota'),
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var`),
    types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any`),
  },
  rust: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"'], calls: true, literals: words('true false None Some Ok Err'),
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while`),
    types: words(`bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box`), sigil: /^#!?\[[^\]]*\]/,
  },
  c: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false NULL'),
    keywords: words(`auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while`),
    types: words(`char double float int long short signed unsigned void size_t bool`), sigil: /^#\s*\w+/,
  },
  cpp: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false nullptr NULL'),
    keywords: words(`alignas alignof and asm auto break case catch class const constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept not operator or private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while override final concept requires co_await co_return co_yield`),
    types: words(`bool char double float int long short signed unsigned void wchar_t size_t string vector map std`), sigil: /^#\s*\w+/,
  },
  swift: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"'], calls: true, literals: words('true false nil'),
    keywords: words(`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is self Self super throw throws try async await some any`),
    types: words(`Int Double Float Bool String Character Array Dictionary Set Optional Void`), sigil: /^@[A-Za-z_]\w*/,
  },
  dart: {
    line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, literals: words('true false null'),
    keywords: words(`abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get hide if implements import in interface is late library mixin new on operator part required rethrow return set show static super switch sync this throw try typedef var void while with yield`),
    types: words(`int double num bool String List Map Set Future Stream Object`), sigil: /^@[A-Za-z_]\w*/,
  },
  php: {
    line: ['//', '#'], block: [['/*', '*/']], quotes: ['"', "'"], calls: true, caseless: true, literals: words('true false null'),
    keywords: words(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield`),
    sigil: /^\$[A-Za-z_]\w*/,
  },
  lua: {
    line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"], calls: true, literals: words('true false nil'),
    keywords: words(`and break do else elseif end for function goto if in local not or repeat return then until while`),
  },
  powershell: {
    line: ['#'], block: [['<#', '#>']], quotes: ['"', "'"], multiline: ['"', "'"], caseless: true, calls: false, literals: words('$true $false $null'),
    keywords: words(`begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in inlinescript param process return sequence static switch throw trap try until using var while workflow -and -or -not -xor -eq -ne -gt -ge -lt -le -like -notlike -match -notmatch -contains -notcontains -in -notin -replace -split -join -is -isnot -as -band -bor -f`),
    sigil: /^\$(?:\{[^}]*\}|[A-Za-z_][\w:]*|[?^$_])/,
  },
  python: {
    line: ['#'], quotes: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], calls: true, literals: words('True False None'),
    keywords: words(`and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case`),
    types: words(`int float str bool list dict set tuple bytes object type self cls`), sigil: /^@[A-Za-z_][\w.]*/,
  },
  ruby: {
    line: ['#'], block: [['=begin', '=end']], quotes: ['"', "'"], calls: true, literals: words('true false nil'),
    keywords: words(`alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer`),
    sigil: /^(?:@@?|\$)[A-Za-z_]\w*|^:[A-Za-z_]\w*/,
  },
  shell: {
    line: ['#'], quotes: ['"', "'"], multiline: ['"', "'"], literals: words('true false'),
    keywords: words(`if then else elif fi case esac for select while until do done in function time coproc return exit export local readonly declare unset shift source alias echo cd`),
    sigil: /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])/,
  },
  batch: {
    line: ['REM ', 'rem ', '::'], quotes: ['"'], caseless: true,
    keywords: words(`call cd chdir cls copy del dir echo else endlocal errorlevel exist exit for goto if in md mkdir move not off on pause popd pushd rd rem ren rmdir set setlocal shift start title type`),
    sigil: /^%[^%\s]+%|^%%?[A-Za-z0-9~]/,
  },
  dockerfile: {
    line: ['#'], quotes: ['"', "'"], caseless: true,
    keywords: words(`from as run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell`),
    sigil: /^\$(?:\{[^}]*\}|[A-Za-z_]\w*)/,
  },
  makefile: {
    line: ['#'], quotes: ['"', "'"],
    keywords: words(`ifeq ifneq ifdef ifndef else endif include define endef export override .PHONY`),
    sigil: /^\$(?:\([^)]*\)|\{[^}]*\}|[@<^*?%])/,
  },
  sql: {
    line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], caseless: true, calls: true, literals: words('true false null'),
    keywords: words(`select from where and or not insert into values update set delete create table view index drop alter add column primary key foreign references join left right inner outer full on as group by order having limit offset union all distinct case when then else end exists in is like between with returning begin commit rollback transaction grant revoke default constraint unique check if replace truncate procedure function trigger declare`),
    types: words(`int integer bigint smallint decimal numeric float real double varchar char text date time timestamp boolean bool uuid json jsonb blob`),
  },
};

/** A scanner for the C-like and hash-commented languages, driven by their spec. */
function scanCode(text: string, spec: CLike): string {
  let out = '';
  let i = 0;
  const n = text.length;
  const starts = (s: string): boolean => (spec.caseless ? text.substr(i, s.length).toLowerCase() === s.toLowerCase() : text.startsWith(s, i));
  const quotes = [...spec.quotes].sort((a, b) => b.length - a.length);
  while (i < n) {
    const ch = text[i]!;
    // Comments
    const block = spec.block?.find(([open]) => starts(open));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? n : end + block[1].length;
      out += wrap('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    const line = spec.line?.find((l) => starts(l));
    if (line) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += wrap('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    // Strings
    const q = quotes.find((x) => text.startsWith(x, i));
    if (q) {
      let j = i + q.length;
      const multi = spec.multiline?.includes(q);
      // A backslash escapes, except where the language has no such escape: PowerShell and cmd, and the single quotes of a shell or SQL.
      const escapes = !(spec === SPECS.powershell || spec === SPECS.batch || ((spec === SPECS.shell || spec === SPECS.sql) && q === "'"));
      while (j < n) {
        if (text[j] === '\\' && escapes) {
          j += 2;
          continue;
        }
        if (text.startsWith(q, j)) {
          j += q.length;
          break;
        }
        if (text[j] === '\n' && !multi) break;
        j += 1;
      }
      out += wrap('str', text.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }
    // Sigils: variables, annotations, preprocessor lines
    if (spec.sigil && /[$@#%:[]/.test(ch)) {
      const m = spec.sigil.exec(text.slice(i, i + 200));
      if (m) {
        const word = m[0];
        out += wrap(ch === '@' || ch === '#' || ch === '[' ? 'meta' : 'var', word);
        i += word.length;
        continue;
      }
    }
    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const prev = text[i - 1] ?? '';
      if (!/[\w$]/.test(prev)) {
        const m = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[a-zA-Z]*/.exec(text.slice(i, i + 64));
        if (m) {
          out += wrap('num', m[0]);
          i += m[0].length;
          continue;
        }
      }
    }
    // Words
    if (/[A-Za-z_$-]/.test(ch)) {
      const m = /^-?[A-Za-z_$][\w$-]*\??/.exec(text.slice(i, i + 120));
      if (m && !(m[0].startsWith('-') && !spec.caseless)) {
        let word = m[0];
        // A hyphen is part of a word only in PowerShell's operators and cmdlets.
        if (spec !== SPECS.powershell && word.includes('-')) word = word.split('-')[0] || word.slice(0, 1);
        if (!word) word = ch;
        const key = spec.caseless ? word.toLowerCase() : word;
        const kind: Tok | null = spec.literals?.has(key) ? 'lit' : spec.keywords.has(key) ? 'kw' : spec.types?.has(key) ? 'type' : null;
        if (kind) out += wrap(kind, word);
        else if (spec.calls && text[i + word.length] === '(') out += wrap('fn', word);
        else if (/^[A-Z][a-z]\w*$/.test(word) && spec.types) out += wrap('type', word);
        else if (spec === SPECS.powershell && /^[A-Z][a-z]+-[A-Z]\w*$/.test(word)) out += wrap('fn', word);
        else out += esc(word);
        i += word.length;
        continue;
      }
    }
    out += esc(ch);
    i += 1;
  }
  return out;
}

/** HTML, XML, SVG: comments, tags, attributes and their values, and, inside HTML, script and style. */
function scanMarkup(text: string, html: boolean): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      out += wrap('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      const stop = end < 0 ? n : end + 3;
      out += wrap('str', text.slice(i, stop));
      i = stop;
      continue;
    }
    const m = /^<\/?[A-Za-z!?][\w:.-]*/.exec(text.slice(i, i + 100));
    if (m) {
      const tag = m[0];
      out += wrap(tag.startsWith('<!') || tag.startsWith('<?') ? 'meta' : 'tag', tag);
      i += tag.length;
      // Attributes up to the end of the tag.
      while (i < n && text[i] !== '>') {
        const a = /^[\s/?]+/.exec(text.slice(i, i + 50));
        if (a) {
          out += esc(a[0]);
          i += a[0].length;
          continue;
        }
        if (text[i] === '"' || text[i] === "'") {
          const end = text.indexOf(text[i]!, i + 1);
          const stop = end < 0 ? n : end + 1;
          out += wrap('str', text.slice(i, stop));
          i = stop;
          continue;
        }
        const name = /^[^\s=>/"']+/.exec(text.slice(i, i + 100));
        if (name) {
          out += wrap('attr', name[0]);
          i += name[0].length;
          continue;
        }
        out += esc(text[i]!);
        i += 1;
      }
      if (i < n) {
        out += wrap('tag', '>');
        i += 1;
      }
      // An HTML script or style element: its body in its own language.
      const lower = tag.toLowerCase();
      if (html && (lower === '<script' || lower === '<style')) {
        const close = lower === '<script' ? '</script' : '</style';
        const end = text.toLowerCase().indexOf(close, i);
        const stop = end < 0 ? n : end;
        const body = text.slice(i, stop);
        out += lower === '<script' ? scanCode(body, SPECS.javascript!) : scanStyle(body, false);
        i = stop;
      }
      continue;
    }
    if (text[i] === '&') {
      const e = /^&[#\w]+;/.exec(text.slice(i, i + 12));
      if (e) {
        out += wrap('lit', e[0]);
        i += e[0].length;
        continue;
      }
    }
    // Text up to the next tag.
    const next = text.indexOf('<', i + 1);
    const amp = text.indexOf('&', i + 1);
    const stop = Math.min(next < 0 ? n : next, amp < 0 ? n : amp);
    out += esc(text.slice(i, stop));
    i = stop;
  }
  return out;
}

/** CSS and its relatives: comments, at-rules, properties, values with their units, colours, strings. */
function scanStyle(text: string, scss: boolean): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let depth = 0;
  let inValue = false;
  while (i < n) {
    const ch = text[i]!;
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += wrap('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (scss && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += wrap('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += wrap('str', text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '@') {
      const m = /^@[\w-]+/.exec(text.slice(i, i + 40));
      if (m) {
        out += wrap('kw', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '$' && scss) {
      const m = /^\$[\w-]+/.exec(text.slice(i, i + 60));
      if (m) {
        out += wrap('var', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      inValue = false;
    }
    if (ch === ';') inValue = false;
    if (ch === ':' && depth > 0) {
      out += esc(ch);
      i += 1;
      inValue = true;
      continue;
    }
    if (ch === '#' && inValue) {
      const m = /^#[\da-fA-F]{3,8}\b/.exec(text.slice(i, i + 12));
      if (m) {
        out += wrap('num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[\d.]/.test(ch) && inValue && !/[\w-]/.test(text[i - 1] ?? '')) {
      const m = /^-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/.exec(text.slice(i, i + 20));
      if (m) {
        out += wrap('num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_-]/.test(ch)) {
      const m = /^-?-?[A-Za-z_][\w-]*/.exec(text.slice(i, i + 80));
      if (m) {
        const word = m[0];
        const isProp = depth > 0 && !inValue && /^\s*:/.test(text.slice(i + word.length, i + word.length + 10));
        out += isProp ? wrap('prop', word) : inValue ? (/^(important|inherit|initial|unset|none|auto)$/.test(word) ? wrap('lit', word) : text[i + word.length] === '(' ? wrap('fn', word) : esc(word)) : wrap('tag', word);
        i += word.length;
        continue;
      }
    }
    out += esc(ch);
    i += 1;
  }
  return out;
}

/** JSON: the keys apart from the values. */
function scanJson(text: string): string {
  return text.replace(/("(?:[^"\\\n]|\\.)*")(\s*:)?|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[&<>]/g, (m, str: string | undefined, colon: string | undefined, lit: string | undefined) => {
    if (str !== undefined) return colon ? wrap('prop', str) + esc(colon) : wrap('str', str);
    if (m.startsWith('//') || m.startsWith('/*')) return wrap('com', m);
    if (lit) return wrap('lit', m);
    if (/^[&<>]$/.test(m)) return esc(m);
    return wrap('num', m);
  });
}

/** YAML: comments, keys, strings, anchors, scalars that mean something. */
function scanYaml(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:- )?)([^#:'"\n][^:#\n]*?)(:)(\s|$)(.*)$/.exec(line);
      const rest = (s: string): string =>
        s.replace(/(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|(\b(?:true|false|null|yes|no|on|off|~)\b)|(-?\b\d+(?:\.\d+)?\b)|([&*][\w-]+)|([&<>])/gi, (x, com, str, lit, num, anchor, special) =>
          com ? wrap('com', com) : str ? wrap('str', str) : lit ? wrap('lit', lit) : num ? wrap('num', num) : anchor ? wrap('var', anchor) : special ? esc(special) : esc(x),
        );
      if (/^\s*#/.test(line)) return wrap('com', line);
      if (/^\s*---|^\s*\.\.\./.test(line)) return wrap('meta', line);
      if (m) return esc(m[1]!) + wrap('prop', m[2]!) + esc(m[3]!) + esc(m[4]!) + rest(m[5]!);
      return rest(line);
    })
    .join('\n');
}

/** INI, TOML, .env: sections, keys, values, comments. */
function scanIni(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*[#;]/.test(line)) return wrap('com', line);
      const sec = /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line);
      if (sec) return esc(sec[1]!) + wrap('head', sec[2]!) + esc(sec[3]!);
      const kv = /^(\s*)([^=:\s][^=:]*?)(\s*[=:]\s*)(.*)$/.exec(line);
      if (kv) {
        const v = kv[4]!;
        const value = /^(".*"|'.*')$/.test(v.trim()) ? wrap('str', v) : /^-?\d+(\.\d+)?$/.test(v.trim()) ? wrap('num', v) : /^(true|false|yes|no|on|off)$/i.test(v.trim()) ? wrap('lit', v) : esc(v);
        return esc(kv[1]!) + wrap('prop', kv[2]!) + esc(kv[3]!) + value;
      }
      return esc(line);
    })
    .join('\n');
}

/** Markdown: headings, emphasis, code, links, quotes and list marks; a fenced block in its own language. */
function scanMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: { mark: string; lang: LangId; body: string[] } | null = null;
  for (const line of lines) {
    if (fence) {
      if (line.trimStart().startsWith(fence.mark)) {
        out.push(fence.body.length ? highlight(fence.body.join('\n'), fence.lang) : '');
        out.push(wrap('code', line));
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const open = /^(\s*)(```+|~~~+)\s*([\w+#-]*)/.exec(line);
    if (open) {
      const lang = open[3] ? (BY_EXTENSION[open[3].toLowerCase()] ?? (LANGUAGES.find((l) => l.name.toLowerCase() === open[3]!.toLowerCase())?.id ?? 'plain')) : 'plain';
      fence = { mark: open[2]!, lang, body: [] };
      out.push(wrap('code', line));
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      out.push(wrap('head', line));
      continue;
    }
    if (/^\s*>/.test(line)) {
      out.push(wrap('com', line));
      continue;
    }
    let html = esc(line);
    html = html
      .replace(/^(\s*)([-*+]|\d+[.)])(\s)/, (_m, a: string, b: string, c: string) => `${a}<span class="hl-kw">${b}</span>${c}`)
      .replace(/(`+)([^`]+?)\1/g, (m) => `<span class="hl-code">${m}</span>`)
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (m) => `<span class="hl-head">${m}</span>`)
      .replace(/(^|[^*\w])(\*|_)(?=\S)(.+?)(?<=\S)\2(?!\w)/g, (_m, pre: string, mark: string, body: string) => `${pre}<span class="hl-em">${mark}${body}${mark}</span>`)
      .replace(/(!?\[[^\]]*\])(\([^)]*\))/g, (_m, label: string, href: string) => `<span class="hl-str">${label}</span><span class="hl-link">${href}</span>`);
    out.push(html);
  }
  if (fence) out.push(highlight(fence.body.join('\n'), fence.lang));
  return out.join('\n');
}

/** A Vue single-file component: markup, with its script and style in their languages. */
function scanVue(text: string): string {
  return scanMarkup(text, true);
}

/** The text as HTML, every character escaped, with the parts that mean something in a span of their kind. */
export function highlight(text: string, lang: LangId): string {
  switch (lang) {
    case 'plain':
      return esc(text);
    case 'json':
      return scanJson(text);
    case 'html':
      return scanMarkup(text, true);
    case 'xml':
      return scanMarkup(text, false);
    case 'vue':
      return scanVue(text);
    case 'css':
      return scanStyle(text, false);
    case 'scss':
      return scanStyle(text, true);
    case 'yaml':
      return scanYaml(text);
    case 'ini':
    case 'toml':
      return scanIni(text);
    case 'markdown':
      return scanMarkdown(text);
    default: {
      const spec = SPECS[lang];
      return spec ? scanCode(text, spec) : esc(text);
    }
  }
}
