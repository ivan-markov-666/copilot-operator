/**
 * The shape of a plan: sessions and their tasks, as one JSON document.
 *
 * The document is not written by hand. The user takes a brief (see `brief.ts`) to whatever
 * chat model they like, that model interviews them about the work, and it answers with a
 * document in this shape. So the schema has two audiences at once: the importer, which needs
 * it to be exact, and a language model, which needs the refusals to say what to fix. That is
 * why nothing here fails with "invalid input" — every issue comes back with a path into the
 * document and a sentence that can be pasted straight back into the chat.
 *
 * Unknown fields are kept out of the imported data but do not fail the import. A model that
 * adds `"description"` to a task has not misunderstood the format badly enough to be worth
 * sending the user back to the chat; it is reported as a warning instead.
 */
import { z } from 'zod';
import { namesEverything } from '../vcs/inputs.js';
import { coveredByArtifacts } from '../vcs/artifacts.js';

export const PLAN_VERSION = 1;

/**
 * Version control, exactly as a session stores it, and required on every session.
 *
 * Required because this is the one decision in a plan that cannot be given a safe default. On
 * means the runner branches and commits and there is a way back from every task; off means the
 * files are changed where they lie and there is not. Guessing either way produces a plan that
 * looks fine and is wrong about the thing that matters most, so the model writing the plan has
 * to ask, and a document that skips the question is refused with the question in it.
 */
const VcsInput = z
  .object(
    {
      enabled: z.boolean({
        error:
          'vcs.enabled must be true or false. Ask the user whether the runner should make a branch before each task and a commit after it; there is no default for this.',
      }),
      repoDir: z.string().trim().default(''),
      branchMode: z
        .enum(['per-task', 'per-session'], {
          error: 'branchMode must be "per-task" (every task starts from the same commit) or "per-session" (one branch, tasks build on each other).',
        })
        .optional(),
      commitOnFinish: z.boolean().optional(),
      branchPrefix: z.string().optional(),
      /** The name of the one branch a per-session run works on. Ignored in per-task mode. */
      branchName: z.string().optional(),
      /**
       * Where the session's first branch is cut from: a local branch (`baseBranch`, `main` unless
       * said otherwise), or the end of the branch of the session before it in the same repository.
       * Absent keeps the old behaviour, wherever the repository is. See `VersionControl.startFrom`.
       */
      startFrom: z
        .enum(['branch', 'previous-session', 'head', 'existing-branch'], {
          error:
            'startFrom must be "branch" (every session starts from the local branch in baseBranch, "main" unless said otherwise), "previous-session" (each session carries on from the branch of the session before it in the same repository) or "existing-branch" (the session works on the existing branch named in existingBranch).',
        })
        .optional(),
      /** The local branch `startFrom: "branch"` starts from, and `previous-session`'s fallback. */
      baseBranch: z.string().trim().optional(),
      /**
       * The existing local branch the whole session works on, exactly as named: no new branch, no
       * prefix. Given alone it means `startFrom: "existing-branch"`. See `VersionControl.startFrom`.
       */
      existingBranch: z.string().trim().optional(),
      /**
       * Fetch and fast-forward the branch the session starts from before its first branch is cut.
       * Absent means true. See `VersionControl.updateFromRemote`.
       */
      updateFromRemote: z.boolean().optional(),
      /**
       * What the session's first run does with uncommitted changes. See `DirtyWorktree`. Accepts the
       * longer spelling a chat model may write — `includeUntracked: false` is `tracked-only-snapshot`,
       * and `includeIgnoredOnlyWhenScoped` can only be true, since that is the rule, not a choice.
       */
      dirtyWorktree: z
        .object({
          policy: z.enum(['reject', 'snapshot', 'tracked-only-snapshot'], {
            error:
              'dirtyWorktree.policy must be "reject" (uncommitted changes keep version control out, as until now), "snapshot" (they become the commit the session starts from) or "tracked-only-snapshot" (the same, tracked changes only). "discard" is not offered: the runner never throws work away.',
          }),
          requireApproval: z.boolean().optional(),
          includeUntracked: z.boolean().optional(),
          includeIgnoredOnlyWhenScoped: z
            .literal(true, { error: 'dirtyWorktree.includeIgnoredOnlyWhenScoped can only be true: an ignored file goes into a snapshot only when a task\'s scope names it. Leave the field out.' })
            .optional(),
        })
        .optional(),
      /**
       * The operator's input files. See `UserInputs`. Accepts the spelling a chat model may write:
       * `capture` can only be "baseline-commit", `allowUntracked`/`allowIgnored` only true (an input
       * may be either), `readOnlyAfterCapture` is `readOnly`.
       */
      userInputs: z
        .object({
          enabled: z.boolean().optional(),
          paths: z.array(z.string().trim()).default([]),
          capture: z.literal('baseline-commit', { error: 'userInputs.capture can only be "baseline-commit": input files go into the commit the session starts from. Leave the field out.' }).optional(),
          allowUntracked: z.literal(true, { error: 'userInputs.allowUntracked can only be true: an input file may be untracked. Leave the field out.' }).optional(),
          allowIgnored: z.literal(true, { error: 'userInputs.allowIgnored can only be true: an input file may be ignored by git. Leave the field out.' }).optional(),
          readOnly: z.boolean().optional(),
          readOnlyAfterCapture: z.boolean().optional(),
          requireApproval: z.boolean().optional(),
        })
        .optional(),
      /**
       * Evidence kept with the run and never committed. See `VersionControl.artifacts`. `commit` can
       * only be false and `attachToRun`/`allowIgnored` only true: that is what an artifact is.
       */
      artifacts: z
        .object({
          paths: z.array(z.string().trim()).default([]),
          allowIgnored: z.literal(true, { error: 'artifacts.allowIgnored can only be true. Leave the field out.' }).optional(),
          attachToRun: z.literal(true, { error: 'artifacts.attachToRun can only be true: artifacts are always kept with the run. Leave the field out.' }).optional(),
          commit: z.literal(false, { error: 'artifacts.commit can only be false: an artifact is never committed. Files that should be committed are the work, not artifacts.' }).optional(),
        })
        .optional(),
    },
    {
      error:
        'Every session needs a "vcs" object saying whether the runner does version control for it and, when it does, which git repository to work in. Ask the user both questions and write the answers here.',
    },
  )
  .superRefine((vcs, ctx) => {
    if (vcs.startFrom === 'existing-branch' && !vcs.existingBranch) {
      ctx.addIssue({
        code: 'custom',
        path: ['existingBranch'],
        message: 'startFrom is "existing-branch", so "existingBranch" must name the local branch to carry on, exactly as it is in git (for example "recovery/apz-migration").',
      });
    }
    if (vcs.existingBranch && vcs.startFrom && vcs.startFrom !== 'existing-branch') {
      ctx.addIssue({
        code: 'custom',
        path: ['existingBranch'],
        message: `"existingBranch" carries on a branch that exists, and startFrom "${vcs.startFrom}" cuts a new one. Keep one: startFrom "existing-branch" with existingBranch, or leave existingBranch out.`,
      });
    }
    if (vcs.dirtyWorktree?.policy === 'tracked-only-snapshot' && vcs.dirtyWorktree.includeUntracked === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['dirtyWorktree', 'includeUntracked'],
        message: '"tracked-only-snapshot" takes tracked changes only, and includeUntracked true asks for new files too. Keep one: policy "snapshot", or leave includeUntracked out.',
      });
    }
    for (const [i, p] of (vcs.userInputs?.paths ?? []).entries()) {
      if (namesEverything(p)) {
        ctx.addIssue({ code: 'custom', path: ['userInputs', 'paths', i], message: `"${p}" names the whole repository; an input pattern names the operator's files, such as "rules-engine/test-data/schemas/*.yaml".` });
      }
    }
    if (vcs.userInputs && vcs.userInputs.enabled !== false && (vcs.userInputs.paths ?? []).length > 0 && !vcs.enabled) {
      ctx.addIssue({ code: 'custom', path: ['userInputs'], message: 'userInputs needs version control on: the input files go into the commit the session starts from. Turn vcs.enabled on, or leave userInputs out.' });
    }
    const hidden = coveredByArtifacts(vcs.userInputs?.paths ?? [], vcs.artifacts?.paths ?? []);
    if (hidden.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', 'paths'],
        message:
          `An artifacts pattern covers the input files ${hidden.map((h) => `"${h}"`).join(', ')}: artifacts are kept out of git, so the inputs would be too. ` +
          'Name only the folders the evidence is written to (for example "rules-engine/test-results/**"), not a whole project folder.',
      });
    }
    if (vcs.enabled && !vcs.repoDir.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['repoDir'],
        message:
          'Version control is on for this session, so "repoDir" must be the absolute path of the git repository to work in. Ask the user which folder that is; do not guess one.',
      });
    }
  });

/**
 * One condition that has to hold before the task is allowed to end.
 *
 * The kinds are deliberately few and deliberately mechanical. This runner has no language
 * model of its own, so a check it cannot decide by running something and comparing is a check
 * it would have to take on trust — which is the thing the check exists to replace.
 */
export const CheckInput = z
  .object({
    name: z.string().trim().min(3, 'A check needs a name saying what it is checking.'),
    expect: z.enum(
      [
        'exit-zero',
        'exit-nonzero',
        'output-contains',
        'output-omits',
        'output-matches',
        'file-exists',
        'file-missing',
        'file-contains',
      ],
      {
        error:
          'expect must be one of: exit-zero, exit-nonzero, output-contains, output-omits, output-matches, ' +
          'file-exists, file-missing, file-contains.',
      },
    ),
    run: z.string().trim().optional(),
    /**
     * The shell to run it in. Left out is the usual answer and the better one.
     *
     * A check that names a shell is asking for that shell and nothing else: on a machine without
     * it the check does not quietly run somewhere else, it ends its task with a configuration
     * error saying what is missing. Left out, it takes whatever the machine has, in the order
     * pwsh, powershell, cmd. See `exec/shells.ts`.
     */
    shell: z.enum(['pwsh', 'powershell', 'cmd']).optional(),
    cwd: z.string().trim().optional(),
    file: z.string().trim().optional(),
    value: z.string().optional(),
  })
  .superRefine((check, ctx) => {
    const needsCommand = check.expect.startsWith('exit-') || check.expect.startsWith('output-');
    const needsFile = check.expect.startsWith('file-');
    const needsValue = check.expect === 'output-contains' || check.expect === 'output-omits' ||
      check.expect === 'output-matches' || check.expect === 'file-contains';

    if (needsCommand && !check.run?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['run'], message: `"${check.expect}" is about a command, so "run" is required.` });
    }
    if (needsFile && !check.file?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['file'], message: `"${check.expect}" is about a file, so "file" is required.` });
    }
    if (needsValue && !check.value?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `"${check.expect}" needs the text it is looking for, in "value".`,
      });
    }
    if (check.expect === 'output-matches' && check.value) {
      try {
        new RegExp(check.value);
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: `not a valid regular expression: ${(e as Error).message}` });
      }
    }
  });

/**
 * Whether the work is checked by a second, independent conversation.
 *
 * Optional, and on when it is left out — which is the point of leaving it out. A plan that says
 * nothing about reviewing still gets reviewed; a plan that wants a particular model for the
 * review, or wants it off for a session of read-only checks, says so here.
 */
const ReviewInput = z.object({
  enabled: z.boolean().optional(),
  /** The model the review runs on. Empty means the session's own. A different one is better. */
  model: z.string().trim().optional(),
});

/** What one task carries into git: the names, not the outcome. */
const TaskVcsInput = z.object({
  branch: z.string().trim().optional(),
  commitMessage: z.string().trim().optional(),
});

/**
 * What was once the project files copied into the chat, removed on 2026-09-30. Still read, so a plan
 * written before then imports: its `rootDir` becomes the session's project folder, and the rest is
 * ignored with a warning. See `importPlan`.
 */
const LegacyMirrorInput = z.object({ enabled: z.boolean().optional(), rootDir: z.string().optional() }).passthrough();

const TaskInput = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'A task needs a title of at least 3 characters.')
    .max(120, 'Keep the title under 120 characters; the detail belongs in "prompt".'),
  prompt: z
    .string()
    .trim()
    .min(30, 'A task needs a real instruction, not a few words. Say what to do, where, and with what.'),
  /**
   * What must work once the task is done.
   *
   * Separate from the prompt because it is the thing the operator reads the summary against.
   * The importer appends it to the prompt under its own heading, so Copilot receives one text
   * and the record still shows which half was the instruction and which was the bar.
   */
  expected: z.string().trim().default(''),
  /** Level 2 for this task alone. Falls back to the session's. */
  level2: z.string().trim().default(''),
  /**
   * The branch this task works on and the commit it ends with.
   *
   * Both are names for work that has not happened yet, which is exactly what a plan is good
   * at: the model writing it knows what the task is for. Neither is required, and neither is
   * trusted — the branch name is slugified and prefixed like any other, and the runner still
   * decides when to branch and when to commit.
   */
  vcs: TaskVcsInput.optional(),
  /**
   * What must be true before this task is allowed to end.
   *
   * `expected` says it for a person to read; this says it so the runner can decide it. When
   * there are checks, Copilot reporting the task as done is not the end of it: they are run,
   * and a failure goes back to the chat to be fixed.
   */
  checks: z.array(CheckInput).default([]),
  /**
   * Turns the independent review off for this one task.
   *
   * Worth using sparingly: a task whose whole output is a report somebody reads, or a scaffold
   * with nothing to run yet, gains little from a reviewer. Everything that produces something
   * usable gains a lot.
   */
  review: z.boolean().optional(),
  /**
   * A task that must not change files: an audit, a smoke test, a report.
   *
   * Written as a flag rather than as a sentence in the prompt because a sentence is advice.
   * A smoke-test task told in prose to change nothing renamed the page's labels when a
   * reviewer asked it to. With the flag, the runner fails the task if the working tree has
   * changed when it ends, whatever the summary says, and commits the change on the task's
   * branch so nothing is lost and the next task starts clean.
   */
  readOnly: z.boolean().default(false),
  /**
   * The paths this task may change, repository-relative: a file, a folder (`tests/e2e/`), or a
   * pattern with `*` and `**`. Absent or empty means anywhere in the project. Enforced by the runner
   * after every round of steps when version control is on — a change outside is put back and the
   * chat told — which a sentence in the prompt cannot be. See `vcs/scope.ts`.
   */
  scope: z.array(z.string().trim().min(1, 'A scope entry needs a path or a pattern.')).default([]),
  /**
   * Files the task is to produce as evidence (reports, archives), repository-relative patterns.
   * Kept with the run's record when the task creates or changes them. See `Task.outputs`.
   */
  outputs: z.array(z.string().trim().min(1, 'An outputs entry needs a path or a pattern.')).default([]),
  /**
   * What earlier attempts of this task were asked, written by the plan export for a task that has
   * been run more than once (`earlierPlans` in `session/exports.ts`). History, not instruction:
   * accepted so that an exported plan imports again without a warning about it, and then ignored —
   * an imported task starts from its current text, with no attempts behind it.
   */
  earlierAttempts: z.array(z.unknown()).optional(),
});

const SessionInput = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'A session needs a name.')
    .max(80, 'Keep the session name short; it becomes part of every branch name.'),
  /** What the whole session is for. Becomes the opening of its level 2. */
  goal: z.string().trim().default(''),
  /** The chat model, by the exact name the picker shows. Empty leaves the chat alone. */
  model: z.string().trim().default(''),
  /** Whether the tasks are one chain (`stop`) or independent checks (`continue`). */
  onFailure: z
    .enum(['stop', 'continue'], {
      error: 'onFailure must be "stop" (the tasks are one chain) or "continue" (the tasks are independent).',
    })
    .default('stop'),
  /** Level 2 for every task in the session, unless a task overrides it. */
  level2: z.string().trim().default(''),
  /**
   * A name that makes this session share one Copilot conversation with the others that carry
   * the same name. Empty means it gets a conversation of its own.
   */
  conversationGroup: z.string().trim().default(''),
  vcs: VcsInput,
  review: ReviewInput.optional(),
  /**
   * The project folder of a session with version control off: where its commands run. Absent means
   * the default project on the Project page. With version control on, `vcs.repoDir` is required (see
   * `checkPlan`) and the commands run there, so this folder decides nothing for such a session.
   */
  projectDir: z.string().trim().optional(),
  /** Read only for old plans; see `LegacyMirrorInput`. */
  mirror: LegacyMirrorInput.optional(),
  tasks: z.array(TaskInput).min(1, 'A session with no tasks would import as an empty queue.'),
});

export const PlanSchema = z.object({
  version: z.literal(PLAN_VERSION, `This importer reads version ${PLAN_VERSION} plans. Set "version": ${PLAN_VERSION}.`),
  /** A name for the whole document, shown while importing. */
  plan: z.string().trim().default(''),
  /** Anything the model wants on the record: assumptions, open questions, ordering. */
  notes: z.string().trim().default(''),
  /**
   * What a run across these sessions does when a whole session fails.
   *
   * The same question the sessions ask about their own tasks, one level up. It is here rather
   * than only in the run panel because it is a property of the work: whether session 2 is
   * worth running after session 1 failed is something the plan knows and the operator would
   * otherwise have to remember.
   */
  onFailure: z
    .enum(['stop', 'continue'], {
      error:
        'The plan-level onFailure must be "stop" (a failed session stops the rest) or "continue" (the sessions are independent of each other).',
    })
    .default('stop'),
  /**
   * Whether the sessions of this plan talk to Copilot in one conversation or in their own.
   *
   * `per-session` is the default and the usual answer: a session is a conversation. `shared`
   * puts all of them in one chat, which is what you want when they are one piece of work split
   * into parts that need to see each other's history — and what you do not want when they are
   * unrelated, because then every session inherits a context that has nothing to do with it.
   */
  conversation: z
    .enum(['per-session', 'shared'], {
      error: 'conversation must be "per-session" (each session gets its own chat) or "shared" (all of them in one).',
    })
    .default('per-session'),
  sessions: z.array(SessionInput).min(1, 'A plan needs at least one session.'),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanSession = Plan['sessions'][number];
export type PlanTask = PlanSession['tasks'][number];

export type PlanIssue = {
  /** Where in the document, in the notation a person would type: `sessions[0].tasks[1].prompt`. */
  path: string;
  message: string;
};

export type PlanSummary = {
  plan: string;
  notes: string;
  /** How many checks the whole plan carries, across every task. */
  checkCount: number;
  /** What a run across these sessions does when one of them fails. */
  onFailure: 'stop' | 'continue';
  /** Whether they talk to Copilot in one conversation or in their own. */
  conversation: 'per-session' | 'shared';
  sessions: Array<{ name: string; tasks: string[]; model: string; onFailure: 'stop' | 'continue'; repoDir: string }>;
  taskCount: number;
};

export type PlanCheck =
  | { ok: true; plan: Plan; warnings: string[]; summary: PlanSummary }
  | { ok: false; issues: PlanIssue[]; warnings: string[] };

/**
 * Finds the JSON inside whatever the user pasted.
 *
 * Chat models wrap answers in prose and fenced code blocks, and asking the user to clean that
 * up by hand is asking them to do the one part of this that a computer is good at. A fenced
 * block wins if there is one; otherwise the text from the first brace to the last is tried.
 */
export function extractJson(text: string): string {
  const trimmed = (text ?? '').trim();
  const fenced = /```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```/i.exec(trimmed);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/** `["sessions", 0, "tasks", 1, "prompt"]` as `sessions[0].tasks[1].prompt`. */
function pathOf(parts: ReadonlyArray<PropertyKey>): string {
  return parts.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)),
    '',
  );
}

/**
 * The keys of an object schema, read from the schema rather than listed by hand.
 *
 * The list used to be written out here, and it drifted: `readOnly` was added to the task
 * schema and not to the list, so every plan that used it was told "readOnly is not part of the
 * format and was ignored" — while the importer applied it. A warning that contradicts what
 * happens is worse than none. Reading the shape cannot drift.
 */
function keysOf(schema: unknown, fallback: readonly string[] = []): readonly string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : fallback;
}

const KNOWN_KEYS = {
  plan: keysOf(PlanSchema),
  session: keysOf(SessionInput),
  task: keysOf(TaskInput),
  check: keysOf(CheckInput, ['name', 'expect', 'run', 'shell', 'cwd', 'file', 'value']),
  vcs: keysOf(VcsInput),
  taskVcs: keysOf(TaskVcsInput),
  review: keysOf(ReviewInput),
};

function unknownKeys(value: unknown, kind: keyof typeof KNOWN_KEYS, where: string, out: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!(KNOWN_KEYS[kind] as readonly string[]).includes(key)) {
      out.push(`${where}.${key} is not part of the format and was ignored.`);
    }
  }
}

/**
 * A value of the raw document as an object whose fields can be read, or nothing.
 *
 * The warning walk runs on the document as it arrived, before the schema has said anything about
 * it, so every level of it may be null, a number or a list where an object belongs. A cast does
 * not make it one: `sessions: [null]` read `null.vcs` and threw, where the schema would have
 * refused it by its path. What is not an object has no fields to warn about, and is left for the
 * schema to refuse.
 */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Fields a model invented, walked by hand because the schema drops them silently. */
function collectWarnings(raw: unknown): string[] {
  const out: string[] = [];
  const plan = fieldsOf(raw);
  if (!plan) return out;
  unknownKeys(plan, 'plan', 'plan', out);
  if (!Array.isArray(plan.sessions)) return out;
  plan.sessions.forEach((s, i) => {
    const session = fieldsOf(s);
    if (!session) return;
    unknownKeys(session, 'session', `sessions[${i}]`, out);
    unknownKeys(session.vcs, 'vcs', `sessions[${i}].vcs`, out);
    unknownKeys(session.review, 'review', `sessions[${i}].review`, out);
    if (!Array.isArray(session.tasks)) return;
    session.tasks.forEach((t, j) => {
      const task = fieldsOf(t);
      if (!task) return;
      unknownKeys(task, 'task', `sessions[${i}].tasks[${j}]`, out);
      unknownKeys(task.vcs, 'taskVcs', `sessions[${i}].tasks[${j}].vcs`, out);
      if (Array.isArray(task.checks)) {
        task.checks.forEach((c, k) => unknownKeys(c, 'check', `sessions[${i}].tasks[${j}].checks[${k}]`, out));
      }
    });
  });
  return out;
}

/**
 * Two sessions with the same name are legal but almost never meant, and by the time anyone
 * notices there are two identical rows in the list and two sets of branches in the
 * repository. Said out loud at import time, it costs the user one glance.
 */
function duplicateNameWarnings(plan: Plan): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const s of plan.sessions) {
    const key = s.name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 2) out.push(`Two sessions are both called "${s.name}". They will be created as two separate sessions.`);
  }
  return out;
}

export function summarise(plan: Plan): PlanSummary {
  return {
    plan: plan.plan,
    notes: plan.notes,
    checkCount: plan.sessions.reduce((n, s) => n + s.tasks.reduce((m, t) => m + t.checks.length, 0), 0),
    onFailure: plan.onFailure,
    conversation: plan.conversation,
    sessions: plan.sessions.map((s) => ({
      name: s.name,
      tasks: s.tasks.map((t) => t.title),
      model: s.model,
      onFailure: s.onFailure,
      repoDir: s.vcs?.repoDir ?? '',
    })),
    taskCount: plan.sessions.reduce((n, s) => n + s.tasks.length, 0),
  };
}

/**
 * Reads a pasted document and says either what it means or what is wrong with it.
 *
 * Never throws. Every way this can fail — not JSON at all, the wrong version, a task with no
 * prompt — is an answer the user is meant to see and hand back to the chat model.
 *
 * That promise is kept here, around the whole reading, and not only by each walk being careful:
 * the walks run on whatever a chat produced, and one of them reading a field of null once turned
 * a malformed plan into a request error carrying a JavaScript message, which neither the page nor
 * the chat that wrote the plan can do anything with. A walk that throws again is an answer too.
 */
export function checkPlan(text: string): PlanCheck {
  try {
    return readPlan(text);
  } catch (e) {
    return {
      ok: false,
      warnings: [],
      issues: [{ path: '', message: `This plan could not be read: ${(e as Error).message}. Check that every session, task and check is a JSON object.` }],
    };
  }
}

function readPlan(text: string): PlanCheck {
  const source = extractJson(text ?? '');
  if (!source.trim()) {
    return { ok: false, warnings: [], issues: [{ path: '', message: 'There is nothing here to import.' }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    return {
      ok: false,
      warnings: [],
      issues: [
        {
          path: '',
          message:
            `This is not valid JSON: ${(e as Error).message}. ` +
            'A common cause is a comment, a trailing comma, or a curly quote the chat inserted.',
        },
      ],
    };
  }

  const warnings = collectWarnings(raw);
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, warnings, issues: parsed.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })) };
  }

  const weak = [...weakCheckIssues(parsed.data), ...contradictionIssues(parsed.data)];
  if (weak.length) return { ok: false, warnings, issues: weak };

  return {
    ok: true,
    plan: parsed.data,
    warnings: [...warnings, ...duplicateNameWarnings(parsed.data), ...indexCheckWarnings(parsed.data)],
    summary: summarise(parsed.data),
  };
}

/**
 * A check that asks the git index whether a file the task creates is there can never pass.
 *
 * The runner commits after the task, so during the task a new file is untracked and
 * `git ls-files` does not list it — and the task is forbidden to `git add`. A plan wrote
 * exactly that check ("the seed rule set is tracked") and the task ended blocked after three
 * honest attempts, with the work complete and the file on disk. `file-exists` is the check
 * that was meant; the negative form (`output-omits` on `ls-files`, "node_modules is not
 * tracked") is fine and stays silent.
 */
function indexCheckWarnings(plan: Plan): string[] {
  const out: string[] = [];
  plan.sessions.forEach((s, i) => {
    s.tasks.forEach((t, j) => {
      t.checks.forEach((c, k) => {
        if (c.expect !== 'output-contains' && c.expect !== 'output-matches') return;
        if (!/\bgit\b[^|;&]*\bls-files\b/i.test(c.run ?? '')) return;
        out.push(
          `sessions[${i}].tasks[${j}].checks[${k}]: "${c.name}" asks git ls-files to list a file. A file the task creates is ` +
            'untracked until the runner commits after the task, and the task may not git add, so this check cannot pass. ' +
            'Use "file-exists" for a file the task writes; the index is right only for what earlier tasks committed.',
        );
      });
    });
  });
  return out;
}

/**
 * A task whose every check would pass with the task's work not done is refused.
 *
 * `file-exists` proves a file, not what is in it; a bare exit code of a test run is 0 when there are
 * no tests at all, and 0 again with only the old ones. A plan built entirely from those can finish
 * "done" with nothing proven, and it did: twice in a row the planning model wrote "npm test exits 0"
 * against five acceptance criteria — the second time after the brief had named this very trap — and
 * both times the operator had to catch it and dictate the fix. The brief teaches the rule; this is
 * the part that does not depend on a model having learned it. It is an error rather than a warning
 * because errors are what the operator copies back to the chat with one button, and the brief tells
 * the chat to fix exactly those.
 *
 * Only tasks that have checks are judged: a task with none (a read-only report, a task with nothing
 * to run) was allowed before and is not what this is about. `exit-nonzero` is not weak — it proves a
 * refusal — and anything that reads output or file contents is where proof can live.
 */
const WEAK_EXPECT = new Set(['file-exists', 'file-missing', 'exit-zero']);

function weakCheckIssues(plan: Plan): PlanIssue[] {
  const out: PlanIssue[] = [];
  plan.sessions.forEach((s, i) => {
    s.tasks.forEach((t, j) => {
      if (!t.checks.length || !t.checks.every((c) => WEAK_EXPECT.has(c.expect))) return;
      out.push({
        path: `sessions[${i}].tasks[${j}].checks`,
        message:
          `every check of "${t.title}" would pass with the task's work not done: a file that exists proves the file, not what is in it, ` +
          'and a test run exits 0 with no tests at all. Add a check that reads output or contents only the finished work produces — ' +
          'name each test after its acceptance criterion and use "output-contains" on the test runner\'s output for that test passing ' +
          '(with node --test, the line starts with ✔), or "output-matches" on the count of passing tests.',
      });
    });
  });
  return out;
}

/**
 * A task whose own flags contradict each other: read-only (change nothing) and scoped (change
 * these). Refused at import, where the chat that wrote it can still be asked which it meant; the
 * runner refuses it again before starting (orchestrator/contract.ts) for a task edited since.
 */
function contradictionIssues(plan: Plan): PlanIssue[] {
  const out: PlanIssue[] = [];
  plan.sessions.forEach((s, i) => {
    s.tasks.forEach((t, j) => {
      if (!t.readOnly || t.scope.length === 0) return;
      out.push({
        path: `sessions[${i}].tasks[${j}]`,
        message:
          `"${t.title}" is "readOnly": true, which allows no change, and has a "scope" (${t.scope.join(', ')}), which allows changes there. ` +
          'An audit that writes a report is not read-only: drop "readOnly" and scope it to the report. One that writes nothing: drop "scope".',
      });
    });
  });
  return out;
}

/** The issues as a block the user can hand back to the chat model without editing it. */
export function describeIssues(issues: PlanIssue[]): string {
  return issues.map((i) => (i.path ? `- ${i.path}: ${i.message}` : `- ${i.message}`)).join('\n');
}
