#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { IaqualinkClient } from './client.js';
import { DEFAULT_TIMING, type Deps } from './tools/deps.js';
import { registrars } from './tools/index.js';

// The client is built ONCE here, outside runMcp's per-connection factory, so
// its session and status cache are shared by every served instance. It defers
// a missing-credential error to the first tool call, so the server still boots
// and answers a host's install-time tools/list without IAQUALINK_* set.
const deps: Deps = { client: new IaqualinkClient(), timing: DEFAULT_TIMING };

await runMcp({
  name: 'iaqualink-mcp',
  version: VERSION,
  banner: '[iaqualink-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  deps,
  tools: registrars,
});
