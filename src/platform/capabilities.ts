import { spawnSync } from 'node:child_process';

export type ServiceManager = 'launchd' | 'systemd' | 'manual';
export type RestartMode = 'service' | 'in-process' | 'none';

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export interface PlatformCapabilities {
  os: NodeJS.Platform;
  serviceManager: ServiceManager;
  restartMode: RestartMode;
  supportsDesktopOpen: boolean;
  supportsDeepLink: boolean;
  supportsAutolaunch: boolean;
  commandLookupProgram: 'which' | 'where';
}

export interface DesktopOpenSupport {
  available: boolean;
  command: string | null;
  reason: string | null;
}

export function detectPlatformCapabilities(platform: NodeJS.Platform = process.platform): PlatformCapabilities {
  switch (platform) {
    case 'darwin':
      return {
        os: platform,
        serviceManager: 'launchd',
        restartMode: 'service',
        supportsDesktopOpen: true,
        supportsDeepLink: true,
        supportsAutolaunch: true,
        commandLookupProgram: 'which',
      };
    case 'linux':
      return {
        os: platform,
        serviceManager: 'systemd',
        restartMode: 'service',
        supportsDesktopOpen: true,
        supportsDeepLink: true,
        supportsAutolaunch: true,
        commandLookupProgram: 'which',
      };
    case 'win32':
      return {
        os: platform,
        serviceManager: 'manual',
        restartMode: 'in-process',
        supportsDesktopOpen: true,
        supportsDeepLink: true,
        supportsAutolaunch: true,
        commandLookupProgram: 'where',
      };
    default:
      return {
        os: platform,
        serviceManager: 'manual',
        restartMode: 'none',
        supportsDesktopOpen: false,
        supportsDeepLink: false,
        supportsAutolaunch: false,
        commandLookupProgram: 'which',
      };
  }
}

export function getCommandLookupProgram(platform: NodeJS.Platform = process.platform): 'which' | 'where' {
  return detectPlatformCapabilities(platform).commandLookupProgram;
}

export function getOpenUrlCommand(url: string, platform: NodeJS.Platform = process.platform): OpenUrlCommand {
  const capabilities = detectPlatformCapabilities(platform);
  switch (capabilities.os) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
      return { command: 'xdg-open', args: [url] };
    default:
      throw new Error(`Desktop open is not supported on platform: ${platform}`);
  }
}

export function getDesktopOpenSupport(
  platform: NodeJS.Platform = process.platform,
  hasCommand: (commandName: string, platformName?: NodeJS.Platform) => boolean = commandExists,
): DesktopOpenSupport {
  const capabilities = detectPlatformCapabilities(platform);
  if (!capabilities.supportsDesktopOpen || !capabilities.supportsDeepLink) {
    return {
      available: false,
      command: null,
      reason: `desktop deep links are not supported on this host (${platform})`,
    };
  }

  const { command } = getOpenUrlCommand('codex://threads/healthcheck', platform);
  if (!hasCommand(command, platform)) {
    return {
      available: false,
      command,
      reason: `${command} is not available in PATH`,
    };
  }

  return {
    available: true,
    command,
    reason: null,
  };
}

function commandExists(commandName: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const lookupProgram = getCommandLookupProgram(platform);
    const result = spawnSync(lookupProgram, [commandName], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}
