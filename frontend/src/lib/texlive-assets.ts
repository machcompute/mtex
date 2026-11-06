// Disk cache for the pinned busytex WASM release assets (see
// /api/texlive/[name]). The assets are immutable (pinned release tag), so
// once downloaded they are served from .texlive-cache forever — for the
// current release. Bumping the pin (RELEASE_BASE in texlive-release.ts)
// invalidates the whole directory: a .release marker file holds the base
// URL, and on a mismatch the cache is wiped and re-downloaded, so a new
// pin can never serve a mixed-version asset set.
//
// The cache lives here (not in the route) so the package store can reuse it
// to read the engine's basic-tree file list (texlive-basic.js embeds it)
// without duplicating the download logic.

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { RELEASE_BASE } from "./texlive-release";

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

// The cache is keyed by the pinned release, not by the individual assets:
// the engine needs all of them from the SAME build (a .js from one pin and
// a .data from another is exactly the mixed set that crashed the
// data-package preload on 2026-11-04, when the pin moved while the browser
// held the old URLs under a 1-year immutable cache). The .release marker
// holds the base URL of the release the files in the cache came from; a
// mismatch wipes the directory. ensureAsset() awaits this before anything
// else, so no download can start before the cache is known consistent.
let releaseCheck: Promise<void> | null = null;
function ensureRelease(): Promise<void> {
  if (!releaseCheck) {
    releaseCheck = (async () => {
      const dir = cacheDir();
      const marker = path.join(dir, ".release");
      let current: string | null = null;
      try {
        current = await readFile(marker, "utf8");
      } catch {
        // no marker yet — either a first run or a cache predating the
        // marker; trust the files already there and just stamp them
      }
      if (current === RELEASE_BASE) return;
      if (current !== null) {
        console.log(
          `[texlive] release changed to ${RELEASE_BASE}; wiping cache ${dir}`,
        );
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
      }
      await writeFile(marker, RELEASE_BASE);
    })();
  }
  return releaseCheck;
}

// One in-flight download per asset: concurrent first requests await the
// same promise instead of racing on the same temp file.
const downloads = new Map<string, Promise<string>>();

/** Resolve the local path of a cached asset, downloading it on first use. */
export async function ensureAsset(name: string): Promise<string> {
  await ensureRelease();
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
