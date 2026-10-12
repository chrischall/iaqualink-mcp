import type { McpServer } from '@modelcontextprotocol/server';
import { registerReadTools } from './read.js';
import { registerControlTools } from './control.js';
import { registerScheduleTools } from './schedules.js';
import { registerOneTouchTools } from './onetouch.js';
import { registerPanelTools } from './panel.js';
import { registerPanelCheckTool } from './panel-check.js';
import { registerPumpTools } from './pump.js';
import type { Deps } from './deps.js';

/** Every registrar, in roster order. index.ts and the tests both use this list. */
export const registrars: Array<(server: McpServer, deps: Deps) => void> = [
  registerReadTools,
  registerControlTools,
  registerScheduleTools,
  registerPanelTools,
  registerPanelCheckTool,
  registerOneTouchTools,
  registerPumpTools,
];
