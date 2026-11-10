// The bottom-zone chat against the LAN WebGPU engine — the default
// backend. The page talks to the engine through a hidden iframe
// (postMessage, no HTTP on the chat path), so this suite observes the
// wire by injecting a message listener into the engine's frame. The
// Router backend (/api/chat, server-side key) is checked only for its
// unconfigured-503 handling: it is unconfigured by design in this
// environment (no .env.local).
// Checks:
//   1. The chat pane opens from the icon rail; the rail carries
//      Files/Chat/Log with Chat active.
//   2. A deterministic question gets a streamed assistant reply (the
//      first round cold-loads the model into WebGPU — minutes, by
//      design, in a fresh profile).
//   3. The LAN backend never hits /api/chat (asserted after every LAN
//      round; only the final router round may).
//   4. The model sees the active file (context question about a marker
//      command only the seeded document defines).
//   5. The system prompt carries the cursor position — read off the
//      engine wire.
//   6. Agentic tool: list_files — a tool row shows the name and result.
//   7. Agentic tool: apply_edit — accepting the diff card lands the
//      edit in the editor.
//   8. Agentic tool: apply_edit — rejecting leaves the file unchanged.
//   9. Stop while the loop blocks on an approval: the card is settled,
//      the tool row settles with the "not applied" result (no permanent
//      spinner), the run cancels (no error box), the file is unchanged,
//      and the user's message stays in the thread.
//  10. Clear empties the conversation; the Log panel still shows the log.
//  11. Settings modal: the engine's models are listed live, and the
//      model picker commits with Save.
//  12. Engine down (dead port): the modal reports the failed handshake
//      and a send fails into the graceful error box with a settings link.
//  13. Restoring the engine URL: chat works again.
//  14. Router backend (unconfigured by design): the 503 surfaces
//      gracefully, and the /api/chat request carries no Authorization
//      header (the key is server-side only).
const { Runner, seedProject } = require("./helpers.cjs");

const ENGINE_URL =
  process.env.CHAT_ENGINE_URL || "http://localhost:3001";
const DEAD_ENGINE_URL = "http://localhost:3999";
const ENGINE_ORIGIN = new URL(ENGINE_URL).origin;

// Deterministic caps, each justified by a named lower bound — no
// retries, no guessing (measured on the software WebGPU adapter,
// logs /tmp/opencode/chat-timing.out + chat-timing2.out):
// - The 2.67 GB pinned GGUF downloads at ~9 MB/s in this environment
//   (~5 min; ~10 min if the CDN runs at half speed).
// - A full COLD round (download + quantize + pipeline build + prefill
//   + first decode) did NOT settle in probe v1's 25 min cap → 25 min
//   is a lower bound, and the non-download part alone is >20 min.
// COLD: first round of a fresh profile — 2.4x the 25 min lower bound.
const COLD_REPLY_MS = 3_600_000; // 60 min
// WARM: the model is loaded; an agentic round is 2 model calls and the
// software-GPU prefill is the dominant cost (worst case named: 10 min
// per call) → 20 min per round.
const WARM_REPLY_MS = 1_200_000; // 20 min
// RELOAD: a fresh engine connection (after the dead-port detour) — the
// non-download path, lower bound 20 min → 2x.
const RELOAD_REPLY_MS = 2_400_000; // 40 min
// The engine handshake gives up after 20 s (lan-llm CONNECT_TIMEOUT_MS).
const HANDSHAKE_TIMEOUT_MS = 60_000;

const GEAR = 'button[title="Chat settings (backend, engine URL, model)"]';

(async () => {
  const r = new Runner("chat");
  const page = await r.start();
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

    // The Router is the only chat path that may hit /api/chat; the LAN
    // backend talks to the engine over postMessage. The request headers
    // are captured so the router round can prove the key never leaves
    // the server.
    let apiChatCount = 0;
    let apiChatAuth = null;
    page.on("request", (req) => {
      if (req.url().includes("/api/chat")) {
        apiChatCount++;
        apiChatAuth = req.headers()["authorization"] ?? null;
      }
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

    // 2. A deterministic reply, streamed. The first round cold-loads the
    //    model: give it room.
    await send("Reply with exactly: OK", COLD_REPLY_MS);
    const reply = await lastAssistant();
    r.ok(
      "assistant answered the first question",
      /OK/.test(reply) && reply.trim().length > 0,
      reply.slice(0, 120),
    );
    r.ok(
      "the LAN backend has not hit /api/chat",
      apiChatCount === 0,
      `${apiChatCount} requests`,
    );

    // The engine's hidden iframe exists now. Capture the wire: the SDK
    // posts { ns, id, method, params } to the iframe's window, so a
    // listener injected into the frame sees every chat request.
    const engineFrame = page
      .frames()
      .find((f) => {
        if (f === page.mainFrame() || f.url() === "about:blank") return false;
        try {
          return new URL(f.url()).origin === ENGINE_ORIGIN;
        } catch {
          return false;
        }
      });
    if (!engineFrame)
      throw new Error("the engine's hidden iframe is not in the frame list");
    await engineFrame.evaluate(() => {
      window.__chatWire = [];
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (d && d.ns === "mach-llm" && d.method === "chat.completions.create") {
          window.__chatWire.push(d.params);
        }
      });
    });

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
    const wire = await engineFrame.evaluate(() => window.__chatWire);
    const lastWire = wire[wire.length - 1];
    const sysPrompt =
      (lastWire?.messages ?? []).find((m) => m.role === "system")?.content ??
      "";
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
      "no LAN round ever hit /api/chat",
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

    // 13. Restore the engine URL: the modal is reachable again and the
    //     chat works (a fresh connection; the model comes from the
    //     local weights cache, not a download).
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
    await send("Reply with exactly: OK", RELOAD_REPLY_MS);
    r.ok(
      "chat works again after restoring the engine URL",
      /OK/.test(await lastAssistant()),
      (await lastAssistant()).slice(0, 120),
    );

    // 14. Router backend: unconfigured by design here, so the 503
    //     surfaces as a graceful error box. The toggle applies
    //     immediately; only this round may hit /api/chat.
    await page.locator(GEAR).click();
    const modal4 = page.locator('[data-modal="chat-settings"]');
    await modal4.waitFor({ timeout: 10_000 });
    await modal4.locator('button:has-text("Router (/api/chat)")').click();
    await modal4.locator('button:has-text("Cancel")').click();
    await modal4.waitFor({ state: "detached", timeout: 10_000 });
    await send("Reply with exactly: OK", 30_000);
    const routerErr = (await page.locator("[data-chat-error]").textContent()) || "";
    r.ok(
      "an unconfigured router shows a graceful error (503)",
      routerErr.includes("chat backend not configured"),
      routerErr.slice(0, 160),
    );
    r.ok("the router round hit /api/chat", apiChatCount === 1, `${apiChatCount} requests`);
    r.ok(
      "the /api/chat request carries no Authorization header",
      apiChatAuth === null,
      `got: ${apiChatAuth}`,
    );
    // Restore the default (LAN) backend.
    await page.locator(GEAR).click();
    const modal5 = page.locator('[data-modal="chat-settings"]');
    await modal5.waitFor({ timeout: 10_000 });
    await modal5.locator('button:has-text("LAN engine (WebGPU)")').click();
    await modal5.locator('button:has-text("Cancel")').click();
    await modal5.waitFor({ state: "detached", timeout: 10_000 });
  } finally {
    await r.finish();
  }
  process.exit(r.failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
