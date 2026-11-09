import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadMap, saveMap, type SavedMap } from './store';
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
  bNav.disabled = !current || current.points.length < 3;
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
  // <img> natural size respects EXIF orientation, same as Leaflet's imageOverlay.
  const img = new Image();
  img.src = URL.createObjectURL(f);
  await img.decode();
  current = { blob: f, w: img.naturalWidth, h: img.naturalHeight, points: [] };
  URL.revokeObjectURL(img.src);
  await saveMap(current);
  file.value = '';
  go('cal');
});

bCal.addEventListener('click', () => go('cal'));
bNav.addEventListener('click', () => go('nav'));

current = await loadMap();
if (!current) {
  syncButtons();
  view.innerHTML = `<div class="empty">Load a photo of a trail map to start.</div>`;
} else go(current.points.length >= 3 ? 'nav' : 'cal');
