// Firefox suite: the engine in a real Firefox, and folder upload via
// drag-and-drop — Firefox's only folder path (it ignores webkitdirectory,
// so the app hides the folder button there).
const fs = require("fs");
const { Runner, PNG_PATH } = require("./helpers.cjs");

const PNG = fs.readFileSync(PNG_PATH);
const DOC = [
  "\\documentclass{article}",
  "\\usepackage{graphicx}",
  "\\begin{document}",
  "Firefox folder doc.",
  "\\includegraphics[width=2cm]{figs/logo.png}",
  "\\end{document}",
].join("\n");

const r = new Runner("firefox", "firefox");

(async () => {
  await r.start();
  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready in Firefox",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
    ((await r.status.textContent().catch(() => "")) || "").trim(),
  );

  // The folder button must be disabled in Firefox (no webkitdirectory).
  const folderBtn = await r.page
    .locator('button[title="Upload a whole folder, recursively (kept in your browser)"]')
    .count();
  r.ok("folder button hidden in Firefox", folderBtn === 0);
  const ffHint =
    ((await r.page
      .locator("p")
      .filter({ hasText: /Firefox has no folder picker/ })
      .first()
      .textContent()
      .catch(() => "")) || "");
  r.ok("hint points to drag-and-drop", ffHint.length > 0, ffHint.slice(0, 80));

  // Drop a synthetic folder — the shape of a real Firefox OS-folder drop
  // (files carrying webkitRelativePath).
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

  await r.page.waitForTimeout(800);
  const notice =
    ((await r.page
      .locator("p, div")
      .filter({ hasText: /^Uploaded/ })
      .first()
      .textContent()
      .catch(() => "")) || "");
  r.ok("folder drop imported in Firefox", /Uploaded 2 files/.test(notice), notice);
  r.ok("nested row present", (await r.page.locator("li", { hasText: "logo.png" }).count()) > 0);

  // Set doc.tex as main and compile.
  await r.page
    .locator("li", { hasText: "doc.tex" })
    .locator('button[title="Set as main file"]')
    .first()
    .click();
  await r.page.waitForTimeout(300);
  const status = await r.recompile();
  r.ok("compile works in Firefox", /Compiled in \d+ ms/.test(status), status);

  const pdfText = await r.pdfText();
  r.ok("folder doc text in PDF", /Firefox folder doc/.test(pdfText), pdfText.slice(0, 120));

  console.log(
    r.failures === 0 ? "ALL FIREFOX CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
