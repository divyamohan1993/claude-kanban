var COLUMNS = [
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'todo', label: 'To Do' },
  { id: 'working', label: 'Working' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

var BP = window.__BASE_PATH__ || ''; // base path prefix (e.g. '/dashboard' when behind Nginx)
var userRole = 'public'; // 'public' | 'user' | 'admin'
var adminPath = '/admin'; // configurable via ADMIN_PATH env, returned in session for admins
var state = { cards: [] };
var dragCardId = null;
var queueInfo = { queue: [], active: [] };
var cardActivities = {};
var selectedCardId = null;
var pipelinePaused = false;
var boardMode = { mode: 'global', autoPromoteBrainstorm: true, discoveryRunning: false };

// Debounced render — coalesces rapid SSE updates into a single DOM repaint
var _renderTimer = null;
function debouncedRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(function() { _renderTimer = null; render(); }, 150);
}

var lastVisitTime = (function() {
  var t = localStorage.getItem('claude-kanban-last-visit');
  return t ? Number(t) : 0;
})();

var PIPELINE_STEPS = [
  { id: 'folder', label: 'Folder' },
  { id: 'spec', label: 'Spec' },
  { id: 'queue', label: 'Queue' },
  { id: 'snapshot', label: 'Snap' },
  { id: 'build', label: 'Build' },
  { id: 'review', label: 'Review' },
  { id: 'fix', label: 'Fix' },
  { id: 'approve', label: 'Approve' },
  { id: 'done', label: 'Done' },
];

var LABEL_CLASSES = {
  bug: 'label-bug', feature: 'label-feature', refactor: 'label-refactor',
  chore: 'label-chore', design: 'label-design', perf: 'label-perf',
  security: 'label-security', docs: 'label-docs',
};

// --- Helpers ---
function el(tag, attrs, children) {
  var e = document.createElement(tag);
  if (attrs) {
    for (var k of Object.keys(attrs)) {
      var v = attrs[k];
      if (k === 'className') e.className = v;
      else if (k === 'textContent') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
  }
  if (children) {
    var arr = Array.isArray(children) ? children : [children];
    for (var i = 0; i < arr.length; i++) {
      var child = arr[i];
      if (typeof child === 'string') e.appendChild(document.createTextNode(child));
      else if (child) e.appendChild(child);
    }
  }
  return e;
}

function btn(text, cls, handler, tooltip) {
  var attrs = { className: 'btn ' + cls, onClick: handler, textContent: text, title: tooltip || text };
  return el('button', attrs);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  var then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  var diff = Math.floor((Date.now() - then) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  return new Date(then).toLocaleDateString();
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  s = s % 60;
  if (m < 60) return m + 'm ' + s + 's';
  var h = Math.floor(m / 60);
  m = m % 60;
  return h + 'h ' + m + 'm';
}

function labelClass(label) {
  return LABEL_CLASSES[label.toLowerCase().trim()] || 'label-default';
}

// --- Auth (SSO — login handled by /auth/login, owned by SSO module) ---
function showLogin() {
  window.location.href = BP + '/auth/login?return=' + encodeURIComponent(location.pathname);
}

// Check session on load — always init the board (reads are open).
// Server controls what actions are available based on auth state.
// If not authenticated, server returns cards without actions — UI shows no buttons.
async function checkSession() {
  try {
    var res = await fetch(BP + '/auth/session');
    var data = await res.json();
    if (data.authenticated) {
      userRole = data.user.role || 'user';
      if (data.adminPath) adminPath = data.adminPath;
    } else {
      userRole = 'public';
    }
  } catch (_) {
    userRole = 'public';
  }
  applyRoleUI();
  init();
}

// Role-based UI — server decides actions, frontend decides chrome visibility
function applyRoleUI() {
  var isPublic = (userRole === 'public');
  var isAdmin = (userRole === 'admin');

  var searchEl = document.querySelector('.header-search');
  var statsEl = document.getElementById('header-stats');
  var pipelineEl = document.getElementById('pipeline-controls');
  var adminBtn = document.getElementById('admin-btn');
  var archiveBtn = document.getElementById('archive-btn');
  var addBtn = document.getElementById('add-btn');
  var signInBtn = document.getElementById('sign-in-btn');
  var signOutBtn = document.getElementById('sign-out-btn');

  if (searchEl) searchEl.style.display = isPublic ? 'none' : '';
  if (statsEl) statsEl.style.display = isPublic ? 'none' : '';
  if (pipelineEl) pipelineEl.style.display = isPublic ? 'none' : '';
  if (adminBtn) adminBtn.style.display = isAdmin ? '' : 'none';
  if (archiveBtn) archiveBtn.style.display = isPublic ? 'none' : '';
  if (addBtn) addBtn.style.display = isPublic ? 'none' : '';
  if (signInBtn) signInBtn.style.display = isPublic ? '' : 'none';
  if (signOutBtn) signOutBtn.style.display = isPublic ? 'none' : '';
}

// Sign In button redirects to SSO login page
(function() {
  var signInBtn = document.getElementById('sign-in-btn');
  if (signInBtn) {
    signInBtn.addEventListener('click', function() { showLogin(); });
  }
  var signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', function() {
      fetch(BP + '/auth/logout', { method: 'POST' }).finally(function() {
        window.location.reload();
      });
    });
  }
})();

// --- API ---
async function api(path, opts) {
  var res = await fetch(BP + '/api' + path, {
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Authentication required');
  }
  if (!res.ok) {
    var err = await res.json().catch(function() { return { error: 'Request failed' }; });
    var e = new Error(err.error || 'Request failed');
    e.code = err.code || null;
    e.data = err;
    throw e;
  }
  return res.json();
}

async function loadCards() {
  state.cards = await api('/cards');
  render();
}

// --- SSE ---
function connectSSE() {
  var es = new EventSource(BP + '/api/events');
  es.onerror = function() {
    es.close();
    setTimeout(function() {
      connectSSE();
      // Full state sync on reconnect — catch up on missed events
      loadCards();
      loadQueue();
    }, 3000);
  };

  function handleCard(e) {
    var card = JSON.parse(e.data);
    var idx = state.cards.findIndex(function(c) { return c.id === card.id; });
    if (idx >= 0) state.cards[idx] = card;
    else state.cards.push(card);
    debouncedRender();
    notifyCardEvent(card);
  }

  es.addEventListener('card-created', handleCard);
  es.addEventListener('card-updated', handleCard);
  es.addEventListener('card-moved', handleCard);

  es.addEventListener('card-deleted', function(e) {
    var data = JSON.parse(e.data);
    state.cards = state.cards.filter(function(c) { return c.id !== data.id; });
    debouncedRender();
  });

  es.addEventListener('card-activity', function(e) {
    var data = JSON.parse(e.data);
    if (data.step === null) delete cardActivities[data.cardId];
    else cardActivities[data.cardId] = data;
    updateCardActivity(data.cardId);
  });

  es.addEventListener('queue-update', function(e) {
    queueInfo = JSON.parse(e.data);
    debouncedRender();
  });

  es.addEventListener('pipeline-state', function(e) {
    var data = JSON.parse(e.data);
    pipelinePaused = data.paused;
    updatePipelineControls();
    debouncedRender();
  });

  es.addEventListener('config-updated', function(e) {
    state.config = JSON.parse(e.data);
    debouncedRender();
  });

  es.addEventListener('mode-updated', function(e) {
    try { boardMode = JSON.parse(e.data); applyModeUI(); debouncedRender(); } catch (_) {}
  });

  es.addEventListener('discovery-state', function(e) {
    try {
      var d = JSON.parse(e.data);
      boardMode.discoveryRunning = d.running;
      applyModeUI();
    } catch (_) {}
  });

  es.addEventListener('toast', function(e) {
    try { var d = JSON.parse(e.data); toast(d.message, d.type || 'info'); } catch (_) {}
  });

  es.addEventListener('error', function(e) {
    try { toast(JSON.parse(e.data).message, 'error'); } catch (_) {}
  });
}

// --- Desktop Notifications ---
var notifPermission = 'default';

function requestNotifPermission() {
  if (!('Notification' in window)) return;
  notifPermission = Notification.permission;
  if (notifPermission === 'default') {
    Notification.requestPermission().then(function(p) { notifPermission = p; });
  }
}

function notifyCardEvent(card) {
  if (notifPermission !== 'granted' || document.hasFocus()) return;
  var msg = null;
  if (card.status === 'complete' && card.column_name === 'done') {
    msg = 'Card completed: ' + card.title;
  } else if (card.status === 'interrupted') {
    msg = 'Build interrupted: ' + card.title;
  } else if (card.column_name === 'review' && card.status === 'idle' && card.review_score > 0) {
    msg = 'Needs review (' + card.review_score + '/10): ' + card.title;
  }
  if (msg) {
    try { new Notification('Claude Kanban', { body: msg, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">&#9670;</text></svg>' }); } catch (_) {}
  }
}

// --- Activity display helpers ---
function updateCardActivity(cardId) {
  var cardEl = document.querySelector('.card[data-id="' + cardId + '"]');
  if (!cardEl) return;
  var existing = cardEl.querySelector('.card-activity');
  var pipelineEl = cardEl.querySelector('.pipeline-steps');
  var activity = cardActivities[cardId];
  if (!activity || !activity.step) {
    if (existing) existing.remove();
    if (pipelineEl) pipelineEl.remove();
    return;
  }
  if (existing) existing.textContent = activity.detail;
  else {
    var metaEl = cardEl.querySelector('.card-meta');
    if (metaEl) {
      metaEl.parentNode.insertBefore(
        el('div', { className: 'card-activity', textContent: activity.detail }),
        metaEl.nextSibling
      );
    }
  }
  if (pipelineEl) renderPipelineInto(pipelineEl, activity.step, false);
}

// Pipeline step comes from server via card.display.pipelineStep — no frontend decisions
function getCompletedStep(card) {
  return card.display ? card.display.pipelineStep : null;
}

function renderPipelineInto(container, activeStep, completed) {
  container.textContent = '';
  var activeIdx = -1;
  for (var i = 0; i < PIPELINE_STEPS.length; i++) {
    if (PIPELINE_STEPS[i].id === activeStep) { activeIdx = i; break; }
  }
  for (var j = 0; j < PIPELINE_STEPS.length; j++) {
    var step = PIPELINE_STEPS[j];
    var cls = 'pip-step';
    if (completed) cls += ' pip-done';
    else if (j < activeIdx) cls += ' pip-done';
    else if (j === activeIdx) cls += ' pip-active';
    container.appendChild(el('div', { className: cls, title: step.label }));
  }
}

function renderPipeline(card) {
  var activity = cardActivities[card.id];
  var disp = card.display || {};
  var activeStep = activity ? activity.step : disp.pipelineStep;
  if (!activeStep) return null;
  var completed = !!disp.pipelineComplete;
  var container = el('div', { className: 'pipeline-steps' });
  renderPipelineInto(container, activeStep, completed);
  return container;
}

// --- Trend Sparklines ---
var trendData = null;

function loadTrends() {
  fetch(BP + '/api/trends').then(function(r) { return r.json(); }).then(function(data) {
    trendData = data;
    renderStats();
  }).catch(function() {});
}

function makeSparkline(values) {
  var filtered = [];
  for (var fi = 0; fi < values.length; fi++) {
    if (values[fi] !== null) filtered.push(values[fi]);
  }
  var max = Math.max.apply(null, filtered.concat([1]));
  var container = el('span', { className: 'sparkline', title: 'Last 8 weeks' });
  for (var si = 0; si < values.length; si++) {
    var val = values[si];
    var height = val !== null && val > 0 ? Math.max(2, Math.round(val / max * 18)) : 0;
    container.appendChild(el('span', { className: 'sparkline-bar' + (height === 0 ? ' empty' : ''), style: 'height:' + (height || 2) + 'px' }));
  }
  return container;
}

// --- Stats ---
function renderStats() {
  var container = document.getElementById('header-stats');
  if (!container) return;
  container.textContent = '';
  var total = state.cards.length;
  var active = queueInfo.active ? queueInfo.active.length : 0;
  var queued = queueInfo.queue ? queueInfo.queue.length : 0;
  var doneCount = state.cards.filter(function(c) { return c.column_name === 'done'; }).length;

  function chip(label, value, cls) {
    return el('div', { className: 'stat-chip' + (cls ? ' ' + cls : '') }, [
      el('span', { className: 'stat-value', textContent: String(value) }),
      el('span', { className: 'stat-label', textContent: label }),
    ]);
  }
  container.appendChild(chip('Total', total));
  if (pipelinePaused) container.appendChild(chip('Paused', '', 'stat-paused'));
  if (active > 0) container.appendChild(chip('Active', active, 'stat-active'));
  if (queued > 0) container.appendChild(chip('Queued', queued, 'stat-queued'));
  container.appendChild(chip('Done', doneCount, 'stat-done'));
  if (trendData) {
    if (trendData.weeklyCompletions) {
      container.appendChild(makeSparkline(trendData.weeklyCompletions));
    }
    if (trendData.successRate !== undefined) {
      container.appendChild(chip(trendData.successRate + '% pass', '', 'stat-done'));
    }
  }
}

// --- Render ---
function render() {
  renderStats();
  var board = document.getElementById('board');
  board.textContent = '';
  for (var ci = 0; ci < COLUMNS.length; ci++) {
    var col = COLUMNS[ci];
    var colCards = state.cards.filter(function(c) { return c.column_name === col.id; });
    if (col.id === 'done') {
      colCards.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
      if (state.config && state.config.runtime && state.config.runtime.maxDoneVisible > 0) {
        colCards = colCards.slice(0, state.config.runtime.maxDoneVisible);
      }
    }
    board.appendChild(renderColumn(col, colCards));
  }
}

function renderColumn(col, colCards) {
  var colEl = el('div', { className: 'column', 'data-col': col.id });
  var toggleArrow = el('span', { className: 'column-toggle', textContent: '\u25BC', 'aria-hidden': 'true' });
  var header = el('div', { className: 'column-header', role: 'button', tabindex: '0', 'aria-label': col.label + ' column, ' + colCards.length + ' cards. Click to collapse or expand.' }, [
    el('div', { className: 'column-dot' }),
    el('h2', { textContent: col.label }),
    el('span', { className: 'card-count', textContent: String(colCards.length) }),
    toggleArrow,
  ]);
  header.addEventListener('click', function() {
    colEl.classList.toggle('collapsed');
    toggleArrow.textContent = colEl.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
  });
  header.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
  });
  colEl.appendChild(header);

  var list = el('div', { className: 'card-list', 'data-col': col.id });
  list.addEventListener('dragover', function(e) { e.preventDefault(); list.classList.add('drag-over'); });
  list.addEventListener('dragleave', function() { list.classList.remove('drag-over'); });
  list.addEventListener('drop', function(e) {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (dragCardId != null) { moveCard(dragCardId, col.id); dragCardId = null; }
  });

  // Group cards: standalone cards first, then initiative sub-task groups
  var standalone = [];
  var initiativeGroups = {}; // parentId -> [cards]
  for (var i = 0; i < colCards.length; i++) {
    var disp = colCards[i].display || {};
    if (disp.initiativeId) {
      if (!initiativeGroups[disp.initiativeId]) initiativeGroups[disp.initiativeId] = [];
      initiativeGroups[disp.initiativeId].push(colCards[i]);
    } else {
      standalone.push(colCards[i]);
    }
  }

  // Render standalone cards
  for (var si = 0; si < standalone.length; si++) {
    list.appendChild(renderCard(standalone[si]));
  }

  // Render initiative groups with visual connectors
  var groupIds = Object.keys(initiativeGroups);
  for (var gi = 0; gi < groupIds.length; gi++) {
    var groupCards = initiativeGroups[groupIds[gi]];
    var parentTitle = groupCards[0].display.parentTitle || 'Initiative #' + groupIds[gi];

    var group = el('div', { className: 'initiative-group' });
    group.appendChild(el('div', { className: 'initiative-group-header' }, [
      el('span', { className: 'initiative-group-dot' }),
      el('span', { className: 'initiative-group-label', textContent: parentTitle }),
    ]));

    for (var ci = 0; ci < groupCards.length; ci++) {
      var isLast = (ci === groupCards.length - 1);
      var wrapper = el('div', { className: 'initiative-card-wrapper' + (isLast ? ' last' : '') });
      wrapper.appendChild(renderCard(groupCards[ci]));
      group.appendChild(wrapper);
    }

    list.appendChild(group);
  }

  colEl.appendChild(list);
  return colEl;
}

function renderCard(card) {
  var isAuthed = (userRole !== 'public');
  var cardEl = el('div', {
    className: 'card' + (card.id === selectedCardId ? ' card-selected' : ''),
    draggable: isAuthed ? 'true' : 'false',
    'data-id': card.id,
    tabindex: '0',
    role: 'article',
    'aria-label': 'Card ' + card.id + ': ' + card.title,
  });
  if (isAuthed) cardEl.addEventListener('dragstart', function() { dragCardId = card.id; cardEl.classList.add('dragging'); });
  cardEl.addEventListener('dragend', function() { cardEl.classList.remove('dragging'); dragCardId = null; });
  // Enter key on card opens detail
  cardEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') showDetail(card); });

  cardEl.appendChild(el('div', { className: 'card-accent' }));

  var titleRow = el('div', { className: 'card-title-row', style: 'cursor:pointer' }, [
    el('span', { className: 'card-id', textContent: '#' + card.id }),
    el('span', { className: 'card-title', textContent: card.title }),
  ]);
  titleRow.addEventListener('click', function() { showDetail(card); });
  cardEl.appendChild(titleRow);

  if (card.description) {
    cardEl.appendChild(el('div', { className: 'card-desc', textContent: card.description }));
  }

  // Labels
  if (card.labels) {
    var labelsDiv = el('div', { className: 'card-labels' });
    card.labels.split(',').forEach(function(l) {
      l = l.trim();
      if (l) labelsDiv.appendChild(el('span', { className: 'label-chip ' + labelClass(l), textContent: l }));
    });
    if (labelsDiv.children.length) cardEl.appendChild(labelsDiv);
  }

  if (card.project_path) {
    cardEl.appendChild(el('div', {
      className: 'card-path',
      textContent: card.project_path.replace(/\\/g, '/').replace(/^R:\//i, ''),
      title: card.project_path,
    }));
  }

  // Badges — rendered from server-computed card.display (zero frontend decisions)
  var meta = el('div', { className: 'card-meta' });
  var disp = card.display || {};
  var badges = disp.badges || [];
  for (var bi = 0; bi < badges.length; bi++) {
    var badge = badges[bi];
    if (badge.spinner) meta.appendChild(el('span', { className: 'spinner' }));
    meta.appendChild(el('span', { className: 'card-badge badge-' + badge.type, textContent: badge.text }));
  }

  // Review score — server-computed display type
  if (disp.reviewScore) {
    meta.appendChild(el('span', { className: 'review-score review-score-' + disp.reviewScore.type, textContent: disp.reviewScore.value + '/10' }));
  }

  // Approval badge — server-computed
  if (disp.approval) {
    var abCls = disp.approval.type === 'human' ? 'approved-human' : 'approved-ai';
    meta.appendChild(el('span', { className: 'approved-badge ' + abCls, textContent: disp.approval.type === 'human' ? 'Human Approved' : 'AI Approved' }));
  }

  // Trust level badge — server-computed
  if (disp.trustLevel) {
    meta.appendChild(el('span', { className: 'trust-badge trust-' + disp.trustLevel, textContent: disp.trustLevel }));
  }

  if (meta.children.length) cardEl.appendChild(meta);

  // Review breakdown — server-computed category details
  if (disp.reviewBreakdown) {
    var breakdownContainer = el('div', { className: 'review-breakdown' });
    var cats = Object.keys(disp.reviewBreakdown);
    for (var rbi = 0; rbi < cats.length; rbi++) {
      var catData = disp.reviewBreakdown[cats[rbi]];
      var catClass = 'review-cat';
      if (catData.critical > 0) catClass += ' has-critical';
      else if (catData.warning > 0) catClass += ' has-warning';
      breakdownContainer.appendChild(el('span', { className: catClass, textContent: cats[rbi] + ':' + catData.total }));
    }
    if (breakdownContainer.children.length) cardEl.appendChild(breakdownContainer);
  }

  // Failure summary — server-computed
  if (disp.failureSummary) {
    cardEl.appendChild(el('div', { className: 'failure-summary', textContent: disp.failureSummary }));
  }

  if (lastVisitTime > 0 && card.created_at) {
    var cardCreated = new Date(card.created_at.replace(' ', 'T') + 'Z').getTime();
    if (cardCreated > lastVisitTime) {
      meta.appendChild(el('span', { className: 'card-badge badge-new', textContent: 'NEW' }));
    }
  }

  if (card.updated_at) {
    meta.appendChild(el('span', { className: 'card-timestamp', textContent: timeAgo(card.updated_at) }));
  }

  // Duration
  if (card.phase_durations) {
    try {
      var pd = JSON.parse(card.phase_durations);
      var parts = [];
      if (pd.brainstorm && pd.brainstorm.duration) parts.push('spec ' + formatDuration(pd.brainstorm.duration));
      if (pd.build && pd.build.duration) parts.push('build ' + formatDuration(pd.build.duration));
      if (pd.review && pd.review.duration) parts.push('review ' + formatDuration(pd.review.duration));
      if (parts.length > 0) {
        cardEl.appendChild(el('div', { className: 'card-duration', textContent: parts.join(' · ') }));
      }
    } catch (_) {}
  }

  var pipeline = renderPipeline(card);
  if (pipeline) cardEl.appendChild(pipeline);

  var activity = cardActivities[card.id];
  if (activity && activity.detail) {
    cardEl.appendChild(el('div', { className: 'card-activity', textContent: activity.detail }));
  }

  // Actions — server decides what buttons to show via card.actions array
  var actions = el('div', { className: 'card-actions' });
  var id = card.id;
  var ca = card.actions || [];

  // Info button — only for authenticated users (public sees no interactive elements)
  if (isAuthed) {
    actions.appendChild(btn('Info', 'btn-sm btn-ghost btn-info', function() { showDetail(card); }, 'View full card details, spec, and logs'));
  }

  // Action button map — server says which ones, we just render them
  var ACTION_MAP = {
    'detect-project': ['Detect', 'btn-sm btn-ghost', function() { doDetect(id); }, 'Find or create a project folder'],
    'brainstorm': ['Brainstorm', 'btn-sm btn-primary', function() { doBrainstorm(id); }, 'AI generates a detailed spec'],
    're-brainstorm': ['Re-brainstorm', 'btn-sm btn-ghost', function() { doBrainstorm(id); }, 'Regenerate the spec'],
    'move-to-todo': ['Move to Todo', 'btn-sm btn-ghost', function() { api('/cards/' + id + '/move', { method: 'POST', body: { column: 'todo', source: 'human' } }).catch(function(e) { toast(e.message, 'error'); }); }, 'Move card to Todo column'],
    'start-work': ['Start', 'btn-sm btn-primary', function() { doStartWork(id); }, 'Queue AI to build this project'],
    'retry': ['Retry', 'btn-sm btn-primary', function() { doStartWork(id); }, 'Retry the build'],
    'cancel-queue': ['Cancel', 'btn-sm btn-ghost', function() { doCancelQueue(id); }, 'Remove from build queue'],
    'stop': ['Stop', 'btn-sm btn-danger', function() { doStopCard(id); }, 'Stop this build immediately'],
    'approve': ['Approve', 'btn-sm btn-primary', function() { doApprove(id); }, 'Approve, update changelog, and git commit'],
    'reject': ['Reject', 'btn-sm btn-ghost', function() { doReject(id); }, 'Reject and rollback file changes'],
    'revert': ['Revert', 'btn-sm btn-ghost', function() { doRevert(id); }, 'Revert files to pre-build state'],
    'discard': ['Discard', 'btn-sm btn-ghost', function() { deleteCard(id); }, 'Permanently delete this card'],
    'delete': ['Delete', 'btn-sm btn-ghost', function() { deleteCard(id); }, 'Delete this card'],
    'edit': ['Edit', 'btn-sm btn-ghost', function() { editCard(id); }, 'Edit card title and description'],
    'edit-spec': ['Spec', 'btn-sm btn-ghost', function() { showDetail(card); }, 'View and edit specification'],
    'feedback': ['Feedback', 'btn-sm btn-ghost', function() { setIdeaFeedbackMode(id, card.title); }, 'Give feedback to refine this card'],
    'retry-with-feedback': ['Feedback', 'btn-sm btn-ghost', function() {
      var fb = prompt('What should be fixed specifically?');
      if (!fb) return;
      api('/cards/' + id + '/retry', { method: 'POST', body: { feedback: fb } })
        .then(function() { toast('Retry with feedback started', 'success'); })
        .catch(function(e) { toast(e.message, 'error'); });
    }, 'Retry with specific instructions'],
    'archive': ['Archive', 'btn-sm btn-ghost', function() {
      api('/cards/' + id + '/move', { method: 'POST', body: { column: 'archive', source: 'human' } })
        .then(function() { toast('Archived', 'success'); })
        .catch(function(e) { toast(e.message, 'error'); });
    }, 'Move to archive'],
    'preview': ['Preview', 'btn-sm btn-ghost', function() { doPreview(id); }, 'Run the project and preview it'],
    'diff': ['Diff', 'btn-sm btn-ghost', function() { showDiff(id); }, 'View file changes'],
    'view-findings': ['Findings', 'btn-sm btn-ghost', function() { showFindings(id); }, 'View AI review findings'],
    'view-log': ['Log', 'btn-sm btn-ghost btn-log', function() { showLiveLog(id, 'build'); }, 'Watch live build output'],
    'view-fix-log': ['Log', 'btn-sm btn-ghost btn-log', function() { showLiveLog(id, 'review-fix'); }, 'Watch auto-fix output'],
    'unarchive': ['Unarchive', 'btn-sm btn-ghost', function() { api('/cards/' + id + '/unarchive', { method: 'POST' }).then(function() { loadCards(); toast('Unarchived', 'success'); }).catch(function(e) { toast(e.message, 'error'); }); }, 'Restore from archive'],
    'promote': ['Promote', 'btn-sm btn-primary', function() { doPromote(id); }, 'Approve and decompose into tasks'],
    'approve-spec': ['Approve Spec', 'btn-sm btn-success', function() { api('/cards/' + id + '/approve-spec', { method: 'POST' }).then(loadCards).catch(function(e) { toast(e.message, 'error'); }); }, 'Approve spec and move to Todo'],
  };

  if (isAuthed) {
    for (var ai = 0; ai < ca.length; ai++) {
      var def = ACTION_MAP[ca[ai]];
      if (def) actions.appendChild(btn(def[0], def[1], def[2], def[3]));
    }
  }

  if (actions.childNodes.length > 0) cardEl.appendChild(actions);
  return cardEl;
}

// --- Folder Detection ---
var folderModal = document.getElementById('folder-modal');
var pendingFolderCardId = null;
var pendingFolderAction = null;

document.getElementById('folder-close').addEventListener('click', function() { folderModal.classList.remove('active'); });
folderModal.addEventListener('click', function(e) { if (e.target === folderModal) folderModal.classList.remove('active'); });

async function doDetect(id, thenAction) {
  pendingFolderCardId = id;
  pendingFolderAction = thenAction || null;
  var card = state.cards.find(function(c) { return c.id === id; });
  if (!card) return;

  document.getElementById('folder-modal-title').textContent = 'Select Folder: ' + card.title;
  document.getElementById('folder-desc').textContent = 'Searching for matching project folders...';
  var matchesDiv = document.getElementById('folder-matches');
  var newDiv = document.getElementById('folder-new');
  matchesDiv.textContent = '';
  newDiv.textContent = '';
  folderModal.classList.add('active');

  try {
    var result = await api('/cards/' + id + '/detect', { method: 'POST' });
    var root = result.projectsRoot || '';
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';

    if (result.matches.length > 0) {
      document.getElementById('folder-desc').textContent = 'Found ' + result.matches.length + ' matching folder(s):';
      for (var i = 0; i < result.matches.length; i++) {
        (function(match) {
          matchesDiv.appendChild(el('div', { className: 'folder-match' }, [
            el('span', { className: 'folder-match-name', textContent: match.name }),
            el('span', { className: 'folder-match-info', textContent: match.files + ' files | score: ' + match.score }),
            btn('Use', 'btn-sm btn-primary', function() { selectFolder(match.path); }),
          ]));
        })(result.matches[i]);
      }
    } else {
      document.getElementById('folder-desc').textContent = 'No matching folders found in ' + root;
    }

    var newPath = root + sep + result.suggestedName;
    newDiv.appendChild(btn('Create: ' + result.suggestedName, 'btn-sm btn-ghost', function() { selectFolder(newPath); }));
    newDiv.appendChild(btn('Skip', 'btn-sm btn-ghost', function() {
      folderModal.classList.remove('active');
      if (pendingFolderAction === 'brainstorm') startBrainstorm(pendingFolderCardId);
    }));
  } catch (e) {
    document.getElementById('folder-desc').textContent = 'Detection failed: ' + e.message;
  }
}

async function selectFolder(projectPath) {
  folderModal.classList.remove('active');
  await api('/cards/' + pendingFolderCardId + '/assign-folder', { method: 'POST', body: { projectPath: projectPath } });
  toast('Folder assigned', 'success');
  await loadCards();
  if (pendingFolderAction === 'brainstorm') startBrainstorm(pendingFolderCardId);
}

// --- Actions ---
async function doBrainstorm(id) {
  // Always ask server — server decides if project path is needed
  try {
    await api('/cards/' + id + '/brainstorm', { method: 'POST' });
    toast('Brainstorming started', 'success');
  } catch (e) {
    if (e.code === 'NEEDS_PROJECT') {
      // Server says project path required — show folder detection
      doDetect(id, 'brainstorm');
    } else if (e.code === 'BRAINSTORM_BLOCKED') {
      toast(e.message || 'Brainstorm blocked — complete current initiative first', 'warning');
    } else {
      toast(e.message || 'Brainstorm failed', 'error');
    }
  }
}

async function startBrainstorm(id) {
  try {
    toast('Brainstorming started...', 'info');
    await api('/cards/' + id + '/brainstorm', { method: 'POST' });
  } catch (e) { toast(e.message, 'error'); }
}

async function doStartWork(id) {
  try {
    await api('/cards/' + id + '/start-work', { method: 'POST' });
    toast('Queued for build', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function doCancelQueue(id) {
  try {
    await api('/cards/' + id + '/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ column: 'todo', source: 'human' }) });
    toast('Removed from queue', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function doOpenVSCode(id) { api('/cards/' + id + '/open-vscode', { method: 'POST' }).then(function() { toast('Opening VS Code...', 'success'); }).catch(function(e) { toast('VSCode: ' + e.message, 'error'); }); }
function doOpenTerminal(id) { api('/cards/' + id + '/open-terminal', { method: 'POST' }).then(function() { toast('Opening terminal...', 'success'); }).catch(function(e) { toast('Terminal: ' + e.message, 'error'); }); }
function doOpenClaude(id) { api('/cards/' + id + '/open-claude', { method: 'POST' }).then(function() { toast('Opening Claude...', 'success'); }).catch(function(e) { toast('Claude: ' + e.message, 'error'); }); }

async function doStopCard(id) {
  if (!confirm('Stop this build immediately?')) return;
  try {
    var result = await api('/cards/' + id + '/stop', { method: 'POST' });
    toast(result.stopped ? 'Build stopped.' : 'Not active: ' + (result.reason || ''), result.stopped ? 'warning' : 'info');
  } catch (e) { toast(e.message, 'error'); }
}

async function doApprove(id) {
  await api('/cards/' + id + '/approve', { method: 'POST' });
  toast('Approved!', 'success');
}

async function doReject(id) {
  var reason = prompt('Why are you rejecting? (helps the AI learn your preferences)\n\nLeave blank to skip, or type your reason:');
  if (reason === null) return; // user clicked Cancel
  try {
    var result = await api('/cards/' + id + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' }),
    });
    toast(result.rollback && result.rollback.success ? 'Rejected! Files rolled back.' : 'Rejected.', 'info');
  } catch (e) { toast(e.message, 'error'); }
}

async function doRevert(id) {
  if (!confirm('Revert files to pre-work state?')) return;
  try {
    var result = await api('/cards/' + id + '/revert-files', { method: 'POST' });
    toast(result.success ? 'Files reverted.' : 'Revert failed: ' + (result.reason || ''), result.success ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}

async function doPreview(id) {
  try {
    var result = await api('/cards/' + id + '/preview', { method: 'POST' });
    toast('Running: ' + result.command, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function doPromote(id) {
  try {
    toast('Promoting brainstorm — decomposing into tasks...', 'info');
    await api('/cards/' + id + '/promote', { method: 'POST' });
    toast('Promoted! Child tasks being created.', 'success');
    await loadCards();
  } catch (e) { toast(e.message, 'error'); }
}

async function moveCard(id, column) {
  await api('/cards/' + id + '/move', { method: 'POST', body: { column: column, source: 'human' } });
}

async function deleteCard(id) {
  if (!confirm('Delete this card?')) return;
  await api('/cards/' + id, { method: 'DELETE' });
  toast('Card deleted.', 'info');
}

// --- Card Modal ---
var cardModal = document.getElementById('card-modal');
var cardForm = document.getElementById('card-form');

// add-btn now wired in idea modal section above

document.getElementById('modal-close').addEventListener('click', function() { cardModal.classList.remove('active'); });
document.getElementById('modal-cancel').addEventListener('click', function() { cardModal.classList.remove('active'); });
cardModal.addEventListener('click', function(e) { if (e.target === cardModal) cardModal.classList.remove('active'); });

function editCard(id) {
  var card = state.cards.find(function(c) { return c.id === id; });
  if (!card) return;
  document.getElementById('card-id').value = card.id;
  document.getElementById('card-title').value = card.title;
  document.getElementById('card-desc').value = card.description || '';
  document.getElementById('card-labels').value = card.labels || '';
  document.getElementById('modal-title').textContent = 'Edit Card';
  cardModal.classList.add('active');
  document.getElementById('card-title').focus();
}

cardForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  var id = document.getElementById('card-id').value;
  var title = document.getElementById('card-title').value.trim();
  var description = document.getElementById('card-desc').value.trim();
  var labels = document.getElementById('card-labels').value.trim();
  if (!title) return;
  try {
    if (id) {
      await api('/cards/' + id, { method: 'PUT', body: { title: title, description: description } });
      if (labels !== undefined) await api('/cards/' + id + '/labels', { method: 'PUT', body: { labels: labels } });
      cardModal.classList.remove('active');
      await loadCards();
    } else {
      var newCard = await api('/cards', { method: 'POST', body: { title: title, description: description } });
      if (labels) await api('/cards/' + newCard.id + '/labels', { method: 'PUT', body: { labels: labels } });
      cardModal.classList.remove('active');
      await loadCards();
      doDetect(newCard.id, 'brainstorm');
    }
  } catch (err) { toast(err.message, 'error'); }
});

// --- Detail Modal ---
var detailModal = document.getElementById('detail-modal');
document.getElementById('detail-close').addEventListener('click', function() {
  detailModal.classList.remove('active');
  if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }
});
detailModal.addEventListener('click', function(e) {
  if (e.target === detailModal) {
    detailModal.classList.remove('active');
    if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }
  }
});

function showDetail(card) {
  document.getElementById('detail-title').textContent = card.title;
  var body = document.getElementById('detail-body');
  body.textContent = '';

  function addSection(title, content) {
    if (!content) return;
    var sec = el('div', { className: 'detail-section' });
    sec.appendChild(el('h3', { textContent: title }));
    sec.appendChild(el('pre', { textContent: content }));
    body.appendChild(sec);
  }

  addSection('Description', card.description);

  // Editable spec
  if (card.spec) {
    var specSec = el('div', { className: 'detail-section' });
    specSec.appendChild(el('h3', { textContent: 'Specification' }));
    var specArea = el('textarea', { className: 'spec-editor', value: card.spec });
    specArea.value = card.spec;
    specSec.appendChild(specArea);
    var specActions = el('div', { style: 'display:flex;gap:6px;margin-top:6px' });
    specActions.appendChild(btn('Save Spec', 'btn-sm btn-primary', async function() {
      try {
        await api('/cards/' + card.id + '/spec', { method: 'PUT', body: { spec: specArea.value } });
        toast('Spec saved', 'success');
        card.spec = specArea.value;
      } catch (err) { toast(err.message, 'error'); }
    }));
    specActions.appendChild(btn('Build with this Spec', 'btn-sm btn-ghost', async function() {
      try {
        await api('/cards/' + card.id + '/spec', { method: 'PUT', body: { spec: specArea.value } });
        await api('/cards/' + card.id + '/start-work', { method: 'POST' });
        toast('Build started with updated spec', 'success');
        detailModal.classList.remove('active');
      } catch (err) { toast(err.message, 'error'); }
    }));
    specSec.appendChild(specActions);
    body.appendChild(specSec);
  }

  addSection('Session Log', card.session_log);

  // Labels editor
  var labelSec = el('div', { className: 'detail-section' });
  labelSec.appendChild(el('h3', { textContent: 'Labels' }));
  var labelInput = el('input', { type: 'text', value: card.labels || '', placeholder: 'bug, feature, design...' });
  labelInput.value = card.labels || '';
  labelInput.addEventListener('change', async function() {
    try {
      await api('/cards/' + card.id + '/labels', { method: 'PUT', body: { labels: labelInput.value } });
      toast('Labels updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  labelSec.appendChild(labelInput);
  body.appendChild(labelSec);

  // Dependencies editor
  var depSec = el('div', { className: 'detail-section' });
  depSec.appendChild(el('h3', { textContent: 'Dependencies (comma-separated card IDs)' }));
  var depInput = el('input', { type: 'text', value: card.depends_on || '', placeholder: '1, 5, 12...' });
  depInput.value = card.depends_on || '';
  depInput.addEventListener('change', async function() {
    try {
      await api('/cards/' + card.id + '/depends-on', { method: 'PUT', body: { dependsOn: depInput.value } });
      toast('Dependencies updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  depSec.appendChild(depInput);
  body.appendChild(depSec);

  // Info
  var info = 'Status: ' + card.status + '\nColumn: ' + card.column_name + '\nCreated: ' + card.created_at + '\nUpdated: ' + card.updated_at;
  if (card.review_score > 0) info += '\nReview Score: ' + card.review_score + '/10';
  if (card.approved_by) info += '\nApproved By: ' + (card.approved_by === 'human' ? 'Human' : 'AI Auto-Approve');
  if (card.phase_durations) {
    try {
      var pd = JSON.parse(card.phase_durations);
      var dparts = [];
      if (pd.brainstorm && pd.brainstorm.duration) dparts.push('Brainstorm: ' + formatDuration(pd.brainstorm.duration));
      if (pd.build && pd.build.duration) dparts.push('Build: ' + formatDuration(pd.build.duration));
      if (pd.review && pd.review.duration) dparts.push('Review: ' + formatDuration(pd.review.duration));
      if (dparts.length) info += '\nDurations: ' + dparts.join(', ');
    } catch (_) {}
  }
  addSection('Info', info);

  // Project actions
  if (card.project_path) {
    var acts = el('div', { className: 'detail-actions' });
    acts.appendChild(btn('View Diff', 'btn-sm btn-ghost', function() { detailModal.classList.remove('active'); showDiff(card.id); }));
    body.appendChild(acts);
  }

  // Retry with feedback — shown when server includes action
  if (card.actions && card.actions.indexOf('retry-with-feedback') >= 0) {
    var retrySec = el('div', { className: 'retry-section' });
    retrySec.appendChild(el('h3', { textContent: 'Retry with Feedback' }));
    var feedbackArea = el('textarea', { rows: '3', placeholder: 'Keep the work, but fix this specifically...' });
    retrySec.appendChild(feedbackArea);
    retrySec.appendChild(el('div', { style: 'margin-top:6px' }, [
      btn('Retry with Feedback', 'btn-sm btn-primary', async function() {
        var feedback = feedbackArea.value.trim();
        if (!feedback) { toast('Enter feedback first', 'error'); return; }
        try {
          await api('/cards/' + card.id + '/retry', { method: 'POST', body: { feedback: feedback } });
          toast('Retry started with feedback', 'success');
          detailModal.classList.remove('active');
        } catch (err) { toast(err.message, 'error'); }
      }),
    ]));
    body.appendChild(retrySec);
  }

  detailModal.classList.add('active');
}

// --- Toast (with ARIA live region announcement) ---
function toast(msg, type) {
  var toastEl = el('div', {
    className: 'toast toast-' + (type || 'info'),
    textContent: msg,
    role: 'status',
    'aria-live': 'polite',
  });
  document.getElementById('toasts').appendChild(toastEl);
  // AAA: longer display time for readability (6s instead of 4s)
  setTimeout(function() { toastEl.style.opacity = '0'; setTimeout(function() { toastEl.remove(); }, 300); }, 6000);
}

// --- Modal Focus Trap (WCAG 2.4.3 focus order) ---
function trapFocus(modalEl) {
  var focusable = modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  first.focus();
  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  modalEl._focusTrapHandler = handler;
  modalEl.addEventListener('keydown', handler);
}

function releaseFocusTrap(modalEl) {
  if (modalEl._focusTrapHandler) {
    modalEl.removeEventListener('keydown', modalEl._focusTrapHandler);
    delete modalEl._focusTrapHandler;
  }
}

// --- Live Log Viewer ---
var activeLogStream = null;

function showLiveLog(cardId, type) {
  document.getElementById('detail-title').textContent = 'Live Log — ' + type;
  var body = document.getElementById('detail-body');
  body.textContent = '';
  var logEl = el('div', { className: 'log-viewer expanded' });
  logEl.textContent = 'Connecting...';
  body.appendChild(logEl);

  if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }

  function connectLogStream() {
    var es = new EventSource(BP + '/api/cards/' + cardId + '/log-stream?type=' + type);
    activeLogStream = es;
    var hasContent = false;
    es.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'connected') { if (!hasContent) logEl.textContent = 'Connected. Waiting...'; }
        else if (data.type === 'waiting') { if (!hasContent) logEl.textContent = data.content || 'Waiting...'; }
        else if (data.type === 'initial') { logEl.textContent = data.content; hasContent = true; }
        else if (data.type === 'append') { if (!hasContent) { logEl.textContent = data.content; hasContent = true; } else logEl.textContent += data.content; }
        logEl.scrollTop = logEl.scrollHeight;
      } catch (_) {}
    };
    es.onerror = function() {
      es.close();
      if (activeLogStream === es) {
        activeLogStream = null;
        if (detailModal.classList.contains('active')) {
          logEl.textContent += '\n[Reconnecting...]\n';
          setTimeout(function() { if (detailModal.classList.contains('active') && !activeLogStream) connectLogStream(); }, 3000);
        }
      }
    };
  }
  connectLogStream();
  detailModal.classList.add('active');
}

// --- AI Review Findings ---
async function showFindings(cardId) {
  document.getElementById('detail-title').textContent = 'AI Review Findings';
  var body = document.getElementById('detail-body');
  body.textContent = '';

  try {
    var review = await api('/cards/' + cardId + '/review');
    var scoreCls = review.score >= 8 ? 'review-score-high' : review.score >= 5 ? 'review-score-mid' : 'review-score-low';
    body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px' }, [
      el('span', { className: 'review-score ' + scoreCls, style: 'font-size:1.2rem;padding:6px 16px', textContent: review.score + '/10' }),
      el('span', { textContent: review.summary || 'No summary', style: 'color:var(--text-secondary);font-size:0.95rem;line-height:1.5' }),
    ]));

    var findings = review.findings || [];
    if (findings.length === 0) {
      body.appendChild(el('p', { textContent: 'No specific findings.', style: 'color:var(--text-tertiary);font-size:0.85rem' }));
    } else {
      for (var i = 0; i < findings.length; i++) {
        var f = findings[i];
        var sev = f.severity || 'info';
        var sevColor = sev === 'critical' ? 'var(--error)' : sev === 'warning' ? 'var(--warning)' : 'var(--text-tertiary)';
        body.appendChild(el('div', { style: 'padding:6px 0;border-bottom:1px solid var(--border)' }, [
          el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:3px' }, [
            el('span', { textContent: sev.toUpperCase(), style: 'font-size:12px;font-weight:700;padding:2px 6px;border-radius:3px;background:color-mix(in srgb, ' + sevColor + ' 10%, transparent);color:' + sevColor }),
            el('span', { textContent: f.category || '', style: 'font-size:12px;color:var(--text-secondary);text-transform:uppercase' }),
          ]),
          el('div', { textContent: f.message, style: 'font-size:14px;line-height:1.5' }),
          f.file ? el('div', { textContent: f.file, style: 'font-size:12px;color:var(--primary);font-family:monospace;margin-top:3px' }) : null,
        ]));
      }
    }

    // Add retry with feedback section
    var retrySec = el('div', { className: 'retry-section' });
    retrySec.appendChild(el('h3', { textContent: 'Retry with Feedback' }));
    var feedbackArea = el('textarea', { rows: '3', placeholder: 'Keep existing work but fix specific issues...' });
    retrySec.appendChild(feedbackArea);
    retrySec.appendChild(el('div', { style: 'margin-top:6px' }, [
      btn('Retry with Feedback', 'btn-sm btn-primary', async function() {
        var fb = feedbackArea.value.trim();
        if (!fb) { toast('Enter feedback', 'error'); return; }
        try {
          await api('/cards/' + cardId + '/retry', { method: 'POST', body: { feedback: fb } });
          toast('Retry started', 'success');
          detailModal.classList.remove('active');
        } catch (err) { toast(err.message, 'error'); }
      }),
    ]));
    body.appendChild(retrySec);
  } catch (err) {
    body.appendChild(el('p', { textContent: 'Failed: ' + err.message, style: 'color:var(--error)' }));
  }
  detailModal.classList.add('active');
}

// --- Diff Viewer ---
function makeEditableFile(cardId, filePath, currentContent) {
  var editArea = el('textarea', {
    className: 'diff-editor',
    style: 'width:100%;min-height:200px;max-height:60vh;font-family:monospace;font-size:13px;line-height:1.6;padding:10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical;tab-size:2;white-space:pre;overflow-wrap:normal;overflow-x:auto',
  });
  editArea.value = currentContent;
  var saveBtn = btn('Save', 'btn-sm btn-primary', async function() {
    try {
      await api('/cards/' + cardId + '/edit-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: filePath, content: editArea.value }),
      });
      toast('Saved ' + filePath, 'success');
    } catch (e) { toast('Save failed: ' + e.message, 'error'); }
  }, 'Save changes to disk');
  var cancelBtn = btn('Cancel', 'btn-sm btn-ghost', function() {
    container.replaceWith(placeholder);
  }, 'Discard edits');
  var container = el('div', { className: 'diff-edit-container', style: 'margin-top:4px' }, [editArea, el('div', { style: 'margin-top:4px;display:flex;gap:6px' }, [saveBtn, cancelBtn])]);
  var placeholder = el('span');
  return { container: container, placeholder: placeholder };
}

async function showDiff(cardId) {
  document.getElementById('detail-title').textContent = 'File Changes';
  var body = document.getElementById('detail-body');
  body.textContent = '';
  body.appendChild(el('p', { textContent: 'Loading diff...', style: 'color:var(--text-tertiary)' }));
  detailModal.classList.add('active');

  try {
    var resp = await fetch(BP + '/api/cards/' + cardId + '/diff');
    if (!resp.ok) {
      var errData = await resp.json().catch(function() { return {}; });
      body.textContent = '';
      body.appendChild(el('p', { textContent: errData.error || 'No snapshot available. Diff is only available for cards that went through the build pipeline.', style: 'color:var(--text-secondary)' }));
      return;
    }
    var diff = await resp.json();
    body.textContent = '';

    // Summary
    var summary = el('div', { className: 'diff-summary' });
    if (diff.added.length) summary.appendChild(el('span', { className: 'diff-stat diff-stat-added', textContent: '+' + diff.added.length + ' added' }));
    if (diff.modified.length) summary.appendChild(el('span', { className: 'diff-stat diff-stat-modified', textContent: '~' + diff.modified.length + ' modified' }));
    if (diff.removed.length) summary.appendChild(el('span', { className: 'diff-stat diff-stat-removed', textContent: '-' + diff.removed.length + ' removed' }));
    summary.appendChild(el('span', { className: 'diff-stat diff-stat-unchanged', textContent: diff.unchanged + ' unchanged' }));
    body.appendChild(summary);

    // Added files (with expandable content)
    diff.added.forEach(function(f) {
      var fileName = typeof f === 'string' ? f : f.file;
      var contentEl = el('div', { className: 'diff-file-content' });

      if (f.content) {
        var lines = f.content.split('\n');
        var maxLines = Math.min(lines.length, 200);
        for (var li = 0; li < maxLines; li++) {
          contentEl.appendChild(el('div', { className: 'diff-line diff-line-add', textContent: '+' + lines[li] }));
        }
        if (lines.length > 200) {
          contentEl.appendChild(el('div', { className: 'diff-line', textContent: '... (' + (lines.length - 200) + ' more lines)' }));
        }
      } else if (f.binary) {
        contentEl.appendChild(el('div', { className: 'diff-line', textContent: 'Binary file (' + f.size + ' bytes)' }));
      }

      var editBtnAdded = f.content ? btn('Edit', 'btn-sm btn-ghost', (function(fn, fc) { return function() {
        var edit = makeEditableFile(cardId, fn, fc);
        contentEl.textContent = '';
        contentEl.classList.add('expanded');
        contentEl.appendChild(edit.container);
      }; })(fileName, f.content), 'Edit this file inline') : null;
      if (editBtnAdded) editBtnAdded.style.marginLeft = 'auto';

      var header = el('div', { className: 'diff-file-header', style: 'display:flex;align-items:center;gap:6px' }, [
        el('span', { className: 'diff-file-badge diff-badge-added', textContent: 'A' }),
        el('span', { textContent: fileName + (f.lines ? ' (' + f.lines + ' lines)' : '') }),
        editBtnAdded,
      ]);
      header.querySelector('span:nth-child(2)').addEventListener('click', function() { contentEl.classList.toggle('expanded'); });
      header.querySelector('.diff-file-badge').addEventListener('click', function() { contentEl.classList.toggle('expanded'); });

      body.appendChild(el('div', { className: 'diff-file' }, [header, contentEl]));
    });

    // Removed files
    diff.removed.forEach(function(f) {
      body.appendChild(el('div', { className: 'diff-file' }, [
        el('div', { className: 'diff-file-header' }, [
          el('span', { className: 'diff-file-badge diff-badge-removed', textContent: 'D' }),
          el('span', { textContent: f }),
        ]),
      ]));
    });

    // Modified files (expandable)
    diff.modified.forEach(function(m) {
      var contentEl = el('div', { className: 'diff-file-content' });

      if (m.binary) {
        contentEl.appendChild(el('div', { className: 'diff-line', textContent: 'Binary file changed (' + m.origSize + ' -> ' + m.currSize + ' bytes)' }));
      } else if (m.error) {
        contentEl.appendChild(el('div', { className: 'diff-line', textContent: m.error }));
      } else {
        // Simple line-by-line diff
        var origLines = (m.original || '').split('\n');
        var currLines = (m.current || '').split('\n');
        var maxLines = Math.min(Math.max(origLines.length, currLines.length), 200);
        for (var li = 0; li < maxLines; li++) {
          var ol = li < origLines.length ? origLines[li] : undefined;
          var cl = li < currLines.length ? currLines[li] : undefined;
          if (ol === cl) {
            contentEl.appendChild(el('div', { className: 'diff-line', textContent: ' ' + (cl || '') }));
          } else {
            if (ol !== undefined && ol !== cl) contentEl.appendChild(el('div', { className: 'diff-line diff-line-del', textContent: '-' + ol }));
            if (cl !== undefined && cl !== ol) contentEl.appendChild(el('div', { className: 'diff-line diff-line-add', textContent: '+' + cl }));
          }
        }
      }

      var editBtn = btn('Edit', 'btn-sm btn-ghost', function() {
        var edit = makeEditableFile(cardId, m.file, m.current || '');
        contentEl.textContent = '';
        contentEl.classList.add('expanded');
        contentEl.appendChild(edit.container);
      }, 'Edit this file inline');
      editBtn.style.marginLeft = 'auto';

      var header = el('div', { className: 'diff-file-header', style: 'display:flex;align-items:center;gap:6px' }, [
        el('span', { className: 'diff-file-badge diff-badge-modified', textContent: 'M' }),
        el('span', { textContent: m.file + (m.origLines ? ' (' + m.origLines + ' -> ' + m.currLines + ' lines)' : '') }),
        editBtn,
      ]);
      header.querySelector('span:nth-child(2)').addEventListener('click', function() { contentEl.classList.toggle('expanded'); });
      header.querySelector('.diff-file-badge').addEventListener('click', function() { contentEl.classList.toggle('expanded'); });

      body.appendChild(el('div', { className: 'diff-file' }, [header, contentEl]));
    });

    if (diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0) {
      body.appendChild(el('p', { textContent: 'No changes detected.', style: 'color:var(--text-tertiary);margin-top:12px' }));
    }
  } catch (err) {
    body.textContent = '';
    body.appendChild(el('p', { textContent: 'Failed to load diff: ' + err.message, style: 'color:var(--error)' }));
  }
}

// --- Search ---
var searchInput = document.getElementById('search-input');
var searchResults = document.getElementById('search-results');
var searchTimeout = null;

searchInput.addEventListener('input', function() {
  clearTimeout(searchTimeout);
  var q = searchInput.value.trim();
  if (q.length < 2) { searchResults.classList.remove('active'); return; }
  searchTimeout = setTimeout(async function() {
    try {
      var results = await api('/search?q=' + encodeURIComponent(q));
      searchResults.textContent = '';
      if (results.length === 0) {
        searchResults.appendChild(el('div', { className: 'search-result-item', textContent: 'No results found' }));
      } else {
        results.forEach(function(card) {
          var item = el('div', { className: 'search-result-item' }, [
            el('div', { className: 'search-result-title', textContent: card.title }),
            el('div', { className: 'search-result-meta', textContent: card.column_name + (card.labels ? ' · ' + card.labels : '') + ' · ' + timeAgo(card.updated_at) }),
          ]);
          item.addEventListener('click', function() {
            searchResults.classList.remove('active');
            searchInput.value = '';
            showDetail(card);
          });
          searchResults.appendChild(item);
        });
      }
      searchResults.classList.add('active');
    } catch (_) {}
  }, 300);
});

searchInput.addEventListener('blur', function() {
  setTimeout(function() { searchResults.classList.remove('active'); }, 200);
});

searchInput.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { searchResults.classList.remove('active'); searchInput.blur(); }
});

// --- Dark Mode ---
function initTheme() {
  var saved = localStorage.getItem('claude-kanban-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
    updateThemeIcon();
  }
}

function toggleTheme() {
  document.body.classList.toggle('dark');
  var isDark = document.body.classList.contains('dark');
  localStorage.setItem('claude-kanban-theme', isDark ? 'dark' : 'light');
  updateThemeIcon();
}

function updateThemeIcon() {
  var isDark = document.body.classList.contains('dark');
  document.getElementById('theme-icon-light').style.display = isDark ? 'none' : 'block';
  document.getElementById('theme-icon-dark').style.display = isDark ? 'block' : 'none';
}

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// --- Admin / Control Panel ---
document.getElementById('admin-btn').addEventListener('click', function() {
  // Path from session (admin-only), redirects to admin server via DB-stored port
  window.open(adminPath, '_blank');
});

// --- Archive ---
var archiveModal = document.getElementById('archive-modal');
document.getElementById('archive-close').addEventListener('click', function() { archiveModal.classList.remove('active'); });
archiveModal.addEventListener('click', function(e) { if (e.target === archiveModal) archiveModal.classList.remove('active'); });
document.getElementById('archive-btn').addEventListener('click', showArchive);

async function showArchive() {
  var body = document.getElementById('archive-body');
  body.textContent = '';
  archiveModal.classList.add('active');
  try {
    var archived = await api('/archive');
    if (archived.length === 0) {
      body.appendChild(el('p', { textContent: 'No archived cards.', style: 'color:var(--text-secondary);font-size:14px;padding:12px 0' }));
      return;
    }
    archived.forEach(function(card) {
      body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)' }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14px;margin-bottom:3px', textContent: card.title }),
          el('div', { style: 'font-size:12px;color:var(--text-secondary);line-height:1.5', textContent: (card.project_path || 'No project') + '  ·  ' + timeAgo(card.updated_at) }),
        ]),
        card.review_score > 0 ? el('span', {
          className: 'review-score ' + (card.review_score >= 8 ? 'review-score-high' : card.review_score >= 5 ? 'review-score-mid' : 'review-score-low'),
          textContent: card.review_score + '/10',
        }) : null,
        btn('Restore', 'btn-sm btn-ghost', async function() {
          await api('/cards/' + card.id + '/unarchive', { method: 'POST' });
          toast('Restored', 'success');
          showArchive();
          loadCards();
        }),
        btn('Delete', 'btn-sm btn-ghost', async function() {
          if (!confirm('Delete "' + card.title + '"?')) return;
          await api('/cards/' + card.id, { method: 'DELETE' });
          toast('Deleted', 'info');
          showArchive();
        }),
      ]));
    });
  } catch (err) {
    body.appendChild(el('p', { textContent: 'Failed: ' + err.message, style: 'color:var(--error)' }));
  }
}

// --- Metrics ---
var metricsModal = document.getElementById('metrics-modal');
document.getElementById('metrics-close').addEventListener('click', function() { metricsModal.classList.remove('active'); });
metricsModal.addEventListener('click', function(e) { if (e.target === metricsModal) metricsModal.classList.remove('active'); });
var metricsBtn = document.getElementById('metrics-btn');
if (metricsBtn) metricsBtn.addEventListener('click', showMetrics);

async function showMetrics() {
  var body = document.getElementById('metrics-body');
  body.textContent = '';
  metricsModal.classList.add('active');

  try {
    var m = await api('/metrics');

    // Summary cards
    var grid = el('div', { className: 'metrics-grid' });
    function mc(value, label) {
      return el('div', { className: 'metric-card' }, [
        el('div', { className: 'metric-value', textContent: String(value) }),
        el('div', { className: 'metric-label', textContent: label }),
      ]);
    }
    grid.appendChild(mc(m.totalCards, 'Total Cards'));
    grid.appendChild(mc(m.avgReviewScore || '-', 'Avg Score'));
    grid.appendChild(mc(m.avgDurations.build ? formatDuration(m.avgDurations.build * 1000) : '-', 'Avg Build'));
    grid.appendChild(mc(m.avgDurations.brainstorm ? formatDuration(m.avgDurations.brainstorm * 1000) : '-', 'Avg Spec'));
    body.appendChild(grid);

    // Completions by day
    var days = Object.keys(m.completedByDay).sort();
    if (days.length > 0) {
      var sec = el('div', { className: 'metrics-section' });
      sec.appendChild(el('h3', { textContent: 'Completed by Day' }));
      var maxVal = Math.max.apply(null, days.map(function(d) { return m.completedByDay[d]; }));
      var chart = el('div', { className: 'metric-bar-chart' });
      var recentDays = days.slice(-14);
      recentDays.forEach(function(day) {
        var height = Math.max(4, (m.completedByDay[day] / maxVal) * 56);
        var bar = el('div', { className: 'metric-bar', style: 'height:' + height + 'px', title: day + ': ' + m.completedByDay[day] });
        chart.appendChild(bar);
      });
      sec.appendChild(chart);
      body.appendChild(sec);
    }

    // Top projects
    if (m.topProjects.length > 0) {
      var projSec = el('div', { className: 'metrics-section' });
      projSec.appendChild(el('h3', { textContent: 'Top Projects' }));
      var projList = el('div', { className: 'metrics-projects' });
      var maxProj = m.topProjects[0][1];
      m.topProjects.forEach(function(p) {
        projList.appendChild(el('div', { className: 'metrics-project-row' }, [
          el('span', { textContent: p[0], style: 'font-weight:500;min-width:120px' }),
          el('div', { style: 'flex:1' }, [
            el('div', { className: 'metrics-project-bar', style: 'width:' + Math.max(8, (p[1] / maxProj) * 100) + '%' }),
          ]),
          el('span', { textContent: p[1], style: 'color:var(--text-secondary);font-size:12px;min-width:24px;text-align:right' }),
        ]));
      });
      projSec.appendChild(projList);
      body.appendChild(projSec);
    }

    // Label distribution
    if (Object.keys(m.labelDistribution).length > 0) {
      var labelSec = el('div', { className: 'metrics-section' });
      labelSec.appendChild(el('h3', { textContent: 'Labels' }));
      var labelRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
      Object.entries(m.labelDistribution).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(entry) {
        labelRow.appendChild(el('span', { className: 'label-chip ' + labelClass(entry[0]), textContent: entry[0] + ' (' + entry[1] + ')' }));
      });
      labelSec.appendChild(labelRow);
      body.appendChild(labelSec);
    }
  } catch (err) {
    body.appendChild(el('p', { textContent: 'Failed: ' + err.message, style: 'color:var(--error)' }));
  }
}

// --- Export ---
var exportBtn = document.getElementById('export-btn');
if (exportBtn) exportBtn.addEventListener('click', async function() {
  try {
    var data = await api('/export');
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'claude-kanban-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Board exported', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

// --- Bulk Import ---
var importModal = document.getElementById('import-modal');
document.getElementById('import-close').addEventListener('click', function() { importModal.classList.remove('active'); });
document.getElementById('import-cancel').addEventListener('click', function() { importModal.classList.remove('active'); });
importModal.addEventListener('click', function(e) { if (e.target === importModal) importModal.classList.remove('active'); });
var importBtn = document.getElementById('import-btn');
if (importBtn) importBtn.addEventListener('click', function() {
  document.getElementById('import-text').value = '';
  importModal.classList.add('active');
  document.getElementById('import-text').focus();
});

document.getElementById('import-submit').addEventListener('click', async function() {
  var text = document.getElementById('import-text').value.trim();
  if (!text) return;
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  var items = lines.map(function(line) {
    var parts = line.split('|');
    return { title: parts[0].trim(), description: (parts[1] || '').trim(), labels: (parts[2] || '').trim() };
  }).filter(function(item) { return item.title; });

  if (items.length === 0) { toast('No valid cards', 'error'); return; }

  try {
    var result = await api('/bulk-create', { method: 'POST', body: { items: items } });
    toast(result.created + ' cards imported', 'success');
    importModal.classList.remove('active');
    loadCards();
  } catch (err) { toast(err.message, 'error'); }
});

// --- Keyboard Navigation ---
var shortcutsVisible = false;

function showShortcuts() {
  if (shortcutsVisible) return;
  shortcutsVisible = true;
  var overlay = el('div', { className: 'shortcuts-overlay', onClick: function() { overlay.remove(); shortcutsVisible = false; } });
  var panel = el('div', { className: 'shortcuts-panel' });
  panel.addEventListener('click', function(e) { e.stopPropagation(); });
  panel.appendChild(el('h2', { textContent: 'Keyboard Shortcuts' }));

  var shortcuts = [
    ['Command palette', 'Ctrl+K'],
    ['New card', 'N'],
    ['Search', '/'],
    ['Toggle dark mode', 'D'],
    ['Open metrics', 'M'],
    ['Open archive', 'A'],
    ['Close modal / panel', 'Esc'],
    ['Show shortcuts', '?'],
  ];

  shortcuts.forEach(function(s) {
    panel.appendChild(el('div', { className: 'shortcut-row' }, [
      el('span', { textContent: s[0] }),
      el('kbd', { textContent: s[1] }),
    ]));
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

document.addEventListener('keydown', function(e) {
  // Command palette — Ctrl+K / Cmd+K works even in inputs
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openCmdPalette();
    return;
  }

  // Don't handle shortcuts when typing in inputs
  var tag = document.activeElement.tagName;
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
    if (cmdPalette && cmdPalette.classList.contains('active')) {
      closeCmdPalette();
      return;
    }
    if (shortcutsVisible) {
      var overlay = document.querySelector('.shortcuts-overlay');
      if (overlay) { overlay.remove(); shortcutsVisible = false; }
      return;
    }
    cardModal.classList.remove('active');
    detailModal.classList.remove('active');
    folderModal.classList.remove('active');
    archiveModal.classList.remove('active');
    metricsModal.classList.remove('active');
    importModal.classList.remove('active');
    searchResults.classList.remove('active');
    if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }
    return;
  }

  if (isInput) return;

  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    document.getElementById('add-btn').click();
  } else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    toggleTheme();
  } else if (e.key === 'm') {
    e.preventDefault();
    showMetrics();
  } else if (e.key === 'a') {
    e.preventDefault();
    showArchive();
  } else if (e.key === '?') {
    e.preventDefault();
    showShortcuts();
  }
});

// --- Pipeline Controls ---
function initPipelineControls() {
  var container = document.getElementById('pipeline-controls');
  if (!container) return;
  container.textContent = '';

  var pauseBtn = el('button', {
    className: 'btn pipeline-toggle',
    id: 'pause-btn',
    title: 'Pause/Resume pipeline',
    'aria-label': 'Pause or resume the build pipeline',
  });
  updatePauseBtnContent(pauseBtn);
  pauseBtn.addEventListener('click', async function() {
    try {
      if (pipelinePaused) {
        await api('/pipeline/resume', { method: 'POST' });
      } else {
        await api('/pipeline/pause', { method: 'POST' });
      }
    } catch (e) { toast(e.message, 'error'); }
  });
  container.appendChild(pauseBtn);

  updatePipelineControls();
}

function updatePipelineControls() {
  var pauseBtn = document.getElementById('pause-btn');
  if (pauseBtn) updatePauseBtnContent(pauseBtn);
}

function updatePauseBtnContent(pauseBtn) {
  pauseBtn.textContent = '';
  if (pipelinePaused) {
    pauseBtn.appendChild(el('span', { textContent: 'Resume', className: 'pause-label' }));
    pauseBtn.classList.add('paused');
  } else {
    pauseBtn.appendChild(el('span', { textContent: 'Pause', className: 'pause-label' }));
    pauseBtn.classList.remove('paused');
  }
}

// --- Mode UI ---
function applyModeUI() {
  var addBtn = document.getElementById('add-btn');
  var modeIndicator = document.getElementById('mode-indicator');

  // Hide "New Card" button in single-project mode or for public users
  if (addBtn) {
    addBtn.style.display = (boardMode.mode === 'single-project' || userRole === 'public') ? 'none' : '';
  }

  // Mode indicator already exists in index.html
  if (!modeIndicator) return;

  if (boardMode.mode === 'single-project') {
    var parts = [];
    parts.push(el('span', { className: 'mode-badge mode-single', textContent: 'Single Project' }));
    if (boardMode.discoveryRunning) {
      parts.push(el('span', { className: 'spinner spinner-sm' }));
      parts.push(el('span', { className: 'mode-discovery', textContent: 'Scanning...' }));
    }
    if (boardMode.hasActiveInitiative) {
      parts.push(el('span', { className: 'mode-initiative', textContent: 'Initiative active' }));
    }
    modeIndicator.textContent = '';
    for (var i = 0; i < parts.length; i++) modeIndicator.appendChild(parts[i]);
    modeIndicator.style.display = '';
  } else {
    modeIndicator.style.display = 'none';
  }
}

// --- Idea Modal — natural language input for ideas and feedback ---
var ideaModal = document.getElementById('idea-modal');
var ideaInput = document.getElementById('idea-input');
var ideaSend = document.getElementById('idea-send');
var ideaMic = document.getElementById('idea-mic');
var ideaFolderBtn = document.getElementById('idea-folder');
var ideaFolderTag = document.getElementById('idea-folder-tag');
var ideaFolderName = document.getElementById('idea-folder-name');
var ideaFolderClear = document.getElementById('idea-folder-clear');
var ideaTargetTag = document.getElementById('idea-target-tag');
var ideaTargetName = document.getElementById('idea-target-name');
var ideaTargetClear = document.getElementById('idea-target-clear');
var ideaClose = document.getElementById('idea-close');
var ideaHint = document.getElementById('idea-hint');
var ideaModalTitle = document.getElementById('idea-modal-title');
var ideaSelectedFolder = null;
var ideaFeedbackCardId = null;
var selectedTemplate = null;

var TEMPLATE_ICONS = { bug: '\uD83D\uDC1B', feature: '\u2728', refactor: '\uD83D\uDD27', security: '\uD83D\uDD12', performance: '\u26A1', test: '\uD83E\uDDEA' };

var cachedTemplates = null;
function renderTemplateGrid(container) {
  function renderFromCache(templates) {
    container.textContent = '';
    if (!templates || templates.length === 0) return;
    var grid = el('div', { className: 'template-grid' });
    for (var ti = 0; ti < templates.length; ti++) {
      var tmpl = templates[ti];
      var tCard = el('div', { className: 'template-card', 'data-tmpl-index': String(ti) }, [
        el('div', { className: 'template-icon', textContent: TEMPLATE_ICONS[tmpl.id] || '\uD83D\uDCCB' }),
        el('div', { className: 'template-name', textContent: tmpl.name }),
        el('div', { className: 'template-desc', textContent: tmpl.description || '' }),
      ]);
      grid.appendChild(tCard);
    }
    // Event delegation — single listener on grid, no leaks
    grid.addEventListener('click', function(e) {
      var card = e.target.closest('.template-card');
      if (!card || !card.hasAttribute('data-tmpl-index')) return;
      var idx = Number(card.getAttribute('data-tmpl-index'));
      var tmpl = templates[idx];
      if (!tmpl) return;
      selectedTemplate = tmpl;
      if (ideaInput) ideaInput.value = (tmpl.title || tmpl.name) + '\n\n' + (tmpl.body || '');
      var allTmpl = grid.querySelectorAll('.template-card');
      for (var j = 0; j < allTmpl.length; j++) allTmpl[j].classList.remove('selected');
      card.classList.add('selected');
    });
    container.appendChild(grid);
  }
  if (cachedTemplates) { renderFromCache(cachedTemplates); return; }
  fetch(BP + '/api/templates').then(function(r) { return r.json(); }).then(function(templates) {
    cachedTemplates = templates;
    renderFromCache(templates);
  }).catch(function() { container.textContent = ''; });
}

function openIdeaModal() {
  clearIdeaFeedbackMode();
  selectedTemplate = null;
  ideaInput.value = '';
  var templateContainer = document.getElementById('idea-templates');
  if (templateContainer) renderTemplateGrid(templateContainer);
  ideaModal.classList.add('active');
  ideaInput.focus();
}

function closeIdeaModal() {
  ideaModal.classList.remove('active');
  clearIdeaFeedbackMode();
}

if (ideaClose) ideaClose.addEventListener('click', closeIdeaModal);
if (ideaModal) ideaModal.addEventListener('click', function(e) { if (e.target === ideaModal) closeIdeaModal(); });

// Wire "+ New Idea" button to open idea modal
document.getElementById('add-btn').addEventListener('click', function() {
  openIdeaModal();
});

// Folder picker — lists project directories
if (ideaFolderBtn) ideaFolderBtn.addEventListener('click', function() {
  document.getElementById('folder-modal-title').textContent = 'Select Project Folder';
  document.getElementById('folder-desc').textContent = 'Loading folders...';
  var matchesDiv = document.getElementById('folder-matches');
  var newDiv = document.getElementById('folder-new');
  matchesDiv.textContent = '';
  newDiv.textContent = '';
  document.getElementById('folder-modal').classList.add('active');
  api('/folders').then(function(result) {
    var root = result.root || '';
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    if (result.folders && result.folders.length > 0) {
      for (var i = 0; i < result.folders.length; i++) {
        (function(name) {
          var fullPath = root + sep + name;
          var row = el('div', { className: 'folder-match', style: 'cursor:pointer;padding:8px 12px;border-radius:6px;margin-bottom:4px' }, [
            el('span', { textContent: name, style: 'font-weight:600;font-size:13px' }),
          ]);
          row.addEventListener('click', function() {
            ideaSelectedFolder = fullPath;
            ideaFolderName.textContent = name;
            ideaFolderTag.style.display = '';
            document.getElementById('folder-modal').classList.remove('active');
          });
          matchesDiv.appendChild(row);
        })(result.folders[i]);
      }
      var msg = result.folders.length + ' project folder(s) in ' + root + '. Pick one or cancel to auto-create new.';
      if (result.hidden > 0) {
        msg += ' (' + result.hidden + ' system/hidden folder' + (result.hidden > 1 ? 's' : '') + ' not shown)';
      }
      document.getElementById('folder-desc').textContent = msg;
    } else {
      var emptyMsg = 'No project folders found in ' + root + '. A new one will be created.';
      if (result.hidden > 0) {
        emptyMsg += ' (' + result.hidden + ' system/hidden folder' + (result.hidden > 1 ? 's' : '') + ' not shown)';
      }
      document.getElementById('folder-desc').textContent = emptyMsg;
    }
  }).catch(function() {
    document.getElementById('folder-desc').textContent = 'Could not list folders. A new folder will be created automatically.';
  });
});

if (ideaFolderClear) ideaFolderClear.addEventListener('click', function() {
  ideaSelectedFolder = null;
  ideaFolderTag.style.display = 'none';
});

// Feedback mode — activated by clicking Feedback button on a card
function setIdeaFeedbackMode(cardId, cardTitle) {
  ideaFeedbackCardId = cardId;
  ideaModalTitle.textContent = 'Feedback';
  ideaHint.textContent = 'Feedback for #' + cardId + ': ' + cardTitle;
  ideaTargetName.textContent = '#' + cardId + ' ' + cardTitle;
  ideaTargetTag.style.display = '';
  ideaFolderBtn.style.display = 'none';
  ideaFolderTag.style.display = 'none';
  var tmplContainer = document.getElementById('idea-templates');
  if (tmplContainer) tmplContainer.style.display = 'none';
  ideaInput.placeholder = 'What should be changed or improved?';
  ideaInput.value = '';
  ideaSend.textContent = 'Send Feedback';
  ideaModal.classList.add('active');
  ideaInput.focus();
}

function clearIdeaFeedbackMode() {
  ideaFeedbackCardId = null;
  if (ideaTargetTag) ideaTargetTag.style.display = 'none';
  if (ideaFolderBtn) ideaFolderBtn.style.display = '';
  var tmplContainer = document.getElementById('idea-templates');
  if (tmplContainer) tmplContainer.style.display = '';
  if (ideaModalTitle) ideaModalTitle.textContent = 'New Idea';
  if (ideaHint) ideaHint.textContent = 'Describe what you want to build. A new project folder will be created automatically.';
  if (ideaInput) ideaInput.placeholder = 'I want to build a...';
  if (ideaSend) ideaSend.textContent = 'Submit Idea';
}

if (ideaTargetClear) ideaTargetClear.addEventListener('click', function() {
  clearIdeaFeedbackMode();
});

// Submit idea or feedback
async function submitIdea() {
  var text = ideaInput.value.trim();
  if (!text) return;

  if (ideaFeedbackCardId) {
    try {
      await api('/cards/' + ideaFeedbackCardId + '/feedback', { method: 'POST', body: { text: text } });
      toast('Feedback sent for #' + ideaFeedbackCardId, 'success');
      closeIdeaModal();
    } catch (e) { toast(e.message, 'error'); }
  } else {
    try {
      var body = { text: text };
      if (ideaSelectedFolder) body.projectPath = ideaSelectedFolder;
      var card = await api('/ideas', { method: 'POST', body: body });
      toast('Idea #' + card.id + ' created — brainstorming...', 'success');
      closeIdeaModal();
    } catch (e) { toast(e.message, 'error'); }
  }
}

if (ideaSend) ideaSend.addEventListener('click', submitIdea);
if (ideaInput) ideaInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitIdea();
  }
});

// --- Voice Input (Web Speech API) ---
var speechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var isListening = false;
var recognition = null;

if (speechRecognition && ideaMic) {
  recognition = new speechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onresult = function(event) {
    var transcript = event.results[0][0].transcript;
    ideaInput.value = (ideaInput.value ? ideaInput.value + ' ' : '') + transcript;
  };

  recognition.onend = function() {
    isListening = false;
    ideaMic.classList.remove('listening');
  };

  recognition.onerror = function(e) {
    isListening = false;
    ideaMic.classList.remove('listening');
    if (e.error === 'not-allowed') toast('Microphone access denied', 'error');
    else if (e.error !== 'aborted') toast('Voice input unavailable', 'error');
  };

  ideaMic.addEventListener('click', function() {
    if (isListening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        isListening = true;
        ideaMic.classList.add('listening');
        toast('Listening...', 'info');
      } catch (e) { toast('Voice input failed: ' + e.message, 'error'); }
    }
  });
} else if (ideaMic) {
  ideaMic.addEventListener('click', function() {
    toast('Voice input not supported in this browser', 'error');
  });
}

// --- Init ---
async function init() {
  initTheme();
  requestNotifPermission();

  var cardsP = api('/cards');
  var activitiesP = fetch(BP + '/api/activities').then(function(r) { return r.json(); }).catch(function() { return {}; });
  var pipelineP = fetch(BP + '/api/pipeline').then(function(r) { return r.json(); }).catch(function() { return { paused: false }; });
  var configP = fetch(BP + '/api/config').then(function(r) { return r.json(); }).catch(function() { return null; });
  var modeP = fetch(BP + '/api/mode').then(function(r) { return r.json(); }).catch(function() { return { mode: 'global' }; });
  var results = await Promise.all([cardsP, activitiesP, pipelineP, configP, modeP]);
  state.cards = results[0];
  cardActivities = results[1];
  pipelinePaused = results[2].paused;
  state.config = results[3];
  boardMode = results[4] || boardMode;
  applyModeUI();
  initPipelineControls();
  render();
  connectSSE();
  loadTrends();

  if (lastVisitTime > 0) {
    var newCount = state.cards.filter(function(c) {
      return c.created_at && new Date(c.created_at.replace(' ', 'T') + 'Z').getTime() > lastVisitTime;
    }).length;
    if (newCount > 0) toast(newCount + ' new card' + (newCount > 1 ? 's' : '') + ' since last visit', 'info');
  }
  setTimeout(function() { localStorage.setItem('claude-kanban-last-visit', String(Date.now())); }, 5000);

  // Dismiss kbd hint after 10s
  setTimeout(function() {
    var hint = document.getElementById('kbd-hint');
    if (hint) hint.style.opacity = '0';
    setTimeout(function() { if (hint) hint.style.display = 'none'; }, 500);
  }, 10000);
}

// --- Command Palette ---
var cmdPalette = document.getElementById('cmd-palette');
var cmdInput = document.getElementById('cmd-input');
var cmdResults = document.getElementById('cmd-results');
var cmdSelectedIndex = 0;
var cmdItems = [];

var CMD_ACTIONS = [
  { label: 'New Idea', icon: '+', action: function() { document.getElementById('add-btn').click(); }, hint: 'N' },
  { label: 'Pause Pipeline', icon: '\u23F8', action: function() { api('/pipeline/pause', { method: 'POST' }).catch(function(e) { toast(e.message, 'error'); }); }, hint: '' },
  { label: 'Resume Pipeline', icon: '\u25B6', action: function() { api('/pipeline/resume', { method: 'POST' }).catch(function(e) { toast(e.message, 'error'); }); }, hint: '' },
  { label: 'Toggle Dark Mode', icon: '\u25D0', action: function() { document.getElementById('theme-toggle').click(); }, hint: 'D' },
  { label: 'View Archive', icon: '\uD83D\uDCE6', action: function() { document.getElementById('archive-btn').click(); }, hint: 'A' },
  { label: 'View Metrics', icon: '\uD83D\uDCCA', action: function() { showMetrics(); }, hint: 'M' },
  { label: 'Control Panel', icon: '\u2699', action: function() { document.getElementById('admin-btn').click(); }, hint: '' },
];

function openCmdPalette() {
  if (!cmdPalette) return;
  cmdPalette.classList.add('active');
  cmdInput.value = '';
  cmdSelectedIndex = 0;
  renderCmdResults('');
  cmdInput.focus();
}

function closeCmdPalette() {
  if (!cmdPalette) return;
  cmdPalette.classList.remove('active');
  cmdInput.value = '';
}

function renderCmdResults(query) {
  cmdResults.textContent = '';
  cmdItems = [];
  var q = query.toLowerCase().trim();

  // Actions
  for (var ai = 0; ai < CMD_ACTIONS.length; ai++) {
    var act = CMD_ACTIONS[ai];
    if (!q || act.label.toLowerCase().indexOf(q) !== -1) {
      cmdItems.push({ type: 'action', data: act });
    }
  }

  // Card search
  if (q.length >= 2) {
    for (var ci = 0; ci < state.cards.length; ci++) {
      var card = state.cards[ci];
      var text = (card.title + ' ' + (card.labels || '')).toLowerCase();
      if (text.indexOf(q) !== -1) {
        cmdItems.push({ type: 'card', data: card });
      }
      if (cmdItems.length > 15) break;
    }
  }

  if (cmdItems.length === 0) {
    cmdResults.appendChild(el('div', { className: 'cmd-result', textContent: 'No results' }));
    return;
  }

  cmdSelectedIndex = Math.min(cmdSelectedIndex, cmdItems.length - 1);

  for (var i = 0; i < cmdItems.length; i++) {
    var item = cmdItems[i];
    var row;
    if (item.type === 'action') {
      row = el('div', { className: 'cmd-result' + (i === cmdSelectedIndex ? ' selected' : ''), 'data-index': String(i) }, [
        el('span', { className: 'cmd-icon', textContent: item.data.icon }),
        el('span', { className: 'cmd-label', textContent: item.data.label }),
        item.data.hint ? el('span', { className: 'cmd-hint', textContent: item.data.hint }) : null,
      ]);
    } else {
      var colLabel = item.data.column_name === 'brainstorm' ? 'Brainstorm' : item.data.column_name === 'todo' ? 'Todo' : item.data.column_name === 'working' ? 'Working' : item.data.column_name === 'review' ? 'Review' : 'Done';
      row = el('div', { className: 'cmd-result' + (i === cmdSelectedIndex ? ' selected' : ''), 'data-index': String(i) }, [
        el('span', { className: 'cmd-icon', textContent: '#' }),
        el('span', { className: 'cmd-label', textContent: '#' + item.data.id + ' ' + item.data.title }),
        el('span', { className: 'cmd-hint', textContent: colLabel }),
      ]);
    }
    cmdResults.appendChild(row);
  }
}

function executeCmdItem(index) {
  if (index < 0 || index >= cmdItems.length) return;
  var item = cmdItems[index];
  closeCmdPalette();
  if (item.type === 'action') {
    item.data.action();
  } else if (item.type === 'card') {
    selectedCardId = item.data.id;
    showDetail(item.data);
  }
}

// Event delegation for command palette — single listener, no leaks
if (cmdResults) {
  cmdResults.addEventListener('click', function(e) {
    var row = e.target.closest('.cmd-result');
    if (!row || !row.hasAttribute('data-index')) return;
    executeCmdItem(Number(row.getAttribute('data-index')));
  });
}

if (cmdInput) {
  cmdInput.addEventListener('input', function() {
    cmdSelectedIndex = 0;
    renderCmdResults(cmdInput.value);
  });
  cmdInput.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectedIndex = Math.min(cmdSelectedIndex + 1, cmdItems.length - 1);
      renderCmdResults(cmdInput.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectedIndex = Math.max(cmdSelectedIndex - 1, 0);
      renderCmdResults(cmdInput.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeCmdItem(cmdSelectedIndex);
    } else if (e.key === 'Escape') {
      closeCmdPalette();
    }
  });
}
if (cmdPalette) {
  cmdPalette.addEventListener('click', function(e) {
    if (e.target === cmdPalette) closeCmdPalette();
  });
}

// --- Automatic Focus Trap for Modals (WCAG 2.4.3) ---
// Observe all modal overlays; trap focus when opened, release when closed.
(function() {
  var modals = document.querySelectorAll('.modal-overlay, .cmd-overlay');
  var previousFocus = null;
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (target.classList.contains('active')) {
        previousFocus = document.activeElement;
        setTimeout(function() { trapFocus(target); }, 50);
      } else {
        releaseFocusTrap(target);
        if (previousFocus && previousFocus.focus) {
          try { previousFocus.focus(); } catch (_) {}
          previousFocus = null;
        }
      }
    }
  });
  modals.forEach(function(modal) {
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
})();

checkSession();
