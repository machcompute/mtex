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

    // 1. Open the chat drawer from the status bar.
    await page.locator('button[title="Toggle the chat drawer"]').first().click();
    const input = page.locator("[data-chat-input]");
    r.ok("chat drawer shows the input", await input.isVisible());
    r.ok(
      "drawer carries the Log/Chat tabs",
      (await page.locator('[data-bottom-tab="log"]').count()) === 1 &&
        (await page.locator('[data-bottom-tab="chat"]').count()) === 1,
    );
    r.ok(
      "the status bar shows Hide chat while the drawer is on chat",
      (await page.locator("button", { hasText: "Hide chat" }).count()) === 1,
    );

    // 4a. The key is not in the DOM (it must live server-side only).
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    r.ok("API key is not in the page DOM", !dom.includes("lr-852076428"));

    // 4b. The page's /api/chat request must carry no Authorization header
    // (the route adds it upstream).
    let chatReqAuth = "unset";
    page.on("request", (req) => {
      if (req.url().includes("/api/chat"))
        chatReqAuth = req.headers()["authorization"] ?? null;
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

    // 5. Clear empties the conversation; the Log tab still shows the log.
    await page.locator("[data-chat-clear]").click();
    r.ok(
      "clear empties the conversation",
      (await page.locator("[data-chat-role]").count()) === 0,
    );
    await page.locator('[data-bottom-tab="log"]').click();
    r.ok(
      "the Log tab shows the build log",
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
