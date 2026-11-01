// Shared helpers for the e2e suites. Each suite gets a Runner, which
// launches a fresh disposable Chromium profile under the OS temp dir,
// waits for the engine, drives the editor page, and tears the profile down.
const os = require("os");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const APP_URL = process.env.APP_URL || "http://localhost:3000/editor";
const CHROME =
  process.env.CHROME_EXECUTABLE ||
  "/home/lukas/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const PNG_PATH = path.join(__dirname, "logo.png");

class Runner {
  constructor(name) {
    this.name = name;
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
    this.ctx = await chromium.launchPersistentContext(this.profile, {
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
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

  // Wait until the status reads "Ready." (engine + texmf assets loaded).
  async waitReady() {
    for (let i = 0; i < 90; i++) {
      await this.page.waitForTimeout(2000);
      const t = ((await this.status.textContent().catch(() => "")) || "").trim();
      if (/^Ready\.$/.test(t)) return true;
    }
    return false;
  }

  // Click "Recompile" and wait for a terminal status. Returns the final
  // status text ("Compiled in N ms" or a failure message, "" on timeout).
  async recompile() {
    await this.page
      .locator("button", { hasText: "Recompile" })
      .first()
      .click();
    for (let i = 0; i < 90; i++) {
      await this.page.waitForTimeout(1000);
      const t = (await this.status.textContent().catch(() => "")) || "";
      if (/Compiled in \d+ ms|failed/i.test(t)) return t;
    }
    return "";
  }

  // Visible text of the rendered PDF (pdf.js marks each line's spans with
  // data-baseline).
  async pdfText() {
    return this.page.evaluate(() => {
      const viewer = document.querySelector("[data-pdf-viewer]");
      return viewer
        ? Array.from(viewer.querySelectorAll("span[data-baseline]"))
            .map((s) => s.textContent)
            .join(" ")
        : "";
    });
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

  async finish() {
    await this.ctx.close();
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

module.exports = { Runner, APP_URL, CHROME, PNG_PATH };
