import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { FALLBACK_IMPERSONATION } from './fprints.js';
import { normalizeNetworkContext } from './network-context.js';

const DEFAULT_TTL = 25 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
const DEFAULT_CAPSOLVER_REQUEST_TIMEOUT = 30000;
const DEFAULT_CAPSOLVER_OVERALL_TIMEOUT = 150000;
const CHROME_131_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CONFIG_SOLVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'solver.json',
);

export function solverConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_SOLVER, 'utf8'));
  } catch {}
  return {
    apiKey: String(process.env.SOLVER_API_KEY || '').trim() || String(file.apiKey || '').trim(),
    browserWs: String(process.env.BROWSER_WS_ENDPOINT || '').trim() || String(file.browserWs || '').trim(),
    chromePath: String(process.env.CHROME_PATH || '').trim() || String(file.chromePath || '').trim(),
  };
}

function clearanceCookie(value) {
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name === 'cf_clearance' && cookieValue) return `cf_clearance=${cookieValue}`;
  }
  return '';
}

export function hasClearanceCookie(value) {
  return Boolean(clearanceCookie(value));
}

export function toPlaywrightProxy(value) {
  const input = String(value || '').trim();
  if (!input) return undefined;
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Playwright proxy must use http:// or https://');
  }
  const proxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

function usableSolution(solution) {
  const cookieHeader = clearanceCookie(solution?.cookieHeader);
  if (!cookieHeader) return null;
  return {
    cookieHeader,
    ua: String(solution?.ua || '').trim() || CHROME_131_UA,
    cleared: true,
    ...(solution?.via ? { via: solution.via } : {}),
  };
}

function challengeFailure(cause) {
  const error = new Error(
    'Cloudflare challenge could not be solved',
    cause ? { cause } : undefined,
  );
  error.code = 'cloudflare_challenge_failed';
  return error;
}

function typedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function findChrome(config = solverConfig()) {
  const configured = config.chromePath;
  if (configured && fs.existsSync(configured)) return configured;

  try {
    for (const directory of fs.readdirSync('/ms-playwright')) {
      if (!directory.startsWith('chromium-')) continue;
      const candidate = `/ms-playwright/${directory}/chrome-linux/chrome`;
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}

  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isChrome131Ua(value) {
  return /\b(?:Chrome|Chromium)\/131\./.test(String(value || ''));
}

const CHALLENGE_TEXT = /just a moment|checking your browser|verify you are human|needs to review the security|attention required|\u8bf7\u7a0d\u5019|\u6b63\u5728\u68c0\u67e5\u60a8\u7684\u6d4f\u89c8\u5668/i;

function cookieHeaderValue(headers = {}) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'cookie');
  return String(entry?.[1] || '');
}

function browserRequestHeaders(requestContext = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(requestContext.headers || {})) {
    const lower = name.toLowerCase();
    if ([
      'cookie',
      'content-length',
      'connection',
      'host',
      'proxy-authorization',
      'user-agent',
    ].includes(lower)) continue;
    headers[name] = String(value);
  }
  if (requestContext.token) headers.Authorization = `Bearer ${requestContext.token}`;
  if (requestContext.body != null && !Object.keys(headers).some(name => (
    name.toLowerCase() === 'content-type'
  ))) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function browserRequestCookies(url, requestContext = {}) {
  const cookies = [];
  for (const part of cookieHeaderValue(requestContext.headers).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    cookies.push({ name, value, url: new URL(url).origin });
  }
  return cookies;
}

function directResponseIsChallenge(response) {
  const contentType = String(response?.headers?.contentType || '').toLowerCase();
  const mitigated = String(response?.headers?.cfMitigated || '').trim().toLowerCase();
  if (mitigated === 'challenge') return true;
  if (![403, 429, 503].includes(Number(response?.status))) return false;
  if (!contentType.includes('text/html')) return false;
  return CHALLENGE_TEXT.test(String(response?.html || ''));
}

function toDirectResponse({ status, headers = {}, text = '' }) {
  const contentTypeEntry = Object.entries(headers).find(([name]) => (
    name.toLowerCase() === 'content-type'
  ));
  const mitigatedEntry = Object.entries(headers).find(([name]) => (
    name.toLowerCase() === 'cf-mitigated'
  ));
  const contentType = String(contentTypeEntry?.[1] || '');
  const cfMitigated = String(mitigatedEntry?.[1] || '');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: String(text).slice(0, 300) };
  }
  const result = {
    status: Number(status),
    json,
    headers: { contentType, cfMitigated },
  };
  const headerChallenge = cfMitigated.trim().toLowerCase() === 'challenge';
  const htmlCandidate = [403, 429, 503].includes(Number(status))
    && contentType.toLowerCase().includes('text/html');
  if (headerChallenge || htmlCandidate) result.html = String(text);
  return result;
}

async function navigationResponse(response) {
  if (!response) return null;
  const headers = typeof response.allHeaders === 'function'
    ? await response.allHeaders()
    : await response.headers();
  return toDirectResponse({
    status: response.status(),
    headers,
    text: await response.text(),
  });
}

async function fetchInPage(page, request) {
  const payload = await page.evaluate(async input => {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      credentials: 'include',
    });
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      status: response.status,
      headers,
      text: await response.text(),
    };
  }, request);
  return toDirectResponse(payload);
}

export function createBrowserSolver({
  chromiumApi = chromium,
  getConfig = solverConfig,
  findExecutable = findChrome,
} = {}) {
  return async function solveWithBrowser({
    url,
    proxy = '',
    allowCdp = true,
    ua = CHROME_131_UA,
    requestContext,
  }) {
    const config = getConfig();
    const playwrightProxy = toPlaywrightProxy(proxy);
    const requestHeaders = requestContext ? browserRequestHeaders(requestContext) : {};
    let browser;
    if (config.browserWs && allowCdp && !playwrightProxy) {
      browser = await chromiumApi.connectOverCDP(config.browserWs);
    } else {
      const executablePath = findExecutable(config);
      if (!executablePath) {
        throw typedError(
          'browser_unavailable',
          'No usable browser found (configure CHROME_PATH or BROWSER_WS_ENDPOINT)',
        );
      }
      browser = await chromiumApi.launch({
        executablePath,
        headless: true,
        ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
        ],
      });
    }

    let context;
    let page;
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: ua,
        ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
        ...(requestContext ? { extraHTTPHeaders: requestHeaders } : {}),
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const requestCookies = requestContext ? browserRequestCookies(url, requestContext) : [];
      if (requestCookies.length) await context.addCookies(requestCookies);
      page = await context.newPage();
      let directResponse = null;
      const method = String(requestContext?.method || 'GET').toUpperCase();
      if (requestContext && method === 'GET') {
        directResponse = await navigationResponse(
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        );
      } else if (requestContext) {
        await page.goto(new URL(url).origin, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        const body = requestContext.body == null
          ? null
          : (typeof requestContext.body === 'string'
            ? requestContext.body
            : JSON.stringify(requestContext.body));
        directResponse = await fetchInPage(page, {
          url,
          method,
          headers: requestHeaders,
          body,
        });
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
      if (directResponse && !directResponseIsChallenge(directResponse)) {
        return { directResponse, via: 'browser' };
      }
      if (directResponse && directResponseIsChallenge(directResponse) && method !== 'GET') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      let cookieHeader = '';
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const cookies = await context.cookies(new URL(url).origin);
        const clearance = cookies.find(cookie => (
          cookie.name === 'cf_clearance' && String(cookie.value || '').trim()
        ));
        if (clearance) {
          cookieHeader = `cf_clearance=${clearance.value}`;
          break;
        }
        await page.waitForTimeout(1000);
      }
      const browserUa = await page.evaluate(() => navigator.userAgent).catch(() => '');
      if (!isChrome131Ua(browserUa)) cookieHeader = '';
      if (cookieHeader && requestContext) {
        const body = requestContext.body == null
          ? null
          : (typeof requestContext.body === 'string'
            ? requestContext.body
            : JSON.stringify(requestContext.body));
        const retried = method === 'GET'
          ? await navigationResponse(
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
          )
          : await fetchInPage(page, {
            url,
            method,
            headers: requestHeaders,
            body,
          });
        if (retried && !directResponseIsChallenge(retried)) {
          return { directResponse: retried, via: 'browser' };
        }
      }
      return {
        cookieHeader,
        ua: isChrome131Ua(browserUa) ? browserUa : '',
        cleared: Boolean(cookieHeader),
        via: 'browser',
      };
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
}

export function createCapSolver({
  fetchFn = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep,
  now = Date.now,
  requestTimeoutMs = DEFAULT_CAPSOLVER_REQUEST_TIMEOUT,
  overallTimeoutMs = DEFAULT_CAPSOLVER_OVERALL_TIMEOUT,
} = {}) {
  const wait = sleep || ((delay, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimer(timer);
      reject(signal.reason);
    };
    timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  }));

  return async function solveWithCapSolver({ url, html, ua, proxy, apiKey }) {
    if (!apiKey) throw typedError('capsolver_missing_api_key', 'CapSolver API key is missing');
    if (!proxy) throw typedError('capsolver_missing_proxy', 'CapSolver requires the task proxy');
    if (!html) throw typedError('capsolver_missing_challenge_html', 'CapSolver challenge HTML is missing');

    const startedAt = now();
    const overallController = new AbortController();
    const overallTimeout = typedError('capsolver_timeout', 'CapSolver overall timeout exceeded');
    const overallTimer = setTimer(() => overallController.abort(overallTimeout), overallTimeoutMs);

    const ensureBudget = () => {
      if (overallController.signal.aborted) {
        throw overallController.signal.reason || overallTimeout;
      }
      if (now() - startedAt >= overallTimeoutMs) {
        overallController.abort(overallTimeout);
        throw overallTimeout;
      }
    };

    const api = async (action, body) => {
      ensureBudget();
      const requestController = new AbortController();
      const requestTimeout = typedError(
        'capsolver_timeout',
        `CapSolver ${action} request timed out`,
      );
      const forwardOverallAbort = () => {
        requestController.abort(overallController.signal.reason || overallTimeout);
      };
      overallController.signal.addEventListener('abort', forwardOverallAbort, { once: true });
      const requestTimer = setTimer(
        () => requestController.abort(requestTimeout),
        requestTimeoutMs,
      );
      try {
        const response = await fetchFn(`https://api.capsolver.com/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, ...body }),
          signal: requestController.signal,
        });
        let result;
        try {
          result = await response.json();
        } catch (cause) {
          throw typedError('capsolver_invalid_response', 'CapSolver returned invalid JSON', cause);
        }
        if (result?.errorId || result?.errorCode) {
          throw typedError(
            result.errorCode || 'capsolver_provider_error',
            result.errorDescription || result.errorCode || 'CapSolver provider error',
          );
        }
        if (!response.ok) {
          throw typedError(
            'capsolver_http_error',
            `CapSolver ${action} returned HTTP ${response.status || 'error'}`,
          );
        }
        return result;
      } catch (cause) {
        if (cause?.code) throw cause;
        if (requestController.signal.aborted) {
          throw requestController.signal.reason || requestTimeout;
        }
        throw typedError(
          'capsolver_request_failed',
          `CapSolver ${action} request failed`,
          cause,
        );
      } finally {
        clearTimer(requestTimer);
        overallController.signal.removeEventListener('abort', forwardOverallAbort);
      }
    };

    try {
      const task = await api('createTask', {
        task: {
          type: 'AntiCloudflareTask',
          websiteURL: url,
          html,
          userAgent: CHROME_131_UA,
          proxy,
        },
      });
      if (!task.taskId) {
        throw typedError('capsolver_missing_task_id', 'CapSolver did not return a task ID');
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        ensureBudget();
        await wait(3000, overallController.signal);
        ensureBudget();
        const result = await api('getTaskResult', { taskId: task.taskId });
        if (result.status !== 'ready') continue;
        const cookies = result.solution?.cookies || {};
        const cookieHeader = Array.isArray(cookies)
          ? cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
          : Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
        const clearance = clearanceCookie(cookieHeader);
        if (!clearance) {
          throw typedError('capsolver_no_clearance', 'CapSolver returned no cf_clearance cookie');
        }
        return {
          cookieHeader: clearance,
          ua: CHROME_131_UA,
          cleared: true,
          via: 'capsolver',
        };
      }
      throw typedError('capsolver_timeout', 'CapSolver did not finish before the polling limit');
    } finally {
      clearTimer(overallTimer);
    }
  };
}

const browserSolve = createBrowserSolver();
const capsolverSolve = createCapSolver();

function coordinatorKey(url, proxy, fingerprint) {
  return `${new URL(url).origin}|${proxy}|${fingerprint}`;
}

export function createChallengeCoordinator({
  ttl = DEFAULT_TTL,
  maxEntries = DEFAULT_MAX_CACHE_ENTRIES,
  now = Date.now,
  browser = browserSolve,
  capsolver = capsolverSolve,
  getConfig = solverConfig,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const generations = new Map();
  const activeCounts = new Map();
  const cacheLimit = Math.max(1, Number(maxEntries) || DEFAULT_MAX_CACHE_ENTRIES);

  const prune = (currentTime = now()) => {
    for (const [key, entry] of cache) {
      if (currentTime - entry.ts >= ttl) cache.delete(key);
    }
    if (cache.size > cacheLimit) {
      const oldest = [...cache.entries()]
        .sort((left, right) => left[1].ts - right[1].ts)
        .slice(0, cache.size - cacheLimit);
      for (const [key] of oldest) cache.delete(key);
    }
  };

  const normalizeInput = (url, proxy = '', imp = '') => {
    const effectiveProxy = String(proxy || '').trim();
    // 破盾/打码统一用浏览器本体的 chrome131 身份（与容器 Chromium 版本一致）
    const fingerprint = String(imp || '').trim() || FALLBACK_IMPERSONATION;
    return {
      url,
      proxy: effectiveProxy,
      imp: fingerprint,
      key: coordinatorKey(url, effectiveProxy, fingerprint),
    };
  };

  async function perform(input, html, requestContext) {
    let browserError;
    let browserResult;
    try {
      browserResult = await browser({
        ...input,
        html,
        ua: CHROME_131_UA,
        allowCdp: !input.proxy,
        ...(requestContext ? { requestContext } : {}),
      });
    } catch (error) {
      browserError = error;
    }
    if (browserResult?.directResponse) {
      return { directResponse: browserResult.directResponse, via: 'browser' };
    }
    const local = usableSolution(browserResult);
    if (local) return local;

    let capsolverError;
    let capsolverResult;
    try {
      capsolverResult = await capsolver({
        url: input.url,
        proxy: input.proxy,
        html,
        ua: CHROME_131_UA,
        imp: FALLBACK_IMPERSONATION,
        apiKey: getConfig().apiKey,
      });
    } catch (error) {
      capsolverError = error;
    }
    const remote = usableSolution(capsolverResult);
    if (remote) return remote;

    throw challengeFailure(
      capsolverError
      || browserError
      || typedError('solver_no_clearance', 'No solver returned a usable cf_clearance cookie'),
    );
  }

  async function solve(url, proxy = '', html = '', imp = '', requestContext) {
    const input = normalizeInput(url, proxy, imp);
    if (requestContext) {
      return perform(input, html, requestContext);
    }
    const currentTime = now();
    prune(currentTime);
    const hit = cache.get(input.key);
    if (hit && currentTime - hit.ts < ttl) return hit.solution;
    if (hit) cache.delete(input.key);

    const pending = inFlight.get(input.key);
    if (pending) return pending;

    const generation = generations.get(input.key) || 0;
    activeCounts.set(input.key, (activeCounts.get(input.key) || 0) + 1);
    const operation = perform(input, html)
      .then(solution => {
        if ((generations.get(input.key) || 0) === generation) {
          cache.set(input.key, { solution, ts: now() });
          prune(now());
        }
        return solution;
      })
      .finally(() => {
        if (inFlight.get(input.key) === operation) {
          inFlight.delete(input.key);
        }
        const remaining = (activeCounts.get(input.key) || 1) - 1;
        if (remaining > 0) {
          activeCounts.set(input.key, remaining);
        } else {
          activeCounts.delete(input.key);
          generations.delete(input.key);
        }
      });
    inFlight.set(input.key, operation);
    return operation;
  }

  function clear(url, proxy = '', imp = '') {
    const input = normalizeInput(url, proxy, imp);
    const hasActiveSolve = (activeCounts.get(input.key) || 0) > 0;
    cache.delete(input.key);
    inFlight.delete(input.key);
    if (hasActiveSolve) {
      generations.set(input.key, (generations.get(input.key) || 0) + 1);
    } else {
      generations.delete(input.key);
    }
  }

  function inspect() {
    prune();
    return {
      cacheSize: cache.size,
      inFlightSize: inFlight.size,
      generationSize: generations.size,
    };
  }

  return { solve, clear, inspect };
}

const productionCoordinator = createChallengeCoordinator();

export function solveChallenge(url, proxy = '', html = '', imp = '', requestContext) {
  const network = normalizeNetworkContext({ proxy, imp });
  return productionCoordinator.solve(url, network.proxy, html, network.imp, requestContext);
}

export function clearSolveCache(url, proxy = '', imp = '') {
  const network = normalizeNetworkContext({ proxy, imp });
  productionCoordinator.clear(url, network.proxy, network.imp);
}
