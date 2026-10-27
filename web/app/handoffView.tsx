'use client';

/**
 * Commands the chat handed to the operator to run themselves (operator, 2026-10-26: "the script is made, but the user
 * runs it; the bot gives the commands for the user to run and the result it expects"): what they are for, the revision,
 * the folder, the lines in order with "Copy", what should be seen and how it should end, what the chat says they reach
 * and change beside what the bot itself reads in them, the lines and scripts the bot would refuse, and the scripts they
 * run, each folded in full with where it is — what the operator reads is what they run. Shown in the conversation, on a
 * queue task's card and in the conversation's history alike; each says how it is answered.
 */
import type { Approval, HandoffCard } from '../lib/api';
import { useT } from '../lib/i18n';
import { CopyButton } from './copyButton';
import { RichText } from './richText';

export function HandoffDetails({ card, why }: { card: HandoffCard; why: string }) {
  const { t } = useT();
  const commands = card.commands.join('\n');
  const revision = card.revision ?? 1;
  const said = (label: string, value: string | undefined) => (
    <p className="small ho-said">
      <span className="muted">{label}</span> {value ? <span>{value}</span> : <span className="muted">{t('ho.notSaid')}</span>}
    </p>
  );
  return (
    <div className="ho-details">
      <p className="small">
        <span className={revision > 1 ? 'ho-revision ho-revision-new' : 'ho-revision'}>{t('ho.revision', { n: revision })}</span>
        {revision > 1 && <span className="small"> {t('ho.revisionNew')}</span>}
      </p>
      <p className="small">{t('ho.intro')}</p>
      {why && <RichText text={why} />}
      <p className="small ho-folder">
        <span className="muted">{t('ho.folder')}</span> <code dir="ltr">{card.cwd}</code>
      </p>
      {card.outside && <p className="reason small">{t('ho.outside')}</p>}
      <p className="cs-who">{t('ho.commands')}</p>
      <pre className="cs-out ho-commands" dir="ltr">{commands}</pre>
      <div className="cs-copy-row">
        <CopyButton text={commands} what="ho.copyCommands" />
      </div>
      {(card.warnings?.length ?? 0) > 0 && (
        <div className="err ho-warn" role="alert">
          <p className="small">{t('ho.warn')}</p>
          <ul className="small">
            {card.warnings!.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="cs-who">{t('ho.expect')}</p>
      <RichText text={card.expect} />
      <div className="ho-declared">
        {said(t('ho.exit'), card.exit)}
        {said(t('ho.network'), card.network)}
        {said(t('ho.platforms'), card.platforms)}
        {said(t('ho.changes'), card.changes)}
      </div>
      {/* What the bot reads in the lines and the scripts themselves, beside what the chat says of them. */}
      {card.seen?.network && <p className="reason small ho-seen">{t('ho.seenNetwork', { what: card.seen.network })}</p>}
      {card.seen?.platform && <p className="reason small ho-seen">{t('ho.seenPlatform', { platform: card.seen.platform })}</p>}
      {card.files.length > 0 && (
        <div className="ho-files">
          {card.files.map((f) => (
            <details key={f.path} className="ho-file">
              <summary className="small">
                <code dir="ltr">{f.path}</code> {f.problem ? <span className="reason">{f.problem}</span> : <span className="muted">{t('ho.files')}</span>}
              </summary>
              {f.abs && (
                <p className="small muted ho-abs" dir="ltr">
                  {t('ho.abs')} <code>{f.abs}</code>
                </p>
              )}
              {f.cut && <p className="small muted">{t('ho.cut')}</p>}
              {f.text !== undefined && (
                <>
                  <pre className="cs-out" dir="ltr">{f.text}</pre>
                  <div className="cs-copy-row">
                    <CopyButton text={f.text} what="ho.copyFile" />
                  </div>
                </>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/** A handoff as the conversation's history keeps it: the card as it was shown, folded, and how it was answered. */
export function HandoffRecord({ card, outcome, answer }: { card: HandoffCard; outcome: string; answer?: string }) {
  const { t } = useT();
  const how =
    outcome === 'ran' ? t('ho.historyRan') : outcome === 'revise' ? t('ho.historyRevise') : outcome === 'declined' ? t('ho.historyDeclined') : outcome === 'stopped' ? t('ho.historyStopped') : t('ho.historyNobody');
  return (
    <div className={`cs-bot ho-record ho-record-${outcome}`}>
      <details>
        <summary className="small">
          <strong>{t('ho.historyTitle', { n: card.revision ?? 1 })}</strong> · {how}
        </summary>
        <HandoffDetails card={card} why={card.why ?? ''} />
      </details>
      {answer && (
        <>
          <p className="cs-who">{outcome === 'revise' ? t('ho.reviseNote') : outcome === 'ran' ? t('ho.output') : t('ho.historySaid')}</p>
          <pre className="cs-out" dir="auto">{answer}</pre>
          <div className="cs-copy-row">
            <CopyButton text={answer} what="chat.copyAnswer" />
          </div>
        </>
      )}
    </div>
  );
}

/** The scripts the bot wrote that a step runs, each folded in full, on the card that asks about the step (2026-10-27). */
export function WrittenScripts({ scripts }: { scripts: NonNullable<Approval['scripts']> }) {
  const { t } = useT();
  return (
    <div className="cs-written-scripts">
      <p className="reason small">{t('approval.scripts')}</p>
      {scripts.map((x) => (
        <details key={`${x.path}:${x.script ?? ''}`} className="ho-file" open={scripts.length === 1}>
          <summary className="small">
            <code dir="ltr">{x.script ? t('approval.scriptOf', { name: x.script, path: x.path }) : x.path}</code>
            {x.problem && <span className="reason"> {x.problem}</span>}
          </summary>
          {x.cut && <p className="small muted">{t('ho.cut')}</p>}
          {x.text !== undefined && (
            <>
              <pre className="cs-out" dir="ltr">{x.text}</pre>
              <div className="cs-copy-row">
                <CopyButton text={x.text} what="ho.copyFile" />
              </div>
            </>
          )}
        </details>
      ))}
    </div>
  );
}
