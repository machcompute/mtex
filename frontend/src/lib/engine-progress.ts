// Pure helpers for presenting the LAN engine's model-load progress
// (LanProgress: tokenizer → gpu → download → quantize → pipelines →
// prefill → ready). UI-independent so any surface (the chat pane, a
// future "download model" button) renders the same wording.
import type { LanProgress } from "./lan-llm";

const STAGE_LABELS: Record<string, string> = {
  tokenizer: "Loading tokenizer…",
  gpu: "Initializing GPU…",
  download: "Downloading model…",
  quantize: "Preparing model weights…",
  pipelines: "Compiling GPU pipelines…",
  prefill: "Warming up the model…",
};

/** Headline for a progress event: a known stage's wording, else the
 *  engine's own message, else a generic "Loading model…". */
export function engineStageLabel(p: LanProgress): string {
  return STAGE_LABELS[p.stage] ?? (p.message.trim() || "Loading model…");
}

/** Whole-number percent (0-100) when the engine reports a fraction, else
 *  null (indeterminate). Out-of-range / non-finite values are clamped. */
export function engineProgressPct(p: LanProgress): number | null {
  if (p.progress === null || !Number.isFinite(p.progress)) return null;
  return Math.round(Math.min(1, Math.max(0, p.progress)) * 100);
}

/** "42s" / "3m 07s" / "1h 02m" for a duration in ms. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The terminal stage: the model is loaded and the indicator should go. */
export function isEngineReady(p: LanProgress): boolean {
  return p.stage === "ready";
}

/**
 * Download size (bytes) of each model the engine registers: every GGUF the
 * model needs (weights + the multimodal projector for Gemma), exactly as
 * pinned in the engine's gguf/sources.js. The wire does not expose sizes
 * (models.list has no byte count), so this mirrors the engine's registry;
 * unknown ids simply get no size.
 */
export const MODEL_DOWNLOAD_BYTES: Record<string, number> = {
  "Qwen/Qwen3.5-4B": 2_669_209_920,
  "google/gemma-4-E2B": 2_841_481_184 + 986_833_664,
  "google/gemma-4-E4B": 4_590_807_392 + 991_552_256,
};

/** "2.7 GB" (decimal, like the engine's own download message) or null when
 *  the model's size is not known. */
export function modelDownloadSize(modelId: string): string | null {
  const bytes = MODEL_DOWNLOAD_BYTES[modelId];
  return bytes === undefined ? null : `${(bytes / 1e9).toFixed(1)} GB`;
}
