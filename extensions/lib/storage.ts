import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type Storage = "home" | "temp";
export const BUSY_MESSAGE =
	"Cannot migrate the scratchpad while the agent is running. Stop the agent or wait until it stops.";

export function assertIdle(isIdle: () => boolean): void {
	if (!isIdle()) throw new Error(BUSY_MESSAGE);
}

export function readConfig(
	path: string,
): Record<string, unknown> & { storage?: Storage } {
	if (!existsSync(path)) return {};
	const config: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(
			`Invalid configuration in ${path}: expected a JSON object.`,
		);
	}
	const record = config as Record<string, unknown>;
	if (
		record.storage !== undefined &&
		record.storage !== "home" &&
		record.storage !== "temp"
	) {
		throw new Error(`Invalid storage in ${path}: use "home" or "temp".`);
	}
	return record as Record<string, unknown> & { storage?: Storage };
}

function writeConfigBytes(path: string, bytes: Buffer, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const staging = join(dirname(path), `.scratchpad-${randomUUID()}.json`);
	try {
		writeFileSync(staging, bytes, { flag: "wx", mode });
		chmodSync(staging, mode);
		renameSync(staging, path);
	} finally {
		rmSync(staging, { force: true });
	}
}

/** Return an undo operation for activation failures. Do not overwrite concurrent edits. */
export function saveConfig(path: string, storage: Storage): () => void {
	const config = readConfig(path);
	const original = existsSync(path) ? readFileSync(path) : undefined;
	const originalMode = original ? lstatSync(path).mode & 0o777 : 0o600;
	const updated = Buffer.from(
		`${JSON.stringify({ ...config, storage }, null, 2)}\n`,
	);
	writeConfigBytes(path, updated, originalMode);
	return () => {
		if (!existsSync(path) || !readFileSync(path).equals(updated)) {
			throw new Error(
				`Cannot restore ${path}: configuration changed after migration started.`,
			);
		}
		if (original) writeConfigBytes(path, original, originalMode);
		else rmSync(path);
	};
}

function validateSessionId(sessionId: string): void {
	if (
		!sessionId ||
		basename(sessionId) !== sessionId ||
		sessionId === "." ||
		sessionId === ".."
	) {
		throw new Error("Invalid scratchpad session identifier.");
	}
}

export interface StorageRoots {
	home: string;
	temp: string;
}

export function systemRoots(): StorageRoots {
	return { home: homedir(), temp: tmpdir() };
}

export function newDirectory(
	storage: Storage,
	sessionId: string,
	roots: StorageRoots = systemRoots(),
): string {
	validateSessionId(sessionId);
	if (storage === "home")
		return join(roots.home, ".pi", "agent", "scratchpads", sessionId);
	// mkdtemp creates a private, unpredictable directory in potentially shared temp storage.
	return join(mkdtempSync(join(roots.temp, "pi-scratchpad-")), sessionId);
}

export interface ScratchpadState {
	dir: string;
	storage: Storage;
}

export function parseState(data: unknown): ScratchpadState {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Invalid saved scratchpad location.");
	}
	const state = data as Record<string, unknown>;
	if (
		typeof state.dir !== "string" ||
		!isAbsolute(state.dir) ||
		(state.storage !== "home" && state.storage !== "temp")
	) {
		throw new Error("Invalid saved scratchpad location.");
	}
	return { dir: state.dir, storage: state.storage };
}

function checkDirectory(path: string, privateDirectory: boolean): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(
			`Unsafe scratchpad directory: ${path}. Expected a directory without symbolic links.`,
		);
	}
	if (process.platform !== "win32") {
		const uid = process.geteuid?.() ?? process.getuid?.();
		if (uid === undefined || stat.uid !== uid) {
			throw new Error(
				`Unsafe scratchpad directory: ${path}. The current user must own it.`,
			);
		}
		const forbidden = privateDirectory ? 0o077 : 0o022;
		if ((stat.mode & forbidden) !== 0) {
			throw new Error(
				`Unsafe scratchpad permissions: ${path}. Other users must not ${privateDirectory ? "access" : "write to"} it.`,
			);
		}
	}
	return true;
}

export function prepareDirectory(
	storage: Storage,
	sessionId: string,
	savedPath?: string,
	roots: StorageRoots = systemRoots(),
): { dir: string; replaced: boolean } {
	validateSessionId(sessionId);
	if (storage === "home") {
		const expected = resolve(
			join(roots.home, ".pi", "agent", "scratchpads", sessionId),
		);
		if (savedPath !== undefined && savedPath !== expected)
			throw new Error(
				"Saved home scratchpad path does not match this session.",
			);
		let path = resolve(roots.home);
		checkDirectory(path, false);
		for (const component of [".pi", "agent", "scratchpads", sessionId]) {
			path = join(path, component);
			if (!checkDirectory(path, false)) mkdirSync(path, { mode: 0o700 });
			checkDirectory(path, false);
		}
		return { dir: expected, replaced: false };
	}
	if (savedPath !== undefined) {
		const parent = dirname(savedPath);
		if (
			savedPath !== resolve(savedPath) ||
			basename(savedPath) !== sessionId ||
			dirname(parent) !== resolve(roots.temp) ||
			!/^pi-scratchpad-[A-Za-z0-9]{6}$/.test(basename(parent))
		) {
			throw new Error(
				"Saved temporary scratchpad path does not match this session or the current temporary root.",
			);
		}
		if (checkDirectory(parent, true) && checkDirectory(savedPath, true)) {
			return { dir: savedPath, replaced: false };
		}
	}
	const dir = newDirectory("temp", sessionId, roots);
	mkdirSync(dir, { mode: 0o700 });
	checkDirectory(dirname(dir), true);
	checkDirectory(dir, true);
	return { dir, replaced: savedPath !== undefined };
}

function manifest(root: string): string {
	const entries: unknown[] = [];
	function visit(relative: string): void {
		const path = join(root, relative);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink())
			throw new Error(`Cannot migrate symbolic link: ${path}`);
		if (stat.isDirectory()) {
			entries.push([relative, "directory", stat.mode & 0o777]);
			for (const name of readdirSync(path).sort()) visit(join(relative, name));
		} else if (stat.isFile()) {
			entries.push([
				relative,
				"file",
				stat.mode & 0o777,
				createHash("sha256").update(readFileSync(path)).digest("hex"),
			]);
		} else {
			throw new Error(`Cannot migrate special file: ${path}`);
		}
	}
	visit("");
	return JSON.stringify(entries);
}

function preserveDirectoryModes(source: string, destination: string): void {
	for (const name of readdirSync(source)) {
		const sourceChild = join(source, name);
		if (lstatSync(sourceChild).isDirectory()) {
			preserveDirectoryModes(sourceChild, join(destination, name));
		}
	}
	chmodSync(destination, lstatSync(source).mode & 0o777);
}

export function copyForMigration(source: string, destination: string): void {
	if (existsSync(destination))
		throw new Error(`Scratchpad destination already exists: ${destination}`);
	const before = manifest(source);
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const staging = mkdtempSync(
		join(dirname(destination), ".scratchpad-migrate-"),
	);
	const copy = join(staging, "files");
	try {
		cpSync(source, copy, {
			recursive: true,
			preserveTimestamps: true,
			errorOnExist: true,
			force: false,
		});
		preserveDirectoryModes(source, copy);
		if (manifest(source) !== before || manifest(copy) !== before) {
			throw new Error(
				"Scratchpad verification failed. The original directory remains active.",
			);
		}
		if (existsSync(destination))
			throw new Error(`Scratchpad destination already exists: ${destination}`);
		renameSync(copy, destination);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

export const SCRATCHPAD_PROMPT = [
	"Use the scratchpad for temporary scripts, intermediate results, and files outside the project.",
	"PI_SCRATCHPAD_DIR contains the current scratchpad directory. The directory can change during this session.",
	"Always access the scratchpad through this environment variable. Never hard-code its absolute path.",
	'In POSIX shell commands, use quoted references such as "$PI_SCRATCHPAD_DIR/script.py".',
	"In PowerShell, use $env:PI_SCRATCHPAD_DIR with Join-Path. In Node or Bun, read process.env.PI_SCRATCHPAD_DIR.",
	'In Python, read os.environ["PI_SCRATCHPAD_DIR"]. Resolve the variable when each operation starts.',
	"Do not retain its resolved value across commands. Do not embed resolved paths in scripts or configuration files.",
	"File tools do not expand environment variables. Read the current variable immediately before supplying a file-tool path.",
	"Do not reuse a resolved path from an earlier operation after storage changes.",
	"Use another temporary directory only when the user explicitly requests it.",
].join("\n");
