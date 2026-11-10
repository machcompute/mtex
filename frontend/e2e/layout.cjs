// The inscribe.io layout: the slimmed app bar (wordmark + build status
// only — project management moved to the dashboard), the icon rail that
// switches the left panel (files/search/chat/log) with GitHub + Packages
// anchored at its bottom, the search view itself, and the divider's
// hover-only swap button. No compiles of its own (the first load
// auto-compiles; nothing here depends on the PDF) and no project
// management — dashboard.cjs and projects.cjs own those.
const { Runner } = require("./helpers.cjs");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Poll `fn` (a page function taking no args) until it returns truthy.
async function poll(r, fn, tries = 40, every = 250) {
  for (let i = 0; i < tries; i++) {
    const v = await r.page.evaluate(fn);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

(async () => {
  const r = new Runner("layout");
  await r.start();
  await r.goto();
  await r.page.waitForSelector('button[data-action="new-file"]', { timeout: 30000 });
  await r.page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });
  // applyProject owns the initial left pane (it resets it to "files" when
  // the project settles), and it is what fills the monaco model — a
  // non-empty main.tex model means the load finished and rail clicks can
  // no longer be reverted.
  const ready = await poll(
    r,
    () =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith("main.tex"))
        ?.getValue() !== "",
  );
  if (!ready) {
    console.error("FATAL: the default project never loaded (main.tex empty)");
    await r.finish();
    process.exit(1);
  }

  // --- app bar: wordmark + status, and nothing else -----------------------
  const bar = await r.page.evaluate(() => {
    const h = document.querySelector("header");
    const word = h?.querySelector('a[href="/"]');
    const titles = [...h?.querySelectorAll("[title]") ?? []].map((b) =>
      b.getAttribute("title"),
    );
    return {
      word: word?.textContent?.trim() ?? "",
      projectsText: /projects/i.test(h?.textContent ?? ""),
      projectsTitle: titles.some((t) => /projects/i.test(t ?? "")),
    };
  });
  r.ok(
    "app bar: wordmark links to the dashboard",
    bar.word === "HomeHub",
    bar.word,
  );
  // While a fresh profile downloads the engine .data the status span is
  // replaced by a progress bar — poll until the text version comes back.
  const status = await poll(r, () => {
    const s = document.querySelector("header span.truncate");
    return (s?.textContent ?? "").trim() || null;
  });
  r.ok("app bar: build status still in the header", !!status, status);
  r.ok(
    "app bar: no Projects menu (it lives on the dashboard now)",
    !bar.projectsText && !bar.projectsTitle,
    `text=${bar.projectsText} title=${bar.projectsTitle}`,
  );

  // --- the icon rail: four entries, in order, bottom-anchored extras ------
  const rail = await r.page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Left panel"]');
    if (!nav) return null;
    const btns = [...nav.querySelectorAll(":scope > button[data-rail]")];
    const box = (el) => el.getBoundingClientRect();
    const log = box(btns.find((b) => b.dataset.rail === "log"));
    const gh = box(nav.querySelector('button[data-action="github"]'));
    const pk = box(nav.querySelector('button[data-action="packages"]'));
    return {
      order: btns.map((b) => b.dataset.rail),
      titles: btns.map((b) => b.title),
      active: [...nav.querySelectorAll(":scope > [data-active]")].map(
        (b) => b.dataset.rail,
      ),
      x: box(btns[0]).x,
      ghBelowLog: gh.y > log.y,
      pkBelowGh: pk.y > gh.y,
    };
  });
  r.ok(
    "rail: files/search/chat/log, in that order",
    rail?.order.join(",") === "files,search,chat,log",
    rail?.order.join(","),
  );
  r.ok(
    "rail: each entry has its tooltip",
    rail?.titles.join(",") === "Files,Search,Chat,Log",
    rail?.titles.join(","),
  );
  r.ok("rail: files active after load", rail?.active.join(",") === "files", rail?.active.join(","));
  r.ok("rail: sits in the left column", rail?.x < 16, rail?.x);
  r.ok(
    "rail: GitHub and Packages anchor the bottom",
    rail?.ghBelowLog && rail?.pkBelowGh,
    JSON.stringify({ gh: rail?.ghBelowLog, pk: rail?.pkBelowGh }),
  );

  // --- rail switching: data-active follows, the pane content swaps --------
  const filesPane = (r) => r.page.locator('button[data-action="new-file"]');

  await r.page.locator('[data-rail="search"]').click();
  await r.page.locator("[data-search-input]").waitFor({ state: "visible", timeout: 10000 });
  r.ok(
    "rail switch: search pane shows the query input",
    (await r.page.locator("[data-search-input]").count()) === 1 &&
      (await filesPane(r).count()) === 0,
  );
  await r.page.locator('[data-rail="chat"]').click();
  await r.page.locator("[data-chat-input]").waitFor({ state: "visible", timeout: 10000 });
  r.ok(
    "rail switch: chat pane replaces search",
    (await r.page.locator("[data-chat-input]").count()) === 1 &&
      (await r.page.locator("[data-search-input]").count()) === 0,
  );
  await r.page.locator('[data-rail="log"]').click();
  await r.page.locator("h2", { hasText: /^Log$/ }).waitFor({ state: "visible", timeout: 10000 });
  r.ok(
    "rail switch: log pane replaces chat",
    (await r.page.locator("[data-chat-input]").count()) === 0,
  );
  await r.page.locator('[data-rail="files"]').click();
  await filesPane(r).waitFor({ state: "visible", timeout: 10000 });
  r.ok(
    "rail switch: back to files, the others are gone",
    (await filesPane(r).count()) === 1 &&
      (await r.page.locator("[data-search-input]").count()) === 0 &&
      (await r.page.locator("[data-chat-input]").count()) === 0,
  );

  // --- the search view: rows, badge, empty states, jump-to-line -----------
  await r.page.locator('[data-rail="search"]').click();
  const input = r.page.locator("[data-search-input]");
  await input.waitFor({ state: "visible", timeout: 10000 });

  await input.fill("documentclass");
  const rows1 = await poll(r, () =>
    [...document.querySelectorAll("button")]
      .map((b) => {
        const s = b.querySelector("span");
        return s && /^\S+:\d+$/.test(s.textContent ?? "") ? b.textContent : null;
      })
      .filter(Boolean),
  );
  r.ok(
    "search: documentclass finds main.tex:1",
    rows1?.length >= 1 &&
      rows1[0].startsWith("main.tex:1") &&
      rows1[0].includes("\\documentclass{article}"),
    rows1?.[0],
  );
  // The count badge in the search header mirrors the row count.
  const badge = await r.page.evaluate(
    () =>
      document
        .querySelector("[data-search-input]")
        ?.parentElement.querySelector("span.tabular-nums")?.textContent,
  );
  r.ok("search: header badge counts the matches", badge === String(rows1?.length), badge);

  await input.fill("zzz_no_match_zzz");
  await poll(r, () => document.body.textContent.includes("No matches."));
  r.ok(
    "search: impossible query says No matches",
    (await r.page.locator("text=No matches.").count()) === 1,
  );
  await input.fill("");
  await poll(r, () =>
    document.body.textContent.includes("Search every text file in the project."),
  );
  r.ok("search: an empty query shows the hint", true);

  // A hit outside the active file must open it and reveal the line.
  await input.fill("article");
  await poll(r, () =>
    [...document.querySelectorAll("button")].some((b) =>
      (b.querySelector("span")?.textContent ?? "").startsWith("refs.bib:"),
    ),
  );
  await r.page.locator("button", { hasText: "refs.bib:" }).first().click();
  const jump = await poll(r, () => {
    const ed = window.monaco.editor.getEditors()[0];
    const m = ed?.getModel();
    return m?.uri.path.endsWith("refs.bib")
      ? { path: m.uri.path, line: ed.getPosition()?.lineNumber }
      : null;
  });
  r.ok(
    "search: clicking a refs.bib hit opens it at that line",
    jump?.path.endsWith("refs.bib") && jump.line === 1,
    JSON.stringify(jump),
  );

  // --- divider swap button: hidden until hover, swaps the two panes -------
  const swapBtn = r.page.locator('button[title="Swap editor and PDF"]');
  const divider = r.page.locator('div[title="Drag to re-split — hover for the swap button"]');
  const rest = await swapBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    return `${cs.opacity}|${cs.pointerEvents}`;
  });
  r.ok(
    "swap: invisible and click-through at rest",
    rest === "0|none",
    rest,
  );
  await divider.hover();
  await poll(r, () => getComputedStyle(document.querySelector('button[title="Swap editor and PDF"]')).opacity === "1");
  const box = (sel) => r.page.locator(sel).first().boundingBox();
  const before = { ed: await box(".monaco-editor"), pdf: await box("[data-pdf-viewer]") };
  await swapBtn.click();
  let after = null;
  for (let i = 0; i < 40; i++) {
    const ed = await box(".monaco-editor");
    const pdf = await box("[data-pdf-viewer]");
    if (ed && pdf && ed.x > pdf.x) {
      after = { ed: ed.x, pdf: pdf.x };
      break;
    }
    await sleep(250);
  }
  r.ok(
    "swap: the editor and the PDF exchange places",
    before.ed.x < before.pdf.x && after !== null,
    JSON.stringify({ before, after }),
  );

  console.log(
    r.failures === 0 ? "ALL LAYOUT CHECKS PASSED" : r.failures + " CHECK(S) FAILED",
  );
  await r.finish();
  process.exit(r.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
