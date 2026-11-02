// Regression: default project (bibtex citations), network audit
// (browser-only, no data exfiltration), and the vendored
// caption/subcaption, algorithm2e and pgfplots(+pslatex) packages.
const { Runner } = require("./helpers.cjs");

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

// The sync-texlive.sh default set: every \usepackage here was "File not
// found" before the vendored tree existed.
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
// undefined" in EVERY TeX Live. The zapfchan TFM/PFB fonts are pulled in
// because the zptmcm* virtual math fonts xdv references (e.g. zpzccmry)
// compose from pzcmi8r, and xdvipdfmx aborts the whole PDF without it.
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

  // Record the worker's print stream (engine diagnostics — including the
  // PATCH 9 "extra texmf tree installed" line) for later checks. The
  // drawer shows the TeX log after a compile, not the print stream, so it
  // can't be read from the DOM.
  await r.page.addInitScript(() => {
    window.__workerPrints = [];
    const desc = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage");
    Object.defineProperty(Worker.prototype, "onmessage", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(fn) {
        desc.set.call(this, (e) => {
          try {
            if (e && e.data && e.data.print !== undefined)
              window.__workerPrints.push(e.data.print);
          } catch (_) {}
          fn(e);
        });
      },
    });
  });

  // Network audit: record every request.
  const requests = [];
  r.page.on("request", (req) =>
    requests.push({ method: req.method(), url: req.url() }),
  );

  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
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

  // Network audit: browser-only. No POST/PUT, no non-engine /api/, no
  // foreign origins (allow app origin, monaco CDN, and blob: URLs).
  const badMethod = requests.filter(
    (req) => req.method === "POST" || req.method === "PUT",
  );
  r.ok(
    "no POST/PUT requests",
    badMethod.length === 0,
    badMethod.map((req) => req.method + " " + req.url).join(", ").slice(0, 200),
  );
  const badApi = requests
    .filter((req) => /\/api\//.test(req.url))
    .filter((req) => !/\/api\/texlive\//.test(req.url));
  r.ok(
    "only /api/texlive/ used",
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

  // --- subcaption: seed a document via localStorage, reload, compile ---
  await r.page.evaluate((doc) => {
    const proj = {
      v: 1,
      projectName: "subcap",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      files: { "main.tex": doc },
    };
    localStorage.setItem("homehub-latex-project-v1", JSON.stringify(proj));
  }, SUBDOC);
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();
  r.ok(
    "reloaded, engine ready",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
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

  // --- algorithm2e: the other vendored package --------------------------
  await r.page.evaluate((doc) => {
    const proj = {
      v: 1,
      projectName: "algo2e",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      files: { "main.tex": doc },
    };
    localStorage.setItem("homehub-latex-project-v1", JSON.stringify(proj));
  }, ALGDOC);
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

  // --- vendored essentials (scripts/sync-texlive.sh default set) ---------
  // First compile in this session: the worker installs the extra tree into
  // the FS root (PATCH 9). The second compile proves the tree persists
  // across compiles: it must NOT be re-installed, and the packages must
  // still resolve.
  await r.page.evaluate((doc) => {
    const proj = {
      v: 1,
      projectName: "essentials",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      files: { "main.tex": doc },
    };
    localStorage.setItem("homehub-latex-project-v1", JSON.stringify(proj));
  }, ESSDOC);
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();

  const essStatus = await r.recompile();
  r.ok("essentials doc compiled", /Compiled in \d+ ms/.test(essStatus), essStatus);

  // Fresh JS context after the reload: the print stream so far belongs to
  // THIS worker, so exactly one install line is expected after the first
  // compile.
  const installs1 = await r.page.evaluate(() =>
    window.__workerPrints.filter((l) => /extra texmf tree installed/.test(l)),
  );
  r.ok(
    "extra tree installed on first compile",
    installs1.length === 1,
    installs1.join(" | ").slice(0, 160) || "no install line",
  );

  const essText = await r.pdfText();
  r.ok("siunitx rendered (3 m)", /3 m/.test(essText), essText.slice(0, 160));
  r.ok(
    "enumitem item rendered",
    /enumitem bullet/.test(essText),
    essText.slice(0, 160),
  );

  const essStatus2 = await r.recompile();
  r.ok(
    "second compile reuses the installed tree",
    /Compiled in \d+ ms/.test(essStatus2),
    essStatus2,
  );
  const installs2 = await r.page.evaluate(() =>
    window.__workerPrints.filter((l) => /extra texmf tree installed/.test(l)),
  );
  r.ok(
    "no re-install on second compile",
    installs2.length === 1,
    installs2.join(" | ").slice(0, 160) || "no install line",
  );

  // --- pslatex + pgfplots (wrapped axis): the user's document shape ------
  await r.page.evaluate((doc) => {
    const proj = {
      v: 1,
      projectName: "plp",
      mainPath: "main.tex",
      openPaths: ["main.tex"],
      files: { "main.tex": doc },
    };
    localStorage.setItem("homehub-latex-project-v1", JSON.stringify(proj));
  }, PLPDOC);
  await r.page.reload({ waitUntil: "load" });
  await r.waitReady();

  const plpStatus = await r.recompile();
  r.ok(
    "pslatex+pgfplots doc compiled",
    /Compiled in \d+ ms/.test(plpStatus),
    plpStatus,
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

  console.log(
    r.failures === 0 ? "ALL REGRESSION CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
