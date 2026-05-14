// proxy.js - Render 用プロキシ（Express + http-proxy-middleware）
// デバッグ強化版：onError でスタックを出力、proxyTimeout を設定、proxyReqPathResolver ログ強化、
// Render 実行環境からターゲットへ直接叩く /__probe_target を追加（デバッグ用）

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const https = require('https');
const url = require('url');

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

// 共通プロキシ生成（proxyReqPathResolver を使う）
function createChibanProxy(pathPrefix, targetBase, rewriteFromRegex) {
  return createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    secure: true,
    logLevel: 'debug',            // 詳細ログ
    proxyTimeout: 15000,          // ターゲット応答待ちタイムアウト（ms）
    timeout: 20000,               // クライアント接続タイムアウト（ms）

    // proxyReqPathResolver でパス＋クエリを明示的に組み立ててログ出力
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

      // Host は上書きしない（Cloudflare の拒否を避ける）
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
      // ここで詳細なエラー情報を出力する（必ずログに残す）
      console.error('[proxy] onError message=%s', err && err.message);
      console.error('[proxy] onError stack=%s', err && err.stack);
      // 可能ならターゲットのホスト名をログに出す
      try {
        const targetHost = new URL(targetBase).host;
        console.error('[proxy] targetHost=%s', targetHost);
      } catch (e) {
        // ignore
      }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy error');
    },

    preserveHeaderKeyCase: true,
  });
}

// --- ここで必ず「1回だけ」ルートをマウントすること ---
app.use('/api-chiban', createChibanProxy('/api-chiban', 'https://api-chiban.geospace.jp', /^\/api-chiban/));
app.use('/api-h-chiban', createChibanProxy('/api-h-chiban', 'https://api-h-chiban.moj.go.jp', /^\/api-h-chiban/));

// デバッグ用プローブ：Render 実行環境からターゲットへ直接接続できるか確認するエンドポイント
// 注意：デバッグ用。確認後は削除してください。
app.get('/__probe_target', (req, res) => {
  const target = 'https://api-chiban.geospace.jp/api/searchChiban?appid=ArcGIS_Pro_chiban_add-in&string=' + encodeURIComponent('東京都台東区雷門1-4') + '&limit=1';
  console.log('[probe] requesting target=%s', target);

  const parsed = new URL(target);
  const opts = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    port: 443,
    timeout: 10000,
    headers: {
      'User-Agent': 'render-probe/1.0',
      'Accept': 'application/json'
    }
  };

  const req2 = https.request(opts, (r) => {
    let body = '';
    r.on('data', (chunk) => body += chunk);
    r.on('end', () => {
      console.log('[probe] status=%s headers=%j', r.statusCode, r.headers && {
        'content-type': r.headers['content-type'],
        'content-length': r.headers['content-length']
      });
      res.status(200).json({ probeStatus: r.statusCode, probeHeaders: r.headers, probeBodySample: body.slice(0, 1000) });
    });
  });

  req2.on('timeout', () => {
    console.error('[probe] request timeout');
    req2.destroy();
    res.status(504).send('probe timeout');
  });

  req2.on('error', (err) => {
    console.error('[probe] request error', err && err.stack || err);
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

// GET の HTML リクエストはすべて index.html にフォールバック（SPA）
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

// 404 ハンドラ（API など）
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ポートは Render の環境変数を使う
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server running on port ${port}`));
