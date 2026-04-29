import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), 'public');
const CACHE_MS = 5 * 60 * 1000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';

const state = {
  paperTradingEnabled: true,
  startingCash: 10000,
  cash: 10000,
  positions: [],
  trades: [],
  alerts: [],
  lastAlertKeys: {},
  closedPnL: 0,
  consecutiveLosses: 0,
  pausedReason: null,
  lastMarket: [],
  lastSignals: [],
  lastNews: [],
  lastUpdated: null,
  cacheUntil: 0,
  notificationEnabled: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_TO)
};

const CONFIG = {
  maxPositions: 3,
  positionSizePct: 0.12,
  takeProfitPct: 4,
  stopLossPct: -2,
  maxHoldHours: 6,
  minScoreToBuy: 68,
  maxConsecutiveLosses: 3,
  volumeSpikeAlert: 1.35,
  priceMoveAlert: 2.2,
  riskDropAlert: -3.5
};

const PRODUCTS = [
  ['BTC-USD','BTC','Bitcoin',1,1280000000000], ['ETH-USD','ETH','Ethereum',2,378000000000], ['SOL-USD','SOL','Solana',5,66000000000],
  ['XRP-USD','XRP','XRP',7,35000000000], ['DOGE-USD','DOGE','Dogecoin',9,22000000000], ['ADA-USD','ADA','Cardano',10,16000000000],
  ['AVAX-USD','AVAX','Avalanche',11,15000000000], ['LINK-USD','LINK','Chainlink',14,9000000000], ['DOT-USD','DOT','Polkadot',15,9900000000],
  ['LTC-USD','LTC','Litecoin',20,7000000000], ['BCH-USD','BCH','Bitcoin Cash',21,8500000000], ['NEAR-USD','NEAR','NEAR Protocol',24,6500000000],
  ['UNI-USD','UNI','Uniswap',25,6000000000], ['APT-USD','APT','Aptos',27,5000000000], ['FIL-USD','FIL','Filecoin',35,4500000000],
  ['ETC-USD','ETC','Ethereum Classic',36,4200000000], ['ATOM-USD','ATOM','Cosmos Hub',38,4100000000]
];

const NEWS_SOURCES = [
  { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog' },
  { name: 'Binance Announcements', url: 'https://www.binance.com/en/support/announcement' },
  { name: 'OKX Announcements', url: 'https://www.okx.com/help/section/announcements' },
  { name: 'CoinGecko Trending', url: 'https://www.coingecko.com/en/discover' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeNumber = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const pct = (a, b) => b ? ((a - b) / b) * 100 : 0;

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload));
}
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; } }
async function fetchJson(url) { const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-signal-cockpit/4.0' } }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.json(); }
async function fetchText(url) { const response = await fetch(url, { headers: { accept: 'text/html,application/rss+xml,text/xml', 'user-agent': 'crypto-signal-cockpit/4.0' } }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response.text(); }
function parseCandles(raw) { return raw.map((c) => ({ time: c[0], low: safeNumber(c[1]), high: safeNumber(c[2]), open: safeNumber(c[3]), close: safeNumber(c[4]), volume: safeNumber(c[5]) })).sort((a, b) => a.time - b.time).filter((c) => c.close > 0); }
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

function computeBacktest(candles) {
  let wins = 0, losses = 0, trades = 0, pnl = 0;
  for (let i = 10; i < candles.length - 6; i++) {
    const before = candles.slice(i - 10, i - 5);
    const recent = candles.slice(i - 5, i);
    const move = pct(recent.at(-1).close, recent[0].open);
    const vol = avg(recent.map((c) => c.volume)) / Math.max(avg(before.map((c) => c.volume)), 1);
    if ((move > 0.6 && vol > 1.05) || (move > -0.4 && vol > 1.35)) {
      const entry = candles[i].open;
      const exitWindow = candles.slice(i, i + 6);
      let result = pct(exitWindow.at(-1).close, entry);
      for (const c of exitWindow) {
        if (pct(c.low, entry) <= -2) { result = -2; break; }
        if (pct(c.high, entry) >= 4) { result = 4; break; }
      }
      trades++; pnl += result; if (result > 0) wins++; else losses++;
    }
  }
  return { trades, wins, losses, winRate: trades ? wins / trades * 100 : 0, expectancy: trades ? pnl / trades : 0 };
}

function decide({ change24h, trend6h, trend24h, volumeSpike, backtest, volatility }) {
  const reasons = [], warnings = [];
  let score = 35;
  let setup = 'NO_TRADE';
  if (volumeSpike >= 1.35 && trend6h > 0.25) { score += 22; setup = 'VOLUME_BREAKOUT'; reasons.push('出来高増加と短期上昇が同時発生'); }
  else if (volumeSpike >= 1.2) { score += 14; setup = 'VOLUME_WATCH'; reasons.push('出来高が通常より増えている'); }
  if (trend6h > 0.8) { score += 16; reasons.push('6時間トレンドが強い'); }
  else if (trend6h > 0.15) { score += 8; reasons.push('6時間トレンドが上向き'); }
  else if (trend6h < -1.2) { score -= 20; warnings.push('短期トレンドが弱い'); }
  if (change24h > 1 && change24h < 9) { score += 12; reasons.push('24hの上昇が過熱しすぎていない'); }
  else if (change24h > 14) { score -= 24; warnings.push('急騰後で飛び乗り危険'); }
  else if (change24h < -5) { score -= 18; warnings.push('24h下落が強い'); }
  if (backtest.trades >= 2 && backtest.winRate >= 50) { score += 12; reasons.push('簡易バックテスト勝率が一定以上'); }
  if (backtest.expectancy > 0.5) { score += 10; reasons.push('簡易期待値がプラス'); }
  else if (backtest.expectancy < -0.6) { score -= 12; warnings.push('簡易期待値がマイナス'); }
  if (volatility > 12) { score -= 10; warnings.push('ボラティリティ過大'); }
  if (volumeSpike < 0.75) { score -= 12; warnings.push('出来高が弱い'); }
  if (!reasons.length) reasons.push('買い根拠がまだ弱い');
  score = Math.max(0, Math.min(100, Math.round(score)));
  let decision = 'AVOID';
  let action = '触らない。次の出来高急増を待つ。';
  if (score >= 68 && warnings.length <= 2) { decision = 'BUY_WATCH'; action = 'エントリー候補。直近高値更新または押し目反発を確認。'; }
  else if (score >= 48) { decision = 'WATCH'; action = '監視継続。出来高がもう一段増えたら候補入り。'; }
  if (setup === 'NO_TRADE' && decision !== 'AVOID') setup = 'WATCH_SETUP';
  return { score, decision, setup, action, reasons: reasons.slice(0, 4), warnings: warnings.slice(0, 4) };
}

async function fetchCoinbaseRadar() {
  const rows = [], errors = [];
  for (const [product, symbol, name, rank, marketCap] of PRODUCTS) {
    try {
      const [stats, rawCandles] = await Promise.all([fetchJson(`https://api.exchange.coinbase.com/products/${product}/stats`), fetchJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600`)]);
      const candles = parseCandles(rawCandles).slice(-72);
      if (candles.length < 24) throw new Error(`${product}: candles too short`);
      const price = safeNumber(stats.last, candles.at(-1).close);
      const open24h = safeNumber(stats.open, candles[candles.length - 24]?.open || price);
      const change24h = pct(price, open24h);
      const recent6 = candles.slice(-6), prev18 = candles.slice(-24, -6);
      const trend6h = pct(recent6.at(-1).close, recent6[0].open);
      const trend24h = pct(candles.at(-1).close, candles[candles.length - 24].open);
      const volumeSpike = avg(recent6.map((c) => c.volume)) / Math.max(avg(prev18.map((c) => c.volume)), 1);
      const volumeUsd = safeNumber(stats.volume) * price;
      const highs = candles.slice(-24).map((c) => c.high), lows = candles.slice(-24).map((c) => c.low);
      const volatility = pct(Math.max(...highs), Math.min(...lows));
      const backtest = computeBacktest(candles);
      const d = decide({ change24h, trend6h, trend24h, volumeSpike, backtest, volatility });
      rows.push({ id: symbol.toLowerCase(), product, symbol, name, rank, price, marketCap, volume: volumeUsd, change24h, trend6h, trend24h, volumeSpike, volatility, backtest, score: d.score, decision: d.decision, setup: d.setup, className: d.decision, danger: d.warnings[0] || '通常監視', action: d.action, reasons: d.reasons, warnings: d.warnings });
      await sleep(70);
    } catch (e) { errors.push(`${product}: ${e.message}`); }
  }
  if (!rows.length) throw new Error(errors.slice(0, 3).join(' / ') || 'Coinbase data unavailable');
  return { market: rows.sort((a, b) => b.score - a.score), errors };
}

async function fetchNews() {
  const results = [];
  for (const source of NEWS_SOURCES) {
    try {
      const text = await fetchText(source.url);
      const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/i);
      const headline = stripTags(titleMatch?.[1] || source.name).slice(0, 120);
      const lower = text.toLowerCase();
      const hot = ['listing', 'launch', 'token', 'airdrop', 'futures', 'perpetual', 'staking', 'roadmap', 'etf'].filter((k) => lower.includes(k));
      results.push({ source: source.name, title: headline, url: source.url, keywords: hot.slice(0, 4), detectedAt: new Date().toISOString(), priority: hot.length ? 'HIGH' : 'NORMAL' });
    } catch (error) {
      results.push({ source: source.name, title: '取得失敗', url: source.url, keywords: [], detectedAt: new Date().toISOString(), priority: 'ERROR', error: error.message });
    }
  }
  state.lastNews = results;
  return results;
}

function createSignals(market, news = []) {
  const actionable = market.filter((c) => c.decision === 'BUY_WATCH');
  const watch = market.filter((c) => c.decision === 'WATCH');
  const volume = [...market].sort((a, b) => b.volumeSpike - a.volumeSpike).slice(0, 3);
  const movers = [...market].sort((a, b) => Math.abs(b.trend6h) - Math.abs(a.trend6h)).slice(0, 3);
  const danger = market.filter((c) => c.warnings?.length).slice(0, 3);
  const highNews = news.filter((n) => n.priority === 'HIGH');
  const signals = [];
  if (actionable.length) signals.push({ type: 'ENTRY_CANDIDATE', title: 'エントリー候補あり', tone: 'go', body: `${actionable[0].name} が最上位。${actionable[0].action}` });
  else signals.push({ type: 'NO_TRADE_ZONE', title: '今はノートレード優先', tone: 'wait', body: 'BUY_WATCHなし。守る相場。次の出来高急増まで待機。' });
  if (volume[0]) signals.push({ type: 'VOLUME_RADAR', title: '出来高急増', tone: volume[0].volumeSpike >= CONFIG.volumeSpikeAlert ? 'go' : 'wait', body: `${volume[0].name}: 出来高 ${volume[0].volumeSpike.toFixed(2)}x / 6h ${volume[0].trend6h.toFixed(2)}%` });
  if (movers[0]) signals.push({ type: 'PRICE_MOMENTUM', title: '短期値動き', tone: Math.abs(movers[0].trend6h) >= CONFIG.priceMoveAlert ? 'go' : 'wait', body: `${movers[0].name}: 6h ${movers[0].trend6h.toFixed(2)}% / 24h ${movers[0].change24h.toFixed(2)}%` });
  if (watch[0]) signals.push({ type: 'WATCHLIST', title: '監視候補', tone: 'wait', body: `${watch[0].name}: もう一段の出来高で候補入り。` });
  if (danger[0]) signals.push({ type: 'RISK_ALERT', title: 'リスク警告', tone: 'risk', body: `${danger[0].name}: ${danger[0].warnings[0]}` });
  if (highNews[0]) signals.push({ type: 'NEWS_ALERT', title: 'ニュース検知', tone: 'go', body: `${highNews[0].source}: ${highNews[0].keywords.join(', ')}` });
  return signals;
}

async function pushLine(message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_TO) return { ok: false, reason: 'LINE env not configured' };
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text: message.slice(0, 4900) }] })
  });
  if (!response.ok) return { ok: false, reason: `LINE API ${response.status}: ${await response.text()}` };
  return { ok: true };
}

async function emitAlerts(signals, market) {
  const now = Date.now();
  const newAlerts = [];
  const candidates = [
    ...signals.filter((s) => ['ENTRY_CANDIDATE', 'VOLUME_RADAR', 'PRICE_MOMENTUM', 'RISK_ALERT', 'NEWS_ALERT'].includes(s.type)),
    ...market.filter((c) => c.volumeSpike >= CONFIG.volumeSpikeAlert).slice(0, 2).map((c) => ({ type: 'VOLUME_SPIKE', title: `${c.symbol} 出来高急増`, tone: 'go', body: `${c.name}: ${c.volumeSpike.toFixed(2)}x / score ${c.score}` })),
    ...market.filter((c) => c.trend6h <= CONFIG.riskDropAlert).slice(0, 2).map((c) => ({ type: 'DROP_ALERT', title: `${c.symbol} 急落警戒`, tone: 'risk', body: `${c.name}: 6h ${c.trend6h.toFixed(2)}%` }))
  ];
  for (const alert of candidates) {
    const key = `${alert.type}:${alert.title}`;
    if (state.lastAlertKeys[key] && now - state.lastAlertKeys[key] < 30 * 60 * 1000) continue;
    state.lastAlertKeys[key] = now;
    const item = { ...alert, id: `${key}:${now}`, createdAt: new Date().toISOString(), notified: false };
    if (state.notificationEnabled) {
      const sent = await pushLine(`Crypto Signal Cockpit\n${item.title}\n${item.body}`);
      item.notified = sent.ok;
      item.notifyError = sent.ok ? null : sent.reason;
    }
    newAlerts.push(item);
  }
  state.alerts = [...newAlerts, ...state.alerts].slice(0, 80);
  return newAlerts;
}

async function fetchMarket() {
  if (state.lastMarket.length && Date.now() < state.cacheUntil) return { market: state.lastMarket, source: 'cache', warning: null, news: state.lastNews };
  try {
    const [result, news] = await Promise.all([fetchCoinbaseRadar(), fetchNews()]);
    state.lastMarket = result.market; state.cacheUntil = Date.now() + CACHE_MS;
    return { market: result.market, source: 'coinbase', news, warning: result.errors.length ? `一部銘柄取得失敗: ${result.errors.length}件` : null };
  } catch (error) {
    if (state.lastMarket.length) return { market: state.lastMarket, source: 'cache', warning: `${error.message} / キャッシュ表示中`, news: state.lastNews };
    return { market: [], source: 'none', warning: `${error.message} / データ取得失敗`, news: state.lastNews };
  }
}

function findPosition(symbol) { return state.positions.find((p) => p.symbol === symbol); }
function openPaperTrade(coin) { if (!state.paperTradingEnabled || state.pausedReason) return; if (state.positions.length >= CONFIG.maxPositions || findPosition(coin.symbol)) return; if (coin.score < CONFIG.minScoreToBuy || coin.decision !== 'BUY_WATCH') return; const spend = state.cash * CONFIG.positionSizePct; if (spend < 25 || coin.price <= 0) return; state.cash -= spend; state.positions.push({ id: `${coin.symbol}-${Date.now()}`, symbol: coin.symbol, name: coin.name, entryPrice: coin.price, qty: spend / coin.price, cost: spend, openedAt: new Date().toISOString(), scoreAtEntry: coin.score }); state.trades.unshift({ type: 'BUY', symbol: coin.symbol, name: coin.name, price: coin.price, amountUsd: spend, pnlUsd: 0, pnlPct: 0, reason: `BUY_WATCH ${coin.score}: ${coin.reasons.join(' / ')}`, time: new Date().toISOString() }); }
function closePaperTrade(position, price, reason) { const value = position.qty * price, pnlUsd = value - position.cost, pnlPct = pct(price, position.entryPrice); state.cash += value; state.closedPnL += pnlUsd; state.positions = state.positions.filter((p) => p.id !== position.id); state.consecutiveLosses = pnlUsd < 0 ? state.consecutiveLosses + 1 : 0; if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) { state.paperTradingEnabled = false; state.pausedReason = '3連敗で自動停止'; } state.trades.unshift({ type: 'SELL', symbol: position.symbol, name: position.name, price, amountUsd: value, pnlUsd, pnlPct, reason, time: new Date().toISOString() }); }
function updatePaperTrading(market) { const priceMap = new Map(market.map((c) => [c.symbol, c])); for (const position of [...state.positions]) { const coin = priceMap.get(position.symbol); if (!coin) continue; const pnlPct = pct(coin.price, position.entryPrice); const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3600000; if (pnlPct >= CONFIG.takeProfitPct) closePaperTrade(position, coin.price, `利確 +${CONFIG.takeProfitPct}%到達`); else if (pnlPct <= CONFIG.stopLossPct) closePaperTrade(position, coin.price, `損切り ${CONFIG.stopLossPct}%到達`); else if (holdHours >= CONFIG.maxHoldHours) closePaperTrade(position, coin.price, '最大保有時間を超過'); } for (const coin of market) openPaperTrade(coin); }
function portfolioSummary(market) { const priceMap = new Map(market.map((c) => [c.symbol, c])); const positions = state.positions.map((p) => { const coin = priceMap.get(p.symbol); const currentPrice = coin ? coin.price : p.entryPrice; const value = p.qty * currentPrice; const pnlUsd = value - p.cost; const pnlPct = pct(currentPrice, p.entryPrice); return { ...p, currentPrice, value, pnlUsd, pnlPct }; }); const openValue = positions.reduce((s, p) => s + p.value, 0); const totalEquity = state.cash + openValue; const sells = state.trades.filter((t) => t.type === 'SELL'); const wins = sells.filter((t) => t.pnlUsd > 0).length; return { cash: state.cash, openValue, totalEquity, closedPnL: state.closedPnL, totalReturnPct: pct(totalEquity, state.startingCash), winRate: sells.length ? wins / sells.length * 100 : 0, closedTrades: sells.length, positions }; }
async function serveStatic(req, res) { const url = new URL(req.url, `http://${req.headers.host}`); const pathname = url.pathname === '/' ? '/index.html' : url.pathname; const filePath = join(PUBLIC_DIR, pathname.replace(/^\/+/, '')); try { const data = await readFile(filePath); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }; res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'Crypto Signal Cockpit', mode: 'paper-trading', realTrading: false, notificationEnabled: state.notificationEnabled });
  if (req.method === 'GET' && url.pathname === '/api/news') return json(res, 200, { sources: NEWS_SOURCES, items: state.lastNews, note: 'ニュース検知は公式ページのキーワード監視です。' });
  if (req.method === 'GET' && url.pathname === '/api/alerts') return json(res, 200, { alerts: state.alerts, notificationEnabled: state.notificationEnabled, lineConfigured: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_TO) });
  if (req.method === 'POST' && url.pathname === '/api/notify/test') { const sent = await pushLine('Crypto Signal Cockpit test notification'); return json(res, sent.ok ? 200 : 400, sent); }
  if (req.method === 'GET' && url.pathname === '/api/market') {
    const result = await fetchMarket();
    state.lastUpdated = new Date().toISOString();
    if (result.market.length) updatePaperTrading(result.market);
    const signals = createSignals(result.market, result.news || []);
    state.lastSignals = signals;
    const newAlerts = await emitAlerts(signals, result.market);
    const actionables = result.market.filter((c) => c.decision !== 'AVOID');
    const top = (actionables.length ? actionables : result.market).slice(0, 5);
    return json(res, 200, { updatedAt: state.lastUpdated, source: result.source, warning: result.warning, config: CONFIG, signals, alerts: state.alerts.slice(0, 20), newAlerts, news: result.news || [], notification: { enabled: state.notificationEnabled, lineConfigured: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_TO) }, top, market: result.market, portfolio: portfolioSummary(result.market), trading: { paperTradingEnabled: state.paperTradingEnabled, pausedReason: state.pausedReason, consecutiveLosses: state.consecutiveLosses }, trades: state.trades.slice(0, 80) });
  }
  if (req.method === 'POST' && url.pathname === '/api/trading/reset') { state.paperTradingEnabled = true; state.cash = state.startingCash; state.positions = []; state.trades = []; state.closedPnL = 0; state.consecutiveLosses = 0; state.pausedReason = null; return json(res, 200, { ok: true }); }
  if (req.method === 'GET') return serveStatic(req, res);
  return json(res, 405, { error: 'method_not_allowed' });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Crypto Signal Cockpit running on port ${PORT}`));
