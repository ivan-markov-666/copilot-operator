/**
 * Which tasks a start from one queued task takes, and what is said about the rest: the rule behind
 * "Run this task" (web/app/runQueued.tsx). Plain data in, plain data out, so it is checked on its own
 * (test/intent.check.ts).
 *
 * "Only this task" takes the task; "this one and the ones after it" adds the queued tasks after it in
 * its session, in order. Nothing that has already run is taken, before it or after it. A session whose
 * tasks are one chain (`onFailure` not 'continue') stops at a task that does not end done, so the panel
 * says so, and names a task of the chain that did not succeed and that the started ones come after.
 */
type T = { id: string; title: string; status: string };

export function runQueuedSelection<Task extends T>(session: { tasks: Task[]; onFailure?: 'stop' | 'continue' }, taskId: string) {
  const at = session.tasks.findIndex((t) => t.id === taskId);
  const task = at >= 0 ? session.tasks[at] : undefined;
  const before = at >= 0 ? session.tasks.slice(0, at) : [];
  const after = at >= 0 ? session.tasks.slice(at + 1) : [];
  const chain = session.onFailure !== 'continue';
  let lastQueued = -1;
  after.forEach((t, i) => {
    if (t.status === 'queued') lastQueued = i;
  });
  return {
    task,
    /** The queued tasks after it, in the order they run: what "this and the ones after it" adds. */
    followingQueued: after.filter((t) => t.status === 'queued'),
    /** Later tasks that have run already: left as they are by either choice. */
    laterRan: after.filter((t) => t.status !== 'queued'),
    /** Tasks before it that have run: never touched by this start. */
    earlierRan: before.filter((t) => t.status !== 'queued'),
    /** Whether a task that does not end done stops the ones after it (the session is one chain). */
    chain,
    /** In a chain, the first earlier task that did not end done: said, not refused. */
    chainGap: chain ? before.find((t) => t.status !== 'done') : undefined,
    /**
     * In a chain, a task between this one and the last queued one after it that ran and did not end done:
     * "this and the ones after it" runs the queued tasks behind it, which were written assuming it worked.
     */
    chainGapLater: chain && lastQueued > 0 ? after.slice(0, lastQueued).find((t) => t.status !== 'queued' && t.status !== 'done') : undefined,
  };
}
