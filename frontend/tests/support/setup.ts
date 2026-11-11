import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { installMemOpfs } from "./memfs";

// Every test starts with an empty in-memory OPFS, and nothing may reach the
// network: a stray fetch fails loudly instead of leaking out of the sandbox.
beforeEach(() => {
  // jsdom ships a crypto without `subtle`; the app hashes with it.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
  installMemOpfs();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`unexpected network request in a unit test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // node env has no localStorage
  }
});
