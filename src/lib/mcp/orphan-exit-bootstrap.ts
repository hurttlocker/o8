/**
 * This side-effect import must precede MCP handler/store imports. Cortex's
 * dependency graph initializes SQLite and the WS token during module loading.
 */
import { exitWhenBundleDeleted } from './orphan-exit';

exitWhenBundleDeleted('o8-mcp');
