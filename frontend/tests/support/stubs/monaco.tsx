// A stand-in for @monaco-editor/react: a textarea backed by Monaco-shaped
// models. It keeps what matters for the page's logic — models keyed by path
// that survive until disposed, an editor with a cursor/selection, executeEdits,
// reveal/decoration calls — without any of Monaco itself.
import { useEffect, useReducer, useRef } from "react";

export type Pos = { lineNumber: number; column: number };

export class FakeModel {
  readonly uri: { path: string };
  disposed = false;
  constructor(
    readonly path: string,
    public value: string,
  ) {
    this.uri = { path };
  }
  getValue() {
    return this.value;
  }
  getLineCount() {
    return this.value.split("\n").length;
  }
  getLineContent(l: number) {
    return this.value.split("\n")[l - 1] ?? "";
  }
  getLineMaxColumn(l: number) {
    return this.getLineContent(l).length + 1;
  }
  offsetAt(line: number, col: number) {
    const lines = this.value.split("\n");
    let off = 0;
    for (let i = 0; i < line - 1; i++) off += (lines[i]?.length ?? 0) + 1;
    return off + col - 1;
  }
  getValueInRange(r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) {
    return this.value.slice(this.offsetAt(r.startLineNumber, r.startColumn), this.offsetAt(r.endLineNumber, r.endColumn));
  }
  dispose() {
    this.disposed = true;
    monacoState.models.delete(this.path);
  }
}

export class FakeSelection {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
  isEmpty() {
    return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
  }
}

type Edit = { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string };

export const monacoState = {
  models: new Map<string, FakeModel>(),
  currentPath: null as string | null,
  position: { lineNumber: 1, column: 1 } as Pos,
  selection: new FakeSelection(1, 1, 1, 1),
  visibleTop: 1,
  mounts: 0,
  reveals: [] as number[],
  positions: [] as Pos[],
  decorations: [] as unknown[][],
  undoStops: 0,
  focused: 0,
  scrollListener: null as ((e: { scrollTopChanged: boolean }) => void) | null,
  commands: [] as { keybinding: number; handler: () => void }[],
  onChange: null as ((v: string) => void) | null,
  rerender: null as (() => void) | null,
  reset() {
    this.models = new Map();
    this.currentPath = null;
    this.position = { lineNumber: 1, column: 1 };
    this.selection = new FakeSelection(1, 1, 1, 1);
    this.visibleTop = 1;
    this.mounts = 0;
    this.reveals = [];
    this.positions = [];
    this.decorations = [];
    this.undoStops = 0;
    this.focused = 0;
    this.scrollListener = null;
    this.commands = [];
    this.onChange = null;
    this.rerender = null;
  },
  model(): FakeModel | null {
    return this.currentPath ? (this.models.get(this.currentPath) ?? null) : null;
  },
  /** Type into the active model as the user would (fires the page's onChange). */
  type(value: string) {
    const m = this.model();
    if (!m) throw new Error("no active model");
    m.value = value;
    this.onChange?.(value);
    this.rerender?.();
  },
};

const fakeMonaco = {
  editor: {
    getModels: () => [...monacoState.models.values()],
    defineTheme: () => {},
  },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { Enter: 3 },
  Selection: FakeSelection,
  Range: FakeSelection,
};

const fakeEditor = {
  getModel: () => monacoState.model(),
  getSelection: () => monacoState.selection,
  getPosition: () => monacoState.position,
  setPosition: (p: Pos) => {
    monacoState.position = p;
    monacoState.positions.push(p);
  },
  setSelection: (s: FakeSelection) => {
    monacoState.selection = new FakeSelection(
      s.startLineNumber,
      s.startColumn,
      s.endLineNumber,
      s.endColumn === Infinity ? (monacoState.model()?.getLineMaxColumn(s.endLineNumber) ?? 1) : s.endColumn,
    );
  },
  revealLineInCenter: (l: number) => {
    monacoState.reveals.push(l);
  },
  deltaDecorations: (prev: string[], next: unknown[]) => {
    monacoState.decorations.push(next);
    return next.map((_, i) => `d${i}`);
  },
  addCommand: (keybinding: number, handler: () => void) => {
    monacoState.commands.push({ keybinding, handler });
  },
  onDidScrollChange: (cb: (e: { scrollTopChanged: boolean }) => void) => {
    monacoState.scrollListener = cb;
  },
  getVisibleRanges: () => [{ startLineNumber: monacoState.visibleTop }],
  executeEdits: (_src: string, edits: Edit[]) => {
    const m = monacoState.model();
    if (!m) return;
    let v = m.value;
    // apply bottom-up so earlier offsets stay valid
    const sorted = [...edits].sort(
      (a, b) => m.offsetAt(b.range.startLineNumber, b.range.startColumn) - m.offsetAt(a.range.startLineNumber, a.range.startColumn),
    );
    for (const e of sorted) {
      const s = m.offsetAt(e.range.startLineNumber, e.range.startColumn);
      const en = m.offsetAt(e.range.endLineNumber, e.range.endColumn);
      v = v.slice(0, s) + e.text + v.slice(en);
    }
    monacoState.type(v);
  },
  pushUndoStop: () => {
    monacoState.undoStops++;
  },
  focus: () => {
    monacoState.focused++;
  },
};

type Props = {
  path: string;
  value: string;
  onChange?: (v: string | undefined) => void;
  onMount?: (e: unknown, m: unknown) => void;
  beforeMount?: (m: unknown) => void;
};

export default function FakeMonaco({ path, value, onChange, onMount, beforeMount }: Props) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const prevPath = useRef(path);
  const mounted = useRef(false);

  let model = monacoState.models.get(path);
  if (!model) {
    model = new FakeModel(path, value);
    monacoState.models.set(path, model);
  }
  monacoState.currentPath = path;
  monacoState.onChange = (v) => onChange?.(v);
  monacoState.rerender = force;

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    monacoState.mounts++;
    beforeMount?.(fakeMonaco);
    onMount?.(fakeEditor, fakeMonaco);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A changed `value` prop (accepted apply_edit, …) is pushed into the model —
  // but not on a path switch: an existing model for the new path keeps its own
  // content until it is disposed, like the real wrapper's per-path models.
  useEffect(() => {
    const switched = prevPath.current !== path;
    prevPath.current = path;
    const m = monacoState.models.get(path);
    if (!switched && m && m.value !== value) {
      m.value = value;
      force();
    }
  }, [path, value]);

  return (
    <textarea
      data-testid="monaco"
      data-path={path}
      value={model.value}
      onChange={(e) => {
        model!.value = e.target.value;
        onChange?.(e.target.value);
      }}
    />
  );
}
