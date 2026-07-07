// ─── 3D PROBABILITY SURFACE ─────────────────────────────────────────────────
// The 16×16 joint distribution P(fantasy team, pick) rendered as a CSS-3D bar
// field: the floor is the heat map, bars rise for every cell above ~1%.

const SURF = {
  cell: 34,          // px per grid cell
  maxH: 170,         // px height of a 100% bar
  minBarPct: 1.2,    // below this, render as a flat floor tile only
  rx0: 58, rz0: -32, // default camera
};

let surfRx = SURF.rx0;
let surfRz = SURF.rz0;
let surfScale = 1;
let surfaceDirty = true;

function markSurfaceDirty() {
  surfaceDirty = true;
  const wrapper = document.getElementById('surface-wrapper');
  if (!wrapper.classList.contains('hidden') && lastProbs) {
    renderSurface(lastProbs, currentSortCol);
  }
}

function applySurfaceTransform() {
  const world = document.getElementById('surface-world');
  world.style.transform = `scale(${surfScale}) rotateX(${surfRx}deg) rotateZ(${surfRz}deg)`;
}

function resetSurfaceView() {
  surfRx = SURF.rx0;
  surfRz = SURF.rz0;
  surfScale = window.innerWidth <= 760 ? 0.55 : 0.85;
  applySurfaceTransform();
}

// Blend the heat color toward green (probability gained since kickoff) or red
// (lost) while a live game is folded into the numbers. Intensity saturates at
// ±8pp so a 1–2pp wobble stays subtle and a big swing is unmissable.
function surfDeltaTint(r, g, b, d) {
  if (!d || Math.abs(d) < 0.5) return [r, g, b];
  const tgt = d > 0 ? [52, 211, 153] : [248, 113, 113];
  const w = Math.min(Math.abs(d) / 8, 1) * 0.8;
  return [Math.round(r + (tgt[0] - r) * w), Math.round(g + (tgt[1] - g) * w), Math.round(b + (tgt[2] - b) * w)];
}

function renderSurface(probs, sortCol) {
  const world = document.getElementById('surface-world');
  const allTeams = sortTeams(Object.keys(FANTASY_TEAMS), probs, sortCol, lastAdp);
  const deltas = typeof lastProbsDelta !== 'undefined' ? lastProbsDelta : null;

  // Locked picks leave the 3D field: they render as a badge strip above the
  // viewport, and both their row and their pick column are dropped so the
  // surface only spans the still-uncertain space.
  const lockedEntries = computeLockedPicks(probs);
  const lockedTeams = new Set(lockedEntries.map(e => e.team));
  const lockedPicks = new Set(lockedEntries.map(e => e.pick));
  const teams = allTeams.filter(t => !lockedTeams.has(t));
  const picks = Array.from({ length: 16 }, (_, i) => i).filter(i => !lockedPicks.has(i));
  renderLockStrip('surface-lockstrip', lockedEntries);

  const C = SURF.cell;
  const width = Math.max(picks.length, 1) * C;
  const depth = Math.max(teams.length, 1) * C;
  world.style.width = `${width}px`;
  world.style.height = `${depth}px`;
  world.style.marginLeft = `${-width / 2}px`;
  world.style.marginTop = `${-depth / 2}px`;

  let html = '';

  // Floor heat tiles (every remaining cell — the floor IS the heat map)
  teams.forEach((team, zi) => {
    picks.forEach((xi, xp) => {
      const pct = probs[team][xi];
      const d = deltas?.[team]?.[xi] ?? 0;
      const [r, g, b] = surfDeltaTint(...heatRGB(pct), d);
      html += `<div class="stile" data-team="${team}" data-pick="${xi}" data-pct="${pct}"${deltas ? ` data-delta="${d.toFixed(1)}"` : ''}
        style="left:${xp * C}px;top:${zi * C}px;width:${C}px;height:${C}px;background:${shadeRGB(r, g, b, 1, 14)}"></div>`;
    });
  });

  // Bars for cells above threshold. While a live game is folded in, bars are
  // STACKED: blue up to the pre-kickoff probability, a solid green extension
  // for probability gained since kickoff, or a translucent red "ghost" cap
  // standing where lost probability used to be.
  teams.forEach((team, zi) => {
    picks.forEach((xi, xp) => {
      const pct = probs[team][xi];
      const d = deltas?.[team]?.[xi] ?? 0;
      const base = pct - d; // pre-kickoff probability
      if (Math.max(pct, base) < SURF.minBarPct) return;
      const h = Math.round((pct / 100) * SURF.maxH);
      const hBase = Math.round((base / 100) * SURF.maxH);
      const seg = deltas && Math.abs(d) >= 1 ? (d > 0 ? 'gain' : 'loss') : null;
      const blueH = seg ? Math.min(h, hBase) : h;
      const segH = seg ? Math.abs(h - hBase) : 0;

      const [r, g, b] = heatRGB(Math.max(pct, 6)); // keep small bars visibly blue
      const top   = shadeRGB(r, g, b, 1.15, 55);
      const faceA = shadeRGB(r, g, b, 1.0, 26);
      const faceB = shadeRGB(r, g, b, 0.62, 12);
      const inset = 4; // gap so bars read as separate towers
      const bw = C - inset * 2;
      html += `<div class="sbar" data-team="${team}" data-pick="${xi}" data-pct="${pct}"${deltas ? ` data-delta="${d.toFixed(1)}" data-base="${base.toFixed(1)}"` : ''}
        style="left:${xp * C + inset}px;top:${zi * C + inset}px;width:${bw}px;height:${bw}px">
        <div class="sf sf-top" style="transform:translateZ(${blueH}px);background:${top}"></div>
        <div class="sf sf-n" style="width:${bw}px;height:${blueH}px;background:${faceA}"></div>
        <div class="sf sf-s" style="width:${bw}px;height:${blueH}px;top:${bw}px;background:${faceA}"></div>
        <div class="sf sf-w" style="width:${blueH}px;height:${bw}px;background:${faceB}"></div>
        <div class="sf sf-e" style="width:${blueH}px;height:${bw}px;left:${bw}px;background:${faceB}"></div>`;
      if (seg) {
        const [sr, sg, sb] = seg === 'gain' ? [52, 211, 153] : [248, 113, 113];
        const sTop = shadeRGB(sr, sg, sb, 1.1, 40);
        const sA = shadeRGB(sr, sg, sb, 0.95, 10);
        const sB = shadeRGB(sr, sg, sb, 0.6, 6);
        const op = seg === 'loss' ? 'opacity:.55;' : '';
        html += `
        <div class="sf" style="width:${bw}px;height:${bw}px;transform:translateZ(${blueH + segH}px);background:${sTop};${op}box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)"></div>
        <div class="sf" style="width:${bw}px;height:${segH}px;transform-origin:0 0;transform:translateZ(${blueH}px) rotateX(90deg);background:${sA};${op}"></div>
        <div class="sf" style="width:${bw}px;height:${segH}px;top:${bw}px;transform-origin:0 0;transform:translateZ(${blueH}px) rotateX(90deg);background:${sA};${op}"></div>
        <div class="sf" style="width:${segH}px;height:${bw}px;transform-origin:0 0;transform:translateZ(${blueH}px) rotateY(-90deg);background:${sB};${op}"></div>
        <div class="sf" style="width:${segH}px;height:${bw}px;left:${bw}px;transform-origin:0 0;transform:translateZ(${blueH}px) rotateY(-90deg);background:${sB};${op}"></div>`;
      }
      html += `</div>`;
    });
  });

  // Axis labels — team names along the left edge, pick numbers along the bottom
  // (pick labels keep their real slot numbers, so gaps read as locked picks)
  teams.forEach((team, zi) => {
    html += `<div class="surf-label surf-label-team" style="top:${zi * C}px;height:${C}px;line-height:${C}px">${team}</div>`;
  });
  picks.forEach((xi, xp) => {
    html += `<div class="surf-label surf-label-pick" style="left:${xp * C}px;top:${depth + 6}px;width:${C}px">P${xi + 1}</div>`;
  });

  world.innerHTML = html;
  applySurfaceTransform();
  surfaceDirty = false;
}


// ─── SURFACE INTERACTION (drag rotate, wheel zoom, hover tooltip) ───────────
function initSurfaceInteraction() {
  const viewport = document.getElementById('surface-viewport');
  let dragging = false, moved = false, px = 0, py = 0;

  viewport.addEventListener('pointerdown', e => {
    dragging = true; moved = false;
    px = e.clientX; py = e.clientY;
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('grabbing');
  });
  viewport.addEventListener('pointermove', e => {
    if (!dragging) {
      const cell = e.target.closest('.sbar, .stile');
      if (cell) {
        const pct = parseFloat(cell.dataset.pct);
        let deltaLine = '';
        if (cell.dataset.delta !== undefined) {
          const d = parseFloat(cell.dataset.delta);
          const wasBit = cell.dataset.base !== undefined ? ` (was ${parseFloat(cell.dataset.base).toFixed(1)}%)` : '';
          deltaLine = Math.abs(d) >= 0.05
            ? `<div class="tt-line" style="color:${d > 0 ? '#34d399' : '#f87171'}">${d > 0 ? '▲ +' : '▼ '}${d.toFixed(1)}pp since kickoff${wasBit}</div>`
            : `<div class="tt-line" style="opacity:.6">· unchanged since kickoff</div>`;
        }
        showTooltip(`<div class="tt-title">${cell.dataset.team}</div>
          <div class="tt-line">Pick ${parseInt(cell.dataset.pick) + 1} · <b>${pct.toFixed(1)}%</b></div>${deltaLine}`,
          e.clientX, e.clientY);
      } else {
        hideTooltip();
      }
      return;
    }
    const dx = e.clientX - px, dy = e.clientY - py;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    px = e.clientX; py = e.clientY;
    surfRz += dx * 0.4;
    surfRx = Math.max(14, Math.min(88, surfRx - dy * 0.35));
    applySurfaceTransform();
    hideTooltip();
  });
  const endDrag = () => { dragging = false; viewport.classList.remove('grabbing'); };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('pointerleave', () => { if (!dragging) hideTooltip(); });

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    surfScale = Math.max(0.45, Math.min(1.9, surfScale * (e.deltaY < 0 ? 1.08 : 0.92)));
    applySurfaceTransform();
  }, { passive: false });

  viewport.addEventListener('dblclick', resetSurfaceView);
}
