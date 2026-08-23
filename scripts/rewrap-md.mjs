#!/usr/bin/env node
/**
 * Deterministic Markdown rewriter.
 *
 * Rewraps hard-wrapped prose, blockquote, and list-item text to a fixed line
 * width (default 140) while leaving structural elements verbatim: YAML front
 * matter, fenced code blocks, ATX headings, horizontal rules, tables, inline
 * HTML, and blank lines.
 *
 * Usage:
 *   node scripts/rewrap-md.mjs                # rewrite docs/, skills/, AGENTS.md, README.md
 *   node scripts/rewrap-md.mjs path/to/a.md   # rewrite specific files
 *   node scripts/rewrap-md.mjs --check        # report files that would change, write nothing
 *   node scripts/rewrap-md.mjs --width 120    # override line width
 *
 * Deterministic: no randomness, no wall-clock, no network. Running twice is a
 * no-op. Use --check (e.g. in CI) to fail when files are not rewrapped.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const DEFAULT_WIDTH = 140;
const IGNORE_DIRS = new Set(["node_modules", ".git", ".okf", "dist", "coverage"]);

// --- line classification ----------------------------------------------------

const RE_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RE_HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_TABLE_ROW = /^ *\|/;
const RE_BLOCKQUOTE = /^ {0,3}>/;
const RE_LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}\.)(?:[ \t]+|$)/;
const RE_HTML = /^[ \t]*</;
const RE_BLANK = /^\s*$/;

function isBlockStart(line) {
  return (
    RE_HEADING.test(line) ||
    RE_FENCE.test(line) ||
    RE_HR.test(line) ||
    RE_TABLE_ROW.test(line) ||
    RE_BLOCKQUOTE.test(line) ||
    RE_LIST_ITEM.test(line) ||
    RE_HTML.test(line)
  );
}

// --- word wrap ---------------------------------------------------------------

/**
 * Greedy word wrap. Long words (URLs, code) are never split.
 */
function wrap(text, width) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (cur.length + 1 + word.length <= width) {
      cur += " " + word;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  lines.push(cur);
  return lines;
}

// --- reflowers ---------------------------------------------------------------

function reflowParagraph(lines, width) {
  const text = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  if (!text) return [];
  return wrap(text, width);
}

function reflowList(lines, width) {
  const m = lines[0].match(RE_LIST_ITEM);
  const prefix = (m[1] || "") + m[2] + " ";
  const contIndent = " ".repeat(prefix.length);
  const firstContent = lines[0].replace(/^ {0,3}([-*+]|\d{1,9}\.)[ \t]+/, "");
  const text = [firstContent, ...lines.slice(1)]
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  const bodyWidth = Math.max(1, width - prefix.length);
  const wrapped = wrap(text, bodyWidth);
  const first = prefix + wrapped[0];
  return [first, ...wrapped.slice(1).map((l) => contIndent + l)];
}

function reflowBlockquote(lines, width) {
  const bodyWidth = Math.max(1, width - 2);
  const out = [];
  let buf = [];
  const flushBuf = () => {
    if (buf.length > 0) {
      for (const l of wrap(buf.join(" "), bodyWidth)) out.push("> " + l);
      buf = [];
    }
  };
  for (const raw of lines) {
    const content = raw.replace(/^ {0,3}> ?/, "");
    if (RE_BLANK.test(content)) {
      // A blank quote line ends the current paragraph and is kept as a lone `>`.
      flushBuf();
      out.push(">");
    } else {
      buf.push(content.trim());
    }
  }
  flushBuf();
  return out;
}

// --- main rewriter ------------------------------------------------------------

function rewrap(content, width) {
  const lines = content.split("\n");
  const out = [];
  let i = 0;

  // YAML front matter at the very top: keep verbatim.
  if (lines.length > 0 && lines[0].trim() === "---") {
    let end = 1;
    while (end < lines.length && lines[end].trim() !== "---") end++;
    for (let k = 0; k <= end && k < lines.length; k++) out.push(lines[k]);
    i = end + 1;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (RE_BLANK.test(line)) {
      out.push("");
      i++;
      continue;
    }

    // Fenced code block: copy verbatim through the closing fence.
    if (RE_FENCE.test(line)) {
      out.push(line);
      i++;
      while (i < lines.length) {
        out.push(lines[i]);
        const closed = RE_FENCE.test(lines[i]);
        i++;
        if (closed) break;
      }
      continue;
    }

    if (RE_HR.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    if (RE_HEADING.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    if (RE_TABLE_ROW.test(line)) {
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      continue;
    }

    if (RE_BLOCKQUOTE.test(line)) {
      const bq = [];
      while (i < lines.length && RE_BLOCKQUOTE.test(lines[i])) {
        bq.push(lines[i]);
        i++;
      }
      out.push(...reflowBlockquote(bq, width));
      continue;
    }

    if (RE_HTML.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    if (RE_LIST_ITEM.test(line)) {
      const m = line.match(RE_LIST_ITEM);
      const indentCol = (m[1] || "").length + (m[2] || "").length;
      const item = [line];
      i++;
      while (i < lines.length) {
        const nx = lines[i];
        if (RE_BLANK.test(nx) || isBlockStart(nx)) break;
        const lead = (nx.match(/^ */) || [""])[0].length;
        if (lead <= indentCol) break;
        item.push(nx);
        i++;
      }
      out.push(...reflowList(item, width));
      continue;
    }

    // Plain prose paragraph.
    const para = [line];
    i++;
    while (i < lines.length) {
      const nx = lines[i];
      if (RE_BLANK.test(nx) || isBlockStart(nx)) break;
      para.push(nx);
      i++;
    }
    out.push(...reflowParagraph(para, width));
  }

  return out.join("\n");
}

// --- file discovery -------------------------------------------------------------

function collectFiles(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (IGNORE_DIRS.has(name)) continue;
        files.push(...collectFiles([join(abs, name)]));
      }
    } else if (extname(abs) === ".md") {
      files.push(abs);
    }
  }
  return files;
}

// --- CLI -------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const widthArg = args.find((a) => a.startsWith("--width="));
  const width = widthArg ? Number(widthArg.split("=")[1]) : DEFAULT_WIDTH;
  if (!Number.isFinite(width) || width < 40) {
    console.error(`error: invalid width (${widthArg || width})`);
    process.exit(2);
  }

  const rest = args.filter((a) => a !== "--check" && !a.startsWith("--width="));
  const targets =
    rest.length > 0
      ? rest
      : ["AGENTS.md", "README.md", "docs", "skills"];

  const files = collectFiles(targets);
  const changed = [];

  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const after = rewrap(before, width);
    if (after !== before) {
      changed.push(file);
      if (!check) writeFileSync(file, after, "utf8");
    }
  }

  if (changed.length === 0) {
    console.log(`All ${files.length} markdown files are already wrapped to ${width} cols.`);
    if (check) return 0;
    return 0;
  }

  for (const f of changed) {
    console.log(`${check ? "would rewrap" : "rewrapped"}: ${f}`);
  }
  console.log(`${changed.length} file(s) ${check ? "would change" : "changed"} (width ${width}).`);
  return check ? 1 : 0;
}

process.exit(main(process.argv));
