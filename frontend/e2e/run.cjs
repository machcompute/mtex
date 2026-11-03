// Runs all e2e suites in order; exits non-zero if any check fails.
// See README.md for prerequisites (both servers must be up).
const { spawnSync } = require("child_process");
const path = require("path");

const suites = [
  "folder.cjs",
  "rename.cjs",
  "regression.cjs",
  "fixes.cjs",
  "projects.cjs",
  "github.cjs",
  "firefox.cjs",
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
