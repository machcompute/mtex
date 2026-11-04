// Disk cache for the pinned busytex WASM release assets (see
// /api/texlive/[name]). The assets are immutable (pinned release tag), so
// once downloaded they are served from .texlive-cache forever.
//
// The cache lives here (not in the route) so the package store can reuse it
// to read the engine's basic-tree file list (texlive-basic.js embeds it)
// without duplicating the download logic.

import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";

export const RELEASE_BASE =
  "https://github.com/TeXlyre/texlyre-busytex-build/releases/download/build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1";

// The fixed asset set the worker may load; anything else is rejected.
export const ASSETS: Record<string, string> = {
  // The combined engine (xelatex/pdflatex/luahbtex + bibtex8 + xdvipdfmx +
  // makeindex) and its preloaded TeX Live 2026 basic tree.
  "busytex.js": `${RELEASE_BASE}/busytex.js`,
  "busytex.wasm": `${RELEASE_BASE}/busytex.wasm`,
  "texlive-basic.js": `${RELEASE_BASE}/texlive-basic.js`,
  "texlive-basic.data": `${RELEASE_BASE}/texlive-basic.data`,
  // On-demand data packages: the pipeline's resolver fetches the .js for
  // the whole catalog (a ProvidesPackage scan) and the matching .data only
  // when a compiled document actually uses a package from it.
  "texlive-recommended.js": `${RELEASE_BASE}/texlive-recommended.js`,
  "texlive-recommended.data": `${RELEASE_BASE}/texlive-recommended.data`,
  "texlive-extra.js": `${RELEASE_BASE}/texlive-extra.js`,
  "texlive-extra.data": `${RELEASE_BASE}/texlive-extra.data`,
  // The biber module: biber.js/.wasm/.data load lazily on the first biber
  // run (its loader is the vendored, patched copy in public/busytex/).
  "biber.js": `${RELEASE_BASE}/biber.js`,
  "biber.wasm": `${RELEASE_BASE}/biber.wasm`,
  "biber.data": `${RELEASE_BASE}/biber.data`,
};

export function cacheDir(): string {
  return (
    process.env.TEXLIVE_CACHE_DIR ?? path.join(process.cwd(), ".texlive-cache")
  );
}

// One in-flight download per asset: concurrent first requests await the
// same promise instead of racing on the same temp file.
const downloads = new Map<string, Promise<string>>();

/** Resolve the local path of a cached asset, downloading it on first use. */
export async function ensureAsset(name: string): Promise<string> {
  const dir = cacheDir();
  const dest = path.join(dir, name);
  try {
    await stat(dest);
    return dest;
  } catch {
    // not cached yet — fall through to download
  }
  let p = downloads.get(name);
  if (!p) {
    p = (async () => {
      await mkdir(dir, { recursive: true });
      // A concurrent download may have finished while we waited.
      if ((await stat(dest).catch(() => null)) !== null) return dest;
      const res = await fetch(ASSETS[name]);
      if (!res.ok || !res.body) {
        throw new Error(`upstream ${ASSETS[name]} returned ${res.status}`);
      }
      const tmp = path.join(
        dir,
        `.${name}.part-${process.pid}-${Date.now()}`,
      );
      const out = await open(tmp, "w");
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await out.write(value);
        }
      } finally {
        await out.close();
      }
      await rename(tmp, dest);
      console.log(`[texlive] cached ${name} (${dir})`);
      return dest;
    })().finally(() => downloads.delete(name));
    downloads.set(name, p);
  }
  return p;
}
