// Server-side CTAN package store for the busytex engine.
//
// The engine (TeX Live 2026 WASM, see /api/texlive) preloads only its
// texlive-basic tree. Packages a document \usepackage's that basic does
// not contain are installed HERE, on demand: a CTAN tlnet container
// (systems/texlive/tlnet/archive/<name>.tar.xz) is downloaded, extracted
// into a local TDS tree, and its files are then served to the engine one
// at a time through /api/texlive-remote/{format}/{name} — the engine's
// kpathsea hook does a synchronous XHR for every lookup miss.
//
// Install/remove only touches this store (never the browser), so the
// engine must be restarted afterwards (its miss cache would keep shadowing
// a just-installed file): the page disposes the compiler after a change.
//
// Layout of the store (gitignored, created on first install):
//   .texlive-extra/
//     manifest.json      installed packages + the files each one added
//     texlive.tlpdb      cached CTAN package database (search/metadata)
//     texmf-dist/...     the extracted TDS trees

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ensureAsset } from "@/lib/texlive-assets";

// ---------------------------------------------------------------------------
// store location
// ---------------------------------------------------------------------------

export function storeDir(): string {
  return (
    process.env.TEXLIVE_EXTRA_DIR ??
    path.join(process.cwd(), ".texlive-extra")
  );
}

function tdsDir(): string {
  return path.join(storeDir(), "texmf-dist");
}

export class PackageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// CTAN tlnet access
// ---------------------------------------------------------------------------
// mirror.ctan.org 307-rotates to a live mirror; the direct mirrors are
// fallbacks (their CTAN paths differ, hence the per-mirror prefix).
const CTAN_MIRRORS = [
  ["https://mirror.ctan.org", "systems/texlive/tlnet"],
  ["https://mirrors.up.pt/pub/CTAN", "systems/texlive/tlnet"],
  ["https://mirror.csclub.uwaterloo.ca/CTAN", "systems/texlive/tlnet"],
] as const;

async function ctanDownload(relPath: string): Promise<Buffer> {
  let lastErr: unknown;
  const tryAllMirrors = async (): Promise<Buffer | null> => {
    for (const [mirror, base] of CTAN_MIRRORS) {
      const url = `${mirror}/${base}/${relPath}`;
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok || !res.body) {
          lastErr = new Error(`${url} -> HTTP ${res.status}`);
          continue;
        }
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastErr = err;
      }
    }
    return null;
  };
  // A transient network failure (DNS blip, reset connection) can take down
  // every mirror at once; the whole chain is retried once after a short
  // pause so a one-off blip does not fail a user-initiated install.
  for (let attempt = 0; attempt < 2; attempt++) {
    const buf = await tryAllMirrors();
    if (buf) return buf;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new PackageError(
    `could not download ${relPath} from CTAN (${String(lastErr)})`,
    502,
  );
}

// ---------------------------------------------------------------------------
// the tlnet package database (tlpdb): metadata + search
// ---------------------------------------------------------------------------

type TlpdbEntry = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  /** bytes of the install container (archive/<name>.tar.xz) */
  size: number;
  /** sha512 of the install container */
  checksum: string;
};

let tlpdbPromise: Promise<Map<string, TlpdbEntry>> | null = null;

async function loadTlpdb(): Promise<Map<string, TlpdbEntry>> {
  if (!tlpdbPromise) {
    tlpdbPromise = (async () => {
      const cache = path.join(storeDir(), "texlive.tlpdb");
      let text = await readFile(cache, "utf8").catch(() => null);
      if (text === null) {
        const buf = await ctanDownload("tlpkg/texlive.tlpdb");
        await mkdir(storeDir(), { recursive: true });
        await writeFile(cache, buf);
        text = buf.toString("utf8");
      }
      return parseTlpdb(text);
    })();
    // A failed load must not poison later calls (the download can fail
    // transiently); drop the promise so the next call retries.
    void tlpdbPromise.catch(() => {
      tlpdbPromise = null;
    });
  }
  return tlpdbPromise;
}

// tlpdb text format: entries separated by blank lines, the first field of
// each is "name <package>".
function parseTlpdb(text: string): Map<string, TlpdbEntry> {
  const map = new Map<string, TlpdbEntry>();
  let cur: TlpdbEntry | null = null;
  for (const line of text.split("\n")) {
    if (line === "") {
      if (cur) {
        map.set(cur.name, cur);
        cur = null;
      }
      continue;
    }
    const eq = line.indexOf(" ");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "name") {
      cur = {
        name: value,
        category: "",
        revision: 0,
        shortdesc: "",
        size: 0,
        checksum: "",
      };
    } else if (cur) {
      if (key === "category") cur.category = value;
      else if (key === "revision") cur.revision = Number(value) || 0;
      else if (key === "shortdesc") cur.shortdesc = value;
      else if (key === "containersize") cur.size = Number(value) || 0;
      else if (key === "containerchecksum") cur.checksum = value;
    }
  }
  if (cur) map.set(cur.name, cur);
  return map;
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

type StoredPackage = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  /** bytes of the install container */
  size: number;
  /** lower-cased names \usepackage can request from this package */
  provides: string[];
  /** files added to the TDS tree, relative to texmf-dist (posix) */
  files: string[];
  installedAt: string;
};

type Manifest = { v: 1; packages: Record<string, StoredPackage> };

export type PackageInfo = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  provides: string[];
  files: number;
  installedAt: string;
};

function info(p: StoredPackage): PackageInfo {
  return {
    name: p.name,
    category: p.category,
    revision: p.revision,
    shortdesc: p.shortdesc,
    size: p.size,
    provides: p.provides,
    files: p.files.length,
    installedAt: p.installedAt,
  };
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(
      path.join(storeDir(), "manifest.json"),
      "utf8",
    );
    const m = JSON.parse(raw) as Partial<Manifest>;
    return { v: 1, packages: m.packages ?? {} };
  } catch {
    return { v: 1, packages: {} };
  }
}

async function saveManifest(m: Manifest): Promise<void> {
  await mkdir(storeDir(), { recursive: true });
  const dest = path.join(storeDir(), "manifest.json");
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(m, null, 2));
  await rename(tmp, dest);
  invalidateFileIndex();
}

// ---------------------------------------------------------------------------
// install / remove / list
// ---------------------------------------------------------------------------

export async function listPackages(): Promise<PackageInfo[]> {
  const m = await readManifest();
  return Object.values(m.packages)
    .map(info)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPackage(name: string): Promise<PackageInfo | null> {
  const m = await readManifest();
  const p = m.packages[name];
  return p ? info(p) : null;
}

let installChain: Promise<unknown> = Promise.resolve();

/**
 * Install a package from CTAN. Serialized: concurrent installs share one
 * chain so the manifest (and the file index) never race.
 */
export function installPackage(name: string): Promise<PackageInfo> {
  const p = installChain.then(() => doInstall(name));
  installChain = p.catch(() => undefined);
  return p;
}

// ---------------------------------------------------------------------------
// install with dependencies
// ---------------------------------------------------------------------------
// TeX Live's tlpdb has no per-package dependency data, so the practical
// source of truth is the LaTeX code: the \usepackage / \RequirePackage /
// \LoadClass of everything an installed package ships. We scan those and
// pull in whatever is not already available — from the engine's basic tree
// or from packages already in the store — and repeat transitively.

const DEP_RE =
  /\\(?:usepackage|RequirePackage|LoadClass)\*?(?:\[[^\]]*\])?\{([^{}]+)\}/g;
// A real package name (lowercase letters, digits, hyphens); filters the
// scan noise — \usepackage{#1} in macro templates, conditional fragments.
const DEP_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_RE = /\.(sty|cls|def|tex3)$/;
const SCAN_MAX = 512 * 1024;
const MAX_DEPTH = 4;
// Documentation and test content ships inside containers too (example
// files like fancyvrb-ex.sty, manual classes like pst-doc.cls, test
// suites) and \usepackages packages the real package never needs —
// scanning it cascades installs (fancyvrb-ex -> pstricks -> pst-doc ->
// biblatex -> ...). Skip it.
const DOC_PATH_RE =
  /\/(tests?|demos?|examples?|doc|docs|manual|manuals|tutorials?|templates?)\//;
const DOC_FILE_RE =
  /(^|\/)(examples?|demo)[^/]*$|(^|\/)[^/]*(doc|manual|-ex)\.(sty|cls)$/;

// \usepackage names that are not tlpkg names (the file ships in a
// differently-named container).
const DEP_ALIASES: Record<string, string> = {
  tikz: "pgf",
  mathrsfs: "jknapltx",
  mathptmx: "psnfss",
  helvet: "psnfss",
  mathabx: "jknapltx",
};

/**
 * The basenames of every file in the engine's preloaded basic tree, so a
 * dependency already in there can be skipped instead of installed twice.
 * The list is embedded in texlive-basic.js as the data package's file map
 * (the .data itself is LZ4-compressed, the .js is not).
 */
let basicNames: Promise<Set<string>> | null = null;
function basicBasenameSet(): Promise<Set<string>> {
  if (!basicNames) {
    basicNames = (async () => {
      const file = await ensureAsset("texlive-basic.js");
      const src = await readFile(file, "utf8");
      const start = src.indexOf("loadPackage({\"files\"");
      if (start < 0) throw new Error("file map not found in texlive-basic.js");
      const j = src.indexOf("[", start);
      let depth = 0;
      for (let k = j; k < src.length; k++) {
        if (src[k] === "[") depth++;
        else if (src[k] === "]" && --depth === 0) {
          const map = src.slice(j, k + 1);
          const names = new Set<string>();
          for (const m of map.matchAll(/\{"filename": "([^"]+)"/g)) {
            names.add(m[1].split("/").pop() ?? m[1]);
          }
          return names;
        }
      }
      throw new Error("unterminated file map in texlive-basic.js");
    })();
    basicNames.catch(() => (basicNames = null)); // don't cache a failure
  }
  return basicNames;
}

export type InstallResult = {
  package: PackageInfo;
  /** tlpkg names pulled in on the way (transitive dependencies). */
  installedDependencies: string[];
  /** dependency names that map to no tlpkg (install them manually). */
  unresolved: string[];
};

/**
 * Install a package AND everything its LaTeX files require that the engine
 * does not already have. Serialized with plain installs through the same
 * chain (the manifest and file index must not race).
 */
export function installWithDependencies(name: string): Promise<InstallResult> {
  const p = installChain.then(() => doInstallWithDeps(name));
  installChain = p.catch(() => undefined);
  return p;
}

async function doInstallWithDeps(name: string): Promise<InstallResult> {
  // Idempotent: an already-installed root is kept as-is, but its missing
  // dependencies are still pulled in (a stale Install button now succeeds
  // instead of 409ing).
  const root = (await getPackage(name)) ?? (await doInstall(name));
  // The basic list is a nice-to-have (skip duplicates); without it we just
  // risk installing a duplicate container, which is wasteful, not broken.
  const basic = await basicBasenameSet().catch(() => null);
  const installed: string[] = [];
  const unresolved: string[] = [];
  await resolveDeps(name, basic, installed, unresolved, 0);
  return {
    package: root,
    installedDependencies: installed,
    unresolved: [...new Set(unresolved)].sort(),
  };
}

async function resolveDeps(
  pkg: string,
  basic: Set<string> | null,
  installed: string[],
  unresolved: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const manifest = await readManifest();
  const entry = manifest.packages[pkg];
  if (!entry) return;

  // 1. Collect every package name this container's LaTeX files require.
  const deps = new Set<string>();
  for (const rel of entry.files) {
    if (!SCAN_RE.test(rel)) continue;
    if (DOC_PATH_RE.test(rel) || DOC_FILE_RE.test(rel)) continue;
    const st = await stat(path.join(tdsDir(), rel)).catch(() => null);
    if (!st || st.size > SCAN_MAX) continue;
    const src = await readFile(path.join(tdsDir(), rel), "utf8").catch(
      () => "",
    );
    // Drop % comments first: containers ship commented-out
    // \RequirePackage{...} lines that are not real dependencies.
    const code = src
      .split("\n")
      .map((line) => line.split(/(?<!\\)%/)[0])
      .join("\n");
    for (const m of code.matchAll(DEP_RE)) {
      for (const d of m[1].split(",")) {
        const dep = d.trim().toLowerCase();
        if (DEP_NAME_RE.test(dep) && dep !== pkg) deps.add(dep);
      }
    }
  }

  for (const dep of deps) {
    // 2. Skip what the engine already has.
    if (basic && (basic.has(`${dep}.sty`) || basic.has(`${dep}.cls`))) continue;
    if (await isInStore(dep)) continue;

    // 3. Map to a tlpkg and install it (then scan THAT container, too).
    const tlpkg = DEP_ALIASES[dep] ?? dep;
    if (tlpkg in (await readManifest()).packages) continue;
    const tlpdb = await loadTlpdb();
    if (!tlpdb.has(tlpkg)) {
      unresolved.push(dep);
      continue;
    }
    await doInstall(tlpkg);
    installed.push(tlpkg);
    await resolveDeps(tlpkg, basic, installed, unresolved, depth + 1);
  }
}

/** True if the store already provides `name` (as a tlpkg or a filename). */
async function isInStore(name: string): Promise<boolean> {
  const m = await readManifest();
  return Object.values(m.packages).some(
    (p) => p.name === name || p.provides.includes(name),
  );
}

async function doInstall(name: string): Promise<PackageInfo> {
  const tlpdb = await loadTlpdb();
  const meta = tlpdb.get(name);
  if (!meta)
    throw new PackageError(`unknown package: ${name}`, 404);

  const manifest = await readManifest();
  if (manifest.packages[name])
    throw new PackageError(`${name} is already installed`, 409);

  const tmp = path.join(storeDir(), `.tmp-install-${name}-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const container = path.join(tmp, "container.tar.xz");
    const buf = await ctanDownload(`archive/${name}.tar.xz`);
    if (meta.size > 0 && buf.length !== meta.size)
      throw new PackageError(
        `downloaded container size ${buf.length} != tlpdb ${meta.size}`,
        502,
      );
    if (meta.checksum) {
      const sha = createHash("sha512").update(buf).digest("hex");
      if (sha !== meta.checksum)
        throw new PackageError("downloaded container checksum mismatch", 502);
    }
    await writeFile(container, buf);

    const extract = path.join(tmp, "extract");
    await mkdir(extract, { recursive: true });
    await runTar(container, extract);

    // Collect the files (posix paths relative to the TDS root) and the
    // package names this container provides.
    const files: string[] = [];
    const provides = new Set([name.toLowerCase()]);
    const PROBE = /\.(sty|cls)$/;
    const PROVIDES_RE = /\\ProvidesPackage\{([^{}]+)\}/;
    const walk = async (dir: string, rel: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const r = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          await walk(full, r);
        } else {
          // Refuse path traversal (a malicious or corrupt container).
          if (
            !path.resolve(full).startsWith(path.resolve(extract) + path.sep)
          )
            continue;
          files.push(r);
          if (PROBE.test(e.name)) {
            // The file name is the usual \usepackage name too — some
            // packages (tikz.sty) never emit a \ProvidesPackage at all,
            // and a name missing from the list would send the engine's
            // resolver to the 540 MB data-tree fallback instead of the
            // remote endpoint.
            provides.add(e.name.replace(PROBE, "").toLowerCase());
            const st = await stat(full).catch(() => null);
            if (st && st.size <= 2 * 1024 * 1024) {
              const m = PROVIDES_RE.exec(
                await readFile(full, "utf8").catch(() => ""),
              );
              if (m) provides.add(m[1].toLowerCase().trim());
            }
          }
        }
      }
    };
    await walk(extract, "");

    // Move the tree into the store.
    const tds = tdsDir();
    for (const rel of files) {
      const dest = path.join(tds, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(extract, rel), dest);
    }

    manifest.packages[name] = {
      name,
      category: meta.category,
      revision: meta.revision,
      shortdesc: meta.shortdesc,
      size: buf.length,
      provides: [...provides].sort(),
      files: files.sort(),
      installedAt: new Date().toISOString(),
    };
    await saveManifest(manifest);
    return info(manifest.packages[name]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runTar(container: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xJf", container, "-C", dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new PackageError(`tar failed (exit ${code}): ${err}`, 502)),
    );
  });
}

export async function removePackage(name: string): Promise<void> {
  const manifest = await readManifest();
  const entry = manifest.packages[name];
  if (!entry) throw new PackageError(`unknown package: ${name}`, 404);

  const tds = tdsDir();
  const emptyDirs: string[] = [];
  for (const rel of entry.files) {
    const file = path.join(tds, rel);
    if (!file.startsWith(tds + path.sep)) continue;
    await rm(file, { force: true });
    // Remember the ancestors so emptied directories can be pruned.
    let dir = path.dirname(file);
    while (dir.startsWith(tds + path.sep)) {
      emptyDirs.push(dir);
      dir = path.dirname(dir);
    }
  }
  delete manifest.packages[name];
  await saveManifest(manifest);

  for (const dir of emptyDirs.sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => undefined); // best effort: not empty -> keep
  }
}

// ---------------------------------------------------------------------------
// search (tlpdb metadata + installed flag)
// ---------------------------------------------------------------------------

export type SearchResult = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  installed: boolean;
};

export async function searchPackages(
  query: string,
  limit = 25,
): Promise<SearchResult[]> {
  const [tlpdb, manifest] = await Promise.all([loadTlpdb(), readManifest()]);
  const q = query.toLowerCase().trim();
  const scored: Array<[number, TlpdbEntry]> = [];
  for (const e of tlpdb.values()) {
    if (q) {
      const n = e.name.toLowerCase();
      const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2
        : e.shortdesc.toLowerCase().includes(q) ? 3
          : -1;
      if (score < 0) continue;
      scored.push([score, e]);
    } else {
      scored.push([0, e]);
    }
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, limit).map(([, e]) => ({
    name: e.name,
    category: e.category,
    revision: e.revision,
    shortdesc: e.shortdesc,
    size: e.size,
    installed: e.name in manifest.packages,
  }));
}

// ---------------------------------------------------------------------------
// the remote endpoint's filename index
// ---------------------------------------------------------------------------
// The engine asks for {format}/{name} (see the kpse_remote hook in the
// release build): name is the exact file name kpathsea looked up (or a
// bare stem, e.g. a font name without extension). The index maps lower
// case basenames of every installed file; the stem fallback resolves
// extensionless names against the extensions that format can mean.
// (Port of the matching table and logic of the Texlyre reference server.)
const KPSE_EXTENSIONS: Record<number, string[]> = {
  0: [".gf"],
  1: [".pk"],
  3: [".tfm"],
  4: [".afm"],
  5: [".base"],
  6: [".bib"],
  7: [".bst"],
  8: [".cnf"],
  10: [".fmt"],
  11: [".map"],
  13: [".mf"],
  16: [".mp"],
  19: [".ocp"],
  20: [".ofm", ".tfm"],
  21: [".opl"],
  22: [".otp"],
  23: [".ovf", ".vf"],
  24: [".ovp"],
  26: [
    ".tex", ".sty", ".cls", ".fd", ".def", ".cfg", ".ltx", ".dtx", ".ldf",
    ".clo", ".bbx", ".cbx", ".lbx", ".dbx", ".rtx",
  ],
  28: [".pool"],
  30: [".pro"],
  32: [".pfa", ".pfb"],
  33: [".vf"],
  35: [".ist"],
  36: [".ttf", ".ttc", ".dfont"],
  44: [".enc"],
  46: [".sfd"],
  47: [".otf"],
  49: [".lig"],
  50: [".lua", ".pl", ".rb", ".py"],
  51: [".lua", ".luc", ".luatex", ".texlua", ".tlu"],
  52: [".fea"],
  53: [".cid", ".cidmap"],
  54: [".mlbib", ".bib"],
  55: [".mlbst", ".bst"],
  57: [".ris"],
  58: [".bltxml"],
};

let fileIndex: Map<string, string> | null = null; // basename -> abs path

function invalidateFileIndex(): void {
  fileIndex = null;
}

async function getFileIndex(): Promise<Map<string, string>> {
  if (fileIndex) return fileIndex;
  const manifest = await readManifest();
  const fi = new Map<string, string>();
  const tds = tdsDir();
  for (const pkg of Object.values(manifest.packages)) {
    for (const rel of pkg.files) {
      const base = rel.split("/").pop() ?? "";
      if (!base) continue;
      const key = base.toLowerCase();
      if (!fi.has(key)) fi.set(key, path.join(tds, rel));
    }
  }
  fileIndex = fi;
  return fi;
}

/**
 * Resolve a remote request (format + name) to a file in the store, or null
 * (the endpoint answers 404, which the engine caches as a miss).
 */
export async function findRemoteFile(
  format: number,
  name: string,
): Promise<string | null> {
  if (!name) return null;
  const fileIndex = await getFileIndex();
  const key = name.toLowerCase();

  // An exact file name is always accepted, regardless of extension.
  const exact = fileIndex.get(key);
  if (exact) return exact;

  // Extensionless names (font metrics, …): try the extensions that this
  // kpse format can mean.
  const expected = KPSE_EXTENSIONS[format];
  if (expected) {
    for (const ext of expected) {
      const p = fileIndex.get(key + ext);
      if (p) return p;
    }
  }
  return null;
}
