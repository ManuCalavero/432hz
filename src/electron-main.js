const path = require('path');
const { app, BrowserWindow } = require('electron');

let server = null;

async function createWindow() {
  process.env.APP_DATA_DIR = app.getPath('userData');

  const { start } = require('./server');
  server = await start();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    maxWidth: 1280,
    maxHeight: 920,
    minWidth: 760,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow).catch((error) => {
  console.error('Unable to start 432Hz:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (server) {
    server.close();
    server = null;
  }
});