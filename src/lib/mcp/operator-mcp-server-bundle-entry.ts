#!/usr/bin/env node

import './operator-node22-reexec';
import './neutralize-server-only';

await import(new URL('./operator-mcp-server-main.mjs', import.meta.url).href);
