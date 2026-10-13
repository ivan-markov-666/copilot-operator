'use client';

/**
 * A task's plan, in plan mode (2026-10-13): what the chat found already there, how it means to do the
 * work, its steps, the files it expects to change, how it will show the work is done, and its risks.
 * Shown on the approval card while the plan waits, and on the task's card afterwards with who
 * approved it and the comments that asked for an earlier version to be changed.
 */
import type { TaskPlan } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';

export function PlanView({ plan, showApproval = true }: { plan: TaskPlan; showApproval?: boolean }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const a = plan.approved;
  return (
    <div className="plan-view">
      <p className="small muted">{t('pm.version', { n: plan.version, at: fmtTime(plan.at) })}</p>
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
    </div>
  );
}
