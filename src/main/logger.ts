import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Replaces the user's home folder (every slash style, any case) with `~`: error messages and ffmpeg
 * output name files, and a log that gets attached to a bug report must not carry the Windows user
 * name. Pure; `home` is a parameter for the tests.
 */
export function redactHome(text: string, home: string = os.homedir()): string {
  if (!home || home.length < 3) return text;
  let result = text;
  const variants = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')]);
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '~');
  }
  return result;
}

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 8000;

/**
 * Append-only log file with a single rotation (main.log -> main.old.log at 2 MB).
 * Only ever pass diagnostic text: never capture content or file bytes.
 * Synchronous on purpose: it must work inside uncaughtException handlers and at exit.
 */
export class Logger {
  private readonly file: string;
  private readonly oldFile: string;

  constructor(
    dir: string,
    private readonly maxBytes: number = MAX_LOG_BYTES,
  ) {
    this.file = path.join(dir, 'main.log');
    this.oldFile = path.join(dir, 'main.old.log');
    fs.mkdirSync(dir, { recursive: true });
  }

  get path(): string {
    return this.file;
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    this.write('error', error === undefined ? message : `${message} ${describeError(error)}`);
  }

  private write(level: LogLevel, message: string): void {
    try {
      const clipped =
        message.length > MAX_LINE_CHARS ? `${message.slice(0, MAX_LINE_CHARS)}...` : message;
      const text = redactHome(clipped);
      const line = `${new Date().toISOString()} [${level}] ${text.replace(/\r?\n/g, '\n  ')}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // Logging must never take the app down.
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size + incomingBytes > this.maxBytes) {
      fs.rmSync(this.oldFile, { force: true });
      fs.renameSync(this.file, this.oldFile);
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

let instance: Logger | undefined;

/** Call once after userData is final. */
export function initLogger(dir: string): Logger {
  instance = new Logger(dir);
  return instance;
}

/** Safe to call before init (messages are dropped; they go to the console in that case). */
export const log = {
  info: (message: string) => (instance ? instance.info(message) : console.info(message)),
  warn: (message: string) => (instance ? instance.warn(message) : console.warn(message)),
  error: (message: string, error?: unknown) =>
    instance ? instance.error(message, error) : console.error(message, error),
};
