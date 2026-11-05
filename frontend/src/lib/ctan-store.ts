"use client";

// The browser's CTAN package store — the engine's installed packages live
// entirely in Origin Private File System (OPFS), the `ctan/` folder next
// to `projects/`:
//
//   ctan/
//     manifest.json      installed packages + the files each one added
//     texlive.tlpdb      cached CTAN package database (search/metadata)
//     texmf-dist/...     the extracted TDS trees (raw bytes)
//
// The server is stateless: /api/ctan/ only relays the two tlnet files the
// browser cannot reach directly (CTAN mirrors send no CORS headers).
// Search, install, and remove all run here: the container is fetched,
// XZ-decompressed and tar-unpacked in the page, and the files land in
// OPFS.
//
// Compiled documents get the installed files in the compile payload at
// their absolute engine paths (/texlive/texmf-dist/...) — the pipeline
// writes absolute payload paths as-is (its PATH.join would concatenate
// them under the project dir, where kpathsea never looks), so they land
// in the engine's preloaded tree. That tree is never remounted
// between compiles, so the files persist for the worker's whole life and
// the payload carries them once per worker session (see storeFiles). That
// is also why the page disposes the compiler after a package change: a
// removed package's stale files would otherwise keep resolving.
//
// Ported from the (now removed) server-side store; the dependency
// scanner's size cap is raised from 512 KB to 4 MB — biblatex.sty is
// 538 KB, and the old cap silently skipped it, missing its \RequirePackage
// dependencies (logreq).

import {
  BINARY_EXT,
  decodeText,
  decodeTextLenient,
  walkFiles,
  writeFile,
} from "@/lib/opfs";
import { parseTar } from "@/lib/tar";
import { XzReadableStream } from "xz-decompress";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export class PackageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type PackageInfo = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  /** lower-cased names \usepackage can request from this package */
  provides: string[];
  files: number;
  installedAt: string;
};

export type SearchResult = {
  name: string;
  category: string;
  revision: number;
  shortdesc: string;
  size: number;
  installed: boolean;
};

export type InstallResult = {
  package: PackageInfo;
  /** tlpkg names pulled in on the way (transitive dependencies). */
  installedDependencies: string[];
  /** dependency names that map to no tlpkg (install them manually). */
  unresolved: string[];
};

// ---------------------------------------------------------------------------
// store location
// ---------------------------------------------------------------------------

async function storeRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("ctan", { create: true });
}

async function tdsDir(): Promise<FileSystemDirectoryHandle> {
  return (await storeRoot()).getDirectoryHandle("texmf-dist", { create: true });
}

/** Read one file under `dir` (posix path), or null when it is missing. */
async function readBytes(
  dir: FileSystemDirectoryHandle,
  rel: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const parts = rel.split("/");
  let d = dir;
  try {
    // Directory parts only — the leaf is a FILE; handing it to
    // getDirectoryHandle throws on an existing entry of the wrong type.
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const fh = await d.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
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

let tlpdbTextPromise: Promise<string> | null = null;

/**
 * The raw tlnet package database (~20 MB of plain text), cached in OPFS
 * after the first fetch. Both the metadata map (loadTlpdb) and the
 * file→package index (fileOwners) parse it, so the download happens once
 * and the text is shared between them.
 */
async function tlpdbText(): Promise<string> {
  if (!tlpdbTextPromise) {
    tlpdbTextPromise = (async () => {
      const root = await storeRoot();
      try {
        const fh = await root.getFileHandle("texlive.tlpdb");
        return await (await fh.getFile()).text();
      } catch {
        // not cached yet: fetch it (the stateless proxy relays CTAN)
        const res = await fetch("/api/ctan/tlpdb");
        if (!res.ok)
          throw new PackageError(
            `could not download the CTAN package database (HTTP ${res.status})`,
            502,
          );
        const buf = new Uint8Array(await res.arrayBuffer());
        const w = await (
          await root.getFileHandle("texlive.tlpdb", { create: true })
        ).createWritable();
        await w.write(buf);
        await w.close();
        return new TextDecoder("utf-8").decode(buf);
      }
    })();
    // A failed download must not poison later calls (it can fail
    // transiently); drop the promise so the next call retries.
    void tlpdbTextPromise.catch(() => {
      tlpdbTextPromise = null;
    });
  }
  return tlpdbTextPromise;
}

let tlpdbPromise: Promise<Map<string, TlpdbEntry>> | null = null;

async function loadTlpdb(): Promise<Map<string, TlpdbEntry>> {
  if (!tlpdbPromise) {
    tlpdbPromise = tlpdbText().then(parseTlpdb);
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
// which tlpkg ships a given file (auto-install a missing babel language)
// ---------------------------------------------------------------------------

// Recent TeX Live split babel's per-language definition files (X.ldf) out
// of the `babel` core into their own tlpkg (babel-portuges, babel-french, …),
// and the engine's preloaded tree ships only babel-english — so a non-English
// \usepackage[...]{babel} fails with "Unknown option" until the matching
// tlpkg is installed. To find it we index the raw tlpdb's per-package
// runfiles (the files that land in the installed texmf-dist tree):
// lower-cased file basename -> the tlpkg names that ship that file. The
// cached metadata entries (TlpdbEntry) carry no file list, so this is a
// second, one-time rescan of the same raw text.
let tlpdbFileOwners: Promise<Map<string, string[]>> | null = null;

function fileOwners(): Promise<Map<string, string[]>> {
  if (!tlpdbFileOwners) {
    tlpdbFileOwners = tlpdbText().then((text) => {
      const owners = new Map<string, string[]>();
      let pkg: string | null = null;
      let inRunfiles = false;
      for (const line of text.split("\n")) {
        if (line === "") {
          // a blank line ends an entry
          pkg = null;
          inRunfiles = false;
          continue;
        }
        if (line[0] === " " || line[0] === "\t") {
          // an indented file line (runfiles / docfiles / srcfiles entry)
          if (inRunfiles && pkg) {
            // drop any trailing attributes (details="…"); take the basename
            const base = line.trim().split(" ")[0].split("/").pop();
            if (base) {
              const key = base.toLowerCase();
              const list = owners.get(key);
              if (list) list.push(pkg);
              else owners.set(key, [pkg]);
            }
          }
          continue;
        }
        // a "key value" field line
        const eq = line.indexOf(" ");
        const key = eq >= 0 ? line.slice(0, eq) : line;
        const value = eq >= 0 ? line.slice(eq + 1) : "";
        if (key === "name") {
          pkg = value;
          inRunfiles = false;
        } else if (key === "runfiles") {
          inRunfiles = true;
        } else {
          // docfiles, srcfiles, containersize, … end the runfiles list
          inRunfiles = false;
        }
      }
      return owners;
    });
    void tlpdbFileOwners.catch(() => {
      tlpdbFileOwners = null; // don't cache a failed parse
    });
  }
  return tlpdbFileOwners;
}

/**
 * The tlpkg that ships the RUNTIME file `basename`, or null when no single
 * owner is unambiguous. A sole owner is returned as-is; with several owners
 * we trust only a babel-* one (this index exists for the babel case, where
 * e.g. "portuguese.ldf" has a single owner) and otherwise refuse to guess.
 * Throws only when the tlpdb itself cannot be loaded (caller retries).
 */
export async function packageForFile(basename: string): Promise<string | null> {
  const owners = (await fileOwners()).get(basename.toLowerCase());
  if (!owners || owners.length === 0) return null;
  if (owners.length === 1) return owners[0];
  return owners.find((n) => n.startsWith("babel-")) ?? null;
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

type Manifest = {
  v: 1;
  packages: Record<string, StoredPackage>;
  /**
   * The version of the default package set this store was seeded with
   * (see DEFAULTS_VERSION). Absent until the first-run sweep ran, so an
   * old store or a fresh one both get the defaults exactly once — and a
   * default the user later removes stays removed.
   */
  defaultsVersion?: number;
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
    const root = await storeRoot();
    const fh = await root.getFileHandle("manifest.json");
    const m = JSON.parse(await (await fh.getFile()).text()) as Partial<Manifest>;
    return {
      v: 1,
      packages: m.packages ?? {},
      defaultsVersion: m.defaultsVersion,
    };
  } catch {
    return { v: 1, packages: {} };
  }
}

async function saveManifest(m: Manifest): Promise<void> {
  const root = await storeRoot();
  const fh = await root.getFileHandle("manifest.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(m, null, 2));
  await w.close();
}

// ---------------------------------------------------------------------------
// list / names for the engine
// ---------------------------------------------------------------------------

export async function listPackages(): Promise<PackageInfo[]> {
  const m = await readManifest();
  return Object.values(m.packages)
    .map(info)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The names the pipeline should treat as locally available: the installed
 * package names plus everything they \ProvidesPackage (pgf provides tikz,
 * algorithm provides algcompatible, …). The init message carries the list;
 * without it, an installed package would count as unresolved and the
 * pipeline would enable ALL data packages (~540 MB).
 */
export async function remotePackageNames(): Promise<string[]> {
  const m = await readManifest();
  const names = new Set<string>();
  for (const p of Object.values(m.packages)) {
    names.add(p.name.toLowerCase());
    for (const n of p.provides) names.add(n.toLowerCase());
  }
  return [...names];
}

/**
 * The installed files at their engine paths, for the compile payload.
 * Text files are UTF-8 strings, binary files (fonts, …) byte arrays —
 * the pipeline registers both with kpathsea via kpse_remote_register (see
 * the pipeline header for why they are not written into the /texlive tree).
 * Sent once per worker session (see the file header): the registration
 * persists for the worker's lifetime, so resending would only re-register
 * the same files.
 */
export async function storeFiles(): Promise<
  { path: string; contents: string | Uint8Array<ArrayBuffer> }[]
> {
  const manifest = await readManifest();
  if (Object.keys(manifest.packages).length === 0) return [];
  const tds = await tdsDir();
  const raw = await walkFiles(tds);
  // Only files the manifest lists: a crashed install could leave bytes
  // behind, and those must not reach the engine.
  const listed = new Set<string>();
  for (const p of Object.values(manifest.packages))
    for (const f of p.files) listed.add(f);
  const out: { path: string; contents: string | Uint8Array<ArrayBuffer> }[] =
    [];
  for (const [rel, bytes] of raw) {
    if (!listed.has(rel)) continue;
    const dot = rel.lastIndexOf(".");
    const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : "";
    const text = ext && BINARY_EXT.has(ext) ? null : decodeText(bytes);
    out.push({ path: "/texlive/texmf-dist/" + rel, contents: text ?? bytes });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// default package set (auto-installed on first run)
// ---------------------------------------------------------------------------

/**
 * The curated set a recent document is likely to \usepackage, installed
 * into a fresh store automatically so the first compile does not sit on
 * an empty "Installed (0)". The base tree already covers geometry,
 * hyperref, amsmath, natbib, times.sty, … — this list is what most
 * documents need beyond that. The font packs (times, zapfchan, symbol) are
 * pslatex's font maps: the .sty lives in the base tree, the physical PFB
 * glyphs come from these containers. babel-portuges is the one babel
 * language the base tree cannot load: recent TeX Live split babel's
 * per-language .ldf files into babel-* tlpkg (the base tree ships only
 * babel-english), and Portuguese is a common thesis language. Every other
 * babel language is covered on demand by the compile-time auto-install
 * (packageForFile), which needs no curation.
 */
export const DEFAULT_PACKAGES = [
  "fontspec",
  "xcolor",
  "enumitem",
  "booktabs",
  "caption",
  "mathtools",
  "siunitx",
  "pgfplots", // pulls in pgf (provides tikz), listings, …
  "algorithm2e",
  "biblatex",
  "translations",
  "titlesec",
  "microtype",
  "float",
  "times",
  "zapfchan",
  "symbol",
  "babel-portuges",
] as const;

/**
 * Bump when the curated set grows: a store seeded with an older version
 * re-runs the sweep, and any default that is not in the manifest is
 * (re)installed — including one the user removed since (the manifest
 * does not record removals, so a curation bump deliberately re-seeds).
 * At the CURRENT version, though, the marker is written once and the
 * sweep is a no-op, so a removal always survives a plain reload.
 */
export const DEFAULTS_VERSION = 2;

let defaultsPromise: Promise<string[]> | null = null;

/**
 * Install the curated default set into a store that does not have it
 * yet (see DEFAULTS_VERSION). Resolves with the names actually
 * installed (empty when everything is already present). Serialized on
 * the store op chain, so it never races a modal install; on failure the
 * marker is not written and the next call (or page load) retries.
 */
export function ensureDefaults(
  onProgress?: (name: string, done: number, total: number) => void,
): Promise<string[]> {
  if (!defaultsPromise) {
    defaultsPromise = opChain.then(() => doEnsureDefaults(onProgress));
    opChain = defaultsPromise.catch(() => undefined);
    defaultsPromise.catch(() => {
      defaultsPromise = null; // failed → the next call retries
    });
  }
  return defaultsPromise;
}

async function doEnsureDefaults(
  onProgress?: (name: string, done: number, total: number) => void,
): Promise<string[]> {
  const manifest = await readManifest();
  if ((manifest.defaultsVersion ?? 0) >= DEFAULTS_VERSION) return [];
  const missing = DEFAULT_PACKAGES.filter((n) => !manifest.packages[n]);
  const basic = await basicBasenameSet().catch(() => null);
  const installed: string[] = [];
  for (let i = 0; i < missing.length; i++) {
    const name = missing[i];
    onProgress?.(name, i, missing.length);
    // doInstall directly: this task holds the chain slot, and the
    // exported wrapper would queue behind it (deadlock).
    await doInstall(name);
    const deps: string[] = [];
    const unresolved: string[] = [];
    await resolveDeps(name, basic, deps, unresolved, 0);
    installed.push(name);
  }
  const fresh = await readManifest();
  fresh.defaultsVersion = DEFAULTS_VERSION;
  await saveManifest(fresh);
  return installed;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

// tlpkg names: lowercase letters, digits, hyphens — also the shape the
// proxy's route validates, so nothing path-like can reach a URL.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

let opChain: Promise<unknown> = Promise.resolve();

/**
 * Install a package AND everything its LaTeX files require that the engine
 * does not already have. Serialized so the manifest never races.
 */
export function installWithDependencies(name: string): Promise<InstallResult> {
  const p = opChain.then(() => doInstallWithDeps(name));
  opChain = p.catch(() => undefined);
  return p;
}

/** Remove a package's files and its manifest entry. Serialized too. */
export function removePackage(name: string): Promise<void> {
  const p = opChain.then(() => doRemove(name));
  opChain = p.catch(() => undefined);
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

async function getPackage(name: string): Promise<PackageInfo | null> {
  const m = await readManifest();
  const p = m.packages[name];
  return p ? info(p) : null;
}

/**
 * Fetch the install container through the stateless proxy, verify it
 * against the tlpdb metadata, and unpack it in the browser (XZ + tar).
 */
async function downloadContainer(name: string): Promise<Uint8Array<ArrayBuffer>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`/api/ctan/archive/${name}`);
      if (res.status === 404)
        throw new PackageError(`CTAN has no container for ${name}`, 404);
      if (!res.ok)
        throw new PackageError(
          `could not download ${name} from CTAN (HTTP ${res.status})`,
          502,
        );
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof PackageError && err.status === 404) throw err;
      lastErr = err;
      // A transient network failure (DNS blip, reset connection) can take
      // down every mirror at once; retry the whole chain once after a
      // short pause so a one-off blip does not fail a user-initiated
      // install.
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new PackageError(
    `could not download ${name} from CTAN (${String(lastErr)})`,
    502,
  );
}

async function sha512Hex(buf: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function doInstall(name: string): Promise<PackageInfo> {
  name = name.toLowerCase().trim();
  if (!NAME_RE.test(name))
    throw new PackageError(`bad package name: ${name}`, 400);

  const tlpdb = await loadTlpdb();
  const meta = tlpdb.get(name);
  if (!meta) throw new PackageError(`unknown package: ${name}`, 404);

  const manifest = await readManifest();
  if (manifest.packages[name])
    throw new PackageError(`${name} is already installed`, 409);

  const buf = await downloadContainer(name);
  if (meta.size > 0 && buf.length !== meta.size)
    throw new PackageError(
      `downloaded container size ${buf.length} != tlpdb ${meta.size}`,
      502,
    );
  if (meta.checksum && (await sha512Hex(buf)) !== meta.checksum)
    throw new PackageError("downloaded container checksum mismatch", 502);

  // XZ-decompress, then tar-unpack, in the page.
  let files: Map<string, Uint8Array<ArrayBuffer>>;
  try {
    const tarBuf = await new Response(
      new XzReadableStream(new Response(buf).body!),
    ).arrayBuffer();
    files = parseTar(new Uint8Array(tarBuf));
  } catch (err) {
    throw new PackageError(
      `could not unpack the ${name} container (${String(err)})`,
      502,
    );
  }
  if (files.size === 0)
    throw new PackageError(`no files in the ${name} container`, 502);

  // The package names this container provides.
  const provides = new Set([name]);
  const PROBE = /\.(sty|cls)$/;
  const PROVIDES_RE = /\\ProvidesPackage\{([^{}]+)\}/;
  for (const [rel, bytes] of files) {
    const base = rel.split("/").pop() ?? "";
    if (!PROBE.test(base)) continue;
    // The file name is the usual \usepackage name too — some packages
    // (tikz.sty) never emit a \ProvidesPackage at all, and a name missing
    // from the list would send the engine's resolver to the 540 MB
    // data-tree fallback.
    provides.add(base.replace(PROBE, "").toLowerCase());
    if (bytes.byteLength <= 2 * 1024 * 1024) {
      // Lenient: a few containers are not valid UTF-8 (latin-1 accented
      // letters), and a missed probe would hide a provided name.
      const m = PROVIDES_RE.exec(decodeTextLenient(bytes));
      if (m) provides.add(m[1].toLowerCase().trim());
    }
  }

  // Land the tree in OPFS.
  const tds = await tdsDir();
  for (const [rel, bytes] of files) await writeFile(tds, rel, bytes);

  manifest.packages[name] = {
    name,
    category: meta.category,
    revision: meta.revision,
    shortdesc: meta.shortdesc,
    size: buf.length,
    provides: [...provides].sort(),
    files: [...files.keys()].sort(),
    installedAt: new Date().toISOString(),
  };
  await saveManifest(manifest);
  return info(manifest.packages[name]);
}

async function doRemove(name: string): Promise<void> {
  const manifest = await readManifest();
  const entry = manifest.packages[name];
  if (!entry) throw new PackageError(`unknown package: ${name}`, 404);

  const tds = await tdsDir();
  const ancestors = new Set<string>();
  for (const rel of entry.files) {
    const parts = rel.split("/");
    const file = parts.pop() as string;
    let dir: FileSystemDirectoryHandle = tds;
    try {
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      await dir.removeEntry(file).catch(() => undefined);
    } catch {
      continue; // the path is already gone
    }
    for (let i = 1; i < parts.length; i++)
      ancestors.add(parts.slice(0, i).join("/"));
  }
  delete manifest.packages[name];
  await saveManifest(manifest);

  // Prune directories this package left empty (deepest first). A
  // removeEntry without recursive succeeds only on an EMPTY directory, so
  // a directory shared with another package is kept.
  for (const rel of [...ancestors].sort((a, b) => b.length - a.length)) {
    const parts = rel.split("/");
    const dirName = parts.pop() as string;
    let dir: FileSystemDirectoryHandle = tds;
    try {
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      await dir.removeEntry(dirName).catch(() => undefined);
    } catch {
      // an ancestor is already gone: nothing left to prune on the branch
    }
  }
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
// Raised from the server store's 512 KB: biblatex.sty is 538 KB, and the
// old cap silently skipped it — its \RequirePackage{logreq} went unscanned
// and the dependency was never installed.
const SCAN_MAX = 4 * 1024 * 1024;
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
  // Conditional dep: footmisc.sty \RequirePackage{perpage} only when loaded
  // with the perpage option — the scanner's regex can't see conditionals.
  // perpage.sty ships in the bigfoot tlpkg (no standalone package).
  perpage: "bigfoot",
  // manyfoot.sty ships in the ncctools tlpkg (bigfoot \RequirePackage's it).
  manyfoot: "ncctools",
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
      const res = await fetch("/api/texlive/texlive-basic.js");
      if (!res.ok)
        throw new Error(`texlive-basic.js -> HTTP ${res.status}`);
      const src = await res.text();
      const start = src.indexOf("loadPackage({\"files\"");
      if (start < 0) throw new Error("file map not found in texlive-basic.js");
      const j = src.indexOf("[", start);
      let depth = 0;
      for (let k = j; k < src.length; k++) {
        if (src[k] === "[") depth++;
        else if (src[k] === "]" && --depth === 0) {
          const map = src.slice(j, k + 1);
          const names = new Set<string>();
          for (const m of map.matchAll(/\{"filename": "([^"]+)"/g))
            names.add(m[1].split("/").pop() ?? m[1]);
          return names;
        }
      }
      throw new Error("unterminated file map in texlive-basic.js");
    })();
    basicNames.catch(() => (basicNames = null)); // don't cache a failure
  }
  return basicNames;
}

async function resolveDeps(
  pkg: string,
  basic: Set<string> | null,
  installed: string[],
  unresolved: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entry = (await readManifest()).packages[pkg];
  if (!entry) return;

  // 1. Collect every package name this container's LaTeX files require.
  const deps = new Set<string>();
  const tds = await tdsDir();
  for (const rel of entry.files) {
    if (!SCAN_RE.test(rel)) continue;
    if (DOC_PATH_RE.test(rel) || DOC_FILE_RE.test(rel)) continue;
    const bytes = await readBytes(tds, rel);
    if (!bytes || bytes.byteLength > SCAN_MAX) continue;
    // Lenient: algorithm2e.sty is not valid UTF-8 (latin-1 bytes), and a
    // strict decode would hand the scan an empty source — its
    // \RequirePackage{ifoddpage/relsize/...} would go unreported.
    const src = decodeTextLenient(bytes);
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

// ---------------------------------------------------------------------------
// search (tlpdb metadata + installed flag)
// ---------------------------------------------------------------------------

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
