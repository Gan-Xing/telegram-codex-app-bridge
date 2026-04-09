import type { Logger } from '../../../logger.js';

export type IlinkLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export interface IlinkRuntimeContext {
  logger: IlinkLogger;
  /** Optional routing tag for some IDC deployments. */
  routeTag?: string;
  channelVersion: string;
  ilinkAppId: string;
  ilinkAppClientVersion: number;
}

let ctx: IlinkRuntimeContext | null = null;

export function setIlinkRuntimeContext(next: IlinkRuntimeContext | null): void {
  ctx = next;
}

export function getIlinkRuntimeContext(): IlinkRuntimeContext {
  if (!ctx) {
    throw new Error('Weixin iLink runtime not initialized (setIlinkRuntimeContext)');
  }
  return ctx;
}

export function tryGetIlinkRuntimeContext(): IlinkRuntimeContext | null {
  return ctx;
}
