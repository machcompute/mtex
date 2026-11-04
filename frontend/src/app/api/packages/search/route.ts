// Search the CTAN package database (the tlnet tlpdb, cached on first use):
//
//   GET /api/packages/search?query=tikz&limit=25
//
// Substring match on package name (exact/prefix hits rank first) and
// short description; an empty query lists packages alphabetically. The
// installed flag comes from the local store.

import { searchPackages } from "@/lib/texlive-packages";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25),
  );
  try {
    return Response.json({ results: await searchPackages(query, limit) });
  } catch (err) {
    console.error("[packages] search failed:", err);
    return Response.json(
      { error: "could not search packages (is the CTAN mirror reachable?)" },
      { status: 502 },
    );
  }
}
