import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';

export interface GeminiCliRunOptions {
  prompt: string;
  cwd: string;
  model: string | null;
  resumeSessionId: string | null;
  includeDirectories: string[];
  approvalMode: 'default' | 'auto_edit' | 'yolo' | 'plan';
  timeoutMs: number;
}

export interface GeminiCliRunCallbacks {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: unknown) => void;
  onTimeout?: () => void;
}

export interface GeminiCliRunHandle {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  cancel(signal?: NodeJS.Signals): void;
}

export class GeminiCliClient extends EventEmitter {
  private connected = false;
  private readonly activeRuns = new Set<GeminiCliRunHandle>();

  constructor(
    private readonly geminiCliBin: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.emit('connected');
  }

  async stop(): Promise<void> {
    for (const run of this.activeRuns) {
      run.cancel('SIGTERM');
    }
    this.activeRuns.clear();
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  run(options: GeminiCliRunOptions, callbacks: GeminiCliRunCallbacks): GeminiCliRunHandle {
    const args = ['-p', options.prompt, '--output-format', 'stream-json'];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.approvalMode) {
      args.push('--approval-mode', options.approvalMode);
    }
    for (const includeDirectory of options.includeDirectories) {
      args.push('--include-directories', includeDirectory);
    }
    const child = spawn(this.geminiCliBin, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      stdout.removeAllListeners();
      stderr.removeAllListeners();
      stdout.close();
      stderr.close();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      this.activeRuns.delete(handle);
    };

    const handle: GeminiCliRunHandle = {
      process: child,
      cancel: (signal = 'SIGTERM') => {
        if (child.exitCode === null && !child.killed) {
          child.kill(signal);
        }
      },
    };
    this.activeRuns.add(handle);

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        this.logger.warn('gemini.turn_timeout', { cwd: options.cwd, timeoutMs: options.timeoutMs });
        callbacks.onTimeout?.();
        handle.cancel('SIGTERM');
      }, options.timeoutMs);
    }

    stdout.on('line', (line) => {
      callbacks.onStdoutLine?.(line);
    });
    stderr.on('line', (line) => {
      callbacks.onStderrLine?.(line);
    });
    child.on('error', (error) => {
      cleanup();
      callbacks.onError?.(error);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      callbacks.onExit?.(code, signal);
    });

    return handle;
  }
}
