'use client';

/**
 * A task's plan, in plan mode (2026-10-13): what the chat found already there, how it means to do the
 * work, its steps, the files it expects to change, how it will show the work is done, and its risks.
 * Shown on the approval card while the plan waits, and on the task's card afterwards with who
 * approved it and the comments that asked for an earlier version to be changed.
 *
 * "Copy" at its top and at its foot (operator, 2026-10-21: "put a copy option on the plan"): the whole plan as text,
 * under the headings it is shown with, to paste into a ticket, a mail or another chat.
 */
import type { TaskPlan } from '../lib/api';
import { useT, useFmtTime, type Key } from '../lib/i18n';
import { CopyButton } from './copyButton';

/** The plan as text, in the page's language: its headings as Markdown, its steps numbered, its files as a list. */
export function planAsText(plan: TaskPlan, t: (key: Key, vars?: Record<string, string | number>) => string): string {
  const part = (heading: Key, body: string): string[] => (body.trim() ? [`## ${t(heading)}`, '', body.trim(), ''] : []);
  return [
    ...part('pm.existing', plan.existing),
    ...part('pm.approach', plan.approach),
    ...part('pm.steps', plan.steps.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')),
    ...part('pm.files', plan.files.map((f) => `- \`${f}\``).join('\n')),
    ...part('pm.verification', plan.verification),
    ...part('pm.risks', plan.risks ?? ''),
  ]
    .join('\n')
    .trim();
}

export function PlanView({ plan, showApproval = true }: { plan: TaskPlan; showApproval?: boolean }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const a = plan.approved;
  const text = planAsText(plan, t);
  return (
    <div className="plan-view">
      <div className="plan-view-head">
        <p className="small muted">{t('pm.version', { n: plan.version, at: fmtTime(plan.at) })}</p>
        <CopyButton text={text} what="pm.copyPlan" />
      </div>
      {showApproval && a && (
        <p className="small">
          {a.by === 'operator' ? t('pm.approvedByOperator', { at: fmtTime(a.at) }) : t('pm.approvedAuto', { at: fmtTime(a.at) })}
          {a.why && ` ${a.why}`}
          {a.note && ` ${t('pm.approvedNote', { note: a.note })}`}
        </p>
      )}
      <h4>{t('pm.existing')}</h4>
      <p className="pre-wrap">{plan.existing}</p>
      <h4>{t('pm.approach')}</h4>
      <p className="pre-wrap">{plan.approach}</p>
      <h4>{t('pm.steps')}</h4>
      <ol>
        {plan.steps.map((s, i) => (
          <li key={i} className="pre-wrap">
            {s}
          </li>
        ))}
      </ol>
      {plan.files.length > 0 && (
        <>
          <h4>{t('pm.files')}</h4>
          <ul>
            {plan.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{t('pm.verification')}</h4>
      <p className="pre-wrap">{plan.verification}</p>
      {plan.risks && (
        <>
          <h4>{t('pm.risks')}</h4>
          <p className="pre-wrap">{plan.risks}</p>
        </>
      )}
      {(plan.revisions?.length ?? 0) > 0 && (
        <>
          <h4>{t('pm.revisions')}</h4>
          <ul>
            {plan.revisions!.map((r) => (
              <li key={r.version} className="small">
                {t('pm.revision', { n: r.version, at: fmtTime(r.at) })} <span className="pre-wrap">{r.comment}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* At its foot too: a long plan is read to the end before it is copied. */}
      <div className="cs-copy-row">
        <CopyButton text={text} what="pm.copyPlan" />
      </div>
    </div>
  );
}
