// ─── SHARED UI HELPERS ──────────────────────────────────────────────────────
const LOCK_THRESHOLD = 99; // % — position is considered locked in

const STAGE_STYLE = {
  0: { bg: '#2a1212', color: '#f87171', label: 'Group Out' },
  1: { bg: '#2a1e10', color: '#fb923c', label: 'R32 Out' },
  2: { bg: '#2a2710', color: '#fbbf24', label: 'R16 Out' },
  3: { bg: '#162810', color: '#86efac', label: 'QF Out' },
  4: { bg: '#0f2a1e', color: '#34d399', label: '4th Place' },
  5: { bg: '#0f2a1e', color: '#34d399', label: '3rd Place' },
  6: { bg: '#0f1f2a', color: '#60a5fa', label: 'Runner-up' },
  7: { bg: '#2a2410', color: '#fcd34d', label: 'Winner' },
};

// ─── HEAT MAP COLOR ─────────────────────────────────────────────────────────
function heatRGB(pct) {
  // 0% → near-black, high% → Detroit Lions blue (#0076B6)
  const t = Math.min(pct / 40, 1); // saturate at 40%
  return [
    Math.round(5  + t * (0   - 5)),
    Math.round(5  + t * (118 - 5)),
    Math.round(15 + t * (182 - 15)),
  ];
}

function heatColor(pct) {
  const [r, g, b] = heatRGB(pct);
  const t = Math.min(pct / 40, 1);
  const textOpacity = pct < 0.5 ? 0.25 : (0.4 + t * 0.6);
  return {
    bg: `rgb(${r},${g},${b})`,
    text: `rgba(255,255,255,${textOpacity})`
  };
}

function shadeRGB(r, g, b, f, add = 0) {
  const c = v => Math.max(0, Math.min(255, Math.round(v * f + add)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function flagImg(country) {
  const url = flagUrl(country);
  return url ? `<img class="flag-img" src="${url}" alt="${country}" title="${country}" loading="lazy">` : '';
}

function teamLogoImg(fantasyTeam) {
  const src = `assets/teams/${encodeURIComponent(fantasyTeam)}.png`;
  return `<img class="team-logo" src="${src}" alt="${fantasyTeam}" onerror="this.style.display='none';this.nextSibling.style.display='inline-block'"><span class="team-logo-placeholder" style="display:none"></span>`;
}

// Picks already decided (one team ≥ LOCK_THRESHOLD at its best slot). Shared
// by the heat grid and the 3D surface, which both pull these rows/columns out
// of the matrix and list them separately.
function computeLockedPicks(probs) {
  const entries = [];
  Object.keys(FANTASY_TEAMS).forEach(team => {
    const row = probs[team];
    let best = 0;
    for (let i = 1; i < 16; i++) if (row[i] > row[best]) best = i;
    if (row[best] >= LOCK_THRESHOLD) entries.push({ team, pick: best });
  });
  return entries.sort((a, b) => a.pick - b.pick);
}

function sortTeams(fantasyTeams, probs, sortCol, adp) {
  return [...fantasyTeams].sort((a, b) => {
    if (sortCol !== null) {
      return currentSortDir === 'asc'
        ? probs[a][sortCol] - probs[b][sortCol]
        : probs[b][sortCol] - probs[a][sortCol];
    }
    // Default: follow active banner mode
    if (orderBannerMode === 'adp' && adp) {
      return (adp[a] ?? 99) - (adp[b] ?? 99);
    }
    const bestPickA = probs[a].indexOf(Math.max(...probs[a]));
    const bestPickB = probs[b].indexOf(Math.max(...probs[b]));
    return bestPickA - bestPickB;
  });
}

// ─── TOOLTIP ────────────────────────────────────────────────────────────────
function showTooltip(html, x, y) {
  const tip = document.getElementById('tooltip');
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  moveTooltip(x, y);
}

function moveTooltip(x, y) {
  const tip = document.getElementById('tooltip');
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8)  left = x - w - pad;
  if (top  + h > window.innerHeight - 8) top  = y - h - pad;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top  = `${Math.max(4, top)}px`;
}

function hideTooltip() {
  document.getElementById('tooltip').classList.add('hidden');
}

// Touch devices: mouseover tooltips have no natural mouseout, so dismiss on
// scroll or on tapping anything that isn't a chip/cell.
window.addEventListener('scroll', hideTooltip, { passive: true });
document.addEventListener('touchstart', e => {
  if (!e.target.closest('.chip, .sbar, .stile')) hideTooltip();
}, { passive: true });

// ─── DRAFT WIRE TICKER ──────────────────────────────────────────────────────
function renderTicker(probs, adp) {
  const teams = Object.keys(adp).sort((a, b) => adp[a] - adp[b]);
  const items = teams.map(t => {
    const best = probs[t].indexOf(Math.max(...probs[t]));
    const pct = probs[t][best];
    const locked = pct >= LOCK_THRESHOLD;
    return locked
      ? `<span class="tk-item tk-lock">🔒 <b>${t}</b> LOCKED AT PICK ${best + 1}</span>`
      : `<span class="tk-item"><b>${t}</b> ADP ${adp[t].toFixed(1)} · MOST LIKELY PICK ${best + 1} <em>${pct.toFixed(0)}%</em></span>`;
  });
  const copy = items.join('<span class="tk-sep">◆</span>') + '<span class="tk-sep">◆</span>';
  document.getElementById('ticker-inner').innerHTML =
    `<div class="tk-copy">${copy}</div><div class="tk-copy" aria-hidden="true">${copy}</div>`;
}

// ─── MATCH CENTER (results ±24h, live, upcoming) ────────────────────────────
function renderMatchCenter(state) {
  const el = document.getElementById('mc-scroll');
  if (!el) return;
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const today = new Date(now).toDateString();
  const fx = state?.fixtures || [];

  const isLive = f => f.state === 'in';
  const isRecent = f => (f.state === 'post' || f.done) && f.kickoff && f.kickoff >= now - dayMs && f.kickoff <= now;
  const isUpcoming = f => f.state !== 'post' && !f.done && f.state !== 'in' && f.kickoff && f.kickoff >= now && f.kickoff <= now + dayMs;

  const doneChip = f => `<span class="mc-match mc-done">${flagImg(f.home)}<span>${f.home} <strong>${f.hs}–${f.as}</strong> ${f.away}</span>${flagImg(f.away)}<span class="mc-time mc-ft">${f.clock || 'FT'}</span></span>`;
  const liveChip = f => `<span class="mc-match mc-live">${flagImg(f.home)}<span>${f.home} <strong>${f.hs}–${f.as}</strong> ${f.away}</span>${flagImg(f.away)}<span class="mc-time mc-clock">${f.clock || 'LIVE'}</span></span>`;
  const upChip = f => {
    const d = new Date(f.kickoff);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = d.toDateString() === today ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ';
    return `<span class="mc-match">${flagImg(f.home)}<span>${f.home} v ${f.away}</span>${flagImg(f.away)}<span class="mc-time">${day}${t}</span></span>`;
  };

  const past = fx.filter(f => isLive(f) || isRecent(f)).sort((a, b) => a.kickoff - b.kickoff);
  const next = fx.filter(isUpcoming).sort((a, b) => a.kickoff - b.kickoff);

  const groupHtml = (label, chips) =>
    `<span class="mc-group"><span class="mc-label">${label}</span>${chips}</span>`;

  const groups = [];
  if (past.length) {
    const label = past.some(isLive) ? 'LIVE &amp; RESULTS' : 'RESULTS';
    groups.push(groupHtml(label, past.map(f => isLive(f) ? liveChip(f) : doneChip(f)).join('')));
  }
  if (next.length) groups.push(groupHtml('UPCOMING', next.map(upChip).join('')));

  el.innerHTML = groups.join('<span class="mc-sep"></span>');
  document.querySelector('.match-center').classList.toggle('hidden', groups.length === 0);
}

// ─── CHIP SCORECARDS ────────────────────────────────────────────────────────
// Scorecard rows in display order, each mapped to the STAGE enum value bucketed
// into it. A row collects the FLAGS of this fantasy team's WC teams that belong
// there: settled teams (solid) sit in the stage they finished at; live teams
// (pulsing) sit in the guaranteed-FLOOR stage of the round they're currently in.
// (There's no 'SF' row: live semifinalists fall into the '4th' floor and settled
// semifinal losers finish 3rd/4th via the third-place match.)
const SCORE_STAGES = [
  ['1st', STAGE.WINNER], ['2nd', STAGE.RUNNER_UP], ['3rd', STAGE.SF_WON_3RD], ['4th', STAGE.SF_LOST_3RD],
  ['QF', STAGE.QF_ELIMINATED], ['R16', STAGE.R16_ELIMINATED], ['R32', STAGE.R32_ELIMINATED],
  ['G', STAGE.GROUP_ELIMINATED],
];

function scFlag(wc, live) {
  const url = flagUrl(wc);
  const cls = `sc-flag${live ? ' sc-flag-live' : ''}`;
  const title = `${wc}${live ? ' · still in' : ''}`;
  return url
    ? `<img class="${cls}" src="${url}" alt="${wc}" title="${title}">`
    : `<span class="${cls} sc-flag-ph" title="${title}">${wc.slice(0, 2)}</span>`;
}

function scorecardHtml(team) {
  if (!lastState) return '';
  const wcTeamStage = lastWcTeamStage || computeWcTeamStage(lastState);
  const current = computeWcCurrentStages(lastState, wcTeamStage);

  let gf = 0, ga = 0;
  const byStage = {}; // STAGE value -> [{ wc, live }]
  for (const wc of FANTASY_TEAMS[team]) {
    const { stage, live } = current[wc];
    (byStage[stage] = byStage[stage] || []).push({ wc, live });
    gf += lastState.allTeamStats[wc]?.gf || 0;
    ga += lastState.allTeamStats[wc]?.ga || 0;
  }

  const rows = SCORE_STAGES.map(([label, stage]) => {
    const teams = byStage[stage];
    const empty = !teams;
    const flags = empty
      ? '<span class="sv">-</span>'
      : teams
          .sort((a, b) => a.live - b.live) // settled (solid) before live (pulsing)
          .map(({ wc, live }) => scFlag(wc, live))
          .join('');
    return `<div class="score-row${empty ? ' score-zero' : ''}"><span class="sc-label">${label}</span><span class="sc-flags">${flags}</span></div>`;
  }).join('');

  return `<div class="score-card">
    ${rows}
    <div class="score-div"></div>
    <div class="score-row score-goals"><span>GF</span><span class="sv">${gf}</span></div>
    <div class="score-row score-goals"><span>GA</span><span class="sv">${ga}</span></div>
  </div>`;
}

// ─── STUDIO HIGHLIGHT REEL (looping GIF screens) ────────────────────────────
// All clips are international-match footage (World Cup). Screens rotate through
// their playlist on staggered timers so the three cuts never sync up.
const REEL_PLAYLISTS = [
  [ // main wall — match action
    'https://media.tenor.com/mFtGVvuLE_QAAAAC/messi-handball.gif',            // ARG, Lusail Stadium
    'https://media.tenor.com/vheitc5jPu0AAAAC/harry-kane-world-cup.gif',      // ENG, Kane
    'https://media.tenor.com/f8uC2RxybhsAAAAC/casemiro-casemito.gif',         // BRA v SUI
    'https://media.tenor.com/Y51B2DuPGOoAAAAC/kylian-mbappe-france.gif',      // FRA, Mbappé
  ],
  [ // left screen — keepers & defence
    'https://media.tenor.com/pvffauawiTAAAAAC/jordan-pickford-england.gif',   // ENG, Pickford save
    'https://media.tenor.com/2kQAgzNfeiwAAAAC/martinez-emi-martinez.gif',     // ARG, E. Martínez
    'https://media.tenor.com/yjo111WpFOIAAAAC/jordan-pickford-england.gif',   // ENG, Pickford
    'https://media.tenor.com/_BDMRKu_V5IAAAAC/brazil-world-cup.gif',          // BRA
  ],
  [ // right screen — goals & celebrations
    'https://media.tenor.com/3WwK71Rb5isAAAAC/argentina-goal.gif',                     // ARG goal
    'https://media.tenor.com/kQLg3831ZdMAAAAC/lautaro-martinez-world-cup-2026.gif',    // ARG, WC 2026
    'https://media.tenor.com/WpEEy0E2va4AAAAC/mbappe-celebration-poland.gif',          // FRA v POL
    'https://media.tenor.com/sc_wEdJB-MYAAAAC/zakaria-aboukhlal.gif',                  // MAR
    'https://media.tenor.com/bUFyQ4NVyNsAAAAC/england-world-cup.gif',                  // ENG
  ],
];

function initHighlightReel() {
  document.querySelectorAll('.video-screen').forEach((screen, si) => {
    const list = REEL_PLAYLISTS[si] || [];
    const img = screen.querySelector('.screen-gif');
    if (!img || !list.length) return;
    let idx = 0;
    img.src = list[0];
    const advance = () => {
      idx = (idx + 1) % list.length;
      const url = list[idx];
      const next = new Image();      // preload off-screen so the cut is clean
      next.onload = () => {
        img.style.opacity = '0';
        setTimeout(() => {
          img.src = url;
          img.style.opacity = '1';
          screen.classList.remove('screen-dead');
        }, 260);
      };
      // On a dead link just wait for the next cycle and try the following clip.
      next.src = url;
    };
    setInterval(advance, 14000 + si * 3500); // staggered cadence per screen
  });
}

// ─── 3D DRAFT STAGE (domino-chip coverflow carousel) ────────────────────────
let carPos = 0;      // current focus position (float while dragging/animating)
let carCount = 0;
let carRaf = null;

function carouselSpacing() {
  const w = window.innerWidth;
  return w <= 760 ? Math.max(92, Math.min(120, w * 0.3)) : 158;
}

function layoutCarousel() {
  const slides = document.querySelectorAll('#stage-world .chip-slide');
  if (!slides.length) return;
  const S = carouselSpacing();
  const focus = Math.round(Math.max(0, Math.min(carCount - 1, carPos)));
  slides.forEach((el, i) => {
    const d = i - carPos;
    const abs = Math.abs(d);
    const a = Math.max(-1, Math.min(1, d));           // rotation saturates one slot out
    // Shallow arc: outer chips drift only slightly behind the focused one,
    // with a gentle inward turn — more shelf than horseshoe.
    const tx = d * S * (1 - Math.min(abs, 5) * 0.03);
    const tz = (abs < 1 ? (1 - abs) * 90 : 0) - Math.min(abs, 5) * 30;
    const ry = -a * 34;
    const sc = 1 - Math.min(abs * 0.04, 0.18);
    el.style.transform = `translateX(${tx.toFixed(1)}px) translateZ(${tz.toFixed(1)}px) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    el.style.zIndex = String(100 - Math.round(abs * 10));
    el.classList.toggle('is-focused', i === focus);
  });
}

function cancelCarAnim() {
  if (carRaf) cancelAnimationFrame(carRaf);
  carRaf = null;
}

function animateCarouselTo(idx) {
  cancelCarAnim();
  const from = carPos;
  const to = Math.max(0, Math.min(carCount - 1, idx));
  const t0 = performance.now(), dur = 420;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    carPos = from + (to - from) * e;
    layoutCarousel();
    carRaf = k < 1 ? requestAnimationFrame(step) : null;
  };
  carRaf = requestAnimationFrame(step);
}

function initCarousel() {
  const stage = document.querySelector('.stage');
  let dragging = false, moved = false, lastX = 0, downSlide = null, lastPointerUpAt = 0;

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.car-btn')) return; // buttons handle their own clicks
    dragging = true; moved = false; lastX = e.clientX;
    // Remember the pressed slide now: pointer capture retargets later events
    // (including the derived click) at `stage`, so a click handler never sees it.
    downSlide = e.target.closest('.chip-slide');
    try { stage.setPointerCapture(e.pointerId); } catch {} // synthetic events have no active pointer
    stage.classList.add('dragging');
    cancelCarAnim();
  });
  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    if (Math.abs(dx) > 3) { moved = true; hideTooltip(); }
    lastX = e.clientX;
    // Rubber-band slightly past the ends so the edges feel physical.
    carPos = Math.max(-0.35, Math.min(carCount - 0.65, carPos - dx / carouselSpacing()));
    layoutCarousel();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    lastPointerUpAt = performance.now();
    stage.classList.remove('dragging');
    if (moved) {
      animateCarouselTo(Math.round(carPos));            // drag: snap to nearest
    } else if (downSlide) {
      animateCarouselTo(parseInt(downSlide.dataset.i)); // tap/click: centre that chip
    }
    downSlide = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Fallback for synthetic clicks (keyboard activation, tests): real pointer
  // sequences are handled in pointerup above and skipped here by the timestamp.
  stage.addEventListener('click', e => {
    if (performance.now() - lastPointerUpAt < 300) return;
    const slide = e.target.closest('.chip-slide');
    if (slide) animateCarouselTo(parseInt(slide.dataset.i));
  });

  document.getElementById('car-prev').addEventListener('click', () => animateCarouselTo(Math.round(carPos) - 1));
  document.getElementById('car-next').addEventListener('click', () => animateCarouselTo(Math.round(carPos) + 1));

  // Wheel / trackpad: scroll through the chips without click-dragging. The
  // dominant axis drives so trackpad horizontal swipes and mouse wheels both
  // work; snaps to the nearest chip once the gesture goes idle.
  let wheelSnapTimer = null;
  stage.addEventListener('wheel', e => {
    if (!carCount) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    e.preventDefault();
    cancelCarAnim();
    hideTooltip();
    const px = delta * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? window.innerHeight : 1);
    carPos = Math.max(-0.35, Math.min(carCount - 0.65, carPos + px / carouselSpacing()));
    layoutCarousel();
    clearTimeout(wheelSnapTimer);
    wheelSnapTimer = setTimeout(() => animateCarouselTo(Math.round(carPos)), 140);
  }, { passive: false });
}

function chipSlideHtml(entry, i) {
  const src = `assets/teams/${encodeURIComponent(entry.team)}.png`;
  const status = [entry.locked ? 'LOCKED' : '', entry.soon ? 'NEXT 24H' : ''].filter(Boolean).join(' · ');
  const delay = ((i * 0.53) % 2.6).toFixed(2);
  return `<div class="chip-slide" data-i="${i}">
    <div class="chip-float" style="animation-delay:-${delay}s">
      <div class="chip3d${entry.locked ? ' locked3d' : ''}">
        <div class="chip-edge edge-l"></div><div class="chip-edge edge-r"></div>
        <div class="chip-edge edge-t"></div><div class="chip-edge edge-b"></div>
        <div class="chip-back"></div>
        <div class="chip${entry.locked ? ' locked' : ''}${entry.soon ? ' chip-soon' : ''}" data-team="${entry.team}">
          <div class="chip-tag">${entry.tag}</div>
          <div class="chip-logo-ring"><img src="${src}" alt="${entry.team}" onerror="this.style.visibility='hidden'"></div>
          <div class="chip-name">${entry.team}</div>
          <div class="chip-status">${status}</div>
          ${scorecardHtml(entry.team)}
        </div>
      </div>
    </div>
    <div class="chip-shadow"></div>
  </div>`;
}

function renderStage(topOrders, probs, adp) {
  const isAdp = orderBannerMode === 'adp';

  document.getElementById('stage-title').textContent = isAdp ? 'Average Draft Position' : 'Most Common Draft Order';
  const pctEl = document.getElementById('stage-pct');
  const top10Btn = document.getElementById('top10-btn');
  if (isAdp) {
    pctEl.textContent = '';
    top10Btn.classList.add('hidden');
    document.getElementById('dd-full').classList.add('hidden');
  } else {
    pctEl.textContent = `${topOrders[0].pct.toFixed(2)}% LIKELY`;
    top10Btn.classList.remove('hidden');
  }
  document.getElementById('tab-adp').classList.toggle('seg-active', isAdp);
  document.getElementById('tab-likely').classList.toggle('seg-active', !isAdp);

  // A fantasy team chip is flagged when any of its 3 WC teams plays within 24h.
  const soon = teamsPlayingSoon(lastState);
  const playingSoon = team => (FANTASY_TEAMS[team] || []).some(t => soon.has(t));

  let entries;
  if (isAdp) {
    entries = Object.keys(adp).sort((a, b) => adp[a] - adp[b]).map(team => ({
      team,
      tag: adp[team].toFixed(1),
      locked: probs && Math.max(...(probs[team] || [0])) >= LOCK_THRESHOLD,
      soon: playingSoon(team),
    }));
  } else {
    entries = topOrders[0].order.map((team, i) => ({
      team,
      tag: String(i + 1),
      locked: probs && (probs[team]?.[i] ?? 0) >= LOCK_THRESHOLD,
      soon: playingSoon(team),
    }));
  }

  const world = document.getElementById('stage-world');
  const sameCount = carCount === entries.length;
  world.innerHTML = `<div class="carousel">${entries.map((e, i) => chipSlideHtml(e, i)).join('')}</div>`;
  carCount = entries.length;
  // Keep the current focus across data refreshes; start centred on the middle
  // of the draft order when the set (or mode) first renders.
  cancelCarAnim();
  carPos = sameCount
    ? Math.max(0, Math.min(carCount - 1, Math.round(carPos)))
    : Math.floor((carCount - 1) / 2);
  layoutCarousel();
}

function chipTooltipHtml(team) {
  const adpVal = lastAdp?.[team];
  const p = lastProbs?.[team] || [];
  const sd = adpVal !== undefined && p.length ? pickStdDev(p, adpVal) : 0;
  const best = p.indexOf(Math.max(...p));
  const wcTeams = FANTASY_TEAMS[team] || [];
  const wcTeamStage = lastWcTeamStage || {};
  const countries = wcTeams.map(wc => {
    const s = wcTeamStage[wc];
    const label = s !== undefined ? STAGE_LABEL[s] : 'Still in';
    const gf = lastState?.allTeamStats?.[wc]?.gf ?? 0;
    const ga = lastState?.allTeamStats?.[wc]?.ga ?? 0;
    return `<div class="tt-country">${flagImg(wc)} ${wc} <span class="tt-goals">${gf}-${ga}</span><span class="tt-stage">${label}</span></div>`;
  }).join('');
  return `<div class="tt-title">${team}</div>
    <div class="tt-line">ADP <b>${adpVal?.toFixed(2) ?? '—'}</b> ± ${sd.toFixed(2)}</div>
    <div class="tt-line">Most likely: <b>Pick ${best + 1}</b> (${(p[best] ?? 0).toFixed(1)}%)</div>
    ${countries}`;
}

function bindStageTooltips() {
  // Bound on .stage: the stage-world plane is pointer-transparent (see styles.css).
  const stage = document.querySelector('.stage');
  stage.addEventListener('mouseover', e => {
    const chip = e.target.closest('.chip');
    if (chip) showTooltip(chipTooltipHtml(chip.dataset.team), e.clientX, e.clientY);
  });
  stage.addEventListener('mousemove', e => {
    if (e.target.closest('.chip')) moveTooltip(e.clientX, e.clientY);
  });
  stage.addEventListener('mouseout', e => {
    if (e.target.closest('.chip')) hideTooltip();
  });
}

// ─── TOP 10 ORDERINGS PANEL ─────────────────────────────────────────────────
function renderTop10(topOrders) {
  const total = topOrders.reduce((s, o) => s + o.pct, 0).toFixed(1);
  const rows = topOrders.map((o, i) => {
    const picks = o.order.map((t, j) => `<span class="dd-pick"><b>${j + 1}</b>${t}</span>`).join('');
    return `<div class="dd-row ${i === 0 ? 'dd-row-top' : ''}">
      <span class="dd-rank">#${i + 1}</span>
      <span class="dd-pct">${o.pct.toFixed(2)}%</span>
      <div class="dd-teams">${picks}</div>
    </div>`;
  }).join('');
  document.getElementById('dd-full').innerHTML = `
    <div class="dd-header">TOP 10 MOST LIKELY ORDERINGS · COMBINED PROBABILITY <strong>${total}%</strong></div>
    ${rows}`;
}

// Orchestrator — kept as the single entry point for banner/stage updates
function renderTopOrders(topOrders, probs, adp) {
  if (!topOrders || !adp) return;
  renderStage(topOrders, probs, adp);
  renderTop10(topOrders);
  renderTicker(probs, adp);
}

// ─── HEAT GRID ──────────────────────────────────────────────────────────────
function renderGrid(probs, currentEstimate, state, sortCol = currentSortCol) {
  const table = document.getElementById('grid');
  table.innerHTML = '';

  const wcTeamStage = computeWcTeamStage(state);
  const finalRanks = computeFinalRanks(state, wcTeamStage);

  // Locked picks leave the matrix: their row and pick column are dropped so
  // the grid only spans still-uncertain slots; they render as a badge strip
  // above the table instead.
  const lockedEntries = computeLockedPicks(probs);
  const lockedTeams = new Set(lockedEntries.map(e => e.team));
  const lockedPicks = new Set(lockedEntries.map(e => e.pick));
  const picks = Array.from({ length: 16 }, (_, i) => i).filter(i => !lockedPicks.has(i));
  renderLockStrip('grid-lockstrip', lockedEntries);

  const fantasyTeams = Object.keys(FANTASY_TEAMS).filter(t => !lockedTeams.has(t));
  const sortedTeams = sortTeams(fantasyTeams, probs, sortCol, lastAdp);

  // Header (pick columns keep their real slot numbers, so gaps = locked picks)
  const hr = document.createElement('tr');
  const cornerTh = `<th class="corner">FANTASY TEAM</th>`;
  const pickThs = picks.map(i => {
    let cls = 'sortable';
    if (sortCol === i) cls += currentSortDir === 'asc' ? ' sort-asc' : ' sort-desc';
    return `<th class="${cls}" data-pick="${i}">P${i + 1}</th>`;
  }).join('');
  hr.innerHTML = cornerTh + pickThs;
  table.appendChild(hr);

  // Column header click → cycle: desc → asc → default
  hr.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = parseInt(th.dataset.pick);
      if (currentSortCol !== col) {
        currentSortCol = col;
        currentSortDir = 'desc';
      } else if (currentSortDir === 'desc') {
        currentSortDir = 'asc';
      } else {
        currentSortCol = null;
        currentSortDir = null;
      }
      if (lastProbs) renderGrid(lastProbs, lastEstimate, lastState, currentSortCol);
      markSurfaceDirty();
    });
  });

  for (const team of sortedTeams) {
    const wcTeams = FANTASY_TEAMS[team];

    // ── Main row ──
    const row = document.createElement('tr');

    const td = document.createElement('td');
    td.className = 'team-name';
    td.innerHTML = `<span class="toggle">▶</span>${teamLogoImg(team)}${team}`;

    // Probability cells
    for (const pick of picks) {
      const pct = probs[team][pick];
      const { bg, text } = heatColor(pct);
      const cell = document.createElement('td');
      cell.className = 'prob-cell';
      cell.style.background = bg;
      cell.style.color = text;
      cell.textContent = `${pct.toFixed(1)}%`;
      cell.title = `${team} → Pick ${pick + 1}: ${pct.toFixed(1)}%`;
      row.appendChild(cell);
    }

    row.insertBefore(td, row.firstChild);
    table.appendChild(row);

    // ── Detail row ──
    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row hidden';

    const detailTd = document.createElement('td');
    detailTd.colSpan = picks.length + 1;

    const inner = document.createElement('div');
    inner.className = 'detail-inner';

    for (const wc of wcTeams) {
      const s = wcTeamStage[wc];
      const settled = s !== undefined;            // out of the tournament (or finished)
      const style = settled ? STAGE_STYLE[s] : { bg: '#1e293b', color: '#64748b', label: 'In Progress' };
      // Eliminated = has a final stage and isn't the tournament winner.
      const eliminated = settled && s !== STAGE.WINNER;
      const gf = state.allTeamStats[wc]?.gf ?? 0;
      const ga = state.allTeamStats[wc]?.ga ?? 0;
      // Eliminated teams show their current overall finish rank instead of the
      // round they exited; the round label moves to a hover tooltip.
      const rank = finalRanks[wc];
      const label = settled && rank ? ordinal(rank) : style.label;
      const title = settled ? `${style.label} · current projected finish` : 'Still in the tournament';

      inner.innerHTML += `
        <div class="detail-team${eliminated ? ' eliminated' : ''}">
          ${flagImg(wc)}
          <span class="detail-team-name">${wc}</span>
          <span class="detail-stage" style="background:${style.bg};color:${style.color}" title="${title}">${label}</span>
          <span class="detail-goals">${gf} GF · ${ga} GA</span>
        </div>`;
    }

    detailTd.appendChild(inner);
    detailRow.appendChild(detailTd);
    table.appendChild(detailRow);

    // Toggle on click
    td.addEventListener('click', () => {
      const isOpen = !detailRow.classList.contains('hidden');
      detailRow.classList.toggle('hidden', isOpen);
      td.classList.toggle('expanded', !isOpen);
    });
  }
}

// Badge strip above the heat grid / 3D surface listing the picks that are
// already decided.
function renderLockStrip(targetId, entries) {
  const strip = document.getElementById(targetId);
  if (!entries.length) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = `<span class="lockstrip-title">🔒 Locked Picks</span>` +
    entries.map(e =>
      `<span class="lockstrip-item">
        <span class="lockrail-pick">P${e.pick + 1}</span>
        ${teamLogoImg(e.team)}<span class="lockrail-team">${e.team}</span>
      </span>`).join('') +
    (entries.length === 16 ? `<span class="lockstrip-done">All 16 picks decided</span>` : '');
  strip.classList.remove('hidden');
}

function buildLegend() {
  const bar = document.getElementById('legend-bar');
  const steps = 20;
  let html = '';
  for (let i = 0; i < steps; i++) {
    const pct = (i / steps) * 40;
    html += `<div style="background:${heatColor(pct).bg}"></div>`;
  }
  bar.innerHTML = html;
}

// ─── SIM COST TRACKER ───────────────────────────────────────────────────────
const TROLL_LINES = [
  'you monster',
  'worth it?',
  'rip atmosphere',
  'polar bears felt that',
  'Al Gore is crying',
  'nice going, champ',
  'the ice caps know',
  'earth says ouch',
  'climate criminal',
  'greta is watching',
];

function calcSimCO2(durationMs) {
  // Assumes ~15W CPU draw during heavy JS, US grid at 386 gCO2/kWh
  const energyKwh = (durationMs / 1000) * 15 / 3_600_000;
  return energyKwh * 386 * 1e6; // micrograms
}

function renderSimCost() {
  const el = document.getElementById('sim-cost');
  if (!el) return;
  if (lastSimCO2ug === null) {
    el.innerHTML = `<span class="sim-cost-label">SIM COST</span><span class="sim-cost-val">—</span>`;
    return;
  }
  let val, unit;
  if (lastSimCO2ug < 1000) { val = lastSimCO2ug.toFixed(1); unit = 'μg CO₂'; }
  else { val = (lastSimCO2ug / 1000).toFixed(2); unit = 'mg CO₂'; }
  const troll = TROLL_LINES[Math.floor(Math.random() * TROLL_LINES.length)];
  el.innerHTML = `
    <span class="sim-cost-label">PER REFRESH</span>
    <span class="sim-cost-val">${val}</span>
    <span class="sim-cost-unit">${unit}</span>
    <span class="sim-cost-troll">${troll}</span>
    <span class="sim-cost-disclaimer">*nothing compared to CO₂ emitted by agents creating this product</span>`;
}
