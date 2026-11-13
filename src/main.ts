import 'leaflet/dist/leaflet.css';
import './style.css';
import { getCurrentId, listMaps, loadMap, newId, persist, saveMap, setCurrentId, type SavedMap } from './store';
import { fitAffine } from './georef';
import { pdfToImage, preloadPdf } from './pdf';
import { showCalibrate } from './calibrate';
import { showNavigate } from './navigate';
import { showMaps } from './maps';

const view = document.getElementById('view')!;
const file = document.getElementById('file') as HTMLInputElement;
const bMaps = document.getElementById('b-maps') as HTMLButtonElement;
const bCal = document.getElementById('b-cal') as HTMLButtonElement;
const bNav = document.getElementById('b-nav') as HTMLButtonElement;

let current: SavedMap | undefined;
let teardown: (() => void) | undefined;

type Screen = 'maps' | 'cal' | 'nav';

function syncButtons(screen?: Screen) {
  bCal.disabled = !current;
  bNav.disabled = !current || !fitAffine(current.points); // also false for collinear points
  if (screen) {
    bMaps.classList.toggle('on', screen === 'maps');
    bCal.classList.toggle('on', screen === 'cal');
    bNav.classList.toggle('on', screen === 'nav');
  }
}

function go(screen: Screen) {
  teardown?.();
  syncButtons(screen);
  teardown = screen === 'maps'
    ? showMaps(view, { open, pick: preload, changed: refreshCurrent })
    : screen === 'cal'
      ? showCalibrate(view, current!, () => saveMap(current!), () => syncButtons())
      : showNavigate(view, current!);
}

async function open(id: string) {
  current = await loadMap(id);
  await setCurrentId(id);
  go(fitAffine(current!.points) ? 'nav' : 'cal');
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
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) blob = await pdfToImage(f, setStage);
    setStage('Decoding image');
    // <img> natural size respects EXIF orientation, same as Leaflet's imageOverlay.
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    // New maps are added to the library; nothing is replaced. Camera photos are all
    // called "image.jpg", so give those a dated name instead.
    const base = f.name.replace(/\.[^.]+$/, '');
    const name = !base || /^image$/i.test(base) ? `Map ${new Date().toLocaleDateString()}` : base;
    current = { id: newId(), name, blob, w: img.naturalWidth, h: img.naturalHeight, points: [] };
    URL.revokeObjectURL(img.src);
    setStage('Saving');
    await saveMap(current);
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
  go('cal');
});

// Start fetching pdf.js while the user is still in the file picker.
const preload = () => { preloadPdf(); file.click(); };

bMaps.addEventListener('click', () => go('maps'));
bCal.addEventListener('click', () => go('cal'));
bNav.addEventListener('click', () => go('nav'));

// Reopen the last map; otherwise show the library (which is also the first-run screen).
const maps = await listMaps(); // also migrates the v1 single-map slot
const lastId = await getCurrentId();
if (lastId && maps.some(m => m.id === lastId)) await open(lastId);
else go('maps');
