// Remove an installed package from the store:
//
//   DELETE /api/packages/[name]

import { PackageError, removePackage } from "@/lib/texlive-packages";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    await removePackage(name);
    return Response.json({ removed: name });
  } catch (err) {
    if (err instanceof PackageError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(`[packages] remove ${name} failed:`, err);
    return Response.json({ error: "remove failed" }, { status: 500 });
  }
}
