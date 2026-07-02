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

function renderSurface(probs, sortCol) {
  const world = document.getElementById('surface-world');
  const teams = sortTeams(Object.keys(FANTASY_TEAMS), probs, sortCol, lastAdp);
  const C = SURF.cell;
  const size = 16 * C;
  world.style.width = `${size}px`;
  world.style.height = `${size}px`;
  world.style.marginLeft = `${-size / 2}px`;
  world.style.marginTop = `${-size / 2}px`;

  let html = '';

  // Floor heat tiles (all 256 cells — the floor IS the heat map)
  teams.forEach((team, zi) => {
    for (let xi = 0; xi < 16; xi++) {
      const pct = probs[team][xi];
      const [r, g, b] = heatRGB(pct);
      html += `<div class="stile" data-team="${team}" data-pick="${xi}" data-pct="${pct}"
        style="left:${xi * C}px;top:${zi * C}px;width:${C}px;height:${C}px;background:${shadeRGB(r, g, b, 1, 14)}"></div>`;
    }
  });

  // Bars for cells above threshold
  teams.forEach((team, zi) => {
    for (let xi = 0; xi < 16; xi++) {
      const pct = probs[team][xi];
      if (pct < SURF.minBarPct) continue;
      const h = Math.round((pct / 100) * SURF.maxH);
      const [r, g, b] = heatRGB(Math.max(pct, 6)); // keep small bars visibly blue
      const top   = shadeRGB(r, g, b, 1.15, 55);
      const faceA = shadeRGB(r, g, b, 1.0, 26);
      const faceB = shadeRGB(r, g, b, 0.62, 12);
      const inset = 4; // gap so bars read as separate towers
      const bw = C - inset * 2;
      html += `<div class="sbar" data-team="${team}" data-pick="${xi}" data-pct="${pct}"
        style="left:${xi * C + inset}px;top:${zi * C + inset}px;width:${bw}px;height:${bw}px">
        <div class="sf sf-top" style="transform:translateZ(${h}px);background:${top}"></div>
        <div class="sf sf-n" style="width:${bw}px;height:${h}px;background:${faceA}"></div>
        <div class="sf sf-s" style="width:${bw}px;height:${h}px;top:${bw}px;background:${faceA}"></div>
        <div class="sf sf-w" style="width:${h}px;height:${bw}px;background:${faceB}"></div>
        <div class="sf sf-e" style="width:${h}px;height:${bw}px;left:${bw}px;background:${faceB}"></div>
      </div>`;
    }
  });

  // Axis labels — team names along the left edge, pick numbers along the bottom
  teams.forEach((team, zi) => {
    html += `<div class="surf-label surf-label-team" style="top:${zi * C}px;height:${C}px;line-height:${C}px">${team}</div>`;
  });
  for (let xi = 0; xi < 16; xi++) {
    html += `<div class="surf-label surf-label-pick" style="left:${xi * C}px;top:${size + 6}px;width:${C}px">P${xi + 1}</div>`;
  }

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
        showTooltip(`<div class="tt-title">${cell.dataset.team}</div>
          <div class="tt-line">Pick ${parseInt(cell.dataset.pick) + 1} · <b>${pct.toFixed(1)}%</b></div>`,
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
