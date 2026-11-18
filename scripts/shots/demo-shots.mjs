import { writeFileSync } from 'node:fs';
const [URL_, OUT] = process.argv.slice(2), ORIGIN = new URL(URL_).origin;
const t = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let i = 0; const errs = [];
const send = (method, params = {}) => new Promise(r => { const id = ++i; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', h); r(m); } }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true })).result.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64')); };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: ORIGIN });
// Downtown Peoria (Main St & Adams St) — on the 1905 map this is the dense grid by the river.
await send('Emulation.setGeolocationOverride', { latitude: 40.6936, longitude: -89.5890, accuracy: 8 });
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'navigator.wakeLock.request = async () => ({ release: async () => {} });' });
await send('Page.navigate', { url: URL_ }); await sleep(2500);
console.log('maps screen demo button:', await ev(`document.getElementById('demo')?.innerText`));
await ev(`document.getElementById('demo').click()`);
for (let k = 0; k < 40; k++) { await sleep(500); if (await ev(`!!document.querySelector('.hint')`)) break; }
await sleep(5000); // satellite tiles
console.log('calibrate:', await ev(`document.querySelector('.hint').innerText`), '|', await ev(`[...document.querySelectorAll('.chip')].map(c => c.innerText.replace('✕', '').trim()).join(' ')`));
await shot('demo-calibrate');
await ev(`document.getElementById('b-nav').click()`); await sleep(3500);
console.log('navigate status:', await ev(`document.querySelector('#gps').innerText`));
await shot('demo-navigate');
await ev(`document.getElementById('b-maps').click()`); await sleep(1000);
console.log('maps list:', await ev(`[...document.querySelectorAll('.maps li .name')].map(n => n.innerText).join(' ; ')`), '| demo button still shown:', await ev(`!!document.getElementById('demo')`));
console.log(errs.length ? 'EXC ' + errs.join(' | ') : 'no exceptions'); ws.close();
