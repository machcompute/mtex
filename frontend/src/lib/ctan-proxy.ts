// Stateless byte proxy for the two CTAN tlnet files the browser needs:
// the package database (texlive.tlpdb, ~20 MB) and the install containers
// (archive/<name>.tar.xz). CTAN mirrors send no CORS headers, so the
// browser can't fetch them directly; these routes relay the bytes.
//
// No server state on purpose: the client caches what it needs in OPFS and
// re-fetches only on a miss, so the proxy is a dumb pipe that can be
// dropped if the mirrors ever add CORS.

// mirror.ctan.org 307-rotates to a live mirror; the direct mirrors are
// fallbacks (their CTAN paths differ, hence the per-mirror prefix).
const CTAN_MIRRORS = [
  ["https://mirror.ctan.org", "systems/texlive/tlnet"],
  ["https://mirrors.up.pt/pub/CTAN", "systems/texlive/tlnet"],
  ["https://mirror.csclub.uwaterloo.ca/CTAN", "systems/texlive/tlnet"],
] as const;

/**
 * Relay `relPath` under the tlnet root to the caller as a byte stream.
 * Mirrors are tried in order; a 404 on every mirror is a 404 (unknown
 * package), anything else a 502 (transient mirror trouble).
 */
export async function ctanStream(relPath: string): Promise<Response> {
  let lastStatus = 0;
  for (const [mirror, base] of CTAN_MIRRORS) {
    const url = `${mirror}/${base}/${relPath}`;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok || !res.body) {
        lastStatus = res.status;
        continue;
      }
      const headers: Record<string, string> = {
        "content-type":
          res.headers.get("content-type") ?? "application/octet-stream",
        // no-store: the OPFS copy is the client's cache of record — an
        // HTTP-cached copy could outlive a CTAN container update.
        "cache-control": "no-store",
      };
      const length = res.headers.get("content-length");
      if (length) headers["content-length"] = length;
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      lastStatus = 502;
      console.error(`[ctan] ${url} failed:`, err);
    }
  }
  return new Response(null, {
    status: lastStatus === 404 ? 404 : 502,
    headers: { "cache-control": "no-store" },
  });
}
