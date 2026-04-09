import { spawn } from 'node:child_process';

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export function buildThreadDeepLink(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export function getOpenUrlCommand(url: string, platform: NodeJS.Platform = process.platform): OpenUrlCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

export async function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const { command, args } = getOpenUrlCommand(url, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
