# teamhub-mcp

**Shared context for teams whose members each use their own AI coding agent — Claude Code, Cursor, Antigravity, OpenCode, whatever — on the same repo.**

[![npm version](https://img.shields.io/npm/v/teamhub-mcp.svg)](https://www.npmjs.com/package/teamhub-mcp)
[![license](https://img.shields.io/npm/l/teamhub-mcp.svg)](./LICENSE)

## The problem

When everyone on a team runs an independent AI agent session, nobody's agent knows what a teammate already decided, what they're building right now, or why a file looks the way it does. People quietly duplicate or overwrite each other's work, and one person ends up doing everything because AI-assisted parallel work silently breaks down.

The usual workaround — `git pull`, then tell your agent "analyze this and build X" — puts the burden back on a human to re-explain context every single handoff, and different models (Claude vs. Gemini vs. GPT) frequently draw different conclusions from the same prose summary anyway.

**teamhub-mcp is git-native — no hosted service, no server to run, no login.** It's a small MCP server (CLI command: `hub-server`) each teammate runs *locally*, pointed at their own clone. State lives as plain JSON files under `.hub/` inside the repo itself, and syncs the same way your code does: `git push` / `git pull`. Having repo access *is* having access — there's no separate workspace ID or auth token to set up.

## Quickstart

```bash
cd your-repo
npx -y teamhub-mcp init      # scaffolds .mcp.json, .claude/settings.json, hooks/
```

The npm **package** is `teamhub-mcp`; the CLI **command** it installs is `hub-server` (there's already an unrelated package literally named `hub-server` on npm, so `npx -y hub-server` would silently fetch the wrong thing — always invoke it as `npx -y teamhub-mcp <command>`, or install it persistently first, see below).

`npx -y` means no global install, no build step, nothing to keep updated — every invocation runs the current published version, cold-start is under 2 seconds. `init` never overwrites an existing file unless you pass `--force`, and if `.claude/settings.json` already exists it merges hub's hooks in rather than clobbering whatever else your team has configured. The `.mcp.json` it writes also invokes the server via `npx -y teamhub-mcp` (not a bare `hub-server` command), so it works whether or not anyone on the team ever did a persistent install.

Commit what `init` creates, so teammates who clone the repo get the same setup automatically. `npx -y teamhub-mcp dashboard` prints a human-readable snapshot from the terminal any time, without going through an agent at all (or just `hub-server dashboard` if you've installed it persistently, see below — hook scripts try that fast path first and fall back to npx automatically).

**Developing locally instead of using the published package:**

```bash
npm install && npm run build && npm link   # puts `hub-server` on PATH
cd your-repo && hub-server init            # same scaffolding, using the local build
```

## What every agent session gets

- **A living plan**, not just a task list — `requirements.md` (the why/what) and `design.md` (the architecture/how), continuously updated and read by every joining agent, so the big picture doesn't live only in one person's head or one chat transcript.
- **Structured completion reports, not prose summaries** — when a task is marked done, the builder fills a fixed schema (what was built, key decisions + why + alternatives considered, files changed + purpose, known limitations, next steps) instead of a freeform paragraph. This matters specifically because your teammates' agents may be *different models* — free text gets reinterpreted differently by each reader; a fixed structure stays consistent regardless of which model wrote it or reads it.
- **Anchor-verified file history** — every file note is pinned to the commit it was written against, and re-checked on every read: `verified` (untouched since), `changed` (re-read the file before trusting the note), or `gone`. A summary that's silently gone stale is worse than no summary.
- **One deterministic handoff call** (`get_handoff_brief`) that assembles requirements + design + active tasks + recent structured completions + anchor-verified file history in a single payload, auto-injected via hooks — every agent gets the *same* assembled context regardless of harness or model, instead of each one deciding for itself how much context is worth digging up.
- **Real conflict detection, not just declared-task overlap** — `declare_task` checks both other declared tasks *and* actual recent git commits touching the same scope, so it catches a teammate mid-edit even if they never declared anything.
- **A repo-aware identity** — at session start, teamhub-mcp asks which GitHub repo you're working on (via MCP's `elicitation` protocol) and resolves that to your local clone. Whoever answers with the same repo URL is automatically on the same team; no workspace ID to invent or share.

Handoff is sequential (one agent finishes, another continues later, then `git pull`s), not simultaneous real-time editing — so a structured, git-synced provenance log is enough. No CRDTs, no merge-conflict machinery beyond git's own, no live messaging channel (deliberately researched and skipped — see below).

## How state is stored

```
your-repo/
  .hub/
    plan/requirements.md             the why/what - continuously updated
    plan/design.md                   the architecture/how - continuously updated
    tasks/<taskId>.json              one file per task (completion is structured, see below)
    activity/<ts>-<id>.json          one file per activity event
    notes/<file/path>/<ts>-<id>.json one file per file-provenance note (anchored to a commit)
```

One file per record is the load-bearing design choice: two teammates writing at "the same time" never touch the same file, so git can never produce a merge conflict from normal use. The one real race — two people claiming the *same* task at once — is caught explicitly: `claim_task` re-checks after a rejected push and reports a real conflict instead of silently overwriting.

## MCP tools

| Tool | Purpose |
|---|---|
| `get_handoff_brief` | **The one to call when picking up someone else's work.** Deterministically bundles requirements + design + active tasks + recent structured completions + anchor-verified file history. Optionally filter by `scope`. |
| `get_context` | Lighter-weight: just tasks + recent activity |
| `get_plan` | Read `requirements.md` + `design.md` |
| `update_plan` | Replace the full content of one plan doc |
| `declare_task` | Propose scope/interface/assumptions. Returns `conflicts` (other declared tasks touching the same scope) AND `recentActivityNearby` (real git commits touching this scope in the last 10 min from anyone else, declared or not). Leaves the task **unclaimed**. |
| `claim_task` | Claim an unclaimed (or your own) task. Also returns `recentActivityNearby` as a non-blocking heads-up. |
| `update_task_status` | Move a task along (`todo`/`claimed`/`in_progress`/`abandoned`/`done`); on `done`, attach a **structured** `completion` — not a free-text summary. Returns `uncommittedFileWarnings` if any claimed `filesChanged` path isn't actually committed/pushed yet. On `abandoned`, attach `abandonReason` — makes a mid-task pivot visible and the task reclaimable, instead of silently sitting at "in_progress" forever. |
| `log_activity` | "I'm doing X right now." Use `kind: "pivoted"` when changing approach mid-task without abandoning it outright. |
| `record_file_note` | Attach a rationale note to a file you finished touching, anchored to the current commit |
| `get_file_history` | Read a file's provenance trail, each note tagged `verified`/`changed`/`gone` against its anchor |
| `check_file_before_edit` | Fast single-file freshness check — call right before editing a file that's part of a shared interface, especially in a long session. Backs the Claude Code `PreToolUse` gate. |
| `get_task_history` | Every status transition a task went through, who made each change, when — `.hub/tasks/<id>.json` is overwritten in place per change, so this sequence isn't otherwise visible even though git already stores it. |

No `join_workspace`/auth tool — every tool takes an optional `memberName`, defaulting to `git config user.name`.

## Harness support

All hooks are pure Node (`.mjs`) — no bash/Git-Bash/WSL dependency, since Node is already a hard requirement of teamhub-mcp itself. This was a real fix, not a preference: on Windows, npm installs `hub-server` as a `.cmd` wrapper, which Node's `child_process` cannot execute without a shell — `hooks/lib/run-hub-server.mjs` handles this safely (shell only on Windows, with real argument escaping, not naive string concatenation).

| Harness | Context injection | Enforcement (deny an edit until checked in) |
|---|---|---|
| Claude Code | `SessionStart` hook — **verified working**: confirmed live that hook output actually reaches the model's context, not just that the hook process runs | `PreToolUse` hook — **verified working end-to-end** via a real `claude -p` run: a raw Edit was denied, the model correctly called `get_handoff_brief` to clear the gate, then the edit succeeded. Known limits: a blocked model can route around via Bash instead of Edit, and hooks cannot see/gate MCP tool calls directly — the gate works by having the MCP server leave a marker file the hook checks. Doesn't yet force *recording* completion afterward, only checking in *before* editing. |
| Antigravity | `pre_turn` hook — presumed working (same injection pattern as Claude Code), not independently verified against a live install | **Not implemented.** Antigravity's docs mention a `HookResult(allow=...)` field but don't confirm it can deny a tool call, and this couldn't be verified without a scriptable way to test Antigravity. An unverified gate that might silently do nothing would be worse than an honest gap. |
| Cursor | hook — written, **not verified** against a live install | not implemented |
| OpenCode | `session.created` plugin event — written, **not verified** against a live install | not implemented |
| Codex CLI | *(no session hook exists upstream)* | not built — needs a shell-wrapper fallback |

All hook scripts shell out to `hub-server handoff` and degrade silently if it's not installed or the repo has no `.hub/` yet. The exact hook-registration config syntax for each harness is evolving fast — verify against that harness's current docs before wiring these in.

## Directory resolution

Asked once per session and cached in memory for that server process:

1. `HUB_REPO_PATH` env override, if set, wins outright.
2. Otherwise, teamhub-mcp asks the user directly, via MCP **elicitation** — "which GitHub repo are you working on?" — then resolves that URL to a local clone: a matching git remote at the auto-detected candidate directory, a cached mapping from a previous session on this machine (`~/.hub-server/repo-cache.json`), a bounded search of common folders (`~`, `~/Desktop`, `~/Documents`, direct children only), or asking directly where it's cloned as a last resort. This doubles as team identity, and sidesteps a whole class of cwd-detection bugs rather than working around them harness-by-harness.
3. Falls back to MCP `roots`, then `process.cwd()`, if elicitation isn't answered or supported.

**Verified real, not just documented**: a test client that declares the elicitation capability confirmed the full round-trip — server asks, client answers a URL, server finds the right local clone even launched from a totally unrelated directory. **Also verified, honestly, that Claude Code itself does not currently trigger this** (tested with `claude -p` — no prompt appeared, it fell through to the fallback chain, which worked correctly). Whether interactive Claude Code or Antigravity support elicitation is unverified.

**Known limitation**: multiple local clones of the same repo on one machine resolve to whichever is found first, not necessarily the one you meant — fine for the normal one-clone-per-person case, ambiguous otherwise.

The `process.cwd()` fallback exists because harnesses that launch a *globally* registered MCP server (observed with Antigravity) spawn it from their own install directory, not the open workspace — a real, widely-hit ecosystem bug (see open issues on `google-antigravity/antigravity-cli` and `anthropics/claude-code`), not something specific to this tool.

## Why structured completion + anchors, not just "more context"

The naive fix for "teammate B's agent doesn't know what A did" is dumping more text at it — a bigger summary, more files. That doesn't actually solve the problem, for two reasons specific to this use case:

1. **Different models interpret the same prose differently.** Claude, Gemini, and GPT reading the same free-text rationale can draw different conclusions about what mattered and what to do next. Structured fields — fixed shape, varying only in content — measurably reduce this variance.
2. **A stale summary is worse than no summary**, because it's silently wrong instead of obviously absent. Anchoring every file note to the commit it was true as of, and re-checking that anchor on every read, tells a reader explicitly when something's changed since.

`get_handoff_brief` exists so this doesn't depend on any individual agent choosing to gather all of this — it's assembled the same way every time, and auto-injected via hooks, so a human never has to say "pull this, then analyze it, then build X."

## Why no live agent-to-agent messaging

This was seriously considered and deliberately rejected, not just skipped. A directly relevant study measuring this exact tradeoff found that added messaging channels *increase* overhead for sequential-pipeline coordination (one agent finishes, another continues later) — teamhub-mcp's exact shape — because the files already carry the coordination; messaging only helps distributed, simultaneously-active work. Every no-hosted-service live option investigated (file-watcher auto-push, GitHub API polling, an optional relay) either violates the "no server to run" principle or was already tried and abandoned by comparable tools for good reasons (auto-push floods a shared branch with broken intermediate states). See `git log` / project history for the full research trail.

## Known limitations (read this before depending on it)

- Conflict detection on `declare_task` is exact string overlap on declared `scope` — cheap and effective for "same file/module/route," won't catch two people building the same thing under different names.
- Frequent small `hub:` commits are a known rough edge; batching/squashing is a candidate future improvement if it proves noisy in practice.
- No remote configured (solo/demo repo)? Everything still works — sync becomes a no-op and state stays local.
- Cursor and OpenCode hooks are written but unverified against live installs. Antigravity's enforcement gate doesn't exist yet.
- Solo-maintained, chasing several fast-moving platforms' hook/MCP APIs at once — expect breakage as those APIs evolve.

## Roadmap

- Codex CLI support via a binary/shell-wrapper fallback (no native session hook exists upstream).
- An `AGENTS.md` auto-sync fallback for harnesses without dynamic hooks at all.
- A minimal local web dashboard over the same data `dashboard --json` already exposes.
- Turn `declared_interface`/`assumptions` overlap from a warning into an actual block-and-negotiate step.
- Extend the `PreToolUse` gate pattern to Cursor once verified live.
- Role-based task visibility, surfacing tasks/provenance on GitHub PRs, multi-repo workspaces.

## Contributing

Issues and PRs welcome — especially reports of what actually happens when you wire this into a harness not yet verified above (Cursor, OpenCode, Antigravity's gate). Real test results, even negative ones, are the most useful contribution right now.

## License

MIT — see [LICENSE](./LICENSE).
