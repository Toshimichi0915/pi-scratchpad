import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	assertIdle,
	copyForMigration,
	newDirectory,
	parseState,
	prepareDirectory,
	readConfig,
	SCRATCHPAD_PROMPT,
	type ScratchpadState,
	type Storage,
	saveConfig,
	systemRoots,
} from "./lib/storage.ts";

export default function (pi: ExtensionAPI): void {
	const roots = systemRoots();
	let dir = "";
	let storage: Storage = "home";
	const configPath = join(getAgentDir(), "scratchpad.json");

	function setActiveLocation(next: ScratchpadState): void {
		dir = next.dir;
		storage = next.storage;
		process.env.PI_SCRATCHPAD_DIR = dir;
	}

	function activate(next: ScratchpadState): void {
		pi.appendEntry<ScratchpadState>("scratchpad-location", next);
		setActiveLocation(next);
	}

	pi.on("session_start", (_event, ctx) => {
		const saved = ctx.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === "scratchpad-location",
			)
			.pop();
		dir = "";
		delete process.env.PI_SCRATCHPAD_DIR;
		const state = saved?.type === "custom" ? parseState(saved.data) : undefined;
		const selectedStorage =
			state?.storage ?? readConfig(configPath).storage ?? "home";
		const prepared = prepareDirectory(
			selectedStorage,
			ctx.sessionManager.getSessionId(),
			state?.dir,
			roots,
		);
		if (!state || prepared.replaced) {
			try {
				activate({ dir: prepared.dir, storage: selectedStorage });
			} catch (error) {
				if (selectedStorage === "temp")
					rmSync(dirname(prepared.dir), { recursive: true, force: true });
				throw error;
			}
		} else {
			setActiveLocation({ dir: prepared.dir, storage: selectedStorage });
		}
		if (prepared.replaced) {
			ctx.ui.notify(
				`The temporary scratchpad no longer exists. Created a new private directory at ${dir}. Previous temporary files are unavailable.`,
				"warning",
			);
		}
	});

	pi.registerCommand("scratchpad", {
		description:
			"Configure scratchpad storage and migrate this session's files",
		handler: async (_args, ctx) => {
			try {
				assertIdle(() => ctx.isIdle());
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Edit ${configPath} to configure scratchpad storage.`,
						"warning",
					);
					return;
				}
				const preference = readConfig(configPath).storage ?? "home";
				const options = [
					`Home directory — persistent${preference === "home" ? " (saved preference)" : ""}`,
					`System temporary directory — OS may remove files${preference === "temp" ? " (saved preference)" : ""}`,
				];
				const selected = await ctx.ui.select("Scratchpad storage", options);
				if (selected === undefined) return;
				const nextStorage: Storage = selected === options[0] ? "home" : "temp";
				let migrate = false;
				if (nextStorage !== storage) {
					const choice = await ctx.ui.select(
						"Apply storage change? Stop background work before migration.",
						[
							"Switch now and move existing files",
							"Apply to new sessions only",
						],
					);
					if (choice === undefined) return;
					migrate = choice === "Switch now and move existing files";
				}
				// The agent can start while a dialog is open. Check again before any mutation.
				assertIdle(() => ctx.isIdle());
				if (!migrate) {
					if (nextStorage !== preference) saveConfig(configPath, nextStorage);
					ctx.ui.notify(
						`Saved ${nextStorage} storage. This session still uses ${dir}.`,
						"info",
					);
					return;
				}
				const source = dir;
				const destination = newDirectory(
					nextStorage,
					ctx.sessionManager.getSessionId(),
					roots,
				);
				let undoPreference: (() => void) | undefined;
				let copied = false;
				try {
					copyForMigration(source, destination);
					copied = true;
					undoPreference = saveConfig(configPath, nextStorage);
					activate({ dir: destination, storage: nextStorage });
				} catch (error) {
					const failures = [
						error instanceof Error ? error.message : String(error),
					];
					try {
						undoPreference?.();
					} catch (rollbackError) {
						failures.push(`Preference rollback failed: ${rollbackError}`);
					}
					if (copied || nextStorage === "temp") {
						try {
							rmSync(
								nextStorage === "temp" ? dirname(destination) : destination,
								{ recursive: true, force: true },
							);
						} catch (cleanupError) {
							failures.push(
								`Destination cleanup failed at ${destination}: ${cleanupError}`,
							);
						}
					}
					throw new Error(failures.join(" "));
				}
				try {
					rmSync(source, { recursive: true });
				} catch (error) {
					ctx.ui.notify(
						`Migration succeeded, but the old directory remains at ${source}: ${error}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					`Scratchpad files moved. This session now uses ${destination}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Scratchpad: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!dir) return;
		event.systemPromptOptions.sections.scratchpad = SCRATCHPAD_PROMPT;
		// Mirror the section when an earlier extension forced the request prompt.
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			event.systemPromptOptions.forceSystemPrompt += `\n\n<scratchpad>\n${SCRATCHPAD_PROMPT}\n</scratchpad>`;
		}
	});
}
