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
    },
    {
      error:
        'Every session needs a "vcs" object saying whether the runner does version control for it and, when it does, which git repository to work in. Ask the user both questions and write the answers here.',
    },
  )
  .superRefine((vcs, ctx) => {
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

/** The project files copied into the chat. Absent means none, which is the default. */
const MirrorInput = z.object({
  enabled: z.boolean().optional(),
  rootDir: z.string().optional(),
  includeDirs: z.array(z.string()).optional(),
  excludeDirs: z.array(z.string()).optional(),
  respectGitignore: z.boolean().optional(),
  includeEnvFiles: z.boolean().optional(),
});

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
  mirror: MirrorInput.optional(),
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

const KNOWN_KEYS = {
  plan: ['version', 'plan', 'notes', 'onFailure', 'conversation', 'sessions'],
  session: ['name', 'goal', 'model', 'onFailure', 'level2', 'conversationGroup', 'vcs', 'review', 'mirror', 'tasks'],
  task: ['title', 'prompt', 'expected', 'level2', 'vcs', 'checks', 'review'],
  check: ['name', 'expect', 'run', 'shell', 'cwd', 'file', 'value'],
  vcs: ['enabled', 'repoDir', 'branchMode', 'commitOnFinish', 'branchPrefix', 'branchName'],
  taskVcs: ['branch', 'commitMessage'],
  review: ['enabled', 'model'],
  mirror: ['enabled', 'rootDir', 'includeDirs', 'excludeDirs', 'respectGitignore', 'includeEnvFiles'],
} as const;

function unknownKeys(value: unknown, kind: keyof typeof KNOWN_KEYS, where: string, out: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!(KNOWN_KEYS[kind] as readonly string[]).includes(key)) {
      out.push(`${where}.${key} is not part of the format and was ignored.`);
    }
  }
}

/** Fields a model invented, walked by hand because the schema drops them silently. */
function collectWarnings(raw: unknown): string[] {
  const out: string[] = [];
  if (!raw || typeof raw !== 'object') return out;
  unknownKeys(raw, 'plan', 'plan', out);
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return out;
  sessions.forEach((s, i) => {
    unknownKeys(s, 'session', `sessions[${i}]`, out);
    const session = s as { tasks?: unknown; vcs?: unknown; review?: unknown; mirror?: unknown };
    unknownKeys(session.vcs, 'vcs', `sessions[${i}].vcs`, out);
    unknownKeys(session.review, 'review', `sessions[${i}].review`, out);
    unknownKeys(session.mirror, 'mirror', `sessions[${i}].mirror`, out);
    if (Array.isArray(session.tasks)) {
      session.tasks.forEach((t, j) => {
        unknownKeys(t, 'task', `sessions[${i}].tasks[${j}]`, out);
        unknownKeys((t as { vcs?: unknown })?.vcs, 'taskVcs', `sessions[${i}].tasks[${j}].vcs`, out);
        const checks = (t as { checks?: unknown })?.checks;
        if (Array.isArray(checks)) {
          checks.forEach((c, k) => unknownKeys(c, 'check', `sessions[${i}].tasks[${j}].checks[${k}]`, out));
        }
      });
    }
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
 */
export function checkPlan(text: string): PlanCheck {
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

  return {
    ok: true,
    plan: parsed.data,
    warnings: [...warnings, ...duplicateNameWarnings(parsed.data)],
    summary: summarise(parsed.data),
  };
}

/** The issues as a block the user can hand back to the chat model without editing it. */
export function describeIssues(issues: PlanIssue[]): string {
  return issues.map((i) => (i.path ? `- ${i.path}: ${i.message}` : `- ${i.message}`)).join('\n');
}
