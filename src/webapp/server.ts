import http from 'node:http';
import type { Logger } from '../logger.js';
import { renderThreadsPanelHtml } from './threads_panel.js';

interface ThreadsWebAppServerOptions {
  host: string;
  port: number;
}

export class ThreadsWebAppServer {
  private server: http.Server | null = null;

  constructor(
    private readonly options: ThreadsWebAppServerOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => this.handleRequest(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.logger.info('webapp.server_started', {
      host: this.options.host,
      port: this.options.port,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const method = request.method || 'GET';
    if (method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Method Not Allowed');
      return;
    }

    const rawUrl = request.url || '/';
    const url = new URL(rawUrl, 'http://localhost');
    if (url.pathname === '/webapp/threads') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(renderThreadsPanelHtml());
      return;
    }
    if (url.pathname === '/webapp/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('Not Found');
  }
}
