package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// texliveAssets are served to the browser from the pinned busytex WASM release
// (full TeX Live compiled to WebAssembly). They are cached on first request
// under the cache directory, then served locally.
var texliveAssets = map[string]string{
	"busytex.js":         "https://github.com/busytex/busytex/releases/download/build_b16fdf28019d93ccfd8f09776e4191835acea5dc/busytex.js",
	"busytex.wasm":       "https://github.com/busytex/busytex/releases/download/build_b16fdf28019d93ccfd8f09776e4191835acea5dc/busytex.wasm",
	"texlive-basic.js":   "https://github.com/busytex/busytex/releases/download/build_b16fdf28019d93ccfd8f09776e4191835acea5dc/texlive-basic.js",
	"texlive-basic.data": "https://github.com/busytex/busytex/releases/download/build_b16fdf28019d93ccfd8f09776e4191835acea5dc/texlive-basic.data",
}

// texliveAssetType maps an asset to the Content-Type the browser needs.
// The types matter: the worker loads the .js files with importScripts(),
// which refuses non-JavaScript types, and the .wasm must be
// application/wasm for streaming compilation.
func texliveAssetType(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return "text/javascript"
	case strings.HasSuffix(name, ".wasm"):
		return "application/wasm"
	default:
		return "application/octet-stream"
	}
}

// One lock per asset: the first request downloads while everyone else waits
// for that download to finish, then serves the cache. Without this,
// concurrent first downloads would race on the same temp file.
var (
	texliveDownloadLocks   = map[string]*sync.Mutex{}
	texliveDownloadLocksMu sync.Mutex
)

func texliveDownloadLock(name string) *sync.Mutex {
	texliveDownloadLocksMu.Lock()
	defer texliveDownloadLocksMu.Unlock()
	mu, ok := texliveDownloadLocks[name]
	if !ok {
		mu = &sync.Mutex{}
		texliveDownloadLocks[name] = mu
	}
	return mu
}

func texliveCacheDir() string {
	if dir := os.Getenv("TEXLIVE_CACHE_DIR"); dir != "" {
		return dir
	}
	return "texlive-cache"
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
}

func handleTexlive(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/api/texlive/")
	src, ok := texliveAssets[name]
	if !ok {
		log.Printf("texlive: unknown asset %q", name)
		http.Error(w, "unknown texlive asset", http.StatusNotFound)
		return
	}

	cacheDir := texliveCacheDir()
	cachePath := filepath.Join(cacheDir, name)
	if info, err := os.Stat(cachePath); err == nil {
		log.Printf("texlive: serving %s (%d bytes, cached)", name, info.Size())
		http.ServeFile(w, r, cachePath)
		return
	}

	mu := texliveDownloadLock(name)
	mu.Lock()
	defer mu.Unlock()

	// A concurrent request may have finished the download while we waited.
	if info, err := os.Stat(cachePath); err == nil {
		log.Printf("texlive: serving %s (%d bytes, cached)", name, info.Size())
		http.ServeFile(w, r, cachePath)
		return
	}

	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		http.Error(w, "internal error: cannot create cache dir", http.StatusInternalServerError)
		return
	}

	// Download from the release, streaming to both the cache file and the client.
	resp, err := http.Get(src)
	if err != nil {
		http.Error(w, "upstream fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("upstream returned %s", resp.Status), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", texliveAssetType(name))
	if resp.ContentLength > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", resp.ContentLength))
	}
	log.Printf("texlive: downloading %s (%d bytes) to %s", name, resp.ContentLength, cachePath)

	// A unique temp file per downloader: a shared ".part" name would be
	// truncated by a concurrent os.Create and could corrupt the cache
	// permanently.
	f, err := os.CreateTemp(cacheDir, name+".part-*")
	if err != nil {
		http.Error(w, "internal error: cannot create cache file", http.StatusInternalServerError)
		return
	}
	partPath := f.Name()

	_, err = io.Copy(io.MultiWriter(w, f), resp.Body)
	cerr := f.Close()
	if err != nil {
		os.Remove(partPath)
		log.Printf("texlive: download of %s failed: %v", name, err)
		return
	}
	if cerr != nil {
		os.Remove(partPath)
		log.Printf("texlive: write of %s failed: %v", name, cerr)
		return
	}
	if err := os.Rename(partPath, cachePath); err != nil {
		os.Remove(partPath)
		log.Printf("texlive: rename of %s failed: %v", name, err)
		return
	}
	log.Printf("texlive: cached %s", cachePath)
}
