importScripts('busytex_pipeline.js');

onmessage = async ({data : {files, main_tex_path, bibtex, busytex_wasm, busytex_js, texlive_js, texmf_local, preload, verbose}}) =>
{
    // Vendored from build b16fdf28 with one addition: report failures back to
    // the page. Without this, any error (bad asset URL, wasm load failure,
    // pipeline crash) leaves the caller hanging on "Loading engine…" forever.
    try
    {
        if(busytex_wasm && busytex_js && texlive_js)
        {
            pipeline = new BusytexPipeline(busytex_js, busytex_wasm, texlive_js, texmf_local, msg => postMessage({print : msg}), preload, BusytexPipeline.ScriptLoaderWorker);
            // The constructor preloads the module; swallow the rejection here
            // (as unhandled-rejection noise) — compile() awaits the same
            // promise and will report it properly.
            if (pipeline.Module)
                pipeline.Module.catch(() => {});
        }
        else if(files && pipeline)
            postMessage(await pipeline.compile(files, main_tex_path, bibtex, verbose))
    }
    catch(e)
    {
        postMessage({error : String(e && e.stack || e)});
    }
};
