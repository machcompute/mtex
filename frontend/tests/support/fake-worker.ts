// A controllable stand-in for the busytex Web Worker. Nothing here loads a
// script: the test drives the worker's side of the protocol by hand.
export type WorkerMsg = Record<string, unknown>;

export class FakeWorker {
  static instances: FakeWorker[] = [];
  static get last(): FakeWorker {
    return FakeWorker.instances[FakeWorker.instances.length - 1];
  }
  static reset(): void {
    FakeWorker.instances = [];
  }

  onmessage: ((e: { data: WorkerMsg }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  posted: WorkerMsg[] = [];
  terminated = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: WorkerMsg): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Deliver a worker→page message. */
  emit(data: WorkerMsg): void {
    this.onmessage?.({ data });
  }
  crash(message?: string): void {
    this.onerror?.({ message });
  }
}

/** Let pending promise continuations run (no timers involved). */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
