#!/usr/bin/env node
'use strict';
// `npm run connect`: lets Claude and Cursor drive Pocket, by adding Pocket's MCP server to the
// Claude app's and Cursor's settings (whichever are on this Mac). Run it again any time; to undo
// it, delete the "pocket" entry under mcpServers in those settings.

const { connectAgents, installedApp } = require('./build');

const app = installedApp();
if (!app) {
  console.error('Pocket isn\'t installed yet. Build it first: npm run build');
  process.exit(1);
}
connectAgents(app);
