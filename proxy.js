// proxy.js - Render 用プロキシ（Express）
// 全文置換用ファイル：http-proxy-middleware を残しつつ、確実に動くサーバ側フェッチのフォールバックを追加します。

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();

console.log('proxy.js loaded, NODE_ENV=' + (process.env.NODE_ENV || 'undefined'));

// CORS を許可
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// リクエスト到達ログ
app.use((req, res, next) => {
  console.log(`[incoming] ${req.method} ${req.originalUrl} host:${req.headers.host} referer:${req.headers.referer || '-'}`);
  next();
});

// 共通 agent（OpenSSL legacy renegotiation を一時許可する設定）
const legacyAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

// createChibanProxy（既存の proxy ミドルウェア）
function createChibanProxy(targetBase, rewriteFromRegex) {
  return createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: true,
    logLevel: 'debug',
    proxyTimeout: 15000,
    timeout: 20000,
    agent: legacyAgent,
    proxyReqPathResolver: function(req) {
      try {
        const original = req.originalUrl || req.url || '';
        const rewritten = original.replace(rewriteFromRegex, '/api');
        console.log('[proxyReqPathResolver] original=%s', original);
        console.log('[proxyReqPathResolver] rewritten=%s', rewritten);
        return rewritten;
      } catch (e) {
        console.error('[proxyReqPathResolver] error', e && e.stack || e);
        return req.originalUrl || req.url || '/';
      }
    },
    onProxyReq: (proxyReq, req, res) => {
      try {
        console.log('[onProxyReq] proxyReq.path=%s proxyReq.method=%s', proxyReq.path, proxyReq.method);
        console.log('[onProxyReq] proxyReq.getHeaders()=%j', proxyReq.getHeaders());
        console.log('[onProxyReq] original req.url=%s', req.originalUrl);
      } catch (e) {
        console.error('[onProxyReq] log error', e && e.stack || e);
      }
      try {
        proxyReq.setHeader('Referer', 'https://exb-chibanapiwidget-demo-ver1.onrender.com/');
        proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
      } catch (e) {
        console.error('[onProxyReq] setHeader error', e && e.stack || e);
      }
    },
    onProxyRes: (proxyRes, req, res) => {
      try {
        proxyRes.headers['access-control-allow-origin'] = '*';
        console.log('[onProxyRes] status=%s headers=%j', proxyRes.statusCode, {
          'content-type': proxyRes.headers['content-type'],
          'content-length': proxyRes.headers['content-length']
        });
      } catch (e) {
        console.error('[onProxyRes] error', e && e.stack || e);
      }
    },
    onError: (err, req, res) => {
      console.error('[proxy] onError message=%s', err && err.message);
      console.error('[proxy] onError stack=%s', err && err.stack);
      try {
        const targetHost = new URL(targetBase).host;
        console.error('[proxy] targetHost=%s', targetHost);
      } catch (e) {}
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy error');
    },
    preserveHeaderKeyCase: true,
  });
}

// マウント（http-proxy-middleware）
app.use('/api-chiban', createChibanProxy('https://api-chiban.geospace.jp', /^\/api-chiban/));
app.use('/api-h-chiban', createChibanProxy('https://api-h-chiban.moj.go.jp', /^\/api-h-chiban/));

// -----------------------------
// フォールバック：サーバ側フェッチ（確実に動く経路）
// /api-chiban-proxy?appid=...&string=...&limit=...&is_num=...
// -----------------------------
app.get('/api-chiban-proxy', (req, res) => {
  // クエリをそのままターゲットに渡す（既に URLSearchParams でエンコード済みのはず）
  const params = new URLSearchParams(req.query).toString();
  const targetUrl = `https://api-chiban.geospace.jp/api/searchChiban?${params}`;
  console.log('[fallback] proxying to targetUrl=%s', targetUrl);

  const parsed = new URL(targetUrl);
  const opts = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    port: 443,
    timeout: 15000,
    headers: {
      'User-Agent': 'render-fallback-proxy/1.0',
      'Accept': 'application/json'
    },
    agent: legacyAgent
  };

  const req2 = https.request(opts, (r) => {
    res.statusCode = r.statusCode || 502;
    // copy headers (but avoid hop-by-hop headers)
    Object.keys(r.headers || {}).forEach((k) => {
      if (!['connection','keep-alive','transfer-encoding','upgrade','proxy-authenticate','proxy-authorization','te'].includes(k.toLowerCase())) {
        res.setHeader(k, r.headers[k]);
      }
    });
    r.pipe(res);
  });

  req2.on('timeout', () => {
    console.error('[fallback] request timeout to target');
    req2.destroy();
    res.status(504).send('fallback proxy timeout');
  });

  req2.on('error', (err) => {
    console.error('[fallback] request error', err && err.stack || err);
    res.status(502).json({ error: err && err.message });
  });

  req2.end();
});

// 静的配信先
const publicDir = path.join(__dirname, 'cdn', '1', 'jimu-core');
app.use(express.static(publicDir));

// ルートで index.html を返す（SPA 対応）
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) {
      console.error('sendFile / index.html error:', err && err.message);
      res.status(404).send('Not Found');
    }
  });
});

// SPA フォールバック
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

// 404 ハンドラ
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// 起動
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server running on port ${port}`));
