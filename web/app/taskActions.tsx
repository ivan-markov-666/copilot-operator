'use client';

/**
 * The two things you can do to a task that has already run, in one place.
 *
 * They live here rather than on the session page because they are wanted from the register
 * too — the register is where a failure is noticed, and sending somebody to another page to
 * act on what they are already looking at is the kind of small friction that makes a feature
 * go unused. The dialogs are the whole substance of both, so duplicating them would mean two
 * versions of the sentence that tells an operator what they are about to lose.
 *
 * Both follow the same shape: ask what would happen, put the answer into the question, and
 * only then do it.
 */

import { useCallback, useState } from 'react';
import { api } from '../lib/api';
import { confirmDialog } from './dialog';
import { useT } from '../lib/i18n';

export type TaskRef = { sessionId: string; taskId: string; title: string };

/** What the caller needs to render a pair of buttons and whatever they had to say. */
export type TaskActions = {
  busy: '' | 'restore' | 'restart';
  message: string;
  clearMessage: () => void;
  restore: (task: TaskRef) => Promise<void>;
  restartFrom: (task: TaskRef) => Promise<void>;
};

export function useTaskActions(onChange: () => void): TaskActions {
  const { t } = useT();
  const [busy, setBusy] = useState<'' | 'restore' | 'restart'>('');
  const [message, setMessage] = useState('');

  /**
   * Back to the code as it was before this task, without destroying what came after.
   *
   * The preview comes first and its numbers go into the question, because "restore" in most
   * tools means "throw the rest away" and here it does not: the later commits stay on the
   * branch they were made on. The operator is told which, and how many, before they agree —
   * and told again afterwards where to find them.
   */
  const restore = useCallback(
    async (task: TaskRef) => {
      setBusy('restore');
      setMessage('');
      try {
        const preview = await api.restorePreview(task.sessionId, task.taskId);
        if (!preview.ok) {
          setMessage(t('restore.cannot', { problem: preview.problem ?? '' }));
          return;
        }

        const common = {
          repo: preview.repoDir,
          title: task.title,
          branch: preview.branchName ?? '',
          commit: (preview.baseCommit ?? '').slice(0, 8),
        };
        const question =
          preview.leftBehind.length > 0
            ? t('restore.confirmLosing', {
                ...common,
                n: preview.leftBehind.length,
                kept: preview.keptOn ?? '',
                list: preview.leftBehind.slice(0, 10).join('\n'),
              })
            : t('restore.confirm', common);
        if (!(await confirmDialog(question))) return;

        const done = await api.restore(task.sessionId, task.taskId);
        if (!done.ok) {
          setMessage(t('restore.failed', { problem: done.problem ?? '' }));
          return;
        }
        setMessage(
          (done.leftBehind?.length ?? 0) > 0
            ? t('restore.done', {
                branch: done.branch ?? '',
                commit: (done.commit ?? '').slice(0, 8),
                n: done.leftBehind?.length ?? 0,
                kept: done.keptOn ?? '',
              })
            : t('restore.doneNothing', { branch: done.branch ?? '', commit: (done.commit ?? '').slice(0, 8) }),
        );
        onChange();
      } catch (e) {
        setMessage((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [t, onChange],
  );

  /**
   * Put the code back and run this task and everything after it again.
   *
   * The question is long on purpose. This is the most far-reaching button in the application:
   * it moves one or more repositories, it throws finished tasks back into the queue, and then
   * it starts a run — three things that are each worth confirming and that nobody would guess
   * from two words on a button. So the dialog lists the repositories, the tasks by name and
   * the sessions they belong to, and says how the run will be started.
   */
  const restartFrom = useCallback(
    async (task: TaskRef) => {
      setBusy('restart');
      setMessage('');
      try {
        const plan = await api.restartPlan(task.sessionId, task.taskId);
        if (!plan.ok) {
          setMessage(t('restart.cannot', { problem: plan.problem ?? '' }));
          return;
        }

        const blocked = plan.restores.filter((r) => !r.ok);
        if (blocked.length > 0) {
          setMessage(t('restart.cannot', { problem: blocked.map((r) => `${r.repoDir}: ${r.problem ?? ''}`).join(' | ') }));
          return;
        }

        const repos = plan.restores
          .map((r) =>
            t('restart.repoLine', {
              repo: r.repoDir,
              commit: (r.baseCommit ?? '').slice(0, 8),
              branch: r.branchName ?? '',
              n: r.leftBehind.length,
              kept: r.keptOn ?? '',
            }),
          )
          .join('\n');

        const list = plan.tasks
          .map((x) => `  ${x.sessionName} / ${x.title}${x.alreadyQueued ? t('restart.alreadyQueued') : ''}`)
          .join('\n');

        const question = t('restart.confirm', {
          title: plan.from.title,
          tasks: plan.tasks.length,
          sessions: plan.sessions.length,
          list,
          repos: repos || t('restart.noRepo'),
          mode: t(plan.mode === 'unattended' ? 'run.unattended' : 'run.confirm'),
        });
        if (!(await confirmDialog(question))) return;

        const done = await api.restartFrom(task.sessionId, task.taskId);
        if (!done.started) {
          setMessage(t('restart.failed', { problem: done.reason ?? '' }));
          onChange();
          return;
        }
        setMessage(t('restart.started', { requeued: done.requeued, repos: done.restored.length }));
        onChange();
      } catch (e) {
        setMessage((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [t, onChange],
  );

  return { busy, message, clearMessage: () => setMessage(''), restore, restartFrom };
}
