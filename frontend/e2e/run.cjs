// Runs all e2e suites in order; exits non-zero if any check fails.
// See README.md for prerequisites (both servers must be up).
const { spawnSync } = require("child_process");
const path = require("path");

const suites = [
  "folder.cjs",
  "rename.cjs",
  "regression.cjs",
  "biber.cjs",
  "fixes.cjs",
  "projects.cjs",
  // The inscribe.io layout: the slim app bar (wordmark + status, no
  // Projects menu), the icon rail switching the left panel (files /
  // search / chat / log) with GitHub + Packages at its bottom, the
  // search view (rows, badge, empty states, jump-to-line), and the
  // divider's hover-only swap button. No CTAN, no project management
  // (dashboard.cjs / projects.cjs own those).
  "layout.cjs",
  "dashboard.cjs",
  "github.cjs",
  "firefox.cjs",
  // The OPFS layout: settings + thumbnails live in artifacts/<id>/, not in
  // the content folders. Seeds an old-layout project (meta + preview inside
  // projects/<id>/) and checks the transparent migration plus the new layout
  // for fresh projects. No compiles — the engine is never needed.
  "artifacts.cjs",
  // The incremental builds: the pipeline reuses the previous build's
  // .aux/.bcf/.bbl and skips the bibliography step when its inputs are
  // unchanged (both biber and bibtex8), and the page's OPFS build cache
  // reuses an unchanged build's PDF without running the engine. Installs
  // biblatex through the modal (the classic bibtex8 path needs no install).
  "incremental.cjs",
  // The bottom-zone chat against the LAN WebGPU engine (the default
  // backend): the drawer UX, a streamed reply over the postMessage wire,
  // active-file context, agentic tools (list_files, apply_edit
  // accept/reject), stop/clear, the settings modal with the engine's
  // live model list, the engine-down fallback, and the API endpoint
  // backend (user address + key, called straight from the page) checked
  // against a local mock SSE server. The first round cold-downloads the
  // model weights (minutes, on the software WebGPU adapter in headless),
  // so this is the slowest suite.
  "chat.cjs",
  // The babel language auto-fix: a clean-store Portuguese document hits
  // "Unknown option 'portuguese'", the editor finds the babel-* tlpkg that
  // ships the .ldf, installs it, restarts the engine, and recompiles. Pulls
  // the package database plus one container from CTAN.
  "babel-pt.cjs",
  // The first-run default package sweep (the only suite that opts in):
  // the heaviest one — a fresh profile pulls the package database plus
  // 18 containers from CTAN — so it runs last.
  "defaults.cjs",
];
let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    failed++;
    console.log(`--- ${suite} failed (exit ${res.status})`);
  }
}
console.log(
  failed === 0 ? "\nALL E2E SUITES PASSED" : `\n${failed} SUITE(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
