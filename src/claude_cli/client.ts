import { EventEmitter } from 'node:events';
import { type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';
import { spawnCommand } from '../process/spawn_command.js';

export interface ClaudeCliRunOptions {
  prompt: string;
  cwd: string;
  model: string | null;
  resumeSessionId: string | null;
  includeDirectories: string[];
  allowedTools: string[];
  permissionMode: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan';
  timeoutMs: number;
}

export interface ClaudeCliRunCallbacks {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: unknown) => void;
  onTimeout?: () => void;
}

export interface ClaudeCliRunHandle {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  cancel(signal?: NodeJS.Signals): void;
}

export class ClaudeCliClient extends EventEmitter {
  private connected = false;
  private readonly activeRuns = new Set<ClaudeCliRunHandle>();

  constructor(
    private readonly claudeCliBin: string,
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

  run(options: ClaudeCliRunOptions, callbacks: ClaudeCliRunCallbacks): ClaudeCliRunHandle {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }
    if (options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }
    for (const includeDirectory of options.includeDirectories) {
      args.push('--add-dir', includeDirectory);
    }
    args.push('--', options.prompt);
    const child = spawnCommand(this.claudeCliBin, args, {
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

    const handle: ClaudeCliRunHandle = {
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
        this.logger.warn('claude.turn_timeout', { cwd: options.cwd, timeoutMs: options.timeoutMs });
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
