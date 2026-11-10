// The assistant-ui chat model adapter: the whole agentic loop (model
// round → tool execution → next round) lives inside one `run` call, so a
// user message costs exactly one roundtrip through the runtime. Each
// yield REPLACES the previous preview (the runtime appends the yielded
// content to the roundtrip's initial content, which is empty for a fresh
// message), so every yield carries the CUMULATIVE parts of all rounds so
// far — text and reasoning stream in live, tool calls appear as the model
// emits them, and their results land once the tools finish.
//
// `apply_edit` approval works because executeTool BLOCKS on the user's
// decision (the page's promise + pending-edit card); while blocked, the
// run simply waits between rounds. Stop = settle the pending edit and
// abort the run signal; this generator then throws an AbortError, which
// the runtime maps to a cancelled run.
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
} from "@assistant-ui/react";
import type {
  ReasoningMessagePart,
  TextMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/core";
import { CHAT_TOOLS } from "./chat-tools";
import {
  streamWireRound,
  toWireMessages,
  type WireMessage,
} from "./chat-wire";
import type { ChatSettings } from "./chat-settings";
import type { LanProgress } from "./lan-llm";

// What the page gives the adapter (all read through refs, because a run
// outlives renders).
export type ChatRuntimeCtx = {
  getSettings: () => ChatSettings;
  /** Rebuilt every round: an accepted edit may have changed the active file. */
  buildSystemPrompt: () => string;
  /**
   * Execute one tool call; BLOCKS on apply_edit until the user decides.
   * Errors come back as "ERROR: …" text the model can react to.
   */
  executeTool: (
    callId: string,
    name: string,
    argsRaw: string,
  ) => Promise<string>;
  /** Engine progress (model load stages) while the LAN backend is busy. */
  onEngineProgress?: (p: LanProgress) => void;
};

// Safety cap on tool rounds (the old loop was unbounded): a model that
// keeps calling tools 12 rounds in a row is stuck, not working.
const MAX_ROUNDS = 12;

type Part = TextMessagePart | ReasoningMessagePart | ToolCallMessagePart;

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

// A JSON object in the sense of the part type's ReadonlyJSONObject
// (the args field is a partial parse while the model streams: a field
// may be missing or mid-string; the final parse happens at round end,
// when the page's executeTool JSON.parses the raw text and reports a
// readable error for malformed JSON).
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
function partialArgs(argsText: string): { [key: string]: JsonValue } {
  if (!argsText) return {};
  try {
    const v: unknown = JSON.parse(argsText);
    return typeof v === "object" && v !== null
      ? (v as { [key: string]: JsonValue })
      : {};
  } catch {
    return {};
  }
}

type PendingCall = {
  index: number;
  /** Stable part id: the streamed id when it arrives, else a placeholder. */
  key: string;
  id: string;
  name: string;
  argsText: string;
  result?: string;
};

export function createChatModelAdapter(
  getCtx: () => ChatRuntimeCtx,
): ChatModelAdapter {
  return {
    // NOTE: must return the generator DIRECTLY — the runtime checks the
    // return value for Symbol.asyncIterator without awaiting it, so an
    // async method (which returns a Promise) would be misread as a single
    // non-streaming result.
    run(options: ChatModelRunOptions) {
      return runLoop(options, getCtx);
    },
  };
}

async function* runLoop(
  options: ChatModelRunOptions,
  getCtx: () => ChatRuntimeCtx,
): AsyncGenerator<ChatModelRunResult> {
  const ctx = getCtx();
  const settings = ctx.getSettings();
  const signal = options.abortSignal;
  throwIfAborted(signal);

  // The conversation so far, including the triggering user message.
  const wire: WireMessage[] = toWireMessages(options.messages);
  // Parts from finished rounds; each round appends its own parts.
  let priorParts: Part[] = [];

  for (let round = 0; ; round++) {
    // Rebuild the system context every round: an accepted edit may have
    // changed the active file since the previous round.
    const roundWire: WireMessage[] = [
      { role: "system", content: ctx.buildSystemPrompt() },
      ...wire,
    ];

    let text = "";
    let reasoning = "";
    const calls: PendingCall[] = [];
    const byIndex = new Map<number, PendingCall>();

    const roundParts = (): Part[] => {
      const parts: Part[] = [];
      if (reasoning)
        parts.push({ type: "reasoning", id: `r${round}`, text: reasoning });
      if (text) parts.push({ type: "text", id: `t${round}`, text });
      for (const c of calls) {
        parts.push({
          type: "tool-call",
          toolCallId: c.key,
          toolName: c.name || "(unnamed)",
          args: partialArgs(c.argsText),
          argsText: c.argsText,
          ...(c.result !== undefined
            ? {
                result: c.result,
                isError: c.result.startsWith("ERROR:"),
              }
            : {}),
        });
      }
      return parts;
    };

    for await (const ev of streamWireRound({
      settings,
      messages: roundWire,
      tools: CHAT_TOOLS,
      signal,
      onEngineProgress: ctx.onEngineProgress,
    })) {
      if (ev.type === "text") {
        text += ev.text;
      } else if (ev.type === "reasoning") {
        reasoning += ev.text;
      } else if (ev.type === "toolcall") {
        const existing = byIndex.get(ev.index);
        if (!existing) {
          const call: PendingCall = {
            index: ev.index,
            key: ev.id || `gen${round}-${ev.index}`,
            id: ev.id ?? "",
            name: ev.name ?? "",
            argsText: "",
          };
          byIndex.set(ev.index, call);
          calls.push(call);
        } else {
          if (ev.id && !existing.id) {
            // The real id arrived after a placeholder was needed —
            // rekey once (ids normally arrive in the first fragment).
            existing.id = ev.id;
            if (existing.key.startsWith(`gen${round}-`)) {
              existing.key = ev.id;
            }
          }
          if (ev.name) existing.name += ev.name;
          if (ev.args) existing.argsText += ev.args;
        }
      }
      // "done" only carries the finish reason; the round-continuation
      // signal (as before) is whether tool calls were emitted.
      yield { content: [...priorParts, ...roundParts()] };
    }
    // The LAN stream may end quietly on abort (the engine is asked to
    // stop, the fetch dies) — treat a post-stream abort as cancelled.
    throwIfAborted(signal);

    const roundDone = roundParts();
    const realCalls = calls.filter((c) => c.name !== "");
    if (realCalls.length > 0) {
      if (round + 1 >= MAX_ROUNDS) {
        // Cap hit: end the run with a note instead of looping forever.
        priorParts = [
          ...priorParts,
          ...roundDone,
          {
            type: "text",
            id: `t${round}-cap`,
            text: "(stopped: the model kept calling tools; ending the conversation.)",
          },
        ];
        yield { content: priorParts };
        return;
      }
      // Give each call its final id, then execute them one by one.
      // Stop clicked while apply_edit held the loop → the settle unblocks
      // the await; the aborted check after the yield turns it into a cancel.
      for (const c of realCalls) {
        if (!c.id) c.id = c.key;
        throwIfAborted(signal);
        c.result = await ctx.executeTool(c.id, c.name, c.argsText);
      }
      // A stop may have landed while the loop blocked on an approval:
      // yield the settled results BEFORE the abort propagates — a
      // cancelled run keeps its last yield, and a tool part without a
      // result would spin forever next to the card the user just settled
      // (unexecuted siblings get a terminal result of their own).
      if (signal.aborted) {
        for (const c of realCalls) {
          if (c.result === undefined)
            c.result =
              "ERROR: the conversation was stopped before this tool ran.";
        }
      }
      priorParts = [...priorParts, ...roundParts()];
      yield { content: priorParts };
      throwIfAborted(signal);
      wire.push({
        role: "assistant",
        content: text,
        tool_calls: realCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.argsText },
        })),
      });
      for (const c of realCalls) {
        wire.push({
          role: "tool",
          tool_call_id: c.id,
          content: c.result ?? "",
        });
      }
      continue;
    }
    // Final text round: no tool calls.
    priorParts = [...priorParts, ...roundDone];
    if (roundDone.length === 0) {
      priorParts.push({
        type: "text",
        id: `t${round}-empty`,
        text: "(no response from the model)",
      });
    }
    yield { content: priorParts };
    return;
  }
}
