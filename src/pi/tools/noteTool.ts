import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatRawAppend } from "../../core";
import { weaveTools } from "../../core/tools";
import { piParameters } from "./parameters";

const tool = weaveTools.find((definition) => definition.name === "weave_note")!;

/** `weave_note` — the smart-notepad tool (design §1: vault knowledge). */
export function registerNoteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: tool.name,
    label: "Weave Note",
    description: tool.description,
    promptSnippet: "Remember and retrieve durable knowledge in the pi-weave vault",
    promptGuidelines: [
      "Use weave_note to store durable knowledge (decisions, preferences, key facts) that should survive the session, marking source as agent-written knowledge.",
      "Use weave_note with action=get when the slug is known; otherwise use one targeted action=search before answering questions about past decisions, people, or projects. A resolved search already contains the full note; do not fetch it again or retry with reformulated queries.",
      "Use weave_note with action=links to find and repair stale [[wiki-links]] deterministically instead of rereading the vault to reconnect notes by hand; add fix=true to apply the unambiguous repairs.",
      "Use weave_note with action=suggest to discover notes that belong together but are not linked (optionally scoped to one slug); it only reports — propose the links to the user rather than writing them.",
    ],
    parameters: piParameters(tool.input),
    async execute(_toolCallId, params) {
      // The vault is global, so weave_note ignores the working directory.
      const result = await tool.execute(params, "");
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}

export { formatRawAppend };
