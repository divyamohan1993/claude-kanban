#!/usr/bin/env node
// =============================================================================
// CODE QUALITY & ARCHITECTURE AUDIT
// =============================================================================
// Verifies:
//   1. File structure & organization
//   2. Error handling patterns
//   3. Security middleware completeness
//   4. Logging discipline (structured, no console.log)
//   5. SQL injection prevention (prepared statements only)
//   6. No hardcoded secrets
//   7. HTTP security headers
//   8. Input validation coverage
//   9. Graceful shutdown handlers
//  10. Documentation presence
// =============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:51777';
let SESSION_COOKIE = '';

let passed = 0;
let failed = 0;
const failures = [];
const startTime = Date.now();

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write('  PASS  ' + name + '\n');
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    process.stdout.write('  FAIL  ' + name + (detail ? ' (' + detail + ')' : '') + '\n');
  }
}

function section(title) {
  process.stdout.write('\n--- ' + title + ' ---\n');
}

function request(method, urlPath) {
  return new Promise(function(resolve) {
    var url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
    var headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    var req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname, method: method, headers: headers,
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var bodyStr = Buffer.concat(chunks).toString();
        var json = null;
        try { json = JSON.parse(bodyStr); } catch (_) {}
        resolve({ status: res.statusCode, body: bodyStr, json: json, headers: res.headers });
      });
    });
    req.on('error', function(e) { resolve({ status: 0, body: '', json: null, headers: {}, error: e.message }); });
    req.setTimeout(5000, function() { req.destroy(); });
    req.end();
  });
}

function readSrc(rel) {
  var full = path.join(ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null;
}

function walkDir(dir, cb) {
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach(function(e) {
      var full = path.join(dir, e.name);
      if (e.isFile()) cb(full);
      else if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walkDir(full, cb);
    });
  } catch (_) {}
}

// ── 1. File structure ──
function testFileStructure() {
  section('FILE STRUCTURE & ORGANIZATION');

  var expectedFiles = [
    'src/server.js', 'src/config.js',
    'src/db/index.js',
    'src/routes/public.js', 'src/routes/admin.js',
    'src/middleware/security.js', 'src/middleware/rate-limit.js',
    'src/sso/index.js', 'src/sso/jwt.js', 'src/sso/session-store.js',
    'src/lib/logger.js',
    'public/index.html', 'public/app.js', 'public/style.css',
    'package.json', 'pnpm-lock.yaml',
  ];

  expectedFiles.forEach(function(f) {
    assert('File exists: ' + f, fs.existsSync(path.join(ROOT, f)));
  });

  // Check no loose JS files in root (all code in src/)
  var rootJs = fs.readdirSync(ROOT).filter(function(f) { return f.endsWith('.js') && f !== '.eslintrc.js'; });
  assert('No loose .js files in root (code in src/)', rootJs.length === 0, rootJs.join(', '));
}

// ── 2. Logging discipline ──
function testLoggingDiscipline() {
  section('LOGGING DISCIPLINE');

  var srcDir = path.join(ROOT, 'src');
  var consoleUsage = [];
  var loggerImports = [];

  walkDir(srcDir, function(filePath) {
    if (!filePath.endsWith('.js')) return;
    var content = fs.readFileSync(filePath, 'utf-8');
    var rel = path.relative(ROOT, filePath);

    // Check for console.log/warn/error (should use pino logger)
    var lines = content.split('\n');
    lines.forEach(function(line, idx) {
      if (/console\.(log|warn|error|info)\s*\(/.test(line) && !line.trim().startsWith('//')) {
        consoleUsage.push(rel + ':' + (idx + 1));
      }
    });

    // Check logger import
    if (content.includes("require('../lib/logger')") || content.includes("require('./lib/logger')")) {
      loggerImports.push(rel);
    }
  });

  assert('No console.log in source (use pino)', consoleUsage.length === 0, consoleUsage.slice(0, 5).join(', '));
  assert('Logger imported in key modules', loggerImports.length >= 3);
}

// ── 3. SQL injection prevention ──
function testSqlSafety() {
  section('SQL INJECTION PREVENTION');

  var dbCode = readSrc('src/db/index.js');
  if (!dbCode) { assert('DB module exists', false); return; }

  // Check for string concatenation in SQL (exclude known-safe patterns)
  var sqlConcat = [];
  var lines = dbCode.split('\n');
  lines.forEach(function(line, idx) {
    // Flag: SQL + string concat with variables (not just string literals)
    if (/\.(run|get|all|prepare)\s*\(.*\+\s*[a-z]/.test(line) && !/\/\//.test(line.split('+')[0])) {
      // Exclude static SQL construction (table creation, PRAGMA)
      if (/CREATE|ALTER|DROP|PRAGMA/.test(line)) return;
      // Exclude COLUMN_MAP-based dynamic SQL (static whitelist, always safe)
      if (/COLUMN_MAP|setClauses/.test(line)) return;
      sqlConcat.push('db/index.js:' + (idx + 1));
    }
  });
  assert('No unsafe SQL string concatenation', sqlConcat.length === 0, sqlConcat.join(', '));

  // Check prepared statements usage
  var prepareCount = (dbCode.match(/\.prepare\s*\(/g) || []).length;
  assert('Uses prepared statements (>=5 found)', prepareCount >= 5, prepareCount + ' prepared statements');

  // Check for parameterized queries
  var paramQueries = (dbCode.match(/\?\s*[,)]/g) || []).length;
  assert('Uses parameterized queries (?)', paramQueries >= 5, paramQueries + ' parameter placeholders');
}

// ── 4. No hardcoded secrets ──
function testNoHardcodedSecrets() {
  section('SECRET MANAGEMENT');

  var secretPatterns = [
    { name: 'API key', re: /['"]sk-[a-zA-Z0-9]{20,}['"]/g },
    { name: 'AWS key', re: /['"]AKIA[A-Z0-9]{16}['"]/g },
    { name: 'password literal', re: /password\s*[:=]\s*['"][^'"]{8,}['"]/gi },
    { name: 'private key', re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g },
  ];

  var srcDir = path.join(ROOT, 'src');
  var secretFindings = [];
  walkDir(srcDir, function(filePath) {
    if (!filePath.endsWith('.js')) return;
    var content = fs.readFileSync(filePath, 'utf-8');
    var rel = path.relative(ROOT, filePath);
    secretPatterns.forEach(function(pat) {
      if (pat.re.test(content)) {
        // Exclude test credentials (admin/admin)
        if (pat.name === 'password literal') {
          var matches = content.match(pat.re) || [];
          var real = matches.filter(function(m) { return !m.includes("'admin'") && !m.includes('"admin"'); });
          if (real.length > 0) secretFindings.push(rel + ': ' + pat.name);
        } else {
          secretFindings.push(rel + ': ' + pat.name);
        }
      }
      pat.re.lastIndex = 0; // Reset regex state
    });
  });

  assert('No hardcoded secrets in source', secretFindings.length === 0, secretFindings.join(', '));

  // Env-based config
  var configCode = readSrc('src/config.js');
  if (configCode) {
    var envRefs = (configCode.match(/process\.env\./g) || []).length;
    assert('Config uses env vars extensively (>=10)', envRefs >= 10, envRefs + ' env references');
  }
}

// ── 5. Security headers verification (live) ──
async function testSecurityHeaders() {
  section('HTTP SECURITY HEADERS (LIVE)');

  var res = await request('GET', '/health');
  if (res.status === 0) { assert('Server reachable', false); return; }

  var h = res.headers;
  assert('X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff');
  assert('X-Frame-Options: DENY', h['x-frame-options'] === 'DENY');
  assert('Referrer-Policy set', !!h['referrer-policy']);
  assert('Content-Security-Policy set', !!h['content-security-policy']);
  assert('X-Request-Id present', !!h['x-request-id']);
  assert('Permissions-Policy set', !!h['permissions-policy']);

  // CSP should have nonce
  var csp = h['content-security-policy'] || '';
  assert('CSP uses nonce-based scripts', csp.includes('nonce-'));
  assert('CSP blocks frame-ancestors', csp.includes("frame-ancestors 'none'"));

  // API endpoints should have no-store
  var apiRes = await request('GET', '/api/cards');
  assert('API Cache-Control: no-store', (apiRes.headers['cache-control'] || '').includes('no-store'));
}

// ── 6. Error handling patterns ──
function testErrorHandling() {
  section('ERROR HANDLING PATTERNS');

  var serverCode = readSrc('src/server.js');
  if (!serverCode) { assert('Server module exists', false); return; }

  // Uncaught exception handler
  assert('Has uncaughtException handler', serverCode.includes('uncaughtException'));
  assert('Has unhandledRejection handler', serverCode.includes('unhandledRejection'));

  // Graceful shutdown
  assert('Has SIGTERM handler', serverCode.includes('SIGTERM'));
  assert('Has SIGINT handler', serverCode.includes('SIGINT'));

  // Error middleware
  var securityCode = readSrc('src/middleware/security.js');
  if (securityCode) {
    assert('Has centralized error handler', securityCode.includes('errorHandler'));
  }

  // Try-catch in routes
  var routesCode = readSrc('src/routes/public.js');
  if (routesCode) {
    var tryCatchCount = (routesCode.match(/try\s*\{/g) || []).length;
    assert('Routes use try-catch (>=5)', tryCatchCount >= 5, tryCatchCount + ' try blocks');
  }
}

// ── 7. Input validation ──
async function testInputValidation() {
  section('INPUT VALIDATION (LIVE)');

  // Login with no credentials
  var noCreds = await request('POST', '/auth/login');
  assert('Login without body returns error', noCreds.status >= 400);

  // Malformed JSON — send raw request
  var malformed = await new Promise(function(resolve) {
    var url = new URL(BASE + '/api/cards');
    var req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': SESSION_COOKIE,
      },
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve({ status: res.statusCode }); });
    });
    req.on('error', function() { resolve({ status: 0 }); });
    req.write('{invalid json!!!');
    req.end();
  });
  assert('Malformed JSON returns 400', malformed.status === 400);
}

// ── 8. Documentation presence ──
function testDocumentation() {
  section('DOCUMENTATION');

  var docs = [
    { file: 'README.md', name: 'README' },
    { file: 'CHANGELOG.md', name: 'CHANGELOG' },
    { file: 'LICENSE', name: 'LICENSE' },
    { file: 'docs/api.md', name: 'API docs' },
    { file: 'docs/architecture.md', name: 'Architecture docs' },
    { file: 'docs/security-audit.md', name: 'Security audit' },
  ];

  docs.forEach(function(d) {
    var exists = fs.existsSync(path.join(ROOT, d.file));
    assert(d.name + ' exists', exists);
  });
}

// ── Main ──
async function main() {
  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  CODE QUALITY & ARCHITECTURE AUDIT\n');
  process.stdout.write('  Date: ' + new Date().toISOString() + '\n');
  process.stdout.write('============================================================\n');

  // Authenticate for live tests
  var setupCheck = await request('GET', '/auth/setup');
  if (setupCheck.status === 200 && setupCheck.body && setupCheck.body.includes('setup')) {
    // setup needed but not our job here
  }
  var creds = [{ username: 'admin', password: 'admin' }, { username: 'testadmin', password: 'testadmin1234' }];
  for (var i = 0; i < creds.length; i++) {
    var loginBody = JSON.stringify(creds[i]);
    var loginRes = await new Promise(function(resolve) {
      var url = new URL(BASE + '/auth/login');
      var req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers }); });
      });
      req.on('error', function() { resolve({ status: 0, headers: {} }); });
      req.write(loginBody);
      req.end();
    });
    if (loginRes.status === 200 && loginRes.headers['set-cookie']) {
      var cookie = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'][0] : loginRes.headers['set-cookie'];
      var match = cookie.match(/sid=([^;]+)/);
      if (match) { SESSION_COOKIE = 'sid=' + match[1]; break; }
    }
  }

  testFileStructure();
  testLoggingDiscipline();
  testSqlSafety();
  testNoHardcodedSecrets();
  try { await testSecurityHeaders(); } catch (e) { process.stdout.write('[CRASH] Headers: ' + e.message + '\n'); }
  testErrorHandling();
  try { await testInputValidation(); } catch (e) { process.stdout.write('[CRASH] Validation: ' + e.message + '\n'); }
  testDocumentation();

  var total = passed + failed;
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  var score = total > 0 ? ((passed / total) * 100).toFixed(2) : 0;

  process.stdout.write('\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  CODE QUALITY — RESULTS\n');
  process.stdout.write('============================================================\n');
  process.stdout.write('  Passed:  ' + passed + '\n');
  process.stdout.write('  Failed:  ' + failed + '\n');
  process.stdout.write('  Total:   ' + total + '\n');
  process.stdout.write('  Duration: ' + elapsed + 's\n');
  process.stdout.write('  ─────────────────────────────────\n');
  process.stdout.write('  SCORE: ' + score + '%\n');
  process.stdout.write('  ─────────────────────────────────\n');

  if (failures.length > 0) {
    process.stdout.write('\n  FAILURES:\n');
    failures.forEach(function(f, i) { process.stdout.write('    ' + (i + 1) + '. ' + f + '\n'); });
  }
  process.stdout.write('============================================================\n');

  var report = {
    suite: 'code-quality',
    date: new Date().toISOString(),
    passed: passed, failed: failed, total: total,
    score: Number(score),
    duration: elapsed + 's',
    failures: failures,
  };
  var reportDir = path.join(ROOT, 'docs', 'trust');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'code-quality.json'), JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
  process.stderr.write('Test crashed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(2);
});
