import type { BridgeSessionCore } from '../../controller/controller.js';

/**
 * Telegram channel: inbound subscription + transport startup ordering for {@link BridgeSessionCore}.
 * Additional channels (e.g. Weixin) can compose the same core with their own adapters.
 */
export class TelegramChannelAdapter {
  constructor(private readonly core: BridgeSessionCore) {}

  async start(): Promise<void> {
    this.core.registerTelegramInboundHandlers();
    await this.core.startCodexApp();
    await this.core.startTelegramPolling();
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  get sessionCore(): BridgeSessionCore {
    return this.core;
  }
}
