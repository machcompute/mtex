// The bottom-zone chat: the page POSTs to /api/chat, which proxies the
// LAN LLM router (server-side key, SSE stream through). Checks:
//   1. The chat drawer opens from the status bar next to "View log";
//      the drawer carries Log/Chat tabs.
//   2. A deterministic question gets a streamed assistant reply.
//   3. The model sees the active file (context question about a marker
//      command only the seeded document defines).
//   4. The API key never reaches the browser: it is absent from the DOM,
//      and the page's /api/chat request carries no Authorization header.
//   5. Clear empties the conversation, and the Log tab still shows the
//      build log.
//   6. Agentic tool: list_files — the model calls a tool and a tool row
//      shows its result.
//   7. Agentic tool: apply_edit — gated by a diff card; accepting lands
//      the edit in the editor.
//   8. The system prompt carries the cursor position of the active file.
const { Runner, seedProject } = require("./helpers.cjs");

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

    // 1. Open the chat panel from the icon rail.
    await page.locator('[data-rail="chat"]').click();
    const input = page.locator("[data-chat-input]");
    r.ok("chat panel shows the input", await input.isVisible());
    r.ok(
      "the rail carries Files/Chat/Log with Chat active",
      (await page.locator('[data-rail="files"]').count()) === 1 &&
        (await page.locator('[data-rail="log"]').count()) === 1 &&
        (await page.locator('[data-rail="chat"][data-active]').count()) === 1,
    );

    // 4a. The key is not in the DOM (it must live server-side only).
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    r.ok("API key is not in the page DOM", !dom.includes("lr-852076428"));

    // 4b. The page's /api/chat request must carry no Authorization header
    // (the route adds it upstream).
    let chatReqAuth = "unset";
    let chatReqBody = "";
    page.on("request", (req) => {
      if (req.url().includes("/api/chat")) {
        chatReqAuth = req.headers()["authorization"] ?? null;
        chatReqBody = req.postData() ?? "";
      }
    });

    // 2. A deterministic reply, streamed.
    await input.fill("Reply with exactly: OK");
    await page.locator("[data-chat-send]").click();
    // The Send button is replaced by Stop while the stream is in flight;
    // its return means the stream settled.
    await page.waitForFunction(
      () => !!document.querySelector("[data-chat-send]"),
      { timeout: 60_000 },
    );
    const lastAssistant = () =>
      page.evaluate(() => {
        const els = document.querySelectorAll('[data-chat-role="assistant"]');
        return els.length ? els[els.length - 1].textContent : "";
      });
    const reply = await lastAssistant();
    r.ok(
      "assistant answered the first question",
      /OK/.test(reply) && reply.trim().length > 0,
      reply.slice(0, 120),
    );
    r.ok(
      "the /api/chat request carries no Authorization header",
      chatReqAuth === null,
      `got: ${chatReqAuth}`,
    );

    // 3. The model sees the active file.
    await input.fill(
      "What is the name of the marker command defined in the user's file? Answer with the command name only.",
    );
    await page.locator("[data-chat-send]").click();
    await page.waitForFunction(
      () => !!document.querySelector("[data-chat-send]"),
      { timeout: 60_000 },
    );
    const reply2 = await lastAssistant();
    r.ok(
      "the model sees the active file (marker command)",
      reply2.includes("huhubmarker"),
      reply2.slice(0, 120),
    );

    // 8. The system prompt carries the cursor position. Click into line 4
    //    ("Hello, chat."), then the next /api/chat body must mention it.
    await page.locator(".view-lines .view-line").nth(3).click();
    chatReqBody = "";
    await input.fill("Reply with exactly: OK");
    await page.locator("[data-chat-send]").click();
    await page.waitForFunction(
      () => !!document.querySelector("[data-chat-send]"),
      { timeout: 60_000 },
    );
    r.ok(
      "the system prompt carries the cursor line",
      chatReqBody.includes("line 4, column"),
      chatReqBody.slice(0, 200),
    );

    // 6. Agentic tool: list_files. The /api/chat loop hands the model the
    //    tools; this turn must call one, and a tool row shows the name
    //    and result.
    await input.fill(
      "Use the list_files tool to list the files in the project, then report what it returned. You must call the tool.",
    );
    await page.locator("[data-chat-send]").click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-chat-role="tool"]')).some(
          (el) =>
            el.textContent.includes("list_files") &&
            el.textContent.includes("main.tex"),
        ),
      { timeout: 120_000 },
    );
    r.ok("the list_files tool ran and a tool row shows its result", true);
    // The loop ends with a final answer; wait for the stream to settle.
    await page.waitForFunction(
      () => !!document.querySelector("[data-chat-send]"),
      { timeout: 120_000 },
    );

    // 7. Agentic tool: apply_edit. Gated by a diff card: nothing is
    //    written until the user accepts.
    await input.fill(
      'Use the apply_edit tool to replace the exact text "Hello, chat." with "Hello, world." in the file main.tex. You must call the tool.',
    );
    await page.locator("[data-chat-send]").click();
    await page.waitForFunction(
      () => document.querySelector("[data-chat-pending-edit]") !== null,
      { timeout: 120_000 },
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
    // Monaco's text layer renders some spaces as U+00A0 (and U+202F in
    // some locales), so normalize before matching.
    await page.waitForFunction(
      () =>
        (document.querySelector(".view-lines")?.textContent ?? "")
          .replace(/[\u00a0\u202f]/g, " ")
          .includes("Hello, world."),
      { timeout: 30_000 },
    );
    r.ok("the accepted edit landed in the editor", true);
    await page.waitForFunction(
      () => document.querySelector("[data-chat-pending-edit]") === null,
      { timeout: 30_000 },
    );
    r.ok("the pending edit card is gone after the decision", true);
    // The loop continues with the tool result and settles.
    await page.waitForFunction(
      () => !!document.querySelector("[data-chat-send]"),
      { timeout: 120_000 },
    );

    // 5. Clear empties the conversation; the Log panel still shows the log.
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
  } finally {
    await r.finish();
  }
  process.exit(r.failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
