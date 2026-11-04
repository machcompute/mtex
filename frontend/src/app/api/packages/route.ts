// The server's CTAN package store (see src/lib/texlive-packages.ts).
//
// GET  /api/packages            the installed packages
// POST /api/packages {"name"}   install a package from CTAN
//
// Installing/removing a package does not reach the running engine: the
// page disposes the compiler after a change so the next compile restarts
// the worker with a fresh miss cache and package list.

import {
  installPackage,
  listPackages,
  PackageError,
} from "@/lib/texlive-packages";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function GET() {
  try {
    return Response.json({ packages: await listPackages() });
  } catch (err) {
    console.error("[packages] list failed:", err);
    return Response.json({ error: "could not list packages" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let name: string | undefined;
  try {
    const body: unknown = await request.json();
    const candidate = (body as { name?: unknown })?.name;
    if (typeof candidate === "string") name = candidate.trim();
  } catch {
    // fall through: invalid body
  }
  if (!name || !NAME_RE.test(name)) {
    return Response.json(
      { error: "body must be { name: '<package name>' }" },
      { status: 400 },
    );
  }

  try {
    const info = await installPackage(name);
    return Response.json({ package: info }, { status: 201 });
  } catch (err) {
    if (err instanceof PackageError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(`[packages] install ${name} failed:`, err);
    return Response.json({ error: "install failed" }, { status: 500 });
  }
}
