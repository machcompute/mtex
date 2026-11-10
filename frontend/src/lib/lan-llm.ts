// Typed wrapper around the vendored MachLLM SDK (mach-llm-sdk.js) for the
// LAN WebGPU LLM engine. The SDK talks to the engine over a hidden iframe;
// this module adds what the chat runtime and settings modal need on top:
// a connection cache (one engine connection per origin), a progress
// subscription, and a typed, recognizable failure when the engine is
// unreachable (so the chat can show a graceful error instead of a raw
// "Timed out connecting…" message).
import {
  MachLLM,
  type LanChatParams,
  type LanCompletion,
  type LanProgress,
  type LanStream,
  type ListedModel,
} from "./mach-llm-sdk";

export type { LanProgress, ListedModel, LanCompletion };

/** Default engine location (overridable per settings; see chat-settings). */
export const DEFAULT_ENGINE_URL =
  process.env.NEXT_PUBLIC_LLM_ENGINE_URL ?? "http://localhost:3001";

/** How long a connection attempt may take before we give up. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Thrown when the engine cannot be reached (no "ready" handshake within
 * the timeout, or the connection was closed). The chat runtime catches it
 * specifically to point the user at the chat settings modal.
 */
export class LanEngineUnreachableError extends Error {
  readonly engineUrl: string;
  constructor(engineUrl: string, cause: unknown) {
    super(
      `Could not reach the LAN LLM engine at ${new URL(engineUrl, window.location.href).origin} — ` +
        "is it running? Check the engine URL in the chat settings.",
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "LanEngineUnreachableError";
    this.engineUrl = engineUrl;
  }
}

type Connection = {
  url: string;
  llm: MachLLM;
  progressHandlers: Set<(p: LanProgress) => void>;
  progress: LanProgress | null;
  closed: boolean;
};

// One connection per engine URL: the engine supports one completion at a
// time and keeps the loaded model in memory, so re-connecting per request
// would reload weights on every turn.
const connections = new Map<string, Connection>();
const connectPromises = new Map<string, Promise<Connection>>();

function normalizeUrl(url: string): string {
  return new URL(url, window.location.href).href;
}

/**
 * Connect to (or reuse) the engine at `url`. `onProgress` (if given)
 * receives every engine progress event for the life of the call — the
 * first model load streams tokenizer → gpu → download → quantize →
 * pipelines → prefill → ready.
 *
 * Rejects with LanEngineUnreachableError when the handshake times out.
 */
export async function ensureLanLlm(
  url: string,
  onProgress?: (p: LanProgress) => void,
): Promise<MachLLM> {
  const href = normalizeUrl(url);
  const existing = connections.get(href);
  if (existing && !existing.closed) {
    if (onProgress) {
      if (existing.progress) onProgress(existing.progress);
      existing.progressHandlers.add(onProgress);
    }
    return existing.llm;
  }
  // A handshake already in flight for this URL: share it (no double iframe).
  const inFlight = connectPromises.get(href);
  if (inFlight) {
    const conn = await inFlight;
    if (onProgress) {
      if (conn.progress) onProgress(conn.progress);
      conn.progressHandlers.add(onProgress);
    }
    return conn.llm;
  }

  const promise = (async () => {
    let llm: MachLLM;
    try {
      llm = await MachLLM.connect({
        engineUrl: href,
        timeoutMs: CONNECT_TIMEOUT_MS,
        onProgress: () => {
          // Progress events are fanned out to the connection-level set
          // below; wire them there.
        },
      });
    } catch (e) {
      throw new LanEngineUnreachableError(url, e);
    }
    const conn: Connection = {
      url: href,
      llm,
      progressHandlers: new Set(),
      progress: null,
      closed: false,
    };
    llm.on("progress", (p) => {
      conn.progress = p;
      for (const h of conn.progressHandlers) h(p);
    });
    connections.set(href, conn);
    connectPromises.delete(href);
    return conn;
  })();
  connectPromises.set(href, promise);
  try {
    const conn = await promise;
    if (onProgress) {
      if (conn.progress) onProgress(conn.progress);
      conn.progressHandlers.add(onProgress);
    }
    return conn.llm;
  } catch (e) {
    connectPromises.delete(href);
    throw e;
  }
}

/**
 * Drop the connection to `url` (and its progress subscribers) — used when
 * the settings point at a different engine. In-flight completions on the
 * old connection reject with "MachLLM connection is closed".
 */
export function closeLanLlm(url?: string): void {
  const href = url !== undefined ? normalizeUrl(url) : undefined;
  for (const [key, conn] of connections) {
    if (href !== undefined && key !== href) continue;
    conn.closed = true;
    conn.llm.close();
    conn.progressHandlers.clear();
    connections.delete(key);
  }
}

/**
 * One streamed completion. Returns an async iterator of OpenAI-shaped
 * chunks plus the final `completion` once exhausted. Tool calls arrive as
 * per-index fragments (function.name / function.arguments pieces) — same
 * accumulation the old SSE parser did; the caller concatenates.
 */
export async function lanStreamChat(
  url: string,
  params: LanChatParams,
  signal: AbortSignal,
  onProgress?: (p: LanProgress) => void,
): Promise<LanStream> {
  const llm = await ensureLanLlm(url, onProgress);
  const created = await llm.chat.completions.create(
    { ...params, stream: true },
    { signal },
  );
  if (!isAsyncIterable(created)) {
    // A non-stream response should never happen (we always ask for a
    // stream), but surface it as a single-chunk stream so callers have
    // one shape to consume.
    throw new Error("The engine did not return a stream");
  }
  return created;
}

function isAsyncIterable(x: LanStream | LanCompletion): x is LanStream {
  return (
    typeof (x as LanStream)[Symbol.asyncIterator] === "function" &&
    "controller" in (x as LanStream)
  );
}

/** List the engine's models (id, label, modalities, maxContext, cached). */
export async function lanListModels(
  url: string,
  onProgress?: (p: LanProgress) => void,
): Promise<ListedModel[]> {
  const llm = await ensureLanLlm(url, onProgress);
  const res = await llm.models.list();
  return res.data;
}
