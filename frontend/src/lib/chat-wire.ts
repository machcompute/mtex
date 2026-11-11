// The wire layer between the chat runtime and the two backends: the LAN
// WebGPU engine (through lan-llm) and a user-configured OpenAI-compatible
// API endpoint, called directly from the page (SSE stream, Bearer key —
// no server-side proxy). Both speak OpenAI chat shapes; this module
// normalizes the thread history into wire messages and exposes one
// streaming generator per round so the runtime does not care which
// backend answers.
import type { ThreadMessage } from "@assistant-ui/core";
import { lanStreamChat, type LanProgress } from "./lan-llm";
import type { LanChatMessage } from "./mach-llm-sdk";
import type { ChatSettings } from "./chat-settings";

// A tool call in the wire format (OpenAI: id, type, function).
export type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// The wire shapes for one turn of conversation. Assistant messages may
// carry tool_calls (content can then be empty); tool messages answer
// exactly one call by id.
export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// One piece of a streamed round, normalized across backends. Tool calls
// arrive as per-index fragments (id / function.name / function.arguments
// pieces) that the caller concatenates before JSON.parsing.
export type WireStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "toolcall";
      index: number;
      id?: string;
      name?: string;
      args?: string;
    }
  | { type: "done"; finishReason: string | null };

// Tool results are capped on the way back into the transcript (a 60 MB
// build log once is enough; keeps the prompt bounded).
const TOOL_RESULT_CAP = 16_000;

// Stand-in result for a tool call whose run ended before it produced one.
const INTERRUPTED_TOOL_RESULT =
  "ERROR: the conversation was stopped before this tool ran.";

function argsToJson(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Map the thread (the branch up to and including the triggering user
 * message — the in-flight assistant reply is not part of it) into wire
 * messages, in thread order. System messages are skipped (the caller
 * prepends a fresh system prompt every round); user text parts are concatenated; an
 * assistant message's parts are flushed in order — a text part that
 * follows pending tool calls starts a new assistant message (the wire
 * format requires tool results between them), followed by one tool
 * message per call.
 */
export function toWireMessages(
  messages: readonly ThreadMessage[],
): WireMessage[] {
  type Pending = {
    id: string;
    name: string;
    argsText: string;
    result?: string;
  };
  const out: WireMessage[] = [];
  let bufText = "";
  let pending: Pending[] = [];
  const flush = () => {
    if (bufText !== "" || pending.length > 0) {
      out.push({
        role: "assistant",
        content: bufText,
        ...(pending.length > 0
          ? {
              tool_calls: pending.map<WireToolCall>((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.argsText },
              })),
            }
          : {}),
      });
      // Every call must be answered right after the assistant message
      // (the engine and OpenAI templates reject dangling calls). A call
      // without a result — a run stopped or failed before the tool ran —
      // gets a terminal result instead of being left open.
      for (const c of pending) {
        out.push({
          role: "tool",
          tool_call_id: c.id,
          content: (c.result ?? INTERRUPTED_TOOL_RESULT).slice(
            0,
            TOOL_RESULT_CAP,
          ),
        });
      }
    }
    bufText = "";
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text !== "") out.push({ role: "user", content: text });
      continue;
    }
    // assistant
    for (const part of m.content) {
      if (part.type === "text") {
        if (pending.length > 0) flush();
        bufText += part.text;
      } else if (part.type === "tool-call") {
        pending.push({
          id: part.toolCallId,
          name: part.toolName,
          argsText: argsToJson(part.args),
          result:
            part.result === undefined ? undefined : String(part.result),
        });
      }
      // reasoning and other part types do not go back to the model
    }
    // Close the assistant message at ITS boundary, so it lands before the
    // next user message. (Flushing only at the very end reordered
    // [user, assistant, user] into [user, user, assistant], which the
    // engine rejects: "the last message must have role user or tool".)
    flush();
  }
  return out;
}

/**
 * One streaming completion against the configured backend. Yields
 * normalized events (text / reasoning / tool-call fragments) and a final
 * "done". Aborts through the given signal: the endpoint path rejects its
 * read loop with an AbortError, the LAN path cancels the engine request.
 * Errors (engine unreachable, HTTP failure, …) propagate to the caller.
 */
export async function* streamWireRound(opts: {
  settings: ChatSettings;
  messages: WireMessage[];
  tools: object[];
  signal: AbortSignal;
  onEngineProgress?: (p: LanProgress) => void;
}): AsyncGenerator<WireStreamEvent> {
  if (opts.settings.backend === "lan") {
    yield* streamLanRound(opts);
  } else {
    yield* streamEndpointRound(opts);
  }
}

async function* streamLanRound(opts: {
  settings: ChatSettings;
  messages: WireMessage[];
  tools: object[];
  signal: AbortSignal;
  onEngineProgress?: (p: LanProgress) => void;
}): AsyncGenerator<WireStreamEvent> {
  const stream = await lanStreamChat(
    opts.settings.engineUrl,
    {
      ...(opts.settings.model !== ""
        ? { model: opts.settings.model }
        : {}),
      messages: opts.messages as LanChatMessage[],
      tools: opts.tools,
      stream: true,
    },
    opts.signal,
    opts.onEngineProgress,
  );
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta;
    if (!d) continue;
    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      yield { type: "reasoning", text: d.reasoning_content };
    }
    if (typeof d.content === "string" && d.content) {
      yield { type: "text", text: d.content };
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        yield {
          type: "toolcall",
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments,
        };
      }
    }
  }
  // The final empty-delta chunk carries finish_reason; the completion
  // object is the fallback if it ever does not.
  if (!finishReason && stream.completion?.choices?.[0]) {
    finishReason = stream.completion.choices[0].finish_reason;
  }
  yield { type: "done", finishReason };
}

// The user enters the base of an OpenAI-compatible API ("…/v1"); the
// page appends /chat/completions unless the full path was pasted in.
function endpointUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (t === "") return "";
  return t.endsWith("/chat/completions") ? t : `${t}/chat/completions`;
}

async function* streamEndpointRound(opts: {
  settings: ChatSettings;
  messages: WireMessage[];
  tools: object[];
  signal: AbortSignal;
}): AsyncGenerator<WireStreamEvent> {
  const url = endpointUrl(opts.settings.endpointUrl);
  if (url === "") {
    throw new Error(
      "No endpoint address set — open chat settings and enter the endpoint address.",
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.settings.apiKey !== ""
        ? { authorization: `Bearer ${opts.settings.apiKey}` }
        : {}),
    },
    body: JSON.stringify({
      ...(opts.settings.endpointModel !== ""
        ? { model: opts.settings.endpointModel }
        : {}),
      messages: opts.messages,
      tools: opts.tools,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = String((await res.json())?.error ?? "");
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finishReason: string | null = null;
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    // The endpoint streams SSE: "data: {…}\n" lines, "\n\n" between
    // events, and a final "data: [DONE]".
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: {
        choices?: {
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: Array<{
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
          finish_reason?: unknown;
        }[];
      };
      try {
        ev = JSON.parse(payload);
      } catch {
        // A partial or malformed line is skipped; the stream ends with
        // [DONE] regardless.
        continue;
      }
      const choice = ev.choices?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const d = choice.delta;
      if (!d) continue;
      if (typeof d.content === "string" && d.content) {
        yield { type: "text", text: d.content };
      }
      if (typeof d.reasoning_content === "string" && d.reasoning_content) {
        yield { type: "reasoning", text: d.reasoning_content };
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const cur = calls.get(idx) ?? { id: "", name: "", arguments: "" };
          let fragment = false;
          if (typeof tc.id === "string" && tc.id) {
            cur.id += tc.id;
            fragment = true;
          }
          if (typeof tc.function?.name === "string" && tc.function.name) {
            cur.name += tc.function.name;
            fragment = true;
          }
          if (
            typeof tc.function?.arguments === "string" &&
            tc.function.arguments
          ) {
            cur.arguments += tc.function.arguments;
            fragment = true;
          }
          if (!fragment) continue;
          calls.set(idx, cur);
          yield {
            type: "toolcall",
            index: idx,
            id: tc.id as string | undefined,
            name: tc.function?.name as string | undefined,
            args: tc.function?.arguments as string | undefined,
          };
        }
      }
    }
  }
  yield { type: "done", finishReason };
}
