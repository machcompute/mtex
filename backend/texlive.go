package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

const texliveAssetType = "application/octet-stream"

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
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/api/texlive/")
	src, ok := texliveAssets[name]
	if !ok {
		http.Error(w, "unknown texlive asset", http.StatusNotFound)
		return
	}

	cacheDir := texliveCacheDir()
	cachePath := filepath.Join(cacheDir, name)
	if _, err := os.Stat(cachePath); err == nil {
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

	w.Header().Set("Content-Type", texliveAssetType)
	if resp.ContentLength > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", resp.ContentLength))
	}
	log.Printf("texlive: downloading %s (%d bytes) to %s", name, resp.ContentLength, cachePath)

	f, err := os.Create(cachePath + ".part")
	if err != nil {
		http.Error(w, "internal error: cannot create cache file", http.StatusInternalServerError)
		return
	}

	_, err = io.Copy(io.MultiWriter(w, f), resp.Body)
	cerr := f.Close()
	if err != nil {
		os.Remove(cachePath + ".part")
		log.Printf("texlive: download of %s failed: %v", name, err)
		return
	}
	if cerr != nil {
		os.Remove(cachePath + ".part")
		log.Printf("texlive: write of %s failed: %v", name, cerr)
		return
	}
	if err := os.Rename(cachePath+".part", cachePath); err != nil {
		log.Printf("texlive: rename of %s failed: %v", name, err)
		return
	}
	log.Printf("texlive: cached %s", cachePath)
}
