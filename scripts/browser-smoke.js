import { writeFile } from 'node:fs/promises';

const endpoint = process.argv[2] || 'http://127.0.0.1:9222';
const targetUrl = process.argv[3] || 'http://127.0.0.1:4173/';
const screenshotPath = process.argv[4] || 'browser-smoke.png';
const targets = await (await fetch(`${endpoint}/json`)).json();
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error('No browser page target');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let id = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const commandId = ++id;
  socket.send(JSON.stringify({ id: commandId, method, params }));
  return new Promise((resolve, reject) => pending.set(commandId, { resolve, reject }));
}

await command('Page.enable');
await command('Runtime.enable');
await command('Network.enable');
await command('Network.setBypassServiceWorker', { bypass: true });
await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await command('Page.navigate', { url: targetUrl });
await new Promise((resolve) => setTimeout(resolve, 1500));
const evaluation = await command('Runtime.evaluate', {
  expression: `({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    hasApp: Boolean(document.querySelector('#app')),
    hasSetup: document.body.innerText.includes('おとなと いっしょに'),
    errors: window.__testErrors || []
  })`,
  returnByValue: true
});
const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
socket.close();
console.log(JSON.stringify(evaluation.result.value));
