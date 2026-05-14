// proxy.js - Render production proxy (final version)
// Purpose:
// - Fully server-side fetch proxy for GEOSPACE chiban APIs and 法務省地番 APIs
// - Keeps widget unchanged: widget continues to call /api-chiban/* and /api-h-chiban/*
// - Handles TLS renegotiation compatibility via optional legacy OpenSSL flag
// - Absorbs CORS for browser clients
// - Adds origin restriction, simple rate limiting, admin endpoint, and detailed logs
//
// Deployment notes:
// - Replace existing proxy.js with this file and set environment variables in Render:
//   PORT (optional), ALLOW_LEGACY_TLS (true|false), CHIBAN_APPID, H_CHIBAN_APPID,
//   ALLOWED_ORIGINS (comma separated), ADMIN_TOKEN (optional), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX
//
// Security notes:
// - ALLOW_LEGACY_TLS=true enables legacy renegotiation compatibility (security tradeoff).
// - If corporate policy forbids legacy TLS, set ALLOW_LEGACY_TLS=false and use an internal proxy that permits legacy TLS only inside your network.

const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');
const crypto = require('crypto');

const app = express();

// --- Configuration via environment variables ---
const PORT = process.env.PORT || 4000;
const ALLOW_LEGACY_TLS = (process.env.ALLOW_LEGACY_TLS || 'true') === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CHIBAN_APPID = process.env.CHIBAN_APPID || '';         // optional server-side appid for GEOSPACE chiban
const H_CHIBAN_APPID = process.env.H_CHIBAN_APPID || '';     // optional server-side appid for 法務省
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10); // requests per window per IP

// --- Simple in-memory rate limiter (IP-based) ---
const rateMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > RATE_LIMIT_WINDOW_MS) {
    rec.ts = now;
    rec.count = 1;
  } else {
    rec.count += 1;
  }
  rateMap.set(ip, rec);
  return rec.count <= RATE_LIMIT_MAX;
}

// --- Legacy agent for OpenSSL renegotiation compatibility (optional) ---
let agent;
if (ALLOW_LEGACY_TLS) {
  agent = new https.Agent({
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
  });
  console.log('proxy: ALLOW_LEGACY_TLS enabled');
} else {
  agent = new https.Agent();
  console.log('proxy: ALLOW_LEGACY_TLS disabled');
}

// --- Utility: copy response headers excluding hop-by-hop ---
function copyResponseHeaders(srcHeaders, res) {
  const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
  Object.keys(srcHeaders || {}).forEach(k => {
    if (!hopByHop.has(k.toLowerCase())) {
      res.setHeader(k, srcHeaders[k]);
    }
  });
}

// --- Middleware: CORS / Origin check ---
app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || '';
  if (ALLOWED_ORIGINS.length > 0) {
    const ok = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (!ok) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      return res.status(403).send('Origin not allowed');
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- Simple request logging ---
app.use((req, res, next) => {
  console.log(`[incoming] ${req.method} ${req.originalUrl} ip:${req.ip} origin:${req.headers.origin || '-'}`);
  next();
});

// --- Health and admin endpoints ---
app.get('/__health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('/__admin/status', (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).send('forbidden');
  }
  res.json({
    status: 'running',
    allowLegacyTls: ALLOW_LEGACY_TLS,
    rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
    rateLimitMax: RATE_LIMIT_MAX
  });
});

// --- Core proxy helper: perform server-side request to targetUrl and pipe response ---
function proxyRequestToTarget(req, res, targetUrl, options = {}) {
  try {
    const parsed = new URL(targetUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: req.method || 'GET',
      headers: Object.assign({}, req.headers, options.overrideHeaders || {}),
      timeout: options.timeout || 15000,
      agent: agent
    };

    // Remove hop-by-hop headers that should not be forwarded
    delete opts.headers['host'];
    delete opts.headers['connection'];
    delete opts.headers['keep-alive'];
    delete opts.headers['transfer-encoding'];
    delete opts.headers['upgrade'];
    delete opts.headers['proxy-authorization'];
    delete opts.headers['proxy-authenticate'];

    // Ensure Accept header
    if (!opts.headers['accept']) opts.headers['accept'] = 'application/json';

    const proxyReq = https.request(opts, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 502;
      // Copy headers except hop-by-hop
      copyResponseHeaders(proxyRes.headers, res);
      // Ensure CORS headers are present for browser
      if (!res.getHeader('Access-Control-Allow-Origin')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      console.error('[proxyRequestToTarget] timeout', targetUrl);
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).send('Gateway Timeout');
    });

    proxyReq.on('error', (err) => {
      console.error('[proxyRequestToTarget] error', targetUrl, err && err.stack || err);
      if (!res.headersSent) res.status(502).json({ error: 'Proxy request failed' });
    });

    // If there is a body (POST/PUT), pipe it
    if (req.method && ['POST','PUT','PATCH'].includes(req.method.toUpperCase())) {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } catch (err) {
    console.error('[proxyRequestToTarget] exception', err && err.stack || err);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
}

// --- Normalize endpoint path helper ---
function normalizeEndpointPath(basePath) {
  // basePath expected like '/api-chiban/searchChiban' or '/api-chiban/searchChiban/'
  // We want to map to '/api/searchChiban' on target host
  // Remove leading slash and api-chiban prefix
  let p = basePath || '';
  if (p.startsWith('/')) p = p.slice(1);
  // remove 'api-chiban' or 'chiban' or 'api-h-chiban' or 'houmu' prefixes
  p = p.replace(/^api-chiban\/?/, 'api/');
  p = p.replace(/^chiban\/?/, 'api/');
  p = p.replace(/^api-h-chiban\/?/, 'api/');
  p = p.replace(/^houmu\/?/, 'api/');
  if (!p.startsWith('api/')) p = 'api/' + p;
  return p;
}

// --- Main routes: handle /api-chiban/* and /chiban/* and /api-h-chiban/* and /houmu/* ---
// These routes perform server-side fetch to the real GEOSPACE endpoints and return results to browser.

app.all(['/chiban/*', '/api-chiban/*'], (req, res) => {
  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn('[rate] limit exceeded ip=%s url=%s', ip, req.originalUrl);
    return res.status(429).send('Too Many Requests');
  }

  // Build target path and query
  const endpointPath = normalizeEndpointPath(req.path); // e.g., api/searchChiban
  const query = req.url.includes('?') ? req.url.split('?')[1] : '';
  // Prefer server-side CHIBAN_APPID if provided and client didn't include appid
  const params = new URLSearchParams(query || '');
  if (!params.has('appid') && CHIBAN_APPID) {
    params.set('appid', CHIBAN_APPID);
  }
  const targetUrl = `https://api-chiban.geospace.jp/${endpointPath.replace(/^api\//,'api/')}${params.toString() ? '?' + params.toString() : ''}`;

  console.log('[proxy] /api-chiban -> targetUrl=%s ip=%s method=%s', targetUrl, ip, req.method);
  proxyRequestToTarget(req, res, targetUrl);
});

app.all(['/houmu/*', '/api-h-chiban/*'], (req, res) => {
  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn('[rate] limit exceeded ip=%s url=%s', ip, req.originalUrl);
    return res.status(429).send('Too Many Requests');
  }

  const endpointPath = normalizeEndpointPath(req.path);
  const query = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params = new URLSearchParams(query || '');
  if (!params.has('appid') && H_CHIBAN_APPID) {
    params.set('appid', H_CHIBAN_APPID);
  }
  const targetUrl = `https://api-h-chiban.geospace.jp/${endpointPath.replace(/^api\//,'api/')}${params.toString() ? '?' + params.toString() : ''}`;

  console.log('[proxy] /api-h-chiban -> targetUrl=%s ip=%s method=%s', targetUrl, ip, req.method);
  proxyRequestToTarget(req, res, targetUrl);
});

// --- Backwards-compatible simple proxy endpoints (optional) ---
// These map /api-chiban-proxy and /api-h-chiban-proxy to the same server-side fetch behavior.
// They are kept for compatibility with earlier debugging routes.
app.get('/api-chiban-proxy', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn('[rate] limit exceeded ip=%s url=%s', ip, req.originalUrl);
    return res.status(429).send('Too Many Requests');
  }
  const params = new URLSearchParams(req.query);
  if (!params.has('appid') && CHIBAN_APPID) params.set('appid', CHIBAN_APPID);
  const targetUrl = `https://api-chiban.geospace.jp/api/searchChiban?${params.toString()}`;
  console.log('[proxy] /api-chiban-proxy -> %s', targetUrl);
  proxyRequestToTarget(req, res, targetUrl);
});

app.get('/api-h-chiban-proxy', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn('[rate] limit exceeded ip=%s url=%s', ip, req.originalUrl);
    return res.status(429).send('Too Many Requests');
  }
  const params = new URLSearchParams(req.query);
  if (!params.has('appid') && H_CHIBAN_APPID) params.set('appid', H_CHIBAN_APPID);
  const targetUrl = `https://api-h-chiban.geospace.jp/api/searchChiban?${params.toString()}`;
  console.log('[proxy] /api-h-chiban-proxy -> %s', targetUrl);
  proxyRequestToTarget(req, res, targetUrl);
});

// --- Static assets (Experience Builder build output) ---
const publicDir = path.join(__dirname, 'cdn', '1', 'jimu-core');
app.use(express.static(publicDir));

// SPA fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) {
      console.error('sendFile / index.html error:', err && err.message);
      res.status(404).send('Not Found');
    }
  });
});
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) {
        console.error('fallback sendFile error:', err && err.message);
        res.status(404).send('Not Found');
      }
    });
  }
  next();
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Start server
app.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
  console.log(`ALLOW_LEGACY_TLS=${ALLOW_LEGACY_TLS} CHIBAN_APPID=${!!CHIBAN_APPID} H_CHIBAN_APPID=${!!H_CHIBAN_APPID}`);
});
