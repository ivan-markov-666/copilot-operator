'use client';

/**
 * A Markdown file as it reads, as VS Code's preview shows it (operator, 2026-10-21: "let .md files be seen formatted,
 * not as text; and support for the mermaid diagrams written straight in them").
 *
 * Written here rather than taken from a package: headings, paragraphs, emphasis, strike-through, code inline and in
 * blocks (coloured by its language), quotes, lists with their nesting and task boxes, tables with their alignment,
 * rules, links and pictures. A ```mermaid block is drawn as its diagram by the `mermaid` package, loaded only when a
 * page has one, in the theme's colours, with its strict security (no script, no click handler in a diagram).
 *
 * What it will not do, and why: HTML written in the file is shown as text, not run; a picture from the internet is not
 * fetched (the page loads nothing from outside) — its link is shown instead; a picture of the folder is shown through
 * the API, which serves only pictures. A link to another file of the folder opens it in the editor.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { API } from '../../lib/api';
import { highlight, type LangId, LANGUAGES } from '../../lib/highlight';
import { useT } from '../../lib/i18n';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ blocks: Block[]; task?: boolean; done?: boolean }> }
  | { kind: 'table'; head: string[]; align: Array<'left' | 'center' | 'right' | ''>; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'html'; text: string };

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** The blocks of a Markdown text, by CommonMark's main rules, enough for a project's documents. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isBlank = (l: string | undefined): boolean => l === undefined || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(mark[0]!.repeat(mark.length))) body.push(lines[i++]!);
      i += 1;
      out.push({ kind: 'code', lang: (fence[3] ?? '').toLowerCase(), text: body.join('\n') });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (/^\s{0,3}>/.test(lines[i]!) || body.length > 0)) {
        if (!/^\s{0,3}>/.test(lines[i]!) && (FENCE.test(lines[i]!) || LIST.test(lines[i]!))) break;
        body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      out.push({ kind: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    // A table: a row of cells, then the row that says how they align.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const cells = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '') as 'left' | 'center' | 'right' | '');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i]!.includes('|')) rows.push(cells(lines[i++]!));
      out.push({ kind: 'table', head, align, rows });
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      const indent = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const items: Array<{ blocks: Block[]; task?: boolean; done?: boolean }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
        const body = [m[3]!];
        i += 1;
        // The item goes on while lines are indented under it, blank lines between them included.
        while (i < lines.length) {
          const next = lines[i]!;
          const inner = LIST.exec(next);
          if (isBlank(next)) {
            if (i + 1 < lines.length && (lines[i + 1]!.match(/^\s*/)?.[0].length ?? 0) > indent && !isBlank(lines[i + 1])) {
              body.push('');
              i += 1;
              continue;
            }
            break;
          }
          if (inner && inner[1]!.length <= indent) break;
          const lead = next.match(/^\s*/)?.[0].length ?? 0;
          if (lead <= indent && !inner && /^\s{0,3}(#|>|```|~~~)/.test(next)) break;
          body.push(lead > indent ? next.slice(Math.min(lead, indent + 2 + (ordered ? 1 : 0))) : next.trim());
          i += 1;
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0]!);
        if (task) body[0] = body[0]!.slice(task[0].length);
        items.push({ blocks: parseBlocks(body.join('\n')), ...(task ? { task: true, done: task[1] !== ' ' } : {}) });
        while (i < lines.length && isBlank(lines[i]) && LIST.exec(lines[i + 1] ?? '')?.[1]?.length === indent) i += 1;
      }
      out.push({ kind: 'list', ordered, start: ordered ? parseInt(item[2]!, 10) : 1, items });
      continue;
    }
    if (/^\s{0,3}<[a-zA-Z!/]/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]!);
      out.push({ kind: 'html', text: body.join('\n') });
      continue;
    }
    // A paragraph, which a line of === or --- under it makes a heading.
    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !FENCE.test(lines[i]!) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]!) && !(body.length > 0 && LIST.test(lines[i]!))) {
      if (body.length > 0 && /^\s{0,3}(=+|-+)\s*$/.test(lines[i]!)) {
        out.push({ kind: 'heading', level: lines[i]!.trim().startsWith('=') ? 1 : 2, text: body.join(' ') });
        body.length = 0;
        i += 1;
        break;
      }
      body.push(lines[i++]!);
    }
    if (body.length > 0) out.push({ kind: 'para', text: body.join('\n') });
  }
  return out;
}

/** A heading's anchor, as GitHub and VS Code make one. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

type Ctx = { dir: string; onOpenFile: (path: string) => void; t: ReturnType<typeof useT>['t'] };

/** A path of the folder from a link or a picture of the file at `dir`, or null when it leaves the folder or is not one. */
function inFolder(dir: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const clean = decodeURI(target.split('#')[0]!.split('?')[0]!);
  const parts = (clean.startsWith('/') ? clean.slice(1) : `${dir}${dir ? '/' : ''}${clean}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

/** The inline marks of a line of text: code, emphasis, strike-through, links, pictures, breaks. */
function inline(text: string, ctx: Ctx, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const k = (): string => `${key}-${n++}`;
  const patterns: Array<[RegExp, (m: RegExpExecArray) => ReactNode]> = [
    [/^\\([\\`*_{}[\]()#+\-.!|~<>])/, (m) => m[1]],
    [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => <code key={k()}>{m[2]!.replace(/^ (.*) $/, '$1')}</code>],
    [/^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)/, (m) => {
      const local = inFolder(ctx.dir, m[2]!);
      if (local === null) {
        return (
          <a key={k()} href={m[2]} target="_blank" rel="noopener noreferrer" title={ctx.t('md.externalImage', { url: m[2]! })}>
            🖼 {m[1] || m[2]}
          </a>
        );
      }
      return <img key={k()} src={`${API}/workspace/raw?path=${encodeURIComponent(local)}`} alt={m[1]} title={m[3]} loading="lazy" />;
    }],
    [/^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)/, (m) => link(m[2]!, inline(m[1]!, ctx, k()), m[3])],
    [/^<(https?:\/\/[^>\s]+)>/, (m) => link(m[1]!, [m[1]!])],
    [/^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/, (m) => link(m[1]!, [m[1]!])],
    [/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, (m) => <strong key={k()}>{inline(m[2]!, ctx, k())}</strong>],
    [/^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u, (m) => <em key={k()}>{inline(m[2]!, ctx, k())}</em>],
    [/^~~(?=\S)([\s\S]*?\S)~~/, (m) => <del key={k()}>{inline(m[1]!, ctx, k())}</del>],
    [/^( {2,}|\\)\n/, () => <br key={k()} />],
  ];
  function link(href: string, children: ReactNode[], title?: string): ReactNode {
    if (href.startsWith('#')) return <a key={k()} href={href} title={title}>{children}</a>;
    const local = inFolder(ctx.dir, href);
    if (local !== null) {
      return (
        <a
          key={k()}
          href={`#${local}`}
          title={title ?? local}
          onClick={(e) => {
            e.preventDefault();
            ctx.onOpenFile(local);
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <a key={k()} href={href} target="_blank" rel="noopener noreferrer" title={title}>
        {children}
      </a>
    );
  }
  let plain = '';
  const flush = (): void => {
    if (plain) out.push(plain);
    plain = '';
  };
  while (rest.length > 0) {
    let matched = false;
    for (const [re, make] of patterns) {
      const m = re.exec(rest);
      if (m) {
        flush();
        out.push(make(m));
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      plain += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return out;
}

/** A ```mermaid block, drawn by the package, in the theme's colours; its code and why when it cannot be drawn. */
function Mermaid({ code }: { code: string }) {
  const { t } = useT();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [problem, setProblem] = useState('');
  const [theme, setTheme] = useState('');
  useEffect(() => {
    const read = (): void => setTheme(document.documentElement.dataset.theme ?? 'light');
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!theme) return;
    let gone = false;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default', fontFamily: 'inherit' });
        const drawn = await mermaid.render(`mmd-${id}-${theme}`, code);
        if (!gone) {
          setSvg(drawn.svg);
          setProblem('');
        }
      } catch (e) {
        if (!gone) setProblem((e as Error).message.split('\n')[0] ?? String(e));
      }
    })();
    return () => {
      gone = true;
    };
  }, [code, theme, id]);
  if (problem) {
    return (
      <div className="md-mermaid bad">
        <p className="small">{t('md.mermaidError', { why: problem })}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) return <p className="md-mermaid muted small">{t('md.mermaidLoading')}</p>;
  // Drawn by mermaid in its strict mode, which cleans what it writes (no script, no handler).
  return <div className="md-mermaid" role="img" aria-label={code.split('\n')[0]} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function render(blocks: Block[], ctx: Ctx, key = 'b'): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}-${i}`;
    switch (b.kind) {
      case 'heading': {
        const H = `h${b.level}` as 'h1';
        return (
          <H key={k} id={slugOf(b.text)}>
            {inline(b.text, ctx, k)}
          </H>
        );
      }
      case 'para':
        return <p key={k}>{inline(b.text, ctx, k)}</p>;
      case 'rule':
        return <hr key={k} />;
      case 'html':
        return (
          <pre key={k} className="md-html">
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={k}>{render(b.blocks, ctx, k)}</blockquote>;
      case 'code': {
        if (b.lang === 'mermaid') return <Mermaid key={k} code={b.text} />;
        const lang = (LANGUAGES.find((l) => l.id === b.lang || l.name.toLowerCase() === b.lang)?.id ?? aliasOf(b.lang)) as LangId | undefined;
        return (
          <pre key={k} className="md-code">
            {lang ? <code dangerouslySetInnerHTML={{ __html: highlight(b.text, lang) }} /> : <code>{b.text}</code>}
          </pre>
        );
      }
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={`${k}-${j}`} className={it.task ? 'md-task' : undefined}>
            {it.task && <input type="checkbox" checked={!!it.done} disabled aria-label={it.done ? '✓' : '○'} />}
            {/* A one-paragraph item reads as its text, not as a paragraph of its own. */}
            {it.blocks.length === 1 && it.blocks[0]!.kind === 'para' ? inline((it.blocks[0] as { text: string }).text, ctx, `${k}-${j}`) : render(it.blocks, ctx, `${k}-${j}`)}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                      {inline(c, ctx, `${k}-h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, j) => (
                      <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                        {inline(r[j] ?? '', ctx, `${k}-${ri}-${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** The short names fences are written with, for the colouring. */
function aliasOf(lang: string): string | undefined {
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', pwsh: 'powershell', py: 'python', cs: 'csharp', 'c#': 'csharp', yml: 'yaml', md: 'markdown', html: 'html', xml: 'xml', json: 'json', css: 'css', sql: 'sql', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cpp: 'cpp', 'c++': 'cpp', c: 'c', bat: 'batch', cmd: 'batch', toml: 'toml', ini: 'ini', dockerfile: 'dockerfile' };
  return map[lang];
}

export function MarkdownView({ text, path, onOpenFile }: { text: string; path: string; onOpenFile: (path: string) => void }) {
  const { t } = useT();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return <article className="md">{render(parseBlocks(text), { dir, onOpenFile, t })}</article>;
}
