'use client';

/**
 * What a task may change: read-only, or a list of paths. Shown wherever a task's text can be
 * rewritten — the edit form on its card and the new-prompt dialog in the register — because a new
 * intent is exactly when these change: a maintenance task rewritten as an audit becomes read-only,
 * or scoped to the report it is now asked to write. The runner enforces both after every round of
 * steps (see src/vcs/scope.ts) and refuses a task whose flags contradict each other before it
 * starts (src/orchestrator/contract.ts).
 */
import { useId } from 'react';
import { useT } from '../lib/i18n';

export function ContractFields({
  readOnly,
  scope,
  onReadOnly,
  onScope,
}: {
  readOnly: boolean;
  /** One path or pattern per line, as typed. */
  scope: string;
  onReadOnly: (v: boolean) => void;
  onScope: (v: string) => void;
}) {
  const { t } = useT();
  const id = useId();
  return (
    <>
      <div className="option" style={{ marginTop: 10 }}>
        <label>
          <input type="checkbox" checked={readOnly} onChange={(e) => onReadOnly(e.target.checked)} />
          <span>{t('task.readOnlyEdit')}</span>
        </label>
        <p className="why">{t('task.readOnlyEditWhy')}</p>
      </div>
      <label htmlFor={`${id}-scope`}>{t('task.scopeEdit')}</label>
      <textarea
        id={`${id}-scope`}
        value={scope}
        onChange={(e) => onScope(e.target.value)}
        placeholder={'tests/e2e/\nsrc/**/*.ts'}
        style={{ minHeight: 60 }}
        disabled={readOnly}
      />
      <p className="why">{t('task.scopeEditWhy')}</p>
    </>
  );
}

/** The scope as the API takes it: one entry per non-empty line. */
export function scopeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
