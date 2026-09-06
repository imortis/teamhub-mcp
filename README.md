# teamhub-mcp

Shared context for teams where everyone uses their own AI coding agent — Claude Code, Cursor, Antigravity, OpenCode, doesn't matter which — on the same repo.

[![npm version](https://img.shields.io/npm/v/teamhub-mcp.svg)](https://www.npmjs.com/package/teamhub-mcp)
[![license](https://img.shields.io/npm/l/teamhub-mcp.svg)](./LICENSE)

## Why this exists

If everyone on your team is running their own AI agent session, nobody's agent knows what a teammate already decided, what they're building right now, or why some file looks the way it does. People end up duplicating each other's work or quietly stepping on it, and eventually one person is doing everything by hand because the AI-assisted parallel work just doesn't hold together.

The normal fix is `git pull`, then tell your agent "look at this and build X" — which just moves the burden back onto a human, every single handoff. And it gets worse when teammates use different models: Claude, Gemini, and GPT will happily draw different conclusions from the same paragraph of context.

teamhub-mcp is git-native. No hosted backend, nothing to deploy, no account to make. It's a small MCP server that each person runs locally against their own clone (the CLI is called `hub-server`). State is just JSON files under `.hub/` in the repo, and it moves around the same way your code does — `git push`, `git pull`. If you have access to the repo, you have access to the shared context. There's no separate workspace ID or token to hand out.

## Getting started

```bash
cd your-repo
npx -y teamhub-mcp init
```

That scaffolds `.mcp.json`, `.claude/settings.json`, and the hook scripts into your repo. One thing worth knowing: the npm package is `teamhub-mcp`, but the command it installs is `hub-server` — there's already an unrelated package called `hub-server` on npm, so typing `npx -y hub-server` will silently grab the wrong thing. Stick to `npx -y teamhub-mcp <command>`.

`init` won't clobber anything — it skips files that already exist unless you pass `--force`, and if you already have a `.claude/settings.json` it merges the hooks in rather than overwriting whatever else you've got configured there. Commit whatever it creates so teammates get the same setup the moment they clone the repo.

Want to poke at it without going through an agent? `npx -y teamhub-mcp dashboard` prints a plain-text summary of the current tasks and activity.

If you're working on teamhub-mcp itself rather than using the published package:

```bash
npm install && npm run build && npm link
cd your-repo && hub-server init
```

## What you actually get

- **A living plan, not just a to-do list.** `requirements.md` and `design.md` live in `.hub/plan/` and get updated as the project evolves, so the big picture isn't stuck in one person's head or buried in a chat transcript somewhere.
- **Completion reports with a fixed shape, not a paragraph.** When someone finishes a task, they fill in what was built, the decisions they made and why, which files changed, known gaps, and what's next — as structured fields, not prose. The reason this matters more than it sounds: if your teammates are on different models, free text gets reinterpreted differently by whoever reads it next. A fixed shape doesn't have that problem.
- **File notes that check their own freshness.** Every note about a file is pinned to the commit it was written against. Read it later and it'll tell you `verified` (nothing's changed), `changed` (go re-read the file, don't trust this blindly), or `gone`. A note that's quietly out of date is worse than no note at all.
- **One call that gets you everything.** `get_handoff_brief` bundles the plan, open tasks, recent completions, and file history into a single response, and it's what gets auto-injected at session start. The point is that it's the same for everyone — nobody's agent has to decide on the fly how much digging is "enough."
- **Conflict detection that looks at real git history, not just declared tasks.** `declare_task` checks other declared tasks *and* actual recent commits touching the same files, so it catches a teammate who's mid-edit even if they never bothered to declare anything.
- **Dependencies, for the case file-overlap can't catch.** "Build `POST /api/auth`" and "wire the login form to it" touch completely different files, so nothing about overlapping scopes will ever flag that the second can't start until the first exists. Mark it with `dependsOn` and you get told at claim time — and the handoff brief shows which tasks are actually startable versus waiting on something.
- **Completions written from the real diff, not memory.** `get_diff_for_task` shows everything that changed since you claimed it, committed and uncommitted, so the completion report lists what you actually touched. In a long session it's easy to forget files you edited early, or to describe an approach you later reverted — and since the uncommitted-file check only inspects the paths you list, an incomplete list quietly defeats that check too.
- **It tells you which repo it's using, and you can change it by just saying so.** Every context response names the active repo, so if it picked the wrong one you'll see it straight away. Tell your agent to switch and it calls `set_repo` — by GitHub URL or folder path. Whoever's working on the same repo is on the same team; there's nothing else to set up, no accounts, no workspace IDs.

Handoffs here are sequential — one person finishes and pushes, the next person pulls and continues — not simultaneous editing, so a plain git-synced log is enough to keep everyone in sync. No CRDTs, no custom merge logic, and (after actually looking into it) no live messaging between agents either — more on that below.

## How the data is laid out

```
your-repo/
  .hub/
    plan/requirements.md             the why/what
    plan/design.md                   the architecture/how
    tasks/<taskId>.json              one file per task
    activity/<ts>-<id>.json          one file per activity event
    notes/<file/path>/<ts>-<id>.json one file per file note, anchored to a commit
```

One file per record is the important decision here. Two people writing "at the same time" never touch the same file, so git can't produce a merge conflict from ordinary use. The one real race condition — two people claiming the same task at once — is handled explicitly: `claim_task` re-checks after a rejected push and tells you the truth instead of quietly overwriting the other person's claim.

## The tools

| Tool | What it does |
|---|---|
| `get_handoff_brief` | Call this when you're picking up someone else's work. Bundles the plan, open tasks, recent completions, and file history in one shot. Can filter by `scope`. |
| `get_context` | The lightweight version — just tasks and recent activity. |
| `get_plan` / `update_plan` | Read or replace `requirements.md` / `design.md`. |
| `declare_task` | Propose a task with a scope. Comes back with any declared tasks that overlap, plus real git commits touching the same files in the last 10 minutes from anyone else. Takes an optional `dependsOn` list of task IDs. Leaves the task unclaimed on purpose — call `claim_task` if you're the one building it. |
| `claim_task` | Claim an unclaimed task, or your own. Tells you about recent activity on those files and any dependencies that aren't finished yet. |
| `get_diff_for_task` | What actually changed since you claimed the task, committed and uncommitted. Call this before writing a completion. |
| `set_repo` | Point this session at a different repo, by GitHub URL or local path. Use it when you switch projects, or when the repo it picked isn't the one you meant. `reset: true` goes back to automatic detection. |
| `update_task_status` | Move a task forward. Marking it `done` needs a structured completion, not a one-liner. Marking it `abandoned` needs a reason — that way a half-finished task doesn't just look stuck forever, and it becomes claimable again. |
| `log_activity` | "Here's what I'm doing right now." Use `kind: "pivoted"` if you're changing approach mid-task without abandoning it. |
| `record_file_note` | Leave a note on a file you just finished touching. |
| `get_file_history` | Read a file's notes, each one tagged with whether it's still trustworthy. |
| `check_file_before_edit` | A fast check on one file before you touch it — cheaper than the full handoff brief, useful in a long session where your original context might be stale. This is what backs the Claude Code enforcement gate. |
| `get_task_history` | The full status history of a task. `.hub/tasks/<id>.json` gets overwritten in place on every change, so without this the todo → claimed → done sequence isn't visible even though git already has it. |

No login, no auth tool. Every tool takes an optional `memberName`, and if you don't pass one it just uses `git config user.name`.

## Where it actually works today

Hooks are plain Node scripts (`.mjs`), not bash — Node's already a hard requirement, so this avoids needing Git Bash or WSL on Windows. This wasn't just a style choice: npm installs `hub-server` as a `.cmd` file on Windows, which Node can't run directly without a shell, and getting that right (safely, without the argument-injection issues that come with shelling out carelessly) took some real work.

**Claude Code** is the one I've actually verified end to end. The `SessionStart` hook really does get its output into the model's context — I checked by putting a made-up string in the hook and asking a fresh session if it saw anything unusual, and it reported the string back. The `PreToolUse` enforcement gate works too: I ran a real `claude -p` session, watched it get denied on a raw edit, watched it correctly call `get_handoff_brief` to clear the gate, then watched the edit go through. It's not bulletproof — a blocked model can still route around it through Bash instead of Edit, and it can only catch built-in tool calls, not MCP calls directly, so the gate works by having the MCP server itself leave a marker the hook can check. It also only enforces checking in *before* you edit, not recording what you did *afterward* — there's no equally clean hook for that yet.

**Antigravity** should get context injected the same way, but I haven't been able to verify it live — there's no scriptable CLI on my machine to test it the way I could with Claude Code. The enforcement gate isn't built for it at all: Antigravity's docs mention something that might allow blocking a tool call, but it's not confirmed, and I'd rather leave it out than ship something that looks like it works and quietly doesn't.

**Cursor** and **OpenCode** have hooks written for them but I haven't tested either against a real install. **Codex CLI** has nothing yet — there's no session-start hook to attach to upstream, so it'd need a different approach (wrapping the binary) that isn't built.

## How it figures out which repo you mean

This is asked once per session and then cached for the rest of that process:

1. If you set `HUB_REPO_PATH`, that wins, full stop.
2. Otherwise it asks you directly — "which GitHub repo are you working on?" — through MCP's elicitation feature, and then works out your local clone from the answer: checking if the auto-detected folder's git remote matches, checking a cache of past answers on this machine, doing a quick scan of `~`, `~/Desktop`, and `~/Documents` for a matching clone, or just asking where you put it.
3. If the client doesn't support elicitation, or you don't answer, it falls back to MCP's `roots` protocol and then plain `process.cwd()`.

I built a test client that supports elicitation to confirm this actually works, including launching from a totally unrelated folder and having it find the right clone anyway. Claude Code itself doesn't trigger the prompt as of writing — I tested with `claude -p` and no prompt showed up, so it just falls through to the cwd-based fallback, which still works fine. Whether Antigravity supports elicitation, I don't know yet.

**So in practice you probably won't be asked, and usually won't need to be.** Every context response carries an `activeRepo` field naming the repo in use, so a wrong one shows up immediately instead of being silently wrong. If it isn't what you meant, just tell your agent to switch — it calls `set_repo`, which works on every harness because it's an ordinary tool call rather than a protocol feature the client has to support. Setting a repo by local path also teaches it that URL-to-folder mapping, so asking for the same repo by URL later works even when the clone lives somewhere the folder scan would never look.

That override lasts for the session and isn't saved machine-wide, on purpose: if it were global, having two projects open in two windows would mean one silently hijacking the other.

One thing to be aware of: if you've got more than one local clone of the same repo, it'll pick whichever one it finds first, which might not be the one you meant. Normal one-clone-per-person setups are unaffected.

The reason there's a fallback chain at all is that some harnesses — Antigravity is the one I ran into — launch a globally registered MCP server from their own install folder instead of your actual project. That's a known issue on their end (there are open GitHub issues about it), not something specific to this tool.

## Why structured data instead of just more context

The obvious fix for "my teammate's agent doesn't know what happened" is to hand it more text — a longer summary, more files. That doesn't really solve it, for two reasons:

Different models read the same prose differently. Claude, Gemini, and GPT can draw genuinely different conclusions from the same free-text explanation. A fixed set of fields doesn't have that problem — the shape stays the same no matter which model wrote it or which one is reading it.

And a summary that's gone stale is worse than no summary, because it looks trustworthy while being wrong. Pinning every note to the commit it was written against, and checking that on every read, means you're told explicitly when something's moved on instead of quietly building on outdated information.

## Why there's no live messaging between agents

I looked into this seriously before deciding against it. There's a study measuring exactly this tradeoff that found adding messaging channels *increases* overhead for sequential handoffs like this one — one person finishes, another continues later — because the files already carry the coordination; messaging mainly helps when work is genuinely simultaneous. Every option I found for doing this without standing up a hosted service either broke the "no server to run" idea or had already been tried and dropped by similar tools for good reasons (auto-committing on every file save floods a shared branch with half-finished code, for instance).

## Things that aren't done yet, or don't work perfectly

- Conflict detection on `declare_task` is a plain string match on scope — good for "same file," won't catch two people building the same feature under different names. (Dependencies between tasks are handled separately, via `dependsOn`.)
- Dependencies are a warning at claim time, not a hard block. If you want to start something that isn't ready yet, nothing stops you — you're just told.
- Small `hub:` commits pile up fast. Might batch these later if it turns out to bother people in practice.
- If there's no git remote (a solo project, or just testing), everything still works — it just skips the sync step.
- Cursor and OpenCode hooks exist but haven't been tested against real installs. Antigravity doesn't have an enforcement gate yet.
- I'm maintaining this alone, and it depends on hook/MCP APIs from several companies that are all still changing quickly. Expect some breakage as those move.

## What's next

- Support for Codex CLI, probably via wrapping the binary since there's no hook to attach to.
- A fallback that keeps `AGENTS.md` in sync for harnesses without real hooks at all.
- A small local web dashboard on top of the same data `dashboard --json` already returns.
- Turning the scope-overlap warning into an actual block, with a way to negotiate instead of just flagging it.
- The `PreToolUse` gate for Cursor, once I can confirm it actually works there.
- Role-based visibility, surfacing tasks on GitHub PRs, multi-repo setups.

## Contributing

Issues and PRs are welcome, especially reports of what happens when you try this on a harness I haven't verified yet (Cursor, OpenCode, Antigravity's gate). Right now, an honest "I tried it and here's what broke" is more useful than a feature request.

## License

MIT — see [LICENSE](./LICENSE).
