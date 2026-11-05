/**
 * Project storage on the browser's Origin Private File System (OPFS).
 *
 * A project is two folders keyed by the same id:
 *   projects/<id>/    the content — the project's files at their relative
 *                     paths (the .tex/.bib/images the compiler sees)
 *   artifacts/<id>/   per-project artifacts — project.json (settings) and
 *                     preview.png (the dashboard thumbnail), plus room for
 *                     any future derived data (build caches, …)
 * Keeping content and artifacts apart means a content walk never has to
 * special-case metadata, and derived artifacts can grow under artifacts/
 * without touching the source tree.
 *
 * The editor page's in-memory `files` map remains the session's source of
 * truth for content; this module only persists and restores it. Saves are
 * diff-based (callers pass the refs they last persisted) so a keystroke
 * rewrites one file, not the tree.
 */

/**
 * File contents: text files are strings, binary files are byte arrays
 * (ArrayBuffer-backed, so they can be written straight to OPFS).
 */
export type FileData = string | Uint8Array<ArrayBuffer>;

export type ProjectSource = {
  kind: "github";
  owner: string;
  repo: string;
  branch: string;
};

export type ProjectMeta = {
  v: 1;
  name: string;
  mainPath: string;
  openPaths: string[];
  activePath: string;
  createdAt: number;
  updatedAt: number;
  source?: ProjectSource;
};

export type ProjectSummary = ProjectMeta & { id: string };

const PROJECTS_DIR = "projects";
/**
 * Per-project artifacts (settings, thumbnails, build data): the same <id>
 * folders as projects/, but holding derived data rather than content.
 */
const ARTIFACTS_DIR = "artifacts";
/** The project's settings file, stored in artifacts/<id>/. */
const META_FILE = "project.json";
/**
 * The square first-page thumbnail the dashboard shows. It is an artifact, not
 * content: it lives in artifacts/<id>/ and is skipped by every content walk so
 * it never reaches the in-memory `files` map (file browser, compiler, counts).
 */
export const PREVIEW_FILE = "preview.png";

/** localStorage key of the project open in the last session. */
export const ACTIVE_PROJECT_KEY = "homehub-active-project-v1";

/**
 * Extensions that are always treated as binary (never decoded as text).
 * Shared by folder uploads and the GitHub pull so the two stay in lockstep.
 */
export const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "avif",
  "pdf",
  "pfb",
  "pfa",
  "otf",
  "ttf",
  "woff",
  "woff2",
  "eot",
]);

/**
 * File names that collide with Object.prototype. Storing them as keys of the
 * plain `files` object would shadow the inherited members, so they are refused
 * outright and every lookup uses Object.hasOwn.
 */
export const RESERVED_NAMES = new Set(["constructor", "__proto__", "prototype"]);

async function projectsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(PROJECTS_DIR, { create: true });
}

async function artifactsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ARTIFACTS_DIR, { create: true });
}

function textBytes(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(s));
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
export function decodeText(buf: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Lenient UTF-8 decode: invalid bytes become U+FFFD instead of failing.
 * For pattern scans over .sty/.cls sources — some old packages (the
 * algorithm2e.sty, latin-1 accented letters) are not valid UTF-8, and a
 * strict decode would make the scan see an empty file and report zero
 * dependencies. The patterns looked for are ASCII, so the replacements
 * are inert.
 */
export function decodeTextLenient(buf: Uint8Array): string {
  return new TextDecoder("utf-8").decode(buf);
}

// The DOM lib types lag behind the async-iterable directory handles that
// both Chromium and Firefox ship; walk them through this.
async function* iterDir(
  dir: FileSystemDirectoryHandle,
): AsyncGenerator<FileSystemHandle> {
  const values = (
    dir as unknown as { values(): AsyncIterableIterator<FileSystemHandle> }
  ).values;
  for await (const entry of values.call(dir)) yield entry;
}

async function readMeta(
  dir: FileSystemDirectoryHandle,
): Promise<ProjectMeta | null> {
  try {
    const fh = await dir.getFileHandle(META_FILE);
    const file = await fh.getFile();
    const meta = JSON.parse(await file.text()) as ProjectMeta;
    return meta && meta.v === 1 && typeof meta.name === "string"
      ? meta
      : null;
  } catch {
    return null; // missing or unreadable meta: treat as not a project
  }
}

async function writeMeta(
  dir: FileSystemDirectoryHandle,
  meta: ProjectMeta,
): Promise<void> {
  const fh = await dir.getFileHandle(META_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(textBytes(JSON.stringify(meta)));
  await w.close();
}

/** The project's content dir, projects/<id>/, or null when it doesn't exist. */
async function projectDir(
  id: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await projectsRoot()).getDirectoryHandle(id);
  } catch {
    return null;
  }
}

/** The project's artifacts dir, artifacts/<id>/ (created on demand). */
async function artifactsDir(id: string): Promise<FileSystemDirectoryHandle> {
  return (await artifactsRoot()).getDirectoryHandle(id, { create: true });
}

/**
 * A project's settings. Read from artifacts/<id>/project.json; when it's not
 * there but the OLD in-project location (projects/<id>/) still has it, move it
 * across first (a one-time, idempotent migration for pre-layout stores).
 * Returns null when the project has no readable meta. `pDir` is the
 * projects/<id>/ handle (may be null).
 */
async function getMeta(
  id: string,
  pDir: FileSystemDirectoryHandle | null,
): Promise<ProjectMeta | null> {
  const aRoot = await artifactsRoot();
  try {
    const meta = await readMeta(await aRoot.getDirectoryHandle(id));
    if (meta) return meta;
  } catch {
    // no artifacts/<id>/ yet
  }
  if (pDir) {
    const meta = await readMeta(pDir);
    if (meta) {
      await writeMeta(await artifactsDir(id), meta);
      await pDir.removeEntry(META_FILE).catch(() => {});
      return meta;
    }
  }
  return null;
}

/**
 * Read an artifact file (by name) from artifacts/<id>/; when it's not there
 * but still lives in the OLD in-project location (projects/<id>/name), move it
 * across first. Returns the bytes, or null when it's in neither place.
 */
async function readArtifact(
  id: string,
  name: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const aRoot = await artifactsRoot();
  const readFrom = async (d: FileSystemDirectoryHandle) =>
    new Uint8Array(
      await (await (await d.getFileHandle(name)).getFile()).arrayBuffer(),
    );
  try {
    return await readFrom(await aRoot.getDirectoryHandle(id));
  } catch {
    // not in artifacts yet
  }
  const pDir = await projectDir(id);
  if (!pDir) return null;
  try {
    const bytes = await readFrom(pDir);
    await writeFile(await artifactsDir(id), name, bytes);
    await pDir.removeEntry(name).catch(() => {});
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Walk a folder into a path -> bytes map (skips project.json and
 * preview.png — those are artifacts, not content; the skip is a no-op in the
 * current layout but covers a store mid-migration). Shared with the CTAN
 * package store, which walks its texmf-dist tree the same way.
 */
export async function walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix = "",
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const out = new Map<string, Uint8Array<ArrayBuffer>>();
  for await (const entry of iterDir(dir)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // The lib types don't discriminate on kind, so narrow by cast.
    if (entry.kind === "directory") {
      if (entry.name === META_FILE) continue;
      for await (const [p, b] of await walkFiles(entry as FileSystemDirectoryHandle, path))
        out.set(p, b);
    } else if (entry.name !== META_FILE && entry.name !== PREVIEW_FILE) {
      const file = await (entry as FileSystemFileHandle).getFile();
      out.set(path, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return out;
}

/**
 * Write one file under `dir` at `path` (posix, subdirectories created).
 * Text is encoded as UTF-8; byte arrays are written as-is. Shared with the
 * CTAN package store.
 */
export async function writeFile(
  dir: FileSystemDirectoryHandle,
  path: string,
  data: FileData,
): Promise<void> {
  const parts = path.split("/");
  let d = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    d = await d.getDirectoryHandle(parts[i], { create: true });
  }
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(typeof data === "string" ? textBytes(data) : data);
  await w.close();
}

/**
 * Create an empty project folder and return its id.
 */
export async function createProjectFolder(): Promise<string> {
  const id = crypto.randomUUID();
  await (await projectsRoot()).getDirectoryHandle(id, { create: true });
  return id;
}

/**
 * Create a complete project (files + meta) and return its id.
 */
export async function createProject(
  name: string,
  files: Record<string, FileData>,
  meta?: Partial<Pick<ProjectMeta, "mainPath" | "openPaths" | "activePath" | "source">>,
): Promise<string> {
  const id = await createProjectFolder();
  const dir = await (await projectsRoot()).getDirectoryHandle(id);
  for (const [p, data] of Object.entries(files)) await writeFile(dir, p, data);
  const now = Date.now();
  await writeMeta(await artifactsDir(id), {
    v: 1,
    name,
    mainPath: meta?.mainPath ?? "",
    openPaths: meta?.openPaths ?? [],
    activePath: meta?.activePath ?? "",
    createdAt: now,
    updatedAt: now,
    ...(meta?.source ? { source: meta.source } : {}),
  });
  return id;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = await projectsRoot();
  const out: ProjectSummary[] = [];
  for await (const entry of iterDir(root)) {
    if (entry.kind !== "directory") continue;
    const dir = entry as FileSystemDirectoryHandle;
    const meta = await getMeta(dir.name, dir);
    if (meta) out.push({ ...meta, id: dir.name });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Load a project's meta + files (text files decoded, invalid UTF-8 kept as
 * bytes). Throws when the project is missing.
 */
export async function loadProject(
  id: string,
): Promise<{ meta: ProjectMeta; files: Record<string, FileData> }> {
  const dir = await projectDir(id);
  const meta = await getMeta(id, dir);
  if (!meta) throw new Error(`project ${id} has no readable meta`);
  const raw = dir ? await walkFiles(dir) : new Map<string, Uint8Array<ArrayBuffer>>();
  const files: Record<string, FileData> = {};
  for (const [p, bytes] of raw) {
    files[p] = decodeText(bytes) ?? bytes;
  }
  return { meta, files };
}

/**
 * Persist the current state. `saved` maps each path to the FileData ref the
 * caller last persisted; only changed (new-ref) and removed paths are
 * written, then the meta is refreshed. On success the caller should adopt
 * the current refs as its new `saved` map.
 */
export async function saveProject(
  id: string,
  meta: ProjectMeta,
  files: Record<string, FileData>,
  saved: Map<string, FileData>,
): Promise<void> {
  const dir = await (await projectsRoot()).getDirectoryHandle(id);
  for (const [p, data] of Object.entries(files)) {
    if (!saved.has(p) || saved.get(p) !== data) await writeFile(dir, p, data);
  }
  for (const p of saved.keys()) {
    if (!Object.hasOwn(files, p)) {
      const parts = p.split("/");
      const name = parts.pop() as string;
      let d = dir;
      for (const part of parts) {
        d = await d.getDirectoryHandle(part);
      }
      await d.removeEntry(name);
    }
  }
  await writeMeta(await artifactsDir(id), { ...meta, updatedAt: Date.now() });
}

export async function updateProjectMeta(
  id: string,
  patch: Partial<ProjectMeta>,
): Promise<void> {
  const dir = await projectDir(id);
  const meta = await getMeta(id, dir);
  if (!meta) throw new Error(`project ${id} has no readable meta`);
  await writeMeta(await artifactsDir(id), { ...meta, ...patch, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  const root = await projectsRoot();
  await root.removeEntry(id, { recursive: true }).catch(() => {});
  const aRoot = await artifactsRoot();
  await aRoot.removeEntry(id, { recursive: true }).catch(() => {});
}

/**
 * Persist the project's square first-page thumbnail (see PREVIEW_FILE).
 * Overwrites any previous one; the artifacts folder is created if missing.
 */
export async function savePreview(
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await writeFile(await artifactsDir(id), PREVIEW_FILE, bytes);
}

/**
 * Read a project's thumbnail bytes, or null when it has never compiled (or the
 * file is missing/unreadable). The dashboard falls back to a placeholder then.
 */
export async function loadPreview(
  id: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  return readArtifact(id, PREVIEW_FILE);
}


