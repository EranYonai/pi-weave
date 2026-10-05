---
name: weave-excalidraw
description: "Create portable editable Excalidraw diagrams in the Weave vault with searchable companion notes; update existing scenes as reviewable copies. Use when the user requests an Excalidraw architecture sketch, flow, or knowledge diagram."
---

# Weave Excalidraw

Create a normal `.excalidraw` JSON file and a Markdown explanation in the user's persistent vault. Keep the scene editable in stock Excalidraw; a preview alone is insufficient. Persist repository-derived diagrams only when the user requests it; the repository's derived `.okf` index must never hold the only copy.

## Context and palette

Run the packaged helper relative to this skill's directory, with the workspace directory:

```sh
node scripts/diagram-context.mjs --cwd /path/to/workspace
```

It reads validated workspace settings and prints `vaultRoot`, `notesRoot` and semantic colors. It writes nothing and requires only Node. Optional overrides: `--theme paper-blue`, `--accent teal`, `--scheme light|dark`. An explicit theme takes precedence over persisted settings.

`needsScheme: true` means the selected system theme cannot be resolved without the browser's device scheme. Choose a concrete scheme from the user's request or ask which to use; run again with `--scheme`. The helper exposes both configured palettes rather than claiming either is active. `themeSource: default` means no saved workspace settings were found.

Use the returned canvas color in `appState.viewBackgroundColor`; use text/stroke, primary/secondary/accentNode fill-stroke pairs, group, annotation and edge roles for elements. Bake ordinary hex colors into the scene. Theme changes do not recolor existing scenes; recolor only on explicit request. Use a scene authored for light mode in light mode and a dark scene in dark mode; stock Excalidraw may transform colors in its opposite editor mode.

## Create and link

1. Outline the diagram's purpose and relationships. Use readable labels, adequate spacing and bound text/arrows. Read [references/scene-files.md](references/scene-files.md) for the file format and safe write pattern.
2. Save under `<notesRoot>/diagrams/<name>.excalidraw` with exclusive creation (`flag: "wx"`); do not overwrite a collision. Reject symlinked scene directories and paths escaping the canonical notes root.
3. Create the companion using `weave_note` action `add`, `source: agent`, a specific title and a short explanation with `[[diagrams/<name>.excalidraw]]`. Include major components/relationships, assumptions and repository identity/revision plus relative source paths when applicable. Without the tool, write a normal front-matter Markdown note using the same exclusive creation rule (`title`, `created`, `updated`, `tags`, `source: agent`).
4. Record scene authorship and later contributions in the companion text. The note's front matter describes the note, not a complete history of the drawing. Imported scenes have unknown authorship unless established. Excalidraw's top-level `source` describes export origin, not human/agent provenance.

These are two separate writes. If companion creation fails, retain the scene and report its path and the missing note/link so the user can recover it.

## Inspect and round-trip

Validate JSON, unique IDs and references, then inspect in an available Excalidraw editor or renderer: check clipping, overlaps, arrow endpoints and legibility. Browser/Python/MCP setup is optional; if unavailable, report visual verification as outstanding instead of claiming it passed.

Weave discovers the file and offers source download. Open/download it, edit in stock Excalidraw or another compatible local editor, then save the `.excalidraw` file back to its vault path. Downloading alone does not save edits into the vault. Reopen the saved file to confirm text, moved shapes, arrow bindings and embedded images remain editable.

## Update

Read the current scene from disk after human edits. Preserve untouched elements, IDs, bindings, groups, embedded `files` and unknown supported fields. Make targeted changes; do not regenerate the entire scene or recolor it silently. Write a new exclusively created review copy, such as `diagrams/<name>-revised.excalidraw`, and add its exact wiki link plus a dated agent contribution to the companion. The human can review before replacing the original. Inspect the copy and confirm the human's changes survive.
