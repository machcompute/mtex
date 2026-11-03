// Test: recursive folder upload. Drops a synthetic folder (paper/doc.tex,
// paper/figs/logo.png) onto the file panel, checks the panel, sets
// doc.tex as main, recompiles, and verifies the nested \includegraphics
// path resolves.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Runner, PNG_PATH, readProject } = require("./helpers.cjs");

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

  // Persisted with nested keys (the debounced save has long fired — the
  // recompile above took seconds).
  const storedF = await readProject(r);
  r.ok(
    "nested paths persisted in OPFS",
    storedF !== null &&
      storedF.files?.["figs/logo.png"] !== undefined &&
      storedF.files?.["doc.tex"] !== undefined,
  );

  // A REAL directory drag (CDP, Chromium) is walked recursively. The tree is
  // bigger than Chromium's 100-entry readEntries batch, so a walker that
  // stops after the first batch loses files.
  const dragRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homehub-folder-"));
  const THESIS = path.join(dragRoot, "thesis");
  fs.mkdirSync(path.join(THESIS, "ch", "deep"), { recursive: true });
  fs.mkdirSync(path.join(THESIS, "many"));
  fs.mkdirSync(path.join(THESIS, ".git"));
  fs.mkdirSync(path.join(dragRoot, "empty"));
  fs.mkdirSync(path.join(dragRoot, "other"));
  fs.mkdirSync(path.join(dragRoot, "second"));
  fs.writeFileSync(path.join(THESIS, "thesis.tex"), DOC);
  fs.writeFileSync(path.join(THESIS, "ch", "deep", "one.tex"), "Deep.\n");
  fs.writeFileSync(path.join(THESIS, ".git", "HEAD"), "ref\n");
  fs.writeFileSync(path.join(THESIS, "LICENSE"), "");
  fs.writeFileSync(path.join(THESIS, "fig.png"), PNG);
  for (let i = 0; i < 150; i++) {
    fs.writeFileSync(path.join(THESIS, "many", `f${i}.tex`), `${i}\n`);
  }
  fs.writeFileSync(path.join(dragRoot, "other", "same.tex"), "Other.\n");
  fs.writeFileSync(path.join(dragRoot, "second", "same.tex"), "Second.\n");

  const paths = async () => {
    const p = await readProject(r);
    return p ? Object.keys(p.files) : [];
  };
  const asideBox = await r.page.locator("aside").boundingBox();
  const dropAt = [asideBox.x + 60, asideBox.y + 200];

  await r.osDrag(THESIS, ...dropAt);
  await r.page.waitForTimeout(2000);
  const tree = await paths();
  r.ok("dropped folder: top file at the root", tree.includes("thesis.tex"));
  r.ok("dropped folder: no top folder kept", !tree.some((p) => p.startsWith("thesis/")));
  r.ok("dropped folder: nested path kept", tree.includes("ch/deep/one.tex"));
  r.ok(
    "dropped folder: past the 100-entry batch",
    tree.filter((p) => p.startsWith("many/")).length === 150,
  );
  r.ok("dropped folder: empty extensionless file kept", tree.includes("LICENSE"));
  r.ok("dropped folder: dot directory skipped", !tree.some((p) => p.startsWith(".git")));
  const savedF = await readProject(r);
  const fig = savedF ? savedF.files["fig.png"] : undefined;
  r.ok(
    "dropped folder: binary kept byte-for-byte",
    !!fig &&
      Array.isArray(fig.bytes) &&
      fig.bytes.join(",") === Array.from(PNG).join(","),
    JSON.stringify(fig)?.slice(0, 60),
  );
  r.ok(
    "drop highlight cleared",
    (await r.page.getByText("Drop files or a folder to add them").count()) === 0,
  );

  // Dropped together, folders keep their names so their files can't collide.
  await r.osDrag(
    [path.join(dragRoot, "other"), path.join(dragRoot, "second")],
    ...dropAt,
  );
  await r.page.waitForTimeout(1500);
  const both = await paths();
  r.ok("two folders keep their names (1)", both.includes("other/same.tex"));
  r.ok("two folders keep their names (2)", both.includes("second/same.tex"));

  await r.osDrag(path.join(dragRoot, "empty"), ...dropAt);
  await r.page.waitForTimeout(1000);
  r.ok(
    "empty folder explains itself",
    (await r.page.getByText("the folder is empty").count()) === 1,
  );
  r.ok(
    "empty folder creates no row",
    (await r.page.locator("li", { hasText: "empty" }).count()) === 0,
  );
  fs.rmSync(dragRoot, { recursive: true, force: true });

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

  // A file created in a COLLAPSED folder must not vanish: its ancestors
  // auto-expand so the user can see where it landed.
  // "other" (a file row inside it has title="other"; the folder row is
  // told apart by its icon).
  const otherFolderRow = r.page.locator(
    'aside li div.group[title="other"]:has(span[data-kind="folder"])',
  );
  const otherFileRows = r.page.locator(
    'aside li div.group[title="other"]:not(:has(span[data-kind="folder"]))',
  );
  await otherFolderRow.click();
  await r.page.waitForTimeout(200);
  r.ok(
    "collapse hides the folder's files",
    (await otherFolderRow.count()) === 1 &&
      (await otherFileRows.count()) === 0,
  );
  await r.page.locator('button[data-action="new-file"]').click();
  await r.page.waitForSelector('[data-modal="new-file"]', { timeout: 5000 });
  await r.page.locator('input[placeholder="chapter.tex"]').fill("newone.tex");
  await r.page.locator('input[placeholder*="project root"]').fill("other");
  await r.page.keyboard.press("Enter");
  await r.page.waitForTimeout(400);
  r.ok(
    "new file in a collapsed folder auto-expands it",
    (await r.page.locator('li:has-text("newone.tex")').count()) === 1,
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
