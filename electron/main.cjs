const { app, BrowserWindow, Menu, shell, nativeImage } = require('electron');
const path = require('path');

const APP_NAME = 'Cortex IDE';
const DEV_URL = process.env.CORTEX_IDE_DEV_URL || 'http://localhost:3001';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icons', 'cortex-ide-dev.png');

app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
});

function createWindow(route = '/') {
  const window = new BrowserWindow({
    width: 1600,
    height: 1024,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f5f7fb',
    title: APP_NAME,
    icon: ICON_PATH,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const targetUrl = `${DEV_URL}${route}`;
  window.loadURL(targetUrl);

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return window;
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: 'Command Center',
          click: () => createWindow('/'),
        },
        {
          label: 'Mobile Remote Preview',
          click: () => createWindow('/mobile'),
        },
        { type: 'separator' },
        {
          label: 'Open GitHub PR #22',
          click: () => shell.openExternal('https://github.com/hurttlocker/cortex-ide/pull/22'),
        },
        {
          label: 'Open GitHub Issues',
          click: () => shell.openExternal('https://github.com/hurttlocker/cortex-ide/issues'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(icon);
    }
  }

  buildMenu();
  createWindow('/');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow('/');
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
