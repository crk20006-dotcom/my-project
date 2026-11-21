import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  detail?: string;
}

const MAX_BUFFER_SIZE = 250;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const logBuffer: SystemLogEntry[] = [];
let logCounter = 0;

function redactSensitiveText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9]{12,}|AIza[0-9A-Za-z\-_]{20,}|ghp_[0-9A-Za-z]{20,})/g, '[REDACTED_KEY]')
    .replace(
      /("?'?(?:passcode|password|token|secret|cookie)"?'?\s*[:=]\s*"?'?)[^\s"',;}]+/gi,
      '$1[REDACTED]'
    );
}

function getLogFilePath(): string {
  return path.resolve(process.cwd(), 'data', 'logs', 'genesis-server.log');
}

function appendToLogFile(entry: SystemLogEntry): void {
  try {
    const filePath = getLogFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size >= MAX_LOG_FILE_BYTES) {
        const rotated = `${filePath}.1`;
        if (fs.existsSync(rotated)) {
          fs.unlinkSync(rotated);
        }
        fs.renameSync(filePath, rotated);
      }
    }
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never crash request handling
  }
}

export function logSystemEvent(
  level: LogLevel,
  category: string,
  message: string,
  detail?: unknown
): SystemLogEntry {
  logCounter += 1;
  const detailStr =
    detail === undefined
      ? undefined
      : typeof detail === 'string'
        ? redactSensitiveText(detail).slice(0, 600)
        : redactSensitiveText(detail instanceof Error ? detail.message : JSON.stringify(detail)).slice(0, 600);

  const entry: SystemLogEntry = {
    id: `log-${Date.now()}-${logCounter}`,
    timestamp: new Date().toISOString(),
    level,
    category: category.slice(0, 48),
    message: redactSensitiveText(message).slice(0, 300),
    ...(detailStr ? { detail: detailStr } : {}),
  };

  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.length = MAX_BUFFER_SIZE;
  }

  if (process.env.NODE_ENV !== 'test') {
    appendToLogFile(entry);
  }

  return entry;
}

export function getRecentSystemLogs(options?: { limit?: number; level?: LogLevel | 'all' }): SystemLogEntry[] {
  const limit = Math.min(200, Math.max(1, options?.limit ?? 60));
  const level = options?.level && options.level !== 'all' ? options.level : null;
  const filtered = level ? logBuffer.filter((e) => e.level === level) : logBuffer;
  return filtered.slice(0, limit);
}

export function getSystemLogSummary(): {
  total_buffered: number;
  error_count: number;
  warn_count: number;
  last_error_at: string | null;
  log_file_path: string;
} {
  let errorCount = 0;
  let warnCount = 0;
  let lastErrorAt: string | null = null;
  for (const e of logBuffer) {
    if (e.level === 'error') {
      errorCount += 1;
      if (!lastErrorAt) lastErrorAt = e.timestamp;
    } else if (e.level === 'warn') {
      warnCount += 1;
    }
  }
  return {
    total_buffered: logBuffer.length,
    error_count: errorCount,
    warn_count: warnCount,
    last_error_at: lastErrorAt,
    log_file_path: getLogFilePath(),
  };
}

export function clearBufferedLogs(): void {
  logBuffer.length = 0;
}
