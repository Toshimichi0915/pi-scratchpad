# pi-scratchpad

A [pi](https://pi.dev) extension that gives each session its own scratchpad directory: a place
for temporary scripts and intermediate files that stays out of your project.

- creates `~/.pi/agent/scratchpads/<session-id>/` at session start
- names it in a `<scratchpad>` system prompt section, as the default instead of `/tmp`
- exports it to shell commands as `$PI_SCRATCHPAD_DIR`

Nothing in it shows up in `git status`, and nothing is cleaned up automatically.

## Install

```bash
pi install npm:pi-scratchpad
```
