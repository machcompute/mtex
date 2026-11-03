// Project management: first-run defaults, create/switch/delete from the
// Projects menu, rename persistence across reloads, delete-to-empty, and
// the menu's outside-click close. No compiles — the engine is never needed.
const { Runner, readProject } = require("./helpers.cjs");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Every confirm() the app raises, in order — the delete flow relies on
// them and an unexpected one means a click hit the wrong button. The
// policy flips to "accept" around the deliberate delete clicks.
const dialogs = [];
let dialogPolicy = "dismiss";
const waitDialog = async (before) => {
  for (let i = 0; i < 60 && dialogs.length <= before; i++) await sleep(250);
  return dialogs[before] ?? "";
};

const NAME_INPUT = 'input[title="Project name (saved in your browser)"]';
const nameInput = (r) => r.page.locator(NAME_INPUT);
const projectsBtn = (r) => r.page.locator('button[data-action="projects"]');
const menuRows = (r) => r.page.locator('[data-menu="projects"] div[data-project]');
const nameValue = (r) =>
  r.page.evaluate(
    (sel) => document.querySelector(sel)?.value ?? "",
    NAME_INPUT,
  );
const openMenu = async (r) => {
  await projectsBtn(r).click();
  await r.page.waitForSelector('[data-menu="projects"] div[data-project]', {
    timeout: 10000,
  });
};
// Rows render in updatedAt order (not creation order), so always pick by
// exact name — "LaTeX project" must not match "LaTeX project 2".
const rowByName = (r, name) =>
  r.page
    .locator('[data-menu="projects"] div[data-project]', {
      has: r.page.locator("span.truncate", {
        hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      }),
    })
    .first();
// Click the row's open button and wait for the name input to reach `name`
// — applyProject flips it in one commit, so this means the operation landed.
const openRow = async (r, name) => {
  const t0 = Date.now();
  await rowByName(r, name).locator("button").first().click();
  console.error(`openRow(${JSON.stringify(name)}): click resolved t+${Date.now() - t0}ms`);
  // Timeline: log every change of the name input for up to 30 s. The
  // switch chain is normally <1 s; the long window absorbs the engine's
  // main-thread wasm init, which can starve it on a loaded machine.
  let last = "";
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    const v = await r.page.evaluate(
      (sel) => document.querySelector(sel)?.value ?? "",
      NAME_INPUT,
    );
    if (v !== last) {
      console.error(`openRow: t+${Date.now() - t0}ms input=${JSON.stringify(v)}`);
      last = v;
    }
    if (v === name) return;
  }
  const diag = await r.page.evaluate(() => ({
    input:
      document.querySelector(
        'input[title="Project name (saved in your browser)"]',
      )?.value ?? "(no input)",
    rows: Array.from(
      document.querySelectorAll('[data-menu="projects"] div[data-project]'),
    ).map((d) => ({
      name: d.querySelector("span.truncate")?.textContent,
      active: d.hasAttribute("data-active"),
    })),
    notice: document.body.innerText.match(/Couldn[^\n]*|Storage[^\n]*/g) ?? [],
  }));
  console.error("openRow DIAG:", JSON.stringify(diag), "dialogs:", JSON.stringify(dialogs));
  throw new Error(`openRow(${JSON.stringify(name)}): name never reached ${JSON.stringify(name)}`);
};
// The active project's files, straight from OPFS.
const activeFiles = async (r) => {
  const p = await readProject(r);
  return p ? p.files : {};
};
// Project 1's main.tex editor content; polls because the Monaco model
// attaches a beat after the state commit.
const mainValue = async (r) => {
  for (let i = 0; i < 10; i++) {
    const v = await r.page.evaluate(
      () =>
        window.monaco.editor
          .getModels()
          .find((m) => m.uri.path.endsWith("main.tex"))?.getValue() ?? "",
    );
    if (v !== "") return v;
    await sleep(300);
  }
  return "";
};

(async () => {
  const r = new Runner("projects");
  await r.start();
  r.page.on("dialog", (d) => {
    dialogs.push(d.message());
    if (dialogPolicy === "accept") d.accept();
    else d.dismiss();
  });
  await r.goto();
  await r.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  await r.page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });

  // --- first run: the default project IS the starting point ---------------
  r.ok(
    "first run: default project name",
    (await nameValue(r)) === "LaTeX project",
    await nameValue(r),
  );
  r.ok(
    "first run: default files listed",
    (await r.page.locator("li", { hasText: "main.tex" }).count()) > 0 &&
      (await r.page.locator("li", { hasText: "refs.bib" }).count()) > 0,
  );
  await openMenu(r);
  r.ok("first run: one project row", (await menuRows(r).count()) === 1);
  r.ok(
    "first run: the row is active",
    (await menuRows(r).first().getAttribute("data-active")) !== null,
  );

  // --- create two more projects via the menu ------------------------------
  await r.page.locator("button", { hasText: "New project" }).click();
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "LaTeX project 2",
    NAME_INPUT,
    { timeout: 15000 },
  );
  r.ok("create: numbered name", (await nameValue(r)) === "LaTeX project 2");
  r.ok(
    "create: menu closed",
    (await r.page.locator('[data-menu="projects"] div[data-project]').count()) === 0,
  );
  await openMenu(r);
  await r.page.locator("button", { hasText: "New project" }).click();
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "LaTeX project 3",
    NAME_INPUT,
    { timeout: 15000 },
  );
  await openMenu(r);
  r.ok("create: three rows now", (await menuRows(r).count()) === 3);

  // --- switch isolation: each project keeps its own files -----------------
  // Back to project 1.
  await openRow(r, "LaTeX project");
  // A marker edit in project 1.
  await r.page.evaluate(
    () =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith("main.tex"))
        .setValue("P1MARK"),
  );
  await sleep(1500); // let the debounced save land
  await openMenu(r);
  await openRow(r, "LaTeX project 3");
  r.ok(
    "switch: new project shows its own content",
    !(await mainValue(r)).includes("P1MARK"),
    (await mainValue(r)).slice(0, 60),
  );
  r.ok(
    "switch: default content intact in project 3",
    (await mainValue(r)).includes("full TeX Live"),
  );
  // Back to project 1 — the marker survived the round trip.
  await openMenu(r);
  await openRow(r, "LaTeX project");
  r.ok(
    "switch back: the marker survived",
    (await mainValue(r)) === "P1MARK",
    await mainValue(r),
  );
  const savedF = await activeFiles(r);
  r.ok(
    "switch: marker persisted to OPFS",
    savedF["main.tex"] === "P1MARK",
    JSON.stringify(String(savedF["main.tex"]).slice(0, 40)),
  );

  // --- rename persists across reload --------------------------------------
  await nameInput(r).fill("Renamed proj");
  await sleep(1500);
  await r.page.reload({ waitUntil: "load" });
  await r.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "Renamed proj",
    NAME_INPUT,
    { timeout: 15000 },
  );
  r.ok("rename: restored after reload", (await nameValue(r)) === "Renamed proj");
  const savedMeta = await r.page.evaluate(async () => {
    const id = localStorage.getItem("homehub-active-project-v1");
    if (!id) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("projects")).getDirectoryHandle(id);
    return JSON.parse(await (await (await dir.getFileHandle("project.json")).getFile()).text());
  });
  r.ok("rename: meta.name persisted", savedMeta?.name === "Renamed proj", savedMeta?.name);

  // --- delete a NON-active project (confirm dialog) ------------------------
  await openMenu(r);
  let dialogMsg = "";
  {
    const before = dialogs.length;
    dialogPolicy = "accept";
    await rowByName(r, "LaTeX project 3").hover();
    await rowByName(r, "LaTeX project 3").locator('button[title="Delete project"]').click();
    dialogMsg = await waitDialog(before);
    dialogPolicy = "dismiss";
  }
  r.ok(
    "delete: confirm dialog names the project",
    dialogMsg.includes("LaTeX project 3"),
    dialogMsg,
  );
  await openMenu(r);
  r.ok("delete: row gone, two left", (await menuRows(r).count()) === 2);

  // --- delete the ACTIVE project: the editor falls back to a remaining one -
  {
    const before = dialogs.length;
    dialogPolicy = "accept";
    await rowByName(r, "Renamed proj").hover();
    await rowByName(r, "Renamed proj").locator('button[title="Delete project"]').click();
    dialogMsg = await waitDialog(before);
    dialogPolicy = "dismiss";
  }
  r.ok(
    "delete active: confirm dialog names the project",
    dialogMsg.includes("Renamed proj"),
    dialogMsg,
  );
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "LaTeX project 2",
    NAME_INPUT,
    { timeout: 15000 },
  );
  r.ok(
    "delete active: a remaining project loads",
    (await nameValue(r)) === "LaTeX project 2",
  );

  // --- delete down to empty: a fresh default project appears ---------------
  {
    const before = dialogs.length;
    dialogPolicy = "accept";
    await openMenu(r);
    await rowByName(r, "LaTeX project 2").hover();
    await rowByName(r, "LaTeX project 2").locator('button[title="Delete project"]').click();
    dialogMsg = await waitDialog(before);
    dialogPolicy = "dismiss";
  }
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "LaTeX project",
    NAME_INPUT,
    { timeout: 15000 },
  );
  await openMenu(r);
  r.ok("delete-to-empty: one fresh default row", (await menuRows(r).count()) === 1);
  const freshF = await activeFiles(r);
  r.ok(
    "delete-to-empty: default files restored",
    typeof freshF["main.tex"] === "string" &&
      freshF["main.tex"].includes("full TeX Live") &&
      freshF["refs.bib"] !== undefined,
  );

  // --- outside click closes the menu ---------------------------------------
  await nameInput(r).click();
  await sleep(300);
  r.ok(
    "menu: outside click closes it",
    (await r.page.locator('[data-menu="projects"] div[data-project]').count()) === 0,
  );

  console.log(
    r.failures === 0 ? "ALL PROJECTS CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
