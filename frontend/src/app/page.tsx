import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          HomeHub
        </h1>
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
          Your home automation and document hub.
        </p>
        <Link
          href="/editor"
          className="flex h-12 items-center justify-center rounded-full bg-zinc-900 px-6 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-black dark:hover:bg-zinc-300"
        >
          LaTeX Editor
        </Link>
      </main>
    </div>
  );
}
