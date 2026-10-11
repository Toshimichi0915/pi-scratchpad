# pi-scratchpad

A [pi](https://pi.dev) extension that gives each session a scratchpad directory for temporary scripts and intermediate files outside your project.

- defaults to `~/.pi/agent/scratchpads/<session-id>/`
- exports the active directory as `PI_SCRATCHPAD_DIR`
- instructs the agent to use the variable instead of hard-coded paths

## Install

```bash
pi install npm:pi-scratchpad
```

## Configure storage

Run `/scratchpad` to choose home or system temporary storage. Apply the change to new sessions, or move the current session's files immediately without a reload.

The preference is saved in `<agent-dir>/scratchpad.json`, normally `~/.pi/agent/scratchpad.json`. You can also edit it directly:

```json
{ "storage": "temp" }
```

Use `"home"` for the default. Temporary storage uses `os.tmpdir()` and respects the system's temporary-directory settings. Typical locations are `/tmp` on Linux, a per-user directory under `/var/folders` on macOS, and `%TEMP%` on Windows.

Migration requires an idle agent. Stop background processes that use the scratchpad first. Existing processes retain the old environment, and migration does not rewrite absolute paths inside files.

The extension does not clean up files automatically. The OS can remove temporary storage. Resume then creates a fresh directory, without recovering the old files.
