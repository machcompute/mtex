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
  "dashboard.cjs",
  "github.cjs",
  "firefox.cjs",
  // The OPFS layout: settings + thumbnails live in artifacts/<id>/, not in
  // the content folders. Seeds an old-layout project (meta + preview inside
  // projects/<id>/) and checks the transparent migration plus the new layout
  // for fresh projects. No compiles — the engine is never needed.
  "artifacts.cjs",
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
