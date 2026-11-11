// An in-memory stand-in for the browser's Origin Private File System, just
// faithful enough for src/lib/opfs.ts and src/lib/ctan-store.ts: directory and
// file handles, async directory iteration, writable streams, and the DOMException
// names the real implementation throws (NotFoundError, ...). Installed at the
// `navigator.storage.getDirectory()` boundary — the app code under test is the
// real thing.

type DomErr = "NotFoundError" | "TypeMismatchError" | "InvalidModificationError";

function domError(name: DomErr, msg: string): Error {
  const e = new Error(msg);
  e.name = name;
  return e;
}

export type FaultPlan = {
  /** Every createWritable() rejects (storage full / unavailable). */
  failWrites: boolean;
  /** getDirectory() itself rejects (OPFS unavailable). */
  failRoot: boolean;
  /** When set, getDirectory() waits for it (a slow OPFS under load). */
  gate: Promise<void> | null;
};

const faults: FaultPlan = { failWrites: false, failRoot: false, gate: null };

export class MemFile {
  readonly kind = "file" as const;
  data = new Uint8Array(0);
  constructor(readonly name: string) {}

  async getFile() {
    const data = this.data;
    const name = this.name;
    return {
      name,
      size: data.byteLength,
      async arrayBuffer() {
        return data.slice().buffer as ArrayBuffer;
      },
      async text() {
        return new TextDecoder().decode(data);
      },
    };
  }

  async createWritable() {
    if (faults.failWrites) throw domError("InvalidModificationError", "write failed");
    let pending: Uint8Array | null = null;
    return {
      write: async (chunk: Uint8Array | string) => {
        pending =
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk);
      },
      close: async () => {
        // Real writables commit on close; an empty write leaves an empty file.
        this.data = pending ?? new Uint8Array(0);
      },
    };
  }
}

export class MemDir {
  readonly kind = "directory" as const;
  readonly entries = new Map<string, MemDir | MemFile>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemDir> {
    const e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw domError("NotFoundError", `no directory ${name}`);
      const d = new MemDir(name);
      this.entries.set(name, d);
      return d;
    }
    if (e.kind !== "directory") throw domError("TypeMismatchError", `${name} is a file`);
    return e;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MemFile> {
    const e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw domError("NotFoundError", `no file ${name}`);
      const f = new MemFile(name);
      this.entries.set(name, f);
      return f;
    }
    if (e.kind !== "file") throw domError("TypeMismatchError", `${name} is a directory`);
    return e;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw domError("NotFoundError", `no entry ${name}`);
    if (e.kind === "directory" && e.entries.size > 0 && !opts?.recursive)
      throw domError("InvalidModificationError", `${name} is not empty`);
    this.entries.delete(name);
  }

  async *values(): AsyncGenerator<MemDir | MemFile> {
    for (const e of [...this.entries.values()]) yield e;
  }
}

let root = new MemDir("");

/** The current root (tests peek at it to assert what was persisted). */
export function opfsRoot(): MemDir {
  return root;
}

export function faultPlan(): FaultPlan {
  return faults;
}

/** Fresh empty store, no faults. Call from beforeEach. */
export function resetOpfs(): void {
  root = new MemDir("");
  faults.failWrites = false;
  faults.failRoot = false;
  faults.gate = null;
}

/** Make OPFS slow: getDirectory() stalls until the returned release() is called. */
export function gateOpfs(): () => void {
  let release!: () => void;
  faults.gate = new Promise<void>((res) => {
    release = () => {
      faults.gate = null;
      res();
    };
  });
  return release;
}

/** Point navigator.storage.getDirectory() at the in-memory root. */
export function installMemOpfs(): void {
  resetOpfs();
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: {
      getDirectory: async () => {
        if (faults.gate) await faults.gate;
        if (faults.failRoot) throw new Error("OPFS unavailable");
        return root;
      },
    },
  });
}

// --- helpers for tests ------------------------------------------------------

/** Read a file at a slash path under the root; null when absent. */
export function readPath(path: string): Uint8Array | null {
  let cur: MemDir | MemFile = root;
  for (const part of path.split("/").filter(Boolean)) {
    if (cur.kind !== "directory") return null;
    const next: MemDir | MemFile | undefined = cur.entries.get(part);
    if (!next) return null;
    cur = next;
  }
  return cur.kind === "file" ? cur.data : null;
}

export function readText(path: string): string | null {
  const b = readPath(path);
  return b === null ? null : new TextDecoder().decode(b);
}

/** True when any entry (file or directory) exists at the slash path. */
export function existsPath(path: string): boolean {
  let cur: MemDir | MemFile = root;
  for (const part of path.split("/").filter(Boolean)) {
    if (cur.kind !== "directory") return false;
    const next: MemDir | MemFile | undefined = cur.entries.get(part);
    if (!next) return false;
    cur = next;
  }
  return true;
}

/** Sorted names directly inside a directory path ("" = root). */
export function listDir(path: string): string[] {
  let cur: MemDir | MemFile = root;
  for (const part of path.split("/").filter(Boolean)) {
    if (cur.kind !== "directory") return [];
    const next: MemDir | MemFile | undefined = cur.entries.get(part);
    if (!next) return [];
    cur = next;
  }
  return cur.kind === "directory" ? [...cur.entries.keys()].sort() : [];
}

/** Write a file (creating parents) straight into the store, bypassing app code. */
export function seedFile(path: string, data: string | Uint8Array): void {
  const parts = path.split("/").filter(Boolean);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    let next = cur.entries.get(part);
    if (!next) {
      next = new MemDir(part);
      cur.entries.set(part, next);
    }
    cur = next as MemDir;
  }
  const f = new MemFile(parts[parts.length - 1]);
  f.data = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  cur.entries.set(f.name, f);
}
