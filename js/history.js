// ─── HISTORY TIMELINE (Draft Pick Probability Over Time) ────────────────────
// Consumes window.HISTORY_DATA (set by history-data.js, generated in CI by
// generate-history.js). Each snapshot is a retrospective simulation "as if only
// the first N matches had been played", so every view traces how odds evolved.
//
// Three views (seg-toggle in the section bar):
//   timeline — ADP RACE tab = bump chart of projected draft slot (rank ribbons);
//              P1–P16 tabs = per-pick probability lines. Both get match-swing
//              annotation chips and share the replay scrubber.
//   stream   — per-fantasy-team stacked area of P(pick 1..16) over time
//   spark    — form-guide grid of ADP sparklines, one card per fantasy team
const HISTORY_COLORS = [
  '#0076B6','#4da3d4','#7fbfe0','#1e5a8a','#3b8fc7',
  '#0a4b73','#62a8d6','#9cc7e3','#2b6f9e','#56b0e0',
  '#bcbcbc','#8a8a8a','#5e5e5e','#d4d4d4','#a0a0a0','#727272',
];

const TEAM_LIST = Object.keys(FANTASY_TEAMS);
let historyData = null;
let historyView = 'timeline';   // 'timeline' | 'stream' | 'spark'
let activePickTab = 'adp';      // 'adp' = bump chart, 0–15 = pick index
let activeStreamTeam = null;
let historyChart = null;
let hoverDatasetIdx = null;
let currentSnapByK = new Map();
let currentAnnotations = [];
const teamImages = {};
const flagImages = {};

// Replay scrubber: replayK = matches revealed (null until data loads)
let replayK = null;
let replayMax = 0;
let replayTimer = null;
let fullSeriesData = []; // unsliced per-dataset points, parallel to chart datasets

// Match metadata for annotations/tooltips: prefer the committed list in
// HISTORY_DATA.matches (CI), fall back to the live ESPN fetch from app.js
let liveMatches = null;

function preloadTeamImages() {
  for (const team of TEAM_LIST) {
    const img = new Image();
    img.src = `assets/teams/${encodeURIComponent(team)}.png`;
    teamImages[team] = img;
  }
}

function getFlagImg(country) {
  const url = flagUrl(country);
  if (!url) return null;
  if (!flagImages[url]) {
    const img = new Image();
    img.onload = () => { if (historyChart) historyChart.draw(); };
    img.src = url;
    flagImages[url] = img;
  }
  return flagImages[url];
}

function getMatches() {
  return window.HISTORY_DATA?.matches || liveMatches || [];
}

// Called by app.js after each ESPN fetch — the k-th completed match (sorted by
// date) is what moved snapshot k-1 → k, same ordering as generate-history.js.
function setLiveHistoryMatches(events) {
  const prevCount = liveMatches?.length ?? -1;
  liveMatches = (events || [])
    .filter(e => e.competitions?.[0]?.status?.type?.completed)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(e => {
      const comp = e.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
      const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
      return {
        home: normalize(home?.team?.displayName || '?'),
        away: normalize(away?.team?.displayName || '?'),
        hs: parseInt(home?.score, 10) || 0,
        as: parseInt(away?.score, 10) || 0,
      };
    });
  // Annotations may have rendered before match data existed — refresh once
  if (!window.HISTORY_DATA?.matches && historyData && liveMatches.length !== prevCount) {
    renderHistoryView();
  }
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Rank 1 = best (lowest ADP); returned array is parallel to TEAM_LIST
function snapshotRanks(snap) {
  const order = TEAM_LIST.map((_, i) => i)
    .sort((a, b) => snap.adp[TEAM_LIST[a]] - snap.adp[TEAM_LIST[b]]);
  const ranks = new Array(TEAM_LIST.length);
  order.forEach((teamIdx, pos) => { ranks[teamIdx] = pos + 1; });
  return ranks;
}

// ─── MATCH-SWING ANNOTATIONS ─────────────────────────────────────────────────
// Values of the currently displayed metric for one snapshot (one number per series)
function metricValues(snap) {
  if (historyView === 'stream') return (snap.probs[activeStreamTeam] || []).slice();
  if (activePickTab === 'adp') return snapshotRanks(snap);
  return TEAM_LIST.map(t => snap.probs[t]?.[activePickTab] ?? 0);
}

// The matches that most moved the displayed metric: top swings get a marker
function computeAnnotations() {
  const snaps = historyData.snapshots;
  const matches = getMatches();
  if (!matches.length || snaps.length < 2) return [];
  // bump ranks move in integer steps (a swap = 1); probabilities in % points
  const minDelta = (historyView === 'timeline' && activePickTab === 'adp') ? 1 : 5;
  const swings = [];
  let prev = metricValues(snaps[0]);
  for (let i = 1; i < snaps.length; i++) {
    const cur = metricValues(snaps[i]);
    let d = 0;
    for (let j = 0; j < cur.length; j++) d = Math.max(d, Math.abs((cur[j] ?? 0) - (prev[j] ?? 0)));
    const k = snaps[i].matchesCompleted;
    // Marker sits at k-1 — one match BEFORE the swing — so the pivotal result
    // reads as the cause of the gradient change immediately to its right
    if (matches[k - 1]) swings.push({ k: k - 1, delta: d, match: matches[k - 1] });
    prev = cur;
  }
  return swings
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6)
    .filter(s => s.delta >= minDelta)
    .sort((a, b) => a.k - b.k);
}

// ─── CHART PLUGINS ───────────────────────────────────────────────────────────
// Team logo circles at the rightmost visible point of each line
const teamIconPlugin = {
  id: 'teamIcons',
  afterDatasetsDraw(chart) {
    const { ctx, data } = chart;
    const SIZE = 22;
    data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      const pt = meta.data[meta.data.length - 1];
      if (!pt) return;
      const img = teamImages[ds.label];
      if (!img?.complete || !img.naturalWidth) return;
      const x = pt.x + 6, y = pt.y - SIZE / 2;
      const cx = x + SIZE / 2, cy = y + SIZE / 2;
      ctx.save();
      if (hoverDatasetIdx !== null && hoverDatasetIdx !== i) ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(cx, cy, SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x, y, SIZE, SIZE);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, SIZE / 2, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    });
  },
};

// Match-swing markers (dashed gold line + flag/score chip) and replay playhead
const historyOverlayPlugin = {
  id: 'historyOverlay',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const xs = scales.x;
    if (!xs || !chartArea) return;
    ctx.save();

    const CHIP_W = 56, CHIP_H = 16;
    let lastChipRight = -Infinity;
    let row = 0;
    for (const ann of currentAnnotations) {
      if (replayK !== null && ann.k > replayK) continue;
      const x = xs.getPixelForValue(ann.k);
      if (x < chartArea.left - 1 || x > chartArea.right + 1) continue;

      ctx.strokeStyle = 'rgba(255, 182, 28, 0.32)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top + CHIP_H + 6);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      const m = ann.match;
      let cx = Math.min(Math.max(x - CHIP_W / 2, chartArea.left), chartArea.right - CHIP_W);
      row = (cx < lastChipRight + 6) ? (row + 1) % 2 : 0;
      lastChipRight = cx + CHIP_W;
      const cy = chartArea.top + row * (CHIP_H + 3);

      ctx.fillStyle = 'rgba(8, 13, 22, 0.92)';
      ctx.strokeStyle = 'rgba(255, 182, 28, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cx, cy, CHIP_W, CHIP_H, 4);
      else ctx.rect(cx, cy, CHIP_W, CHIP_H);
      ctx.fill();
      ctx.stroke();

      const fh = getFlagImg(m.home), fa = getFlagImg(m.away);
      if (fh?.complete && fh.naturalWidth) ctx.drawImage(fh, cx + 4, cy + 3.5, 13, 9);
      if (fa?.complete && fa.naturalWidth) ctx.drawImage(fa, cx + CHIP_W - 17, cy + 3.5, 13, 9);
      ctx.fillStyle = '#ffb61c';
      ctx.font = '700 9px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${m.hs}–${m.as}`, cx + CHIP_W / 2, cy + CHIP_H / 2 + 0.5);
    }

    if (replayK !== null && replayK < replayMax) {
      const x = xs.getPixelForValue(replayK);
      if (x >= chartArea.left && x <= chartArea.right) {
        ctx.strokeStyle = 'rgba(33, 175, 252, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(33, 175, 252, 0.8)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};

// ─── TOOLTIP ─────────────────────────────────────────────────────────────────
function flagTag(country) {
  const url = flagUrl(country);
  return url ? `<img class="htt-flag" src="${url}" alt="">` : '';
}

function externalTooltip(context, mode) {
  const el = document.getElementById('history-tooltip');
  const tt = context.tooltip;
  if (tt.opacity === 0) { el.style.opacity = 0; return; }

  const points = (tt.dataPoints || []).slice();
  const k = points[0]?.parsed.x ?? '';
  let html = `<div class="htt-title">After ${k} matches</div>`;

  // The k-th completed match is the one that moved the needle at this x
  const m = getMatches()[k - 1];
  if (m) {
    html += `<div class="htt-match">${flagTag(m.home)}<span>${m.home}</span>` +
      `<b>${m.hs}–${m.as}</b><span>${m.away}</span>${flagTag(m.away)}</div>`;
  }

  if (mode === 'stream') {
    points.sort((a, b) => b.parsed.y - a.parsed.y);
    let rows = 0;
    for (const it of points) {
      if (it.parsed.y < 0.5 || rows >= 9) continue;
      rows++;
      html += `<div class="htt-row"><i class="htt-swatch" style="background:${it.dataset.backgroundColor}"></i>
        <span>Pick ${it.dataset.label.slice(1)}</span><span class="htt-val">${it.parsed.y.toFixed(1)}%</span></div>`;
    }
  } else {
    const isBump = mode === 'bump';
    points.sort((a, b) => isBump ? a.parsed.y - b.parsed.y : b.parsed.y - a.parsed.y);
    const snap = currentSnapByK.get(k);
    for (const it of points) {
      const team = it.dataset.label;
      const src = `assets/teams/${encodeURIComponent(team)}.png`;
      const val = isBump
        ? `#${it.parsed.y}${snap ? ` · ${snap.adp[team].toFixed(2)}` : ''}`
        : it.parsed.y.toFixed(1) + '%';
      html += `<div class="htt-row">
        <img class="htt-logo" src="${src}" alt="" onerror="this.style.visibility='hidden'">
        <span>${team}</span><span class="htt-val">${val}</span></div>`;
    }
  }
  el.innerHTML = html;

  const wrap = context.chart.canvas.parentNode;
  const wrapW = wrap.offsetWidth;
  let left = tt.caretX + 14;
  // Flip to the left of the cursor if it would overflow the container
  if (left + el.offsetWidth > wrapW) left = tt.caretX - el.offsetWidth - 14;
  el.style.left = Math.max(0, left) + 'px';
  el.style.top = Math.max(0, tt.caretY - el.offsetHeight / 2) + 'px';
  el.style.opacity = 1;
}

// ─── VIEW SWITCHING & TAB BARS ───────────────────────────────────────────────
function defaultStreamTeam() {
  const snaps = historyData?.snapshots;
  if (!snaps?.length) return TEAM_LIST[0];
  const last = snaps[snaps.length - 1];
  return TEAM_LIST.slice().sort((a, b) => last.adp[a] - last.adp[b])[0];
}

function setHistoryView(view) {
  historyView = view;
  document.querySelectorAll('#history-view-toggle button').forEach(b =>
    b.classList.toggle('seg-active', b.dataset.hview === view));
  renderHistoryView();
}

function buildTabBar() {
  const container = document.getElementById('history-tabs');
  if (historyView === 'spark') { container.innerHTML = ''; return; }
  if (historyView === 'stream') {
    if (!activeStreamTeam) activeStreamTeam = defaultStreamTeam();
    container.innerHTML = TEAM_LIST.map(t =>
      `<button class="htab htab-team${t === activeStreamTeam ? ' htab-active' : ''}" data-team="${t}">
        <img class="htab-logo" src="assets/teams/${encodeURIComponent(t)}.png" alt="" onerror="this.style.display='none'">${t}</button>`
    ).join('');
  } else {
    let html = `<button class="htab htab-adp${activePickTab === 'adp' ? ' htab-active' : ''}" data-pick="adp">ADP RACE</button>`;
    for (let i = 0; i < 16; i++) {
      html += `<button class="htab${i === activePickTab ? ' htab-active' : ''}" data-pick="${i}">P${i + 1}</button>`;
    }
    container.innerHTML = html;
  }
}

function renderHistoryView() {
  stopReplay();
  const chartWrap = document.getElementById('history-chart-wrap');
  const sparkEl = document.getElementById('history-spark');
  const tabsEl = document.getElementById('history-tabs');
  const replayEl = document.getElementById('history-replay');

  const isSpark = historyView === 'spark' && !!historyData;
  chartWrap.classList.toggle('hidden', isSpark);
  sparkEl.classList.toggle('hidden', !isSpark);
  tabsEl.classList.toggle('hidden', isSpark);
  replayEl.classList.toggle('hidden', isSpark || !historyData);
  buildTabBar();
  if (!historyData) return;
  if (isSpark) renderSparkGrid();
  else renderHistoryChart();
}

// One-time wiring; called from app.js initApp()
function buildHistoryTabs() {
  document.getElementById('history-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.htab');
    if (!btn) return;
    if (btn.dataset.team) activeStreamTeam = btn.dataset.team;
    else activePickTab = btn.dataset.pick === 'adp' ? 'adp' : parseInt(btn.dataset.pick);
    buildTabBar();
    stopReplay();
    renderHistoryChart();
  });

  document.querySelectorAll('#history-view-toggle button').forEach(b =>
    b.addEventListener('click', () => setHistoryView(b.dataset.hview)));

  document.getElementById('replay-slider').addEventListener('input', e => {
    replayK = parseInt(e.target.value);
    applyReplay();
  });
  document.getElementById('replay-btn').addEventListener('click', toggleReplay);

  document.getElementById('history-chart').addEventListener('mouseleave', () => {
    if (hoverDatasetIdx !== null && historyChart) {
      hoverDatasetIdx = null;
      restoreSeriesColors(historyChart);
      historyChart.update('none');
    }
  });

  let sparkResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(sparkResizeTimer);
    sparkResizeTimer = setTimeout(() => {
      if (historyView === 'spark' && historyData) drawSparklines();
    }, 150);
  });

  buildTabBar();
}

// ─── REPLAY SCRUBBER ─────────────────────────────────────────────────────────
function updateReplayUI() {
  const slider = document.getElementById('replay-slider');
  slider.max = replayMax;
  slider.value = replayK;
  document.getElementById('replay-label').textContent =
    replayK >= replayMax ? `ALL ${replayMax} MATCHES` : `AFTER ${replayK} / ${replayMax} MATCHES`;
}

function applyReplay() {
  updateReplayUI();
  if (!historyChart) return;
  historyChart.data.datasets.forEach((ds, i) => {
    ds.data = fullSeriesData[i].filter(p => p.x <= replayK);
  });
  historyChart.update('none');
}

function toggleReplay() {
  if (replayTimer) { stopReplay(); return; }
  if (!historyChart) return;
  if (replayK === null || replayK >= replayMax) replayK = 0;
  const btn = document.getElementById('replay-btn');
  btn.textContent = '❚❚';
  btn.classList.add('replay-playing');
  replayTimer = setInterval(() => {
    replayK = Math.min(replayMax, replayK + 1);
    applyReplay();
    if (replayK >= replayMax) stopReplay();
  }, 130);
}

function stopReplay() {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  const btn = document.getElementById('replay-btn');
  if (btn) {
    btn.textContent = '▶';
    btn.classList.remove('replay-playing');
  }
}

// ─── MAIN CHART (timeline + stream) ──────────────────────────────────────────
function restoreSeriesColors(chart) {
  chart.data.datasets.forEach((ds, i) => {
    ds.borderColor = ds._baseColor || ds.borderColor;
    if (ds._baseWidth) ds.borderWidth = ds._baseWidth;
  });
}

function streamBandColor(pick) {
  // Picks 1–8 descend through blues, 9–16 through greys — early picks pop
  if (pick < 8) return `hsla(203, 88%, ${64 - pick * 4.5}%, 0.9)`;
  return `hsla(215, 12%, ${52 - (pick - 8) * 4}%, 0.9)`;
}

function renderHistoryChart() {
  if (!historyData || typeof Chart === 'undefined' || historyView === 'spark') return;
  const canvas = document.getElementById('history-chart');
  document.getElementById('history-no-data').style.display = 'none';
  canvas.style.display = 'block';

  const snaps = historyData.snapshots;
  currentSnapByK = new Map(snaps.map(s => [s.matchesCompleted, s]));
  replayMax = snaps.length ? snaps[snaps.length - 1].matchesCompleted : 0;
  if (replayK === null || replayK > replayMax) replayK = replayMax;
  hoverDatasetIdx = null;

  const mode = historyView === 'stream' ? 'stream'
    : (activePickTab === 'adp' ? 'bump' : 'prob');

  let datasets, yScale;
  if (mode === 'bump') {
    const rankRows = snaps.map(s => ({ x: s.matchesCompleted, ranks: snapshotRanks(s) }));
    datasets = TEAM_LIST.map((team, i) => ({
      label: team,
      data: rankRows.map(r => ({ x: r.x, y: r.ranks[i] })),
      borderColor: HISTORY_COLORS[i % HISTORY_COLORS.length],
      _baseColor: HISTORY_COLORS[i % HISTORY_COLORS.length],
      _baseWidth: 3.5,
      backgroundColor: 'transparent',
      borderWidth: 3.5,
      borderCapStyle: 'round',
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.35,
    }));
    yScale = {
      reverse: true, min: 0.5, max: 16.5,
      ticks: {
        color: '#666', font: { size: 11 }, stepSize: 1,
        callback: v => Number.isInteger(v) ? '#' + v : '',
      },
      grid: { color: 'rgba(255,255,255,0.05)' },
      title: { display: true, text: 'Projected Draft Slot', color: '#666', font: { size: 11 } },
    };
  } else if (mode === 'stream') {
    if (!activeStreamTeam) activeStreamTeam = defaultStreamTeam();
    datasets = Array.from({ length: 16 }, (_, p) => ({
      label: `P${p + 1}`,
      data: snaps.map(s => ({ x: s.matchesCompleted, y: s.probs[activeStreamTeam]?.[p] ?? 0 })),
      borderColor: 'rgba(4, 6, 11, 0.55)',
      borderWidth: 0.75,
      backgroundColor: streamBandColor(p),
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0.3,
    }));
    yScale = {
      stacked: true, min: 0, max: 100,
      ticks: { color: '#666', font: { size: 11 }, callback: v => v + '%' },
      grid: { color: 'rgba(255,255,255,0.05)' },
      title: { display: true, text: `Where ${activeStreamTeam} lands`, color: '#666', font: { size: 11 } },
    };
  } else {
    datasets = TEAM_LIST.map((team, i) => ({
      label: team,
      data: snaps.map(s => ({ x: s.matchesCompleted, y: s.probs[team]?.[activePickTab] ?? 0 })),
      borderColor: HISTORY_COLORS[i % HISTORY_COLORS.length],
      _baseColor: HISTORY_COLORS[i % HISTORY_COLORS.length],
      _baseWidth: 1.5,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
    }));
    // Bounds from the FULL series so the scale never jumps during replay
    const allVals = snaps.flatMap(s => TEAM_LIST.map(t => s.probs[t]?.[activePickTab] ?? 0));
    const yMax = Math.min(100, Math.ceil((Math.max(...allVals) + 2) / 5) * 5);
    yScale = {
      min: 0, max: yMax,
      ticks: { color: '#666', font: { size: 11 }, callback: v => v + '%' },
      grid: { color: 'rgba(255,255,255,0.05)' },
      title: { display: true, text: 'Probability', color: '#666', font: { size: 11 } },
    };
  }

  currentAnnotations = computeAnnotations();

  if (historyChart) historyChart.destroy();
  historyChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: mode === 'stream' ? 8 : 34 } },
      interaction: { mode: 'index', intersect: false },
      onHover: (evt, _els, chart) => {
        if (mode === 'stream') return;
        const near = chart.getElementsAtEventForMode(evt.native || evt, 'nearest', { intersect: false }, true);
        const idx = near.length ? near[0].datasetIndex : null;
        if (idx === hoverDatasetIdx) return;
        hoverDatasetIdx = idx;
        chart.data.datasets.forEach((ds, i) => {
          ds.borderColor = (idx === null || i === idx) ? ds._baseColor : hexToRgba(ds._baseColor, 0.12);
          ds.borderWidth = (i === idx && mode === 'bump') ? 5 : ds._baseWidth;
        });
        chart.update('none');
      },
      scales: {
        x: {
          type: 'linear',
          min: 0, max: 104,
          ticks: { color: '#666', font: { size: 11 }, stepSize: 8 },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'Matches Completed', color: '#666', font: { size: 11 } },
        },
        y: yScale,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: ctx => externalTooltip(ctx, mode),
        },
      },
    },
    plugins: mode === 'stream'
      ? [historyOverlayPlugin]
      : [teamIconPlugin, historyOverlayPlugin],
  });

  fullSeriesData = datasets.map(ds => ds.data);
  if (replayK < replayMax) applyReplay();
  else updateReplayUI();
}

// ─── SPARK GRID (form guide) ─────────────────────────────────────────────────
function renderSparkGrid() {
  const el = document.getElementById('history-spark');
  const snaps = historyData.snapshots;
  if (!snaps.length) { el.innerHTML = ''; return; }
  const last = snaps[snaps.length - 1];
  // Trend arrow compares against ~10 matches back (recent form, not all-time)
  const then = snaps[Math.max(0, snaps.length - 1 - 10)];
  const teams = TEAM_LIST.slice().sort((a, b) => last.adp[a] - last.adp[b]);

  el.innerHTML = teams.map(t => {
    const d = last.adp[t] - then.adp[t]; // negative = climbing the draft
    const cls = d < -0.05 ? 'up' : d > 0.05 ? 'down' : 'flat';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '—';
    const vals = snaps.map(s => s.adp[t]);
    const lo = Math.min(...vals).toFixed(1), hi = Math.max(...vals).toFixed(1);
    return `<div class="spark-card" data-team="${t}" title="Show pick distribution for ${t}">
      <div class="spark-head">
        <img class="spark-logo" src="assets/teams/${encodeURIComponent(t)}.png" alt="" onerror="this.style.visibility='hidden'">
        <span class="spark-name">${t}</span>
        <span class="spark-delta ${cls}">${arrow}${cls === 'flat' ? '' : ' ' + Math.abs(d).toFixed(1)}</span>
      </div>
      <canvas class="spark-canvas" data-team="${t}"></canvas>
      <div class="spark-foot"><span>ADP <b>${last.adp[t].toFixed(2)}</b></span><span>range ${lo}–${hi}</span></div>
    </div>`;
  }).join('');

  el.querySelectorAll('.spark-card').forEach(card =>
    card.addEventListener('click', () => {
      activeStreamTeam = card.dataset.team;
      setHistoryView('stream');
    }));

  requestAnimationFrame(drawSparklines);
}

function drawSparklines() {
  const snaps = historyData?.snapshots;
  if (!snaps?.length) return;
  document.querySelectorAll('#history-spark .spark-canvas').forEach(cv => {
    const vals = snaps.map(s => s.adp[cv.dataset.team]);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const min = Math.min(...vals) - 0.3, max = Math.max(...vals) + 0.3;
    const X = i => vals.length === 1 ? w / 2 : 3 + (i / (vals.length - 1)) * (w - 6);
    const Y = v => 3 + ((v - min) / (max - min)) * (h - 6); // low ADP (better) at top

    ctx.beginPath();
    vals.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v)));
    ctx.strokeStyle = '#21affc';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(X(vals.length - 1), h);
    ctx.lineTo(X(0), h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 118, 182, 0.18)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(X(vals.length - 1), Y(vals[vals.length - 1]), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  });
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────
function loadHistoryData() {
  if (window.HISTORY_DATA) {
    historyData = window.HISTORY_DATA;
    renderHistoryView();
  }
  // If history-data.js wasn't loaded, placeholder message stays visible
}
