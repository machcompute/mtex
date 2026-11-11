import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";

type Props = {
  data: Uint8Array | null;
  onPageClick?: (page: number, x: number, y: number) => void;
  downloadName?: string;
  syncScroll?: boolean;
  onToggleSyncScroll?: () => void;
  onViewportTop?: (page: number, y: number) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  onNumPages?: (n: number) => void;
};

export const pdfState = {
  pages: 1,
  scrollOk: true,
  viewportTop: null as { page: number; yTop: number } | null,
  scrolls: [] as { page: number; y: number; opts?: { select?: boolean; instant?: boolean } }[],
  props: null as Props | null,
  reset() {
    this.pages = 1;
    this.scrollOk = true;
    this.viewportTop = null;
    this.scrolls = [];
    this.props = null;
  },
  /** The current PDF's bytes as text (the fake engine writes the main source into it). */
  text(): string {
    return this.props?.data ? new TextDecoder().decode(this.props.data) : "";
  },
};

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export type PdfViewerHandle = {
  scrollToPosition: (page: number, y: number, opts?: { select?: boolean; instant?: boolean }) => boolean;
  getViewportTop: () => { page: number; yTop: number } | null;
};

const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(props, ref) {
  pdfState.props = props;
  useImperativeHandle(ref, () => ({
    scrollToPosition: (page, y, opts) => {
      pdfState.scrolls.push({ page, y, opts });
      return pdfState.scrollOk;
    },
    getViewportTop: () => pdfState.viewportTop,
  }));
  const { data, onNumPages } = props;
  useEffect(() => {
    onNumPages?.(data ? pdfState.pages : 0);
  }, [data, onNumPages]);
  return (
    <div data-testid="pdf" data-bytes={data ? data.byteLength : 0} data-download={props.downloadName}>
      <div data-testid="pdf-leading">{props.leading}</div>
      <div data-testid="pdf-trailing">{props.trailing}</div>
    </div>
  );
});

export default PdfViewer;
