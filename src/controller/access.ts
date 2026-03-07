import type { AppConfig } from '../config.js';
import type { AccessPresetValue, ApprovalPolicyValue, ChatSessionSettings, SandboxModeValue } from '../types.js';

export interface ResolvedAccessMode {
  preset: AccessPresetValue;
  approvalPolicy: ApprovalPolicyValue;
  sandboxMode: SandboxModeValue;
}

export const ACCESS_PRESETS: AccessPresetValue[] = ['read-only', 'default', 'full-access'];

export function normalizeAccessPreset(value: string | null | undefined): AccessPresetValue | null {
  if (value === 'read-only' || value === 'default' || value === 'full-access') {
    return value;
  }
  return null;
}

export function resolveConfiguredAccessPreset(settings: Pick<ChatSessionSettings, 'accessPreset'> | null | undefined): AccessPresetValue {
  return settings?.accessPreset ?? 'default';
}

export function resolveAccessMode(
  config: Pick<AppConfig, 'defaultApprovalPolicy' | 'defaultSandboxMode'>,
  settings: Pick<ChatSessionSettings, 'accessPreset'> | null | undefined,
): ResolvedAccessMode {
  const preset = resolveConfiguredAccessPreset(settings);
  switch (preset) {
    case 'read-only':
      return {
        preset,
        approvalPolicy: 'on-request',
        sandboxMode: 'read-only',
      };
    case 'full-access':
      return {
        preset,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      };
    default:
      return {
        preset: 'default',
        approvalPolicy: config.defaultApprovalPolicy,
        sandboxMode: config.defaultSandboxMode,
      };
  }
}
