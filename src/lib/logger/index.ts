import { v4 as uuidv4 } from 'uuid';

import type { Level, LogFields, Logger, LogConfig } from './types';
import { loadConfig, saveConfig, resetConfig } from './config';
import { isLevelEnabled, resolveLevel } from './levels';
import { resolveNamespace } from './namespace';
import { serializeFields } from './serialize';
import { globalTransport } from './transport';
import { useLogStore } from './store';

// Wire up backend error events to LogPanel
let backendListenerRegistered = false;
async function ensureBackendErrorListener(): Promise<void> {
  if (backendListenerRegistered) return;
  backendListenerRegistered = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ message: string; model: string; provider: string; ts: number }>('backend:ai-error', (event) => {
      const payload = event.payload;
      useLogStore.getState().appendEntry({
        id: uuidv4(),
        ts: payload.ts ?? Date.now(),
        level: 'error',
        target: `backend:${payload.provider}`,
        message: payload.message,
        fields: { model: payload.model },
      });
    });
  } catch {
    // Not in Tauri environment, ignore
  }
}
// Start listening when module loads
ensureBackendErrorListener();

function collectFields(args: unknown[]): LogFields {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0] as LogFields;
  }
  // 多个参数：作为 args 数组传入
  return { args };
}

function emit(level: Level, target: string, msg: string, ...args: unknown[]): void {
  const config = loadConfig();
  const effective = resolveLevel(target, config);
  if (!isLevelEnabled(level, effective)) return;

  const fields = collectFields(args);

  const message =
    fields && fields.err instanceof Error
      ? `${msg} | ${(fields.err as Error).stack ?? (fields.err as Error).message}`
      : msg;

  const entry = {
    id: uuidv4(),
    ts: Date.now(),
    level,
    target,
    message,
    fields: serializeFields(fields),
  };
  globalTransport.send(entry, config);
}

function makeLogger(target: string | null): Logger {
  // If target is null, resolve at call time (for the default `logger` export)
  const getTarget = (): string => target ?? resolveNamespace(2);
  return {
    debug: (msg, ...args) => emit('debug', getTarget(), msg, ...args),
    info: (msg, ...args) => emit('info', getTarget(), msg, ...args),
    warn: (msg, ...args) => emit('warn', getTarget(), msg, ...args),
    error: (msg, ...args) => emit('error', getTarget(), msg, ...args),
  };
}

export const logger: Logger = makeLogger(null);

export function getLogger(ns: string): Logger {
  return makeLogger(ns);
}

export function setLogConfig(cfg: Partial<LogConfig>): void {
  saveConfig(cfg);
}

export function getLogConfig(): LogConfig {
  return loadConfig();
}

export function resetLogConfig(): void {
  resetConfig();
}

export { useLogStore } from './store';
export type { LogEntry, LogConfig, Level, LogFields, Logger } from './types';