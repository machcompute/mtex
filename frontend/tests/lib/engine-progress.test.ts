import { describe, expect, it } from "vitest";
import { engineProgressPct, engineStageLabel, formatElapsed, isEngineReady, modelDownloadSize } from "@/lib/engine-progress";

const p = (stage: string, progress: number | null, message = "") => ({ stage, message, progress });

describe("engineStageLabel", () => {
  it("words the known stages", () => {
    expect(engineStageLabel(p("download", 0.1, "x"))).toBe("Downloading model…");
    expect(engineStageLabel(p("tokenizer", null))).toBe("Loading tokenizer…");
    expect(engineStageLabel(p("gpu", null))).toBe("Initializing GPU…");
    expect(engineStageLabel(p("quantize", 0.5))).toBe("Preparing model weights…");
    expect(engineStageLabel(p("pipelines", null))).toBe("Compiling GPU pipelines…");
    expect(engineStageLabel(p("prefill", null))).toBe("Warming up the model…");
  });
  it("falls back to the engine's message, then a generic label, for unknown stages", () => {
    expect(engineStageLabel(p("mystery", null, "Doing a thing"))).toBe("Doing a thing");
    expect(engineStageLabel(p("mystery", null, "  "))).toBe("Loading model…");
  });
});

describe("engineProgressPct", () => {
  it("rounds a fraction to a whole percent", () => {
    expect(engineProgressPct(p("download", 0.426))).toBe(43);
    expect(engineProgressPct(p("download", 0))).toBe(0);
    expect(engineProgressPct(p("download", 1))).toBe(100);
  });
  it("is null (indeterminate) when the engine reports no fraction, and clamps nonsense", () => {
    expect(engineProgressPct(p("gpu", null))).toBeNull();
    expect(engineProgressPct(p("download", Number.NaN))).toBeNull();
    expect(engineProgressPct(p("download", 1.7))).toBe(100);
    expect(engineProgressPct(p("download", -0.2))).toBe(0);
  });
});

describe("formatElapsed / isEngineReady", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(42_900)).toBe("42s");
    expect(formatElapsed(187_000)).toBe("3m 07s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
    expect(formatElapsed(-5)).toBe("0s");
  });
  it("only the ready stage is ready", () => {
    expect(isEngineReady(p("ready", 1))).toBe(true);
    expect(isEngineReady(p("prefill", 1))).toBe(false);
  });
});

describe("modelDownloadSize", () => {
  it("sums every GGUF a model needs, in decimal GB like the engine's own message", () => {
    expect(modelDownloadSize("Qwen/Qwen3.5-4B")).toBe("2.7 GB"); // 2_669_209_920 bytes
    expect(modelDownloadSize("google/gemma-4-E2B")).toBe("3.8 GB"); // weights + mmproj
    expect(modelDownloadSize("google/gemma-4-E4B")).toBe("5.6 GB");
  });
  it("is null for a model the registry does not know", () => {
    expect(modelDownloadSize("someone/else")).toBeNull();
  });
});
