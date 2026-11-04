// Vendored copy of the pinned release's biber loader (same provenance as
// the WASM assets in /api/texlive — see the worker header), with one
// patch: run() wrote every input at work_dir/<basename>, FLATTENING
// subdirectory paths. Biber resolves data sources relative to the control
// file, so a .bcf pointing at bib/references.bib needs the .bib at
// <work_dir>/bib/references.bib — a flattened references.bib is never
// found ("ERROR - Cannot find 'bib/references.bib'!"). Inputs are now
// written at their full relative paths, creating subdirectories.

class BusytexBiber {
    constructor(biber_js, biber_wasm, biber_data, print, script_loader) {
        this.biber_js = biber_js;
        this.biber_wasm = biber_wasm;
        this.biber_data = biber_data;
        this.print = print;
        this.script_loader = script_loader;
        this.work_dir = '/home/web_user/biber';
        this.bin_biber = '/opt/perl-wasm/bin/biber';
        this.assets_promise = null;
        this.last_output = '';
    }

    _assets() {
        if (this.assets_promise == null) {
            this.assets_promise = Promise.all([
                this.script_loader(this.biber_js),
                fetch(this.biber_wasm).then(response => {
                    if (!response.ok) throw new Error(`Failed to fetch WASM module: ${this.biber_wasm} (HTTP ${response.status})`);
                    return response.arrayBuffer().then(WebAssembly.compile);
                }),
            ]);
        }
        return this.assets_promise;
    }

    // perl tears down its interpreter on exit, so every run gets a fresh
    // instance; the compiled wasm is reused and the data package comes from
    // the preload cache emscripten maintains.
    async instantiate() {
        const [, wasm_module] = await this._assets();

        const Module = {
            noInitialRun: true,
            locateFile: path => path.endsWith('.wasm') ? this.biber_wasm : path.endsWith('.data') ? this.biber_data : path,
            instantiateWasm(imports, successCallback) {
                WebAssembly.instantiate(wasm_module, imports).then(successCallback).catch(err => { throw new Error('Error while initializing biber!\n\n' + err.toString()) });
                return {};
            },
            print: text => { this.last_output += text + '\n'; this.print(text); },
            printErr: text => { this.last_output += text + '\n'; this.print(text); },
        };

        const moduleFactory = typeof biber !== 'undefined' ? biber : self.biber;
        if (!moduleFactory) throw new Error('No biber module factory found. Ensure biber.js is loaded.');
        return await moduleFactory(Module);
    }

    // Data sources are resolved relative to the control file, so inputs
    // keep their subdirectory structure below the work dir (a .bcf in
    // sub/ looking for bib/x.bib needs sub/bib/x.bib). Returns the .bbl
    // text, or null on failure.
    async run(bcf_path, files, verbose_args = []) {
        this.last_output = '';
        const Module = await this.instantiate();
        const FS = Module.FS;
        const basename = p => p.slice(p.lastIndexOf('/') + 1);

        FS.chdir(this.work_dir);
        for (const { path, contents } of files) {
            const rel = path.replace(/^\/+/, '');
            const dir = rel.slice(0, rel.lastIndexOf('/'));
            if (dir !== '')
                FS.mkdirTree(this.work_dir + '/' + dir);
            FS.writeFile(this.work_dir + '/' + rel, contents);
        }

        const bcf = basename(bcf_path);
        const bbl = bcf.replace(/\.bcf$/, '.bbl');
        const argv = [this.bin_biber, '--output-format=bbl', `--outfile=${bbl}`, '--nolog', ...verbose_args, bcf];

        const cmdline = '$ biber ' + argv.slice(1).join(' ');
        this.last_output += cmdline + '\n';
        this.print(cmdline);

        let exit_code = 0;
        try {
            exit_code = Module.callMain(argv);
        } catch (err) {
            exit_code = typeof err.status == 'number' ? err.status : 1;
        }

        if (exit_code != 0)
            return null;

        const bbl_full = this.work_dir + '/' + bbl;
        return FS.analyzePath(bbl_full).exists ? FS.readFile(bbl_full, { encoding: 'utf8' }) : null;
    }
}

if (typeof self !== 'undefined') self.BusytexBiber = BusytexBiber;
