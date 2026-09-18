/**
 * The live event stream.
 *
 * Every run already writes a JSONL transcript. This is the same information as it happens,
 * so the web UI can show progress without polling files. Each session keeps a bounded
 * history so a page that opens mid-run can catch up.
 */
import { EventEmitter } from 'node:events';
import type { SessionEvent } from './model.js';

const HISTORY_PER_SESSION = 500;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, SessionEvent[]>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: Omit<SessionEvent, 'at'>): SessionEvent {
    const full: SessionEvent = { at: new Date().toISOString(), ...event };
    const list = this.history.get(event.sessionId) ?? [];
    list.push(full);
    if (list.length > HISTORY_PER_SESSION) list.splice(0, list.length - HISTORY_PER_SESSION);
    this.history.set(event.sessionId, list);
    this.emitter.emit(event.sessionId, full);
    this.emitter.emit('*', full);
    return full;
  }

  recent(sessionId: string): SessionEvent[] {
    return [...(this.history.get(sessionId) ?? [])];
  }

  subscribe(sessionId: string | '*', handler: (e: SessionEvent) => void): () => void {
    this.emitter.on(sessionId, handler);
    return () => this.emitter.off(sessionId, handler);
  }
}
