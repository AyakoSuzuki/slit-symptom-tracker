import { writeFile } from 'node:fs/promises';

const endpoint = process.argv[2] || 'http://127.0.0.1:9222';
const targetUrl = process.argv[3] || 'http://127.0.0.1:4173/';
const screenshotPath = process.argv[4] || 'browser-flow.png';
const parentScreenshotPath = process.argv[5] || 'browser-flow-parent.png';
const settingsScreenshotPath = process.argv[6] || 'browser-flow-settings.png';
const dataScreenshotPath = process.argv[7] || 'browser-flow-data.png';
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
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
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
const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

await command('Page.enable');
await command('Runtime.enable');
await command('Network.enable');
await command('Network.setBypassServiceWorker', { bypass: true });
await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await command('Storage.clearDataForOrigin', { origin: new URL(targetUrl).origin, storageTypes: 'all' });
await command('Page.navigate', { url: targetUrl });
await wait(800);

await evaluate(`document.querySelector('[data-action="adult-gate"]').click()`);
await wait();
await evaluate(`document.querySelector('[data-form="parent-gate"] input[name="confirm"]').checked=true; document.querySelector('[data-form="parent-gate"]').requestSubmit()`);
await wait();
await evaluate(`(() => {
  const f=document.querySelector('[data-form="settings"]');
  f.elements.medicationName.value='確認用の薬';
  f.elements.medicationDose.value='1単位';
  f.elements.symptomLabel.value='からだ';
  f.requestSubmit();
})()`);
await wait(500);
await evaluate(`document.querySelector('[data-action="back-child"]').click()`);
await wait();
const before = await evaluate(`({
  hasMedication: document.body.innerText.includes('確認用の薬'),
  worryButtons: document.querySelectorAll('[data-action="select-worry"]').length,
  worryLabels: document.querySelectorAll('[data-action="select-worry"] .scale-label').length,
  width: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth
})`);
await evaluate(`document.querySelector('[data-action="select-worry"][data-value="3"]').click(); document.querySelector('[data-action="start-dose"]').click()`);
await wait(500);
const active = await evaluate(`({ severityButtons: document.querySelectorAll('[data-action="record-severity"]').length, hasPrompt: document.body.innerText.includes('かわったときだけ') })`);
await evaluate(`document.querySelector('[data-action="record-severity"][data-value="3"]').click()`);
await wait(400);
await evaluate(`document.querySelector('[data-action="record-severity"][data-value="1"]').click()`);
await wait(400);
const lastValue = await evaluate(`({
  showsLast: document.body.innerText.includes('さいごの きろくは 1 ほんのすこし'),
  showsMax: document.body.innerText.includes('さいごの きろくは 3'),
  checked: document.querySelector('[data-action="record-severity"][data-value="1"]').getAttribute('aria-checked') === 'true',
  uncheckedOthers: document.querySelectorAll('[data-action="record-severity"][aria-checked="true"]').length === 1
})`);
await evaluate(`document.querySelector('[data-action="record-severity"][data-value="2"]').click()`);
await wait(5500);
const undoStayed = await evaluate(`Boolean(document.querySelector('.undo-bar'))`);
await evaluate(`document.querySelector('[data-action="record-severity"][data-value="0"]').click()`);
await wait(500);
const resolved = await evaluate(`({ resolvedText: document.body.innerText.includes('いまは きにならないよ'), hasAdult: Boolean(document.querySelector('[data-action="adult-gate"]')) })`);
await command('Page.reload');
await wait(800);
const persisted = await evaluate(`({ persistedText: document.body.innerText.includes('いまは きにならないよ'), severityButtons: document.querySelectorAll('[data-action="record-severity"]').length })`);
const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
await evaluate(`document.querySelector('[data-action="adult-gate"]').click()`);
await wait();
await evaluate(`document.querySelector('[data-form="parent-gate"] input[name="confirm"]').checked=true; document.querySelector('[data-form="parent-gate"]').requestSubmit()`);
await wait(500);
const parent = await evaluate(`({ tabs: document.querySelectorAll('[role="tab"]').length, charts: document.querySelectorAll('.chart-card svg').length, hasSummary: document.body.innerText.includes('記録の概要') })`);
const parentScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(parentScreenshotPath, Buffer.from(parentScreenshot.data, 'base64'));
await evaluate(`document.querySelector('[data-action="parent-tab"][data-tab="settings"]').click()`);
await wait();
const settingsUi = await evaluate(`({ oneSymptomField: document.querySelectorAll('[name="symptomLabel"]').length === 1, hasTechnicalCode: document.body.innerText.includes('症状コード') })`);
const settingsScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(settingsScreenshotPath, Buffer.from(settingsScreenshot.data, 'base64'));
await evaluate(`document.querySelector('[data-action="parent-tab"][data-tab="data"]').click()`);
await wait();
const dataUi = await evaluate(`({ hasBestEffort: document.body.innerText.includes('best-effort'), hasBackupLabel: document.body.innerText.includes('記録をバックアップ') })`);
const dataScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(dataScreenshotPath, Buffer.from(dataScreenshot.data, 'base64'));
socket.close();

const result = { before, active, lastValue, undoStayed, resolved, persisted, parent, settingsUi, dataUi, exceptions };
console.log(JSON.stringify(result));
if (!before.hasMedication || before.worryButtons !== 6 || before.worryLabels !== 6 || before.width !== before.scrollWidth ||
    !lastValue.showsLast || lastValue.showsMax || !lastValue.checked || !lastValue.uncheckedOthers ||
    active.severityButtons !== 6 || !active.hasPrompt || !undoStayed || !resolved.resolvedText ||
    !persisted.persistedText || persisted.severityButtons !== 6 || parent.tabs !== 5 || !parent.hasSummary ||
    !settingsUi.oneSymptomField || settingsUi.hasTechnicalCode || dataUi.hasBestEffort || !dataUi.hasBackupLabel || exceptions.length) process.exitCode = 1;
