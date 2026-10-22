'use client';

/**
 * The panel on the workbench's right: the chat, which works in the open project folder (see `cascade.tsx`). Only the
 * chat for now (2026-10-20: "remove the Kerrigan button beside Chat; leave only Chat"); Kerrigan is on the home screen.
 */
import type { ReactNode } from 'react';
import type { Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useActivity } from '../../lib/activity';
import { isWorking, liveText } from '../../lib/actors';
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
  grip,
}: {
  workspace: Workspace | null;
  composeAsk: number;
  showThread: { id: string; n: number } | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onTurn: (turn: ChatTurn) => void;
  onChange: () => void;
  onClose: () => void;
  /** Moves the panel (see `panelGrip.tsx`). */
  grip?: ReactNode;
}) {
  const { t } = useT();
  const activity = useActivity();
  const live = isWorking(activity);
  // Said in words too, for a reader that cannot see the mark, and on hover: who is at work, or that it is paused.
  const liveSays = liveText(t, activity);
  return (
    <div className="wb-chat-inner">
      <div className="wb-chat-tabs" role="tablist" aria-label={t('wb.chatPanel')}>
        {grip}
        <button type="button" role="tab" aria-selected className="on">
          {t('wb.chatTab')}
          {/* LIVE while the bot works (operator, 2026-10-22). */}
          {live && (
            <span className={`wb-live-badge${activity?.paused ? ' paused' : ''}`} role="status" title={liveSays} aria-label={liveSays}>
              <span className="wb-live-badge-dot" aria-hidden="true" />
              {t('wb.live')}
            </span>
          )}
        </button>
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.toggleChat')} title={t('wb.toggleChat')} onClick={onClose}>×</button>
      </div>
      <Cascade workspace={workspace} composeAsk={composeAsk} showThread={showThread} onOpenFile={onOpenFile} onChange={onChange} onOpenFolder={onOpenFolder} onTurn={onTurn} />
    </div>
  );
}
