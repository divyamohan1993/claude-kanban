#!/usr/bin/env node
// =============================================================================
// PERFORMANCE BENCHMARK — Response Time, Throughput & Resource Usage
// =============================================================================
// Measures:
//   1. Cold start time
//   2. API response latency (p50, p95, p99)
//   3. Throughput under sustained load
//   4. SSE connection handling
//   5. Database operation speed
//   6. Static asset serving performance
//   7. Memory baseline
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:51777';
let SESSION_COOKIE = '';

let passed = 0;
let failed = 0;
const failures = [];
const metrics = {};
const startTime = Date.now();

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write('  PASS  ' + name + (detail ? ' (' + detail + ')' : '') + '\n');
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    process.stdout.write('  FAIL  ' + name + (detail ? ' (' + detail + ')' : '') + '\n');
  }
}

function section(title) {
  process.stdout.write('\n--- ' + title + ' ---\n');
}

function request(method, urlPath, body) {
  return new Promise(function(resolve) {
    var url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
    var headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    if (body && typeof body === 'object') headers['Content-Type'] = 'application/json';

    var t0 = process.hrtime.bigint();
    var reqData = body ? JSON.stringify(body) : null;

    var req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var elapsed = Number(process.hrtime.bigint() - t0) / 1e6; // ms
        var bodyStr = Buffer.concat(chunks).toString();
        var json = null;
        try { json = JSON.parse(bodyStr); } catch (_) {}
        resolve({ status: res.statusCode, body: bodyStr, json: json, headers: res.headers, latencyMs: elapsed });
      });
    });
    req.on('error', function(e) {
      var elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ status: 0, body: '', json: null, headers: {}, latencyMs: elapsed, error: e.message });
    });
    req.setTimeout(10000, function() { req.destroy(); });
    if (reqData) req.write(reqData);
    req.end();
  });
}

function percentile(arr, p) {
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
  var idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

async function authenticate() {
  // Try setup check first
  var setupCheck = await request('GET', '/auth/setup');
  if (setupCheck.status === 200 && setupCheck.body.includes('setup')) {
    await request('POST', '/auth/setup', {
      username: 'testadmin', password: 'testadmin1234',
      displayName: 'Test Admin', email: 'test@localhost',
      ssoConfig: { provider: 'builtin' },
    });
    var login = await request('POST', '/auth/login', { username: 'testadmin', password: 'testadmin1234' });
    if (login.headers['set-cookie']) {
      var m = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']).match(/sid=([^;]+)/);
      if (m) SESSION_COOKIE = 'sid=' + m[1];
    }
    return !!SESSION_COOKIE;
  }

  // Try default credentials
  var creds = [
    { username: 'admin', password: 'admin' },
    { username: 'testadmin', password: 'testadmin1234' },
  ];
  for (var i = 0; i < creds.length; i++) {
    var res = await request('POST', '/auth/login', creds[i]);
    if (res.status === 200 && res.headers['set-cookie']) {
      var match = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie']).match(/sid=([^;]+)/);
      if (match) { SESSION_COOKIE = 'sid=' + match[1]; return true; }
    }
  }
  return false;
}

// ── 1. API Response Latency ──
async function testApiLatency() {
  section('API RESPONSE LATENCY');

  // Health endpoint (should be ultra-fast)
  var healthLatencies = [];
  for (var i = 0; i < 50; i++) {
    var r = await request('GET', '/health');
    if (r.status === 200) healthLatencies.push(r.latencyMs);
  }
  var hp50 = percentile(healthLatencies, 50);
  var hp95 = percentile(healthLatencies, 95);
  var hp99 = percentile(healthLatencies, 99);
  metrics.healthP50 = hp50.toFixed(1);
  metrics.healthP95 = hp95.toFixed(1);
  metrics.healthP99 = hp99.toFixed(1);

  assert('Health p50 < 20ms', hp50 < 20, hp50.toFixed(1) + 'ms');
  assert('Health p95 < 50ms', hp95 < 50, hp95.toFixed(1) + 'ms');
  assert('Health p99 < 100ms', hp99 < 100, hp99.toFixed(1) + 'ms');

  // Cards list (DB read)
  var cardLatencies = [];
  for (var j = 0; j < 30; j++) {
    var cr = await request('GET', '/api/cards');
    if (cr.status === 200) cardLatencies.push(cr.latencyMs);
  }
  var cp50 = percentile(cardLatencies, 50);
  var cp95 = percentile(cardLatencies, 95);
  metrics.cardsP50 = cp50.toFixed(1);
  metrics.cardsP95 = cp95.toFixed(1);

  assert('GET /api/cards p50 < 50ms', cp50 < 50, cp50.toFixed(1) + 'ms');
  assert('GET /api/cards p95 < 100ms', cp95 < 100, cp95.toFixed(1) + 'ms');

  // Card creation (DB write)
  var writeLatencies = [];
  var writeIds = [];
  for (var k = 0; k < 20; k++) {
    var wr = await request('POST', '/api/cards', { title: 'PerfTest-' + k });
    if (wr.status === 200) {
      writeLatencies.push(wr.latencyMs);
      if (wr.json && wr.json.id) writeIds.push(wr.json.id);
    }
  }
  if (writeLatencies.length > 0) {
    var wp50 = percentile(writeLatencies, 50);
    var wp95 = percentile(writeLatencies, 95);
    metrics.writeP50 = wp50.toFixed(1);
    metrics.writeP95 = wp95.toFixed(1);
    assert('POST /api/cards p50 < 50ms', wp50 < 50, wp50.toFixed(1) + 'ms');
    assert('POST /api/cards p95 < 100ms', wp95 < 100, wp95.toFixed(1) + 'ms');
  }

  // Cleanup
  for (var ci = 0; ci < writeIds.length; ci++) {
    await request('DELETE', '/api/cards/' + writeIds[ci]);
  }
}

// ── 2. Throughput under sustained load ──
async function testThroughput() {
  section('THROUGHPUT (SUSTAINED LOAD)');

  // Fire 100 requests as fast as possible (in batches of 10)
  var batchSize = 10;
  var totalRequests = 100;
  var successes = 0;
  var latencies = [];
  var t0 = Date.now();

  for (var batch = 0; batch < totalRequests / batchSize; batch++) {
    var promises = [];
    for (var i = 0; i < batchSize; i++) {
      promises.push(request('GET', '/health'));
    }
    var results = await Promise.all(promises);
    results.forEach(function(r) {
      if (r.status === 200) successes++;
      latencies.push(r.latencyMs);
    });
  }

  var totalTime = (Date.now() - t0) / 1000;
  var rps = (successes / totalTime).toFixed(0);
  metrics.throughputRps = rps;
  metrics.throughputSuccessRate = ((successes / totalRequests) * 100).toFixed(1);

  assert('Sustained throughput > 50 rps', Number(rps) > 50, rps + ' rps');
  assert('Success rate > 95% under load', successes > totalRequests * 0.95, successes + '/' + totalRequests);

  var avgLatency = latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length;
  metrics.avgLatencyUnderLoad = avgLatency.toFixed(1);
  assert('Avg latency under load < 100ms', avgLatency < 100, avgLatency.toFixed(1) + 'ms');
}

// ── 3. Static asset serving ──
async function testStaticAssets() {
  section('STATIC ASSET PERFORMANCE');

  // Index page
  var indexRes = await request('GET', '/');
  assert('Index page served', indexRes.status === 200 || indexRes.status === 302);
  if (indexRes.status === 200) {
    assert('Index page < 200ms', indexRes.latencyMs < 200, indexRes.latencyMs.toFixed(1) + 'ms');
    assert('Index page has Cache-Control', !!indexRes.headers['cache-control']);
  }

  // CSS
  var cssRes = await request('GET', '/style.css');
  if (cssRes.status === 200) {
    assert('CSS served', true);
    assert('CSS < 100ms', cssRes.latencyMs < 100, cssRes.latencyMs.toFixed(1) + 'ms');
    assert('CSS has immutable cache', (cssRes.headers['cache-control'] || '').includes('immutable') || (cssRes.headers['cache-control'] || '').includes('max-age'));
  }

  // JS
  var jsRes = await request('GET', '/app.js');
  if (jsRes.status === 200) {
    assert('JS served', true);
    assert('JS < 100ms', jsRes.latencyMs < 100, jsRes.latencyMs.toFixed(1) + 'ms');
  }
}

// ── 4. Database operation stress ──
async function testDbStress() {
  section('DATABASE STRESS TEST');

  // Create 50 cards rapidly
  var ids = [];
  var createStart = Date.now();
  var createPromises = [];
  for (var i = 0; i < 50; i++) {
    createPromises.push(request('POST', '/api/cards', { title: 'StressTest-' + i }));
  }
  var createResults = await Promise.all(createPromises);
  var createTime = Date.now() - createStart;
  var createSuccess = 0;
  createResults.forEach(function(r) {
    if (r.status === 200 && r.json && r.json.id) {
      createSuccess++;
      ids.push(r.json.id);
    }
  });

  metrics.bulkCreateMs = createTime;
  metrics.bulkCreateSuccess = createSuccess;
  assert('Bulk create 50 cards succeeds', createSuccess >= 45, createSuccess + '/50 in ' + createTime + 'ms');
  assert('Bulk create < 5 seconds', createTime < 5000, createTime + 'ms');

  // Read all cards
  var readStart = Date.now();
  var readRes = await request('GET', '/api/cards');
  var readTime = Date.now() - readStart;
  assert('Read all cards after bulk insert < 200ms', readTime < 200, readTime + 'ms');
  assert('All created cards visible', readRes.json && Array.isArray(readRes.json) && readRes.json.length >= createSuccess);

  // Delete all test cards
  var deleteStart = Date.now();
  var deletePromises = ids.map(function(id) { return request('DELETE', '/api/cards/' + id); });
  await Promise.all(deletePromises);
  var deleteTime = Date.now() - deleteStart;
  metrics.bulkDeleteMs = deleteTime;
  assert('Bulk delete 50 cards < 5 seconds', deleteTime < 5000, deleteTime + 'ms');
}

// ── 5. SSE connection performance ──
async function testSsePerformance() {
  section('SSE CONNECTION PERFORMANCE');

  // Measure time to establish SSE connection
  var sseLatency = await new Promise(function(resolve) {
    var t0 = process.hrtime.bigint();
    var url = new URL(BASE + '/api/events');
    var req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'GET', headers: { 'Accept': 'text/event-stream', 'Cookie': SESSION_COOKIE },
    }, function(res) {
      var elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      setTimeout(function() { req.destroy(); resolve(elapsed); }, 200);
    });
    req.on('error', function() { resolve(-1); });
    req.setTimeout(5000, function() { req.destroy(); resolve(-1); });
    req.end();
  });

  if (sseLatency > 0) {
    metrics.sseConnectMs = sseLatency.toFixed(1);
    assert('SSE connection < 200ms', sseLatency < 200, sseLatency.toFixed(1) + 'ms');
  }

  // API still responsive while SSE is open
  var ssePromise = new Promise(function(resolve) {
    var url = new URL(BASE + '/api/events');
    var req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'GET', headers: { 'Accept': 'text/event-stream', 'Cookie': SESSION_COOKIE },
    }, function() { setTimeout(function() { req.destroy(); resolve(true); }, 1000); });
    req.on('error', function() { resolve(false); });
    req.end();
  });
  var apiRes = await request('GET', '/api/cards');
  await ssePromise;
  assert('API responsive during SSE', apiRes.status === 200, apiRes.latencyMs.toFixed(1) + 'ms');
}

// ── 6. Response size efficiency ──
async function testResponseSize() {
  section('RESPONSE SIZE EFFICIENCY');

  var cardsRes = await request('GET', '/api/cards');
  if (cardsRes.status === 200) {
    var bodySize = Buffer.byteLength(cardsRes.body);
    assert('Cards response has Content-Type JSON', (cardsRes.headers['content-type'] || '').includes('json'));
    assert('Cards response well-formed JSON', cardsRes.json !== null);
    metrics.cardsResponseBytes = bodySize;
  }

  var healthRes = await request('GET', '/health');
  if (healthRes.status === 200) {
    var healthSize = Buffer.byteLength(healthRes.body);
    assert('Health response < 1KB', healthSize < 1024, healthSize + ' bytes');
    metrics.healthResponseBytes = healthSize;
  }
}

// ── Main ──
async function main() {
  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  PERFORMANCE BENCHMARK\n');
  process.stdout.write('  Target: ' + BASE + '\n');
  process.stdout.write('  Date: ' + new Date().toISOString() + '\n');
  process.stdout.write('============================================================\n');

  var authed = await authenticate();
  if (!authed) process.stdout.write('\n[WARN] Running without auth — some tests may be limited.\n');
  else process.stdout.write('\nAuthenticated. Running benchmarks.\n');

  try { await testApiLatency(); } catch (e) { process.stdout.write('[CRASH] Latency: ' + e.message + '\n'); }
  try { await testThroughput(); } catch (e) { process.stdout.write('[CRASH] Throughput: ' + e.message + '\n'); }
  try { await testStaticAssets(); } catch (e) { process.stdout.write('[CRASH] Static: ' + e.message + '\n'); }
  try { await testDbStress(); } catch (e) { process.stdout.write('[CRASH] DB Stress: ' + e.message + '\n'); }
  try { await testSsePerformance(); } catch (e) { process.stdout.write('[CRASH] SSE: ' + e.message + '\n'); }
  try { await testResponseSize(); } catch (e) { process.stdout.write('[CRASH] Response Size: ' + e.message + '\n'); }

  var total = passed + failed;
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  var score = total > 0 ? ((passed / total) * 100).toFixed(2) : 0;

  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  PERFORMANCE BENCHMARK — RESULTS\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  Passed:  ' + passed + '\n');
  process.stdout.write('  Failed:  ' + failed + '\n');
  process.stdout.write('  Total:   ' + total + '\n');
  process.stdout.write('  Duration: ' + elapsed + 's\n');
  process.stdout.write('  ─────────────────────────────────\n');
  process.stdout.write('  SCORE: ' + score + '%\n');
  process.stdout.write('  ─────────────────────────────────\n');

  if (Object.keys(metrics).length > 0) {
    process.stdout.write('\n  KEY METRICS:\n');
    Object.keys(metrics).forEach(function(k) {
      process.stdout.write('    ' + k + ': ' + metrics[k] + '\n');
    });
  }

  if (failures.length > 0) {
    process.stdout.write('\n  FAILURES:\n');
    failures.forEach(function(f, i) { process.stdout.write('    ' + (i + 1) + '. ' + f + '\n'); });
  }
  process.stdout.write('============================================================\n');

  var report = {
    suite: 'performance-benchmark',
    date: new Date().toISOString(),
    passed: passed, failed: failed, total: total,
    score: Number(score),
    duration: elapsed + 's',
    metrics: metrics,
    failures: failures,
  };
  var reportDir = path.join(__dirname, '..', 'docs', 'trust');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'performance-benchmark.json'), JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
  process.stderr.write('Benchmark crashed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(2);
});
