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
