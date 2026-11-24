import { languages, localeOf, translate } from './i18n.js';

const $ = id => document.getElementById(id);
const session = document.querySelector('meta[name="simple-mail-session"]').content;
const accountOrder = ['qq', '163', '126', 'yeah', 'gmail', 'icloud', 'custom'];
const providerTags = { qq: 'QQ', '163': '163', '126': '126', yeah: 'Y', gmail: 'G', icloud: 'iC', custom: '@' };
const folderKeys = {
  '\\Inbox': 'folder.inbox', '\\Sent': 'folder.sent', '\\All': 'folder.all', '\\Archive': 'folder.archive',
  '\\Drafts': 'folder.drafts', '\\Junk': 'folder.junk', '\\Trash': 'folder.trash', '\\Flagged': 'folder.flagged',
};
const providerHelp = {
  qq: ['help.qq', 'https://mail.qq.com/'],
  '163': ['help.163', 'https://help.mail.163.com/faq.do?m=list&categoryID=90'],
  '126': ['help.126', 'https://help.mail.163.com/faq.do?m=list&categoryID=90'],
  yeah: ['help.yeah', 'https://help.mail.163.com/faq.do?m=list&categoryID=90'],
  gmail: ['help.gmail', 'https://support.google.com/accounts/answer/185833'],
  icloud: ['help.icloud', 'https://support.apple.com/102654'],
  custom: ['help.custom'],
};
const themeKey = 'simple-mail-theme';
const svgNS = 'http://www.w3.org/2000/svg';

let lang = 'zh';
let locale = 'zh-CN';
let dateTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
let dateFull = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

function t(key, params) {
  return translate(lang, key, params);
}

const state = {
  accounts: [], providers: {}, canRemember: false, info: {}, options: { pageSize: [40], autoRefresh: [0] },
  settings: { language: 'zh', theme: 'system', density: 'comfortable', pageSize: 40, autoRefresh: 0, bypassProxy: true, mailProxy: '', connectTimeout: 12, startAtLogin: false, includeJunk: true },
  active: '', recent: true, folder: 'INBOX', folders: [], q: '',
  rows: [], recentRows: [], pages: new Map(), errors: new Map(), selected: '',
  listRequest: 0, readRequest: 0, folderRequest: 0, loading: false,
  editing: '', saving: false, diagnostics: null,
  checked: new Set(), starred: new Set(), readerView: null,
};

let autoRefreshTimer = 0;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Simple-Mail': session, 'X-Simple-Mail-Lang': lang };
  if (body) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`/api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(t('status.localDown'));
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(t('err.internal'));
  }
  if (!response.ok) throw new Error(data.error || t('err.internal'));
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, action) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function icon(name, className = '') {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- i18n plumbing ----------

function applyStatic() {
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  document.title = t('app.windowTitle');
}

function setLanguage(next, { persist = true } = {}) {
  lang = languages.some(item => item.id === next) ? next : 'zh';
  locale = localeOf(lang);
  dateTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  dateFull = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  try { localStorage.setItem('simple-mail-lang', lang); } catch { /* storage is optional */ }
  applyStatic();
  renderSettingsLabels();
  renderNavigation();
  renderFolders();
  renderList();
  if ($('account-dialog').open) updateFormProvider();
  if (!state.readerView) renderEmptyReader();
  if (state.readerView) renderMessage(state.readerView.mail, state.readerView.message, state.readerView.options);
  if (persist) void saveSetting({ language: lang });
}

// ---------- theme ----------

function preferredTheme() {
  const mode = state.settings.theme || 'system';
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.dataset.theme = preferredTheme();
  try { localStorage.setItem(themeKey, state.settings.theme || 'system'); } catch { /* ignore */ }
  updateThemeButton();
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const toggle = $('theme-toggle');
  toggle.replaceChildren(icon(dark ? 'sun' : 'moon'));
  const label = dark ? t('theme.toLight') : t('theme.toDark');
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

// ---------- formatting ----------

function providerName(key) {
  return t(`provider.${key}`);
}

function folderName(specialUse) {
  return folderKeys[specialUse] ? t(folderKeys[specialUse]) : '';
}

function providerMark(key, extra = '') {
  const tag = providerTags[key] || '@';
  const mark = element('span', `avatar brand-avatar${tag.length > 2 ? ' tiny' : ''}${extra ? ` ${extra}` : ''}`, tag);
  mark.dataset.brand = Object.hasOwn(providerTags, key) ? key : 'custom';
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function toneFor(text) {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 6;
}

function senderAvatar(name) {
  const label = name || '?';
  return element('span', `avatar sender-avatar tone-${toneFor(label)}`, [...label][0]?.toUpperCase() || '?');
}

function senderName(mail) {
  const first = mail.from?.[0];
  return first?.name || first?.address || t('reader.unknownSender');
}

function subjectOf(mail) {
  return mail.subject || t('mail.noSubject');
}

function formatAddresses(items = []) {
  const text = items
    .map(({ name, address }) => (name && address && name !== address ? `${name} <${address}>` : name || address))
    .filter(Boolean)
    .join(', ');
  return text || '—';
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(+date) ? null : date;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatListDate(value) {
  const date = validDate(value);
  if (!date) return '';
  const now = new Date();
  if (sameDay(date, now)) return dateTime.format(date);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return t('date.yesterday');
  if (date.getFullYear() === now.getFullYear()) return t('date.monthDay', { m: date.getMonth() + 1, d: date.getDate() });
  return t('date.yearMonthDay', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
}

function formatFullDate(value) {
  const date = validDate(value);
  return date ? dateFull.format(date) : '—';
}

function groupLabel(value) {
  const date = validDate(value);
  if (!date) return t('date.older');
  const now = new Date();
  if (sameDay(date, now)) return t('date.today');
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return t('date.yesterday');
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((start - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return t('date.monthDay', { m: date.getMonth() + 1, d: date.getDate() });
  return t('date.yearMonthDayLong', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
}

function timestamp(value) {
  const date = validDate(value);
  return date ? +date : 0;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 4200);
}

// ---------- navigation ----------

function updateUnifiedCount() {
  const unread = state.rows.filter(mail => !mail.seen).length;
  const badge = $('unified-count');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = Boolean(state.active) || state.recent || unread === 0;
}

function updateToolbarState() {
  const any = state.checked.size > 0;
  for (const id of ['tool-read', 'tool-star', 'tool-archive', 'tool-delete']) {
    const el = $(id);
    if (el) el.disabled = !any;
  }
  const all = $('check-all');
  if (all) {
    const rows = state.rows;
    all.checked = rows.length > 0 && rows.every(mail => state.checked.has(mail.key));
    all.indeterminate = !all.checked && rows.some(mail => state.checked.has(mail.key));
  }
}

function renderNavigation() {
  const recent = $('nav-recent');
  recent.classList.toggle('active', state.recent);
  recent.setAttribute('aria-current', String(state.recent));

  const unified = $('unified');
  const unifiedActive = !state.active && !state.recent;
  unified.classList.toggle('active', unifiedActive);
  unified.setAttribute('aria-current', String(unifiedActive));

  const accounts = $('accounts');
  accounts.replaceChildren();
  for (const account of state.accounts) {
    const row = element('div', `account-row${state.active === account.id ? ' active' : ''}`);
    const select = button('account', '', () => selectAccount(account.id));
    select.title = account.email;
    select.setAttribute('aria-label', `${account.email} · ${providerName(account.provider)}`);
    select.setAttribute('aria-current', String(state.active === account.id));
    const text = element('span', 'account-text');
    text.append(element('span', 'account-email', account.email), element('span', 'account-provider', providerName(account.provider)));
    select.append(providerMark(account.provider), text);

    const manage = button('account-manage', '', () => showAccountForm(account));
    manage.append(icon('more'));
    manage.title = t('action.editAccount');
    manage.setAttribute('aria-label', `${t('action.editAccount')} · ${account.email}`);
    row.append(select, manage);
    accounts.append(row);
  }
  if (!state.accounts.length) accounts.append(element('p', 'sidebar-empty', t('accounts.empty')));

  const hasAccounts = state.accounts.length > 0;
  $('search').disabled = !hasAccounts;
  $('refresh').disabled = !hasAccounts || state.loading;
  $('edit-account').hidden = !state.active;
  updateUnifiedCount();
}

function renderFolders() {
  const account = state.accounts.find(item => item.id === state.active);
  const title = $('folder-title');
  title.textContent = state.recent ? t('list.recent.title') : account ? account.email : t('list.unified.title');
  title.title = title.textContent;
  $('folder-label').hidden = !account || state.recent;

  const select = $('folders');
  select.replaceChildren(new Option(t('folder.inbox'), 'INBOX'));
  for (const folder of state.folders) {
    if (folder.path.toUpperCase() === 'INBOX') continue;
    select.add(new Option(folderName(folder.specialUse) || folder.path, folder.path));
  }
  if (!Array.from(select.options).some(option => option.value === state.folder)) {
    select.add(new Option(state.folder, state.folder));
  }
  select.value = state.folder;
}

async function loadFolders() {
  const id = state.active;
  if (!id) return;
  const request = ++state.folderRequest;
  try {
    const folders = await api(`accounts/${id}/folders`);
    if (request !== state.folderRequest || state.active !== id) return;
    state.folders = folders;
    renderFolders();
  } catch {
    // Inbox loading shows connection errors; the folder menu stays usable with INBOX.
  }
}

// ---------- list ----------

function renderSkeleton(list, count = 6) {
  for (let index = 0; index < count; index += 1) {
    const row = element('div', 'mail-row skeleton');
    const avatar = element('span', 'avatar sk-avatar sk-block');
    const lines = element('div', 'sk-lines');
    lines.append(
      element('span', 'sk-line sk-block'),
      element('span', 'sk-line sk-block'),
      element('span', 'sk-line sk-block'),
    );
    row.append(avatar, lines);
    list.append(row);
  }
}

function renderListEmpty(list) {
  const empty = element('div', 'list-empty');
  const glyph = element('span', 'empty-glyph');
  glyph.append(icon('inbox'));
  empty.append(glyph);

  if (!state.accounts.length) {
    empty.append(element('strong', '', t('empty.noAccounts.title')));
    empty.append(element('p', '', t('empty.noAccounts.body')));
    const add = button('button primary', t('account.addLong'), () => showAccountForm());
    add.prepend(icon('plus'));
    empty.append(add);
  } else if (state.q) {
    empty.append(element('strong', '', t('empty.search.title')));
    empty.append(element('p', '', t('empty.search.body')));
    empty.append(button('button ghost', t('search.clear'), clearSearch));
  } else if (state.recent) {
    empty.append(element('strong', '', t('empty.recent.title')));
    empty.append(element('p', '', t('empty.recent.body')));
    empty.append(button('button ghost', t('action.refresh'), refreshMail));
  } else {
    empty.append(element('strong', '', t('empty.folder.title')));
    empty.append(element('p', '', t('empty.folder.body')));
    empty.append(button('button ghost', t('action.refresh'), refreshMail));
  }
  list.append(empty);
}

function renderListAlert(list, account, message) {
  const alert = element('div', 'list-alert');
  alert.append(icon('alert'));
  const content = element('div');
  content.append(element('strong', '', state.active ? t('list.failed') : (account?.email || t('list.failedAccount'))));
  content.append(element('p', '', message));
  content.append(button('', t('action.retry'), () => loadMessages()));
  alert.append(content);
  list.append(alert);
}

function renderMailRow(mail) {
  const name = senderName(mail);
  const subject = subjectOf(mail);
  const row = element('div', `mail-row${mail.seen ? '' : ' unread'}${state.selected === mail.key ? ' selected' : ''}`);
  row.dataset.key = mail.key;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `${name}: ${subject}`);
  row.addEventListener('click', () => openMessage(mail));
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMessage(mail); }
  });

  const checkWrap = element('span', 'mail-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'row-check';
  check.checked = state.checked.has(mail.key);
  check.setAttribute('aria-label', subject);
  check.addEventListener('click', event => event.stopPropagation());
  check.addEventListener('change', () => {
    if (check.checked) state.checked.add(mail.key); else state.checked.delete(mail.key);
    updateToolbarState();
  });
  checkWrap.append(check);

  const star = button(`mail-star${state.starred.has(mail.key) ? ' is-starred' : ''}`, '', event => {
    event.stopPropagation();
    if (state.starred.has(mail.key)) state.starred.delete(mail.key); else state.starred.add(mail.key);
    star.classList.toggle('is-starred', state.starred.has(mail.key));
    showToast(state.starred.has(mail.key) ? t('toast.starred.on') : t('toast.starred.off'));
  });
  star.append(icon('star'));
  star.setAttribute('aria-label', t('tool.star'));

  const avatar = senderAvatar(name);
  avatar.classList.add('mail-avatar');

  const body = element('div', 'mail-body');
  const top = element('div', 'mail-top');
  top.append(element('span', 'mail-sender', name));
  const flags = element('span', 'mail-flags');
  if (!mail.seen) flags.append(icon('mail'));
  top.append(flags);
  body.append(top);
  body.append(element('span', 'mail-subject', subject));
  const snippet = state.recent
    ? `${folderName(mail.folderSpecial) || mail.folderName || mail.folder} · ${providerName(mail.provider)} · ${mail.email}`
    : state.active
      ? t('snippet.from', { email: mail.email })
      : `${providerName(mail.provider)} · ${mail.email}`;
  body.append(element('span', 'mail-snippet', snippet));

  const date = element('span', 'mail-date', formatListDate(mail.date));
  row.append(checkWrap, star, avatar, body, date);
  return row;
}

function renderList() {
  const list = $('mail-list');
  const scroll = list.scrollTop;
  list.replaceChildren();

  const status = $('list-status');
  status.classList.toggle('syncing', state.loading);
  if (state.loading && !state.rows.length) {
    status.textContent = t('status.syncing');
  } else if (!state.accounts.length) {
    status.textContent = t('status.noAccounts');
  } else {
    const unread = state.rows.filter(mail => !mail.seen).length;
    const parts = [state.recent ? t('status.recentCount', { n: state.rows.length }) : t('status.count', { n: state.rows.length })];
    if (unread) parts.push(t('status.unread', { n: unread }));
    if (state.recent) parts.push(t('status.accountsFolders', { n: state.accounts.length }));
    else if (!state.active) parts.push(t('status.accounts', { n: state.accounts.length }));
    if (state.q) parts.push(t('status.searching', { q: state.q }));
    status.textContent = parts.join(' · ');
  }

  $('refresh').disabled = !state.accounts.length || state.loading;
  $('refresh').classList.toggle('spinning', state.loading);
  $('list-footer').hidden = state.recent || !Array.from(state.pages.values()).some(page => page.next);
  $('more').disabled = state.loading;
  updateUnifiedCount();

  if (state.loading && !state.rows.length && !state.errors.size) {
    renderSkeleton(list);
    list.scrollTop = scroll;
    return;
  }

  for (const [id, message] of state.errors) {
    renderListAlert(list, state.accounts.find(account => account.id === id), message);
  }

  if (state.rows.length) {
    let group = null;
    for (const mail of state.rows) {
      const label = groupLabel(mail.date);
      if (!group || group.label !== label) {
        group = { label, items: [] };
        const heading = element('div', 'date-group');
        heading.append(element('span', '', label), element('span', 'date-count', ''));
        list.append(heading);
        group.heading = heading;
      }
      group.items.push(mail);
      list.append(renderMailRow(mail));
      group.heading.querySelector('.date-count').textContent = String(group.items.length);
    }
  } else if (!state.errors.size && !state.loading) {
    renderListEmpty(list);
  }

  list.scrollTop = scroll;
  updateUnifiedCount();
  updateToolbarState();
}

function selectMailRow(key) {
  for (const row of $('mail-list').querySelectorAll('.mail-row')) {
    const active = row.dataset.key === key;
    row.classList.toggle('selected', active);
    row.setAttribute('aria-pressed', String(active));
  }
}

// ---------- reader ----------

function renderEmptyReader() {
  const content = element('div', 'empty-reader');
  const glyph = element('span', 'empty-icon');
  glyph.append(icon('mail'));
  content.append(glyph);

  if (state.accounts.length) {
    content.append(element('h2', '', t('reader.empty.title')));
    content.append(element('p', '', t('reader.empty.body')));
  } else {
    content.append(element('h2', '', t('reader.welcome.title')));
    content.append(element('p', '', t('reader.welcome.body')));
    const add = button('button primary', t('account.addLong'), () => showAccountForm());
    add.prepend(icon('plus'));
    content.append(add);
  }
  $('reader').replaceChildren(content);
  $('reader').scrollTop = 0;
}

function showStartupError(message) {
  const content = element('div', 'empty-reader');
  const glyph = element('span', 'empty-icon');
  glyph.append(icon('alert'));
  content.append(glyph, element('h2', '', t('startup.error.title')));
  content.append(element('p', '', message));
  content.append(button('button primary', t('startup.reload'), () => location.reload()));
  $('reader').replaceChildren(content);
}

function clearReader() {
  ++state.readRequest;
  state.selected = '';
  state.readerView = null;
  $('app').classList.remove('reading');
  renderEmptyReader();
}

function leaveMessage() {
  const previous = state.selected;
  clearReader();
  selectMailRow('');
  const row = Array.from($('mail-list').querySelectorAll('.mail-row')).find(item => item.dataset.key === previous);
  row?.focus();
}

function renderMessage(mail, message, { loading = false, note = '' } = {}) {
  state.readerView = { mail, message, options: { loading, note } };
  const article = element('article', 'message');

  const toolbar = element('div', 'message-toolbar');
  const back = button('tool-btn', '', leaveMessage);
  back.append(icon('arrow-left'));
  back.title = t('reader.back');
  back.setAttribute('aria-label', t('reader.back'));
  toolbar.append(back);
  const reply = button('tool-btn', '', () => showToast(t('toast.readonly.compose')));
  reply.append(icon('reply'), element('span', '', t('reader.reply')));
  const forward = button('tool-btn', '', () => showToast(t('toast.readonly.forward')));
  forward.append(icon('forward'), element('span', '', t('reader.forward')));
  const trash = button('tool-btn danger', '', () => showToast(t('toast.readonly.delete')));
  trash.append(icon('trash'), element('span', '', t('reader.delete')));
  toolbar.append(reply, forward, trash);
  article.append(toolbar);

  const card = element('div', 'message-card');
  card.append(element('h2', 'message-subject', subjectOf(mail)));

  const first = mail.from?.[0];
  const name = senderName(mail);
  const meta = element('div', 'message-meta');
  const senderAvatarEl = senderAvatar(name);
  senderAvatarEl.classList.add('sender-avatar');
  const info = element('div', 'sender-info');
  info.append(element('span', 'sender-name', name));
  if (first?.address && first.address !== name) info.append(element('span', 'sender-email', first.address));
  meta.append(senderAvatarEl, info, element('span', 'message-date', formatFullDate(mail.date)));
  card.append(meta);

  if (mail.to?.length) card.append(element('p', 'message-recipient', t('reader.recipient', { list: formatAddresses(mail.to) })));

  if (loading) {
    const skeleton = element('div', 'body-skeleton');
    for (let index = 0; index < 6; index += 1) skeleton.append(element('span', 'sk-line sk-block'));
    card.append(skeleton);
  } else if (note) {
    const notice = element('div', 'message-notice');
    notice.append(icon('alert'), element('span', '', note));
    card.append(notice);
  } else if (message?.text) {
    card.append(element('p', 'message-text', message.text));
  } else {
    card.append(element('p', 'message-note', t('reader.none')));
  }

  if (message && !loading) {
    card.append(element('p', 'message-note', message.truncated ? t('reader.truncated') : t('reader.note')));
  }

  article.append(card);
  $('reader').replaceChildren(article);
  $('reader').scrollTop = 0;
  $('app').classList.add('reading');
}

async function openMessage(mail) {
  const request = ++state.readRequest;
  state.selected = mail.key;
  selectMailRow(mail.key);
  renderMessage(mail, null, { loading: true });

  const params = new URLSearchParams({ folder: mail.folder, uid: mail.uid, validity: mail.validity });
  try {
    const message = await api(`accounts/${mail.id}/message?${params}`);
    if (request === state.readRequest) renderMessage(mail, message);
  } catch (error) {
    if (request === state.readRequest) renderMessage(mail, null, { note: error.message });
  }
}

// ---------- loading ----------

function filterRecentRows() {
  const q = state.q.trim().toLowerCase();
  if (!q) {
    state.rows = [...state.recentRows];
    return;
  }
  state.rows = state.recentRows.filter(mail => [
    subjectOf(mail),
    senderName(mail),
    mail.email,
    mail.folderName,
    mail.folder,
  ].filter(Boolean).join(' ').toLowerCase().includes(q));
}

async function loadRecent() {
  if (!state.recent) return;
  const request = ++state.listRequest;
  const targets = [...state.accounts];
  state.rows = [];
  state.recentRows = [];
  state.pages.clear();
  state.errors.clear();
  state.checked.clear();
  $('mail-list').scrollTop = 0;
  clearReader();
  state.loading = targets.length > 0;
  renderList();

  const results = await Promise.all(targets.map(async account => {
    try {
      return { account, page: await api(`accounts/${account.id}/recent`) };
    } catch (error) {
      return { account, error: error.message };
    }
  }));

  if (request !== state.listRequest) return;

  const rows = new Map();
  for (const result of results) {
    const { account, page, error } = result;
    if (error) {
      state.errors.set(account.id, error);
      continue;
    }
    state.errors.delete(account.id);
    for (const message of page.messages) {
      const key = JSON.stringify([account.id, message.folder, message.validity, message.uid]);
      rows.set(key, {
        ...message,
        key,
        id: account.id,
        email: account.email,
        provider: account.provider,
      });
    }
  }

  state.recentRows = [...rows.values()].sort((a, b) => timestamp(b.date) - timestamp(a.date) || b.uid - a.uid);
  filterRecentRows();
  state.loading = false;
  renderList();
}

function openRecent() {
  state.recent = true;
  state.active = '';
  state.folder = 'INBOX';
  state.folders = [];
  state.q = '';
  $('search').value = '';
  $('search').placeholder = t('search.placeholder.recent');
  updateSearchClear();
  renderNavigation();
  renderFolders();
  void loadRecent();
}

async function loadMessages(older = false, keepReader = false, bulk = false) {
  if (state.recent) return;
  if (older && state.loading) return;
  const request = ++state.listRequest;
  const active = state.active;
  const targets = active ? state.accounts.filter(account => account.id === active) : [...state.accounts];
  const folder = active ? state.folder : 'INBOX';

  if (!older) {
    state.rows = [];
    state.pages.clear();
    state.errors.clear();
    state.checked.clear();
    $('mail-list').scrollTop = 0;
    if (!keepReader) clearReader();
  }
  state.loading = targets.length > 0;
  renderList();

  const results = await Promise.all(targets.map(async account => {
    const page = state.pages.get(account.id);
    if (older && !page?.next) return null;
    const params = new URLSearchParams({ folder, q: state.q });
    if (bulk) params.set('bulk', '1');
    if (older) {
      params.set('before', page.next);
      params.set('validity', page.validity);
    }
    try {
      return { account, page: await api(`accounts/${account.id}/messages?${params}`) };
    } catch (error) {
      return { account, error: error.message };
    }
  }));

  if (request !== state.listRequest) return;

  const rows = new Map(state.rows.map(row => [row.key, row]));
  for (const result of results) {
    if (!result) continue;
    const { account, page, error } = result;
    if (error) {
      state.errors.set(account.id, error);
      continue;
    }
    state.errors.delete(account.id);
    state.pages.set(account.id, { next: page.next, validity: page.validity });
    for (const message of page.messages) {
      const key = JSON.stringify([account.id, folder, page.validity, message.uid]);
      rows.set(key, {
        ...message,
        key,
        folder,
        validity: page.validity,
        id: account.id,
        email: account.email,
        provider: account.provider,
      });
    }
  }

  state.rows = [...rows.values()].sort((a, b) => timestamp(b.date) - timestamp(a.date) || b.uid - a.uid);
  state.loading = false;
  renderList();
}

function selectAccount(id) {
  state.recent = false;
  state.recentRows = [];
  state.active = id;
  state.folder = 'INBOX';
  state.folders = [];
  state.q = '';
  $('search').value = '';
  $('search').placeholder = t('search.placeholder.folder');
  updateSearchClear();
  renderNavigation();
  renderFolders();
  if (id) void loadFolders();
  void loadMessages();
}

function refreshMail() {
  if (state.recent) {
    void loadRecent();
    return;
  }
  void loadFolders();
  void loadMessages(false, true);
}

function updateSearchClear() {
  const hasValue = $('search').value.length > 0;
  $('search-clear').hidden = !hasValue;
  $('search-form').classList.toggle('has-value', hasValue);
}

function clearSearch() {
  $('search').value = '';
  state.q = '';
  updateSearchClear();
  if (state.recent) {
    filterRecentRows();
    renderList();
  } else {
    void loadMessages();
  }
  $('search').focus();
}

// ---------- account form ----------

function updateFormProvider() {
  const selected = document.querySelector('#provider-options input[name="provider"]:checked');
  if (!selected) return;
  const key = selected.value;
  const custom = key === 'custom';
  $('host-fields').hidden = !custom;
  $('host').required = custom;
  $('port').required = custom;
  $('email').placeholder = `name@${state.providers[key]?.domain || 'example.com'}`;
  $('password-caption').textContent = key === 'gmail' || key === 'icloud'
    ? t('field.appPassword')
    : custom ? t('field.passwordOrCode') : t('field.password');

  const [key2, link] = providerHelp[key] || providerHelp.custom;
  const hint = $('provider-hint');
  hint.textContent = t(key2);
  if (link) {
    const anchor = element('a', '', t('help.link'));
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    hint.append(document.createTextNode(' '), anchor);
  }
}

function buildProviderOptions() {
  const wrap = $('provider-options');
  wrap.replaceChildren();
  for (const key of accountOrder) {
    if (!state.providers[key]) continue;
    const option = element('label', 'provider-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'provider';
    input.value = key;
    input.className = 'sr-only';
    option.append(input, providerMark(key), element('span', '', providerName(key)));
    wrap.append(option);
  }
}

function showAccountForm(account) {
  if (!Object.keys(state.providers).length) return;
  $('account-form').reset();
  $('form-message').textContent = '';
  $('form-message').classList.remove('busy');
  state.editing = account?.id || '';
  state.saving = false;

  $('dialog-title').textContent = account ? t('dialog.editTitle') : t('dialog.addTitle');
  const provider = account?.provider || (state.providers.qq ? 'qq' : accountOrder.find(key => state.providers[key])) || 'custom';
  const input = document.querySelector(`#provider-options input[value="${provider}"]`);
  if (input) input.checked = true;

  $('email').value = account?.email || '';
  $('email').readOnly = Boolean(account);
  $('host').value = account?.host || '';
  $('port').value = account?.port || 993;
  $('provider-fieldset').disabled = Boolean(account);
  $('remember-label').hidden = !state.canRemember;
  $('remember').checked = Boolean(state.canRemember && account?.remember);
  $('remove-account').hidden = !account;
  $('save').textContent = account ? t('action.saveConnect') : t('action.connect');
  $('save').disabled = false;
  $('cancel').disabled = false;
  $('close-dialog').disabled = false;
  $('account-fields').inert = false;
  updateFormProvider();

  $('account-dialog').showModal();
  (account ? $('password') : $('email')).focus();
}

function setSaving(busy, message = '') {
  state.saving = busy;
  $('account-fields').inert = busy;
  $('provider-fieldset').disabled = busy || Boolean(state.editing);
  $('email').readOnly = busy || Boolean(state.editing);
  for (const id of ['close-dialog', 'cancel', 'remove-account', 'save']) $(id).disabled = busy;
  $('save').textContent = busy ? t('action.saving') : state.editing ? t('action.saveConnect') : t('action.connect');
  $('form-message').classList.toggle('busy', busy);
  $('form-message').textContent = message;
}

$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.saving) return;
  if (!$('account-form').reportValidity()) return;

  const editing = state.editing;
  const provider = document.querySelector('#provider-options input[name="provider"]:checked')?.value || 'qq';
  const body = {
    provider,
    email: $('email').value,
    password: $('password').value,
    remember: $('remember').checked,
    host: $('host').value,
    port: $('port').value,
  };

  setSaving(true, t('form.validating'));
  try {
    const account = await api(editing ? `accounts/${editing}` : 'accounts', { method: editing ? 'PUT' : 'POST', body });
    if (editing) state.accounts = state.accounts.map(item => (item.id === account.id ? account : item));
    else state.accounts.push(account);
    setSaving(false);
    $('account-dialog').close();
    showToast(editing ? t('toast.accountUpdated') : t('toast.accountAdded'));
    if (editing) selectAccount(state.active);
    else openRecent();
  } catch (error) {
    setSaving(false, error.message);
  }
});

$('remove-account').addEventListener('click', async () => {
  const id = state.editing;
  const account = state.accounts.find(item => item.id === id);
  if (!account || !window.confirm(t('confirm.remove', { email: account.email }))) return;
  setSaving(true, t('form.removing'));
  try {
    await api(`accounts/${id}`, { method: 'DELETE' });
    state.accounts = state.accounts.filter(item => item.id !== id);
    setSaving(false);
    $('account-dialog').close();
    showToast(t('toast.accountRemoved'));
    selectAccount(state.active === id ? '' : state.active);
  } catch (error) {
    setSaving(false, error.message);
  }
});

$('account-dialog').addEventListener('cancel', event => {
  if (state.saving) event.preventDefault();
});
$('account-dialog').addEventListener('close', () => {
  $('password').value = '';
  state.editing = '';
  state.saving = false;
  $('account-fields').inert = false;
  $('provider-fieldset').disabled = false;
  $('email').readOnly = false;
  $('form-message').textContent = '';
  $('form-message').classList.remove('busy');
  for (const id of ['close-dialog', 'cancel', 'remove-account', 'save']) $(id).disabled = false;
  $('save').textContent = t('action.connect');
});

// ---------- settings ----------

function settingsMessage(text, { restart = false, error: isError = false } = {}) {
  const node = $('settings-message');
  node.classList.toggle('error', isError);
  node.textContent = text;
  if (restart) {
    const action = button('settings-inline-link', t('settings.restart'), () => {
      api('restart', { method: 'POST' }).catch(err => settingsMessage(err.message, { error: true }));
    });
    node.append(' ', action);
  }
}

async function saveSetting(patch, { quiet = false } = {}) {
  const previous = { ...state.settings };
  Object.assign(state.settings, patch);
  try {
    const { settings } = await api('settings', { method: 'PUT', body: patch });
    state.settings = settings;
    applySettings({ mode: 'save' });
    if (!quiet) settingsMessage(t('settings.saved'));
    if (patch.bypassProxy !== undefined && settings.bypassProxy !== previous.bypassProxy) {
      settingsMessage(t('settings.needRestart'), { restart: Boolean(state.info.desktop) });
    }
    if (patch.startAtLogin !== undefined) applySettings();
    return true;
  } catch (error) {
    Object.assign(state.settings, previous);
    applySettings();
    settingsMessage(error.message, { error: true });
    return false;
  }
}

function applySettings({ mode = 'all' } = {}) {
  document.documentElement.dataset.density = state.settings.density;
  applyTheme();
  scheduleAutoRefresh();
  if (mode !== 'save') syncSettingsControls();
}

function syncSettingsControls() {
  for (const group of document.querySelectorAll('.segmented')) {
    const value = group.id === 'language-options' ? lang
      : group.id === 'theme-options' ? state.settings.theme
        : state.settings.density;
    for (const item of group.querySelectorAll('button')) {
      const active = item.dataset.value === value;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    }
  }
  $('set-startup').checked = state.settings.startAtLogin;
  $('set-bypass').checked = state.settings.bypassProxy;
  if (document.activeElement !== $('set-mail-proxy')) $('set-mail-proxy').value = state.settings.mailProxy;
  if (document.activeElement !== $('set-timeout')) $('set-timeout').value = String(state.settings.connectTimeout);
  $('set-pagesize').value = String(state.settings.pageSize);
  $('set-autorefresh').value = String(state.settings.autoRefresh);
  $('set-junk').checked = state.settings.includeJunk;

  $('about-version').textContent = state.info.version ? `${t('app.name')} ${state.info.version}` : '—';
  const runtime = [state.info.electron ? `Electron ${state.info.electron}` : null, state.info.node ? `Node ${state.info.node}` : null].filter(Boolean);
  $('about-runtime').textContent = runtime.length ? runtime.join(' · ') : '—';
  const dataDir = $('about-data');
  dataDir.textContent = state.info.dataDir || '—';
  dataDir.title = state.info.dataDir || '';
  document.querySelectorAll('[data-windows-only]').forEach(node => {
    node.hidden = state.info.platform ? state.info.platform !== 'win32' : false;
  });
}

function renderSettingsLabels() {
  const pageSize = $('set-pagesize');
  if (pageSize) {
    const current = pageSize.value;
    pageSize.replaceChildren(...(state.options.pageSize || [40]).map(size => new Option(String(size), String(size))));
    if (current) pageSize.value = current;
  }
  const autoRefresh = $('set-autorefresh');
  if (autoRefresh) {
    const current = autoRefresh.value;
    autoRefresh.replaceChildren(new Option(t('settings.autoRefresh.off'), '0'));
    for (const minutes of (state.options.autoRefresh || []).filter(value => value > 0)) {
      autoRefresh.append(new Option(t('settings.autoRefresh.minutes', { n: minutes }), String(minutes)));
    }
    if (current) autoRefresh.value = current;
  }
}

function buildSegmented() {
  const languageOptions = $('language-options');
  languageOptions.replaceChildren(...languages.map(item => {
    const node = button('', item.label, () => {
      if (item.id === lang) return;
      setLanguage(item.id);
      syncSettingsControls();
    });
    node.dataset.value = item.id;
    return node;
  }));
  for (const [id, key] of [['theme-options', 'theme'], ['density-options', 'density']]) {
    $(id).addEventListener('click', event => {
      const target = event.target.closest('button[data-value]');
      if (!target) return;
      void saveSetting({ [key]: target.dataset.value }).then(ok => { if (ok) syncSettingsControls(); });
    });
  }
}

function openSettings() {
  renderSettingsLabels();
  syncSettingsControls();
  settingsMessage('');
  $('diagnostics').hidden = true;
  $('diagnostics').replaceChildren();
  switchSettingsTab('general');
  $('settings-dialog').showModal();
}

function switchSettingsTab(tab) {
  for (const node of document.querySelectorAll('.settings-tab')) {
    const active = node.dataset.tab === tab;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  }
}

function diagnosticRow(label, value, ok) {
  const item = element('li', `diag-item${ok === true ? ' ok' : ok === false ? ' bad' : ''}`);
  item.append(element('span', 'diag-label', label), element('span', 'diag-value', value));
  return item;
}

async function runDiagnostics() {
  const list = $('diagnostics');
  list.hidden = false;
  list.replaceChildren(element('li', 'diag-item', t('settings.diagnostics.running')));
  try {
    const data = await api('diagnostics');
    const rows = [];
    rows.push(diagnosticRow(t('settings.diagnostics.local'), t('settings.diagnostics.localOk', { ms: data.service.ms }), true));
    rows.push(diagnosticRow(t('settings.diagnostics.policy'), data.policy.bypassProxy ? t('settings.policy.direct') : t('settings.policy.system'), data.policy.bypassProxy));
    for (const item of data.mail) {
      rows.push(diagnosticRow(`${item.host}:${item.port}`, item.ok ? t('settings.diagnostics.ms', { ms: item.ms }) : t('settings.diagnostics.bad'), item.ok));
    }
    if (!data.mail.length) rows.push(diagnosticRow(t('settings.diagnostics.mail'), t('status.noAccounts'), null));
    if (data.policy.mailProxy) {
      const target = data.policy.mailProxy.replace(/^[a-z0-9]+:\/\//i, '');
      rows.push(diagnosticRow(target, data.proxy?.ok ? t('settings.diagnostics.ms', { ms: data.proxy.ms }) : t('settings.diagnostics.bad'), data.proxy?.ok ?? false));
    }
    list.replaceChildren(...rows);
  } catch (error) {
    list.replaceChildren(diagnosticRow(t('settings.diagnostics'), error.message, false));
  }
}

function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  const minutes = Number(state.settings.autoRefresh) || 0;
  if (minutes <= 0) return;
  autoRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (!$('account-dialog').open && !$('settings-dialog').open) refreshMail();
  }, minutes * 60000);
}

// ---------- wiring ----------

$('provider-options').addEventListener('change', updateFormProvider);
for (const id of ['add-small', 'add-account']) $(id).addEventListener('click', () => showAccountForm());
$('compose').addEventListener('click', () => showToast(t('toast.readonly.compose')));
for (const id of ['cancel', 'close-dialog']) $(id).addEventListener('click', () => $('account-dialog').close());
$('edit-account').addEventListener('click', () => {
  const account = state.accounts.find(item => item.id === state.active);
  if (account) showAccountForm(account);
});
$('unified').addEventListener('click', () => selectAccount(''));
$('nav-recent').addEventListener('click', openRecent);

function pickFolder(use) {
  const match = state.folders.find(folder => folder.specialUse === use);
  if (!state.active) {
    showToast(t('toast.pickAccount'));
    return;
  }
  if (!match) { showToast(t('toast.noFolder')); return; }
  state.folder = match.path;
  const select = $('folders');
  if (!Array.from(select.options).some(option => option.value === match.path)) {
    select.add(new Option(folderName(use) || match.path, match.path));
  }
  select.value = match.path;
  void loadMessages();
}
$('nav-starred').addEventListener('click', () => pickFolder('\\Flagged'));
$('nav-sent').addEventListener('click', () => pickFolder('\\Sent'));
$('nav-draft').addEventListener('click', () => pickFolder('\\Drafts'));
$('nav-archive').addEventListener('click', () => pickFolder('\\Archive'));

$('tool-read').addEventListener('click', () => showToast(t('toast.readCount', { n: state.checked.size })));
$('tool-star').addEventListener('click', () => {
  for (const key of state.checked) state.starred.add(key);
  renderList();
  showToast(t('toast.starCount', { n: state.checked.size }));
});
$('tool-archive').addEventListener('click', () => showToast(t('toast.readonly.archive')));
$('tool-delete').addEventListener('click', () => showToast(t('toast.readonly.delete')));
$('check-all').addEventListener('change', event => {
  if (event.target.checked) state.rows.forEach(mail => state.checked.add(mail.key));
  else state.checked.clear();
  void renderList();
});

$('folders').addEventListener('change', () => {
  state.folder = $('folders').value;
  void loadMessages();
});
$('refresh').addEventListener('click', refreshMail);
$('more').addEventListener('click', () => void loadMessages(true));
$('load-all').addEventListener('click', async () => {
  const button = $('load-all');
  if (state.loading || button.disabled) return;
  button.disabled = true;
  button.textContent = t('list.loadingAll');
  try {
    while (!state.recent && !state.loading && [...state.pages.values()].some(page => page.next)) {
      const request = state.listRequest + 1;
      const previous = JSON.stringify([...state.pages.values()]);
      await loadMessages(true, false, true);
      if (state.listRequest !== request || state.errors.size ||
          JSON.stringify([...state.pages.values()]) === previous) break;
    }
  } finally {
    button.disabled = false;
    button.textContent = t('list.all');
  }
});
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  state.q = $('search').value.trim();
  if (state.recent) {
    filterRecentRows();
    renderList();
  } else {
    void loadMessages();
  }
});
$('search').addEventListener('input', updateSearchClear);
$('search').addEventListener('search', () => {
  updateSearchClear();
  if (!$('search').value && state.q) {
    state.q = '';
    if (state.recent) {
      filterRecentRows();
      renderList();
    } else {
      void loadMessages();
    }
  }
});
$('search-clear').addEventListener('click', clearSearch);

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  state.settings.theme = next;
  applyTheme();
  syncSettingsControls();
  void saveSetting({ theme: next }, { quiet: true });
});

$('open-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-done').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => settingsMessage(''));
for (const node of document.querySelectorAll('.settings-tab')) {
  node.addEventListener('click', () => switchSettingsTab(node.dataset.tab));
}
$('set-startup').addEventListener('change', () => void saveSetting({ startAtLogin: $('set-startup').checked }));
$('set-bypass').addEventListener('change', () => void saveSetting({ bypassProxy: $('set-bypass').checked }));
$('set-junk').addEventListener('change', () => void saveSetting({ includeJunk: $('set-junk').checked }).then(ok => {
  if (ok && state.recent) void loadRecent();
}));
$('set-pagesize').addEventListener('change', () => void saveSetting({ pageSize: Number($('set-pagesize').value) }).then(ok => {
  if (ok && !state.recent) void loadMessages();
}));
$('set-autorefresh').addEventListener('change', () => void saveSetting({ autoRefresh: Number($('set-autorefresh').value) }));
$('set-mail-proxy').addEventListener('change', () => void saveSetting({ mailProxy: $('set-mail-proxy').value }));
$('set-mail-proxy').addEventListener('blur', () => {
  if ($('set-mail-proxy').value !== state.settings.mailProxy) void saveSetting({ mailProxy: $('set-mail-proxy').value });
});
$('set-timeout').addEventListener('change', () => void saveSetting({ connectTimeout: Number($('set-timeout').value) }));
$('run-diagnostics').addEventListener('click', () => void runDiagnostics());
$('open-data-dir').addEventListener('click', () => {
  api('open-data-dir', { method: 'POST' }).catch(error => settingsMessage(error.message, { error: true }));
});
$('reset-settings').addEventListener('click', async () => {
  if (!window.confirm(t('confirm.reset'))) return;
  try {
    const { settings } = await api('settings/reset', { method: 'POST' });
    state.settings = settings;
    setLanguage(settings.language, { persist: false });
    applySettings();
    settingsMessage(t('settings.saved'));
  } catch (error) {
    settingsMessage(error.message, { error: true });
  }
});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    if (!state.accounts.length) return;
    event.preventDefault();
    $('search').focus();
    $('search').select();
    return;
  }
  if (event.key !== 'Escape' || $('account-dialog').open || $('settings-dialog').open) return;
  if (document.activeElement === $('search')) {
    if ($('search').value) {
      event.preventDefault();
      clearSearch();
    }
    return;
  }
  if ($('app').classList.contains('reading')) {
    event.preventDefault();
    leaveMessage();
  }
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', () => {
  if ((state.settings.theme || 'system') === 'system') applyTheme();
});

async function init() {
  try {
    const config = await api('config');
    Object.assign(state, {
      accounts: config.accounts,
      providers: config.providers,
      canRemember: config.canRemember,
      settings: config.settings,
      info: config.info || {},
      options: config.options || state.options,
    });
    setLanguage(config.settings.language, { persist: false });
    buildSegmented();
    buildProviderOptions();
    renderSettingsLabels();
    applySettings();
    $('search').placeholder = t('search.placeholder.recent');
    selectAccount('');
  } catch (error) {
    $('add-small').disabled = true;
    $('add-account').disabled = true;
    $('list-status').textContent = t('status.localDown');
    showStartupError(error.message);
    showToast(error.message);
  } finally {
    document.documentElement.dataset.ready = 'true';
  }
}

void init();
