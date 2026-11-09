// Project management: first-run defaults, create/switch/delete from the
// dashboard (the editor's Projects menu is gone — the wordmark goes there),
// rename persistence across reloads, and delete-to-empty. The P1MARK
// marker edit trips the auto-compile (bare text, so it fails and
// auto-opens the Log panel) — ensureFilesPane restores the Files panel
// where the name input now lives.
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
const nameValue = (r) =>
  r.page.evaluate(
    (sel) => document.querySelector(sel)?.value ?? "",
    NAME_INPUT,
  );
// A failed build (the P1MARK marker is bare text, not LaTeX) auto-opens
// the Log panel, which unmounts the file tree — and with it the project
// name input (inscribe.io layout: the name lives in the files header).
// Restore the Files panel before touching files-panel UI.
const ensureFilesPane = async (r) => {
  if ((await r.page.locator('[data-rail="log"][data-active]').count()) > 0) {
    await r.page.locator('[data-rail="files"]').click();
    await sleep(200);
  }
};

// --- dashboard navigation (project create/switch/delete live there) ------
const NEW_PROJECT_BTN = 'button[title="Create a new project and open it"]';
const goDashboard = async (r) => {
  // Idempotent: when the dashboard is already up, the editor's wordmark
  // anchor can linger in the DOM (hidden) and `header a[href="/"]` would
  // match it instead of navigating.
  if (!(await r.page.locator(NEW_PROJECT_BTN).isVisible())) {
    await r.page.locator('header a[href="/"]').click();
  }
  await r.page.waitForSelector(NEW_PROJECT_BTN, { timeout: 15000 });
  // The card grid fills in asynchronously from OPFS (each card also reads
  // its preview thumbnail) — wait until it settles (cards OR the empty
  // state), not just for the header button.
  for (let i = 0; i < 60; i++) {
    const settled =
      (await r.page.locator('button[title^="Open "]').count()) > 0 ||
      (await r.page.locator("text=No projects yet").count()) > 0;
    if (settled) break;
    await sleep(250);
  }
};
const cardBy = (r, name) =>
  r.page.locator(`button[title="Open ${name}"]`);
const cardCount = (r) => r.page.locator('button[title^="Open "]');
// Click a card and wait for the editor to load that project — the name
// input flips to it in one commit, so this means the switch landed.
const openCard = async (r, name) => {
  await cardBy(r, name).click();
  await r.page.waitForFunction(
    // waitForFunction takes ONE argument — destructure, don't spread.
    ([sel, n]) => document.querySelector(sel)?.value === n,
    [NAME_INPUT, name],
    { timeout: 20000 },
  );
};
// Create through the dashboard button; it navigates straight to the editor.
const createFromDashboard = async (r, expectedName) => {
  await r.page.locator(NEW_PROJECT_BTN).click();
  await r.page.waitForFunction(
    ([sel, n]) => document.querySelector(sel)?.value === n,
    [NAME_INPUT, expectedName],
    { timeout: 20000 },
  );
};
// Delete a card: the sibling trash button (a nested button would be
// invalid HTML), confirmed through the accept-policy dialog handler.
// The OPFS delete is async — the card leaves the DOM only when it
// settles, so wait for the detach; assertions after this call must see
// the settled state.
const deleteCard = async (r, name) => {
  const before = dialogs.length;
  dialogPolicy = "accept";
  await cardBy(r, name).hover();
  await r.page.locator(`button[title="Delete ${name}"]`).click();
  const msg = await waitDialog(before);
  dialogPolicy = "dismiss";
  if (!msg)
    throw new Error(
      `deleteCard(${name}): no confirm dialog — the trash click missed`,
    );
  await cardBy(r, name).waitFor({ state: "detached", timeout: 20000 });
  return msg;
};
// Project directories straight from OPFS (the app keeps one per project).
const projectCount = async (r) =>
  r.page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle("projects");
    let n = 0;
    for await (const entry of projects.values())
      if (entry.kind === "directory") n++;
    return n;
  });
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
  r.ok(
    "first run: one project in storage",
    (await projectCount(r)) === 1,
    await projectCount(r),
  );
  await goDashboard(r);
  r.ok(
    "first run: the dashboard lists it",
    (await cardCount(r).count()) === 1 &&
      (await cardBy(r, "LaTeX project").count()) === 1,
    await cardCount(r).count(),
  );

  // --- create two more projects via the dashboard -------------------------
  await goDashboard(r);
  await createFromDashboard(r, "LaTeX project 2");
  r.ok("create: numbered name", (await nameValue(r)) === "LaTeX project 2");
  await goDashboard(r);
  await createFromDashboard(r, "LaTeX project 3");
  await goDashboard(r);
  r.ok("create: three cards now", (await cardCount(r).count()) === 3);
  r.ok(
    "create: three projects in storage",
    (await projectCount(r)) === 3,
    await projectCount(r),
  );

  // --- switch isolation: each project keeps its own files -----------------
  // Back to project 1 through its card.
  await goDashboard(r);
  await openCard(r, "LaTeX project");
  // A marker edit in project 1.
  await r.page.evaluate(
    () =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith("main.tex"))
        .setValue("P1MARK"),
  );
  await sleep(1500); // let the debounced save land
  await goDashboard(r);
  await openCard(r, "LaTeX project 3");
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
  await goDashboard(r);
  await openCard(r, "LaTeX project");
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
  await ensureFilesPane(r); // the P1MARK build failure may have opened the Log
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
    const dir = await (await root.getDirectoryHandle("artifacts")).getDirectoryHandle(id);
    return JSON.parse(await (await (await dir.getFileHandle("project.json")).getFile()).text());
  });
  r.ok("rename: meta.name persisted", savedMeta?.name === "Renamed proj", savedMeta?.name);

  // --- delete a NON-active project (dashboard trash + confirm) ------------
  await goDashboard(r);
  let dialogMsg = await deleteCard(r, "LaTeX project 3");
  r.ok(
    "delete: confirm dialog names the project",
    dialogMsg.includes("LaTeX project 3"),
    dialogMsg,
  );
  r.ok(
    "delete: card gone, two left",
    (await cardCount(r).count()) === 2 &&
      (await cardBy(r, "LaTeX project 3").count()) === 0,
    await cardCount(r).count(),
  );
  r.ok(
    "delete: two projects in storage",
    (await projectCount(r)) === 2,
    await projectCount(r),
  );

  // --- delete the ACTIVE project: the editor falls back on next open ------
  dialogMsg = await deleteCard(r, "Renamed proj");
  r.ok(
    "delete active: confirm dialog names the project",
    dialogMsg.includes("Renamed proj"),
    dialogMsg,
  );
  r.ok(
    "delete active: its card is gone",
    (await cardBy(r, "Renamed proj").count()) === 0,
  );
  // The dashboard's active-project key still points at the deleted project;
  // opening the editor directly must fall back to a remaining one. The
  // name input's SSR default is "LaTeX project" — accepting that value
  // would match the initial render before the real project applies, so
  // wait for the sole survivor's exact name.
  await r.goto();
  await r.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "LaTeX project 2",
    NAME_INPUT,
    { timeout: 20000 },
  );
  const fellBack = await nameValue(r);
  r.ok(
    "delete active: the remaining project loads",
    fellBack === "LaTeX project 2",
    fellBack,
  );

  // --- delete down to empty: a fresh default project appears ---------------
  // Deleting the active project does NOT spawn a new one — the fallback
  // picked the most recently updated REMAINING project — so exactly one
  // card is left. Delete whatever remains, however many.
  await goDashboard(r);
  while ((await cardCount(r).count()) > 0) {
    const title = await cardCount(r).first().getAttribute("title");
    await deleteCard(r, title.replace(/^Open /, ""));
  }
  r.ok(
    "delete-to-empty: the dashboard shows its empty state",
    (await cardCount(r).count()) === 0 &&
      (await r.page.locator("text=No projects yet").count()) === 1,
    await cardCount(r).count(),
  );
  r.ok(
    "delete-to-empty: storage is empty",
    (await projectCount(r)) === 0,
    await projectCount(r),
  );
  await r.goto();
  await r.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  // The ACTIVE key still points at a deleted project until the editor
  // applies the fresh default (readProject rejects meanwhile), and the
  // name input's SSR default is "LaTeX project" too — so the key itself
  // resolving in OPFS is the readiness signal.
  let fresh = null;
  for (let i = 0; i < 60; i++) {
    try {
      fresh = await readProject(r);
    } catch {
      fresh = null;
    }
    if (fresh) break;
    await sleep(500);
  }
  r.ok(
    "delete-to-empty: one fresh default",
    fresh?.meta?.name === "LaTeX project" && (await nameValue(r)) === "LaTeX project",
    fresh?.meta?.name ?? "(ACTIVE key never resolved)",
  );
  const freshF = fresh?.files ?? {};
  r.ok(
    "delete-to-empty: default files restored",
    typeof freshF["main.tex"] === "string" &&
      freshF["main.tex"].includes("full TeX Live") &&
      freshF["refs.bib"] !== undefined,
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
