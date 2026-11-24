import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountStore } from './accounts.mjs';
import { languageFromRequest, t, withLanguage } from './i18n.mjs';
import { accountInput, createMailService, MailError, providers } from './mail.mjs';
import { createSettingsStore, settingOptions } from './settings.mjs';
import { languages } from './web/i18n.js';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const localHost = '127.0.0.1';
const version = '2.1.0';
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(response, status, data) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new MailError(415, 'err.badRequest');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new MailError(413, 'err.tooLarge');
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MailError(400, 'err.badRequest');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MailError(400, 'err.badRequest');
  return data;
}

function uidParam(params, key) {
  const value = params.get(key);
  if (value === null) return undefined;
  if (!/^\d{1,10}$/.test(value) || +value < 1 || +value > 4294967295) throw new MailError(400, 'err.badUid');
  return Number(value);
}

function probe(host, port, timeout) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error: error || null });
    };
    socket.setTimeout(Math.max(1000, timeout));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', error => finish(false, error.code || error.message || 'error'));
  });
}

function proxyTarget(proxy) {
  try {
    const url = new URL(proxy);
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'http:' ? 8080 : 1080) };
  } catch {
    return null;
  }
}

export async function startApp({ directory, mail, vault, port = 0, settings, hooks = {} } = {}) {
  const store = await createAccountStore(directory, vault);
  const config = settings || createSettingsStore(directory);
  const mailService = mail || createMailService({ getSettings: () => config.get() });
  const token = randomBytes(32).toString('hex');
  const assetContents = {};
  await Promise.all(Object.entries(assets).map(async ([path, [file, type]]) => {
    const text = await readFile(new URL(`./web/${file}`, import.meta.url), 'utf8');
    assetContents[path] = { type, content: path === '/' ? text.replace('%%SESSION%%', token) : text };
  }));

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30000 }, (request, response) => {
    const language = languageFromRequest(request, config.get().language);
    withLanguage(language, () => {
      handle(request, response).catch(error => {
        const known = error instanceof MailError;
        if (!known) console.error('Simple Mail request failed:', error?.code ?? error?.name);
        const status = known ? error.status : 500;
        const message = known ? t(error.key, error.params) : t('err.internal');
        if (!response.headersSent) json(response, status, { error: message });
        else response.end();
      });
    });
  });

  function providerList() {
    return Object.fromEntries(Object.entries(providers).map(([key, value]) => [key, { domain: value.domain }]));
  }

  function info() {
    return {
      version,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      node: process.versions.node || null,
      platform: process.platform,
      desktop: Boolean(process.versions.electron),
      dataDir: directory,
    };
  }

  async function handle(request, response) {
    const host = `${localHost}:${server.address().port}`;
    const origin = `http://${host}`;
    if (request.headers.host !== host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new MailError(403, 'err.localOnly');
    }
    const url = new URL(request.url, origin);
    if (url.origin !== origin) throw new MailError(403, 'err.localOnly');
    const method = request.method;
    const path = url.pathname;
    const asset = Object.hasOwn(assetContents, path) ? assetContents[path] : undefined;
    if (asset && (method === 'GET' || method === 'HEAD')) {
      response.writeHead(200, { ...headers, 'Content-Type': asset.type });
      response.end(method === 'HEAD' ? undefined : asset.content);
      return;
    }
    if (!path.startsWith('/api/')) throw new MailError(404, 'err.notFound');
    const supplied = Buffer.from(request.headers['x-simple-mail'] || '');
    const expected = Buffer.from(token);
    if ((request.headers.origin && request.headers.origin !== origin) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new MailError(403, 'err.badSession');
    }
    if (method === 'GET' && path === '/api/config') {
      return json(response, 200, {
        accounts: store.list(),
        providers: providerList(),
        canRemember: store.canRemember,
        settings: config.get(),
        languages,
        options: {
          pageSize: settingOptions.pageSize,
          autoRefresh: settingOptions.autoRefresh,
        },
        info: info(),
      });
    }
    if (method === 'PUT' && path === '/api/settings') {
      const saved = config.update(await readJson(request));
      return json(response, 200, { settings: saved });
    }
    if (method === 'POST' && path === '/api/settings/reset') {
      return json(response, 200, { settings: config.reset() });
    }
    if (method === 'GET' && path === '/api/diagnostics') {
      const current = config.get();
      const started = Date.now();
      const targets = [...new Set(store.list().map(account => `${account.host}:${account.port}`))]
        .map(item => {
          const index = item.lastIndexOf(':');
          return { host: item.slice(0, index), port: Number(item.slice(index + 1)) };
        });
      const timeout = Math.min(20000, Math.max(4000, current.connectTimeout * 1000));
      const results = await Promise.all(targets.map(async target => ({
        host: target.host,
        port: target.port,
        ...(await probe(target.host, target.port, timeout)),
      })));
      const target = current.mailProxy ? proxyTarget(current.mailProxy) : null;
      const proxyResult = target ? { ...target, ...(await probe(target.host, target.port, Math.min(6000, timeout))) } : null;
      return json(response, 200, {
        service: { ok: true, ms: Date.now() - started },
        policy: { bypassProxy: current.bypassProxy, mailProxy: current.mailProxy || '' },
        mail: results,
        proxy: proxyResult,
      });
    }
    if (method === 'POST' && path === '/api/open-data-dir') {
      if (hooks.openPath) {
        await hooks.openPath(directory);
        return json(response, 200, { opened: true });
      }
      const open = process.platform === 'win32'
        ? ['explorer.exe', [directory]]
        : process.platform === 'darwin' ? ['open', [directory]] : ['xdg-open', [directory]];
      execFile(open[0], open[1], { windowsHide: true }, () => {});
      return json(response, 200, { opened: true });
    }
    if (method === 'POST' && path === '/api/restart') {
      if (!hooks.restart) throw new MailError(501, 'err.noDesktop');
      json(response, 200, { restarting: true });
      setTimeout(() => hooks.restart(), 120);
      return;
    }
    if (method === 'POST' && path === '/api/accounts') {
      const input = accountInput(await readJson(request));
      if (store.list().some(account => account.email.toLowerCase() === input.email.toLowerCase())) {
        throw new MailError(409, 'err.duplicate');
      }
      await mailService.check(input);
      return json(response, 201, await store.save(null, input));
    }
    const accountPath = path.match(/^\/api\/accounts\/([0-9a-f-]{36})(?:\/(folders|messages|message|recent))?$/);
    if (!accountPath) throw new MailError(404, 'err.notFound');
    const [, id, action] = accountPath;
    if (!action && method === 'PUT') {
      const original = store.find(id);
      const input = accountInput({ ...original, ...await readJson(request), email: original.email, provider: original.provider });
      await mailService.check(input);
      return json(response, 200, await store.save(id, input));
    }
    if (!action && method === 'DELETE') {
      await store.remove(id);
      return json(response, 200, { removed: true });
    }
    if (method === 'GET' && action === 'folders') {
      return json(response, 200, await mailService.folders(await store.withPassword(id)));
    }
    if (method === 'GET' && action === 'recent') {
      const current = config.get();
      return json(response, 200, await mailService.recent(await store.withPassword(id), {
        includeJunk: current.includeJunk,
        size: current.pageSize,
      }));
    }
    if (method === 'GET' && (action === 'messages' || action === 'message')) {
      const params = url.searchParams;
      const folder = params.get('folder') || 'INBOX';
      const validity = params.get('validity') || '';
      if (folder.length > 1024 || /[\0\r\n]/.test(folder) || (validity && !/^\d{1,20}$/.test(validity))) {
        throw new MailError(400, 'err.badFolder');
      }
      const account = await store.withPassword(id);
      if (action === 'messages') {
        const q = (params.get('q') || '').trim();
        if (q.length > 160 || /[\0\r\n]/.test(q)) throw new MailError(400, 'err.badQuery');
        return json(response, 200, await mailService.messages(account, {
          path: folder,
          before: uidParam(params, 'before'),
          q,
          validity,
          bulk: params.get('bulk') === '1',
          size: config.get().pageSize,
        }));
      }
      const uid = uidParam(params, 'uid');
      if (!uid) throw new MailError(400, 'err.missingUid');
      return json(response, 200, await mailService.message(account, { path: folder, uid, validity }));
    }
    throw new MailError(404, 'err.notFound');
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, localHost, resolve);
  });
  return { url: `http://${localHost}:${server.address().port}`, server, settings: config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = join(process.env.LOCALAPPDATA || homedir(), 'SimpleMail');
  try {
    const portArg = process.argv.find(arg => /^--port=\d+$/.test(arg));
    const { url } = await startApp({ directory, port: portArg ? Number(portArg.slice(7)) : 0 });
    console.log(`\n  Simple Mail | ${url}\n  Keep this window open while reading email. Press Ctrl+C to stop.\n`);
    if (process.argv.includes('--open')) {
      const onError = error => { if (error) console.error(`Open ${url} in your browser.`); };
      if (process.platform === 'win32') execFile('cmd.exe', ['/d', '/c', `start "" "${url}"`], { windowsHide: true }, onError);
      else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], onError);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
