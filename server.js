import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), 'public');

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
  lastUpdated: null
};

const CONFIG = {
  maxPositions: 3,
  positionSizePct: 0.15,
  takeProfitPct: 4,
  stopLossPct: -2,
  maxHoldHours: 6,
  minScoreToBuy: 70,
  minVolumeUsd: 50_000_000,
  minMarketCapUsd: 100_000_000,
  maxConsecutiveLosses: 3
};

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

function scoreCoin(coin) {
  const change = safeNumber(coin.price_change_percentage_24h);
  const volume = safeNumber(coin.total_volume);
  const marketCap = safeNumber(coin.market_cap);
  const rank = safeNumber(coin.market_cap_rank, 9999);
  let score = 0;
  if (change >= 3 && change <= 12) score += 35;
  else if (change > 12 && change <= 25) score += 18;
  else if (change >= 1 && change < 3) score += 12;
  else if (change < -8) score += 8;
  if (volume >= 1_000_000_000) score += 25;
  else if (volume >= 300_000_000) score += 20;
  else if (volume >= 50_000_000) score += 12;
  if (marketCap >= 10_000_000_000) score += 15;
  else if (marketCap >= 1_000_000_000) score += 12;
  else if (marketCap >= 100_000_000) score += 8;
  if (rank <= 25) score += 10;
  else if (rank <= 100) score += 7;
  else if (rank <= 300) score += 4;
  score -= getDangerPenalty(coin);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getDangerPenalty(coin) {
  const change = safeNumber(coin.price_change_percentage_24h);
  const volume = safeNumber(coin.total_volume);
  const marketCap = safeNumber(coin.market_cap);
  let penalty = 0;
  if (marketCap < 50_000_000 && Math.abs(change) > 20) penalty += 30;
  if (volume > marketCap * 0.9) penalty += 18;
  if (change > 25) penalty += 18;
  if (change < -15) penalty += 12;
  return penalty;
}

function dangerLabel(coin) {
  const change = safeNumber(coin.price_change_percentage_24h);
  const volume = safeNumber(coin.total_volume);
  const marketCap = safeNumber(coin.market_cap);
  if (marketCap < 50_000_000 && Math.abs(change) > 20) return '危険: 小型急騰';
  if (volume > marketCap * 0.9) return '注意: 出来高過熱';
  if (change > 25) return '注意: 急騰しすぎ';
  if (change < -15) return '注意: 急落中';
  return '通常監視';
}

function classify(score, danger) {
  if (danger.startsWith('危険')) return 'DANGER';
  if (score >= 70) return 'BUY_WATCH';
  if (score >= 50) return 'WATCH';
  return 'NEUTRAL';
}

async function fetchMarket() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=80&page=1&sparkline=false&price_change_percentage=24h';
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-radar-pro/1.0' } });
  if (!response.ok) throw new Error(`CoinGecko API error ${response.status}`);
  const data = await response.json();
  return data.map((coin) => {
    const score = scoreCoin(coin);
    const danger = dangerLabel(coin);
    return {
      id: coin.id,
      name: coin.name,
      symbol: String(coin.symbol || '').toUpperCase(),
      image: coin.image,
      price: safeNumber(coin.current_price),
      marketCap: safeNumber(coin.market_cap),
      volume: safeNumber(coin.total_volume),
      change24h: safeNumber(coin.price_change_percentage_24h),
      rank: coin.market_cap_rank,
      score,
      danger,
      className: classify(score, danger)
    };
  }).sort((a, b) => b.score - a.score);
}

function findPosition(symbol) { return state.positions.find((p) => p.symbol === symbol); }

function openPaperTrade(coin) {
  if (!state.paperTradingEnabled || state.pausedReason) return;
  if (state.positions.length >= CONFIG.maxPositions || findPosition(coin.symbol)) return;
  if (coin.score < CONFIG.minScoreToBuy || coin.volume < CONFIG.minVolumeUsd || coin.marketCap < CONFIG.minMarketCapUsd) return;
  if (coin.change24h < 3 || coin.change24h > 12 || coin.danger !== '通常監視') return;
  const spend = state.cash * CONFIG.positionSizePct;
  if (spend < 25 || coin.price <= 0) return;
  const qty = spend / coin.price;
  state.cash -= spend;
  const position = { id: `${coin.symbol}-${Date.now()}`, symbol: coin.symbol, name: coin.name, image: coin.image, entryPrice: coin.price, qty, cost: spend, openedAt: new Date().toISOString(), scoreAtEntry: coin.score };
  state.positions.push(position);
  state.trades.unshift({ type: 'BUY', symbol: coin.symbol, name: coin.name, price: coin.price, amountUsd: spend, pnlUsd: 0, pnlPct: 0, reason: 'Score条件一致によるペーパートレード買い', time: new Date().toISOString() });
}

function closePaperTrade(position, price, reason) {
  const value = position.qty * price;
  const pnlUsd = value - position.cost;
  const pnlPct = (price / position.entryPrice - 1) * 100;
  state.cash += value;
  state.closedPnL += pnlUsd;
  state.positions = state.positions.filter((p) => p.id !== position.id);
  state.consecutiveLosses = pnlUsd < 0 ? state.consecutiveLosses + 1 : 0;
  if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
    state.paperTradingEnabled = false;
    state.pausedReason = '3連敗で自動停止';
  }
  state.trades.unshift({ type: 'SELL', symbol: position.symbol, name: position.name, price, amountUsd: value, pnlUsd, pnlPct, reason, time: new Date().toISOString() });
}

function updatePaperTrading(market) {
  const priceMap = new Map(market.map((c) => [c.symbol, c]));
  for (const position of [...state.positions]) {
    const coin = priceMap.get(position.symbol);
    if (!coin) continue;
    const pnlPct = (coin.price / position.entryPrice - 1) * 100;
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
    const pnlPct = (currentPrice / p.entryPrice - 1) * 100;
    return { ...p, currentPrice, value, pnlUsd, pnlPct };
  });
  const openValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalEquity = state.cash + openValue;
  const sells = state.trades.filter((t) => t.type === 'SELL');
  const wins = sells.filter((t) => t.pnlUsd > 0).length;
  const winRate = sells.length ? (wins / sells.length) * 100 : 0;
  return { cash: state.cash, openValue, totalEquity, closedPnL: state.closedPnL, totalReturnPct: ((totalEquity / state.startingCash) - 1) * 100, winRate, closedTrades: sells.length, positions };
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
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, name: 'Crypto Radar Pro', mode: 'paper-trading', realTrading: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/news') {
    return json(res, 200, { sources: [
      { name: 'Binance Announcements', url: 'https://www.binance.com/en/support/announcement' },
      { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog' },
      { name: 'OKX Announcements', url: 'https://www.okx.com/help/section/announcements' },
      { name: 'CoinGecko Trending', url: 'https://www.coingecko.com/en/discover' }
    ], note: '公式ニュースはリンク確認方式。次段階で有料API・RSS・通知を追加できます。' });
  }

  if (req.method === 'GET' && url.pathname === '/api/market') {
    try {
      const market = await fetchMarket();
      state.lastMarket = market;
      state.lastUpdated = new Date().toISOString();
      updatePaperTrading(market);
      return json(res, 200, { updatedAt: state.lastUpdated, config: CONFIG, market, portfolio: portfolioSummary(market), trading: { paperTradingEnabled: state.paperTradingEnabled, pausedReason: state.pausedReason, consecutiveLosses: state.consecutiveLosses }, trades: state.trades.slice(0, 80) });
    } catch (err) {
      return json(res, 500, { error: 'market_fetch_failed', message: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/trading/toggle') {
    const body = await readBody(req);
    state.paperTradingEnabled = Boolean(body.enabled);
    if (state.paperTradingEnabled) { state.pausedReason = null; state.consecutiveLosses = 0; }
    return json(res, 200, { ok: true, paperTradingEnabled: state.paperTradingEnabled, pausedReason: state.pausedReason });
  }

  if (req.method === 'POST' && url.pathname === '/api/trading/reset') {
    state.paperTradingEnabled = true;
    state.cash = state.startingCash;
    state.positions = [];
    state.trades = [];
    state.closedPnL = 0;
    state.consecutiveLosses = 0;
    state.pausedReason = null;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  return json(res, 405, { error: 'method_not_allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Radar Pro running on port ${PORT}`);
});
