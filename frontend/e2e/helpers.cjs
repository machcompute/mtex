// Shared helpers for the e2e suites. Each suite gets a Runner, which
// launches a fresh disposable browser profile (Chromium or Firefox) under
// the OS temp dir, waits for the engine, drives the editor page, and tears
// the profile down.
const os = require("os");
const path = require("path");
const fs = require("fs");

const APP_URL = process.env.APP_URL || "http://localhost:3000/editor";
const CHROME =
  process.env.CHROME_EXECUTABLE ||
  "/home/lukas/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
// `npx playwright-core install firefox` (matches the installed version).
const FIREFOX =
  process.env.FIREFOX_EXECUTABLE ||
  "/home/lukas/.cache/ms-playwright/firefox-1532/firefox/firefox";
const PNG_PATH = path.join(__dirname, "logo.png");

class Runner {
  constructor(name, browser = "chromium") {
    this.name = name;
    this.browser = browser;
    this.failures = 0;
    // Unique temp profile — the repo and /tmp are never touched, and a
    // previous crashed run can't leave state behind.
    this.profile = fs.mkdtempSync(
      path.join(os.tmpdir(), `homehub-e2e-${name}-`),
    );
  }

  ok(name, cond, extra) {
    console.log(
      `${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`,
    );
    if (!cond) this.failures++;
  }

  async start() {
    const impl = require("playwright-core")[this.browser];
    this.ctx = await impl.launchPersistentContext(this.profile, {
      executablePath: this.browser === "firefox" ? FIREFOX : CHROME,
      headless: true,
      // Chrome-only flags; Firefox doesn't take them.
      args:
        this.browser === "firefox"
          ? []
          : ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.page = await this.ctx.newPage();
    this.page.on("pageerror", (e) =>
      console.log(`[pageerror] ${String(e).slice(0, 200)}`),
    );
    this.status = this.page.locator("header span.truncate").first();
    return this.page;
  }

  goto() {
    return this.page.goto(APP_URL, { waitUntil: "load", timeout: 60000 });
  }

  // Wait until the app has settled after a load: the engine is ready AND
  // the open project's auto-compile has finished. Terminal statuses:
  // "Ready." (no main file to compile), "Compiled in N ms", or a failed
  // build. (A bare engine-ready window no longer exists — the auto-compile
  // on open takes the status straight from Ready. to Compiling….)
  async waitReady() {
    const settled = /^(Ready\.|Compiled in \d+ ms|Compilation failed)/;
    for (let i = 0; i < 90; i++) {
      await this.page.waitForTimeout(2000);
      const t = ((await this.status.textContent().catch(() => "")) || "").trim();
      if (settled.test(t)) return true;
    }
    return false;
  }

  // Click "Recompile" and wait for a terminal status. Returns the final
  // status text ("Compiled in N ms" or a failure message, "" on timeout).
  // Terminal = the button is enabled again (it is disabled only while
  // compiling) AND the run actually started: either the button was seen
  // busy, or the status text changed synchronously (e.g. the "No main
  // .tex file" error returns before a compile starts). Matching message
  // text here would miss error messages that don't say "failed".
  // The start evidence matters because a REBUILD can finish with the
  // SAME terminal text as before the click (a project that already
  // failed: "Compilation failed — see log" before and after); without
  // it the wait would be indistinguishable from "nothing happened".
  // Polls are 200 ms apart: a warm rebuild of a small project can finish
  // in well under a second, and a 1 s poll could miss the whole busy
  // window when the before-text already equals the terminal text.
  // Button state and status text are read in ONE page evaluate: separate
  // CDP reads can straddle the terminal commit (text read just before the
  // done state renders, button read just after), which would return a
  // stale "Compiling…" line for a build that has already finished.
  async recompile() {
    const btn = this.page.locator('button[title^="Recompile"]').first();
    const snap = () =>
      this.page.evaluate(() => {
        const b = document.querySelector('button[title^="Recompile"]');
        const s = document.querySelector("header span.truncate");
        return {
          disabled: b ? b.disabled : true,
          text: (s?.textContent || "").trim(),
        };
      });
    const before = (await snap()).text;
    await btn.click();
    let sawBusy = false;
    for (let i = 0; i < 450; i++) {
      await this.page.waitForTimeout(200);
      const { disabled, text } = await snap();
      if (disabled) sawBusy = true;
      if ((sawBusy || text !== before) && !disabled) return text;
    }
    return "";
  }

  // Visible text of the rendered PDF (pdf.js marks each line's spans with
  // data-baseline). The text layer renders a beat after the canvas, so
  // poll until it appears instead of reading a possibly empty page.
  async pdfText() {
    for (let i = 0; i < 20; i++) {
      const text = await this.page.evaluate(() => {
        const viewer = document.querySelector("[data-pdf-viewer]");
        return viewer
          ? Array.from(viewer.querySelectorAll("span[data-baseline]"))
              .map((s) => s.textContent)
              .join(" ")
          : "";
      });
      if (text.trim().length > 0) return text;
      await this.page.waitForTimeout(500);
    }
    return "";
  }

  // Open the log drawer if it's closed, read the log, close it again.
  async logText() {
    const viewLog = this.page.locator("button", { hasText: "View log" });
    if (await viewLog.count()) {
      await viewLog.first().click();
      await this.page.waitForTimeout(300);
    }
    const log =
      (await this.page.evaluate(
        () => document.querySelector("pre")?.textContent || "",
      )) || "";
    const hideLog = this.page.locator("button", { hasText: "Hide log" });
    if (await hideLog.count()) await hideLog.first().click();
    return log;
  }

  // Real OS file/directory drag, synthesized through CDP (Chromium only).
  // `absPath` is a host path, or an array of them; the browser builds the
  // drag exactly as for a genuine user drag — a directory arrives as one
  // unreadable File with no relative path, plus a walkable directory entry.
  async osDrag(absPath, x, y) {
    if (this.browser !== "chromium")
      throw new Error("osDrag is Chromium-only");
    const cdp = await this.ctx.newCDPSession(this.page);
    const data = { items: [], files: [absPath].flat(), dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
    }
    await cdp.detach();
  }

  async finish() {
    await this.ctx.close();
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

const ACTIVE_KEY = "homehub-active-project-v1";

/**
 * Write a project straight into OPFS (bypassing the app) and make it the
 * active one. Call AFTER goto + waitReady so the app's load effect has
 * settled (and first-run defaults exist), then goto() again — the reload
 * picks the seeded project up via the active-project localStorage key.
 *
 * files: { "rel/path": string | number[] } — strings are text files,
 * number[] are binary (e.g. Array.from(pngBytes)).
 */
async function seedProject(r, { id, name, mainPath = "", openPaths = [], activePath = "", files = {}, source = null, createdAt, updatedAt }) {
  const pid =
    id ||
    (await r.page.evaluate(() =>
      crypto.randomUUID(),
    ));
  const now = Date.now();
  await r.page.evaluate(
    ({ key, id, name, mainPath, openPaths, activePath, files, source, createdAt, updatedAt }) =>
      (async () => {
        const root = await navigator.storage.getDirectory();
        const projects = await root.getDirectoryHandle("projects", { create: true });
        const dir = await projects.getDirectoryHandle(id, { create: true });
        for (const [rel, data] of Object.entries(files)) {
          const parts = rel.split("/");
          const leaf = parts.pop();
          let d = dir;
          for (const part of parts) d = await d.getDirectoryHandle(part, { create: true });
          const fh = await d.getFileHandle(leaf, { create: true });
          const w = await fh.createWritable();
          if (typeof data === "string") await w.write(data);
          else await w.write(new Uint8Array(data));
          await w.close();
        }
        const meta = {
          v: 1,
          name,
          mainPath,
          openPaths,
          activePath,
          createdAt,
          updatedAt,
        };
        if (source) meta.source = source;
        const fh = await dir.getFileHandle("project.json", { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(meta));
        await w.close();
        localStorage.setItem(key, id);
      })(),
    {
      key: ACTIVE_KEY,
      id: pid,
      name,
      mainPath,
      openPaths,
      activePath,
      files,
      source,
      createdAt,
      updatedAt,
    },
  );
  return pid;
}

/**
 * Read the active project back out of OPFS (the app's saved state).
 * Returns { id, meta, files } where each file is a string when its bytes
 * are valid UTF-8, else { bytes: number[] } — so the suites can compare
 * what the app actually persisted, not what it had in memory.
 */
async function readProject(r) {
  return r.page.evaluate((key) =>
    (async () => {
      const id = localStorage.getItem(key);
      if (!id) return null;
      const root = await navigator.storage.getDirectory();
      const projects = await root.getDirectoryHandle("projects");
      const dir = await projects.getDirectoryHandle(id);
      const meta = JSON.parse(
        await (await (await dir.getFileHandle("project.json")).getFile()).text(),
      );
      const files = {};
      async function walk(d, prefix) {
        for await (const entry of d.values()) {
          const p = prefix ? prefix + "/" + entry.name : entry.name;
          if (entry.kind === "directory") {
            await walk(entry, p);
          } else if (entry.name !== "project.json" && entry.name !== "preview.png") {
            const buf = new Uint8Array(await (await entry.getFile()).arrayBuffer());
            let ok = false;
            let text = "";
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
              ok = true;
            } catch {
              // not valid UTF-8 → binary
            }
            files[p] = ok ? text : { bytes: Array.from(buf) };
          }
        }
      }
      await walk(dir, "");
      return { id, meta, files };
    })(),
    ACTIVE_KEY,
  );
}

module.exports = { Runner, APP_URL, CHROME, FIREFOX, PNG_PATH, seedProject, readProject, ACTIVE_KEY };
