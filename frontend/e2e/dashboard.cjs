// The project dashboard (the `/` landing): it lists every project as a card
// with a square first-page preview and the title, opens a project on click,
// and creates a new one. The preview only exists after a successful compile,
// so the second half drives the editor to compile, then checks that the
// thumbnail was persisted (and excluded from the file list) and shown.
const { Runner, APP_URL, ACTIVE_KEY, seedProject } = require("./helpers.cjs");

const HOME_URL = APP_URL.replace(/\/editor\/*$/, "/");
const NAME_INPUT = 'input[title="Project name (saved in your browser)"]';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const cardBtns = (r) => r.page.locator('button[title^="Open "]');
// A card's preview div carries an inline background-image once a thumbnail
// exists; without one it renders a placeholder (no such div).
const cardHasPreview = (r, name) =>
  r.page.evaluate((n) => {
    const btn = Array.from(document.querySelectorAll('button[title^="Open "]')).find(
      (b) => b.getAttribute("title") === "Open " + n,
    );
    if (!btn) return "missing";
    const div = btn.querySelector("div[style*='background-image']");
    return div ? "preview" : "placeholder";
  }, name);
const cardCount = (r) => cardBtns(r).count();
const titleValue = (r) =>
  r.page.evaluate(
    (sel) => document.querySelector(sel)?.value ?? "",
    NAME_INPUT,
  );

// Wait for the editor's name input to reach `name` (applyProject flips it in
// one commit, so this means the open landed).
const waitName = async (r, name) => {
  for (let i = 0; i < 90; i++) {
    if ((await titleValue(r)) === name) return true;
    await sleep(200);
  }
  return false;
};

// Does `preview.png` exist in the active project's artifacts folder?
const previewOnDisk = (r) =>
  r.page.evaluate((key) =>
    (async () => {
      const id = localStorage.getItem(key);
      if (!id) return false;
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("artifacts")).getDirectoryHandle(id);
      try {
        await dir.getFileHandle("preview.png");
        return true;
      } catch {
        return false;
      }
    })(),
    ACTIVE_KEY,
  );

(async () => {
  const r = new Runner("dashboard");
  await r.start();
  r.page.on("dialog", (d) => d.dismiss());

  // --- load the (empty) dashboard, seed three projects, reload -------------
  // Each is a minimal, compilable document (a comment alone won't build), so
  // the preview-generation path actually runs for the one we compile.
  const doc = (line) =>
    `\\documentclass{article}\n\\begin{document}\n${line}\n\\end{document}\n`;
  await r.page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 });
  await r.page.waitForSelector("h1", { timeout: 30000 });
  await seedProject(r, { name: "Alpha doc", files: { "main.tex": doc("ALPHA-CONTENT") } });
  await seedProject(r, { name: "Beta doc", files: { "main.tex": doc("BETA-CONTENT") } });
  await seedProject(r, { name: "Gamma doc", files: { "main.tex": doc("GAMMA-CONTENT") } });
  await r.page.goto(HOME_URL, { waitUntil: "load" });

  // --- the dashboard lists every project -----------------------------------
  await r.page.waitForSelector('button[title^="Open "]', { timeout: 30000 });
  r.ok("dashboard: three project cards", (await cardCount(r)) === 3, String(await cardCount(r)));
  r.ok(
    "dashboard: titles shown",
    (await r.page.locator("button[title='Open Alpha doc']").count()) === 1 &&
      (await r.page.locator("button[title='Open Beta doc']").count()) === 1 &&
      (await r.page.locator("button[title='Open Gamma doc']").count()) === 1,
  );
  // Nothing has compiled yet, so every card is a placeholder.
  r.ok("dashboard: uncompiled → placeholder", (await cardHasPreview(r, "Alpha doc")) === "placeholder");
  r.ok("dashboard: uncompiled → placeholder (2)", (await cardHasPreview(r, "Beta doc")) === "placeholder");

  // --- clicking a card opens that project in the editor ---------------------
  await r.page.locator("button[title='Open Beta doc']").click();
  r.ok("open: editor opened Beta", await waitName(r, "Beta doc"), await titleValue(r));
  // preview.png is not a content file: the file browser must not list it.
  r.ok(
    "open: preview.png not in the file list",
    (await r.page.locator("li", { hasText: "preview.png" }).count()) === 0,
  );

  // --- compile Beta → the square thumbnail is persisted ---------------------
  r.ok("compile: engine ready", await r.waitReady());
  const compiled = await r.recompile();
  r.ok("compile: succeeded", /Compiled in \d+ ms/.test(compiled), compiled);
  await sleep(1500); // the preview render is fire-and-forget; give it a beat
  r.ok("preview: preview.png written to OPFS", await previewOnDisk(r));

  // --- back on the dashboard, Beta now shows its preview --------------------
  await r.page.goto(HOME_URL, { waitUntil: "load" });
  await r.page.waitForSelector('button[title^="Open "]', { timeout: 30000 });
  r.ok("dashboard: compiled → preview shown", (await cardHasPreview(r, "Beta doc")) === "preview", await cardHasPreview(r, "Beta doc"));
  r.ok("dashboard: others still placeholder", (await cardHasPreview(r, "Alpha doc")) === "placeholder");

  // --- "New project" from the dashboard creates + opens one -----------------
  await r.page.locator("button", { hasText: "New project" }).click();
  // A/B/C are custom names, so the next default name is the plain one.
  r.ok("new: opened a fresh project", await waitName(r, "LaTeX project"), await titleValue(r));
  // And it now appears as a fourth card.
  await r.page.goto(HOME_URL, { waitUntil: "load" });
  await r.page.waitForSelector('button[title^="Open "]', { timeout: 30000 });
  r.ok("new: four cards now", (await cardCount(r)) === 4, String(await cardCount(r)));

  console.log(
    r.failures === 0 ? "ALL DASHBOARD CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
