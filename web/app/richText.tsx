'use client';

/**
 * The little bit of markdown that actually turns up in a summary, rendered.
 *
 * Copilot writes prose with backticks around commands, the odd bold phrase, and sometimes a
 * bullet list or a fenced block quoting output. Shown raw, that is a wall of text with stray
 * asterisks in it; shown through a full markdown library it would be a dependency, a bundle
 * and a sanitising problem for text a model wrote.
 *
 * So this handles exactly what appears and nothing else, and it builds React elements rather
 * than HTML, which means there is no way for anything in the text to become markup. Anything
 * it does not recognise is left as the characters it is — the worst case is a paragraph that
 * reads exactly as it does today.
 */

import { Fragment, type ReactNode } from 'react';

/** `code`, **bold** and *italic*, in one pass, so nesting cannot produce half-open markup. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const piece = match[0];
    const key = `${keyPrefix}-i${(i += 1)}`;
    if (piece.startsWith('`')) out.push(<code key={key}>{piece.slice(1, -1)}</code>);
    else if (piece.startsWith('**')) out.push(<strong key={key}>{piece.slice(2, -2)}</strong>);
    else out.push(<em key={key}>{piece.slice(1, -1)}</em>);
    last = match.index + piece.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One line that opens a list item, and what it says. */
function listItem(line: string): string | null {
  const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
  if (bullet) return bullet[1];
  const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  return numbered ? numbered[1] : null;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    // A fenced block runs to its closing fence, or to the end when the model forgot one.
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i += 1;
      if (body.length > 0) blocks.push(<pre key={`b${(key += 1)}`}>{body.join('\n')}</pre>);
      continue;
    }

    // A run of list lines becomes one list; anything else ends it.
    if (listItem(line) !== null) {
      const items: string[] = [];
      while (i < lines.length && listItem(lines[i]) !== null) items.push(listItem(lines[i++]) as string);
      blocks.push(
        <ul key={`b${(key += 1)}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `b${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // A paragraph is every line up to the next blank line or list, with its breaks kept: a
    // model that laid something out in lines meant those lines.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && listItem(lines[i]) === null && !lines[i].trim().startsWith('```')) {
      para.push(lines[i++]);
    }
    const k = (key += 1);
    blocks.push(
      <p key={`b${k}`}>
        {para.map((l, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(l, `b${k}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className={`rich ${className ?? ''}`}>{blocks}</div>;
}
