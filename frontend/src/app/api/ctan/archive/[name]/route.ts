// A CTAN tlnet install container:
//
//   GET /api/ctan/archive/<name>   ->   archive/<name>.tar.xz
//
// The client XZ-decompresses and tar-parses it in the browser and keeps
// the files in OPFS (src/lib/ctan-store.ts). The name is validated before
// the URL is built — it is a tlpkg name (lowercase letters, digits,
// hyphens), never a path.

import { ctanStream } from "@/lib/ctan-proxy";

const TLPKG_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!TLPKG_NAME_RE.test(name)) {
    return new Response("bad package name", { status: 400 });
  }
  return ctanStream(`archive/${name}.tar.xz`);
}
