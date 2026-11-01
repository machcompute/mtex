// Firefox suite: the folder UPLOAD BUTTON in a real Firefox. Firefox honors
// the webkitdirectory attribute (MDN: supported; CanIUse: Firefox 50+), so
// the button opens a native folder picker exactly like in Chromium. This
// suite drives that whole flow: click button -> folder picker -> select a
// directory on disk -> import with structure -> compile.
const fs = require("fs");
const os = require("os");
const path = require("path");
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
// A real folder on disk for the native picker to "select".
const pickDir = fs.mkdtempSync(path.join(os.tmpdir(), "homehub-ffpick-"));
fs.mkdirSync(path.join(pickDir, "ffpaper", "figs"), { recursive: true });
fs.writeFileSync(path.join(pickDir, "ffpaper", "doc.tex"), DOC);
fs.copyFileSync(PNG_PATH, path.join(pickDir, "ffpaper", "figs", "logo.png"));

(async () => {
  await r.start();
  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready in Firefox",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
    ((await r.status.textContent().catch(() => "")) || "").trim(),
  );

  // The folder button must be present (Firefox DOES support webkitdirectory).
  const folderBtn = r.page.locator(
    'button[title="Upload a whole folder, recursively (kept in your browser)"]',
  );
  r.ok("folder button present in Firefox", (await folderBtn.count()) === 1);

  // Click it: the filechooser fires on the webkitdirectory input. Selecting
  // the on-disk directory is what the user does in the native dialog.
  const [chooser] = await Promise.all([
    r.page.waitForEvent("filechooser", { timeout: 15000 }),
    folderBtn.first().click(),
  ]);
  const inputAttrs = await chooser.element().evaluate((n) =>
    Array.from(n.attributes).map((a) => a.name),
  );
  r.ok(
    "picker is the webkitdirectory input",
    inputAttrs.includes("webkitdirectory"),
    inputAttrs.join(","),
  );
  await chooser.setFiles([path.join(pickDir, "ffpaper")]);

  await r.page.waitForTimeout(800);
  const notice =
    ((await r.page
      .locator("p, div")
      .filter({ hasText: /^Uploaded/ })
      .first()
      .textContent()
      .catch(() => "")) || "");
  r.ok("folder import notice", /Uploaded 2 files/.test(notice), notice);
  r.ok(
    "nested row present",
    (await r.page.locator("li", { hasText: "logo.png" }).count()) > 0,
  );

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
  r.ok(
    "folder doc text in PDF",
    /Firefox folder doc/.test(pdfText),
    pdfText.slice(0, 120),
  );

  console.log(
    r.failures === 0 ? "ALL FIREFOX CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  fs.rmSync(pickDir, { recursive: true, force: true });
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  fs.rmSync(pickDir, { recursive: true, force: true });
  process.exit(1);
});
