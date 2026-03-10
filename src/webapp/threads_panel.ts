const WEB_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Threads</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --surface: #171a21;
      --surface-border: #2d3340;
      --text: #e8ecf3;
      --muted: #9aa4b3;
      --open: #1b8cff;
      --open-border: #4ea7ff;
      --rename: #2f3c52;
      --rename-border: #485a77;
      --danger: #ff7b7b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f5f7fb;
        --surface: #ffffff;
        --surface-border: #d5dcea;
        --text: #182033;
        --muted: #5c687f;
        --open: #1b6fff;
        --open-border: #4a8eff;
        --rename: #e8eef8;
        --rename-border: #c7d4eb;
        --danger: #c63535;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 12px;
    }
    .shell {
      display: grid;
      gap: 10px;
      max-width: 960px;
      margin: 0 auto;
    }
    .header {
      font-size: 15px;
      line-height: 1.4;
      color: var(--muted);
    }
    .item {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 10px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .title {
      font-size: 14px;
      line-height: 1.35;
      word-break: break-word;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
    }
    .actions {
      display: grid;
      grid-template-columns: 7fr 3fr;
      gap: 8px;
    }
    .btn {
      border: 1px solid transparent;
      border-radius: 8px;
      min-height: 40px;
      padding: 0 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .btn-open {
      background: var(--open);
      border-color: var(--open-border);
      color: #fff;
    }
    .btn-rename {
      background: var(--rename);
      border-color: var(--rename-border);
      color: var(--text);
    }
    .empty, .error {
      color: var(--muted);
      border: 1px dashed var(--surface-border);
      border-radius: 10px;
      padding: 14px;
      font-size: 14px;
      line-height: 1.4;
    }
    .error { color: var(--danger); }
  </style>
</head>
<body>
  <main id="app" class="shell"></main>
  <script>
    (() => {
      const STRINGS = {
        en: {
          header: 'Select a thread action.',
          open: 'Open',
          rename: 'Rename',
          current: 'Current',
          empty: 'No threads available.',
          invalid: 'Invalid thread payload.',
        },
        zh: {
          header: '请选择线程操作。',
          open: '打开',
          rename: '改名',
          current: '当前',
          empty: '当前没有可用线程。',
          invalid: '线程数据无效。',
        },
      };

      const app = document.getElementById('app');
      const webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      if (webApp) {
        webApp.ready();
        webApp.expand();
      }

      function decodePayload(raw) {
        if (!raw) return null;
        try {
          const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
          const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
          const binary = atob(padded);
          const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
          const json = new TextDecoder().decode(bytes);
          return JSON.parse(json);
        } catch {
          return null;
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function sendAction(action, threadId, button) {
        if (button) button.disabled = true;
        try {
          const payload = JSON.stringify({
            v: 1,
            kind: 'threads-panel',
            action,
            threadId,
          });
          if (webApp && typeof webApp.sendData === 'function') {
            webApp.sendData(payload);
          }
        } finally {
          if (webApp && typeof webApp.close === 'function') {
            setTimeout(() => webApp.close(), 80);
          }
        }
      }

      const params = new URLSearchParams(window.location.search);
      const payload = decodePayload(params.get('payload'));
      const locale = payload && payload.locale === 'zh' ? 'zh' : 'en';
      const t = STRINGS[locale];

      const header = document.createElement('div');
      header.className = 'header';
      header.textContent = t.header;
      app.appendChild(header);

      if (!payload || payload.v !== 1 || payload.kind !== 'threads-panel' || !Array.isArray(payload.threads)) {
        const error = document.createElement('div');
        error.className = 'error';
        error.textContent = t.invalid;
        app.appendChild(error);
        return;
      }

      if (payload.threads.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = t.empty;
        app.appendChild(empty);
        return;
      }

      for (const thread of payload.threads) {
        if (!thread || typeof thread.threadId !== 'string') continue;
        const item = document.createElement('article');
        item.className = 'item';

        const title = document.createElement('div');
        title.className = 'title';
        title.innerHTML = escapeHtml(String(thread.title || thread.threadId));
        item.appendChild(title);

        if (thread.isCurrent) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = t.current;
          item.appendChild(meta);
        }

        const actions = document.createElement('div');
        actions.className = 'actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn-open';
        openBtn.type = 'button';
        openBtn.textContent = t.open;
        openBtn.addEventListener('click', () => sendAction('open', thread.threadId, openBtn));
        actions.appendChild(openBtn);

        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn btn-rename';
        renameBtn.type = 'button';
        renameBtn.textContent = t.rename;
        renameBtn.addEventListener('click', () => sendAction('rename_start', thread.threadId, renameBtn));
        actions.appendChild(renameBtn);

        item.appendChild(actions);
        app.appendChild(item);
      }
    })();
  </script>
</body>
</html>
`;

export function renderThreadsPanelHtml(): string {
  return WEB_APP_HTML;
}
