import path from "node:path";
import { defineConfig } from "vitest/config";

// The default suite is unit-only: no browser, no network, no real OPFS, no
// engine. DOM-flavoured files opt into jsdom with a `@vitest-environment`
// docblock; everything else runs in plain Node. The browser e2e scripts live
// in e2e/ and are deliberately outside `include`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/support/setup.ts"],
    css: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
