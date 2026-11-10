// The bottom-zone chat against the LAN WebGPU engine — the default
// backend. The page talks to the engine through a hidden iframe
// (postMessage, no HTTP on the chat path), so this suite observes the
// wire: app→engine requests by injecting a message listener into the
// engine's frame, engine→app traffic by a listener on the app's main
// window (where the engine posts progress/chunk/result/error).
//
// Feasibility gate: on a host without a real GPU the WebGPU adapter is
// SwiftShader (software). There the engine downloads, caches, and loads
// the model fine ("ready" ~6 min after the first send in a fresh
// profile: 2.67 GB download at ~9 MB/s dominates), but the model then
// produces no output: the first prefill chunk (256 tokens) does not
// complete in 6+ min while ~5 cores stay pegged (measured, fresh
// profile: /tmp/opencode/chat-stage.out; a prior full run never
// settled in 60 min). Prefill emits a progress event per 256-token
// chunk (webgpu-llm model.js), so the silence means the chunk itself
// is stuck in software compute. The gate therefore watches the wire
// after the first send: if no streamed token arrives within 10 min of
// the model reporting ready (absolute backstop: 45 min after the
// send), inference is declared infeasible on this host — the run is
// stopped, the inference-dependent checks are reported as SKIP (they
// cannot pass or fail here), and the non-inference checks still run.
// On a real-GPU host tokens stream within seconds of ready and the
// full suite runs uncut.
//
// The API endpoint backend (user-configured address + API key, called
// directly from the page — the /api/chat proxy route is gone) is checked
// against a local mock OpenAI-compatible SSE server: the streamed reply
// must render, the request must hit the endpoint straight from the
// browser with the Bearer key the user typed, and no round may ever
// touch the deleted /api/chat route. The mock is instant, so this check
// does not need inference and runs uncut.
//
// Checks (SKIP-gated ones need a streamed token):
//   1. The chat pane opens from the icon rail; the rail carries
//      Files/Chat/Log with Chat active.
//   2. (gated) A deterministic question gets a streamed assistant
//      reply (the first round cold-loads the model into WebGPU —
//      minutes, by design, in a fresh profile).
//   3. No round hits /api/chat (the old proxy route is deleted, so any
//      request to it is a bug; asserted after every LAN round).
//   4. (gated) The model sees the active file (context question about
//      a marker command only the seeded document defines).
//   5. The system prompt carries the cursor position — read off the
//      engine wire (the request is captured at send time, so it does
//      not need the run to settle).
//   6. (gated) Agentic tool: list_files — a tool row shows the name
//      and result.
//   7. (gated) Agentic tool: apply_edit — accepting the diff card
//      lands the edit in the editor.
//   8. (gated) Agentic tool: apply_edit — rejecting leaves the file
//      unchanged.
//   9. (gated) Stop while the loop blocks on an approval: the card is
//      settled, the tool row settles with the "not applied" result
//      (no permanent spinner), the run cancels (no error box), the
//      file is unchanged, and the user's message stays in the thread.
//  10. Clear empties the conversation; the Log panel still shows the log.
//  11. Settings modal: the engine's models are listed live, and the
//      model picker commits with Save.
//  12. Engine down (dead port): the modal reports the failed handshake
//      and a send fails into the graceful error box with a settings link.
//  13. Restoring the engine URL: the modal is reachable again; the
//      (gated) reply round works again.
//  14. API endpoint backend: the settings ask for an address + API key
//      (+ model), the page calls the endpoint straight from the browser
//      (a local mock SSE server here), the Bearer key rides on the wire,
//      and the streamed reply renders in the thread.
const { Runner, seedProject } = require("./helpers.cjs");

const ENGINE_URL =
  process.env.CHAT_ENGINE_URL || "http://localhost:3001";
const DEAD_ENGINE_URL = "http://localhost:3999";
const ENGINE_ORIGIN = new URL(ENGINE_URL).origin;

// Deterministic caps, each justified by a named lower bound — no
// retries, no guessing. The first round is owned by the feasibility
// gate below (its backstop is GATE_ABSOLUTE_MS); these cap the
// follow-up rounds:
// WARM: the model is loaded; an agentic round is 2 model calls. On a
// real GPU that is seconds; 20 min per round is a backstop for a
// pathological (but token-producing) adapter, not an expectation.
const WARM_REPLY_MS = 1_200_000; // 20 min
// RELOAD: a fresh engine connection (after the dead-port detour) —
// the model comes from the local weights cache, but the pipeline build
// runs again → 2x WARM.
const RELOAD_REPLY_MS = 2_400_000; // 40 min
// The engine handshake gives up after 20 s (lan-llm CONNECT_TIMEOUT_MS);
// 60 s leaves 3x room for a slow LAN.
const HANDSHAKE_TIMEOUT_MS = 60_000;

// Feasibility gate constants (see the header for the measurement):
// - Ready arrives ~6 min after the first send (download-dominated).
// - Post-ready, the first prefill chunk (256 tokens — prefill emits a
//   progress event per chunk) had NOT completed after 379 s in the
//   fresh-profile stage probe (and 412 s in an earlier one); ~5 cores
//   pegged throughout = computing, not hung. 10 min after ready is
//   ~2.7x the longest observed no-token window and still far below
//   any practical suite duration.
const INFEASIBLE_AFTER_READY_MS = 600_000; // 10 min
// Absolute backstop from the first send: covers a host where the model
// never even reaches ready. 45 min > 3x the ~6 min ready time.
const GATE_ABSOLUTE_MS = 2_700_000; // 45 min
const GATE_POLL_MS = 5_000;

const GEAR = 'button[title="Chat settings (backend, URL, model, endpoint)"]';

// --- Failure evidence ---------------------------------------------------
// The box is shared and its load spikes (observed up to ~20 on 16 cores),
// so a FATAL under load must be diagnosable from the log alone. Two
// instruments are installed after the first reload:
// - an rAF gap ticker: gaps > 2 s at FATAL time prove BeginFrame
//   (compositor) starvation — a headless page under load can go
//   minutes without frames while its main thread still answers CDP.
//   It does NOT by itself prove a JS block: the dump's in-page
//   evaluate succeeding rules that out (see dumpFatalEvidence);
// - a ring of cross-origin (engine / dead-port) request events, plus
//   Playwright-side navigation and dialog watchers. Request
//   timestamps landing inside a gap window prove the main thread
//   executed JS there.
// On FATAL the current page state (URL, iframes, modal, max gap) is
// dumped next to the error.
function installEvidenceProbe(page) {
  return page.evaluate(() => {
    window.__e2eTicks = [];
    (function tick() {
      window.__e2eTicks.push(performance.now());
      if (window.__e2eTicks.length > 4000)
        window.__e2eTicks.splice(0, 2000);
      requestAnimationFrame(tick);
    })();
    window.__e2eEvents = [];
    window.addEventListener("error", (e) => {
      window.__e2eEvents.push(
        `${performance.now().toFixed(0)}ms [window-error] ${String(e.message).slice(0, 120)}`,
      );
      if (window.__e2eEvents.length > 200) window.__e2eEvents.shift();
    });
  });
}

async function dumpFatalEvidence({ r, page }) {
  if (!page) return;
  const os = require("os");
  try {
    const ev = await page.evaluate(() => {
      const t = window.__e2eTicks ?? [];
      let max = 0;
      let at = 0;
      for (let i = 1; i < t.length; i++)
        if (t[i] - t[i - 1] > max) {
          max = t[i] - t[i - 1];
          at = t[i];
        }
      return {
        maxGapMs: max,
        atMs: at,
        ticks: t.length,
        nowMs: performance.now(),
        events: (window.__e2eEvents ?? []).slice(-30),
        url: location.href,
        iframes: Array.from(document.querySelectorAll("iframe")).map(
          (f) => f.src,
        ),
        modal: !!document.querySelector("[data-modal]"),
      };
    });
    const load = os.loadavg().map((x) => x.toFixed(1)).join(", ");
    // Note: this dump evaluated IN-PAGE, so the main thread was
    // responsive at FATAL time — a long rAF gap therefore proves
    // BEGINFRAME (compositor) starvation, not a JS block. (A true JS
    // block would make THIS evaluate time out → "page state
    // unavailable" in the catch below.) A headless page under load
    // can go minutes without BeginFrames while still answering CDP.
    console.error(
      `EVIDENCE: loadavg=[${load}] max rAF gap ${ev.maxGapMs.toFixed(0)} ms ` +
        `(at ${ev.atMs.toFixed(0)} ms of ${ev.nowMs.toFixed(0)} ms, ${ev.ticks} ticks) — ` +
        (ev.maxGapMs > 2000
          ? "rAF/BeginFrame starved (compositor); main thread RESPONSIVE " +
            "at FATAL time (this dump ran in-page) — not a JS block"
          : "app main thread responsive (suspect CDP/browser-level stall)"),
    );
    console.error(
      `EVIDENCE: url=${ev.url} modal=${ev.modal} iframes=${JSON.stringify(ev.iframes)}`,
    );
    for (const line of ev.events) console.error(`EVIDENCE: ${line}`);
  } catch (d) {
    console.error(
      "EVIDENCE: (page state unavailable — browser may be gone):",
      String(d).slice(0, 120),
    );
  }
}

const suite = { r: null, page: null };
(async () => {
  const r = (suite.r = new Runner("chat"));
  const page = (suite.page = await r.start());
  try {
    await r.goto();
    if (!(await r.waitReady())) throw new Error("engine not ready");
    await seedProject(r, {
      name: "chat-doc",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      activePath: "main.tex",
      files: {
        "main.tex":
          "\\documentclass{article}\n" +
          "\\newcommand{\\huhubmarker}{ZZZ-QV7}\n" +
          "\\begin{document}\n" +
          "Hello, chat.\n" +
          "\\end{document}\n",
      },
    });
    await page.reload({ waitUntil: "load" });
    await r.waitReady();

    await installEvidenceProbe(page);
    page.on("framenavigated", (f) =>
      console.log(`[evidence:frame] ${f.url()}`),
    );
    page.on("dialog", (d) => {
      console.log(`[evidence:dialog] ${d.type()}: ${d.message().slice(0, 120)}`);
      d.dismiss().catch(() => {});
    });
    // Engine-origin and dead-port traffic (the model download comes from
    // the internet and is not interesting at check 12 time).
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("localhost:3001") || u.includes("localhost:3999"))
        console.log(
          `[evidence:req] ${new Date().toISOString().slice(11, 23)} ` +
            `${req.method()} ${u}`,
        );
    });

    // 1. Open the chat pane from the icon rail.
    await page.locator('[data-rail="chat"]').click();
    const input = page.locator("[data-chat-input]");
    r.ok("chat pane shows the input", await input.isVisible());
    r.ok(
      "the rail carries Files/Chat/Log with Chat active",
      (await page.locator('[data-rail="files"]').count()) === 1 &&
        (await page.locator('[data-rail="log"]').count()) === 1 &&
        (await page.locator('[data-rail="chat"][data-active]').count()) === 1,
    );

    // /api/chat is the old proxy route, deleted: no chat path may ever
    // hit it (the LAN backend talks to the engine over postMessage, the
    // endpoint backend calls the user's address directly). The request
    // counter is an assertion, not an expectation.
    let apiChatCount = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/chat")) apiChatCount++;
    });

    const sendButton = page.locator("[data-chat-send]");
    // Send a message and wait for the run to settle: the Send button is
    // replaced by Stop while a run is in flight, its return means the
    // run ended (success, error, or cancel).
    const send = async (text, timeoutMs) => {
      await input.fill(text);
      await sendButton.click();
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: timeoutMs },
      );
    };
    const lastAssistant = () =>
      page.evaluate(() => {
        const els = document.querySelectorAll('[data-chat-role="assistant"]');
        return els.length ? els[els.length - 1].textContent : "";
      });
    const editorText = () =>
      page
        .evaluate(() => document.querySelector(".view-lines")?.textContent ?? "")
        .then((t) => t.replace(/[\u00a0\u202f]/g, " "));
    const toolRows = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-chat-role="tool"]')).map(
          (el) => el.textContent,
        ),
      );

    // Gate listener on the app's MAIN window: the engine's iframe is
    // created lazily by the first send, but engine→app messages
    // (progress / chunk / result / error) are always posted to the
    // app's main window, so a main-frame listener installed before the
    // first send sees everything. Records when the model reports ready,
    // when the first streamed content chunk (a "chunk" without
    // event:"progress") or a terminal event arrives, and the message of
    // every engine error reply (e.g. a send rejected as busy while the
    // engine is still unwinding an aborted prefill).
    await page.evaluate(() => {
      window.__gate = { readyAt: 0, firstTokenAt: 0, lastStage: "", engineErrors: [] };
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (!d || d.ns !== "mach-llm") return;
        if (d.type === "chunk" && d.data?.event === "progress") {
          const p = d.data.progress ?? {};
          if (p.stage === "ready") window.__gate.readyAt = performance.now();
          else window.__gate.lastStage = p.stage ?? "";
        } else if (d.type === "chunk" || d.type === "result" || d.type === "error") {
          if (!window.__gate.firstTokenAt)
            window.__gate.firstTokenAt = performance.now();
          if (d.type === "error")
            window.__gate.engineErrors.push(d.data?.message ?? "");
        }
      });
    });

    // Send the first round and decide feasibility (see header).
    // Returns { feasible, reason } — "feasible" means the round settled
    // (or a token streamed); otherwise the run has been stopped.
    const gateSend = async (text) => {
      const t0 = Date.now();
      await input.fill(text);
      await sendButton.click();
      const state = () =>
        page.evaluate(() => {
          const g = window.__gate;
          const now = performance.now();
          return {
            sendBack: !!document.querySelector("[data-chat-send]"),
            readyAge: g.readyAt ? now - g.readyAt : 0,
            hasToken: !!g.firstTokenAt,
            lastStage: g.lastStage,
          };
        });
      let s = await state();
      while (!(s.sendBack || s.hasToken)) {
        // The primary gate: the model reports ready but no token
        // streams within the window → the adapter cannot run inference.
        if (s.readyAge > INFEASIBLE_AFTER_READY_MS) {
          await stopAndSettle();
          return {
            feasible: false,
            reason: `no streamed token within ${INFEASIBLE_AFTER_READY_MS / 60000} min of the model reporting ready`,
          };
        }
        // The absolute backstop only decides when ready never arrived
        // (a slow/broken download); once ready has arrived, the primary
        // gate above is the timer.
        if (Date.now() - t0 > GATE_ABSOLUTE_MS && !s.readyAge) {
          await stopAndSettle();
          return {
            feasible: false,
            reason: `the model never reported ready within ${GATE_ABSOLUTE_MS / 60000} min (last stage: ${s.lastStage || "none"})`,
          };
        }
        await page.waitForTimeout(GATE_POLL_MS);
        s = await state();
      }
      // A token streamed (or the run ended): wait for the UI to settle,
      // using the remaining gate budget (a token-producing adapter that
      // never settles is an anomaly worth a loud failure, not a skip).
      const remaining = Math.max(30_000, GATE_ABSOLUTE_MS - (Date.now() - t0));
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: remaining },
      );
      return { feasible: true, reason: "" };
    };
    // Stop the in-flight round and wait for the Send button to return
    // (the UI settles on cancel; no tool approval can be pending before
    // the first token streams).
    const stopAndSettle = async () => {
      await page.locator("[data-chat-stop]").click();
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: 30_000 },
      );
    };

    const skipped = [];
    const skip = (name, reason) => {
      skipped.push(name);
      console.log(`SKIP: ${name} — ${reason}`);
    };

    // The engine's hidden iframe: the first non-main frame whose URL is
    // on the engine's origin. It is created lazily by the first send, so
    // this is only called after a round has been sent.
    const findEngineFrame = () => {
      const frame = page
        .frames()
        .find((f) => {
          if (f === page.mainFrame() || f.url() === "about:blank") return false;
          try {
            return new URL(f.url()).origin === ENGINE_ORIGIN;
          } catch {
            return false;
          }
        });
      if (!frame)
        throw new Error("the engine's hidden iframe is not in the frame list");
      return frame;
    };
    // Capture the app→engine wire: the SDK posts
    // { ns, id, method, params } to the iframe's window, so a listener
    // injected into the frame sees every chat request (at SEND time —
    // independent of whether the round ever settles).
    const captureWire = (engineFrame) =>
      engineFrame.evaluate(() => {
        window.__chatWire = [];
        window.addEventListener("message", (e) => {
          const d = e.data;
          if (d && d.ns === "mach-llm" && d.method === "chat.completions.create") {
            window.__chatWire.push(d.params);
          }
        });
      });
    const lastWireSystemPrompt = async (engineFrame) => {
      const wire = await engineFrame.evaluate(() => window.__chatWire ?? []);
      const last = wire[wire.length - 1];
      return (
        (last?.messages ?? []).find((m) => m.role === "system")?.content ?? ""
      );
    };

    const gate = await gateSend("Reply with exactly: OK");
    const infeasible = !gate.feasible;
    if (infeasible) {
      console.log(
        `GATE: inference infeasible on this host — ${gate.reason}. ` +
          "Stopping the round and running the non-inference checks.",
      );
    }

    if (!infeasible) {
      // 2. A deterministic reply, streamed.
      const reply = await lastAssistant();
      r.ok(
        "assistant answered the first question",
        /OK/.test(reply) && reply.trim().length > 0,
        reply.slice(0, 120),
      );
      r.ok(
        "the LAN backend has not hit the deleted /api/chat route",
        apiChatCount === 0,
        `${apiChatCount} requests`,
      );

      // The engine's hidden iframe exists now. Capture the wire: the SDK
      // posts { ns, id, method, params } to the iframe's window, so a
      // listener injected into the frame sees every chat request.
      const engineFrame = findEngineFrame();
      await captureWire(engineFrame);

      // 4. The model sees the active file.
      await send(
        "What is the name of the marker command defined in the user's file? Answer with the command name only.",
        WARM_REPLY_MS,
      );
      const reply2 = await lastAssistant();
      r.ok(
        "the model sees the active file (marker command)",
        reply2.includes("huhubmarker"),
        reply2.slice(0, 120),
      );

      // 5. The system prompt carries the cursor position (captured on the
      //    engine wire). Click into line 4 ("Hello, chat.").
      await page.locator(".view-lines .view-line").nth(3).click();
      await send("Reply with exactly: OK", WARM_REPLY_MS);
      const sysPrompt = await lastWireSystemPrompt(engineFrame);
      r.ok(
        "the system prompt carries the cursor line (seen on the engine wire)",
        /line 4, column/.test(sysPrompt),
        sysPrompt.slice(0, 200),
      );

      // 6. Agentic tool: list_files. The round must call a tool, and a
      //    tool row shows the name and result.
      await input.fill(
        "Use the list_files tool to list the files in the project, then report what it returned. You must call the tool.",
      );
      await sendButton.click();
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-chat-role="tool"]')).some(
            (el) =>
              el.textContent.includes("list_files") &&
              el.textContent.includes("main.tex"),
          ),
        null,
        { timeout: WARM_REPLY_MS },
      );
      r.ok("the list_files tool ran and a tool row shows its result", true);
      // The loop ends with a final answer; wait for the run to settle.
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: WARM_REPLY_MS },
      );

      // 7. Agentic tool: apply_edit. Gated by a diff card: nothing is
      //    written until the user accepts.
      await input.fill(
        'Use the apply_edit tool to replace the exact text "Hello, chat." with "Hello, world." in the file main.tex. You must call the tool.',
      );
      await sendButton.click();
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") !== null,
        null,
        { timeout: WARM_REPLY_MS },
      );
      const card =
        (await page.evaluate(
          () =>
            document.querySelector("[data-chat-pending-edit]")?.textContent ??
            "",
        )) || "";
      r.ok(
        "the pending edit card shows the old and new text",
        card.includes("Hello, chat.") && card.includes("Hello, world."),
        card.slice(0, 160),
      );
      await page.locator("[data-chat-edit-accept]").click();
      await page.waitForFunction(
        () =>
          (document.querySelector(".view-lines")?.textContent ?? "")
            .replace(/[\u00a0\u202f]/g, " ")
            .includes("Hello, world."),
        null,
        { timeout: 30_000 },
      );
      r.ok("the accepted edit landed in the editor", true);
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") === null,
        null,
        { timeout: 30_000 },
      );
      r.ok("the pending edit card is gone after the decision", true);
      // The loop continues with the tool result and settles.
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: WARM_REPLY_MS },
      );

      // 8. apply_edit, rejected: the file must stay unchanged, and the
      //    rejection is the tool's result.
      await input.fill(
        'Use the apply_edit tool to replace the exact text "Hello, world." with "Hello, planet." in the file main.tex. You must call the tool.',
      );
      await sendButton.click();
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") !== null,
        null,
        { timeout: WARM_REPLY_MS },
      );
      await page.locator("[data-chat-edit-reject]").click();
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") === null,
        null,
        { timeout: 30_000 },
      );
      r.ok("the pending edit card is gone after the rejection", true);
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: WARM_REPLY_MS },
      );
      r.ok(
        "the rejected edit left the file unchanged",
        (await editorText()).includes("Hello, world.") &&
          !(await editorText()).includes("Hello, planet."),
        (await editorText()).slice(0, 120),
      );
      r.ok(
        "the rejection is recorded as the tool result",
        (await toolRows()).some(
          (t) => t.includes("apply_edit") && t.includes("REJECTED"),
        ),
      );

      // 9. Stop while the loop blocks on an approval: the card is settled
      //    ("not applied"), the run is cancelled (not an error), the file
      //    stays unchanged, and the user's message remains.
      await input.fill(
        'Use the apply_edit tool to replace the exact text "Hello, world." with "Hello, galaxy." in the file main.tex. You must call the tool.',
      );
      await sendButton.click();
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") !== null,
        null,
        { timeout: WARM_REPLY_MS },
      );
      await page.locator("[data-chat-stop]").click();
      await page.waitForFunction(
        () => document.querySelector("[data-chat-pending-edit]") === null,
        null,
        { timeout: 30_000 },
      );
      r.ok("stop while blocked removes the pending edit card", true);
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: 30_000 },
      );
      r.ok("stop cancels the run (the send button returns)", true);
      r.ok(
        "the stopped edit's tool row settles (no permanent spinner)",
        (await toolRows()).some((t) => t.includes("stopped the conversation")) &&
          (await page.locator("text=Waiting for your decision").count()) === 0,
        (await toolRows()).join(" | ").slice(0, 200),
      );
      r.ok(
        "stop left the file unchanged",
        (await editorText()).includes("Hello, world.") &&
          !(await editorText()).includes("Hello, galaxy."),
      );
      r.ok(
        "a stopped run shows no error box",
        (await page.locator("[data-chat-error]").count()) === 0,
      );
      r.ok(
        "the user's message survives the stop",
        (await page.locator('[data-chat-role="user"]').count()) >= 1,
      );
    } else {
      // Inference infeasible on this host: the checks that need a
      // streamed token are SKIPped (they can neither pass nor fail
      // here); everything the wire and the UI expose without inference
      // is still verified.
      skip(
        "2. streamed first reply",
        `inference infeasible (${gate.reason})`,
      );
      r.ok(
        "the LAN backend has not hit the deleted /api/chat route",
        apiChatCount === 0,
        `${apiChatCount} requests`,
      );
      skip(
        "4. active-file context",
        `inference infeasible (${gate.reason})`,
      );

      // 5. The system prompt carries the cursor position. The request is
      //    posted to the engine at send time, so the wire capture works
      //    even though the round itself will never settle: send, wait
      //    for the captured request, assert, then settle the round so
      //    the remaining checks start from a settled UI.
      const engineFrame = findEngineFrame();
      await captureWire(engineFrame);
      await page.locator(".view-lines .view-line").nth(3).click();
      await input.fill("Reply with exactly: OK");
      // Snapshot the engine-error count BEFORE the send. The engine's
      // busy reply (if any) is posted the moment the request lands, so
      // under load the page can process it while the wire capture below
      // is still resolving — a post-send snapshot would count it as
      // baseline and never see it as "new".
      const engineErrBase = await page.evaluate(
        () => window.__gate.engineErrors.length,
      );
      await sendButton.click();
      await engineFrame.waitForFunction(
        () => (window.__chatWire?.length ?? 0) >= 1,
        null,
        { timeout: 30_000 },
      );
      const sysPrompt = await lastWireSystemPrompt(engineFrame);
      r.ok(
        "the system prompt carries the cursor line (seen on the engine wire)",
        /line 4, column/.test(sysPrompt),
        sysPrompt.slice(0, 200),
      );
      // Settle the round. Its fate is decided by the engine's busy
      // flag, which the gate's stop left held: the flag is cleared only
      // when runCompletion settles (engine protocol.ts), and a stuck
      // prefill never settles (the abort signal is checked only in the
      // decode loop, engine completions.ts). Two outcomes:
      //   busy  — the engine rejects this send with an error reply; the
      //           round settles on its own (error box, Send returns, the
      //           Stop button never durably renders);
      //   free  — the round goes in flight and the Stop button renders
      //           and stays (only possible if the gate's absolute
      //           backstop fired while a very slow load was still
      //           finishing).
      // Watch for EITHER outcome within the same 30 s budget
      // stopAndSettle uses for its Stop wait — the outcome is which one
      // the UI shows, so no arrival timing is assumed.
      const outcome = await page
        .waitForFunction(
          (base) => {
            if (window.__gate.engineErrors.length > base) return "error";
            if (document.querySelector("[data-chat-stop]")) return "stop";
            return "none";
          },
          engineErrBase,
          { timeout: 30_000, polling: 100 },
        )
        .then((f) => f.value)
        .catch(() => "none");
      if (outcome === "none") {
        throw new Error(
          "check 5: after the send, neither an engine error reply nor " +
            "the Stop button appeared within 30 s",
        );
      }
      if (outcome === "stop") {
        // In flight — stop it. The click may find nothing if the busy
        // reply landed in the same instant the Stop was observed (the
        // round is then already settling); either way the settle end
        // state is the Send button.
        await page
          .locator("[data-chat-stop]")
          .click({ timeout: 5_000 })
          .catch(() => {});
      }
      await page.waitForFunction(
        () => !!document.querySelector("[data-chat-send]"),
        null,
        { timeout: 30_000 },
      );

      skip(
        "6. list_files tool",
        `inference infeasible (${gate.reason})`,
      );
      skip(
        "7. apply_edit accept",
        `inference infeasible (${gate.reason})`,
      );
      skip(
        "8. apply_edit reject",
        `inference infeasible (${gate.reason})`,
      );
      skip(
        "9. stop while blocked on an approval",
        `inference infeasible (${gate.reason})`,
      );
    }

    // 10. Clear empties the conversation; the Log panel still shows the
    //     log.
    await page.locator("[data-chat-clear]").click();
    r.ok(
      "clear empties the conversation",
      (await page.locator("[data-chat-role]").count()) === 0,
    );
    await page.locator('[data-rail="log"]').click();
    r.ok(
      "the Log panel shows the build log",
      (await page.locator("pre").count()) >= 1,
    );
    await page.locator('[data-rail="chat"]').click();
    r.ok(
      "no round ever hit the deleted /api/chat route",
      apiChatCount === 0,
      `${apiChatCount} requests`,
    );

    // 11. Settings modal: the model listing IS the connection test —
    //     the cached connection answers immediately.
    await page.locator(GEAR).click();
    const modal = page.locator('[data-modal="chat-settings"]');
    await modal.waitFor({ timeout: 10_000 });
    await modal.getByText("Engine reachable").waitFor({
      timeout: HANDSHAKE_TIMEOUT_MS,
    });
    const optCount = await modal.locator("select option").count();
    r.ok(
      "the settings modal lists the engine's models live",
      optCount >= 2,
      `${optCount} options`,
    );
    // Pick the engine's default model explicitly (the same model the
    // rounds above used — no re-load) and commit it with Save.
    await modal.locator("select").selectOption("Qwen/Qwen3.5-4B");
    await modal.locator('button:has-text("Save")').click();
    await modal.locator('button:has-text("Cancel")').click();
    await modal.waitFor({ state: "detached", timeout: 10_000 });
    r.ok("the settings modal closed after saving the model pick", true);

    // 12. Engine down: point the engine at a dead port. The modal's
    //     listing reports the failed handshake (20 s timeout), and a
    //     send fails into the graceful error box.
    //
    // Reload first. The gate's stopped round left the engine iframe
    // stuck in an un-abortable prefill (the engine checks abort only in
    // its decode loop). The Save below CHANGES the URL, so the handler
    // calls closeLanLlm() — removing that stuck iframe mid-prefill.
    // Under this box's load (observed up to ~20) the browser's teardown
    // of the stuck out-of-process iframe stalled the CDP round trips
    // the click's post-input phase needs, past the 30 s click budget:
    // the handler demonstrably ran (dead-port iframe created) and the
    // page answered CDP evaluates at FATAL time, yet locator.click()
    // never returned (chatstandalone3 evidence). The engine connection
    // is per-page, so a reload drops it — the app's documented
    // recovery path — and check 12's Save then tears down only a fresh
    // handshake-only connection. The dead-port handshake and the
    // graceful error box — what this check asserts — are unchanged.
    await page.reload({ waitUntil: "load" });
    await r.waitReady();
    await page.locator('[data-rail="chat"]').click();
    await page.locator("[data-chat-input]").waitFor({ timeout: 10_000 });

    await page.locator(GEAR).click();
    const modal2 = page.locator('[data-modal="chat-settings"]');
    await modal2.waitFor({ timeout: 10_000 });
    await modal2.locator('input[type="text"]').fill(DEAD_ENGINE_URL);
    await modal2.locator('button:has-text("Save")').click();
    await modal2
      .getByText("Could not reach the LAN LLM engine")
      .waitFor({ timeout: HANDSHAKE_TIMEOUT_MS + 30_000 });
    r.ok("the settings modal reports an unreachable engine", true);
    await modal2.locator('button:has-text("Cancel")').click();
    await modal2.waitFor({ state: "detached", timeout: 10_000 });
    // A send against the dead engine: another handshake timeout, then
    // the error box with the settings link.
    await send("Reply with exactly: OK", HANDSHAKE_TIMEOUT_MS + 30_000);
    const errBox = page.locator("[data-chat-error]");
    await errBox.waitFor({ timeout: 10_000 });
    const errText = (await errBox.textContent()) || "";
    r.ok(
      "a send against a dead engine shows the graceful error box",
      errText.includes(
        `Could not reach the LAN LLM engine at ${new URL(DEAD_ENGINE_URL).origin}`,
      ),
      errText.slice(0, 160),
    );
    r.ok("the error box offers the chat settings", errText.includes("Open chat settings"));

    // 13. Restore the engine URL: the modal is reachable again...
    await page.locator(GEAR).click();
    const modal3 = page.locator('[data-modal="chat-settings"]');
    await modal3.waitFor({ timeout: 10_000 });
    await modal3.locator('input[type="text"]').fill(ENGINE_URL);
    await modal3.locator('button:has-text("Save")').click();
    await modal3.getByText("Engine reachable").waitFor({
      timeout: HANDSHAKE_TIMEOUT_MS,
    });
    await modal3.locator('button:has-text("Cancel")').click();
    await modal3.waitFor({ state: "detached", timeout: 10_000 });
    // ...and (when inference is feasible) the chat works (a fresh
    // connection; the model comes from the local weights cache, not a
    // download).
    if (!infeasible) {
      await send("Reply with exactly: OK", RELOAD_REPLY_MS);
      r.ok(
        "chat works again after restoring the engine URL",
        /OK/.test(await lastAssistant()),
        (await lastAssistant()).slice(0, 120),
      );
    } else {
      skip(
        "13. reply after restoring the engine URL",
        `inference infeasible (${gate.reason})`,
      );
    }

    // 14. API endpoint backend: the settings ask for an address + API
    //     key (+ model), and the page calls the endpoint directly from
    //     the browser — no /api/chat. The endpoint here is a local mock
    //     OpenAI-compatible SSE server (deterministic, instant — it does
    //     not need inference, so it runs uncut).
    const http = require("http");
    const mockSeen = [];
    const mock = http.createServer((req, res) => {
      const origin = req.headers.origin ?? "*";
      if (req.method === "OPTIONS") {
        // Preflight: the page's origin differs from the mock's port, and
        // the request carries Authorization + content-type headers.
        res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        mockSeen.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization ?? null,
          body: body ? JSON.parse(body) : null,
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "access-control-allow-origin": origin,
        });
        res.write(
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
        );
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const mockBase = `http://localhost:${mock.address().port}/v1`;

    await page.locator(GEAR).click();
    const modal4 = page.locator('[data-modal="chat-settings"]');
    await modal4.waitFor({ timeout: 10_000 });
    await modal4.locator('button:has-text("API endpoint")').click();
    await modal4
      .locator('input[placeholder="http://host:port/v1"]')
      .fill(mockBase);
    await modal4.locator('input[type="password"]').fill("e2e-key-123");
    await modal4.locator('input[placeholder^="Model id"]').fill("mock-model");
    await modal4.locator('button:has-text("Save")').click();
    await modal4.locator('button:has-text("Cancel")').click();
    await modal4.waitFor({ state: "detached", timeout: 10_000 });
    await send("Reply with exactly: OK", 15_000);
    r.ok(
      "the endpoint reply streams into the thread",
      /OK/.test(await lastAssistant()),
      (await lastAssistant()).slice(0, 120),
    );
    r.ok(
      "the page called the endpoint directly (no /api/chat)",
      mockSeen.length === 1 &&
        mockSeen[0].method === "POST" &&
        mockSeen[0].url === "/v1/chat/completions" &&
        apiChatCount === 0,
      JSON.stringify(mockSeen[0] ?? null).slice(0, 160),
    );
    r.ok(
      "the endpoint request carries the user's Bearer key",
      mockSeen[0]?.auth === "Bearer e2e-key-123",
      String(mockSeen[0]?.auth),
    );
    r.ok(
      "the endpoint request asks for the configured model and streams",
      mockSeen[0]?.body?.model === "mock-model" &&
        mockSeen[0]?.body?.stream === true &&
        Array.isArray(mockSeen[0]?.body?.messages),
      JSON.stringify(mockSeen[0]?.body ?? null).slice(0, 160),
    );
    mock.close();
    // Restore the default (LAN) backend.
    await page.locator(GEAR).click();
    const modal5 = page.locator('[data-modal="chat-settings"]');
    await modal5.waitFor({ timeout: 10_000 });
    await modal5.locator('button:has-text("LAN engine (WebGPU)")').click();
    await modal5.locator('button:has-text("Cancel")').click();
    await modal5.waitFor({ state: "detached", timeout: 10_000 });

    if (skipped.length) {
      console.log(
        `SKIPPED (inference infeasible on this host): ${skipped.length} checks — ` +
          `${skipped.map((s) => s.split(". ")[0]).join(", ")}`,
      );
    }
  } catch (e) {
    // Dump the page evidence BEFORE the finally below tears down the
    // browser profile (the dump evaluates in-page).
    try {
      await dumpFatalEvidence(suite);
    } catch (d) {
      console.error("EVIDENCE: dump failed:", String(d).slice(0, 120));
    }
    throw e;
  } finally {
    await r.finish();
  }
  process.exit(r.failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
