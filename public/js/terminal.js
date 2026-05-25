// ═════════════════════════════════════════════════════════════════════════
// ANTIGRAVITY v2 — TRADING FLOOR TERMINAL
// Renders the new dashboard split layout: operation cards (LEFT) + live
// event stream (RIGHT). Hooks into existing /api/state polling via
// window.terminalOnState. Maintains its own /api/events poller for the stream.
// ═════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let lastEventSeq = 0;
  let streamFilter = 'ALL';   // 'ALL' | 'NQ=F' | 'ES=F' | 'CL=F' | 'GC=F' | 'ERRORS'
  let streamPaused = false;
  let eventBuffer = [];        // ring of recent events for re-rendering on filter change
  const MAX_EVENT_RENDER = 220;

  const SYMBOLS = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];

  // ── Public hooks (called from app.js) ──────────────────────────────────
  window.terminalOnState = function (data) {
    if (!data) return;
    renderKpiStrip(data);
    renderOpsCards(data);
    updateOpsPaneSub(data);
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
    let active = 0;
    for (const s of SYMBOLS) if (data.accounts && data.accounts[s] && data.accounts[s].activePosition) active++;
    set('kpi-active-trades', String(active));

    // APX progress bar (matches existing logic)
    const profitMade = Math.max(0, (data.totalBalance || 0) - 200000);
    const pct = Math.min(100, (profitMade / 12000) * 100);
    const bar = document.getElementById('kpi-progress');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
  }

  // ── Operations cards (LEFT pane) ───────────────────────────────────────
  function renderOpsCards(data) {
    const container = document.getElementById('ops-cards');
    if (!container) return;

    const decisions = data.lastDecisions || {};
    const livePrices = data.livePrices || {};
    const accounts = data.accounts || {};

    const cards = SYMBOLS.map(sym => {
      const decision = decisions[sym];
      const acc = accounts[sym] || {};
      const px = livePrices[sym] || 0;
      return buildOpsCard(sym, decision, acc, px);
    });
    container.innerHTML = cards.join('');
  }

  function buildOpsCard(sym, decision, acc, px) {
    const cleanSym = sym.replace('=F', '');
    const balance = formatCurrency(acc.balance || 0);
    const todayPnl = (acc.realizedPnL || 0) + (acc.unrealizedPnL || 0);
    const pnlClass = todayPnl > 0 ? 'pnl-pos' : (todayPnl < 0 ? 'pnl-neg' : '');
    const pnlSign = todayPnl >= 0 ? '+' : '';

    // No decision yet → placeholder
    if (!decision) {
      return `<div class="ops-card" style="opacity:0.55;">
        <div class="ops-card-head">
          <span class="ops-card-symbol">${cleanSym}</span>
          <span class="ops-card-balance">${balance}</span>
        </div>
        <div class="specialist-line">waiting for first bar…</div>
      </div>`;
    }

    const regime = decision.regime || 'CHOP';
    const session = decision.session || '—';
    const isChop = regime === 'CHOP';
    const fireClass =
      decision.action === 'BUY' ? 'fire-long' :
      decision.action === 'SELL' ? 'fire-short' :
      isChop ? 'chop' : '';

    const regimePillClass =
      regime === 'TREND_UP' ? 'trend-up' :
      regime === 'TREND_DOWN' ? 'trend-down' :
      regime === 'VOL_EXPANSION' ? 'vol-exp' : 'chop';

    const regimeShort = regime.replace('TREND_', 'TREND ').replace('_', ' ');

    // Specialist + probabilities
    const probs = decision.probabilities || {};
    const longP = probs.long !== undefined ? probs.long : (decision.action === 'BUY' ? decision.probability : null);
    const shortP = probs.short !== undefined ? probs.short : (decision.action === 'SELL' ? decision.probability : null);
    const longTh = probs.longTh !== undefined ? probs.longTh : (decision.action === 'BUY' ? decision.threshold : null);
    const shortTh = probs.shortTh !== undefined ? probs.shortTh : (decision.action === 'SELL' ? decision.threshold : null);

    const longBundleStatus = decision.longBundle || 'OK';
    const shortBundleStatus = decision.shortBundle || 'OK';

    let specialistText;
    if (isChop) {
      specialistText = 'CHOP — no specialist active';
    } else if (longBundleStatus === 'DISABLED' && shortBundleStatus === 'DISABLED') {
      specialistText = '<span style="color:var(--neon-red);">all bundles gated off (low quality)</span>';
    } else if (longBundleStatus === 'MISSING' && shortBundleStatus === 'MISSING') {
      specialistText = '<span style="color:var(--neon-orange);">no model trained for this regime</span>';
    } else {
      const which =
        decision.action === 'BUY' ? `${cleanSym}_${session}_${regime}_long` :
        decision.action === 'SELL' ? `${cleanSym}_${session}_${regime}_short` :
        `${cleanSym}_${session}_${regime}_{long|short}`;
      specialistText = `active: <strong>${which}</strong>`;
    }

    // Position strip
    const pos = acc.activePosition;
    const posHtml = pos
      ? `<div class="ops-position-strip has-pos"><span>${pos.direction} × ${pos.qty} @ ${pos.entryPrice.toFixed(2)}</span><strong style="color:${(pos.unrealizedPnL||0) >= 0 ? 'var(--neon-green)' : 'var(--neon-red)'};">${(pos.unrealizedPnL||0) >= 0 ? '+' : ''}${formatCurrency(pos.unrealizedPnL || 0)}</strong></div>`
      : `<div class="ops-position-strip"><span>no open position</span><span>px ${px ? px.toFixed(2) : '—'}</span></div>`;

    return `<div class="ops-card ${fireClass}">
      <div class="ops-card-head">
        <span class="ops-card-symbol">${cleanSym}</span>
        <span class="ops-card-balance">${balance} <span class="${pnlClass}">${pnlSign}${formatCurrency(todayPnl)}</span></span>
      </div>
      <div class="ops-card-regime">
        <span class="regime-pill ${regimePillClass}">${regimeShort}</span>
        <span style="font-size:9px; opacity:0.6;">${session}</span>
        ${decision.action !== 'FLAT'
          ? `<span class="fire-badge fire ${decision.action === 'SELL' ? 'short' : ''}" style="margin-left:auto;">${decision.action === 'BUY' ? '▲ FIRE LONG' : '▼ FIRE SHORT'}</span>`
          : `<span class="fire-badge wait" style="margin-left:auto;">${isChop ? 'CHOP' : 'WAIT'}</span>`
        }
      </div>
      <div class="specialist-line">${specialistText}</div>
      ${buildProbRow('L', 'long', longP, longTh, longBundleStatus)}
      ${buildProbRow('S', 'short', shortP, shortTh, shortBundleStatus)}
      ${posHtml}
    </div>`;
  }

  function buildProbRow(label, klass, prob, threshold, status) {
    if (status === 'MISSING' || status === 'DISABLED' || prob === null || prob === undefined) {
      const reason = status === 'DISABLED' ? 'gated' : (status === 'MISSING' ? 'no model' : '—');
      return `<div class="prob-row">
        <span class="prob-label ${klass}">${label}</span>
        <div class="prob-bar-track"><span class="prob-bar-fill ${klass}" style="width:0%;"></span></div>
        <span class="prob-value" style="opacity:0.5;">${reason}</span>
      </div>`;
    }
    const pct = Math.max(0, Math.min(1, prob)) * 100;
    const thMark = threshold !== null && threshold !== undefined
      ? `<span class="prob-threshold-mark" style="left:${(threshold * 100).toFixed(1)}%;" title="threshold ${threshold.toFixed(2)}"></span>`
      : '';
    const valColor = (threshold !== null && prob >= threshold) ? `color: var(--neon-${klass === 'long' ? 'green' : 'red'});` : '';
    return `<div class="prob-row">
      <span class="prob-label ${klass}">${label}</span>
      <div class="prob-bar-track"><span class="prob-bar-fill ${klass}" style="width:${pct.toFixed(1)}%;"></span>${thMark}</div>
      <span class="prob-value" style="${valColor}">${pct.toFixed(0)}%</span>
    </div>`;
  }

  function updateOpsPaneSub(data) {
    const sub = document.getElementById('ops-pane-sub');
    if (!sub) return;
    const live = (data.tradingMode || 'paper').toUpperCase();
    sub.textContent = `mode: ${live} · 4 symbols`;
  }

  // ── Event stream (RIGHT pane) ──────────────────────────────────────────
  async function pollEvents() {
    if (streamPaused) return;
    try {
      const url = `/api/events?after=${lastEventSeq}&limit=120`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.events || data.events.length === 0) return;
      lastEventSeq = data.currentSeq || lastEventSeq;
      for (const ev of data.events) eventBuffer.push(ev);
      if (eventBuffer.length > MAX_EVENT_RENDER) {
        eventBuffer = eventBuffer.slice(-MAX_EVENT_RENDER);
      }
      renderEventStream();
    } catch (e) {
      // silent — stream poll failures don't block other dashboard activity
    }
  }

  function renderEventStream() {
    const container = document.getElementById('event-stream');
    if (!container) return;

    const filtered = eventBuffer.filter(ev => {
      if (streamFilter === 'ALL') return true;
      if (streamFilter === 'ERRORS') return ev.type === 'ERROR';
      return ev.symbol === streamFilter;
    });

    if (filtered.length === 0) {
      container.innerHTML = `<div class="event-stream-empty">No events match filter <strong>${streamFilter}</strong>${streamPaused ? ' · ⏸ paused' : ''}.</div>`;
      return;
    }

    // Render newest at top
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

  // ── Paper stats KPI hook (separate poller — slower cadence) ─────────────
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
        if (pfEl) {
          // Estimate PF from netR (rough): wins/losses approximation skipped — show netR instead
          pfEl.textContent = (data.stats.netR || 0).toFixed(1) + ' R';
        }
      }
    } catch (e) {}
  }

  async function pollModelStatus() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (data.models) {
        const enabled = data.models.filter(m => m.enabled).length;
        const total = data.models.length;
        const el = document.getElementById('kpi-models-on');
        if (el) el.textContent = `${enabled} / ${total}`;
      }
    } catch (e) {}
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  // Poll events at 1.5s (live feel), paper stats + models at 10s (lower cost).
  setInterval(pollEvents, 1500);
  setInterval(pollPaperStats, 10000);
  setInterval(pollModelStatus, 15000);
  pollEvents();
  pollPaperStats();
  pollModelStatus();
})();
