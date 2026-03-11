const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const DEV_URL = process.env.CORTEX_IDE_DEV_URL || 'http://localhost:3001';

function createWindow(route = '/') {
  const window = new BrowserWindow({
    width: 1600,
    height: 1024,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f5f7fb',
    title: 'Cortex IDE',
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
      label: 'Cortex IDE',
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
