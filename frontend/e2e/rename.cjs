// Verifies the nested-file rename fix: in-place rename, move between
// folders/roots, and invalid-name handling.
const fs = require("fs");
const { Runner, PNG_PATH, readProject } = require("./helpers.cjs");

const PNG = fs.readFileSync(PNG_PATH);
const DOC = ["\\documentclass{article}", "\\begin{document}", "x", "\\end{document}"].join("\n");

const r = new Runner("rename");

(async () => {
  await r.start();
  // :not([title]) — the files header's project-name input also matches
  // "aside input" (inscribe.io layout), but it carries a title attr.
  const renameInput = () =>
    r.page.locator('aside input:not([type="file"]):not([title])');

  await r.goto();
  await r.waitReady();

  // Drop a folder with a nested image to rename.
  await r.page.evaluate(
    ({ doc, png }) => {
      const mk = (rel, content, type) => {
        const f = new File(
          type === "image/png" ? [new Uint8Array(content)] : [content],
          rel.split("/").pop(),
          { type },
        );
        Object.defineProperty(f, "webkitRelativePath", { value: rel });
        return f;
      };
      const dt = new DataTransfer();
      dt.items.add(mk("paper/doc.tex", doc, "text/x-tex"));
      dt.items.add(mk("paper/figs/logo.png", png, "image/png"));
      document
        .querySelector("aside")
        .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { doc: DOC, png: Array.from(PNG) },
  );
  await r.page.waitForTimeout(600);
  r.ok("folder dropped", (await r.page.locator("li", { hasText: "logo.png" }).count()) > 0);

  // 1) In-place nested rename: figs/logo.png -> figs/logo2.png
  await r.page
    .locator("li", { hasText: "logo.png" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await r.page.waitForTimeout(150);
  await renameInput().fill("figs/logo2.png");
  await renameInput().press("Enter");
  await r.page.waitForTimeout(300);
  r.ok("in-place rename: old gone", (await r.page.locator("li", { hasText: "logo.png" }).count()) === 0);
  r.ok("in-place rename: new present", (await r.page.locator("li", { hasText: "logo2.png" }).count()) > 0);
  const pad = await r.page
    .locator("li", { hasText: "logo2.png" })
    .first()
    .locator("div")
    .first()
    .evaluate((el) => el.style.paddingLeft);
  r.ok("in-place rename keeps folder depth (18px)", pad === "18px", pad);

  // 2) Move to root: figs/logo2.png -> rootlogo.png
  await r.page
    .locator("li", { hasText: "logo2.png" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await r.page.waitForTimeout(150);
  await renameInput().fill("rootlogo.png");
  await renameInput().press("Enter");
  await r.page.waitForTimeout(300);
  r.ok("move to root: present", (await r.page.locator("li", { hasText: "rootlogo.png" }).count()) > 0);
  const pad2 = await r.page
    .locator("li", { hasText: "rootlogo.png" })
    .first()
    .locator("div")
    .first()
    .evaluate((el) => el.style.paddingLeft);
  r.ok("move to root depth 0 (8px)", pad2 === "8px", pad2);

  // 3) Invalid rename (empty segment) -> error, file unchanged
  await r.page
    .locator("li", { hasText: "rootlogo.png" })
    .locator('button[title="Rename file"]')
    .first()
    .click();
  await r.page.waitForTimeout(150);
  await renameInput().fill("a//b.png");
  await renameInput().press("Enter");
  await r.page.waitForTimeout(300);
  // The error is a notice pill (not a status error — that would open the
  // log drawer and imply a failed compile).
  const bodyText = await r.page.evaluate(() => document.body.innerText);
  r.ok("invalid rename shows notice", /Cannot rename/.test(bodyText));
  r.ok(
    "invalid rename leaves the log panel closed",
    (await r.page.locator('[data-rail="log"][data-active]').count()) === 0,
  );
  r.ok(
    "invalid rename leaves file unchanged",
    (await r.page.locator("li", { hasText: "rootlogo.png" }).count()) > 0 &&
      (await r.page.locator("li", { hasText: "b.png" }).count()) === 0,
  );

  // OPFS reflects the final keys (wait out the 600 ms save debounce).
  await r.page.waitForTimeout(1000);
  const stored = await readProject(r);
  r.ok("OPFS: figs/logo.png gone", stored?.files?.["figs/logo.png"] === undefined);
  r.ok("OPFS: rootlogo.png present", stored?.files?.["rootlogo.png"] !== undefined);

  console.log(
    r.failures === 0 ? "ALL RENAME CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
