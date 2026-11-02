#!/bin/sh
# sync-texlive.sh — pull LaTeX packages from the LOCAL TeX Live install into
# the app's vendored tree (public/texmf-extra/), which the in-browser engine
# adds to TEXMFDIST (see src/lib/busytex.ts and the PATCH 9 comment in
# public/busytex/busytex_pipeline.js).
#
# A package is pulled as its WHOLE directory: the .sty plus every sibling
# file it needs to actually load (config files, .def colour models, font
# definitions — xcolor without rgb.def, fontspec without its .cfg/.fd, is
# just a file TeX cannot use). Two packages span two TDS roots and are
# pulled as both roots: xkeyval (the .sty does \input xkeyval, which is
# tex/generic/xkeyval/xkeyval.tex) and pgf (which is what provides tikz;
# requesting "tikz" pulls the same pgf tree).
#
# Pinned overrides (scripts/texlive-overrides/<name>/): the in-worker
# engine is TeX Live 2021 (LaTeX2e 2020-10-01, L3 2020-10-27). Packages
# from a newer local TeX Live may require a newer kernel (siunitx 3.x
# dies with "LaTeX kernel too old"), so a kernel-compatible version can
# be pinned here. An override replaces the pulled directory wholesale.
#
# Math fonts: the wasm engine ships only the core Computer Modern metric
# (TFM) and Type1 (PFB) fonts, so \mathscr (rsfs), wasysym's extra
# symbols, stmaryrd and \mathbb double-stroke letters (dsfont) die with
# "Metric (TFM) file or installed font not found". FONT_DIRS names LOCAL
# font directories (fonts/tfm/public/<d> and fonts/type1/public/<d>)
# whose *.tfm and *.pfb files are pulled into the tree. Font directory
# names do NOT match package names (mathrsfs -> rsfs, wasysym -> wasy +
# wasy-type1, dsfont -> doublestroke), so they are listed separately.
# Pass a font directory name (e.g. rsfs) as an argument to add it.
#
# Usage:
#   sh scripts/sync-texlive.sh                 # pull the default set
#   sh scripts/sync-texlive.sh tikz pgfplots   # default set PLUS named
#                                              # packages (any package that
#                                              # has a <name>.sty) or font
#                                              # dirs (rsfs, wasy, ...)
#   sh scripts/sync-texlive.sh --all           # literally every .sty
#                                              # package: ~100 MB of .sty,
#                                              # ~360 MB with siblings. The
#                                              # engine itself is a 27 MB
#                                              # download; think about it.
#   sh scripts/sync-texlive.sh --list          # list pullable package names
#
# The tree is rebuilt from scratch on every run, then a single
# extra-bundle.json (path -> contents) is generated: the browser fetches
# ONE ~13 MB file instead of thousands of per-package requests (binary
# font files are base64-encoded inside it). Commit the result — the app is
# browser-only and serves the tree from its own public/ directory.

set -eu

cd "$(dirname "$0")/.."   # frontend/

DST="public/texmf-extra/texmf-dist"

# --- default set: the packages the wasm texlive-basic image lacks that
# --- papers actually \usepackage (see the /IfFileExists probe), plus the
# --- packages previously vendored by hand so the rebuild is complete.
#
# NOT included: textgreek. It renders Greek via the LGR encoding, which
# maps to the grmn1000 font — a metric (TFM) font the in-worker XeTeX engine
# cannot load, so any document that \usepackage{textgreek} dies at
# \begin{document} with "Metric (TFM) file or installed font not found".
# (The greek-fontenc + cbfonts-fd packages below still define the LGR
# encoding and its font files, which babel/polyglossia Greek typesetting
# needs; they are the standard LGR support, just not enough for textgreek.)
DEFAULT_PKGS="
appendix
algorithm
algorithm2e
algorithmicx
bigfoot
booktabs
caption
cbfonts-fd
cite
cleveref
datatool
dsfont
endnotes
enumitem
etoolbox
fancyvrb
float
fontspec
footmisc
fp
glossaries
greek-fontenc
ifoddpage
lastpage
listings
makecmds
marginnote
mathtools
mathrsfs
mfirstuc
microtype
multirow
physics
placeins
pgf
polyglossia
relsize
setspace
siunitx
stmaryrd
substr
subfigure
textcase
threeparttable
titlesec
tracklang
todonotes
units
wasysym
wrapfig
xcolor
xfor
xkeyval
xspace
xurl
"

usage() {
    sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# --- locate the local TeX Live (before arg parsing: font-dir arguments
# --- are detected against the local tree) --------------------------------
TEXMFDIST="$(kpsewhich --var-value TEXMFDIST 2>/dev/null || true)"
if [ -z "$TEXMFDIST" ] || [ ! -d "$TEXMFDIST/tex/latex" ]; then
    for cand in /usr/share/texlive/texmf-dist \
                /usr/local/texlive/*/texmf-dist \
                /opt/texlive/texmf-dist; do
        if [ -d "$cand/tex/latex" ]; then TEXMFDIST="$cand"; break; fi
    done
fi
if [ -z "$TEXMFDIST" ] || [ ! -d "$TEXMFDIST/tex/latex" ]; then
    echo "error: no local TeX Live found (kpsewhich --var-value TEXMFDIST)" >&2
    exit 1
fi
echo "using TeX Live: $TEXMFDIST"

SRC_DIRS="$TEXMFDIST/tex/latex $TEXMFDIST/tex/generic"

# --- default math fonts (see the header comment) -------------------------
DEFAULT_FONTS="
doublestroke
rsfs
stmaryrd
wasy
wasy-type1
"

PKGS="$DEFAULT_PKGS"
FONTS="$DEFAULT_FONTS"
ALL=0
LIST=0
for arg in "$@"; do
    case "$arg" in
    --all) ALL=1 ;;
    --list) LIST=1 ;;
    -h|--help) usage 0 ;;
    *)
        # A name matching a local font dir is a font, not a package
        # (font dir names like "rsfs" have no .sty).
        if [ -d "$TEXMFDIST/fonts/tfm/public/$arg" ] || [ -d "$TEXMFDIST/fonts/type1/public/$arg" ]; then
            FONTS="$FONTS
$arg"
        else
            PKGS="$PKGS
$arg"
        fi
        ;;
    esac
done

if [ "$LIST" = 1 ]; then
    find $SRC_DIRS -type f -name '*.sty' 2>/dev/null \
        | while IFS= read -r f; do basename "$f" .sty; done | sort -u
    exit 0
fi

# --- collect the source directories to copy ------------------------------
# A package name resolves to the directory(ies) holding <name>.sty. With
# --all, every directory that contains at least one .sty.
TMP_DIRS="$(mktemp)"
trap 'rm -f "$TMP_DIRS"' EXIT
: > "$TMP_DIRS"

if [ "$ALL" = 1 ]; then
    find $SRC_DIRS -type f -name '*.sty' 2>/dev/null \
        | while IFS= read -r f; do dirname "$f"; done | sort -u > "$TMP_DIRS"
else
    # Add a TDS root to the pull list (whole directory).
    pull_root() {
        if [ -d "$TEXMFDIST/$1" ]; then
            echo "$TEXMFDIST/$1" >> "$TMP_DIRS"
        else
            echo "warning: $TEXMFDIST/$1 not found (skipped)" >&2
        fi
    }
    for p in $PKGS; do
        if [ "$p" = "tikz" ]; then
            # tikz ships INSIDE the pgf package; pull the pgf roots.
            p=pgf
        fi
        if [ -d "$TEXMFDIST/tex/latex/$p" ]; then
            # Pull the whole package root — the entry .sty may sit in a
            # sub-directory (glossaries/base/, pgf/basiclayer/), and the
            # root is where the package's siblings live. Also pull the
            # engine-independent sibling root tex/generic/<p> when present
            # (xkeyval, tracklang: the .sty does \input <p>, which lives in
            # tex/generic/<p>).
            pull_root "tex/latex/$p"
            [ -d "$TEXMFDIST/tex/generic/$p" ] && pull_root "tex/generic/$p"
        else
            # No root directory: the .sty lives inside another package's
            # directory (perpage.sty inside bigfoot/, algcompatible.sty
            # inside algorithm/); pull that directory.
            find $SRC_DIRS -type f -name "$p.sty" 2>/dev/null \
                | while IFS= read -r f; do dirname "$f"; done | sort -u >> "$TMP_DIRS"
            if ! find $SRC_DIRS -type f -name "$p.sty" 2>/dev/null | grep -q .; then
                echo "warning: package '$p' not found in $TEXMFDIST (skipped)" >&2
            fi
        fi
    done
    sort -u -o "$TMP_DIRS" "$TMP_DIRS"
fi
n_pkgs=$(wc -l < "$TMP_DIRS")
echo "pulling $n_pkgs package directory(ies) ..."

# --- rebuild the tree -----------------------------------------------------
rm -rf "$DST"
while IFS= read -r src; do
    rel="${src#"$TEXMFDIST"/}"
    mkdir -p "$DST/$rel"
    cp -a "$src/." "$DST/$rel/"
done < "$TMP_DIRS"

# --- apply pinned overrides (see the header comment) ----------------------
OVERRIDES_DIR="scripts/texlive-overrides"
if [ -d "$OVERRIDES_DIR" ]; then
    for d in "$OVERRIDES_DIR"/*/; do
        name="$(basename "$d")"
        # Resolve the package root the same way the pull does, so the
        # override replaces the WHOLE pulled directory (an override dir
        # holds the root's contents). A package whose entry .sty sits in a
        # sub-directory (glossaries/base/) must still have its whole root
        # replaced, or the old root's siblings (styles/, expl/) would be
        # left in place and mismatch the pinned version.
        if [ -d "$TEXMFDIST/tex/latex/$name" ]; then
            target="$TEXMFDIST/tex/latex/$name"
        else
            target="$(find $SRC_DIRS -type f -name "$name.sty" 2>/dev/null | head -1 | xargs -r dirname)"
        fi
        if [ -n "$target" ] && [ -d "$target" ]; then
            rel="${target#"$TEXMFDIST"/}"
            rm -rf "$DST/$rel"
            cp -a "$d" "$DST/$rel"
            echo "pinned override: $name -> $rel"
        else
            echo "warning: override '$name' does not match a package in $TEXMFDIST (skipped)" >&2
        fi
    done
fi

# --- pull math fonts (see the header comment) -----------------------------
# Font dir names are NOT package names (mathrsfs -> rsfs, wasysym ->
# wasy/wasy-type1, dsfont -> doublestroke), so they are pulled by their TDS
# paths: metrics from fonts/tfm/public/<d>, outlines from
# fonts/type1/public/<d> (PFB only — XeTeX feeds its PDF output straight
# from the PFB and needs no .pfm).
n_fonts=0
for d in $FONTS; do
    for spec in "tfm:tfm" "type1:pfb"; do
        kind="${spec%%:*}"
        ext="${spec#*:}"
        src="$TEXMFDIST/fonts/$kind/public/$d"
        [ -d "$src" ] || continue
        mkdir -p "$DST/fonts/$kind/public/$d"
        if cp -a "$src"/*."$ext" "$DST/fonts/$kind/public/$d/" 2>/dev/null; then
            n_fonts=$((n_fonts+1))
        else
            echo "warning: no .${ext} files in $src (skipped)" >&2
        fi
    done
done
echo "pulled $n_fonts font directory(ies) ..."

# --- generate the single-file bundle --------------------------------------
# The worker fetches this once per engine start and installs the tree into
# its in-memory FS (busytex_pipeline.js PATCH 9). One request instead of
# thousands. Keys are relative to public/texmf-extra (they start with
# "texmf-dist/"), because the pipeline installs them at /texmf-extra and
# TEXMFDIST points at /texmf-extra/texmf-dist.
node - "public/texmf-extra" "public/texmf-extra/extra-bundle.json" <<'EOF'
const fs = require("fs");
const path = require("path");
// `node -` puts "-" in argv[1]; the real args start at argv[2].
const [root, out] = process.argv.slice(2);
// Binary font files (metrics TFM, outlines PFB) are base64-encoded as
// {"b64": "..."} — the worker decodes them to raw bytes, since a UTF-8
// string read would corrupt the font data.
const BINARY = new Set([".tfm", ".pfb", ".otf", ".ttf"]);
const files = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (path.resolve(p) !== path.resolve(out)) {
      const key = path.relative(root, p).split(path.sep).join("/");
      if (BINARY.has(path.extname(e.name).toLowerCase()))
        files[key] = { b64: fs.readFileSync(p).toString("base64") };
      else
        files[key] = fs.readFileSync(p, "utf8");
    }
  }
})(root);
const sorted = {};
for (const k of Object.keys(files).sort()) sorted[k] = files[k];
const json = JSON.stringify({ v: 1, files: sorted });
fs.writeFileSync(out, json);
console.log(
  `bundle: ${Object.keys(files).length} files, ` +
    `${(json.length / 1048576).toFixed(1)} MB -> ${out}`,
);
EOF

tree_mb=$(du -sm "$DST" | cut -f1)
echo "done: $DST (${tree_mb} MB) + public/texmf-extra/extra-bundle.json"
echo "commit the result (the app is browser-only and serves it from public/)."
