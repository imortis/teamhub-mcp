#!/usr/bin/env node
// Claude Code SessionStart hook. Pure Node - no bash dependency.
//
// Register in .claude/settings.json:
//   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
//       "command": "node hooks/claude-code/session-start.mjs" }] }] } }
//
// (Written automatically by `hub-server init`.)

import { fetchHubContext } from "../lib/fetch-context.mjs";

const context = fetchHubContext();
if (context) console.log(context);
