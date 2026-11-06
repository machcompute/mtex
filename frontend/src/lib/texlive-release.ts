// The pinned busytex WASM release — single source of truth, shared by the
// server (src/lib/texlive-assets.ts downloads the assets from RELEASE_BASE)
// and the client (src/lib/busytex.ts and src/lib/ctan-store.ts stamp every
// /api/texlive/* URL with RELEASE_ID).
//
// The stamp exists because the route serves /api/texlive/* with
// `cache-control: public, max-age=31536000, immutable`. When the pin moved
// from the official busytex build to the TeXlyre TeX Live 2026 build
// (2026-11-04), the URLs did not change — and the editor's browser kept
// serving its cached, now-inconsistent older set for a year, crashing the
// engine's data-package preload. Bumping the pin changes RELEASE_ID, which
// changes every asset URL, so the browser refetches a consistent set. The
// query survives the pipeline's `.js` → `.data` rewrite
// (BusytexPipeline.locateFile) and the route ignores it.
//
// To bump the pin: change RELEASE_BASE only; RELEASE_ID derives from it.
export const RELEASE_BASE =
  "https://github.com/TeXlyre/texlyre-busytex-build/releases/download/build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1";

// The release tag — appended to every /api/texlive/* URL as ?v=.
export const RELEASE_ID = RELEASE_BASE.slice(RELEASE_BASE.lastIndexOf("/") + 1);
