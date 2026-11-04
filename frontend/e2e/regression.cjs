// Regression: default project (bibtex citations), network audit
// (browser-only, no data exfiltration), and the on-demand CTAN packages
// caption/subcaption, algorithm2e, the essentials set, and
// pslatex+pgfplots(+tikz).
//
// The package store is the browser's own (OPFS — src/lib/ctan-store.ts;
// the server keeps no state), so this suite installs through the
// Packages modal, the same path a user takes: search → Install → the
// tlnet container is fetched through the stateless /api/ctan proxy,
// unpacked in the page, and lands in OPFS with its transitive
// dependencies. A fresh profile's store is empty, so the
// dependency-resolution assertions run against a clean store. Installed
// files ride the compile payload at their engine paths (there is no
// on-demand endpoint), so the network audit asserts the /api/ctan/
// traffic instead of engine fetches.
const {
  Runner,
  seedProject,
  openPackagesModal,
  closePackagesModal,
  installViaModal,
  readCtanManifest,
} = require("./helpers.cjs");

const SUBDOC = [
  "\\documentclass{article}",
  "\\usepackage{caption}",
  "\\usepackage{subcaption}",
  "\\begin{document}",
  "Main text referencing Figure \\ref{fig:main}, specifically \\subref{fig:a}.",
  "\\begin{figure}",
  "\\centering",
  "\\begin{subfigure}{0.45\\textwidth}",
  "\\framebox[3cm]{A}",
  "\\caption{Sub A}\\label{fig:a}",
  "\\end{subfigure}",
  "\\hfill",
  "\\begin{subfigure}{0.45\\textwidth}",
  "\\framebox[3cm]{B}",
  "\\caption{Sub B}\\label{fig:b}",
  "\\end{subfigure}",
  "\\caption{Main caption}\\label{fig:main}",
  "\\end{figure}",
  "\\end{document}",
].join("\n");

const ALGDOC = [
  "\\documentclass{article}",
  "\\usepackage[ruled,linesnumbered]{algorithm2e}",
  "\\begin{document}",
  "Body text before the algorithm.",
  "\\begin{algorithm}[H]",
  "\\KwIn{a value $x$}",
  "\\KwOut{$x + 1$}",
  "$x \\leftarrow x + 1$\\;",
  "\\caption{Increment}\\label{alg:inc}",
  "\\end{algorithm}",
  "See Algorithm \\ref{alg:inc}.",
  "\\end{document}",
].join("\n");

// Every \usepackage in the documents below that the engine's preloaded
// texlive-basic tree does not contain. Installing one that basic DOES
// contain is harmless (the local tree wins the lookup; the store file is
// simply never used). pgfplots and algorithm2e are installed FIRST, on
// the clean store, so the dependency-resolution assertions are causal.
const PKGS = [
  "pgfplots", // pulls in pgf (provides tikz), listings, xcolor, pdfcolmk, everyshi
  "algorithm2e", // pulls in ifoddpage, relsize, endfloat, tocbibind, type1cm
  "caption",
  "booktabs",
  "mathtools", // mhsetup ships in its own container
  "siunitx",
  "enumitem",
  "fontspec",
  "xcolor", // already pulled in by pgfplots — a no-op success
  "pslatex",
  // pslatex only ships the .sty; the Times text metrics/fonts live in the
  // separate `times` package (URW Base 35), and the pzcm* math family it
  // selects (mapped to Zapf Chancery by tetex/dvips35.map) in `zapfchan`.
  // These are fontmap deps — invisible to the \usepackage scanner, so
  // they must be installed by hand.
  "times",
  "zapfchan",
  // siunitx probes for it (babel's translations package); a miss is
  // tolerated but the store serves it once installed
  "translations",
];

const ESSDOC = [
  "\\documentclass{article}",
  "\\usepackage{booktabs}",
  "\\usepackage[table]{xcolor}",
  "\\usepackage{mathtools}",
  "\\usepackage{siunitx}",
  "\\usepackage{enumitem}",
  "\\usepackage{fontspec}",
  "\\DeclareMathOperator{\\argmax}{arg\\,max}",
  "\\begin{document}",
  "\\begin{table}[h]",
  "\\rowcolors{2}{red!10}{blue!5}",
  "\\begin{tabular}{ll}",
  "\\toprule",
  "Item & Value \\\\",
  "\\midrule",
  "A & \\SI{3}{\\meter} \\\\",
  "B & 2 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\begin{equation}",
  "\\argmax_x f(x)",
  "\\end{equation}",
  "\\begin{itemize}[leftmargin=2em]",
  "\\item enumitem bullet",
  "\\end{itemize}",
  "\\end{document}",
].join("\n");

// pslatex (Times) + pgfplots, the user's document shape. The axis MUST be
// wrapped in a tikzpicture — that is how pgfplots installs the environment
// (the manual: "we have to write each \PGFPlots{} graph into a \TikZ{}
// picture"); a standalone \begin{axis} fails with "Environment axis
// undefined" in EVERY TeX Live. The Times fonts themselves come with the
// pslatex container (the whole package is pulled, not cherry-picked).
const PLPDOC = [
  "\\documentclass{article}",
  "\\usepackage{pslatex}",
  "\\usepackage{caption}",
  "\\usepackage{subcaption}",
  "\\usepackage[ruled,linesnumbered]{algorithm2e}",
  "\\usepackage{booktabs}",
  "\\usepackage{tikz}",
  "\\usepackage{pgfplots}",
  "\\pgfplotsset{compat=1.18}",
  "\\begin{document}",
  "Typeset in Times: $a+b=c$ and text.",
  "\\begin{figure}[h]",
  "\\centering",
  "\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}",
  "\\caption{A figure}\\label{fig:a}",
  "\\end{figure}",
  "\\begin{figure}[h]",
  "\\centering",
  "\\begin{tikzpicture}",
  "\\begin{axis}[width=5cm,height=3cm]",
  "\\addplot coordinates {(0,0) (1,1) (2,4)};",
  "\\end{axis}",
  "\\end{tikzpicture}",
  "\\caption{A plot}\\label{fig:plot}",
  "\\end{figure}",
  "\\begin{algorithm}[H]",
  "$x \\leftarrow x + 1$\\;",
  "\\caption{Increment}\\label{alg:inc}",
  "\\end{algorithm}",
  "\\begin{table}[h]",
  "\\begin{tabular}{ll}\\toprule A & 1 \\\\ \\bottomrule\\end{tabular}",
  "\\end{table}",
  "See Figure \\ref{fig:a} and Algorithm \\ref{alg:inc}.",
  "\\end{document}",
].join("\n");

const r = new Runner("reg");

(async () => {
  await r.start();

  // Network audit: record every request from the very start (the modal
  // installs below make the /api/ctan/ requests).
  const requests = [];
  r.page.on("request", (req) =>
    requests.push({ method: req.method(), url: req.url() }),
  );

  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready",
    /^(Ready\.|Compiled in \d+ ms)$/.test(
      ((await r.status.textContent()) || "").trim(),
    ),
  );
  // Auto-compile on open: the default project (it has a main.tex) has
  // already been built by the time the app settles — no click happened.
  // (It runs against an EMPTY store — the default project only uses
  // amsmath, which the preloaded basic tree covers.)
  r.ok(
    "auto-compiled on open (no Recompile clicked yet)",
    /^Compiled in \d+ ms$/.test(
      ((await r.status.textContent()) || "").trim(),
    ),
  );

  // Default project compiles with bibtex citations resolved.
  const status = await r.recompile();
  r.ok("default project compiled", /Compiled in \d+ ms/.test(status), status);

  const pdfText = await r.pdfText();
  r.ok("PDF rendered with text", pdfText.length > 0);
  r.ok("no ?? undefined references", !/\\?\?/.test(pdfText), pdfText.slice(0, 120));

  // Log: bibtex ran (a .bbl was read).
  const log = await r.logText();
  r.ok("bibtex ran (bbl read in log)", /\.bbl/.test(log));

  // --- the browser's CTAN store (the Packages modal) ---------------------
  // Everything the documents below \usepackage beyond the preloaded
  // texlive-basic tree must be in the store BEFORE those projects
  // compile: a worker born without the names would fall through to the
  // enable-all-data-packages fallback (the ~540 MB trees).
  await openPackagesModal(r);

  for (const name of PKGS) {
    console.log(`installing ${name}…`);
    const notice = await installViaModal(r, name);
    if (name === "pgfplots") {
      // Clean-store install: the whole closure must be in the store now.
      const manifest = await readCtanManifest(r);
      const has = (n) => n in manifest.packages;
      r.ok(
        "install pgfplots pulled in pgf (its \\RequirePackage)",
        has("pgf") && has("listings"),
        Object.keys(manifest.packages).join(", "),
      );
      r.ok(
        "install pgfplots pulled in xcolor + pdfcolmk (transitive, via pgf)",
        has("xcolor") && has("pdfcolmk"),
        Object.keys(manifest.packages).join(", "),
      );
      // Doc/test files inside containers (lstdoc.sty, fancyvrb-ex.sty,
      // pst-doc.cls) must NOT trigger installs: that cascade once pulled
      // in pstricks, biblatex and friends.
      r.ok(
        "doc-file references not installed (no pstricks/biblatex cascade)",
        !has("pstricks") && !has("biblatex"),
      );
      r.ok(
        "pgfplots install reported no unresolved dependencies",
        notice !== null && !/could not auto-install/.test(notice),
        notice ?? "no install notice visible",
      );
    }
    if (name === "algorithm2e") {
      const manifest = await readCtanManifest(r);
      r.ok(
        "install algorithm2e pulled in ifoddpage + relsize",
        "ifoddpage" in manifest.packages && "relsize" in manifest.packages,
        Object.keys(manifest.packages).join(", "),
      );
      r.ok(
        "algorithm2e install reported no unresolved dependencies",
        notice !== null && !/could not auto-install/.test(notice),
        notice ?? "no install notice visible",
      );
    }
  }
  await closePackagesModal(r);

  // The proxy traffic the installs must have made: the package database
  // (cached in OPFS after the first fetch) and one container per fresh
  // install — all same-origin, because CTAN mirrors send no CORS headers.
  const archiveReqs = requests.filter((req) =>
    /\/api\/ctan\/archive\//.test(req.url),
  );
  r.ok(
    "the tlpdb was fetched through the same-origin proxy",
    requests.some((req) => req.url.endsWith("/api/ctan/tlpdb")),
  );
  r.ok(
    "install containers came through the same-origin proxy",
    archiveReqs.length >= PKGS.length,
    archiveReqs.length + " archive requests",
  );

  // Network audit: browser-only. The app talks to its own origin only:
  // the engine assets (/api/texlive/) and the stateless CTAN proxy
  // (/api/ctan/). No POST/PUT (installs are client-side), no server
  // package API (the store is in the browser), no foreign origins.
  const badMethod = requests.filter(
    (req) => req.method === "POST" || req.method === "PUT",
  );
  r.ok(
    "no POST/PUT requests",
    badMethod.length === 0,
    badMethod.map((req) => req.method + " " + req.url).join(", ").slice(0, 200),
  );
  r.ok(
    "no server package API used (the store lives in the browser)",
    requests.every(
      (req) =>
        !/\/api\/packages/.test(req.url) &&
        !/\/api\/texlive-remote/.test(req.url),
    ),
  );
  const badApi = requests
    .filter((req) => /\/api\//.test(req.url))
    .filter(
      (req) =>
        !/\/api\/texlive\//.test(req.url) && !/\/api\/ctan\//.test(req.url),
    );
  r.ok(
    "only the app's own API endpoints used",
    badApi.length === 0,
    badApi.map((req) => req.url).join(", ").slice(0, 200),
  );
  const allowed = (u) =>
    u.startsWith("http://localhost:3000") ||
    u.startsWith("blob:") ||
    /https:\/\/cdn\.jsdelivr\.net\/npm\/monaco-editor/.test(u);
  const foreign = requests.filter((req) => !allowed(req.url));
  r.ok(
    "no foreign origins",
    foreign.length === 0,
    foreign.map((req) => req.url).join(", ").slice(0, 200),
  );

  // --- subcaption: seed a document in OPFS, reload, compile --------------
  await seedProject(r, {
    name: "subcap",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": SUBDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();
  r.ok(
    "reloaded, engine ready",
    /^(Ready\.|Compiled in \d+ ms)$/.test(
      ((await r.status.textContent()) || "").trim(),
    ),
  );

  const subStatus = await r.recompile();
  r.ok("subcaption doc compiled", /Compiled in \d+ ms/.test(subStatus), subStatus);

  const subText = await r.pdfText();
  r.ok("main caption in PDF", /Main caption/.test(subText));
  r.ok("subcaption A rendered", /Sub A/.test(subText));
  r.ok("subcaption B rendered", /Sub B/.test(subText));
  r.ok(
    "subref resolved (no ?? in body)",
    !/\\?\?/.test(subText),
    subText.slice(0, 160),
  );

  // --- algorithm2e ---------------------------------------------------------
  await seedProject(r, {
    name: "algo2e",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": ALGDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();

  const algStatus = await r.recompile();
  r.ok("algorithm2e doc compiled", /Compiled in \d+ ms/.test(algStatus), algStatus);

  const algText = await r.pdfText();
  r.ok("algorithm caption in PDF", /Increment/.test(algText), algText.slice(0, 160));
  r.ok(
    "algorithm label resolved (no ??)",
    !/\?\?/.test(algText),
    algText.slice(0, 160),
  );

  // --- essentials ----------------------------------------------------------
  await seedProject(r, {
    name: "essentials",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": ESSDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();

  const essStatus = await r.recompile();
  r.ok("essentials doc compiled", /Compiled in \d+ ms/.test(essStatus), essStatus);

  // siunitx's unit separator is a thin space, which the text extraction
  // widens — collapse whitespace before matching.
  const essText = await r.pdfText();
  const essFlat = essText.replace(/\s+/g, " ");
  r.ok("siunitx rendered (3 m)", /3 m/.test(essFlat), essText.slice(0, 160));
  r.ok(
    "enumitem item rendered",
    /enumitem bullet/.test(essFlat),
    essText.slice(0, 160),
  );

  // --- pslatex + pgfplots (wrapped axis): the user's document shape ------
  await seedProject(r, {
    name: "plp",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": PLPDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();

  const plpStatus = await r.recompile();
  r.ok(
    "pslatex+pgfplots doc compiled",
    /Compiled in \d+ ms/.test(plpStatus),
    plpStatus,
  );

  // The client-store mechanism end-to-end: the installed files rode this
  // compile's payload at their engine paths, and the worker's init
  // carried the store's names as remote_packages. A \usepackage the
  // store does not provide would make the resolver enable ALL data
  // packages — the recommended+extra .data trees (~540 MB) would be
  // downloaded. The .js catalogs are fetched at every worker init (the
  // resolver's \ProvidesPackage scan); the .data trees are the fallback
  // and must never load for the documents in this suite.
  r.ok(
    "no data-tree fallback (recommended/extra .data never fetched)",
    requests.every((req) => !/texlive-(recommended|extra)\.data/.test(req.url)),
    requests
      .filter((req) => /texlive-(recommended|extra)\.data/.test(req.url))
      .map((req) => req.url)
      .join(", "),
  );

  const plpText = await r.pdfText();
  const plpFlat = plpText.replace(/\s+/g, " ");
  r.ok("figure caption in PDF", /A figure/.test(plpText), plpText.slice(0, 160));
  r.ok("axis plot caption in PDF", /A plot/.test(plpText), plpText.slice(0, 160));
  r.ok(
    "axis tick labels rendered (0 2 4)",
    /0 2 4/.test(plpFlat),
    plpFlat.slice(0, 200),
  );
  r.ok(
    "pslatex refs resolved (no ??)",
    !/\?\?/.test(plpText),
    plpText.slice(0, 160),
  );

  // --- the header brand goes back to the project dashboard --------------
  const brand = r.page.locator('header a[href="/"]', { hasText: "HomeHub" });
  r.ok("the HomeHub brand links to the dashboard", (await brand.count()) === 1);
  await brand.first().click();
  await r.page.waitForSelector('button:has-text("New project")', { timeout: 30000 });
  r.ok("clicking the brand opens the dashboard", r.page.url().endsWith("/"), r.page.url());

  console.log(
    r.failures === 0 ? "ALL REGRESSION CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
