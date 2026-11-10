// The chat backend's user settings: which engine answers the chat — the
// LAN WebGPU engine or a user-configured OpenAI-compatible API endpoint
// the page calls directly — where it lives, and which model to ask for.
// Persisted in localStorage under CHAT_SETTINGS_KEY (the page also lives
// with the session, so nothing here is part of the project itself). The
// API key lives only in this browser; there is no server-side proxy.
export type ChatBackend = "lan" | "endpoint";

export type ChatSettings = {
  backend: ChatBackend;
  /** Where the LAN WebGPU engine is served from (used when backend === "lan"). */
  engineUrl: string;
  /** Model id to request from the LAN engine; empty = the engine's default. */
  model: string;
  /**
   * Base of the OpenAI-compatible API (used when backend === "endpoint"),
   * e.g. "http://host:port/v1" — the page calls "{base}/chat/completions"
   * straight from the browser.
   */
  endpointUrl: string;
  /** Bearer key sent to the endpoint; empty = sent with no auth header. */
  apiKey: string;
  /** Model id to request from the endpoint; empty = omitted from the call. */
  endpointModel: string;
};

export const CHAT_SETTINGS_KEY = "homehub:chat:settings";

/**
 * Defaults: the LAN engine (the local WebGPU model) at the configured
 * URL, the engine's default model; the endpoint fields start empty until
 * the user configures them.
 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  backend: "lan",
  engineUrl: process.env.NEXT_PUBLIC_LLM_ENGINE_URL ?? "http://localhost:3001",
  model: "",
  endpointUrl: "",
  apiKey: "",
  endpointModel: "",
};

/**
 * Load the saved settings. SSR-safe (no localStorage on the server) and
 * tolerant of corrupt/partial values: any unknown backend or non-string
 * field falls back to the default. Settings saved under the old "router"
 * backend (the deleted /api/chat proxy) migrate to "endpoint" — the key
 * was server-side and is gone with the proxy, so the user re-enters it.
 */
export function loadChatSettings(): ChatSettings {
  if (typeof window === "undefined") return DEFAULT_CHAT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(CHAT_SETTINGS_KEY);
    if (!raw) return DEFAULT_CHAT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    const s = (typeof parsed === "object" && parsed !== null
      ? parsed
      : {}) as Record<string, unknown>;
    return {
      backend:
        s.backend === "endpoint" || s.backend === "router"
          ? "endpoint"
          : "lan",
      engineUrl:
        typeof s.engineUrl === "string" && s.engineUrl.trim() !== ""
          ? s.engineUrl
          : DEFAULT_CHAT_SETTINGS.engineUrl,
      model: typeof s.model === "string" ? s.model : "",
      endpointUrl: typeof s.endpointUrl === "string" ? s.endpointUrl : "",
      apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
      endpointModel: typeof s.endpointModel === "string" ? s.endpointModel : "",
    };
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
}

/** Save the settings (best-effort; a full localStorage must not break the chat). */
export function saveChatSettings(settings: ChatSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage full / disabled — the settings simply won't persist
  }
}
