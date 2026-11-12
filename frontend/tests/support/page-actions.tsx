import { fireEvent } from "@testing-library/react";
import { act, advance, settle } from "./page-utils";

export const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
export const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

export async function click(el: Element | null, label = "element"): Promise<void> {
  if (!el) throw new Error(`click: ${label} not found`);
  fireEvent.click(el);
  await settle();
}

export async function rail(id: "files" | "search" | "chat" | "log"): Promise<void> {
  await click(q(`[data-rail="${id}"]`), `rail ${id}`);
}

/** The Files-panel row (li) whose label is exactly `name`. */
export function rowFor(name: string): HTMLElement | null {
  const spans = qa('aside li span[title*="double-click"]');
  const span = spans.find((s) => s.textContent === name);
  return (span?.closest("li") as HTMLElement | null) ?? null;
}

/** Open the new-file modal, fill name/location and press Create. Returns whether the modal closed. */
export async function newFile(name: string, location = ""): Promise<boolean> {
  await click(q('button[data-action="new-file"]'), "new-file button");
  const modal = q('[data-modal="new-file"]');
  if (!modal) throw new Error("new-file modal did not open");
  const [nameInput, locInput] = modal.querySelectorAll("input");
  fireEvent.change(nameInput, { target: { value: name } });
  if (location) fireEvent.change(locInput, { target: { value: location } });
  fireEvent.keyDown(nameInput, { key: "Enter" });
  await settle();
  return q('[data-modal="new-file"]') === null;
}

/** Rename through the row's pencil button and the inline input. */
export async function renameFile(oldPath: string, nextPath: string): Promise<void> {
  const row = rowFor(oldPath.split("/").pop()!);
  if (!row) throw new Error(`no row for ${oldPath}`);
  await click(row.querySelector('button[title="Rename file"]'), "rename button");
  const input = q<HTMLInputElement>("aside input:not([type=file]):not([title])");
  if (!input) throw new Error("rename input missing");
  fireEvent.change(input, { target: { value: nextPath } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
}

export async function openFile(name: string): Promise<void> {
  const row = rowFor(name);
  if (!row) throw new Error(`no row for ${name}`);
  await click(row.querySelector("div.group"), `row ${name}`);
}

export async function tab(path: string): Promise<void> {
  await click(q(`[data-tab="${path}"]`), `tab ${path}`);
}

/** A File-shaped object (jsdom's Blob lacks arrayBuffer()). */
export function fakeFile(
  name: string,
  data: string | Uint8Array,
  opts: { relativePath?: string; type?: string } = {},
): File {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const f = {
    name,
    size: bytes.byteLength,
    type: opts.type ?? (name.includes(".") ? "text/plain" : ""),
    webkitRelativePath: opts.relativePath ?? "",
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
  return f as unknown as File;
}

/** Pick files through the hidden folder / file inputs. */
export async function pick(kind: "upload-folder" | "upload", files: File[]): Promise<void> {
  const btn = q(`button[data-action="${kind}"]`);
  if (!btn) throw new Error(`no ${kind} button`);
  const inputs = qa<HTMLInputElement>('aside input[type="file"]');
  const input = kind === "upload-folder" ? inputs.find((i) => i.hasAttribute("webkitdirectory")) : inputs.find((i) => !i.hasAttribute("webkitdirectory"));
  if (!input) throw new Error("file input missing");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
  await settle();
}

export async function typeInEditor(value: string): Promise<void> {
  const { monacoState } = await import("./stubs/monaco");
  await act(async () => {
    monacoState.type(value);
  });
  await settle();
}

export { advance, settle };

// --- drag and drop ------------------------------------------------------------

export type FsNode = { name: string; data?: string | Uint8Array; children?: FsNode[]; unreadable?: boolean };

/** A FileSystemEntry tree whose readEntries() returns Chromium-style batches of 100. */
export function entryOf(node: FsNode): FileSystemEntry {
  const isDir = node.children !== undefined;
  return {
    name: node.name,
    isFile: !isDir,
    isDirectory: isDir,
    file(ok: (f: File) => void, fail: (e: unknown) => void) {
      if (node.unreadable) return fail(new Error("unreadable"));
      ok(fakeFile(node.name, node.data ?? ""));
    },
    createReader() {
      let at = 0;
      return {
        readEntries(ok: (e: FileSystemEntry[]) => void, fail: (e: unknown) => void) {
          if (node.unreadable) return fail(new Error("unreadable"));
          const batch = (node.children ?? []).slice(at, at + 100);
          at += 100;
          ok(batch.map(entryOf));
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function dropEvent(dataTransfer: unknown, target: EventTarget = window): void {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(e);
}

/** Drop folders/files the way Chromium reports them (webkitGetAsEntry). */
export async function dropEntries(nodes: FsNode[]): Promise<Event> {
  const items = nodes.map((n) => ({ webkitGetAsEntry: () => entryOf(n) }));
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], items, files: [] } });
  await act(async () => {
    window.dispatchEvent(e);
  });
  await settle();
  return e;
}

/** A synthetic drop (no entry API): the page gets the plain file list. */
export async function dropFiles(files: File[], target: EventTarget = window): Promise<Event> {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { types: ["Files"], items: files.map(() => ({ webkitGetAsEntry: () => null })), files },
  });
  await act(async () => {
    target.dispatchEvent(e);
  });
  await settle();
  return e;
}
void dropEvent;

export const compileButton = () => q<HTMLButtonElement>('button[title^="Recompile"]');
export const gotoPdfButton = () => qa<HTMLButtonElement>("button").find((b) => b.textContent === "Go to PDF") ?? null;
export const autoButton = () => q<HTMLButtonElement>('button[title^="Auto recompile"]');
/** The divider's always-visible jump arrow, by its title ("Go to PDF" / "Go to editor"). */
export const dividerArrow = (title: string) => q<HTMLButtonElement>(`button[title="${title}"]`);
