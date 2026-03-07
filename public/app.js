const COLUMNS = [
  { id: 'brainstorm', label: 'Brainstorm', icon: '\u{1F4A1}' },
  { id: 'todo', label: 'To Do', icon: '\u{1F4CB}' },
  { id: 'working', label: 'Working', icon: '\u{2699}\uFE0F' },
  { id: 'review', label: 'Review', icon: '\u{1F441}\uFE0F' },
  { id: 'done', label: 'Done', icon: '\u{2705}' },
];

let state = { cards: [] };
let dragCardId = null;
let queueInfo = { queue: [], active: [] };
let cardActivities = {}; // cardId → { step, detail, timestamp }

// Track last visit for "new" badges
var lastVisitTime = (function() {
  var t = localStorage.getItem('claude-kanban-last-visit');
  return t ? Number(t) : 0;
})();

// Pipeline steps definition
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

// --- Helpers ---
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'textContent') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'string') e.appendChild(document.createTextNode(child));
      else if (child) e.appendChild(child);
    }
  }
  return e;
}

function btn(text, cls, handler) {
  return el('button', { className: 'btn ' + cls, onClick: handler, textContent: text });
}

// --- Helpers ---
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

// --- API ---
async function api(path, opts) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(function() { return { error: 'Request failed' }; });
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
  const es = new EventSource('/api/events');
  es.onerror = function() { es.close(); setTimeout(connectSSE, 3000); };

  function handleCard(e) {
    const card = JSON.parse(e.data);
    const idx = state.cards.findIndex(function(c) { return c.id === card.id; });
    if (idx >= 0) state.cards[idx] = card;
    else state.cards.push(card);
    render();
  }

  es.addEventListener('card-created', handleCard);
  es.addEventListener('card-updated', handleCard);
  es.addEventListener('card-moved', handleCard);

  es.addEventListener('card-deleted', function(e) {
    const data = JSON.parse(e.data);
    state.cards = state.cards.filter(function(c) { return c.id !== data.id; });
    render();
  });

  es.addEventListener('card-activity', function(e) {
    var data = JSON.parse(e.data);
    if (data.step === null) {
      delete cardActivities[data.cardId];
    } else {
      cardActivities[data.cardId] = data;
    }
    // Update just the activity display without full re-render
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
  // Update or create activity text
  if (existing) {
    existing.textContent = activity.detail;
  } else {
    var metaEl = cardEl.querySelector('.card-meta');
    if (metaEl) {
      metaEl.parentNode.insertBefore(
        el('div', { className: 'card-activity', textContent: activity.detail }),
        metaEl.nextSibling
      );
    }
  }
  // Update pipeline steps
  if (pipelineEl) {
    renderPipelineInto(pipelineEl, activity.step, false);
  }
}

function getCompletedStep(card) {
  // Derive which step the card has reached based on column/status
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
    var dot = el('div', { className: cls, title: step.label });
    container.appendChild(dot);
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
  const board = document.getElementById('board');
  board.textContent = '';

  for (const col of COLUMNS) {
    const colCards = state.cards.filter(function(c) { return c.column_name === col.id; });
    board.appendChild(renderColumn(col, colCards));
  }
}

function renderColumn(col, colCards) {
  const colEl = el('div', { className: 'column', 'data-col': col.id });

  // Header
  const header = el('div', { className: 'column-header' }, [
    el('div', { className: 'column-dot' }),
    el('h2', { textContent: col.label }),
    el('span', { className: 'card-count', textContent: String(colCards.length) }),
  ]);
  colEl.appendChild(header);

  // Card list
  const list = el('div', { className: 'card-list', 'data-col': col.id });

  list.addEventListener('dragover', function(e) {
    e.preventDefault();
    list.classList.add('drag-over');
  });
  list.addEventListener('dragleave', function() {
    list.classList.remove('drag-over');
  });
  list.addEventListener('drop', function(e) {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (dragCardId != null) {
      moveCard(dragCardId, col.id);
      dragCardId = null;
    }
  });

  for (const card of colCards) {
    list.appendChild(renderCard(card, col.id));
  }

  colEl.appendChild(list);
  return colEl;
}

function renderCard(card, colId) {
  var cardEl = el('div', { className: 'card', draggable: 'true', 'data-id': card.id });

  cardEl.addEventListener('dragstart', function() { dragCardId = card.id; cardEl.classList.add('dragging'); });
  cardEl.addEventListener('dragend', function() { cardEl.classList.remove('dragging'); dragCardId = null; });

  // Accent bar
  cardEl.appendChild(el('div', { className: 'card-accent' }));

  // Title (clickable for details)
  var title = el('div', { className: 'card-title', textContent: card.title, style: 'cursor:pointer' });
  title.addEventListener('click', function() { showDetail(card); });
  cardEl.appendChild(title);

  // Description
  if (card.description) {
    cardEl.appendChild(el('div', { className: 'card-desc', textContent: card.description }));
  }

  // Project path indicator
  if (card.project_path) {
    var pathLabel = el('div', {
      className: 'card-path',
      textContent: card.project_path.replace(/\\/g, '/').replace(/^R:\//i, ''),
      title: card.project_path,
    });
    cardEl.appendChild(pathLabel);
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
  } else if (card.spec) {
    meta.appendChild(el('span', { className: 'card-badge badge-has-spec', textContent: 'Has Spec' }));
  }
  if (card.status === 'complete') {
    meta.appendChild(el('span', { className: 'card-badge badge-complete', textContent: 'Complete' }));
  }
  // Review score badge
  if (card.review_score > 0) {
    var scoreCls = card.review_score >= 8 ? 'review-score-high' : card.review_score >= 5 ? 'review-score-mid' : 'review-score-low';
    meta.appendChild(el('span', { className: 'review-score ' + scoreCls, textContent: card.review_score + '/10' }));
  }
  // "New since last visit" badge
  if (lastVisitTime > 0 && card.created_at) {
    var cardCreated = new Date(card.created_at.replace(' ', 'T') + 'Z').getTime();
    if (cardCreated > lastVisitTime) {
      meta.appendChild(el('span', { className: 'card-badge badge-new', textContent: 'NEW' }));
    }
  }
  // Relative timestamp
  if (card.updated_at) {
    meta.appendChild(el('span', { className: 'card-timestamp', textContent: timeAgo(card.updated_at) }));
  }
  if (meta.children.length) cardEl.appendChild(meta);

  // Pipeline progress steps
  var pipeline = renderPipeline(card);
  if (pipeline) cardEl.appendChild(pipeline);

  // Live activity text
  var activity = cardActivities[card.id];
  if (activity && activity.detail) {
    cardEl.appendChild(el('div', { className: 'card-activity', textContent: activity.detail }));
  }

  // Actions
  var actions = el('div', { className: 'card-actions' });
  var id = card.id;

  if (card.status === 'interrupted') {
    // Interrupted cards get special actions regardless of column
    actions.appendChild(btn('Retry', 'btn-sm btn-primary', function() { doStartWork(id); }));
    actions.appendChild(btn('Re-brainstorm', 'btn-sm btn-ghost', function() { doBrainstorm(id); }));
    actions.appendChild(btn('Reject', 'btn-sm btn-ghost', function() { doReject(id); }));
    actions.appendChild(btn('Discard', 'btn-sm btn-ghost', function() { deleteCard(id); }));
  } else if (colId === 'brainstorm') {
    actions.appendChild(btn('Detect', 'btn-sm btn-ghost', function() { doDetect(id); }));
    actions.appendChild(btn('Brainstorm', 'btn-sm btn-primary', function() { doBrainstorm(id); }));
    actions.appendChild(btn('Edit', 'btn-sm btn-ghost', function() { editCard(id); }));
    actions.appendChild(btn('Del', 'btn-sm btn-ghost', function() { deleteCard(id); }));
  } else if (colId === 'todo') {
    actions.appendChild(btn('Start Work', 'btn-sm btn-primary', function() { doStartWork(id); }));
    actions.appendChild(btn('Re-brainstorm', 'btn-sm btn-ghost', function() { doBrainstorm(id); }));
    actions.appendChild(btn('Edit', 'btn-sm btn-ghost', function() { editCard(id); }));
  } else if (colId === 'working') {
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }));
    actions.appendChild(btn('Terminal', 'btn-sm btn-ghost', function() { doOpenTerminal(id); }));
    actions.appendChild(btn('Claude', 'btn-sm btn-ghost', function() { doOpenClaude(id); }));
    actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'build'); }));
  } else if (colId === 'review') {
    actions.appendChild(btn('Approve', 'btn-sm btn-primary', function() { doApprove(id); }));
    actions.appendChild(btn('Reject', 'btn-sm btn-ghost', function() { doReject(id); }));
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }));
    if (card.review_score > 0) {
      actions.appendChild(btn('Findings', 'btn-sm btn-ghost', function() { showFindings(id); }));
    }
    if (card.status === 'reviewing') {
      actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'review'); }));
    }
    if (card.status === 'fixing') {
      actions.appendChild(btn('Log', 'btn-sm btn-ghost', function() { showLiveLog(id, 'review-fix'); }));
    }
  } else if (colId === 'done') {
    actions.appendChild(btn('VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(id); }));
    actions.appendChild(btn('Revert', 'btn-sm btn-ghost', function() { doRevert(id); }));
    actions.appendChild(btn('Archive', 'btn-sm btn-ghost', function() { deleteCard(id); }));
  }

  cardEl.appendChild(actions);
  return cardEl;
}

// --- Folder Detection ---
var folderModal = document.getElementById('folder-modal');
var pendingFolderCardId = null;
var pendingFolderAction = null; // 'brainstorm' or null

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
      document.getElementById('folder-desc').textContent = 'Found ' + result.matches.length + ' matching folder(s). Pick one or create new:';
      for (var i = 0; i < result.matches.length; i++) {
        (function(match) {
          var row = el('div', { className: 'folder-match' }, [
            el('span', { className: 'folder-match-name', textContent: match.name }),
            el('span', { className: 'folder-match-info', textContent: match.files + ' files | score: ' + match.score }),
            btn('Use This', 'btn-sm btn-primary', function() { selectFolder(match.path); }),
          ]);
          matchesDiv.appendChild(row);
        })(result.matches[i]);
      }
    } else {
      document.getElementById('folder-desc').textContent = 'No matching folders found in ' + root;
    }

    var newPath = root + sep + result.suggestedName;
    newDiv.appendChild(
      btn('Create New: ' + result.suggestedName, 'btn-sm btn-ghost', function() { selectFolder(newPath); })
    );
    newDiv.appendChild(
      btn('Skip (no folder)', 'btn-sm btn-ghost', function() {
        folderModal.classList.remove('active');
        if (pendingFolderAction === 'brainstorm') startBrainstorm(pendingFolderCardId);
      })
    );
  } catch (e) {
    document.getElementById('folder-desc').textContent = 'Detection failed: ' + e.message;
  }
}

async function selectFolder(projectPath) {
  folderModal.classList.remove('active');
  await api('/cards/' + pendingFolderCardId + '/assign-folder', {
    method: 'POST', body: { projectPath: projectPath }
  });
  toast('Folder assigned: ' + projectPath, 'success');
  await loadCards();
  if (pendingFolderAction === 'brainstorm') {
    startBrainstorm(pendingFolderCardId);
  }
}

// --- Actions ---
async function doBrainstorm(id) {
  var card = state.cards.find(function(c) { return c.id === id; });
  if (card && !card.project_path) {
    // No folder assigned yet — detect first
    doDetect(id, 'brainstorm');
    return;
  }
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
    toast('Queued for build!', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function doOpenVSCode(id) { api('/cards/' + id + '/open-vscode', { method: 'POST' }).catch(function() {}); }
function doOpenTerminal(id) { api('/cards/' + id + '/open-terminal', { method: 'POST' }).catch(function() {}); }
function doOpenClaude(id) { api('/cards/' + id + '/open-claude', { method: 'POST' }).catch(function() {}); }

async function doApprove(id) {
  await api('/cards/' + id + '/approve', { method: 'POST' });
  toast('Card approved!', 'success');
}

async function doReject(id) {
  if (!confirm('Reject and ROLLBACK all file changes to pre-work state?')) return;
  var result = await api('/cards/' + id + '/reject', { method: 'POST' });
  if (result.rollback && result.rollback.success) {
    toast('Rejected! Files rolled back to pre-work state.', 'info');
  } else {
    toast('Rejected. ' + (result.rollback ? result.rollback.reason : 'No snapshot.'), 'info');
  }
}

async function doRevert(id) {
  if (!confirm('Revert all file changes from this card to pre-work state?')) return;
  try {
    var result = await api('/cards/' + id + '/revert-files', { method: 'POST' });
    if (result.success) {
      toast('Files reverted to pre-work state.' + (result.wasNew ? ' New project folder removed.' : ''), 'success');
    } else {
      toast('Revert failed: ' + (result.reason || 'Unknown error'), 'error');
    }
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
  document.getElementById('modal-title').textContent = 'Edit Card';
  cardModal.classList.add('active');
  document.getElementById('card-title').focus();
}

cardForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  var id = document.getElementById('card-id').value;
  var title = document.getElementById('card-title').value.trim();
  var description = document.getElementById('card-desc').value.trim();
  if (!title) return;
  try {
    if (id) {
      await api('/cards/' + id, { method: 'PUT', body: { title: title, description: description } });
      cardModal.classList.remove('active');
      await loadCards();
    } else {
      var newCard = await api('/cards', { method: 'POST', body: { title: title, description: description } });
      cardModal.classList.remove('active');
      await loadCards();
      // Auto-open folder picker → assign → auto-brainstorm → auto-work
      doDetect(newCard.id, 'brainstorm');
    }
  } catch (err) { toast(err.message, 'error'); }
});

// --- Detail Modal ---
var detailModal = document.getElementById('detail-modal');
document.getElementById('detail-close').addEventListener('click', function() { detailModal.classList.remove('active'); });
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
  addSection('Specification', card.spec);
  addSection('Session Log', card.session_log);
  addSection('Project Path', card.project_path);
  var info = 'Status: ' + card.status + '\nColumn: ' + card.column_name + '\nCreated: ' + card.created_at + '\nUpdated: ' + card.updated_at;
  if (card.review_score > 0) info += '\nAI Review Score: ' + card.review_score + '/10';
  addSection('Info', info);

  if (card.project_path) {
    var acts = el('div', { className: 'detail-actions' });
    acts.appendChild(btn('Open in VSCode', 'btn-sm btn-ghost', function() { doOpenVSCode(card.id); }));
    acts.appendChild(btn('Open Terminal', 'btn-sm btn-ghost', function() { doOpenTerminal(card.id); }));
    acts.appendChild(btn('Open Claude', 'btn-sm btn-ghost', function() { doOpenClaude(card.id); }));
    body.appendChild(acts);
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
  var detailTitle = document.getElementById('detail-title');
  var body = document.getElementById('detail-body');
  detailTitle.textContent = 'Live Log — ' + type;
  body.textContent = '';

  var logEl = el('div', { className: 'log-viewer expanded' });
  logEl.textContent = 'Connecting...';
  body.appendChild(logEl);

  // Close previous stream
  if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }

  function connectLogStream() {
    var es = new EventSource('/api/cards/' + cardId + '/log-stream?type=' + type);
    activeLogStream = es;
    var hasContent = false;

    es.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'connected') {
          if (!hasContent) logEl.textContent = 'Connected. Waiting for output...';
        } else if (data.type === 'waiting') {
          if (!hasContent) logEl.textContent = data.content || 'Waiting for log file...';
        } else if (data.type === 'initial') {
          logEl.textContent = data.content;
          hasContent = true;
        } else if (data.type === 'append') {
          if (!hasContent) { logEl.textContent = data.content; hasContent = true; }
          else logEl.textContent += data.content;
        }
        logEl.scrollTop = logEl.scrollHeight;
      } catch (_) {}
    };
    es.onerror = function() {
      es.close();
      // Reconnect after 3s if modal is still open and this is still the active stream
      if (activeLogStream === es) {
        activeLogStream = null;
        if (document.getElementById('detail-modal').classList.contains('active')) {
          logEl.textContent += '\n[Connection lost — reconnecting...]\n';
          setTimeout(function() {
            if (document.getElementById('detail-modal').classList.contains('active') && !activeLogStream) {
              connectLogStream();
            }
          }, 3000);
        }
      }
    };
  }

  connectLogStream();
  document.getElementById('detail-modal').classList.add('active');
}

// Clean up log stream when detail modal closes
var origDetailClose = document.getElementById('detail-close');
origDetailClose.addEventListener('click', function() {
  if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }
});

// --- AI Review Findings ---
async function showFindings(cardId) {
  var detailTitle = document.getElementById('detail-title');
  var body = document.getElementById('detail-body');
  detailTitle.textContent = 'AI Review Findings';
  body.textContent = '';

  try {
    var review = await api('/cards/' + cardId + '/review');

    // Score header
    var scoreCls = review.score >= 8 ? 'review-score-high' : review.score >= 5 ? 'review-score-mid' : 'review-score-low';
    var header = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:16px' }, [
      el('span', { className: 'review-score ' + scoreCls, style: 'font-size:1.2rem;padding:6px 16px', textContent: review.score + '/10' }),
      el('span', { textContent: review.summary || 'No summary', style: 'color:var(--text-muted);font-size:0.85rem' }),
    ]);
    body.appendChild(header);

    // Findings list
    var findings = review.findings || [];
    if (findings.length === 0) {
      body.appendChild(el('p', { textContent: 'No specific findings.', style: 'color:var(--text-muted);font-size:0.85rem' }));
    } else {
      for (var i = 0; i < findings.length; i++) {
        var f = findings[i];
        var sev = f.severity || 'info';
        var sevColor = sev === 'critical' ? '#ef4444' : sev === 'warning' ? '#eab308' : 'var(--text-muted)';
        var row = el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, [
          el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:4px' }, [
            el('span', {
              textContent: sev.toUpperCase(),
              style: 'font-size:0.6rem;font-weight:700;padding:1px 6px;border-radius:4px;background:' + sevColor + '20;color:' + sevColor,
            }),
            el('span', {
              textContent: f.category || '',
              style: 'font-size:0.6rem;color:var(--text-muted);text-transform:uppercase',
            }),
          ]),
          el('div', { textContent: f.message, style: 'font-size:0.8rem;line-height:1.4' }),
          f.file ? el('div', {
            textContent: f.file,
            style: 'font-size:0.65rem;color:var(--todo);font-family:monospace;margin-top:2px',
          }) : null,
        ]);
        body.appendChild(row);
      }
    }
  } catch (err) {
    body.appendChild(el('p', { textContent: 'Failed to load review: ' + err.message, style: 'color:#ef4444' }));
  }

  document.getElementById('detail-modal').classList.add('active');
}

// --- Archive ---
var archiveModal = document.getElementById('archive-modal');
document.getElementById('archive-close').addEventListener('click', function() { archiveModal.classList.remove('active'); });
archiveModal.addEventListener('click', function(e) { if (e.target === archiveModal) archiveModal.classList.remove('active'); });

document.getElementById('archive-btn').addEventListener('click', function() { showArchive(); });

async function showArchive() {
  var body = document.getElementById('archive-body');
  body.textContent = '';
  archiveModal.classList.add('active');

  try {
    var archived = await api('/archive');
    if (archived.length === 0) {
      body.appendChild(el('p', { textContent: 'No archived cards.', style: 'color:var(--text-tertiary);font-size:13px;padding:16px 0' }));
      return;
    }

    for (var i = 0; i < archived.length; i++) {
      (function(card) {
        var row = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)' }, [
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:2px', textContent: card.title }),
            el('div', { style: 'font-size:11px;color:var(--text-tertiary)', textContent: (card.project_path || 'No project') + '  ·  ' + timeAgo(card.updated_at) }),
          ]),
          card.review_score > 0 ? el('span', {
            className: 'review-score ' + (card.review_score >= 8 ? 'review-score-high' : card.review_score >= 5 ? 'review-score-mid' : 'review-score-low'),
            textContent: card.review_score + '/10',
          }) : null,
          btn('Revert', 'btn-sm btn-ghost', async function() {
            if (!confirm('Revert file changes from "' + card.title + '" to pre-work state?')) return;
            try {
              var rv = await api('/cards/' + card.id + '/revert-files', { method: 'POST' });
              if (rv.success) toast('Files reverted for: ' + card.title, 'success');
              else toast('No snapshot: ' + (rv.reason || ''), 'error');
            } catch (err) { toast(err.message, 'error'); }
          }),
          btn('Restore', 'btn-sm btn-ghost', async function() {
            await api('/cards/' + card.id + '/unarchive', { method: 'POST' });
            toast('Card restored to Done', 'success');
            showArchive(); // refresh
            loadCards();
          }),
          btn('Delete', 'btn-sm btn-ghost', async function() {
            if (!confirm('Permanently delete "' + card.title + '"?')) return;
            await api('/cards/' + card.id, { method: 'DELETE' });
            toast('Card deleted', 'info');
            showArchive();
          }),
        ]);
        body.appendChild(row);
      })(archived[i]);
    }
  } catch (err) {
    body.appendChild(el('p', { textContent: 'Failed to load archive: ' + err.message, style: 'color:var(--error)' }));
  }
}

// --- Keyboard ---
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    cardModal.classList.remove('active');
    detailModal.classList.remove('active');
    folderModal.classList.remove('active');
    archiveModal.classList.remove('active');
    if (activeLogStream) { activeLogStream.close(); activeLogStream = null; }
  }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && document.activeElement === document.body) {
    document.getElementById('add-btn').click();
  }
});

// --- Init ---
async function init() {
  // Fetch initial state in parallel
  var cardsP = api('/cards');
  var activitiesP = fetch('/api/activities').then(function(r) { return r.json(); }).catch(function() { return {}; });
  var results = await Promise.all([cardsP, activitiesP]);
  state.cards = results[0];
  cardActivities = results[1];
  render();
  connectSSE();

  // Notify about new cards since last visit
  if (lastVisitTime > 0) {
    var newCount = state.cards.filter(function(c) {
      return c.created_at && new Date(c.created_at.replace(' ', 'T') + 'Z').getTime() > lastVisitTime;
    }).length;
    if (newCount > 0) {
      toast(newCount + ' new card' + (newCount > 1 ? 's' : '') + ' since your last visit', 'info');
    }
  }
  // Update last visit timestamp (delayed so user sees NEW badges first)
  setTimeout(function() {
    localStorage.setItem('claude-kanban-last-visit', String(Date.now()));
  }, 5000);
}
init();
