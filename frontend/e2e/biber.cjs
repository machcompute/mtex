// Biber with a subdirectory .bib — the thesis layout (main.tex at the
// root, the data source at bib/references.bib). The release biber loader
// flattened every input path to its basename, so biber — which resolves
// data sources relative to the control file — could never find
// bib/references.bib ("ERROR - Cannot find 'bib/references.bib'!"). The
// vendored loader (public/busytex/busytex_biber.js) keeps the
// subdirectory, and this suite asserts the entry actually reaches the
// PDF (a biber failure still produces a PDF, with ?! citations).
const { Runner, seedProject, APP_URL } = require("./helpers.cjs");

const API_BASE = APP_URL.replace(/\/editor$/, "");

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

// Host-side install (the engine's worker must be born AFTER the package
// list contains biblatex, or the resolver would fall through to the
// enable-all-data-packages fallback and pull the multi-hundred-MB trees).
async function installPackage(name) {
  const res = await fetch(`${API_BASE}/api/packages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) return null; // already installed (previous run)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) || {};
    throw new Error(`install ${name} failed: ${res.status} ${data.error || ""}`);
  }
  const data = await res.json();
  console.log(`    installed ${data.package?.name} (+${(data.installedDependencies ?? []).length} deps)`);
  return data.package;
}

(async () => {
  // logreq: biblatex's \RequirePackage{logreq} sits past the old server
  // resolver's 512 KB scan cap (biblatex.sty is 538 KB), so the server
  // store misses it as a dependency — install it explicitly here. The
  // client resolver (src/lib/ctan-store.ts) raises the cap and pulls it
  // in automatically.
  await installPackage("logreq");
  await installPackage("biblatex");

  const r = new Runner("biber");
  try {
    await r.start();
    await r.goto();
    await r.waitReady();
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
})();
