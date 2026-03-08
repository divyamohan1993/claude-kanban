// =============================================================================
// Spec Intelligence Service — Enterprise-Grade Specification Quality Engine
// =============================================================================
//
// Four integrated subsystems:
//
//   1. Multi-Lens Brainstorm   — Forces multi-perspective analysis before spec writing
//   2. Historical Review Inject — Feeds past review findings + spec patterns into prompts
//   3. Creative Constraints     — Randomized thinking prompts that surface hidden design concerns
//   4. Spec Feedback Loop       — Scores spec effectiveness, learns structural patterns over time
//
// All subsystems are feature-flagged via runtime config. Graceful degradation on failure.
// Zero additional Claude calls — all intelligence is injected into existing brainstorm prompts.
//

const { cards, learnings, auditLog } = require('../db');
const { runtime } = require('../config');
const { log } = require('../lib/logger');

// =============================================================================
// 1. Multi-Lens Brainstorm
// =============================================================================
// Builds a mandatory multi-perspective analysis section for the brainstorm prompt.
// Card-type-aware: different lenses emphasize different concerns based on labels.

const LENS_PROFILES = {
  bug: {
    user: 'Think as the person who hit this bug. What was I trying to do when it broke? Is there a workaround I already found? What data did I lose? How urgent does this feel from my side?',
    adversary: 'Think as a security researcher. Could this bug be exploited? Is it a symptom of a deeper vulnerability? What other code paths share the same flawed assumption?',
    maintainer: 'Think as a developer debugging this 6 months from now. What caused this bug: a logic error, a race condition, a missing edge case, or a wrong assumption? Is this a one-off, or a pattern that will produce similar bugs?',
  },
  feature: {
    user: 'Think as the person who will use this feature daily. Would I discover it naturally, or would I need a tutorial? What would frustrate me about a naive implementation? What would genuinely delight me?',
    adversary: 'Think as someone trying to misuse this feature. What unexpected inputs would I try? What happens if I use it in a way the developer never imagined? What is the blast radius if this feature has a bug?',
    maintainer: 'Think as a developer maintaining this code in 6 months. Does this feature add complexity proportional to its value? Will I understand the design decisions without reading a commit history? Does this create technical debt or reduce it?',
  },
  security: {
    user: 'Think as an end user affected by this security change. Does this create friction that will make me find a workaround? Will I even notice this protection exists? Does it break my existing workflow?',
    adversary: 'Think as an attacker who knows about this fix. Would I find another way in? Does fixing this narrow one vector while opening another? What is the minimal bypass for this mitigation?',
    maintainer: 'Think as a future security auditor. Is this the right layer for this control? Is it testable? Does it follow defense-in-depth, or is it a single point of security? Will it still be relevant when dependencies update?',
  },
  refactor: {
    user: 'Think as an end user after this refactor ships. Will any user-facing behavior change, even subtly? Will performance improve, degrade, or stay the same? Could this refactor break any integration or API contract?',
    adversary: 'Think as someone reviewing this refactor for introduced vulnerabilities. Does the refactored code have a wider attack surface? Are there new injection points, changed trust boundaries, or relaxed validations?',
    maintainer: 'Think as a developer who joins the team after this refactor. Is the new structure more obvious than the old one? Does this refactor justify its review and testing cost? Does it set a precedent that helps or hurts future changes?',
  },
  performance: {
    user: 'Think as a real user on a real device. Will this optimization be perceptible, or only visible in benchmarks? Does it improve the interaction that matters most (first load, critical action, peak load)?',
    adversary: 'Think as someone exploiting this optimization. Does it create a timing side-channel? Can the optimized path be weaponized for resource exhaustion? Does caching introduce stale data vulnerabilities?',
    maintainer: 'Think as a developer profiling this code next quarter. Does this optimization make the code harder to read or modify? Is the performance gain documented with measurements? Will it survive the next refactor?',
  },
  default: {
    user: 'Think as the person who will use this daily. What would frustrate me about a naive implementation? What would delight me? What edge case would I hit first?',
    adversary: 'Think as someone trying to break this. What is the attack surface? What input causes unexpected behavior? What happens under extreme load or when dependencies fail?',
    maintainer: 'Think as a developer reading this code 6 months from now. Is the approach obvious, or does it need an explanation? What would I want to change first? Does this create technical debt or reduce it?',
  },
};

function detectCardType(card) {
  const labels = (card.labels || '').toLowerCase();
  const title = (card.title || '').toLowerCase();

  // Labels are the strongest signal — check them first (user-assigned or auto-labeled)
  if (labels.includes('bug')) return 'bug';
  if (labels.includes('security')) return 'security';
  if (labels.includes('refactor')) return 'refactor';
  if (labels.includes('perf') || labels.includes('performance')) return 'performance';
  if (labels.includes('feature')) return 'feature';

  // Title-based detection: check specific/rare keywords before common ones.
  // Security keywords first (xss, csrf, vuln, inject are unambiguous)
  if (/\b(xss|csrf|vuln|inject|owasp|cve|exploit|sanitiz)\b/.test(title)) return 'security';
  // Refactor keywords (explicit intent)
  if (/\b(refactor|cleanup|reorganize|simplify|restructur)\b/.test(title)) return 'refactor';
  // Performance keywords
  if (/\b(perf|optimi|speed|slow|latency|cache|bundle\s*size)\b/.test(title)) return 'performance';
  // Bug keywords (common but should not override more specific matches above)
  if (/\b(bug|broken|crash|error|fail|regression|404|500)\b/.test(title)) return 'bug';
  // Security (broader — auth, encrypt — checked after refactor/bug to avoid false positives)
  if (/\b(security|auth|encrypt|password|token|session|permission)\b/.test(title)) return 'security';
  // Feature (broadest match, last resort before default)
  if (/\b(feat|add|new|implement|create|build|introduce)\b/.test(title)) return 'feature';
  // Fix is ambiguous — could be bug fix or security fix. Check context.
  if (/\bfix\b/.test(title)) return 'bug';

  return 'default';
}

function buildMultiLensSection(card) {
  if (!runtime.multiLensBrainstorm) return '';

  const cardType = detectCardType(card);
  const profile = LENS_PROFILES[cardType] || LENS_PROFILES.default;

  const parts = [];
  parts.push('## Multi-Perspective Analysis (MANDATORY)');
  parts.push('');
  parts.push('Before writing the specification, analyze this task from three distinct perspectives.');
  parts.push('Write a brief analysis (3-5 sentences each) for each lens. This is not optional.');
  parts.push('');
  parts.push('### Lens 1: End User');
  parts.push(profile.user);
  parts.push('');
  parts.push('### Lens 2: Adversary (Security & Resilience)');
  parts.push(profile.adversary);
  parts.push('');
  parts.push('### Lens 3: Future Maintainer');
  parts.push(profile.maintainer);
  parts.push('');
  parts.push('After completing all three analyses, synthesize their insights into the specification.');
  parts.push('Every concern raised by any lens MUST be addressed in the spec.');
  parts.push('If a concern is deliberately excluded, state why in one sentence.');
  parts.push('');

  return parts.join('\n');
}

// =============================================================================
// 2. Historical Review Injection
// =============================================================================
// Queries DB for past review data, spec effectiveness patterns, and learnings.
// Formats as a concise context section for the brainstorm prompt.

function gatherHistoricalContext(card) {
  if (!runtime.specFeedbackLoop) return '';

  try {
    const allCards = cards.getAll().concat(cards.getArchived());
    const projectPath = card.project_path || '';

    // --- Aggregate review findings ---
    const findingCounts = {};   // category -> count
    const findingMessages = {}; // category -> [messages]
    const scores = [];
    const specScores = [];
    let fixRoundsTotal = 0;
    let fixRoundsCount = 0;
    let projectScores = [];

    for (let i = 0; i < allCards.length; i++) {
      const c = allCards[i];

      // Collect review scores
      if (c.review_score > 0) {
        scores.push(c.review_score);
        if (projectPath && c.project_path === projectPath) {
          projectScores.push(c.review_score);
        }
      }

      // Collect spec effectiveness scores
      if (c.spec_score > 0) {
        specScores.push(c.spec_score);
      }

      // Parse review findings
      if (c.review_data) {
        try {
          const rd = JSON.parse(c.review_data);
          const findings = rd.findings || [];
          for (let fi = 0; fi < findings.length; fi++) {
            const f = findings[fi];
            const cat = f.category || 'other';
            findingCounts[cat] = (findingCounts[cat] || 0) + 1;
            if (!findingMessages[cat]) findingMessages[cat] = [];
            if (findingMessages[cat].length < 5 && f.message) {
              // Deduplicate by checking rough similarity
              const isDuplicate = findingMessages[cat].some(function(m) {
                return m.toLowerCase().slice(0, 40) === f.message.toLowerCase().slice(0, 40);
              });
              if (!isDuplicate) findingMessages[cat].push(f.message);
            }
          }
        } catch (_) {}
      }

      // Collect fix round data from phase durations
      if (c.phase_durations) {
        try {
          const pd = JSON.parse(c.phase_durations);
          if (pd.review && pd.review.duration) {
            // Rough heuristic: multiple review phases = fix rounds happened
            fixRoundsCount++;
          }
        } catch (_) {}
      }
    }

    // --- Gather spec pattern learnings ---
    const specPatterns = learnings.getByCategory('spec-pattern');
    const highPatterns = [];
    const lowPatterns = [];

    for (let pi = 0; pi < specPatterns.length; pi++) {
      const p = specPatterns[pi];
      try {
        const data = JSON.parse(p.pattern_value);
        if (data.count >= 3) { // Only include patterns with sufficient data
          const entry = { key: p.pattern_key, avg: data.avg, count: data.count };
          if (data.avg >= 70) highPatterns.push(entry);
          else if (data.avg < 50) lowPatterns.push(entry);
        }
      } catch (_) {}
    }

    // --- Gather workflow notes ---
    const workflowNotes = learnings.getByCategory('workflow-note');
    const relevantNotes = [];
    for (let ni = 0; ni < workflowNotes.length && ni < 3; ni++) {
      if (workflowNotes[ni].confidence >= 50) {
        relevantNotes.push(workflowNotes[ni].pattern_value);
      }
    }

    // --- Gather common feedback themes ---
    const themes = learnings.getByCategory('prompt-theme');
    const topThemes = themes
      .filter(function(t) { return t.occurrences >= 3 && t.confidence >= 40; })
      .slice(0, 5)
      .map(function(t) { return t.pattern_key; });

    // --- Build the section ---
    // Only include if there's meaningful data
    if (scores.length < 2 && specPatterns.length < 1 && relevantNotes.length < 1) return '';

    const parts = [];
    parts.push('## Historical Build Intelligence');
    parts.push('');

    // Review score stats
    if (scores.length >= 2) {
      const avgScore = Math.round(scores.reduce(function(a, b) { return a + b; }, 0) / scores.length * 10) / 10;
      parts.push('### Review Pattern Analysis');
      parts.push('Based on ' + scores.length + ' completed builds:');
      parts.push('- Overall average review score: ' + avgScore + '/10');
      if (projectScores.length >= 2) {
        const projAvg = Math.round(projectScores.reduce(function(a, b) { return a + b; }, 0) / projectScores.length * 10) / 10;
        parts.push('- This project average: ' + projAvg + '/10');
      }
      if (specScores.length >= 2) {
        const specAvg = Math.round(specScores.reduce(function(a, b) { return a + b; }, 0) / specScores.length * 10) / 10;
        parts.push('- Average spec effectiveness: ' + specAvg + '/100');
      }
      parts.push('');
    }

    // Top finding categories
    const sortedFindings = Object.entries(findingCounts).sort(function(a, b) { return b[1] - a[1]; });
    if (sortedFindings.length > 0) {
      parts.push('### Most Common Review Findings');
      const topCats = sortedFindings.slice(0, 5);
      for (let ci = 0; ci < topCats.length; ci++) {
        const cat = topCats[ci][0];
        const count = topCats[ci][1];
        const msgs = findingMessages[cat] || [];
        parts.push('- **' + cat + '** (' + count + 'x)' + (msgs.length > 0 ? ': ' + msgs.slice(0, 2).join('; ') : ''));
      }
      parts.push('');
      parts.push('Address these categories proactively in your specification. Do not repeat past mistakes.');
      parts.push('');
    }

    // Spec patterns that correlate with quality
    if (highPatterns.length > 0 || lowPatterns.length > 0) {
      parts.push('### Spec Effectiveness Patterns');
      for (let hi = 0; hi < highPatterns.length && hi < 3; hi++) {
        const p = highPatterns[hi];
        parts.push('- Specs with "' + formatPatternKey(p.key) + '": avg effectiveness ' + p.avg + '/100 (' + p.count + ' samples)');
      }
      for (let li = 0; li < lowPatterns.length && li < 3; li++) {
        const p = lowPatterns[li];
        parts.push('- Specs WITHOUT "' + formatPatternKey(p.key) + '": avg effectiveness ' + p.avg + '/100 (' + p.count + ' samples) — IMPROVE THIS');
      }
      parts.push('');
    }

    // Feedback themes
    if (topThemes.length > 0) {
      parts.push('### Recurring Feedback Themes');
      parts.push('These issues appear repeatedly in retry feedback. Address them upfront:');
      parts.push('- ' + topThemes.join(', '));
      parts.push('');
    }

    // Workflow notes
    if (relevantNotes.length > 0) {
      parts.push('### System Observations');
      for (let rn = 0; rn < relevantNotes.length; rn++) {
        parts.push('- ' + relevantNotes[rn]);
      }
      parts.push('');
    }

    return parts.join('\n');
  } catch (err) {
    log.error({ err: err.message }, 'spec-intelligence: gatherHistoricalContext failed');
    return ''; // Graceful degradation — brainstorm proceeds without historical context
  }
}

function formatPatternKey(key) {
  return key.replace(/-/g, ' ').replace(/^has /, '').replace(/^is /, '');
}

// =============================================================================
// 3. Creative Constraints
// =============================================================================
// Context-aware creative thinking prompts. Applied to a configurable percentage
// of brainstorms. Each constraint forces consideration of an angle that routine
// engineering often misses.

const CREATIVE_CONSTRAINTS = [
  // Accessibility & inclusion
  { text: 'Design this feature so it works perfectly with screen readers and keyboard-only navigation. What changes to the spec?', tags: ['feature', 'bug', 'default'] },
  { text: 'What if the primary user has a slow 3G connection and a 5-year-old phone? Which parts of this design break first?', tags: ['feature', 'performance', 'default'] },

  // Resilience & failure modes
  { text: 'Design this to gracefully degrade when the database is read-only or temporarily unavailable.', tags: ['feature', 'default', 'refactor'] },
  { text: 'What if this needs to handle a sudden 100x traffic spike with zero preparation? Which component is the bottleneck?', tags: ['performance', 'feature', 'default'] },
  { text: 'What if the upstream API/dependency returns malformed data 10% of the time? How does this spec account for that?', tags: ['feature', 'default', 'bug'] },

  // Simplicity & elegance
  { text: 'What if the entire implementation had to fit in a single file under 300 lines? What would you cut to make that work?', tags: ['feature', 'refactor', 'default'] },
  { text: 'Remove one dependency from the planned implementation. What has to change? Is the result actually better?', tags: ['feature', 'refactor', 'default'] },

  // User empathy
  { text: 'A non-technical person needs to configure and operate this. How would you make every step self-evident?', tags: ['feature', 'default'] },
  { text: 'What happens if a user accidentally triggers this action twice in rapid succession? Is the result safe and predictable?', tags: ['feature', 'bug', 'default'] },
  { text: 'What if the user makes a mistake? How do they undo it? Is recovery as easy as the action itself?', tags: ['feature', 'default'] },

  // Security adversarial thinking
  { text: 'Assume an attacker has read the entire source code. What would they target first in this implementation?', tags: ['security', 'feature', 'default'] },
  { text: 'What if every piece of user input is a carefully crafted exploit payload? Does every input path survive?', tags: ['security', 'feature', 'default'] },

  // Observability & operations
  { text: 'A production incident happens at 3 AM. What logs, metrics, or alerts would you need to diagnose it in under 5 minutes?', tags: ['feature', 'default', 'performance'] },
  { text: 'How would you prove this feature works correctly without any manual testing? What automated verification exists?', tags: ['feature', 'default', 'bug'] },

  // Scale & longevity
  { text: 'What if the data volume grows 1000x over the next year? Which part of this design breaks first?', tags: ['performance', 'feature', 'default'] },
  { text: 'Design this so it can be deployed across multiple geographic regions with no code changes. What abstractions are needed?', tags: ['feature', 'default', 'performance'] },

  // Cross-domain creativity
  { text: 'How would you expose this as a public API that third-party developers could build on? What contract would you promise?', tags: ['feature', 'default'] },
  { text: 'What if this feature also needed to work as a CLI tool? How does that change the architecture?', tags: ['feature', 'default'] },
  { text: 'What if this feature needed a complete undo/history system? How would that change the data model?', tags: ['feature', 'default', 'refactor'] },

  // Time & resource constraints
  { text: 'If you had to ship a working version in 2 hours, what would you build first and what would you defer? Use that priority order.', tags: ['feature', 'default'] },
  { text: 'What if the budget for this feature was zero third-party dependencies? How does the implementation change?', tags: ['feature', 'refactor', 'default'] },
];

function selectCreativeConstraint(card) {
  if (runtime.creativeConstraintPct <= 0) return '';
  if (Math.random() * 100 >= runtime.creativeConstraintPct) return '';

  const cardType = detectCardType(card);

  // Filter constraints relevant to this card type
  const relevant = CREATIVE_CONSTRAINTS.filter(function(c) {
    return c.tags.indexOf(cardType) !== -1;
  });
  if (relevant.length === 0) return '';

  // Weighted random: prefer constraints not recently used
  const recentlyUsed = learnings.getByCategory('constraint-used');
  const recentKeys = {};
  for (let ri = 0; ri < recentlyUsed.length; ri++) {
    recentKeys[recentlyUsed[ri].pattern_key] = recentlyUsed[ri].occurrences;
  }

  // Score each constraint: lower usage = higher weight
  let totalWeight = 0;
  const weighted = [];
  for (let ci = 0; ci < relevant.length; ci++) {
    const sig = relevant[ci].text.slice(0, 50);
    const usageCount = recentKeys[sig] || 0;
    const weight = Math.max(1, 10 - usageCount);
    totalWeight += weight;
    weighted.push({ constraint: relevant[ci], weight: weight, cumWeight: totalWeight });
  }

  // Weighted random selection
  const roll = Math.random() * totalWeight;
  let selected = relevant[0];
  for (let wi = 0; wi < weighted.length; wi++) {
    if (roll <= weighted[wi].cumWeight) {
      selected = weighted[wi].constraint;
      break;
    }
  }

  // Track usage for future diversity
  const sig = selected.text.slice(0, 50);
  learnings.upsert('constraint-used', sig, cardType, 30);

  const parts = [];
  parts.push('## Creative Thinking Constraint');
  parts.push('');
  parts.push(selected.text);
  parts.push('');
  parts.push('This is a thinking exercise that surfaces hidden design concerns.');
  parts.push('Address it in 2-3 sentences within the spec: either incorporate the insight or explicitly explain why it does not apply.');
  parts.push('Do not ignore this section.');
  parts.push('');

  return parts.join('\n');
}

// =============================================================================
// 4. Spec Quality Feedback Loop
// =============================================================================
// After every build+review cycle, computes a spec effectiveness score.
// Learns structural patterns from specs that produced high vs low quality builds.
// This data feeds back into gatherHistoricalContext() for future brainstorms.

// Spec effectiveness formula:
//   base     = reviewScore * 10                    (0-100 from review quality)
//   fixPen   = fixRounds * 15                      (penalty per fix cycle needed)
//   timePen  = 30 if build timed out               (spec was too vague/complex)
//   appBonus = 10 if auto-approved first try       (spec was unambiguous)
//   score    = clamp(base - fixPen - timePen + appBonus, 0, 100)
//
function computeSpecEffectiveness(cardId, reviewScore, fixRounds, autoApproved) {
  try {
    const card = cards.get(cardId);
    if (!card) return 0;

    // Check for timeout in session log
    const timedOut = (card.session_log || '').indexOf('TIMEOUT') !== -1;

    const base = (reviewScore || 0) * 10;
    const fixPenalty = (fixRounds || 0) * 15;
    const timePenalty = timedOut ? 30 : 0;
    const approveBonus = (autoApproved && fixRounds === 0) ? 10 : 0;
    const score = Math.max(0, Math.min(100, base - fixPenalty - timePenalty + approveBonus));

    // Persist score on card
    cards.setSpecScore(cardId, score);

    // Audit trail
    auditLog('spec-score', 'card', cardId, 'system',
      '', String(score),
      'review=' + reviewScore + ' fixes=' + fixRounds + ' auto=' + autoApproved + ' timeout=' + timedOut);

    // Learn from this spec's structural patterns
    if (card.spec) {
      learnFromSpec(card.spec, score);
    }

    log.info({
      cardId: cardId,
      specScore: score,
      reviewScore: reviewScore,
      fixRounds: fixRounds,
      autoApproved: autoApproved,
    }, 'Spec effectiveness computed');

    return score;
  } catch (err) {
    log.error({ cardId: cardId, err: err.message }, 'computeSpecEffectiveness failed');
    return 0; // Graceful degradation
  }
}

// Structural feature extraction from spec text.
// Each feature is correlated with the spec's effectiveness score over time.
function analyzeSpecStructure(specText) {
  if (!specText || specText.length < 20) return {};

  const len = specText.length;
  return {
    'length-short': len < 500,
    'length-medium': len >= 500 && len < 2000,
    'length-long': len >= 2000 && len < 5000,
    'length-very-long': len >= 5000,
    'has-numbered-steps': /^\s*\d+[.)]/m.test(specText),
    'has-file-paths': /\b[\w-]+\.(js|ts|jsx|tsx|css|html|json|md|py|go|rs|sql)\b/i.test(specText),
    'has-code-blocks': /```/.test(specText),
    'has-acceptance-criteria': /accept|criteria|requirement|must\s+(be|have|support)|should\s+(be|have|support)/i.test(specText),
    'has-edge-cases': /edge\s*case|risk|rollback|failure|error\s*handling|fallback/i.test(specText),
    'has-architecture': /architect|data\s*flow|component|module|layer|pattern/i.test(specText),
    'has-testing-plan': /test\s*plan|test\s*case|coverage|assert|expect|mock|spec\s*file/i.test(specText),
    'has-security-section': /security|auth|encrypt|sanitiz|validat|csrf|xss|inject|owasp/i.test(specText),
    'has-performance-target': /performance|latency|p95|p99|bundle\s*size|cache|lazy\s*load/i.test(specText),
    'has-accessibility': /a11y|accessibility|wcag|aria|screen\s*reader|keyboard\s*nav/i.test(specText),
    'has-api-contract': /endpoint|route|request|response|payload|status\s*code|api/i.test(specText),
    'has-data-model': /schema|table|column|field|relation|foreign\s*key|index|migration/i.test(specText),
    'has-error-handling': /error\s*handling|error\s*boundary|try|catch|fallback|graceful/i.test(specText),
    'has-rollback-plan': /rollback|revert|undo|migration\s*down|backward\s*compat/i.test(specText),
  };
}

function learnFromSpec(specText, score) {
  const features = analyzeSpecStructure(specText);
  const featureKeys = Object.keys(features);

  for (let fi = 0; fi < featureKeys.length; fi++) {
    const key = featureKeys[fi];
    if (!features[key]) continue; // Only learn from features that are PRESENT

    // Read existing running average
    const existing = learnings.get('spec-pattern', key);
    let sum = 0;
    let count = 0;

    if (existing) {
      try {
        const data = JSON.parse(existing.pattern_value);
        sum = data.sum || 0;
        count = data.count || 0;
      } catch (_) {}
    }

    sum += score;
    count += 1;
    const avg = Math.round(sum / count);

    // Confidence grows with data: starts at 30, reaches 90 at 20 samples
    const confidence = Math.min(90, 30 + count * 3);
    learnings.upsert('spec-pattern', key, JSON.stringify({ sum: sum, count: count, avg: avg }), confidence);
  }

  // Also learn about ABSENT features for specs with low scores
  if (score < 40) {
    for (let fi = 0; fi < featureKeys.length; fi++) {
      const key = featureKeys[fi];
      if (features[key]) continue; // Skip features that ARE present
      if (key.startsWith('length-')) continue; // Length buckets are always mutually exclusive

      const absentKey = 'missing-' + key;
      const existing = learnings.get('spec-pattern', absentKey);
      let sum = 0;
      let count = 0;

      if (existing) {
        try {
          const data = JSON.parse(existing.pattern_value);
          sum = data.sum || 0;
          count = data.count || 0;
        } catch (_) {}
      }

      sum += score;
      count += 1;
      const avg = Math.round(sum / count);
      const confidence = Math.min(80, 25 + count * 3);
      learnings.upsert('spec-pattern', absentKey, JSON.stringify({ sum: sum, count: count, avg: avg }), confidence);
    }
  }
}

// =============================================================================
// API: Spec Intelligence Insights
// =============================================================================
// Returns aggregated spec quality data for dashboards and monitoring.

function getInsights() {
  try {
    const allCards = cards.getAll().concat(cards.getArchived());

    // Spec score distribution
    const distribution = { excellent: 0, good: 0, needsImprovement: 0, poor: 0, unscored: 0 };
    const specScores = [];
    const reviewScores = [];

    for (let i = 0; i < allCards.length; i++) {
      const c = allCards[i];
      if (c.spec_score > 0) {
        specScores.push(c.spec_score);
        if (c.spec_score >= 80) distribution.excellent++;
        else if (c.spec_score >= 60) distribution.good++;
        else if (c.spec_score >= 40) distribution.needsImprovement++;
        else distribution.poor++;
      } else if (c.spec) {
        distribution.unscored++;
      }
      if (c.review_score > 0) reviewScores.push(c.review_score);
    }

    // Spec pattern analysis
    const patterns = learnings.getByCategory('spec-pattern');
    const patternInsights = [];
    for (let pi = 0; pi < patterns.length; pi++) {
      try {
        const data = JSON.parse(patterns[pi].pattern_value);
        if (data.count >= 2) {
          patternInsights.push({
            pattern: patterns[pi].pattern_key,
            avgEffectiveness: data.avg,
            sampleCount: data.count,
            confidence: patterns[pi].confidence,
          });
        }
      } catch (_) {}
    }
    patternInsights.sort(function(a, b) { return b.avgEffectiveness - a.avgEffectiveness; });

    // Constraint usage stats
    const constraintUsage = learnings.getByCategory('constraint-used');
    const constraintStats = constraintUsage.map(function(c) {
      return { constraint: c.pattern_key, timesUsed: c.occurrences, lastUsed: c.last_seen };
    });

    // Review finding aggregation
    const findingAgg = {};
    for (let i = 0; i < allCards.length; i++) {
      if (!allCards[i].review_data) continue;
      try {
        const rd = JSON.parse(allCards[i].review_data);
        const findings = rd.findings || [];
        for (let fi = 0; fi < findings.length; fi++) {
          const cat = findings[fi].category || 'other';
          if (!findingAgg[cat]) findingAgg[cat] = { count: 0, messages: [] };
          findingAgg[cat].count++;
          if (findingAgg[cat].messages.length < 5 && findings[fi].message) {
            findingAgg[cat].messages.push(findings[fi].message);
          }
        }
      } catch (_) {}
    }

    return {
      specScores: {
        total: specScores.length,
        average: specScores.length > 0 ? Math.round(specScores.reduce(function(a, b) { return a + b; }, 0) / specScores.length) : 0,
        distribution: distribution,
      },
      reviewScores: {
        total: reviewScores.length,
        average: reviewScores.length > 0 ? Math.round(reviewScores.reduce(function(a, b) { return a + b; }, 0) / reviewScores.length * 10) / 10 : 0,
      },
      patterns: {
        highEffectiveness: patternInsights.filter(function(p) { return p.avgEffectiveness >= 70 && !p.pattern.startsWith('missing-'); }),
        lowEffectiveness: patternInsights.filter(function(p) { return p.avgEffectiveness < 50 || p.pattern.startsWith('missing-'); }),
        total: patternInsights.length,
      },
      constraints: {
        totalUsed: constraintStats.reduce(function(sum, c) { return sum + c.timesUsed; }, 0),
        unique: constraintStats.length,
        details: constraintStats,
      },
      reviewFindings: findingAgg,
      config: {
        multiLensBrainstorm: runtime.multiLensBrainstorm,
        creativeConstraintPct: runtime.creativeConstraintPct,
        specFeedbackLoop: runtime.specFeedbackLoop,
      },
    };
  } catch (err) {
    log.error({ err: err.message }, 'spec-intelligence: getInsights failed');
    return { error: 'Failed to gather insights: ' + err.message };
  }
}

// =============================================================================
// Init
// =============================================================================

function init() {
  const patternCount = learnings.getByCategory('spec-pattern').length;
  const constraintCount = learnings.getByCategory('constraint-used').length;
  log.info({
    multiLens: runtime.multiLensBrainstorm,
    creativeConstraintPct: runtime.creativeConstraintPct,
    specFeedback: runtime.specFeedbackLoop,
    existingPatterns: patternCount,
    constraintsUsed: constraintCount,
  }, 'Spec intelligence service initialized');
}

module.exports = {
  // Brainstorm prompt enrichment
  buildMultiLensSection: buildMultiLensSection,
  gatherHistoricalContext: gatherHistoricalContext,
  selectCreativeConstraint: selectCreativeConstraint,

  // Spec feedback loop
  computeSpecEffectiveness: computeSpecEffectiveness,
  analyzeSpecStructure: analyzeSpecStructure,

  // API / monitoring
  getInsights: getInsights,
  detectCardType: detectCardType,

  // Lifecycle
  init: init,
};
