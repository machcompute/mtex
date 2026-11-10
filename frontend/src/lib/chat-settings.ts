// The chat backend's user settings: which engine answers the chat, where
// it lives, and which model to ask for. Persisted in localStorage under
// CHAT_SETTINGS_KEY (the page also lives with the session, so nothing here
// is part of the project itself).
export type ChatBackend = "lan" | "router";

export type ChatSettings = {
  backend: ChatBackend;
  /** Where the LAN WebGPU engine is served from (used when backend === "lan"). */
  engineUrl: string;
  /** Model id to request; empty = the engine's default model. */
  model: string;
};

export const CHAT_SETTINGS_KEY = "homehub:chat:settings";

/**
 * Defaults: the LAN engine (the local WebGPU model) at the configured URL,
 * the engine's default model. The Router (/api/chat) stays a fallback.
 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  backend: "lan",
  engineUrl: process.env.NEXT_PUBLIC_LLM_ENGINE_URL ?? "http://localhost:3001",
  model: "",
};

/**
 * Load the saved settings. SSR-safe (no localStorage on the server) and
 * tolerant of corrupt/partial values: any unknown backend or non-string
 * field falls back to the default.
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
      backend: s.backend === "router" ? "router" : "lan",
      engineUrl:
        typeof s.engineUrl === "string" && s.engineUrl.trim() !== ""
          ? s.engineUrl
          : DEFAULT_CHAT_SETTINGS.engineUrl,
      model: typeof s.model === "string" ? s.model : "",
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
