"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFit,
  IconSync,
  IconZoomIn,
  IconZoomOut,
} from "@/components/icons";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Padding around the pages (Tailwind p-4 on the scroll container);
// fit-to-width subtracts it from the container width.
const PAD = 16;

/**
 * Copy bytes out into a fresh ArrayBuffer so a Blob never aliases
 * worker-owned memory (and satisfies BlobPart's ArrayBuffer typing).
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export type PdfViewerHandle = {
  /**
   * Jump to a synctex position: scroll the given PDF page so the position
   * (y in points from the top of the page — the visual space synctex.ts
   * converts records into) is visible. `select` highlights the rendered
   * line at that position (default, "Go to PDF"); `instant` skips the
   * smooth animation (scroll-sync follows the editor).
   */
  scrollToPosition: (
    page: number,
    yFromTopPts: number,
    opts?: { select?: boolean; instant?: boolean },
  ) => boolean;
  /**
   * The page and y (points from that page's top) currently at the
   * viewport's top edge, or null when nothing is rendered. The page saves
   * this before a recompile so it can restore the scroll position after
   * the new PDF arrives (pdf.js renders async — poll scrollToPosition
   * until it returns true).
   */
  getViewportTop: () => { page: number; yTop: number } | null;
};

type Props = {
  data: Uint8Array | null;
  className?: string;
  /**
   * Called when the reader clicks rendered PDF text. Coordinates are in
   * points with the origin at the top-left of the page — the same
   * visual space the synctex entries use.
   */
  onPageClick?: (
    page: number,
    xFromLeftPts: number,
    yFromTopPts: number,
  ) => void;
  /** File name suggested for "Download PDF". */
  downloadName?: string;
  /** Two-way PDF<->editor scroll sync (Overleaf's sync-scroll toggle). */
  syncScroll?: boolean;
  onToggleSyncScroll?: () => void;
  /**
   * Called whenever the visible top of the PDF moves: the topmost visible
   * page and the y of the viewport top in points from that page's top.
   * The editor uses this to follow the PDF's scroll when sync is on.
   */
  onViewportTop?: (page: number, yTopPts: number) => void;
};

export default forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  {
    data,
    className,
    onPageClick,
    downloadName,
    syncScroll = false,
    onToggleSyncScroll,
    onViewportTop,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  // Identity of the data prop currently rendered; page-state resets (below)
  // only happen when it changes, never on zoom/fit re-renders.
  const renderedDataRef = useRef<Uint8Array | null | undefined>(undefined);
  // Keep the latest callbacks without re-rendering the PDF on every change.
  const clickRef = useRef(onPageClick);
  clickRef.current = onPageClick;
  const viewportRef = useRef(onViewportTop);
  viewportRef.current = onViewportTop;

  // Zoom: null = fit-to-width (default, follows the pane width); a number
  // is a manual zoom in 0.5–4.
  const [scale, setScale] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pageWidthPts, setPageWidthPts] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const fitScale = useMemo(() => {
    if (!pageWidthPts || containerWidth <= 0) return 1.5;
    const s = (containerWidth - 2 * PAD) / pageWidthPts;
    // Round to 4 decimals so sub-pixel width jitter can't re-render pages.
    return Math.round(s * 10000) / 10000;
  }, [pageWidthPts, containerWidth]);

  const effScale = scale ?? fitScale;

  // Track the pane width for fit-to-width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setContainerWidth((w) => (w === el.clientWidth ? w : el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build (or rebuild) the pages whenever the PDF, zoom or fit changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    taskRef.current?.destroy().catch(() => {});
    taskRef.current = null;
    container.replaceChildren();
    if (renderedDataRef.current !== data) {
      // A new PDF (or none) arrived: reset the per-document state. Must not
      // run on zoom/fit re-renders — setPageWidthPts(null) there would flip
      // fitScale back to its default and re-trigger this effect forever.
      renderedDataRef.current = data;
      setNumPages(0);
      setPageWidthPts(null);
      setPage(1);
    }

    if (!data || data.byteLength === 0) {
      const empty = document.createElement("div");
      empty.className =
        "flex h-full flex-col items-center justify-center gap-2 text-stone";
      // Same document glyph as IconFile (imperative DOM — keep in sync).
      empty.innerHTML =
        '<svg viewBox="0 0 16 16" class="h-10 w-10 text-stone/40" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.5h5.5L13 5v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/><path d="M9.5 1.5V5H13"/></svg>';
      const label = document.createElement("p");
      label.className = "text-sm";
      label.textContent = "No PDF output yet — press Recompile.";
      empty.append(label);
      container.append(empty);
      return;
    }

    // Hand pdf.js a COPY: it transfers the buffer to its worker, which
    // detaches it — re-reading `data.byteLength` afterwards (the effect
    // re-runs on every fit/zoom change) would see 0 and show the empty
    // state for a perfectly good PDF.
    const task = pdfjsLib.getDocument({ data: data.slice() });
    taskRef.current = task;

    let cancelled = false;
    task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        setNumPages(pdf.numPages);
        const s =
          scale ?? (pageWidthPts && containerWidth > 0 ? fitScale : 1.5);
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return;
          const pageObj = await pdf.getPage(pageNum);
          const base = pageObj.getViewport({ scale: 1 });
          if (pageNum === 1 && pageWidthPts !== base.width) {
            setPageWidthPts(base.width);
          }
          const viewport = pageObj.getViewport({ scale: s });
          const heightPts = base.height;

          const wrapper = document.createElement("div");
          wrapper.className =
            "relative mx-auto block bg-white shadow-sm " +
            (pageNum > 1 ? "mt-4 " : "");
          wrapper.dataset.page = String(pageNum);
          wrapper.dataset.heightPts = String(heightPts);
          wrapper.dataset.scale = String(s);
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
              x / s,
              (Number.isFinite(baselineCss) ? baselineCss : yTop) / s,
            );
          });

          container.append(wrapper);
          await pageObj.render({ canvas, viewport }).promise;

          const content = await pageObj.getTextContent();
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
  }, [data, scale, fitScale, containerWidth, pageWidthPts]);

  // Page tracking + viewport-top reporting while the reader scrolls.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const track = () => {
      raf = 0;
      const wrappers = Array.from(
        el.querySelectorAll<HTMLElement>("[data-page]"),
      );
      if (wrappers.length === 0) return;
      const S = el.scrollTop;
      // Current page: the one intersecting a probe 35% down the viewport.
      const probe = S + el.clientHeight * 0.35;
      let cur = Number(wrappers[wrappers.length - 1].dataset.page) || 1;
      for (const w of wrappers) {
        if (w.offsetTop <= probe) cur = Number(w.dataset.page) || cur;
        else break;
      }
      setPage((p) => (p === cur ? p : cur));
      // Topmost visible page: the first whose bottom is still below the
      // viewport top. Report the viewport top in points of that page.
      let vis: HTMLElement | null = null;
      for (const w of wrappers) {
        if (w.offsetTop + w.offsetHeight > S) {
          vis = w;
          break;
        }
      }
      if (!vis) vis = wrappers[0];
      const sVis = Number.parseFloat(vis.dataset.scale || "1") || 1;
      const hPts = Number.parseFloat(vis.dataset.heightPts || "0") || 0;
      const yTop = Math.min(
        Math.max((S - vis.offsetTop) / sVis, 0),
        hPts,
      );
      viewportRef.current?.(Number(vis.dataset.page) || 1, yTop);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(track);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPosition(pageNum, yFromTopPts, opts) {
        const select = opts?.select !== false;
        const instant = opts?.instant === true;
        const el = containerRef.current;
        if (!el) return false;
        const wrapper = el.querySelector(
          `[data-page="${pageNum}"]`,
        ) as HTMLElement | null;
        const canvas = wrapper?.querySelector("canvas");
        const layer = wrapper?.querySelector("[data-text-layer]");
        if (!wrapper || !canvas || !layer) return false;
        const s = Number.parseFloat(wrapper.dataset.scale || "1") || 1;
        const heightPts = Number.parseFloat(wrapper.dataset.heightPts || "");
        if (!Number.isFinite(heightPts) || heightPts <= 0) return false;

        // Center the position slightly above the middle of the viewport.
        const yTopCss = yFromTopPts * s;
        const target =
          wrapper.offsetTop + yTopCss - 0.35 * el.clientHeight;
        el.scrollTo({
          top: Math.max(0, target),
          behavior: instant ? "auto" : "smooth",
        });
        // The scroll happened — selection below is cosmetic.
        if (!select) return true;
        // Select the rendered line at that position so it stands out.
        const spans = Array.from(
          layer.querySelectorAll<HTMLSpanElement>("span"),
        );
        if (spans.length === 0) return true;
        let best = spans[0];
        let bestDist = Infinity;
        for (const sp of spans) {
          const dist = Math.abs(sp.offsetTop + sp.offsetHeight / 2 - yTopCss);
          if (dist < bestDist) {
            bestDist = dist;
            best = sp;
          }
        }
        const lineH = best.offsetHeight > 0 ? best.offsetHeight : 16;
        const matched = spans.filter(
          (sp) =>
            Math.abs(sp.offsetTop + sp.offsetHeight / 2 - yTopCss) <=
            0.9 * lineH,
        );
        const selection = window.getSelection();
        if (!selection) return true;
        const range = document.createRange();
        range.setStart(matched[0], 0);
        const last = matched[matched.length - 1];
        range.setEnd(last, last.childNodes.length);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      },
      getViewportTop() {
        // Same math as track()'s viewport-top report: the topmost page
        // wrapper whose bottom is still below the scroll position.
        const el = containerRef.current;
        if (!el) return null;
        const wrappers = Array.from(
          el.querySelectorAll<HTMLElement>("[data-page]"),
        );
        if (wrappers.length === 0) return null;
        const S = el.scrollTop;
        let vis: HTMLElement | null = null;
        for (const w of wrappers) {
          if (w.offsetTop + w.offsetHeight > S) {
            vis = w;
            break;
          }
        }
        if (!vis) vis = wrappers[0];
        const sVis = Number.parseFloat(vis.dataset.scale || "1") || 1;
        const hPts = Number.parseFloat(vis.dataset.heightPts || "0") || 0;
        const yTop = Math.min(Math.max((S - vis.offsetTop) / sVis, 0), hPts);
        return { page: Number(vis.dataset.page) || 1, yTop };
      },
    }),
    [],
  );

  const hasPdf = !!data && data.byteLength > 0;

  const zoomBy = (factor: number) => {
    setScale(
      Math.min(4, Math.max(0.5, Math.round(effScale * factor * 100) / 100)),
    );
  };

  const goToPage = (n: number) => {
    const el = containerRef.current;
    if (!el) return;
    const wrappers = Array.from(
      el.querySelectorAll<HTMLElement>("[data-page]"),
    );
    if (n < 1 || n > wrappers.length) return;
    el.scrollTo({
      top: Math.max(0, wrappers[n - 1].offsetTop - PAD),
      behavior: "smooth",
    });
  };

  const download = () => {
    if (!hasPdf) return;
    const blob = new Blob([toArrayBuffer(data)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName ?? "output.pdf";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const tBtn =
    "rounded p-1 text-stone transition-colors hover:bg-peach/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className={"flex h-full min-w-0 flex-col " + (className ?? "")}>
      {/* Toolbar: zoom | fit | page | sync-scroll | download */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-ink/10 bg-cream px-2">
        <button title="Zoom out" disabled={!hasPdf} onClick={() => zoomBy(1 / 1.25)} className={tBtn}>
          <IconZoomOut className="h-4 w-4" />
        </button>
        <button
          title="Actual size (100%)"
          disabled={!hasPdf}
          onClick={() => setScale(1)}
          className="w-12 rounded px-1 py-1 text-center text-xs font-medium text-ink transition-colors hover:bg-peach/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {hasPdf ? `${Math.round(effScale * 100)}%` : "–"}
        </button>
        <button title="Zoom in" disabled={!hasPdf} onClick={() => zoomBy(1.25)} className={tBtn}>
          <IconZoomIn className="h-4 w-4" />
        </button>
        <span className="mx-1 h-4 w-px bg-ink/10" />
        <button
          title="Fit to width"
          disabled={!hasPdf}
          onClick={() => setScale(null)}
          className={
            tBtn +
            (scale === null ? " bg-mint/30 text-ink hover:bg-mint/30" : "")
          }
        >
          <IconFit className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <button
          title="Previous page"
          disabled={!hasPdf}
          onClick={() => goToPage(page - 1)}
          className={tBtn}
        >
          <IconChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-1 text-xs tabular-nums text-stone">
          {numPages > 0 ? `${page} / ${numPages}` : "–"}
        </span>
        <button
          title="Next page"
          disabled={!hasPdf}
          onClick={() => goToPage(page + 1)}
          className={tBtn}
        >
          <IconChevronRight className="h-4 w-4" />
        </button>
        <span className="mx-1 h-4 w-px bg-ink/10" />
        <button
          title={
            syncScroll
              ? "Sync scroll: on (editor and PDF follow each other)"
              : "Sync scroll: off"
          }
          onClick={onToggleSyncScroll}
          className={
            tBtn +
            (syncScroll
              ? " bg-mint/30 text-ink hover:bg-mint/30 hover:text-ink"
              : "")
          }
        >
          <IconSync className="h-4 w-4" />
        </button>
        <button title="Download PDF" disabled={!hasPdf} onClick={download} className={tBtn}>
          <IconDownload className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={containerRef}
        data-pdf-viewer
        className="relative min-h-0 flex-1 overflow-y-auto bg-stone/10 p-4"
      />
    </div>
  );
});
