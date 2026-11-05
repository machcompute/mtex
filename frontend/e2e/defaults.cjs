// First-run default package sweep (src/lib/ctan-store.ts,
// DEFAULT_PACKAGES): a fresh browser's CTAN store is empty, and the
// editor auto-installs the curated set in the background so a common
// document's first compile does not sit on missing packages. This suite
// is the only one that opts IN (every other suite visits the editor
// with ?noDefaults=1 — see the Runner in helpers.cjs), so its fresh
// profile runs the real sweep: tlpdb + 17 containers through the
// stateless /api/ctan proxy, unpacked into OPFS.
//
// Verified here: the sweep installs the whole set and marks the
// manifest (defaultsVersion), the status progress bar takes over the
// status line while it runs, a reload downloads NO further containers
// (the marker makes the sweep a no-op), a default the user removes is
// never resurrected, and a document that \usepackage's the defaults
// (pslatex shape: pgfplots axis, booktabs, siunitx) compiles.
const {
  Runner,
  seedProject,
  openPackagesModal,
  closePackagesModal,
  readCtanManifest,
} = require("./helpers.cjs");

// Mirror of DEFAULT_PACKAGES in src/lib/ctan-store.ts (kept literal so
// the suite fails loudly if the curated set drifts).
const DEFAULT_PACKAGES = [
  "fontspec",
  "xcolor",
  "enumitem",
  "booktabs",
  "caption",
  "mathtools",
  "siunitx",
  "pgfplots",
  "algorithm2e",
  "biblatex",
  "translations",
  "titlesec",
  "microtype",
  "float",
  "times",
  "zapfchan",
  "symbol",
];

// Defaults-only document: everything beyond the preloaded basic tree is
// a swept default (pslatex itself is in the base tree).
const DEFDOC = [
  "\\documentclass{article}",
  "\\usepackage[T1]{fontenc}",
  "\\usepackage{fontspec}",
  "\\usepackage{pslatex}",
  "\\usepackage{xcolor}",
  "\\usepackage{pgfplots}",
  "\\usepackage{booktabs}",
  "\\usepackage{siunitx}",
  "\\begin{document}",
  "Defaults document: $a^2+b^2=c^2$.",
  "",
  "\\begin{tikzpicture}",
  "  \\draw[->] (0,0) -- (2,2) node[right] {tikz};",
  "\\end{tikzpicture}",
  "",
  "\\begin{tikzpicture}",
  "\\begin{axis}[width=6cm, height=4cm]",
  "  \\addplot coordinates {(0,0) (1,1) (2,4) (3,9)};",
  "\\end{axis}",
  "\\end{tikzpicture}",
  "",
  "\\begin{table}",
  "\\begin{tabular}{ll}",
  "\\toprule",
  "A & B \\\\",
  "\\midrule",
  "\\si{3\\milli\\meter} & 9 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\end{document}",
].join("\n");

const r = new Runner("defaults", "chromium", { autoDefaults: true });

(async () => {
  await r.start();

  // Container downloads through the stateless proxy — the sweep's traffic.
  const archiveReqs = [];
  r.page.on("request", (req) => {
    if (/\/api\/ctan\/archive\//.test(req.url()))
      archiveReqs.push(req.url());
  });

  await r.goto();

  // The sweep runs in the background on first load. It downloads the
  // ~20 MB package database plus 17 containers (and their
  // dependencies) through the proxy — give it a long window, and log
  // occasionally so a hang is diagnosable. While it installs, the status
  // progress bar takes over the status slot (one step per package). The
  // install phase can last only a couple of seconds on a fast network —
  // shorter than any host-side polling period — so watch for the bar from
  // inside the page: arm a MutationObserver now, well before the bar can
  // appear (the package database is still downloading), and it records
  // the sighting regardless of how brief the window is.
  await r.page.evaluate(() => {
    const sel = 'header span[title^="Installing default packages"]';
    window.__sawInstallBar = !!document.querySelector(sel);
    const mo = new MutationObserver(() => {
      if (document.querySelector(sel)) window.__sawInstallBar = true;
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });
  });
  let swept = false;
  const deadline = Date.now() + 12 * 60 * 1000;
  let loggedAt = 0;
  while (Date.now() < deadline) {
    const m = await readCtanManifest(r);
    if (typeof m.defaultsVersion === "number" && m.defaultsVersion >= 1) {
      swept = true;
      break;
    }
    const now = Date.now();
    if (now - loggedAt > 30000) {
      loggedAt = now;
      console.log(
        `…sweep running (${Object.keys(m.packages).length}/${DEFAULT_PACKAGES.length} roots marked, ` +
          `${archiveReqs.length} container downloads so far)`,
      );
    }
    await r.page.waitForTimeout(2000);
  }
  const m = await readCtanManifest(r);
  const sawInstallBar = await r.page.evaluate(
    () => !!window.__sawInstallBar,
  );
  r.ok("first-run sweep completed (manifest marked)", swept, `defaultsVersion=${m.defaultsVersion}`);
  const missing = DEFAULT_PACKAGES.filter((n) => !(n in m.packages));
  r.ok(
    "all 17 default packages are in the store",
    missing.length === 0,
    missing.length ? "missing: " + missing.join(", ") : Object.keys(m.packages).length + " packages",
  );
  r.ok(
    "the sweep's containers came through the stateless proxy",
    archiveReqs.length >= DEFAULT_PACKAGES.length,
    archiveReqs.length + " container downloads",
  );
  r.ok("the install progress bar was shown in the status slot", sawInstallBar);

  // The sweep settled → the app also settled (engine ready, the default
  // project's auto-compile done; the post-sweep restart defers to the
  // in-flight compile's finally).
  r.ok("app settled after the sweep", await r.waitReady());

  // A default the user removes stays removed: the sweep must never
  // resurrect it (the marker is written once, and even a re-run skips
  // installed-but-removed names).
  await openPackagesModal(r);
  await r.page.click(`[data-pkg-row="float"] [data-pkg-remove]`);
  await r.page.waitForSelector('[data-pkg-row="float"]', {
    state: "detached",
    timeout: 60000,
  });
  await closePackagesModal(r);
  let m2 = await readCtanManifest(r);
  r.ok("user-removed default left the store", !("float" in m2.packages));

  // A fresh load: the marker makes the sweep a no-op — no container
  // downloads at all, and the removal survives.
  const archivesBefore = archiveReqs.length;
  await r.goto();
  r.ok("second load settled", await r.waitReady());
  m2 = await readCtanManifest(r);
  r.ok(
    "second load downloaded no containers (sweep ran once)",
    archiveReqs.length === archivesBefore,
    `${archiveReqs.length - archivesBefore} new downloads`,
  );
  r.ok(
    "removed default not resurrected on reload",
    !("float" in m2.packages) && typeof m2.defaultsVersion === "number",
  );

  // A document that \usepackage's the defaults compiles: the swept files
  // ride the compile payload and resolve in the engine.
  await seedProject(r, {
    name: "defaults",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": DEFDOC },
  });
  await r.goto();
  r.ok("defaults doc settled on open", await r.waitReady());
  // waitReady accepts "Compilation failed" as settled too, so read the
  // settled text explicitly: the auto-compile's outcome decides whether
  // the PDF checks below have anything to see.
  const settledText = ((await r.status.textContent().catch(() => "")) || "").trim();
  console.log(`…settled on open: ${settledText}`);
  const status = await r.recompile();
  if (!/Compiled in \d+ ms/.test(status)) {
    // xelatex runs --halt-on-error: the first "!" line in the log is the
    // real failure. Surface it plus the log tail in the run output.
    const log = await r.logText();
    const bang = log.split("\n").find((l) => l.startsWith("!")) ?? "(no ! line)";
    r.ok(
      "defaults doc compiled",
      false,
      `status="${status}", settled-on-open="${settledText}", first ! line: ${bang} — log tail: ${log.slice(-1200).replace(/\s+/g, " ")}`,
    );
  } else {
    r.ok("defaults doc compiled", true, status);
  }

  const text = await r.pdfText();
  const flat = text.replace(/\s+/g, " ");
  r.ok("document text in PDF", /Defaults document/.test(flat), flat.slice(0, 160));
  r.ok("tikz drawn (default: pgfplots pulls pgf)", /tikz/.test(flat));
  r.ok(
    "siunitx rendered (3 mm)",
    /3\s*mm/.test(flat),
    flat.slice(0, 200),
  );
  r.ok("no ?? unresolved references", !/\?\?/.test(text), text.slice(0, 160));

  console.log(
    r.failures === 0 ? "ALL DEFAULTS CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
