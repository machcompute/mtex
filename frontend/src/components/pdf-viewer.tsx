"use client";

import { useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Props = {
  data: Uint8Array | null;
  className?: string;
};

/** Renders the given PDF bytes as stacked page canvases. */
export default function PdfViewer({ data, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);

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
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className =
            "mx-auto block bg-white shadow-sm " + (pageNum > 1 ? "mt-4 " : "");
          container.append(canvas);
          await page.render({ canvas, viewport }).promise;
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

  return (
    <div ref={containerRef} className={"h-full overflow-y-auto p-4 " + (className ?? "")}>
    </div>
  );
}
