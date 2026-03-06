import https from 'node:https';

export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

const API_HOST = 'api.telegram.org';

export async function callTelegramApi<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  const payload = JSON.stringify(body);
  return new Promise<TelegramApiResult<T>>((resolve, reject) => {
    const request = https.request({
      host: API_HOST,
      port: 443,
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      family: 4,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(text) as TelegramApiResult<T>);
        } catch (error) {
          reject(new Error(`Failed to parse Telegram response: ${String(error)}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(20_000, () => {
      request.destroy(new Error(`Telegram API request timed out for ${method}`));
    });
    request.write(payload);
    request.end();
  });
}
