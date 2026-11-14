import { deleteMap, listMaps, loadMap, loadWaypoints, persist, saveMap, saveTrail, type MapMeta } from './store';
import { packMap, sendFile } from './share';
import { DEMO_ID, loadDemo } from './demo';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Launched from the home screen (iOS gives it storage separate from the browser).
const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// The map library: every map saved on this device, with its calibration and trail.
export function showMaps(root: HTMLElement, cb: { open(id: string, screen?: 'cal' | 'nav'): void; pick(): void; changed(id: string): void }) {
  let alive = true;

  async function render() {
    const maps = await listMaps();
    if (!alive) return;
    const rows = maps.map((m: MapMeta) => `
      <li data-id="${m.id}">
        <button class="row-open" data-act="open">
          <div class="name">${esc(m.name)}</div>
          <div class="meta">${m.points >= 2 ? `${m.points} points` : 'not calibrated'} · trail ${km(m.trailM)} · ${new Date(m.updated).toLocaleDateString()}</div>
        </button>
        <div class="row-actions">
          <button class="btn" data-act="share" ${m.points >= 2 ? '' : 'disabled'}>Share</button>
          <button class="btn" data-act="rename">Rename</button>
          <button class="btn" data-act="clear" ${m.trailM ? '' : 'disabled'}>Clear trail</button>
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </li>`).join('');
    root.innerHTML = `<div class="maps">
      <button id="pick" class="btn on big">📷 Add a map (photo or PDF)</button>
      ${maps.length ? `<ul>${rows}</ul>` : `<ol>
        <li>Take a photo of a trail map, or pick a photo or PDF</li>
        <li>Match 4–6 spots on it to the satellite view</li>
        <li>Navigate: your GPS dot and trail appear on the map</li>
      </ol>`}
      ${!maps.length && installed ? `<p class="installed-note">You opened You Are Here from your home screen. On iPhone it keeps its own maps,
        separate from your browser. To bring a map over, open the app in your browser, tap <b>Share</b> on the map
        and save the file, then <b>Add a map</b> here and choose that file.</p>` : ''}
      ${maps.some(m => m.id === DEMO_ID) ? '' : `<button id="demo" class="btn demo">🗺 Try the demo map: Peoria, Illinois in 1905</button>`}
      <p class="howto"><a href="#help">How to use this app →</a></p>
      <p class="storage" id="storage"></p>
    </div>`;
    root.querySelector('#pick')!.addEventListener('click', cb.pick);
    root.querySelector('#demo')?.addEventListener('click', async e => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true; b.textContent = 'Loading the demo map…';
      try { await loadDemo(); cb.open(DEMO_ID, 'cal'); }
      catch (err) { b.disabled = false; b.textContent = `Couldn't load the demo (${err}). Tap to retry.`; }
    });
    if (maps.length) {
      const kept = await persist();
      const el = root.querySelector('#storage');
      if (el) el.textContent = kept
        ? 'Maps, calibrations and trails are saved on this device in this browser.'
        : 'Saved on this device in this browser. The browser may clear it if the app goes unused for weeks; use the same browser each time.';
    }
  }

  const onClick = async (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const id = btn?.closest<HTMLElement>('li')?.dataset.id;
    if (!btn || !id) return;
    const act = btn.dataset.act;
    if (act === 'open') return cb.open(id);
    const map = await loadMap(id);
    if (!map) return;
    if (act === 'rename') {
      const name = prompt('Map name', map.name)?.trim();
      if (!name) return;
      await saveMap({ ...map, name });
    } else if (act === 'clear') {
      if (!confirm(`Clear the saved trail for "${map.name}"?`)) return;
      await saveTrail(id, []);
    } else if (act === 'share') {
      // Two taps on purpose: iOS only opens the share sheet straight after a tap, and
      // packing a large map can take longer than that allowance.
      root.querySelector('.sheet')?.remove();
      const el = document.createElement('div');
      el.className = 'sheet';
      el.innerHTML = `<div class="msg">Preparing “${esc(map.name)}”…</div>`;
      root.appendChild(el);
      const wps = await loadWaypoints(id);
      const f = await packMap(map, wps);
      el.innerHTML = `<div class="msg">Send “${esc(map.name)}”</div>
        <div class="sub">${(f.size / 1e6).toFixed(1)} MB · map, calibration${wps.length ? ` and ${wps.length} waypoint${wps.length > 1 ? 's' : ''}` : ''}. Your trail and photos stay on this phone.</div>
        <div class="sub">They open it with <b>Add a map</b> → choose the file (on iPhone, Save to Files first).</div>
        <div class="row"><button class="btn" data-s="cancel">Cancel</button><button class="btn on" data-s="send">Send…</button></div>`;
      el.addEventListener('click', async ev => {
        const a = (ev.target as HTMLElement).dataset.s;
        if (a === 'cancel') el.remove();
        if (a !== 'send') return;
        const r = await sendFile(f);
        if (r === 'cancelled') return;
        el.innerHTML = `<div class="msg">${r === 'shared' ? 'Sent.' : 'Saved as a file. Send it from your Downloads or Files.'}</div>`;
        setTimeout(() => el.remove(), 2500);
      });
      return;
    } else if (act === 'delete') {
      if (!confirm(`Delete "${map.name}", its calibration and its trail?`)) return;
      await deleteMap(id);
    }
    cb.changed(id);
    render();
  };
  // root is the shared view container, so the listener must come off on teardown
  // or each visit to this screen stacks another handler.
  root.addEventListener('click', onClick);

  render();
  return () => { alive = false; root.removeEventListener('click', onClick); };
}
