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
import { availableShells, detectShells, type Shell } from '../exec/shells.js';
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
 * The heading the operator's persona gets when it opens a task's level 2.
 *
 * A way of working, not a character, so it is headed by what it is for rather than by a name —
 * the operator's persona is nameless on purpose, so that it can be swapped for another when a
 * different kind of work needs a different approach.
 */
export const PERSONA_HEADER = '## How to carry out this work';

/**
 * The line that closes the persona, written out rather than inferred.
 *
 * The persona is free text the operator wrote, and it may carry headings and rules of its own, so
 * "up to the next heading" would cut it wherever it happened to use one. The plan export has to lift
 * it back out exactly — an exported plan imported again must get the persona that is in the field at
 * that moment, not the old one and the new one stacked — and an explicit end is the only thing that
 * makes that exact. It reads as a plain aside to the model that sees it.
 */
export const PERSONA_END = '(end of how to carry out this work)';

/** The persona as it opens a task's level 2, or nothing when there is none. */
export function personaBlock(persona: string): string {
  const body = persona.trim();
  return body ? `${PERSONA_HEADER}\n\n${body}\n\n${PERSONA_END}` : '';
}

/**
 * A level 2 with any persona block at its head taken off.
 *
 * Used both ways round: by the plan export, so the file it writes is the plan without the approach
 * that happened to be in force, and by `composeLevel2`, so a plan that already carries a persona —
 * hand-written, or exported from somewhere that did not strip it — gets the current one instead of a
 * second one.
 */
export function withoutPersona(level2: string): string {
  const text = level2.trimStart();
  if (!text.startsWith(PERSONA_HEADER)) return level2;
  const end = text.indexOf(PERSONA_END);
  if (end < 0) return level2;
  return text.slice(end + PERSONA_END.length).replace(/^\s+/, '');
}

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

/**
 * Level 2 for one task: the operator's persona first, then its own instructions if it has any,
 * otherwise the session's, goal first.
 *
 * The persona goes on every task, whichever branch the rest takes, because it is how *all* of this
 * work is carried out — a task with instructions of its own replaces the session's instructions,
 * not the approach. It is written in here rather than sent separately so that it travels with every
 * task: level 2 is repeated with each task in the conversation, and a long conversation loses its
 * early turns, which is where a once-sent persona would have been. It sits inside level 2 and so
 * under level 1, which it cannot change — the persona is the operator's approach, not a way round
 * the runner's contract.
 */
export function composeLevel2(session: PlanSession, task: PlanTask, persona = ''): string {
  const rest = level2Without(session, task);
  const block = personaBlock(persona);
  if (!block) return rest;
  return rest ? `${block}\n\n${rest}` : block;
}

/** The task's own level 2 if it has any, otherwise the session's, goal first — persona excluded. */
function level2Without(session: PlanSession, task: PlanTask): string {
  const own = withoutPersona(task.level2).trim();
  if (own) return own;
  const shared = withoutPersona(session.level2).trim();
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
 * Checks that name a shell this machine has not got.
 *
 * A warning rather than a refusal, which is the line this importer already draws: a plan is
 * refused for what is wrong with the document and warned about for what is wrong with running
 * it here. The document is fine — `shell: "pwsh"` is a legal thing for a plan to ask for — and
 * the same plan is correct on the machine it was written for, so refusing it would be refusing
 * the wrong thing. But a check that asks for an interpreter this machine cannot start will end
 * its task on a configuration error rather than on the work, and the moment to hear that is now,
 * while the queue is still sitting in front of somebody, and not four tasks into a run.
 *
 * One line per missing shell, not one per check: the fix is the same for all of them.
 */
function unavailableShellWarnings(plan: Plan): string[] {
  const inventory = detectShells();
  const here = availableShells(inventory);
  const asked = new Map<Shell, string[]>();

  for (const session of plan.sessions) {
    for (const task of session.tasks) {
      for (const check of task.checks) {
        if (!check.shell || inventory.found[check.shell]) continue;
        asked.set(check.shell, [...(asked.get(check.shell) ?? []), `"${check.name}" in "${task.title}"`]);
      }
    }
  }

  return [...asked].map(([shell, checks]) => {
    const named = checks.slice(0, 3).join(', ');
    return (
      `${checks.length} check(s) ask to run in ${shell}, which is not installed on this machine: ${named}` +
      `${checks.length > 3 ? `, and ${checks.length - 3} more` : ''}. ` +
      `They will end their task with a configuration error rather than run. Install ${shell}, or edit those checks to ` +
      `use one of the shells that are here${here.length > 0 ? ` (${here.join(', ')})` : ''}.`
    );
  });
}

/**
 * Creates everything the plan describes.
 *
 * `defaultModel` is written onto a session the plan names no model for. The service passes
 * nothing: such a session follows the model chosen in Settings at the time it runs, like one made
 * by hand in the UI. Kept as a parameter for a caller that wants the old, copied behaviour.
 */
export async function importPlan(
  store: SessionStore,
  plan: Plan,
  defaultModel = '',
  defaultReviewModel = '',
  /** The operator's persona at the moment of import, written into every task's level 2. */
  persona = '',
): Promise<ImportResult> {
  const sessions: ImportedSession[] = [];
  const warnings: string[] = [...unavailableShellWarnings(plan)];

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
    // A branch to carry on, given alone, is that choice: see `VersionControl.startFrom`.
    if (vcs.existingBranch?.trim()) vcs.startFrom = 'existing-branch';

    const group = planned.conversationGroup.trim() || sharedGroup;
    await store.updateSession(created.id, (s: Session) => {
      s.onFailure = planned.onFailure;
      // Absent means reviewed, which is the default everywhere else too.
      // The reviewing model follows the same rule as the working one: the plan's word, else
      // the standing default, else the session's own.
      s.review = { enabled: planned.review?.enabled !== false, model: (planned.review?.model || defaultReviewModel).trim() };
      s.conversationGroup = group || undefined;
      s.model = (planned.model || defaultModel).trim() || undefined;
      s.planName = plan.plan.trim() || undefined;
      s.vcs = vcs;
    });

    const titles: string[] = [];
    for (const task of planned.tasks) {
      const added = await store.addTask(created.id, {
        title: task.title,
        level2: composeLevel2(planned, task, persona),
        prompt: composePrompt(task),
        // Kept even when version control is off for this session: the operator may turn it on
        // afterwards, and throwing away a name the plan chose would make that a worse session
        // than the same one imported a minute later.
        vcsPlan: task.vcs,
        checks: task.checks,
        reviewEnabled: task.review,
        readOnly: task.readOnly || undefined,
        scope: task.scope.length > 0 ? task.scope : undefined,
      });
      titles.push(added.title);
    }

    sessions.push({ id: created.id, name: created.name, tasks: titles.length, titles });
  }

  return { sessions, taskCount: sessions.reduce((n, s) => n + s.tasks, 0), warnings };
}
