import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  summarizeTelegramInput,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from './media.js';

test('isNativeImageAttachment recognizes native image inputs', () => {
  const photo: TelegramInboundAttachment = {
    kind: 'photo',
    fileId: 'photo-id',
    fileUniqueId: 'photo-unique',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 1_024,
    width: 800,
    height: 600,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  };
  const pngDocument: TelegramInboundAttachment = {
    kind: 'document',
    fileId: 'doc-id',
    fileUniqueId: 'doc-unique',
    fileName: 'diagram.png',
    mimeType: 'image/png',
    fileSize: 2_048,
    width: null,
    height: null,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  };
  const pdfDocument: TelegramInboundAttachment = {
    ...pngDocument,
    fileId: 'pdf-id',
    fileUniqueId: 'pdf-unique',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
  };

  assert.equal(isNativeImageAttachment(photo), true);
  assert.equal(isNativeImageAttachment(pngDocument), true);
  assert.equal(isNativeImageAttachment(pdfDocument), false);
});

test('planAttachmentStoragePath keeps files inside the thread inbox', () => {
  const attachment: TelegramInboundAttachment = {
    kind: 'document',
    fileId: 'doc-id',
    fileUniqueId: 'AbC12345',
    fileName: 'Quarterly Report.pdf',
    mimeType: 'application/pdf',
    fileSize: 3_072,
    width: null,
    height: null,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  };

  const planned = planAttachmentStoragePath(
    '/tmp/project',
    'thread-123',
    attachment,
    'documents/file_9',
    new Date('2026-03-07T12:34:56.000Z'),
  );

  assert.match(planned.relativePath, /^\.telegram-inbox[\\/]+2026-03-07[\\/]+thread-123[\\/]+20260307-123456-AbC12345-Quarterly-Report\.pdf$/);
  assert.equal(path.isAbsolute(planned.localPath), true);
  assert.match(planned.localPath, new RegExp(`${escapeRegExp(path.join('.telegram-inbox', '2026-03-07', 'thread-123', '20260307-123456-AbC12345-Quarterly-Report.pdf'))}$`));
  assert.equal(planned.fileName, 'Quarterly-Report.pdf');
});

test('buildAttachmentPrompt includes local paths and native image markers', () => {
  const staged: StagedTelegramAttachment[] = [{
    kind: 'photo',
    fileId: 'photo-id',
    fileUniqueId: 'photo-unique',
    fileName: 'telegram-photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 4_096,
    width: 1024,
    height: 768,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
    localPath: '/tmp/project/.telegram-inbox/2026-03-07/thread-123/telegram-photo.jpg',
    relativePath: '.telegram-inbox/2026-03-07/thread-123/telegram-photo.jpg',
    nativeImage: true,
  }];

  const prompt = buildAttachmentPrompt('Please inspect this screenshot.', staged);
  const expectedPath = escapeRegExp(staged[0]!.localPath);

  assert.match(prompt, /Please inspect this screenshot\./);
  assert.match(prompt, /filename: telegram-photo\.jpg/);
  assert.match(prompt, new RegExp(`path: ${expectedPath}`));
  assert.match(prompt, /attached_as: localImage/);
});

test('summarizeTelegramInput includes attachment labels', () => {
  const summary = summarizeTelegramInput('Need a summary', [{
    kind: 'document',
    fileId: 'doc-id',
    fileUniqueId: 'doc-unique',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 10,
    width: null,
    height: null,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  }]);

  assert.equal(summary, 'Need a summary [attachments: document:report.pdf]');
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
