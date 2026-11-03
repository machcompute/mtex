/**
 * The starter project: the first-run default and the body of every "New
 * project". A two-file bibtex example, so multi-file compilation and bibtex8
 * (the pipeline auto-runs it whenever a .bib is present) work out of the box.
 * Shared by the editor and the dashboard so the two never drift apart.
 */

export const DEFAULT_MAIN = "main.tex";
export const DEFAULT_PROJECT_NAME = "LaTeX project";

export const DEFAULT_FILES: Record<string, string> = {
  [DEFAULT_MAIN]: `\\documentclass{article}
\\usepackage{amsmath}

\\title{HomeHub LaTeX}
\\author{You}
\\date{\\today}

\\begin{document}
\\maketitle

Hello from a \\textbf{full TeX Live} running in your browser.
Citations are resolved by bibtex8: Euler's classic
\\cite{euler1748} and Knuth's \\cite{knuth1984}.

\\begin{equation}
  e^{i\\pi} + 1 = 0
\\end{equation}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
  "refs.bib": `@article{euler1748,
  author  = {Euler, Leonhard},
  title   = {Introductio in analysin infinitorum},
  journal = {Genevae},
  year    = {1748},
}

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
`,
};

/** "LaTeX project", "LaTeX project 2", … — the first one not taken. */
export function nextProjectName(taken: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? DEFAULT_PROJECT_NAME : `${DEFAULT_PROJECT_NAME} ${i}`;
    if (!taken.includes(name)) return name;
  }
  return `${DEFAULT_PROJECT_NAME} ${Date.now()}`;
}
