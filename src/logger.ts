import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_SIZE = 1_000_000;

export class Logger {
  constructor(private level: LogLevel, private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  debug(message: string, meta?: unknown): void { this.write('debug', message, meta); }
  info(message: string, meta?: unknown): void { this.write('info', message, meta); }
  warn(message: string, meta?: unknown): void { this.write('warn', message, meta); }
  error(message: string, meta?: unknown): void { this.write('error', message, meta); }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (RANK[level] < RANK[this.level]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(meta === undefined ? {} : { meta })
    };
    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
    this.rotateIfNeeded();
    fs.appendFileSync(this.filePath, line + '\n', 'utf8');
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < MAX_SIZE) return;
      const rotated = `${this.filePath}.1`;
      try {
        fs.rmSync(rotated, { force: true });
      } catch {
        return;
      }
      fs.renameSync(this.filePath, rotated);
    } catch {
      // ignore missing file
    }
  }
}
