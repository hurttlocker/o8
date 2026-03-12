const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cortexDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
