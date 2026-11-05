"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useState, type ComponentProps } from "react";

type Props = ComponentProps<typeof Editor>;

/**
 * Thin re-mounting wrapper around `@monaco-editor/react`'s `Editor`.
 *
 * Why this exists: with `cacheComponents: true`, Next 16 keeps this route
 * alive across navigation using React's `<Activity>`. Leaving `/editor`
 * *hides* the subtree — React runs every effect's cleanup, and the Monaco
 * wrapper uses that to dispose its editor + model. Returning *re-shows* the
 * SAME component instance (state, refs and DOM are preserved), so React
 * reconnects the effects. The wrapper's "create the editor" step is one-shot,
 * but its `path` effect is not — it runs again on reconnect and calls
 * `setModel()` on the editor that the hide-cleanup just disposed, throwing
 * "InstantiationService has been disposed" and taking the whole page down.
 *
 * The wrapper (4.7.0, and 4.8.0-rc.3 which ships the identical logic) has no
 * prop that makes it recreate the editor on reconnect. The fix is to force a
 * real remount: bump a key every time the subtree is hidden, so that on the
 * next show React mounts a brand-new `Editor` (fresh `editor.create`) instead
 * of reconnecting against a dead one. The key is bumped in the effect
 * cleanup, which is exactly when `<Activity>` hides the route.
 */
export default function MonacoEditor(props: Props) {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    // Runs on unmount AND on every Activity hide (route left). Bumping the
    // key here means the `<Editor>` underneath is remounted before the route
    // is shown again, so it always mounts fresh.
    return () => setGeneration((g) => g + 1);
  }, []);

  return <Editor key={generation} {...props} />;
}
