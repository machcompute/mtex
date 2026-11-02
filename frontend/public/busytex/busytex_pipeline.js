// Vendored from busytex build b16fdf28 (same commit as the pinned WASM
// release), with patches. See the end-of-file note for the patch list.
//
//TODO: work with only files paths (without dir paths)
//TODO: what happens if creating another pipeline (waiting data error?)
//TODO: TEXMFLOG?
//TODO: put texlive into /opt/texlive/2020 or ~/.texlive2020?
//TODO: configure fontconfig to use /etc/fonts
//TODO: move latex.fmt to /texlive

class BusytexPipeline
{
    static VerboseSilent = 'silent';
    static VerboseInfo = 'info';
    static VerboseDebug = 'debug';

    //FIXME begin: have to do static to execute LZ4 data packages: https://github.com/emscripten-core/emscripten/issues/12347
    static preRun = [];

    static data_packages = [];
    
    static locateFile(remote_package_name) 
    {
        return BusytexPipeline.data_packages
            .map(data_package_js => data_package_js.replace('.js', '.data'))
            .find(data_file => data_file.endsWith(remote_package_name));
    }
    //FIXME end

    static ScriptLoaderDocument(src)
    {
        return new Promise((resolve, reject) =>
        {
            let s = self.document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            self.document.head.appendChild(s);
        });
    }

    static ScriptLoaderRequire(src)
    {
        return new Promise(resolve => self.require([src], resolve));
    }

    static ScriptLoaderWorker(src)
    {
        return Promise.resolve(self.importScripts(src));
    }

    constructor(busytex_js, busytex_wasm, texlive_js, texmf_local, print, preload, script_loader)
    {
        this.print = print;
        this.preload = preload;
        this.wasm_module_promise = fetch(busytex_wasm).then(WebAssembly.compileStreaming);
        this.em_module_promise = script_loader(busytex_js);
        
        BusytexPipeline.data_packages = []
        for(const data_package_js of texlive_js)
        {
            this.em_module_promise = this.em_module_promise.then(_ => script_loader(data_package_js));
            BusytexPipeline.data_packages.push(data_package_js);
        }
        
        this.ansi_reset_sequence = '\x1bc';
        
        this.project_dir = '/home/web_user/project_dir/';
        this.bin_busytex = '/bin/busytex';
        this.fmt_latex = '/xelatex.fmt';
        this.dir_texmfdist = ['/texlive', '/texmf', ...texmf_local].map(texmf => (texmf.startsWith('/') ? '' : this.project_dir) + texmf + '/texmf-dist').join(':');
        this.dir_texmfvar = '/texlive/texmf-dist/texmf-var';
        this.dir_cnf = '/texlive/texmf-dist/web2c';
        this.dir_fontconfig = '/etc/fonts';

        this.verbose_args = 
        {
            [BusytexPipeline.VerboseSilent] : {
                xetex : [],
                bibtex8 : [],
                xdvipdfmx : []
            },
            [BusytexPipeline.VerboseInfo] : {
                xetex: ['-kpathsea-debug', '32'],
                bibtex8 : ['--debug', 'search'],
                xdvipdfmx : ['-v', '--kpathsea-debug', '32'],
            },
            [BusytexPipeline.VerboseDebug] : {
                xetex : ['-kpathsea-debug', '63', '-recorder'],
                bibtex8 : ['--debug', 'all'],
                xdvipdfmx : ['-vv', '--kpathsea-debug', '63'],
            },
        };

        this.mem_header_size = 2 ** 25;
        this.env = {TEXMFDIST : this.dir_texmfdist, TEXMFVAR : this.dir_texmfvar, TEXMFCNF : this.dir_cnf, FONTCONFIG_PATH : this.dir_fontconfig};
        this.Module = this.preload ? this.reload_module(this.env, this.project_dir) : null;
    }

    terminate()
    {
        this.Module = null;
    }

    async reload_module(env, project_dir)
    {
        const [wasm_module, em_module] = await Promise.all([this.wasm_module_promise, this.em_module_promise]);
        const {print, init_env} = this;
        const Module =
        {
            thisProgram : this.bin_busytex,
            noInitialRun : true,
            totalDependencies: 0,
            prefix : "",
            
            preRun : [() =>
            {
                Object.setPrototypeOf(BusytexPipeline, Module);
                self.LZ4 = Module.LZ4;
                for(const preRun of BusytexPipeline.preRun) 
                    preRun();

                Object.assign(Module.ENV, env);
                Module.FS.mkdir(project_dir);
            }],

            instantiateWasm(imports, successCallback)
            {
                // WebAssembly.instantiate resolves with the Instance itself when
                // given a compiled Module (compileStreaming), but with
                // {module, instance} when given a buffer source — receiveInstance
                // wants the instance either way.
                WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(WebAssembly.compileStreaming ? output : output.instance));
            },
            
            print(text) 
            {
                // (upstream guarded this with `verbose == BusytexVerboseSilent`, but
                // neither identifier is in scope here, so any stdout write threw;
                // forward the lines so compile progress stays visible)
                Module.setStatus(Module.prefix + ' | stdout: ' + (arguments.length > 1 ?  Array.prototype.slice.call(arguments).join(' ') : text));
            },

            printErr(text)
            {
                Module.setStatus(Module.prefix + ' | stderr: ' + (arguments.length > 1 ?  Array.prototype.slice.call(arguments).join(' ') : text));
            },
            
            setPrefix(text)
            {
                this.prefix = text;
            },
            
            setStatus(text)
            {
                print((this.statusPrefix || '') + text);
            },
            
            monitorRunDependencies(left)
            {
                this.totalDependencies = Math.max(this.totalDependencies, left);
                Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
            },
        };
       
        const initialized_module = await busytex(Module);
        console.assert(this.mem_header_size % 4 == 0 && initialized_module.HEAP32.slice(this.mem_header_size / 4).every(x => x == 0));
        return initialized_module;
    }

    // PATCH 9: one-time install of the extra tree (see the call in
    // compile()). extra_tree_promise is set by the worker (a parsed
    // /texmf-extra/extra-bundle.json, or null if the fetch failed — the
    // worker already printed why). A missing tree must not block compiling
    // documents that don't use the extra packages.
    async install_extra_tree(FS, PATH)
    {
        if(this.extra_tree_installed)
            return;
        this.extra_tree_installed = true;
        let files = null;
        try
        {
            files = await this.extra_tree_promise;
        }
        catch(e)
        {
            this.print("extra texmf tree unavailable: " + e);
        }
        if(!files || files.length === 0)
            return;
        const root = "/texmf-extra";
        // mkdirTree: /texmf-extra does not exist yet, and a plain
        // FS.mkdir of the first subdir would ENOENT on its missing parent.
        try
        {
            FS.mkdirTree(root);
        }
        catch
        {
            // already there — keep going
        }
        // FS.writeFile does not create parent directories — emit the
        // ancestor dirs first, sorted, exactly like compile()'s file loop.
        const dirs = new Set();
        for(const f of files)
        {
            const parts = f.path.split('/');
            for(let i = 1; i < parts.length; i++)
                dirs.add(parts.slice(0, i).join('/'));
        }
        const all = [
            ...[...dirs].map(path => ({path, dir : true})),
            ...files.map(f => ({path : f.path, contents : f.contents})),
        ].sort((a, b) => a.path < b.path ? -1 : 1);
        for(const {path, dir, contents} of all)
        {
            const p = PATH.join2(root, path);
            if(dir)
                FS.mkdir(p);
            else
                FS.writeFile(p, contents);
        }
        this.print("extra texmf tree installed (" + files.length + " files)");
    }

    async compile(files, main_tex_path, bibtex, verbose)
    {
        const NOCLEANUP_callMain = (Module, args) =>
        {
            Module.setPrefix(args[0]);
            const entryFunction = Module['_main'];
            const argc = args.length+1;
            const argv = Module.stackAlloc((argc + 1) * 4);
            Module.HEAP32[argv >> 2] = Module.allocateUTF8OnStack(Module.thisProgram);
            for (let i = 1; i < argc; i++) 
                Module.HEAP32[(argv >> 2) + i] = Module.allocateUTF8OnStack(args[i - 1]);
            Module.HEAP32[(argv >> 2) + argc] = 0;

            try
            {
                entryFunction(argc, argv);
            }
            catch(e)
            {
                this.print('callMain: ' + e.message);
                return e.status;
            }
            
            return 0;
        }
        
        this.print(this.ansi_reset_sequence);
        this.print(`New compilation started: [${main_tex_path}]`);
        
        if(this.Module == null)
            this.Module = this.reload_module(this.env, this.project_dir);
        const Module = await this.Module;
        const [FS, PATH] = [Module.FS, Module.PATH];

        // PATCH 9: install the vendored extra TeX tree (public/texmf-extra,
        // generated by scripts/sync-texlive.sh) ONCE into the FS ROOT.
        // project_dir is remounted as a fresh MEMFS on every compile, so a
        // multi-MB tree cannot ride in the per-compile payload — the
        // root-level /texmf-extra survives across compiles for the worker's
        // lifetime. TEXMFDIST already points at it: texmf_local entries
        // starting with "/" map to the FS root (see constructor).
        await this.install_extra_tree(FS, PATH);

        const source_name = main_tex_path.slice(1 + main_tex_path.lastIndexOf('/'));
        const tex_path = source_name;
        // PATCH 8: TeX's jobname strips only the file's FINAL extension
        // (a.text.tex -> a.text, MAIN.TEX -> MAIN). The old
        // .replace('.tex', ext) hit the FIRST occurrence anywhere in the
        // name, so a.text.tex became a.pdf.t.tex — paths TeX never writes.
        const base = source_name.toLowerCase().endsWith('.tex')
            ? source_name.slice(0, -4)
            : source_name;
        const [xdv_path, pdf_path, log_path, aux_path] = ['.xdv', '.pdf', '.log', '.aux'].map(ext => base + ext);
        // PATCH 4: -synctex=1 makes xetex write <job>.synctex.gz, which
        // maps source lines to PDF positions (and back) for the page's
        // PDF<->editor navigation. Read back below.
        const [synctex_gz_path, synctex_plain_path] = ['.synctex.gz', '.synctex'].map(ext => base + ext);

        const xetex = ['xetex', '--interaction=nonstopmode', '--halt-on-error', '--no-pdf', '--synctex=1', '--fmt', this.fmt_latex, tex_path].concat((this.verbose_args[verbose] || this.verbose_args[BusytexPipeline.VerboseSilent]).xetex);
        const bibtex8 = ['bibtex8', '--8bit', aux_path].concat((this.verbose_args[verbose] || this.verbose_args[BusytexPipeline.VerboseSilent]).bibtex8);
        const xdvipdfmx = ['xdvipdfmx', '-o', pdf_path, xdv_path].concat((this.verbose_args[verbose] || this.verbose_args[BusytexPipeline.VerboseSilent]).xdvipdfmx);

        FS.mount(FS.filesystems.MEMFS, {}, this.project_dir);
        for(const {path, contents} of files.sort((lhs, rhs) => lhs['path'] < rhs['path'] ? -1 : 1))
        {
            const absolute_path = PATH.join2(this.project_dir, path);
            if(contents == null)
                FS.mkdir(absolute_path);
            else
                FS.writeFile(absolute_path, contents);
        }
        
        const dirname = main_tex_path.slice(0, main_tex_path.length - source_name.length) || '.';
        const source_dir = PATH.join2(this.project_dir, dirname);
        FS.chdir(source_dir);

        const mem_header = Uint8Array.from(Module.HEAPU8.slice(0, this.mem_header_size));
        const run = (cmd) => {
            const code = NOCLEANUP_callMain(Module, cmd, this.print);
            Module.HEAPU8.fill(0);
            Module.HEAPU8.set(mem_header);
            Module.setStatus(`EXIT CODE: ${code}`);
            return code;
        };

        // First xetex pass always runs; it writes the .aux that tells us
        // whether *this* document uses a bibtex-managed bibliography.
        let exit_code = run(xetex);

        if(bibtex == null)
            bibtex = files.some(({path, contents}) => contents != null && path.endsWith('.bib'));
        // PATCH 6: only run bibtex when the document actually declared a
        // bibliography (\bibdata in an .aux). A project can hold a .bib —
        // the default refs.bib, or one that came in with a folder upload —
        // while the document being compiled never cites it; running bibtex
        // then fatals ("no \bibdata") and kills a build that should succeed.
        // \include writes the included file's \bibdata to <name>.aux (the
        // main .aux only \@input's it), so every .aux under the source
        // dir is scanned, not just the main one.
        let bibtex_needed = false;
        if(exit_code == 0 && bibtex)
        {
            const aux_files = [];
            (function walk(dir)
            {
                let names = [];
                try { names = FS.readdir(dir); } catch (e) { return; }
                for(const n of names)
                {
                    if(n === '.' || n === '..') continue;
                    const p = dir + (dir.endsWith('/') ? '' : '/') + n;
                    const st = FS.lstat(p);
                    // Emscripten stat structs carry the POSIX mode number
                    // (no Stats.isDirectory()); 0o170000 is the file-type mask.
                    if((st.mode & 0o170000) === 0o040000) walk(p);
                    else if(n.endsWith('.aux')) aux_files.push(p);
                }
            })(FS.cwd());
            bibtex_needed = aux_files.some(p => /\\bibdata\b/.test(FS.readFile(p, {encoding : 'utf8'})));
        }
        // PATCH 5: a second xetex pass (also without bibtex) so \ref/\label
        // (incl. \subref from subcaption) resolve from the first pass's .aux.
        // Upstream ran xetex only once in that case — every cross-reference
        // printed ?? and stayed that way.
        // PATCH 7: bibtex8's own output — its error messages ("I couldn't
        // open database file", "I didn't find a database") never reach
        // xetex's .log, so a failed bibtex build used to report the
        // (successful) first xetex pass as the log.
        let bibtex_log = '';
        let bibtex_failed = false;
        const rest = bibtex_needed ? [bibtex8, xetex, xetex, xdvipdfmx] : [xetex, xetex, xdvipdfmx];
        if(exit_code == 0)
        {
            for(const cmd of rest)
            {
                const is_bibtex = cmd[0] === 'bibtex8';
                let saved_print = null;
                if(is_bibtex)
                {
                    bibtex_log = '';
                    saved_print = this.print;
                    this.print = (line) => { bibtex_log += line + '\n'; saved_print(line); };
                }
                exit_code = run(cmd);
                if(is_bibtex)
                {
                    // PATCH 3: bibtex8 exits 1 on warnings (missing fields
                    // etc.) while still writing a usable .bbl — only a real
                    // error (2) should abort the build. Upstream broke on
                    // any non-zero code, which turned every bibtex warning
                    // into a failed compile with no PDF.
                    bibtex_failed = exit_code != 0 && exit_code != 1;
                    this.print = saved_print;
                }
                if(exit_code != 0 && !(is_bibtex && exit_code == 1))
                    break;
            }
        }

        const pdf = exit_code == 0 && FS.analyzePath(pdf_path).exists ? FS.readFile(pdf_path, {encoding : 'binary'}) : null;
        let log = FS.analyzePath(log_path).exists ? FS.readFile(log_path, {encoding : 'utf8'}) : null;
        if(log != null && bibtex_failed)
            log += '\n--- bibtex8 ---\n' + bibtex_log;
        // TeX writes the synctex file gzipped when built with zlib; the
        // plain fallback covers builds without it.
        const synctex = FS.analyzePath(synctex_gz_path).exists
            ? FS.readFile(synctex_gz_path, {encoding : 'binary'})
            : (FS.analyzePath(synctex_plain_path).exists ? FS.readFile(synctex_plain_path, {encoding : 'binary'}) : null);

        FS.unmount(this.project_dir);
        if(!this.preload)
            this.Module = null;

        return {pdf : pdf, log : log, synctex : synctex};
    }
}

// ---------------------------------------------------------------------------
// Patch list (vs. upstream b16fdf28):
//   1. locateFile() maps <package>.js -> <package>.data so the 72 MB
//      texlive data package is fetched from the same (proxied) URL.
//   2. ScriptLoaderWorker uses importScripts() so the worker stays
//      single-threaded (DedicatedWorkerGlobalScope).
//   3. bibtex8 exit code 1 (warnings, .bbl still written) no longer
//      aborts the build; see the loop in compile().
//   4. xetex runs with -synctex=1 and compile() returns the
//      <job>.synctex.gz bytes as `synctex` (null when unavailable),
//      for PDF<->source navigation in the page.
//   5. A second xetex pass runs even without bibtex, so cross-references
//      resolve; see the cmds line in compile().
//   6. bibtex8 runs only when an .aux under the source dir declares a
//      bibliography (\bibdata — \include files write their own .aux),
//      so a .bib in the project that the document never cites no longer
//      fatals the build; see compile().
//   7. bibtex8's own output is captured and appended to the returned log
//      when bibtex8 fails (exit code 2) — its errors never reach xetex's
//      .log, so a failed bibtex build used to report xetex's success text.
//   8. Output paths derive from TeX's jobname (the file name minus its
//      FINAL .tex extension, case-insensitive) instead of the first .tex
//      occurrence, so a.text.tex and MAIN.TEX compile; see compile().
