// Vendored from the Texlyre busytex build of TeX Live 2026
// (github.com/TeXlyre/texlyre-busytex-build, release
// build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86), with changes:
//
// 1. Error reporting. Upstream had no error channel: any failure (asset
//    load, pipeline crash) left the page hanging on "Loading engine…"
//    forever. Every failure now posts {error}, which the page shows in the
//    status line.
// 2. {ready} is posted once the script has loaded, so the page can confirm
//    the worker started.
// 3. {loaded} is posted once the engine (wasm + texlive-basic data) has
//    finished loading, so the page can stop showing "Loading engine…"
//    (upstream posts {initialized: versions} instead; the applet version
//    map is not needed by the page).
// 4. remote_packages: the names of LaTeX packages the SERVER has installed
//    in its CTAN package store (served to the engine on demand through
//    TEXLIVE_REMOTE_ENDPOINT — see /api/texlive-remote/). They are passed
//    to the pipeline, whose resolver treats them as local packages, so a
//    \usepackage for an installed package never triggers the "unresolved →
//    enable ALL data packages" fallback (which would pull the ~540 MB
//    recommended+extra trees the package does not need).
//
// The WASM assets come from the pinned release (served through
// /api/texlive/). The biber loader is the unmodified release file,
// imported from there; the pipeline is the vendored, patched copy next to
// this worker (busytex_pipeline.js — see that file's header). The protocol
// is the release's: the page posts plain message objects ({busytex_js, …}
// or {files, …}) — no wrapper. Inside the worker, onmessage receives a
// MessageEvent whose .data is that object, so the fields are read from
// evt.data.
//
// Bump SCRIPT_VERSION whenever this file or busytex_pipeline.js changes —
// browsers cache worker scripts aggressively and even a hard refresh may
// not refetch them (the pipeline import is version-stamped with it). Keep
// it in sync with WORKER_VERSION in src/lib/busytex.ts.
const SCRIPT_VERSION = 17;

function fail(prefix, e)
{
    try
    {
        postMessage({error : prefix + " " + String((e && e.stack) || e)});
    }
    catch(_)
    {
        // The worker is already broken; there is nowhere left to report.
    }
}

self.onerror = (e) =>
    fail("worker error: " + (e.message || "unknown") + " at " + (e.filename || "?") + ":" + (e.lineno || "?"), e.error);

self.onunhandledrejection = (e) =>
    fail("unhandled promise rejection:", e.reason);

// Load the biber class (vendored copy, path-preserving patch — see the
// file header) and the patched pipeline. importScripts() is synchronous
// and same-origin-only; a failure here kills the worker before it can do
// anything, so report it on {error} (the page shows it in the status line
// instead of waiting forever).
try
{
    importScripts("busytex_biber.js?v=" + SCRIPT_VERSION);
    importScripts("busytex_pipeline.js?v=" + SCRIPT_VERSION);
    // {ready}: the worker script (and its imports) loaded — the page can
    // confirm the worker started.
    postMessage({ready : true});
}
catch(e)
{
    fail("failed to load worker scripts:", e);
}

self.pipeline = null;

onmessage = async (evt) =>
{
    // Note: in a destructure pattern like {data : {…}}, `data` is a
    // property NAME, not a variable — capture it explicitly or the
    // reference below is a ReferenceError.
    const data = evt && evt.data;
    const {files, main_tex_path, bibtex, biber, makeindex, rerun,
           busytex_wasm, busytex_js, biber_js, biber_wasm, biber_data,
           preload_data_packages_js, data_packages_js, texmf_local,
           preload, verbose, driver, remote_endpoint, shell_escape,
           load_shell_handler_script, read_project_files,
           write_texlive_remote_files, write_texlive_remote_misses,
           remote_packages} = data || {};
    try
    {
        if(busytex_wasm && busytex_js && preload_data_packages_js)
        {
            self.pipeline = new BusytexPipeline(
                busytex_js, busytex_wasm,
                data_packages_js, preload_data_packages_js,
                texmf_local,
                msg => postMessage({print : msg}),
                // Engine ready (wasm + preloaded data package loaded,
                // applet versions reported): {loaded} ends "Loading
                // engine…" on the page.
                () => postMessage({loaded : true}),
                preload,
                BusytexPipeline.ScriptLoaderWorker,
                biber_js, biber_wasm, biber_data,
                // PATCH 4: server-installed CTAN packages.
                remote_packages);
        }
        else if(load_shell_handler_script)
        {
            importScripts(load_shell_handler_script);
            if(self.handler_ready)
                await self.handler_ready;
            postMessage({shell_handler_script_loaded : load_shell_handler_script});
        }
        else if(read_project_files && self.pipeline)
        {
            postMessage({project_files : await self.pipeline.read_project_files(read_project_files.dir || null)});
        }
        else if(write_texlive_remote_files && self.pipeline)
        {
            await self.pipeline.write_texlive_remote_files(write_texlive_remote_files);
            postMessage({texlive_remote_written : true});
        }
        else if(write_texlive_remote_misses && self.pipeline)
        {
            await self.pipeline.write_texlive_remote_misses(write_texlive_remote_misses);
            postMessage({texlive_remote_misses_written : true});
        }
        else if(files)
        {
            if(!self.pipeline)
                fail("compile requested before the engine was initialized:", new Error("no init message processed"));
            else
                postMessage(await self.pipeline.compile(files, main_tex_path, bibtex, biber, makeindex, rerun, verbose, driver, data_packages_js, remote_endpoint, shell_escape === true));
        }
        else
        {
            fail("unrecognized worker message (expected {data: {…init…}} or {data: {…compile…}}):", new Error(JSON.stringify(data || {})));
        }
    }
    catch(e)
    {
        fail("worker handler failed:", e);
    }
};
