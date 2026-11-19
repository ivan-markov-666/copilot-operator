/**
 * Why "New branch from main" is off, or '' when it is on (2026-10-26). Off while a task works — its branch is not
 * changed under it —, while the queue runs, between its tasks too (bug hunt 2026-11-18: the button looked usable there,
 * and the server refused it), and where there is no repository. Said on hover.
 */
import type { Workspace } from './api';
import type { Key } from './lang/types';

export function newBranchOff(t: (key: Key) => string, at: { running: boolean; queue: boolean; workspace: Pick<Workspace, 'ok' | 'isRepo'> | null }): string {
  if (at.running) return t('nb.offRunning');
  if (at.queue) return t('nb.offQueue');
  if (!at.workspace?.ok) return t('nb.offNoFolder');
  return at.workspace.isRepo ? '' : t('nb.offNoRepo');
}
