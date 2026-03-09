import type { AppLocale, PendingApprovalRecord } from '../types.js';
import { t } from '../i18n.js';

export interface ActiveTurnStatusSnapshot {
  interruptRequested: boolean;
  pendingApprovalKinds: ReadonlySet<PendingApprovalRecord['kind']>;
  awaitingUserInput: boolean;
  toolStatusText: string | null;
  reasoningActive: boolean;
  hasStreamingReply: boolean;
}

export function renderActiveTurnStatus(locale: AppLocale, snapshot: ActiveTurnStatusSnapshot): string {
  if (snapshot.interruptRequested) {
    return t(locale, 'interrupt_requested_waiting');
  }
  if (snapshot.pendingApprovalKinds.size > 0) {
    return t(locale, 'approval_requested', { kind: formatApprovalKinds(locale, snapshot.pendingApprovalKinds) });
  }
  if (snapshot.awaitingUserInput) {
    return t(locale, 'waiting_for_input');
  }
  if (snapshot.toolStatusText) {
    return snapshot.toolStatusText;
  }
  if (snapshot.reasoningActive) {
    return locale === 'zh' ? '正在思考...' : 'Thinking...';
  }
  if (snapshot.hasStreamingReply) {
    return locale === 'zh' ? '正在回复...' : 'Streaming reply...';
  }
  return locale === 'zh' ? '正在思考...' : 'Thinking...';
}

export function formatApprovalKinds(locale: AppLocale, kinds: ReadonlySet<PendingApprovalRecord['kind']>): string {
  const values = [...kinds].map(kind => locale === 'zh'
    ? kind === 'fileChange' ? '文件修改' : '命令执行'
    : kind === 'fileChange' ? 'file change' : 'command');
  if (values.length === 0) {
    return locale === 'zh' ? '审批' : 'approval';
  }
  return values.join(locale === 'zh' ? '、' : ', ');
}
