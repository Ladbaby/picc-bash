# picc-bash

Claude Code style Bash and TaskStops tool for pi. 
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Adds background-task support and Claude-Code-style timeouts to pi's bash execution.
Behavior, schema descriptions, output format, kill semantics, abort handling, task ID generation, prompt guidelines, and storage layout all mirror Claude Code's Bash tool (`tools/BashTool/BashTool.tsx`) and TaskStop tool (`tools/TaskStopTool/TaskStopTool.ts`) — see the in-line source citations for which Claude Code function each section was ported from.

## Tools registered

| Tool | Purpose |
|------|---------|
| `bash` (default) | Run a shell command (foreground or background). Default registered name is `"bash"` (pi ecosystem standard). Set `toolName: "Bash"` in `config.json` for Claude Code parity. pi's built-in `bash` coexists unchanged — picc-bash will be loaded instead of the built-in one. |
| `TaskStop` | Stop a background bash task by id. Matches Claude Code's `tools/TaskStopTool/TaskStopTool.ts` schema and success message format. Name is fixed (no alias). |

`TaskOutput` / `BashOutput` / `AgentOutputTool` are **intentionally NOT registered**.
Claude Code marks `TaskOutput` deprecated and instructs models to use `Read` on the
output file path instead. The Bash tool's `run_in_background` result already returns
that path.

## Tool name configuration

The Bash tool is registered as `"bash"` (lowercase) by default for compatibility with pi's existing extension ecosystem. To register it as `"Bash"` (capital-B,
Claude Code naming), use either:

**Option A — config file** at `~/.pi/agent/extensions/picc-bash/config.json` (create the directory if needed):

```json
{ "toolName": "Bash" }
```

**Option B — environment variable** (highest precedence):

```
PICC_BASH_TOOL_NAME=Bash
```

Valid values are `"bash"` (default) and `"Bash"`. Any other value prints a
warning to stderr and falls back to `"bash"`. The `PICC_BASH_CONFIG_PATH`
env var overrides the config file location (default: `~/.pi/agent/extensions/picc-bash/config.json`).

> The UI `label` and the model's `promptGuidelines` follow the registered
> name, so the tool is fully consistent regardless of which you pick.
> `TaskStop` is always registered as `TaskStop` (no configuration).

## `Bash` parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | string | (required) | Shell command. On Windows runs under Git Bash (`bash.exe -l -c`); on Unix under `/bin/sh -c`. |
| `timeout` | number (ms) | `120000` | Clamped to `[1, BASH_MAX_TIMEOUT_MS]`. |
| `description` | string | — | Short, active-voice description. Follows Claude Code's guidance (5–10 words for simple commands; more context for piped/obscure commands). |
| `run_in_background` | bool | `false` | Omitted from schema if `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. |

When `run_in_background:true`, the tool result text reads:

```
Command running in background with ID: <id>. Output is being written to: <output-path>
```

…matching Claude Code's `BashTool.tsx` `mapToolResultToToolResultBlockParam`. The model is expected to `Read` that file directly rather than poll any dedicated output tool.

### Foreground output format

Foreground results use Claude Code's join pattern (`[processedStdout, errorMessage].filter(Boolean).join('\n')`):

- Leading/trailing blank lines are stripped from stdout (CC `BashTool.tsx`).
- stderr is attached as a separate paragraph below stdout; if both stderr and the
  command were interrupted, the trailing line is `<error>Command was aborted before completion</error>`.
- On timeout: `Command timed out after <duration>` (where `<duration>` is `formatDuration()`'s `2m 0s`-style output, not raw ms).
- On non-zero exit (if not aborted): `Exit code <N>` (no colon — matches Claude Code).
- `details.interrupted` is set when the abort signal's `reason === "interrupt"`
  (user submitted a new message); `details.aborted` is set otherwise.
- `details.timedOut`, `details.timeoutMs`, `details.exitCode` are present when applicable.

### Task ID format

Task IDs are generated exactly as Claude Code does (`generateTaskId('local_bash')`
→ `'l' + 8 base36 chars`), e.g. `lx1y2z3a4`. The `/^l[a-z0-9]{8}$/` prefix lets
you recognize a picc-bash local-bash task ID at a glance.

## `TaskStop` schema and behavior

Aligned with Claude Code's `tools/TaskStopTool/TaskStopTool.ts` and `prompt.ts`.

**Input schema** (both `task_id` and `shell_id` accepted; `shell_id` is the
deprecated alias from `KillShell`):

```json
{ "task_id": "<id>" }
```

**Output** (mirrors `TaskStopTool.ts:14-29`):

Claude Code's `mapToolResultToToolResultBlockParam` returns the full payload as
JSON-stringified text and the same payload as structured `details`. picc-bash
does the same:

```json
{
  "message": "Successfully stopped task: <id> (<command>)",
  "task_id": "<id>",
  "task_type": "local_bash",
  "command": "<command>"
}
```

**Failure payloads** (one of `Missing required parameter: task_id`,
`No task found with ID: <id>`, `Task <id> is not running (status: <status>)`)
include the same JSON shape, with `alreadyExited: true` set on the "not
running" path.

Kill semantics: `tree-kill` (cross-platform) with SIGTERM on the
foreground timeout/abort path, escalating to SIGKILL on retry. Matches Claude
Code's `ShellCommand.ts #doKill`.

## Configuration (env vars)

| Env var | Default | Effect |
|---------|---------|--------|
| `BASH_DEFAULT_TIMEOUT_MS` | `120000` | Foreground timeout when caller doesn't specify one. |
| `BASH_MAX_TIMEOUT_MS` | `600000` | Maximum allowed foreground timeout. |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | (unset) | When set to `1`, the `run_in_background` parameter is omitted from `Bash`'s schema AND the background-usage prompt guideline is suppressed. |
| `PICC_BASH_PATH` | (unset) | Override the Git Bash path used on Windows. Must point at an existing `bash.exe`. If unset, picc-bash auto-detects via `where.exe bash` and then checks the canonical install locations (`C:\Program Files\Git\bin\bash.exe`, `C:\Program Files (x86)\Git\bin\bash.exe`). If detection fails, picc-bash falls back to `cmd.exe` with a one-time stderr warning — backslash paths like `C:\Users\foo` may not work in that degraded mode. |

## Storage (Claude Code parity)

Background task output lives at `${os.tmpdir()}/picc-bash/{sessionId}/tasks/{taskId}.output`, mirroring Claude Code's `getTaskOutputPath` (`utils/task/diskOutput.ts:50-73`). The session ID is captured at first call (memoized) so concurrent sessions don't collide and `/clear` regenerations don't strand in-flight tasks.

Inside that directory:

- `<taskId>.output` — appended stdout+stderr. **No `[Exit code: N]` trailer** in the file (Claude Code doesn't write exit codes there; the exit code lives on `details.exitCode` returned to the model).
- `registry.json` may exist from prior versions and is ignored on startup; task state itself is held in memory only (matching Claude Code's `AppState.tasks[taskId]`).

DiskTaskOutput caps total bytes at `5GB` (matching Claude Code's
`MAX_TASK_OUTPUT_BYTES`); past the cap, appended chunks become a
`[output truncated: exceeded 5GB disk cap]` marker and the actual writes stop.

Output files older than 7 days (per `mtime`) are reaped on `session_start` and
`session_shutdown`. There is no PID-based orphan resync (Claude Code doesn't do
that either — orphan tasks simply show as not-running at lookup time).

## Permission routing

To make `permission.bash.*` rules apply to `Bash` calls (apart from `bash` calls), this extension expects `@ladbabynpm/picc-permission-system` to be installed, wired via a `packages` entry in `~/.pi/agent/settings.json`.

The fork accepts both `"bash"` and `"Bash"` as the bash surface across all gates (command-pattern surface, `path` token extraction, `external_directory`, denial/decision messages, permission prompts, system-prompt guideline filtering, tool preview). Without the fork, `permission.bash.*` rules do not match `Bash` invocations — only the LLM-driven auto-classifier in `@ladbabynpm/picc-permission-modes` sees the tool (it already handles both names in its `toolStringView`).

## Differences from Claude Code

These are intentionally out of scope for picc-bash.

- **Tool name** is registered as `bash` by default (lowercase). Set `toolName: "Bash"` in `config.json` or `PICC_BASH_TOOL_NAME=Bash` to match Claude Code's naming. pi's built-in `bash` coexists unchanged.
- No sandbox (`shouldUseSandbox`, `dangerouslyDisableSandbox` parameter). pi has no per-command sandbox.
- No `assistantAutoBackgrounded` / 15s blocking-budget auto-backgrounding. Use `run_in_background:true` explicitly.
- No `Ctrl+B` to background an in-flight foreground command.
- No progress streaming (`onUpdate` throttling, `BackgroundHint` UI, `TaskOutput.startPolling`). Background tasks just append to the file; check it with `Read`.
- No `persistedOutputPath` (the inline-→-tool-results dir copy used for very large foreground output).
- No image output handling.
- No `extractClaudeCodeHints` (`<claude-code-hint/>` tag stripping).
- No sed edit preview / `_simulatedSedEdit`.
- Task list is in-memory only; Claude Code uses AppState. Restarting the session loses TaskStop access to old tasks (but output files on disk remain readable).
- TaskStop is registered here (not by `@ladbabynpm/picc-tasks`) so the actual subprocess abort behavior is wired up. The picc-tasks extension intentionally drops its own `TaskStop` registration to avoid shadowing this one.
