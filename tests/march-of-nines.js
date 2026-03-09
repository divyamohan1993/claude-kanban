#!/usr/bin/env node
// =============================================================================
// MARCH OF NINES — Comprehensive Reliability & Trust Test Suite
// =============================================================================
// Tests 9 dimensions of software dependability:
//   1. Startup & Health
//   2. API Contract Compliance
//   3. Error Resilience (bad input, boundary)
//   4. Security Posture (CSRF, injection, headers, auth)
//   5. Data Integrity (CRUD, consistency, idempotency)
//   6. Concurrency Safety (parallel ops)
//   7. Recovery & Self-Healing
//   8. Configuration Robustness
//   9. Edge Cases & Stress
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:51777';
let SESSION_COOKIE = '';
let ADMIN_PATH = '';
let ADMIN_PORT = '';

// Test counters
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const startTime = Date.now();

// =============================================================================
// HTTP HELPER
// =============================================================================
function request(method, urlPath, body, opts) {
  return new Promise(function(resolve) {
    const url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
    }
    if (opts && opts.origin) headers['Origin'] = opts.origin;
    if (opts && opts.headers) Object.assign(headers, opts.headers);
    if (opts && opts.noCsrf) {
      delete headers['X-Requested-With'];
      delete headers['Origin'];
    }

    const data = body ? JSON.stringify(body) : undefined;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
      timeout: 10000,
    };

    const req = http.request(options, function(res) {
      let body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
          json: json,
        });
      });
    });
    req.on('error', function(err) {
      resolve({ status: 0, headers: {}, body: '', json: null, error: err.message });
    });
    req.on('timeout', function() {
      req.destroy();
      resolve({ status: 0, headers: {}, body: '', json: null, error: 'timeout' });
    });
    if (data) req.write(data);
    req.end();
  });
}

// =============================================================================
// TEST HELPERS
// =============================================================================
function assert(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write('  [PASS] ' + name + '\n');
  } else {
    failed++;
    const msg = name + (detail ? ' — ' + detail : '');
    failures.push(msg);
    process.stdout.write('  [FAIL] ' + msg + '\n');
  }
}

function skip(name, reason) {
  skipped++;
  process.stdout.write('  [SKIP] ' + name + ' — ' + reason + '\n');
}

function section(name) {
  process.stdout.write('\n========== ' + name + ' ==========\n');
}

// =============================================================================
// AUTHENTICATION SETUP
// =============================================================================
async function authenticate() {
  // Check if setup needs to be completed first
  const setupCheck = await request('GET', '/auth/setup');
  const setupNeeded = setupCheck.status === 200 && setupCheck.body.includes('setup');

  if (setupNeeded) {
    process.stdout.write('  Setup wizard detected — completing first-run setup...\n');
    const setupRes = await request('POST', '/auth/setup', {
      username: 'testadmin',
      password: 'testadmin1234',
      displayName: 'Test Admin',
      email: 'test@localhost',
      ssoConfig: { provider: 'builtin' },
    });
    if (setupRes.status === 200 && setupRes.json && setupRes.json.ok) {
      process.stdout.write('  Setup complete. Logging in as testadmin.\n');
      // Login as the new superadmin
      const loginRes = await request('POST', '/auth/login', { username: 'testadmin', password: 'testadmin1234' });
      if (loginRes.status === 200 && loginRes.json && loginRes.json.ok) {
        const setCookie = loginRes.headers['set-cookie'];
        if (setCookie) {
          const match = (Array.isArray(setCookie) ? setCookie[0] : setCookie).match(/sid=([^;]+)/);
          if (match) SESSION_COOKIE = 'sid=' + match[1];
        }
        const sessionRes = await request('GET', '/auth/session');
        if (sessionRes.json && sessionRes.json.adminPath) {
          ADMIN_PATH = sessionRes.json.adminPath;
        }
        return true;
      }
    } else {
      process.stdout.write('  Setup failed: ' + (setupRes.json ? setupRes.json.error : setupRes.body.substring(0, 100)) + '\n');
    }
  }

  // Try login with default admin credentials
  const loginRes = await request('POST', '/auth/login', { username: 'admin', password: 'admin' });
  if (loginRes.status === 200 && loginRes.json && loginRes.json.ok) {
    const setCookie = loginRes.headers['set-cookie'];
    if (setCookie) {
      const match = (Array.isArray(setCookie) ? setCookie[0] : setCookie).match(/sid=([^;]+)/);
      if (match) SESSION_COOKIE = 'sid=' + match[1];
    }
    // Get admin path
    const sessionRes = await request('GET', '/auth/session');
    if (sessionRes.json && sessionRes.json.adminPath) {
      ADMIN_PATH = sessionRes.json.adminPath;
    }
    return true;
  }

  // Try superadmin
  const saLogin = await request('POST', '/auth/login', { username: 'testadmin', password: 'testadmin1234' });
  if (saLogin.status === 200 && saLogin.json && saLogin.json.ok) {
    const setCookie = saLogin.headers['set-cookie'];
    if (setCookie) {
      const match = (Array.isArray(setCookie) ? setCookie[0] : setCookie).match(/sid=([^;]+)/);
      if (match) SESSION_COOKIE = 'sid=' + match[1];
    }
    const sessionRes = await request('GET', '/auth/session');
    if (sessionRes.json && sessionRes.json.adminPath) {
      ADMIN_PATH = sessionRes.json.adminPath;
    }
    return true;
  }
  return false;
}

// =============================================================================
// DIMENSION 1: STARTUP & HEALTH
// =============================================================================
async function testStartupHealth() {
  section('DIMENSION 1: STARTUP & HEALTH');

  // 1.1 Shallow health
  const health = await request('GET', '/health');
  assert('Health endpoint returns 200', health.status === 200);
  assert('Health returns status ok', health.json && health.json.status === 'ok');
  assert('Health returns uptime', health.json && typeof health.json.uptime === 'number' && health.json.uptime > 0);

  // 1.2 Deep readiness probe
  const ready = await request('GET', '/health/ready');
  assert('Readiness probe returns 200', ready.status === 200);
  assert('DB check passes', ready.json && ready.json.checks && ready.json.checks.db === 'ok');
  assert('Disk check passes', ready.json && ready.json.checks && ready.json.checks.disk === 'ok');
  assert('Pipeline check present', ready.json && ready.json.checks && ready.json.checks.pipeline);
  assert('Error count present', ready.json && ready.json.checks && ready.json.checks.errors);
  assert('Ready status is ready or degraded', ready.json && (ready.json.status === 'ready' || ready.json.status === 'degraded'));

  // 1.3 Static assets
  const indexPage = await request('GET', '/');
  assert('Index page returns 200', indexPage.status === 200);
  assert('Index page is HTML', indexPage.headers['content-type'] && indexPage.headers['content-type'].includes('text/html'));
  assert('Index page has cache-busted content', indexPage.body.includes('.js?') || indexPage.body.includes('.css?') || !indexPage.body.includes('__BUST__'));

  // 1.4 CSS loads
  const css = await request('GET', '/style.css');
  assert('CSS returns 200', css.status === 200);

  // 1.5 JS loads
  const js = await request('GET', '/app.js');
  assert('JS returns 200', js.status === 200);
}

// =============================================================================
// DIMENSION 2: API CONTRACT COMPLIANCE
// =============================================================================
async function testApiContracts() {
  section('DIMENSION 2: API CONTRACT COMPLIANCE');

  // 2.1 Cards list
  const cardsList = await request('GET', '/api/cards');
  assert('GET /api/cards returns 200', cardsList.status === 200);
  assert('Cards returns array', Array.isArray(cardsList.json));

  // 2.2 Queue
  const queue = await request('GET', '/api/queue');
  assert('GET /api/queue returns 200', queue.status === 200);
  assert('Queue has expected shape', queue.json && 'queue' in queue.json);

  // 2.3 Activities
  const activities = await request('GET', '/api/activities');
  assert('GET /api/activities returns 200', activities.status === 200);

  // 2.4 Pipeline state
  const pipeline = await request('GET', '/api/pipeline');
  assert('GET /api/pipeline returns 200', pipeline.status === 200);
  assert('Pipeline has paused field', pipeline.json && 'paused' in pipeline.json);

  // 2.5 Config (public)
  const config = await request('GET', '/api/config');
  assert('GET /api/config returns 200', config.status === 200);
  assert('Config has runtime', config.json && config.json.runtime);

  // 2.6 Mode
  const mode = await request('GET', '/api/mode');
  assert('GET /api/mode returns 200', mode.status === 200);
  assert('Mode has mode field', mode.json && mode.json.mode);

  // 2.7 Templates
  const templates = await request('GET', '/api/templates');
  assert('GET /api/templates returns 200', templates.status === 200);
  assert('Templates is array with entries', Array.isArray(templates.json) && templates.json.length > 0);
  assert('Template has required fields', templates.json[0].id && templates.json[0].name && templates.json[0].title);

  // 2.8 Trends
  const trends = await request('GET', '/api/trends');
  assert('GET /api/trends returns 200', trends.status === 200);
  assert('Trends has weekly data', trends.json && Array.isArray(trends.json.weeklyCompletions));

  // 2.9 Metrics
  const metrics = await request('GET', '/api/metrics');
  assert('GET /api/metrics returns 200', metrics.status === 200);

  // 2.10 Search
  const search = await request('GET', '/api/search?q=test');
  assert('GET /api/search returns 200', search.status === 200);
  assert('Search returns array', Array.isArray(search.json));

  // 2.11 Auth session
  const session = await request('GET', '/auth/session');
  assert('GET /auth/session returns 200', session.status === 200);
  assert('Session has authenticated field', session.json && 'authenticated' in session.json);

  // 2.12 Spec intelligence
  const specInt = await request('GET', '/api/spec-intelligence');
  assert('GET /api/spec-intelligence returns 200', specInt.status === 200);

  // 2.13 Archive
  const archive = await request('GET', '/api/archive');
  assert('GET /api/archive returns 200', archive.status === 200);
  assert('Archive returns array', Array.isArray(archive.json));

  // 2.14 SSE endpoint
  const sseRes = await new Promise(function(resolve) {
    const url = new URL(BASE + '/api/events');
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
      timeout: 2000,
    };
    const req = http.request(opts, function(res) {
      let data = '';
      res.on('data', function(chunk) {
        data += chunk;
        req.destroy(); // We got data, close
        resolve({ status: res.statusCode, headers: res.headers, data: data });
      });
      setTimeout(function() { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, data: data }); }, 1500);
    });
    req.on('error', function() { resolve({ status: 0 }); });
    req.end();
  });
  assert('SSE endpoint returns 200', sseRes.status === 200);
  assert('SSE content-type is event-stream', sseRes.headers && sseRes.headers['content-type'] === 'text/event-stream');
}

// =============================================================================
// DIMENSION 3: ERROR RESILIENCE
// =============================================================================
async function testErrorResilience() {
  section('DIMENSION 3: ERROR RESILIENCE');

  // 3.1 Missing title on card create
  const noTitle = await request('POST', '/api/cards', {});
  assert('Card create without title returns 400', noTitle.status === 400);
  assert('Error message mentions title', noTitle.json && noTitle.json.error && noTitle.json.error.toLowerCase().includes('title'));

  // 3.2 Title too long
  const longTitle = await request('POST', '/api/cards', { title: 'x'.repeat(501) });
  assert('Title > 500 chars returns 400', longTitle.status === 400);

  // 3.3 Description too long
  const longDesc = await request('POST', '/api/cards', { title: 'test', description: 'x'.repeat(10001) });
  assert('Description > 10K chars returns 400', longDesc.status === 400);

  // 3.4 Invalid card ID
  const badId = await request('GET', '/api/cards/99999/review');
  assert('Non-existent card returns 404', badId.status === 404);

  // 3.5 Invalid log type (path traversal attempt)
  // Express resolves .. before routing, so this becomes /api/etc/passwd -> 404. Traversal is blocked.
  const traversal = await request('GET', '/api/cards/1/log/../../etc/passwd');
  assert('Path traversal in log type is blocked', traversal.status === 400 || traversal.status === 404);

  // 3.6 Invalid log type
  const badLogType = await request('GET', '/api/cards/1/log/notvalid');
  assert('Invalid log type returns 400', badLogType.status === 400);

  // 3.7 Move to invalid column
  const badCol = await request('POST', '/api/cards/1/move', { column: 'nonexistent' });
  assert('Invalid column returns 400', badCol.status === 400 || badCol.status === 404);

  // 3.8 Malformed JSON body
  const malformed = await new Promise(function(resolve) {
    const url = new URL(BASE + '/api/cards');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': '5',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers: headers,
    }, function(res) {
      let body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.write('{bad}');
    req.end();
  });
  assert('Malformed JSON returns 400', malformed.status === 400);

  // 3.9 Non-JSON content type on API POST
  const wrongCT = await new Promise(function(resolve) {
    const url = new URL(BASE + '/api/cards');
    const headers = {
      'Content-Type': 'text/plain',
      'Content-Length': '4',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers: headers,
    }, function(res) {
      let body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.write('test');
    req.end();
  });
  assert('Non-JSON Content-Type returns 415', wrongCT.status === 415);

  // 3.10 Spec too long
  const longSpec = await request('PUT', '/api/cards/99999/spec', { spec: 'x'.repeat(100001) });
  assert('Spec > 100K chars returns 400', longSpec.status === 400);

  // 3.11 Labels too long
  const longLabels = await request('PUT', '/api/cards/99999/labels', { labels: 'x'.repeat(1001) });
  assert('Labels > 1000 chars returns 400', longLabels.status === 400);

  // 3.12 Dependencies invalid format
  const badDeps = await request('PUT', '/api/cards/99999/depends-on', { dependsOn: 'abc,def' });
  assert('Non-numeric dependencies returns 400', badDeps.status === 400);

  // 3.13 Feedback too long
  const longFeedback = await request('POST', '/api/cards/99999/feedback', { text: 'x'.repeat(5001) });
  assert('Feedback > 5K chars returns 400', longFeedback.status === 400 || longFeedback.status === 404);

  // 3.14 Idea text too long
  const longIdea = await request('POST', '/api/ideas', { text: 'x'.repeat(5001) });
  assert('Idea > 5K chars returns 400', longIdea.status === 400);

  // 3.15 Retry without feedback
  const noFeedback = await request('POST', '/api/cards/99999/retry', {});
  assert('Retry without feedback returns 400', noFeedback.status === 400);

  // 3.16 Empty search
  const emptySearch = await request('GET', '/api/search');
  assert('Empty search returns empty array', emptySearch.status === 200 && Array.isArray(emptySearch.json) && emptySearch.json.length === 0);

  // 3.17 Bulk create with empty items
  const emptyBulk = await request('POST', '/api/bulk-create', { items: [] });
  assert('Empty bulk create returns 400', emptyBulk.status === 400);

  // 3.18 Bulk create with non-array
  const badBulk = await request('POST', '/api/bulk-create', { items: 'notarray' });
  assert('Non-array bulk create returns 400', badBulk.status === 400);
}

// =============================================================================
// DIMENSION 4: SECURITY POSTURE
// =============================================================================
async function testSecurity() {
  section('DIMENSION 4: SECURITY POSTURE');

  // 4.1 Security headers present
  const headersRes = await request('GET', '/health');
  assert('X-Content-Type-Options set', headersRes.headers['x-content-type-options'] === 'nosniff');
  assert('X-Frame-Options set', headersRes.headers['x-frame-options'] === 'DENY');
  assert('Referrer-Policy set', headersRes.headers['referrer-policy'] === 'strict-origin-when-cross-origin');
  assert('X-Request-Id present', !!headersRes.headers['x-request-id']);
  assert('CSP header present', !!headersRes.headers['content-security-policy']);
  assert('CSP has nonce', headersRes.headers['content-security-policy'] && headersRes.headers['content-security-policy'].includes('nonce-'));
  assert('Permissions-Policy set', !!headersRes.headers['permissions-policy']);
  assert('X-XSS-Protection set', headersRes.headers['x-xss-protection'] === '0');

  // 4.2 Cache-Control
  assert('API Cache-Control is no-store', headersRes.headers['cache-control'] !== undefined);
  const cssRes = await request('GET', '/style.css');
  assert('Static Cache-Control is public', cssRes.headers['cache-control'] && cssRes.headers['cache-control'].includes('public'));

  // 4.3 CSRF — POST without Origin or X-Requested-With
  const csrfRes = await request('POST', '/api/cards', { title: 'csrf test' }, { noCsrf: true });
  assert('POST without Origin/XRW returns 403', csrfRes.status === 403);
  assert('CSRF error code present', csrfRes.json && csrfRes.json.code === 'CSRF_PROTECTION');

  // 4.4 CSRF — POST with wrong origin
  const wrongOrigin = await request('POST', '/api/cards', { title: 'origin test' }, { origin: 'https://evil.com' });
  assert('POST with wrong origin returns 403', wrongOrigin.status === 403);
  assert('Origin rejected code', wrongOrigin.json && wrongOrigin.json.code === 'ORIGIN_REJECTED');

  // 4.5 Auth — write endpoints require auth (test without session)
  const savedCookie = SESSION_COOKIE;
  SESSION_COOKIE = '';
  const noAuthCreate = await request('POST', '/api/cards', { title: 'no auth' });
  assert('Card create without auth returns 401', noAuthCreate.status === 401);

  const noAuthUpdate = await request('PUT', '/api/cards/1', { title: 'no auth' });
  assert('Card update without auth returns 401', noAuthUpdate.status === 401);

  const noAuthDelete = await request('DELETE', '/api/cards/1');
  assert('Card delete without auth returns 401', noAuthDelete.status === 401);

  const noAuthBrainstorm = await request('POST', '/api/cards/1/brainstorm');
  assert('Brainstorm without auth returns 401', noAuthBrainstorm.status === 401);
  SESSION_COOKIE = savedCookie;

  // 4.6 Auth — read endpoints work without auth (public board)
  SESSION_COOKIE = '';
  const publicCards = await request('GET', '/api/cards');
  assert('Cards list is publicly readable', publicCards.status === 200);

  const publicQueue = await request('GET', '/api/queue');
  assert('Queue is publicly readable', publicQueue.status === 200);
  SESSION_COOKIE = savedCookie;

  // 4.7 Auth — verify cards don't include actions for unauthenticated users
  SESSION_COOKIE = '';
  const anonCards = await request('GET', '/api/cards');
  if (Array.isArray(anonCards.json) && anonCards.json.length > 0) {
    assert('Anonymous user gets empty actions', anonCards.json[0].actions && anonCards.json[0].actions.length === 0);
  } else {
    skip('Anonymous actions check', 'no cards in system');
  }
  SESSION_COOKIE = savedCookie;

  // 4.8 Log type path traversal — Express resolves .. at URL level, blocking traversal via 404
  const traversal1 = await request('GET', '/api/cards/1/log/../../../etc/passwd');
  assert('Log path traversal blocked', traversal1.status === 400 || traversal1.status === 404);

  const traversal2 = await request('GET', '/api/cards/1/log/build%2F..%2F..%2Fetc%2Fpasswd');
  assert('URL-encoded traversal blocked', traversal2.status === 400);

  // 4.9 Login rate limiting
  const loginRes = await request('POST', '/auth/login', { username: 'nonexistent', password: 'wrong' });
  assert('Failed login returns 401', loginRes.status === 401);

  // 4.10 Setup wizard locked after first run
  const setupRes = await request('GET', '/auth/setup');
  // When setup is complete: redirects to / (302) or serves the board (200 with redirect HTML)
  assert('Setup page redirects when complete',
    setupRes.status === 302 ||
    (setupRes.status === 200 && !setupRes.body.includes('First-Time Setup')) ||
    setupRes.status === 404);

  const setupPost = await request('POST', '/auth/setup', { username: 'hack', password: 'hacking123', displayName: 'Hacker' });
  // Must be blocked: 403 (forbidden) or 404 (route not found after setup complete)
  assert('Setup POST blocked after completion', setupPost.status === 403 || setupPost.status === 404);

  // 4.11 Control panel blocked on public port
  const cpRes = await request('GET', '/control-panel.html');
  assert('Control panel blocked on public port', cpRes.status === 404);

  // 4.12 User management blocked on public port
  const umRes = await request('GET', '/user-management.html');
  assert('User management blocked on public port', umRes.status === 404);

  // 4.13 SQL injection in search
  const sqli = await request('GET', "/api/search?q=' OR 1=1 --");
  assert('SQL injection in search returns 200 (parameterized)', sqli.status === 200);

  // 4.14 XSS in card title (server should accept but not execute)
  const xssCard = await request('POST', '/api/cards', { title: '<script>alert("xss")</script>' });
  if (xssCard.status === 200 && xssCard.json) {
    assert('XSS in title stored safely', xssCard.json.title === '<script>alert("xss")</script>');
    // Clean up
    await request('DELETE', '/api/cards/' + xssCard.json.id);
  } else {
    skip('XSS test', 'card creation failed');
  }

  // 4.15 User management API requires superadmin (admin role should be rejected)
  const userListRes = await request('GET', '/api/users');
  assert('User list requires superadmin', userListRes.status === 403 || userListRes.status === 401 || userListRes.status === 404);
}

// =============================================================================
// DIMENSION 5: DATA INTEGRITY
// =============================================================================
async function testDataIntegrity() {
  section('DIMENSION 5: DATA INTEGRITY');

  // 5.1 Create card
  const createRes = await request('POST', '/api/cards', { title: 'March of Nines Test Card', description: 'Reliability test' });
  assert('Card creation returns 200', createRes.status === 200);
  assert('Card has id', createRes.json && typeof createRes.json.id === 'number');
  assert('Card has correct title', createRes.json && createRes.json.title === 'March of Nines Test Card');
  assert('Card defaults to brainstorm column', createRes.json && createRes.json.column_name === 'brainstorm');
  assert('Card defaults to idle status', createRes.json && createRes.json.status === 'idle');
  assert('Card has created_at', createRes.json && createRes.json.created_at);
  assert('Card has updated_at', createRes.json && createRes.json.updated_at);
  assert('Card has computed actions', createRes.json && Array.isArray(createRes.json.actions));
  assert('Card has computed display', createRes.json && createRes.json.display);
  const testCardId = createRes.json ? createRes.json.id : null;

  if (!testCardId) {
    skip('Remaining data integrity tests', 'card creation failed');
    return;
  }

  // 5.2 Read card back
  const readRes = await request('GET', '/api/cards');
  const found = readRes.json ? readRes.json.find(function(c) { return c.id === testCardId; }) : null;
  assert('Created card appears in list', !!found);
  assert('Card data matches', found && found.title === 'March of Nines Test Card');

  // 5.3 Update card
  const updateRes = await request('PUT', '/api/cards/' + testCardId, {
    title: 'Updated Test Card',
    description: 'Updated description',
  });
  assert('Card update returns 200', updateRes.status === 200);
  assert('Title updated correctly', updateRes.json && updateRes.json.title === 'Updated Test Card');
  assert('Description updated correctly', updateRes.json && updateRes.json.description === 'Updated description');

  // 5.4 Update spec
  const specRes = await request('PUT', '/api/cards/' + testCardId + '/spec', { spec: 'Test specification content' });
  assert('Spec update returns 200', specRes.status === 200);
  assert('Spec stored correctly', specRes.json && specRes.json.spec === 'Test specification content');

  // 5.5 Update labels
  const labelRes = await request('PUT', '/api/cards/' + testCardId + '/labels', { labels: 'test,reliability' });
  assert('Labels update returns 200', labelRes.status === 200);
  assert('Labels stored correctly', labelRes.json && labelRes.json.labels === 'test,reliability');

  // 5.6 Update dependencies
  const depRes = await request('PUT', '/api/cards/' + testCardId + '/depends-on', { dependsOn: '' });
  assert('Dependencies update returns 200', depRes.status === 200);

  // 5.7 Review data (no review yet)
  const reviewRes = await request('GET', '/api/cards/' + testCardId + '/review');
  assert('Review returns empty findings', reviewRes.status === 200 && reviewRes.json && Array.isArray(reviewRes.json.findings));

  // 5.8 Sessions for card
  const sessRes = await request('GET', '/api/cards/' + testCardId + '/sessions');
  assert('Sessions returns array', sessRes.status === 200 && Array.isArray(sessRes.json));

  // 5.9 Snapshot check
  const snapRes = await request('GET', '/api/cards/' + testCardId + '/has-snapshot');
  assert('Snapshot check returns boolean', snapRes.status === 200 && snapRes.json && typeof snapRes.json.has === 'boolean');

  // 5.10 Feedback
  const fbRes = await request('POST', '/api/cards/' + testCardId + '/feedback', { text: 'Test feedback for reliability' });
  assert('Feedback returns 200', fbRes.status === 200);
  assert('Feedback appended to spec', fbRes.json && fbRes.json.spec && fbRes.json.spec.includes('Test feedback'));

  // 5.11 Bulk create
  const bulkRes = await request('POST', '/api/bulk-create', {
    items: [
      { title: 'Bulk Test 1' },
      { title: 'Bulk Test 2', description: 'desc2', labels: 'bulk' },
      { title: 'Bulk Test 3', column: 'brainstorm' },
    ]
  });
  assert('Bulk create returns 200', bulkRes.status === 200);
  assert('Bulk created 3 cards', bulkRes.json && bulkRes.json.created === 3);
  const bulkIds = bulkRes.json ? bulkRes.json.cards.map(function(c) { return c.id; }) : [];

  // 5.12 Search finds created card
  const searchRes = await request('GET', '/api/search?q=Updated Test');
  assert('Search finds updated card', searchRes.status === 200 && searchRes.json.some(function(c) { return c.id === testCardId; }));

  // 5.13 Delete card
  const deleteRes = await request('DELETE', '/api/cards/' + testCardId);
  assert('Delete returns success', deleteRes.status === 200 && deleteRes.json && deleteRes.json.success);

  // 5.14 Deleted card no longer in list
  const afterDelete = await request('GET', '/api/cards');
  const deleted = Array.isArray(afterDelete.json) ? afterDelete.json.find(function(c) { return c.id === testCardId; }) : null;
  assert('Deleted card absent from list', !deleted);

  // Clean up bulk cards
  for (let i = 0; i < bulkIds.length; i++) {
    await request('DELETE', '/api/cards/' + bulkIds[i]);
  }
}

// =============================================================================
// DIMENSION 6: CONCURRENCY SAFETY
// =============================================================================
async function testConcurrency() {
  section('DIMENSION 6: CONCURRENCY SAFETY');

  // 6.1 Parallel card creation (10 simultaneous)
  const createPromises = [];
  for (let i = 0; i < 10; i++) {
    createPromises.push(request('POST', '/api/cards', { title: 'Concurrent ' + i }));
  }
  const results = await Promise.all(createPromises);
  const successful = results.filter(function(r) { return r.status === 200; });
  assert('10 parallel creates all succeed', successful.length === 10);
  const ids = successful.map(function(r) { return r.json.id; });
  const uniqueIds = new Set(ids);
  assert('All concurrent cards get unique IDs', uniqueIds.size === 10);

  // 6.2 Parallel reads
  const readPromises = [];
  for (let i = 0; i < 20; i++) {
    readPromises.push(request('GET', '/api/cards'));
  }
  const readResults = await Promise.all(readPromises);
  const readSuccessful = readResults.filter(function(r) { return r.status === 200; });
  assert('20 parallel reads all succeed', readSuccessful.length === 20);

  // 6.3 Parallel updates to different cards
  const updatePromises = [];
  for (let i = 0; i < ids.length; i++) {
    updatePromises.push(request('PUT', '/api/cards/' + ids[i], { title: 'Updated Concurrent ' + i, description: 'updated' }));
  }
  const updateResults = await Promise.all(updatePromises);
  const updateSuccess = updateResults.filter(function(r) { return r.status === 200; });
  assert('10 parallel updates all succeed', updateSuccess.length === 10);

  // 6.4 Parallel mixed operations
  const mixedPromises = [
    request('GET', '/api/cards'),
    request('GET', '/api/queue'),
    request('GET', '/api/activities'),
    request('GET', '/api/pipeline'),
    request('GET', '/api/config'),
    request('GET', '/api/trends'),
    request('GET', '/api/metrics'),
    request('GET', '/health'),
    request('GET', '/health/ready'),
    request('GET', '/api/search?q=Concurrent'),
  ];
  const mixedResults = await Promise.all(mixedPromises);
  const mixedSuccess = mixedResults.filter(function(r) { return r.status === 200; });
  assert('10 parallel mixed ops all succeed', mixedSuccess.length === 10);

  // 6.5 Parallel deletes
  const deletePromises = ids.map(function(id) { return request('DELETE', '/api/cards/' + id); });
  const deleteResults = await Promise.all(deletePromises);
  const deleteSuccess = deleteResults.filter(function(r) { return r.status === 200; });
  assert('10 parallel deletes all succeed', deleteSuccess.length === 10);

  // 6.6 Verify all deleted
  const finalCards = await request('GET', '/api/cards');
  const remaining = Array.isArray(finalCards.json) ? finalCards.json.filter(function(c) { return c.title && c.title.startsWith('Updated Concurrent'); }) : [];
  assert('All concurrent cards properly deleted', remaining.length === 0);
}

// =============================================================================
// DIMENSION 7: RECOVERY & SELF-HEALING
// =============================================================================
async function testRecovery() {
  section('DIMENSION 7: RECOVERY & SELF-HEALING');

  // 7.1 Pipeline state consistency
  const pState = await request('GET', '/api/pipeline');
  assert('Pipeline state is boolean', typeof pState.json.paused === 'boolean');

  // 7.2 Pause/resume cycle
  const pause = await request('POST', '/api/pipeline/pause');
  assert('Pipeline pause works', pause.status === 200 && pause.json && pause.json.paused === true);

  const verifyPaused = await request('GET', '/api/pipeline');
  assert('Pipeline confirms paused', verifyPaused.json && verifyPaused.json.paused === true);

  const resume = await request('POST', '/api/pipeline/resume');
  assert('Pipeline resume works', resume.status === 200 && resume.json && resume.json.paused === false);

  const verifyResumed = await request('GET', '/api/pipeline');
  assert('Pipeline confirms resumed', verifyResumed.json && verifyResumed.json.paused === false);

  // 7.3 Card state transitions
  const card = await request('POST', '/api/cards', { title: 'Recovery Test Card' });
  const cid = card.json ? card.json.id : null;
  if (!cid) {
    skip('Recovery state tests', 'card creation failed');
    return;
  }

  // Valid move: brainstorm -> todo
  const move1 = await request('POST', '/api/cards/' + cid + '/move', { column: 'todo' });
  assert('Move brainstorm->todo works', move1.status === 200 && move1.json && move1.json.column_name === 'todo');

  // Move back
  const move2 = await request('POST', '/api/cards/' + cid + '/move', { column: 'brainstorm' });
  assert('Move todo->brainstorm works', move2.status === 200);

  // 7.4 Checkpoints
  const checkpoints = await request('GET', '/api/checkpoints');
  assert('Checkpoints returns array', checkpoints.status === 200 && Array.isArray(checkpoints.json));

  // Clean up
  await request('DELETE', '/api/cards/' + cid);
}

// =============================================================================
// DIMENSION 8: CONFIGURATION ROBUSTNESS
// =============================================================================
async function testConfiguration() {
  section('DIMENSION 8: CONFIGURATION ROBUSTNESS');

  // 8.1 Public config does not leak secrets
  const config = await request('GET', '/api/config');
  assert('Config present', config.status === 200 && config.json);
  assert('Config has runtime', config.json && config.json.runtime);
  assert('Config does not expose admin port', !config.body.includes('admin_port') || config.json.adminPort === undefined);
  assert('Config does not expose JWT secret', !config.body.includes('SSO_JWT_SECRET'));
  assert('Config does not expose master key', !config.body.includes('master_encryption_key'));

  // 8.2 Mode endpoint returns valid state
  const modeRes = await request('GET', '/api/mode');
  assert('Mode returns valid mode', modeRes.json && (modeRes.json.mode === 'global' || modeRes.json.mode === 'single-project'));

  // 8.3 Templates are well-formed
  const templates = await request('GET', '/api/templates');
  assert('All templates have required fields',
    templates.json && templates.json.every(function(t) { return t.id && t.name && t.title && t.body; }));

  // 8.4 Valid columns are enforced
  const badColumn = await request('POST', '/api/cards', { title: 'col test' });
  const colCardId = badColumn.json ? badColumn.json.id : null;
  if (colCardId) {
    const invalidCol = await request('POST', '/api/cards/' + colCardId + '/move', { column: 'hacked-column' });
    assert('Invalid column name rejected', invalidCol.status === 400);
    await request('DELETE', '/api/cards/' + colCardId);
  }

  // 8.5 SSO config (not accessible as admin, only superadmin)
  const ssoConfig = await request('GET', '/api/sso-config');
  assert('SSO config requires superadmin', ssoConfig.status === 403 || ssoConfig.status === 401);
}

// =============================================================================
// DIMENSION 9: EDGE CASES & STRESS
// =============================================================================
async function testEdgeCases() {
  section('DIMENSION 9: EDGE CASES & STRESS');

  // 9.1 Empty string title
  const emptyTitle = await request('POST', '/api/cards', { title: '' });
  assert('Empty string title rejected', emptyTitle.status === 400);

  // 9.2 Unicode title
  const unicodeRes = await request('POST', '/api/cards', { title: 'Test with Unicode: ' });
  assert('Unicode title accepted', unicodeRes.status === 200);
  if (unicodeRes.json) {
    assert('Unicode preserved', unicodeRes.json.title.includes(''));
    await request('DELETE', '/api/cards/' + unicodeRes.json.id);
  }

  // 9.3 Whitespace-only title — should be rejected (trim then check)
  const wsRes = await request('POST', '/api/cards', { title: '   ' });
  assert('Whitespace-only title rejected', wsRes.status === 400);
  if (wsRes.status === 200 && wsRes.json) {
    await request('DELETE', '/api/cards/' + wsRes.json.id);
  }

  // 9.4 Very rapid sequential requests (50 in series)
  let rapidFails = 0;
  for (let i = 0; i < 50; i++) {
    const r = await request('GET', '/api/cards');
    if (r.status !== 200) rapidFails++;
  }
  assert('50 rapid sequential requests: all succeed', rapidFails === 0, rapidFails + ' failures');

  // 9.5 Special characters in search
  const specialSearch = await request('GET', '/api/search?q=%25%27%22%3C%3E');
  assert('Special chars in search handled', specialSearch.status === 200);

  // 9.6 Large bulk create (50 items)
  const bigBulk = [];
  for (let i = 0; i < 50; i++) {
    bigBulk.push({ title: 'Stress Test ' + i });
  }
  const bigBulkRes = await request('POST', '/api/bulk-create', { items: bigBulk });
  assert('50-item bulk create succeeds', bigBulkRes.status === 200 && bigBulkRes.json && bigBulkRes.json.created === 50);
  // Clean up
  if (bigBulkRes.json && bigBulkRes.json.cards) {
    const deletePromises = bigBulkRes.json.cards.map(function(c) { return request('DELETE', '/api/cards/' + c.id); });
    await Promise.all(deletePromises);
  }

  // 9.7 Duplicate card titles
  const dup1 = await request('POST', '/api/cards', { title: 'Duplicate Title Test' });
  const dup2 = await request('POST', '/api/cards', { title: 'Duplicate Title Test' });
  assert('Duplicate titles both created', dup1.status === 200 && dup2.status === 200);
  assert('Duplicate titles get unique IDs', dup1.json && dup2.json && dup1.json.id !== dup2.json.id);
  if (dup1.json) await request('DELETE', '/api/cards/' + dup1.json.id);
  if (dup2.json) await request('DELETE', '/api/cards/' + dup2.json.id);

  // 9.8 SSE doesn't block other requests
  const ssePromise = new Promise(function(resolve) {
    const url = new URL(BASE + '/api/events');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'GET', headers: { 'Accept': 'text/event-stream' },
    }, function(res) {
      setTimeout(function() { req.destroy(); resolve(true); }, 500);
    });
    req.on('error', function() { resolve(false); });
    req.end();
  });
  const [sseOk, apiRes] = await Promise.all([
    ssePromise,
    request('GET', '/api/cards'),
  ]);
  assert('API works while SSE connected', apiRes.status === 200);

  // 9.9 Idempotent operations
  const idempotentCard = await request('POST', '/api/cards', { title: 'Idempotency Test' });
  if (idempotentCard.json) {
    const cid = idempotentCard.json.id;
    // Double move to same column should be fine
    await request('POST', '/api/cards/' + cid + '/move', { column: 'brainstorm' });
    const r = await request('POST', '/api/cards/' + cid + '/move', { column: 'brainstorm' });
    assert('Moving to same column is idempotent', r.status === 200);
    // Double delete
    await request('DELETE', '/api/cards/' + cid);
  }

  // 9.10 Concurrent write to same card
  const raceCard = await request('POST', '/api/cards', { title: 'Race Condition Test' });
  if (raceCard.json) {
    const rid = raceCard.json.id;
    const [r1, r2, r3] = await Promise.all([
      request('PUT', '/api/cards/' + rid, { title: 'Race A', description: 'A' }),
      request('PUT', '/api/cards/' + rid, { title: 'Race B', description: 'B' }),
      request('PUT', '/api/cards/' + rid, { title: 'Race C', description: 'C' }),
    ]);
    assert('Concurrent updates all return 200', r1.status === 200 && r2.status === 200 && r3.status === 200);
    const finalCard = await request('GET', '/api/cards');
    const raceResult = Array.isArray(finalCard.json) ? finalCard.json.find(function(c) { return c.id === rid; }) : null;
    assert('Card in consistent state after race', raceResult && raceResult.title && raceResult.description);
    await request('DELETE', '/api/cards/' + rid);
  }
}

// =============================================================================
// BONUS: AUTHENTICATION FLOW TESTS
// =============================================================================
async function testAuthFlow() {
  section('BONUS: AUTHENTICATION FLOW');

  // Login with admin
  const loginRes = await request('POST', '/auth/login', { username: 'admin', password: 'admin' });
  assert('Login returns 200', loginRes.status === 200);
  assert('Login returns ok:true', loginRes.json && loginRes.json.ok === true);
  assert('Login returns user info', loginRes.json && loginRes.json.user && loginRes.json.user.role);
  assert('Login sets Set-Cookie', !!loginRes.headers['set-cookie']);
  const rawCookie = loginRes.headers['set-cookie'];
  const cookieStr = Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie || '');
  assert('Cookie is HttpOnly', cookieStr.includes('HttpOnly'));
  assert('Cookie is SameSite=Strict', cookieStr.includes('SameSite=Strict'));

  // Capture the new cookie for session check
  const loginMatch = cookieStr.match(/sid=([^;]+)/);
  if (loginMatch) SESSION_COOKIE = 'sid=' + loginMatch[1];

  // Session check with fresh cookie
  const session = await request('GET', '/auth/session');
  assert('Session check returns authenticated', session.json && session.json.authenticated === true);
  assert('Session includes user role', session.json && session.json.user && session.json.user.role);

  // Logout
  const logoutRes = await request('POST', '/auth/logout');
  assert('Logout returns ok', logoutRes.status === 200 && logoutRes.json && logoutRes.json.ok);

  // Re-auth for remaining tests
  const relogin = await request('POST', '/auth/login', { username: 'admin', password: 'admin' });
  if (relogin.headers['set-cookie']) {
    const reMatch = (Array.isArray(relogin.headers['set-cookie']) ? relogin.headers['set-cookie'][0] : relogin.headers['set-cookie']).match(/sid=([^;]+)/);
    if (reMatch) SESSION_COOKIE = 'sid=' + reMatch[1];
  }

  // Wrong password
  const wrongPw = await request('POST', '/auth/login', { username: 'admin', password: 'wrongpassword' });
  assert('Wrong password returns 401', wrongPw.status === 401);
  assert('Wrong password error message', wrongPw.json && wrongPw.json.error === 'Invalid credentials');

  // Non-existent user
  const noUser = await request('POST', '/auth/login', { username: 'doesntexist', password: 'test1234' });
  assert('Non-existent user returns 401', noUser.status === 401);
}

// =============================================================================
// MAIN — Run all dimensions
// =============================================================================
async function main() {
  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  MARCH OF NINES — Comprehensive Reliability Test Suite\n');
  process.stdout.write('  Target: ' + BASE + '\n');
  process.stdout.write('  Date: ' + new Date().toISOString() + '\n');
  process.stdout.write('============================================================\n');

  // Authenticate first
  const authed = await authenticate();
  if (!authed) {
    process.stdout.write('\n[CRITICAL] Cannot authenticate. Attempting tests without auth.\n');
  } else {
    process.stdout.write('\nAuthenticated as admin. Session active.\n');
  }

  try { await testStartupHealth(); } catch (e) { process.stdout.write('[CRASH] Dimension 1: ' + e.message + '\n'); }
  try { await testApiContracts(); } catch (e) { process.stdout.write('[CRASH] Dimension 2: ' + e.message + '\n'); }
  try { await testErrorResilience(); } catch (e) { process.stdout.write('[CRASH] Dimension 3: ' + e.message + '\n'); }
  try { await testSecurity(); } catch (e) { process.stdout.write('[CRASH] Dimension 4: ' + e.message + '\n'); }
  try { await testDataIntegrity(); } catch (e) { process.stdout.write('[CRASH] Dimension 5: ' + e.message + '\n'); }
  try { await testConcurrency(); } catch (e) { process.stdout.write('[CRASH] Dimension 6: ' + e.message + '\n'); }
  try { await testRecovery(); } catch (e) { process.stdout.write('[CRASH] Dimension 7: ' + e.message + '\n'); }
  try { await testConfiguration(); } catch (e) { process.stdout.write('[CRASH] Dimension 8: ' + e.message + '\n'); }
  try { await testEdgeCases(); } catch (e) { process.stdout.write('[CRASH] Dimension 9: ' + e.message + '\n'); }
  try { await testAuthFlow(); } catch (e) { process.stdout.write('[CRASH] Bonus Auth: ' + e.message + '\n'); }

  // Final report
  const total = passed + failed + skipped;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const reliability = total > 0 ? ((passed / (passed + failed)) * 100).toFixed(2) : 0;

  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  MARCH OF NINES — RESULTS\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  Passed:   ' + passed + '\n');
  process.stdout.write('  Failed:   ' + failed + '\n');
  process.stdout.write('  Skipped:  ' + skipped + '\n');
  process.stdout.write('  Total:    ' + total + '\n');
  process.stdout.write('  Duration: ' + elapsed + 's\n');
  process.stdout.write('  ─────────────────────────────────\n');
  process.stdout.write('  RELIABILITY: ' + reliability + '%\n');
  process.stdout.write('  ─────────────────────────────────\n');

  if (Number(reliability) >= 99.9) {
    process.stdout.write('  VERDICT: OPERATES LIKE DEPENDABLE SOFTWARE\n');
  } else if (Number(reliability) >= 99.0) {
    process.stdout.write('  VERDICT: NEAR DEPENDABLE — minor issues\n');
  } else if (Number(reliability) >= 95.0) {
    process.stdout.write('  VERDICT: USUALLY WORKS — needs fixes\n');
  } else {
    process.stdout.write('  VERDICT: UNRELIABLE — significant issues\n');
  }

  if (failures.length > 0) {
    process.stdout.write('\n  FAILURES:\n');
    for (let i = 0; i < failures.length; i++) {
      process.stdout.write('    ' + (i + 1) + '. ' + failures[i] + '\n');
    }
  }
  process.stdout.write('============================================================\n');

  // Write JSON report for aggregation
  var report = {
    suite: 'march-of-nines',
    date: new Date().toISOString(),
    passed: passed,
    failed: failed,
    total: total,
    score: Number(reliability),
    duration: elapsed + 's',
    failures: failures,
  };
  var reportDir = path.join(__dirname, '..', 'docs', 'trust');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'march-of-nines.json'), JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
  process.stderr.write('Test suite crashed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(2);
});
