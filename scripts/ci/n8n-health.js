#!/usr/bin/env bun

const DEFAULT_BASE_URL = 'https://n8n.bluedevilcollectibles.com';
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function joinBaseAndPath(baseUrl, path) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlash(baseUrl)}${suffix}`;
}

function buildHealthUrl(env = process.env) {
  if (env.N8N_HEALTH_URL && env.N8N_HEALTH_URL.trim() !== '') {
    return env.N8N_HEALTH_URL.trim();
  }

  const baseUrl =
    env.N8N_BASE_URL && env.N8N_BASE_URL.trim() !== ''
      ? env.N8N_BASE_URL.trim()
      : DEFAULT_BASE_URL;
  const path =
    env.N8N_HEALTH_PATH && env.N8N_HEALTH_PATH.trim() !== ''
      ? env.N8N_HEALTH_PATH.trim()
      : DEFAULT_HEALTH_PATH;

  return joinBaseAndPath(baseUrl, path);
}

function parsePositiveInt(name, value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    url: buildHealthUrl(env),
    timeoutMs: parsePositiveInt(
      'N8N_HEALTH_TIMEOUT_MS',
      env.N8N_HEALTH_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    retries: parsePositiveInt('N8N_HEALTH_RETRIES', env.N8N_HEALTH_RETRIES, DEFAULT_RETRIES),
    retryDelayMs: parsePositiveInt(
      'N8N_HEALTH_RETRY_DELAY_MS',
      env.N8N_HEALTH_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS
    ),
    expectJson: env.N8N_HEALTH_EXPECT_JSON === '1',
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) {
      options.url = next;
      i += 1;
    } else if (arg === '--timeout-ms' && next) {
      options.timeoutMs = parsePositiveInt('--timeout-ms', next, DEFAULT_TIMEOUT_MS);
      i += 1;
    } else if (arg === '--retries' && next) {
      options.retries = parsePositiveInt('--retries', next, DEFAULT_RETRIES);
      i += 1;
    } else if (arg === '--retry-delay-ms' && next) {
      options.retryDelayMs = parsePositiveInt('--retry-delay-ms', next, DEFAULT_RETRY_DELAY_MS);
      i += 1;
    } else if (arg === '--expect-json') {
      options.expectJson = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }

  return validateOptions(options);
}

function validateOptions(options) {
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch (_error) {
    throw new Error(`N8N health URL is invalid: ${options.url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`N8N health URL must use http or https: ${options.url}`);
  }

  return {
    ...options,
    url: parsed.toString(),
  };
}

function responseJsonLooksHealthy(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const values = Object.values(body).map(value => String(value).toLowerCase());
  return values.some(value =>
    ['ok', 'ready', 'healthy', 'success', 'true'].some(healthyWord => value.includes(healthyWord))
  );
}

async function readBody(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('application/json')) {
    return { type: 'json', value: await response.json() };
  }
  return { type: 'text', value: await response.text() };
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkN8nHealth(options, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }

  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const startedAt = deps.now ? deps.now() : Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(options.url, options.timeoutMs, fetchImpl);
      const body = await readBody(response);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (options.expectJson && (body.type !== 'json' || !responseJsonLooksHealthy(body.value))) {
        throw new Error('health response JSON did not contain a healthy status');
      }

      return {
        ok: true,
        url: options.url,
        attempts: attempt,
        status: response.status,
        elapsedMs: (deps.now ? deps.now() : Date.now()) - startedAt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < options.retries) {
        await sleep(options.retryDelayMs);
      }
    }
  }

  return {
    ok: false,
    url: options.url,
    attempts: options.retries,
    error: lastError ? lastError.message : 'unknown health check failure',
    elapsedMs: (deps.now ? deps.now() : Date.now()) - startedAt,
  };
}

function usage() {
  return [
    'Usage: bun scripts/ci/n8n-health.js [--url URL] [--timeout-ms N] [--retries N]',
    '',
    'Environment:',
    '  N8N_HEALTH_URL              Full health URL. Overrides base/path.',
    '  N8N_BASE_URL                Base URL used with N8N_HEALTH_PATH.',
    '  N8N_HEALTH_PATH             Health path. Default: /healthz.',
    '  N8N_HEALTH_TIMEOUT_MS       Per-attempt timeout. Default: 5000.',
    '  N8N_HEALTH_RETRIES          Attempts before failure. Default: 3.',
    '  N8N_HEALTH_RETRY_DELAY_MS   Delay between attempts. Default: 1000.',
    '  N8N_HEALTH_EXPECT_JSON=1    Require JSON body with healthy-looking status.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    console.error(
      `N8N_HEALTH=failed reason="${error instanceof Error ? error.message : String(error)}"`
    );
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const result = await checkN8nHealth(options);
  if (result.ok) {
    if (!options.quiet) {
      console.log(
        `N8N_HEALTH=ok url="${result.url}" status=${result.status} attempts=${result.attempts} elapsed_ms=${result.elapsedMs}`
      );
    }
    return 0;
  }

  console.error(
    `N8N_HEALTH=failed url="${result.url}" attempts=${result.attempts} elapsed_ms=${result.elapsedMs} reason="${result.error}"`
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exitCode = code;
}

export {
  DEFAULT_BASE_URL,
  DEFAULT_HEALTH_PATH,
  checkN8nHealth,
  parseArgs,
  responseJsonLooksHealthy,
};
