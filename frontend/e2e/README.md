# E2E tests

Browser-only end-to-end tests for the LaTeX editor, driven by a headless
Chromium via `playwright-core` (no Playwright driver install, no browser
download — we point at a system Chromium).

## Running

```
npm run test:e2e            # all suites
node e2e/folder.cjs         # one suite: recursive folder upload
node e2e/rename.cjs         # one suite: nested-file rename / move
node e2e/regression.cjs     # one suite: compile, citations, network audit, vendored packages
node e2e/firefox.cjs        # one suite: folder picker button flow in real Firefox
```

Prerequisites:

- `npm install` in `frontend/` (brings in `playwright-core`).
- Both servers up: the Next.js frontend (`npm run dev`, :3000) **and** the
  Go backend (`go run .` in `backend/`, :8080) — the frontend proxies
  `/api/texlive/` to it, and the engine cannot load without it.
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
~72 MB texlive package through the backend, which then serves it from
`backend/texlive-cache/`.

## What the suites cover

- **folder.cjs** — drops a synthetic folder (`paper/doc.tex`,
  `paper/figs/logo.png`) onto the file panel: panel rows and indentation,
  first text file opened, main-file switch, compile with a nested
  `\includegraphics` path, image binary preview, localStorage persistence.
  Then real directory drags over CDP: recursive import past Chromium's
  100-entry `readEntries` batch, top folder stripped, two folders dropped
  together keeping their names, and an empty folder explaining itself.
- **rename.cjs** — nested-file rename: in-place rename keeps folder depth,
  rename moves between folders/roots, invalid paths are rejected,
  localStorage keys follow.
- **regression.cjs** — default project compiles with bibtex citations
  resolved (no `??`), a network audit proves the app stays browser-only
  (no POST/PUT, only `/api/texlive/`, no foreign origins beyond the Monaco
  CDN and `blob:`), and the vendored packages (pulled by
  `scripts/sync-texlive.sh` into `public/texmf-extra/`) work:
  caption/subcaption renders subfigures and `\subref`, algorithm2e compiles
  a numbered, ruled algorithm with its `\ref` resolved, and the essentials
  set (booktabs, xcolor, mathtools, siunitx, enumitem, fontspec) compiles —
  including the one-time install of the extra TeX tree into the worker's
  FS root and its persistence across compiles (no re-install on the second
  compile).
- **firefox.cjs** — the folder *button* in a real Firefox. Firefox honors
  `webkitdirectory` (MDN: supported; CanIUse: Firefox 50+), so the button
  opens a native folder picker; the suite drives the whole flow — click
  button → picker on the `webkitdirectory` input → select an on-disk
  directory → import with structure → compile.

Suites exit non-zero on any failed check, so `run.cjs` (and CI) can rely on
the exit code.
