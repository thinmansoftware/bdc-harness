/**
 * ===========================================================================
 * CROSS-AI GUARDRAILS HEADER -- DO NOT REMOVE
 * ===========================================================================
 * Project:        BDC Infrastructure
 * Feature:        n8n Webhook Health Test Suite
 * File:           n8n-health.js
 * Version:        1.1.0
 *
 * RULES:
 * - Claude is test operator, not release authority
 * - John Ranson is sole release gatekeeper
 *
 * WO-INFRA-N8N-HEALTH-TESTS-01 (original suite)
 * WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01 (alert dedup + persistence fix)
 * Runs 5 health test cases against n8n webhook endpoints.
 * Appends results to a local JSON-lines log (health-results.jsonl).
 * Alerts via admin-notify webhook on NEW/CHANGED failures only (deduplicated),
 * with a single recovery notice when the suite returns to all-passing.
 *
 * Source of truth: this file lives at scripts/ci/n8n-health.js in
 * bluedevilcollectibles/bdc-harness. The Hetzner host copy at
 * /opt/bdc/ci/n8n-health.js is deployed from here (see deploy-n8n-health.sh).
 * The systemd unit bdc-n8n-health.service runs it directly as CommonJS.
 *
 * NO EMOJIS IN CODE - ASCII ONLY
 * ===========================================================================
 */

'use strict';

var https = require('https');
var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config from environment (loaded by systemd EnvironmentFile)
// ---------------------------------------------------------------------------
var N8N_API_KEY = process.env.N8N_API_KEY || '';
var N8N_BASE = process.env.N8N_BASE || 'http://localhost:5678';
var ALERT_URL =
  process.env.ALERT_URL || 'https://n8n.bluedevilcollectibles.com/webhook/admin-notify';
var N8N_WH_BASE = process.env.N8N_WH_BASE || 'https://n8n.bluedevilcollectibles.com';

var SUITE_NAME = 'n8n-health';

// Persistence + alert-dedup config (WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01).
// These default to files next to the script so a systemd oneshot with no
// persistent process can still carry "last alerted" state across runs.
var SCRIPT_DIR = __dirname;
var STATE_FILE =
  process.env.HEALTH_STATE_FILE || path.join(SCRIPT_DIR, '.n8n-health-last-alert.json');
var RESULTS_LOG = process.env.HEALTH_RESULTS_LOG || path.join(SCRIPT_DIR, 'health-results.jsonl');
// Re-alert reminder window for an UNCHANGED persistent failure. Default 24h so a
// still-broken suite reminds once per day, not once per 6h forever.
var REALERT_INTERVAL_MS = parseInt(process.env.HEALTH_REALERT_INTERVAL_MS, 10) || 86400000;

// Fixture tenant used by the "valid STARTER tenant" test case below.
var STARTER_FIXTURE_SCRIPT_ID = '1HOP0UV93bW3RcF5RMpMfchXbdBlyYhHm0D3C-sqKxhbIdEeDYjHzY1Td';

// ---------------------------------------------------------------------------
// HTTP fetch helper (no external deps)
// ---------------------------------------------------------------------------
function httpRequest(method, urlStr, body, extraHeaders) {
  return new Promise(function (resolve, reject) {
    var parsed = new URL(urlStr);
    var isHttps = parsed.protocol === 'https:';
    var mod = isHttps ? https : http;
    var headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    var bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: method,
      headers: headers,
      timeout: 10000,
    };
    var req = mod.request(options, function (res) {
      var chunks = [];
      res.on('data', function (c) {
        chunks.push(c);
      });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString();
        var parsed_body = null;
        try {
          parsed_body = JSON.parse(raw);
        } catch (e) {
          parsed_body = raw;
        }
        resolve({ status: res.statusCode, body: parsed_body, raw: raw });
      });
    });
    req.on('error', function (e) {
      reject(e);
    });
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test-tenant cleanup (2026-07-11)
// ---------------------------------------------------------------------------
// The license/validate tests create REAL tenant rows in PROD Supabase (project
// aqat) every run: 'ci_health_test_<ts>' from the auto-register test, and
// 'undefined' from the empty-body test (the webhook auto-registers a tenant
// when the body has no script_id -- a real product bug). Before this cleanup
// existed these leaked 290+ junk tenants over 7 weeks (7/11 tenant audit).
// This sweeps BOTH patterns via the Supabase REST API and returns the count of
// ci_health_test_ rows deleted (for the auto-register test's own assertion).
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY for the PROD project in
// /opt/bdc/ci/.env (root-only). NOTE: shopops-api SUPABASE_DB_* point at
// STAGING (uqyi), NOT prod -- do not use those here.
function sweepTestTenants() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return Promise.reject(
      new Error('cleanup config missing: SUPABASE_URL/SUPABASE_SERVICE_KEY not in env')
    );
  }
  var base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  var q = 'or=(script_id.like.ci_health_test_*,script_id.eq.undefined)';
  var url = base + '/rest/v1/tenants?' + q;
  return httpRequest('DELETE', url, null, {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    Prefer: 'return=representation',
  }).then(function (res) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error('cleanup DELETE failed: status ' + res.status);
    }
    var rows = Array.isArray(res.body) ? res.body : [];
    return rows.filter(function (r) {
      return r.script_id && r.script_id.indexOf('ci_health_test_') === 0;
    }).length;
  });
}

// ---------------------------------------------------------------------------
// STARTER fixture self-healing (2026-07-19, WO-SHOPOPS-LICENSE-VALIDATE-STARTER-403-DIAG-01)
// ---------------------------------------------------------------------------
// Root cause of the 2026-07-17..07-19 STARTER-tenant 403 outage: this fixture
// (id 11, script_id STARTER_FIXTURE_SCRIPT_ID) was created 2026-04-29 as a
// 14-day TRIALING tenant. The lsp-license-grace-expiry cron (workflow
// 7P4ZAZNxrpN327In, daily 3AM) is *supposed* to cancel expired TRIALING/
// PAST_DUE tenants via transition_tenant_status(), but that Postgres function
// was missing/broken (NodeOperationError: function transition_tenant_status
// does not exist) until 2026-07-17, so this long-expired fixture sat
// untouched for months. The moment the cron started succeeding (07-17 03:00
// America/New_York), it correctly-per-its-own-logic canceled this fixture,
// which then 403'd every CI run since. This was NOT a bug in the
// license/validate webhook's Query Tenant/Build Response logic -- it was a
// fixture that was never protected from a real lifecycle process, unlike the
// ELITE fixture (a real always-on status=ACTIVE tenant, which the cron never
// touches since it only targets TRIALING/PAST_DUE).
//
// Fix: the fixture row was repaired once (status -> ACTIVE, immune to the
// expiry cron, same protection pattern as the ELITE fixture). This function
// re-asserts that same healthy state before every run of the STARTER test
// case so any future drift (manual, cron, or otherwise) self-heals instead of
// silently failing CI for days before anyone notices.
function ensureStarterFixtureHealthy() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return Promise.reject(
      new Error('fixture self-heal config missing: SUPABASE_URL/SUPABASE_SERVICE_KEY not in env')
    );
  }
  var base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  var url = base + '/rest/v1/tenants?script_id=eq.' + STARTER_FIXTURE_SCRIPT_ID;
  return httpRequest(
    'PATCH',
    url,
    { status: 'ACTIVE', grace_until: null },
    {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      Prefer: 'return=representation',
    }
  ).then(function (res) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error('fixture self-heal PATCH failed: status ' + res.status);
    }
    var rows = Array.isArray(res.body) ? res.body : [];
    if (rows.length !== 1 || rows[0].script_id !== STARTER_FIXTURE_SCRIPT_ID) {
      throw new Error(
        'fixture self-heal PATCH did not affect exactly the expected row: ' +
          JSON.stringify(res.body)
      );
    }
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
var TEST_CASES = [
  {
    name: 'license/validate: valid ELITE tenant (master)',
    run: function () {
      return httpRequest('POST', N8N_WH_BASE + '/webhook/license/validate', {
        script_id: '1n7-03xa2oa8Emc4cg81vldwsCnvrRaNGvT-24VHuYo63TqSTgXNCBa9l',
      }).then(function (res) {
        if (res.status !== 200) throw new Error('Expected 200, got ' + res.status);
        var b = res.body;
        if (!b || b.allowed !== true)
          throw new Error('Expected allowed:true, got: ' + JSON.stringify(b));
        if (b.plan !== 'ELITE') throw new Error('Expected plan:ELITE, got: ' + b.plan);
        return { ok: true };
      });
    },
  },
  {
    name: 'license/validate: valid STARTER tenant',
    run: function () {
      // Self-heal first (see ensureStarterFixtureHealthy() above) so this
      // fixture cannot silently drift to a denied state again before the
      // actual webhook assertion below runs.
      return ensureStarterFixtureHealthy().then(function () {
        return httpRequest('POST', N8N_WH_BASE + '/webhook/license/validate', {
          script_id: STARTER_FIXTURE_SCRIPT_ID,
        }).then(function (res) {
          if (res.status !== 200) throw new Error('Expected 200, got ' + res.status);
          var b = res.body;
          if (!b || b.allowed !== true)
            throw new Error('Expected allowed:true, got: ' + JSON.stringify(b));
          if (b.plan !== 'STARTER') throw new Error('Expected plan:STARTER, got: ' + b.plan);
          return { ok: true };
        });
      });
    },
  },
  {
    name: 'license/validate: new tenant auto-registers as TRIALING',
    run: function () {
      // New/unknown script IDs are auto-registered with a 14-day trial (TRIALING).
      // This tests the trial registration flow -- allowed:true, status:TRIALING.
      // The n8n workflow SQL uses a CTE INSERT + SELECT. Due to Postgres CTE
      // snapshot isolation, the first call creates the tenant but the SELECT
      // doesn't see it (returns unknown_tenant/403). The second call finds
      // the now-existing row and returns allowed:true/200.
      // This two-call pattern tests both the auto-registration AND the
      // subsequent validation -- which is the real production flow.
      // This test creates a real prod tenant row; sweepTestTenants() (module
      // scope) cleans it, and main() runs a final unconditional sweep so rows
      // created by LATER tests (e.g. the empty-body 'undefined' row) are also
      // removed. See sweepTestTenants() header for the full contract.
      var testScriptId = 'ci_health_test_' + Date.now();
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return Promise.reject(
          new Error(
            'cleanup config missing: SUPABASE_URL/SUPABASE_SERVICE_KEY not in env -- refusing to run a test that leaks prod tenants'
          )
        );
      }
      function assertFlow() {
        return httpRequest('POST', N8N_WH_BASE + '/webhook/license/validate', {
          script_id: testScriptId,
        })
          .then(function (res) {
            // Current flow: auto-register visible same-call, returns 200.
            // Legacy flow (pre-2026-07): CTE snapshot isolation returned 403
            // on first call, 200 on second. Accept both.
            if (res.status === 200) return res;
            if (res.status === 403) {
              return httpRequest('POST', N8N_WH_BASE + '/webhook/license/validate', {
                script_id: testScriptId,
              });
            }
            throw new Error('First call: expected 200 (or legacy 403), got ' + res.status);
          })
          .then(function (res) {
            if (res.status !== 200)
              throw new Error('Validate call: expected 200, got ' + res.status);
            var b = res.body;
            if (!b || b.allowed !== true)
              throw new Error('Expected allowed:true for new tenant, got: ' + JSON.stringify(b));
            if (b.status !== 'TRIALING')
              throw new Error('Expected status:TRIALING, got: ' + b.status);
          });
      }
      return assertFlow().then(
        function () {
          return sweepTestTenants().then(function (n) {
            if (n < 1)
              throw new Error(
                'cleanup deleted 0 ci_health rows -- expected at least the tenant this run created'
              );
            return { ok: true, cleaned: n };
          });
        },
        function (err) {
          // Test failed -- still sweep whatever this run left behind, then
          // surface the ORIGINAL test failure.
          return sweepTestTenants()
            .catch(function () {})
            .then(function () {
              throw err;
            });
        }
      );
    },
  },
  {
    name: 'license/validate: empty body returns error',
    run: function () {
      return httpRequest('POST', N8N_WH_BASE + '/webhook/license/validate', {}).then(
        function (res) {
          // Expect 400 or allowed:false -- not a 500
          if (res.status === 500)
            throw new Error('Got 500 on empty body (should be 400 or structured error)');
          return { ok: true };
        }
      );
    },
  },
  {
    name: 'workflow active check: lsp-license-validate (8CZna7pYZQXjYWpc)',
    run: function () {
      return httpRequest('GET', N8N_BASE + '/api/v1/workflows/8CZna7pYZQXjYWpc', null, {
        'X-N8N-API-KEY': N8N_API_KEY,
      }).then(function (res) {
        if (res.status !== 200) throw new Error('Expected 200, got ' + res.status);
        var b = res.body;
        if (!b || b.active !== true)
          throw new Error('Workflow not active: ' + JSON.stringify(b && b.active));
        return { ok: true };
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Alert dedup state (WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01)
// ---------------------------------------------------------------------------
// A stable signature of the CURRENT failing set. Empty string means "all
// passing". Sorted so the signature is order-independent across runs.
function computeSignature(failedCases) {
  if (!failedCases || failedCases.length === 0) return '';
  var names = failedCases
    .map(function (f) {
      return f.name;
    })
    .slice()
    .sort();
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex');
}

// Read the persisted last-alert state. Missing or unparseable file -> {}.
function readState(filePath) {
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch (e) {
    return {};
  }
}

// Persist last-alert state atomically enough for a oneshot (single writer).
function writeState(filePath, state) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

// Decide what notification (if any) this run should send, given the current
// failure signature, the persisted state, the current time, and the re-alert
// window. Pure function -- no IO -- so it is unit-testable.
//   'new-failure'     : transition from all-passing (or no prior alert) to failing
//   'changed-failure' : failing set differs from the last alerted set
//   're-alert'        : same failing set, but re-alert interval has elapsed
//   'suppress'        : same failing set, still inside the re-alert window
//   'recovery'        : all-passing now, but a prior failure was alerted
//   'none'            : all-passing and nothing was outstanding
function decideNotification(currentSignature, state, nowMs, reAlertIntervalMs) {
  var prevSignature = (state && state.signature) || '';
  if (currentSignature) {
    if (!prevSignature) return 'new-failure';
    if (prevSignature !== currentSignature) return 'changed-failure';
    var lastAlertAtMs = state && state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
    if (!lastAlertAtMs || nowMs - lastAlertAtMs >= reAlertIntervalMs) return 're-alert';
    return 'suppress';
  }
  if (prevSignature) return 'recovery';
  return 'none';
}

// ---------------------------------------------------------------------------
// Alert on failure
// ---------------------------------------------------------------------------
function sendAlert(failedCases) {
  var lines = failedCases.map(function (f) {
    return '<li>' + f.name + ': ' + f.error + '</li>';
  });
  var payload = {
    subject: 'CI ALERT: n8n health suite -- ' + failedCases.length + ' failed',
    html:
      '<p><strong>Suite:</strong> ' +
      SUITE_NAME +
      '</p>' +
      '<p><strong>Failed:</strong> ' +
      failedCases.length +
      '/' +
      TEST_CASES.length +
      '</p>' +
      '<ul>' +
      lines.join('') +
      '</ul>' +
      '<p>Full run output appended to ' +
      RESULTS_LOG +
      ' on the Hetzner host (' +
      SUITE_NAME +
      ' JSON-lines log).</p>',
  };
  return httpRequest('POST', ALERT_URL, payload)
    .then(function () {
      console.log('[alert] admin-notify sent');
    })
    .catch(function (e) {
      console.error('[alert] Failed to send alert:', e.message);
    });
}

// One-time recovery notice when the suite returns to all-passing after a prior
// failure was alerted.
function sendRecoveryNotice(passedCount, totalCount) {
  var payload = {
    subject:
      'CI RESOLVED: n8n health suite recovered -- ' + passedCount + '/' + totalCount + ' passing',
    html:
      '<p><strong>Suite:</strong> ' +
      SUITE_NAME +
      '</p>' +
      '<p>The n8n health suite is passing again (' +
      passedCount +
      '/' +
      totalCount +
      '). A prior failure had been alerted; this is the one-time recovery notice.</p>' +
      '<p>Full run output appended to ' +
      RESULTS_LOG +
      ' on the Hetzner host.</p>',
  };
  return httpRequest('POST', ALERT_URL, payload)
    .then(function () {
      console.log('[alert] recovery notice sent');
    })
    .catch(function (e) {
      console.error('[alert] Failed to send recovery notice:', e.message);
    });
}

// ---------------------------------------------------------------------------
// Persist results to a local JSON-lines log
// ---------------------------------------------------------------------------
// (Replaces the previous Postgres write to the decommissioned DevilSync host
// at 127.0.0.1:5433, which had been silently ECONNREFUSED-failing on every run
// since the 2026-04-29 Supabase migration. WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01.)
function appendResultLine(logPath, record) {
  return fs.promises.appendFile(logPath, JSON.stringify(record) + '\n');
}

function writeResults(results, durationMs) {
  var passed = results.filter(function (r) {
    return r.ok;
  }).length;
  var failed = results.filter(function (r) {
    return !r.ok;
  }).length;
  var record = {
    ts: new Date().toISOString(),
    suite: SUITE_NAME,
    total: results.length,
    passed: passed,
    failed: failed,
    duration_ms: durationMs,
    results: results,
  };
  return appendResultLine(RESULTS_LOG, record);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  var start = Date.now();
  console.log('[n8n-health] Starting suite: ' + SUITE_NAME);

  var results = [];
  var chain = Promise.resolve();

  TEST_CASES.forEach(function (tc) {
    chain = chain.then(function () {
      return tc
        .run()
        .then(function () {
          console.log('[PASS] ' + tc.name);
          results.push({ name: tc.name, ok: true, error: null });
        })
        .catch(function (e) {
          console.log('[FAIL] ' + tc.name + ' -- ' + e.message);
          results.push({ name: tc.name, ok: false, error: e.message });
        });
    });
  });

  return chain
    .then(function () {
      return sweepTestTenants()
        .then(function (n) {
          if (n > 0)
            console.log('[n8n-health] final tenant sweep: removed ' + n + ' ci_health row(s)');
        })
        .catch(function (e) {
          console.error('[n8n-health] final tenant sweep failed:', e.message);
        });
    })
    .then(function () {
      var durationMs = Date.now() - start;
      var failed = results.filter(function (r) {
        return !r.ok;
      });
      var passed = results.filter(function (r) {
        return r.ok;
      });

      console.log(
        '[n8n-health] Done. ' +
          passed.length +
          '/' +
          results.length +
          ' passed. Duration: ' +
          durationMs +
          'ms'
      );

      var writeP = writeResults(results, durationMs)
        .then(function () {
          console.log('[n8n-health] Results appended to ' + RESULTS_LOG);
        })
        .catch(function (e) {
          console.error('[n8n-health] Results write failed:', e.message);
        });

      // Alert deduplication: only notify on a NEW/CHANGED failure, a re-alert
      // interval elapse for the SAME failure, or a recovery back to passing.
      var currentSignature = computeSignature(failed);
      var state = readState(STATE_FILE);
      var nowMs = Date.now();
      var nowIso = new Date().toISOString();
      var decision = decideNotification(currentSignature, state, nowMs, REALERT_INTERVAL_MS);
      var notifyP = Promise.resolve();

      if (decision === 'new-failure' || decision === 'changed-failure' || decision === 're-alert') {
        console.log(
          '[n8n-health] alert decision: ' +
            decision +
            ' (signature ' +
            currentSignature.slice(0, 12) +
            ')'
        );
        notifyP = sendAlert(failed).then(function () {
          writeState(STATE_FILE, {
            signature: currentSignature,
            failingNames: failed.map(function (f) {
              return f.name;
            }),
            lastAlertAt: nowIso,
            lastDecision: decision,
          });
        });
      } else if (decision === 'recovery') {
        console.log('[n8n-health] alert decision: recovery');
        notifyP = sendRecoveryNotice(passed.length, results.length).then(function () {
          writeState(STATE_FILE, {
            signature: '',
            failingNames: [],
            lastRecoveryAt: nowIso,
            lastDecision: 'recovery',
          });
        });
      } else {
        // 'suppress': leave existing state unchanged so the re-alert window is
        // measured from the last ACTUAL alert.
        // 'none': all-passing with nothing outstanding -- ensure a state file
        // exists so downstream checks (Stop 2) are satisfied after any run.
        console.log('[n8n-health] alert decision: ' + decision + ' (no notification sent)');
        if (decision === 'none' && !fs.existsSync(STATE_FILE)) {
          writeState(STATE_FILE, { signature: '', failingNames: [], lastDecision: 'none' });
        }
      }

      return Promise.all([writeP, notifyP]).then(function () {
        process.exit(failed.length > 0 ? 1 : 0);
      });
    });
}

// Only auto-run when executed directly (systemd host path). When required as a
// module (unit tests), export the pure helpers instead of running the suite.
if (require.main === module) {
  main().catch(function (e) {
    console.error('[n8n-health] Fatal:', e.message);
    process.exit(2);
  });
}

module.exports = {
  computeSignature: computeSignature,
  decideNotification: decideNotification,
  readState: readState,
  writeState: writeState,
  appendResultLine: appendResultLine,
};
