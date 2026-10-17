'use client';

/**
 * The panel on the workbench's right: the chat, which works in the open project folder (see `cascade.tsx`), and
 * Kerrigan, to ask how to go on with the bot's sessions.
 */
import type { Session, Task, Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Cascade } from './cascade';
import { Kerrigan } from './kerrigan';
import type { ChatTab } from './workbench';

export function ChatPanel({
  tab,
  onTab,
  session,
  task,
  sessions,
  workspace,
  composeAsk,
  onOpenFile,
  onOpenFolder,
  onTurn,
  onChange,
  onClose,
}: {
  tab: ChatTab;
  onTab: (t: ChatTab) => void;
  session?: Session;
  task?: Task;
  sessions: Session[];
  workspace: Workspace | null;
  composeAsk: number;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onTurn: (turn: { sessionId: string; taskId: string } | null) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="wb-chat-inner">
      <div className="wb-chat-tabs" role="tablist" aria-label={t('wb.chatPanel')}>
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => onTab('chat')}>{t('wb.chatTab')}</button>
        <button type="button" role="tab" aria-selected={tab === 'kerrigan'} className={tab === 'kerrigan' ? 'on' : ''} onClick={() => onTab('kerrigan')}>{t('wb.kerriganTab')}</button>
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.toggleChat')} title={t('wb.toggleChat')} onClick={onClose}>×</button>
      </div>
      {tab === 'kerrigan' ? (
        <Kerrigan session={session} task={task} sessions={sessions} onChange={onChange} />
      ) : (
        <Cascade workspace={workspace} composeAsk={composeAsk} onOpenFile={onOpenFile} onChange={onChange} onOpenFolder={onOpenFolder} onTurn={onTurn} />
      )}
    </div>
  );
}
