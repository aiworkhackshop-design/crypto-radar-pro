import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), 'public');
const CACHE_MS = 5 * 60 * 1000;

const state = {
  paperTradingEnabled: true,
  startingCash: 10000,
  cash: 10000,
  positions: [],
  trades: [],
  closedPnL: 0,
  consecutiveLosses: 0,
  pausedReason: null,
  lastMarket: [],
  lastUpdated: null,
  cacheUntil: 0
};

const CONFIG = {
  maxPositions: 3,
  positionSizePct: 0.12,
  takeProfitPct: 4,
  stopLossPct: -2,
  maxHoldHours: 6,
  minScoreToBuy: 72,
  maxConsecutiveLosses: 3
};

const PRODUCTS = [
  ['BTC-USD','BTC','Bitcoin',1,1280000000000],
  ['ETH-USD','ETH','Ethereum',2,378000000000],
  ['SOL-USD','SOL','Solana',5,66000000000],
  ['XRP-USD','XRP','XRP',7,35000000000],
  ['DOGE-USD','DOGE','Dogecoin',9,22000000000],
  ['ADA-USD','ADA','Cardano',10,16000000000],
  ['AVAX-USD','AVAX','Avalanche',11,15000000000],
  ['LINK-USD','LINK','Chainlink',14,9000000000],
  ['DOT-USD','DOT','Polkadot',15,9900000000],
  ['LTC-USD','LTC','Litecoin',20,7000000000],
  ['BCH-USD','BCH','Bitcoin Cash',21,8500000000],
  ['NEAR-USD','NEAR','NEAR Protocol',24,6500000000],
  ['UNI-USD','UNI','Uniswap',25,6000000000],
  ['APT-USD','APT','Aptos',27,5000000000],
  ['FIL-USD','FIL','Filecoin',35,4500000000],
  ['ETC-USD','ETC','Ethereum Classic',36,4200000000],
  ['ATOM-USD','ATOM','Cosmos Hub',38,4100000000]
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const pct = (a, b) => b ? ((a - b) / b) * 100 : 0;

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'crypto-radar-pro/2.0' }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function parseCandles(raw) {
  return raw
    .map((c) => ({
      time: c[0],
      low: safeNumber(c[1]),
      high: safeNumber(c[2]),
      open: safeNumber(c[3]),
      close: safeNumber(c[4]),
      volume: safeNumber(c[5])
    }))
    .sort((a, b) => a.time - b.time)
    .filter((c) => c.close > 0);
}

function computeBacktest(candles) {
  let wins = 0;
  let losses = 0;
  let trades = 0;
  let pnl = 0;
  for (let i = 12; i < candles.length - 6; i++) {
    const before = candles.slice(i - 12, i - 6);
    const recent = candles.slice(i - 6, i);
    const recentMove = pct(recent[recent.length - 1].close, recent[0].open);
    const volumeSpike = avg(recent.map((c) => c.volume)) / Math.max(avg(before.map((c) => c.volume)), 1);
    if (recentMove > 1.2 && recentMove < 8 && volumeSpike > 1.2) {
      const entry = candles[i].open;
      const exitWindow = candles.slice(i, i + 6);
      let result = pct(exitWindow[exitWindow.length - 1].close, entry);
      for (const c of exitWindow) {
        const highPct = pct(c.high, entry);
        const lowPct = pct(c.low, entry);
        if (lowPct <= -2) { result = -2; break; }
        if (highPct >= 4) { result = 4; break; }
      }
      trades += 1;
      pnl += result;
      if (result > 0) wins += 1; else losses += 1;
    }
  }
  return {
    trades,
    wins,
    losses,
    winRate: trades ? (wins / trades) * 100 : 0,
    expectancy: trades ? pnl / trades : 0
  };
}

function decide({ change24h, trend6h, trend24h, volumeSpike, backtest, volatility }) {
  const reasons = [];
  const warnings = [];
  let score = 0;

  if (change24h > 2 && change24h < 12) { score += 18; reasons.push('24h上昇が強すぎず弱すぎない'); }
  if (trend6h > 0.6) { score += 18; reasons.push('短期6時間トレンドが上向き'); }
  if (trend24h > 0) { score += 12; reasons.push('24時間トレンドがプラス圏'); }
  if (volumeSpike > 1.25) { score += 18; reasons.push('直近出来高が増加'); }
  if (backtest.trades >= 2 && backtest.winRate >= 50) { score += 16; reasons.push('簡易バックテストで勝率が一定以上'); }
  if (backtest.expectancy > 0) { score += 10; reasons.push('簡易期待値がプラス'); }
  if (Math.abs(change24h) < 1) { score -= 8; warnings.push('値動きが弱くチャンス不足'); }
  if (change24h > 15) { score -= 25; warnings.push('急騰しすぎで飛び乗り注意'); }
  if (change24h < -8) { score -= 25; warnings.push('下落中で反転確認待ち'); }
  if (volatility > 14) { score -= 12; warnings.push('ボラティリティが高く損切り幅に注意'); }
  if (volumeSpike < 0.8) { score -= 8; warnings.push('出来高が弱い'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let decision = 'AVOID';
  let action = '触らない。条件が揃うまで待つ。';
  if (score >= 75 && warnings.length <= 1) {
    decision = 'BUY_WATCH';
    action = '即買いではなく、押し目または直近高値更新を確認して監視。';
  } else if (score >= 52) {
    decision = 'WATCH';
    action = '監視。出来高継続と短期足の反転確認待ち。';
  }

  if (!reasons.length) reasons.push('買い根拠が不足');
  return { score, decision, action, reasons: reasons.slice(0, 4), warnings: warnings.slice(0, 4) };
}

async function fetchCoinbaseRadar() {
  const rows = [];
  const errors = [];
  for (const [product, symbol, name, rank, marketCap] of PRODUCTS) {
    try {
      const [stats, rawCandles] = await Promise.all([
        fetchJson(`https://api.exchange.coinbase.com/products/${product}/stats`),
        fetchJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600`)
      ]);
      const candles = parseCandles(rawCandles).slice(-72);
      if (candles.length < 24) throw new Error(`${product}: candles too short`);
      const price = safeNumber(stats.last, candles[candles.length - 1].close);
      const open24h = safeNumber(stats.open, candles[candles.length - 24]?.open || price);
      const change24h = pct(price, open24h);
      const recent6 = candles.slice(-6);
      const prev18 = candles.slice(-24, -6);
      const trend6h = pct(recent6[recent6.length - 1].close, recent6[0].open);
      const trend24h = pct(candles[candles.length - 1].close, candles[candles.length - 24].open);
      const volumeSpike = avg(recent6.map((c) => c.volume)) / Math.max(avg(prev18.map((c) => c.volume)), 1);
      const volumeUsd = safeNumber(stats.volume) * price;
      const highs = candles.slice(-24).map((c) => c.high);
      const lows = candles.slice(-24).map((c) => c.low);
      const volatility = pct(Math.max(...highs), Math.min(...lows));
      const backtest = computeBacktest(candles);
      const decision = decide({ change24h, trend6h, trend24h, volumeSpike, backtest, volatility });

      rows.push({
        id: symbol.toLowerCase(),
        product,
        symbol,
        name,
        rank,
        price,
        marketCap,
        volume: volumeUsd,
        change24h,
        trend6h,
        trend24h,
        volumeSpike,
        volatility,
        backtest,
        score: decision.score,
        decision: decision.decision,
        className: decision.decision,
        danger: decision.warnings[0] || '通常監視',
        action: decision.action,
        reasons: decision.reasons,
        warnings: decision.warnings,
        image: ''
      });
      await sleep(70);
    } catch (error) {
      errors.push(`${product}: ${error.message}`);
    }
  }
  if (!rows.length) throw new Error(errors.slice(0, 3).join(' / ') || 'Coinbase data unavailable');
  return { market: rows.sort((a, b) => b.score - a.score), errors };
}

async function fetchMarket() {
  if (state.lastMarket.length && Date.now() < state.cacheUntil) {
    return { market: state.lastMarket, source: 'cache', warning: null };
  }
  try {
    const result = await fetchCoinbaseRadar();
    state.lastMarket = result.market;
    state.cacheUntil = Date.now() + CACHE_MS;
    return {
      market: result.market,
      source: 'coinbase',
      warning: result.errors.length ? `一部銘柄取得失敗: ${result.errors.length}件` : null
    };
  } catch (error) {
    if (state.lastMarket.length) {
      return { market: state.lastMarket, source: 'cache', warning: `${error.message} / キャッシュ表示中` };
    }
    return { market: [], source: 'none', warning: `${error.message} / データ取得失敗` };
  }
}

function findPosition(symbol) { return state.positions.find((p) => p.symbol === symbol); }
function openPaperTrade(coin) {
  if (!state.paperTradingEnabled || state.pausedReason) return;
  if (state.positions.length >= CONFIG.maxPositions || findPosition(coin.symbol)) return;
  if (coin.score < CONFIG.minScoreToBuy || coin.decision !== 'BUY_WATCH') return;
  const spend = state.cash * CONFIG.positionSizePct;
  if (spend < 25 || coin.price <= 0) return;
  state.cash -= spend;
  state.positions.push({ id: `${coin.symbol}-${Date.now()}`, symbol: coin.symbol, name: coin.name, entryPrice: coin.price, qty: spend / coin.price, cost: spend, openedAt: new Date().toISOString(), scoreAtEntry: coin.score });
  state.trades.unshift({ type: 'BUY', symbol: coin.symbol, name: coin.name, price: coin.price, amountUsd: spend, pnlUsd: 0, pnlPct: 0, reason: `BUY_WATCH ${coin.score}: ${coin.reasons.join(' / ')}`, time: new Date().toISOString() });
}
function closePaperTrade(position, price, reason) {
  const value = position.qty * price;
  const pnlUsd = value - position.cost;
  const pnlPct = (price / position.entryPrice - 1) * 100;
  state.cash += value;
  state.closedPnL += pnlUsd;
  state.positions = state.positions.filter((p) => p.id !== position.id);
  state.consecutiveLosses = pnlUsd < 0 ? state.consecutiveLosses + 1 : 0;
  if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) { state.paperTradingEnabled = false; state.pausedReason = '3連敗で自動停止'; }
  state.trades.unshift({ type: 'SELL', symbol: position.symbol, name: position.name, price, amountUsd: value, pnlUsd, pnlPct, reason, time: new Date().toISOString() });
}
function updatePaperTrading(market) {
  const priceMap = new Map(market.map((c) => [c.symbol, c]));
  for (const position of [...state.positions]) {
    const coin = priceMap.get(position.symbol);
    if (!coin) continue;
    const pnlPct = pct(coin.price, position.entryPrice);
    const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3600000;
    if (pnlPct >= CONFIG.takeProfitPct) closePaperTrade(position, coin.price, `利確 +${CONFIG.takeProfitPct}%到達`);
    else if (pnlPct <= CONFIG.stopLossPct) closePaperTrade(position, coin.price, `損切り ${CONFIG.stopLossPct}%到達`);
    else if (holdHours >= CONFIG.maxHoldHours) closePaperTrade(position, coin.price, '最大保有時間を超過');
  }
  for (const coin of market) openPaperTrade(coin);
}
function portfolioSummary(market) {
  const priceMap = new Map(market.map((c) => [c.symbol, c]));
  const positions = state.positions.map((p) => {
    const coin = priceMap.get(p.symbol);
    const currentPrice = coin ? coin.price : p.entryPrice;
    const value = p.qty * currentPrice;
    const pnlUsd = value - p.cost;
    const pnlPct = pct(currentPrice, p.entryPrice);
    return { ...p, currentPrice, value, pnlUsd, pnlPct };
  });
  const openValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalEquity = state.cash + openValue;
  const sells = state.trades.filter((t) => t.type === 'SELL');
  const wins = sells.filter((t) => t.pnlUsd > 0).length;
  return { cash: state.cash, openValue, totalEquity, closedPnL: state.closedPnL, totalReturnPct: pct(totalEquity, state.startingCash), winRate: sells.length ? (wins / sells.length) * 100 : 0, closedTrades: sells.length, positions };
}
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  try {
    const data = await readFile(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'Crypto Radar Pro v2', mode: 'paper-trading', realTrading: false });
  if (req.method === 'GET' && url.pathname === '/api/news') return json(res, 200, { sources: [
    { name: 'Binance Announcements', url: 'https://www.binance.com/en/support/announcement' },
    { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog' },
    { name: 'OKX Announcements', url: 'https://www.okx.com/help/section/announcements' },
    { name: 'CoinGecko Trending', url: 'https://www.coingecko.com/en/discover' }
  ], note: '公式ニュースはリンク確認方式。次段階でRSS・通知を追加します。' });
  if (req.method === 'GET' && url.pathname === '/api/market') {
    const result = await fetchMarket();
    state.lastUpdated = new Date().toISOString();
    if (result.market.length) updatePaperTrading(result.market);
    const top = result.market.slice(0, 5);
    return json(res, 200, { updatedAt: state.lastUpdated, source: result.source, warning: result.warning, config: CONFIG, top, market: result.market, portfolio: portfolioSummary(result.market), trading: { paperTradingEnabled: state.paperTradingEnabled, pausedReason: state.pausedReason, consecutiveLosses: state.consecutiveLosses }, trades: state.trades.slice(0, 80) });
  }
  if (req.method === 'POST' && url.pathname === '/api/trading/reset') {
    state.paperTradingEnabled = true; state.cash = state.startingCash; state.positions = []; state.trades = []; state.closedPnL = 0; state.consecutiveLosses = 0; state.pausedReason = null; return json(res, 200, { ok: true });
  }
  if (req.method === 'GET') return serveStatic(req, res);
  return json(res, 405, { error: 'method_not_allowed' });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Crypto Radar Pro v2 running on port ${PORT}`));
