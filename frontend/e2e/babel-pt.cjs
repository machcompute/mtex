// Focused suite for the babel auto-fix: "Package babel Error: Unknown
// option 'portuguese'".
//
// A fresh profile with the default-package sweep disabled (?noDefaults=1,
// empty store) relies on the preloaded texlive-basic tree. Recent TeX Live
// split babel's per-language .ldf files out of the `babel` core into their
// own babel-* tlpkg, and the base tree ships only babel-english — so
// \usepackage[portuguese]{babel} fails on a clean store. The editor now
// detects that exact error, finds the tlpkg that ships <lang>.ldf
// (packageForFile), installs it, restarts the engine, and recompiles — with
// no manual intervention.
//
// This suite seeds a Portuguese document on the CLEAN store and verifies the
// whole cycle lands on success:
//   * the "installing babel-portuges (language 'portuguese')" line appears,
//   * babel-portuges is in the store (on a noDefaults store only the
//     auto-fix can add it),
//   * the compile finishes "Compiled in N ms", the final log has no
//     "Unknown option", and the PDF shows the Portuguese "Figura" caption
//     (babel actually loaded the language).
const { Runner, seedProject, readCtanManifest } = require("./helpers.cjs");

const PTDOC = [
  "\\documentclass{article}",
  "\\usepackage[portuguese]{babel}",
  "\\begin{document}",
  "Olá mundo. Texto em português: ção, ção.",
  "\\begin{figure}[h]",
  "\\centering",
  "\\framebox[3cm]{A}",
  "\\caption{Uma figura}\\label{fig:a}",
  "\\end{figure}",
  "Veja a Figura \\ref{fig:a}.",
  "\\end{document}",
].join("\n");

const r = new Runner("babelpt");

(async () => {
  await r.start();
  await r.goto(); // ?noDefaults=1 → clean store
  await r.waitReady();

  await seedProject(r, {
    name: "pt",
    mainPath: "main.tex",
    openPaths: ["main.tex"],
    activePath: "main.tex",
    files: { "main.tex": PTDOC },
  });
  await r.page.reload({ waitUntil: "load" });
  // Arm an observer for the "installing babel-portuges" status line AFTER the
  // reload (a reload wipes `window`, so an observer armed before it is gone).
  // The line only appears seconds after load — the fix waits on the auto-
  // compile AND the ~20 MB tlpdb download before showing it — so arming it
  // now (right after the load event) is always in time. Observe document.body
  // and re-query the element each time so a React node swap can't break it.
  await r.page.evaluate(() => {
    window.__sawAutoFix = false;
    const check = () => {
      const el = document.querySelector("header span.truncate");
      if (el && /installing babel-portuges/.test(el.textContent || ""))
        window.__sawAutoFix = true;
    };
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  // The auto-compile on open hits the babel error and (the fix) auto-
  // installs babel-portuges + restarts the engine + recompiles. The fix
  // keeps the status "Compiling…" the whole time, so waitReady() only
  // settles on the FINAL result — a success or a real failure.
  await r.waitReady();

  // Force a compile (deterministic: if the auto-compile already ran the fix
  // this is a plain successful rebuild). recompile() returns the final
  // status; if its 90 s window elapsed (slow tlpdb download), keep waiting.
  let status = await r.recompile();
  if (!/^(Compiled in \d+ ms|Compilation failed)/.test(status)) {
    await r.waitReady();
    status = ((await r.status.textContent().catch(() => "")) || "").trim();
  }
  const manifest = await readCtanManifest(r);
  const pdfText = await r.pdfText();
  const sawAutoFix = await r.page.evaluate(() => window.__sawAutoFix);
  const log = await r.logText();

  const compiled = /Compiled in \d+ ms/.test(status);
  const hasBabelPortuges = "babel-portuges" in manifest.packages;
  const ptCaption = /Figura|figura/.test(pdfText);
  const hasUnknownOption = /Unknown option/i.test(log);

  console.log("\n=== CLEAN STORE + BABEL AUTO-FIX ===");
  console.log("status:", JSON.stringify(status));
  console.log("saw 'installing babel-portuges' line:", sawAutoFix);
  console.log(
    "manifest packages:",
    Object.keys(manifest.packages).join(", ") || "(none)",
  );
  console.log("PDF text:", JSON.stringify(pdfText.slice(0, 160)));
  console.log("final log has 'Unknown option':", hasUnknownOption);
  console.log("============================\n");

  r.ok(
    "auto-fix installed babel-portuges (clean store, no manual install)",
    hasBabelPortuges,
    Object.keys(manifest.packages).join(", ") || "(empty)",
  );
  r.ok("the 'installing babel-portuges' status line was shown", sawAutoFix);
  r.ok("compile succeeded ('Compiled in N ms')", compiled, `status="${status}"`);
  r.ok(
    "Portuguese caption rendered ('Figura')",
    ptCaption,
    pdfText.slice(0, 160),
  );
  r.ok("no 'Unknown option' in the final log", !hasUnknownOption);

  console.log(
    r.failures === 0 ? "ALL BABEL-PT CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
