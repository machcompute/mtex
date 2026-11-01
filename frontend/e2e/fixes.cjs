// Regression suite for the bug-fix set (Chromium). Each section guards one
// fixed behavior; the scenarios mirror the manual verification runs.
// Prereq: both servers up (see README.md).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Runner } = require("./helpers.cjs");

const KEY = "homehub-latex-project-v1";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- shared helpers ---------------------------------------------------------
const notice = (r) =>
  r.page.evaluate(
    () =>
      document.querySelector(".pointer-events-none.absolute")?.textContent ||
      "",
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
const savedRaw = (r) => r.page.evaluate((k) => localStorage.getItem(k), KEY);
const setModelValue = (r, txt) =>
  r.page.evaluate(
    (t) => window.monaco.editor.getModels()[0].setValue(t),
    txt,
  );

// Seed a project on the app's origin (about:blank is opaque). waitReady()
// gives a >=2 s window, so the app's 600 ms initial persist (defaults) has
// already fired and no timer is pending — the caller's next goto() then
// loads the seed instead of letting the debounce clobber it.
async function seed(r, proj) {
  await r.goto();
  await r.waitReady();
  await r.page.evaluate(
    ([KEY, p]) => localStorage.setItem(KEY, JSON.stringify(p)),
    [KEY, proj],
  );
}

// =====================================================================
(async () => {
  // --- 1. File operations (no compile needed) --------------------------
  const r1 = new Runner("fixes-files");
  await r1.start();
  await seed(r1, {
    v: 1,
    projectName: "t",
    mainPath: "main.tex",
    openPaths: ["main.tex", "b.tex"],
    activePath: "b.tex",
    files: { "main.tex": "AAA\n", "b.tex": "BBB\n" },
  });
  await r1.goto();
  await r1.page.waitForSelector("#new-file-input", { timeout: 30000 });
  await r1.page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });

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
    "aside input:not([type=file]):not(#new-file-input)",
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

  // #22/#18/#13 name validation notices.
  const nf = r1.page.locator("#new-file-input");
  await nf.fill("b.tex");
  await nf.press("Enter");
  await sleep(300);
  r1.ok(
    "#22 duplicate new file shows a notice",
    /already exists/.test(await notice(r1)),
    await notice(r1),
  );
  // The "View log" toggle is always rendered; the DRAWER ({showLog && …})
  // must stay closed for a validation notice.
  r1.ok(
    "#22 log drawer stays closed for a validation error",
    (await r1.page.locator("button", { hasText: "Hide log" }).count()) === 0,
  );
  await nf.fill("v1..2.tex");
  await nf.press("Enter");
  await sleep(300);
  r1.ok(
    "#18 v1..2.tex is accepted",
    (await rows(r1)).includes("v1..2.tex"),
    JSON.stringify(await rows(r1)),
  );
  await nf.fill("constructor");
  await nf.press("Enter");
  await sleep(300);
  r1.ok(
    "#22 reserved name refused with a notice",
    /Cannot create/.test(await notice(r1)),
    await notice(r1),
  );
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
    v: 1,
    projectName: "t",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    files: {
      "main.tex": "AAA2\n",
      "refs.bib": "@article{k1, author={Doe}, title={T}, journal={J}, year={2020}}\n",
    },
  });
  await r1.goto();
  await r1.page.waitForSelector("#new-file-input", { timeout: 30000 });
  await r1.page
    .locator("li", { hasText: "main.tex" })
    .locator('button[title="Delete file"]')
    .first()
    .click();
  await sleep(300);
  await r1.page.locator("button", { hasText: "Recompile" }).first().click();
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
    v: 1, projectName: "t", mainPath: "main.tex", openPaths: ["main.tex"],
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
    v: 1, projectName: "t", mainPath: "main.tex", openPaths: ["main.tex"],
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

  // #9 a missing database is a bibtex8 error (exit 2): the build fails and
  // the log carries the bibtex8 section. refs.bib stays in the project —
  // it opens the pipeline's bibtex gate.
  await seed(r2, {
    v: 1, projectName: "t", mainPath: "main.tex", openPaths: ["main.tex"],
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
  r2.ok(
    "#9 log includes the bibtex8 section",
    (await r2.logText()).includes("--- bibtex8 ---"),
    (await r2.logText()).slice(-200),
  );

  // #14a jobname: a.text.tex (and MAIN.TEX) compile — TeX strips only the
  // final .tex, case-insensitively.
  await seed(r2, {
    v: 1, projectName: "t", mainPath: "a.text.tex", openPaths: ["a.text.tex"],
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
    v: 1, projectName: "t", mainPath: "main.tex", openPaths: ["main.tex"],
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
    const box = await r3.page.evaluate((t) => {
      const s = [...document.querySelectorAll("[data-pdf-viewer] span[data-baseline]")].find(
        (e) => e.textContent.includes(t),
      );
      if (!s) return null;
      const b = s.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, text);
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
    v: 1, projectName: "t", mainPath: "main.tex", openPaths: ["main.tex"],
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
  await r4.page.waitForSelector("#new-file-input", { timeout: 30000 });
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
  const storedB = await r4.page.evaluate(
    (k) => {
      const p = JSON.parse(localStorage.getItem(k) || "null");
      return p ? p.files["b.tex"] : null;
    },
    KEY,
  );
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
  const xinfo = await r4.page.evaluate((k) => {
    const p = JSON.parse(localStorage.getItem(k) || "null");
    const v = p ? p.files["x.txt"] : null;
    if (typeof v !== "object" || v === null) return { kind: typeof v };
    const bin = atob(v.b64);
    return { kind: "b64", bytes: [...bin].map((c) => c.charCodeAt(0)) };
  }, KEY);
  r4.ok(
    "#15 non-UTF-8 bytes stored as raw binary",
    xinfo.kind === "b64" && xinfo.bytes.join(",") === "255,254,65",
    JSON.stringify(xinfo),
  );
  fs.rmSync(dragDir, { recursive: true, force: true });
  await r4.finish();

  // --- 5. Storage ----------------------------------------------------------
  const r5 = new Runner("fixes-storage");
  await r5.start();
  // #19 a corrupt saved project is reported, and the stored bytes are left
  // untouched (the defaults must not be saved over them).
  const bad = JSON.stringify({
    v: 1,
    projectName: "precious",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    files: { "main.tex": "hello", "bad.bin": { b64: "!!!!" } },
  });
  await seed(r5, JSON.parse(bad));
  await r5.goto();
  await r5.page.waitForSelector("#new-file-input", { timeout: 30000 });
  r5.ok(
    "#19 corrupt storage shows a notice",
    /Couldn't read the saved project/.test(await notice(r5)),
    await notice(r5),
  );
  await sleep(2500);
  r5.ok(
    "#19 the stored project was NOT overwritten",
    (await savedRaw(r5)) === bad,
  );
  await r5.finish();

  // #11 a quota failure must not show "Saved".
  const r5b = new Runner("fixes-quota");
  await r5b.start();
  await r5b.page.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "homehub-latex-project-v1")
        throw new DOMException("quota", "QuotaExceededError");
      return orig.call(this, k, v);
    };
  });
  await r5b.goto();
  await r5b.page.waitForSelector("#new-file-input", { timeout: 30000 });
  let hdr = "";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    hdr = await r5b.page.evaluate(() =>
      [...document.querySelectorAll("header span")]
        .map((e) => e.textContent)
        .find((t) => /Saving…|Not saved|Saved$/.test(t)) || "",
    );
    if (/Not saved/.test(hdr)) break;
  }
  r5b.ok(
    "#11 header says Not saved when storage fails",
    /Not saved/.test(hdr),
    hdr,
  );
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
  await r6.page.route(
    "**/api/texlive/texlive-basic.data",
    (route) => route.abort(),
  );
  await r6.goto();
  await r6.page.waitForSelector("#new-file-input", { timeout: 30000 });
  // Nothing compiles on load — trigger the first build manually.
  await r6.page.locator("button", { hasText: "Recompile" }).first().click();
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
  await r6.page.unroute("**/api/texlive/texlive-basic.data");
  const stR = await r6.recompile();
  r6.ok(
    "#2/#3 the next compile recreates the worker and succeeds",
    /Compiled in/.test(stR),
    stR,
  );
  await r6.finish();

  const failures = [r1, r2, r3, r4, r5, r5b, r6].reduce(
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
