/**
 * Turns what a task did into one document the operator can keep.
 *
 * Everything here already exists on disk: the opening message is on the task, every reply is
 * under `replies/`, every report that was sent back is under `reports/`. What was missing was
 * a way to hand someone the record without explaining the folder layout first.
 *
 * Two shapes, because two questions get asked about a finished task:
 *
 *   `full`    the whole conversation, in order, both sides. For reading what actually
 *             happened, step by step, or for attaching to a bug report.
 *   `outcome` only the first message and the last one. The first says what the task was
 *             asked to do, the last says what was done: expected and actual, side by side,
 *             with nothing in between to wade through.
 *
 * A task whose run folder is gone still exports: the opening message, the summary and the
 * final reply are kept on the session itself, so the record survives a cleaned `runs/`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Task } from './model.js';
import { describeDeviations } from '../protocol/replySchema.js';

export type ExportVariant = 'full' | 'outcome';

export type ExportInput = {
  session: Session;
  tasks: Task[];
  variant: ExportVariant;
  /** Where the run folders live, so the conversation can be read back. */
  runsDir: string;
};

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function heading(text: string): string {
  return `\n${RULE}\n${text}\n${RULE}\n`;
}

function when(iso?: string): string {
  return iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

/**
 * The conversation of one task, reconstructed from the run folder.
 *
 * Replies are numbered by the transport as `NN-<label>.md`, so their names sort into the
 * order they arrived. A reply labelled `iteration-K` was the answer to report K, which is why
 * the report is emitted just before it: that pairing is what makes the document read like a
 * conversation rather than two separate piles of text.
 */
async function conversationOf(task: Task, runsDir: string): Promise<string[]> {
  const out: string[] = [];
  if (!task.runId) return out;

  const base = join(runsDir, task.runId);
  const replies = (await readdir(join(base, 'replies')).catch(() => [] as string[]))
    .filter((n) => n.endsWith('.md'))
    .sort();

  let openingWritten = false;
  for (const name of replies) {
    const label = name.replace(/^\d+-/, '').replace(/\.md$/, '');

    if (label.startsWith('opening')) {
      if (!openingWritten && task.firstMessage) {
        out.push(`${heading('SENT — the message that opened the task')}${task.firstMessage.trimEnd()}`);
        openingWritten = true;
      }
    } else if (label.startsWith('iteration')) {
      const n = label.split('-')[1];
      const report = await readFile(join(base, 'reports', `iteration-${n}.txt`), 'utf8').catch(() => null);
      out.push(
        `${heading(`SENT — the report after iteration ${n}`)}${
          report ? report.trimEnd() : '(the report file is no longer in the run folder)'
        }`,
      );
    } else if (label.startsWith('format-retry')) {
      out.push(heading('SENT — a request to keep the agreed format').trimEnd());
    }

    const body = await readFile(join(base, 'replies', name), 'utf8').catch(() => '');
    out.push(`${heading(`RECEIVED — ${label}`)}${body.trimEnd()}`);
  }

  if (!openingWritten && task.firstMessage) {
    out.unshift(`${heading('SENT — the message that opened the task')}${task.firstMessage.trimEnd()}`);
  }
  return out;
}

/**
 * What version control did for one task, as lines in the record.
 *
 * This belongs in the document rather than only on screen. The question someone asks weeks
 * later is "where did this change go", and the answer — the branch, the commit it started
 * from, the commits it produced — is not reconstructable from a summary. `commits` is the
 * list the runner read back from the repository after committing, so the count is what is
 * actually on that branch since it was cut, not what anybody assumed.
 */
function versionControlLines(task: Task, session: Session): string[] {
  const vcs = task.vcs;
  if (!session.vcs?.enabled) return ['version control : off for this session'];
  if (!vcs || (!vcs.branch && !vcs.problem)) return ['version control : nothing was recorded for this task'];
  if (!vcs.branch) return [`version control : did not run — ${vcs.problem}`];

  const commits = vcs.commits ?? [];
  const lines = [
    `branch     : ${vcs.branch}`,
    `started at : ${vcs.baseCommit ? vcs.baseCommit.slice(0, 8) : '—'} (the commit this task branched from)`,
    `commit     : ${vcs.commit ? vcs.commit.slice(0, 8) : 'none — the task changed no files'}`,
    `commits    : ${commits.length} on this branch since it was cut`,
  ];
  for (const line of commits) lines.push(`             ${line}`);

  const files = vcs.files ?? [];
  if (files.length > 0) {
    lines.push(`files      : ${files.length} changed by this task's commit`);
    for (const f of files) {
      const counts = f.added < 0 || f.removed < 0 ? 'binary' : `+${f.added} -${f.removed}`;
      lines.push(`             ${counts.padEnd(12)} ${f.path}`);
    }
  } else if (vcs.commit) {
    lines.push('files      : none recorded for this commit');
  }
  lines.push('pushed     : no — this runner never pushes');
  if (vcs.problem) lines.push(`note       : ${vcs.problem}`);

  const earlier = (task.attempts ?? []).map((a) => a.vcs?.branch).filter(Boolean);
  if (earlier.length > 0) {
    lines.push(`earlier    : ${earlier.join(', ')} (branches of the previous attempts, untouched)`);
  }
  return lines;
}

/** One task's section of the document. */
async function sectionFor(task: Task, index: number, input: ExportInput): Promise<string> {
  const parts: string[] = [];

  parts.push(heading(`TASK ${index}: ${task.title}`).trimStart());
  parts.push(
    [
      `status     : ${task.status}`,
      `attempt    : ${task.attempt ?? 1}${(task.attempts?.length ?? 0) > 0 ? ` (earlier attempts: ${task.attempts?.length})` : ''}`,
      `started    : ${when(task.startedAt)}`,
      `finished   : ${when(task.finishedAt)}`,
      `iterations : ${task.iterations}`,
      `run folder : ${task.runId ?? '(never started)'}`,
    ].join('\n'),
  );

  parts.push(`\n${THIN}\nVERSION CONTROL\n${THIN}`);
  parts.push(versionControlLines(task, input.session).join('\n'));

  /*
   * What the second opinion concluded, kept in the record because it is the part a reader
   * cannot reconstruct. A summary says what the implementer believes about its own work; this
   * says what somebody who had no part in it found when they ran the thing.
   */
  if (task.review && task.review.verdict !== 'skipped') {
    const r = task.review;
    parts.push(`\n${THIN}\nINDEPENDENT REVIEW\n${THIN}`);
    parts.push(
      [
        `verdict   : ${r.verdict}`,
        `rounds    : ${r.rounds}`,
        `commands  : ${r.stepsRun} run by the reviewer`,
        r.model ? `model     : ${r.model}` : '',
        r.problem ? `problem   : ${r.problem}` : '',
        r.summary ? `\n${r.summary}` : '',
        (r.findings ?? []).length > 0
          ? '\n' +
            (r.findings ?? [])
              .map((f, i) => `${i + 1}. ${f.what}${f.where ? ` (${f.where})` : ''}\n   Evidence: ${f.evidence}`)
              .join('\n\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /*
   * The expectation is the task as it was written, not the whole first message.
   *
   * The first message of a session carries the level-1 contract in front of the task, which
   * runs to several pages. Putting that under "EXPECTED" buries the one paragraph the reader
   * is comparing against the outcome. The exact first message is not lost: the full variant
   * prints it verbatim as the first thing in the conversation.
   */
  parts.push(`\n${THIN}\nEXPECTED — the task as it was written\n${THIN}`);
  parts.push(task.prompt.trimEnd() || '(the task had no text)');

  if (task.level2.trim()) {
    parts.push(`\n${THIN}\nEXPECTED — the project instructions sent with it (level 2)\n${THIN}`);
    parts.push(task.level2.trimEnd());
  }

  if (task.firstMessage && task.firstMessage.includes('Level 1')) {
    parts.push('\n(The level 1 contract was sent in front of this task. It is in the full variant.)');
  }

  parts.push(`\n${THIN}\nACTUAL — what came back\n${THIN}`);
  if (task.summary) parts.push(task.summary.trimEnd());
  else if (task.reason) parts.push(`The task did not finish with a summary. Reason: ${task.reason}`);
  else parts.push('(no closing summary)');

  // Right under the outcome, because this is the part of it the reader is least likely to
  // expect: the task said one thing, and the model — with a reason — did another.
  if ((task.deviations ?? []).length > 0) {
    parts.push(`\n${THIN}\nNOT AS THE TASK SAID — instructions the model could not follow as written\n${THIN}`);
    parts.push(describeDeviations(task.deviations ?? []));
  }

  if (task.finalReply && task.finalReply.trim() !== (task.summary ?? '').trim()) {
    parts.push(`\n${THIN}\nACTUAL — the last message in full\n${THIN}`);
    parts.push(task.finalReply.trimEnd());
  }

  if (input.variant === 'full') {
    const conversation = await conversationOf(task, input.runsDir);
    if (conversation.length > 0) {
      parts.push(`\n${THIN}\nTHE WHOLE CONVERSATION, IN ORDER\n${THIN}`);
      parts.push(conversation.join('\n'));
    } else {
      parts.push(`\n${THIN}\nTHE WHOLE CONVERSATION, IN ORDER\n${THIN}`);
      parts.push('(the run folder is not on this machine any more, so only the record above is left)');
    }
  }

  return `${parts.join('\n')}\n`;
}

/** The whole document, plus a file name that says what it is without being opened. */
export async function buildExport(input: ExportInput): Promise<{ fileName: string; content: string }> {
  const { session, tasks, variant } = input;

  const header = [
    `copilot-operator — ${variant === 'full' ? 'the whole conversation' : 'expected and actual'}`,
    '',
    `session    : ${session.name} (${session.id})`,
    `chat       : ${session.chat?.url ?? '(no conversation was opened)'}`,
    `model      : ${session.model || 'whatever the chat was set to'}${session.modelInUse ? ` (ran on ${session.modelInUse})` : ''}`,
    `repository : ${
      session.vcs?.enabled
        ? `${session.vcs.repoDir || session.mirror.rootDir || '(none set)'} — ${
            session.vcs.branchMode === 'per-session' ? 'one branch for the whole session' : 'a branch of its own for every task'
          }, prefix ${session.vcs.branchPrefix}${session.vcs.commitOnFinish ? '' : ', commits off'}`
        : 'version control is off for this session'
    }`,
    `tasks      : ${tasks.length} of ${session.tasks.length}`,
    `exported   : ${when(new Date().toISOString())}`,
    '',
    variant === 'full'
      ? 'Every message of every selected task, in the order it was sent or received.'
      : 'For each selected task: the message that opened it, and what came back at the end.',
  ].join('\n');

  const sections: string[] = [];
  for (const [i, task] of tasks.entries()) {
    sections.push(await sectionFor(task, i + 1, input));
  }

  const safeName = session.name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '-') || 'session';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
  const kind = variant === 'full' ? 'full' : 'expected-actual';

  return {
    fileName: `${safeName}-${kind}-${stamp}.txt`,
    content: `${header}\n${sections.join('\n')}`,
  };
}
