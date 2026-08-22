const endpoint = process.argv[2] || 'http://127.0.0.1:9222';
const targetUrl = process.argv[3] || 'http://127.0.0.1:4173/';
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
const exceptions = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (!message.id || !pending.has(message.id)) return;
  const handlers = pending.get(message.id);
  pending.delete(message.id);
  message.error ? handlers.reject(new Error(message.error.message)) : handlers.resolve(message.result);
});
function command(method, params = {}) {
  const commandId = ++id;
  socket.send(JSON.stringify({ id: commandId, method, params }));
  return new Promise((resolve, reject) => pending.set(commandId, { resolve, reject }));
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await command('Page.enable');
await command('Runtime.enable');
await command('Network.enable');
await command('Network.setBypassServiceWorker', { bypass: false });
await command('Storage.clearDataForOrigin', { origin: new URL(targetUrl).origin, storageTypes: 'all' });
await command('Page.navigate', { url: targetUrl });
await wait(1500);
const ready = await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
await command('Page.reload');
await wait(700);
const controlled = await evaluate(`Boolean(navigator.serviceWorker.controller)`);
await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
await command('Page.reload');
await wait(800);
const offline = await evaluate(`({ hasApp: Boolean(document.querySelector('#app')), hasChildText: document.body.innerText.includes('きょうの きろく'), controlled: Boolean(navigator.serviceWorker.controller) })`);
await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' });
socket.close();
console.log(JSON.stringify({ ready, controlled, offline, exceptions }));
if (!ready || !controlled || !offline.hasApp || !offline.hasChildText || !offline.controlled || exceptions.length) process.exitCode = 1;
