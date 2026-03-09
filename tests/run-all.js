#!/usr/bin/env node
// =============================================================================
// TEST RUNNER — Runs all trust test suites and generates aggregate report
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'docs', 'trust');
const NODE = process.execPath;

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

var suites = [
  { name: 'March of Nines (Reliability)', file: 'march-of-nines.js', requiresServer: true },
  { name: 'Dependency Security Audit', file: 'dependency-audit.js', requiresServer: false },
  { name: 'Performance Benchmark', file: 'performance-benchmark.js', requiresServer: true },
  { name: 'Data Durability', file: 'data-durability.js', requiresServer: true },
  { name: 'Code Quality & Architecture', file: 'code-quality.js', requiresServer: true },
];

var results = [];
var overallPassed = 0;
var overallFailed = 0;
var overallTotal = 0;

process.stdout.write('\n');
process.stdout.write('================================================================\n');
process.stdout.write('  TRUST VERIFICATION — Full Test Suite Runner\n');
process.stdout.write('  Date: ' + new Date().toISOString() + '\n');
process.stdout.write('================================================================\n\n');

for (var i = 0; i < suites.length; i++) {
  var suite = suites[i];
  var suitePath = path.join(__dirname, suite.file);

  if (!fs.existsSync(suitePath)) {
    process.stdout.write('[SKIP] ' + suite.name + ' — file not found\n');
    continue;
  }

  process.stdout.write('[RUN]  ' + suite.name + ' ...\n');

  var output = '';
  var exitCode = 0;
  try {
    output = execFileSync(NODE, [suitePath], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
    exitCode = e.status || 1;
  }

  // Parse the JSON report if written
  var jsonFile = path.join(REPORT_DIR, suite.file.replace('.js', '.json'));
  // Map suite filenames to their actual report names
  var reportNames = {
    'march-of-nines.js': 'march-of-nines.json',
    'dependency-audit.js': 'dependency-audit.json',
    'performance-benchmark.js': 'performance-benchmark.json',
    'data-durability.js': 'data-durability.json',
    'code-quality.js': 'code-quality.json',
  };
  var reportFile = path.join(REPORT_DIR, reportNames[suite.file] || suite.file.replace('.js', '.json'));

  var report = null;
  if (fs.existsSync(reportFile)) {
    try { report = JSON.parse(fs.readFileSync(reportFile, 'utf-8')); } catch (_) {}
  }

  if (report) {
    overallPassed += report.passed;
    overallFailed += report.failed;
    overallTotal += report.total;
    results.push({
      name: suite.name,
      passed: report.passed,
      failed: report.failed,
      total: report.total,
      score: report.score,
      duration: report.duration,
      failures: report.failures || [],
    });
    var status = report.failed === 0 ? 'PASS' : 'FAIL';
    process.stdout.write('[' + status + '] ' + suite.name + ': ' + report.passed + '/' + report.total + ' (' + report.score + '%) in ' + report.duration + '\n');
  } else {
    results.push({
      name: suite.name,
      passed: 0, failed: 1, total: 1,
      score: 0,
      duration: '?',
      failures: ['Suite failed to produce report'],
    });
    overallFailed++;
    overallTotal++;
    process.stdout.write('[FAIL] ' + suite.name + ': No report generated\n');
  }
}

// Aggregate report
var overallScore = overallTotal > 0 ? ((overallPassed / overallTotal) * 100).toFixed(2) : 0;

process.stdout.write('\n');
process.stdout.write('================================================================\n');
process.stdout.write('  AGGREGATE TRUST SCORE\n');
process.stdout.write('================================================================\n');
process.stdout.write('  Total Tests: ' + overallTotal + '\n');
process.stdout.write('  Passed:      ' + overallPassed + '\n');
process.stdout.write('  Failed:      ' + overallFailed + '\n');
process.stdout.write('  ─────────────────────────────────\n');
process.stdout.write('  OVERALL SCORE: ' + overallScore + '%\n');
process.stdout.write('  ─────────────────────────────────\n');

if (Number(overallScore) >= 99) {
  process.stdout.write('  VERDICT: ENTERPRISE-GRADE RELIABILITY\n');
} else if (Number(overallScore) >= 95) {
  process.stdout.write('  VERDICT: PRODUCTION-READY\n');
} else if (Number(overallScore) >= 90) {
  process.stdout.write('  VERDICT: NEAR-PRODUCTION — minor issues\n');
} else {
  process.stdout.write('  VERDICT: NEEDS IMPROVEMENT\n');
}

process.stdout.write('================================================================\n');

// Write aggregate JSON
var aggregate = {
  generated: new Date().toISOString(),
  overallScore: Number(overallScore),
  totalTests: overallTotal,
  passed: overallPassed,
  failed: overallFailed,
  suites: results,
};
fs.writeFileSync(path.join(REPORT_DIR, 'aggregate.json'), JSON.stringify(aggregate, null, 2));

process.stdout.write('\nReports written to docs/trust/\n');
process.exit(overallFailed > 0 ? 1 : 0);
