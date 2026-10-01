# OpenCode V1/V2 E2E checklist

Test PR #60 from `codex/opencode-adapter`. Both hosts use the same tool definitions, vault actions, command workflow, scan engines, and
browser server. V1 translates the legacy API; V2 retains direct commands and its terminal companion. The V2 toast-only crash fix is
retained.

## Automated checks

In the existing branch worktree:

```bash
cd /Users/eranyonai/.codex/worktrees/opencode-adapter/pi-weave
npm run check
npm run smoke:opencode
```

The smoke packs the actual npm artifact and starts OpenCode 1.18.29 and 2.0.19 with isolated configuration, caches, data, repositories, and
vaults. A local deterministic model exercises tools and scans without credentials or API charges. It also checks packaged skill discovery,
V1 command-result metadata, and V2 RPC. Interactive rendering, real provider authentication, and browser launching still need the manual
pass below.

## Prepare an isolated manual fixture

Run these in one terminal. Keep it open for both host passes. These commands use the existing branch directly and create test data in a new
temporary directory; they do not change your normal OpenCode profile or notes.

```bash
cd /Users/eranyonai/.codex/worktrees/opencode-adapter/pi-weave
weave_plugin="file://$PWD"
weave_test="$(mktemp -d)"
export PI_WEAVE_VAULT="$weave_test/vault"
export OPENCODE_DISABLE_EXTERNAL_SKILLS=true
export OPENCODE_DISABLE_CLAUDE_CODE=true
mkdir -p "$weave_test/repo" "$weave_test/v1/config/opencode" "$weave_test/v2/config/opencode"
printf 'export const answer = 42;\n' > "$weave_test/repo/example.ts"
printf '.okf/\n' > "$weave_test/repo/.gitignore"
git -C "$weave_test/repo" init -q
git -C "$weave_test/repo" add .
git -C "$weave_test/repo" -c user.name=WeaveTest -c user.email=weave-test@example.invalid commit -qm fixture
printf '{"plugin":["%s"]}\n' "$weave_plugin" > "$weave_test/v1/config/opencode/opencode.json"
printf '{"plugin":["%s"]}\n' "$weave_plugin" > "$weave_test/v1/config/opencode/tui.json"
printf '{"plugins":["%s"]}\n' "$weave_plugin" > "$weave_test/v2/config/opencode/opencode.json"
```

V1 loads terminal plugins separately from `tui.json`; both V1 configuration files above are required for automatic browser opening and the
viewer URL fallback dialog.

## V1 — minimum supported release

```bash
export XDG_CONFIG_HOME="$weave_test/v1/config"
export XDG_DATA_HOME="$weave_test/v1/data"
export XDG_CACHE_HOME="$weave_test/v1/cache"
npm install --ignore-scripts --no-audit --no-fund --prefix "$XDG_CONFIG_HOME/opencode" @opencode-ai/plugin@1.18.29
./node_modules/@opencode-v1/cli/bin/opencode.exe "$weave_test/repo"
```

The `npm install` prepares V1's normal plugin SDK dependency explicitly; this also avoids waiting on V1's background dependency installer.
These binary paths use the pinned development hosts (1.18.29 and 2.0.19) and avoid any globally installed `opencode`. Use `/connect` to
authenticate in this test profile and `/models` to select your model. Send one ordinary message before scanning, such as “Reply OK. For this
session, our decision is to keep project notes in local Markdown.” V1 scans use the model from that chat message.

Run this checklist:

1. **Dashboard:** `/weave` reports the test vault and fixture repository. V1 runs slash commands through a model reply; an extra model
   response in the regular conversation is expected. `/weave` must not open a dialog or browser window.
2. **Skills:** ask the agent to load `weave-notepad` and `weave-explore`. Both should be discoverable without copying skill files.
3. **Notes:** “Use weave_note to create a note titled Adapter E2E saying: We chose local Markdown for project memory.” Then append a detail
   and ask “What did we decide about project memory?” Inspect the tool calls and returned note. Agent-created notes must have `source:
   agent`.
4. **Repository:** ask the agent to use `weave_repo` with `action=scan`, then `action=overview`. Paths must refer to the temporary repo.
5. **Deep scan:** `/weave-scan deep`. Expect progress, completion, and generated summaries in the fixture's `.okf` index. Temporary
   “pi-weave scan” child sessions must disappear when it finishes.
6. **Session memory:** `/weave-scan sessions`. Expect a generated note under the test vault's `notes/sessions/`, containing the
   conversation's decisions and an `opencode:session:` source reference.
7. **Cancellation:** start a deep/session scan with changed input and run `/weave-scan-cancel` while it is generating. Expect cancellation,
   no leaked scan child session, and no late summary saved after cancellation. A scan that already completed will report “no scan”.
8. **Viewer:** `/weave-view` opens the browser when the terminal can reach the local viewer. Check notes, repository graph, and editing.
   Repeat with `/weave-view --no-open`; the existing viewer should be reused and a native dialog should show the exact URL without opening a
   browser. An unknown argument should print usage.
9. **Cleanup:** quit OpenCode completely. Refresh the viewer URL; the old server should no longer answer.

## V2 — regression pass

Quit V1 first. In the same terminal, switch only the OpenCode profile; keep the same fixture and vault:

```bash
export XDG_CONFIG_HOME="$weave_test/v2/config"
export XDG_DATA_HOME="$weave_test/v2/data"
export XDG_CACHE_HOME="$weave_test/v2/cache"
./node_modules/@opencode/cli/bin/opencode.exe --standalone "$weave_test/repo"
```

Authenticate and select a model in this profile. Repeat the checklist, with these expectations:

- The V1 note is immediately readable through `weave_note` and the browser. There is no migration or second vault.
- `/weave`, `/weave-scan`, and `/weave-view` execute directly, without V1's extra model response.
- Status/progress uses toasts. Opening the home screen or a session must not crash with “Orphan text”; there is no custom footer.
- `/weave-view` opens the browser when the terminal can prove it reaches that viewer locally. `--no-open` prints the URL only.
- Deep and session scans use the active V2 session model. Both cancellation and viewer shutdown still work.

## Repository switching and failure checks

- Start another session in a different repository. `weave_repo` and `/weave-scan` must use that session's directory. Opening its viewer must
  replace the previous repository's viewer rather than leaving the old server running.
- Try a session outside Git: `/weave-scan` should explain that it is not inside a repository; notes and the browser remain usable.
- Try a provider failure during a scan: expect an error or failed-file report, then restore the provider and retry. V1 must remove its
  temporary child session on this path too.

To share a failure, include the host version, command or tool arguments, error text, and whether it occurred in V1 or V2. Keep the
`weave_test` path until finished so the isolated artifacts remain available for inspection. Closing this terminal removes these environment
overrides; your normal profile remains unchanged.
