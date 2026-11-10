// The inscribe.io layout: the slimmed app bar (wordmark + build status
// only — project management moved to the dashboard), the icon rail that
// switches the left panel (files/search/chat/log) with GitHub + Packages
// anchored at its bottom, the search view itself, and the divider's
// hover-only swap button, the formatting toolbar + save indicator row,
// the PDF pane's right group (compile history, notes, page badge), the
// files-panel stats popover, and the PDF line-number gutter drawn from
// the auto-compiled synctex map. No compiles of its own (the first load
// auto-compiles; the gutter checks poll for its PDF + map) and no
// project management — dashboard.cjs and projects.cjs own those.
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

  // --- the formatting toolbar (the row under the tab strip) ---------------
  // main.tex is the active file until the search section below switches it,
  // so the functional check runs here and restores the file afterwards.
  const toolbar = await r.page.evaluate(() => {
    const sel = document.querySelector("select[data-format-block]");
    return {
      block: sel ? [...sel.options].map((o) => o.value).join(",") : "",
      btns: [...document.querySelectorAll("button[data-format]")].map(
        (b) => b.dataset.format,
      ),
    };
  });
  r.ok(
    "toolbar: block select + I/B/U/S/link/code/image/table, in order",
    toolbar.block ===
      "normal,section,subsection,subsubsection,itemize,enumerate" &&
      toolbar.btns.join(",") ===
        "emph,strong,underline,strikethrough,link,code,image,table",
    JSON.stringify(toolbar),
  );
  const origMain = await r.page.evaluate(
    () => window.monaco.editor.getEditors()[0]?.getModel()?.getValue() ?? null,
  );
  // Park the cursor just after \begin{document}: the edit may trip the
  // auto-recompile while it is in its intermediate state, and a failed
  // compile (text before \documentclass would be one) opens the log pane
  // — the stats check below expects the files pane.
  await r.page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    const m = ed?.getModel();
    if (!ed || !m) return;
    for (let i = 1; i <= m.getLineCount(); i++) {
      if ((m.getLineContent(i) ?? "").includes("\\begin{document}")) {
        ed.setPosition({ lineNumber: Math.min(i + 1, m.getLineCount()), column: 1 });
        return;
      }
    }
  });
  await r.page.locator('button[data-format="strong"]').click();
  const wrapped = await poll(
    r,
    () => {
      const v = window.monaco.editor.getEditors()[0]?.getModel()?.getValue();
      return v && v.includes("\\textbf{Text}") ? v : null;
    },
    10,
  );
  r.ok(
    "toolbar: Bold inserts the \\textbf{Text} placeholder",
    !!wrapped,
    wrapped?.slice(0, 80),
  );
  // Restore the pristine file: the search and gutter checks below expect
  // the default project, and the auto-recompile must get it back too.
  await r.page.evaluate(
    (o) => window.monaco.editor.getEditors()[0]?.getModel()?.setValue(o),
    origMain,
  );
  // The debounced OPFS persist completes: the indicator is Saved again.
  const savedState = await poll(r, () =>
    document.querySelector("[data-save-state]")?.getAttribute("data-save-state") ===
    "saved"
      ? document.querySelector("[data-save-state]")?.textContent?.trim()
      : null,
  );
  r.ok(
    "toolbar: save indicator reads Saved at rest",
    savedState === "Saved",
    savedState,
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

  // --- the PDF line-number gutter (the auto-compiled map from above) ----
  // The viewer draws one label per physical baseline, in the page's own
  // left margin, from the decoded synctex map. Poll: on a fresh profile
  // the engine download plus the synctex decode can still be running.
  const gutterFirst = await poll(
    r,
    () => {
      const w = document.querySelector("[data-page]");
      const labs = w
        ? [...w.querySelectorAll("[data-line-gutter-label]")]
        : [];
      return labs.length > 0 ? labs.length : null;
    },
    80,
    500,
  );
  r.ok(
    "gutter: line numbers appear in the rendered page's left margin",
    (gutterFirst ?? 0) > 3,
    gutterFirst,
  );
  const gutter = await r.page.evaluate(() => {
    const pages = [];
    for (const w of document.querySelectorAll("[data-page]")) {
      const pr = w.getBoundingClientRect();
      const labs = [];
      for (const l of w.querySelectorAll("[data-line-gutter-label]")) {
        const lr = l.getBoundingClientRect();
        labs.push({
          line: Number(l.textContent),
          file: l.dataset.lineGutterFile ?? "",
          num: /^\d+$/.test(l.textContent ?? ""),
          left: lr.left - pr.left, // px from the page's left edge
          top: lr.top - pr.top, // px from the page's top edge
          pe: getComputedStyle(l).pointerEvents,
        });
      }
      pages.push(labs);
    }
    const stray = [...document.querySelectorAll("[data-line-gutter-label]")]
      .filter((l) => !l.closest("[data-page]")).length;
    return { pages, stray };
  });
  const all = gutter.pages.flat();
  r.ok(
    "gutter: every label is a line number in the page's left margin",
    all.length > 0 &&
      all.every((g) => g.num && g.left >= 0 && g.left <= 12),
    JSON.stringify(all.slice(0, 3)) + ` (stray=${gutter.stray})`,
  );
  // A click on a label must fall through to the page's synctex handler.
  r.ok(
    "gutter: labels are click-through (pointer-events:none)",
    all.every((g) => g.pe === "none"),
    JSON.stringify([...new Set(all.map((g) => g.pe))]),
  );
  // Top to bottom on each page, the line numbers never decrease WITHIN
  // one file (a wrapped source line may repeat its number on the next
  // baseline). Across files they reset — the references section is
  // typeset from refs.bib, so main.tex:8 above refs.bib:3 is correct.
  let monotone = null;
  for (const labs of gutter.pages) {
    labs.sort((a, b) => a.top - b.top);
    for (let i = 1; i < labs.length; i++) {
      const p = labs[i - 1];
      if (p.file !== labs[i].file) continue;
      const bad = labs[i].top <= p.top || labs[i].line < p.line;
      if (bad && monotone === null) monotone = `${p.file}:${p.line} -> ${labs[i].file}:${labs[i].line}`;
    }
  }
  r.ok(
    "gutter: line numbers rise top to bottom within a file",
    monotone === null,
    monotone,
  );
  r.ok(
    "gutter: labels live only inside page wrappers",
    gutter.stray === 0,
    gutter.stray,
  );

  // --- the PDF pane's right group: history, notes, page badge --------------
  // The auto-compile above produced the PDF, so the history is non-empty.
  await r.page.locator('button[title="Compile history"]').click();
  const hist = await poll(r, () => {
    const ul = document.querySelector('[data-popover-root="history"] ul');
    return ul?.textContent ?? null;
  });
  r.ok(
    "history: the popover lists the auto-compile",
    !!hist && /Compiled in \d+ ms/.test(hist),
    String(hist).slice(0, 80),
  );
  await r.page.locator('button[title="Compile history"]').click(); // close
  // Notes survive a close/reopen: the textarea remounts from localStorage.
  const notesBtn = r.page.locator('button[title^="Project notes"]');
  await notesBtn.click();
  await r.page.locator("[data-notes]").waitFor({ state: "visible", timeout: 5000 });
  await r.page.locator("[data-notes]").fill("GUTTER-NOTE");
  await notesBtn.click(); // close
  await notesBtn.click(); // reopen
  const noteVal = await r.page.locator("[data-notes]").inputValue();
  r.ok(
    "notes: typed notes survive closing and reopening",
    noteVal === "GUTTER-NOTE",
    noteVal,
  );
  await notesBtn.click(); // close
  // The page-count badge on the document glyph mirrors the rendered pages.
  const pageBadge = await r.page.evaluate(() => ({
    n:
      document.querySelector('span[title$="in the current PDF"] span')
        ?.textContent ?? "",
    pages: document.querySelectorAll("[data-page]").length,
  }));
  r.ok(
    "page badge: counts the rendered PDF pages",
    pageBadge.n === String(pageBadge.pages) && pageBadge.pages > 0,
    JSON.stringify(pageBadge),
  );
  // The stats popover (files-panel header): project + active-file counts.
  // A failed auto-compile earlier in the suite (the Bold test edits the
  // file) opens the log pane and unmounts the FileBrowser — make sure
  // the files pane is active before looking for the button.
  await r.page.locator('[data-rail="files"]').click();
  await r.page
    .locator('button[data-action="new-file"]')
    .waitFor({ state: "visible", timeout: 5000 });
  await r.page.locator('button[title="Project stats"]').click();
  const stats = await poll(r, () => {
    const pop = document.querySelector('[data-popover-root="stats"] dl');
    if (!pop) return null;
    return [...pop.querySelectorAll("div")].map((d) => ({
      dt: d.querySelector("dt")?.textContent ?? "",
      dd: d.querySelector("dd")?.textContent ?? "",
    }));
  });
  const srows = Object.fromEntries(
    (stats ?? []).map((s) => [s.dt.split(" — ")[0].trim(), s.dd]),
  );
  r.ok(
    "stats: files, words, lines and PDF pages are numeric",
    !!stats &&
      /^\d+$/.test(srows.Files ?? "") &&
      /^\d+$/.test(srows.Words ?? "") &&
      /^\d+$/.test(srows.Lines ?? "") &&
      /^\d+$/.test(srows["PDF pages"] ?? ""),
    JSON.stringify(stats),
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
