const { app, BrowserWindow, session, shell, Menu, dialog } = require('electron');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');

let mainWindow = null;
let running = null;
let starting = false;
let settingsStore = null;

// Keep in sync with defaultSettings in settings.mjs. Only the values needed before the app is
// ready live here; the validated store is created later inside boot().
const startupDefaults = { language: 'zh', bypassProxy: true, startAtLogin: false };

function readStartupSettings() {
  try {
    const file = join(app.getPath('userData'), 'SimpleMail', 'settings.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return { ...startupDefaults, ...(data && typeof data === 'object' ? data : {}) };
  } catch {
    return { ...startupDefaults };
  }
}

const startup = readStartupSettings();

// Chromium reads the Windows proxy settings by default. When a VPN or proxy client is running,
// requests to the local page can be routed through it and fail with ERR_PROXY_CONNECTION_FAILED.
// The window only ever talks to 127.0.0.1, so going direct is always correct and keeps the app
// usable with any VPN configuration.
if (startup.bypassProxy !== false) {
  app.commandLine.appendSwitch('no-proxy-server');
}

function windowTitle() {
  if (startup.language === 'en') return 'Simple Mail';
  if (startup.language === 'ja') return '簡メール';
  return '简邮';
}

function applyLoginItem(enabled) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true,
      path: process.execPath,
      args: ['--autostart'],
    });
  } catch {
    // Login items are a convenience; a locked-down system may refuse them.
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    boot();
  });
}

async function boot() {
  if (starting || running) return;
  starting = true;
  try {
    const { startApp } = await import('./server.mjs');
    const { createSettingsStore } = await import('./settings.mjs');
    const directory = join(app.getPath('userData'), 'SimpleMail');
    settingsStore = createSettingsStore(directory);

    running = await startApp({
      directory,
      port: 0,
      settings: settingsStore,
      hooks: {
        openPath: target => shell.openPath(target),
        restart: () => {
          app.relaunch();
          app.exit(0);
        },
      },
    });

    if (settingsStore.get().bypassProxy !== false) {
      try { await session.defaultSession.setProxy({ mode: 'direct' }); } catch { /* the switch above already applies */ }
    }
    applyLoginItem(settingsStore.get().startAtLogin);
    settingsStore.onChange(next => applyLoginItem(next.startAtLogin));

    const iconPath = join(app.getAppPath(), 'build', 'icon.ico');
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: windowTitle(),
      backgroundColor: '#f7f7f5',
      icon: iconPath,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.focus();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(running.url)) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });

    // If the first load still fails (a proxy client that hijacks loopback, for example), drop the
    // proxy entirely and retry before showing any error.
    let retries = 0;
    mainWindow.webContents.on('did-fail-load', async (event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || retries >= 2 || !running) return;
      retries += 1;
      try {
        await session.defaultSession.setProxy({ mode: 'direct' });
        await mainWindow.loadURL(running.url);
      } catch {
        if (retries >= 2) {
          dialog.showErrorBox(windowTitle(), `${description || 'ERR_FAILED'} (${code})\n${running.url}`);
        }
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
    await mainWindow.loadURL(running.url);
  } catch (error) {
    starting = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    if (running && running.server) {
      try { running.server.close(); } catch (_) {}
      running = null;
    }
    const detail = error && error.message ? error.message : String(error);
    dialog.showErrorBox(windowTitle(), detail);
    app.quit();
    return;
  }
  starting = false;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (running && running.server) {
      try { running.server.close(); } catch (_) {}
      running = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (running && running.server) {
    try { running.server.close(); } catch (_) {}
    running = null;
  }
});
