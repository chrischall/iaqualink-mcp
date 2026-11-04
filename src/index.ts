#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { IaqualinkClient } from './client.js';
import { timingFromEnv, type Deps } from './tools/deps.js';
import { loadSystemLabels } from './tools/systems.js';
import { registrars } from './tools/index.js';

// The client is built ONCE here, outside runMcp's per-connection factory, so
// its session and status cache are shared by every served instance. It defers
// a missing-credential error to the first tool call, so the server still boots
// and answers a host's install-time tools/list without IAQUALINK_* set.
const client = new IaqualinkClient();
// The systems are listed ONCE, before serving, so every `serial` argument can
// publish their names as an enum. A failed or slow listing (no credential yet,
// at install time) publishes no enum and the tools still work by serial.
const deps: Deps = { client, timing: timingFromEnv(), systems: await loadSystemLabels(client) };

await runMcp({
  name: 'iaqualink-mcp',
  version: VERSION,
  banner: '[iaqualink-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  deps,
  tools: registrars,
});
