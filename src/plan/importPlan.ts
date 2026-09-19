/**
 * Turning a validated plan into real sessions and real queued tasks.
 *
 * The importer only ever adds. It creates new sessions rather than editing existing ones,
 * even when a name matches, because a plan arrives from outside the system and a document
 * that silently rewrote a session someone is in the middle of would be the worst kind of
 * import: one that looks like it worked.
 *
 * Nothing is started here. The import ends with a queue and an untouched Start button, which
 * is the one moment the operator gets to read what a chat model decided on their behalf.
 */
import type { SessionStore } from '../session/store.js';
import { DEFAULT_MIRROR, DEFAULT_VCS } from '../session/store.js';
import type { Session } from '../session/model.js';
import type { Plan, PlanSession, PlanTask } from './schema.js';

export type ImportedSession = {
  id: string;
  name: string;
  tasks: number;
  /** Task titles in the order they were queued, which is the order they will run in. */
  titles: string[];
};

export type ImportResult = {
  sessions: ImportedSession[];
  taskCount: number;
  /** Anything worth telling the operator that did not stop the import. */
  warnings: string[];
};

/** The heading under which a task's acceptance bar reaches Copilot. English, like level 1. */
const EXPECTED_HEADER = '### Expected result';
/** The heading the session's goal gets when it opens the level-2 instructions. */
const GOAL_HEADER = '## Goal of this session';

/**
 * The text of one task as Copilot will receive it.
 *
 * The prompt and the acceptance bar are joined here rather than in the schema so that the
 * stored task is exactly what was sent: a task that can be re-read a month later and matched
 * against its summary, with no second document to consult.
 */
export function composePrompt(task: PlanTask): string {
  const prompt = task.prompt.trim();
  const expected = task.expected.trim();
  if (!expected) return prompt;
  return `${prompt}\n\n${EXPECTED_HEADER}\n\n${expected}`;
}

/** Level 2 for one task: its own if it has any, otherwise the session's, goal first. */
export function composeLevel2(session: PlanSession, task: PlanTask): string {
  const own = task.level2.trim();
  if (own) return own;
  const shared = session.level2.trim();
  const goal = session.goal.trim();
  if (!goal) return shared;
  return shared ? `${GOAL_HEADER}\n\n${goal}\n\n${shared}` : `${GOAL_HEADER}\n\n${goal}`;
}

/**
 * What makes two tasks the same task, for the purpose of spotting a plan imported twice.
 *
 * The title and the text that would actually be sent. Not the level 2, and not the branch or
 * the commit message: those can be edited on the session afterwards, and a plan re-pasted
 * with a better commit subject is still the same plan being imported a second time.
 */
export function taskSignature(task: { title: string; prompt: string }): string {
  return `${task.title.trim()}\u0000${task.prompt.trim()}`;
}

/** The same, for a whole session as the plan describes it. */
export function plannedSessionSignature(session: PlanSession): string {
  return session.tasks.map((t) => taskSignature({ title: t.title, prompt: composePrompt(t) })).join('\u0001');
}

/**
 * Creates everything the plan describes.
 *
 * `defaultModel` is what a session starts on when the plan does not name one, which keeps an
 * imported session behaving like one made by hand in the UI.
 */
export async function importPlan(store: SessionStore, plan: Plan, defaultModel = ''): Promise<ImportResult> {
  const sessions: ImportedSession[] = [];
  const warnings: string[] = [];

  /*
   * One conversation for the whole plan, when it asked for that.
   *
   * The group is named after the plan, or after the moment of import when the plan has no name,
   * because the name is what a session in the UI is shown and typed against later. A session
   * that named its own group keeps it: a plan may want most of its sessions together and one
   * of them apart.
   */
  const sharedGroup =
    plan.conversation === 'shared'
      ? (plan.plan.trim() || `plan-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}`).slice(0, 60)
      : '';

  for (const planned of plan.sessions) {
    const mirror = { ...DEFAULT_MIRROR, ...(planned.mirror ?? {}) };
    if (mirror.enabled && !mirror.rootDir.trim()) {
      mirror.enabled = false;
      warnings.push(
        `Session "${planned.name}" asked for project files without a root folder, so file attachment was left off.`,
      );
    }

    const created = await store.createSession(planned.name, mirror);
    const vcs = { ...DEFAULT_VCS, ...(planned.vcs ?? {}) };
    vcs.branchPrefix = vcs.branchPrefix.trim() || DEFAULT_VCS.branchPrefix;
    vcs.repoDir = vcs.repoDir.trim();

    const group = planned.conversationGroup.trim() || sharedGroup;
    await store.updateSession(created.id, (s: Session) => {
      s.onFailure = planned.onFailure;
      // Absent means reviewed, which is the default everywhere else too.
      s.review = { enabled: planned.review?.enabled !== false, model: (planned.review?.model ?? '').trim() };
      s.conversationGroup = group || undefined;
      s.model = (planned.model || defaultModel).trim() || undefined;
      s.vcs = vcs;
    });

    const titles: string[] = [];
    for (const task of planned.tasks) {
      const added = await store.addTask(created.id, {
        title: task.title,
        level2: composeLevel2(planned, task),
        prompt: composePrompt(task),
        // Kept even when version control is off for this session: the operator may turn it on
        // afterwards, and throwing away a name the plan chose would make that a worse session
        // than the same one imported a minute later.
        vcsPlan: task.vcs,
        checks: task.checks,
        reviewEnabled: task.review,
      });
      titles.push(added.title);
    }

    sessions.push({ id: created.id, name: created.name, tasks: titles.length, titles });
  }

  return { sessions, taskCount: sessions.reduce((n, s) => n + s.tasks, 0), warnings };
}
