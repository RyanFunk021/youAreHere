import { deleteMap, listMaps, loadMap, persist, saveMap, saveTrail, type MapMeta } from './store';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// The map library: every map saved on this device, with its calibration and trail.
export function showMaps(root: HTMLElement, cb: { open(id: string): void; pick(): void; changed(id: string): void }) {
  let alive = true;

  async function render() {
    const maps = await listMaps();
    if (!alive) return;
    const rows = maps.map((m: MapMeta) => `
      <li data-id="${m.id}">
        <button class="row-open" data-act="open">
          <div class="name">${esc(m.name)}</div>
          <div class="meta">${m.points >= 3 ? `${m.points} points` : 'not calibrated'} · trail ${km(m.trailM)} · ${new Date(m.updated).toLocaleDateString()}</div>
        </button>
        <div class="row-actions">
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
      <p class="storage" id="storage"></p>
    </div>`;
    root.querySelector('#pick')!.addEventListener('click', cb.pick);
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
