'use client';

/**
 * The panel on the workbench's right: the chat, which works in the open project folder (see `cascade.tsx`). Only the
 * chat for now (2026-10-20: "remove the Kerrigan button beside Chat; leave only Chat"); Kerrigan is on the home screen.
 */
import type { Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Cascade, type ChatTurn } from './cascade';

export function ChatPanel({
  workspace,
  composeAsk,
  showThread,
  onOpenFile,
  onOpenFolder,
  onTurn,
  onChange,
  onClose,
}: {
  workspace: Workspace | null;
  composeAsk: number;
  showThread: { id: string; n: number } | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onTurn: (turn: ChatTurn) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="wb-chat-inner">
      <div className="wb-chat-tabs" role="tablist" aria-label={t('wb.chatPanel')}>
        <button type="button" role="tab" aria-selected className="on">{t('wb.chatTab')}</button>
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.toggleChat')} title={t('wb.toggleChat')} onClick={onClose}>×</button>
      </div>
      <Cascade workspace={workspace} composeAsk={composeAsk} showThread={showThread} onOpenFile={onOpenFile} onChange={onChange} onOpenFolder={onOpenFolder} onTurn={onTurn} />
    </div>
  );
}
