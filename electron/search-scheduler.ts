export const SEARCH_SUPERSEDED = "搜索请求已被新输入取代";

interface ScheduledRequest {
  execute: () => Promise<void>;
  reject: (reason: Error) => void;
}

interface SearchSlot {
  revision: number;
  running: boolean;
  next?: ScheduledRequest;
}

/** Keeps at most one native query and one newest pending query per window. */
export class LatestSearchScheduler {
  private readonly slots = new Map<string, SearchSlot>();

  run<T>(key: string, operation: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { revision: 0, running: false };
      this.slots.set(key, slot);
    }
    const currentSlot = slot;
    const revision = ++currentSlot.revision;
    currentSlot.next?.reject(new Error(SEARCH_SUPERSEDED));
    currentSlot.next = undefined;
    return new Promise<T>((resolve, reject) => {
      const request: ScheduledRequest = {
        reject,
        execute: async () => {
          const isCurrent = () => currentSlot.revision === revision;
          try {
            const value = await operation(isCurrent);
            if (!isCurrent()) throw new Error(SEARCH_SUPERSEDED);
            resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };
      if (currentSlot.running) currentSlot.next = request;
      else void this.drain(key, currentSlot, request);
    });
  }

  cancel(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.revision++;
    slot.next?.reject(new Error(SEARCH_SUPERSEDED));
    slot.next = undefined;
    if (!slot.running) this.slots.delete(key);
  }

  cancelAll(): void {
    for (const key of this.slots.keys()) this.cancel(key);
  }

  private async drain(key: string, slot: SearchSlot, first: ScheduledRequest): Promise<void> {
    slot.running = true;
    let current: ScheduledRequest | undefined = first;
    while (current) {
      await current.execute();
      current = slot.next;
      slot.next = undefined;
    }
    slot.running = false;
    if (this.slots.get(key) === slot) this.slots.delete(key);
  }
}
