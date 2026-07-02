// ─── HISTORY CHART (Draft Pick Probability Over Time) ───────────────────────
// Consumes window.HISTORY_DATA (set by history-data.js, generated in CI by
// generate-history.js). Each snapshot is a retrospective simulation "as if only
// the first N matches had been played", so the lines trace how odds evolved.
const HISTORY_COLORS = [
  '#0076B6','#4da3d4','#7fbfe0','#1e5a8a','#3b8fc7',
  '#0a4b73','#62a8d6','#9cc7e3','#2b6f9e','#56b0e0',
  '#bcbcbc','#8a8a8a','#5e5e5e','#d4d4d4','#a0a0a0','#727272',
];

const TEAM_LIST = Object.keys(FANTASY_TEAMS);
let historyData = null;
let activePickTab = 0; // 0–15 = pick index, 'adp' = ADP mode
let historyChart = null;
const teamImages = {};

function preloadTeamImages() {
  for (const team of TEAM_LIST) {
    const img = new Image();
    img.src = `assets/teams/${encodeURIComponent(team)}.png`;
    teamImages[team] = img;
  }
}

// Custom plugin: draws team logo circles at the rightmost data point of each line
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

function externalTooltip(context, isAdp) {
  const el = document.getElementById('history-tooltip');
  const tt = context.tooltip;
  if (tt.opacity === 0) { el.style.opacity = 0; return; }

  const items = (tt.dataPoints || [])
    .slice()
    .sort((a, b) => isAdp ? a.parsed.y - b.parsed.y : b.parsed.y - a.parsed.y);

  const title = `After ${items[0]?.parsed.x ?? ''} matches`;
  let html = `<div class="htt-title">${title}</div>`;
  for (const it of items) {
    const team = it.dataset.label;
    const v = it.parsed.y;
    const src = `assets/teams/${encodeURIComponent(team)}.png`;
    const val = isAdp ? v.toFixed(1) : v.toFixed(1) + '%';
    html += `<div class="htt-row">
      <img class="htt-logo" src="${src}" alt="" onerror="this.style.visibility='hidden'">
      <span>${team}</span><span class="htt-val">${val}</span></div>`;
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

function buildHistoryTabs() {
  const container = document.getElementById('history-tabs');
  let html = '';
  for (let i = 0; i < 16; i++) {
    html += `<button class="htab${i === 0 ? ' htab-active' : ''}" data-pick="${i}">P${i + 1}</button>`;
  }
  html += `<button class="htab htab-adp" data-pick="adp">ADP</button>`;
  container.innerHTML = html;
  container.addEventListener('click', e => {
    const btn = e.target.closest('.htab');
    if (!btn) return;
    container.querySelectorAll('.htab').forEach(b => b.classList.remove('htab-active'));
    btn.classList.add('htab-active');
    activePickTab = btn.dataset.pick === 'adp' ? 'adp' : parseInt(btn.dataset.pick);
    renderHistoryChart();
  });
}

function renderHistoryChart() {
  if (!historyData || typeof Chart === 'undefined') return;
  const canvas = document.getElementById('history-chart');
  const noData = document.getElementById('history-no-data');
  canvas.style.display = 'block';
  noData.style.display = 'none';

  const isAdp = activePickTab === 'adp';

  const datasets = TEAM_LIST.map((team, i) => ({
    label: team,
    data: historyData.snapshots.map(s => ({
      x: s.matchesCompleted,
      y: isAdp ? s.adp[team] : s.probs[team]?.[activePickTab] ?? 0,
    })),
    borderColor: HISTORY_COLORS[i % HISTORY_COLORS.length],
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.3,
  }));

  // Compute y-axis bounds from the displayed series BEFORE building the config,
  // so the scale and the line geometry are consistent (mutating min/max after
  // creation moves the ticks but not the points).
  const allVals = historyData.snapshots.flatMap(s =>
    TEAM_LIST.map(team => isAdp ? s.adp[team] : (s.probs[team]?.[activePickTab] ?? 0))
  );
  const dataMin = Math.min(...allVals);
  const dataMax = Math.max(...allVals);
  let yMin, yMax;
  if (isAdp) {
    yMin = Math.max(1, Math.floor(dataMin - 0.5));
    yMax = Math.min(16, Math.ceil(dataMax + 0.5));
  } else {
    yMin = 0;
    yMax = Math.min(100, Math.ceil((dataMax + 2) / 5) * 5);
  }

  const yScale = isAdp ? {
    reverse: true,
    min: yMin, max: yMax,
    ticks: { color: '#666', font: { size: 11 }, stepSize: 1 },
    grid: { color: 'rgba(255,255,255,0.05)' },
    title: { display: true, text: 'Avg Draft Position', color: '#666', font: { size: 11 } },
  } : {
    min: yMin, max: yMax,
    ticks: { color: '#666', font: { size: 11 }, callback: v => v + '%' },
    grid: { color: 'rgba(255,255,255,0.05)' },
    title: { display: true, text: 'Probability', color: '#666', font: { size: 11 } },
  };

  if (historyChart) historyChart.destroy();
  historyChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 34 } },
      interaction: { mode: 'index', intersect: false },
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
          external: ctx => externalTooltip(ctx, isAdp),
        },
      },
    },
    plugins: [teamIconPlugin],
  });
}

function loadHistoryData() {
  if (window.HISTORY_DATA) {
    historyData = window.HISTORY_DATA;
    renderHistoryChart();
  }
  // If history-data.js wasn't loaded, placeholder message stays visible
}
