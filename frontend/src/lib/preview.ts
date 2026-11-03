/**
 * Turn a compiled PDF's first page into the dashboard's square thumbnail.
 * The page is fitted into a fixed square with a white letterbox (a portrait
 * page letterboxes left/right, a landscape one top/bottom) so every card is
 * the same shape regardless of the document.
 */
import * as pdfjsLib from "pdfjs-dist";

// The PDF viewer sets the same global worker; pdf.js's workerSrc is a single
// global, and both point at the identical bundled asset, so this is a no-op
// when the viewer loaded first (and correct on its own otherwise).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** Side, in CSS px, of the square thumbnail. */
const PREVIEW_PX = 512;

/**
 * Render a PDF's first page into a square PNG. Returns null on any failure —
 * the thumbnail is optional, so a corrupt or empty PDF must never throw up to
 * the caller (the dashboard shows a placeholder instead).
 */
export async function renderFirstPagePng(
  pdfBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer> | null> {
  // Hand pdf.js a COPY: it transfers the buffer to its worker, which detaches
  // it — the caller's bytes (still shown in the viewer) must survive.
  const task = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = PREVIEW_PX / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });

    // Render the page onto its own canvas (pdf.js clears the canvas it is
    // handed), then blit it centred onto the white square.
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = Math.max(1, Math.ceil(viewport.width));
    pageCanvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvas: pageCanvas, viewport }).promise;

    const out = document.createElement("canvas");
    out.width = PREVIEW_PX;
    out.height = PREVIEW_PX;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PREVIEW_PX, PREVIEW_PX);
    const dx = (PREVIEW_PX - pageCanvas.width) / 2;
    const dy = (PREVIEW_PX - pageCanvas.height) / 2;
    ctx.drawImage(pageCanvas, Math.round(dx), Math.round(dy));

    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, "image/png"),
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    // The loading task (not the document proxy) owns the worker round-trip;
    // destroying it releases the parse even on the failure paths above.
    void task.destroy().catch(() => {});
  }
}
