// ═════════════════════════════════════════════════════════════════════════
// ANTIGRAVITY v2 — DASHBOARD (E2 layout)
// D-style cards on left (1-column stack with sparklines + gauge rings + price
// + change%) and live event stream on right (sticky sidebar, 40%).
// Hooks into existing /api/state polling via window.terminalOnState.
// Maintains its own /api/events + /api/paper + /api/models pollers.
// ═════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let lastEventSeq = 0;
  let streamFilter = 'ALL';   // 'ALL' | 'NQ' | 'ES' | 'CL' | 'GC' | 'ERRORS'
  let streamPaused = false;
  let eventBuffer = [];
  const MAX_EVENT_RENDER = 220;

  // Sparkline price history (rolling buffer of last 30 closes per family)
  const sparkBuffers = { NQ: [], ES: [], CL: [], GC: [] };
  const SPARK_LEN = 30;

  // Loaded model thresholds keyed by family. Populated from /api/models.
  // Each family entry: { RTH_TREND_UP_long: 0.68, ETH_VOL_EXPANSION_short: 0.62, ... }
  // Cards use this to display "primed specialists" before any decision fires.
  const modelThresholdsByFamily = { NQ: {}, ES: {}, CL: {}, GC: {} };
  // Quality status per bundle key: 'OK' | 'DISABLED' | undefined (untrained)
  const bundleStatusByFamily   = { NQ: {}, ES: {}, CL: {}, GC: {} };
  // Aggregate WR per bundle for display
  const bundleAggregateByFamily = { NQ: {}, ES: {}, CL: {}, GC: {} };

  // ── Public hooks (called from app.js) ──────────────────────────────────
  window.terminalOnState = function (data) {
    if (!data) return;
    renderKpiStrip(data);
    renderE2Cards(data);
    renderContractToggle(data);
  };

  window.setStreamFilter = function (filter) {
    streamFilter = filter;
    document.querySelectorAll('.stream-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    renderEventStream();
  };

  window.toggleStreamPause = function () {
    streamPaused = !streamPaused;
    const btn = document.getElementById('stream-pause-btn');
    if (btn) {
      btn.classList.toggle('paused', streamPaused);
      btn.textContent = streamPaused ? '▶' : '⏸';
      btn.title = streamPaused ? 'Resume live stream' : 'Pause live stream';
    }
  };

  // ── KPI strip ──────────────────────────────────────────────────────────
  function renderKpiStrip(data) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('kpi-equity', formatCurrency(data.totalEquity));
    const openPnl = data.totalOpenPnL || 0;
    const openEl = document.getElementById('kpi-open-pnl');
    if (openEl) {
      openEl.textContent = (openPnl >= 0 ? '+' : '') + formatCurrency(openPnl);
      openEl.className = 'tk-value ' + (openPnl > 0 ? 'profit' : (openPnl < 0 ? 'loss' : 'neutral'));
    }
    const accounts = data.accounts || {};
    const activeSyms = (data.contractMode === 'MICRO') ? (data.microSymbols || []) : (data.miniSymbols || []);
    let active = 0;
    for (const s of activeSyms) if (accounts[s] && accounts[s].activePosition) active++;
    set('kpi-active-trades', String(active));
    const profitMade = Math.max(0, (data.totalBalance || 0) - 200000);
    const pct = Math.min(100, (profitMade / 12000) * 100);
    const bar = document.getElementById('kpi-progress');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
  }

  // ── MINI/MICRO toggle wiring ──────────────────────────────────────────
  function renderContractToggle(data) {
    const mode = data.contractMode || 'MINI';
    document.querySelectorAll('#contractToggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.c === mode);
    });
    const title = document.getElementById('opsContractTitle');
    if (title) title.textContent = `⚙️ OPERATIONS · ${mode}`;
  }
  // Click handler on the MINI/MICRO buttons (delegated, attached once on first render)
  let _toggleWired = false;
  function wireContractToggle() {
    if (_toggleWired) return;
    const tg = document.getElementById('contractToggle');
    if (!tg) return;
    tg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', async () => {
        const mode = b.dataset.c;
        try {
          await fetch('/api/contract-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          // Optimistic toggle until next state refresh
          tg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          const title = document.getElementById('opsContractTitle');
          if (title) title.textContent = `⚙️ OPERATIONS · ${mode}`;
        } catch (e) { console.warn('contract-mode toggle failed', e); }
      });
    });
    _toggleWired = true;
  }

  // ── E2 symbol cards (left pane) ───────────────────────────────────────
  function renderE2Cards(data) {
    wireContractToggle();
    const container = document.getElementById('e2-cards');
    if (!container) return;

    const mode = data.contractMode || 'MINI';
    const symbols = mode === 'MICRO' ? (data.microSymbols || []) : (data.miniSymbols || []);
    if (symbols.length === 0) {
      // Fallback if state doesn't include the lists yet
      symbols.push('NQ=F', 'ES=F', 'CL=F', 'GC=F');
    }
    const decisions = data.lastDecisions || {};
    const livePrices = data.livePrices || {};
    const accounts = data.accounts || {};
    const specs = data.contractSpecs || {};

    // Update sparkline buffers from current prices (one snapshot per state refresh)
    for (const sym of symbols) {
      const fam = sym.replace(/^M/, '').replace('=F', '');
      if (!sparkBuffers[fam]) sparkBuffers[fam] = [];
      const px = livePrices[sym] || 0;
      if (px > 0 && (sparkBuffers[fam].length === 0 || sparkBuffers[fam][sparkBuffers[fam].length - 1] !== px)) {
        sparkBuffers[fam].push(px);
        if (sparkBuffers[fam].length > SPARK_LEN) sparkBuffers[fam].shift();
      }
    }

    // Per-session WR floors — surfaced on each card so the user sees at a
    // glance what the quality bar is for their current session.
    const floors = data.qualityFloors || { rth: 0.65, eth: 0.55 };

    container.innerHTML = symbols.map(sym => buildE2Card(sym, decisions[sym], accounts[sym], livePrices[sym], specs[sym], floors)).join('');
  }

  function buildE2Card(sym, decision, acc, px, spec, floors) {
    floors = floors || { rth: 0.65, eth: 0.55 };
    const family = (spec && spec.family) || sym.replace(/^M/, '').replace('=F', '');
    const isMicro = spec && spec.isMicro;
    const displaySym = sym.replace('=F', '');
    const balance = acc ? acc.balance : 0;
    const todayPnl = acc ? (acc.realizedPnL || 0) + (acc.unrealizedPnL || 0) : 0;
    const enabled = acc ? acc.enabled !== false : true;

    // Decision-derived state
    const action = decision ? decision.action : null;
    const regime = decision ? decision.regime : null;
    const session = decision ? decision.session : '—';
    const isChop = regime === 'CHOP';
    const probs = (decision && decision.probabilities) || {};
    const longP = probs.long;
    const shortP = probs.short;
    const longTh = probs.longTh;
    const shortTh = probs.shortTh;
    const longBundle = (decision && decision.longBundle) || 'OK';
    const shortBundle = (decision && decision.shortBundle) || 'OK';

    // Classes for fire/chop states
    let fireClass = '';
    if (action === 'BUY')  fireClass = 'fire-long';
    else if (action === 'SELL') fireClass = 'fire-short';
    else if (isChop) fireClass = 'chop';
    if (!enabled) fireClass = 'off';

    // Regime pill class
    const rClass = regime === 'TREND_UP' ? 'up'
                 : regime === 'TREND_DOWN' ? 'down'
                 : regime === 'VOL_EXPANSION' ? 'vol'
                 : 'chop';
    const regimeText = regime ? regime.replace('TREND_', 'TREND ').replace('_', ' ') : 'waiting';

    // Verdict pill
    let verdictHtml;
    if (action === 'BUY')       verdictHtml = `<span class="e2-verdict long">▲ FIRE LONG</span>`;
    else if (action === 'SELL') verdictHtml = `<span class="e2-verdict short">▼ FIRE SHORT</span>`;
    else if (isChop)            verdictHtml = `<span class="e2-verdict wait">CHOP</span>`;
    else                        verdictHtml = `<span class="e2-verdict wait">WAIT</span>`;

    // Specialist line — shows ALL primed specialists for this family even
    // before any decision fires, so the user can see what the bot is armed
    // to do at any moment.
    let specLine;
    if (isChop) {
      specLine = 'CHOP — no specialist active';
    } else if (decision && (longBundle === 'DISABLED' && shortBundle === 'DISABLED')) {
      specLine = '<span style="color:var(--neon-red);">all bundles gated off (low quality)</span>';
    } else if (decision && (longBundle === 'MISSING' && shortBundle === 'MISSING')) {
      specLine = '<span style="color:var(--neon-orange);">no model trained for this regime</span>';
    } else if (decision && (action === 'BUY' || action === 'SELL')) {
      const dir = action === 'BUY' ? 'long' : 'short';
      specLine = `<strong>active: ${family}_${session}_${regime}_${dir}</strong>`;
    } else {
      // No decision yet — list deployed bundles for this family
      const bundles = deployedBundlesFor(family);
      if (bundles.length === 0) {
        specLine = '<span style="opacity:0.6;">no deployed bundles · waiting for retrain</span>';
      } else {
        const compact = bundles.slice(0, 3).map(b => {
          const k = b.key.replace('_long', '↑').replace('_short', '↓').replace('VOL_EXPANSION', 'VOL_EXP');
          return `<strong>${k}</strong>@${b.threshold.toFixed(2)}`;
        }).join('  ·  ');
        const more = bundles.length > 3 ? `  +${bundles.length - 3}` : '';
        specLine = `<span style="opacity:0.85;">primed: ${compact}${more}</span>`;
      }
    }

    // Sparkline
    const sparkPoints = sparkBuffers[family] || [];
    const sparkSvg = buildSparkline(sparkPoints, todayPnl);

    // Gauges. When no decision yet, surface the BEST threshold across the
    // family's deployed bundles for each direction (gives user the firing
    // bar before any bar arrives).
    let displayLongTh = longTh, displayShortTh = shortTh;
    if (displayLongTh === undefined || displayLongTh === null) {
      const dl = deployedBundlesFor(family).filter(b => b.key.endsWith('_long'));
      displayLongTh = dl.length > 0 ? Math.min(...dl.map(b => b.threshold)) : null;
    }
    if (displayShortTh === undefined || displayShortTh === null) {
      const ds = deployedBundlesFor(family).filter(b => b.key.endsWith('_short'));
      displayShortTh = ds.length > 0 ? Math.min(...ds.map(b => b.threshold)) : null;
    }
    const longGauge = buildGauge('long', longP, displayLongTh, longBundle, decision);
    const shortGauge = buildGauge('short', shortP, displayShortTh, shortBundle, decision);

    // Change percentage placeholder (computed from sparkline)
    const chgPct = sparkPoints.length >= 2
      ? ((sparkPoints[sparkPoints.length - 1] - sparkPoints[0]) / sparkPoints[0]) * 100
      : 0;
    const chgClass = chgPct > 0.01 ? 'pos' : (chgPct < -0.01 ? 'neg' : 'flat');
    const chgText = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%';

    // Position strip
    const pos = acc && acc.activePosition;
    const posHtml = pos
      ? `<div class="e2-pos-status">${pos.direction} × ${pos.qty} @ ${pos.entryPrice ? pos.entryPrice.toFixed(2) : '—'}</div>
         <div class="e2-pos-pnl ${(pos.unrealizedPnL || 0) >= 0 ? 'pos' : 'neg'}">${(pos.unrealizedPnL || 0) >= 0 ? '+' : ''}${formatCurrency(pos.unrealizedPnL || 0)}</div>`
      : `<div class="e2-pos-status">no open position</div>
         <div class="e2-pos-pnl" style="color:var(--text-secondary); font-size:11px;">flat</div>`;

    return `
      <div class="e2-card ${fireClass}">
        <div class="e2-head">
          <div class="e2-sym-row">
            <span class="e2-sym">${displaySym}</span>
            ${px > 0 ? `<span class="e2-px">${px.toFixed(2)}</span>` : ''}
            ${px > 0 ? `<span class="e2-chg ${chgClass}">${chgText}</span>` : ''}
          </div>
          <span class="e2-onoff ${enabled ? 'on' : 'off'}"
                onclick="toggleSymbolState('${sym}', ${!enabled})">${enabled ? '● ON' : '○ OFF'}</span>
        </div>
        <div class="e2-row">
          <span class="e2-regime-pill ${rClass}">${regimeText}</span>
          <span class="e2-sess">${session}</span>
          ${verdictHtml}
        </div>
        <div class="e2-floors-row" title="Quality gate: bundles must hit this WR to deploy. RTH (NY hours) holds a high bar; ETH (overnight) uses a realistic bar.">
          <span class="e2-floor-chip ${session==='RTH' ? 'active' : ''}">RTH&nbsp;<strong>${Math.round(floors.rth*100)}%</strong></span>
          <span class="e2-floor-chip ${session==='ETH' ? 'active' : ''}">ETH&nbsp;<strong>${Math.round(floors.eth*100)}%</strong></span>
          <span class="e2-floors-label">WR floor</span>
        </div>
        <div class="e2-spark-row">
          ${sparkSvg}
          <div class="e2-spark-stats">today<br><strong class="${todayPnl > 0 ? 'pos' : (todayPnl < 0 ? 'neg' : '')}">${todayPnl >= 0 ? '+' : ''}${formatCurrency(todayPnl)}</strong></div>
        </div>
        <div class="e2-gauges">${longGauge}${shortGauge}</div>
        <div class="e2-foot">
          <div class="e2-spec">${specLine}</div>
          <div class="e2-pos">${posHtml}</div>
        </div>
      </div>`;
  }

  function buildGauge(side, prob, threshold, status, decision) {
    const cls = side === 'long' ? 'l' : 's';
    const fillCls = side === 'long' ? 'long' : 'short';
    const cap = side === 'long' ? 'LONG' : 'SHORT';
    // Status-based dead states
    if (status === 'DISABLED') {
      return `<div class="e2-gauge" style="opacity:0.45;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th gated">⊘ GATED</div>
      </div>`;
    }
    if (status === 'MISSING') {
      return `<div class="e2-gauge" style="opacity:0.45;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th">no model</div>
      </div>`;
    }
    // No prob yet (waiting for first bar) but threshold IS known → show it
    if (prob === null || prob === undefined) {
      const thLabel = threshold !== null && threshold !== undefined
        ? `th ${threshold.toFixed(2)} (primed)`
        : 'awaiting bar';
      return `<div class="e2-gauge" style="opacity:0.7;">
        <svg viewBox="0 0 100 55"><path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/></svg>
        <div class="e2-gauge-num muted">—</div>
        <div class="e2-gauge-cap">${cap} prob</div>
        <div class="e2-gauge-th">${thLabel}</div>
      </div>`;
    }
    const pct = Math.max(0, Math.min(1, prob));
    const arcLen = 125.7; // half-circle perimeter at r=40
    const dashOffset = arcLen * (1 - pct);
    const hit = threshold !== undefined && prob >= threshold;
    const thLabel = threshold !== undefined ? `th ${threshold.toFixed(2)}${hit ? ' ✓ HIT' : ''}` : '—';
    const thCls = hit ? (side === 'long' ? 'hit' : 'hit-s') : '';
    return `<div class="e2-gauge">
      <svg viewBox="0 0 100 55">
        <path class="g-bg" d="M 10 50 A 40 40 0 0 1 90 50"/>
        <path class="g-fg ${fillCls}" d="M 10 50 A 40 40 0 0 1 90 50" stroke-dasharray="${arcLen}" stroke-dashoffset="${dashOffset.toFixed(1)}"/>
      </svg>
      <div class="e2-gauge-num ${cls}">${(pct * 100).toFixed(0)}%</div>
      <div class="e2-gauge-cap">${cap} prob</div>
      <div class="e2-gauge-th ${thCls}">${thLabel}</div>
    </div>`;
  }

  function buildSparkline(points, todayPnl) {
    if (!points || points.length < 2) {
      return `<svg class="e2-spark" viewBox="0 0 200 50" preserveAspectRatio="none">
        <line x1="0" y1="25" x2="200" y2="25" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3,3"/>
      </svg>`;
    }
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const w = 200, h = 50, pad = 4;
    const step = (w - 2 * pad) / (points.length - 1);
    const ptsStr = points.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = todayPnl >= 0 ? '#39ff14' : '#ff3838';
    const fillId = 'sf_' + Math.random().toString(36).slice(2, 8);
    return `<svg class="e2-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.3"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${ptsStr} ${w - pad},${h} ${pad},${h}" fill="url(#${fillId})"/>
      <polyline points="${ptsStr}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ── Event stream (right sidebar) ──────────────────────────────────────
  async function pollEvents() {
    if (streamPaused) return;
    try {
      const res = await fetch(`/api/events?after=${lastEventSeq}&limit=120`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.events || data.events.length === 0) return;
      lastEventSeq = data.currentSeq || lastEventSeq;
      for (const ev of data.events) eventBuffer.push(ev);
      if (eventBuffer.length > MAX_EVENT_RENDER) eventBuffer = eventBuffer.slice(-MAX_EVENT_RENDER);
      renderEventStream();
    } catch (e) {}
  }

  function renderEventStream() {
    const container = document.getElementById('event-stream');
    if (!container) return;

    const filtered = eventBuffer.filter(ev => {
      if (streamFilter === 'ALL') return true;
      if (streamFilter === 'ERRORS') return ev.type === 'ERROR';
      // Filter by family (NQ matches both NQ=F and MNQ=F)
      if (!ev.symbol) return false;
      const fam = ev.symbol.replace(/^M/, '').replace('=F', '');
      return fam === streamFilter;
    });

    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:30px 12px; font-family: var(--font-family); font-size:12px;">No events match filter <strong>${streamFilter}</strong>${streamPaused ? ' · ⏸ paused' : ''}.</div>`;
      return;
    }

    const rows = filtered.slice().reverse().map(ev => {
      const t = new Date(ev.ts);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const sym = ev.symbol ? ev.symbol.replace('=F', '') : '·';
      const typeShort = (ev.type || '').substring(0, 3);
      const msg = escapeHtml(ev.message || '');
      return `<div class="event-row type-${ev.type}">
        <span class="event-time">${hh}:${mm}:${ss}</span>
        <span class="event-symbol">${sym}</span>
        <span class="event-type">${typeShort}</span>
        <span class="event-msg">${msg}</span>
      </div>`;
    }).join('');
    container.innerHTML = rows;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCurrency(v) {
    if (v === null || v === undefined || isNaN(v)) return '$0.00';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
  }

  // ── Exits tab (TP/SL/BE/Trail override per RTH/ETH) ────────────────────
  async function pollExitsConfig() {
    try {
      const res = await fetch('/api/exits');
      if (!res.ok) return;
      const data = await res.json();
      renderExitsTab(data.config, data.fixedActive);
    } catch (e) {}
  }

  // 8 symbols: 4 mini + 4 micro. Each gets its own card with RTH + ETH columns.
  const EXITS_SYMBOLS = [
    { sym: 'NQ=F',  label: 'NQ',  family: 'Nasdaq-100 E-mini',     tier: 'mini'  },
    { sym: 'ES=F',  label: 'ES',  family: 'S&P 500 E-mini',         tier: 'mini'  },
    { sym: 'CL=F',  label: 'CL',  family: 'Crude Oil',              tier: 'mini'  },
    { sym: 'GC=F',  label: 'GC',  family: 'Gold',                   tier: 'mini'  },
    { sym: 'MNQ=F', label: 'MNQ', family: 'Nasdaq-100 Micro',       tier: 'micro' },
    { sym: 'MES=F', label: 'MES', family: 'S&P 500 Micro',          tier: 'micro' },
    { sym: 'MCL=F', label: 'MCL', family: 'Crude Oil Micro',        tier: 'micro' },
    { sym: 'MGC=F', label: 'MGC', family: 'Gold Micro',             tier: 'micro' }
  ];

  function renderExitsTab(cfg, fixedActive) {
    const warn = document.getElementById('exits-warning');
    if (warn) warn.style.display = fixedActive ? '' : 'none';
    const wrap = document.getElementById('exits-cards');
    if (!wrap) return;
    wrap.innerHTML = EXITS_SYMBOLS.map(meta => buildExitsCardForSymbol(meta, cfg[meta.sym] || {})).join('');
    wireExitsHandlers();
  }

  function buildExitsCardForSymbol(meta, symCfg) {
    const rth = symCfg.RTH || {};
    const eth = symCfg.ETH || {};
    const anyActive = !!(rth.enabled || eth.enabled);
    const tierBadge = meta.tier === 'micro'
      ? `<span style="font-size:9px; padding: 2px 6px; border-radius: 4px; background: rgba(167,139,250,0.15); color: #a78bfa; border: 1px solid rgba(167,139,250,0.4); font-weight: 800; letter-spacing: 0.5px;">MICRO</span>`
      : `<span style="font-size:9px; padding: 2px 6px; border-radius: 4px; background: rgba(0,240,255,0.12); color: var(--cyan-glow, #00F0FF); border: 1px solid rgba(0,240,255,0.4); font-weight: 800; letter-spacing: 0.5px;">MINI</span>`;
    return `
      <div class="exits-symbol-card glass-card" style="padding: 18px 20px; border: 1px solid ${anyActive ? 'rgba(255,152,0,0.4)' : 'var(--border-light)'}; box-shadow: ${anyActive ? '0 0 16px rgba(255,152,0,0.12)' : 'none'};">
        <div style="display:flex; align-items:center; gap: 10px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <h3 style="margin:0; font-size: 18px; font-weight: 800; color: var(--text-primary); letter-spacing: 1px;">${meta.label}</h3>
          ${tierBadge}
          <span style="font-size: 11px; color: var(--text-secondary); margin-left: 4px;">${meta.family}</span>
          ${anyActive ? `<span style="margin-left: auto; font-size: 10px; font-weight: 800; color: var(--neon-orange); letter-spacing: 0.5px;">● FIXED ACTIVE</span>` : ''}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
          ${buildSessionBlock(meta.sym, 'RTH', rth)}
          ${buildSessionBlock(meta.sym, 'ETH', eth)}
        </div>
      </div>
    `;
  }

  function buildSessionBlock(symbol, session, s) {
    const sessLabel = session === 'RTH' ? '☀️ RTH' : '🌙 ETH';
    const accentColor = session === 'RTH' ? 'var(--neon-green)' : 'var(--neon-orange)';
    const accentGlow  = session === 'RTH' ? 'rgba(57,255,20,0.12)' : 'rgba(255,152,0,0.10)';
    const enabled = !!s.enabled;
    return `
      <div style="background: rgba(5,7,12,${enabled ? '0.45' : '0.25'}); border: 1px solid ${enabled ? accentColor : 'rgba(255,255,255,0.05)'}; border-radius: 8px; padding: 12px; ${enabled ? `box-shadow: inset 0 0 12px ${accentGlow};` : ''}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <span style="font-size: 12px; font-weight: 800; color: ${accentColor}; letter-spacing: 0.5px;">${sessLabel}</span>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;">
            <input type="checkbox" data-exits-symbol="${symbol}" data-exits-session="${session}" data-exits-field="enabled" ${enabled ? 'checked' : ''} style="width:14px; height:14px; cursor:pointer; accent-color: ${accentColor};">
            <span style="font-size:9.5px; font-weight: 800; letter-spacing: 0.4px; color: ${enabled ? accentColor : 'var(--text-secondary)'};">USE FIXED ${enabled ? '✓' : ''}</span>
          </label>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; ${enabled ? '' : 'opacity:0.45; pointer-events:none;'}">
          ${exitsField('Profit',     symbol, session, 'profitPoints',     s.profitPoints,     'pts')}
          ${exitsField('Stop',       symbol, session, 'stopPoints',       s.stopPoints,       'pts')}
          ${exitsField('Break-Even', symbol, session, 'breakevenAtPoints', s.breakevenAtPoints, 'pts')}
          ${exitsField('Trail @',    symbol, session, 'trailStartPoints', s.trailStartPoints, 'pts')}
          <div style="grid-column: 1 / -1;">
            ${exitsField('Trail Step', symbol, session, 'trailStepPoints',  s.trailStepPoints,  'pts behind')}
          </div>
        </div>
      </div>
    `;
  }

  function exitsField(label, symbol, session, field, value, suffix) {
    return `
      <div class="input-group" style="display:flex; flex-direction:column; gap:3px;">
        <label style="font-size: 9px; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;">${label}</label>
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" min="0.05" step="0.05" value="${value}"
                 data-exits-symbol="${symbol}" data-exits-session="${session}" data-exits-field="${field}"
                 style="flex:1; min-width: 0; padding: 6px 8px; background: rgba(5,7,12,0.6); border: 1px solid var(--border-light); border-radius: 5px; color: var(--text-primary); font-family: 'Consolas', monospace; font-size: 12px; font-weight: 600;">
          <span style="font-size: 9px; color: var(--text-secondary); white-space: nowrap;">${suffix}</span>
        </div>
      </div>
    `;
  }

  let _exitsHandlersWired = new WeakSet();
  function wireExitsHandlers() {
    document.querySelectorAll('[data-exits-symbol]').forEach(el => {
      if (_exitsHandlersWired.has(el)) return;
      _exitsHandlersWired.add(el);
      el.addEventListener('change', async () => {
        const symbol  = el.dataset.exitsSymbol;
        const session = el.dataset.exitsSession;
        const field   = el.dataset.exitsField;
        const val     = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
        try {
          const res = await fetch('/api/exits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, session, values: { [field]: val } })
          });
          if (res.ok) pollExitsConfig();  // re-render with fresh state
        } catch (e) { console.warn('exits save failed', e); }
      });
    });
  }

  // ── Paper stats KPI hook + models polling ──────────────────────────────
  async function pollPaperStats() {
    try {
      const res = await fetch('/api/paper');
      if (!res.ok) return;
      const data = await res.json();
      if (data.stats) {
        const wrEl = document.getElementById('kpi-paper-wr');
        const pfEl = document.getElementById('kpi-paper-pf');
        if (wrEl) wrEl.textContent = data.stats.total > 0
          ? (data.stats.winRate * 100).toFixed(1) + '% (' + data.stats.total + ')'
          : '— (0)';
        if (pfEl) pfEl.textContent = (data.stats.netR || 0).toFixed(1) + ' R';
      }
    } catch (e) {}
  }

  async function pollModelStatus() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.models) return;
      // Top-line KPI: deployed / total
      const enabled = data.models.filter(m => m.enabled).length;
      const total = data.models.length;
      const el = document.getElementById('kpi-models-on');
      if (el) el.textContent = `${enabled} / ${total}`;
      // Global cache so app.js (Futures Funded Accounts cards) can show
      // the same per-family bundle list without re-fetching.
      window._v2ModelStatus = data.models;
      // Populate the Settings → "v2 Engine" info panel
      renderSettingsModelsInfo(data.models);
      // Per-family bundle tables (used by the ops cards to show "primed
      // specialists" with thresholds BEFORE any decision fires).
      for (const fam of Object.keys(modelThresholdsByFamily)) {
        modelThresholdsByFamily[fam]   = {};
        bundleStatusByFamily[fam]      = {};
        bundleAggregateByFamily[fam]   = {};
      }
      for (const m of data.models) {
        const fam = (m.symbol || '').replace('=F', '');
        if (!modelThresholdsByFamily[fam]) continue;
        const key = `${m.session}_${m.regime}_${m.direction}`;
        modelThresholdsByFamily[fam][key] = m.threshold;
        bundleStatusByFamily[fam][key]    = m.enabled ? 'OK' : 'DISABLED';
        bundleAggregateByFamily[fam][key] = m.aggregate || null;
      }
    } catch (e) {}
  }

  // Populates the Settings tab's "v2 Engine" panel with live model stats.
  function renderSettingsModelsInfo(models) {
    if (!Array.isArray(models)) return;
    const deployed = models.filter(m => m.enabled);
    const gated = models.filter(m => !m.enabled);
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('settings-deployed-count', deployed.length + ' deployed');
    setText('settings-gated-count',    gated.length    + ' gated off');
    // Latest train timestamp — pick max trainedAt across models
    let latest = null;
    for (const m of models) {
      if (!m.trainedAt) continue;
      const t = new Date(m.trainedAt);
      if (!latest || t > latest) latest = t;
    }
    setText('settings-last-trained', latest ? latest.toLocaleString() : '—');

    const list = document.getElementById('settings-deployed-list');
    if (!list) return;
    if (deployed.length === 0) {
      list.innerHTML = '<span style="color:var(--neon-orange);">No bundles pass the quality gate. Run a retrain or relax MIN_WR / MIN_PF / MIN_TRADES env vars.</span>';
      return;
    }
    // Sort by WR descending and render as a tidy table
    const sorted = deployed.slice().sort((a, b) => (b.aggregate?.winRate || 0) - (a.aggregate?.winRate || 0));
    const rows = sorted.map(m => {
      const a = m.aggregate || {};
      const wr = ((a.winRate || 0) * 100).toFixed(1).padStart(5) + '%';
      const pf = (a.profitFactor || 0).toFixed(2).padStart(5);
      const sh = (a.sharpe || 0).toFixed(2).padStart(6);
      const tr = String(a.totalTestTrades || 0).padStart(5);
      const sym = m.symbol.replace('=F', '').padEnd(3);
      const sess = m.session.padEnd(4);
      const reg  = m.regime.padEnd(14);
      const dir  = m.direction.padEnd(6);
      const th   = (m.threshold || 0).toFixed(2);
      return `  ✓ ${sym} ${sess} ${reg} ${dir}  WR=${wr}  PF=${pf}  Sharpe=${sh}  trades=${tr}  th=${th}`;
    }).join('\n');
    list.textContent = rows;
  }

  // Returns the deployed (gate-passing) bundles for a family, summarized
  // for the "primed specialists" line on each card.
  function deployedBundlesFor(family) {
    const status = bundleStatusByFamily[family] || {};
    const ths = modelThresholdsByFamily[family] || {};
    const aggs = bundleAggregateByFamily[family] || {};
    const out = [];
    for (const key of Object.keys(status)) {
      if (status[key] !== 'OK') continue;
      const a = aggs[key] || {};
      out.push({
        key,
        threshold: ths[key] || 0.65,
        winRate:   a.winRate || 0,
        pf:        a.profitFactor || 0,
        trades:    a.totalTestTrades || 0
      });
    }
    return out;
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  setInterval(pollEvents, 1500);
  setInterval(pollPaperStats, 10000);
  setInterval(pollModelStatus, 15000);
  setInterval(pollExitsConfig, 30000);
  pollEvents();
  pollPaperStats();
  pollModelStatus();
  pollExitsConfig();

  // Refresh Exits tab whenever it becomes the active view
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function (tabName) {
      _origSwitchTab(tabName);
      if (tabName === 'exits') pollExitsConfig();
    };
  }
})();
