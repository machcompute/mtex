// A tiny CTAN: a tlpdb text, install containers (plain tar — xz is mocked at
// the xz-decompress boundary), and the engine's basic-tree file map, served
// through a stubbed fetch that only knows the same-origin proxy routes.
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { buildTar } from "./tar-builder";

export type Pkg = {
  name: string;
  category?: string;
  revision?: number;
  shortdesc?: string;
  /** archive path (relative to texmf-dist, like a real tlnet container) -> bytes */
  files: Record<string, string | Uint8Array>;
  /** override tlpdb runfiles (default: every file under texmf-dist/tex) */
  runfiles?: string[];
  /** corrupt the advertised checksum / size */
  badChecksum?: boolean;
  badSize?: boolean;
};

export type CtanStub = {
  /** every URL fetched, in order */
  requests: string[];
  /** how many times each container was fetched */
  containerHits: Record<string, number>;
  tlpdbHits: number;
  /** container names that should answer with this status */
  failContainer: Record<string, number>;
  /** make the next N container fetches reject at the network layer */
  networkFailures: number;
  /** override the basic tree listing; null = answer 404 */
  basicNames: string[] | null;
};

export function sty(name: string, requires: string[] = [], extra = ""): string {
  return (
    `\\ProvidesPackage{${name}}\n` +
    requires.map((r) => `\\RequirePackage{${r}}\n`).join("") +
    extra
  );
}

export function simplePkg(name: string, requires: string[] = []): Pkg {
  return { name, files: { [`tex/latex/${name}/${name}.sty`]: sty(name, requires) } };
}

export function buildCtan(pkgs: Pkg[]) {
  const containers = new Map<string, Uint8Array<ArrayBuffer>>();
  const blocks: string[] = [];
  for (const p of pkgs) {
    const tar = buildTar(p.files);
    containers.set(p.name, tar);
    const runfiles =
      p.runfiles ?? Object.keys(p.files).filter((f) => f.startsWith("tex/")).map((f) => `texmf-dist/${f}`);
    const checksum = p.badChecksum ? "0".repeat(128) : createHash("sha512").update(tar).digest("hex");
    blocks.push(
      [
        `name ${p.name}`,
        `category ${p.category ?? "Package"}`,
        `revision ${p.revision ?? 1}`,
        `shortdesc ${p.shortdesc ?? `The ${p.name} package`}`,
        `runfiles size=${runfiles.length}`,
        ...runfiles.map((f) => ` ${f}`),
        `docfiles size=1`,
        ` texmf-dist/doc/latex/${p.name}/README.md details="doc"`,
        `containersize ${p.badSize ? tar.length + 1 : tar.length}`,
        `containerchecksum ${checksum}`,
        "",
      ].join("\n"),
    );
  }
  return { tlpdb: blocks.join("\n") + "\n", containers };
}

export function basicTreeJs(names: string[]): string {
  const files = names.map((n, i) => `{"filename": "/texmf-dist/tex/latex/base/${n}", "start": ${i}, "end": ${i + 1}}`);
  return `var Module = {}; Module.loadPackage({"files": [${files.join(", ")}], "remote_package_size": 1});`;
}

export function installCtanStub(pkgs: Pkg[], basic: string[] = ["article.cls", "amsmath.sty"]): CtanStub & ReturnType<typeof buildCtan> {
  const built = buildCtan(pkgs);
  const stub: CtanStub & ReturnType<typeof buildCtan> = {
    ...built,
    requests: [],
    containerHits: {},
    tlpdbHits: 0,
    failContainer: {},
    networkFailures: 0,
    basicNames: basic,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      stub.requests.push(url);
      if (init?.method && init.method !== "GET") throw new Error(`non-GET request: ${init.method} ${url}`);
      if (url === "/api/ctan/tlpdb") {
        stub.tlpdbHits++;
        return new Response(stub.tlpdb);
      }
      const arch = /^\/api\/ctan\/archive\/(.+)$/.exec(url);
      if (arch) {
        const name = arch[1];
        stub.containerHits[name] = (stub.containerHits[name] ?? 0) + 1;
        if (stub.networkFailures > 0) {
          stub.networkFailures--;
          throw new TypeError("network down");
        }
        if (stub.failContainer[name]) return new Response(null, { status: stub.failContainer[name] });
        const c = stub.containers.get(name);
        if (!c) return new Response(null, { status: 404 });
        return new Response(c.slice().buffer as ArrayBuffer);
      }
      if (url.startsWith("/api/texlive/texlive-basic.js")) {
        if (stub.basicNames === null) return new Response(null, { status: 404 });
        return new Response(basicTreeJs(stub.basicNames));
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  return stub;
}
