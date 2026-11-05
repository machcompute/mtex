// OPFS layout + migration: settings and thumbnails live in artifacts/<id>/,
// keyed like the content folders in projects/<id>/ — not inside them. Seeds
// a project in the OLD layout (project.json + preview.png inside the content
// folder), then verifies the app migrates both on first access, that the
// migration is idempotent, that the migrated project still works (card with
// thumbnail, editor load), and that fresh projects get the new layout.
const fs = require("fs");
const { Runner, APP_URL, ACTIVE_KEY, PNG_PATH } = require("./helpers.cjs");

const HOME_URL = APP_URL.replace(/\/editor\/*$/, "/");
const NAME_INPUT = 'input[title="Project name (saved in your browser)"]';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
const titleValue = (r) =>
  r.page.evaluate(
    (sel) => document.querySelector(sel)?.value ?? "",
    NAME_INPUT,
  );

// Existence of the layout paths we care about, for the active project.
const layout = (r) =>
  r.page.evaluate(async (key) => {
    const id = localStorage.getItem(key);
    if (!id) return null;
    const root = await navigator.storage.getDirectory();
    const has = async (a, b, c) => {
      try {
        let d = root;
        if (a) d = await d.getDirectoryHandle(a);
        if (b) d = await d.getDirectoryHandle(b);
        if (c) await d.getFileHandle(c);
        return true;
      } catch {
        return false;
      }
    };
    return {
      content: await has("projects", id, "main.tex"),
      oldMeta: await has("projects", id, "project.json"),
      oldPreview: await has("projects", id, "preview.png"),
      newMeta: await has("artifacts", id, "project.json"),
      newPreview: await has("artifacts", id, "preview.png"),
    };
  }, ACTIVE_KEY);

(async () => {
  const r = new Runner("artifacts");
  await r.start();
  r.page.on("dialog", (d) => d.dismiss());

  // --- seed a project in the OLD layout (meta + preview in the content dir) -
  await r.goto();
  r.ok("setup: editor ready", await r.waitReady());
  const png = Array.from(fs.readFileSync(PNG_PATH));
  const id = await r.page.evaluate(() => crypto.randomUUID());
  await r.page.evaluate(
    ({ key, id, png }) =>
      (async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await (
          await root.getDirectoryHandle("projects", { create: true })
        ).getDirectoryHandle(id, { create: true });
        const write = async (name, data) => {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(data);
          await w.close();
        };
        await write(
          "main.tex",
          "\\documentclass{article}\n\\begin{document}\nMIGRATED\n\\end{document}\n",
        );
        await write(
          "project.json",
          JSON.stringify({
            v: 1,
            name: "Migrated doc",
            mainPath: "main.tex",
            openPaths: ["main.tex"],
            activePath: "main.tex",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        );
        await write("preview.png", new Uint8Array(png));
        localStorage.setItem(key, id);
      })(),
    { key: ACTIVE_KEY, id, png },
  );
  let L = await layout(r);
  r.ok(
    "seed: old layout in place (no artifacts/)",
    L?.content && L?.oldMeta && L?.oldPreview && !L?.newMeta && !L?.newPreview,
    JSON.stringify(L),
  );

  // --- first access (the dashboard) migrates both artifacts -----------------
  await r.page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 });
  await r.page.waitForSelector('button[title="Open Migrated doc"]', { timeout: 30000 });
  r.ok("dashboard: migrated project listed", true);
  // loadPreview moved the old in-project thumbnail across to show it.
  r.ok(
    "dashboard: migrated thumbnail shown",
    (await cardHasPreview(r, "Migrated doc")) === "preview",
    await cardHasPreview(r, "Migrated doc"),
  );
  L = await layout(r);
  r.ok(
    "migrate: meta + preview now in artifacts/<id>/",
    L?.newMeta && L?.newPreview,
    JSON.stringify(L),
  );
  r.ok(
    "migrate: old in-project copies removed",
    !L?.oldMeta && !L?.oldPreview,
    JSON.stringify(L),
  );
  r.ok("migrate: content untouched", L?.content === true, JSON.stringify(L));

  // --- the migration is idempotent: a second visit changes nothing ----------
  await r.page.goto(HOME_URL, { waitUntil: "load" });
  await r.page.waitForSelector('button[title="Open Migrated doc"]', { timeout: 30000 });
  L = await layout(r);
  r.ok(
    "migrate: idempotent on re-visit",
    L?.newMeta && L?.newPreview && !L?.oldMeta && !L?.oldPreview,
    JSON.stringify(L),
  );

  // --- the migrated project opens and loads in the editor -------------------
  await r.page.locator('button[title="Open Migrated doc"]').click();
  let opened = false;
  for (let i = 0; i < 90 && !opened; i++) {
    opened = (await titleValue(r)) === "Migrated doc";
    if (!opened) await sleep(200);
  }
  r.ok("editor: migrated project opens", opened, await titleValue(r));
  r.ok(
    "editor: content file listed",
    (await r.page.locator("li", { hasText: "main.tex" }).count()) >= 1,
  );

  // --- fresh projects get the new layout from day one -----------------------
  await r.page.goto(HOME_URL, { waitUntil: "load" });
  await r.page.waitForSelector('button[title^="Open "]', { timeout: 30000 });
  await r.page.locator("button", { hasText: "New project" }).click();
  await r.page.waitForSelector(NAME_INPUT, { timeout: 30000 });
  const fresh = await r.page.evaluate(async (key) => {
    const id = localStorage.getItem(key);
    if (!id) return null;
    const root = await navigator.storage.getDirectory();
    const has = async (a, b, c) => {
      try {
        let d = root;
        if (a) d = await d.getDirectoryHandle(a);
        if (b) d = await d.getDirectoryHandle(b);
        if (c) await d.getFileHandle(c);
        return true;
      } catch {
        return false;
      }
    };
    return {
      newMeta: await has("artifacts", id, "project.json"),
      oldMeta: await has("projects", id, "project.json"),
    };
  }, ACTIVE_KEY);
  r.ok(
    "new: meta written to artifacts/<id>/",
    fresh?.newMeta === true,
    JSON.stringify(fresh),
  );
  r.ok(
    "new: no meta in the content folder",
    fresh?.oldMeta === false,
    JSON.stringify(fresh),
  );

  console.log(
    r.failures === 0 ? "ALL ARTIFACTS CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
