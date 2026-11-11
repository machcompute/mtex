// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakePage = { w: number; h: number };
const pdfjs = vi.hoisted(() => ({
  page: { w: 612, h: 792 } as FakePage,
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
  renderCalls: [] as { canvas: { width: number; height: number }; scale: number }[],
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfjs.getDocument,
}));

import { renderFirstPagePng } from "@/lib/preview";

type FakeCanvas = {
  width: number;
  height: number;
  ctx: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> } | null;
  getContext: () => FakeCanvas["ctx"];
  toBlob: (cb: (b: unknown) => void) => void;
};
const canvases: FakeCanvas[] = [];
let blobResult: "png" | "null" = "png";
let ctxAvailable = true;

beforeEach(() => {
  canvases.length = 0;
  blobResult = "png";
  ctxAvailable = true;
  pdfjs.page = { w: 612, h: 792 };
  pdfjs.renderCalls = [];
  pdfjs.destroy.mockClear();
  pdfjs.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: pdfjs.page.w * scale, height: pdfjs.page.h * scale }),
        render: ({ canvas, viewport }: { canvas: { width: number; height: number }; viewport: { width: number } }) => {
          pdfjs.renderCalls.push({ canvas, scale: viewport.width / pdfjs.page.w });
          return { promise: Promise.resolve() };
        },
      }),
    }),
    destroy: pdfjs.destroy,
  }));
  const real = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return real(tag);
    const c: FakeCanvas = {
      width: 0,
      height: 0,
      ctx: ctxAvailable ? { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() } : null,
      getContext: () => c.ctx,
      toBlob: (cb) =>
        cb(blobResult === "png" ? { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } : null),
    };
    canvases.push(c);
    return c as never;
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("renderFirstPagePng (e2e dashboard: preview.png generation)", () => {
  it("fits a portrait page into a 512 square, letterboxed left/right on white", async () => {
    const pdf = new Uint8Array([1, 2, 3]);
    const png = await renderFirstPagePng(pdf);
    expect(Array.from(png!)).toEqual([137, 80, 78, 71]);
    const [page, out] = canvases;
    // scale = 512 / 792; page canvas = ceil(612*scale) x ceil(792*scale)
    expect(page.height).toBe(512);
    expect(page.width).toBe(Math.ceil((612 * 512) / 792));
    expect([out.width, out.height]).toEqual([512, 512]);
    expect(out.ctx!.fillStyle).toBe("#ffffff");
    expect(out.ctx!.fillRect).toHaveBeenCalledWith(0, 0, 512, 512);
    const [, dx, dy] = out.ctx!.drawImage.mock.calls[0];
    expect(dy).toBe(0);
    expect(dx).toBe(Math.round((512 - page.width) / 2));
  });

  it("letterboxes a landscape page top/bottom", async () => {
    pdfjs.page = { w: 800, h: 400 };
    await renderFirstPagePng(new Uint8Array([1]));
    const [page, out] = canvases;
    expect(page.width).toBe(512);
    const [, dx, dy] = out.ctx!.drawImage.mock.calls[0];
    expect(dx).toBe(0);
    expect(dy).toBe(Math.round((512 - page.height) / 2));
  });

  it("hands pdf.js a COPY of the bytes (the viewer's PDF must survive) and always destroys the task", async () => {
    const pdf = new Uint8Array([9, 8, 7]);
    await renderFirstPagePng(pdf);
    const arg = pdfjs.getDocument.mock.calls[0][0] as { data: Uint8Array };
    expect(arg.data).not.toBe(pdf);
    expect(Array.from(arg.data)).toEqual([9, 8, 7]);
    expect(pdfjs.destroy).toHaveBeenCalledTimes(1);
  });

  it("is best effort: a corrupt PDF, a missing 2d context or a failed encode yields null, never a throw", async () => {
    pdfjs.getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error("Invalid PDF")), destroy: pdfjs.destroy }));
    expect(await renderFirstPagePng(new Uint8Array([0]))).toBeNull();
    expect(pdfjs.destroy).toHaveBeenCalled();
  });

  it("returns null without a 2d context and when toBlob yields nothing", async () => {
    ctxAvailable = false;
    expect(await renderFirstPagePng(new Uint8Array([1]))).toBeNull();
    ctxAvailable = true;
    blobResult = "null";
    expect(await renderFirstPagePng(new Uint8Array([1]))).toBeNull();
  });
});
