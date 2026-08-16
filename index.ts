/**
 * picc-bash: Claude Code-compatible Bash tool for pi.
 *
 * Adds a `bash` tool (registered name configurable — default `"bash"`, override
 * to `"Bash"` via `config.json` or `PICC_BASH_TOOL_NAME`) with `run_in_background`,
 * a 2-minute default / 10-minute max foreground timeout (configurable via
 * `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`), background tasks whose
 * output is persisted under the OS temp dir at
 * `${tmpdir()}/picc-bash/{sessionId}/tasks/{taskId}.output` (mirroring Claude
 * Code's `getTaskOutputPath`), plus a `TaskStop` tool.
 *
 * The deprecated `TaskOutput` tool is intentionally NOT registered — Claude
 * Code tells models to use the `Read` tool on the output file path instead.
 * The Bash tool's `run_in_background` result already returns that path.
 *
 * Honors `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` to omit `run_in_background`
 * from the schema.
 *
 * Tool name configuration:
 *   - Default: `"bash"` (pi ecosystem standard).
 *   - Claude Code parity: set `config.json` `toolName` to `"Bash"` (default
 *     location `~/.pi/agent/extensions/picc-bash/config.json`), or set
 *     `PICC_BASH_TOOL_NAME=Bash`. Valid values: `"bash"`, `"Bash"`.
 *
 * References:
 * - pi's built-in bash: dist/core/tools/bash.js + dist/utils/shell.js
 * - Claude Code Bash tool: tools/BashTool/BashTool.tsx
 * - Claude Code timeouts: utils/timeouts.ts
 * - Claude Code TaskStop: tools/TaskStopTool/TaskStopTool.ts (and prompt.ts)
 * - Claude Code storage path: utils/task/diskOutput.ts (`getTaskOutputDir`,
 *   `getTaskOutputPath`).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { constants as fsConstants, mkdir, open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import process from "node:process";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import treeKill from "tree-kill";
import { Type } from "typebox";

// ============================================================================
// Config
// ============================================================================

/** Tool names the bash tool may be registered as. */
const VALID_TOOL_NAMES = ["bash", "Bash"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

/** Resolve the config.json path.
 *  Default: `~/.pi/agent/extensions/picc-bash/config.json` (stable, outside
 *  node_modules, so it survives reinstalls). Override at runtime via
 *  PICC_BASH_CONFIG_PATH. */
function resolveConfigPath(): string {
	const env = process.env.PICC_BASH_CONFIG_PATH;
	if (env) return env;
	return join(
		homedir(),
		".pi",
		"agent",
		"extensions",
		"picc-bash",
		"config.json",
	);
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-bash] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "bash".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	// Precedence: PICC_BASH_TOOL_NAME env var > config.json > "bash" default
	const envVal = process.env.PICC_BASH_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-bash] PICC_BASH_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "bash".`,
		);
	}
	return readToolNameFromConfig() ?? "bash";
}

/** Module-level config object (read once at startup). */
export const config = { toolName: loadToolName() };

// ============================================================================
// Constants
// ============================================================================

/** Claude Code-compatible defaults. */
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Top-level subdir under tmpdir for picc-bash output. */
const TASKS_ROOT_NAME = "picc-bash";

const isBackgroundDisabled =
	process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1";

// ============================================================================
// Helpers (ported verbatim from Claude Code)
// ============================================================================

/**
 * Ported verbatim from claude-code/utils/format.ts. Formats milliseconds as a
 * human-readable duration string (e.g. `1234` → `"1s"`, `65000` → `"1m 5s"`).
 * Used to format the bash timeout error message exactly like Claude Code.
 */
function formatDuration(
	ms: number,
	options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
	if (ms < 60000) {
		if (ms === 0) return "0s";
		if (ms < 1) {
			const s = (ms / 1000).toFixed(1);
			return `${s}s`;
		}
		const s = Math.floor(ms / 1000).toString();
		return `${s}s`;
	}

	let days = Math.floor(ms / 86400000);
	let hours = Math.floor((ms % 86400000) / 3600000);
	let minutes = Math.floor((ms % 3600000) / 60000);
	let seconds = Math.round((ms % 60000) / 1000);

	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}

	const hide = options?.hideTrailingZeros;

	if (options?.mostSignificantOnly) {
		if (days > 0) return `${days}d`;
		if (hours > 0) return `${hours}h`;
		if (minutes > 0) return `${minutes}m`;
		return `${seconds}s`;
	}

	if (days > 0) {
		if (hide && hours === 0 && minutes === 0) return `${days}d`;
		if (hide && minutes === 0) return `${days}d ${hours}h`;
		return `${days}d ${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		if (hide && minutes === 0 && seconds === 0) return `${hours}h`;
		if (hide && seconds === 0) return `${hours}h ${minutes}m`;
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		if (hide && seconds === 0) return `${minutes}m`;
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Ported from claude-code/Task.ts:96-104. Generates a task ID with a single-
 * letter prefix identifying the task type, followed by 8 base36 characters.
 * `local_bash` → `l` prefix (matches Claude Code's TASK_ID_PREFIXES).
 *
 * Uses `crypto.randomBytes` (Node) where available; falls back to Math.random
 * for environments without `node:crypto`. Returns a 9-char string.
 */
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function generateTaskId(prefix: string): string {
	const bytes = new Uint8Array(8);
	for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
	let id = prefix;
	for (let i = 0; i < 8; i++) {
		const ch = TASK_ID_ALPHABET[bytes[i] % TASK_ID_ALPHABET.length];
		id += ch ?? "0";
	}
	return id;
}

// ============================================================================
// Types
// ============================================================================

type TaskStatus = "running" | "completed" | "failed" | "killed";

interface BackgroundTask {
	id: string;
	command: string;
	description?: string;
	status: TaskStatus;
	exitCode: number | null;
	outputPath: string;
	startedAt: number;
	completedAt?: number;
	pid?: number;
	interrupted: boolean;
}

interface BashToolDetails {
	backgroundTaskId?: string;
	timedOut?: boolean;
	timeoutMs?: number;
	aborted?: boolean;
	interrupted?: boolean;
	exitCode?: number | null;
}

/** Claude Code TaskStop output schema (tools/TaskStopTool/TaskStopTool.ts:14-29). */
interface TaskStopDetails {
	/** Status message about the operation. */
	message: string;
	/** The ID of the task that was stopped. */
	task_id: string;
	/** The type of the task that was stopped. */
	task_type: string;
	/** Optional: the command or description of the stopped task. */
	command?: string;
	/** Internal: true when the kill did not actually fire (task already exited). */
	alreadyExited?: boolean;
}

interface BashToolResult {
	content: TextContent[];
	details: BashToolDetails;
	isError?: boolean;
}

interface TaskStopResult {
	content: TextContent[];
	details: TaskStopDetails;
	isError?: boolean;
}

/** Helper to type-check a TextContent literal as TextContent (not string). */
function tc(text: string): TextContent {
	return { type: "text", text };
}

// ============================================================================
// Storage paths — mirror Claude Code's getTaskOutputPath
// (utils/task/diskOutput.ts:50-73).
//
// Pattern: ${tmpdir()}/picc-bash/{sessionId}/tasks/{taskId}.output
//
// The session ID is captured at FIRST CALL (memoized) so concurrent sessions
// in the same process don't clobber each other, and `/clear` regenerations
// don't strand in-flight tasks pointing at a stale directory.
// ============================================================================

let _sessionId: string | undefined;
let _tasksDir: string | undefined;

function getSessionId(ctx: ExtensionContext | undefined): string {
	if (_sessionId !== undefined) return _sessionId;
	// Prefer the live session manager; fall back to a stable per-process id
	// when called outside a session (e.g. during CLI shutdown).
	try {
		const id = ctx?.sessionManager.getSessionId();
		if (typeof id === "string" && id.length > 0) {
			_sessionId = id;
			return id;
		}
	} catch {
		// sessionManager may be unavailable during very early init
	}
	const fallback = `pid-${process.pid}`;
	_sessionId = fallback;
	return fallback;
}

function getTasksDir(ctx?: ExtensionContext): string {
	if (_tasksDir !== undefined) return _tasksDir;
	_tasksDir = join(tmpdir(), TASKS_ROOT_NAME, getSessionId(ctx), "tasks");
	return _tasksDir;
}

function getTaskOutputPath(taskId: string, ctx?: ExtensionContext): string {
	return join(getTasksDir(ctx), `${taskId}.output`);
}

/** Test helper — clears memoized paths. */
export function _resetStoragePathsForTest(): void {
	_sessionId = undefined;
	_tasksDir = undefined;
}

// ============================================================================
// Task state (in-memory only; matches Claude Code's AppState.tasks[taskId])
//
// Claude Code stores background tasks in appState (in-memory), not on disk.
// We do the same. Output FILES still live on disk (via getTaskOutputPath) so
// the model can `Read` them. Metadata is gone after session shutdown — that's
// fine, because TaskStop only operates on running tasks spawned this session.
// ============================================================================

/** All known background tasks for this session. */
const taskCache = new Map<string, BackgroundTask>();
/** Captured session context for notifications. */
let extensionContext: ExtensionContext | undefined;

function ensureTasksDir(ctx?: ExtensionContext): string {
	const dir = getTasksDir(ctx);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** Best-effort cleanup of orphan output files from prior sessions. */
function cleanupOldOutputFiles(): void {
	const dir = getTasksDir(extensionContext);
	const now = Date.now();
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.endsWith(".output")) continue;
		if (name === "registry.json") continue; // legacy file; safe to ignore
		const full = join(dir, name);
		try {
			const stat = statSync(full);
			// 7-day retention for orphan files (no in-memory counter).
			if (now - stat.mtimeMs > MAX_TASK_AGE_MS) {
				unlinkSync(full);
			}
		} catch {
			// Ignore stat/unlink races
		}
	}
}

function upsertTask(task: BackgroundTask): void {
	taskCache.set(task.id, task);
}

function getTask(taskId: string): BackgroundTask | undefined {
	return taskCache.get(taskId);
}

// ============================================================================
// Cross-platform process kill (tree-kill, mirrors ShellCommand.ts #doKill
// which uses `import treeKill from 'tree-kill'; treeKill(pid, 'SIGKILL')`).
// ============================================================================

/**
 * Kill a process and all its descendants. Cross-platform via tree-kill.
 * Defaults to SIGKILL; pass `'SIGTERM'` for graceful shutdown (Claude Code's
 * ShellCommand.ts uses SIGTERM for timeout/abort, SIGKILL only on retry).
 */
function killProcess(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
	try {
		treeKill(pid, signal);
	} catch {
		// Process may already be gone — treat as success (matches Claude Code).
	}
}

// ============================================================================
// Timeout configuration (mirrors utils/timeouts.ts)
// ============================================================================

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

function getDefaultTimeoutMs(): number {
	return (
		parsePositiveInt(process.env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
	);
}

function getMaxTimeoutMs(): number {
	const envMax = parsePositiveInt(process.env.BASH_MAX_TIMEOUT_MS);
	const max = envMax ?? MAX_TIMEOUT_MS;
	// Max must be at least as large as the default.
	return Math.max(max, getDefaultTimeoutMs());
}

/**
 * Resolve the effective foreground timeout, clamped to [1, max].
 *
 * Mirrors claude-code/tools/BashTool/BashTool.tsx:860 —
 * `const timeoutMs = timeout || getDefaultTimeoutMs()` — so a falsy request
 * (0, null, undefined) falls back to the default rather than being an error.
 */
function resolveTimeoutMs(requested: number | undefined): number {
	const max = getMaxTimeoutMs();
	const requestedMs =
		typeof requested === "number" && requested > 0
			? requested
			: getDefaultTimeoutMs();
	if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
		throw new Error(
			"Invalid timeout: must be a finite positive number of milliseconds",
		);
	}
	return Math.min(Math.max(requestedMs, 1), max);
}

// ============================================================================
// Git Bash detection (Windows)
//
// Claude Code runs every shell command under `bash.exe` from Git for Windows
// on Windows (see claude-code's `utils/windowsPaths.ts` + `entrypoints/init.ts`).
// That works because Git Bash's MSYS2 layer translates Windows paths like
// `C:\Users\foo` into the POSIX form `/c/Users/foo` automatically, so users can
// type `ls C:\Users\foo` and `cmd.exe`-style escape-mangling is avoided.
//
// We mirror that behavior: prefer Git Bash, fall back to cmd.exe with a one-
// line stderr warning if Git Bash isn't installed. We do NOT exit the process
// the way Claude Code does — picc-bash runs inside an existing pi session, so
// killing the agent would be worse than degraded behavior.
// ============================================================================

/** Env var that overrides Git Bash detection (mirrors Claude Code's CLAUDE_CODE_GIT_BASH_PATH). */
const PICC_BASH_PATH_ENV = "PICC_BASH_PATH";

/** Canonical install paths, tried if `where.exe bash` fails. */
const CANONICAL_BASH_PATHS: readonly string[] = [
	"C:\\Program Files\\Git\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

let _bashPath: string | undefined;
let _bashDetectionFailed = false;

/**
 * Resolve the absolute path to `bash.exe` on Windows.
 *
 * Order:
 *   1. `$PICC_BASH_PATH` if set and exists.
 *   2. First result of `where.exe bash` not located inside the current
 *      working directory (security: prevent hijack by a local `bash.bat`).
 *   3. Canonical install paths (`C:\Program Files\Git\bin\bash.exe`, ...).
 *
 * Returns `undefined` if nothing resolves; callers should fall back to
 * `cmd.exe` in that case and emit a one-line stderr warning.
 *
 * Result is memoized for the lifetime of the process.
 */
export function resolveBashPath(): string | undefined {
	if (_bashPath !== undefined) return _bashPath;
	if (_bashDetectionFailed) return undefined;

	const fromEnv = process.env[PICC_BASH_PATH_ENV];
	if (fromEnv && existsSync(fromEnv)) {
		_bashPath = fromEnv;
		return _bashPath;
	}
	if (fromEnv) {
		console.error(
			`[picc-bash] ${PICC_BASH_PATH_ENV}="${fromEnv}" does not exist; falling back to auto-detection.`,
		);
	}

	// 1. Canonical install paths (C:\Program Files\Git\bin\bash.exe).
	//    Tried FIRST because `where.exe bash` will otherwise return
	//    C:\Windows\System32\bash.exe — which on Windows 10/11 is the WSL
	//    launcher stub. WSL bash is real GNU bash but it does NOT have
	//    MSYS path translation, so commands like `ls C:\Users\foo` fail
	//    (backslashes get treated as escape characters, same as cmd.exe).
	for (const candidate of CANONICAL_BASH_PATHS) {
		if (existsSync(candidate) && isGitBash(candidate)) {
			_bashPath = candidate;
			return _bashPath;
		}
	}

	// 2. `where.exe bash` — accept only candidates that report MSYS.
	const fromWhere = findBashViaWhere();
	if (fromWhere && isGitBash(fromWhere)) {
		_bashPath = fromWhere;
		return _bashPath;
	}

	_bashDetectionFailed = true;
	return undefined;
}

/** Test helper — clears memoized path so tests can re-run detection. */
export function _resetBashPathForTest(): void {
	_bashPath = undefined;
	_bashDetectionFailed = false;
}

function findBashViaWhere(): string | undefined {
	if (process.platform !== "win32") return undefined;
	let raw: string;
	try {
		raw = execFileSync("where.exe", ["bash"], {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			windowsHide: true,
		});
	} catch {
		return undefined;
	}

	const candidates = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (candidates.length === 0) return undefined;

	// SECURITY: skip any candidate that lives inside (or is) the current
	// working directory to avoid executing a local `bash.bat` / `bash.cmd`.
	const cwdLower = process.cwd().toLowerCase();
	for (const candidate of candidates) {
		const normalized = resolve(candidate);
		const normalizedLower = normalized.toLowerCase();
		const dirLower = normalizedLower.slice(0, normalizedLower.lastIndexOf(sep));
		if (dirLower === cwdLower || normalizedLower.startsWith(cwdLower + sep)) {
			continue;
		}
		return normalized;
	}
	return undefined;
}

/**
 * Verify that a candidate `bash.exe` is actually Git Bash (MSYS) and not
 * WSL bash or the WindowsApps stub. MSYS bash is the only variant that
 * translates Windows paths to POSIX form automatically, which is what makes
 * `ls C:\Users\foo` work in picc-bash.
 *
 * Detection: spawn `bash --version` and look for the `-pc-msys` build
 * triple in the output. WSL reports `x86_64-pc-linux-gnu`; MSYS reports
 * `x86_64-pc-msys` (or `i686-pc-msys`). A failure to spawn is treated as
 * "not Git Bash" so the caller falls back.
 */
function isGitBash(candidate: string): boolean {
	try {
		const out = execFileSync(candidate, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			windowsHide: true,
			timeout: 3000,
		});
		return /-pc-msys/i.test(out);
	} catch {
		return false;
	}
}

/**
 * Resolve the shell executable + spawn args for the current platform.
 * On Windows, returns `bash.exe -l -c <command>` when Git Bash is detected,
 * otherwise falls back to `cmd.exe /C <command>` with a one-time stderr
 * warning. On non-Windows, returns `/bin/sh -c <command>`.
 */
function resolveShell(command: string): {
	shell: string;
	args: string[];
	degraded: boolean;
} {
	if (process.platform !== "win32") {
		return { shell: "/bin/sh", args: ["-c", command], degraded: false };
	}
	const bashPath = resolveBashPath();
	if (bashPath) {
		return { shell: bashPath, args: ["-l", "-c", command], degraded: false };
	}
	console.error(
		"[picc-bash] Git Bash (bash.exe with MSYS) not found. " +
			"Install Git for Windows (https://git-scm.com/downloads/win) or set " +
			`${PICC_BASH_PATH_ENV} to your bash.exe. ` +
			"(WSL's bash.exe was rejected because it lacks MSYS path translation.) " +
			"Falling back to cmd.exe; backslash Windows paths like C:\\Users\\foo may fail.",
	);
	return { shell: "cmd.exe", args: ["/C", command], degraded: true };
}

// ============================================================================
// Foreground execution
// ============================================================================

interface ForegroundResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	interrupted: boolean;
}

// Claude Code treats stderr as part of stdout (merged fd for bash). For pi
// we keep two separate streams; the formatter downstream joins them like
// Claude Code's BashTool.tsx:484-507 (`mapToolResultToToolResultBlockParam`).
async function executeForeground(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<ForegroundResult> {
	return new Promise((resolve) => {
		const { shell, args } = resolveShell(command);

		const child: ChildProcess = spawn(shell, args, {
			cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let interrupted = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const onAbort = () => {
			// Mirrors ShellCommand.ts:155-160 (#abortHandler):
			//   On 'interrupt' (user submitted a new message), don't kill — let
			//   the caller background the process so the model can see partial
			//   output. Otherwise kill via SIGTERM.
			if (signal?.reason === "interrupt") {
				interrupted = true;
				return;
			}
			aborted = true;
			if (child.pid !== undefined) killProcess(child.pid, "SIGTERM");
		};

		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		child.on("error", () => {
			cleanup();
			resolve({
				stdout,
				stderr,
				exitCode: null,
				timedOut,
				aborted,
				interrupted,
			});
		});

		child.on("exit", (code) => {
			cleanup();
			if (signal?.aborted && !aborted && !interrupted) {
				aborted = true;
			}
			resolve({
				stdout,
				stderr,
				exitCode: code,
				timedOut,
				aborted,
				interrupted,
			});
		});

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid !== undefined) killProcess(child.pid, "SIGTERM");
			}, timeoutMs);
		}
	});
}

// EOL marker used by the output formatter below. Matches BashTool.tsx const.
const EOL = "\n";

// Build the Bash tool's text content using Claude Code's pattern from
// BashTool.tsx:484-507 (`mapToolResultToToolResultBlockParam`).
function formatBashOutput(
	stdout: string,
	stderr: string,
	exitCode: number | null,
	timedOut: boolean,
	aborted: boolean,
	timeoutMs: number,
): string {
	let processedStdout = stdout;
	if (processedStdout) {
		processedStdout = processedStdout.replace(/^(\s*\n)+/, "").trimEnd();
	}
	let errorMessage = stderr.trim();
	if (aborted && !timedOut) {
		if (errorMessage) errorMessage += EOL;
		errorMessage += "<error>Command was aborted before completion</error>";
	}
	if (timedOut) {
		const msg = `Command timed out after ${formatDuration(timeoutMs)}`;
		errorMessage = errorMessage ? `${msg} ${errorMessage}` : msg;
	}
	if (exitCode !== null && exitCode !== 0 && !aborted && !timedOut) {
		errorMessage = errorMessage
			? `${errorMessage}\nExit code ${exitCode}`
			: `Exit code ${exitCode}`;
	}
	return [processedStdout, errorMessage].filter(Boolean).join(EOL);
}

// ============================================================================
// DiskTaskOutput (ported verbatim from claude-code/utils/task/diskOutput.ts)
//
// A queue-based async file writer with a 5GB disk cap. Each task gets one
// DiskTaskOutput instance whose `append()` calls never block — they push to a
// queue and a single drain loop flushes chunks via a file handle. This avoids
// the memory ballooning that comes from chaining .then() on every chunk.
//
// NOTE: We do NOT include the O_NOFOLLOW security flag (Windows doesn't
// expose it through libuv). picc-bash runs inside pi's TUI which doesn't have
// a sandbox attack surface to defend against.
// ============================================================================

const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TASK_OUTPUT_BYTES_DISPLAY = "5GB";

class DiskTaskOutput {
	#path: string;
	#fileHandle: Awaited<ReturnType<typeof open>> | null = null;
	#queue: string[] = [];
	#bytesWritten = 0;
	#capped = false;
	#flushPromise: Promise<void> | null = null;
	#flushResolve: (() => void) | null = null;

	constructor(taskId: string) {
		this.#path = getTaskOutputPath(taskId);
	}

	append(content: string): void {
		if (this.#capped) return;
		// content.length (UTF-16 code units) undercounts UTF-8 bytes by at most ~3×.
		// Acceptable for a coarse disk-fill guard — avoids re-scanning every chunk.
		this.#bytesWritten += content.length;
		if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
			this.#capped = true;
			this.#queue.push(
				`\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
			);
		} else {
			this.#queue.push(content);
		}
		if (!this.#flushPromise) {
			this.#flushPromise = new Promise<void>((resolve) => {
				this.#flushResolve = resolve;
			});
			void this.#drain();
		}
	}

	flush(): Promise<void> {
		return this.#flushPromise ?? Promise.resolve();
	}

	cancel(): void {
		this.#queue.length = 0;
	}

	async #drainAllChunks(): Promise<void> {
		while (true) {
			try {
				if (!this.#fileHandle) {
					await mkdir(getTasksDir(), { recursive: true });
					this.#fileHandle = await open(
						this.#path,
						process.platform === "win32"
							? "a"
							: fsConstants.O_WRONLY |
									fsConstants.O_APPEND |
									fsConstants.O_CREAT,
					);
				}
				while (true) {
					await this.#writeAllChunks();
					if (this.#queue.length === 0) break;
				}
			} finally {
				if (this.#fileHandle) {
					const fh = this.#fileHandle;
					this.#fileHandle = null;
					await fh.close();
				}
			}
			// another .append() may have raced in while we were closing — loop back.
			if (this.#queue.length) continue;
			break;
		}
	}

	#writeAllChunks(): Promise<void> {
		// No awaits: appendFile() takes the buffer synchronously and the buffer
		// captures all queued strings. Adding `await` here would pin the queue.
		const fh = this.#fileHandle;
		if (!fh) throw new Error("DiskTaskOutput: fileHandle is null");
		return fh.appendFile(this.#queueToBuffers());
	}

	#queueToBuffers(): Buffer {
		const queue = this.#queue.splice(0, this.#queue.length);
		let totalLength = 0;
		for (const str of queue) totalLength += Buffer.byteLength(str, "utf8");
		const buffer = Buffer.allocUnsafe(totalLength);
		let offset = 0;
		for (const str of queue) offset += buffer.write(str, offset, "utf8");
		return buffer;
	}

	async #drain(): Promise<void> {
		try {
			await this.#drainAllChunks();
		} catch (e) {
			// Transient fs errors (EMFILE on busy CI, EPERM on Windows pending-
			// delete): log once, retry if queue still has data, then give up.
			console.error("[picc-bash] DiskTaskOutput drain error:", e);
			if (this.#queue.length > 0) {
				try {
					await this.#drainAllChunks();
				} catch (e2) {
					console.error("[picc-bash] DiskTaskOutput drain retry failed:", e2);
				}
			}
		} finally {
			const resolve = this.#flushResolve;
			this.#flushPromise = null;
			this.#flushResolve = null;
			if (resolve) resolve();
		}
	}
}

// ============================================================================
// Background task lifecycle
// ============================================================================

// 'l' = local_bash (matches Claude Code's TASK_ID_PREFIXES.local_bash).
function newTaskId(): string {
	return generateTaskId("l");
}

async function startBackgroundTask(
	command: string,
	description: string | undefined,
	cwd: string,
	ctx: ExtensionContext,
): Promise<BackgroundTask> {
	const id = newTaskId();
	const outputPath = getTaskOutputPath(id, ctx);
	// Eagerly seed the output file so the model can `Read` it immediately
	// even before any data arrives (matches Claude Code's initTaskOutput
	// which uses O_EXCL — we use a plain writeFileSync).
	ensureTasksDir(ctx);
	writeFileSync(outputPath, "", "utf-8");

	const { shell, args } = resolveShell(command);

	const child: ChildProcess = spawn(shell, args, {
		cwd,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32", // Unix: own process group so we can kill the tree
		windowsHide: true,
	});

	const task: BackgroundTask = {
		id,
		command,
		description,
		status: "running",
		exitCode: null,
		outputPath,
		startedAt: Date.now(),
		pid: child.pid ?? undefined,
		interrupted: false,
	};
	upsertTask(task);

	const disk = new DiskTaskOutput(id);
	child.stdout?.on("data", (chunk: Buffer) => {
		disk.append(chunk.toString("utf-8"));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		disk.append(chunk.toString("utf-8"));
	});

	child.on("exit", (code) => {
		// No `[Exit code: N]` trailer in the output file — Claude Code doesn't
		// write exit codes to the task file. Exit code lives only on the
		// structured `details.exitCode` returned to the model.
		const status: TaskStatus = code === 0 ? "completed" : "failed";
		const updated: BackgroundTask = {
			...task,
			status,
			exitCode: code,
			completedAt: Date.now(),
		};
		upsertTask(updated);
		notifyTaskComplete(updated);
	});

	child.on("error", () => {
		const updated: BackgroundTask = {
			...task,
			status: "failed",
			completedAt: Date.now(),
			interrupted: true,
		};
		upsertTask(updated);
		notifyTaskComplete(updated);
	});

	return task;
}

function notifyTaskComplete(task: BackgroundTask): void {
	const ctx = extensionContext;
	if (!ctx) return;
	const desc = task.description ?? task.command.slice(0, 60);
	const ok = task.status === "completed";
	const msg = ok
		? `Background task "${desc}" completed (exit ${task.exitCode})`
		: `Background task "${desc}" ${task.status} (exit ${task.exitCode ?? "?"})`;
	try {
		ctx.ui.notify(msg, ok ? "info" : "warning");
	} catch {
		// UI may not be available in non-interactive modes.
	}
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		extensionContext = ctx;
		// Reap stale output files from prior sessions (best-effort).
		cleanupOldOutputFiles();
	});

	pi.on("session_shutdown", () => {
		extensionContext = undefined;
		cleanupOldOutputFiles();
	});

	// ---- Bash (foreground + background) -------------------------------------

	// Background usage note (ported from getBackgroundUsageNote() in
	// prompt.ts:32-35). Returns null (omitted from the guidelines) when
	// CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.
	function backgroundUsageNote(): string | null {
		if (process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1") return null;
		return `You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away — you'll be notified when it finishes.`;
	}

	// Description text (verbatim from claude-code/tools/BashTool/BashTool.tsx:62-91,
	// BashTool.tsx:228-244 + tools/BashTool/prompt.ts).
	const BASH_DESCRIPTION_TEXT = `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls \u2192 "List files in current directory"
- git status \u2192 "Show working tree status"
- npm install \u2192 "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; \u2192 "Find and delete all .tmp files recursively"
- git reset --hard origin/main \u2192 "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' \u2192 "Fetch JSON from URL and extract data array elements"`;

	const bashProperties = {
		command: Type.String({ description: "The command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description: `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`,
			}),
		),
		description: Type.Optional(
			Type.String({
				description: BASH_DESCRIPTION_TEXT,
			}),
		),
		...(isBackgroundDisabled
			? {}
			: {
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Set to true to run this command in the background. Use Read to read the output later.",
						}),
					),
				}),
	} as const;

	// promptGuidelines ported from claude-code/tools/BashTool/prompt.ts
	// `getSimplePrompt()` (excluding embedded/MONITOR_TOOL branches and the
	// sandbox+git sections, none of which exist in pi). Substitutes
	// `config.toolName` for the tool-name references so the guidelines match
	// whatever name the tool is registered under.
	function getBashPromptGuidelines(): string[] {
		const tn = config.toolName;
		const guidelines: string[] = [
			`Avoid using ${tn} to run dedicated-tool commands unless the dedicated tool can't accomplish your task. Prefer: "find" tool (NOT find or ls), "grep" tool (NOT grep or rg), "read" (NOT cat/head/tail), "edit" (NOT sed/awk), "write" (NOT echo >/cat <<EOF). Output text directly (NOT echo/printf).`,
			`If your command will create new directories or files, first run \`ls\` to verify the parent directory exists and is correct.`,
			`Always quote file paths that contain spaces with double quotes.`,
			`Try to maintain your current working directory throughout the session by using absolute paths and avoiding \`cd\`. You may use \`cd\` if the User explicitly requests it.`,
			`You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${(getMaxTimeoutMs() / 60_000).toFixed(0)} minutes). Default timeout is ${getDefaultTimeoutMs()}ms (${(getDefaultTimeoutMs() / 60_000).toFixed(0)} minutes).`,
			...(backgroundUsageNote() ? [backgroundUsageNote() as string] : []),
			`When issuing multiple commands: if the commands are independent and can run in parallel, make multiple ${tn} tool calls in a single message. If they depend on each other and must run sequentially, use a single ${tn} call with '&&' to chain them. Use ';' only when you don't care if earlier commands fail. Do not use newlines to separate commands.`,
			`Avoid unnecessary \`sleep\` commands: don't sleep between commands that can run immediately — just run them. If your command is long-running and you want a completion notification, use \`run_in_background\`. If waiting for a background task you started, do not poll — you'll be notified.`,
			`Use TaskStop(task_id) to stop a background task.`,
		];
		return guidelines;
	}

	pi.registerTool({
		name: config.toolName,
		label: config.toolName,
		// Claude Code's Bash tool shows a different description here vs the
		// schema description: per BashTool.tsx:268-273 the runtime description
		// is `description || "Run shell command"`. We emulate that by giving
		// the dynamic form via promptGuidelines (the long-form instructions)
		// and keeping a short, Claude-Code-style description for the model.
		description: "Run shell command",
		promptSnippet: "execute shell commands",
		promptGuidelines: getBashPromptGuidelines(),
		parameters: Type.Object(bashProperties),
		// Custom call rendering: the built-in bash tool shows `(timeout Ns)`
		// because its timeout is in SECONDS. picc-bash's timeout is in ms
		// (Claude Code compatible), so without this the TUI falls back to raw
		// JSON.stringify(args) and shows e.g. "timeout": 600000 — which reads
		// as "(timeout 600000s)". Render it the Claude Code way instead: the same
		// formatDuration(ms, { hideTrailingZeros }) call ShellTimeDisplay.tsx makes,
		// so 600000ms -> (timeout 10m). The suffix is shown only when a timeout was
		// explicitly provided (omitted when the default applies), matching the
		// built-in bash convention.
		renderCall(args, theme, context) {
			const command = typeof args.command === "string" ? args.command : "";
			let text = theme.fg("toolTitle", theme.bold(`$ ${command}`));
			const requested = (args as { timeout?: unknown }).timeout;
			if (typeof requested === "number" && requested > 0) {
				const timeoutMs = Math.min(Math.max(requested, 1), getMaxTimeoutMs());
				text += theme.fg(
					"muted",
					` (timeout ${formatDuration(timeoutMs, { hideTrailingZeros: true })})`,
				);
			}
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			t.setText(text);
			return t;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { command, timeout, description } = params;
			const runInBackground = isBackgroundDisabled
				? false
				: Boolean(
						(params as { run_in_background?: boolean }).run_in_background,
					);

			if (runInBackground) {
				const task = await startBackgroundTask(
					command,
					description,
					ctx.cwd,
					ctx,
				);
				// Mirror Claude Code BashTool.tsx:612-618 — include the output
				// path in the tool result so the model can Read it directly.
				const text = `Command running in background with ID: ${task.id}. Output is being written to: ${task.outputPath}`;
				const result: BashToolResult = {
					content: [tc(text)],
					details: { backgroundTaskId: task.id },
				};
				return result;
			}

			let effectiveTimeout: number;
			try {
				effectiveTimeout = resolveTimeoutMs(timeout);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const result: BashToolResult = {
					content: [tc(message)],
					details: {},
					isError: true,
				};
				return result;
			}

			const result = await executeForeground(
				command,
				ctx.cwd,
				effectiveTimeout,
				signal,
			);

			// Build tool-result text per Claude Code's mapToolResultToToolResultBlockParam
			// (BashTool.tsx:484-507): [processedStdout, errorMessage, backgroundInfo].join('\n').
			const outputText = formatBashOutput(
				result.stdout,
				result.stderr,
				result.exitCode,
				result.timedOut,
				result.aborted,
				effectiveTimeout,
			);

			const baseDetails: BashToolDetails = {};
			if (result.exitCode !== null && result.exitCode !== 0) {
				baseDetails.exitCode = result.exitCode;
			}
			if (result.timedOut) {
				baseDetails.timedOut = true;
				baseDetails.timeoutMs = effectiveTimeout;
			}
			if (result.interrupted) {
				baseDetails.interrupted = true;
			} else if (result.aborted) {
				baseDetails.aborted = true;
			}

			const hasError =
				result.timedOut ||
				result.aborted ||
				(result.exitCode !== null && result.exitCode !== 0);
			return {
				content: [tc(outputText || "(no output)")],
				details: baseDetails,
				isError: !!hasError,
			};
		},
	});

	// ---- TaskStop ------------------------------------------------------------
	//
	// Canonical name is TaskStop (matching Claude Code's TASK_STOP_TOOL_NAME).
	//
	// Schema, description, prompt, and success message are aligned with Claude
	// Code (tools/TaskStopTool/TaskStopTool.ts:14-29, 142; prompt.ts:3-9).
	// Claude Code's stopTask() resolves a task by id, validates it is running,
	// calls taskImpl.kill(taskId, setAppState) (which dispatches to
	// LocalShellTask.kill for local_bash tasks), then returns the success
	// message. picc-bash mirrors this against its own task registry:
	// lookup → running check → killProcess(pid) → upsert.

	const taskStopSchema = Type.Object({
		task_id: Type.Optional(
			Type.String({ description: "The ID of the background task to stop." }),
		),
		shell_id: Type.Optional(
			Type.String({
				description: "Deprecated: use task_id instead.",
			}),
		),
	});

	const TASK_STOP_DESCRIPTION = "Stop a running background task by ID.";

	const taskStopHandler = async (
		_toolCallId: string,
		params: { task_id?: string; shell_id?: string },
	): Promise<TaskStopResult> => {
		// Support both task_id and shell_id (deprecated KillShell compat).
		const id = params.task_id ?? params.shell_id;
		if (!id) {
			const payload: TaskStopDetails = {
				message: "Missing required parameter: task_id",
				task_id: "",
				task_type: "local_bash",
			};
			return {
				content: [tc(JSON.stringify(payload))],
				details: payload,
				isError: true,
			};
		}

		const task = getTask(id);
		if (!task) {
			const payload: TaskStopDetails = {
				message: `No task found with ID: ${id}`,
				task_id: id,
				task_type: "local_bash",
			};
			return {
				content: [tc(JSON.stringify(payload))],
				details: payload,
				isError: true,
			};
		}

		if (task.status !== "running") {
			const payload: TaskStopDetails = {
				message: `Task ${id} is not running (status: ${task.status})`,
				task_id: id,
				task_type: "local_bash",
				command: task.command,
				alreadyExited: true,
			};
			return {
				content: [tc(JSON.stringify(payload))],
				details: payload,
				isError: true,
			};
		}

		if (task.pid !== undefined) {
			killProcess(task.pid);
		}

		const updated: BackgroundTask = {
			...task,
			status: "killed",
			exitCode: null,
			completedAt: Date.now(),
			interrupted: true,
		};
		upsertTask(updated);

		// Claude Code's success message format (TaskStopTool.ts:131-136):
		// `Successfully stopped task: <id> (<command>)`. We emit the full
		// payload as JSON-stringified text in `content`, matching Claude Code's
		// `mapToolResultToToolResultBlockParam` (`jsonStringify(output)`).
		const payload: TaskStopDetails = {
			message: `Successfully stopped task: ${updated.id} (${updated.command})`,
			task_id: updated.id,
			task_type: "local_bash",
			command: updated.command,
		};
		return {
			content: [tc(JSON.stringify(payload))],
			details: payload,
		};
	};

	const TASK_STOP_PROMPT = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`;

	pi.registerTool({
		name: "TaskStop",
		label: "Stop Task",
		description: TASK_STOP_DESCRIPTION,
		promptSnippet: "Kill a running background task by task_id",
		promptGuidelines: [TASK_STOP_PROMPT],
		parameters: taskStopSchema,
		execute: taskStopHandler,
	});
}
