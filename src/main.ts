import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadMap, saveMap, type SavedMap } from './store';
import { fitAffine } from './georef';
import { pdfToImage, preloadPdf } from './pdf';
import { showCalibrate } from './calibrate';
import { showNavigate } from './navigate';

const view = document.getElementById('view')!;
const file = document.getElementById('file') as HTMLInputElement;
const bCal = document.getElementById('b-cal') as HTMLButtonElement;
const bNav = document.getElementById('b-nav') as HTMLButtonElement;

let current: SavedMap | undefined;
let teardown: (() => void) | undefined;

function syncButtons(screen?: 'cal' | 'nav') {
  bCal.disabled = !current;
  bNav.disabled = !current || !fitAffine(current.points); // also false for collinear points
  if (screen) {
    bCal.classList.toggle('on', screen === 'cal');
    bNav.classList.toggle('on', screen === 'nav');
  }
}

function go(screen: 'cal' | 'nav') {
  teardown?.();
  syncButtons(screen);
  teardown = screen === 'cal'
    ? showCalibrate(view, current!, () => saveMap(current!), () => syncButtons())
    : showNavigate(view, current!);
}

file.addEventListener('change', async () => {
  const f = file.files![0];
  if (current?.points.length && !confirm('Replace the calibrated map? Its points will be lost.')) { file.value = ''; return; }
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
    current = { blob, w: img.naturalWidth, h: img.naturalHeight, points: [] };
    URL.revokeObjectURL(img.src);
    setStage('Saving');
    await saveMap(current);
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

// A real button calling file.click() (inside the tap's user gesture) is more reliable
// on iOS than a <label> wrapping a display:none input.
document.getElementById('b-load')!.addEventListener('click', preload);
bCal.addEventListener('click', () => go('cal'));
bNav.addEventListener('click', () => go('nav'));

current = await loadMap();
if (!current) {
  syncButtons();
  view.innerHTML = `<div class="empty">
    <button id="pick" class="btn on big">📷 Choose a map photo or PDF</button>
    <ol>
      <li>Take a photo of a trail map, or pick a photo or PDF</li>
      <li>Match 4–6 spots on it to the satellite view</li>
      <li>Navigate: your GPS dot appears on the photo</li>
    </ol>
  </div>`;
  view.querySelector('#pick')!.addEventListener('click', preload);
} else go(fitAffine(current.points) ? 'nav' : 'cal');
