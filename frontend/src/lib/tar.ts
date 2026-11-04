/**
 * Minimal tar reader for CTAN tlnet containers (the decompressed bytes of
 * archive/<name>.tar.xz). CTAN ships POSIX ustar with GNU extensions; the
 * parser covers regular files, directories, and the GNU long-name entry
 * ('L'), and skips everything else (symlinks, hard links, …) after
 * consuming their blocks.
 *
 * Only regular files are returned — the TDS store needs the file set and
 * its bytes; directories are implicit in the paths.
 */

/** A regular file of the archive: archive-relative posix path → bytes. */
export type TarFiles = Map<string, Uint8Array<ArrayBuffer>>;

function readCstr(buf: Uint8Array, start: number, end: number): string {
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  // Archive names are ASCII (CTAN file names); utf-8 decodes them as-is.
  return new TextDecoder("utf-8").decode(buf.subarray(start, i));
}

/** Octal size field (12 bytes, NUL- or space-padded, possibly no pad). */
function readOctal(buf: Uint8Array, start: number): number {
  let i = start;
  while (i < start + 12 && buf[i] !== 0 && buf[i] !== 32) i++;
  const text = new TextDecoder("ascii").decode(buf.subarray(start, i));
  return text === "" ? 0 : parseInt(text, 8);
}

/**
 * Parse a tar archive into its regular files. Throws on a truncated
 * archive or a path that would escape the extraction root (a malicious
 * or corrupt container must fail the install, not write elsewhere).
 */
export function parseTar(buf: Uint8Array<ArrayBuffer>): TarFiles {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let off = 0;
  let pendingName = "";
  let zeroBlocks = 0;

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      zeroBlocks++;
      // Two consecutive zero blocks end the archive; a lone one can
      // appear as padding before the end marker.
      if (zeroBlocks >= 2) break;
      off += 512;
      continue;
    }
    zeroBlocks = 0;

    const typeflag = String.fromCharCode(header[156]);
    const size = readOctal(header, 124);
    const dataEnd = off + 512 + size;
    if (dataEnd > buf.length)
      throw new Error(`tar truncated at entry ${off} (need ${size} more bytes)`);
    const data = buf.subarray(off + 512, dataEnd);
    off += 512 + ((size + 511) & ~511);

    if (typeflag === "L") {
      // GNU long name: this entry's payload is the next entry's name.
      pendingName = readCstr(data, 0, data.length);
      continue;
    }
    if (typeflag !== "0" && header[156] !== 0) {
      // Directory, symlink, hard link, or anything else: consume the
      // blocks, keep no data.
      continue;
    }

    let name = pendingName;
    pendingName = "";
    if (name === "") {
      const prefix = readCstr(header, 345, 500);
      name = prefix ? `${prefix}/${readCstr(header, 0, 100)}` : readCstr(header, 0, 100);
    }
    if (name === "") continue;
    if (name.startsWith("/") || name.split("/").includes(".."))
      throw new Error(`tar entry escapes the archive root: ${name}`);

    files.set(name, data.slice());
  }
  return files;
}
