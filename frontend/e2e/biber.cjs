// Biber with a subdirectory .bib — the thesis layout (main.tex at the
// root, the data source at bib/references.bib). The release biber loader
// flattened every input path to its basename, so biber — which resolves
// data sources relative to the control file — could never find
// bib/references.bib ("ERROR - Cannot find 'bib/references.bib'!"). The
// vendored loader (public/busytex/busytex_biber.js) keeps the
// subdirectory, and this suite asserts the entry actually reaches the
// PDF (a biber failure still produces a PDF, with ?! citations).
//
// biblatex itself is not in the engine's preloaded texlive-basic tree, so
// it is installed through the Packages modal first (the store is the
// browser's own — OPFS; the modal is the only install path). This also
// guards the client dependency resolver: logreq (biblatex's
// \RequirePackage) sits past the old server resolver's 512 KB scan cap
// (biblatex.sty is 538 KB) and must be pulled in automatically.
const {
  Runner,
  seedProject,
  openPackagesModal,
  closePackagesModal,
  installViaModal,
  readCtanManifest,
} = require("./helpers.cjs");

const MAIN = [
  "\\documentclass{article}",
  "\\usepackage[backend=biber]{biblatex}",
  "\\addbibresource{bib/references.bib}",
  "\\begin{document}",
  "As shown in the literature\\cite{knuth1984}, typesetting matters.",
  "\\printbibliography",
  "\\end{document}",
].join("\n");

const BIB = [
  "@book{knuth1984,",
  "  author    = {Knuth, Donald E.},",
  "  title     = {The TeXbook},",
  "  year      = {1984},",
  "  publisher = {Addison-Wesley},",
  "}",
].join("\n");

const r = new Runner("biber");

(async () => {
  try {
    await r.start();
    await r.goto();
    await r.waitReady();

    // --- install biblatex through the modal (the only install path) ------
    await openPackagesModal(r);
    const notice = await installViaModal(r, "biblatex");
    const manifest = await readCtanManifest(r);
    r.ok(
      "biblatex is in the browser's CTAN store",
      "biblatex" in manifest.packages,
      Object.keys(manifest.packages).join(", "),
    );
    r.ok(
      "logreq was auto-pulled (biblatex's \\RequirePackage, past the old 512 KB scan cap)",
      "logreq" in manifest.packages,
      Object.keys(manifest.packages).join(", "),
    );
    r.ok(
      "biblatex install reported no unresolved dependencies",
      notice !== null && !/could not auto-install/.test(notice),
      notice ?? "no install notice visible",
    );
    await closePackagesModal(r);

    // --- seed the thesis-layout project (main.tex + bib/references.bib) --
    await seedProject(r, {
      name: "Biber subdir",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      activePath: "main.tex",
      files: { "main.tex": MAIN, "bib/references.bib": BIB },
    });
    await r.goto();
    await r.waitReady();

    const status = ((await r.status.textContent().catch(() => "")) || "").trim();
    r.ok("compiled with a subdirectory .bib", /^Compiled in \d+ ms/.test(status), status);

    const log = await r.logText();
    r.ok("biber was invoked", /biber main\.bcf/.test(log));
    r.ok(
      "biber found bib/references.bib",
      !log.includes("Cannot find") && !log.includes("ERROR -"),
      log.split("\n").filter((l) => l.includes("ERROR") || l.includes("Cannot find")).join(" | ").slice(0, 200),
    );

    const pdf = await r.pdfText();
    r.ok("the cited entry reached the PDF", pdf.includes("The TeXbook"), pdf.slice(0, 120));
  } finally {
    await r.finish();
  }
  process.exit(r.failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
