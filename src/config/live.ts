/**
 * Settings saved while a message is at work (operator, 2026-11-03: "when I change a setting in Settings, if it can be,
 * let it take effect at once, even while a task is running"). A run read its settings once, when it started, so a
 * program added to "Programs the bot may start" after a step was refused for it was refused again until the next
 * message. Now each run keeps its settings in one object (`LiveSettings.cfg`) and takes into it, in place, what can
 * change under a message without breaking it:
 *
 *   - at once (`now`): the rules each step is judged by — the programs, the scripts, the ones set to read only, those
 *     run without asking, downloads, the deny patterns, isolation, the variables a step is given, and Settings'
 *     agreement with the bot — the time a command may take, the limits, the pauses, the reports and their redaction.
 *     Each is read where it is used, so the next step, the next reply or the next message goes by the new value;
 *   - from the next message (`next`): what a message is built on when it starts — the models, plan mode, the shell and
 *     folder a step runs in by default, the project and its folders, the skills, the contract's stop word, the mode a
 *     start takes, and the lead's number of subtasks, which its assignment states;
 *   - when the chat window opens again (`window`): the chat's address, its browser and the waits and locators the
 *     window was opened with; it is kept open between messages.
 *
 * A step that is running, and a card already put to the operator, go on as they began. The locked policy, when there is
 * one, is in what was saved (`loadConfigObject`), so it is taken with the rest and still wins.
 */
import { chatDenyPatterns, type ResolvedConfig } from './schema.js';

/** Taken at once, by section; `*` is every field of it. */
const NOW: Record<string, readonly string[] | '*'> = {
  execution: [
    'networkFetch', 'questions', 'commandTimeoutSec', 'idleTimeoutSec', 'longCommandTimeoutSec', 'longIdleTimeoutSec',
    'maxStepTimeoutSec', 'isolation', 'passEnv', 'allowedPrograms', 'readOnlyPrograms', 'runWithoutAsking', 'scripts',
    'writtenScripts', 'denyPatterns',
  ],
  limits: '*',
  pacing: '*',
  report: '*',
};
/** Of a section taken whole, what a message is told when it starts: the lead's number of subtasks is its assignment's. */
const NOT_NOW: Record<string, readonly string[]> = {
  limits: ['maxSubtasks'],
};
/** What the chat window was opened with. */
const WINDOW: Record<string, readonly string[]> = {
  copilot: ['url', 'profileDir', 'channel', 'headless', 'replyTimeoutSec', 'signInTimeoutSec', 'humanWaitSec', 'keepFailurePage', 'pickerLocators', 'pickerSteps'],
};
/** The sections a run compares; the rest (where the bot keeps its records) is read when the bot starts. */
const SECTIONS = ['copilot', 'task', 'execution', 'report', 'project', 'skills', 'pacing', 'limits'] as const;

/** What a save changed for a run, by name (`execution.allowedPrograms`), in the order Settings has them. */
export type LiveChange = { now: string[]; next: string[]; window: string[] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function classOf(section: string, key: string): keyof LiveChange {
  if (NOT_NOW[section]?.includes(key)) return 'next';
  const now = NOW[section];
  if (now === '*' || now?.includes(key)) return 'now';
  return WINDOW[section]?.includes(key) ? 'window' : 'next';
}

/** One run's settings, and those who hear when a save changes what it goes by. */
export class LiveSettings {
  private readonly listeners = new Set<(change: LiveChange) => void>();
  /** The settings as last saved, so a save names what it changed, not what an earlier one did. */
  private last: Record<string, Record<string, unknown> | undefined>;

  /**
   * `cfg`: the run's own; `chat`: a conversation of the workbench's chat, whose deny patterns leave its git to the
   * operator; `loaded`: the settings the run was made from, before that.
   */
  constructor(
    readonly cfg: ResolvedConfig,
    private readonly chat: boolean,
    loaded: ResolvedConfig = cfg,
  ) {
    this.last = JSON.parse(JSON.stringify(loaded)) as Record<string, Record<string, unknown> | undefined>;
  }

  /** Hears every save that changes something this run takes at once. */
  onChange(fn: (change: LiveChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Takes what was saved: the fields this run takes at once go into `cfg`, in place, so every part of the run holding
   * it reads them; the rest is only named. Those who listen hear of it when anything was taken.
   */
  take(saved: ResolvedConfig): LiveChange {
    const change: LiveChange = { now: [], next: [], window: [] };
    const target = this.cfg as unknown as Record<string, Record<string, unknown>>;
    const source = saved as unknown as Record<string, Record<string, unknown> | undefined>;
    for (const section of SECTIONS) {
      const before = this.last[section] ?? {};
      const from = source[section];
      if (!from || typeof from !== 'object') continue;
      for (const key of new Set([...Object.keys(before), ...Object.keys(from)])) {
        if (same(before[key], from[key])) continue;
        const kind = classOf(section, key);
        change[kind].push(`${section}.${key}`);
        if (kind !== 'now' || !target[section]) continue;
        const value = from[key];
        target[section][key] = section === 'execution' && key === 'denyPatterns' && this.chat && Array.isArray(value) ? chatDenyPatterns(value as string[]) : value;
      }
    }
    this.last = JSON.parse(JSON.stringify(saved)) as Record<string, Record<string, unknown> | undefined>;
    if (change.now.length > 0) {
      this.cfg.policyLock = saved.policyLock;
      for (const fn of this.listeners) {
        try {
          fn(change);
        } catch {
          // One that cannot hear it does not keep it from the others.
        }
      }
    }
    return change;
  }
}

/** The names of several runs' changes together, each once. */
export function mergedChange(changes: LiveChange[]): LiveChange {
  const out: LiveChange = { now: [], next: [], window: [] };
  for (const c of changes) {
    for (const k of ['now', 'next', 'window'] as const) for (const name of c[k]) if (!out[k].includes(name)) out[k].push(name);
  }
  return out;
}
