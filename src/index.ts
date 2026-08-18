/** Programmatic surface, for anyone who wants the pieces without the CLI. */
export { configSchema, type Config } from './config/schema.js';
export { defaultConfig, loadConfig, parseConfig, saveConfig } from './config/load.js';
export {
  type Decision,
  type RotorState,
  decide,
  decideHardKill,
  emptyState,
  levelFor,
  pickTarget,
} from './core/decide.js';
export {
  type UsageReading,
  activeAccount,
  readingFromAutoStream,
  readingFromListOutput,
} from './core/usage.js';
export { type Manifest, parseManifest, renderManifestMarkdown } from './core/manifest.js';
export { DEFAULT_PATTERNS, compilePatterns, scanText } from './core/secrets.js';
export { parseHookPayload, renderHookResponse } from './core/hookPayload.js';
export {
  DEFAULT_HOOK_SPECS,
  installRotorccHooks,
  removeRotorccHooks,
} from './core/settingsMerge.js';
export { performCheckpoint } from './core/checkpoint.js';
export { schedulerPlan } from './core/scheduler.js';
export { VERSION } from './version.js';
