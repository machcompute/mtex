// Parsing and lookups for the modern (XDV-style) .synctex file — the one
// xetex writes with --synctex=1, whether the PDF comes straight from xetex
// or via xdvipdfmx (both emit the same format).
//
// Layout:
//   SyncTeX Version:1
//   Input:<n>:<path>        1-based table; a record's first field indexes it
//   Output:xdv|pdf
//   Magnification:1000
//   Unit:1
//   X Offset:<n>            integer offsets ADDED to the record coordinates
//   Y Offset:<n>
//   Content:
//   {<page> ... }<page>     page context for the records between the markers
//   <t>,<n>,<line>:<x>,<y>[:extra]     t ∈ g h k x r $ ( ) [ ]
//   !<n>                    internal counters (ignored)
//   Postamble:
//   Count:<n>
//   Post scriptum:
//
// Input lines may be appended in the postamble (files TeX reads late, like
// the .aux), so the whole file is scanned for them.
//
// Coordinates: record units are 1/65536 of a TeX (DVI) point (72.27/in);
// the PDF uses 72/in. y is page-relative and grows downward — the same
// visual space pdf.js renders into:
//
//   yFromTop [PDF pt] = (y + Y Offset) * (72 / 72.27) / 65536
//
// Calibrated against the reference `synctex` CLI oracle: residuals below
// 0.001 pt on both xelatex-direct and xdvipdfmx-produced PDFs.
//
// Records are grouped per (page, baseline, file, source line), so one
// entry is one physical line a source line occupies; a source line that
// wraps over several physical lines yields several entries.
//
// The file is gzip-compressed when the engine was built with zlib.

export type SyncEntry = {
  /** 1-based PDF page number. */
  page: number;
  /**
   * Baseline of the source line on that physical line, in points from the
   * top of the page (visual space).
   */
  yTop: number;
  /** Leftmost x of the line's records, in points from the left edge. */
  xLeft: number;
  /** Rightmost x of the line's records, in points from the left edge. */
  xRight: number;
  /** True when the line's records include glyphs (not just markers). */
  hasGlyph: boolean;
  /** 1-based source line number. */
  line: number;
  /** Flat project file name (basename of the Input-table path). */
  file: string;
};

// TeX (DVI) points per PDF point: 72.27 vs 72 points per inch.
const DVI_PT_TO_PDF_PT = 72 / 72.27;
// Record coordinates are in 1/65536 of a DVI point.
const UNITS_PER_PDF_PT = 65536 / DVI_PT_TO_PDF_PT;

function toPts(v: number, offset: number): number {
  return (v + offset) / UNITS_PER_PDF_PT;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  // bytes is worker output (always an ArrayBuffer-backed view).
  const buffer = (bytes.buffer as ArrayBuffer).slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const stream = new Blob([buffer]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Response(stream).text();
}

type Agg = {
  file: string;
  line: number;
  page: number;
  y: number;
  xLeft: number;
  xRight: number;
  hasGlyph: boolean;
};

/** Decode synctex bytes (gzipped or plain) into lookup entries. */
export async function decodeSynctex(bytes: Uint8Array): Promise<SyncEntry[]> {
  const text =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? await gunzip(bytes)
      : new TextDecoder().decode(bytes);

  const inputs = new Map<number, string>();
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;
  let inContent = false;
  const aggs = new Map<string, Agg>();

  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("Input:")) {
      const m = raw.match(/^Input:(\d+):(.*)$/);
      if (m) inputs.set(Number.parseInt(m[1], 10), basename(m[2]));
      continue;
    }
    if (raw.startsWith("X Offset:")) {
      xOffset = Number.parseInt(raw.slice("X Offset:".length), 10) || 0;
      continue;
    }
    if (raw.startsWith("Y Offset:")) {
      yOffset = Number.parseInt(raw.slice("Y Offset:".length), 10) || 0;
      continue;
    }
    if (raw === "Content:") {
      inContent = true;
      continue;
    }
    if (raw.startsWith("Postamble:")) {
      inContent = false;
      continue;
    }
    if (!inContent) continue;

    const t = raw[0];
    if (t === "{") {
      page = Number.parseInt(raw.slice(1), 10) || 0;
      continue;
    }
    if (t === "}" || t === "!") continue;
    if (!"ghkxr$()[]".includes(t)) continue;

    const m = raw.slice(1).match(/^(\d+),(\d+):(-?\d+),(-?\d+)(?::(.*))?$/);
    if (!m) continue;
    const idx = Number.parseInt(m[1], 10);
    const file = inputs.get(idx);
    const line = Number.parseInt(m[2], 10);
    const x = Number.parseInt(m[3], 10);
    const y = Number.parseInt(m[4], 10);
    if (!file || !page || !line || !Number.isFinite(x) || !Number.isFinite(y))
      continue;

    const hasGlyph = t === "g" || t === "k" || t === "x";
    const key = `${page}:${y}:${idx}:${line}`;
    const agg = aggs.get(key);
    if (agg) {
      if (x < agg.xLeft) agg.xLeft = x;
      if (x > agg.xRight) agg.xRight = x;
      if (hasGlyph) agg.hasGlyph = true;
    } else {
      aggs.set(key, { file, line, page, y, xLeft: x, xRight: x, hasGlyph });
    }
  }

  const entries: SyncEntry[] = [];
  for (const a of aggs.values()) {
    entries.push({
      page: a.page,
      yTop: toPts(a.y, yOffset),
      xLeft: toPts(a.xLeft, xOffset),
      xRight: toPts(a.xRight, xOffset),
      hasGlyph: a.hasGlyph,
      line: a.line,
      file: a.file,
    });
  }
  return entries;
}

/**
 * Inverse sync: the source line for a point in the PDF (points, origin at
 * the top-left of the page).
 *
 * 1. The click belongs to the physical line whose baseline (yTop) is
 *    closest to the click's y (a tie goes to the line below — its
 *    descenders reach into that space).
 * 2. Several source lines can share one physical line: a wrapped source
 *    line, or a group marker recorded at the position where the group
 *    opened. The click's x breaks the tie: the line whose text starts
 *    just before the cursor wins; actual glyphs beat a bare group/move
 *    marker.
 */
export function findSourceForPoint(
  entries: SyncEntry[],
  page: number,
  xLeft: number,
  yTop: number,
): SyncEntry | null {
  let best: SyncEntry | null = null;
  for (const e of entries) {
    if (e.page !== page) continue;
    if (!best) {
      best = e;
      continue;
    }
    const d = Math.abs(e.yTop - yTop) - Math.abs(best.yTop - yTop);
    if (d < 0 || (d === 0 && e.yTop > best.yTop)) best = e;
  }
  if (!best) return null;

  const baseline = best.yTop;
  const cands = entries.filter(
    (e) => e.page === page && Math.abs(e.yTop - baseline) < 0.001,
  );
  const before = cands.filter((c) => c.xLeft <= xLeft);
  const pool = before.length > 0 ? before : cands;
  pool.sort(
    (a, b) =>
      (before.length > 0 ? b.xLeft - a.xLeft : a.xLeft - b.xLeft) ||
      (b.hasGlyph ? 1 : 0) - (a.hasGlyph ? 1 : 0) ||
      b.xRight - a.xRight ||
      a.line - b.line,
  );
  return pool[0];
}

/**
 * Forward sync: the PDF position for a source line. Uses the entry with
 * the greatest source line at or above the given line, else the nearest.
 */
export function findOutputForSource(
  entries: SyncEntry[],
  file: string,
  line: number,
): SyncEntry | null {
  let atOrAbove: SyncEntry | null = null;
  let below: SyncEntry | null = null;
  for (const e of entries) {
    if (e.file !== file) continue;
    if (e.line <= line) {
      if (!atOrAbove || e.line > atOrAbove.line) atOrAbove = e;
    } else if (!below || e.line < below.line) {
      below = e;
    }
  }
  return atOrAbove ?? below;
}
