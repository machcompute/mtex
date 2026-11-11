// Builders for ustar archives (what a CTAN container holds once decompressed).

function header(name: string, size: number, type = "0", prefix = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
  put(name, 0);
  put(size.toString(8).padStart(11, "0"), 124);
  h[156] = type.charCodeAt(0);
  put(prefix, 345);
  return h;
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function tarEntry(name: string, body: string | Uint8Array, type = "0", prefix = ""): Uint8Array {
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat([header(name, data.length, type, prefix), padded]);
}

const END = new Uint8Array(1024);

/** A complete archive of regular files. */
export function buildTar(files: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  return concat([...Object.entries(files).map(([n, b]) => tarEntry(n, b)), END]);
}

/** A complete archive from pre-built entries. */
export function tarOf(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat([...parts, END]);
}
