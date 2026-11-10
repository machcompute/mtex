"use client";

// The chat panel, built on assistant-ui primitives. The page owns the
// runtime (useLocalRuntime) and the tool execution; this component renders
// the thread, the apply_edit approval cards, the error box, and the
// composer. It is ALWAYS mounted (hidden with display:none when another
// pane is active) so the runtime — and any in-flight run — survive pane
// switches; unmounting would abort a running conversation.
//
// The data-chat-* attributes are the e2e contract: the send button must
// exist (possibly disabled) whenever no run is in flight, tool rows carry
// the tool name AND its result, and clearing must remove every
// [data-chat-role] element.
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type AssistantRuntime,
  type EmptyMessagePartProps,
  type MessageState,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useComposerSend } from "@assistant-ui/core/react";
import { IconGear, IconSpinner } from "@/components/icons";

// A file change the assistant proposed and the user has not decided yet.
// The tool loop BLOCKS on it: the model's turn already ended, no stream
// is open, so waiting between turns is safe.
export type PendingEdit = {
  id: string; // the tool_call id
  path: string;
  old: string;
  new: string;
  line: number; // 1-based line of the match
};

// Minimal line diff (LCS) for the apply_edit approval card. Snippets are
// small; the DP grid is fine.
export type DiffLine = { t: "same" | "del" | "add"; text: string };
export function diffSnippet(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "del", text: a[i] });
      i++;
    } else {
      out.push({ t: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

type Props = {
  hidden: boolean;
  runtime: AssistantRuntime;
  pendingEdits: PendingEdit[];
  onDecideEdit: (id: string, accept: boolean) => void;
  /** Settle any pending edit, then cancel the in-flight run. */
  onStop: () => void;
  /** Settle any pending edit, cancel, and reset the thread. */
  onClear: () => void;
  onOpenSettings: () => void;
  /** LAN backend in use → the error box links to the settings modal. */
  isLanBackend: boolean;
};

export default function ChatDrawer({
  hidden,
  runtime,
  pendingEdits,
  onDecideEdit,
  onStop,
  onClear,
  onOpenSettings,
  isLanBackend,
}: Props) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-col bg-white"
      style={hidden ? { display: "none" } : undefined}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink/10 px-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone">
            Chat
          </h2>
          <div className="flex items-center gap-1">
            <button
              title="Chat settings (backend, engine URL, model)"
              onClick={onOpenSettings}
              className="rounded p-1 text-stone transition-colors hover:bg-peach hover:text-ink"
            >
              <IconGear className="h-3.5 w-3.5" />
            </button>
            <button
              data-chat-clear
              title="Clear the conversation"
              onClick={onClear}
              className="rounded px-2 py-0.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
            >
              Clear
            </button>
          </div>
        </div>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            autoScroll
            className="min-h-0 flex-1 space-y-2 overflow-auto p-3"
          >
            <ThreadPrimitive.Empty>
              <p className="text-xs text-stone">
                Ask about the document you are editing — or have the
                assistant read files, compile, fix code (you approve each
                change), or install packages.
              </p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {({ message }) => <ChatMessageRow message={message} />}
            </ThreadPrimitive.Messages>
            {pendingEdits.map((p) => (
              <PendingEditCard
                key={p.id}
                edit={p}
                onDecide={onDecideEdit}
              />
            ))}
            <ChatErrorBox
              isLanBackend={isLanBackend}
              onOpenSettings={onOpenSettings}
            />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="flex shrink-0 items-end gap-2 border-t border-ink/10 p-2">
            <ComposerInputRow />
            <ChatSendStop onStop={onStop} />
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

/** One message: a user bubble or an assistant bubble with its parts. */
function ChatMessageRow({ message }: { message: MessageState }) {
  if (message.role === "user") {
    return (
      <MessagePrimitive.Root
        data-chat-role="user"
        className="rounded border border-mint/60 bg-mint/30 px-2 py-1.5"
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide text-stone">
          You
        </div>
        <MessagePrimitive.Parts
          components={{ Text: ChatTextPart, Empty: ChatEmptyPart }}
        />
      </MessagePrimitive.Root>
    );
  }
  if (message.role === "assistant") {
    return (
      <MessagePrimitive.Root
        data-chat-role="assistant"
        className="rounded border border-stone/30 bg-white/70 px-2 py-1.5"
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide text-stone">
          Assistant
        </div>
        <MessagePrimitive.Parts
          components={{
            Text: ChatTextPart,
            Reasoning: ChatReasoningPart,
            Empty: ChatEmptyPart,
            tools: { Override: ChatToolCallPart },
          }}
        />
      </MessagePrimitive.Root>
    );
  }
  return null;
}

function ChatTextPart({ text }: TextMessagePartProps) {
  return (
    <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
      {text}
    </div>
  );
}

function ChatReasoningPart({ text }: ReasoningMessagePartProps) {
  return (
    <div className="mb-1 whitespace-pre-wrap text-xs italic leading-relaxed text-stone">
      {text}
    </div>
  );
}

function ChatEmptyPart() {
  return (
    <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
      …
    </div>
  );
}

// One tool call. While it runs (no result yet) it shows a spinner — and
// for apply_edit, the fact that it waits on the user's decision (the diff
// card below carries the accept/reject buttons). Once settled, the row
// carries the data-chat-role="tool" marker with the name and result.
function ChatToolCallPart({
  toolName,
  result,
  isError,
}: ToolCallMessagePartProps) {
  if (result === undefined) {
    return (
      <div className="rounded border border-stone/30 bg-peach/30 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone">
          <IconSpinner className="h-3 w-3" />
          Tool · {toolName}
        </div>
        {toolName === "apply_edit" && (
          <div className="mt-0.5 text-[11px] text-stone">
            Waiting for your decision on the edit…
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      data-chat-role="tool"
      className="rounded border border-stone/30 bg-peach/30 px-2 py-1.5"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-stone">
        Tool · {toolName}
      </div>
      <div
        className={
          "max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed " +
          (isError ? "text-red-700" : "text-ink")
        }
      >
        {typeof result === "string" ? result : JSON.stringify(result)}
      </div>
    </div>
  );
}

/**
 * The last message is the in-flight or most recent reply: if it ended in
 * error (engine unreachable, router failure, …) show the message.
 */
function ChatErrorBox({
  isLanBackend,
  onOpenSettings,
}: {
  isLanBackend: boolean;
  onOpenSettings: () => void;
}) {
  const error = useAuiState((s) => {
    const last = s.thread.messages[s.thread.messages.length - 1];
    if (
      last &&
      last.role === "assistant" &&
      last.status.type === "incomplete" &&
      last.status.reason === "error"
    ) {
      const err = last.status.error as { message?: string } | undefined;
      return err?.message ?? "The reply failed.";
    }
    return null;
  });
  if (error === null) return null;
  return (
    <div
      data-chat-error
      className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700"
    >
      {error}
      {isLanBackend && (
        <>
          {" "}
          <button
            onClick={onOpenSettings}
            className="underline underline-offset-2 hover:text-red-900"
          >
            Open chat settings
          </button>{" "}
          to check the engine connection.
        </>
      )}
    </div>
  );
}

/** The composer textarea. Disabled while a run is in flight: without
 *  queueing, a second submit would start a second run and the LAN engine
 *  would reject it as busy. */
function ComposerInputRow() {
  const running = useAuiState((s) => s.thread.isRunning);
  return (
    <ComposerPrimitive.Input
      data-chat-input
      disabled={running}
      rows={1}
      placeholder="Ask the assistant… (Enter to send, Shift+Enter for a new line)"
      className="max-h-24 min-w-0 flex-1 resize-y rounded border border-stone/40 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-ink"
    />
  );
}

/**
 * Custom send/stop (the built-in ComposerPrimitive.Send hides itself when
 * disabled, but the e2e contract needs the send button to EXIST —
 * possibly disabled — whenever no run is in flight).
 */
function ChatSendStop({ onStop }: { onStop: () => void }) {
  const running = useAuiState((s) => s.thread.isRunning);
  const { send, disabled } = useComposerSend();
  if (running) {
    return (
      <button
        type="button"
        data-chat-stop
        onClick={onStop}
        className="rounded border border-stone/40 px-3 py-1.5 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
      >
        Stop
      </button>
    );
  }
  return (
    <button
      type="button"
      data-chat-send
      disabled={disabled}
      onClick={() => send()}
      className="rounded bg-ink px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40 disabled:hover:opacity-40"
    >
      Send
    </button>
  );
}

/** The apply_edit approval card (markup unchanged from the old drawer). */
function PendingEditCard({
  edit,
  onDecide,
}: {
  edit: PendingEdit;
  onDecide: (id: string, accept: boolean) => void;
}) {
  const p = edit;
  return (
    <div
      data-chat-pending-edit
      className="rounded border border-ink/20 bg-white/80 p-2 shadow-sm"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink">
          Apply edit
        </span>
        <span className="truncate font-mono text-[11px] text-stone">
          {p.path}:{p.line}
        </span>
      </div>
      <pre className="mt-1 max-h-40 overflow-auto rounded bg-cream p-1.5 font-mono text-[11px] leading-relaxed">
        {diffSnippet(p.old, p.new).map((d, li) => (
          <div
            key={li}
            className={
              d.t === "del"
                ? "bg-red-100 text-red-800"
                : d.t === "add"
                  ? "bg-green-100 text-green-800"
                  : "text-stone"
            }
          >
            {d.t === "del" ? "- " : d.t === "add" ? "+ " : "  "}
            {d.text || " "}
          </div>
        ))}
      </pre>
      <div className="mt-1.5 flex gap-2">
        <button
          data-chat-edit-accept
          onClick={() => onDecide(p.id, true)}
          className="rounded bg-mint px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:bg-ink hover:text-mint"
        >
          Accept
        </button>
        <button
          data-chat-edit-reject
          onClick={() => onDecide(p.id, false)}
          className="rounded border border-stone/40 px-2.5 py-1 text-xs text-stone transition-colors hover:bg-peach hover:text-ink"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
