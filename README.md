# HomeHub

Browser-only LaTeX editor: full TeX Live 2026 compiled to WebAssembly
(Texlyre's busytex build) runs in a worker, with a Next.js frontend that
serves the engine assets. Everything the user owns — projects and the
installed CTAN packages — lives in the browser's private file system
(OPFS); the server keeps no state. No separate backend process.

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
button in the editor installs them into the browser's own store — the
`ctan/` folder in OPFS (`src/lib/ctan-store.ts`). The install container
(CTAN tlnet `archive/<name>.tar.xz`) is downloaded through the stateless
`/api/ctan/archive/[name]` proxy, verified against the package database
(downloaded and cached the same way through `/api/ctan/tlpdb`), XZ-decompressed
and tar-unpacked in the page, and stored as raw bytes in a TDS tree.
Transitive dependencies are resolved by scanning the installed package's
LaTeX code and pulling in whatever the base tree does not cover. At compile
time the store's files ride the payload at their absolute engine paths
(`/texlive/texmf-dist/...`). The store persists across sessions and restarts;
removing a package deletes exactly the files it added.

## API

- `GET /api/texlive/[name]` → one of the pinned engine assets, with
  `Cache-Control: immutable` and single-range support; downloaded from the
  busytex GitHub release on first request, served from the local cache
  afterwards.
- `GET /api/ctan/tlpdb` → the CTAN package database (tlnet `texlive.tlpdb`)
  relayed from the mirrors; the browser caches it in OPFS after the first
  fetch.
- `GET /api/ctan/archive/[name]` → one CTAN install container
  (`tlnet/archive/<name>.tar.xz`) relayed from the mirrors.
  Both routes are stateless byte pipes: CTAN mirrors send no CORS headers,
  so the browser cannot reach them directly. All search/install/remove logic
  runs client-side (`src/lib/ctan-store.ts`), against the browser's OPFS
  store.
