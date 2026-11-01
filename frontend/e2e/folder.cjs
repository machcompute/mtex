// Test: recursive folder upload. Drops a synthetic folder (paper/doc.tex,
// paper/figs/logo.png) onto the file panel, checks the panel, sets
// doc.tex as main, recompiles, and verifies the nested \includegraphics
// path resolves.
const fs = require("fs");
const { Runner, PNG_PATH } = require("./helpers.cjs");

// 1x1 transparent PNG — a real, valid file (hand-typed bytes once produced
// a truncated IEND CRC that libpng rejects).
const PNG = fs.readFileSync(PNG_PATH);

const DOC = [
  "\\documentclass{article}",
  "\\usepackage{graphicx}",
  "\\begin{document}",
  "Folder doc with nested image.",
  "\\includegraphics[width=2cm]{figs/logo.png}",
  "\\end{document}",
].join("\n");

const r = new Runner("folder");

(async () => {
  await r.start();
  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
  );

  // Drop a synthetic folder onto the file panel.
  await r.page.evaluate(
    ({ doc, png }) => {
      const mk = (rel, content, type, isBin) => {
        const f = new File(
          isBin ? [new Uint8Array(content)] : [content],
          rel.split("/").pop(),
          { type },
        );
        Object.defineProperty(f, "webkitRelativePath", { value: rel });
        return f;
      };
      const dt = new DataTransfer();
      dt.items.add(mk("paper/doc.tex", doc, "text/x-tex", false));
      dt.items.add(mk("paper/figs/logo.png", png, "image/png", true));
      const ev = new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector("aside").dispatchEvent(ev);
    },
    { doc: DOC, png: Array.from(PNG) },
  );

  await r.page.waitForTimeout(600);
  const notice =
    ((await r.page
      .locator("p, div")
      .filter({ hasText: /^Uploaded/ })
      .first()
      .textContent()
      .catch(() => "")) || "");
  r.ok("upload notice", /Uploaded 2 files/.test(notice), notice);

  // Panel: doc.tex at root, figs/logo.png nested (indented).
  const docRow = r.page.locator("li", { hasText: "doc.tex" }).first();
  const pngRow = r.page.locator("li", { hasText: "logo.png" }).first();
  r.ok("doc.tex listed", (await docRow.count()) > 0);
  r.ok("figs/logo.png listed with nested path", (await pngRow.count()) > 0);
  const pngPadding = await pngRow
    .locator("div")
    .first()
    .evaluate((el) => el.style.paddingLeft);
  r.ok("nested row indented", pngPadding === "18px", pngPadding);
  const pngKind = await pngRow
    .locator("[data-kind]")
    .first()
    .getAttribute("data-kind");
  r.ok("png row has image icon", pngKind === "image", pngKind);

  // doc.tex was opened (first text file).
  r.ok(
    "doc.tex tab opened",
    (await r.page.evaluate(
      () => document.querySelector("[data-active]")?.getAttribute("data-tab"),
    )) === "doc.tex",
  );

  // Set doc.tex as main.
  await r.page
    .locator("li", { hasText: "doc.tex" })
    .locator('button[title="Set as main file"]')
    .first()
    .click();
  await r.page.waitForTimeout(300);
  r.ok(
    "main badge moved to doc.tex",
    /main/.test((await docRow.textContent()) || ""),
  );

  // Recompile — the nested \includegraphics{figs/logo.png} must resolve.
  const status = await r.recompile();
  r.ok("compile with folder files succeeded", /Compiled in \d+ ms/.test(status), status);

  // pdf.js paints the canvas a beat after the status flips — poll instead
  // of taking a single snapshot.
  let canvasCount = 0;
  for (let i = 0; i < 12; i++) {
    canvasCount = await r.page
      .locator('div:has(> [data-pdf-viewer])')
      .last()
      .locator("canvas")
      .count();
    if (canvasCount > 0) break;
    await r.page.waitForTimeout(500);
  }
  r.ok("PDF rendered", canvasCount > 0, `${canvasCount} canvas(es)`);
  const pdfText = await r.pdfText();
  r.ok("folder doc text in PDF", /Folder doc with nested image/.test(pdfText));

  // Log: no missing-file error for the nested image.
  const log = await r.logText();
  r.ok(
    "nested image found (no missing-file error)",
    !/logo\.png.*not found|not found.*logo\.png/i.test(log),
  );

  // Binary preview for the image.
  await pngRow.click();
  await r.page.waitForTimeout(400);
  const hasCanvasPreview = await r.page.evaluate(
    () =>
      !!document.querySelector('[data-active][data-tab="figs/logo.png"]') &&
      !!document.querySelector("img, canvas"),
  );
  r.ok("image tab opens a binary preview", hasCanvasPreview);

  // Persisted with nested keys.
  const stored = await r.page.evaluate(
    () => JSON.parse(localStorage.getItem("homehub-latex-project-v1") || "{}"),
  );
  r.ok(
    "nested path persisted in localStorage",
    stored.files?.["figs/logo.png"] !== undefined &&
      stored.files?.["doc.tex"] !== undefined,
  );

  // A folder dragged from the OS must not create a junk row. Two shapes:
  //  1. a REAL directory drag (CDP, Chromium) — the browser delivers one
  //     unreadable File whose name matches a directory entry;
  //  2. a synthetic 0-byte, typeless file WITH a dot in its name — the
  //     no-entries heuristic must still import it (a folder only looks
  //     like a nameless empty file, never like "empty.txt").
  const DRAG_DIR = "/tmp/opencode/dragfix/thesis";
  if (fs.existsSync(DRAG_DIR)) {
    const asideBox = await r.page.locator("aside").boundingBox();
    await r.osDrag(DRAG_DIR, asideBox.x + 60, asideBox.y + 200);
    await r.page.waitForTimeout(1500);
    r.ok(
      "dropped OS folder creates no junk row",
      (await r.page.locator("li", { hasText: "thesis" }).count()) === 0,
    );
    const folderNotice =
      ((await r.page
        .locator("p, div")
        .filter({ hasText: /can't be read by the browser/ })
        .first()
        .textContent()
        .catch(() => "")) || "");
    r.ok("notice explains the dropped folder", folderNotice.length > 0, folderNotice);
  }

  await r.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(0)], "empty.txt", { type: "" }));
    document
      .querySelector("aside")
      .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await r.page.waitForTimeout(800);
  r.ok(
    "0-byte file with a dot still imports",
    (await r.page.locator("li", { hasText: "empty.txt" }).count()) > 0,
  );

  console.log(
    r.failures === 0 ? "ALL FOLDER CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
