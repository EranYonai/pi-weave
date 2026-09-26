#!/usr/bin/env node

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(ROOT, "src/pi/index.ts");
const SKILL = join(ROOT, "skills/weave-notepad/SKILL.md");

const notes = [
  ["Harbor master plan", ["sailing", "operations"], "The primary vessel is Aurora. It docks at North Pier. Link it to [[aurora-maintenance]]."],
  ["Aurora Maintenance", ["sailing", "maintenance"], "Aurora needs hull inspection Friday. See [[harbor-master-plan]]."],
  ["Sailing Checklist", ["sailing", "safety"], "Pack life jackets and check the weather radio."],
  ["Hull Inspection Log", ["maintenance"], "Hull inspection found a loose port fitting on Aurora."],
  ["Marina Dinner", ["personal"], "Dinner reservation is Saturday at seven."],
  ["Lisbon Trip Plan", ["travel", "family"], "Flight TP1063 leaves November 7 at 06:15. Stay at Alfama Loft. See [[lisbon-packing-list]]."],
  ["Lisbon Packing List", ["travel", "checklist"], "Pack a waterproof jacket, Type C power adapter, and the blue passport pouch. See [[lisbon-trip-plan]]."],
  ["Kitchen Renovation Decision", ["home", "decision"], "Choose matte sage cabinet fronts and Cloud White quartz. Budget is 42,000 NIS. See [[appliance-measurements]]."],
  ["Appliance Measurements", ["home", "renovation"], "Fridge alcove is 92 cm wide. Oven is 60 cm. Dishwasher is 45 cm. See [[kitchen-renovation-decision]]."],
  ["Family Birthday Dinner", ["family", "event"], "Dinner is October 18 at 19:30 at Nona Kitchen. Leah is vegetarian. Order the lemon tart."],
  ["Dentist Follow-up", ["health", "appointment"], "Appointment is October 14 at 09:20 with Dr. Amir. Bring the panoramic X-ray."],
  ["Weekly Training Plan", ["health", "routine"], "Strength training Tuesday and Thursday at 07:00. Run 5 km on Sunday."],
  ["Book Club November", ["reading", "event"], "Meet November 3 to discuss chapters 1–6 of The Dispossessed."],
  ["Atlas API Migration", ["atlas", "api", "migration"], "Move clients from /v1/orders to /v2/orders by November 15. POST requests require Idempotency-Key. See [[atlas-rollout-guardrails]]."],
  ["Atlas Rollout Guardrails", ["atlas", "release"], "Roll out at 10%, then 50%, then 100%. Pause when error rate exceeds 1.5%. See [[atlas-api-migration]]."],
  ["Checkout Incident September 18", ["checkout", "incident"], "At 14:07 a promotion caused database connection pool exhaustion. Raise pool size from 40 to 80 and cap workers at 24."],
  ["Checkout Incident Actions", ["checkout", "incident"], "Niv owns the September 30 load test. Priya owns the pool saturation alert. See [[checkout-incident-september-18]]."],
  ["Payments Bug 1842", ["payments", "bug"], "JPY totals were divided by 100 incorrectly. Fix the zero-decimal currency set and add JPY and KRW regression tests. See [[payment-release-4-8-1]]."],
  ["Payment Release 4.8.1", ["payments", "release"], "Release 4.8.1 contains the currency fix. Start at 5% and watch the amount-mismatch rate. See [[payments-bug-1842]]."],
  ["Auth Boundary ADR", ["architecture", "auth"], "The gateway validates JWT signature, issuer, and audience. Services enforce roles and tenant authorization."],
  ["Session Cache Decision", ["architecture", "cache"], "Use Redis with a 20-minute TTL and tenant-prefixed keys. Do not add a local fallback cache."],
  ["Observability Rollout", ["platform", "observability"], "Sample 10% of normal traces and 100% of errors. Retain traces for 14 days."],
  ["Web Bundle Budget", ["frontend", "performance"], "Current bundle is 382 kB gzip; target is 250 kB. Removing Moment saves 68 kB and splitting charts saves 44 kB."],
  ["Node 22 Upgrade", ["platform", "upgrade"], "Upgrade is blocked by the legacy canvas package. Zoe owns replacement research. Target date is December 2."],
  ["Search Ranking Experiment", ["search", "experiment"], "Use title boost 4, tag boost 3, and body boost 1. Offline nDCG improved from 0.71 to 0.78."],
  ["Customer Timezone Migration", ["database", "migration"], "Add nullable customer_timezone, backfill UTC in batches of 5,000, then make it required. Abort if lock waits exceed 200 ms."],
];

const cases = [
  ["exact-title", "baseline", "What does my note called Harbor master plan say? Use my notes.", ["Aurora", "North Pier"]],
  ["natural-language", "baseline", "What is the primary vessel in my harbor plan, and where does it dock? Use my notes.", ["Aurora", "North Pier"]],
  ["connected-summary", "baseline", "What do my notes say about Aurora? Summarize only from my notes.", ["Aurora", "North Pier", "Friday", "loose port fitting"], ["life jackets"]],
  ["lisbon-flight", "life", "According to my Lisbon Trip Plan note, what flight am I taking and when does it leave?", ["TP1063", ["November 7", "Nov 7"], ["06:15", "6:15"]]],
  ["lisbon-adapter", "life", "Which power adapter and passport pouch should I pack for Lisbon? Use my notes.", ["Type C", "blue"]],
  ["lisbon-connected", "life", "Summarize my Lisbon travel logistics and the most important things to pack, using only my notes.", ["TP1063", "Alfama Loft", "waterproof jacket", "Type C"]],
  ["kitchen-finishes", "life", "What finishes did we choose in the Kitchen Renovation Decision note?", ["matte sage", "Cloud White"]],
  ["appliance-widths", "life", "How wide are the fridge alcove and dishwasher spaces? Check my notes.", [["92 cm", "92cm"], ["45 cm", "45cm"]]],
  ["renovation-connected", "life", "What is the kitchen renovation budget, and how wide is the fridge alcove? Use my notes.", [["42,000", "42000"], ["92 cm", "92cm"]]],
  ["birthday-dinner", "life", "Give me the time, place, dietary constraint, and dessert for the family birthday dinner.", [["19:30", "7:30"], "Nona Kitchen", "vegetarian", "lemon tart"]],
  ["dentist", "life", "When is my dentist follow-up, who is it with, and what should I bring?", [["October 14", "Oct 14"], ["09:20", "9:20"], "Dr. Amir", ["panoramic X-ray", "panoramic xray"]]],
  ["training", "life", "What is my weekly training schedule? Use my notes.", ["Tuesday", "Thursday", ["07:00", "7:00"], "Sunday", "5 km"]],
  ["book-club", "life", "What book and chapters are next for book club, and on what date?", ["The Dispossessed", ["1–6", "1-6", "1 through 6"], "November 3"]],
  ["travel-tag", "life", "Which notes do I have tagged for travel? Give me their titles.", ["Lisbon Trip Plan", "Lisbon Packing List"]],
  ["missing-note", "life", "Do I have a note about renewing car insurance? Use my notes.", [["no note", "no notes", "couldn't find", "couldn’t find", "did not find", "don't have"]]],
  ["atlas-migration", "software", "What endpoint and deadline are in my Atlas API Migration note?", ["/v2/orders", "November 15"]],
  ["atlas-header", "software", "Which header must Atlas clients send for order creation? Check my notes.", ["Idempotency-Key"]],
  ["atlas-rollout", "software", "What are the Atlas rollout stages and stop threshold?", ["10%", "50%", "100%", "1.5%"]],
  ["atlas-connected", "software", "Summarize the Atlas migration deadline and rollout risk guardrail from my notes.", ["November 15", "1.5%"]],
  ["checkout-root-cause", "software", "What caused the September 18 checkout incident? Use my notes.", ["promotion", "database connection pool", "exhaust"]],
  ["checkout-mitigation", "software", "What pool and worker changes were chosen after the checkout incident?", [["40 to 80", "40 → 80", "40 up to 80"], "24"]],
  ["payments-bug", "software", "What was wrong in payments bug 1842, and which currencies need regression tests?", ["JPY", "100", "KRW"]],
  ["payment-release", "software", "How should payment release 4.8.1 roll out, and what metric should we watch?", ["5%", "amount-mismatch"]],
  ["auth-boundary", "software", "Where do JWT validation and authorization happen according to the Auth Boundary ADR?", ["gateway", "signature", "issuer", "audience", "services", "roles", "tenant"]],
  ["session-cache", "software", "Summarize the session cache decision, including TTL and fallback policy.", ["Redis", ["20-minute", "20 minute"], ["no local fallback", "do not add a local fallback"]]],
  ["observability", "software", "What trace sampling and retention did we choose? Use my notes.", ["10%", "100%", "14 days"]],
  ["bundle-budget", "software", "What is the current web bundle, the target, and the two planned savings?", ["382", "250", "68", "44", "Moment", "charts"]],
  ["node-upgrade", "software", "What blocks the Node 22 upgrade, who owns it, and what is the target date?", ["canvas", "Zoe", "December 2"]],
  ["search-ranking", "software", "What weights and nDCG result are in the search ranking experiment?", [["title boost 4", "title 4", "title **4**"], ["tag boost 3", "tag 3", "tags 3", "tags **3**"], ["body boost 1", "body 1", "body **1**"], "0.71", "0.78"]],
  ["timezone-migration", "software", "Describe the customer timezone migration sequence, batch size, and lock-wait cutoff.", ["nullable", "UTC", ["5,000", "5000"], "required", ["200 ms", "200ms"]]],
].map(([name, category, prompt, mustMention, mustAvoid = []]) => ({ name, category, prompt, mustMention, mustAvoid }));

function parseEvents(stdout) {
  return stdout.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`invalid Pi JSONL at line ${index + 1}`); }
  });
}

function textOf(content) {
  return Array.isArray(content)
    ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    : "";
}

function normalizeMessages(events) {
  const messages = [...events].reverse().find((event) => event.type === "agent_end")?.messages ?? [];
  return messages.flatMap((message) => {
    if (message.role === "user") return [{ role: "user", text: textOf(message.content) }];
    if (message.role === "toolResult") {
      return [{ role: "tool", name: message.toolName, text: textOf(message.content), details: message.details, isError: message.isError }];
    }
    if (message.role !== "assistant") return [];
    const content = message.content.flatMap((part) => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "toolCall") return [{ type: "tool_call", name: part.name, arguments: part.arguments }];
      return [];
    });
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  });
}

function summarize(name, prompt, stdout) {
  const events = parseEvents(stdout);
  const starts = events.filter((event) => event.type === "tool_execution_start");
  const toolCalls = starts.map((event) => ({ name: event.toolName, arguments: event.args }));
  const toolRounds = events.filter(
    (event) => event.type === "turn_end" && Array.isArray(event.toolResults) && event.toolResults.length > 0,
  ).length;
  const assistant = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => textOf(event.message.content)).filter(Boolean).at(-1) ?? "";
  const modelMessage = [...events].reverse().find(
    (event) => event.type === "message_end" && event.message?.role === "assistant" && event.message.model,
  )?.message;
  return {
    name,
    prompt,
    model: modelMessage ? `${modelMessage.provider}/${modelMessage.model}` : "unknown",
    toolCalls,
    toolRounds,
    assistant,
    conversation: normalizeMessages(events),
  };
}

function runPi(name, prompt, vault, transcripts) {
  const args = [
    "-ne", "-e", EXTENSION,
    "--skill", SKILL,
    "--no-session", "--mode", "json",
    "--no-builtin-tools", "--tools", "weave_note",
    "-p", prompt,
  ];
  const result = spawnSync("pi", args, {
    cwd: ROOT,
    env: { ...process.env, PI_WEAVE_VAULT: vault },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });
  const base = join(transcripts, name);
  writeFileSync(`${base}.jsonl`, result.stdout ?? "");
  if (result.stderr) writeFileSync(`${base}.stderr.log`, result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pi failed for ${name} (exit ${result.status}); see ${base}.stderr.log`);
  return summarize(name, prompt, result.stdout);
}

function contains(answer, requirement) {
  const alternatives = Array.isArray(requirement) ? requirement : [requirement];
  return alternatives.some((term) => answer.toLowerCase().includes(term.toLowerCase()));
}

function assess(testCase, run) {
  const actions = run.toolCalls.map((call) => call.arguments?.action ?? call.name);
  const missing = testCase.mustMention.filter((requirement) => !contains(run.assistant, requirement));
  const unexpected = testCase.mustAvoid.filter((requirement) => contains(run.assistant, requirement));
  return {
    name: testCase.name,
    category: testCase.category,
    actions,
    calls: run.toolCalls.length,
    rounds: run.toolRounds,
    answerPass: missing.length === 0 && unexpected.length === 0,
    efficiencyPass: actions.length === 1 && actions[0] === "search",
    missing,
    unexpected,
  };
}

function seedPrompt(batch) {
  const rows = batch.map(([title, tags, text], index) =>
    `${index + 1}. Title: ${title}\n   Tags: ${tags.join(", ")}\n   Body: ${text}`
  ).join("\n");
  return `Create these ${batch.length} human-authored notes in my notepad. Use exactly one weave_note add call per note, preserve every fact and wiki-link exactly, and set source to human.\n${rows}\nCreate only these notes and summarize the slugs.`;
}

function renderReport(output, vault, seedRuns, runs, assessments) {
  const answerPasses = assessments.filter((result) => result.answerPass).length;
  const efficiencyPasses = assessments.filter((result) => result.efficiencyPass).length;
  const rows = assessments.map((result) =>
    `| ${result.name} | ${result.category} | ${result.actions.join(" → ") || "none"} | ${result.calls} | ${result.rounds} | ${result.answerPass ? "PASS" : "FAIL"} | ${result.efficiencyPass ? "PASS" : "FAIL"} |`
  );
  const sections = runs.map((run, index) => `## ${run.name}

- Model: \`${run.model}\`
- Tool calls: ${run.toolCalls.length}
- Tool rounds: ${run.toolRounds}
- Answer check: ${assessments[index].answerPass ? "PASS" : "FAIL"}
- Efficiency check: ${assessments[index].efficiencyPass ? "PASS" : "FAIL"}
- Raw transcript: \`transcripts/${run.name}.jsonl\`

\`\`\`json
${JSON.stringify(run.conversation, null, 2)}
\`\`\``).join("\n\n");
  return `# pi-weave notepad retrieval eval — 30 cases

- Output: \`${output}\`
- Isolated vault: \`${vault}\`
- Seed: ${notes.length} notes through ${seedRuns.length} real Pi conversations
- Answer checks: ${answerPasses}/${assessments.length}
- One-search efficiency checks: ${efficiencyPasses}/${assessments.length}
- Efficiency target: exactly one \`search\` call and no \`get\` call.

| Case | Category | Actions | Calls | Rounds | Answer | Efficiency |
| --- | --- | --- | ---: | ---: | --- | --- |
${rows.join("\n")}

${sections}
`;
}

function selfTest() {
  const stdout = [
    { type: "tool_execution_start", toolName: "weave_note", args: { action: "search", query: "harbor" } },
    { type: "turn_end", toolResults: [{}] },
    { type: "message_end", message: { role: "assistant", provider: "test", model: "model", content: [{ type: "text", text: "Aurora is at North Pier" }] } },
    { type: "agent_end", messages: [
      { role: "user", content: [{ type: "text", text: "find it" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "weave_note", arguments: { action: "search" } }] },
      { role: "toolResult", toolName: "weave_note", content: [{ type: "text", text: "found" }], details: { action: "search" }, isError: false },
      { role: "assistant", content: [{ type: "text", text: "Aurora is at North Pier" }] },
    ] },
  ].map(JSON.stringify).join("\n");
  const run = summarize("self-test", "find it", stdout);
  const result = assess({ name: "self-test", category: "test", mustMention: ["Aurora", ["North Pier", "north pier"]], mustAvoid: [] }, run);
  if (!result.answerPass || !result.efficiencyPass || run.toolRounds !== 1) throw new Error("self-test failed");
  if (run.conversation.length !== 4 || run.conversation[2].details.action !== "search") throw new Error("conversation normalization failed");
  if (cases.length !== 30) throw new Error(`expected 30 cases, found ${cases.length}`);
  console.log("self-test passed");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "pi-weave-notepad-eval-"));
  const vault = join(output, "vault");
  const transcripts = join(output, "transcripts");
  mkdirSync(vault, { recursive: true });
  mkdirSync(transcripts, { recursive: true });

  console.log(`Writing eval artifacts to ${output}`);
  const batches = Array.from({ length: Math.ceil(notes.length / 6) }, (_, index) => notes.slice(index * 6, index * 6 + 6));
  const seedRuns = batches.map((batch, index) => {
    console.log(`Seeding batch ${index + 1}/${batches.length}…`);
    const run = runPi(`seed-${index + 1}`, seedPrompt(batch), vault, transcripts);
    const adds = run.toolCalls.filter((call) => call.arguments?.action === "add");
    const valid = batch.every(([title, tags, text]) => adds.some((call) =>
      call.arguments.title === title
      && call.arguments.text === text
      && call.arguments.source === "human"
      && JSON.stringify(call.arguments.tags) === JSON.stringify(tags)
    ));
    if (adds.length !== batch.length || !valid) throw new Error(`seed-${index + 1} did not preserve its ${batch.length} notes exactly`);
    return run;
  });

  const runs = cases.map((testCase, index) => {
    console.log(`Running ${index + 1}/${cases.length}: ${testCase.name}…`);
    return runPi(testCase.name, testCase.prompt, vault, transcripts);
  });
  const assessments = runs.map((run, index) => assess(cases[index], run));
  const report = renderReport(output, vault, seedRuns, runs, assessments);
  writeFileSync(join(output, "conversation.json"), `${JSON.stringify([...seedRuns, ...runs], null, 2)}\n`);
  writeFileSync(join(output, "results.json"), `${JSON.stringify(assessments, null, 2)}\n`);
  writeFileSync(join(output, "report.md"), report);
  console.log(report.split("\n").slice(0, 45).join("\n"));
  console.log(`Full LLM analysis report: ${join(output, "report.md")}`);
}
