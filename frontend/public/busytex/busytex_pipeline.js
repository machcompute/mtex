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

        const source_name = main_tex_path.slice(1 + main_tex_path.lastIndexOf('/'));
        const tex_path = source_name;
        const [xdv_path, pdf_path, log_path, aux_path] = ['.xdv', '.pdf', '.log', '.aux'].map(ext => tex_path.replace('.tex', ext));
        // PATCH 4: -synctex=1 makes xetex write <job>.synctex.gz, which
        // maps source lines to PDF positions (and back) for the page's
        // PDF<->editor navigation. Read back below.
        const [synctex_gz_path, synctex_plain_path] = ['.synctex.gz', '.synctex'].map(ext => tex_path.replace('.tex', ext));

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
       
        if(bibtex == null)
            bibtex = files.some(({path, contents}) => contents != null && path.endsWith('.bib'));
        // PATCH 5: a second xetex pass also without bibtex, so \ref/\label
        // (incl. \subref from subcaption) resolve from the first pass's .aux.
        // Upstream ran xetex only once in that case — every cross-reference
        // printed ?? and stayed that way.
        const cmds = bibtex ? [xetex, bibtex8, xetex, xetex, xdvipdfmx] : [xetex, xetex, xdvipdfmx];
        
        let exit_code = 0;
        const mem_header = Uint8Array.from(Module.HEAPU8.slice(0, this.mem_header_size));
        for(const cmd of cmds)
        {
            exit_code = NOCLEANUP_callMain(Module, cmd, this.print);
            Module.HEAPU8.fill(0);
            Module.HEAPU8.set(mem_header);

            Module.setStatus(`EXIT CODE: ${exit_code}`);
            // PATCH 3: bibtex8 exits 1 on warnings (missing fields etc.)
            // while still writing a usable .bbl — only a real error (2)
            // should abort the build. Upstream broke on any non-zero
            // code, which turned every bibtex warning into a failed
            // compile with no PDF.
            const is_bibtex = cmd[0] === 'bibtex8';
            if(exit_code != 0 && !(is_bibtex && exit_code == 1))
                break;
        }

        const pdf = exit_code == 0 && FS.analyzePath(pdf_path).exists ? FS.readFile(pdf_path, {encoding: 'binary'}) : null;
        const log = FS.analyzePath(log_path).exists ? FS.readFile(log_path, {encoding : 'utf8'}) : null;
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
