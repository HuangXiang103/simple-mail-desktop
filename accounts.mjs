import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MailError } from './mail.mjs';

const protectScript = String.raw`$ErrorActionPreference='Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
$inputValue=[Console]::In.ReadToEnd()
$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputValue))
$protected=ConvertFrom-SecureString (ConvertTo-SecureString $value -AsPlainText -Force)
[Console]::Out.Write($protected)`;

const unprotectScript = String.raw`$ErrorActionPreference='Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
$protected=[Console]::In.ReadToEnd()
$secure=ConvertTo-SecureString $protected
$value=[System.Net.NetworkCredential]::new('', $secure).Password
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))`;

function runDpapi(script, input) {
  return new Promise((resolve, reject) => {
    const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error('Windows credential protection failed'));
    });
    child.stdin.end(input);
  });
}

export const windowsVault = {
  available: process.platform === 'win32',
  protect: password => runDpapi(protectScript, Buffer.from(password, 'utf8').toString('base64')),
  unprotect: async encrypted => Buffer.from(await runDpapi(unprotectScript, encrypted), 'base64').toString('utf8'),
};

export async function createAccountStore(directory, vault = windowsVault) {
  const filename = join(directory, 'accounts.json');
  const passwords = new Map();
  let accounts;
  try {
    const data = JSON.parse(await readFile(filename, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid accounts file');
    accounts = data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new MailError(500, 'err.accountsRead');
    accounts = [];
  }
  let writes = Promise.resolve();

  function performWrite(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }

  async function persist(nextAccounts) {
    const temp = join(directory, `${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temp, JSON.stringify(nextAccounts, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temp, filename);
    } catch {
      await rm(temp, { force: true }).catch(() => {});
      throw new MailError(500, 'err.accountsWrite');
    }
    accounts = nextAccounts;
  }

  function publicAccount({ secret, ...account }) {
    return { ...account, remember: Boolean(secret), connected: Boolean(secret || passwords.has(account.id)) };
  }

  function find(id) {
    const account = accounts.find(item => item.id === id);
    if (!account) throw new MailError(404, 'err.accountGone');
    return account;
  }

  return {
    canRemember: vault.available,
    list: () => accounts.map(publicAccount),
    find: id => publicAccount(find(id)),
    async withPassword(id) {
      const { secret, ...account } = find(id);
      let password = passwords.get(id);
      if (!password && secret) {
        try {
          password = await vault.unprotect(secret);
        } catch {
          throw new MailError(409, 'err.unlock');
        }
        if (accounts.some(current => current.id === id && current.secret === secret)) passwords.set(id, password);
      }
      if (!password) throw new MailError(409, 'err.needPassword');
      return { ...account, password };
    },
    save: (id, input) => performWrite(async () => {
      if (id) find(id);
      if (accounts.some(account => account.email.toLowerCase() === input.email.toLowerCase() && account.id !== id)) {
        throw new MailError(409, 'err.duplicate');
      }
      const { password, remember, ...details } = input;
      let secret;
      if (remember && vault.available) {
        try {
          secret = await vault.protect(password);
        } catch {
          throw new MailError(500, 'err.protect');
        }
      }
      const account = { ...details, id: id || randomUUID(), ...(secret ? { secret } : {}) };
      await persist(id ? accounts.map(item => item.id === id ? account : item) : [...accounts, account]);
      passwords.set(account.id, password);
      return publicAccount(account);
    }),
    remove: id => performWrite(async () => {
      find(id);
      await persist(accounts.filter(account => account.id !== id));
      passwords.delete(id);
    }),
  };
}
