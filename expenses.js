(() => {
  'use strict';
  const STORAGE_KEY = 'moneytracker_expenses';
  const STORAGE_KEY_BUDGETS = 'moneytracker_budgets';
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let state = { expenses: [], budgets: [] };
  let viewDate = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let editingId = null;
  let searchQ = '';
  let activeTab = 'expenses';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const genId = () => 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const genBudgetId = () => 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const fmtAmt = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const fmtDate = ds => { if (!ds) return ''; const d = new Date(ds + 'T00:00:00'); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
  const getDayParts = ds => {
    if (!ds) return { num: '', name: '', month: '' };
    const d = new Date(ds + 'T00:00:00');
    return {
      num: d.getDate(),
      name: d.toLocaleDateString('en-US', { weekday: 'long' }),
      month: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    };
  };
  const escHtml = s => { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; };

  /* ── PERSISTENCE ── */
  const save = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.expenses));
    localStorage.setItem(STORAGE_KEY_BUDGETS, JSON.stringify(state.budgets || []));
    if (window.db) {
      window.db.upsertDocument('moneytracker_data', { _id: 'expenses_state' }, {
        expenses: state.expenses,
        budgets: state.budgets || []
      });
    }
  };
  function load() {
    try {
      const r = localStorage.getItem(STORAGE_KEY);
      if (r) state.expenses = JSON.parse(r);
      const b = localStorage.getItem(STORAGE_KEY_BUDGETS);
      if (b) state.budgets = JSON.parse(b);
    } catch (e) { }

    if (window.db && window.db.isConfigured()) {
      window.db.fetchDocuments('moneytracker_data').then(docs => {
        if (!docs) return;
        const remoteInfo = docs.find(d => d._id === 'expenses_state');
        if (remoteInfo) {
          if (remoteInfo.expenses) state.expenses = remoteInfo.expenses;
          if (remoteInfo.budgets) state.budgets = remoteInfo.budgets;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.expenses));
          localStorage.setItem(STORAGE_KEY_BUDGETS, JSON.stringify(state.budgets || []));
          render();
        }
      });
    }
  }

  /* ── HELPERS ── */
  function monthExpenses() {
    const prefix = `${viewDate.year}-${String(viewDate.month + 1).padStart(2, '0')}`;
    return state.expenses.filter(e => e.date.startsWith(prefix));
  }

  /* ── STATS (follows viewDate, not hardcoded current month) ── */
  function updateStats() {
    const { year, month } = viewDate;
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const monthExp = state.expenses.filter(e => e.date.startsWith(prefix));
    const total = monthExp.reduce((s, e) => s + Number(e.amount), 0);

    // Determine number of days to use for average
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = isCurrentMonth ? now.getDate() : daysInMonth;
    const avg = days > 0 ? total / days : 0;

    // "Today" tile: if viewing current month, show today's spend; otherwise show the last day with expenses
    const todayLabel = $('#statTodayLabel');
    let todayTotal = 0;
    if (isCurrentMonth) {
      const today = todayStr();
      todayTotal = state.expenses.filter(e => e.date === today).reduce((s, e) => s + Number(e.amount), 0);
      if (todayLabel) todayLabel.textContent = 'Today';
    } else {
      // For past/future months, show the highest single-day spend
      const dailyMap = {};
      monthExp.forEach(e => { dailyMap[e.date] = (dailyMap[e.date] || 0) + Number(e.amount); });
      let maxDay = '', maxAmt = 0;
      Object.entries(dailyMap).forEach(([d, a]) => { if (a > maxAmt) { maxAmt = a; maxDay = d; } });
      todayTotal = maxAmt;
      if (todayLabel) todayLabel.textContent = maxDay ? `Peak (${fmtDate(maxDay)})` : 'Peak Day';
    }

    $('#statSpent').textContent = fmtAmt(total);
    $('#statToday').textContent = fmtAmt(todayTotal);
    $('#statAvg').textContent = fmtAmt(avg);
    $('#statCount').textContent = monthExp.length;
  }

  /* ── LINE CHART ── */
  function renderBarChart() {
    const { year, month } = viewDate;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = todayStr();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    const dailyTotals = Array.from({ length: daysInMonth }, (_, i) => {
      const d = `${prefix}-${String(i + 1).padStart(2, '0')}`;
      return { day: i + 1, total: state.expenses.filter(e => e.date === d).reduce((s, e) => s + Number(e.amount), 0), date: d };
    });

    const max = Math.max(...dailyTotals.map(d => d.total), 1);
    const svgEl = document.getElementById('lineChartSvg');
    const labelsEl = document.getElementById('lineChartLabels');
    const tooltip = document.getElementById('lineTooltip');
    if (!svgEl) return;

    const W = svgEl.clientWidth || 240;
    const H = 100;
    const padX = 4, padY = 24;
    const chartW = W - padX * 2;
    const chartH = H - padY * 2;
    const step = chartW / Math.max(daysInMonth - 1, 1);

    const pts = dailyTotals.map((d, i) => ({
      x: padX + i * step,
      y: padY + chartH - (d.total / max) * chartH,
      d
    }));

    function bezierPath(pts) {
      if (pts.length < 2) return `M${pts[0].x},${pts[0].y}`;
      let path = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], c = pts[i];
        const cx = (p.x + c.x) / 2;
        path += ` C ${cx.toFixed(1)},${p.y.toFixed(1)} ${cx.toFixed(1)},${c.y.toFixed(1)} ${c.x.toFixed(1)},${c.y.toFixed(1)}`;
      }
      return path;
    }

    const linePath = bezierPath(pts);
    const areaPath = linePath
      + ` L ${pts[pts.length - 1].x.toFixed(1)},${H} L ${pts[0].x.toFixed(1)},${H} Z`;

    const gradId = `lg_${month}_${year}`;
    const todayPt = pts.find(p => p.d.date === today);

    svgEl.innerHTML = `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#34d399" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#34d399" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${[0.25, 0.5, 0.75, 1].map(f => {
      const gy = (padY + chartH * (1 - f)).toFixed(1);
      return `<line x1="${padX}" y1="${gy}" x2="${(W - padX).toFixed(1)}" y2="${gy}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
    }).join('')}
      <path d="${areaPath}" fill="url(#${gradId})"/>
      <path d="${linePath}" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${todayPt ? `<line x1="${todayPt.x.toFixed(1)}" y1="${padY}" x2="${todayPt.x.toFixed(1)}" y2="${H}" stroke="var(--cyan)" stroke-width="1" stroke-dasharray="3,3" opacity="0.2"/>` : ''}
      
      <!-- Interactive Scrubbing Overlay -->
      <line id="scrubLine" y1="0" y2="${H}" stroke="var(--cyan)" stroke-width="1.5" stroke-dasharray="4,4" opacity="0" pointer-events="none" style="transition: opacity 0.2s;"/>
      <circle id="scrubDot" r="4.5" fill="var(--bg-deep)" stroke="var(--cyan)" stroke-width="2.5" opacity="0" pointer-events="none" style="transition: opacity 0.2s; filter: drop-shadow(0 0 6px var(--cyan));"/>
      <rect id="scrubOverlay" x="0" y="0" width="${W}" height="${H}" fill="transparent" style="cursor:crosshair;"/>
      
      <!-- Axis Labels -->
      ${pts.map(p => {
      const isT = p.d.date === today;
      const show = p.d.day === 1 || p.d.day === dailyTotals.length || isT;
      if (!show) return '';
      let anchor = 'middle';
      if (p.d.day === 1) anchor = 'start';
      else if (p.d.day === dailyTotals.length) anchor = 'end';
      const color = isT ? 'var(--cyan)' : 'var(--t4)';
      return `<text x="${p.x.toFixed(1)}" y="${H + 18}" text-anchor="${anchor}" fill="${color}" font-size="10" font-weight="700" font-family="'Outfit', sans-serif" style="pointer-events:none;">${p.d.day}</text>`;
    }).join('')}
    `;

    if (labelsEl) labelsEl.innerHTML = '';

    // Scrubbing Logic
    const overlay = svgEl.querySelector('#scrubOverlay');
    const scrubLine = svgEl.querySelector('#scrubLine');
    const scrubDot = svgEl.querySelector('#scrubDot');

    function updateScrub(e) {
      const rect = svgEl.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = clientX - rect.left;

      const scaleX = W / rect.width;
      const svgX = x * scaleX;

      let closest = pts[0];
      let minD = Infinity;
      pts.forEach(p => {
        const d = Math.abs(p.x - svgX);
        if (d < minD) { minD = d; closest = p; }
      });

      scrubLine.setAttribute('x1', closest.x.toFixed(1));
      scrubLine.setAttribute('x2', closest.x.toFixed(1));
      scrubLine.setAttribute('opacity', '0.6');

      scrubDot.setAttribute('cx', closest.x.toFixed(1));
      scrubDot.setAttribute('cy', closest.y.toFixed(1));
      scrubDot.setAttribute('opacity', '1');

      const wrap = document.getElementById('lineChartWrap');
      const wRect = wrap.getBoundingClientRect();

      tooltip.innerHTML = `<div style="font-size:0.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">${fmtDate(closest.d.date)}</div><div style="font-size:1.1rem;color:var(--cyan);">${fmtAmt(closest.d.total)}</div>`;
      tooltip.style.left = (rect.left - wRect.left + (closest.x / scaleX)) + 'px';
      tooltip.style.top = (rect.top - wRect.top + (closest.y / scaleX) - 15) + 'px';

      let shiftX = '-50%';
      if (closest.x < 50) shiftX = '0%';
      else if (closest.x > W - 50) shiftX = '-100%';
      tooltip.style.transform = `translate(${shiftX}, -100%)`;

      tooltip.classList.add('visible');
    }

    function hideScrub() {
      scrubLine.setAttribute('opacity', '0');
      scrubDot.setAttribute('opacity', '0');
      tooltip.classList.remove('visible');
    }

    overlay.addEventListener('mousemove', updateScrub);
    overlay.addEventListener('touchmove', e => { e.preventDefault(); updateScrub(e); }, { passive: false });
    overlay.addEventListener('mouseleave', hideScrub);
    overlay.addEventListener('touchend', hideScrub);
  }

  /* ── EXPENSE LIST ── */
  function renderList() {
    const { year, month } = viewDate;
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    let exps = state.expenses.filter(e => e.date.startsWith(prefix));
    if (searchQ) exps = exps.filter(e => e.desc.toLowerCase().includes(searchQ.toLowerCase()));

    const listEl = $('#expList');
    if (exps.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-state__icon">💸</div><h3 class="empty-state__title">No expenses</h3><p class="empty-state__text">No expenses recorded for this period.</p></div>`;
      return;
    }

    // Group by date
    const groups = {};
    exps.forEach(e => {
      if (!groups[e.date]) groups[e.date] = [];
      groups[e.date].push(e);
    });

    // Sort dates descending
    const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    listEl.innerHTML = sortedDates.map((dateStr, blockIdx) => {
      const dayExps = groups[dateStr];
      dayExps.sort((a, b) => b.id.localeCompare(a.id));
      const dayTotal = dayExps.reduce((s, e) => s + Number(e.amount), 0);
      const { num, name, month: mName } = getDayParts(dateStr);

      return `
        <div class="day-block" style="animation-delay:${blockIdx * 0.05}s">
          <div class="day-block__header">
            <div class="day-block__date">
              <span class="day-block__day-num">${num}</span>
              <div class="day-block__day-detail">
                <span class="day-block__day-name">${name}</span>
                <span class="day-block__month-name">${mName}</span>
              </div>
            </div>
          </div>
          <div class="day-block__items">
            ${dayExps.map(e => {
        return `
                <div class="day-block__item">
                  <div class="day-block__item-left">
                    <span class="day-block__item-desc">${escHtml(e.desc)}</span>
                  </div>
                  <div class="day-block__item-right">
                    <span class="day-block__item-amount">${fmtAmt(e.amount)}</span>
                    <div class="day-block__item-actions">
                      <button class="exp-action-btn" onclick="window.__editExp('${e.id}')">✏️</button>
                      <button class="exp-action-btn del" onclick="window.__deleteExp('${e.id}')">🗑️</button>
                    </div>
                  </div>
                </div>
              `;
      }).join('')}
          </div>
          <div class="day-block__footer">
            <span class="day-block__footer-label">Total</span>
            <span class="day-block__footer-total">${fmtAmt(dayTotal)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ── TAB SWITCHING ── */
  function switchTab(tab) {
    activeTab = tab;
    $$('.bottom-nav__item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));

    if (tab === 'insights') {
      setTimeout(() => {
        renderBarChart();
        updateStats();
      }, 50);
    } else if (tab === 'budget') {
      renderBudgetTab();
    }
  }

  /* ── MONTH NAVIGATION ── */
  function changeMonth(dir) {
    viewDate.month += dir;
    if (viewDate.month < 0) { viewDate.month = 11; viewDate.year--; }
    if (viewDate.month > 11) { viewDate.month = 0; viewDate.year++; }
    render();
  }

  /* ── FULL RENDER ── */
  function updateMonthLabels() {
    const label = `${MONTH_NAMES[viewDate.month]} ${viewDate.year}`;
    const el1 = $('#monthLabel');
    const el2 = $('#monthLabelInsight');
    if (el1) el1.textContent = label;
    if (el2) el2.textContent = label;
  }

  function render() {
    updateMonthLabels();
    updateStats();
    renderBarChart();
    renderList();
    renderBudgetTab();
  }

  /* ── MODAL ── */
  function openModal() {
    $('#expModal').classList.add('open');
  }

  function closeModal() {
    $('#expModal').classList.remove('open');
    editingId = null;
  }

  const createRowId = () => 'row_' + Math.random().toString(36).slice(2, 7);

  function addModalRow(desc = '', amount = '') {
    const listEl = document.getElementById('expModalList');
    if (!listEl) return;

    const rowId = createRowId();
    const row = document.createElement('div');
    row.className = 'modal-item-row';
    row.id = rowId;

    const isEdit = (editingId !== null);

    row.innerHTML = `
      <input class="modal__input row-desc" type="text" placeholder="Description" value="${escHtml(desc)}" required>
      <input class="modal__input row-amount" type="number" placeholder="0.00" min="0" step="0.01" value="${amount}" required>
      ${isEdit ? '<div style="width:32px"></div>' : `<button type="button" class="btn-remove-row" onclick="window.__removeModalRow('${rowId}')">✕</button>`}
    `;

    listEl.appendChild(row);

    const descInp = row.querySelector('.row-desc');
    const amtInp = row.querySelector('.row-amount');

    descInp.focus();

    descInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        amtInp.focus();
      }
    });

    amtInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!isEdit) {
          addModalRow();
        } else {
          saveExpense();
        }
      }
    });
  }

  window.__removeModalRow = rowId => {
    const row = document.getElementById(rowId);
    if (!row) return;

    const listEl = document.getElementById('expModalList');
    if (listEl.children.length > 1) {
      row.remove();
    } else {
      row.querySelector('.row-desc').value = '';
      row.querySelector('.row-amount').value = '';
    }
  };

  function saveExpense() {
    const rows = document.querySelectorAll('#expModalList .modal-item-row');
    const dateVal = $('#expDate').value || todayStr();

    let allValid = true;
    const itemsToSave = [];

    rows.forEach(row => {
      const descInp = row.querySelector('.row-desc');
      const amtInp = row.querySelector('.row-amount');
      const desc = descInp.value.trim();
      const amount = parseFloat(amtInp.value);

      if (!desc || isNaN(amount) || amount <= 0) {
        allValid = false;
        if (!desc) {
          descInp.style.boxShadow = 'var(--neu-in-sm),0 0 0 2px var(--red-dim)';
          setTimeout(() => descInp.style.boxShadow = '', 1500);
        }
        if (isNaN(amount) || amount <= 0) {
          amtInp.style.boxShadow = 'var(--neu-in-sm),0 0 0 2px var(--red-dim)';
          setTimeout(() => amtInp.style.boxShadow = '', 1500);
        }
      } else {
        itemsToSave.push({ desc, amount });
      }
    });

    if (!allValid) return;

    if (editingId) {
      const idx = state.expenses.findIndex(e => e.id === editingId);
      if (idx > -1) {
        state.expenses[idx] = {
          id: editingId,
          desc: itemsToSave[0].desc,
          amount: itemsToSave[0].amount,
          date: dateVal
        };
      }
    } else {
      itemsToSave.forEach(item => {
        state.expenses.unshift({
          id: genId(),
          desc: item.desc,
          amount: item.amount,
          date: dateVal
        });
      });
    }

    save();
    closeModal();
    render();
    if (window.showToast) {
      window.showToast(editingId ? 'Expense updated!' : 'Expenses saved!', 'success');
    }
  }

  window.__editExp = id => {
    editingId = id;
    const e = state.expenses.find(x => x.id === id); if (!e) return;
    $('#expModalTitle').textContent = 'Edit Expense';
    $('#expDate').value = e.date;
    $('#expModalList').innerHTML = '';
    $('#btnAddRow').style.display = 'none';
    addModalRow(e.desc, e.amount);
    openModal();
  };

  window.__deleteExp = id => {
    if (window.confirm && window.confirm('Delete this expense?') === false) return;
    state.expenses = state.expenses.filter(e => e.id !== id);
    save(); render();
  };

  /* ── SEQUENTIAL BUDGET CASCADE (FIFO) ── */
  function computeBudgetCascade() {
    if (!state.budgets || state.budgets.length === 0) {
      const totalSpent = state.expenses.reduce((s, e) => s + Number(e.amount), 0);
      return {
        budgets: [],
        activeBudget: null,
        pendingOverflow: totalSpent,
        hasBudgets: false
      };
    }

    // Clone and sort budgets chronologically: date asc, createdAt asc
    const budgets = state.budgets.map(b => ({
      id: b.id,
      amount: Number(b.amount),
      date: b.date,
      createdAt: b.createdAt || 0,
      spent: 0,
      remaining: Number(b.amount),
      isFinished: false,
      count: 0
    })).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // Clone and sort expenses chronologically: date asc, id asc
    const expenses = [...state.expenses].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.id.localeCompare(b.id);
    });

    let bIdx = 0;
    let pendingOverflow = 0;
    const pendingExpenses = [];

    for (const exp of expenses) {
      const amt = Number(exp.amount);
      if (isNaN(amt) || amt <= 0) continue;

      // Find the first budget with remaining balance > 0
      while (bIdx < budgets.length && budgets[bIdx].remaining <= 0) {
        budgets[bIdx].isFinished = true;
        bIdx++;
      }

      if (bIdx >= budgets.length) {
        // All existing budgets are finished! Any subsequent expense is pending overflow
        pendingOverflow += amt;
        pendingExpenses.push(exp);
        continue;
      }

      const curB = budgets[bIdx];
      if (curB.remaining >= amt) {
        curB.remaining = Math.max(0, curB.remaining - amt);
        curB.spent += amt;
        curB.count++;
        if (curB.remaining === 0) {
          curB.isFinished = true;
        }
      } else {
        // Partial fit: drains the rest of curB, curB finishes, and remainder moves to next budget
        const covered = curB.remaining;
        const leftover = amt - covered;
        curB.spent += covered;
        curB.remaining = 0;
        curB.isFinished = true;
        curB.count++;

        bIdx++;
        if (bIdx < budgets.length) {
          const nextB = budgets[bIdx];
          const nextCovered = Math.min(nextB.remaining, leftover);
          nextB.remaining = Math.max(0, nextB.remaining - nextCovered);
          nextB.spent += nextCovered;
          nextB.count++;
          if (nextB.remaining === 0) nextB.isFinished = true;

          const unabsorbed = leftover - nextCovered;
          if (unabsorbed > 0) {
            pendingOverflow += unabsorbed;
            pendingExpenses.push(exp);
          }
        } else {
          pendingOverflow += leftover;
          pendingExpenses.push(exp);
        }
      }
    }

    budgets.forEach(b => {
      if (b.remaining <= 0) b.isFinished = true;
    });

    // Active budget is the first non-finished budget, or if all are finished, the latest one
    const activeBudget = budgets.find(b => !b.isFinished) || (budgets.length > 0 ? budgets[budgets.length - 1] : null);

    return {
      budgets,
      activeBudget,
      pendingOverflow,
      pendingExpenses,
      hasBudgets: true
    };
  }

  /* ── BUDGET TAB RENDERING ── */
  function renderBudgetTab() {
    const displayEl = $('#budgetDisplay');
    if (!displayEl) return;

    const cascade = computeBudgetCascade();

    if (!cascade.hasBudgets) {
      displayEl.innerHTML = `
        <div class="empty-state" style="padding:36px 14px;">
          <div class="empty-state__icon">💰</div>
          <h3 class="empty-state__title">No Budget Added</h3>
          <p class="empty-state__text" style="max-width:300px;margin:0 auto 16px;font-size:0.82rem;">
            Add your budget amount. Daily expenses will count down from it and show your live remaining balance.
          </p>
          <button class="btn-primary" onclick="window.__openBudgetModal()" style="background:var(--grad-money);box-shadow:0 4px 18px var(--green-dim);margin:0 auto;">
            <span style="font-size:1.1rem;font-weight:300">＋</span><span> Add First Budget</span>
          </button>
        </div>
      `;
      return;
    }

    const { activeBudget, pendingOverflow, budgets } = cascade;
    let cardHtml = '';

    if (activeBudget) {
      const isFin = activeBudget.isFinished;
      const spent = activeBudget.spent;
      const total = activeBudget.amount;
      const rem = activeBudget.remaining;
      const remPct = total > 0 ? (rem / total) * 100 : 0;
      const spentPct = Math.min(100, Math.max(0, 100 - remPct));

      let tagClass = 'budget-card__tag--active';
      let tagText = 'Active Budget';
      let fillGradient = 'linear-gradient(90deg, #00d4ff, #34d399)';

      if (isFin) {
        tagClass = 'budget-card__tag--finished';
        tagText = 'Budget Finished';
        fillGradient = 'linear-gradient(90deg, #f87171, #ef4444)';
      } else if (remPct <= 20) {
        tagClass = 'budget-card__tag--low';
        tagText = 'Low Balance';
        fillGradient = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
      }

      cardHtml = `
        <div class="budget-card">
          <div class="budget-card__header">
            <span class="budget-card__tag ${tagClass}">
              <span>●</span> ${tagText}
            </span>
            <span class="budget-card__date">
              Added ${fmtDate(activeBudget.date)}
            </span>
          </div>

          <div class="budget-card__balance-label">
            ${isFin ? 'Remaining Balance (Exhausted)' : 'Remaining Balance'}
          </div>
          <div class="budget-card__balance-value" style="color:${isFin ? 'var(--red)' : (remPct <= 20 ? 'var(--orange)' : 'var(--green)')}">
            ${fmtAmt(rem)}
          </div>
          <div class="budget-card__balance-sub">
            ${fmtAmt(spent)} spent of ${fmtAmt(total)}
          </div>

          <div class="budget-progress-track">
            <div class="budget-progress-fill" style="width:${spentPct}%;background:${fillGradient};"></div>
          </div>

          <div class="budget-stats-grid">
            <div class="budget-stat-item">
              <span class="budget-stat-label">Budget</span>
              <span class="budget-stat-value">${fmtAmt(total)}</span>
            </div>
            <div class="budget-stat-item">
              <span class="budget-stat-label">Spent</span>
              <span class="budget-stat-value" style="color:var(--red);">${fmtAmt(spent)}</span>
            </div>
            <div class="budget-stat-item">
              <span class="budget-stat-label">Remaining</span>
              <span class="budget-stat-value" style="color:${isFin ? 'var(--t3)' : 'var(--green)'};">${fmtAmt(rem)}</span>
            </div>
          </div>
        </div>
      `;
    }

    let pendingHtml = '';
    if (pendingOverflow > 0) {
      pendingHtml = `
        <div class="budget-alert">
          <div class="budget-alert__icon">⏳</div>
          <div class="budget-alert__body">
            <div class="budget-alert__title">Pending Expenses: ${fmtAmt(pendingOverflow)}</div>
            <div class="budget-alert__text">
              These expenses were added after your previous budget hit zero. Once you add a new budget, this will be automatically counted and deducted from it.
            </div>
            <button class="btn-primary budget-alert__btn" onclick="window.__openBudgetModal()" style="background:var(--grad-money);">
              <span style="font-weight:300">＋</span><span> Add Next Budget</span>
            </button>
          </div>
        </div>
      `;
    }

    const reversedBudgets = [...budgets].reverse();
    let historyHtml = `
      <div class="budget-history-card">
        <div class="budget-history-title">
          <span>Budget History</span>
          <span class="budget-history-count">${budgets.length} total</span>
        </div>
        <div>
          ${reversedBudgets.map(b => `
            <div class="budget-history-item">
              <div class="budget-history-left">
                <span class="budget-history-amt">${fmtAmt(b.amount)}</span>
                <span class="budget-history-date">${fmtDate(b.date)} • ${b.isFinished ? 'Finished' : 'Active'}</span>
              </div>
              <div class="budget-history-right">
                <div class="budget-history-spent-wrap">
                  <span class="budget-history-spent-label">Spent</span>
                  <span class="budget-history-spent-val">${fmtAmt(b.spent)}</span>
                </div>
                <button class="btn-del-budget" title="Delete budget" onclick="window.__deleteBudget('${b.id}')">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    displayEl.innerHTML = cardHtml + pendingHtml + historyHtml;
  }

  /* ── BUDGET MODAL LOGIC ── */
  function openBudgetModal() {
    const cascade = computeBudgetCascade();
    const noticeEl = $('#budgetPendingNotice');
    if (noticeEl) {
      if (cascade.pendingOverflow > 0) {
        noticeEl.style.display = 'block';
        noticeEl.innerHTML = `⚠️ <strong>${fmtAmt(cascade.pendingOverflow)}</strong> in pending expenses will be deducted from this new budget.`;
      } else {
        noticeEl.style.display = 'none';
      }
    }
    const dateInp = $('#budgetDate');
    const amtInp = $('#budgetAmount');
    if (dateInp) dateInp.value = todayStr();
    if (amtInp) {
      amtInp.value = '';
      amtInp.style.boxShadow = '';
    }
    $('#budgetModal')?.classList.add('open');
    setTimeout(() => amtInp?.focus(), 150);
  }

  function closeBudgetModal() {
    $('#budgetModal')?.classList.remove('open');
  }

  function saveBudget() {
    const amtInp = $('#budgetAmount');
    const amt = parseFloat(amtInp?.value);
    const dateVal = $('#budgetDate')?.value || todayStr();

    if (isNaN(amt) || amt <= 0) {
      if (amtInp) {
        amtInp.style.boxShadow = 'var(--neu-in-sm),0 0 0 2px var(--red-dim)';
        setTimeout(() => amtInp.style.boxShadow = '', 1500);
      }
      return;
    }

    if (!state.budgets) state.budgets = [];
    state.budgets.push({
      id: genBudgetId(),
      amount: amt,
      date: dateVal,
      createdAt: Date.now()
    });

    save();
    closeBudgetModal();
    render();
    if (window.showToast) {
      window.showToast('Budget added!', 'success');
    }
  }

  function deleteBudget(id) {
    if (window.confirm && window.confirm('Delete this budget?') === false) return;
    state.budgets = (state.budgets || []).filter(b => b.id !== id);
    save();
    render();
    if (window.showToast) {
      window.showToast('Budget deleted', 'info');
    }
  }

  window.__openBudgetModal = openBudgetModal;
  window.__deleteBudget = deleteBudget;

  /* ── INIT ── */
  function init() {
    load();

    // Month nav — both tabs
    $('#prevMonth').addEventListener('click', () => changeMonth(-1));
    $('#nextMonth').addEventListener('click', () => changeMonth(1));
    $('#prevMonthInsight').addEventListener('click', () => changeMonth(-1));
    $('#nextMonthInsight').addEventListener('click', () => changeMonth(1));

    // Tab switching
    $$('.bottom-nav__item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    $('#btnAddExp').addEventListener('click', () => {
      editingId = null;
      $('#expModalTitle').textContent = 'Add Expense';
      $('#expDate').value = todayStr();
      $('#expModalList').innerHTML = '';
      $('#btnAddRow').style.display = 'inline-flex';
      addModalRow();
      openModal();
    });

    $('#btnAddRow').addEventListener('click', () => addModalRow());

    $('#expCancel').addEventListener('click', closeModal);
    $('#modalClose').addEventListener('click', closeModal);
    $('#expModal').addEventListener('click', e => { if (e.target === $('#expModal')) closeModal(); });
    $('#expSave').addEventListener('click', () => saveExpense());

    // Budget modal listeners
    $('#btnOpenAddBudget')?.addEventListener('click', openBudgetModal);
    $('#budgetCancel')?.addEventListener('click', closeBudgetModal);
    $('#budgetClose')?.addEventListener('click', closeBudgetModal);
    $('#budgetModal')?.addEventListener('click', e => { if (e.target === $('#budgetModal')) closeBudgetModal(); });
    $('#budgetSave')?.addEventListener('click', saveBudget);
    $('#budgetAmount')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBudget();
      }
    });

    $('#searchExp').addEventListener('input', e => { searchQ = e.target.value; renderList(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeModal();
        closeBudgetModal();
      }
    });

    // Listen for database unlock to pull fresh data
    window.addEventListener('moneytracker:db_unlocked', () => {
      load();
    });

    render();
  }

  window.reloadExpenses = load;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
