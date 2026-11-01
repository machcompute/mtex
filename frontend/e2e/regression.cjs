// Regression: default project (bibtex citations), network audit
// (browser-only, no data exfiltration), and the vendored
// caption/subcaption and algorithm2e packages.
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

const r = new Runner("reg");

(async () => {
  await r.start();

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

  console.log(
    r.failures === 0 ? "ALL REGRESSION CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
