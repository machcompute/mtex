// Registered for the jsdom "page" project only: every heavy boundary the pages
// import is replaced here, once, for every page test file.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { FakeBusyTex } from "./fake-busytex";
import { monacoState } from "./stubs/monaco";
import { pdfState } from "./stubs/pdf-viewer";
import { resetCtan } from "./stubs/ctan";

vi.mock("@/components/monaco-editor", async () => await import("./stubs/monaco"));
vi.mock("@/components/pdf-viewer", async () => await import("./stubs/pdf-viewer"));
vi.mock("@/components/packages-modal", async () => await import("./stubs/packages-modal"));
vi.mock("@/lib/ctan-store", async () => (await import("./stubs/ctan")).ctan);
vi.mock("@/lib/preview", async () => {
  const { vi: v } = await import("vitest");
  return { renderFirstPagePng: v.fn(async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3])) };
});
vi.mock("@/lib/busytex", async (orig) => {
  const actual = await orig<typeof import("@/lib/busytex")>();
  const { FakeBusyTex: Fake } = await import("./fake-busytex");
  return { ...actual, BusyTexCompiler: Fake };
});
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) =>
      React.createElement("a", { href, ...rest }, children),
  };
});
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

// jsdom gaps the real UI libraries (assistant-ui, the file panel) touch.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  if (typeof globalThis.ResizeObserver === "undefined") vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  FakeBusyTex.reset();
  monacoState.reset();
  pdfState.reset();
  resetCtan();
  routerPush.mockClear();
  // Strict React act warnings are noise for the long-lived async effects here.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
});

export { routerPush };
