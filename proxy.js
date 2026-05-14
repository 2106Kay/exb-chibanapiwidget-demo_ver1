// proxy.js - Render 用プロキシ（Express + http-proxy-middleware）
// - 静的ファイルは cdn/1/jimu-core を配信
// - /api-chiban と /api-h-chiban をそれぞれ外部 API にプロキシ
// - 起動ログとリクエストログを出力
// - proxyReqPathResolver で送信先パスを明示的に組み立て、詳細ログを出力

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();

// 起動時ログ
console.log('proxy.js loaded, NODE_ENV=' + (process.env.NODE_ENV || 'undefined'));

// CORS を許可（ブラウザからの fetch を通す）
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
    logLevel: 'info',

    // proxyReqPathResolver を使ってターゲットに送るパス（クエリ含む）を明示的に作る
    proxyReqPathResolver: function(req) {
      try {
        // req.originalUrl にはパス + クエリが入る（例: /api-chiban/searchChiban?appid=...）
        const original = req.originalUrl || req.url || '';
        // 先頭の /api-chiban を /api に置換（rewriteFromRegex は /^\/api-chiban/ を渡す想定）
        const rewritten = original.replace(rewriteFromRegex, '/api');
        console.log('[proxyReqPathResolver] original=%s rewritten=%s', original, rewritten);
        return rewritten;
      } catch (e) {
        console.error('[proxyReqPathResolver] error', e && e.message);
        return req.originalUrl || req.url || '/';
      }
    },

    // デバッグとヘッダ付与
    onProxyReq: (proxyReq, req, res) => {
      try {
        console.log('[onProxyReq] proxyReq.path=%s proxyReq.method=%s', proxyReq.path, proxyReq.method);
        console.log('[onProxyReq] proxyReq.getHeaders()=%j', proxyReq.getHeaders());
        console.log('[onProxyReq] original req.url=%s', req.originalUrl);
      } catch (e) {
        console.error('[onProxyReq] log error', e && e.message);
      }

      // Host は上書きしない（Cloudflare の拒否を避ける）
      // 参照元チェックがある場合に備えて Referer と X-Requested-With を付与
      try {
        proxyReq.setHeader('Referer', 'https://exb-chibanapiwidget-demo-ver1.onrender.com/');
        proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
      } catch (e) {
        console.error('[onProxyReq] setHeader error', e && e.message);
      }
    },

    onProxyRes: (proxyRes, req, res) => {
      try {
        // レスポンスヘッダに CORS を追加
        proxyRes.headers['access-control-allow-origin'] = '*';
        // ログ：ターゲットからのステータスと一部ヘッダ
        console.log('[onProxyRes] status=%s headers=%j', proxyRes.statusCode, {
          'content-type': proxyRes.headers['content-type'],
          'content-length': proxyRes.headers['content-length']
        });
      } catch (e) {
        console.error('[onProxyRes] error', e && e.message);
      }
    },

    onError: (err, req, res) => {
      console.error('[proxy] error', err && err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy error');
    },

    // 必要ならヘッダキーの大文字小文字を保持
    preserveHeaderKeyCase: true,
  });
}

// --- ここで必ず「1回だけ」ルートをマウントすること ---
// /api-chiban を /api に書き換えて https://api-chiban.geospace.jp に転送する
app.use('/api-chiban', createChibanProxy('/api-chiban', 'https://api-chiban.geospace.jp', /^\/api-chiban/));

// /api-h-chiban の例（必要なら有効化）
app.use('/api-h-chiban', createChibanProxy('/api-h-chiban', 'https://api-h-chiban.moj.go.jp', /^\/api-h-chiban/));

// 静的配信先（実際のビルド成果物がここにある想定）
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
