/**
 * A standalone Electron process that shows one framed window filled with solid #FF00FF, for the
 * native window-capture test (an in-process window would be excluded from Framelet's own window
 * list). Not part of the app. Usage: electron color-window.mjs <title> <x> <y> <userDataDir>
 *
 * stdout: `READY {"bounds":{...},"contentBounds":{...}}` once painted.
 * Commands: write `minimize`, `restore` or `quit` to `<userDataDir>/command.txt` (polled; reading
 * process.stdin in an Electron main process stalls on Windows).
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';

const [title, x, y, userData] = process.argv.slice(2);
if (userData) app.setPath('userData', userData);
const commandFile = path.join(userData ?? '.', 'command.txt');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no menu bar: the content size is then exactly what was asked
  const win = new BrowserWindow({
    title,
    x: Number(x),
    y: Number(y),
    width: 640,
    height: 400,
    useContentSize: true,
    resizable: false,
    show: true,
    backgroundColor: '#FF00FF',
    webPreferences: { backgroundThrottling: false },
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  const html = '<body style="margin:0;background:#FF00FF"></body>';
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      console.log(
        `READY ${JSON.stringify({ bounds: win.getBounds(), contentBounds: win.getContentBounds() })}`,
      );
    }, 600);
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  setInterval(() => {
    let command;
    try {
      command = fs.readFileSync(commandFile, 'utf8').trim();
      fs.rmSync(commandFile, { force: true });
    } catch {
      return;
    }
    if (command === 'minimize') win.minimize();
    else if (command === 'restore') win.restore();
    else if (command === 'quit') app.quit();
  }, 150);
});

app.on('window-all-closed', () => app.quit());
