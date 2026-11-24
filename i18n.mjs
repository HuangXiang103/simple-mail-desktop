import { AsyncLocalStorage } from 'node:async_hooks';
import { isLanguage, translate } from './web/i18n.js';

const storage = new AsyncLocalStorage();

export function currentLanguage() {
  return storage.getStore()?.language ?? 'zh';
}

export function withLanguage(language, task) {
  return storage.run({ language: isLanguage(language) ? language : 'zh' }, task);
}

export function t(key, params) {
  return translate(currentLanguage(), key, params);
}

export function languageFromRequest(request, fallback = 'zh') {
  const explicit = request?.headers?.['x-simple-mail-lang'];
  if (isLanguage(explicit)) return explicit;
  const accept = String(request?.headers?.['accept-language'] ?? '');
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('en')) return 'en';
    if (tag.startsWith('zh')) return 'zh';
  }
  return isLanguage(fallback) ? fallback : 'zh';
}

export function localizeError(error) {
  if (!error) return t('err.internal');
  if (error.key) return t(error.key, error.params);
  return error.expose && error.message ? error.message : t('err.internal');
}
