// proxy.js - Render 用プロキシ（恒久運用向け）
// - GEOSPACE API 互換性を維持（必要時に legacy TLS を有効化）
// - 本番向けの安全対策を組み込み：APIキー保護、オリジン制限、簡易レート制限、詳細ログ
// - ファイルを丸ごと置き換えてください

const express = require('express');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const app = express();

// --- 設定（環境変数で制御） ---
// 必須: CHIBAN_APPID または CHIBAN_API_KEY を Render の環境変数に設定してください。
// ALLOW_LEGACY_TLS=true にすると legacy OpenSSL オプションを有効化します（セキュリティ注意）。
const PORT = process.env.PORT || 4000;
const ALLOW_LEGACY_TLS = (process.env.ALLOW_LEGACY_TLS || 'true') === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // 空なら全許可（開発）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 管理用トークン（任意だが推奨）
const CHIBAN_APPID = process.env.CHIBAN_APPID || ''; // 可能ならサーバ側で保持して使う
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1分
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10); // 1分あたりの最大リクエスト数（調整可）

// --- 簡易レートリミッタ（IPベース、メモリ） ---
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

// --- legacyAgent（必要時のみ） ---
let legacyAgent = undefined;
if (ALLOW_LEGACY_TLS) {
  legacyAgent = new https.Agent({
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
  });
  console.log('proxy: ALLOW_LEGACY_TLS enabled (legacy OpenSSL options active)');
} else {
  legacyAgent = new https.Agent();
  console.log('proxy: ALLOW_LEGACY_TLS disabled (default secure agent)');
}

// --- ミドルウェア: CORS / Origin チェック ---
app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || '';
  if (ALLOWED_ORIGINS.length > 0) {
    const ok = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (!ok) {
      // ブラウザからの直接アクセスは拒否（API はサーバ経由を想定）
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

// --- リクエストログ（簡潔） ---
app.use((req, res, next) => {
  console.log(`[incoming] ${req.method} ${req.originalUrl} ip:${req.ip} origin:${req.headers.origin || '-'}`);
  next();
});

// --- ヘルスチェック / 管理用（管理トークンがあれば利用） ---
app.get('/__health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('/__admin/status', (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).send('forbidden');
  }
  res.json({ status: 'running', allowLegacyTls: ALLOW_LEGACY_TLS });
});

// -----------------------------
// メイン：サーバ側フェッチ経路（安全に GEOSPACE API に合わせる）
// エンドポイント: /api-chiban-proxy
// クライアントはこのエンドポイントを呼ぶ（クエリは URLSearchParams で組み立てること）
// -----------------------------
app.get('/api-chiban-proxy', (req, res) => {
  // レート制限
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn('[rate] limit exceeded ip=%s', ip);
    return res.status(429).send('Too Many Requests');
  }

  // 必要ならサーバ側で appid を付与（クライアントに appid を持たせたくない場合）
  const params = new URLSearchParams(req.query);
  if (!params.has('appid') && CHIBAN_APPID) {
    params.set('appid', CHIBAN_APPID);
  }

  // 組み立て
  const target = `https://api-chiban.geospace.jp/api/searchChiban?${params.toString()}`;
  console.log('[fallback] proxying to target=%s ip=%s', target, ip);

  const parsed = new URL(target);
  const opts = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    port: 443,
    timeout: 15000,
    headers: {
      'User-Agent': 'render-fallback-proxy/1.0',
      'Accept': 'application/json',
      // 参照元を明示（必要なら）
      'Referer': 'https://exb-chibanapiwidget-demo-ver1.onrender.com/'
    },
    agent: legacyAgent
  };

  const req2 = https.request(opts, (r) => {
    // ステータスとヘッダを透過（ホップバイホップは除外）
    res.statusCode = r.statusCode || 502;
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
    // エラー詳細はログに残すが、クライアントには簡潔に返す
    res.status(502).json({ error: 'Proxy request failed' });
  });

  req2.end();
});

// -----------------------------
// 旧ルート互換（必要なら残すが、推奨は /api-chiban-proxy を使う）
// -----------------------------
app.get('/api-chiban/*', (req, res) => {
  // 互換的に /api-chiban/... を /api/... に書き換えて直接転送する簡易実装
  // ただし本番では /api-chiban-proxy を使うことを推奨
  const original = req.originalUrl || req.url || '';
  const rewritten = original.replace(/^\/api-chiban/, '/api');
  const target = `https://api-chiban.geospace.jp${rewritten}`;
  console.log('[compat] forwarding to target=%s', target);

  const parsed = new URL(target);
  const opts = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    port: 443,
    timeout: 15000,
    headers: {
      'User-Agent': 'render-compat-proxy/1.0',
      'Accept': 'application/json',
      'Referer': 'https://exb-chibanapiwidget-demo-ver1.onrender.com/'
    },
    agent: legacyAgent
  };

  const req2 = https.request(opts, (r) => {
    res.statusCode = r.statusCode || 502;
    Object.keys(r.headers || {}).forEach((k) => {
      if (!['connection','keep-alive','transfer-encoding','upgrade','proxy-authenticate','proxy-authorization','te'].includes(k.toLowerCase())) {
        res.setHeader(k, r.headers[k]);
      }
    });
    r.pipe(res);
  });

  req2.on('timeout', () => {
    console.error('[compat] request timeout to target');
    req2.destroy();
    res.status(504).send('compat proxy timeout');
  });

  req2.on('error', (err) => {
    console.error('[compat] request error', err && err.stack || err);
    res.status(502).json({ error: 'Compat proxy failed' });
  });

  req2.end();
});

// 静的配信（ビルド成果物）
const publicDir = path.join(__dirname, 'cdn', '1', 'jimu-core');
app.use(express.static(publicDir));

// SPA フォールバック
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

// 404
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// 起動
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
