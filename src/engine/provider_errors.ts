export class ProviderError extends Error {
  readonly code: string;

  constructor(message: string, code = 'provider_error') {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export class ProviderUnsupportedError extends ProviderError {
  constructor(
    readonly engine: 'codex' | 'gemini' | 'claude',
    readonly feature: string,
    message?: string,
  ) {
    super(message ?? `${engine} does not support ${feature}`, 'provider_unsupported');
    this.name = 'ProviderUnsupportedError';
  }
}

export function unsupportedProviderFeature(
  engine: 'codex' | 'gemini' | 'claude',
  feature: string,
  message?: string,
): ProviderUnsupportedError {
  return new ProviderUnsupportedError(engine, feature, message);
}
