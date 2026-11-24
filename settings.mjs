import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLanguage } from './web/i18n.js';
import { MailError } from './mail.mjs';

export const defaultSettings = Object.freeze({
  language: 'zh',
  theme: 'system',
  density: 'comfortable',
  pageSize: 40,
  autoRefresh: 0,
  bypassProxy: true,
  mailProxy: '',
  connectTimeout: 12,
  startAtLogin: false,
  includeJunk: true,
});

export const settingOptions = Object.freeze({
  pageSize: [20, 40, 60, 80, 120],
  autoRefresh: [0, 1, 5, 15, 30],
  themes: ['system', 'light', 'dark'],
  densities: ['comfortable', 'compact'],
});

const proxyProtocols = new Set(['socks5:', 'socks4:', 'http:', 'https:', 'socks:']);

export function normalizeMailProxy(value) {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 200) throw new MailError(400, 'err.badSettings');
  let candidate = text;
  if (!text.includes('://')) {
    candidate = /^\d{1,5}$/.test(text) ? `socks5://127.0.0.1:${text}` : `socks5://${text}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new MailError(400, 'err.badSettings');
  }
  if (!proxyProtocols.has(url.protocol) || !url.hostname) throw new MailError(400, 'err.badSettings');
  const port = url.port || (url.protocol === 'http:' ? '8080' : '1080');
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return `${url.protocol}//${auth}${url.hostname}:${port}`;
}

function bool(value) {
  return value === undefined ? undefined : value === true || value === 'true';
}

function pick(value, allowed) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return allowed.includes(number) ? number : undefined;
}

// Returns a validated copy of `patch` merged over `base`. Unknown or invalid values are ignored
// so a stale client cannot corrupt the stored file.
export function normalizeSettings(patch, base = defaultSettings) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = { ...base };

  if (isLanguage(source.language)) next.language = source.language;
  if (settingOptions.themes.includes(source.theme)) next.theme = source.theme;
  if (settingOptions.densities.includes(source.density)) next.density = source.density;

  const pageSize = pick(source.pageSize, settingOptions.pageSize);
  if (pageSize !== undefined) next.pageSize = pageSize;
  const autoRefresh = pick(source.autoRefresh, settingOptions.autoRefresh);
  if (autoRefresh !== undefined) next.autoRefresh = autoRefresh;

  const bypassProxy = bool(source.bypassProxy);
  if (bypassProxy !== undefined) next.bypassProxy = bypassProxy;
  const startAtLogin = bool(source.startAtLogin);
  if (startAtLogin !== undefined) next.startAtLogin = startAtLogin;
  const includeJunk = bool(source.includeJunk);
  if (includeJunk !== undefined) next.includeJunk = includeJunk;

  if (source.connectTimeout !== undefined) {
    const seconds = Math.round(Number(source.connectTimeout));
    if (Number.isFinite(seconds)) next.connectTimeout = Math.min(60, Math.max(5, seconds));
  }

  const proxy = normalizeMailProxy(source.mailProxy);
  if (proxy !== undefined) next.mailProxy = proxy;

  return next;
}

export function createSettingsStore(directory) {
  const file = join(directory, 'settings.json');
  let values = { ...defaultSettings };
  try {
    values = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')), defaultSettings);
  } catch (error) {
    if (error?.code !== 'ENOENT') values = { ...defaultSettings };
  }
  const listeners = new Set();

  function get() {
    return { ...values };
  }

  function persist() {
    const temp = `${file}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temp, JSON.stringify(values, null, 2), { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* ignore */ }
      throw new MailError(500, 'err.accountsWrite');
    }
  }

  return {
    file,
    directory,
    get,
    update(patch) {
      const next = normalizeSettings(patch, values);
      const changed = Object.keys(next).some(key => next[key] !== values[key]);
      values = next;
      persist();
      if (changed) for (const listener of listeners) { try { listener(get()); } catch { /* ignore */ } }
      return get();
    },
    reset() {
      values = { ...defaultSettings };
      persist();
      for (const listener of listeners) { try { listener(get()); } catch { /* ignore */ } }
      return get();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
