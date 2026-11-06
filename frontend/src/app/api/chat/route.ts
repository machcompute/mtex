// The editor's chat panel proxies through here to the LLM router on the
// LAN (an OpenAI-compatible endpoint — see .env.local, which is
// gitignored). The router's API key lives on the server only and is
// never exposed to the browser: the page POSTs plain messages (and, for
// the assistant's project tools, a `tools` array plus the tool results)
// to this route and the route signs the upstream call.
//
// The upstream is a local FastLLM router running qwen3.8-27b, a thinking
// model — each request disables thinking (chat_template_kwargs) so
// answers come straight out. Responses stream through as SSE
// (text/event-stream) so the page can render the assistant's tokens as
// they are produced.
//
// (Node.js runtime is the default; the `runtime` segment config is not
// allowed with this project's cacheComponents setup.)

const ROUTER_BASE =
  process.env.ROUTER_BASE_URL || "http://192.168.1.230/router/api/v1";
const API_KEY = process.env.ROUTER_API_KEY || "";
const MODEL = process.env.CHAT_MODEL || "qwen3.8-27b";

// Caps for one conversation: plenty for real use, but a single request
// can't push an unbounded context upstream. The message cap is generous
// on purpose: the page's tool loop grows the history by an assistant
// message + one tool message per tool call.
const MAX_MESSAGES = 100;
const MAX_CONTENT_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_TOOL_CALLS = 10;
const MAX_TOOLS = 20;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The three message shapes the tool loop produces. Assistant messages
// may carry tool_calls (content can then be empty); tool messages answer
// exactly one tool call by id.
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export async function POST(request: Request) {
  if (!API_KEY) {
    return Response.json(
      { error: "chat backend not configured (ROUTER_API_KEY is missing)" },
      { status: 503 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const body = parsed as { messages?: unknown; tools?: unknown };
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return Response.json(
      { error: `messages must be an array of 1..${MAX_MESSAGES}` },
      { status: 400 },
    );
  }

  const messages: ChatMsg[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown }).role;
    if (role === "system" || role === "user") {
      const content = (m as { content?: unknown }).content;
      if (typeof content !== "string") {
        return Response.json(
          { error: "system/user messages need string content" },
          { status: 400 },
        );
      }
      messages.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
    } else if (role === "assistant") {
      const a = m as { content?: unknown; tool_calls?: unknown };
      const content = typeof a.content === "string" ? a.content : "";
      let toolCalls: ToolCall[] | undefined;
      if (a.tool_calls !== undefined) {
        if (
          !Array.isArray(a.tool_calls) ||
          a.tool_calls.length === 0 ||
          a.tool_calls.length > MAX_TOOL_CALLS
        ) {
          return Response.json(
            {
              error: `assistant tool_calls must be an array of 1..${MAX_TOOL_CALLS}`,
            },
            { status: 400 },
          );
        }
        toolCalls = [];
        for (const tc of a.tool_calls) {
          const t = tc as {
            id?: unknown;
            type?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          if (
            typeof t.id !== "string" ||
            t.type !== "function" ||
            typeof t.function?.name !== "string" ||
            typeof t.function?.arguments !== "string"
          ) {
            return Response.json(
              {
                error:
                  "each tool_call needs an id, type \"function\" and a function {name, arguments}",
              },
              { status: 400 },
            );
          }
          toolCalls.push({
            id: t.id.slice(0, 128),
            type: "function",
            function: {
              name: t.function.name.slice(0, 128),
              arguments: t.function.arguments.slice(0, 64_000),
            },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: content.slice(0, MAX_CONTENT_CHARS),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool") {
      const t = m as { tool_call_id?: unknown; content?: unknown };
      if (typeof t.tool_call_id !== "string" || typeof t.content !== "string") {
        return Response.json(
          { error: "tool messages need a tool_call_id and string content" },
          { status: 400 },
        );
      }
      messages.push({
        role: "tool",
        tool_call_id: t.tool_call_id.slice(0, 128),
        content: t.content.slice(0, MAX_CONTENT_CHARS),
      });
    } else {
      return Response.json(
        {
          error:
            "each message needs a system|user|assistant|tool role and string content",
        },
        { status: 400 },
      );
    }
  }

  // The assistant's tools (OpenAI function format). Validated shallowly:
  // the shapes the page sends, nothing more — the upstream does the real
  // schema check and the page executes the calls, never the router.
  let tools: ChatTool[] | undefined;
  if (body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.length === 0 ||
      body.tools.length > MAX_TOOLS
    ) {
      return Response.json(
        { error: `tools must be an array of 1..${MAX_TOOLS}` },
        { status: 400 },
      );
    }
    tools = [];
    for (const t of body.tools) {
      const f = (t as { type?: unknown; function?: unknown }).function as {
        name?: unknown;
        description?: unknown;
        parameters?: unknown;
      } | undefined;
      const params = f?.parameters;
      if (
        (t as { type?: unknown }).type !== "function" ||
        typeof f?.name !== "string" ||
        !TOOL_NAME_RE.test(f.name) ||
        typeof params !== "object" ||
        params === null ||
        Array.isArray(params)
      ) {
        return Response.json(
          {
            error:
              'each tool needs type "function" and a function {name, parameters object}',
          },
          { status: 400 },
        );
      }
      tools.push({
        type: "function",
        function: {
          name: f.name,
          description:
            typeof f.description === "string"
              ? f.description.slice(0, 4_000)
              : "",
          // Already validated as a non-null, non-array object above.
          parameters: params as Record<string, unknown>,
        },
      });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${ROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        ...(tools ? { tools } : {}),
        stream: true,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The model is a thinking model; for an inline assistant the
        // thinking budget would only add latency.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    console.error("[chat] upstream fetch failed:", err);
    return Response.json(
      { error: `upstream unreachable: ${String(err)}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { error: `upstream ${upstream.status}: ${text.slice(0, 500)}` },
      { status: 502 },
    );
  }

  // Pass the SSE stream straight through; no-transform keeps proxies from
  // reformatting the event-stream body.
  return new Response(upstream.body, {
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
