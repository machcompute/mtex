"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Fixed render scale (CSS px per PDF point) for the canvases.
const SCALE = 1.5;

export type PdfViewerHandle = {
  /**
   * Jump to a synctex position: scroll the given PDF page so the
   * position (y in points from the top of the page — the visual space
   * synctex.ts converts records into) is visible, and select the
   * rendered text on that line so the reader can see where the source
   * line landed in the document.
   */
  scrollToPosition: (page: number, yFromTopPts: number) => void;
};

type Props = {
  data: Uint8Array | null;
  className?: string;
  /**
   * Called when the reader clicks rendered PDF text. Coordinates are in
   * points with the origin at the top-left of the page — the same
   * visual space the synctex entries use.
   */
  onPageClick?: (page: number, xFromLeftPts: number, yFromTopPts: number) => void;
};

export default forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { data, className, onPageClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  // Keep the latest callback without re-rendering the PDF on every change.
  const clickRef = useRef(onPageClick);
  clickRef.current = onPageClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    taskRef.current?.destroy().catch(() => {});
    container.replaceChildren();

    if (!data || data.byteLength === 0) {
      const empty = document.createElement("div");
      empty.className = "flex h-full items-center justify-center text-sm text-stone";
      empty.textContent = "No PDF output yet";
      container.append(empty);
      return;
    }

    const task = pdfjsLib.getDocument({ data });
    taskRef.current = task;

    let cancelled = false;
    task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: SCALE });
          const heightPts = viewport.height / SCALE;

          const wrapper = document.createElement("div");
          wrapper.className =
            "relative mx-auto block bg-white shadow-sm " + (pageNum > 1 ? "mt-4 " : "");
          wrapper.dataset.page = String(pageNum);
          wrapper.dataset.heightPts = String(heightPts);
          wrapper.style.width = `${Math.floor(viewport.width)}px`;
          wrapper.style.height = `${Math.floor(viewport.height)}px`;

          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "block";
          wrapper.append(canvas);

          // Text layer: transparent spans positioned exactly over the
          // rendered text (pdf.js-style), so the reader can select and
          // copy PDF text like in any other PDF viewer.
          const layer = document.createElement("div");
          layer.className = "absolute inset-0";
          layer.dataset.textLayer = "";
          wrapper.append(layer);

          // Click → synctex lookup. A click that merely ends a
          // drag-selection must not trigger a jump to the source.
          wrapper.addEventListener("click", (e) => {
            const selection = window.getSelection();
            if (selection && selection.toString().length > 0) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const yTop = e.clientY - rect.top;
            if (x < 0 || yTop < 0 || x > rect.width || yTop > rect.height) return;
            // A click on a rendered text span snaps to that line's
            // baseline: glyph ink sits ABOVE the baseline, so the raw
            // click y could otherwise land closer to the line above and
            // the lookup would jump one line too early.
            const target = e.target as HTMLElement | null;
            const span = (target
              ? target.closest("span[data-baseline]")
              : null) as HTMLElement | null;
            const baselineCss = span
              ? Number.parseFloat(span.dataset.baseline || "")
              : NaN;
            clickRef.current?.(
              pageNum,
              x / SCALE,
              (Number.isFinite(baselineCss) ? baselineCss : yTop) / SCALE,
            );
          });

          container.append(wrapper);
          await page.render({ canvas, viewport }).promise;

          const content = await page.getTextContent();
          for (const item of content.items) {
            if (!("str" in item) || item.str.length === 0) continue;
            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]);
            if (fontHeight < 0.5) continue;
            const span = document.createElement("span");
            span.textContent = item.str;
            span.style.position = "absolute";
            span.style.left = `${tx[4]}px`;
            span.style.top = `${tx[5] - fontHeight}px`;
            span.style.height = `${fontHeight}px`;
            span.style.fontSize = `${fontHeight}px`;
            span.style.color = "transparent";
            span.style.whiteSpace = "pre";
            // Baseline of this line in CSS px from the top of the page —
            // used to snap synctex clicks on rendered text (see above).
            span.dataset.baseline = String(tx[5]);
            layer.append(span);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const error = document.createElement("div");
        error.className = "p-4 text-sm text-red-600";
        error.textContent = `Failed to render PDF: ${err}`;
        container.append(error);
      });

    return () => {
      cancelled = true;
    };
  }, [data]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPosition(page, yFromTopPts) {
        const container = containerRef.current;
        if (!container) return;
        const wrapper = container.querySelector(
          `[data-page="${page}"]`,
        ) as HTMLElement | null;
        const canvas = wrapper?.querySelector("canvas");
        const layer = wrapper?.querySelector("[data-text-layer]");
        if (!wrapper || !canvas || !layer) return;
        const heightPts = Number.parseFloat(wrapper.dataset.heightPts || "");
        if (!Number.isFinite(heightPts) || heightPts <= 0) return;

        // Center the position slightly above the middle of the viewport.
        const yTopCss = (yFromTopPts / heightPts) * canvas.clientHeight;
        const target =
          wrapper.offsetTop + yTopCss - 0.35 * container.clientHeight;
        container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });

        // Select the rendered line at that position so it stands out.
        const spans = Array.from(
          layer.querySelectorAll<HTMLSpanElement>("span"),
        );
        if (spans.length === 0) return;
        let best = spans[0];
        let bestDist = Infinity;
        for (const s of spans) {
          const dist = Math.abs(s.offsetTop + s.offsetHeight / 2 - yTopCss);
          if (dist < bestDist) {
            bestDist = dist;
            best = s;
          }
        }
        const lineH = best.offsetHeight > 0 ? best.offsetHeight : 16;
        const matched = spans.filter(
          (s) => Math.abs(s.offsetTop + s.offsetHeight / 2 - yTopCss) <= 0.9 * lineH,
        );
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.setStart(matched[0], 0);
        const last = matched[matched.length - 1];
        range.setEnd(last, last.childNodes.length);
        selection.removeAllRanges();
        selection.addRange(range);
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      data-pdf-viewer
      className={"relative h-full overflow-y-auto p-4 " + (className ?? "")}
    />
  );
});
