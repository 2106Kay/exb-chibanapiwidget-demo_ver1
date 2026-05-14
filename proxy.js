// proxy.js - Render 用プロキシ（Express + http-proxy-middleware）
// - 静的ファイルは cdn/1/jimu-core を配信
// - /api-chiban と /api-h-chiban をそれぞれ外部 API にプロキシ
// - 起動ログとリクエストログを出力
// - デバッグ用にターゲットへ送る path/headers をログ出力し、Host/Referer を明示的に設定

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

// Proxy 共通オプションファクトリ
function createChibanProxy(pathPrefix, targetBase, rewriteFrom) {
  return createProxyMiddleware(pathPrefix, {
    target: targetBase,
    changeOrigin: true,
    secure: true,
    logLevel: 'info',
    pathRewrite: (path, req) => {
      // デフォルトは /api-chiban/... -> /api/...
      // 必要に応じてここを調整してください
      return path.replace(rewriteFrom, '/api');
    },
    onProxyReq: (proxyReq, req, res) => {
      // デバッグログ：ターゲットに送るメソッド・パス・ヘッダを出力
      try {
        console.log('[proxy->target] method=%s path=%s headers=%j', proxyReq.method, proxyReq.path, proxyReq.getHeaders());
      } catch (e) {
        console.error('[proxy->target] log error', e && e.message);
      }

      // 明示的に Host と Referer を設定（proxy が変えてしまう場合に備える）
      proxyReq.setHeader('Host', new URL(targetBase).host);
      proxyReq.setHeader('Referer', 'https://exb-chibanapiwidget-demo-ver1.onrender.com/');
      proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');

      // もし API が追加ヘッダを要求するならここで設定（例）
      // proxyReq.setHeader('X-API-Key', process.env.CHIBAN_API_KEY || 'your_key_here');
    },
    onProxyRes: (proxyRes, req, res) => {
      // CORS を通す
      proxyRes.headers['access-control-allow-origin'] = '*';
    },
    onError: (err, req, res) => {
      console.error('[proxy] error', err && err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy error');
    }
  });
}

// Proxy ルール
app.use(createChibanProxy('/api-chiban', 'https://api-chiban.geospace.jp', /^\/api-chiban/));
app.use(createChibanProxy('/api-h-chiban', 'https://api-h-chiban.moj.go.jp', /^\/api-h-chiban/));

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
