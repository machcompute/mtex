// Regression suite for the bug-fix set (Chromium). Each section guards one
// fixed behavior; the scenarios mirror the manual verification runs.
// Prereq: both servers up (see README.md).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Runner, seedProject, readProject } = require("./helpers.cjs");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- shared helpers ---------------------------------------------------------
const notice = (r) =>
  r.page.evaluate(
    () =>
      // data-notice, not the position classes: the header tooltip pills
      // share pointer-events-none/absolute and come first in DOM order.
      document.querySelector("[data-notice]")?.textContent || "",
  );
const activeTab = (r) =>
  r.page.evaluate(
    () => document.querySelector("[data-tab][data-active]")?.dataset.tab ?? "",
  );
const rows = (r) =>
  r.page.evaluate(() =>
    [...document.querySelectorAll("aside li div.group")]
      .map((d) =>
        d.querySelector('span[title*="double-click"]')?.textContent,
      )
      .filter(Boolean),
  );
const setModelValue = (r, txt) =>
  r.page.evaluate(
    (t) => window.monaco.editor.getModels()[0].setValue(t),
    txt,
  );

// Seed a project into OPFS on the app's origin (about:blank is opaque).
// waitReady() gives a >=2 s window, so the app's 600 ms initial persist
// has already fired and no timer is pending — the caller's next goto()
// then loads the seed instead of letting the debounce clobber it.
async function seed(r, p) {
  await r.goto();
  await r.waitReady();
  await seedProject(r, p);
}

// =====================================================================
(async () => {
  // --- 1. File operations (no compile needed) --------------------------
  const r1 = new Runner("fixes-files");
  await r1.start();
  await seed(r1, {
    name: "t",
    mainPath: "main.tex",
    openPaths: ["main.tex", "b.tex"],
    activePath: "b.tex",
    files: { "main.tex": "AAA\n", "b.tex": "BBB\n" },
  });
  await r1.goto();
  // The header renders BEFORE the load effect's OPFS read commits (the
  // previous project shows until applyProject lands), so a header selector
  // is no proof the seed is up. Wait for the restored tab itself — the
  // previous project has no b.tex tab, so this can only be the seed.
  await r1.page.waitForFunction(
    () =>
      document.querySelector("[data-tab][data-active]")?.dataset.tab === "b.tex",
    null,
    { timeout: 15000 },
  );

  // #21 active tab restored on load.
  r1.ok(
    "#21 active tab restored on load",
    (await activeTab(r1)) === "b.tex",
    await activeTab(r1),
  );

  // #1 rename-back: the Monaco model is keyed by path; renaming back must
  // not resurrect the pre-rename model (which silently discards edits).
  await r1.page.locator("[data-tab]", { hasText: "main.tex" }).first().click();
  await sleep(300);
  await r1.page.locator(".monaco-editor .view-lines").first().click();
  await r1.page.keyboard.press("Control+End");
  await r1.page.keyboard.type("ED");
  const renamed = r1.page.locator(
    // :not([title]) — the files header's project-name input also matches
    // "aside input" (inscribe.io layout), but it carries a title attr.
    "aside input:not([type=file]):not([title])",
  );
  await r1.page
    .locator("li", { hasText: "main.tex" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await sleep(150);
  await renamed.fill("m2.tex");
  await renamed.press("Enter");
  await sleep(300);
  await r1.page
    .locator("li", { hasText: "m2.tex" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await sleep(150);
  await renamed.fill("main.tex");
  await renamed.press("Enter");
  await sleep(300);
  const v = await r1.page.evaluate(
    () => window.monaco.editor.getEditors()[0]?.getModel()?.getValue() ?? "",
  );
  r1.ok(
    "#1 rename-back keeps the edit (no stale model)",
    (await activeTab(r1)) === "main.tex" && v.includes("AAA") && v.includes("ED"),
    JSON.stringify(v.slice(0, 40)),
  );

  // #22/#18/#13 name validation notices (new-file modal).
  const newFile = async (name) => {
    // The seeded doc is bare text, so the builds above failed by design and
    // the Log panel is auto-open (it unmounts the file tree, where the
    // new-file button lives). Restore the Files panel first.
    if ((await r1.page.locator('[data-rail="log"][data-active]').count()) > 0) {
      await r1.page.locator('[data-rail="files"]').click();
      await sleep(200);
    }
    await r1.page.locator('button[data-action="new-file"]').click();
    await r1.page.waitForSelector('[data-modal="new-file"]', { timeout: 5000 });
    const input = r1.page.locator('input[placeholder="chapter.tex"]');
    await input.fill(name);
    await input.press("Enter");
    await sleep(300);
  };
  // The seeded main.tex is bare text, not LaTeX: the open-time auto-compile
  // and the debounced rebuild of the #1 edit above both FAIL, and a failed
  // build opens the Log panel by design. Settle any in-flight build; the
  // newFile helper below restores the Files panel so the checks isolate
  // the validation notice (before auto-compile-on-open this passed by luck:
  // the FIRST compile in a session is slow enough to still be running at
  // check time).
  await r1.waitReady();

  await newFile("b.tex");
  r1.ok(
    "#22 duplicate new file shows a notice",
    /already exists/.test(await notice(r1)),
    await notice(r1),
  );
  // The left panel starts on the Files tab; a validation notice must not
  // switch it to the Log panel (only compile errors do).
  r1.ok(
    "#22 log panel stays closed for a validation error",
    (await r1.page.locator('[data-rail="log"][data-active]').count()) === 0,
  );
  // A rejected create keeps the modal open — Escape, then a legal name.
  await r1.page.keyboard.press("Escape");
  await newFile("v1..2.tex");
  r1.ok(
    "#18 v1..2.tex is accepted",
    (await rows(r1)).includes("v1..2.tex"),
    JSON.stringify(await rows(r1)),
  );
  await newFile("constructor");
  r1.ok(
    "#22 reserved name refused with a notice",
    /Cannot create/.test(await notice(r1)),
    await notice(r1),
  );
  await r1.page.keyboard.press("Escape");
  await r1.page
    .locator("li", { hasText: "v1..2.tex" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await sleep(150);
  await renamed.fill("main.tex/x.tex");
  await renamed.press("Enter");
  await sleep(300);
  r1.ok(
    "#13 rename under an existing file refused",
    /collide/.test(await notice(r1)),
    await notice(r1),
  );

  // #14c deleting the only .tex leaves no build target (and a .bib never
  // becomes the main file).
  await seed(r1, {
    name: "t",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    files: {
      "main.tex": "AAA2\n",
      "refs.bib": "@article{k1, author={Doe}, title={T}, journal={J}, year={2020}}\n",
    },
  });
  await r1.goto();
  // Same load race as #21: the page renders the DEFAULT project until the
  // seed's OPFS read commits (its file set is identical — main.tex +
  // refs.bib — so the panel can't disambiguate). A delete in that window
  // hits the old state, and the "Recompile" below then starts a real
  // xetex build instead of the no-main error. The seed's main.tex content
  // is the one thing only the seed produces: wait for it in the model.
  await r1.page.waitForFunction(
    () =>
      window.monaco?.editor.getModels()[0]?.getValue() === "AAA2\n",
    null,
    { timeout: 15000 },
  );
  await r1.page
    .locator("li", { hasText: "main.tex" })
    .locator('button[title="Delete file"]')
    .first()
    .click();
  await sleep(300);
  await r1.page.locator('button[title^="Recompile"]').first().click();
  await sleep(1500);
  const st14c = ((await r1.status.textContent().catch(() => "")) || "").trim();
  r1.ok(
    "#14c deleting the only .tex leaves no build target",
    /No main .tex file/.test(st14c),
    st14c,
  );
  await r1.finish();

  // --- 2. Compile correctness (one engine) ------------------------------
  const r2 = new Runner("fixes-compile");
  await r2.start();
  const doc = (extra) =>
    `\\documentclass{article}\n\\begin{document}\nSTART${extra}.\n\\end{document}\n`;
  await seed(r2, {
    name: "t", mainPath: "main.tex", openPaths: ["main.tex"],
    files: { "main.tex": doc("") },
  });
  await r2.goto();
  await r2.waitReady();

  // #7 an edit that lands mid-compile must end up in the PDF (auto
  // recompile is ON by default; the queued rebuild picks up the new text).
  // Wait until MARK7 is actually in the PDF — the status first returns to
  // "Compiled in" after the FIRST build, while the queued one may still
  // be running.
  const quickText = () =>
    r2.page.evaluate(() => {
      const v = document.querySelector("[data-pdf-viewer]");
      return v
        ? Array.from(v.querySelectorAll("span[data-baseline]"))
            .map((s) => s.textContent)
            .join(" ")
        : "";
    });
  await setModelValue(r2, doc(" AAA"));
  await sleep(1500); // 1.2 s debounce fired; the build is in flight
  await setModelValue(r2, doc(" AAA MARK7"));
  let st = "";
  let txt = "";
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    st = ((await r2.status.textContent().catch(() => "")) || "").trim();
    if (/Compiled in/.test(st)) {
      txt = await quickText();
      if (txt.includes("MARK7")) break;
    }
  }
  r2.ok("#7 a final compile happened", /Compiled in/.test(st), st);
  r2.ok(
    "#7 the mid-compile edit is in the PDF",
    txt.includes("MARK7"),
    txt.slice(0, 120),
  );

  // #20 turning auto recompile off cancels the pending 1.2 s timer.
  await setModelValue(r2, doc(" AAA MARK7 MARK20"));
  await sleep(300); // timer pending
  await r2.page.locator('button[title^="Auto recompile"]').first().click();
  let fired = false;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    const t = ((await r2.status.textContent().catch(() => "")) || "").trim();
    if (/preparing|Loading engine/i.test(t)) fired = true;
  }
  r2.ok(
    "#20 no compile fires after turning auto recompile off",
    !fired && !(await r2.pdfText()).includes("MARK20"),
    `statusFired=${fired}`,
  );

  // #8 \bibliography in an \include'd file still triggers bibtex8.
  await seed(r2, {
    name: "t", mainPath: "main.tex", openPaths: ["main.tex"],
    files: {
      "main.tex":
        "\\documentclass{article}\n\\begin{document}\n\\include{back}\n\\end{document}\n",
      "back.tex":
        "Cited: \\cite{k1}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n",
      "refs.bib":
        "@article{k1, author={Doe, J.}, title={A Title}, journal={J}, year={2020}}\n",
    },
  });
  await r2.goto();
  await r2.waitReady();
  const st8 = await r2.recompile();
  r2.ok("#8 \\include+\\bibliography compiled", /Compiled in/.test(st8), st8);
  r2.ok(
    "#8 citation resolved",
    (await r2.pdfText()).includes("Doe"),
    (await r2.pdfText()).slice(0, 200),
  );

  // #9 a missing database is a bibtex8 error: the build fails and the log
  // carries the bibtex8 section (logcat format: "$ bibtex8 …" + "EXITCODE:
  // n" + per-command LOG:/STDOUT:/STDERR: blocks). refs.bib stays in the
  // project — it opens the pipeline's bibtex gate.
  await seed(r2, {
    name: "t", mainPath: "main.tex", openPaths: ["main.tex"],
    files: {
      "main.tex":
        "\\documentclass{article}\n\\begin{document}\n\\include{back}\n\\end{document}\n",
      "back.tex":
        "Cited: \\cite{k1}.\n\\bibliographystyle{plain}\n\\bibliography{nope}\n",
      "refs.bib":
        "@article{k1, author={Doe, J.}, title={A Title}, journal={J}, year={2020}}\n",
    },
  });
  await r2.goto();
  await r2.waitReady();
  const st9 = await r2.recompile();
  r2.ok("#9 broken bib fails the build", /failed/i.test(st9), st9);
  const log9 = await r2.logText();
  r2.ok(
    "#9 log includes the bibtex8 section",
    /\$ bibtex8/.test(log9),
    log9.slice(-200),
  );
  r2.ok(
    "#9 the missing-database error is in the log",
    /couldn't open database file/i.test(log9),
    log9.slice(-200),
  );

  // #14a jobname: a.text.tex (and MAIN.TEX) compile — TeX strips only the
  // final .tex, case-insensitively.
  await seed(r2, {
    name: "t", mainPath: "a.text.tex", openPaths: ["a.text.tex"],
    files: {
      "a.text.tex":
        "\\documentclass{article}\n\\begin{document}\nJOBMARKA.\n\\end{document}\n",
    },
  });
  await r2.goto();
  await r2.waitReady();
  const st14a = await r2.recompile();
  r2.ok("#14a a.text.tex compiles", /Compiled in/.test(st14a), st14a);
  r2.ok(
    "#14a a.text.tex content in PDF",
    (await r2.pdfText()).includes("JOBMARKA"),
  );
  await r2.finish();

  // --- 3. Synctex navigation (one engine) --------------------------------
  const r3 = new Runner("fixes-sync");
  await r3.start();
  await seed(r3, {
    name: "t", mainPath: "main.tex", openPaths: ["main.tex"],
    files: {
      // Blank lines = \par: each mark on its own PDF line / text span.
      "main.tex":
        "\\documentclass{article}\n\\begin{document}\nMain line.\n\n\\input{a/inner}\n\\input{inner}\n\\end{document}\n",
      "a/inner.tex": "NESTEDMARK paragraph.\n\n",
      "inner.tex": "FLATMARK paragraph.\n\n",
    },
  });
  await r3.goto();
  await r3.waitReady();
  const stS = await r3.recompile();
  r3.ok("synctex doc compiled", /Compiled in/.test(stS), stS);

  async function clickSpan(text) {
    // The text layer renders a beat after the canvas (widely so under
    // load), so poll for the span INSTEAD of a one-shot lookup — a missed
    // lookup fails the check even though the PDF is perfectly good. The
    // span must also be inside the viewport, or the mouse click would land
    // somewhere else entirely.
    const box = await r3.page
      .waitForFunction(
        (t) => {
          const s = [...document.querySelectorAll(
            "[data-pdf-viewer] span[data-baseline]",
          )].find((e) => e.textContent.includes(t));
          if (!s) return null;
          const b = s.getBoundingClientRect();
          if (b.y < 0 || b.y > window.innerHeight) return null;
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        },
        text,
        { timeout: 15000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (!box) return false;
    await r3.page.mouse.click(box.x, box.y);
    await sleep(700);
    return true;
  }

  // #6 nested synctex paths + #16 a PDF click into an UNOPENED file opens
  // it as a tab.
  r3.ok("NESTEDMARK span clicked", await clickSpan("NESTEDMARK"));
  r3.ok(
    "#6 nested synctex click opens a/inner.tex",
    (await activeTab(r3)) === "a/inner.tex",
    await activeTab(r3),
  );
  r3.ok(
    "#16 unopened file shows its own content",
    (await r3.page.evaluate(
      () => window.monaco.editor.getEditors()[0]?.getModel()?.getValue() ?? "",
    )).includes("NESTEDMARK"),
  );
  r3.ok("FLATMARK span clicked", await clickSpan("FLATMARK"));
  r3.ok(
    "#6 flat synctex click opens inner.tex",
    (await activeTab(r3)) === "inner.tex",
    await activeTab(r3),
  );

  // #17 a recompile must not reset the PDF scroll position.
  const body = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}.`).join("\n");
  await seed(r3, {
    name: "t", mainPath: "main.tex", openPaths: ["main.tex"],
    files: {
      "main.tex": `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`,
    },
  });
  await r3.goto();
  await r3.waitReady();
  const st17a = await r3.recompile();
  r3.ok("long doc compiled", /Compiled in/.test(st17a), st17a);
  let pages = 0;
  for (let i = 0; i < 40 && pages < 3; i++) {
    await sleep(500);
    pages = await r3.page.evaluate(
      () => document.querySelectorAll("[data-pdf-viewer] [data-page]").length,
    );
  }
  r3.ok("long doc has 3+ pages", pages >= 3, pages);
  if (pages >= 3) {
    await r3.page.evaluate(() => {
      const c = document.querySelector("[data-pdf-viewer]");
      const w = c.querySelector('[data-page="2"]');
      c.scrollTop = w.offsetTop + w.offsetHeight / 2;
    });
    await sleep(800);
    const st17b = await r3.recompile();
    r3.ok("#17 recompile after scrolling", /Compiled in/.test(st17b), st17b);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      top = await r3.page.evaluate(() => {
        const c = document.querySelector("[data-pdf-viewer]");
        const ws = [...c.querySelectorAll("[data-page]")];
        if (!ws.length) return 0;
        const S = c.scrollTop;
        let val = 0;
        for (const w of ws)
          if (w.offsetTop + w.offsetHeight > S) {
            val = Number(w.dataset.page);
            break;
          }
        return val;
      });
      if (top >= 2) break;
    }
    r3.ok(
      "#17 scroll restored on page 2 after recompile",
      top === 2,
      top,
    );
  }
  await r3.finish();

  // --- 4. Drops (Chromium CDP, no engine needed) -------------------------
  const r4 = new Runner("fixes-drops");
  await r4.start();
  const dragDir = fs.mkdtempSync(path.join(os.tmpdir(), "homehub-drag-"));
  fs.writeFileSync(
    path.join(dragDir, "b.tex"),
    "\\documentclass{article}\n\\begin{document}\nDragged.\n\\end{document}\n",
  );
  fs.mkdirSync(path.join(dragDir, "thesis", "ch"), { recursive: true });
  fs.writeFileSync(path.join(dragDir, "thesis", "a.tex"), "A\n");
  await r4.goto();
  await r4.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  await r4.page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });

  const center = await r4.page.evaluate(() => {
    const el = document.querySelector(".monaco-editor");
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  // #23 a plain file dropped on the EDITOR PANE (outside the Files panel)
  // is imported, and the page must not navigate away to open the file.
  await r4.osDrag(path.join(dragDir, "b.tex"), center.x, center.y);
  await sleep(1500);
  r4.ok(
    "#23 plain file dropped on editor pane is imported",
    /Uploaded 1 file/.test(await notice(r4)),
    await notice(r4),
  );
  r4.ok("b.tex listed", (await rows(r4)).includes("b.tex"));
  r4.ok(
    "#23 the page did not navigate away",
    r4.page.url().startsWith("http://localhost:3000/editor"),
    r4.page.url(),
  );
  // #10 a real OS folder dropped on the editor pane is imported (top folder
  // stripped) and creates no junk row.
  await r4.osDrag(path.join(dragDir, "thesis"), center.x, center.y);
  await sleep(1500);
  r4.ok(
    "#10 real folder drop imports its contents",
    (await rows(r4)).includes("a.tex"),
    JSON.stringify(await rows(r4)),
  );
  r4.ok(
    "#10 no junk folder row",
    !(await rows(r4)).includes("thesis"),
    JSON.stringify(await rows(r4)),
  );
  // #12 an existing file is never overwritten by a drop.
  await r4.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["SHOULD NOT WIN"], "b.tex", { type: "text/plain" }));
    document.body.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await sleep(1500);
  const saved12 = await readProject(r4);
  const storedB = saved12 ? saved12.files["b.tex"] : null;
  r4.ok(
    "#12 an existing file is never overwritten by a drop",
    typeof storedB === "string" && storedB.includes("Dragged."),
    JSON.stringify(String(storedB).slice(0, 80)),
  );
  // #15 non-UTF-8 bytes in a text file are stored as raw binary, not
  // U+FFFD-replaced text.
  await r4.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array([0xff, 0xfe, 0x41])], "x.txt", { type: "text/plain" }),
    );
    document.body.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await sleep(1500);
  const saved15 = await readProject(r4);
  const v15 = saved15 ? saved15.files["x.txt"] : null;
  const xinfo =
    typeof v15 === "object" && v15 !== null
      ? { kind: "binary", bytes: v15.bytes }
      : { kind: typeof v15 };
  r4.ok(
    "#15 non-UTF-8 bytes stored as raw binary",
    xinfo.kind === "binary" && xinfo.bytes.join(",") === "255,254,65",
    JSON.stringify(xinfo),
  );
  fs.rmSync(dragDir, { recursive: true, force: true });
  await r4.finish();

  // --- 5. Storage ----------------------------------------------------------
  // #24 a saved project with no .tex file keeps main EMPTY on load —
  // compiling must explain it, not treat the first file (.bib) as main.
  const r5c = new Runner("fixes-no-main");
  await r5c.start();
  await seed(r5c, {
    name: "nomain",
    mainPath: "",
    openPaths: ["refs.bib"],
    activePath: "refs.bib",
    files: { "refs.bib": "@article{a}" },
  });
  await r5c.goto();
  await r5c.waitReady();
  r5c.ok(
    "#24 no main badge when the project has no .tex",
    (await r5c.page.locator('aside span:text-is("main")').count()) === 0,
  );
  const st24 = await r5c.recompile();
  r5c.ok(
    "#24 compile says there is no main file",
    /No main .tex file/.test(st24),
    st24,
  );
  await r5c.finish();

  // #11 storage failure is reported: nothing is persisted, and the user
  // must be told (notice pill at the bottom of the page). Rejecting
  // navigator.storage.getDirectory kills every OPFS path the app has.
  const r5b = new Runner("fixes-quota");
  await r5b.start();
  await r5b.page.addInitScript(() => {
    navigator.storage.getDirectory = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await r5b.goto();
  await r5b.page.waitForSelector('button[data-action="new-file"]', {
    timeout: 30000,
  });
  // NOTE: the local is `seen`, not `notice` — the IIFE must not shadow the
  // notice() helper (TDZ crash for every earlier section).
  let seen = "";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    seen = await r5b.page.evaluate(
      () => (/Storage unavailable/.test(document.body.innerText) ? "shown" : ""),
    );
    if (seen) break;
  }
  r5b.ok("#11 storage failure shows a notice", seen === "shown", seen);
  await r5b.finish();

  // --- 6. Engine failure + recovery (#2/#3) --------------------------------
  const r6 = new Runner("fixes-engine");
  await r6.start();
  // Block the 72 MB texlive data asset: the worker must report the failure
  // (no hang), dispose itself, and the NEXT compile must recreate the
  // worker and succeed. The failure surfaces as "Engine failed to load"
  // (error arrives outside a compile) or "Compilation failed" (it arrives
  // while the first compile is in flight) — both mean the promise settled
  // and the worker was disposed, which is what the fix guarantees.
  // Trailing *: asset URLs carry a ?v=<release> stamp
  // (src/lib/texlive-release.ts) and the glob must match the full URL.
  await r6.page.route(
    "**/api/texlive/texlive-basic.data*",
    (route) => route.abort(),
  );
  await r6.goto();
  await r6.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  // Nothing compiles on load — trigger the first build manually.
  await r6.page.locator('button[title^="Recompile"]').first().click();
  let eng = "";
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    eng = ((await r6.status.textContent().catch(() => "")) || "").trim();
    if (/Engine failed|Compilation failed/i.test(eng)) break;
  }
  r6.ok(
    "#3 a failed engine load is reported (no hang)",
    /Engine failed to load|Compilation failed/i.test(eng),
    eng,
  );
  await r6.page.unroute("**/api/texlive/texlive-basic.data*");
  const stR = await r6.recompile();
  r6.ok(
    "#2/#3 the next compile recreates the worker and succeeds",
    /Compiled in/.test(stR),
    stR,
  );
  await r6.finish();

  // Every Runner's failures count — a check can FAIL yet the suite exit
  // 0 if its runner is missing from this list.
  const failures = [r1, r2, r3, r4, r5b, r5c, r6].reduce(
    (n, x) => n + (x.failures || 0),
    0,
  );
  console.log(
    failures === 0
      ? "ALL FIXES CHECKS PASSED"
      : failures + " FIXES CHECK(S) FAILED",
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
