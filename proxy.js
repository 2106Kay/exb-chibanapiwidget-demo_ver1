// proxy.js - http-proxy-middleware ベースの Render 用プロキシ
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();

// CORS を許可（ブラウザからの fetch を通す）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 静的配信
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// 共通ログミドルウェア
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
      // '^/api-chiban' -> '/api'
      return path.replace(rewriteFrom, '/api');
    },
    onProxyReq: (proxyReq, req, res) => {
      // 必要ならここで追加ヘッダを付与
      // 例: proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
      // 例: proxyReq.setHeader('User-Agent', 'exb-proxy/1.0');
      // もし API 側が Referer をチェックするなら referer を設定することも可能
      // proxyReq.setHeader('Referer', 'https://exb-render.onrender.com/');
    },
    onProxyRes: (proxyRes, req, res) => {
      // ターゲットからのレスポンスヘッダをそのままクライアントに渡すが、
      // 必要に応じて CORS ヘッダを付与しておく
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

// /api-chiban -> https://api-chiban.geospace.jp (path /api/...)
app.use(createChibanProxy('/api-chiban', 'https://api-chiban.geospace.jp', /^\/api-chiban/));

// /api-h-chiban -> https://api-h-chiban.moj.go.jp (path /api/...)
app.use(createChibanProxy('/api-h-chiban', 'https://api-h-chiban.moj.go.jp', /^\/api-h-chiban/));

// ルートは public/index.html を返す
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ポートは Render の環境変数を使う
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server running on port ${port}`));
