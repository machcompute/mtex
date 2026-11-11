"use client";

import { useEffect, useRef, useState } from "react";
import { IconClose, IconSpinner } from "@/components/icons";
import {
  EngineProgressRow,
  useEngineProgress,
} from "@/components/engine-progress";
import { modelDownloadSize } from "@/lib/engine-progress";
import {
  closeLanLlm,
  lanEngineDefaultModel,
  lanListModels,
  lanPreloadModel,
  type LanProgress,
  type ListedModel,
} from "@/lib/lan-llm";
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatBackend,
  type ChatSettings,
} from "@/lib/chat-settings";

type Props = {
  settings: ChatSettings;
  /** The page persists the new settings (state + localStorage). */
  onChange: (next: ChatSettings) => void;
  onClose: () => void;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Where the chat talks to: the LAN WebGPU engine (default — the local
 * MachLLM server) or an API endpoint the page calls directly — the user
 * enters the endpoint address, the API key, and the model to ask for.
 * For the LAN engine the model list is fetched live (its cached flag
 * included) and the listing doubles as the connection test.
 */
export default function ChatSettingsModal({
  settings,
  onChange,
  onClose,
}: Props) {
  // Fields are edited as drafts and committed with "Save"; the backend
  // toggle applies immediately (it cannot break anything in flight — a
  // running chat keeps its own settings snapshot).
  const [url, setUrl] = useState(settings.engineUrl);
  const [model, setModel] = useState(settings.model);
  const [endpointUrl, setEndpointUrl] = useState(settings.endpointUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [endpointModel, setEndpointModel] = useState(settings.endpointModel);
  // The model list is per-URL: tag it so a stale list for a previous URL
  // can never render (derived `current` below is the only thing shown).
  const [modelList, setModelList] = useState<{
    url: string;
    models: ListedModel[];
  } | null>(null);
  const [listError, setListError] = useState<{
    url: string;
    error: string;
  } | null>(null);
  const [progress, setProgress] = useState<LanProgress | null>(null);
  // The engine's default model id (what "Engine default" resolves to).
  const [defaultModel, setDefaultModel] = useState<{
    url: string;
    id: string | null;
  } | null>(null);
  // "Start download": a preheat of the selected model through the engine,
  // reported with the same indicator the chat uses.
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);
  const engineProgress = useEngineProgress();
  const reportProgress = engineProgress.report;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Listing the models IS the connection test: it opens the engine
  // connection (iframe handshake) if needed. No weights load — that only
  // happens on the first completion.
  useEffect(() => {
    if (settings.backend !== "lan") return;
    let cancelled = false;
    lanListModels(settings.engineUrl, (p) => {
      if (!cancelled) setProgress(p);
    })
      .then(async (models) => {
        // Which model "Engine default" means — best effort; without it the
        // default pick simply gets no warning.
        const defId = await lanEngineDefaultModel(settings.engineUrl).catch(
          () => null,
        );
        if (cancelled) return;
        setModelList({ url: settings.engineUrl, models });
        setDefaultModel({ url: settings.engineUrl, id: defId });
        setListError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setModelList(null);
        setListError({ url: settings.engineUrl, error: errMsg(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [settings.backend, settings.engineUrl, listTick]);

  const models =
    modelList && modelList.url === settings.engineUrl
      ? modelList.models
      : null;
  const listErr =
    listError && listError.url === settings.engineUrl
      ? listError.error
      : null;
  const connecting = !models && !listErr;
  // The model the picker currently points at, and whether its weights are
  // still to be downloaded (cached === null = unknown: no warning).
  const defaultId =
    defaultModel && defaultModel.url === settings.engineUrl
      ? defaultModel.id
      : null;
  const selectedId = model !== "" ? model : defaultId;
  const selected = models?.find((m) => m.id === selectedId) ?? null;
  const needsDownload = selected !== null && selected.cached === false;
  const sizeText = selected ? modelDownloadSize(selected.id) : null;
  const dirty =
    url.trim() !== settings.engineUrl ||
    model !== settings.model ||
    endpointUrl.trim() !== settings.endpointUrl ||
    apiKey !== settings.apiKey ||
    endpointModel.trim() !== settings.endpointModel;

  const changeBackend = (backend: ChatBackend) => {
    if (backend === settings.backend) return;
    onChange({ ...settings, backend });
  };

  const startDownload = async () => {
    if (!selected || loading) return;
    const engineUrl = settings.engineUrl;
    setLoading(true);
    setLoadError(null);
    reportProgress(null);
    try {
      await lanPreloadModel(engineUrl, selected.id, reportProgress);
      // Loaded: the engine's cache now has the weights — flip the flag
      // right away (warning + button go away) and re-list to confirm.
      if (alive.current) {
        const id = selected.id;
        setModelList((cur) =>
          cur && cur.url === engineUrl
            ? {
                ...cur,
                models: cur.models.map((m) =>
                  m.id === id ? { ...m, cached: true } : m,
                ),
              }
            : cur,
        );
        setListTick((t) => t + 1);
      }
    } catch (e) {
      // An unreachable engine reads like it does in the chat (its message
      // already points at the engine URL above).
      if (alive.current) setLoadError(errMsg(e));
    } finally {
      reportProgress(null);
      if (alive.current) setLoading(false);
    }
  };

  const save = () => {
    const nextUrl = url.trim() !== "" ? url.trim() : DEFAULT_CHAT_SETTINGS.engineUrl;
    if (nextUrl !== settings.engineUrl) {
      // The old engine is a different machine: drop that connection so
      // the next chat starts clean against the new URL.
      closeLanLlm(settings.engineUrl);
      setProgress(null);
    }
    onChange({
      ...settings,
      engineUrl: nextUrl,
      model,
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      endpointModel: endpointModel.trim(),
    });
  };

  return (
    <div
      data-modal="chat-settings"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-md border border-ink/10 bg-cream p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Chat settings</h2>
          <button
            onClick={onClose}
            title="Close"
            className="rounded p-1 text-stone hover:bg-peach/60 hover:text-ink"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Backend */}
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
          Backend
        </p>
        <div className="mb-3 flex gap-2">
          {(
            [
              ["lan", "LAN engine (WebGPU)"],
              ["endpoint", "API endpoint"],
            ] as Array<[ChatBackend, string]>
          ).map(([b, label]) => (
            <button
              key={b}
              onClick={() => changeBackend(b)}
              className={
                "flex-1 rounded border px-2 py-1.5 text-xs transition-colors " +
                (settings.backend === b
                  ? "border-mint bg-mint/30 text-ink"
                  : "border-stone/40 bg-white text-stone hover:bg-peach/40")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {settings.backend === "lan" ? (
          <>
            {/* Engine URL */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
              Engine URL
            </p>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_CHAT_SETTINGS.engineUrl}
              spellCheck={false}
              autoComplete="off"
              className="mb-3 w-full rounded border border-stone/40 bg-white px-2 py-1.5 font-mono text-xs text-ink focus:border-mint focus:outline-none"
            />

            {/* Model + engine status */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
              Model
            </p>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={models === null}
              className="mb-2 w-full rounded border border-stone/40 bg-white px-2 py-1.5 text-xs text-ink focus:border-mint focus:outline-none disabled:opacity-50"
            >
              <option value="">Engine default</option>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.id}
                  {m.cached === true ? " (cached)" : ""}
                </option>
              ))}
            </select>

            {connecting && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-stone">
                <IconSpinner className="h-3 w-3" />
                {progress
                  ? `Connecting… ${progress.message}`
                  : "Connecting to the engine…"}
                {progress?.progress != null && (
                  <span className="font-mono">
                    {Math.round(progress.progress * 100)}%
                  </span>
                )}
              </p>
            )}
            {listErr && (
              <p className="mb-2 rounded bg-peach/60 px-2 py-1 text-xs text-ink">
                {listErr}
              </p>
            )}
            {models !== null && (
              <p className="mb-2 text-xs text-stone">
                Engine reachable — {models.length} model
                {models.length === 1 ? "" : "s"} listed.
              </p>
            )}

            {needsDownload && selected && (
              <div
                data-chat-model-download
                className="mb-2 rounded border border-stone/30 bg-peach/30 px-2 py-2 text-xs text-ink"
              >
                <p className="mb-1 font-semibold">
                  This chat installs a local model in your browser
                </p>
                <p className="mb-2 text-stone">
                  {selected.label} is not installed yet. The first use
                  downloads
                  {sizeText ? ` about ${sizeText} of` : ""} model weights from
                  Hugging Face into this browser&apos;s storage and sets them
                  up on your GPU — it can take 10+ minutes on a slow
                  connection, and it needs WebGPU. It is a one-time step:
                  afterwards the model is cached and chats start right away.
                </p>
                {loading ? (
                  engineProgress.state ? (
                    <EngineProgressRow state={engineProgress.state} />
                  ) : (
                    <p
                      data-engine-progress="starting"
                      className="flex items-center gap-1.5 text-stone"
                    >
                      <IconSpinner className="h-3 w-3" />
                      Starting the download…
                    </p>
                  )
                ) : (
                  <button
                    data-action="start-model-download"
                    onClick={startDownload}
                    className="rounded bg-mint px-3 py-1.5 text-xs font-semibold text-ink transition-opacity hover:opacity-80"
                  >
                    Start download{sizeText ? ` (${sizeText})` : ""}
                  </button>
                )}
                {loadError && (
                  <p
                    data-chat-model-download-error
                    className="mt-2 rounded bg-peach/60 px-2 py-1 text-ink"
                  >
                    {loadError}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {/* Endpoint address */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
              Endpoint address
            </p>
            <input
              type="text"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="http://host:port/v1"
              spellCheck={false}
              autoComplete="off"
              className="mb-2 w-full rounded border border-stone/40 bg-white px-2 py-1.5 font-mono text-xs text-ink focus:border-mint focus:outline-none"
            />

            {/* API key */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
              API key
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              className="mb-2 w-full rounded border border-stone/40 bg-white px-2 py-1.5 font-mono text-xs text-ink focus:border-mint focus:outline-none"
            />

            {/* Model */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
              Model
            </p>
            <input
              type="text"
              value={endpointModel}
              onChange={(e) => setEndpointModel(e.target.value)}
              placeholder="Model id (e.g. qwen3.8-27b)"
              spellCheck={false}
              autoComplete="off"
              className="mb-2 w-full rounded border border-stone/40 bg-white px-2 py-1.5 font-mono text-xs text-ink focus:border-mint focus:outline-none"
            />

            <p className="mb-2 text-xs text-stone">
              The page streams from this OpenAI-compatible endpoint
              directly — the key is sent to it as a Bearer token and
              stored only in this browser. The engine URL and model
              picker apply when the LAN engine is selected.
            </p>
          </>
        )}

        {/* Footer */}
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-ink/10 pt-3">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach/60 hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded bg-mint px-3 py-1.5 text-xs font-semibold text-ink transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
