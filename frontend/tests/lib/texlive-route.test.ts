// The /api/texlive route and its disk cache, against a scratch directory and a
// stubbed upstream (the pinned release is never contacted).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_BASE } from "@/lib/texlive-release";

const SCRATCH_ROOT = path.join(process.cwd(), "node_modules", ".vitest-scratch");
let dir: string;
let upstream: string[];

type Route = typeof import("@/app/api/texlive/[name]/route");
type Assets = typeof import("@/lib/texlive-assets");
let route: Route;
let assets: Assets;

const BODY = "0123456789abcdefghij"; // 20 bytes

beforeEach(async () => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  dir = mkdtempSync(path.join(SCRATCH_ROOT, "cache-"));
  process.env.TEXLIVE_CACHE_DIR = dir;
  upstream = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      upstream.push(url);
      if (url.endsWith("missing.bin")) return new Response(null, { status: 404 });
      return new Response(BODY, { status: 200 });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  route = await import("@/app/api/texlive/[name]/route");
  assets = await import("@/lib/texlive-assets");
});
afterEach(() => {
  delete process.env.TEXLIVE_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const get = (name: string, headers: Record<string, string> = {}) =>
  route.GET(new Request(`http://x/api/texlive/${name}?v=tag`, { headers }), { params: Promise.resolve({ name }) });

describe("asset allow-list and downloading", () => {
  it("refuses anything outside the fixed asset set", async () => {
    expect((await get("evil.js")).status).toBe(404);
    expect((await get("../../etc/passwd")).status).toBe(404);
    expect(upstream).toEqual([]);
  });

  it("covers the engine, the three data packages and the biber module", () => {
    expect(Object.keys(assets.ASSETS).sort()).toEqual(
      [
        "biber.data",
        "biber.js",
        "biber.wasm",
        "busytex.js",
        "busytex.wasm",
        "texlive-basic.data",
        "texlive-basic.js",
        "texlive-extra.data",
        "texlive-extra.js",
        "texlive-recommended.data",
        "texlive-recommended.js",
      ].sort(),
    );
    for (const url of Object.values(assets.ASSETS)) expect(url.startsWith(RELEASE_BASE + "/")).toBe(true);
  });

  it("downloads once from the pinned release, then serves from disk", async () => {
    const a = await get("busytex.js");
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(BODY);
    await get("busytex.js");
    expect(upstream).toEqual([`${RELEASE_BASE}/busytex.js`]);
    expect(readFileSync(path.join(dir, "busytex.js"), "utf8")).toBe(BODY);
  });

  it("coalesces concurrent first requests into one download", async () => {
    await Promise.all([get("biber.js"), get("biber.js"), get("biber.js")]);
    expect(upstream).toHaveLength(1);
  });

  it("reports an upstream failure as 502", async () => {
    assets.ASSETS["missing.bin"] = `${RELEASE_BASE}/missing.bin`;
    const res = await get("missing.bin");
    expect(res.status).toBe(502);
    delete assets.ASSETS["missing.bin"];
  });
});

describe("response headers", () => {
  it("serves long-lived immutable caching and the right content types (wasm must stream-compile)", async () => {
    const js = await get("busytex.js");
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("accept-ranges")).toBe("bytes");
    expect(js.headers.get("content-length")).toBe(String(BODY.length));
    expect((await get("busytex.wasm")).headers.get("content-type")).toBe("application/wasm");
    expect((await get("texlive-basic.data")).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers a matching ETag with 304", async () => {
    const first = await get("busytex.js");
    const etag = first.headers.get("etag")!;
    const res = await get("busytex.js", { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });
});

describe("range requests", () => {
  it.each([
    ["bytes=0-4", 206, "01234", "bytes 0-4/20"],
    ["bytes=15-", 206, "fghij", "bytes 15-19/20"],
    ["bytes=-5", 206, "fghij", "bytes 15-19/20"],
    ["bytes=10-999", 206, "abcdefghij", "bytes 10-19/20"],
  ])("%s", async (range, status, body, contentRange) => {
    const res = await get("busytex.js", { range });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("content-range")).toBe(contentRange);
    expect(res.headers.get("content-length")).toBe(String(body.length));
  });

  it("416 for an unsatisfiable range; a multi-range request gets the whole file", async () => {
    const res = await get("busytex.js", { range: "bytes=50-60" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */20");
    const multi = await get("busytex.js", { range: "bytes=0-1,5-6" });
    expect(multi.status).toBe(200);
    expect(await multi.text()).toBe(BODY);
  });
});

describe("release pin marker", () => {
  it("wipes a cache that belongs to another release (no mixed-version asset sets)", async () => {
    writeFileSync(path.join(dir, ".release"), "https://example.invalid/old-release");
    writeFileSync(path.join(dir, "busytex.js"), "STALE");
    const res = await get("busytex.js");
    expect(await res.text()).toBe(BODY); // re-downloaded, not the stale file
    expect(readFileSync(path.join(dir, ".release"), "utf8")).toBe(RELEASE_BASE);
  });

  it("keeps files when the marker matches and stamps a cache that predates the marker", async () => {
    writeFileSync(path.join(dir, "busytex.js"), "KEEP");
    const res = await get("busytex.js");
    expect(await res.text()).toBe("KEEP");
    expect(upstream).toEqual([]);
    expect(readFileSync(path.join(dir, ".release"), "utf8")).toBe(RELEASE_BASE);
  });
});
