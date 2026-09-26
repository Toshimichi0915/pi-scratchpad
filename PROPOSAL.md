# Scratchpad directory for Pi — proposal

Port the idea from Claude Code (a per-session temp directory the model is told to use), not the
machinery around it.

- **Phase 0**: a ~40-line extension. No core changes. Creates the directory, names it in the
  system prompt.
- **Phase 1**: export `PI_SCRATCHPAD_DIR` to shell commands, like the existing `PI_SESSION_*`
  variables. Implemented in the same extension (no core patch needed).
- **Do not copy**: auto-cleanup, permission allow-rules (Pi has no permission prompts),
  display-path rewriting.

---

## 1. What Claude Code actually does

Verified against a live Claude Code 2.1.283 install (on-disk layout + strings in the binary) and
the published prompt catalog.

### On disk

```
$TMPDIR/claude-<uid>/<cwd-as-slug>/<session-uuid>/scratchpad
```

with a sibling `tasks/` directory. Live example on this machine:

```
/tmp/claude-1000/-home-toshimichi-orca-workspaces-tera-angelfish/8a9a6f9c-…/scratchpad
```

It is created by `ensureScratchpadDir()` during init (telemetry events `init_scratchpad_created` /
`init_scratchpad_unavailable`) and re-ensured on session switch, gated behind
`isScratchpadEnabled`. Related internals: `getScratchpadDir`, `isScratchpadPath`,
`isScratchpadDisplayPath`, `isScratchpadWrite`.

### In the prompt

Current (2.1.x). The standalone block was folded into the environment guidance (per the
[system-prompt changelog](https://github.com/Piebald-AI/claude-code-system-prompts)):
verbatim text from the binary:

> Scratchpad directory: `<path>`
>   always use it for temporary files (intermediate results, scripts, outputs that don't belong in
>   the project) instead of `/tmp` or other system temp directories; it is session-specific,
>   isolated from the project, and can generally be used without permission prompts. Only use
>   `/tmp` if the user explicitly asks.

Earlier (2.0.x) standalone block, from the
[prompt catalog](https://ccprompts.info/prompts/special/special-scratchpad):

```
# Scratchpad Directory
IMPORTANT: Always use this scratchpad directory for temporary files instead of `/tmp`
or other system temp directories: <path>

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to `/tmp`
```

Subagents/workers get their own block:

> Scratchpad directory: `<path>`
> Workers can generally read and write here without permission prompts. Use this for durable
> cross-worker knowledge — prefer plain data and markdown files.

### Everywhere else it is wired

- **Permissions**: a session allow-rule is installed — "Scratchpad files for current session are
  allowed for writing". It is not a blanket bypass: path-safety screening still applies inside the
  pad ("its name is one the file-edit safety rules screen even in the scratchpad (git, hook, tool,
  and agent settings)").
- **Display**: `isScratchpadDisplayPath` shortens what the user sees; permission prompts annotate
  a file as being in the scratchpad.
- **Transcript UI**: writes there are classified `isScratchpadWrite` and collapsed like memory
  writes, so the transcript is not spammed with `mkdir`/scratch writes.
- **No env var.** The path exists only in the prompt. Feature request
  [#78013](https://github.com/anthropics/claude-code/issues/78013) asks for `CLAUDE_SCRATCHPAD`.

### Known problems — do not replicate

- [#89878](https://github.com/anthropics/claude-code/issues/89878): generated files disappear
  silently; the pad lives under `$TEMP`, routine temp cleanup empties it between sessions.
- [#78475](https://github.com/anthropics/claude-code/issues/78475): the root cannot be set
  independently of `TEMP`; live session state is destroyed by temp cleaners.
- [#78013](https://github.com/anthropics/claude-code/issues/78013): the path is not reachable
  from shell-tool processes.

## 2. Why it works, and which part transfers to Pi

The win is cheap and behavioral: the model gets a *named, sanctioned* place for junk plus an
explicit "instead of `/tmp`" default. That removes two failure modes:

1. temp scripts and checkpoints littering the repo (dirty `git status`, stray untracked files,
   accidental commits);
2. nothing at all — big intermediates dumped into the chat transcript instead of a file.

What does **not** transfer: the permission-prompt rationale. Claude Code sells it partly as "no
prompts inside the scratchpad". Pi has no permission prompts and no sandbox
(`docs/security.md`), so that clause is meaningless here. Pi's headline benefit is (1): keep the
working tree clean. There is also prior demand in Pi itself —
[discussion #6642](https://github.com/earendil-works/pi/discussions/6642) ("Scratchpads?").

Pi-specific extras:

- Subagents and workflows share the session and the cwd. A session scratchpad is a natural
  hand-off place for artifacts between parent and children without touching the working tree —
  the "durable cross-worker knowledge" case above.
- Pi already injects session metadata into shell tools (`PI_SESSION_ID`, `PI_SESSION_FILE`,
  `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` — `docs/environment-variables.md`).
  `PI_SCRATCHPAD_DIR` is the same pattern: one row in that table.

## 3. Proposal

### Phase 0 — an extension (no core changes)

`~/.pi/agent/extensions/scratchpad.ts` (global) or `.pi/extensions/scratchpad.ts` (per project):

```typescript
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = join(homedir(), ".pi", "agent", "scratchpads");

export default function (pi: ExtensionAPI) {
  let dir = "";
  pi.on("session_start", (_event, ctx) => {
    // ponytail: one pad per session, shared by anything spawned in this process
    dir = join(ROOT, ctx.sessionManager.getSessionId());
    mkdirSync(dir, { recursive: true });
  });

  pi.on("before_agent_start", (event) => {
    if (!dir) return;
    event.systemPromptOptions.sections.scratchpad =
      `Scratchpad directory: ${dir}\n` +
      `Always use it for temporary files (intermediate results, scripts, outputs that don't ` +
      `belong in the project) instead of /tmp or other system temp directories. It is ` +
      `session-specific and not part of the project, so nothing written there shows up in git. ` +
      `Only use /tmp if the user explicitly asks.`;
  });
}
```

Try it with `pi -e ./scratchpad.ts`; install by dropping it in the extensions directory
(`/reload` hot-reloads).

Why this shape:

- `sections.scratchpad` is a structured prompt section. Pi diffs sections and patches only what
  changed (`docs/extensions.md`), so the addition is cache-friendly and survives compaction.
  Returning `systemPrompt` instead forces a whole-prompt replacement and a cache miss — avoid.
- The pad lives under `~/.pi/agent/`, **not** `$TMPDIR`, on purpose: the most-reported Claude Code
  complaint is that a temp cleaner wiped live session state. Files stay put until the user deletes
  them; nothing vanishes silently.

### Phase 1 — `PI_SCRATCHPAD_DIR` for shell commands

Bash scripts and `!` commands can then find the pad without the path being spelled out, which is
exactly what [#78013](https://github.com/anthropics/claude-code/issues/78013) asks Claude Code for.

Planned as a core change (compute the path where `PI_SESSION_ID` is computed, add one row to the
table in `docs/environment-variables.md`), but pi builds the shell environment from `process.env`
plus those five session variables (`getShellEnv()` / `resolveSpawnContext` in
`core/tools/bash.js`), so the extension can do it in one line:

```typescript
process.env.PI_SCRATCHPAD_DIR = dir;
```

That reaches every `bash`/`powershell` tool call and `!` user command, and survives pi upgrades.
The upstream core change is still worth doing for users without the extension; it stays a one-row
doc change plus one line where the other `PI_*` values are set.

### Explicitly out of scope

- **Auto-cleanup / sweeping old pads.** Claude Code's #1 complaint is "my files vanished". If disk
  usage ever matters, add a manual `/scratchpad clean` or a 30-day sweep later.
- **Permission allow-rules for the pad.** Pi has no per-path permission prompts; nothing to exempt.
- **Display-path shortening and transcript collapsing of pad writes.** Cosmetic; Claude Code does
  it because it builds a whole UI around it.
- **A dedicated `scratchpad` tool.** `write`/`read`/`bash` already cover it; a tool would be a
  second way to do the same thing.

## 4. Open questions

- **Subagent identity.** Keying by `getSessionId()` lets children share the parent's pad (the
  cross-worker case); `getLeafId()` would give each child its own. Verify with a real subagent run
  and pick whichever shares; the other can be a subdirectory.
- **Ephemeral sessions.** `getSessionFile()` is undefined there; confirm `getSessionId()` is not
  before keying on it.
- **Root layout.** Per-session under a global root is what Claude Code does and is fine. Per-project
  (`<project>/…`) would make the pad easier to find but reintroduces a directory the user did not
  ask for in their tree.

## 5. How we know it works

One manual check, no framework: start pi with the extension, ask it to write and run a throwaway
script. Then confirm (a) the file landed under `~/.pi/agent/scratchpads/<id>/`, (b) `git status`
is still clean, (c) the scratchpad section is present in the session transcript's system message.
