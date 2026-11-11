"use client";

// Model load / download indicator for the LAN engine. `useEngineProgress`
// holds the latest LanProgress event (plus when the load started, for the
// elapsed clock); `EngineProgressRow` renders it: stage label, engine
// message, a % bar when the engine reports a fraction, an indeterminate
// pulse + elapsed time otherwise. Reusable by anything that surfaces
// engine progress — feed `report` from `onEngineProgress`/`ensureLanLlm`.
import { useCallback, useEffect, useState } from "react";
import {
  engineProgressPct,
  engineStageLabel,
  formatElapsed,
  isEngineReady,
} from "@/lib/engine-progress";
import type { LanProgress } from "@/lib/lan-llm";
import { IconSpinner } from "./icons";

export type EngineProgressState = {
  progress: LanProgress;
  /** Epoch ms of the first event of this load (drives the elapsed clock). */
  startedAt: number;
};

export function useEngineProgress(): {
  state: EngineProgressState | null;
  /** Feed engine events; null or the "ready" stage clears the indicator. */
  report: (p: LanProgress | null) => void;
} {
  const [state, setState] = useState<EngineProgressState | null>(null);
  const report = useCallback((p: LanProgress | null) => {
    if (p === null || isEngineReady(p)) {
      setState(null);
      return;
    }
    setState((prev) => ({ progress: p, startedAt: prev?.startedAt ?? Date.now() }));
  }, []);
  return { state, report };
}

export function EngineProgressRow({ state }: { state: EngineProgressState }) {
  const { progress, startedAt } = state;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pct = engineProgressPct(progress);
  const label = engineStageLabel(progress);
  return (
    <div
      data-chat-engine-progress
      data-stage={progress.stage}
      className="rounded border border-stone/30 bg-peach/30 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-xs text-stone">
        <IconSpinner className="h-3 w-3 shrink-0" />
        <span data-engine-progress="label" className="min-w-0 flex-1 truncate font-medium text-ink">
          {label}
        </span>
        {pct !== null && (
          <span data-engine-progress="pct" className="shrink-0 font-mono tabular-nums">
            {pct}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== null ? { "aria-valuenow": pct } : {})}
        data-engine-progress="bar"
        data-indeterminate={pct === null ? "" : undefined}
        className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/10"
      >
        {pct !== null ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-mint transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-mint" />
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2 text-[11px] text-stone">
        <span data-engine-progress="message" className="min-w-0 flex-1 truncate" title={progress.message}>
          {progress.message}
        </span>
        <span data-engine-progress="elapsed" className="shrink-0 tabular-nums">
          {formatElapsed(now - startedAt)}
        </span>
      </div>
    </div>
  );
}
