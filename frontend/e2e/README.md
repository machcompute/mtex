# E2E tests

Browser-only end-to-end tests for the LaTeX editor, driven by a headless
Chromium via `playwright-core` (no Playwright driver install, no browser
download — we point at a system Chromium).

## Running

```
npm run test:e2e            # all suites
node e2e/folder.cjs         # one suite: recursive folder upload
node e2e/rename.cjs         # one suite: nested-file rename / move
node e2e/regression.cjs     # one suite: compile, citations, network audit, CTAN packages
node e2e/biber.cjs          # one suite: biber with a subdirectory .bib
node e2e/fixes.cjs          # one suite: the bug-fix regression set
node e2e/projects.cjs       # one suite: project create/switch/delete (OPFS)
node e2e/github.cjs         # one suite: PAT-based GitHub import (stubbed API)
node e2e/firefox.cjs        # one suite: folder picker button flow in real Firefox
```

Prerequisites:

- `npm install` in `frontend/` (brings in `playwright-core`).
- The Next.js frontend up (`npm run dev`, :3000). It serves the engine
  assets itself through `/api/texlive/` (downloading them from the pinned
  busytex release on first request and caching them in `.texlive-cache/`),
  and the engine cannot load without that route.
- A headless Chromium. The default is
  `/home/lukas/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
  override with `CHROME_EXECUTABLE=/path/to/chrome node e2e/run.cjs`.
- A headless Firefox for `firefox.cjs` (one-time:
  `npx playwright-core install firefox`); override with
  `FIREFOX_EXECUTABLE=/path/to/firefox`.
- `APP_URL` env var if the frontend is not at `http://localhost:3000`.

Each suite launches a fresh disposable Chromium profile under the OS temp
dir (`mkdtemp`) and removes it on exit, so nothing is written into the repo
and a crashed run can't poison the next one. The first run downloads the
engine assets from the web into `.texlive-cache/`, which the route then
serves from disk — the browser load needs `busytex.js/.wasm` plus the
`texlive-basic` data package (~130 MB total).

`regression.cjs` and `biber.cjs` additionally need outbound access to
CTAN: they install the packages their documents use through the Packages
modal, into the browser's own OPFS store (`ctan/` — see
`src/lib/ctan-store.ts`). Each fresh profile's store is empty, so every
run downloads the ~20 MB package database (`texlive.tlpdb`) plus one
tlnet container per install through the stateless `/api/ctan/` proxy.

## What the suites cover

Suites that need a pre-saved state use the `seedProject`/`readProject`
helpers in `helpers.cjs`: they write/read the project folders straight
into the browser's OPFS (`projects/<id>/` + `project.json`) and set the
`homehub-active-project-v1` localStorage key, so a reload loads exactly
what the test seeded — and checks compare what the app actually
persisted, not what it had in memory.

- **folder.cjs** — drops a synthetic folder (`paper/doc.tex`,
  `paper/figs/logo.png`) onto the file panel: panel rows and indentation,
  first text file opened, main-file switch, compile with a nested
  `\includegraphics` path, image binary preview, OPFS persistence.
  Then real directory drags over CDP: recursive import past Chromium's
  100-entry `readEntries` batch, top folder stripped, two folders dropped
  together keeping their names, and an empty folder explaining itself.
- **rename.cjs** — nested-file rename: in-place rename keeps folder depth,
  rename moves between folders/roots, invalid paths are rejected, and the
  OPFS project files follow.
- **regression.cjs** — default project compiles with bibtex citations
  resolved (no `??`), a network audit proves the app stays browser-only
  (no POST/PUT, no server package API, only its own `/api/texlive/` and
  stateless `/api/ctan/` proxy endpoints, no foreign origins beyond the
  Monaco CDN and `blob:`), and the on-demand CTAN packages work: they are
  installed through the Packages modal (the only install path — the store
  is the browser's own OPFS), and afterwards caption/subcaption renders
  subfigures and `\subref`, algorithm2e compiles a numbered, ruled
  algorithm with its `\ref` resolved, the essentials set (booktabs, xcolor,
  mathtools, siunitx, enumitem, fontspec) compiles, and pslatex+pgfplots+TikZ
  compiles with its Times fonts. On the clean store it also asserts the
  dependency resolver is causal: installing pgfplots pulls in pgf,
  listings, xcolor, pdfcolmk (its `\RequirePackage` chain), installing
  algorithm2e pulls in ifoddpage and relsize, and doc-file references inside
  containers do NOT cascade (no pstricks/biblatex). The list covers the
  packages' own dependencies too (times/zapfchan, whose metrics the
  xdvipdfmx font chain needs; the tlpdb has no dependency metadata, so the
  store only pulls what the installed packages' code asks for). It also
  proves the client-store mechanism itself: the installed files ride the
  compile payload at their engine paths (`/texlive/texmf-dist/...`), and a
  `\usepackage` the store doesn't provide would trigger the data-tree
  fallback (the ~540 MB recommended+extra `.data` download), which the
  suite asserts never happens.
- **biber.cjs** — biber with a subdirectory `.bib` (the thesis layout:
  `main.tex` at the root, the data source at `bib/references.bib`).
  biblatex is installed through the Packages modal first, which also
  asserts the client resolver auto-pulls `logreq` (biblatex's
  `\RequirePackage`, past the old server resolver's 512 KB scan cap). Then
  the thesis project compiles: biber is invoked, finds
  `bib/references.bib` (the vendored loader keeps the subdirectory; the
  release loader flattened paths to basenames and biber failed with
  "Cannot find 'bib/references.bib'"), and the cited entry reaches the
  PDF.
- **fixes.cjs** — the bug-fix regression set, one section per fixed
  behavior: rename-back without stale Monaco models, name validation,
  no-main-file handling, mid-compile edits, auto-recompile cancel,
  bibtex in `\include`d files, synctex navigation into nested and
  unopened files, scroll restoration on recompile, editor-pane and real
  folder drops (existing files never overwritten, non-UTF-8 bytes kept
  binary), storage-failure notice, and engine load failure + recovery.
- **projects.cjs** — the Projects menu: first-run default project,
  create with numbered names, switching keeps projects isolated (with the
  marker edit persisted per project), rename persists across reload,
  delete with confirm dialog (inactive and active), delete-to-empty
  creating a fresh default, and outside-click close.
- **github.cjs** — the serverless GitHub import with `api.github.com`
  stubbed by route interception (CORS included, since the app sends a
  bearer token cross-origin): the PAT is persisted and sent, the
  repo/branch browser preselects the default branch, and a pull creates a
  project named for the repo — dotfiles are filtered out of the tree
  listing before anything is downloaded (their blobs are never requested),
  binaries are kept byte-for-byte, and no tarball
  (`codeload.github.com`) traffic happens. A re-pull of the same repo from
  another branch replaces that project's files (stale paths deleted, new
  branch recorded) instead of creating a duplicate row.
- **firefox.cjs** — the folder *button* in a real Firefox. Firefox honors
  `webkitdirectory` (MDN: supported; CanIUse: Firefox 50+), so the button
  opens a native folder picker; the suite drives the whole flow — click
  button → picker on the `webkitdirectory` input → select an on-disk
  directory → import with structure → compile.

Suites exit non-zero on any failed check, so `run.cjs` (and CI) can rely on
the exit code.
