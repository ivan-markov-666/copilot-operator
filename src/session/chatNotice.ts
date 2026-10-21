/**
 * What the chat's window says when the work on a message has ended and the window is left open for the next one
 * (2026-10-19: "when the chat is done, let the browser show a message — the task has finished — and an OK under
 * it"). In the language the workbench was in when the message was written; the card is drawn by `showNotice`.
 * Every language of the interface has its words here (2026-10-20); one that has none is English. Arabic is written
 * right to left, and the card says so.
 */
import type { TaskStatus } from './model.js';
import type { WindowNotice } from '../transport/copilotTransport.js';

/** A language code of the interface: `en`, `bg`, `de`, … (see `web/lib/lang/languages.ts`). */
export type NoticeLang = string;

/** A message of the run, as it ended. */
export type NoticeTask = { title: string; status: TaskStatus; reason?: string; summary?: string };

/** What the card says, in one language. */
type Words = {
  done: string;
  stopped: string;
  failed: string;
  notStarted: string;
  doneLine: string;
  stoppedLine: string;
  blockedLine: string;
  failedLine: string;
  limitLine: string;
  notStartedLine: string;
  statusOf: Record<string, string>;
  keep: string;
  ok: string;
  quote: (s: string) => string;
};

const WORDS: Record<string, Words> = {
  en: {
    done: 'The task is done',
    stopped: 'The task was stopped',
    failed: 'The task ended unfinished',
    notStarted: 'The task could not start',
    doneLine: 'Copilot finished it. What was done is in the copilot-operator chat.',
    stoppedLine: 'It was stopped; nothing more is sent.',
    blockedLine: 'Copilot could not finish it',
    failedLine: 'It ended with an error',
    limitLine: 'It stopped at a limit from the settings',
    notStartedLine: 'Nothing was sent',
    statusOf: { done: 'done', aborted: 'stopped', blocked: 'blocked', failed: 'failed', 'limit-reached': 'at a limit', queued: 'not started' },
    keep: 'This window stays open for your next message. You can close it at any time.',
    ok: 'OK',
    quote: (s: string) => `“${s}”`,
  },
  bg: {
    done: 'Заданието е изпълнено',
    stopped: 'Заданието е спряно',
    failed: 'Заданието приключи незавършено',
    notStarted: 'Заданието не можа да започне',
    doneLine: 'Copilot го завърши. Какво е направено, виждате в чата на copilot-operator.',
    stoppedLine: 'Спряно е; нищо повече не се изпраща.',
    blockedLine: 'Copilot не успя да го завърши',
    failedLine: 'Завърши с грешка',
    limitLine: 'Спря при ограничение от настройките',
    notStartedLine: 'Нищо не беше изпратено',
    statusOf: { done: 'изпълнено', aborted: 'спряно', blocked: 'незавършено', failed: 'с грешка', 'limit-reached': 'при ограничение', queued: 'не започна' },
    keep: 'Прозорецът остава отворен за следващото ви съобщение. Можете да го затворите по всяко време.',
    ok: 'ОК',
    quote: (s: string) => `„${s}“`,
  },
  de: {
    done: 'Die Aufgabe ist erledigt',
    stopped: 'Die Aufgabe wurde angehalten',
    failed: 'Die Aufgabe wurde nicht abgeschlossen',
    notStarted: 'Die Aufgabe konnte nicht beginnen',
    doneLine: 'Copilot hat sie abgeschlossen. Was getan wurde, steht im Chat von copilot-operator.',
    stoppedLine: 'Sie wurde angehalten; es wird nichts mehr gesendet.',
    blockedLine: 'Copilot konnte sie nicht abschließen',
    failedLine: 'Sie endete mit einem Fehler',
    limitLine: 'Sie hielt an einer Grenze aus den Einstellungen an',
    notStartedLine: 'Es wurde nichts gesendet',
    statusOf: { done: 'erledigt', aborted: 'angehalten', blocked: 'blockiert', failed: 'fehlgeschlagen', 'limit-reached': 'an einer Grenze', queued: 'nicht begonnen' },
    keep: 'Dieses Fenster bleibt für Ihre nächste Nachricht geöffnet. Sie können es jederzeit schließen.',
    ok: 'OK',
    quote: (s: string) => `„${s}“`,
  },
  es: {
    done: 'La tarea se ha completado',
    stopped: 'La tarea se ha detenido',
    failed: 'La tarea terminó sin completarse',
    notStarted: 'La tarea no pudo empezar',
    doneLine: 'Copilot la ha terminado. Lo que se hizo está en el chat de copilot-operator.',
    stoppedLine: 'Se ha detenido; no se envía nada más.',
    blockedLine: 'Copilot no pudo terminarla',
    failedLine: 'Terminó con un error',
    limitLine: 'Se detuvo en un límite de la configuración',
    notStartedLine: 'No se envió nada',
    statusOf: { done: 'completada', aborted: 'detenida', blocked: 'bloqueada', failed: 'con error', 'limit-reached': 'en un límite', queued: 'sin empezar' },
    keep: 'Esta ventana sigue abierta para su próximo mensaje. Puede cerrarla en cualquier momento.',
    ok: 'Aceptar',
    quote: (s: string) => `«${s}»`,
  },
  fr: {
    done: 'La tâche est terminée',
    stopped: 'La tâche a été arrêtée',
    failed: 'La tâche s’est terminée inachevée',
    notStarted: 'La tâche n’a pas pu démarrer',
    doneLine: 'Copilot l’a terminée. Ce qui a été fait se trouve dans le chat de copilot-operator.',
    stoppedLine: 'Elle a été arrêtée ; plus rien n’est envoyé.',
    blockedLine: 'Copilot n’a pas pu la terminer',
    failedLine: 'Elle s’est terminée par une erreur',
    limitLine: 'Elle s’est arrêtée à une limite des paramètres',
    notStartedLine: 'Rien n’a été envoyé',
    statusOf: { done: 'terminée', aborted: 'arrêtée', blocked: 'bloquée', failed: 'en erreur', 'limit-reached': 'à une limite', queued: 'non démarrée' },
    keep: 'Cette fenêtre reste ouverte pour votre prochain message. Vous pouvez la fermer à tout moment.',
    ok: 'OK',
    quote: (s: string) => `« ${s} »`,
  },
  pt: {
    done: 'A tarefa está concluída',
    stopped: 'A tarefa foi parada',
    failed: 'A tarefa terminou por concluir',
    notStarted: 'A tarefa não pôde começar',
    doneLine: 'O Copilot concluiu-a. O que foi feito está no chat do copilot-operator.',
    stoppedLine: 'Foi parada; não é enviado mais nada.',
    blockedLine: 'O Copilot não conseguiu concluí-la',
    failedLine: 'Terminou com um erro',
    limitLine: 'Parou num limite das definições',
    notStartedLine: 'Nada foi enviado',
    statusOf: { done: 'concluída', aborted: 'parada', blocked: 'bloqueada', failed: 'com erro', 'limit-reached': 'num limite', queued: 'não iniciada' },
    keep: 'Esta janela fica aberta para a sua próxima mensagem. Pode fechá-la a qualquer momento.',
    ok: 'OK',
    quote: (s: string) => `«${s}»`,
  },
  ja: {
    done: 'タスクが完了しました',
    stopped: 'タスクを停止しました',
    failed: 'タスクは未完了のまま終了しました',
    notStarted: 'タスクを開始できませんでした',
    doneLine: 'Copilot がタスクを完了しました。行われた内容は copilot-operator のチャットにあります。',
    stoppedLine: '停止しました。これ以上は何も送信されません。',
    blockedLine: 'Copilot はタスクを完了できませんでした',
    failedLine: 'エラーで終了しました',
    limitLine: '設定の上限で停止しました',
    notStartedLine: '何も送信されませんでした',
    statusOf: { done: '完了', aborted: '停止', blocked: 'ブロック', failed: 'エラー', 'limit-reached': '上限で停止', queued: '未開始' },
    keep: 'このウィンドウは次のメッセージのために開いたままです。いつでも閉じることができます。',
    ok: 'OK',
    quote: (s: string) => `「${s}」`,
  },
  ko: {
    done: '작업이 완료되었습니다',
    stopped: '작업이 중지되었습니다',
    failed: '작업이 완료되지 않은 채 끝났습니다',
    notStarted: '작업을 시작할 수 없었습니다',
    doneLine: 'Copilot이 작업을 마쳤습니다. 수행된 내용은 copilot-operator 채팅에 있습니다.',
    stoppedLine: '중지되었습니다. 더 이상 아무것도 보내지 않습니다.',
    blockedLine: 'Copilot이 작업을 마치지 못했습니다',
    failedLine: '오류로 끝났습니다',
    limitLine: '설정의 한도에서 멈췄습니다',
    notStartedLine: '아무것도 보내지 않았습니다',
    statusOf: { done: '완료', aborted: '중지됨', blocked: '차단됨', failed: '오류', 'limit-reached': '한도 도달', queued: '시작 안 됨' },
    keep: '이 창은 다음 메시지를 위해 열려 있습니다. 언제든지 닫을 수 있습니다.',
    ok: '확인',
    quote: (s: string) => `‘${s}’`,
  },
  ar: {
    done: 'اكتملت المهمة',
    stopped: 'تم إيقاف المهمة',
    failed: 'انتهت المهمة دون إكمالها',
    notStarted: 'تعذّر بدء المهمة',
    doneLine: 'أنهى Copilot المهمة. ما تم إنجازه موجود في دردشة copilot-operator.',
    stoppedLine: 'تم إيقافها؛ لن يُرسل أي شيء آخر.',
    blockedLine: 'لم يتمكن Copilot من إنهائها',
    failedLine: 'انتهت بخطأ',
    limitLine: 'توقفت عند حد من الإعدادات',
    notStartedLine: 'لم يُرسل أي شيء',
    statusOf: { done: 'مكتملة', aborted: 'متوقفة', blocked: 'محظورة', failed: 'بخطأ', 'limit-reached': 'عند حد', queued: 'لم تبدأ' },
    keep: 'تبقى هذه النافذة مفتوحة لرسالتك التالية. يمكنك إغلاقها في أي وقت.',
    ok: 'موافق',
    quote: (s: string) => `«${s}»`,
  },
};

/** The languages written right to left: the card is drawn that way for them. */
const RIGHT_TO_LEFT = new Set(['ar']);

/** A reason as a line: its first sentence or so, since the whole of it is in the chat. */
function brief(text: string | undefined, max = 220): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The card for a run of the chat that has ended: how its message(s) ended, and that the window stays open. */
export function chatNotice(lang: NoticeLang, tasks: NoticeTask[], error?: string): WindowNotice {
  const w = WORDS[lang] ?? WORDS.en!;
  const ran = tasks.filter((t) => t.status !== 'queued');
  const unfinished = ran.filter((t) => t.status !== 'done' && t.status !== 'aborted');
  const stopped = ran.some((t) => t.status === 'aborted');
  const kind = unfinished.length > 0 ? 'failed' : stopped ? 'stopped' : ran.length > 0 ? 'done' : error ? 'notStarted' : 'stopped';
  const subject = tasks.length === 1 ? w.quote(tasks[0]!.title) : undefined;
  const lines: string[] = [];
  if (tasks.length > 1) {
    for (const t of tasks) lines.push(`${w.quote(t.title)} — ${w.statusOf[t.status] ?? t.status}`);
  } else if (kind === 'done') {
    lines.push(w.doneLine);
  } else if (kind === 'stopped') {
    lines.push(w.stoppedLine);
  } else if (kind === 'notStarted') {
    lines.push(`${w.notStartedLine}: ${brief(error)}`);
  } else {
    const t = unfinished[0]!;
    const said = t.status === 'blocked' ? w.blockedLine : t.status === 'limit-reached' ? w.limitLine : w.failedLine;
    const why = brief(t.status === 'blocked' ? t.summary || t.reason : t.reason || t.summary);
    lines.push(why ? `${said}: ${why}` : `${said}.`);
  }
  lines.push(w.keep);
  return {
    tone: kind === 'done' ? 'done' : kind === 'stopped' ? 'stopped' : 'failed',
    title: w[kind],
    ...(subject ? { subject } : {}),
    lines,
    button: w.ok,
    ...(RIGHT_TO_LEFT.has(lang) ? { dir: 'rtl' as const } : {}),
  };
}
