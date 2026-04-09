import type { Logger } from '../../../logger.js';
import { BRIDGE_PACKAGE_VERSION, ILINK_APP_CLIENT_VERSION, ILINK_APP_ID } from './constants.js';
import { setIlinkRuntimeContext } from './context.js';

/** Wire bridge {@link Logger} and package version into iLink HTTP helpers. */
export function attachIlinkRuntimeFromBridgeLogger(logger: Logger, routeTag?: string | null): void {
  const trimmed = routeTag?.trim();
  setIlinkRuntimeContext({
    logger,
    channelVersion: BRIDGE_PACKAGE_VERSION,
    ilinkAppId: ILINK_APP_ID,
    ilinkAppClientVersion: ILINK_APP_CLIENT_VERSION,
    ...(trimmed ? { routeTag: trimmed } : {}),
  });
}
