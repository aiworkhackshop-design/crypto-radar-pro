import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

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

  const dangerPenalty = getDangerPenalty(coin);
  score -= dangerPenalty;

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
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'crypto-radar-pro/1.0'
    }
  });

  if (!res.ok) {
    throw new Error(`CoinGecko API error ${res.status}`);
  }

  const data = await res.json();
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

function findPosition(symbol) {
  return state.positions.find((p) => p.symbol === symbol);
}

function openPaperTrade(coin) {
  if (!state.paperTradingEnabled) return;
  if (state.pausedReason) return;
  if (state.positions.length >= CONFIG.maxPositions) return;
  if (findPosition(coin.symbol)) return;
  if (coin.score < CONFIG.minScoreToBuy) return;
  if (coin.volume < CONFIG.minVolumeUsd) return;
  if (coin.marketCap < CONFIG.minMarketCapUsd) return;
  if (coin.change24h < 3 || coin.change24h > 12) return;
  if (coin.danger !== '通常監視') return;

  const spend = state.cash * CONFIG.positionSizePct;
  if (spend < 25) return;

  const qty = spend / coin.price;
  state.cash -= spend;

  const position = {
    id: `${coin.symbol}-${Date.now()}`,
    symbol: coin.symbol,
    name: coin.name,
    image: coin.image,
    entryPrice: coin.price,
    qty,
    cost: spend,
    openedAt: new Date().toISOString(),
    scoreAtEntry: coin.score
  };

  state.positions.push(position);
  state.trades.unshift({
    type: 'BUY',
    symbol: coin.symbol,
    name: coin.name,
    price: coin.price,
    amountUsd: spend,
    pnlUsd: 0,
    pnlPct: 0,
    reason: 'Score条件一致によるペーパートレード買い',
    time: new Date().toISOString()
  });
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

  state.trades.unshift({
    type: 'SELL',
    symbol: position.symbol,
    name: position.name,
    price,
    amountUsd: value,
    pnlUsd,
    pnlPct,
    reason,
    time: new Date().toISOString()
  });
}

function updatePaperTrading(market) {
  const priceMap = new Map(market.map((c) => [c.symbol, c]));

  for (const position of [...state.positions]) {
    const coin = priceMap.get(position.symbol);
    if (!coin) continue;

    const pnlPct = (coin.price / position.entryPrice - 1) * 100;
    const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3600000;

    if (pnlPct >= CONFIG.takeProfitPct) {
      closePaperTrade(position, coin.price, `利確 +${CONFIG.takeProfitPct}%到達`);
    } else if (pnlPct <= CONFIG.stopLossPct) {
      closePaperTrade(position, coin.price, `損切り ${CONFIG.stopLossPct}%到達`);
    } else if (holdHours >= CONFIG.maxHoldHours) {
      closePaperTrade(position, coin.price, '最大保有時間を超過');
    }
  }

  for (const coin of market) {
    openPaperTrade(coin);
  }
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

  return {
    cash: state.cash,
    openValue,
    totalEquity,
    closedPnL: state.closedPnL,
    totalReturnPct: ((totalEquity / state.startingCash) - 1) * 100,
    winRate,
    closedTrades: sells.length,
    positions
  };
}

app.get('/api/market', async (req, res) => {
  try {
    const market = await fetchMarket();
    state.lastMarket = market;
    state.lastUpdated = new Date().toISOString();
    updatePaperTrading(market);

    res.json({
      updatedAt: state.lastUpdated,
      config: CONFIG,
      market,
      portfolio: portfolioSummary(market),
      trading: {
        paperTradingEnabled: state.paperTradingEnabled,
        pausedReason: state.pausedReason,
        consecutiveLosses: state.consecutiveLosses
      },
      trades: state.trades.slice(0, 80)
    });
  } catch (err) {
    res.status(500).json({ error: 'market_fetch_failed', message: err.message });
  }
});

app.post('/api/trading/toggle', (req, res) => {
  state.paperTradingEnabled = Boolean(req.body.enabled);
  if (state.paperTradingEnabled) {
    state.pausedReason = null;
    state.consecutiveLosses = 0;
  }
  res.json({ ok: true, paperTradingEnabled: state.paperTradingEnabled, pausedReason: state.pausedReason });
});

app.post('/api/trading/reset', (req, res) => {
  state.paperTradingEnabled = true;
  state.cash = state.startingCash;
  state.positions = [];
  state.trades = [];
  state.closedPnL = 0;
  state.consecutiveLosses = 0;
  state.pausedReason = null;
  res.json({ ok: true });
});

app.get('/api/news', (req, res) => {
  res.json({
    sources: [
      { name: 'Binance Announcements', url: 'https://www.binance.com/en/support/announcement' },
      { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog' },
      { name: 'OKX Announcements', url: 'https://www.okx.com/help/section/announcements' },
      { name: 'CoinGecko Trending', url: 'https://www.coingecko.com/en/discover' }
    ],
    note: '公式ニュースはリンク確認方式。次段階で有料API・RSS・通知を追加できます。'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'Crypto Radar Pro', mode: 'paper-trading', realTrading: false });
});

app.listen(PORT, () => {
  console.log(`Crypto Radar Pro running on port ${PORT}`);
});
