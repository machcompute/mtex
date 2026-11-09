import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Next 16's dev-indicator badge renders in the portal at bottom-left by
  // default — exactly where the rail's GitHub/Packages buttons sit — and its
  // 36×36 hit area swallows clicks in e2e. Hiding it keeps errors in the
  // overlay; the position option can't move it far enough.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
