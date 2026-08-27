/**
 * Functional smoke test: invoke the Bash tool's execute function with real
 * commands and verify the behavior.
 *
 * Run: npx tsx test/execute.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import extension, {
	_resetBashPathForTest,
	config,
	resolveBashPath,
} from "../index.ts";

interface RegisteredTool {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: {
			cwd: string;
			sessionManager: { getSessionId: () => string };
			ui: { notify: (msg: string, level?: string) => void };
		},
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

const registered: RegisteredTool[] = [];

const pi = {
	registerTool(def: RegisteredTool): void {
		registered.push(def);
	},
	on(event: string, handler: unknown): void {
		// Capture session_start so we initialize the path memoization the
		// extension expects before any tool call.
		if (event === "session_start") {
			(handler as (e: unknown, ctx: unknown) => void)({ type: "session_start" }, {
				cwd: process.cwd(),
				sessionManager: { getSessionId: () => "test-session" },
				ui: { notify: () => {} },
			});
		}
	},
};

extension(pi as never);

// On Windows, force re-detection of Git Bash inside the test process so a
// stale memoized value from the extension module's first call (or a previous
// test run) doesn't leak across tests.
_resetBashPathForTest();

const bash = registered.find((t) => t.name === config.toolName);
const taskStop = registered.find((t) => t.name === "TaskStop");

if (!bash?.execute || !taskStop?.execute) {
	throw new Error("Tools missing execute handlers");
}

const ctx = {
	cwd: process.cwd(),
	sessionManager: { getSessionId: () => "test-session" },
	ui: { notify: () => {} },
};

const isWindows = process.platform === "win32";

function expectedOutputDir(): string {
	return join(tmpdir(), "picc-bash", "test-session", "tasks");
}

test("foreground: echo hello", async () => {
	const r = await bash.execute!(
		"call-1",
		{ command: isWindows ? "echo hello" : "printf hello" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, false, "should not be an error");
	const text = r.content[0].text;
	assert.ok(text.includes("hello"), `output should include 'hello', got: ${text}`);
});

test("foreground: exit 1 returns isError=true", async () => {
	const r = await bash.execute!(
		"call-2",
		{ command: "exit 1" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, true);
	// Claude Code format (BashTool.tsx formatBashOutput): `Exit code 1` (no colon).
	assert.match(r.content[0].text, /Exit code 1/);
});

test("foreground: sleep is not auto-backgrounded (killed on timeout)", async () => {
	// `sleep` is in DISALLOWED_AUTO_BACKGROUND_COMMANDS (claude-code parity), so
	// a timed-out `sleep` is still killed rather than backgrounded.
	// Windows is skipped: cmd.exe has no `sleep` (the test would exit early).
	if (process.platform === "win32") return;
	const r = await bash.execute!(
		"call-3",
		{ command: "sleep 5", timeout: 500 },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, true, "should be an error after timeout");
	const details = r.details as { timedOut?: boolean; backgroundTaskId?: string };
	assert.equal(details?.timedOut, true, "details.timedOut should be true");
	assert.equal(details?.backgroundTaskId, undefined, "sleep must not be backgrounded");
});

test("foreground: command that hits its timeout is auto-backgrounded", async () => {
	// A backgroundable command (base command != sleep) that keeps running past
	// its timeout is promoted to a background task instead of being killed
	// (mirrors claude-code BashTool auto-backgrounding on timeout).
	const command = isWindows ? "ping -n 30 127.0.0.1" : "echo auto-bg-marker; sleep 30";
	const r = await bash.execute!(
		"call-17",
		{ command, timeout: 500 },
		undefined,
		undefined,
		ctx,
	);
	const details = r.details as { backgroundTaskId?: string };
	assert.ok(details?.backgroundTaskId, "should return a background task id");
	assert.equal(r.isError, undefined, "auto-backgrounding is not an error");
	assert.match(
		r.content[0].text,
		/Command running in background with ID: /,
		"result text should announce the background task",
	);
	assert.match(
		r.content[0].text,
		/Output is being written to: .+\.output/,
		"result text should include the output file path",
	);

	// The promoted task must actually keep running and keep writing output —
	// verify the pre-timeout output landed in the task file.
	const outputFile = join(expectedOutputDir(), `${details.backgroundTaskId}.output`);
	await new Promise((r) => setTimeout(r, 1000));
	assert.ok(existsSync(outputFile), `task output file exists at ${outputFile}`);
	if (!isWindows) {
		const raw = readFileSync(outputFile, "utf-8");
		assert.ok(
			raw.includes("auto-bg-marker"),
			"task output file should contain the pre-timeout marker",
		);
	}

	// Clean up the still-running backgrounded command.
	await taskStop.execute!(
		"call-17-stop",
		{ task_id: details.backgroundTaskId },
		undefined,
		undefined,
		ctx,
	);
});

test("background: long-running task returns task_id and exposes output path", async () => {
	const r = await bash.execute!(
		"call-4",
		{
			command: isWindows ? "ping -n 5 127.0.0.1" : "sleep 2",
			run_in_background: true,
		},
		undefined,
		undefined,
		ctx,
	);
	const details = r.details as { backgroundTaskId?: string };
	assert.ok(details?.backgroundTaskId, "should return task_id");

	// Tool result text must include the output file path (Claude Code parity).
	assert.match(
		r.content[0].text,
		/Output is being written to: .+\.output/,
		"Bash result must include the output file path",
	);

	// Output file must live under tmpdir/picc-bash/test-session/tasks/.
	const expectedPath = join(expectedOutputDir(), `${details.backgroundTaskId}.output`);
	assert.ok(existsSync(expectedPath), `output file must exist at ${expectedPath}`);
});

test("background: log file exists and contains output", async () => {
	const r = await bash.execute!(
		"call-5",
		{
			command: "echo bg-test-marker",
			run_in_background: true,
		},
		undefined,
		undefined,
		ctx,
	);
	const taskId = (r.details as { backgroundTaskId: string }).backgroundTaskId;
	await new Promise((r) => setTimeout(r, 1500));
	const expectedPath = join(expectedOutputDir(), `${taskId}.output`);
	assert.ok(existsSync(expectedPath), `output file exists at ${expectedPath}`);
	const raw = readFileSync(expectedPath, "utf-8");
	assert.ok(raw.includes("bg-test-marker"), "raw output file contains the marker");
});

test("TaskStop on unknown id returns isError with the standard message", async () => {
	const r = await taskStop.execute!(
		"call-7",
		{ task_id: "no-such-task" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, true);
	// Claude Code's TaskStopTool.ts:88-91 returns the same payload object for
	// both the model's `content` (as JSON-stringified text) and the tool's
	// structured `details`. We mirror that exactly.
	const parsed = JSON.parse(r.content[0].text) as {
		message: string;
		task_id: string;
		task_type: string;
	};
	assert.equal(parsed.message, "No task found with ID: no-such-task");
	assert.equal(parsed.task_id, "no-such-task");
	assert.equal(parsed.task_type, "local_bash");

	const details = r.details as {
		message: string;
		task_id: string;
		task_type: string;
	};
	assert.equal(details.message, "No task found with ID: no-such-task");
	assert.equal(details.task_id, "no-such-task");
	assert.equal(details.task_type, "local_bash");
});

test("TaskStop on a running task kills it and returns Claude Code's success message", async () => {
	const bg = await bash.execute!(
		"call-8",
		{
			command: isWindows ? "ping -n 60 127.0.0.1" : "sleep 30",
			run_in_background: true,
		},
		undefined,
		undefined,
		ctx,
	);
	const taskId = (bg.details as { backgroundTaskId: string }).backgroundTaskId;
	const cmd = isWindows ? "ping -n 60 127.0.0.1" : "sleep 30";

	const r = await taskStop.execute!(
		"call-9",
		{ task_id: taskId },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, undefined, "successful kill should not be isError");

	// Tool result text is JSON-stringified payload (Claude Code's
	// `mapToolResultToToolResultBlockParam` returns `jsonStringify(output)`).
	// Mirrors the literal message: `Successfully stopped task: <id> (<command>)`.
	const parsed = JSON.parse(r.content[0].text) as {
		message: string;
		task_id: string;
		task_type: string;
		command: string;
	};
	assert.match(
		parsed.message,
		new RegExp(`^Successfully stopped task: ${taskId} \\(${cmd}\\)$`),
		`expected 'Successfully stopped task: <id> (<cmd>)', got: ${parsed.message}`,
	);

	// Output schema must match Claude Code (TaskStopTool.ts:14-29).
	const details = r.details as {
		message: string;
		task_id: string;
		task_type: string;
		command: string;
	};
	assert.equal(details.message, parsed.message);
	assert.equal(details.task_id, taskId);
	assert.equal(details.task_type, "local_bash");
	assert.equal(details.command, cmd);
});

test("TaskStop on already-stopped task returns isError with alreadyExited flag", async () => {
	// Start + immediately stop to leave a known-killed task.
	const bg = await bash.execute!(
		"call-10",
		{ command: isWindows ? "ping -n 60 127.0.0.1" : "sleep 30", run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	const taskId = (bg.details as { backgroundTaskId: string }).backgroundTaskId;
	await taskStop.execute!("call-11", { task_id: taskId }, undefined, undefined, ctx);

	// Second TaskStop on the same id — task is no longer running.
	const r = await taskStop.execute!(
		"call-12",
		{ task_id: taskId },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, true);
	const parsed = JSON.parse(r.content[0].text) as {
		message: string;
		alreadyExited?: boolean;
	};
	assert.match(parsed.message, new RegExp(`Task ${taskId} is not running`));

	const details = r.details as { alreadyExited?: boolean; command: string };
	assert.equal(details.alreadyExited, true);
});

test("TaskStop accepts shell_id (compat shim for the removed KillShell alias)", async () => {
	const bg = await bash.execute!(
		"call-13",
		{ command: isWindows ? "ping -n 60 127.0.0.1" : "sleep 30", run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	const taskId = (bg.details as { backgroundTaskId: string }).backgroundTaskId;

	// Use shell_id instead of task_id (matches Claude Code's compat shim;
	// the schema accepts both even though KillShell is no longer registered).
	const r = await taskStop.execute!(
		"call-14",
		{ shell_id: taskId },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, undefined);
	const parsed = JSON.parse(r.content[0].text) as { message: string };
	assert.match(parsed.message, new RegExp(`Successfully stopped task: ${taskId}`));
});

test("output file lives under tmpdir/picc-bash/test-session/tasks/", async () => {
	// After the Claude Code alignment: task state is held in memory
	// (AppState.tasks in CC), output files are the only on-disk artifact.
	const r = await bash.execute!(
		"call-15",
		{ command: "echo reg-probe", run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	const taskId = (r.details as { backgroundTaskId: string }).backgroundTaskId;
	await new Promise((r) => setTimeout(r, 1500));
	const outputFile = join(expectedOutputDir(), `${taskId}.output`);
	assert.ok(existsSync(outputFile), `output file exists at ${outputFile}`);
	// No `[Exit code: N]` trailer in the output file (matches Claude Code).
	const raw = readFileSync(outputFile, "utf-8");
	assert.doesNotMatch(
		raw,
		/\[Exit code: \d+\]/,
		"output file must not contain an Exit code trailer",
	);
});

test("foreground: backslash Windows path resolves correctly (MSYS regression)", async () => {
	if (process.platform !== "win32") {
		// The original bug was Windows-only; non-Windows paths already work.
		return;
	}
	// The MSYS2 layer inside Git Bash must turn `~\.pi\agent\extensions`
	// into something `ls` can read.
	_resetBashPathForTest();
	const knownDir = join(homedir(), ".pi", "agent", "extensions");
	const r = await bash.execute!(
		"call-16",
		{ command: `ls "${knownDir}" 2>&1 | head -20` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.isError, false, `ls should not error, got: ${r.content[0].text}`);
	const text = r.content[0].text;
	assert.ok(text.length > 0, "ls should produce some output");
	assert.doesNotMatch(
		text,
		/cannot access 'C:Users/i,
		"output must not contain the cmd.exe backslash-mangling error",
	);
});

test("resolveBashPath returns a usable bash.exe on Windows", () => {
	if (process.platform !== "win32") return;
	_resetBashPathForTest();
	const p = resolveBashPath();
	assert.ok(p, "resolveBashPath should return a path on Windows");
	assert.match(p, /bash\.exe$/i, `path should end in bash.exe, got: ${p}`);
	assert.ok(existsSync(p), `bash.exe should exist at ${p}`);
});

// ---------------------------------------------------------------------------
// Large tool-result persistence (Claude Code parity).
//
// The bash tool persists oversized foreground output to a per-session
// tool-results file and returns a `<persisted-output>` envelope instead of the
// full text. The threshold is `BASH_MAX_OUTPUT_LENGTH` (default 30_000) clamped
// to 50_000.
// ---------------------------------------------------------------------------

function expectedToolResultsDir(): string {
	return join(tmpdir(), "picc-bash", "test-session", "tool-results");
}

// A cross-platform command that emits a known amount of output. ~7000 chars —
// below the default 30_000-char persistence threshold.
const MEDIUM_OUTPUT_COMMAND =
	"node -e \"for(let i=0;i<1000;i++)console.log('line-'+i)\"";
// ~96KB — comfortably above the default threshold.
const LARGE_OUTPUT_COMMAND =
	"node -e \"for(let i=0;i<10000;i++)console.log('line-'+i)\"";

test("large output: result under threshold is returned inline (no persistence)", async () => {
	// Use the default threshold (30_000) and a small output — no persistence.
	const prev = process.env.BASH_MAX_OUTPUT_LENGTH;
	delete process.env.BASH_MAX_OUTPUT_LENGTH;
	try {
		const r = await bash.execute!(
			"call-large-1",
			{ command: MEDIUM_OUTPUT_COMMAND },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(r.isError, false);
		const text = r.content[0].text;
		assert.doesNotMatch(text, /^<persisted-output>/, "should be inline, not an envelope");
		assert.ok(text.includes("line-0"), "should contain raw output");
		assert.ok(text.includes("line-999"), "should contain the last output line");
		assert.equal(
			(r.details as { persistedOutputPath?: string })?.persistedOutputPath,
			undefined,
			"should not persist when under threshold",
		);
	} finally {
		if (prev === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
		else process.env.BASH_MAX_OUTPUT_LENGTH = prev;
	}
});

test("large output: result over threshold is persisted to a tool-results file", async () => {
	const prev = process.env.BASH_MAX_OUTPUT_LENGTH;
	process.env.BASH_MAX_OUTPUT_LENGTH = "5000"; // lower the threshold
	try {
		const r = await bash.execute!(
			"call-large-2",
			{ command: LARGE_OUTPUT_COMMAND },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(r.isError, false);
		const text = r.content[0].text;
		assert.match(text, /^<persisted-output>\n/, "content should be a <persisted-output> envelope");
		assert.match(text, /Full output saved to: /, "envelope should point at a saved file");
		assert.match(text, /Preview \(first 2KB\):/, "envelope should note the preview size");
		assert.match(text, /\n\.\.\.\n<\/persisted-output>\s*$/, "envelope should end with ellipsis + closing tag");

		const details = r.details as {
			persistedOutputPath?: string;
			persistedOutputSize?: number;
		};
		assert.ok(details.persistedOutputPath, "details should carry the persisted path");
		assert.ok(
			details.persistedOutputPath!.startsWith(expectedToolResultsDir()),
			`persisted file should live under ${expectedToolResultsDir()}, got ${details.persistedOutputPath}`,
		);
		assert.match(
			details.persistedOutputPath!,
			/[/\\]call-large-2\.txt$/,
			"persisted file should be named call-large-2.txt",
		);
		assert.ok(
			existsSync(details.persistedOutputPath!),
			`persisted file should exist at ${details.persistedOutputPath}`,
		);
		const raw = readFileSync(details.persistedOutputPath!, "utf-8");
		assert.ok(
			raw.includes("line-9999"),
			"persisted file should contain the FULL output (last line)",
		);
		assert.equal(details.persistedOutputSize, raw.length, "persisted size should match file");
	} finally {
		if (prev === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
		else process.env.BASH_MAX_OUTPUT_LENGTH = prev;
	}
});