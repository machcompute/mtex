import { act, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { ACTIVE_PROJECT_KEY, createProject, loadProject, type FileData } from "@/lib/opfs";

/** Let queued promise continuations (OPFS shim, effects) run — no timers. */
export async function settle(rounds = 80): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

/** Advance the fake clock (debounces, notices) and flush what that unblocks. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

export type Seed = {
  name?: string;
  mainPath?: string;
  openPaths?: string[];
  activePath?: string;
  files: Record<string, FileData>;
};

/** Write a project into the (in-memory) OPFS and make it the active one. */
export async function seedProject(seed: Seed): Promise<string> {
  const main = seed.mainPath ?? Object.keys(seed.files).find((p) => p.endsWith(".tex")) ?? "";
  const id = await createProject(seed.name ?? "Seeded", seed.files, {
    mainPath: main,
    openPaths: seed.openPaths ?? (main ? [main] : []),
    activePath: seed.activePath ?? main,
  });
  localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  return id;
}

export async function stored(id: string) {
  return loadProject(id);
}

export async function mountEditor(seed?: Seed, opts: { engineReady?: boolean } = {}) {
  vi.useFakeTimers();
  const id = seed ? await seedProject(seed) : null;
  const { default: EditorPage } = await import("@/app/editor/page");
  const utils = render(<EditorPage />);
  await settle();
  void opts;
  // A first run creates its default project: its id is the active-project key.
  return { id: id ?? localStorage.getItem(ACTIVE_PROJECT_KEY), ...utils };
}

// --- DOM readers mirroring the e2e helpers ------------------------------------

export const statusText = (): string => document.querySelector("header span.truncate")?.textContent ?? "";
export const noticeText = (): string => document.querySelector("[data-notice]")?.textContent ?? "";
export const activeTab = (): string =>
  (document.querySelector("[data-tab][data-active]") as HTMLElement | null)?.dataset.tab ?? "";
export const openTabs = (): string[] =>
  [...document.querySelectorAll("[data-tab]")].map((e) => (e as HTMLElement).dataset.tab ?? "");
export const fileRows = (): string[] =>
  [...document.querySelectorAll("aside li div.group")]
    .map((d) => d.querySelector('span[title*="double-click"]')?.textContent)
    .filter((x): x is string => !!x);
export const railActive = (): string[] =>
  [...document.querySelectorAll("[data-rail][data-active]")].map((e) => (e as HTMLElement).dataset.rail ?? "");
export const projectNameValue = (): string =>
  (document.querySelector('aside input[title^="Project name"]') as HTMLInputElement | null)?.value ?? "";

export { act, render, screen, within };
