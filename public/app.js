var COLUMNS = [
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'todo', label: 'To Do' },
  { id: 'working', label: 'Working' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

var state = { cards: [] };
var dragCardId = null;
var queueInfo = { queue: [], active: [] };
var cardActivities = {};
var selectedCardId = null;

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

// --- API ---
async function api(path, opts) {
  var res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return { error: 'Request failed' }; });
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

async function loadCards() {
  state.cards = await api('/cards');
  render();
}

// --- SSE ---
function connectSSE() {
  var es = new EventSource('/api/events');
  es.onerror = function() { es.close(); setTimeout(connectSSE, 3000); };

  function handleCard(e) {
    var card = JSON.parse(e.data);
    var idx = state.cards.findIndex(function(c) { return c.id === card.id; });
    if (idx >= 0) state.cards[idx] = card;
    else state.cards.push(card);
    render();
    // Desktop notification for state changes
    notifyCardEvent(card);
  }

  es.addEventListener('card-created', handleCard);
  es.addEventListener('card-updated', handleCard);
  es.addEventListener('card-moved', handleCard);

  es.addEventListener('card-deleted', function(e) {
    var data = JSON.parse(e.data);
    state.cards = state.cards.filter(function(c) { return c.id !== data.id; });
    render();
  });

  es.addEventListener('card-activity', function(e) {
    var data = JSON.parse(e.data);
    if (data.step === null) delete cardActivities[data.cardId];
    else cardActivities[data.cardId] = data;
    updateCardActivity(data.cardId);
  });

  es.addEventListener('queue-update', function(e) {
    queueInfo = JSON.parse(e.data);
    render();
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

function getCompletedStep(card) {
  if (card.column_name === 'done') return 'done';
  if (card.status === 'complete') return 'done';
  if (card.status === 'fixing') return 'fix';
  if (card.status === 'reviewing') return 'review';
  if (card.status === 'building') return 'build';
  if (card.status === 'queued') return 'queue';
  if (card.status === 'brainstorming') return 'spec';
  if (card.column_name === 'review') return 'review';
  if (card.column_name === 'working') return 'build';
  if (card.spec) return 'spec';
  if (card.project_path) return 'folder';
  return null;
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
  var activeStep = activity ? activity.step : getCompletedStep(card);
  if (!activeStep) return null;
  var completed = card.column_name === 'done' || card.status === 'complete';
  var container = el('div', { className: 'pipeline-steps' });
  renderPipelineInto(container, activeStep, completed);
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
  if (active > 0) container.appendChild(chip('Active', active, 'stat-active'));
  if (queued > 0) container.appendChild(chip('Queued', queued, 'stat-queued'));
  container.appendChild(chip('Done', doneCount, 'stat-done'));
}

// --- Render ---
function render() {
  renderStats();
  var board = document.getElementById('board');
  board.textContent = '';
  for (var ci = 0; ci < COLUMNS.length; ci++) {
    var col = COLUMNS[ci];
    var colCards = state.cards.filter(function(c) { return c.column_name === col.id; });
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

  for (var i = 0; i < colCards.length; i++) {
    list.appendChild(renderCard(colCards[i], col.id));
  }
  colEl.appendChild(list);
  return colEl;
}

function renderCard(card, colId) {
  var cardEl = el('div', { className: 'card' + (card.id === selectedCardId ? ' card-selected' : ''), draggable: 'true', 'data-id': card.id });
  cardEl.addEventListener('dragstart', function() { dragCardId = card.id; cardEl.classList.add('dragging'); });
  cardEl.addEventListener('dragend', function() { cardEl.classList.remove('dragging'); dragCardId = null; });

  cardEl.appendChild(el('div', { className: 'card-accent' }));

  var title = el('div', { className: 'card-title', textContent: card.title, style: 'cursor:pointer' });
  title.addEventListener('click', function() { showDetail(card); });
  cardEl.appendChild(title);

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

  // Badges
  var meta = el('div', { className: 'card-meta' });
  if (card.status === 'brainstorming') {
    meta.appendChild(el('span', { className: 'spinner' }));
    meta.appendChild(el('span', { className: 'card-badge badge-brainstorming', textContent: 'Brainstorming' }));
  } else if (card.status === 'queued') {
    var qPos = -1;
    for (var qi = 0; qi < queueInfo.queue.length; qi++) {
      if (queueInfo.queue[qi].cardId === card.id) { qPos = queueInfo.queue[qi].position; break; }
    }
    meta.appendChild(el('span', { className: 'card-badge badge-queued', textContent: 'Queued' + (qPos > 0 ? ' #' + qPos : '') }));
  } else if (card.status === 'building') {
    meta.appendChild(el('span', { className: 'spinner' }));
    meta.appendChild(el('span', { className: 'card-badge badge-building', textContent: 'Building' }));
  } else if (card.status === 'reviewing') {
    meta.appendChild(el('span', { className: 'spinner' }));
    meta.appendChild(el('span', { className: 'card-badge badge-reviewing', textContent: 'AI Reviewing' }));
  } else if (card.status === 'fixing') {
    meta.appendChild(el('span', { className: 'spinner' }));
    meta.appendChild(el('span', { className: 'card-badge badge-building', textContent: 'Auto-Fixing' }));
  } else if (card.status === 'interrupted') {
    meta.appendChild(el('span', { className: 'card-badge badge-interrupted', textContent: 'Interrupted' }));
  } else if (card.status === 'blocked') {
    meta.appendChild(el('span', { className: 'card-badge badge-blocked', textContent: 'Blocked' }));
  } else if (card.spec) {
    meta.appendChild(el('span', { className: 'card-badge badge-has-spec', textContent: 'Has Spec' }));
  }
  if (card.status === 'complete') {
    meta.appendChild(el('span', { className: 'card-badge badge-complete', textContent: 'Complete' }));
  }

  // Dependency badge
  if (card.depends_on) {
    var deps = card.depends_on.split(',').filter(Boolean);
    var blockedBy = [];
    deps.forEach(function(d) {
      var depCard = state.cards.find(function(c) { return c.id === Number(d.trim()); });
      if (depCard && depCard.column_name !== 'done' && depCard.column_name !== 'archive') {
        blockedBy.push('#' + d.trim());
      }
    });
    if (blockedBy.length > 0) {
      meta.appendChild(el('span', { className: 'card-badge badge-blocked', textContent: 'Blocked: ' + blockedBy.join(', ') }));
    }
  }

  if (card.review_score > 0) {
    var scoreCls = card.review_score >= 8 ? 'review-score-high' : card.review_score >= 5 ? 'review-score-mid' : 'review-score-low';
    meta.appendChild(el('span', { className: 'review-score ' + scoreCls, textContent: card.review_score + '/10' }));
  }
  if (card.approved_by) {
    var abCls = card.approved_by === 'human' ? 'approved-human' : 'approved-ai';
    meta.appendChild(el('span', { className: 'approved-badge ' + abCls, textContent: card.approved_by === 'human' ? 'Human Approved' : 'AI Approved' }));
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
  if (meta.children.length) cardEl.appendChild(meta);

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

  // Actions
  var actions = el('div', { className: 'card-actions' });
  var id = card.id;

  // Info button on every card — always visible
  actions.appendChild(btn('Info', 'btn-sm btn-ghost btn-info', function() { showDetail(card); }, 'View full card details, spec, and logs'));

  if (card.status === 'interrupted') {
    actions.appendChild(btn('Retry', 'btn-sm btn-primary', function() { doStartWork(id); }, 'Retry the build from where it left off'));
    actions.appendChild(btn('Re-brainstorm', 'btn-sm btn-ghost', function() { doBrainstorm(id); }, 'Generate a new spec via AI brainstorm'));
    actions.appendChild(btn('Reject', 'btn-sm btn-ghost', function() { doReject(id); }, 'Reject and rollback file changes'));
    actions.appendChild(btn('Discard', 'btn-sm btn-ghost', function() { deleteCard(id); }, 'Permanently delete this card'));
  } else if (colId === 'brainstorm') {
    actions.appendChild(btn('Detect', 'btn-sm btn-ghost', function() { doDetect(id); }, 'Find or create a project folder'));
    actions.appendChild(btn('Brainstorm', 'btn-sm btn-primary', function() { doBrainstorm(id); }, 'AI generates a detailed spec'));
    actions.appendChild(btn('Edit', 'btn-sm btn-ghost', function() { editCard(id); }, 'Edit card title and description'));
    actions.appendChild(btn('Del', 'btn-sm btn-ghost', function() { deleteCard(id); }, 'Delete this card'));
  } else if (colId === 'todo' && card.status === 'blocked') {
    actions.appendChild(btn('Retry', 'btn-sm btn-primary', function() { doStartWork(id); }, 'Re-queue this card for building'));
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }, 'Open project in VS Code'));
    actions.appendChild(btn('Discard', 'btn-sm btn-ghost', function() { deleteCard(id); }, 'Delete this card'));
  } else if (colId === 'todo' && card.status === 'queued') {
    actions.appendChild(btn('Cancel', 'btn-sm btn-ghost', function() { doCancelQueue(id); }, 'Remove from build queue'));
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }, 'Open project in VS Code'));
    actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'build'); }, 'Watch live build output'));
  } else if (colId === 'todo') {
    actions.appendChild(btn('Start', 'btn-sm btn-primary', function() { doStartWork(id); }, 'Queue AI to build this project'));
    actions.appendChild(btn('Re-brainstorm', 'btn-sm btn-ghost', function() { doBrainstorm(id); }, 'Regenerate the spec'));
    actions.appendChild(btn('Edit', 'btn-sm btn-ghost', function() { editCard(id); }, 'Edit card title and description'));
  } else if (colId === 'working') {
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }, 'Open project in VS Code'));
    actions.appendChild(btn('Terminal', 'btn-sm btn-ghost', function() { doOpenTerminal(id); }, 'Open terminal in project folder'));
    actions.appendChild(btn('Claude', 'btn-sm btn-ghost', function() { doOpenClaude(id); }, 'Open Claude CLI in project folder'));
    actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'build'); }, 'Watch live build output'));
  } else if (colId === 'review') {
    actions.appendChild(btn('Approve', 'btn-sm btn-primary', function() { doApprove(id); }, 'Approve, update changelog, and git commit'));
    actions.appendChild(btn('Reject', 'btn-sm btn-ghost', function() { doReject(id); }, 'Reject and rollback file changes'));
    actions.appendChild(btn('Diff', 'btn-sm btn-ghost', function() { showDiff(id); }, 'View file changes since snapshot'));
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }, 'Open project in VS Code'));
    if (card.review_score > 0) {
      actions.appendChild(btn('Findings', 'btn-sm btn-ghost', function() { showFindings(id); }, 'View AI review findings'));
    }
    if (card.status === 'reviewing') {
      actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'review'); }, 'Watch live review output'));
    }
    if (card.status === 'fixing') {
      actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'review-fix'); }, 'Watch auto-fix output'));
    }
  } else if (colId === 'done') {
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }, 'Open project in VS Code'));
    actions.appendChild(btn('Preview', 'btn-sm btn-ghost', function() { doPreview(id); }, 'Run the project and preview it'));
    actions.appendChild(btn('Diff', 'btn-sm btn-ghost', function() { showDiff(id); }, 'View file changes from the build'));
    actions.appendChild(btn('Revert', 'btn-sm btn-ghost', function() { doRevert(id); }, 'Revert files to pre-build state'));
  }

  cardEl.appendChild(actions);
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
  var card = state.cards.find(function(c) { return c.id === id; });
  if (card && !card.project_path) { doDetect(id, 'brainstorm'); return; }
  startBrainstorm(id);
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

async function doApprove(id) {
  await api('/cards/' + id + '/approve', { method: 'POST' });
  toast('Approved!', 'success');
}

async function doReject(id) {
  if (!confirm('Reject and ROLLBACK all file changes?')) return;
  var result = await api('/cards/' + id + '/reject', { method: 'POST' });
  toast(result.rollback && result.rollback.success ? 'Rejected! Files rolled back.' : 'Rejected.', 'info');
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

document.getElementById('add-btn').addEventListener('click', function() {
  document.getElementById('card-id').value = '';
  document.getElementById('card-title').value = '';
  document.getElementById('card-desc').value = '';
  document.getElementById('card-labels').value = '';
  document.getElementById('modal-title').textContent = 'New Card';
  cardModal.classList.add('active');
  document.getElementById('card-title').focus();
});

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
    acts.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(card.id); }));
    acts.appendChild(btn('Terminal', 'btn-sm btn-ghost', function() { doOpenTerminal(card.id); }));
    acts.appendChild(btn('Claude', 'btn-sm btn-ghost', function() { doOpenClaude(card.id); }));
    acts.appendChild(btn('View Diff', 'btn-sm btn-ghost', function() { detailModal.classList.remove('active'); showDiff(card.id); }));
    body.appendChild(acts);
  }

  // Retry with feedback (for review cards)
  if (card.column_name === 'review' || (card.column_name === 'review' && card.review_score > 0)) {
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

// --- Toast ---
function toast(msg, type) {
  var toastEl = el('div', { className: 'toast toast-' + (type || 'info'), textContent: msg });
  document.getElementById('toasts').appendChild(toastEl);
  setTimeout(function() { toastEl.style.opacity = '0'; setTimeout(function() { toastEl.remove(); }, 300); }, 4000);
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
    var es = new EventSource('/api/cards/' + cardId + '/log-stream?type=' + type);
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
      el('span', { className: 'review-score ' + scoreCls, style: 'font-size:1.1rem;padding:5px 14px', textContent: review.score + '/10' }),
      el('span', { textContent: review.summary || 'No summary', style: 'color:var(--text-secondary);font-size:0.85rem' }),
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
            el('span', { textContent: sev.toUpperCase(), style: 'font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:color-mix(in srgb, ' + sevColor + ' 10%, transparent);color:' + sevColor }),
            el('span', { textContent: f.category || '', style: 'font-size:9px;color:var(--text-tertiary);text-transform:uppercase' }),
          ]),
          el('div', { textContent: f.message, style: 'font-size:12px;line-height:1.4' }),
          f.file ? el('div', { textContent: f.file, style: 'font-size:10px;color:var(--primary);font-family:monospace;margin-top:2px' }) : null,
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
    style: 'width:100%;min-height:200px;max-height:60vh;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical;tab-size:2;white-space:pre;overflow-wrap:normal;overflow-x:auto',
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
    var resp = await fetch('/api/cards/' + cardId + '/diff');
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
      body.appendChild(el('p', { textContent: 'No archived cards.', style: 'color:var(--text-tertiary);font-size:12px;padding:12px 0' }));
      return;
    }
    archived.forEach(function(card) {
      body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)' }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:12px;margin-bottom:2px', textContent: card.title }),
          el('div', { style: 'font-size:10px;color:var(--text-tertiary)', textContent: (card.project_path || 'No project') + '  ·  ' + timeAgo(card.updated_at) }),
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
document.getElementById('metrics-btn').addEventListener('click', showMetrics);

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
          el('span', { textContent: p[1], style: 'color:var(--text-tertiary);font-size:11px;min-width:24px;text-align:right' }),
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
document.getElementById('export-btn').addEventListener('click', async function() {
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
document.getElementById('import-btn').addEventListener('click', function() {
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
  // Don't handle shortcuts when typing in inputs
  var tag = document.activeElement.tagName;
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
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

// --- Init ---
async function init() {
  initTheme();
  requestNotifPermission();

  var cardsP = api('/cards');
  var activitiesP = fetch('/api/activities').then(function(r) { return r.json(); }).catch(function() { return {}; });
  var results = await Promise.all([cardsP, activitiesP]);
  state.cards = results[0];
  cardActivities = results[1];
  render();
  connectSSE();

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
init();
