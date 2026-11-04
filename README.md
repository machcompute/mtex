# HomeHub

Browser-only LaTeX editor: full TeX Live 2026 compiled to WebAssembly
(Texlyre's busytex build) runs in a worker, with a Next.js frontend that
serves the engine assets and a server-side CTAN package store. No separate
backend process.

| Folder      | Stack                                    | Notes                                  |
| ----------- | ---------------------------------------- | -------------------------------------- |
| `frontend/` | Next.js (App Router), TypeScript, Tailwind | Dev server on `:3000`                |

## Getting started

```sh
cd frontend
npm install   # already done by create-next-app
npm run dev   # http://localhost:3000
```

The engine assets (`busytex.js/.wasm`, the `texlive-*` data packages,
biber) are not vendored in the repo: the `GET /api/texlive/[name]` route
handler downloads them from the pinned busytex release on first request and
caches them in `frontend/.texlive-cache/` (override with
`TEXLIVE_CACHE_DIR`). The worker needs same-origin URLs for
`importScripts()` and an `application/wasm` content type, so the assets
always come through this route — never directly from the CDN.

The engine preloads only its `texlive-basic` tree. Packages a document
`\usepackage`s beyond that are pulled on demand from CTAN: the **Packages**
button in the editor installs them into a server-side store
(`frontend/.texlive-extra/`, gitignored — a CTAN tlnet container is
downloaded, verified against the package database, and extracted into a TDS
tree), and at compile time the engine's kpathsea fetches each needed file
from the store through `/api/texlive-remote/`. The store persists across
sessions and restarts; removing a package deletes exactly the files it
added.

## API

- `GET /api/texlive/[name]` → one of the pinned engine assets, with
  `Cache-Control: immutable` and single-range support; downloaded from the
  busytex GitHub release on first request, served from the local cache
  afterwards.
- `GET /api/packages` → the installed packages.
- `POST /api/packages` (`{"name": …}`) → install a package from CTAN.
- `DELETE /api/packages/[name]` → remove an installed package.
- `GET /api/packages/search?query=…` → search the CTAN package database
  (the tlnet `texlive.tlpdb`, cached on first use).
- `GET /api/texlive-remote/[format]/[name]` → the engine's on-demand file
  endpoint (synchronous XHR from the worker's kpathsea wrapper; 404s are
  cached as misses for the engine's lifetime, so the editor restarts the
  engine after a package change).
