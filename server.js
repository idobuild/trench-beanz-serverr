// ============================================================================
//  TRENCH BEANZ — multiplayer relay + REAL leaderboard server
// ----------------------------------------------------------------------------
//  This one program does two jobs:
//    1) Relays live multiplayer (WebSocket) so real players share a match.
//    2) Stores the REAL global leaderboard (HTTP /score + /top). Only real
//       player accounts are ever stored here — the game never sends bot scores.
//
//  DEPLOY (free): Render.com / Railway / Fly.io. (Netlify can't host this.)
//    1) Drop this whole folder into a GitHub repo (or zip-upload to Render).
//    2) Render -> New Web Service -> connect the repo
//         Build command:  npm install
//         Start command:  npm start      (runs: node server.js)
//    3) Render gives https://YOURAPP.onrender.com
//    4) In trench-beanz.html set:  const NET_URL='wss://YOURAPP.onrender.com';
//       (the game derives the http leaderboard URL from that automatically)
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_ROOM = 20, MAX_MSG = 4096;
// Where the leaderboard is saved. Prefer the persistent disk (/var/data) so the data
// SURVIVES code redeploys. Falls back to a local file only if no disk is mounted.
function defaultLbPath(){
  try { if (fs.existsSync('/var/data')) return '/var/data/leaderboard.json'; } catch(e){}
  return path.join(__dirname, 'leaderboard.json');
}
const LB_FILE = process.env.LB_FILE || defaultLbPath();
console.log('Leaderboard storage:', LB_FILE);
const STATS = ['wins','gold','xp','height','daily','weekly'];
// REWARD CONTEST: four 24h categories. Top 10 of each share that category's slice
// of the prize pool. 1st = 25%, tapering down. Must sum to 100.
const REWARD_CATS = ['d_wins','d_gold','d_xp','d_height'];   // 24h: wins, money made, xp, parkour
const SPLIT = [25,18,13,10,8,7,6,5,4.5,3.5];                 // % for places 1..10 (sums to 100)
const DAY_MS = 24*60*60*1000;
function dayId(){ return Math.floor(Date.now()/DAY_MS); }    // integer day bucket (UTC)

// ---------- PRIZE POOL: read the wallet's SOL balance server-side ----------
// (Browsers are blocked by Solana's public RPC CORS, so the server fetches it.)
const PRIZE_WALLET = process.env.PRIZE_WALLET || '2uHayBQTLJSmvoiLb7nAShCqzEQnaKSaBpUEU3LvGVTi';
const SOL_RPCS = (process.env.SOL_RPC ? [process.env.SOL_RPC] : []).concat([
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana'
]);
let poolCache = { sol:null, usd:null, ts:0, ok:false };
async function fetchSolPriceUsd(){
  const urls = ['https://api.coinbase.com/v2/prices/SOL-USD/spot','https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'];
  for(const url of urls){
    try{
      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),6000);
      const r=await fetch(url,{signal:ctrl.signal}); clearTimeout(to);
      if(!r.ok) continue; const j=await r.json();
      const p = (j&&j.data&&parseFloat(j.data.amount)) || (j&&parseFloat(j.price));
      if(isFinite(p)&&p>0) return p;
    }catch(e){}
  }
  return null;
}
async function fetchPoolSol(){
  const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'getBalance', params:[PRIZE_WALLET] });
  for(const url of SOL_RPCS){
    try{
      const ctrl = new AbortController(); const to = setTimeout(()=>ctrl.abort(), 6000);
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body, signal:ctrl.signal });
      clearTimeout(to);
      if(!r.ok) continue;
      const j = await r.json();
      if(j && j.result && typeof j.result.value === 'number'){ return j.result.value / 1e9; }
    }catch(e){}
  }
  return null;
}
async function getPool(){
  const now = Date.now();
  if(poolCache.ok && now - poolCache.ts < 30000) return poolCache;   // cache 30s
  const [sol, usd] = await Promise.all([fetchPoolSol(), fetchSolPriceUsd()]);
  poolCache = {
    sol: (sol!=null? sol : poolCache.sol),
    usd: (usd!=null? usd : poolCache.usd),
    ts: now,
    ok: (sol!=null)
  };
  return poolCache;
}
// warm it on boot + refresh in the background
getPool(); setInterval(getPool, 30000);

// ---------- persistent leaderboard (accounts keyed by lowercase name) ----------
// ONE-TIME RESET: bump this string to wipe ALL stored accounts on the next deploy.
// (Leave it alone afterwards — accounts persist normally going forward.)
const RESET_TOKEN = 'reset-2026-06-15b';   // bump this string ONLY when you want a one-time wipe
const RESET_FLAG  = LB_FILE + '.reset';
let board = {};   // name -> { name, wins, gold, xp, height, ... }
try { board = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {}; } catch (e) { board = {}; }
// if we haven't applied this reset token yet, clear the board exactly once.
try {
  let done = '';
  try { done = fs.readFileSync(RESET_FLAG, 'utf8'); } catch(e){}
  if (done !== RESET_TOKEN) {
    board = {};
    try { fs.writeFileSync(LB_FILE, '{}'); } catch(e){}
    try { fs.writeFileSync(RESET_FLAG, RESET_TOKEN); } catch(e){}
    console.log('Leaderboard wiped (one-time reset '+RESET_TOKEN+').');
  }
} catch(e){}
let saveTimer = null;
function saveSoon(){ if(saveTimer) return; saveTimer = setTimeout(()=>{ saveTimer=null;
  try { fs.writeFileSync(LB_FILE, JSON.stringify(board)); } catch(e){} }, 1500); }

function clampNum(v){ v = Number(v)||0; if(!isFinite(v)) v=0; return Math.max(0, Math.min(v, 1e12)); }
// sane per-submission gain caps so nobody can spike a 24h board with one bogus payload
const GAIN_CAP = { wins:5, gold:50000, xp:60000, height:2000 };
function recordScore(p){
  const name = String(p.name||'').replace(/[<>]/g,'').slice(0,16).trim();
  if(!name) return;
  const key = name.toLowerCase();
  const today = dayId();
  const cur = board[key] || { name, wins:0, gold:0, xp:0, height:0, daily:0, weekly:0, ts:0,
    day:today, d_wins:0, d_gold:0, d_xp:0, d_height:0, base:{} };
  cur.name = name;
  if(!cur.base) cur.base = {};
  // new 24h window? reset the daily tallies and re-baseline.
  if(cur.day !== today){ cur.day=today; cur.d_wins=0; cur.d_gold=0; cur.d_xp=0; cur.d_height=0; cur.base={}; }

  for(const st of ['wins','gold','xp','height']){
    const v = clampNum(p[st]);
    const prevBest = cur[st]||0;
    // all-time best (monotonic up)
    cur[st] = Math.max(prevBest, v);
    // 24h gain = how much this all-time best grew since the last submission THIS window,
    // clamped so a single payload can't inflate the daily board.
    const baseline = (cur.base[st]==null) ? prevBest : cur.base[st];
    let gain = cur[st] - baseline;
    if(gain < 0) gain = 0;
    if(gain > (GAIN_CAP[st]||1e9)) gain = GAIN_CAP[st]||1e9;
    if(st==='height'){ // parkour: the 24h board is the best single run today, not a sum
      cur.d_height = Math.max(cur.d_height||0, Math.min(v, cur[st]));
    } else {
      cur['d_'+st] = (cur['d_'+st]||0) + gain;
    }
    cur.base[st] = cur[st];
  }
  cur.ts = Date.now();
  board[key] = cur;
  saveSoon();
}
const ALL_STATS = STATS.concat(REWARD_CATS);
function rowVal(r, stat){
  // daily cats only count rows whose window is the current day
  if(REWARD_CATS.includes(stat)) return (r.day===dayId()) ? (r[stat]||0) : 0;
  return r[stat]||0;
}
function topRows(stat, n){
  if(!ALL_STATS.includes(stat)) stat='wins';
  return Object.values(board)
    .map(r=>({ r, v:rowVal(r,stat) }))
    .sort((a,b)=>b.v-a.v)
    .slice(0, Math.max(1, Math.min(n||50, 100)))
    .map(({r})=>({ name:r.name, wins:r.wins, gold:r.gold, xp:r.xp, height:r.height, daily:r.daily, weekly:r.weekly,
                   d_wins:rowVal(r,'d_wins'), d_gold:rowVal(r,'d_gold'), d_xp:rowVal(r,'d_xp'), d_height:rowVal(r,'d_height') }));
}

// ---------- HTTP (leaderboard API) ----------
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
const server = http.createServer((req,res)=>{
  cors(res);
  if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');

  if(req.method==='GET' && u.pathname==='/top'){
    const rows = topRows(u.searchParams.get('stat')||'wins', parseInt(u.searchParams.get('n')||'50',10));
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ rows, count: Object.keys(board).length }));
  }
  if(req.method==='GET' && u.pathname==='/pool'){
    getPool().then(p=>{
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ sol: p.sol, usd: p.usd, ok: p.ok, wallet: PRIZE_WALLET }));
    }).catch(()=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({sol:null,ok:false,wallet:PRIZE_WALLET})); });
    return;
  }
  if(req.method==='GET' && u.pathname==='/rewards'){
    const cats={};
    for(const c of REWARD_CATS){
      cats[c]=topRows(c,10).map(r=>({ name:r.name, value:r[c]||0 })).filter(r=>r.value>0);
    }
    const msLeft = DAY_MS - (Date.now() % DAY_MS);   // until the 24h window resets (UTC)
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ cats, split:SPLIT, msLeft, day:dayId() }));
  }
  if(req.method==='POST' && u.pathname==='/score'){
    let body=''; let bad=false;
    req.on('data',c=>{ body+=c; if(body.length>2048){ bad=true; req.destroy(); } });
    req.on('end',()=>{ if(bad) return;
      try{ recordScore(JSON.parse(body)); }catch(e){}
      res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"ok":true}');
    });
    return;
  }
  if(u.pathname==='/' || u.pathname==='/health'){
    res.writeHead(200, {'Content-Type':'text/plain'});
    return res.end('TRENCH BEANZ server up. accounts='+Object.keys(board).length);
  }
  res.writeHead(404); res.end('not found');
});

// ---------- WebSocket (live multiplayer relay + REAL matchmaking queue) ----------
const wss = new WebSocketServer({ server });
const rooms = new Map();   // code -> { members:Map(id->{ws,name,fit,ready}), host, public, phase, countdown, timer }
let nextId = 1;
const MIN_START = 3;       // need at least this many REAL players to compete
const COUNTDOWN = 90;      // seconds lobby waits once MIN_START reached
const AUTOSTART = 20;      // instantly begin at a full lobby
const VOTE_PCT  = 0.65;    // if > this fraction of players vote, start immediately

function roomOf(code){ if(!rooms.has(code)) rooms.set(code,{ members:new Map(), host:null, public:code.startsWith('PUBLIC'), phase:'queue', countdown:0, timer:null, votes:new Set() }); return rooms.get(code); }
function publicRoom(){ // any public room still gathering (queue OR counting) with space
  for(const [code,r] of rooms) if(r.public && (r.phase==='queue'||r.phase==='counting') && r.members.size>0 && r.members.size<AUTOSTART) return code;
  return 'PUBLIC-'+Date.now().toString(36);
}
function bcast(r,msg,exceptId){ const s=JSON.stringify(msg); for(const [pid,m] of r.members) if(pid!==exceptId && m.ws.readyState===1) m.ws.send(s); }

function votesNeeded(n){ return Math.max(1, Math.ceil(n*VOTE_PCT)); }
function pushQueue(r){
  const n = r.members.size;
  // only count votes from players still present
  for(const v of [...r.votes]) if(!r.members.has(v)) r.votes.delete(v);
  bcast(r, { t:'queue', n, min:MIN_START, max:AUTOSTART, phase:r.phase,
             countdown: r.phase==='counting' ? Math.ceil(r.countdown) : null,
             votes: r.votes.size, votesNeeded: votesNeeded(n) });
}
function checkVotes(r){
  if(r.phase!=='counting' && r.phase!=='queue') return;
  const n=r.members.size;
  if(n>=MIN_START && r.votes.size > n*VOTE_PCT){ return beginMatch(r); }
}
function startCountdown(r){
  if(r.phase!=='queue') return;
  r.phase='counting'; r.countdown=COUNTDOWN; pushQueue(r);
}
function cancelCountdown(r){
  if(r.phase!=='counting') return;
  r.phase='queue'; r.countdown=0; if(r.timer){ clearInterval(r.timer); r.timer=null; } pushQueue(r);
}
function beginMatch(r){
  if(r.phase==='playing') return;
  r.phase='playing'; if(r.timer){ clearInterval(r.timer); r.timer=null; } r.votes.clear();
  // lock the roster order; first member is the authority for map picks
  bcast(r, { t:'begin', n:r.members.size });
}
function evalRoom(r){
  const n = r.members.size;
  if(r.phase==='queue'){
    if(n>=AUTOSTART) return beginMatch(r);
    if(n>=MIN_START) startCountdown(r);
  } else if(r.phase==='counting'){
    if(n>=AUTOSTART) return beginMatch(r);
    if(n<MIN_START) cancelCountdown(r);
  }
}
// drive countdowns once a second
setInterval(()=>{
  for(const [,r] of rooms){
    if(r.phase==='counting'){
      r.countdown-=1;
      if(r.countdown<=0){ beginMatch(r); }
      else pushQueue(r);
    }
  }
},1000);

wss.on('connection',(ws)=>{
  const id = nextId++; let code = null;
  ws.on('message',(raw)=>{
    if(raw.length>MAX_MSG) return;
    let m; try{ m=JSON.parse(raw); }catch(e){ return; }
    if(m.t==='hello'){
      code = (m.room==='PUBLIC') ? publicRoom() : String(m.room||'').slice(0,12).toUpperCase() || 'LOBBY';
      const r = roomOf(code);
      if(r.members.size>=AUTOSTART || r.phase==='playing'){ ws.send(JSON.stringify({t:'full'})); ws.close(); return; }
      const name = String(m.name||'bean').slice(0,16);
      r.members.set(id, { ws, name, fit:m.fit||null });
      if(!r.host) r.host = id;
      ws.send(JSON.stringify({ t:'welcome', id, host:r.host===id, min:MIN_START, max:AUTOSTART,
        players:[...r.members].filter(([pid])=>pid!==id).map(([pid,p])=>({id:pid,name:p.name,fit:p.fit})) }));
      bcast(r,{ t:'join', id, name, fit:m.fit||null }, id);
      pushQueue(r); evalRoom(r);
      return;
    }
    if(!code) return;
    const r = rooms.get(code); if(!r) return;
    // a private-room host can force the start early
    if(m.t==='forcestart' && r.host===id){ return beginMatch(r); }
    // vote-to-start (public lobbies): >65% of players → begin now
    if(m.t==='vote'){ r.votes.add(id); pushQueue(r); checkVotes(r); return; }
    if(m.t==='unvote'){ r.votes.delete(id); pushQueue(r); return; }
    if(m.t==='state'||m.t==='finish'||m.t==='dead'){ m.from=id; bcast(r,m,id); return; }
    if((m.t==='round'||m.t==='start') && r.host===id){ bcast(r,m,id); return; }
  });
  ws.on('close',()=>{
    if(!code) return; const r = rooms.get(code); if(!r) return;
    r.members.delete(id); bcast(r,{ t:'leave', id });
    if(r.host===id){ const next=[...r.members.keys()][0]; r.host=next||null; if(next)bcast(r,{t:'host',id:next}); }
    if(r.members.size===0){ if(r.timer)clearInterval(r.timer); rooms.delete(code); }
    else { pushQueue(r); evalRoom(r); }
  });
});
setInterval(()=>{ for(const ws of wss.clients) if(ws.readyState===1) ws.ping(); }, 25000);

server.listen(PORT, ()=>console.log('TRENCH BEANZ server (relay + leaderboard) on :'+PORT));
