// Reactive Web Dashboard controller for V1 Antigravity Smart Bot

let apiState = null;

// Fetch and update dashboard state
async function updateDashboard() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('API failure');
    const data = await res.json();
    
    apiState = data;
    renderKPIs(data);
    renderAccounts(data.accounts);
    renderPositions(data.accounts);
    renderNews(data.news);
    renderYahooNews(data.yahooNews);
    renderTradeHistory(data.history);
    renderRegime(data.regime, data.schedule);
    
    // Update config inputs if values exist
    if (data.tastytradeId) {
      document.getElementById('tt-client-id').value = data.tastytradeId;
    }
  } catch (err) {
    console.error('[Dashboard] State fetch error:', err.message);
  }
}

// Render Master KPIs
function renderKPIs(data) {
  const equityElement = document.getElementById('kpi-equity');
  const balanceElement = document.getElementById('kpi-balance');
  const openPnLElement = document.getElementById('kpi-open-pnl');
  const activeTradesElement = document.getElementById('kpi-active-trades');
  const progressElement = document.getElementById('kpi-progress');

  equityElement.textContent = formatCurrency(data.totalEquity);
  balanceElement.textContent = formatCurrency(data.totalBalance);
  
  // Format Open P&L with positive/negative colors
  openPnLElement.textContent = (data.totalOpenPnL >= 0 ? '+' : '') + formatCurrency(data.totalOpenPnL);
  openPnLElement.className = 'value ' + (data.totalOpenPnL > 0 ? 'profit' : (data.totalOpenPnL < 0 ? 'loss' : 'neutral'));

  // Count active open positions
  let activeCount = 0;
  for (const sym of Object.keys(data.accounts)) {
    if (data.accounts[sym].activePosition) activeCount++;
  }
  activeTradesElement.textContent = activeCount;

  // Calculate Progress toward $53,000 APX target (on a $50,000 base)
  // Target profit is $3,000
  const profitMade = Math.max(0, data.totalBalance - 200000); // base for 4 accounts is $200k
  const totalTarget = 12000; // 4 accounts * $3000 = $12k total profit target
  const percent = Math.min(100, (profitMade / totalTarget) * 100);
  progressElement.style.width = `${percent}%`;
}

// Render Futures Sub-Accounts
function renderAccounts(accounts) {
  const container = document.getElementById('accounts-container');
  container.innerHTML = '';

  const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
  
  symbols.forEach(sym => {
    const acc = accounts[sym];
    if (!acc) return;

    const cleanSymbol = sym.replace('=F', '');
    const activePosText = acc.activePosition ? `${acc.activePosition.direction} @ ${acc.activePosition.entryPrice.toFixed(2)}` : 'None';
    
    // Determine status badge
    let statusClass = 'badge active';
    let statusText = acc.status;
    if (acc.status === 'FAILED') {
      statusClass = 'badge failed';
      statusText = 'LIQUIDATED';
    } else if (acc.passed) {
      statusClass = 'badge passed';
      statusText = `${acc.mode} PASSED`;
    } else {
      statusText = `${acc.mode} ACTIVE`;
    }

    // Dynamic color tags for drawdown values based on mode
    const drawdownFloorText = acc.mode === 'Standard' ? 'Bypassed (Universal)' : formatCurrency(acc.drawdownFloor);
    const drawdownStyle = acc.mode === 'Standard' ? 'color: var(--neon-green); font-style: italic;' : 'color: var(--neon-red);';

    const card = document.createElement('div');
    card.className = 'glass-card account-card glow-on-hover';
    card.innerHTML = `
      <div class="account-card-header">
        <h4>${cleanSymbol} Account</h4>
        <span class="${statusClass}">${statusText}</span>
      </div>
      <div class="account-details">
        <p>Current Balance: <strong>${formatCurrency(acc.balance)}</strong></p>
        <p>Peak Equity: <strong>${formatCurrency(acc.peakEquity)}</strong></p>
        <p>Drawdown Floor: <strong style="${drawdownStyle}">${drawdownFloorText}</strong></p>
        <p>Open Position: <strong style="color: ${acc.activePosition ? 'var(--neon-green)' : 'var(--text-secondary)'};">${activePosText}</strong></p>
        
        <!-- Premium Selector for Broker Account Mode -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border-light);">
          <label style="font-size: 11px; color: var(--text-secondary);">Broker Mode:</label>
          <select class="glass-select" style="background: rgba(0,0,0,0.3); border:1px solid var(--border-light); border-radius:4px; padding:3px 6px; font-family: var(--font-family); color:#fff; font-size:11px; outline:none;" onchange="setAccountMode('${sym}', this.value)">
            <option value="Standard" ${acc.mode === 'Standard' ? 'selected' : ''}>Standard (Universal)</option>
            <option value="Evaluation" ${acc.mode === 'Evaluation' ? 'selected' : ''}>APX Evaluation ($50K)</option>
            <option value="PA" ${acc.mode === 'PA' ? 'selected' : ''}>APX Performance (PA)</option>
          </select>
        </div>
      </div>
    `;

    // Add Transition to PA button if passed and still in Evaluation
    if (acc.passed && acc.mode === 'Evaluation') {
      const button = document.createElement('button');
      button.className = 'btn btn-primary';
      button.style.width = '100%';
      button.style.marginTop = '12px';
      button.style.padding = '8px';
      button.style.fontSize = '11px';
      button.textContent = '🚀 Transition to PA Account';
      button.onclick = () => transitionToPA(sym);
      card.appendChild(button);
    }

    container.appendChild(card);
  });
}

// Render Positions Table
function renderPositions(accounts) {
  const tbody = document.getElementById('positions-table-body');
  tbody.innerHTML = '';

  let hasPositions = false;

  for (const sym of Object.keys(accounts)) {
    const acc = accounts[sym];
    const pos = acc.activePosition;
    if (!pos) continue;

    hasPositions = true;
    const cleanSym = sym.replace('=F', '');
    const tr = document.createElement('tr');
    
    const pnlClass = pos.unrealizedPnL > 0 ? 'profit' : (pos.unrealizedPnL < 0 ? 'loss' : 'neutral');
    const pnlSign = pos.unrealizedPnL >= 0 ? '+' : '';
    
    tr.innerHTML = `
      <td><strong>${cleanSym}</strong></td>
      <td style="color: ${pos.direction === 'Long' ? 'var(--neon-green)' : 'var(--neon-red)'}; font-weight: 600;">${pos.direction}</td>
      <td>${pos.qty}</td>
      <td>${pos.entryPrice.toFixed(2)}</td>
      <td id="price-${cleanSym}">-</td>
      <td>
        <span style="font-size: 11px; display:block;">SL: ${pos.stopLoss.toFixed(2)}</span>
        <span style="font-size: 11px; display:block; color: var(--text-secondary);">TP: ${pos.takeProfit.toFixed(2)}</span>
      </td>
      <td class="${pnlClass}" style="font-weight:600;">${pnlSign}${formatCurrency(pos.unrealizedPnL)}</td>
      <td>
        <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 11px;" onclick="forceClosePosition('${sym}')">Close</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  if (!hasPositions) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No active positions. Monitoring strategies...</td></tr>`;
  }
}

// Render News Events
function renderNews(news) {
  const container = document.getElementById('news-events-container');
  if (!news || !news.events || news.events.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No high-impact economic news scheduled.</div>`;
    return;
  }

  container.innerHTML = '';

  // Add suspension banner if news block is active
  if (news.suspensionActive) {
    const banner = document.createElement('div');
    banner.style.background = 'rgba(255, 56, 56, 0.15)';
    banner.style.border = '1px solid var(--neon-red)';
    banner.style.borderRadius = '8px';
    banner.style.padding = '10px';
    banner.style.fontSize = '12px';
    banner.style.fontWeight = '600';
    banner.style.color = 'var(--neon-red)';
    banner.style.marginBottom = '12px';
    banner.style.textAlign = 'center';
    banner.textContent = `🛑 Trading Suspended: ${news.reason}`;
    container.appendChild(banner);
  } else if (news.nextNewsEvent) {
    const banner = document.createElement('div');
    banner.style.background = 'rgba(255, 152, 0, 0.1)';
    banner.style.border = '1px solid var(--neon-orange)';
    banner.style.borderRadius = '8px';
    banner.style.padding = '8px';
    banner.style.fontSize = '12px';
    banner.style.color = 'var(--neon-orange)';
    banner.style.marginBottom = '12px';
    banner.style.textAlign = 'center';
    banner.textContent = `⏳ High Impact ${news.nextNewsEvent.title} in ${news.nextNewsEvent.timeRemainingMins} mins`;
    container.appendChild(banner);
  }

  // Define impact order hierarchy
  const impactWeights = { 'High': 3, 'Medium': 2, 'Low': 1 };

  // Sort events: 1. High Impact First, 2. Closest time proximity
  const sortedEvents = [...news.events].sort((a, b) => {
    const weightA = impactWeights[a.impact] || 0;
    const weightB = impactWeights[b.impact] || 0;
    
    if (weightA !== weightB) {
      return weightB - weightA; // Higher weight on top
    }
    
    // If same weight, sort by time difference (closest to now on top)
    const timeA = new Date(a.dateTime).getTime();
    const timeB = new Date(b.dateTime).getTime();
    const now = Date.now();
    return Math.abs(timeA - now) - Math.abs(timeB - now);
  });

  sortedEvents.forEach(event => {
    const cleanTime = new Date(event.dateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // Calculate elapsed/remaining time indicators
    const now = new Date();
    const eventTime = new Date(event.dateTime);
    const diffMs = eventTime.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / (60 * 1000));
    
    let timeLabel = '';
    let timeColorClass = 'text-muted';

    if (diffMins === 0) {
      timeLabel = 'JUST NOW';
      timeColorClass = 'color: var(--neon-green); font-weight: 800;';
    } else if (diffMins > 0) {
      // Future event
      timeColorClass = 'color: var(--text-secondary);';
      if (diffMins < 60) {
        timeLabel = `in ${diffMins}m`;
      } else {
        timeLabel = `in ${(diffMins / 60).toFixed(1)}h`;
      }
    } else {
      // Past event
      const absMins = Math.abs(diffMins);
      if (absMins < 60) {
        timeLabel = `${absMins}m ago`;
        // High impact news that is recent (under 30m) gets highlighted
        if (event.impact === 'High' && absMins <= 30) {
          timeColorClass = 'color: var(--neon-red); font-weight: 600;';
        } else {
          timeColorClass = 'color: var(--neon-orange);';
        }
      } else {
        timeLabel = `${(absMins / 60).toFixed(1)}h ago`;
        timeColorClass = 'color: var(--text-secondary);';
      }
    }

    const item = document.createElement('div');
    item.className = 'news-item';
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.innerHTML = `
      <div class="news-item-left">
        <span class="news-item-title">${event.title}</span>
        <span class="news-item-sub">${event.country} • Today @ ${cleanTime}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 11px; ${timeColorClass}">${timeLabel}</span>
        <span class="news-impact-tag ${event.impact.toLowerCase()}">${event.impact}</span>
      </div>
    `;
    container.appendChild(item);
  });
}

// Render Yahoo Finance Live News
function renderYahooNews(yahooNews) {
  const container = document.getElementById('yahoo-news-container');
  if (!yahooNews || yahooNews.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No live financial news available.</div>`;
    return;
  }

  container.innerHTML = '';
  
  // Sort by calculated impact hierarchy first, then recency
  const impactWeights = { 'High': 3, 'Medium': 2, 'Low': 1 };
  const sortedNews = [...yahooNews].sort((a, b) => {
    const weightA = impactWeights[a.impact] || 1;
    const weightB = impactWeights[b.impact] || 1;
    
    if (weightA !== weightB) {
      return weightB - weightA; // Float higher impact to top
    }
    
    // Sort by publication timestamp
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  sortedNews.forEach(item => {
    const now = new Date();
    const pubDate = new Date(item.pubDate);
    const diffMs = now.getTime() - pubDate.getTime();
    const diffMins = Math.round(diffMs / (60 * 1000));
    
    let timeLabel = '';
    let timeColorClass = 'color: var(--text-secondary);';
    
    if (diffMins <= 0) {
      timeLabel = 'JUST NOW';
      timeColorClass = 'color: var(--neon-green); font-weight: 800;';
    } else if (diffMins < 60) {
      timeLabel = `${diffMins}m ago`;
      if (diffMins <= 15) {
        timeColorClass = 'color: var(--neon-green); font-weight: 600;';
      } else {
        timeColorClass = 'color: var(--neon-orange);';
      }
    } else {
      const hours = Math.round(diffMins / 60);
      timeLabel = `${hours}h ago`;
    }

    const cleanTime = pubDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    const div = document.createElement('div');
    div.className = 'news-item';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '6px';
    div.style.cursor = 'pointer';
    div.onclick = () => window.open(item.link || 'https://finance.yahoo.com', '_blank');
    
    // Custom label classes for news impact
    const impactClass = item.impact ? item.impact.toLowerCase() : 'low';
    
    div.innerHTML = `
      <div style="font-size: 13px; font-weight: 600; line-height: 1.4; color: var(--text-primary);">${item.title}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
        <span style="color: var(--text-secondary);">Yahoo Finance • Today @ ${cleanTime}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="${timeColorClass}">${timeLabel}</span>
          <span class="news-impact-tag ${impactClass}" style="font-size: 9px; padding: 2px 6px;">${item.impact || 'Low'}</span>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

// Render Trade History
function renderTradeHistory(history) {
  const container = document.getElementById('trade-history-container');
  if (!history || history.length === 0) {
    container.innerHTML = `<div class="text-muted text-center py-4">No closed trades recorded yet.</div>`;
    return;
  }

  container.innerHTML = '';
  history.slice(0, 10).forEach(trade => {
    const sign = trade.profit >= 0 ? '+' : '';
    const winClass = trade.profit >= 0 ? 'win' : 'loss';
    const cleanSym = trade.symbol.replace('=F', '');
    
    const timeStr = new Date(trade.exitTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerHTML = `
      <div class="log-item-details">
        <span style="font-size: 13px; font-weight:600;">${cleanSym} • ${trade.direction} (${trade.qty} Contracts)</span>
        <span style="font-size: 11px; color: var(--text-secondary);">${trade.strategyUsed} • ${trade.reason} @ ${timeStr}</span>
      </div>
      <div class="log-item-profit ${winClass}">${sign}${formatCurrency(trade.profit)}</div>
    `;
    container.appendChild(item);
  });
}

// Render RTH/ETH regimes
function renderRegime(regime, schedule) {
  const textElement = document.getElementById('regime-text');
  const badgeElement = document.getElementById('regime-badge');
  const pulseElement = document.getElementById('regime-pulse');
  
  const scheduleText = document.getElementById('schedule-text');
  const scheduleBadge = document.getElementById('schedule-badge');

  textElement.textContent = regime.name;

  if (regime.code === 'RTH') {
    pulseElement.className = 'pulse-dot active';
    badgeElement.style.border = '1px solid rgba(57, 255, 20, 0.3)';
  } else {
    pulseElement.className = 'pulse-dot warning';
    badgeElement.style.border = '1px solid rgba(255, 152, 0, 0.3)';
  }

  scheduleText.textContent = schedule.reason;
  if (schedule.isClosed) {
    scheduleBadge.style.color = 'var(--neon-red)';
    scheduleBadge.style.border = '1px solid rgba(255, 56, 56, 0.3)';
    scheduleBadge.style.background = 'rgba(255, 56, 56, 0.05)';
  } else {
    scheduleBadge.style.color = 'var(--neon-green)';
    scheduleBadge.style.border = '1px solid rgba(57, 255, 20, 0.3)';
    scheduleBadge.style.background = 'rgba(57, 255, 20, 0.05)';
  }
}

// Actions & API posts
async function transitionToPA(symbol) {
  if (confirm(`Are you sure you want to transition ${symbol} to PA Account? This will reset the PA balance to $50,000 and lock the risk drawdown floor forever at $50,100.`)) {
    try {
      const res = await fetch(`/api/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      if (res.ok) {
        alert('PA transition successful!');
        updateDashboard();
      }
    } catch (e) {
      alert('Transition failed.');
    }
  }
}

async function setAccountMode(symbol, mode) {
  try {
    const res = await fetch(`/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, mode })
    });
    if (res.ok) {
      console.log(`[Dashboard] Account ${symbol} mode changed to ${mode}`);
      updateDashboard();
    } else {
      alert('Failed to update broker mode.');
    }
  } catch (e) {
    console.error('[Dashboard] Error changing account mode:', e.message);
  }
}

async function forceClosePosition(symbol) {
  if (confirm(`Force close all active positions for ${symbol}?`)) {
    try {
      const res = await fetch(`/api/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      if (res.ok) {
        updateDashboard();
      }
    } catch (e) {
      alert('Close order failed.');
    }
  }
}

async function updateWebhookUrl(val) {
  try {
    await fetch(`/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: val })
    });
    console.log('[Dashboard] Webhook URL saved.');
  } catch (e) {}
}

async function runBacktester() {
  const box = document.getElementById('backtest-results');
  box.style.display = 'block';
  box.innerHTML = '📥 Downloading historical futures data from Yahoo Finance and executing backtest...\n';

  try {
    const res = await fetch('/api/backtest', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run');
    const data = await res.json();
    box.innerHTML = data.results;
  } catch (err) {
    box.innerHTML = '❌ Backtest run failed. Verify your internet connection.';
  }
}

async function runOptimizer() {
  const box = document.getElementById('backtest-results');
  box.style.display = 'block';
  box.innerHTML = '🧠 Running dynamic Walkforward Grid Search ML optimization across NQ, ES, CL, GC...';

  try {
    const res = await fetch('/api/optimize', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run');
    const data = await res.json();
    box.innerHTML = data.results;
    updateDashboard();
  } catch (err) {
    box.innerHTML = '❌ Optimizer run failed.';
  }
}

// Helpers
function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

// Start Update Interval (run every 2 seconds for highly reactive dashboard)
setInterval(updateDashboard, 2000);
updateDashboard();
