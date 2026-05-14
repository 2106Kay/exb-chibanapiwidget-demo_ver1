// proxy.js - Render 用プロキシ（Express + http-proxy-middleware）
// - 静的ファイルは cdn/1/jimu-core を配信
// - /api-chiban と /api-h-chiban をそれぞれ外部 API にプロキシ
// - 起動ログとリクエストログを出力
// - デバッグ用にターゲットへ送る path/headers をログ出力し、Referer/X-Requested-With を付与

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
function createChibanProxy(pathPrefix, targetBase, rewriteFromRegex) {
  return createProxyMiddleware(pathPrefix, {
    target: targetBase,
    changeOrigin: true,    // 通常はターゲットの Host に合わせる
    secure: true,
    logLevel: 'info',
    // pathRewrite: /api-chiban/... -> /api/...
    pathRewrite: (path, req) => {
      try {
        return path.replace(rewriteFromRegex, '/api');
      } catch (e) {
        console.error('pathRewrite error', e && e.message);
        return path;
      }
    },
    onProxyReq: (proxyReq, req, res) => {
      // デバッグログ：ターゲットに送るメソッド・パス・ヘッダを出力
      try {
        console.log('[proxy->target] method=%s path=%s headers=%j', proxyReq.method, proxyReq.path, proxyReq.getHeaders());
        console.log('[proxy->target] original req.url=%s', req.url);
      } catch (e) {
        console.error('[proxy->target] log error', e && e.message);
      }

      // Cloudflare 等のフロントで Host を偽装すると拒否されることがあるため Host は上書きしない
      // 代わりに Referer と X-Requested-With を付与してブラウザ由来のリクエストであることを示す
      try {
        proxyReq.setHeader('Referer', 'https://exb-chibanapiwidget-demo-ver1.onrender.com/');
        proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
      } catch (e) {
        console.error('setHeader error', e && e.message);
      }

      // 必要ならここで追加ヘッダを環境変数から付与（例）
      // if (process.env.CHIBAN_API_KEY) {
      //   proxyReq.setHeader('X-API-Key', process.env.CHIBAN_API_KEY);
      // }
    },
    onProxyRes: (proxyRes, req, res) => {
      // CORS を通す（レスポンスヘッダに追加）
      try {
        proxyRes.headers['access-control-allow-origin'] = '*';
      } catch (e) {
        console.error('onProxyRes error', e && e.message);
      }
    },
    onError: (err, req, res) => {
      console.error('[proxy] error', err && err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy error');
    },
    // クエリやヘッダの大文字小文字を保持する設定（必要に応じて）
    preserveHeaderKeyCase: true,
  });
}

// Proxy ルール（/api-chiban -> https://api-chiban.geospace.jp/api/...）
app.use(createChibanProxy('/api-chiban', 'https://api-chiban.geospace.jp', /^\/api-chiban/));

// もし別の API をプロキシするなら同様に追加（例: /api-h-chiban）
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
