// Type declarations for the vendored mach-llm-sdk.js (the MachLLM SDK).
// Shapes mirror the shared engine's sources (lib/protocol.ts,
// lib/completions.ts, lib/engine.ts) — re-verify when the SDK is
// re-copied.
export type LanProgress = {
  stage: string;
  message: string;
  progress: number | null;
};

export type ListedModel = {
  object: "model";
  id: string;
  label: string;
  modalities: readonly string[];
  maxContext: number;
  /** Whether the model's weights are already in the engine's cache. */
  cached: boolean | null;
};

export type EngineStatus = {
  model: string;
  activeModel: string;
  defaultModel: string;
  loaded: boolean;
  generating: boolean;
  webgpu: boolean;
  contextUsedTokens: number;
  contextMaxTokens: number;
};

export type LanToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LanToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments?: string };
};

/** One streamed chunk (OpenAI chat.completion.chunk shape). */
export type LanStreamChunk = {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: LanToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
};

/** The final completion (OpenAI chat.completion shape). */
export type LanCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
      tool_calls?: LanToolCall[];
      reasoning_content?: string;
    };
    finish_reason: "stop" | "length" | "abort" | "tool_calls";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type LanChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: LanToolCall[];
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type LanChatParams = {
  model?: string;
  messages: LanChatMessage[];
  tools?: object[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  max_tokens?: number | null;
  thinking?: boolean;
};

export type LanStream = AsyncIterable<LanStreamChunk> & {
  /** The full completion; set once the stream is exhausted. */
  completion: LanCompletion | null;
  controller: AbortController;
};

export class MachLLM {
  static connect(options?: {
    engineUrl?: string;
    onProgress?: (progress: LanProgress) => void;
    timeoutMs?: number;
  }): Promise<MachLLM>;
  chat: {
    completions: {
      create(
        params: LanChatParams,
        options?: { signal?: AbortSignal },
      ): Promise<LanStream | LanCompletion>;
    };
  };
  models: {
    list(): Promise<{ object: "list"; data: ListedModel[] }>;
  };
  on(event: "progress", handler: (progress: LanProgress) => void): this;
  off(event: "progress", handler: (progress: LanProgress) => void): this;
  status(): Promise<EngineStatus>;
  load(options?: object): Promise<EngineStatus>;
  unload(): Promise<EngineStatus>;
  updateSettings(options: object): Promise<unknown>;
  wipeCache(options?: object): Promise<unknown>;
  close(): void;
}
