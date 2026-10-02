import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = join(homedir(), ".pi", "agent", "scratchpads");

export default function (pi: ExtensionAPI) {
	let dir = "";

	pi.on("session_start", (_event, ctx) => {
		// ponytail: one pad per session; anything spawned in this process shares it
		dir = join(ROOT, ctx.sessionManager.getSessionId());
		mkdirSync(dir, { recursive: true });
		// pi builds shell env from process.env (getShellEnv), so this reaches every
		// bash/powershell command and `!` user commands
		process.env.PI_SCRATCHPAD_DIR = dir;
	});

	pi.on("before_agent_start", (event) => {
		if (!dir) return;
		const text =
			`Scratchpad directory: ${dir}\n` +
			`Always use it for temporary files (intermediate results, scripts, outputs that don't belong ` +
			`in the project) instead of /tmp or other system temp directories. It is session-specific ` +
			`and not part of the project, so nothing written there shows up in git. Shell commands see ` +
			`it as $PI_SCRATCHPAD_DIR. Only use /tmp if the user explicitly asks.`;
		event.systemPromptOptions.sections.scratchpad = text;
		// An earlier before_agent_start handler (e.g. ponytail) may have returned systemPrompt,
		// freezing the request's prompt text; later section mutations only reach the transcript.
		// Mirror the section into the forced prompt so it still reaches the model (Pi 1.0.0+).
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			event.systemPromptOptions.forceSystemPrompt += `\n\n<scratchpad>\n${text}\n</scratchpad>`;
		}
	});
}
