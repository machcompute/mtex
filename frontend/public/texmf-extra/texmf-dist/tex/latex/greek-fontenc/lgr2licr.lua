#!/usr/bin/lua

-- LGR Transcription to Greek LICR transformation
-- **********************************************
--
-- :Copyright: © 2010 Günter Milde
-- :Licence:   This work may be distributed and/or modified under the
--             conditions of the `LaTeX Project Public License`_, either
--             version 1.3 of this license or any later version.
--
-- .. _LaTeX Project Public License: http://www.latex-project.org/lppl.txt
--
-- The LGR font encoding is the de-facto standard for Greek typesetting with
-- LaTeX. This file provides a translation from the Latin transliteration defined
-- by LGR into the LaTeX Internal Character Representation (LICR) macros.
--
-- ::

usage = [[
Usage: lua lgr2licr.lua [OPTIONS] [STRING]
  Convert STRING from Latin transliteration to LICR macros for Greek symbols.
  (This dumb conversion fails if the string contains TeX macros.)
  Without argument, the script reads from standard input like a
  redirected file. End interactive input with Ctrl-D.
Options: -h, --help      show this help
         -f, --file      read input from file STRING
]]

if arg[1] == "-h" or arg[1] == "--help" then
    print(usage)
    return
end

-- Get input string::

local s

if arg[1] == "-f" then
    local f = assert(io.open(arg[2], "r"))
    s = f:read("*all")
    f:close()
elseif arg[1] then
    s = table.concat(arg, " ") .. "\n"
else
    -- test:
    -- s = "\\emph{x\\'us}"
    s = io.read("*all")
end

-- The mapping from the LGR Latin transliteration to LICR macros::

LGR_map = {
  A = "\\textAlpha{}",
  B = "\\textBeta{}",
  G = "\\textGamma{}",
  D = "\\textDelta{}",
  E = "\\textEpsilon{}",
  Z = "\\textZeta{}",
  H = "\\textEta{}",
  J = "\\textTheta{}",
  I = "\\textIota{}",
  K = "\\textKappa{}",
  L = "\\textLambda{}",
  M = "\\textMu{}",
  N = "\\textNu{}",
  X = "\\textXi{}",
  O = "\\textOmicron{}",
  P = "\\textPi{}",
  R = "\\textRho{}",
  S = "\\textSigma{}",
  T = "\\textTau{}",
  U = "\\textUpsilon{}",
  F = "\\textPhi{}",
  Q = "\\textChi{}",
  Y = "\\textPsi{}",
  W = "\\textOmega{}",

  a = "\\textalpha{}",
  b = "\\textbeta{}",
  g = "\\textgamma{}",
  d = "\\textdelta{}",
  e = "\\textepsilon{}",
  z = "\\textzeta{}",
  h = "\\texteta{}",
  j = "\\texttheta{}",
  i = "\\textiota{}",
  k = "\\textkappa{}",
  l = "\\textlambda{}",
  m = "\\textmu{}",
  n = "\\textnu{}",
  x = "\\textxi{}",
  o = "\\textomicron{}",
  p = "\\textpi{}",
  r = "\\textrho{}",
  s = "\\textautosigma{}",
  c = "\\textfinalsigma{}",
  t = "\\texttau{}",
  u = "\\textupsilon{}",
  f = "\\textphi{}",
  q = "\\textchi{}",
  y = "\\textpsi{}",
  w = "\\textomega{}",
  v = "\\noboundary{}",

  ["'"] = "\\'",
  ["`"] = "\\`",
  ["~"] = "\\~",
  ["<"] = "\\<",
  [">"] = "\\>",
  ["|"] = "\\|",
  ['"'] = '\\"',
  [";"] = "\\textanoteleia{}",
  ["?"] = "\\texterotimatiko{}",
}

-- Return substitution string for 3 captures:
--
-- `c1` backslash
-- `c2` a-zA-Z
-- `c3` any other char
-- ::

function lgr_replace(c1, c2, c3)
    -- print (c1, c2, c3)
    if c1 == "\\" then
        if c2 and (c2 ~= "") then
            return c1 .. c2 .. (LGR_map[c3] or c3 or "")
        end
        return c1 .. c3
    end
    c2 = string.gsub(c2, "s(.)", "sv%1")
    return (string.gsub(c2, ".", LGR_map) or "") .. (LGR_map[c3] or c3 or "")
end

-- Use the mapping to replace every ASCII-character with
-- non-standard meaning to the corresponding LICR macro
-- (skip macros)::
  -- *([a-zA-Z'`~<>|\";?]
s = string.gsub(s, "(\\?)([a-zA-Z]*)([^\\]?)", lgr_replace)

-- Ligatures::

s = string.gsub(s, "%(%(", "\\guillemetleft{}")
s = string.gsub(s, "%)%)", "\\guillemetright{}")
s = string.gsub(s, "\\'\\'", "\\textquoteright{}")               -- ''
s = string.gsub(s, "\\`\\`", "\\textquoteleft{}")                -- ``
s = string.gsub(s, '\"(%s)', "\\textquoteright{}%1")

-- Separating empty group "{}" only required if followed by space or ASCII::

s = string.gsub(s, "{}([^ a-zA-Z])", "%1")

-- Autosigma replacements::

s = string.gsub(s, "\\textautosigma\\noboundary", "\\textsigma")  -- sv
s = string.gsub(s, "\\textautosigma(\\['`~<>|\"])", "\\textsigma%1") -- accents

s = string.gsub(s, "\\textautosigma([-%s!#$%%&%(%)*+,./0-9:=%[%]{|}])",
                   "\\textfinalsigma%1")

s = string.gsub(s, "\\textautosigma(\\textquote)", "\\textfinalsigma%1")
s = string.gsub(s, "\\textautosigma(\\texterotimatiko)", "\\textfinalsigma%1")
s = string.gsub(s, "\\textautosigma(\\textanoteleia)", "\\textfinalsigma%1")

s = string.gsub(s, "\\textautosigma$", "\\textfinalsigma")

-- Write the result to stdout::

io.write(s)
