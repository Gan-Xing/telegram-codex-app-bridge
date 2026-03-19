import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import type { Readable } from 'node:stream';

function shouldUseShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') {
    return false;
  }
  const trimmed = command.trim();
  return trimmed.length > 0 && (!/\.[^\\/]+$/i.test(trimmed) || /\.(cmd|bat)$/i.test(trimmed));
}

export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(command, [...args], {
    ...options,
    shell: options.shell ?? shouldUseShell(command),
  }) as ChildProcessByStdio<null, Readable, Readable>;
}

export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> | SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    ...options,
    shell: options.shell ?? shouldUseShell(command),
  }) as SpawnSyncReturns<Buffer> | SpawnSyncReturns<string>;
}
