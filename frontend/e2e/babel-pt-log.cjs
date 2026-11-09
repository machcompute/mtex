// Dump the FULL compile log for \usepackage[portuguese]{babel} on a clean
// store. A debug aid (no assertions): prints the log to stdout and also
// writes it to a file in the OS temp dir (path printed below).
const { Runner, seedProject } = require("./helpers.cjs");
const os = require("os");
const path = require("path");

const PTDOC = [
  "\\documentclass{article}",
  "\\usepackage[portuguese]{babel}",
  "\\begin{document}",
  "Olá mundo.",
  "\\end{document}",
].join("\n");

const r = new Runner("babelptlog");
(async () => {
  await r.start();
  await r.goto();
  await r.waitReady();
  await seedProject(r, {
    name: "pt",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": PTDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();
  await r.recompile();
  // open the log panel (icon rail)
  await r.page.locator('[data-rail="log"]').click();
  await r.page.waitForTimeout(400);
  const full = await r.page.evaluate(() => document.querySelector("pre")?.textContent || "");
  const out = path.join(os.tmpdir(), "babel-pt-full.log");
  require("fs").writeFileSync(out, full);
  console.log("full log bytes:", full.length, "(written to " + out + ")");
  console.log(full);
  await r.finish();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
