// The engine's on-demand package file endpoint (TEXLIVE_REMOTE_ENDPOINT).
//
//   GET /api/texlive-remote/{format}/{name}
//
// The TeX Live 2026 WASM build's kpathsea wrapper intercepts every lookup
// miss and does a SYNCHRONOUS XHR here (30 s timeout, arraybuffer):
//
//   200 + bytes  -> the file is written to the engine's FS and used
//   404          -> cached as a miss for the engine's lifetime
//
// {format} is the kpathsea format number, {name} the file name kpathsea
// looked up (exact name, or a bare stem for fonts — resolved against the
// extensions that format can mean, see src/lib/texlive-packages.ts).
//
// Because misses persist, the engine must be restarted (compiler.dispose()
// in the page) after a package is installed or removed — otherwise a stale
// miss would keep shadowing a file that now exists.

import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { findRemoteFile } from "@/lib/texlive-packages";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ format: string; name: string }> },
) {
  const { format, name } = await params;
  const fmt = Number(format);
  if (!Number.isInteger(fmt) || fmt < 0) {
    return new Response("bad format", { status: 400 });
  }

  const file = await findRemoteFile(fmt, name);
  if (!file) return new Response(null, { status: 404 });

  // no-store on purpose: the engine caches files (and misses) in its own
  // FS, and an HTTP-cached 200 would survive a package reinstall.
  return new Response(
    Readable.toWeb(createReadStream(file)) as ReadableStream,
    {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        // Informational (mirrors the Texlyre reference server); the engine
        // stores the bytes itself.
        fileid: path.basename(file),
      },
    },
  );
}
