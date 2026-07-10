(() => {
  'use strict';
  const STORAGE_KEY = 'moneytracker_expenses';
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let state = { expenses: [] };
  let viewDate = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let editingId = null;
  let searchQ = '';
  let activeTab = 'expenses';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const genId = () => 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
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
    if (window.db) {
      window.db.upsertDocument('moneytracker_data', { _id: 'expenses_state' }, {
        expenses: state.expenses
      });
    }
  };
  function load() {
    try { const r = localStorage.getItem(STORAGE_KEY); if (r) state.expenses = JSON.parse(r); } catch (e) { }

    if (window.db && window.db.isConfigured()) {
      window.db.fetchDocuments('moneytracker_data').then(docs => {
        if (!docs) return;
        const remoteInfo = docs.find(d => d._id === 'expenses_state');
        if (remoteInfo) {
          if (remoteInfo.expenses) state.expenses = remoteInfo.expenses;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.expenses));
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

    // Re-render chart when switching to insights (needs visible container for width)
    if (tab === 'insights') {
      setTimeout(() => {
        renderBarChart();
        updateStats();
      }, 50);
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

    $('#searchExp').addEventListener('input', e => { searchQ = e.target.value; renderList(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
