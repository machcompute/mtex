import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone CommonJS e2e scripts (see e2e/README.md).
    "e2e/**",
    // Engine assets downloaded and cached by the /api/texlive route on
    // first request (minified vendor JS — never lint).
    ".texlive-cache/**",
  ]),
  // The unit-test stubs stand in for heavy components (Monaco, pdf.js, the
  // packages modal) and deliberately record their props/state in module-level
  // test controls; the React Compiler's purity rule is meant for app code.
  {
    files: ["tests/support/stubs/**"],
    rules: { "react-hooks/immutability": "off" },
  },
]);

export default eslintConfig;
