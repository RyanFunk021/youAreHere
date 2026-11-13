// Orienteering-style compass for Navigate.
//   "N" arrow  = where north is on the map image (from the calibration; always shown)
//   red needle = where north really is, from the phone's compass
// Turn the phone until they line up and the map is oriented to the land around you.
// The map itself never rotates.

type OrientEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

const ALIGNED_DEG = 10;
// Read off window so browsers without the API don't throw a ReferenceError.
const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
const needsTap = typeof DOE?.requestPermission === 'function';
const wrap = (d: number) => ((d + 540) % 360) - 180; // to [-180, 180)

export function compassWidget(parent: HTMLElement, mapNorthDeg: number) {
  const el = document.createElement('button');
  el.className = 'compass';
  el.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" class="ring"/>
      <g class="needle" style="display:none"><path d="M0,-36 L7,0 L-7,0 Z" class="n"/><path d="M0,36 L7,0 L-7,0 Z" class="s"/></g>
      <g class="mapn" transform="rotate(${mapNorthDeg})"><path d="M0,-47 L8,-31 L-8,-31 Z"/><text y="-17" text-anchor="middle">N</text></g>
    </svg><span class="hint">Tap for compass</span>`;
  parent.appendChild(el);
  const needle = el.querySelector<SVGGElement>('.needle')!;
  const hint = el.querySelector<HTMLElement>('.hint')!;

  let smooth: number | null = null;
  let started = false;
  let gotHeading = false;
  const evName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

  const onOrient = (ev: Event) => {
    const e = ev as OrientEvent;
    // iOS (Safari and Chrome): webkitCompassHeading, degrees clockwise from north.
    // Android Chrome: absolute alpha, counter-clockwise.
    const raw = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (raw == null) return;
    gotHeading = true;
    const h = (raw + (screen.orientation?.angle ?? 0)) % 360;
    smooth = smooth == null ? h : (smooth + wrap(h - smooth) * 0.2 + 360) % 360; // compass jitters; low-pass it
    const north = -smooth; // where real north is, relative to the top of the phone
    needle.style.display = '';
    needle.setAttribute('transform', `rotate(${north})`);
    const off = wrap(mapNorthDeg - north);
    const aligned = Math.abs(off) < ALIGNED_DEG;
    el.classList.toggle('aligned', aligned);
    hint.textContent = aligned ? 'Map aligned' : `Turn ${off > 0 ? '↺' : '↻'} ${Math.round(Math.abs(off))}°`;
  };

  async function start() {
    if (started) return;
    if (!DOE) { hint.textContent = 'No compass in this browser'; return; }
    // iOS needs a tap-triggered permission request before it will send orientation events.
    if (needsTap) {
      const r = await DOE.requestPermission!().catch(() => 'denied');
      if (r !== 'granted') { hint.textContent = 'Compass not allowed'; return; }
    }
    started = true;
    window.addEventListener(evName, onOrient);
    hint.textContent = 'Hold phone flat…';
    setTimeout(() => { if (!gotHeading) hint.textContent = 'No compass on this device'; }, 3000);
  }

  el.addEventListener('click', start);
  // Android/desktop need no permission, so start right away; iOS waits for the tap.
  if (DOE && !needsTap) start();

  return () => { window.removeEventListener(evName, onOrient); el.remove(); };
}
