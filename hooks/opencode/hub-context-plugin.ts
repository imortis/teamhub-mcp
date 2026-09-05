// OpenCode plugin: pushes the shared team HANDOFF BRIEF into a session as
// soon as it's created, using OpenCode's `session.created` plugin event
// (plugin API v2, v1.17.10+). See https://opencode.ai/docs/plugins/ for the
// current plugin interface - this follows the documented pattern of using
// `client.session.prompt({ noReply: true, ... })` to inject context without
// triggering a model reply, but hasn't been run against a live OpenCode
// install in this repo, so verify the exact plugin export shape against your
// installed version.
//
// hub-server is a LOCAL MCP server - no URL/workspace-ID config needed here.
// This shells out to `hub-server handoff`, which does a git fetch +
// fast-forward pull, then deterministically assembles requirements/design +
// active tasks + structured completion reports + anchor-verified file
// history into ONE payload - every agent gets the same assembled context,
// not whatever it happened to think to look up on its own.
// Requires `hub-server` on PATH (npm link, or npm install -g once published).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function hubContextPlugin({ client }: { client: any }) {
  return {
    event: async ({ event }: { event: any }) => {
      if (event.type !== "session.created") return;

      try {
        const { stdout } = await execFileAsync("hub-server", ["handoff"], {
          cwd: process.cwd(),
          timeout: 5000,
        });
        const brief = JSON.parse(stdout);

        const text = [
          "## Shared team handoff brief (hub-server, .hub/ in this repo)",
          "",
          "This repo is shared with teammates using their own AI coding agents.",
          "This is the FULL current state: requirements/design, what's still to",
          "do, what teammates just finished (with their reasoning and",
          "decisions), and file-level history. Don't ask the user to re-explain",
          "anything already captured here.",
          "",
          "As you work: call declare_task before starting something new (check",
          "the conflicts it returns), claim_task to take an existing one,",
          "update_task_status with a structured `completion` when done (not a",
          "one-line summary), record_file_note when you finish touching a file,",
          "and update_plan if requirements or design actually changed.",
          "",
          "```json",
          JSON.stringify(brief, null, 2),
          "```",
        ].join("\n");

        await client.session.prompt({
          sessionId: event.session.id,
          noReply: true,
          parts: [{ type: "text", text }],
        });
      } catch {
        // hub-server not installed, not a git repo, or unreachable -
        // degrade silently, don't block the session.
      }
    },
  };
}
