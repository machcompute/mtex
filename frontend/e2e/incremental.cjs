// The incremental builds (the pipeline's skip logic + the page's build
// cache).
//
// Part B — the pipeline reuses the previous build's .aux/.bcf/.bbl (the
// page persists them in artifacts/<id>/build/ and sends them back in the
// payload) and SKIPS the bibliography step when the bibliography inputs
// are unchanged: the control file TeX just wrote is byte-identical to the
// previous one AND every .bib hashes to what it recorded. Verified here
// for both backends:
//   S1  biblatex/biber  — the .bcf is deterministic (no timestamps), so a
//       benign text edit leaves it (and the .bbl) in force: "skipping
//       biber" appears in the log and the PDF is still right; editing the
//       .bib itself forces biber to run again.
//   S2  classic bibtex8 — the .aux is stable when the document has no
//       \label (the only line-bearing entries): "skipping bibtex8".
//
// Part A — the page's build cache (OPFS, artifacts/<id>/build/cache/,
// keyed by the sha256 of the project's inputs): a recompile with
// unchanged inputs reuses the cached PDF without running the engine at
// all, so it lands in well under a second while a real build takes many
// seconds on a fresh profile.
//
// S3 — the reader's place: the old PDF stays on screen for the whole
// build (no blank state), and a FAILED build does not destroy it — the
// last successful PDF is what the reader is looking at.
const {
  Runner,
  seedProject,
  openPackagesModal,
  closePackagesModal,
  installViaModal,
} = require("./helpers.cjs");

// --- S1: biblatex/biber ---------------------------------------------------
const MAIN = [
  "\\documentclass{article}",
  "\\usepackage[backend=biber]{biblatex}",
  "\\addbibresource{bib/references.bib}",
  "\\begin{document}",
  "As shown in the literature\\cite{knuth1984}, typesetting matters.",
  "\\printbibliography",
  "\\end{document}",
].join("\n");
// Benign edit: the new paragraph goes AFTER the citation and
// \printbibliography, so the .bcf (and the .aux) come out byte-identical.
const MAIN_EDITED = MAIN.replace(
  "\\printbibliography\n\\end{document}",
  "\\printbibliography\nA harmless trailing paragraph for the incremental test.\n\\end{document}",
);

const BIB = [
  "@book{knuth1984,",
  "  author    = {Knuth, Donald E.},",
  "  title     = {The TeXbook},",
  "  year      = {1984},",
  "  publisher = {Addison-Wesley},",
  "}",
].join("\n");
// Edit a FIELD, not the key: the first "1984" in BIB is inside the cite
// key itself, and renaming the key would make the citation legitimately
// unresolved (biber: "I didn't find a database entry for 'knuth1984'").
const BIB_1985 = BIB.replace("year      = {1984}", "year      = {1985}");

// --- S2: classic bibtex8 (no \label anywhere — keeps the .aux stable) -----
const CLASSIC_MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Knuth wrote the classic book\\cite{knuth1984}.",
  "\\bibliographystyle{plain}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");
const CLASSIC_EDITED = CLASSIC_MAIN.replace(
  "\\end{document}",
  "A harmless trailing paragraph for the incremental test.\n\\end{document}",
);

// The files under the project's artifacts/<id>/build/ (the persisted build
// state plus the build cache), so the suites can check what the app
// actually persisted.
async function buildFiles(r, id) {
  return r.page.evaluate(async (id) => {
    const out = [];
    try {
      const root = await navigator.storage.getDirectory();
      const aDir = await (
        await root.getDirectoryHandle("artifacts")
      ).getDirectoryHandle(id);
      const build = await aDir.getDirectoryHandle("build");
      for await (const e of build.values())
        if (e.kind === "file") out.push("build/" + e.name);
      const cache = await build.getDirectoryHandle("cache");
      for await (const e of cache.values())
        if (e.kind === "file") out.push("build/cache/" + e.name);
    } catch {
      // no build dir yet
    }
    return out;
  }, id);
}

// Edit a file the way the app sees it: click its tab (the app's onChange
// only fires for the ACTIVE editor) and set the model's value.
async function editFile(r, relPath, text) {
  await r.page.click(`[data-tab="${relPath}"]`);
  await r.page.evaluate(
    ({ p, t }) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith(p))
        .setValue(t),
    { p: relPath, t: text },
  );
}

// Wait for the status to pass through a non-terminal state and settle
// (a terminal status alone is not enough: the previous build's terminal
// text is still on screen until the new compile starts). Robust even
// when the build may have finished before waiting started.
//
// The cap matches waitEditCompile's below (450 × 200 ms = 90 s), which
// already carries the same edit→settle wait: in a loaded full 16-suite
// run the S3 broken build was still "Compiling…" at the old 24 s cap
// (load avg 5.6/35/56 at the run's start), while idle it settles in
// seconds — slow under load, not a hang (standalone idle run: all
// green). The slowest legitimate build measured under that same loaded
// run was ~11 s (biber); 90 s is ~3.75× the broken build's measured
// 24 s lower bound.
async function waitForSettled(r) {
  let text = "", sawNonTerminal = false;
  for (let i = 0; i < 450; i++) {
    text = ((await r.status.textContent().catch(() => "")) || "").trim();
    const disabled = await r.page.evaluate(
      () => document.querySelector('button[title^="Recompile"]')?.disabled,
    );
    const terminal = /^(Compiled in \d+ ms|Compilation failed)/.test(text);
    if (!terminal) sawNonTerminal = true;
    if (sawNonTerminal && terminal && !disabled) return text;
    await r.page.waitForTimeout(200);
  }
  return text;
}

// Wait for the debounced auto-compile an edit triggers to settle; returns
// the terminal status text. Mirrors recompile()'s busy tracking (a terminal
// status alone is not enough: the previous build's terminal text is still
// on screen until the new compile starts).
async function waitEditCompile(r) {
  const snap = () =>
    r.page.evaluate(() => {
      const b = document.querySelector('button[title^="Recompile"]');
      const s = document.querySelector("header span.truncate");
      return {
        disabled: b ? b.disabled : true,
        text: (s?.textContent || "").trim(),
      };
    });
  const before = (await snap()).text;
  let sawBusy = false;
  for (let i = 0; i < 450; i++) {
    await r.page.waitForTimeout(200);
    const { disabled, text } = await snap();
    if (disabled) sawBusy = true;
    if ((sawBusy || text !== before) && !disabled) return text;
  }
  return "";
}

const r = new Runner("incremental");

(async () => {
  try {
    await r.start();
    await r.goto();
    await r.waitReady();

    // --- install biblatex through the modal (the only install path) ------
    await openPackagesModal(r);
    await installViaModal(r, "biblatex");
    await closePackagesModal(r);

    // ======================= S1: biblatex / biber =========================
    const id1 = await seedProject(r, {
      name: "Incremental biber",
      mainPath: "main.tex",
      openPaths: ["main.tex", "bib/references.bib"],
      activePath: "main.tex",
      files: { "main.tex": MAIN, "bib/references.bib": BIB },
    });
    await r.goto();
    const ready = await r.waitReady();
    const status = ((await r.status.textContent().catch(() => "")) || "").trim();
    r.ok("S1 build 1 compiled", ready && /^Compiled in \d+ ms$/.test(status), status);

    let log = await r.logText();
    r.ok(
      "S1 build 1 ran biber",
      /biber main\.bcf/.test(log) && !/biber main\.bcf \(skipped\)/.test(log),
      log.split("\n").filter((l) => l.includes("biber")).join(" | ").slice(0, 200),
    );
    let pdf = await r.pdfText();
    r.ok("S1 build 1 PDF has the cited entry", pdf.includes("The TeXbook"), pdf.slice(0, 120));

    // The build state (and the first cache entry) landed in OPFS.
    let stored = await buildFiles(r, id1);
    r.ok(
      "S1 build state persisted (aux/bcf/bbl + bib hashes)",
      ["build/main.aux", "build/main.bcf", "build/main.bbl", "build/bib-hashes.json"].every(
        (f) => stored.includes(f),
      ),
      stored.join(", "),
    );
    r.ok(
      "S1 first cache entry persisted",
      stored.some((f) => f.startsWith("build/cache/") && f.endsWith(".pdf")) &&
        stored.includes("build/cache/index.json"),
      stored.filter((f) => f.startsWith("build/cache/")).join(", "),
    );

    // --- benign text edit: the bibliography inputs are unchanged ---------
    await editFile(r, "main.tex", MAIN_EDITED);
    const st2 = await waitEditCompile(r);
    r.ok("S1 build 2 compiled", /^Compiled in \d+ ms$/.test(st2), st2);
    log = await r.logText();
    r.ok(
      "S1 build 2 skipped biber",
      /biber main\.bcf \(skipped\)/.test(log),
      log.split("\n").filter((l) => l.includes("biber")).join(" | ").slice(0, 200),
    );
    pdf = await r.pdfText();
    r.ok(
      "S1 build 2 PDF is up to date (old entry + new paragraph)",
      pdf.includes("The TeXbook") && pdf.includes("harmless trailing paragraph"),
      pdf.slice(0, 160),
    );

    // --- unchanged recompile: the build cache hits, the engine idles -----
    const st3 = await r.recompile();
    const ms = /^Compiled in (\d+) ms$/.exec(st3);
    r.ok("S1 build 3 (cache hit) compiled", Boolean(ms), st3);
    r.ok(
      "S1 build 3 (cache hit) skipped the engine",
      Boolean(ms) && Number(ms[1]) < 1000,
      st3,
    );
    pdf = await r.pdfText();
    r.ok("S1 cache-hit PDF is the cached one", pdf.includes("harmless trailing paragraph"), pdf.slice(0, 160));

    // Two distinct builds → two cache entries.
    stored = await buildFiles(r, id1);
    const cachePdfs = stored.filter((f) => f.startsWith("build/cache/") && f.endsWith(".pdf"));
    r.ok("S1 cache holds one entry per distinct input set", cachePdfs.length === 2, cachePdfs.join(", "));

    // --- edit the .bib: the data source changed, biber must run again ----
    await editFile(r, "bib/references.bib", BIB_1985);
    const st4 = await waitEditCompile(r);
    r.ok("S1 build 4 compiled", /^Compiled in \d+ ms$/.test(st4), st4);
    log = await r.logText();
    r.ok(
      "S1 build 4 re-ran biber after the .bib edit",
      /biber main\.bcf/.test(log) && !/biber main\.bcf \(skipped\)/.test(log),
      log.split("\n").filter((l) => l.includes("biber")).join(" | ").slice(0, 200),
    );
    pdf = await r.pdfText();
    if (!pdf.includes("1985")) {
      // Diagnostics for the unresolved-citation case: the full log (biber's
      // stdout rides in it) plus what the app actually persisted.
      console.log("=== S1 build 4 full log ===\n" + log + "\n=== end log ===");
      console.log("S1 build 4 build dir:", (await buildFiles(r, id1)).join(", "));
    }
    r.ok("S1 build 4 PDF shows the edited year", pdf.includes("1985"), pdf.slice(0, 160));

    // ====================== S2: classic bibtex8 ===========================
    const id2 = await seedProject(r, {
      name: "Incremental bibtex",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      activePath: "main.tex",
      files: { "main.tex": CLASSIC_MAIN, "refs.bib": BIB },
    });
    await r.goto();
    const ready2 = await r.waitReady();
    const status2 = ((await r.status.textContent().catch(() => "")) || "").trim();
    r.ok("S2 build 1 compiled", ready2 && /^Compiled in \d+ ms$/.test(status2), status2);

    log = await r.logText();
    r.ok(
      "S2 build 1 ran bibtex8",
      /bibtex8[^\n]*main\.aux/.test(log) && !/\(skipped\)/.test(log),
      log.split("\n").filter((l) => l.includes("bibtex")).join(" | ").slice(0, 200),
    );
    pdf = await r.pdfText();
    r.ok("S2 build 1 PDF has the cited entry", pdf.includes("The TeXbook"), pdf.slice(0, 120));

    stored = await buildFiles(r, id2);
    r.ok(
      "S2 build state persisted (aux/bbl + bib hashes)",
      ["build/main.aux", "build/main.bbl", "build/bib-hashes.json"].every((f) => stored.includes(f)),
      stored.join(", "),
    );

    // --- benign text edit: no \label, so the .aux comes out identical ----
    await editFile(r, "main.tex", CLASSIC_EDITED);
    const st5 = await waitEditCompile(r);
    r.ok("S2 build 2 compiled", /^Compiled in \d+ ms$/.test(st5), st5);
    log = await r.logText();
    r.ok(
      "S2 build 2 skipped bibtex8",
      /bibtex8 main\.aux \(skipped\)/.test(log),
      log.split("\n").filter((l) => l.includes("bibtex")).join(" | ").slice(0, 200),
    );
    pdf = await r.pdfText();
    r.ok(
      "S2 build 2 PDF is up to date (old entry + new paragraph)",
      pdf.includes("The TeXbook") && pdf.includes("harmless trailing paragraph"),
      pdf.slice(0, 160),
    );

    // ================= S3: the reader keeps their PDF while building =====
    // A second marker paragraph: the OLD pdf has the first marker but not
    // this one, so the viewer's text tells the two builds apart.
    const CLASSIC_KEEPPDF = CLASSIC_EDITED.replace(
      "\\end{document}",
      "A second paragraph for the keep-PDF test.\n\\end{document}",
    );
    await editFile(r, "main.tex", CLASSIC_KEEPPDF);
    // Sample the viewer WHILE the debounced auto-compile runs (the button
    // is disabled while a build is in flight): the old PDF must stay on
    // screen, not be blanked.
    let sawOldDuringBuild = false;
    for (let i = 0; i < 150; i++) {
      const [disabled, text] = await r.page.evaluate(() => [
        document.querySelector('button[title^="Recompile"]')?.disabled,
        Array.from(
          document.querySelectorAll("[data-pdf-viewer] span[data-baseline]"),
        )
          .map((s) => s.textContent)
          .join(" "),
      ]);
      if (
        disabled &&
        text.includes("harmless trailing paragraph") &&
        !text.includes("keep-PDF test")
      ) {
        sawOldDuringBuild = true;
        break;
      }
      if (text.includes("keep-PDF test")) break; // already landed
      await r.page.waitForTimeout(100);
    }
    r.ok("S3 the old PDF stays on screen while the build runs", sawOldDuringBuild);
    const st6 = await waitForSettled(r);
    r.ok("S3 build 3 compiled", /^Compiled in \d+ ms/.test(st6), st6);
    pdf = await r.pdfText();
    r.ok(
      "S3 the new PDF shows both paragraphs",
      pdf.includes("harmless trailing paragraph") && pdf.includes("keep-PDF test"),
      pdf.slice(0, 160),
    );

    // A failed build must not destroy the previous PDF either.
    const CLASSIC_BROKEN = CLASSIC_KEEPPDF.replace(
      "\\documentclass{article}",
      "\\documentclass{article}\n\\usepackage{nonexistent-pkg-xyz}",
    );
    await editFile(r, "main.tex", CLASSIC_BROKEN);
    const st7 = await waitForSettled(r);
    r.ok("S3 the broken build failed", /^Compilation failed/.test(st7), st7);
    pdf = await r.pdfText();
    r.ok(
      "S3 a failed build keeps the previous PDF",
      pdf.includes("harmless trailing paragraph") && pdf.includes("keep-PDF test"),
      pdf.slice(0, 160),
    );
  } finally {
    await r.finish();
  }
  process.exit(r.failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
