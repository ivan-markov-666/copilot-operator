'use client';

/**
 * The project's directories as a tree, each one clickable into or out of the mirror.
 *
 * The two text areas — directories in, directories out — stay the record and stay editable;
 * this is a way of filling them without typing paths. A click on a directory puts it in the
 * "in" list, which takes everything beneath it, so the children show as inherited; a second
 * click takes it out again. The small "−" on a row puts that directory in the "out" list,
 * which carves it (and everything beneath it) back out of an included parent. The lists are
 * kept minimal: including a directory drops the entries beneath it that it now covers.
 *
 * The list of directories comes from the API, pruned by the same rules the mirror uses, so
 * what is offered is what can be copied.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';

type Node = { path: string; name: string; children: Node[] };

function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isUnder(child: string, parent: string): boolean {
  return parent === '.' || parent === '' ? true : child === parent || child.startsWith(`${parent}/`);
}

function buildTree(paths: string[]): Node[] {
  const roots: Node[] = [];
  const byPath = new Map<string, Node>();
  for (const p of [...paths].sort()) {
    const node: Node = { path: p, name: p.split('/').pop() ?? p, children: [] };
    byPath.set(p, node);
    const parent = p.includes('/') ? byPath.get(p.slice(0, p.lastIndexOf('/'))) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

type State = 'in' | 'inherited' | 'out' | 'out-inherited' | 'none';

/**
 * What a folder holds that the eye cannot see while it is folded.
 *
 * A folder carved out of an included parent disappears the moment its parent is collapsed, and
 * then the two lists say one thing and the tree shows another. So a folded row carries the
 * count of what is named inside it, and the row is marked when any of it is excluded — the
 * case that matters, because an exclusion inside an inclusion is the one a reader will
 * otherwise miss.
 */
function insideOf(path: string, include: string[], exclude: string[]): { included: number; excluded: number } {
  const under = (list: string[]) => list.filter((p) => p !== path && isUnder(p, path)).length;
  return { included: under(include), excluded: under(exclude) };
}

function stateOf(path: string, include: string[], exclude: string[]): State {
  if (exclude.includes(path)) return 'out';
  if (exclude.some((e) => e !== path && isUnder(path, e))) return 'out-inherited';
  if (include.includes(path)) return 'in';
  if (include.some((i) => i !== path && isUnder(path, i))) return 'inherited';
  return 'none';
}

export function DirTree({
  rootDir,
  respectGitignore,
  includeEnvFiles,
  include,
  exclude,
  onChange,
}: {
  rootDir: string;
  respectGitignore: boolean;
  /** Only for the note below: what is left out without anyone typing it. */
  includeEnvFiles?: boolean;
  include: string[];
  exclude: string[];
  onChange: (include: string[], exclude: string[]) => void;
}) {
  const { t } = useT();
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadedFor, setLoadedFor] = useState('');

  const load = async () => {
    if (!rootDir.trim()) return;
    setErr('');
    try {
      const list = await api.dirs(rootDir, respectGitignore);
      setDirs(list);
      setLoadedFor(`${rootDir}|${respectGitignore}`);
      // The first level open, the rest folded: a tree of forty directories fully open is a
      // list, and the point of a tree is that it is not one.
      setOpen(new Set(list.filter((p) => !p.includes('/'))));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    setDirs(null);
    setLoadedFor('');
  }, [rootDir, respectGitignore]);

  const tree = useMemo(() => buildTree(dirs ?? []), [dirs]);
  const inc = include.map(norm).filter(Boolean);
  const exc = exclude.map(norm).filter(Boolean);

  const toggleInclude = (path: string) => {
    const state = stateOf(path, inc, exc);
    if (state === 'in') {
      onChange(inc.filter((p) => p !== path), exc);
      return;
    }
    // Including a directory covers everything beneath it: entries under it leave both lists.
    const nextInc = [...inc.filter((p) => !isUnder(p, path)), path];
    const nextExc = exc.filter((p) => !isUnder(p, path));
    onChange(nextInc, nextExc);
  };

  const toggleExclude = (path: string) => {
    if (exc.includes(path)) {
      onChange(inc, exc.filter((p) => p !== path));
      return;
    }
    onChange(inc.filter((p) => p !== path && !isUnder(p, path)), [...exc.filter((p) => !isUnder(p, path)), path]);
  };

  const flip = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (nodes: Node[]): ReactElement => (
    <ul className="dir-tree">
      {nodes.map((n) => {
        const state = stateOf(n.path, inc, exc);
        const isOpen = open.has(n.path);
        const inside = insideOf(n.path, inc, exc);
        const hidden = !isOpen && n.children.length > 0 && (inside.included > 0 || inside.excluded > 0);
        return (
          <li key={n.path} className={`dir ${state}`}>
            <div className="dir-row">
              {n.children.length > 0 ? (
                <button type="button" className="dir-flip" onClick={() => flip(n.path)} aria-label={isOpen ? t('tree.fold') : t('tree.unfold')} aria-expanded={isOpen}>
                  {isOpen ? '▾' : '▸'}
                </button>
              ) : (
                <span className="dir-flip" aria-hidden="true" />
              )}
              <button
                type="button"
                className="dir-name"
                onClick={() => toggleInclude(n.path)}
                title={
                  state === 'in'
                    ? t('tree.stateIn')
                    : state === 'inherited'
                      ? t('tree.stateInherited')
                      : state === 'out'
                        ? t('tree.stateOut')
                        : state === 'out-inherited'
                          ? t('tree.stateOutInherited')
                          : t('tree.stateNone')
                }
                aria-pressed={state === 'in' || state === 'inherited'}
              >
                <span className="dir-mark" aria-hidden="true">
                  {state === 'in' ? '✓' : state === 'inherited' ? '·' : state === 'out' || state === 'out-inherited' ? '×' : ''}
                </span>
                {n.name}
              </button>
              <button type="button" className={`dir-out${state === 'out' ? ' on' : ''}`} onClick={() => toggleExclude(n.path)} title={state === 'out' ? t('tree.unexclude') : t('tree.exclude')}>
                −
              </button>
              {hidden && (
                <span className={`chip inside${inside.excluded > 0 ? ' out' : ''}`} title={t('tree.insideWhy')}>
                  {inside.excluded > 0 && inside.included > 0
                    ? t('tree.insideBoth', { i: inside.included, e: inside.excluded })
                    : inside.excluded > 0
                      ? t('tree.insideOut', { n: inside.excluded })
                      : t('tree.insideIn', { n: inside.included })}
                </span>
              )}
            </div>
            {isOpen && n.children.length > 0 && render(n.children)}
          </li>
        );
      })}
    </ul>
  );

  const stale = loadedFor !== `${rootDir}|${respectGitignore}`;

  return (
    <div className="dir-tree-box">
      <div className="row">
        <button type="button" onClick={() => void load()} disabled={!rootDir.trim()}>
          {dirs === null || stale ? t('tree.load') : t('tree.reload')}
        </button>
        <span className="muted small">{t('tree.hint')}</span>
      </div>
      {err && <div className="err small">{err}</div>}
      {/*
        What is left out that nobody typed.

        The exclude list holds what the operator named, and it would be wrong to write these
        into it: they follow the two switches, and a copy of them in the field would go on
        excluding after a switch was turned off. So they are said here instead, where the
        question "what will actually be copied" is being asked.
      */}
      <p className="muted small" style={{ marginTop: 6 }}>
        {t('tree.alsoOut')}{' '}
        {[
          respectGitignore ? t('tree.alsoGitignore') : null,
          includeEnvFiles === false ? t('tree.alsoEnv') : null,
          t('tree.alsoAlways'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {dirs !== null && !stale && (dirs.length === 0 ? <p className="muted small">{t('mirror.noDirs')}</p> : render(tree))}
    </div>
  );
}
