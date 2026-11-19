/**
 * The id of a task added to the queue: never one a task had before (bug hunt 2026-11-18). `q<n>` after the number of
 * tasks gave a removed task's id to the next one, and a card left in that task's chat answered the new one's. By the
 * time, so it is not given again.
 */
export function newItemId(items: ReadonlyArray<{ id: string }>, now: number = Date.now()): string {
  let id = `q${now.toString(36)}`;
  while (items.some((x) => x.id === id)) id = `${id}x`;
  return id;
}
