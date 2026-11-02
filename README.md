# HomeHub

Browser-only LaTeX editor: full TeX Live compiled to WebAssembly (busytex)
runs in a worker, with a Next.js frontend that also serves the engine
assets. No separate backend process.

| Folder      | Stack                                    | Notes                                  |
| ----------- | ---------------------------------------- | -------------------------------------- |
| `frontend/` | Next.js (App Router), TypeScript, Tailwind | Dev server on `:3000`                |

## Getting started

```sh
cd frontend
npm install   # already done by create-next-app
npm run dev   # http://localhost:3000
```

The engine assets (`busytex.js/.wasm`, `texlive-basic.js/.data`, ~96 MB)
are not vendored in the repo: the `GET /api/texlive/[name]` route handler
downloads them from the pinned busytex release on first request and caches
them in `frontend/.texlive-cache/` (override with `TEXLIVE_CACHE_DIR`).
The worker needs same-origin URLs for `importScripts()` and an
`application/wasm` content type, so the assets always come through this
route — never directly from the CDN.

## API

- `GET /api/texlive/[name]` → one of the four pinned engine assets, with
  `Cache-Control: immutable` and single-range support; downloaded from the
  busytex GitHub release on first request, served from the local cache
  afterwards.
