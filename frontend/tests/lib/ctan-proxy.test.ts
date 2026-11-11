import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctanStream } from "@/lib/ctan-proxy";
import { GET as archiveGET } from "@/app/api/ctan/archive/[name]/route";
import { GET as tlpdbGET } from "@/app/api/ctan/tlpdb/route";

let calls: string[];
function mirrorFetch(plan: (url: string) => Response | Error) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const r = plan(url);
      if (r instanceof Error) throw r;
      return r;
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
}
const ok = (body = "bytes", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

beforeEach(() => {
  calls = [];
});

describe("ctanStream (stateless relay)", () => {
  it("relays the first mirror's bytes with no-store and the upstream length/type", async () => {
    mirrorFetch(() => ok("payload", { "content-length": "7", "content-type": "application/x-xz" }));
    const res = await ctanStream("archive/pgf.tar.xz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("content-type")).toBe("application/x-xz");
    expect(calls).toEqual(["https://mirror.ctan.org/systems/texlive/tlnet/archive/pgf.tar.xz"]);
  });

  it("defaults the content type to octet-stream", async () => {
    mirrorFetch(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1]));
              c.close();
            },
          }),
        ),
    );
    expect((await ctanStream("x")).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("falls through the mirrors in order on failure", async () => {
    mirrorFetch((u) => (u.startsWith("https://mirror.ctan.org") ? new Response(null, { status: 503 }) : u.includes("mirrors.up.pt") ? new TypeError("dns") : ok("from csclub")));
    const res = await ctanStream("tlpkg/texlive.tlpdb");
    expect(await res.text()).toBe("from csclub");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("mirrors.up.pt/pub/CTAN/systems/texlive/tlnet/");
  });

  it("answers 404 when every mirror says 404 (unknown package), 502 for anything else", async () => {
    mirrorFetch(() => new Response(null, { status: 404 }));
    expect((await ctanStream("archive/nope.tar.xz")).status).toBe(404);
    mirrorFetch((u) => (u.includes("mirror.ctan.org") ? new Response(null, { status: 404 }) : new Response(null, { status: 500 })));
    expect((await ctanStream("archive/x.tar.xz")).status).toBe(502);
    mirrorFetch(() => new TypeError("offline"));
    const res = await ctanStream("archive/x.tar.xz");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/api/ctan routes", () => {
  const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

  it("archive: validates the tlpkg name before building any URL", async () => {
    mirrorFetch(() => ok());
    for (const bad of ["../etc/passwd", "Pgf", "-x", "a b", "a/b", "", "x%2f"]) {
      const res = await archiveGET(new Request("http://x/"), ctx(bad));
      expect(res.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("archive: relays archive/<name>.tar.xz; tlpdb: relays tlpkg/texlive.tlpdb", async () => {
    mirrorFetch(() => ok("c"));
    expect((await archiveGET(new Request("http://x/"), ctx("pgfplots"))).status).toBe(200);
    expect(calls[0]).toMatch(/archive\/pgfplots\.tar\.xz$/);
    await tlpdbGET();
    expect(calls[1]).toMatch(/tlpkg\/texlive\.tlpdb$/);
  });
});
