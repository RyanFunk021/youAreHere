// Instruction screenshots: drives the real app (headless Chrome over CDP) with a synthetic
// "Example Park" map placed over Jubilee College State Park, fake GPS and compass, and
// saves PNGs. Run via scripts/shots/run.sh, which serves the build and converts to JPEG.
// Usage: node help-shots.mjs URL OUT_DIR SCRATCH_DIR
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [URL_, OUT, SCR] = process.argv.slice(2), ORIGIN = new URL(URL_).origin;
const HERE = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- geometry: photo px -> lat/lng (1.5 m/px, map drawn 12° off north)
const R = 6378137, D = Math.PI / 180, o = [40.842, -89.822], th = 12 * D, s = 1.5;
const truth = (u, v) => { const x = s * (Math.cos(th) * u + Math.sin(th) * v), y = s * (Math.sin(th) * u - Math.cos(th) * v); return [o[0] + y / (R * D), o[1] + x / (R * D * Math.cos(o[0] * D))]; };
const RIDGE = [[300, 1150], [420, 860], [680, 560], [1000, 420], [1350, 440], [1650, 650], [1720, 960], [1450, 1160], [1000, 1200], [620, 1210], [300, 1150]];
const CREEK = [[1000, 1200], [1060, 960], [980, 700], [1000, 420]];
const SPUR = [[1650, 650], [1860, 470]];
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
const noisy = ([u, v]) => { const [la, ln] = truth(u, v); return [la + rnd() * 5 / 111000, ln + rnd() * 5 / 84000]; };
const points = [[305, 1225], [1000, 420], [1860, 470], [1450, 1160]].map(p => ({ px: p, ll: noisy(p) }));

// --- CDP plumbing
const t = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let i = 0, chooser = null; const errs = [];
const send = (method, params = {}) => new Promise(r => { const id = ++i; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', h); r(m); } }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data);
  if (m.method === 'Page.fileChooserOpened') chooser = m.params;
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true })).result.result?.value;
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('  saved', name); };
const tapAt = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(500); };
const rect = sel => ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`);
const tapIn = async (sel, fx, fy, dx = 0) => { const [x, y, w, h] = await rect(sel); await tapAt(x + w * fx + dx, y + h * fy); };
const click = sel => ev(`document.querySelector('${sel}').click()`);

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: ORIGIN });
const [la0, ln0] = truth(300, 1150);
await send('Emulation.setGeolocationOverride', { latitude: la0, longitude: ln0, accuracy: 5 });
// iOS-style compass (tap to allow, webkitCompassHeading); wake lock always granted.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `delete Window.prototype.ondeviceorientationabsolute; delete window.ondeviceorientationabsolute; DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); navigator.wakeLock.request = async () => ({ release: async () => {} });` });

// 01 — first run
await send('Page.navigate', { url: URL_ }); await sleep(2500);
await shot('01-start');

// Seed "Example Park" (4 pairs) + a second, uncalibrated map for the list.
await ev(`(async () => {
  const W = 2000, H = 1400, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#f2eee0'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#d6e4c4'; g.beginPath(); g.moveTo(230, 160); g.lineTo(1930, 140); g.lineTo(1960, 1260); g.lineTo(240, 1270); g.closePath(); g.fill();
  g.fillStyle = '#b9d1a3'; for (let k = 0; k < 900; k++) { const x = 260 + ((k * 397) % 1680), y = 180 + ((k * 211) % 1060); g.beginPath(); g.arc(x, y, 9 + (k % 7), 0, 7); g.fill(); }
  g.strokeStyle = '#7fb3dc'; g.lineWidth = 12; g.beginPath(); g.moveTo(160, 250); g.bezierCurveTo(520, 330, 760, 720, 1110, 830); g.stroke();
  g.fillStyle = '#9cc7e6'; g.beginPath(); g.ellipse(1260, 860, 200, 115, -0.3, 0, 7); g.fill();
  for (const [w, col] of [[30, '#b8b8b8'], [20, '#ffffff']]) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(0, 1330); g.lineTo(2000, 1310); g.moveTo(160, 0); g.lineTo(160, 1400); g.stroke(); }
  g.fillStyle = '#c9c9c9'; g.fillRect(250, 1190, 110, 72); g.fillStyle = '#1a5fb4'; g.font = 'bold 58px sans-serif'; g.fillText('P', 283, 1247);
  const line = (pts, col) => { g.strokeStyle = col; g.lineWidth = 13; g.lineJoin = 'round'; g.setLineDash([30, 14]); g.beginPath(); pts.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); };
  line(${JSON.stringify(RIDGE)}, '#c0392b'); line(${JSON.stringify(CREEK)}, '#2471a3'); line(${JSON.stringify(SPUR)}, '#b7950b');
  g.fillStyle = '#333'; g.font = 'italic 44px Georgia, serif';
  g.fillText('Ridge Loop', 560, 480); g.fillText('Creek Trail', 1080, 1060); g.fillText('Overlook', 1700, 420); g.fillText('Mirror Lake', 1150, 870);
  g.fillStyle = '#222'; g.font = 'bold 64px Georgia, serif'; g.fillText('Example Park · Trail Map', 260, 115);
  g.save(); g.translate(1840, 1150); g.rotate(${th}); g.fillStyle = '#222'; g.beginPath(); g.moveTo(0, -70); g.lineTo(26, 30); g.lineTo(0, 12); g.lineTo(-26, 30); g.closePath(); g.fill(); g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, -82); g.restore();
  g.fillStyle = '#222'; g.fillRect(260, 1365, 133, 10); g.font = '30px sans-serif'; g.fillText('200 m', 410, 1380);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const db = await new Promise(r => { const q = indexedDB.open('keyval-store'); q.onupgradeneeded = () => q.result.createObjectStore('keyval'); q.onsuccess = () => r(q.result); });
  const put = (k, v) => new Promise(r => { const tx = db.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(v, k); tx.oncomplete = r; });
  const now = Date.now();
  await put('map:ex', { id: 'ex', name: 'Example Park', blob, w: W, h: H, points: ${JSON.stringify(points)} });
  await put('map:lake', { id: 'lake', name: 'Lakeside Trails', blob, w: W, h: H, points: [] });
  await put('maps', [ { id: 'ex', name: 'Example Park', updated: now, points: 4, trailM: 0 }, { id: 'lake', name: 'Lakeside Trails', updated: now - 86400000 * 3, points: 0, trailM: 0 } ]);
  await put('current', 'ex');
})()`);

// 02/03 — calibrate: tap the map, the satellite jumps to the prediction, tap it, Add pair
await send('Page.navigate', { url: URL_ }); await sleep(2500);
await click('#b-cal'); await sleep(3500);
await tapIn('#ph', 0.62, 0.62); await sleep(2500);
await tapIn('#sat', 0.5, 0.5); await sleep(2500);
await shot('02-calibrate-pair');
await click('#add'); await sleep(1500);
await shot('03-calibrate-fit');
// 04 — a deliberate mis-tap gets flagged
await tapIn('#ph', 0.3, 0.3); await sleep(2500);
await tapIn('#sat', 0.5, 0.5, 70); await sleep(800);
await click('#add'); await sleep(2000);
await shot('04-calibrate-mistap');
const bad = await ev(`[...document.querySelectorAll('.chip')].findIndex(c => c.classList.contains('bad'))`);
if (bad >= 0) { await ev(`document.querySelectorAll('.chip')[${bad}].querySelector('[data-del]').click()`); await sleep(500); }

// 05 — navigate: walk part of the Ridge Loop, add a hike photo, align the compass
const walk = []; for (let k = 0; k < 5; k++) { const [a, b] = [RIDGE[k], RIDGE[k + 1]]; for (let f = 0; f < 1; f += 0.2) walk.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]); }
await click('#b-nav'); await sleep(2500);
for (const [u, v] of walk) { const [la, ln] = truth(u, v); await send('Emulation.setGeolocationOverride', { latitude: la, longitude: ln, accuracy: 5 }); await sleep(450); }
const [pla, pln] = truth(1350, 440);
execFileSync('python3', [join(HERE, 'scenic.py'), `${SCR}/overlook.jpg`, String(pla), String(pln)]);
await send('Page.setInterceptFileChooserDialog', { enabled: true });
await click('#addphotos'); await sleep(500);
await send('DOM.getDocument'); await send('DOM.setFileInputFiles', { files: [`${SCR}/overlook.jpg`], backendNodeId: chooser.backendNodeId });
await sleep(3000);
console.log('  photo report:', await ev(`document.querySelector('#gps').innerText`));
await click('.compass'); await sleep(400);
const mapN = parseFloat((await ev(`document.querySelector('.compass .mapn').getAttribute('transform')`)).match(/-?[\d.]+/)[0]);
for (let k = 0; k < 30; k++) await ev(`(() => { const e = new Event('deviceorientation'); Object.assign(e, { webkitCompassHeading: ${(360 - mapN + 3) % 360} }); window.dispatchEvent(e); })()`);
const [lz, lnz] = truth(...walk[walk.length - 1]); await send('Emulation.setGeolocationOverride', { latitude: lz + 0.00004, longitude: lnz, accuracy: 5 }); await sleep(1200);
// Show the whole walk, then zoom one step towards it, so the trail of dots is visible.
await click('#fitmap'); await sleep(800);
{ const [x, y, w, h] = await rect('#nav'); await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w * 0.45, y: y + h * 0.42, deltaX: 0, deltaY: -240 }); await sleep(1500); }
await shot('05-navigate');
// 06 — tap the camera dot
await ev(`document.querySelector('.cam').dispatchEvent(new MouseEvent('click', { bubbles: true }))`); await sleep(800);
await shot('06-photo');
await click('.lightbox [data-a=close]'); await sleep(300);
// 09 — the session menu
await click('.pill'); await sleep(500);
await shot('09-session');
await click('[data-s=close]'); await sleep(300);
// 07 — the Maps list
await click('#b-maps'); await sleep(1500);
await shot('07-maps');
// 08 — location blocked
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: ORIGIN });
await send('Page.navigate', { url: URL_ }); await sleep(3000);
await click('[data-loc=ask]'); await sleep(1200);
await shot('08-location-blocked');
console.log(errs.length ? 'EXC ' + errs.join(' | ') : '  no exceptions'); ws.close();
