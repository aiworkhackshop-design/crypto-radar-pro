import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), 'public');
const CACHE_MS = 5 * 60 * 1000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';

const PRODUCTS = [
  ['BTC-USD','BTC','Bitcoin',1], ['ETH-USD','ETH','Ethereum',2], ['SOL-USD','SOL','Solana',5], ['XRP-USD','XRP','XRP',7],
  ['DOGE-USD','DOGE','Dogecoin',9], ['ADA-USD','ADA','Cardano',10], ['AVAX-USD','AVAX','Avalanche',11], ['LINK-USD','LINK','Chainlink',14],
  ['DOT-USD','DOT','Polkadot',15], ['LTC-USD','LTC','Litecoin',20], ['BCH-USD','BCH','Bitcoin Cash',21], ['UNI-USD','UNI','Uniswap',25]
];
const NEWS_SOURCES = [{ name: 'Binance Announcements', url: 'https://www.binance.com/en/support/announcement' }];
const state = { cacheUntil: 0, lastMarket: [], lastNews: [], alerts: [], lastAlertKeys: {}, lastUpdated: null };
const notificationEnabled = Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_TO);
const safe = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const pct = (a, b) => b ? ((a - b) / b) * 100 : 0;
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function json(res, code, data) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); }
async function fetchJson(url) { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-alpha-terminal/1.0' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function fetchText(url) { const r = await fetch(url, { headers: { accept: 'text/html,application/rss+xml,text/xml', 'user-agent': 'crypto-alpha-terminal/1.0' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); }
function strip(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function candles(raw) { return raw.map(c => ({ time: c[0], low: safe(c[1]), high: safe(c[2]), open: safe(c[3]), close: safe(c[4]), volume: safe(c[5]) })).sort((a,b)=>a.time-b.time).filter(c=>c.close>0); }
function backtest(cs) {
  let wins=0,trades=0,pnl=0;
  for (let i=18;i<cs.length-6;i++) {
    const recent=cs.slice(i-6,i), before=cs.slice(i-18,i-6);
    const move=pct(recent.at(-1).close,recent[0].open);
    const vol=avg(recent.map(c=>c.volume))/Math.max(avg(before.map(c=>c.volume)),1);
    if (move>0.4 && move<6 && vol>1.15) {
      const entry=cs[i].open, exit=cs.slice(i,i+6);
      let result=pct(exit.at(-1).close,entry);
      for (const c of exit) { if (pct(c.low,entry)<=-2) { result=-2; break; } if (pct(c.high,entry)>=3) { result=3; break; } }
      trades++; pnl+=result; if(result>0) wins++;
    }
  }
  return { trades, winRate: trades ? wins/trades*100 : 0, expectancy: trades ? pnl/trades : 0 };
}
function makePlan(m, cs) {
  const highs = cs.slice(-24).map(c => c.high);
  const lows = cs.slice(-24).map(c => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const atrish = Math.max((recentHigh - recentLow) * 0.16, m.price * 0.006);
  const entry = Math.max(recentHigh, m.price * 1.004);
  const stop = Math.min(m.price - atrish, recentLow);
  const risk = Math.max(entry - stop, m.price * 0.005);
  const target1 = entry + risk * 1.8;
  const target2 = entry + risk * 3.0;
  const rr = (target1 - entry) / risk;
  const invalid = stop;
  return { entry, stop, target1, target2, invalid, rr, recentHigh, recentLow };
}
function analyze(m) {
  const reasons=[], warnings=[];
  let score=0, setup='NO_SETUP', decision='NO_TRADE', action='待機。条件が揃うまで何もしない。';
  if (m.volumeSpike>=1.5 && m.trend6h>0.4) { score+=35; setup='VOLUME_BREAKOUT'; reasons.push('出来高急増と短期上昇が同時発生'); }
  else if (m.volumeSpike>=1.25) { score+=22; setup='VOLUME_WATCH'; reasons.push('出来高が増え始めている'); }
  if (m.trend6h>1.0) { score+=22; reasons.push('6時間トレンドが強い'); } else if (m.trend6h>0.3) { score+=12; reasons.push('6時間トレンドが上向き'); }
  if (m.change24h>0.7 && m.change24h<8) { score+=14; reasons.push('24hが過熱しすぎていない'); }
  if (m.bt.trades>=5 && m.bt.winRate>=55) { score+=18; reasons.push('簡易BT勝率が55%以上'); }
  if (m.bt.expectancy>0.35) { score+=11; reasons.push('簡易期待値がプラス'); }
  if (m.change24h>12) { warnings.push('急騰後で飛び乗り注意'); score-=20; }
  if (m.trend6h<-1.5 || m.change24h<-5) { warnings.push('下落圧力が強い'); score-=22; }
  if (m.volumeSpike<0.8) { warnings.push('出来高が弱い'); score-=10; }
  score=Math.max(0,Math.min(100,Math.round(score)));
  if (score>=72 && warnings.length<=1) { decision='BUY_WATCH'; action='直近高値更新か押し目反発を確認。'; }
  else if (score>=55) { decision='WATCH'; action='監視。出来高が継続すれば候補。'; }
  if (!reasons.length) reasons.push('明確な優位性なし');
  return { score, setup, decision, action, reasons: reasons.slice(0,4), warnings: warnings.slice(0,3) };
}
function verdict(c) {
  if (!c) return { label:'NO DATA', tone:'risk', action:'市場データなし。何もしない。' };
  if (c.decision === 'BUY_WATCH') return { label:'ALPHA SETUP', tone:'go', action:`${c.symbol}: ${c.plan.entry.toFixed(c.price < 1 ? 5 : 2)} 上抜け確認。SL ${c.plan.stop.toFixed(c.price < 1 ? 5 : 2)}。` };
  if (c.decision === 'WATCH') return { label:'WATCH ONLY', tone:'wait', action:`${c.symbol}: 出来高継続待ち。今は成行で触らない。` };
  return { label:'NO TRADE', tone:'risk', action:'強い候補なし。現金を守る。次の出来高急増まで待機。' };
}
async function fetchMarketData() {
  const market=[], errors=[];
  for (const [product,symbol,name,rank] of PRODUCTS) {
    try {
      const [stats, raw] = await Promise.all([
        fetchJson(`https://api.exchange.coinbase.com/products/${product}/stats`),
        fetchJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600`)
      ]);
      const cs=candles(raw).slice(-72); if(cs.length<24) throw new Error('candles too short');
      const price=safe(stats.last, cs.at(-1).close);
      const recent6=cs.slice(-6), prev18=cs.slice(-24,-6);
      const change24h=pct(price, safe(stats.open, cs.at(-24).open));
      const trend6h=pct(recent6.at(-1).close, recent6[0].open);
      const volumeSpike=avg(recent6.map(c=>c.volume))/Math.max(avg(prev18.map(c=>c.volume)),1);
      const bt=backtest(cs);
      const base={ product,symbol,name,rank,price,change24h,trend6h,volumeSpike,volume:safe(stats.volume)*price,bt,backtest:bt };
      const analysis = analyze(base);
      const plan = makePlan(base, cs);
      const chart = cs.slice(-48).map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume }));
      market.push({ ...base, ...analysis, plan, chart });
      await sleep(60);
    } catch(e) { errors.push(`${symbol}: ${e.message}`); }
  }
  return { market: market.sort((a,b)=>b.score-a.score), errors };
}
async function fetchNews() {
  const items=[];
  for (const s of NEWS_SOURCES) {
    try {
      const html=await fetchText(s.url);
      const title=strip(html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || s.name);
      const titleLower=title.toLowerCase();
      const strong=['listing','new asset','will list','launchpool','airdrop','etf approval','futures listing'].filter(k=>titleLower.includes(k));
      items.push({ source:s.name, title, url:s.url, priority:strong.length?'HIGH':'NORMAL', keywords:strong, detectedAt:new Date().toISOString() });
    } catch(e) { console.warn(`News fetch skipped: ${s.name}: ${e.message}`); }
  }
  state.lastNews=items;
  return items;
}
function signals(market, news) {
  const buy=market.filter(c=>c.decision==='BUY_WATCH');
  const watch=market.filter(c=>c.decision==='WATCH');
  const vol=[...market].sort((a,b)=>b.volumeSpike-a.volumeSpike)[0];
  const highNews=news.find(n=>n.priority==='HIGH');
  const out=[];
  if (buy[0]) out.push({ type:'ENTRY_CANDIDATE', title:'候補あり', tone:'go', body:`${buy[0].name}: score ${buy[0].score} / Entry ${buy[0].plan.entry.toFixed(buy[0].price < 1 ? 5 : 2)}` });
  else out.push({ type:'NO_TRADE_ZONE', title:'今は待機', tone:'wait', body:'強い候補なし。無理に触らない。' });
  if (vol) out.push({ type:'VOLUME_RADAR', title:'出来高監視', tone:vol.volumeSpike>=1.5?'go':'wait', body:`${vol.name}: ${vol.volumeSpike.toFixed(2)}x / 6h ${vol.trend6h.toFixed(2)}%` });
  if (watch[0]) out.push({ type:'WATCHLIST', title:'監視候補', tone:'wait', body:`${watch[0].name}: score ${watch[0].score}` });
  if (highNews) out.push({ type:'NEWS_ALERT', title:'重要ニュース候補', tone:'go', body:`${highNews.source}: ${highNews.keywords.join(', ')}` });
  return out;
}
async function pushLine(message) {
  if (!notificationEnabled) return { ok:false, reason:'LINE env not configured' };
  const r=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},body:JSON.stringify({to:LINE_TO,messages:[{type:'text',text:message.slice(0,4900)}]})});
  return r.ok ? { ok:true } : { ok:false, reason:`LINE ${r.status}` };
}
async function emitAlerts(sig) {
  const now=Date.now(), created=[];
  for (const s of sig.filter(x=>['ENTRY_CANDIDATE','NEWS_ALERT'].includes(x.type) || (x.type==='VOLUME_RADAR' && x.tone==='go'))) {
    const key=`${s.type}:${s.body}`; if(state.lastAlertKeys[key] && now-state.lastAlertKeys[key]<1800000) continue;
    state.lastAlertKeys[key]=now;
    const item={...s, id:`${key}:${now}`, createdAt:new Date().toISOString(), notified:false};
    if(notificationEnabled){ const sent=await pushLine(`Crypto Alpha Terminal\n${s.title}\n${s.body}`); item.notified=sent.ok; item.notifyError=sent.reason||null; }
    created.push(item);
  }
  state.alerts=[...created,...state.alerts].slice(0,50); return created;
}
function portfolioSummary(){return{cash:10000,openValue:0,totalEquity:10000,closedPnL:0,totalReturnPct:0,winRate:0,closedTrades:0,positions:[]};}
async function serveStatic(req,res){const url=new URL(req.url,`http://${req.headers.host}`);const p=url.pathname==='/'?'/index.html':url.pathname;const filePath=join(PUBLIC_DIR,p.replace(/^\/+/,'') );try{const data=await readFile(filePath);const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'};res.writeHead(200,{'content-type':types[extname(filePath)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,`http://${req.headers.host}`);if(req.method==='OPTIONS')return json(res,200,{ok:true});
 if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,name:'Crypto Alpha Terminal',notificationEnabled});
 if(req.method==='GET'&&url.pathname==='/api/market'){
  let result, news;
  if(state.lastMarket.length&&Date.now()<state.cacheUntil){result={market:state.lastMarket,errors:[]};news=state.lastNews;}else{result=await fetchMarketData();news=await fetchNews();state.lastMarket=result.market;state.cacheUntil=Date.now()+CACHE_MS;}
  state.lastUpdated=new Date().toISOString();const sig=signals(result.market,news);const newAlerts=await emitAlerts(sig);const actionables=result.market.filter(c=>c.decision!=='NO_TRADE').slice(0,5);const primary=(actionables[0]||result.market[0]||null);const command=verdict(primary);
  return json(res,200,{updatedAt:state.lastUpdated,source:'coinbase',warning:result.errors.length?`一部取得失敗: ${result.errors.length}件`:null,command,primary,signals:sig,alerts:state.alerts.slice(0,20),newAlerts,news,notification:{enabled:notificationEnabled,lineConfigured:notificationEnabled},top:actionables,market:result.market,portfolio:portfolioSummary(),trading:{paperTradingEnabled:false,pausedReason:'自動売買なし・監視のみ',consecutiveLosses:0},trades:[]});
 }
 if(req.method==='GET'&&url.pathname==='/api/news')return json(res,200,{sources:NEWS_SOURCES,items:state.lastNews});
 if(req.method==='GET'&&url.pathname==='/api/alerts')return json(res,200,{alerts:state.alerts,notificationEnabled});
 if(req.method==='POST'&&url.pathname==='/api/notify/test')return json(res,200,await pushLine('Crypto Alpha Terminal test'));
 if(req.method==='GET')return serveStatic(req,res);return json(res,405,{error:'method_not_allowed'});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Crypto Alpha Terminal running on port ${PORT}`));
