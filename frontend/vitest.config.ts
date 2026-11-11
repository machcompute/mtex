import path from "node:path";
import { defineConfig } from "vitest/config";

// The default suite is unit-only: no browser, no network, no real OPFS, no
// engine. Library tests run in plain Node; page/component tests run in jsdom
// with the heavy boundaries (Monaco, pdf.js, the TeX worker, CTAN) replaced
// by controllable stubs (tests/support). The browser e2e scripts live in
// e2e/ and are deliberately outside every `include`.
const alias = { "@": path.resolve(__dirname, "src") };

export default defineConfig({
  resolve: { alias },
  esbuild: { jsx: "automatic" },
  test: {
    css: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "lib",
          environment: "node",
          include: ["tests/lib/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/support/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "page",
          environment: "jsdom",
          include: ["tests/page/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/support/setup.ts", "tests/support/page-setup.ts"],
        },
      },
    ],
  },
});
