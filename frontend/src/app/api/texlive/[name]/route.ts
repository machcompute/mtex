// Same-origin server for the busytex WASM engine assets (full TeX Live 2026
// compiled to WebAssembly), downloaded on first request from the pinned
// release and cached on disk.
//
// The pinned release is Texlyre's busytex build of TeX Live 2026
// (github.com/TeXlyre/texlyre-busytex-build). Its texmf tree ships as three
// emscripten data packages; the worker preloads texlive-basic and pulls the
// other two on demand when a \usepackage resolves to them, so the map below
// must cover all of them (plus the standalone biber module).
//
// The worker loads busytex.js and the data-package .js files with
// importScripts(), which browsers only allow for the worker's own origin —
// it therefore cannot fetch them directly from github.com. The .wasm also
// needs the application/wasm content type (GitHub serves octet-stream) for
// streaming compilation, so the assets must come from us, not the CDN.
//
// The assets are immutable (pinned release tag): the response carries a
// long-lived Cache-Control, so the ~93 MB basic .data package is downloaded
// once — from the web on first request, from the local cache after.
// Range requests are supported the way the previous Go backend did.

import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

// (Node.js runtime is the default; the `runtime` segment config is not
// allowed with this project's cacheComponents setup.)

const RELEASE_BASE =
  "https://github.com/TeXlyre/texlyre-busytex-build/releases/download/build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1";

// The fixed asset set the worker may load; anything else is rejected.
const ASSETS: Record<string, string> = {
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
  // The biber module: the worker importScripts() its loader on start (it
  // defines the class only), and biber.js/.wasm/.data load lazily on the
  // first biber run.
  "busytex_biber.js": `${RELEASE_BASE}/busytex_biber.js`,
  "biber.js": `${RELEASE_BASE}/biber.js`,
  "biber.wasm": `${RELEASE_BASE}/biber.wasm`,
  "biber.data": `${RELEASE_BASE}/biber.data`,
};

function cacheDir() {
  return (
    process.env.TEXLIVE_CACHE_DIR ?? path.join(process.cwd(), ".texlive-cache")
  );
}

// The types matter: importScripts() refuses non-JavaScript types for the
// .js files, and the .wasm must be application/wasm to stream-compile.
function assetType(name: string): string {
  if (name.endsWith(".js")) return "text/javascript";
  if (name.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

// One in-flight download per asset: concurrent first requests await the
// same promise instead of racing on the same temp file.
const downloads = new Map<string, Promise<string>>();

async function ensureAsset(name: string): Promise<string> {
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

function streamFile(file: string, start: number, end?: number): ReadableStream {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!ASSETS[name]) {
    return new Response("unknown texlive asset", { status: 404 });
  }

  let file: string;
  try {
    file = await ensureAsset(name);
  } catch (err) {
    console.error(`[texlive] download failed:`, err);
    return new Response(`upstream fetch failed: ${String(err)}`, {
      status: 502,
    });
  }

  const info = await stat(file);
  const size = info.size;
  const etag = `"${name}-${size}-${info.mtimeMs}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const headers = new Headers({
    "content-type": assetType(name),
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    etag,
  });

  // Single-range support (bytes=a-b, bytes=a-, bytes=-s); anything more
  // complex is ignored and the whole file is served.
  const range = request.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const suffix = m[1] === "" && m[2] !== "";
    const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1] || 0);
    const end = suffix ? size - 1 : Math.min(Number(m[2] || size - 1), size - 1);
    if (start >= size || start > end) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(streamFile(file, start, end), { status: 206, headers });
  }

  headers.set("content-length", String(size));
  return new Response(streamFile(file, 0), { status: 200, headers });
}
// Next.js derives HEAD automatically from GET (same headers, no body).
