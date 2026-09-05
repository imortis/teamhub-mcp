#!/usr/bin/env node
// Cursor hook (session-start equivalent). Pure Node - no bash dependency.
//
// Cursor's hooks config format is newer and evolving - check
// https://cursor.com/docs/hooks for the current registration syntax for
// your installed version. Functionally this does the same thing as the
// Claude Code hook: fetch the shared handoff brief and print it.

import { fetchHubContext } from "../lib/fetch-context.mjs";

const context = fetchHubContext();
if (context) console.log(context);
