// Same-origin proxy for the busytex WASM assets.
//
// The worker loads busytex.js and texlive-basic.js with importScripts(),
// which browsers only allow for the worker's own origin — it can therefore
// not fetch them directly from the Go backend on :8080. This route makes
// the assets available from the frontend origin; the backend stays the
// source of truth (on-demand GitHub download + local cache).
//
// Cache-validation and range request headers are passed through and the
// response headers (mime type, length, ETag, range info) are mirrored, so
// the 72 MB .data package is downloaded once and reused.

const BACKEND_BASE = process.env.TEXLIVE_BACKEND_BASE ?? "http://localhost:8080";

const REQUEST_HEADERS_TO_FORWARD = [
  "range",
  "if-none-match",
  "if-modified-since",
];

const RESPONSE_HEADERS_TO_FORWARD = [
  "content-type",
  "content-length",
  "accept-ranges",
  "content-range",
  "etag",
  "last-modified",
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  // The asset set is fixed (busytex.js, busytex.wasm, texlive-basic.js,
  // texlive-basic.data); reject anything else.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return new Response("bad asset name", { status: 400 });
  }

  const headers = new Headers();
  for (const h of REQUEST_HEADERS_TO_FORWARD) {
    const value = request.headers.get(h);
    if (value) headers.set(h, value);
  }

  const upstream = await fetch(`${BACKEND_BASE}/api/texlive/${encodeURIComponent(name)}`, {
    headers,
    cache: "no-store",
  });

  const out = new Headers();
  for (const h of RESPONSE_HEADERS_TO_FORWARD) {
    const value = upstream.headers.get(h);
    if (value) out.set(h, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
