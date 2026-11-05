// The editor's chat panel proxies through here to the LLM router on the
// LAN (an OpenAI-compatible endpoint — see .env.local, which is
// gitignored). The router's API key lives on the server only and is
// never exposed to the browser: the page POSTs plain messages to this
// route and the route signs the upstream call.
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
// can't push an unbounded context upstream.
const MAX_MESSAGES = 50;
const MAX_CONTENT_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 4096;

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

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
  const raw = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return Response.json(
      { error: `messages must be an array of 1..${MAX_MESSAGES}` },
      { status: 400 },
    );
  }
  const messages: ChatMsg[] = [];
  for (const m of raw) {
    const { role, content } = m as ChatMsg;
    if (
      (role !== "system" && role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      return Response.json(
        {
          error:
            "each message needs a system|user|assistant role and string content",
        },
        { status: 400 },
      );
    }
    messages.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
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
