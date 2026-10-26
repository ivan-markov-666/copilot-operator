'use client';

import { useEffect, useState } from 'react';
import type { QueueItem } from '../../lib/api';
import { useT, type Key } from '../../lib/i18n';

/**
 * The queue as a picture (operator, 2026-10-24: "each task a dot; tasks bound to one another joined by threads; easy to
 * take in, light for the browser; the names over the dots, on hover, and a box that shows them all"). The tasks run from
 * left to right, one after another, on a faint line; a thread arcs over it from a task to each task that depends on it,
 * its arrow at the one that waits. A dot is coloured by how its task stands, and a thread from a task that did not end
 * done is drawn broken. Plain SVG, no library: a queue holds at most fifty tasks.
 */
const GAP = 104;
// Room at each end for a name centred under the first and the last dot.
const PAD = 64;
const R = 12;

const STATUS: Record<QueueItem['status'], Key> = {
  waiting: 'q.waiting',
  running: 'q.running',
  done: 'q.done',
  failed: 'q.failed',
  skipped: 'q.skipped',
  stopped: 'q.stopped',
  parked: 'q.parked',
};

const NAMES_KEY = 'cop.queue.names';

export function QueueGraph({ items, titleOf }: { items: QueueItem[]; titleOf: (x: QueueItem) => string }) {
  const { t } = useT();
  const [names, setNames] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    try {
      setNames(window.localStorage.getItem(NAMES_KEY) === 'on');
    } catch {
      /* off */
    }
  }, []);
  const showNames = (on: boolean) => {
    setNames(on);
    try {
      window.localStorage.setItem(NAMES_KEY, on ? 'on' : 'off');
    } catch {
      /* for this page only */
    }
  };

  if (items.length === 0) return null;
  const index = new Map(items.map((x, i) => [x.id, i]));
  const x = (i: number): number => PAD + i * GAP;
  const threads = items.flatMap((to, j) =>
    to.dependsOn
      .map((d) => index.get(d))
      .filter((i): i is number => i !== undefined && i < j)
      .map((i) => ({ from: items[i]!, to, i, j, lift: Math.min(26 + (j - i) * GAP * 0.32, 150) })),
  );
  const top = Math.max(30, ...threads.map((th) => th.lift)) + 14;
  const base = top + R;
  const width = x(items.length - 1) + PAD;
  const height = base + R + (names ? 34 : 14);
  const near = (id: string): boolean => !at || id === at || threads.some((th) => (th.from.id === at && th.to.id === id) || (th.to.id === at && th.from.id === id));
  const short = (s: string): string => (s.length > 15 ? `${s.slice(0, 14)}…` : s);
  const hovered = at ? items.find((o) => o.id === at) : undefined;
  const hoveredAt = hovered ? index.get(hovered.id)! : 0;

  return (
    <div className="queue-graph">
      <div className="row queue-graph-head">
        <h3>{t('q.graph')}</h3>
        <label className="queue-graph-names">
          <input type="checkbox" checked={names} onChange={(e) => showNames(e.target.checked)} />
          {t('q.showNames')}
        </label>
      </div>
      <p className="muted small">{t('q.graphWhy')}</p>
      <div className="queue-graph-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('q.graphLabel', { n: items.length, links: threads.length })}>
          <defs>
            <marker id="qg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="qg-arrowhead" />
            </marker>
          </defs>
          {/* The order they run in: left to right. */}
          <line x1={x(0)} y1={base} x2={x(items.length - 1)} y2={base} className="qg-line" />
          {threads.map((th) => {
            const x1 = x(th.i);
            const x2 = x(th.j) - R * 0.6;
            const broken = th.from.status === 'failed' || th.from.status === 'skipped' || th.from.status === 'stopped';
            return (
              <path
                key={`${th.from.id}-${th.to.id}`}
                d={`M ${x1} ${base - R} C ${x1} ${base - th.lift}, ${x2} ${base - th.lift}, ${x2} ${base - R}`}
                className={`qg-thread${broken ? ' is-broken' : ''}${!at || th.from.id === at || th.to.id === at ? '' : ' is-dim'}`}
                markerEnd="url(#qg-arrow)"
              />
            );
          })}
          {items.map((o, i) => (
            <g
              key={o.id}
              className={`qg-task s-${o.status}${near(o.id) ? '' : ' is-dim'}`}
              transform={`translate(${x(i)} ${base})`}
              tabIndex={0}
              aria-label={`${i + 1}. ${titleOf(o)} — ${t(STATUS[o.status])}`}
              onMouseEnter={() => setAt(o.id)}
              onMouseLeave={() => setAt(null)}
              onFocus={() => setAt(o.id)}
              onBlur={() => setAt(null)}
            >
              {/* The browser's own tooltip too, wherever the line below is scrolled to. */}
              <title>{`${i + 1}. ${titleOf(o)} — ${t(STATUS[o.status])}`}</title>
              {o.status === 'running' && <circle r={R + 5} className="qg-pulse" />}
              <circle r={R} className="qg-dot" />
              <text className="qg-n" dy="0.35em">
                {i + 1}
              </text>
              {names && (
                <text className="qg-name" y={R + 16}>
                  {short(titleOf(o))}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      {/*
        The task pointed at, under the picture: never cut off by its frame, as a box over the dots was where the frame
        scrolls. Its name, how it stands, what it depends on.
      */}
      <div className="qg-tip" aria-live="polite">
        {hovered ? (
          <>
            <strong>
              {hoveredAt + 1}. {titleOf(hovered)}
            </strong>
            <span className={`queue-status s-${hovered.status}`}>{t(STATUS[hovered.status])}</span>
            {hovered.dependsOn.length > 0 && <span className="small muted">{t('q.dependsOnList', { list: hovered.dependsOn.map((d) => `#${(index.get(d) ?? 0) + 1}`).join(', ') })}</span>}
          </>
        ) : (
          <span className="small muted">{t('q.graphPoint')}</span>
        )}
      </div>
      <ul className="qg-legend small muted" aria-hidden="true">
        {(['waiting', 'running', 'done', 'failed', 'skipped'] as const).map((s) => (
          <li key={s}>
            <svg width="12" height="12" viewBox="-7 -7 14 14">
              <circle r="6" className={`qg-dot s-${s}`} />
            </svg>
            {t(STATUS[s])}
          </li>
        ))}
        <li>
          <svg width="26" height="12" viewBox="0 0 26 12">
            <path d="M 2 11 C 2 1, 24 1, 24 11" className="qg-thread" />
          </svg>
          {t('q.graphThread')}
        </li>
      </ul>
    </div>
  );
}
