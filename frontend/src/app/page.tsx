import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-cream">
      <main className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          HomeHub
        </h1>
        <p className="max-w-md text-lg text-stone">
          Your home automation and document hub.
        </p>
        <Link
          href="/editor"
          className="flex h-12 items-center justify-center rounded-full bg-mint px-6 font-medium text-ink transition-colors hover:bg-ink hover:text-mint"
        >
          LaTeX Editor
        </Link>
        <span className="rounded-full bg-peach px-3 py-1 text-xs font-medium text-ink">
          LaTeX compiled in your browser
        </span>
      </main>
    </div>
  );
}
