# Portable scene files

Use Excalidraw's exported scene envelope:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

The [verified flow template](flow-template.excalidraw) opens in stock Excalidraw and contains two shapes, bound labels and an arrow. Copy and adapt its elements/colors when creating a small flow; retain reciprocal bindings.

Elements need stable unique IDs, ordinary Excalidraw geometry/style fields and reciprocal bindings. Prefer an exported stock-editor element as a template rather than guessing a schema. Bound text references its shape through `containerId`; the shape references the text in `boundElements`. Arrow bindings must reference existing shape IDs, with corresponding arrow entries on each shape. Preserve these when moving or updating elements. `files` holds embedded image data referenced by image elements; preserve it even if the requested edit concerns only text.

Official format and API references: [JSON export](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export), [element helpers](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/element).

## Exclusive creation using Node

For the fixed `diagrams/` location, this pattern allows a symlinked vault root but rejects a symlinked notes/diagrams directory. Supply the helper's `notesRoot`, a basename such as `auth-flow.excalidraw`, and serialized scene JSON. Use a different basename on collision. The scene content must be generated and validated before writing.

```js
import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

async function createScene(notesRoot, name, sceneText) {
  if (basename(name) !== name || !/^[a-z0-9][a-z0-9-]*\.excalidraw$/.test(name)) {
    throw new Error("Use a simple scene basename");
  }
  await mkdir(notesRoot, { recursive: true });
  if ((await lstat(notesRoot)).isSymbolicLink()) throw new Error("Symlinked notes directory");
  const canonicalNotes = await realpath(notesRoot);
  const directory = join(canonicalNotes, "diagrams");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("Symlinked diagram directory");
  }
  const path = join(directory, name);
  await writeFile(path, sceneText, { flag: "wx", mode: 0o600 });
  return path;
}
```

This avoids routine overwrites and symlink escapes in a local authoring workflow. It does not provide a filesystem sandbox against another process replacing directories during the write; don't run authoring against an untrusted concurrently mutated filesystem.

References evaluated for this workflow: [robtaylor's MIT file-based generator](https://github.com/robtaylor/excalidraw-diagrams), [coleam00's palette and render-review workflow](https://github.com/coleam00/excalidraw-diagram-skill). This skill uses original guidance; it does not vendor upstream code or require their runtimes.
