// Vendored from busytex build b16fdf28, with changes:
//
// 1. Error reporting. Upstream had no error channel: any failure (asset
//    load, pipeline crash) left the page hanging on "Loading engine…"
//    forever. Every failure now posts {error}, which the page shows in
//    the status line.
// 2. {ready} is posted once the script has loaded, so the page (and the
//    Node smoke test) can confirm the worker started.
// 3. {loaded} is posted once the engine (wasm + texlive data) has
//    finished loading, so the page can stop showing "Loading engine…".
//
// The worker + pipeline come from the same commit as the pinned WASM
// release and speak the old protocol: the page posts plain message
// objects ({busytex_js, …} or {files, …}) — no wrapper. Inside the
// worker, onmessage receives a MessageEvent whose .data is that object,
// so the fields are read from evt.data.
//
// Bump SCRIPT_VERSION whenever this file or busytex_pipeline.js changes —
// browsers cache worker scripts aggressively and even a hard refresh may
// not refetch them. Keep it in sync with WORKER_VERSION in
// src/lib/busytex.ts.
const SCRIPT_VERSION = 7;

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

if(typeof BusytexPipeline === "undefined")
{
    try
    {
        importScripts("busytex_pipeline.js?v=" + SCRIPT_VERSION);
    }
    catch(e)
    {
        fail("importScripts('busytex_pipeline.js') failed:", e);
    }
}

postMessage({ready : true});

onmessage = async (evt) =>
{
    // Note: in a destructure pattern like {data : {…}}, `data` is a
    // property NAME, not a variable — capture it explicitly or the
    // reference below is a ReferenceError.
    const data = evt && evt.data;
    const {files, main_tex_path, bibtex, busytex_wasm, busytex_js, texlive_js, texmf_local, preload, verbose} = data || {};
    try
    {
        if(busytex_wasm && busytex_js && texlive_js)
        {
            pipeline = new BusytexPipeline(busytex_js, busytex_wasm, texlive_js, texmf_local, msg => postMessage({print : msg}), preload, BusytexPipeline.ScriptLoaderWorker);
            // The constructor kicks off the module preload. Tell the page
            // when the engine is ready ({loaded}), and forward any load
            // failure instead of leaving it unhandled (and invisible).
            if(pipeline.Module)
                pipeline.Module
                    .then(() => postMessage({loaded : true}))
                    .catch(e => fail("engine failed to load:", e));
        }
        else if(files)
        {
            if(!pipeline)
                fail("compile requested before the engine was initialized:", new Error("no init message processed"));
            else
                postMessage(await pipeline.compile(files, main_tex_path, bibtex, verbose));
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
