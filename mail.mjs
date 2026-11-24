import { ImapFlow } from 'imapflow';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { compile } from 'html-to-text';
import { t } from './i18n.mjs';

export const providers = {
  qq: { host: 'imap.qq.com', port: 993, domain: 'qq.com' },
  '163': { host: 'imap.163.com', port: 993, domain: '163.com' },
  '126': { host: 'imap.126.com', port: 993, domain: '126.com' },
  yeah: { host: 'imap.yeah.net', port: 993, domain: 'yeah.net' },
  gmail: { host: 'imap.gmail.com', port: 993, domain: 'gmail.com' },
  icloud: { host: 'imap.mail.me.com', port: 993, domain: 'icloud.com' },
  custom: { domain: 'example.com' },
};

export class MailError extends Error {
  constructor(status, key, params) {
    super(key);
    this.status = status;
    this.key = key;
    this.params = params;
  }
}

export function accountInput(input) {
  const provider = Object.hasOwn(providers, input.provider) ? input.provider : 'custom';
  const preset = providers[provider];
  const email = String(input.email ?? '').trim();
  const host = preset.host ?? String(input.host ?? '').trim().toLowerCase();
  const port = preset.port ?? Number(input.port || 993);
  const rawPassword = String(input.password ?? '');
  const password = provider === 'gmail' ? rawPassword.replace(/\s/g, '') : rawPassword;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new MailError(400, 'err.emailInvalid');
  }
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MailError(400, 'err.hostInvalid');
  }
  if (!password.trim() || password.length > 1024 || /[\0\r\n]/.test(password)) {
    throw new MailError(400, 'err.passwordInvalid');
  }
  return { provider, email, host, port, password, remember: input.remember === true };
}

function friendlyError(error, account) {
  if (error instanceof MailError) return error;
  const code = error.serverResponseCode ?? error.responseCode ?? error.code ?? '';
  const text = `${code} ${error.response ?? ''} ${error.message ?? ''}`;
  if (/UNSAFE/i.test(text)) return new MailError(502, 'err.imapUnsafe');
  if (error.authenticationFailed || /AUTH|CREDENTIAL|LOGIN/i.test(code)) {
    return new MailError(422, account.provider === 'gmail' ? 'err.authFailedGmail' : 'err.authFailed');
  }
  if (/CERT|TLS|SSL/.test(code)) return new MailError(502, 'err.tls');
  if (/PROXY/i.test(code) || /proxy/i.test(error.message ?? '')) {
    return new MailError(502, 'err.unreachable', { host: account.host });
  }
  if (/TIMEOUT|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET|EPIPE/i.test(text)) {
    return new MailError(502, 'err.unreachable', { host: account.host });
  }
  if (/NONEXISTENT|NOPERM|MAILBOX/i.test(code)) return new MailError(404, 'err.folder');
  return new MailError(502, 'err.serverGeneric', { host: account.host });
}

export function createMailService({ makeClient = options => new ImapFlow(options), getSettings = () => ({}) } = {}) {
  const indexes = new Map();
  let qqRoute;

  function limits() {
    const settings = getSettings() || {};
    const seconds = Math.min(60, Math.max(5, Number(settings.connectTimeout) || 12));
    return {
      timeout: seconds * 1000,
      proxy: settings.mailProxy ? String(settings.mailProxy) : undefined,
    };
  }

  async function connect(account, task) {
    const { timeout, proxy } = limits();
    const options = {
      host: account.host,
      port: account.port,
      secure: true,
      auth: { user: account.email, pass: account.password },
      clientInfo: { name: 'Simple Mail', version: '2.1.0', vendor: 'Simple Mail' },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: timeout,
      greetingTimeout: Math.max(4000, timeout - 2000),
      socketTimeout: timeout * 2,
      ...(proxy ? { proxy } : {}),
    };
    async function open(route) {
      const client = makeClient(route ? { ...options, ...route } : { ...options });
      client.on('error', () => {});
      try {
        await client.connect();
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    }
    let client;
    try {
      try {
        client = await open(account.host === 'imap.qq.com' ? qqRoute : undefined);
      } catch (error) {
        if (account.host !== 'imap.qq.com' || proxy ||
            !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) throw error;
        const routes = await qqDirectRoutes().catch(() => []);
        for (const route of routes) {
          try {
            client = await open({ ...route, proxy: undefined });
            qqRoute = route;
            break;
          } catch (routeError) {
            if (routeError.authenticationFailed || /CERT|TLS|SSL/.test(routeError.code ?? '')) throw routeError;
          }
        }
        if (!client) throw error;
      }
      return await task(client);
    } catch (error) {
      throw friendlyError(error, account);
    } finally {
      client?.close();
    }
  }

  return {
    check: account => connect(account, client => openFolder(client, 'INBOX')),
    folders: account => connect(account, async client => {
      const folders = await client.list();
      return folders.filter(folder => !folder.flags.has('\\Noselect') && !folder.flags.has('\\NonExistent'))
        .map(({ path, name, specialUse }) => ({ path, name, specialUse }));
    }),
    messages: (account, query) => connect(account, client => getMessages(client, query, indexes, account.id)),
    message: (account, query) => connect(account, client => getMessage(client, query)),
    recent: (account, query = {}) => connect(account, client => getRecent(client, query)),
  };
}

async function qqDirectRoutes() {
  const response = await fetch('https://dns.google/resolve?name=imap.qq.com&type=A', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return [];
  const { Answer = [] } = await response.json();
  const hosts = Answer.filter(answer => answer.type === 1 && isIPv4(answer.data)).map(answer => answer.data);
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/meta|tun|tap|virtual|vethernet/i.test(name))
    .flatMap(([, addresses]) => addresses)
    .filter(address => address.family === 'IPv4' && !address.internal)
    .flatMap(({ address }) => hosts.map(host => ({
      host, servername: 'imap.qq.com', tls: { localAddress: address },
      connectionTimeout: 4000, greetingTimeout: 4000,
    })));
}

const defaultPageSize = 40;
const recentMessageLimit = 80;
const recentFolderLimit = 12;

function isReceivedFolder(folder, includeJunk) {
  if (folder.specialUse === '\\Junk') return includeJunk;
  if (!folder.specialUse) return true;
  return ['\\Inbox', '\\Archive'].includes(folder.specialUse);
}

function recentFolderName(folder) {
  if (folder.specialUse === '\\Junk') return t('folder.junk');
  if (folder.specialUse === '\\Archive') return t('folder.archive');
  if (folder.specialUse === '\\Inbox') return t('folder.inbox');
  return folder.name || folder.path;
}

async function openFolder(client, path, knownValidity) {
  const mailbox = await client.mailboxOpen(path, { readOnly: true });
  const validity = String(mailbox.uidValidity ?? '');
  if (knownValidity && validity !== knownValidity) {
    throw new MailError(409, 'err.validityChanged');
  }
  return { mailbox, validity };
}

function addresses(list = []) {
  return list.map(({ name, address }) => ({ name: name ?? '', address: address ?? '' }));
}

function summary(message) {
  const envelope = message.envelope ?? {};
  const date = message.internalDate ?? envelope.date;
  return {
    uid: message.uid,
    subject: envelope.subject || '',
    date: date instanceof Date && !Number.isNaN(+date) ? date.toISOString() : '',
    from: addresses(envelope.from),
    to: addresses(envelope.to),
    seen: message.flags?.has('\\Seen') ?? false,
  };
}

async function dateIndex(client, count, q) {
  if (!count) return [];
  const matches = q && await client.search({
    or: [{ subject: q }, { from: q }, { to: q }],
  }, { uid: true });
  const indexed = [];
  if (!q || matches?.length) {
    const range = q ? matches.join(',') : `1:${count}`;
    for await (const message of client.fetch(range, { uid: true, internalDate: true }, { uid: Boolean(q) })) {
      if (message.uid) indexed.push(message);
    }
  }
  return indexed.sort((a, b) => (+b.internalDate || 0) - (+a.internalDate || 0) || b.uid - a.uid)
    .map(message => message.uid);
}

async function readSummaries(client, uids) {
  if (!uids.length) return [];
  const raw = await client.fetchAll(uids.join(','), {
    uid: true, envelope: true, flags: true, internalDate: true,
  }, { uid: true });
  const byUid = new Map(raw.filter(message => message.uid).map(message => [message.uid, message]));
  return uids.map(uid => byUid.get(uid)).filter(Boolean);
}

async function getMessages(client, { path, before, q, validity: knownValidity, bulk, size }, indexes, accountId) {
  const { mailbox, validity } = await openFolder(client, path, knownValidity);
  const key = JSON.stringify([accountId, path, q, validity]);
  let uids = before && indexes.get(key);
  if (!uids) {
    uids = await dateIndex(client, mailbox.exists, q);
    indexes.delete(key);
    indexes.set(key, uids);
    if (indexes.size > 32) indexes.delete(indexes.keys().next().value);
  }
  const cursor = before ? uids.indexOf(before) : -1;
  if (before && cursor < 0) throw new MailError(409, 'err.validityChanged');
  const pageSize = Number.isInteger(size) && size > 0 ? Math.min(400, size) : defaultPageSize;
  const page = uids.slice(cursor + 1, cursor + 1 + (bulk ? 400 : pageSize));
  const messages = [];
  for (let offset = 0; offset < page.length; offset += 100) {
    for (const message of await readSummaries(client, page.slice(offset, offset + 100))) {
      messages.push(summary(message));
    }
  }
  return { messages, validity, next: cursor + 1 + page.length < uids.length ? page.at(-1) : null };
}

async function getRecent(client, { includeJunk = true, size = defaultPageSize } = {}) {
  const folders = (await client.list())
    .filter(folder => !folder.flags.has('\\Noselect') && !folder.flags.has('\\NonExistent') && isReceivedFolder(folder, includeJunk))
    .slice(0, recentFolderLimit);
  const collected = [];
  const scanned = [];
  const failures = [];
  let succeeded = 0;
  const pageSize = Number.isInteger(size) && size > 0 ? Math.min(120, size) : defaultPageSize;

  for (const folder of folders) {
    const name = recentFolderName(folder);
    try {
      const { mailbox, validity } = await openFolder(client, folder.path);
      succeeded += 1;
      if (!mailbox.exists) {
        scanned.push({ path: folder.path, name, count: 0 });
        continue;
      }
      const uids = await dateIndex(client, mailbox.exists);
      const raw = await readSummaries(client, uids.slice(0, pageSize));
      for (const message of raw) {
        if (!message.uid || !message.envelope) continue;
        collected.push({
          ...summary(message),
          folder: folder.path,
          folderName: name,
          folderSpecial: folder.specialUse || '',
          validity,
        });
      }
      scanned.push({ path: folder.path, name, count: mailbox.exists });
    } catch (error) {
      failures.push(error);
    }
  }

  if (!succeeded && failures.length) throw failures[0];

  const unique = new Map(collected.map(message => [`${message.folder}:${message.uid}`, message]));
  const messages = [...unique.values()]
    .sort((a, b) => {
      const left = Date.parse(a.date) || 0;
      const right = Date.parse(b.date) || 0;
      return right - left || b.uid - a.uid;
    })
    .slice(0, recentMessageLimit);
  return { messages, folders: scanned };
}

const htmlToText = compile({
  wordwrap: false,
  limits: { maxInputLength: 1024 * 1024, maxDepth: 100 },
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'head', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
  ],
});

function bodyParts(node, depth = 0) {
  if (!node || depth > 35 || node.disposition?.toLowerCase() === 'attachment' || node.type === 'message/rfc822') return [];
  if (node.type === 'text/plain' || node.type === 'text/html') return [node];
  return (node.childNodes ?? []).flatMap(child => bodyParts(child, depth + 1));
}

async function getMessage(client, { path, uid, validity }) {
  await openFolder(client, path, validity);
  const data = await client.fetchOne(uid, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true }, { uid: true });
  if (!data?.envelope) throw new MailError(404, 'err.messageGone');
  const parts = bodyParts(data.bodyStructure);
  const ordered = [...parts.filter(part => part.type === 'text/plain'), ...parts.filter(part => part.type === 'text/html')];
  const limit = 512 * 1024;
  for (const part of ordered) {
    const { content } = await client.download(uid, part.part || '1', { uid: true, maxBytes: limit + 1 });
    if (!content) continue;
    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const raw = buffer.subarray(0, limit).toString('utf8');
    const text = (part.type === 'text/html' ? htmlToText(raw) : raw).trim();
    if (text) return { ...summary(data), text, truncated: buffer.length > limit };
  }
  return { ...summary(data), text: '', truncated: false };
}
