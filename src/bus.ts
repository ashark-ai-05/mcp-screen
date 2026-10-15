/**
 * Fan-out event bus. Adapted from opencanvas `src/backend/canvas-event-bus.ts`
 * (MIT, ashark-ai-05/opencanvas): each subscriber owns its own queue so a slow
 * SSE client never blocks the others, and closing the iterator unsubscribes.
 */
import type { ScreenEvent } from './types.js';

export interface BusSubscription extends AsyncIterable<ScreenEvent> {
  close(): void;
}

export class EventBus {
  private subscribers: Subscriber[] = [];
  private listeners = new Set<(e: ScreenEvent) => void>();

  push(event: ScreenEvent): void {
    for (const s of this.subscribers) s.write(event);
    for (const l of this.listeners) l(event);
  }

  /** Synchronous listener (used in-process, e.g. by tests). Returns an unsubscribe fn. */
  on(listener: (e: ScreenEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribe(): BusSubscription {
    const sub: Subscriber = new Subscriber(() => {
      this.subscribers = this.subscribers.filter((s) => s !== sub);
    });
    this.subscribers.push(sub);
    return sub;
  }

  subscriberCount(): number {
    return this.subscribers.length;
  }
}

class Subscriber implements BusSubscription {
  private queue: ScreenEvent[] = [];
  private waiters: Array<(r: IteratorResult<ScreenEvent>) => void> = [];
  private closed = false;
  constructor(private readonly onClose: () => void) {}

  write(event: ScreenEvent): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: event, done: false });
    else this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ScreenEvent> {
    return {
      next: () => {
        const v = this.queue.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
