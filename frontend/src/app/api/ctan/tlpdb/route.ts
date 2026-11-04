// The CTAN package database (tlnet tlpdb, ~20 MB): metadata for package
// search and the container sizes/checksums install verifies against.
//
//   GET /api/ctan/tlpdb
//
// The client downloads it once and keeps it in OPFS; see
// src/lib/ctan-store.ts. Stateless pass-through — CTAN sends no CORS
// headers, so the browser needs this pipe.

import { ctanStream } from "@/lib/ctan-proxy";

export async function GET() {
  return ctanStream("tlpkg/texlive.tlpdb");
}
