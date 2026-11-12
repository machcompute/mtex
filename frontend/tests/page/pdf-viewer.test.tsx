// The REAL PdfViewer (the page tests stub it out) over a mocked pdf.js.
// Regression: resizing the pane used to destroy the document loading task and
// reload the worker on every width change ("PDF flashes and reloads
// pdf.worker.min when resizing"). The document must be loaded once per PDF and
// only its pages re-rendered when the fit/zoom changes.
import { createRef } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, deferred, render, screen, settle } from "../support/page-utils";

type Viewer = typeof import("@/components/pdf-viewer").default;

const pdfjs = vi.hoisted(() => ({
  PAGE_W: 600,
  PAGE_H: 800,
  numPages: 2,
  getDocument: vi.fn(),
  destroys: [] as number[],
  renders: [] as { page: number; scale: number; canvas: HTMLCanvasElement }[],
  cancels: [] as number[],
  // When set, page renders wait on it (to observe mid-render behaviour).
  gate: null as null | Promise<void>,
  loadError: null as null | Error,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  Util: {
    // [a b c d e f] x [a b c d e f] (2D affine), as pdf.js's Util.transform.
    transform: (m1: number[], m2: number[]) => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ],
  },
  getDocument: pdfjs.getDocument,
}));

let loadId = 0;
beforeEach(() => {
  pdfjs.numPages = 2;
  pdfjs.destroys = [];
  pdfjs.renders = [];
  pdfjs.cancels = [];
  pdfjs.gate = null;
  pdfjs.loadError = null;
  loadId = 0;
  pdfjs.getDocument.mockImplementation(() => {
    const id = ++loadId;
    const pdf = {
      numPages: pdfjs.numPages,
      getPage: async (n: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: pdfjs.PAGE_W * scale,
          height: pdfjs.PAGE_H * scale,
          transform: [scale, 0, 0, -scale, 0, pdfjs.PAGE_H * scale],
        }),
        render: ({ canvas, viewport }: { canvas: HTMLCanvasElement; viewport: { width: number } }) => {
          pdfjs.renders.push({ page: n, scale: viewport.width / pdfjs.PAGE_W, canvas });
          return {
            promise: pdfjs.gate ?? Promise.resolve(),
            cancel: () => pdfjs.cancels.push(id),
          };
        },
        getTextContent: async () => ({
          items: [{ str: `text of page ${n}`, transform: [12, 0, 0, 12, 50, 700] }],
        }),
      }),
    };
    return {
      promise: pdfjs.loadError ? Promise.reject(pdfjs.loadError) : Promise.resolve(pdf),
      destroy: async () => {
        pdfjs.destroys.push(id);
      },
    };
  });
});

// jsdom has no layout: the pane width is whatever the test says it is, and the
// ResizeObserver callback is fired by hand.
let paneWidth = 832;
const observers: (() => void)[] = [];
beforeEach(() => {
  paneWidth = 832;
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-pdf-viewer") ? paneWidth : 0;
  });
});

async function resizeTo(width: number) {
  paneWidth = width;
  await act(async () => {
    observers.forEach((cb) => cb());
  });
  await settle();
}

const pane = () => document.querySelector("[data-pdf-viewer]") as HTMLElement;
const wrappers = () => Array.from(pane().querySelectorAll<HTMLElement>("[data-page]"));
const bytes = (s = "%PDF-1.7 a") => new TextEncoder().encode(s);

async function mount(props: Partial<React.ComponentProps<Viewer>> = {}, data: Uint8Array | null = bytes()) {
  const { default: PdfViewer } = await vi.importActual<typeof import("@/components/pdf-viewer")>("@/components/pdf-viewer");
  const ui = (d: Uint8Array | null) => <PdfViewer data={d} {...props} />;
  const view = render(ui(data));
  await settle();
  return { ...view, rerenderWith: (d: Uint8Array | null) => view.rerender(ui(d)) };
}

describe("PdfViewer: loading", () => {
  it("loads the document once and renders every page with its dataset, canvas and text layer", async () => {
    const onNumPages = vi.fn();
    await mount({ onNumPages });
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(wrappers().map((w) => w.dataset.page)).toEqual(["1", "2"]);
    const w1 = wrappers()[0];
    // Pane 832 → (832 - 2*16) / 600 = 1.3333, rounded to 4 decimals.
    expect(w1.dataset.scale).toBe("1.3333");
    expect(w1.dataset.heightPts).toBe("800");
    expect(w1.style.width).toBe("799px");
    expect(w1.querySelector("canvas")).not.toBeNull();
    expect(w1.querySelector("[data-text-layer] span")?.textContent).toBe("text of page 1");
    expect(wrappers()[1].className).toContain("mt-4");
    expect(onNumPages.mock.calls.map((c) => c[0])).toEqual([0, 2]);
    expect(screen.getByText("1 / 2")).toBeTruthy();
    // The first render is already at the fit scale (no wasted 1.5 pass).
    expect(pdfjs.renders.map((r) => r.scale.toFixed(4))).toEqual(["1.3333", "1.3333"]);
  });

  it("hands pdf.js a copy so the caller's bytes stay readable", async () => {
    const data = bytes("%PDF-1.7 abcdef");
    await mount({}, data);
    const arg = pdfjs.getDocument.mock.calls[0][0] as { data: Uint8Array };
    expect(arg.data).not.toBe(data);
    expect(Array.from(arg.data)).toEqual(Array.from(data));
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it("shows the empty state (and never starts pdf.js) without a PDF", async () => {
    const onNumPages = vi.fn();
    await mount({ onNumPages }, null);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(pane().textContent).toContain("No PDF output yet");
    expect(onNumPages).toHaveBeenLastCalledWith(0);
    expect(screen.getByTitle("Download PDF")).toHaveProperty("disabled", true);
  });

  it("an empty buffer is the empty state too", async () => {
    await mount({}, new Uint8Array(0));
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(pane().textContent).toContain("No PDF output yet");
  });

  it("reports a load failure in the pane", async () => {
    pdfjs.loadError = new Error("Invalid PDF structure");
    await mount();
    expect(pane().querySelector("[data-render-error]")?.textContent).toContain("Invalid PDF structure");
    expect(wrappers()).toHaveLength(0);
  });
});

describe("PdfViewer: resizing the pane (no flash, no worker reload)", () => {
  it("keeps the loading task and re-renders the existing document at the new fit scale", async () => {
    await mount();
    const before = wrappers();
    expect(pdfjs.renders).toHaveLength(2);

    await resizeTo(632); // (632 - 32) / 600 = 1
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroys).toEqual([]);
    expect(wrappers().map((w) => w.dataset.scale)).toEqual(["1", "1"]);
    expect(wrappers()[0].style.width).toBe("600px");
    expect(wrappers()[0]).not.toBe(before[0]);
    expect(pdfjs.renders.slice(2).map((r) => r.scale)).toEqual([1, 1]);
    // Text layer and page badge survive the re-render.
    expect(wrappers()[1].querySelector("[data-text-layer] span")?.textContent).toBe("text of page 2");
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("a burst of resizes never creates or destroys a task", async () => {
    await mount();
    for (const w of [700, 650, 900, 1000, 640]) await resizeTo(w);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroys).toEqual([]);
    expect(wrappers()).toHaveLength(2);
  });

  it("a resize that leaves the fit scale unchanged re-renders nothing", async () => {
    await mount();
    await resizeTo(832); // same width
    expect(pdfjs.renders).toHaveLength(2);
    // 4-decimal rounding: 0.01px of width is below the rounding step.
    await resizeTo(832.004);
    expect(pdfjs.renders).toHaveLength(2);
  });

  it("never blanks the pane while the new pages render (old pages stay until the swap)", async () => {
    await mount();
    const old = wrappers();
    const gate = deferred<void>();
    pdfjs.gate = gate.promise;
    await resizeTo(632);
    // New pages are still rendering: the pane still shows the old ones.
    expect(old.every((w) => w.isConnected)).toBe(true);
    expect(wrappers().map((w) => w.dataset.scale)).toEqual(["1.3333", "1.3333"]);
    await act(async () => gate.resolve());
    await settle();
    expect(old.every((w) => !w.isConnected)).toBe(true);
    expect(wrappers().map((w) => w.dataset.scale)).toEqual(["1", "1"]);
  });

  it("a newer resize cancels the in-flight page render of the previous one", async () => {
    await mount();
    pdfjs.gate = new Promise(() => {}); // never finishes
    await resizeTo(632);
    expect(pdfjs.cancels).toEqual([]);
    await resizeTo(732);
    expect(pdfjs.cancels).toEqual([1]); // the first render task was cancelled
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroys).toEqual([]);
  });

  it("keeps the reader's place when the scale changes", async () => {
    await mount();
    pane().scrollTop = 400;
    await resizeTo(632); // 1.3333 → 1
    expect(pane().scrollTop).toBeCloseTo(300, 0);
  });
});

describe("PdfViewer: zoom", () => {
  it("manual zoom re-renders the same document; later resizes no longer change the scale", async () => {
    await mount();
    await act(async () => screen.getByTitle("Actual size (100%)").click());
    await settle();
    expect(wrappers().map((w) => w.dataset.scale)).toEqual(["1", "1"]);
    await act(async () => screen.getByTitle("Zoom in").click());
    await settle();
    expect(wrappers().map((w) => w.dataset.scale)).toEqual(["1.25", "1.25"]);
    const renders = pdfjs.renders.length;
    await resizeTo(500);
    expect(pdfjs.renders).toHaveLength(renders);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroys).toEqual([]);
    // Fit to width follows the pane again.
    await act(async () => screen.getByTitle("Fit to width").click());
    await settle();
    expect(wrappers()[0].dataset.scale).toBe("0.78");
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });
});

describe("PdfViewer: new PDF bytes", () => {
  it("destroys the old task, loads one new task and resets the page state", async () => {
    const onNumPages = vi.fn();
    const v = await mount({ onNumPages });
    pdfjs.numPages = 3;
    v.rerenderWith(bytes("%PDF-1.7 b"));
    await settle();
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(2);
    expect(pdfjs.destroys).toEqual([1]);
    expect(wrappers().map((w) => w.dataset.page)).toEqual(["1", "2", "3"]);
    expect(onNumPages.mock.calls.map((c) => c[0])).toEqual([0, 2, 0, 3]);
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // A re-render with the SAME bytes object is not a new PDF.
    const same = bytes("%PDF-1.7 c");
    v.rerenderWith(same);
    await settle();
    const calls = pdfjs.getDocument.mock.calls.length;
    v.rerenderWith(same);
    await settle();
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(calls);
  });

  it("falls back to the empty state when the PDF goes away, destroying its task", async () => {
    const v = await mount();
    v.rerenderWith(null);
    await settle();
    expect(pdfjs.destroys).toEqual([1]);
    expect(pane().textContent).toContain("No PDF output yet");
    expect(wrappers()).toHaveLength(0);
  });

  it("destroys the task on unmount", async () => {
    const v = await mount();
    v.unmount();
    expect(pdfjs.destroys).toEqual([1]);
  });
});

describe("PdfViewer: callbacks survive a re-render", () => {
  it("click → onPageClick in points, snapping to the clicked line's baseline", async () => {
    const onPageClick = vi.fn();
    await mount({ onPageClick });
    await resizeTo(632); // scale 1
    const span = wrappers()[1].querySelector("span") as HTMLElement;
    // jsdom rects are all zero: a click at (0, 0) is inside; the span's
    // baseline (CSS px at scale 1) wins over the raw y.
    await act(async () => span.click());
    expect(onPageClick).toHaveBeenCalledTimes(1);
    const [page, x, y] = onPageClick.mock.calls[0];
    expect(page).toBe(2);
    expect(x).toBe(0);
    expect(y).toBe(Number(span.dataset.baseline) / 1);
  });

  it("uses the latest onPageClick / onNumPages without re-rendering the PDF", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { default: PdfViewer } = await vi.importActual<typeof import("@/components/pdf-viewer")>("@/components/pdf-viewer");
    const data = bytes();
    const v = render(<PdfViewer data={data} onPageClick={first} />);
    await settle();
    const renders = pdfjs.renders.length;
    v.rerender(<PdfViewer data={data} onPageClick={second} />);
    await settle();
    expect(pdfjs.renders).toHaveLength(renders);
    await act(async () => (wrappers()[0].querySelector("span") as HTMLElement).click());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// jsdom has no layout: give the fake text-layer spans the geometry the
// selection logic reads, the same way the page layout tests fake clientWidth.
function fakeLine(text: string, top: number, height: number): HTMLSpanElement {
  const sp = document.createElement("span");
  sp.textContent = text;
  Object.defineProperty(sp, "offsetTop", { value: top });
  Object.defineProperty(sp, "offsetHeight", { value: height });
  return sp;
}

function fakeLayer(lines: [string, number, number][]): HTMLElement {
  const layer = document.createElement("div");
  for (const [text, top, height] of lines) layer.appendChild(fakeLine(text, top, height));
  return layer;
}

// The page project mocks the whole viewer module (tests/support/page-setup);
// the pure helper comes from the real module, same as the viewer itself.
describe("matchLineSpans (the scrollToPosition selection target)", async () => {
  let matchLineSpans: (layer: ParentNode, yCss: number) => HTMLSpanElement[];
  beforeAll(async () => {
    ({ matchLineSpans } = await vi.importActual<typeof import("@/components/pdf-viewer")>("@/components/pdf-viewer"));
  });
  it("does not throw Range.setStart when the target falls between lines", () => {
    // Two 16px lines; the target lands 60px below the last line (a margin /
    // empty region). No span is within 0.9 * 16 of it, so the old inline
    // filter returned [] and range.setStart(matched[0], 0) threw
    // "Range.setStart: Argument 1 is not an object".
    const layer = fakeLayer([
      ["first line", 0, 16],
      ["second line", 32, 16],
    ]);
    const matched = matchLineSpans(layer, 100);
    expect(matched.length).toBeGreaterThan(0); // never empty for a spanned layer
    expect(matched).toEqual([layer.children[1]]); // the closest line
    // And the range the caller builds from the result no longer throws
    // (the spans must be connected for jsdom to keep the range).
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    document.body.appendChild(layer);
    try {
      const range = document.createRange();
      range.setStart(matched[0], 0);
      const last = matched[matched.length - 1];
      range.setEnd(last, last.childNodes.length);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.rangeCount).toBe(1);
      expect(selection.getRangeAt(0).startContainer).toBe(last);
    } finally {
      selection.removeAllRanges();
      layer.remove();
    }
  });

  it("selects exactly the spans of the line at the target when the target is on a line", () => {
    const layer = fakeLayer([
      ["line one", 0, 16],
      ["line two left", 40, 16],
      ["line two right", 40, 16],
      ["line three", 80, 16],
    ]);
    // Line two's spans share center 48; the other lines are 40px away, well
    // outside the 0.9 * 16 window.
    expect(matchLineSpans(layer, 48).map((s) => s.textContent)).toEqual([
      "line two left",
      "line two right",
    ]);
    expect(matchLineSpans(layer, 8).map((s) => s.textContent)).toEqual(["line one"]);
  });

  it("returns empty for a layer without spans (no throw, no selection)", () => {
    expect(matchLineSpans(document.createElement("div"), 42)).toEqual([]);
  });
});

describe("PdfViewer: imperative handle", () => {
  it("scrollToPosition / getViewportTop work against the re-rendered pages", async () => {
    const { default: PdfViewer } = await vi.importActual<typeof import("@/components/pdf-viewer")>("@/components/pdf-viewer");
    const ref = createRef<import("@/components/pdf-viewer").PdfViewerHandle>();
    render(<PdfViewer ref={ref} data={bytes()} />);
    await settle();
    await resizeTo(632);
    expect(ref.current?.scrollToPosition(1, 100, { select: false, instant: true })).toBe(true);
    expect(ref.current?.getViewportTop()).toEqual({ page: 1, yTop: 0 });
    expect(ref.current?.scrollToPosition(9, 0)).toBe(false);
  });

  it("scrollToPosition selects the closest line without throwing when the target falls in a gap", async () => {
    // Repro of the reported crash: the synctex target lands in a region with
    // no rendered line within 0.9 line-heights, so the old matched list was
    // empty and range.setStart(matched[0], 0) threw "Argument 1 is not an
    // object" after the scroll had already happened.
    const { default: PdfViewer } = await vi.importActual<typeof import("@/components/pdf-viewer")>("@/components/pdf-viewer");
    const ref = createRef<import("@/components/pdf-viewer").PdfViewerHandle>();
    render(<PdfViewer ref={ref} data={bytes()} />);
    await settle();
    await resizeTo(632); // scale 1
    const span = wrappers()[0].querySelector("[data-text-layer] span") as HTMLElement;
    // The page's only rendered line sits 400px below the requested target (20).
    Object.defineProperty(span, "offsetTop", { value: 400 });
    Object.defineProperty(span, "offsetHeight", { value: 16 });
    expect(ref.current?.scrollToPosition(1, 20, { instant: true })).toBe(true);
    const sel = window.getSelection();
    expect(sel?.rangeCount).toBe(1); // the closest line is selected
    expect(sel?.getRangeAt(0).startContainer).toBe(span);
    sel?.removeAllRanges();
  });
});
