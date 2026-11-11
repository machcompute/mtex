# Unit tests

`npm test` runs the whole default suite with [Vitest](https://vitest.dev): **no browser, no real network,
no real OPFS, no TeX engine, no timing-based waits.** It finishes in seconds.

```
npm test               # everything (lib + page projects)
npx vitest run --project lib      # pure modules, plain Node
npx vitest run --project page     # the real pages/components in jsdom
npx vitest run tests/lib/github.test.ts
npx tsc --noEmit && npm run lint  # the other two gates
```

## How it stays deterministic and fast

* **OPFS** is an in-memory implementation of the directory/file-handle API installed at
  `navigator.storage.getDirectory()` (`tests/support/memfs.ts`). The app's own `opfs.ts` and
  `ctan-store.ts` run unmodified on top of it; faults (write failures, unavailable storage, a slow root)
  are switches on it.
* **Network**: `fetch` is a stub per test file (`api.github.com`, the `/api/ctan` + `/api/texlive`
  proxy routes, an OpenAI-compatible SSE endpoint). Any unexpected request throws.
* **TeX engine**: `BusyTexCompiler` is replaced by `FakeBusyTex` (`tests/support/fake-busytex.ts`) whose
  `compile()` is answered by a per-test handler; `lib/busytex.ts` itself is tested against a fake `Worker`.
  The LAN LLM engine is the mocked `MachLLM` client (and the vendored SDK is tested over jsdom's real
  `postMessage`).
* **Heavy UI libraries**: Monaco and pdf.js are stand-ins (`tests/support/stubs`) that keep the
  behaviour the page relies on (models keyed by path, cursor/selection, `executeEdits`, scroll calls).
  The file panel, GitHub modal, chat drawer + assistant-ui runtime, chat-settings modal and the
  dashboard run for real.
* **Time**: page tests use Vitest fake timers (debounces, notices, history). Nothing waits on a clock —
  `advance(ms)` moves it, `settle()` flushes microtasks.

## Layout

| Path | What |
| --- | --- |
| `tests/lib/*.test.ts` | Node: OPFS store, GitHub client, synctex, tar, CTAN store, TeX worker wrapper, chat wire/runtime/settings, engine-progress labels, LAN client + SDK, preview, CTAN/texlive routes |
| `tests/page/*.test.tsx` | jsdom: the real editor page, dashboard and modals over the stubs above (`pdf-viewer.test` runs the real PDF viewer over a mocked pdf.js) |
| `tests/support/` | the OPFS shim, fixtures (GitHub, CTAN, tar, synctex), fake engine/worker, UI stubs, drivers |

## Old browser e2e → unit tests

`e2e/` (Playwright, real Chromium/Firefox + OPFS + live engine) stays in the tree for manual full runs
(`npm run test:e2e`) but is **not** part of `npm test`.

| e2e suite | Checks | Ported to |
| --- | --- | --- |
| `regression.cjs` | auto-compile on open, bibtex log, same-origin proxy only, no POST/PUT, package installs with transitive deps (pgfplots → pgf → xcolor/pdfcolmk; algorithm2e → ifoddpage/relsize; doc/example files not cascaded), brand → dashboard link | `page/compile`, `lib/ctan-store`, `lib/ctan-proxy`, `lib/texlive-route`, `page/layout` |
| `biber.cjs` | biblatex pulls logreq past the old 512 KB scan cap, subdirectory `.bib` | `lib/ctan-store` (4 MB scan cap), `page/incremental` |
| `folder.cjs` | folder import (nested rows, depth, icons, first `.tex` opened, main switch, nested payload), image preview, OPFS persistence, dropped folders (recursive, >100-entry batches, top folder stripped, dotdirs, LICENSE, binary bytes), two folders keep names, empty folder, 0-byte file, collapse/auto-expand | `page/folder` |
| `rename.cjs` | in-place rename keeps depth, move to root, invalid path notice (log stays closed), OPFS follows | `page/files` |
| `fixes.cjs` | #1 rename-back/no stale model, #2/#3 failed engine load + recovery, #6/#16 nested/flat synctex click → file, #7 mid-compile edit, #8/#9/#14a compile payloads, status & log, dotted main names, #10/#12/#23 drops, #11 storage-failure notice, #13 collision refusal, #14c/#24 no main file, #15 non-UTF-8 bytes, #17 scroll restore, #18/#22 name validation, #20 auto-recompile off, #21 tab restore | `page/files`, `page/folder`, `page/compile`, `page/projects`, `page/incremental`, `lib/busytex` |
| `projects.cjs` | first-run default, create/numbering, switch, rename + reload, delete (+confirm), delete-active, delete-to-empty → fresh default, dashboard listing | `page/projects`, `lib/defaults`, `lib/opfs` |
| `layout.cjs` | app bar, toolbar order + inserts, save indicator, rail order/tooltips/bottom buttons, pane switching, search (rows, badge, no matches, jumps), swap button, workspace persistence, history popover, notes, page badge, stats | `page/layout`, `page/files`, `page/compile` |
| `dashboard.cjs` | project cards, placeholder vs preview, open, new project, preview written after compile | `page/projects` (dashboard), `lib/preview`, `lib/opfs` |
| `github.cjs` | PAT sign-in/persist/Bearer, repo + branch lists, default-branch preselect, pull (dotfile skipped before download, blobs fetched once, no codeload), OPFS persistence + source record, Re-pull same id/replace/delete stale, push: blobs → trees deepest-first → commit (`machlatex <ts>`, authored user) → non-forced ref, source recorded | `page/github`, `lib/github` |
| `firefox.cjs` | `webkitdirectory` picker + folder import | `page/folder` (picker input), `page/folder` (import) |
| `artifacts.cjs` | old layout → `artifacts/<id>/` migration, idempotent, new layout for fresh projects | `lib/opfs`, `page/projects` |
| `incremental.cjs` | build state persisted, seeded into the next build, `.bib` hashes, cached PDF reuse, one entry per input set, failed build keeps previous PDF, old PDF shown during a build | `page/incremental`, `lib/opfs` |
| `babel-pt.cjs` / `babel-pt-log.cjs` | `Unknown option 'portuguese'` → install the tlpkg that ships the `.ldf`, restart, recompile; once per language | `page/incremental`, `lib/ctan-store` (`packageForFile`) |
| `defaults.cjs` | first-run sweep: all defaults installed once, progress bar, no resurrection of removed defaults, version bump | `lib/ctan-store`, `page/defaults` |
| `chat.cjs` | rail/chat pane, endpoint streaming w/ Bearer key, LAN vs endpoint, system prompt carries file + cursor/selection, tools (list/read/compile/log/search/install), apply_edit accept/reject/stop, clear, settings modal (live models, Save), dead engine → graceful box, deleted `/api/chat` never hit | `page/chat` (incl. the model-load indicator), `lib/chat-wire`, `lib/chat-runtime`, `lib/engine-progress`, `lib/lan-llm`, `lib/mach-llm-sdk`, `lib/chat-settings` |
| `helpers.cjs` | Runner/waitReady plumbing | n/a (replaced by `tests/support`) |

## Not unit-testable (and why)

* **Real TeX output** — that a document compiles, citations resolve (no `??`), `siunitx`/`pgfplots`/`subcaption`/
  `algorithm2e` render, biber vs bibtex8 actually run or are skipped, PDF text content. This is the WASM engine
  itself; the unit suite checks everything the page *hands* it and does with its result, not TeX.
* **Real PDF rasterization** — pdf.js canvas rendering, the dashboard thumbnail's pixels, the real viewer's
  scroll/selection geometry. `lib/preview` is tested for letterboxing math and failure paths against a mocked
  pdf.js/canvas.
* **WebGPU inference** — streaming from a real model, the 2.67 GB weight download, GPU adapters. The wire
  (iframe `postMessage` protocol, SSE, tool loop) is covered; token generation is not.
* **Real browser file pickers / OS drag-and-drop** — the Firefox `webkitdirectory` dialog and CDP OS drags.
  The inputs and the `DataTransfer`/`FileSystemEntry` handling (incl. Chromium's 100-entry batches) are covered.
* **Real OPFS quirks** — browser quota, structured-clone/locking behaviour, cross-tab effects. The in-memory
  shim models the handle API and failure modes, not browser internals.
* **Layout geometry** — "rail sits in the left column" (pixel positions), CSS hover reveal of the swap button,
  pointer-drag resizing of panes (jsdom has no layout; the persisted/clamped values are tested).
* **Live CTAN / GitHub / mirror availability** — all upstreams are stubbed; the proxy's mirror fallback logic is
  tested, not the mirrors.
