---
name: weave-excalidraw
description: "Create portable editable Excalidraw diagrams in the Weave vault with searchable companion notes; update existing scenes as reviewable copies. Use for an Excalidraw graph note, example graph, architecture sketch, flow, or knowledge diagram."
---

# Weave Excalidraw

Create a normal `.excalidraw` JSON file and a Markdown explanation in the user's persistent vault. Keep the scene editable in stock Excalidraw; a preview alone is insufficient. Persist repository-derived diagrams only when the user requests it; the repository's derived `.okf` index must never hold the only copy.

A request to create an example diagram means a **new scene**, not a note linking a pre-existing drawing. Do not claim a diagram was created until its scene file exists and its exact link resolves.

## Context and palette

Run the packaged helper relative to this skill's directory, with the workspace directory:

```sh
node scripts/diagram-context.mjs --cwd /path/to/workspace
```

It reads validated workspace settings and prints `vaultRoot`, `notesRoot` and semantic colors. It writes nothing and requires only Node. Optional overrides: `--theme paper-blue`, `--accent teal`, `--scheme light|dark`. An explicit theme takes precedence over persisted settings.

`needsScheme: true` means the selected system theme cannot be resolved without the browser's device scheme. Choose a concrete scheme from the user's request or ask which to use; run again with `--scheme`. The helper exposes both configured palettes rather than claiming either is active. `themeSource: default` means no saved workspace settings were found.

Use the returned canvas color in `appState.viewBackgroundColor`; use text/stroke, primary/secondary/accentNode fill-stroke pairs, group, annotation and edge roles for elements. Bake ordinary hex colors into the scene. Theme changes adapt recognized palette colors in the preview without rewriting the saved scene; recolor the source only on explicit request. Use a scene authored for light mode in light mode and a dark scene in dark mode; stock Excalidraw may transform colors in its opposite editor mode.

## Create and link

1. Outline the diagram's purpose and relationships. For a small linear example flow, use the packaged helper below; it wraps labels and sets non-overlapping geometry from a stock-verified template. For other diagrams, read [references/scene-files.md](references/scene-files.md), especially label fitting. Use actual newline characters in labels, never literal backslash-n, and size text/containers together. Changing a label without updating its dimensions and position is not a valid edit.
2. Save a new scene under `<notesRoot>/diagrams/<name>.excalidraw` with exclusive creation (`flag: "wx"`); do not overwrite a collision. Reject symlinked scene directories and paths escaping the canonical notes root. Read the saved JSON back and verify visible elements, unique IDs, reciprocal bindings and the intended path before creating a companion.
3. Create the companion using `weave_note` action `add`, `source: agent`, a specific title and a short Markdown body with the exact `[[diagrams/<name>.excalidraw]]` returned by scene creation. Pass title/tags/source as tool fields; **do not include YAML front matter in `text`**. Include major components/relationships, assumptions and repository identity/revision plus relative source paths when applicable. Without the tool, write a normal front-matter Markdown note using the same exclusive creation rule (`title`, `created`, `updated`, `tags`, `source: agent`). Read the companion back and confirm that its exact link targets the newly created scene.
4. Record scene authorship and later contributions in the companion text. The note's front matter describes the note, not a complete history of the drawing. Imported scenes have unknown authorship unless established. Excalidraw's top-level `source` describes export origin, not human/agent provenance.

These are two separate writes. If companion creation fails, retain the scene and report its path and the missing note/link so the user can recover it.

### Small example flows

Save the resolved context helper output to a temporary JSON file. Save a JSON array of 2–8 short labels in a second temporary file, in flow order (for example `["Ask the agent", "Save the knowledge", "Browse in Weave"]`). Then run relative to this skill directory:

```sh
node scripts/create-flow.mjs --context /tmp/weave-diagram-context.json --name example-flow --labels /tmp/weave-flow-labels.json
```

This Node-only helper creates a fresh scene with bound labels and arrows between successive steps. It returns `path`, `wikiLink`, and counts after reading the saved scene back. Use that `wikiLink` for the companion. On a filename collision, choose a new name and retry. For branches, cycles or custom layouts, adapt the verified template and inspect the result rather than forcing them into a linear flow.

## Inspect and round-trip

Validate JSON, unique IDs and reciprocal references. Check that each bound label's declared rectangle fits inside its container with padding on every side. Then inspect in an available Excalidraw editor or renderer at readable zoom: confirm the actual glyphs fit, multiline text has room, labels do not overlap edges, and arrow endpoints/spacing are clear. The helper uses conservative monospace estimates; arithmetic bounds alone do not prove font rendering. Fix any overflow in a review copy before calling the drawing verified. Browser/Python/MCP setup is optional; if unavailable, report visual verification as outstanding instead of claiming it passed.

Weave discovers the file, renders a local preview, and offers **Download source** and **How to edit** in the pane’s **⋯** menu. Open/download it, edit in stock Excalidraw or another compatible local editor, then save the `.excalidraw` file back to its vault path and refresh Weave. Downloading alone does not save edits into the vault. Reopen the saved file to confirm text, moved shapes, arrow bindings and embedded images remain editable.

## Update

Read the current scene from disk after human edits. Preserve untouched elements, IDs, bindings, groups, embedded `files` and unknown supported fields. Make targeted changes; do not regenerate the entire scene or recolor it silently. Write a new exclusively created review copy, such as `diagrams/<name>-revised.excalidraw`, and add its exact wiki link plus a dated agent contribution to the companion. The human can review before replacing the original. Inspect the copy and confirm the human's changes survive.
