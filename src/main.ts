import 'leaflet/dist/leaflet.css';
import './style.css';
import { getCurrentId, listMaps, loadMap, loadWaypoints, newId, persist, saveMap, saveWaypoints, setCurrentId, type SavedMap } from './store';
import { parseLatLng } from './waypoint';
import { fitPoints, type ControlPoint } from './georef';
import { pdfToImage, preloadPdf } from './pdf';
import { isMapFile, unpackMap } from './share';
import { showCalibrate } from './calibrate';
import { showNavigate } from './navigate';
import { showMaps } from './maps';
import { showHelp } from './help';

const view = document.getElementById('view')!;
const file = document.getElementById('file') as HTMLInputElement;
const bMaps = document.getElementById('b-maps') as HTMLButtonElement;
const bCal = document.getElementById('b-cal') as HTMLButtonElement;
const bNav = document.getElementById('b-nav') as HTMLButtonElement;
const bHelp = document.getElementById('b-help') as HTMLButtonElement;

let current: SavedMap | undefined;
let teardown: (() => void) | undefined;

type Screen = 'maps' | 'cal' | 'nav' | 'help';

function syncButtons(screen?: Screen) {
  bCal.disabled = !current;
  bNav.disabled = !current || !fitPoints(current.points); // also false for collinear points
  if (screen) {
    bMaps.classList.toggle('on', screen === 'maps');
    bCal.classList.toggle('on', screen === 'cal');
    bNav.classList.toggle('on', screen === 'nav');
    bHelp.classList.toggle('on', screen === 'help');
  }
}

function go(screen: Screen) {
  teardown?.();
  syncButtons(screen);
  // #help is a shareable link to the instructions; drop it when leaving that screen.
  if (screen === 'help') { if (location.hash !== '#help') history.replaceState(null, '', '#help'); }
  else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  teardown = screen === 'help' ? showHelp(view) : screen === 'maps'
    ? showMaps(view, { open, pick: preload, changed: refreshCurrent })
    : screen === 'cal'
      ? showCalibrate(view, current!, () => saveMap(current!), () => syncButtons())
      : showNavigate(view, current!);
}

async function open(id: string, screen?: 'cal' | 'nav') {
  current = await loadMap(id);
  await setCurrentId(id);
  go(screen ?? (fitPoints(current!.points) ? 'nav' : 'cal'));
}

// After a rename/clear/delete on the Maps screen, re-read the open map (or drop it).
async function refreshCurrent(id: string) {
  if (current?.id === id) current = await loadMap(id);
  syncButtons('maps');
}

file.addEventListener('change', async () => {
  const f = file.files![0];
  teardown?.(); teardown = undefined;

  // Show the current stage and a running clock, so "slow" and "stuck" look different,
  // and show the error instead of leaving a stale status on screen.
  const t0 = performance.now();
  const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
  let stage = 'Reading file';
  const setStage = (s: string) => { console.info(`[import] ${stage} done at ${secs()}s`); stage = s; };
  const render = () => { view.innerHTML = `<div class="empty"><div class="stage">${stage}…</div><div class="clock">${secs()} s</div></div>`; };
  render();
  const tick = setInterval(render, 200);
  try {
    let blob: Blob = f;
    let shared: Awaited<ReturnType<typeof unpackMap>> | null = null;
    let geoPoints: ControlPoint[] | null = null;
    if (isMapFile(f)) { setStage('Opening shared map'); shared = await unpackMap(f); blob = shared.blob; }
    else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const r = await pdfToImage(f, setStage);
      blob = r.blob;
      if (r.points.length >= 2) geoPoints = r.points; // a GeoPDF: calibrated with zero taps
    }
    setStage('Decoding image');
    // <img> natural size respects EXIF orientation, same as Leaflet's imageOverlay.
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    // New maps are added to the library; nothing is replaced. Camera photos are all
    // called "image.jpg", so give those a dated name instead.
    const base = f.name.replace(/\.[^.]+$/, '');
    const name = shared?.name ?? (!base || /^image$/i.test(base) ? `Map ${new Date().toLocaleDateString()}` : base);
    current = { id: newId(), name, blob, w: img.naturalWidth, h: img.naturalHeight, points: shared?.points ?? geoPoints ?? [] };
    if (geoPoints) toast(`This PDF carries its own coordinates, so it's ready to navigate. No calibration needed.`);
    URL.revokeObjectURL(img.src);
    setStage('Saving');
    await saveMap(current);
    if (shared?.waypoints.length) await saveWaypoints(current.id, shared.waypoints);
    await setCurrentId(current.id);
    persist();
    setStage('Done');
  } catch (e) {
    clearInterval(tick);
    view.innerHTML = `<div class="empty"><div class="stage">Couldn't load this file (failed while: ${stage})</div><pre class="err"></pre></div>`;
    view.querySelector('.err')!.textContent = String(e);
    console.error(e);
    return;
  } finally {
    clearInterval(tick);
    file.value = '';
  }
  go(current && fitPoints(current.points) ? 'nav' : 'cal'); // a shared map arrives calibrated
});

// A short message that floats over whatever screen comes next.
function toast(text: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// Start fetching pdf.js while the user is still in the file picker.
const preload = () => { preloadPdf(); file.click(); };

bMaps.addEventListener('click', () => go('maps'));
bCal.addEventListener('click', () => go('cal'));
bNav.addEventListener('click', () => go('nav'));
bHelp.addEventListener('click', () => go('help'));
window.addEventListener('hashchange', () => { if (location.hash === '#help') go('help'); });

// Reopen the last map; otherwise show the library (which is also the first-run screen).
const maps = await listMaps(); // also migrates the v1 single-map slot
const lastId = await getCurrentId();
if (lastId && maps.some(m => m.id === lastId)) current = await loadMap(lastId);

// A shared waypoint link (?wp=lat,lng&name=...) adds the waypoint to the current map.
const params = new URLSearchParams(location.search);
const wp = params.get('wp');
if (wp) {
  history.replaceState(null, '', location.pathname + location.hash); // so a reload doesn't add it again
  const r = parseLatLng(wp);
  if ('error' in r) alert(`That waypoint link didn't work: ${r.error}`);
  else if (!current || !fitPoints(current.points)) alert('Open and calibrate a map first, then tap the waypoint link again.');
  else {
    const list = await loadWaypoints(current.id);
    await saveWaypoints(current.id, [...list, { id: Date.now().toString(36), lat: r.ll[0], lng: r.ll[1], name: (params.get('name') ?? '').slice(0, 60), created: Date.now() }]);
  }
}
if (location.hash === '#help') go('help');
else if (current) await open(current.id);
else go('maps');
