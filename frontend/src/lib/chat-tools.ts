// The seven tools the assistant can call on the project (OpenAI function
// format). The page executes them against in-memory state; the model only
// ever sees the results. `apply_edit` is gated on the user's accept.
export const CHAT_TOOLS: Array<{
  type: "function";
  function: { name: string; description: string; parameters: object };
}> = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List all files in the current project (path and whether each is binary), and which file is the main file.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text content of one file in the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. main.tex" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compile",
      description:
        "Compile the project with XeLaTeX and wait for the build to finish. Returns the outcome (success/failure) and a tail of the build log.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_build_log",
      description: "Return the log of the last completed build.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_edit",
      description:
        "Replace one exact occurrence of `old` in a project file with `new`. The user must accept the change in the UI; the result reports whether it was accepted. `old` must occur exactly once in the file — if it does not, the result is an error and you should read_file and retry with the exact text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. main.tex" },
          old: {
            type: "string",
            description:
              "The exact existing text to replace (must occur exactly once)",
          },
          new: { type: "string", description: "The replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_package",
      description:
        "Install a LaTeX package (plus its dependencies) from CTAN into the browser's package store. The engine restarts and the package is available on the next compile.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The tlpkg package name, e.g. tikz or biblatex",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_packages",
      description:
        "Search CTAN for LaTeX packages by name or description. Returns matches with a one-line description and whether each is already installed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text, e.g. \"tikz\" or \"bibliography\"",
          },
        },
        required: ["query"],
      },
    },
  },
];
