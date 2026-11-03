// GitHub import (Stage 2): PAT-based, fully serverless. The app talks to
// api.github.com directly from the browser, so this suite stubs the API with
// Playwright route interception (emulating GitHub's CORS, including the
// preflight OPTIONS the custom Authorization header triggers) and checks:
// the token is persisted and sent as a bearer header; the repo/branch
// browser auto-selects the default branch; a pull creates a project named
// for the repo; junk (dotfiles) is filtered out of the tree BEFORE anything
// is downloaded (its blob is never requested); binaries are kept
// byte-for-byte; no tarball (codeload.github.com) traffic happens; and a
// re-pull of the same repo — from another branch — REPLACES that project's
// files (stale paths deleted) instead of creating a duplicate.
const fs = require("fs");
const { Runner, PNG_PATH, readProject } = require("./helpers.cjs");

const PNG = fs.readFileSync(PNG_PATH);
const PNG_BYTES = Array.from(PNG);

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Pulled from GitHub.",
  "\\end{document}",
].join("\n");
const MAIN_TEX_DEV = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Pulled from the dev branch.",
  "\\end{document}",
].join("\n");
const INNER_TEX = "Inner content.\n";
const SECOND_TEX = "Second file on the dev branch.\n";
const GITIGNORE = "*.aux\n*.log\n";

// Stub blob bytes, keyed by the sha the tree responses reference.
const BLOBS = {
  "sha-main": Buffer.from(MAIN_TEX, "utf8"),
  "sha-main-dev": Buffer.from(MAIN_TEX_DEV, "utf8"),
  "sha-inner": Buffer.from(INNER_TEX, "utf8"),
  "sha-second": Buffer.from(SECOND_TEX, "utf8"),
  "sha-png": PNG,
  "sha-gitignore": Buffer.from(GITIGNORE, "utf8"),
};

// main: three kept files + a dotfile (junk) + the tree entries themselves.
const TREE_MAIN = {
  sha: "tree-main",
  url: "https://api.github.com/repos/testuser/latex-repo/git/trees/tree-main",
  tree: [
    { path: ".gitignore", mode: "100644", type: "blob", sha: "sha-gitignore", size: GITIGNORE.length },
    { path: "figs", mode: "040000", type: "tree", sha: "tree-figs" },
    { path: "figs/logo.png", mode: "100644", type: "blob", sha: "sha-png", size: PNG.length },
    { path: "main.tex", mode: "100644", type: "blob", sha: "sha-main", size: MAIN_TEX.length },
    { path: "sub", mode: "040000", type: "tree", sha: "tree-sub" },
    { path: "sub/inner.tex", mode: "100644", type: "blob", sha: "sha-inner", size: INNER_TEX.length },
  ],
  truncated: false,
};
// dev: inner.tex is gone, second.tex is new — proves a re-pull replaces.
const TREE_DEV = {
  sha: "tree-dev",
  url: "https://api.github.com/repos/testuser/latex-repo/git/trees/tree-dev",
  tree: [
    { path: "figs", mode: "040000", type: "tree", sha: "tree-figs" },
    { path: "figs/logo.png", mode: "100644", type: "blob", sha: "sha-png", size: PNG.length },
    { path: "main.tex", mode: "100644", type: "blob", sha: "sha-main-dev", size: MAIN_TEX_DEV.length },
    { path: "second.tex", mode: "100644", type: "blob", sha: "sha-second", size: SECOND_TEX.length },
  ],
  truncated: false,
};

// GitHub answers api.github.com with CORS * so browsers may call it directly;
// the stub must too, or the preflight for the Authorization header fails.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, accept, x-github-api-version",
};
const okCors = { "access-control-allow-origin": "*" };
const preflight = (route) =>
  route.fulfill({ status: 204, contentType: "text/plain", headers: CORS });

const blobHits = {};
let codeloadHits = 0;
let userAuthHeader = null;

async function stubGithub(r) {
  // Catch-all first (routes run in reverse registration order, so it is the
  // LAST one consulted): any GitHub path the stub doesn't model fails loudly
  // instead of leaking to the network.
  await r.page.route("**/api.github.com/**", (route) => {
    const req = route.request();
    console.error(
      `[stub] UNMATCHED ${req.method()} ${req.url()} (codeload hits so far: ${codeloadHits})`,
    );
    route.abort();
  });
  // A tarball (codeload) download would defeat the file-by-file design.
  await r.page.route("**/codeload.github.com/**", (route) => {
    codeloadHits++;
    console.error(`[stub] CODELOAD REQUEST: ${route.request().url()}`);
    route.abort();
  });
  await r.page.route("**/api.github.com/user", (route) => {
    if (route.request().method() === "OPTIONS") return preflight(route);
    userAuthHeader = route.request().headers()["authorization"] ?? null;
    return route.fulfill({
      contentType: "application/json",
      headers: okCors,
      body: JSON.stringify({ login: "testuser", name: "Test User", avatar_url: "" }),
    });
  });
  await r.page.route("**/api.github.com/user/repos*", (route) => {
    if (route.request().method() === "OPTIONS") return preflight(route);
    return route.fulfill({
      contentType: "application/json",
      headers: okCors,
      body: JSON.stringify([
        {
          full_name: "testuser/latex-repo",
          name: "latex-repo",
          owner: { login: "testuser" },
          default_branch: "main",
          private: false,
          pushed_at: "2026-11-03T00:00:00Z",
        },
      ]),
    });
  });
  await r.page.route(
    "**/api.github.com/repos/testuser/latex-repo/branches*",
    (route) => {
      if (route.request().method() === "OPTIONS") return preflight(route);
      return route.fulfill({
        contentType: "application/json",
        headers: okCors,
        body: JSON.stringify([{ name: "main" }, { name: "dev" }]),
      });
    },
  );
  await r.page.route(
    "**/api.github.com/repos/testuser/latex-repo/git/trees/*",
    (route) => {
      if (route.request().method() === "OPTIONS") return preflight(route);
      const ref = route.request().url().split("/git/trees/")[1].split("?")[0];
      return route.fulfill({
        contentType: "application/json",
        headers: okCors,
        body: JSON.stringify(ref === "dev" ? TREE_DEV : TREE_MAIN),
      });
    },
  );
  await r.page.route(
    "**/api.github.com/repos/testuser/latex-repo/git/blobs/*",
    (route) => {
      if (route.request().method() === "OPTIONS") return preflight(route);
      const sha = route.request().url().split("/git/blobs/")[1];
      blobHits[sha] = (blobHits[sha] ?? 0) + 1;
      const bytes = BLOBS[sha];
      if (!bytes) {
        console.error(`[stub] unknown blob sha ${sha}`);
        return route.abort();
      }
      return route.fulfill({
        contentType: "application/octet-stream",
        headers: okCors,
        body: bytes,
      });
    },
  );
}

const NAME_INPUT = 'input[title="Project name (saved in your browser)"]';
const PAT_KEY = "homehub-github-pat-v1";
const nameValue = (r) =>
  r.page.evaluate((sel) => document.querySelector(sel)?.value ?? "", NAME_INPUT);
const openMenu = async (r) => {
  await r.page.locator('button[data-action="projects"]').click();
  await r.page.waitForSelector('[data-menu="projects"] div[data-project]', {
    timeout: 10000,
  });
};
// Wait until the branch select offers `dev` (it shows "Loading…" first).
const waitBranches = async (r, sel) => {
  for (let i = 0; i < 40; i++) {
    const opts = await sel.locator("option").allTextContents();
    if (opts.includes("dev")) return opts;
    await r.page.waitForTimeout(250);
  }
  return [];
};

const r = new Runner("github");

(async () => {
  await r.start();
  await stubGithub(r);
  await r.goto();
  await r.waitReady();
  r.ok(
    "engine ready",
    /^Ready\.$/.test(((await r.status.textContent()) || "").trim()),
  );

  r.ok(
    "no saved token before first open",
    (await r.page.evaluate((k) => localStorage.getItem(k), PAT_KEY)) === null,
  );

  // --- open the modal: the PAT step -----------------------------------------
  await r.page.locator('button[data-action="github"]').click();
  await r.page.waitForSelector('[data-modal="github"]', { timeout: 10000 });
  r.ok(
    "PAT step shown (no saved token)",
    (await r.page.locator('input[data-gh="pat"]').count()) === 1 &&
      (await r.page.locator('[data-gh="login"]').count()) === 0,
  );

  // --- sign in with the (stubbed) PAT ----------------------------------------
  await r.page.locator('input[data-gh="pat"]').fill("ghp_testtoken");
  await r.page.locator('button[data-gh="save"]').click();
  await r.page.locator('[data-gh="login"]').waitFor({ timeout: 15000 });
  r.ok(
    "signed in as the stubbed user",
    ((await r.page.locator('[data-gh="login"]').textContent()) || "").trim() ===
      "testuser",
  );
  r.ok(
    "token persisted to localStorage",
    (await r.page.evaluate((k) => localStorage.getItem(k), PAT_KEY)) ===
      "ghp_testtoken",
  );
  r.ok(
    "API requests carry the bearer token",
    userAuthHeader === "Bearer ghp_testtoken",
    String(userAuthHeader),
  );
  r.ok(
    "no error banner after sign-in",
    (await r.page.locator('[data-gh="error"]').count()) === 0,
  );

  // --- browse: repo + branches ------------------------------------------------
  const repoSel = r.page.locator('select[data-gh="repo"]');
  const branchSel = r.page.locator('select[data-gh="branch"]');
  r.ok(
    "repo listed",
    (await repoSel.locator("option").allTextContents()).includes(
      "testuser/latex-repo",
    ),
  );
  const branchOpts = await waitBranches(r, branchSel);
  r.ok(
    "branches loaded",
    branchOpts.includes("main") && branchOpts.includes("dev"),
    JSON.stringify(branchOpts),
  );
  r.ok(
    "default branch preselected",
    (await branchSel.inputValue()) === "main",
    String(await branchSel.inputValue()),
  );
  r.ok(
    "fresh repo offers a fresh pull",
    /Pull into a project/.test(
      (await r.page.locator('button[data-gh="pull"]').textContent()) || "",
    ),
  );

  // --- pull ---------------------------------------------------------------------
  await r.page.locator('button[data-gh="pull"]').click();
  await r.page.waitForSelector('[data-modal="github"]', {
    state: "detached",
    timeout: 30000,
  });
  await r.page.waitForFunction(
    (sel) => document.querySelector(sel)?.value === "latex-repo",
    NAME_INPUT,
    { timeout: 15000 },
  );
  r.ok("project named for the repo", (await nameValue(r)) === "latex-repo");
  r.ok(
    "pull notice counts files and the skipped dotfile",
    /Pulled 3 files from testuser\/latex-repo/.test(
      (await r.page.locator("[data-notice]").first().textContent().catch(() => "")) ||
        "",
    ) &&
      /1 dotfile skipped/.test(
        (await r.page.locator("[data-notice]").first().textContent().catch(() => "")) ||
          "",
      ),
    String(
      (await r.page.locator("[data-notice]").first().textContent().catch(() => "")) ||
        "",
    ),
  );

  // Panel rows for the active (pulled) project.
  r.ok("main.tex listed", (await r.page.locator("li", { hasText: "main.tex" }).count()) > 0);
  r.ok("figs/logo.png listed", (await r.page.locator("li", { hasText: "logo.png" }).count()) > 0);
  r.ok("sub/inner.tex listed", (await r.page.locator("li", { hasText: "inner.tex" }).count()) > 0);
  r.ok(
    ".gitignore NOT listed",
    (await r.page.locator("li", { hasText: ".gitignore" }).count()) === 0,
  );
  r.ok(
    "main.tex opened as the active tab",
    (await r.page.evaluate(
      () => document.querySelector("[data-active]")?.getAttribute("data-tab"),
    )) === "main.tex",
  );

  // Network: exactly the three kept blobs, never the junk one, no tarball.
  r.ok(
    "kept blobs each fetched once",
    blobHits["sha-main"] === 1 &&
      blobHits["sha-png"] === 1 &&
      blobHits["sha-inner"] === 1,
    JSON.stringify(blobHits),
  );
  r.ok(
    "junk blob never requested",
    (blobHits["sha-gitignore"] ?? 0) === 0,
    JSON.stringify(blobHits),
  );
  r.ok("no codeload (tarball) traffic", codeloadHits === 0, `${codeloadHits} hit(s)`);

  // --- compile the pulled project -------------------------------------------------
  const status = await r.recompile();
  r.ok("pulled project compiles", /Compiled in \d+ ms/.test(status), status);
  r.ok("pulled doc text in PDF", /Pulled from GitHub/.test(await r.pdfText()));

  // --- OPFS: what the app actually persisted -------------------------------------
  const p1 = await readProject(r);
  r.ok(
    "OPFS: all three files persisted",
    !!p1 &&
      ["main.tex", "figs/logo.png", "sub/inner.tex"].every(
        (k) => p1.files[k] !== undefined,
      ),
    p1 ? JSON.stringify(Object.keys(p1.files)) : "(null)",
  );
  r.ok("OPFS: dotfile not persisted", !!p1 && p1.files[".gitignore"] === undefined);
  r.ok(
    "OPFS: png byte-for-byte",
    !!p1 && p1.files["figs/logo.png"]?.bytes?.join(",") === PNG_BYTES.join(","),
  );
  r.ok("OPFS: main.tex text", !!p1 && p1.files["main.tex"] === MAIN_TEX);
  r.ok(
    "OPFS: github source recorded",
    !!p1 &&
      p1.meta.source?.kind === "github" &&
      p1.meta.source.owner === "testuser" &&
      p1.meta.source.repo === "latex-repo" &&
      p1.meta.source.branch === "main",
    p1 ? JSON.stringify(p1.meta.source) : "(null)",
  );
  r.ok(
    "OPFS: repo name + main path",
    !!p1 && p1.meta.name === "latex-repo" && p1.meta.mainPath === "main.tex",
  );
  const latexId = p1 ? p1.id : null;

  // --- re-pull from another branch: replace, never duplicate -----------------------
  await r.page.locator('button[data-action="github"]').click();
  await r.page.waitForSelector('[data-modal="github"]', { timeout: 10000 });
  await r.page.locator('[data-gh="login"]').waitFor({ timeout: 15000 });
  r.ok(
    "re-opened modal auto-signs-in from the saved token",
    ((await r.page.locator('[data-gh="login"]').textContent()) || "").trim() ===
      "testuser",
  );
  r.ok(
    "same repo now offers Re-pull",
    /Re-pull/.test(
      (await r.page.locator('button[data-gh="pull"]').textContent()) || "",
    ),
  );
  await waitBranches(r, branchSel);
  await branchSel.selectOption("dev");
  await r.page.locator('button[data-gh="pull"]').click();
  await r.page.waitForSelector('[data-modal="github"]', {
    state: "detached",
    timeout: 30000,
  });
  r.ok("still the repo-named project", (await nameValue(r)) === "latex-repo");

  // saveProject ran inside onPulled, so OPFS is already at the dev state.
  const p2 = await readProject(r);
  r.ok(
    "re-pull keeps the same project id",
    !!p2 && p2.id === latexId,
    p2 ? p2.id : "(null)",
  );
  const keys2 = p2 ? Object.keys(p2.files).sort() : [];
  r.ok(
    "re-pull replaces the file set",
    JSON.stringify(keys2) ===
      JSON.stringify(["figs/logo.png", "main.tex", "second.tex"]),
    JSON.stringify(keys2),
  );
  r.ok(
    "re-pull deleted the stale file",
    !!p2 && p2.files["sub/inner.tex"] === undefined,
    JSON.stringify(keys2),
  );
  r.ok("re-pull wrote the dev content", !!p2 && p2.files["main.tex"] === MAIN_TEX_DEV);
  r.ok(
    "re-pull recorded the branch",
    !!p2 && p2.meta.source?.branch === "dev",
    p2 ? JSON.stringify(p2.meta.source) : "(null)",
  );

  // Exactly one "latex-repo" row in the Projects menu (and the default
  // project is untouched next to it).
  await openMenu(r);
  const rowNames = await r.page
    .locator('[data-menu="projects"] div[data-project] span.truncate')
    .allTextContents();
  r.ok(
    "menu: a single latex-repo row (no duplicate)",
    rowNames.filter((n) => n === "latex-repo").length === 1,
    JSON.stringify(rowNames),
  );
  r.ok(
    "menu: default project untouched",
    rowNames.includes("LaTeX project"),
    JSON.stringify(rowNames),
  );

  r.ok("still no codeload traffic", codeloadHits === 0, `${codeloadHits} hit(s)`);

  console.log(
    r.failures === 0 ? "ALL GITHUB CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
