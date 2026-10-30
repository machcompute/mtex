// Small inline icon set (16px grid, stroke-based) for the Overleaf-style
// editor UI. All icons inherit currentColor, so color them with text-*.

type P = { className?: string };

function Svg({
  className,
  children,
  filled = false,
}: P & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconPlay({ className }: P) {
  return (
    <Svg className={className} filled>
      <path d="M4.5 2.5v11l9-5.5z" />
    </Svg>
  );
}

export function IconPlus({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Svg>
  );
}

export function IconUpload({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M8 9.5V2.8M5 5.3 8 2.3l3 3" />
      <path d="M2.5 10.5v1.7a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.7" />
    </Svg>
  );
}

export function IconTrash({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M3 4.3h10M6.3 4.3V3a.5.5 0 0 1 .5-.5h2.4a.5.5 0 0 1 .5.5v1.3" />
      <path d="M4.6 4.3l.5 8.6a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-8.6" />
    </Svg>
  );
}

export function IconPencil({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M10.8 2.6l2.6 2.6L5.2 13.4H2.6v-2.6z" />
    </Svg>
  );
}

export function IconClose({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function IconChevronLeft({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Svg>
  );
}

export function IconChevronRight({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconZoomIn({ className }: P) {
  return (
    <Svg className={className}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10l3.5 3.5M6.8 4.8v4M4.8 6.8h4" />
    </Svg>
  );
}

export function IconZoomOut({ className }: P) {
  return (
    <Svg className={className}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10l3.5 3.5M4.8 6.8h4" />
    </Svg>
  );
}

export function IconFit({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M1.8 5.5v5M14.2 5.5v5" />
      <path d="M4.5 8h7M4.5 8 6 6.5M4.5 8 6 9.5M11.5 8 10 6.5M11.5 8 10 9.5" />
    </Svg>
  );
}

export function IconDownload({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M8 2.5v8M5 7.5l3 3 3-3M2.8 13.5h10.4" />
    </Svg>
  );
}

export function IconSync({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M5.2 13.2V2.8M3 5l2.2-2.2L7.4 5" />
      <path d="M10.8 2.8v10.4M8.6 11l2.2 2.2L13 11" />
    </Svg>
  );
}

export function IconAuto({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M13.4 8A5.4 5.4 0 1 1 8 2.6c2 0 3.7 1.1 4.6 2.7" />
      <path d="M12.9 2.3v3.1H9.8" />
    </Svg>
  );
}

export function IconCheck({ className }: P) {
  return (
    <Svg className={className}>
      <path d="M3 8.6 6.4 12 13 4.5" />
    </Svg>
  );
}

export function IconSpinner({ className }: P) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="5.8" opacity={0.25} />
      <path d="M13.8 8A5.8 5.8 0 0 0 8 2.2" />
    </svg>
  );
}

// --- file type icons -------------------------------------------------------

/** Document outline with a folded corner; the label slot sits at the bottom. */
function DocBase({ label }: { label?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <path
        d="M4 1.5h5.5L13 5v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
      {label}
    </svg>
  );
}

function DocLabel({ text, fill }: { text: string; fill?: string }) {
  return (
    <text
      x="8.5"
      y="12.2"
      textAnchor="middle"
      fontSize="4.6"
      fontWeight="700"
      fontFamily="Arial, sans-serif"
      fill={fill ?? "currentColor"}
    >
      {text}
    </text>
  );
}

export function IconFileTex({ className }: P) {
  return (
    <span className={className} title=".tex">
      <DocBase label={<DocLabel text="TeX" fill="#0d9488" />} />
    </span>
  );
}

export function IconFileBib({ className }: P) {
  return (
    <span className={className} title=".bib">
      <DocBase label={<DocLabel text="bib" fill="#b0764a" />} />
    </span>
  );
}

export function IconFilePdf({ className }: P) {
  return (
    <span className={className} title=".pdf">
      <DocBase label={<DocLabel text="PDF" fill="#c0392b" />} />
    </span>
  );
}

export function IconFileImage({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path
        d="M4 1.5h5.5L13 5v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
      <circle cx="6.8" cy="7.6" r="1" fill="#b0764a" />
      <path
        d="M5 11.8l2.3-2.9 1.8 2.1 1.3-1.4 1.6 2.2"
        fill="none"
        stroke="#0d9488"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFile({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path
        d="M4 1.5h5.5L13 5v8.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
}
