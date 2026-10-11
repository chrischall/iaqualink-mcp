#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

// Scaffold only — the iAqualink client and tools land in the first feature PR.
await runMcp({
  name: 'iaqualink-mcp',
  version: VERSION,
  banner: '[iaqualink-mcp] This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  tools: [],
});
