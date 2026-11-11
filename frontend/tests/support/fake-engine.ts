// A STRICT fake of the LAN engine's request validation, so chat tests fail on
// request shapes the real engine rejects (instead of silently accepting any
// message list). Mirrors validateMessages() in the engine source
// (mcompute/shared/lib/completions.ts) plus the OpenAI tool-call pairing rules
// a chat template needs: every assistant tool_call is answered by a following
// tool message with the same id, and a tool message answers a preceding call.

export class EngineRequestError extends Error {}

type Raw = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };

export function validateWireRequest(input: unknown): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new EngineRequestError("messages must be a non-empty array");
  }
  const ms = input as Raw[];
  let open = new Set<string>(); // ids of the preceding assistant's unanswered calls
  ms.forEach((m, i) => {
    const { role, content } = m ?? {};
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new EngineRequestError(`messages[${i}].role must be "system", "user", "assistant" or "tool"`);
    }
    if (typeof content !== "string" && !Array.isArray(content)) {
      throw new EngineRequestError(`messages[${i}].content must be a string or a content-parts array`);
    }
    if (role === "system" && i !== 0) {
      throw new EngineRequestError("a system message is only allowed as the first message");
    }
    if (role !== "assistant" && m.tool_calls !== undefined) {
      throw new EngineRequestError(`messages[${i}].tool_calls is only allowed on assistant messages`);
    }
    if (role === "assistant" && typeof content !== "string") {
      throw new EngineRequestError(`messages[${i}].content must be a string for assistant messages`);
    }
    // Pairing: tool results only directly after the assistant that called them.
    if (role === "tool") {
      if (typeof m.tool_call_id !== "string" || !open.has(m.tool_call_id)) {
        throw new EngineRequestError(`messages[${i}] is a tool message that answers no preceding tool call`);
      }
      open.delete(m.tool_call_id);
      return;
    }
    if (open.size > 0) {
      throw new EngineRequestError(`messages[${i}]: tool calls ${[...open].join(", ")} were not answered before the next message`);
    }
    open = new Set();
    if (role === "assistant" && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) throw new EngineRequestError(`messages[${i}].tool_calls must be an array`);
      for (const c of m.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
        if (typeof c?.function?.name !== "string" || typeof c?.function?.arguments !== "string") {
          throw new EngineRequestError(`messages[${i}].tool_calls must have function.name and function.arguments strings`);
        }
        if (typeof c.id !== "string") throw new EngineRequestError(`messages[${i}].tool_calls[].id must be a string`);
        open.add(c.id);
      }
    }
  });
  if (open.size > 0) {
    throw new EngineRequestError(`tool calls ${[...open].join(", ")} were never answered`);
  }
  const last = ms[ms.length - 1];
  if (last.role !== "user" && last.role !== "tool") {
    throw new EngineRequestError('the last message must have role "user" or "tool"');
  }
}
