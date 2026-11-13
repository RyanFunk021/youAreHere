// Instructions screen. The prose lives in public/instructions.md (edit that, not this),
// rendered here so the page and its Markdown source can't drift apart.
// Screenshots are in public/help/ and use a synthetic example map.
export function showHelp(root: HTMLElement) {
  root.innerHTML = `<div class="help"><p class="loading">Loading instructions…</p></div>`;
  const box = root.querySelector<HTMLElement>('.help')!;
  let alive = true;
  Promise.all([
    import('marked'),
    fetch('instructions.md').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
  ]).then(([{ marked }, md]) => {
    if (!alive) return;
    box.innerHTML = marked.parse(md, { async: false }) as string; // our own trusted Markdown
    box.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; });
  }).catch(e => {
    if (alive) box.textContent = `Couldn't load the instructions (${e}). They need a connection the first time.`;
  });
  return () => { alive = false; };
}
