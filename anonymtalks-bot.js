/**
 * anonymtalks-bot-v4.js
 * AnonymTalks — Anonymous 1:1 Chat Telegram Bot
 *
 * V4 Upgrades:
 *  ✅ Admin-only dashboard (other users CANNOT access)
 *  ✅ Admin can add/edit/delete bots in "Our Bots" section
 *  ✅ Real stats (total users, chats, messages, active now)
 *  ✅ Premium via Telegram Stars (native, no third party)
 *  ✅ Fixed bot page layout (no blank spaces, clean intro)
 *  ✅ Secure: ADMIN_IDS env-controlled, no public dashboard exposure
 */

require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const fs     = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const express   = require('express');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const DB_FILE      = process.env.DB_FILE      || './anonymtalks.db';
const BOT_USERNAME = process.env.BOT_USERNAME || 'AnonymTalksBot';
const PORT         = parseInt(process.env.PORT || '3000');
// Secret for web dashboard API — set a strong random value in .env
const DASH_SECRET  = process.env.DASH_SECRET  || 'change_me_in_env';
const WEBAPP_URL   = process.env.WEBAPP_URL   || '';

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN missing'); process.exit(1); }

// ─── PREMIUM PLANS ───────────────────────────────────────────────────────────
const PREMIUM_PLANS = {
  vip: {
    label:       'VIP',
    stars:       50,
    days:        30,
    tier:        1,
    emoji:       '⭐',
    perks: [
      '⚡ Priority queue matching',
      '🏷 Interest-based matching',
      '🎭 Mood-based matching',
      '🎫 3 queue jumps / day',
    ],
  },
  premium: {
    label:       'Premium',
    stars:       100,
    days:        30,
    tier:        2,
    emoji:       '👑',
    perks: [
      'Everything in VIP',
      '🌐 Language filter',
      '👁 See partner mood before connecting',
      '⏰ 30-min idle timeout (vs 15 min)',
      '🚀 Highest queue priority',
    ],
  },
};

// ─── DATABASE ─────────────────────────────────────────────────────────────────
class Database {
  constructor(filename) { this.filename = filename; this.db = null; }

  async init() {
    const SQL = await initSqlJs();
    this.db = fs.existsSync(this.filename)
      ? new SQL.Database(fs.readFileSync(this.filename))
      : new SQL.Database();
  }

  save() {
    if (this.db) fs.writeFileSync(this.filename, Buffer.from(this.db.export()));
  }

  prepare(sql) {
    const { db } = this;
    const save   = () => this.save();
    return {
      run: (...p) => { try { db.run(sql, p); save(); } catch(e) { console.error('SQL.run:', e.message); } },
      get: (...p) => { try { const s = db.prepare(sql); s.bind(p); const r = s.step() ? s.getAsObject() : null; s.free(); return r; } catch(e) { return null; } },
      all: (...p) => { try { const s = db.prepare(sql); s.bind(p); const r = []; while (s.step()) r.push(s.getAsObject()); s.free(); return r; } catch(e) { return []; } },
    };
  }

  close() { this.save(); if (this.db) this.db.close(); }
}

let db = null;

async function initDB() {
  db = new Database(DB_FILE);
  await db.init();
  const exec = sql => db.prepare(sql).run();

  exec(`CREATE TABLE IF NOT EXISTS users (
    anon_id         TEXT PRIMARY KEY,
    tg_id           INTEGER DEFAULT NULL,
    rating_sum      INTEGER DEFAULT 0,
    rating_count    INTEGER DEFAULT 0,
    interests       TEXT DEFAULT NULL,
    mood            TEXT DEFAULT NULL,
    language        TEXT DEFAULT 'any',
    gender          TEXT DEFAULT NULL,
    premium         INTEGER DEFAULT 0,
    vip_tier        INTEGER DEFAULT 0,
    premium_expires TEXT DEFAULT NULL,
    last_bonus_date TEXT DEFAULT NULL,
    chat_count      INTEGER DEFAULT 0,
    streak_days     INTEGER DEFAULT 0,
    last_chat_date  TEXT DEFAULT NULL,
    total_messages  INTEGER DEFAULT 0,
    referral_code   TEXT DEFAULT NULL,
    referred_by     TEXT DEFAULT NULL,
    referral_count  INTEGER DEFAULT 0,
    banned          INTEGER DEFAULT 0,
    ban_reason      TEXT DEFAULT NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    country         TEXT DEFAULT NULL
  )`);

  exec(`CREATE TABLE IF NOT EXISTS complaints (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT, reporter_anon TEXT, accused_anon TEXT,
    reason TEXT, excerpt TEXT, severity INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT, anon_a TEXT, anon_b TEXT,
    started_at TEXT, ended_at TEXT, msg_count INTEGER DEFAULT 0, end_reason TEXT
  )`);

  exec(`CREATE TABLE IF NOT EXISTS referrals (
    code TEXT PRIMARY KEY, owner_anon TEXT, used_count INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS bot_stats (
    key TEXT PRIMARY KEY, value INTEGER DEFAULT 0
  )`);

  exec(`CREATE TABLE IF NOT EXISTS managed_bots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    username    TEXT NOT NULL,
    description TEXT DEFAULT '',
    features    TEXT DEFAULT '',
    category    TEXT DEFAULT 'General',
    link        TEXT NOT NULL,
    icon        TEXT DEFAULT '🤖',
    active      INTEGER DEFAULT 1,
    sort_order  INTEGER DEFAULT 0,
    added_at    TEXT DEFAULT (datetime('now'))
  )`);

  exec(`CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id        INTEGER, anon_id TEXT, plan TEXT,
    stars        INTEGER, payload TEXT,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now')),
    completed_at TEXT DEFAULT NULL
  )`);

  ['total_users','total_chats','total_messages','active_today'].forEach(k => {
    if (!db.prepare('SELECT key FROM bot_stats WHERE key=?').get(k))
      db.prepare('INSERT INTO bot_stats(key,value) VALUES(?,0)').run(k);
  });
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const makeAnonId       = () => crypto.randomBytes(9).toString('hex');
const makeReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function ensureUserRow(anon_id, tg_id = null) {
  const r = db.prepare('SELECT anon_id FROM users WHERE anon_id=?').get(anon_id);
  if (!r) {
    const code = makeReferralCode();
    db.prepare('INSERT INTO users(anon_id,tg_id,referral_code) VALUES(?,?,?)').run(anon_id, tg_id, code);
    db.prepare('INSERT OR IGNORE INTO referrals(code,owner_anon,used_count) VALUES(?,?,0)').run(code, anon_id);
    db.prepare("UPDATE bot_stats SET value=value+1 WHERE key='total_users'").run();
  } else if (tg_id) {
    db.prepare('UPDATE users SET tg_id=? WHERE anon_id=?').run(tg_id, anon_id);
  }
}

function getUser(anon_id, tg_id = null) {
  ensureUserRow(anon_id, tg_id);
  return db.prepare('SELECT * FROM users WHERE anon_id=?').get(anon_id);
}

function getRating(anon_id) {
  const r = getUser(anon_id);
  if (!r || !r.rating_count) return 0;
  return Number((r.rating_sum / r.rating_count).toFixed(1));
}

function saveRating(anon_id, value) {
  ensureUserRow(anon_id);
  db.prepare('UPDATE users SET rating_sum=rating_sum+?,rating_count=rating_count+1 WHERE anon_id=?').run(value, anon_id);
}

function saveComplaint(reporter, accused, reason, excerpt, severity = 0) {
  db.prepare('INSERT INTO complaints(timestamp,reporter_anon,accused_anon,reason,excerpt,severity) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), reporter, accused, reason, excerpt, severity);
}

function updateStreak(anon_id) {
  const u         = getUser(anon_id);
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let s = 1;
  if (u.last_chat_date === yesterday) s = (u.streak_days || 0) + 1;
  else if (u.last_chat_date === today) s = u.streak_days || 1;
  db.prepare('UPDATE users SET streak_days=?,last_chat_date=?,chat_count=chat_count+1 WHERE anon_id=?').run(s, today, anon_id);
  return s;
}

function logChat(chatId, aA, aB, sa, ea, mc, er) {
  db.prepare('INSERT INTO chat_logs(chat_id,anon_a,anon_b,started_at,ended_at,msg_count,end_reason) VALUES(?,?,?,?,?,?,?)').run(chatId,aA,aB,sa,ea,mc,er);
  db.prepare("UPDATE bot_stats SET value=value+1 WHERE key='total_chats'").run();
}

function checkPremiumExpiry(anon_id) {
  const u = getUser(anon_id);
  if (u.vip_tier > 0 && u.premium_expires && new Date(u.premium_expires) < new Date()) {
    db.prepare('UPDATE users SET vip_tier=0,premium=0,premium_expires=NULL WHERE anon_id=?').run(anon_id);
    return false;
  }
  return u.vip_tier > 0;
}

// Real-time stat helpers
const getStat = key => db.prepare("SELECT value FROM bot_stats WHERE key=?").get(key)?.value || 0;
const getTotalUsers  = () => getStat('total_users');
const getTotalChats  = () => getStat('total_chats');
const getTotalMsgs   = () => getStat('total_messages');
const getActiveToday = () => {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT COUNT(*) as c FROM users WHERE last_chat_date=?").get(today)?.c || 0;
};

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
const waitingPool = { random: [], female: [], male: [], other: [] };
const activeChats = new Map();
const tgToAnon    = {};
const spamTracker = {};
const gameStates  = new Map();

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MOODS = ['😊 Happy','😔 Sad','🤔 Philosophical','🔥 Flirty','😂 Funny','💪 Motivational','😴 Chill'];
const INTEREST_TAGS = ['🎵 Music','🎮 Gaming','📚 Books','🏋️ Fitness','🎨 Art','💻 Tech','🍕 Food','✈️ Travel','💰 Crypto','🎬 Movies','🌿 Nature','🧠 Philosophy'];
const LANGUAGES = ['Any','English','Hindi','Spanish','Arabic','Russian','French'];

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const lobbyKb  = () => Markup.keyboard([
  ['🚀 Random Chat', '😍 Flirt Chat'],
  ['🔍 Match by Interest', '🎭 Match by Mood'],
  ['👤 Profile', '🎁 Daily Bonus'],
  ['📊 Leaderboard', '🎮 Mini Games'],
  ['💎 Go Premium', '🔗 Refer & Earn'],
  ['🤖 Our Bots'],
]).resize();

const searchKb = () => Markup.keyboard([['❌ Cancel Search']]).resize();
const chatKb   = () => Markup.inlineKeyboard([
  [Markup.button.callback('👍 Rate Up','rate_5'), Markup.button.callback('👎 Rate Down','rate_1')],
  [Markup.button.callback('⛔ Report','complain'), Markup.button.callback('⏭ Next Chat','btn_next')],
]);
const endChatKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('⭐ Rate Partner','show_rating')],
  [Markup.button.callback('🔄 Find New Partner','btn_next'), Markup.button.callback('🏠 Lobby','go_lobby')],
]);

// ─── SESSION ──────────────────────────────────────────────────────────────────
function ensureSession(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.anon) {
    ctx.session.anon = {
      anon_id: makeAnonId(), inChat: false, chatId: null,
      searchingSince: null, awaitingComplaint: null,
      awaitingBotField: null, pendingBot: {},
      premium: false, vip_tier: 0, queueJump: 0,
    };
    ensureUserRow(ctx.session.anon.anon_id, ctx.from?.id);
  }
  return ctx.session.anon;
}

// ─── SECURITY: Admin check ────────────────────────────────────────────────────
const isAdmin = ctx => ADMIN_IDS.includes(ctx.from?.id);

// ─── MODERATION ───────────────────────────────────────────────────────────────
const MOD = {
  critical: /(?:minor|underage|age\s*\d{1,2}|kid|child|teen|13|14|15|16|17)[\s\S]{0,30}(?:sex|nude|porn|touch|naked)/i,
  threats:  /\b(i will kill|i will rape|i will hurt|shoot you|bomb|stab you|murder)\b/i,
  doxx:     /\b(your address|phone number|your location|your school|doxx)\b/i,
  hate:     /\b(nigger|faggot|kike|chink|wetback|spic)\b/i,
  spam:     /(.)\1{15,}|http[s]?:\/\/\S+/i,
};
function checkMod(text) {
  if (!text) return null;
  if (MOD.critical.test(text)) return { severity: 3, reason: 'sexual_with_minors' };
  if (MOD.threats.test(text))  return { severity: 3, reason: 'threats' };
  if (MOD.doxx.test(text))     return { severity: 2, reason: 'possible_doxx' };
  if (MOD.hate.test(text))     return { severity: 2, reason: 'hate_speech' };
  if (MOD.spam.test(text))     return { severity: 1, reason: 'spam_or_link' };
  return null;
}
function isSpamming(tg_id) {
  const now = Date.now();
  if (!spamTracker[tg_id] || spamTracker[tg_id].resetAt < now) {
    spamTracker[tg_id] = { count: 1, resetAt: now + 3000 };
    return false;
  }
  return ++spamTracker[tg_id].count > 5;
}

// ─── POOL HELPERS ─────────────────────────────────────────────────────────────
function removeFromPools(anon_id) {
  ['random','male','female','other'].forEach(k => {
    waitingPool[k] = waitingPool[k].filter(u => u.anon_id !== anon_id);
  });
}
function interestScore(a, b) {
  if (!a || !b) return 0;
  const sA = new Set(a.split(','));
  let n = 0; b.split(',').forEach(x => { if (sA.has(x)) n++; }); return n;
}
function tryMatch(item, genderPref) {
  const pools = [];
  if (genderPref) pools.push(waitingPool[genderPref]);
  pools.push(waitingPool.random, waitingPool.male, waitingPool.female, waitingPool.other);
  let best = -1, bestPool = null, bestIdx = -1;
  for (const pool of pools) {
    if (!pool) continue;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]; if (c.anon_id === item.anon_id) continue;
      let score = 0;
      if (item.mood && c.mood === item.mood) score += 3;
      score += interestScore(item.interests, c.interests) * 2;
      score += (c.premium || 0);
      if (score > best) { best = score; bestPool = pool; bestIdx = i; }
    }
  }
  if (bestIdx >= 0) return bestPool.splice(bestIdx, 1)[0];
  return null;
}

// ─── CONNECT PAIR ─────────────────────────────────────────────────────────────
async function connectPair(a, b) {
  const chatId = crypto.randomBytes(6).toString('hex');
  const start  = Date.now();
  removeFromPools(a.anon_id); removeFromPools(b.anon_id);
  activeChats.set(chatId, { a_anon:a.anon_id, b_anon:b.anon_id, a_tg:a.tg_id, b_tg:b.tg_id, startedAt:start, a_msgs:0, b_msgs:0, idleTimer:null });
  tgToAnon[a.tg_id] = { anon:a.anon_id, chatId, partnerAnon:b.anon_id, partnerTg:b.tg_id, startedAt:start };
  tgToAnon[b.tg_id] = { anon:b.anon_id, chatId, partnerAnon:a.anon_id, partnerTg:a.tg_id, startedAt:start };
  const uA = getUser(a.anon_id), uB = getUser(b.anon_id);
  const sA = updateStreak(a.anon_id), sB = updateStreak(b.anon_id);
  try { await bot.telegram.sendMessage(a.tg_id, buildFoundMsg(uB, sA), { parse_mode:'Markdown', protect_content:true, ...chatKb() }); } catch(e) {}
  try { await bot.telegram.sendMessage(b.tg_id, buildFoundMsg(uA, sB), { parse_mode:'Markdown', protect_content:true, ...chatKb() }); } catch(e) {}
  const chat = activeChats.get(chatId);
  if (chat) chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), 15 * 60 * 1000);
}

function buildFoundMsg(p, streak) {
  const r    = p ? getRating(p.anon_id) : 0;
  const stars = r > 0 ? '⭐'.repeat(Math.round(r)) : 'unrated';
  return [
    '🦋 *Partner found! Say hi 👋*', '',
    '*─── Partner Info ───*',
    p?.interests ? `🏷 *Interests:* ${p.interests}` : '🏷 *Interests:* not set',
    p?.mood      ? `🎭 *Mood:* ${p.mood}` : '',
    `🏆 *Rating:* ${r} ${stars}`,
    '',
    `🔥 *Your streak:* ${streak} day(s)`, '',
    `_/next · /stop · /game · /report_`,
  ].filter(Boolean).join('\n');
}

// ─── END CHAT ─────────────────────────────────────────────────────────────────
async function endChat(chatId, reason = 'ended') {
  const chat = activeChats.get(chatId); if (!chat) return;
  const secs = Math.floor((Date.now() - chat.startedAt) / 1000);
  const total = (chat.a_msgs || 0) + (chat.b_msgs || 0);
  if (chat.idleTimer) clearTimeout(chat.idleTimer);
  activeChats.delete(chatId);
  const txt = [`💬 *Chat ended!*`, `⏱ ${Math.floor(secs/60)}m ${secs%60}s · 📨 ${total} messages`,
    reason === 'idle_timeout' ? '😴 Ended due to inactivity.' : '', '', 'What would you like to do?']
    .filter(Boolean).join('\n');
  for (const id of [chat.a_tg, chat.b_tg]) {
    try { await bot.telegram.sendMessage(id, txt, { parse_mode:'Markdown', ...endChatKb() }); } catch(e) {}
    delete tgToAnon[id];
  }
  logChat(chatId, chat.a_anon, chat.b_anon, new Date(chat.startedAt).toISOString(), new Date().toISOString(), total, reason);
  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.a_msgs, chat.a_anon);
  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.b_msgs, chat.b_anon);
  db.prepare("UPDATE bot_stats SET value=value+? WHERE key='total_messages'").run(total);
  gameStates.delete(chatId);
}

async function endChatForUser(anon_id, reason = 'ended') {
  for (const [id, c] of activeChats.entries())
    if (c.a_anon === anon_id || c.b_anon === anon_id) { await endChat(id, reason); return; }
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────
async function startSearch(ctx, opts = {}) {
  const s = ensureSession(ctx);
  if (s.inChat) return ctx.reply('⚠️ End your current chat first (/stop).');
  checkPremiumExpiry(s.anon_id);
  const u = getUser(s.anon_id);
  if (u.banned) return ctx.reply(`🚫 You are banned. Reason: ${u.ban_reason || 'rule violation'}`);
  s.searchingSince = Date.now();
  removeFromPools(s.anon_id);
  const item = { anon_id:s.anon_id, tg_id:ctx.from.id, gender:u.gender,
    premium:(s.queueJump>0)?2:(u.premium||0), joinedAt:Date.now(),
    mood:u.mood, interests:u.interests, language:u.language||'any' };
  if (s.queueJump > 0) s.queueJump--;
  const gp = opts.genderPref || null;
  if (gp) waitingPool[gp].push(item); else waitingPool.random.push(item);
  await ctx.reply('🔍 Searching for a partner...', searchKb());
  let elapsed = 0, wide = false;
  const poll = setInterval(async () => {
    elapsed += 1000;
    if (!s.searchingSince || tgToAnon[ctx.from.id]?.chatId) { clearInterval(poll); return; }
    const match = tryMatch(item, gp);
    if (match) {
      clearInterval(poll); s.searchingSince = null;
      removeFromPools(s.anon_id); s.inChat = true;
      await connectPair(item, match); return;
    }
    if (elapsed === 20000 && !wide && s.searchingSince) { wide = true; await ctx.reply('⏳ Still searching — widening filters...').catch(() => {}); }
    if (elapsed >= 60000) {
      clearInterval(poll); removeFromPools(s.anon_id); s.searchingSince = null;
      await ctx.reply('🌱 *Nobody searching right now!*\n\nTry again in a few minutes.\n🔗 Invite friends: /refer',
        { parse_mode:'Markdown', ...lobbyKb() }).catch(() => {});
    }
  }, 1000);
}

// ─── MINI GAMES ───────────────────────────────────────────────────────────────
const TRIVIA = [
  { q:'What planet is closest to the sun?',a:'mercury',hint:'Starts with M' },
  { q:'How many continents?',a:'7',hint:'Single digit' },
  { q:'What gas do plants absorb?',a:'co2',hint:'Carbon...' },
  { q:'Who painted the Mona Lisa?',a:'da vinci',hint:'Italian artist' },
  { q:'Largest ocean?',a:'pacific',hint:'Starts with P' },
  { q:'Capital of Japan?',a:'tokyo',hint:'Modern megacity' },
  { q:'Fastest land animal?',a:'cheetah',hint:'Big cat' },
];
const WYR = [
  'Would you rather have the ability to fly OR be invisible?',
  'Would you rather live in the future OR the past?',
  'Would you rather be famous OR be rich in private?',
  'Would you rather speak all languages OR play all instruments?',
];
const TOD = [
  ["What's your most embarrassing memory?", 'Say "I am the champion" in a voice message!'],
  ["One lie you've told recently?", 'Type with your eyes closed!'],
  ["Your guilty pleasure?", 'Share your most used emoji!'],
];

async function startGame(chatId, name, tgA, tgB) {
  let msg = '', state = {};
  if (name === 'trivia') {
    const q = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
    state = { type:'trivia', question:q, answered:false };
    msg   = `🎯 *Trivia!*\n\n❓ ${q.q}\n💡 Hint: ${q.hint}\n\nFirst correct answer wins!`;
  } else if (name === 'wyr') {
    const q = WYR[Math.floor(Math.random() * WYR.length)];
    state = { type:'wyr', question:q };
    msg   = `🤔 *Would You Rather?*\n\n${q}\n\nBoth reply with your choice!`;
  } else if (name === 'tod') {
    const p = TOD[Math.floor(Math.random() * TOD.length)];
    state = { type:'tod', truth:p[0], dare:p[1] };
    msg   = `🎲 *Truth or Dare?*\n\n🔍 Truth: ${p[0]}\n💥 Dare: ${p[1]}\n\nPick one!`;
  } else if (name === 'wordchain') {
    state = { type:'wordchain', lastWord:null, usedWords:[], turn:tgA };
    msg   = `🔤 *Word Chain!*\nEach word must start with the last letter of the previous.\nYou start:`;
  }
  gameStates.set(chatId, state);
  for (const id of [tgA, tgB]) try { await bot.telegram.sendMessage(id, msg, { parse_mode:'Markdown' }); } catch(e) {}
}

async function handleGameInput(chatId, tg_id, text) {
  const game = gameStates.get(chatId); if (!game) return false;
  const chat = activeChats.get(chatId); if (!chat) return false;
  const partner = chat.a_tg === tg_id ? chat.b_tg : chat.a_tg;
  if (game.type === 'trivia' && !game.answered) {
    if (text.toLowerCase().trim() === game.question.a) {
      game.answered = true; gameStates.delete(chatId);
      try { await bot.telegram.sendMessage(tg_id, `✅ *Correct!* 🎉 Use /game to play again.`, { parse_mode:'Markdown' }); } catch(e) {}
      try { await bot.telegram.sendMessage(partner, `❌ Partner got it! Answer: *${game.question.a}*`, { parse_mode:'Markdown' }); } catch(e) {}
      return true;
    }
  }
  if (game.type === 'wordchain') {
    if (game.turn !== tg_id) return true;
    const w = text.toLowerCase().trim();
    if (game.lastWord && w[0] !== game.lastWord[game.lastWord.length-1]) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Must start with "${game.lastWord[game.lastWord.length-1].toUpperCase()}"!`); } catch(e) {}
      return true;
    }
    if (game.usedWords.includes(w)) {
      try { await bot.telegram.sendMessage(tg_id, `❌ Already used!`); } catch(e) {}
      return true;
    }
    game.lastWord = w; game.usedWords.push(w); game.turn = partner;
    try { await bot.telegram.sendMessage(partner, `🔤 Partner: *${w}*\nYour turn → start with *${w[w.length-1].toUpperCase()}*`, { parse_mode:'Markdown' }); } catch(e) {}
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD (Telegram)
// ═══════════════════════════════════════════════════════════════════════════════

async function showAdminDashboard(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('🚫 Unauthorized. This command is admin-only.');
  const tu = getTotalUsers(), tc = getTotalChats(), tm = getTotalMsgs(), at = getActiveToday();
  const an = activeChats.size, sn = Object.values(waitingPool).reduce((a,b) => a+b.length, 0);
  const bn  = db.prepare('SELECT COUNT(*) as c FROM users WHERE banned=1').get()?.c || 0;
  const oc  = db.prepare('SELECT COUNT(*) as c FROM complaints WHERE resolved=0').get()?.c || 0;
  const mb  = db.prepare('SELECT COUNT(*) as c FROM managed_bots WHERE active=1').get()?.c || 0;
  const pu  = db.prepare('SELECT COUNT(*) as c FROM users WHERE vip_tier>0').get()?.c || 0;
  const pp  = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status='pending'").get()?.c || 0;
  const rev = db.prepare("SELECT COALESCE(SUM(stars),0) as s FROM payments WHERE status='completed'").get()?.s || 0;

  await ctx.reply(
    `🛠 *Admin Dashboard*\n\n` +
    `📊 *Live Stats*\n` +
    `├ 👥 Total Users: *${tu}*\n` +
    `├ 💬 Total Chats: *${tc}*\n` +
    `├ 📨 Total Messages: *${tm}*\n` +
    `├ 🟢 Active Chats: *${an}*\n` +
    `├ 🔍 Searching: *${sn}*\n` +
    `└ 📅 Active Today: *${at}*\n\n` +
    `💎 *Revenue*\n` +
    `├ Premium Users: *${pu}*\n` +
    `├ Pending Payments: *${pp}*\n` +
    `└ Total Stars Earned: *${rev}⭐*\n\n` +
    `🔧 *Moderation*\n` +
    `├ 🚫 Banned: *${bn}*\n` +
    `└ 📋 Open Complaints: *${oc}*\n\n` +
    `🤖 *Bots*\n` +
    `└ Managed Bots: *${mb}*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Complaints', 'adm_complaints'), Markup.button.callback('🚫 Banned', 'adm_banned')],
        [Markup.button.callback('🤖 Manage Bots', 'adm_bots'),     Markup.button.callback('💰 Payments', 'adm_payments')],
        [Markup.button.callback('📊 Top Users', 'adm_topusers'),   Markup.button.callback('🔄 Refresh', 'adm_refresh')],
      ])
    }
  );
}

async function showAdminBots(ctx) {
  if (!isAdmin(ctx)) return;
  const bots = db.prepare('SELECT * FROM managed_bots ORDER BY sort_order ASC, added_at DESC').all();
  if (!bots.length) {
    return ctx.reply('🤖 *Manage Bots*\n\nNo bots added yet.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add New Bot', 'adm_addbot')],
        [Markup.button.callback('« Back', 'adm_back')],
      ])
    });
  }
  const lines = bots.map((b, i) =>
    `${i+1}. ${b.active ? '🟢' : '🔴'} *${b.name}* · @${b.username}\n   📁 ${b.category} | ${(b.description||'').slice(0,50)}`
  ).join('\n\n');

  const rows = bots.map(b => [
    Markup.button.callback(`${b.active ? '🔴 Disable' : '🟢 Enable'} ${b.name}`, `adm_tbotstat_${b.id}`),
    Markup.button.callback(`🗑`, `adm_delbot_${b.id}`),
  ]);

  await ctx.reply(`🤖 *Managed Bots (${bots.length})*\n\n${lines}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...rows,
      [Markup.button.callback('➕ Add New Bot', 'adm_addbot')],
      [Markup.button.callback('« Back to Dashboard', 'adm_back')],
    ])
  });
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
bot.command('admin', showAdminDashboard);

bot.command('ban', async ctx => {
  if (!isAdmin(ctx)) return;
  const a = ctx.message.text.split(' ');
  if (a.length < 2) return ctx.reply('Usage: /ban <anon_id> [reason]');
  db.prepare('UPDATE users SET banned=1,ban_reason=? WHERE anon_id=?').run(a.slice(2).join(' ')||'Rule violation', a[1]);
  await ctx.reply(`✅ Banned \`${a[1].slice(0,8)}...\``, { parse_mode:'Markdown' });
});

bot.command('unban', async ctx => {
  if (!isAdmin(ctx)) return;
  const a = ctx.message.text.split(' ');
  if (a.length < 2) return ctx.reply('Usage: /unban <anon_id>');
  db.prepare('UPDATE users SET banned=0,ban_reason=NULL WHERE anon_id=?').run(a[1]);
  await ctx.reply(`✅ Unbanned \`${a[1].slice(0,8)}...\``, { parse_mode:'Markdown' });
});

bot.command('broadcast', async ctx => {
  if (!isAdmin(ctx)) return;
  const msg = ctx.message.text.replace('/broadcast','').trim();
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const users = db.prepare('SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND banned=0').all();
  let sent=0, failed=0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.tg_id, `📢 *Announcement*\n\n${msg}`, { parse_mode:'Markdown' }); sent++; }
    catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  await ctx.reply(`📢 Done! ✅ ${sent} sent, ❌ ${failed} failed.`);
});

// ─── ADMIN CALLBACKS ──────────────────────────────────────────────────────────
bot.action('adm_refresh', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery('Refreshed!');
  await ctx.deleteMessage().catch(() => {});
  await showAdminDashboard(ctx);
});
bot.action('adm_back', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await showAdminDashboard(ctx);
});
bot.action('adm_bots', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery(); await showAdminBots(ctx);
});
bot.action('adm_complaints', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM complaints WHERE resolved=0 ORDER BY timestamp DESC LIMIT 10').all();
  if (!rows.length) return ctx.reply('✅ No open complaints!');
  const txt = rows.map(r => `#${r.id} | Sev:${r.severity} | ${r.reason}\n📝 "${(r.excerpt||'').slice(0,60)}"`).join('\n\n');
  await ctx.reply(`📋 *Open Complaints:*\n\n${txt}`, { parse_mode:'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]]) });
});
bot.action('adm_banned', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT * FROM users WHERE banned=1 LIMIT 10').all();
  if (!rows.length) return ctx.reply('No banned users.');
  const txt = rows.map(r => `• \`${r.anon_id.slice(0,8)}...\` — ${r.ban_reason||'no reason'}`).join('\n');
  await ctx.reply(`🚫 *Banned Users:*\n\n${txt}`, { parse_mode:'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]]) });
});
bot.action('adm_topusers', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const rows = db.prepare('SELECT anon_id,chat_count,total_messages,streak_days,vip_tier FROM users ORDER BY chat_count DESC LIMIT 10').all();
  const txt = rows.map((r,i) =>
    `${i+1}. \`${r.anon_id.slice(0,8)}...\` | 💬${r.chat_count} | 📨${r.total_messages} | 🔥${r.streak_days}d | ${r.vip_tier>0?'💎':'🆓'}`
  ).join('\n');
  await ctx.reply(`📊 *Top Users*\n\n${txt}`, { parse_mode:'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]]) });
});
bot.action('adm_payments', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const pays = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 20').all();
  if (!pays.length) return ctx.reply('No payments yet.');
  const txt = pays.map(p =>
    `${p.status==='completed'?'✅':'⏳'} ${p.plan} | ⭐${p.stars} | tg:${p.tg_id} | ${(p.created_at||'').slice(0,10)}`
  ).join('\n');
  await ctx.reply(`💰 *Payments*\n\n${txt}`, { parse_mode:'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'adm_back')]]) });
});

// ─── ADMIN ADD BOT FLOW ───────────────────────────────────────────────────────
bot.action('adm_addbot', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  s.awaitingBotField = 'name'; s.pendingBot = {};
  await ctx.reply('➕ *Add Bot — Step 1/6*\n\nEnter the *bot name* (e.g. "GhostMusic"):',
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_canceladd')]]) });
});
bot.action('adm_canceladd', async ctx => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery('Cancelled');
  const s = ensureSession(ctx); s.awaitingBotField = null; s.pendingBot = {};
  await ctx.reply('❌ Cancelled.'); await showAdminDashboard(ctx);
});
bot.action(/adm_tbotstat_(\d+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const id = parseInt(ctx.match[1]);
  const b  = db.prepare('SELECT * FROM managed_bots WHERE id=?').get(id);
  if (!b) return;
  db.prepare('UPDATE managed_bots SET active=? WHERE id=?').run(b.active ? 0 : 1, id);
  await ctx.reply(`${b.active ? '🔴 Disabled' : '🟢 Enabled'}: *${b.name}*`, { parse_mode:'Markdown' });
  await showAdminBots(ctx);
});
bot.action(/adm_delbot_(\d+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const id = parseInt(ctx.match[1]);
  const b  = db.prepare('SELECT * FROM managed_bots WHERE id=?').get(id);
  if (!b) return;
  db.prepare('DELETE FROM managed_bots WHERE id=?').run(id);
  await ctx.reply(`🗑 Deleted: *${b.name}*`, { parse_mode:'Markdown' });
  await showAdminBots(ctx);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PREMIUM — TELEGRAM STARS
// ═══════════════════════════════════════════════════════════════════════════════
async function showPremiumPage(ctx) {
  const s = ensureSession(ctx);
  checkPremiumExpiry(s.anon_id);
  const u   = getUser(s.anon_id);
  const tier = u.vip_tier || 0;
  const statusLine = tier > 0
    ? `✅ *Current plan:* ${['','⭐ VIP','👑 Premium'][tier]} · expires ${(u.premium_expires||'').slice(0,10)}\n`
    : `🆓 *Current plan:* Free\n`;

  await ctx.reply(
    `💎 *AnonymTalks Premium*\n\n${statusLine}\n` +
    `*⭐ VIP — 50 Telegram Stars / month*\n` +
    `├ ⚡ Priority queue matching\n├ 🏷 Interest-based matching\n├ 🎭 Mood-based matching\n└ 🎫 3 queue jumps/day\n\n` +
    `*👑 Premium — 100 Telegram Stars / month*\n` +
    `├ Everything in VIP\n├ 🌐 Language filter\n├ 👁 See partner mood before connecting\n└ ⏰ 30-min idle timeout\n\n` +
    `💡 *Telegram Stars* are purchased inside Telegram.\nGo to: Settings → My Stars → Get Stars.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Get VIP — 50 Stars', 'buy_vip'), Markup.button.callback('👑 Get Premium — 100 Stars', 'buy_premium')],
        tier > 0 ? [Markup.button.callback('❌ Cancel Subscription', 'cancel_premium')] : [Markup.button.callback('ℹ️ What are Stars?', 'stars_info')],
      ])
    }
  );
}

async function sendInvoice(ctx, plan) {
  const s    = ensureSession(ctx);
  const pd   = PREMIUM_PLANS[plan]; if (!pd) return;
  const payload = `${plan}_${s.anon_id}_${Date.now()}`;
  db.prepare('INSERT INTO payments(tg_id,anon_id,plan,stars,payload,status) VALUES(?,?,?,?,?,?)').run(ctx.from.id, s.anon_id, plan, pd.stars, payload, 'pending');
  try {
    await ctx.replyWithInvoice({
      title:         `${pd.emoji} ${pd.label} — AnonymTalks`,
      description:   pd.perks.join('\n') + `\n\nValid for ${pd.days} days.`,
      payload,
      currency:      'XTR',
      prices:        [{ label: pd.label, amount: pd.stars }],
      provider_token:'',
    });
  } catch(e) {
    await ctx.reply(`⚠️ Could not create invoice: ${e.message}\n\nMake sure bot payments are enabled via @BotFather.`);
  }
}

bot.action('buy_vip',     async ctx => { await ctx.answerCbQuery(); await sendInvoice(ctx, 'vip'); });
bot.action('buy_premium', async ctx => { await ctx.answerCbQuery(); await sendInvoice(ctx, 'premium'); });
bot.action('cancel_premium', async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  db.prepare('UPDATE users SET vip_tier=0,premium=0,premium_expires=NULL WHERE anon_id=?').run(s.anon_id);
  s.vip_tier = 0;
  await ctx.reply('❌ *Subscription cancelled.* You are now on the Free plan.', { parse_mode:'Markdown' });
});
bot.action('stars_info', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `⭐ *Telegram Stars*\n\n` +
    `Stars are Telegram's native currency — safe, instant, no third-party needed.\n\n` +
    `*How to get Stars:*\n1. Open Telegram\n2. Settings → My Stars\n3. Tap "Get Stars"\n4. Purchase via App Store / Google Play\n\n` +
    `*Pricing (approx):*\n• 50 Stars ≈ $1 / ₹85\n• 100 Stars ≈ $2 / ₹170`,
    { parse_mode:'Markdown' }
  );
});
bot.on('pre_checkout_query', async ctx => { try { await ctx.answerPreCheckoutQuery(true); } catch(e) {} });

// ─── OUR BOTS (public view) ────────────────────────────────────────────────────
async function showOurBots(ctx) {
  const bots = db.prepare('SELECT * FROM managed_bots WHERE active=1 ORDER BY sort_order ASC, added_at DESC').all();
  if (!bots.length) {
    return ctx.reply('🤖 *Our Bots*\n\nNo bots available right now. Check back soon!', { parse_mode:'Markdown', ...lobbyKb() });
  }
  const bycat = {};
  for (const b of bots) { if (!bycat[b.category]) bycat[b.category] = []; bycat[b.category].push(b); }
  let txt = `🤖 *Our Official Bots*\n_All bots below are made by our team._\n`;
  for (const [cat, items] of Object.entries(bycat)) {
    txt += `\n*${cat}*\n`;
    for (const b of items) txt += `• [${b.icon||'🤖'} ${b.name}](${b.link}) — ${(b.description||'No description').slice(0,60)}\n`;
  }
  const rows = [];
  const btns = bots.map(b => Markup.button.url(`${b.icon||'🤖'} ${b.name}`, b.link));
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i+2));
  await ctx.reply(txt, { parse_mode:'Markdown', disable_web_page_preview:true, ...Markup.inlineKeyboard(rows) });
}

// ─── MAIN BOT COMMANDS ────────────────────────────────────────────────────────
bot.start(async ctx => {
  const s = ensureSession(ctx);
  ensureUserRow(s.anon_id, ctx.from.id);
  const payload = ctx.startPayload;
  if (payload?.startsWith('ref_')) {
    const code = payload.replace('ref_','');
    const ref  = db.prepare('SELECT * FROM referrals WHERE code=?').get(code);
    if (ref && ref.owner_anon !== s.anon_id) {
      const u = getUser(s.anon_id);
      if (!u.referred_by) {
        db.prepare('UPDATE users SET referred_by=? WHERE anon_id=?').run(ref.owner_anon, s.anon_id);
        db.prepare('UPDATE referrals SET used_count=used_count+1 WHERE code=?').run(code);
        db.prepare('UPDATE users SET referral_count=referral_count+1 WHERE anon_id=?').run(ref.owner_anon);
        await ctx.reply('🎉 You joined via a referral link! Your friend earns a bonus.');
      }
    }
  }
  await ctx.reply(
    `👻 *Welcome to AnonymTalks!*\n\n` +
    `Chat anonymously with people around the world.\n` +
    `Your identity stays completely private — no names, no numbers.\n\n` +
    `*Get started:*\n` +
    `• 🚀 *Random Chat* — find a partner instantly\n` +
    `• 🔍 *Match by Interest* — find someone like you\n` +
    `• 💎 *Go Premium* — unlock priority & more\n\n` +
    `_/rules for community guidelines_`,
    { parse_mode:'Markdown', ...lobbyKb() }
  );
});

bot.command('stop', async ctx => {
  const s = ensureSession(ctx);
  if (s.searchingSince) { removeFromPools(s.anon_id); s.searchingSince = null; return ctx.reply('🛑 Search cancelled.', lobbyKb()); }
  if (!tgToAnon[ctx.from.id]?.chatId) return ctx.reply("🤷 You're not in a chat.", lobbyKb());
  await endChatForUser(s.anon_id, 'user_stop'); s.inChat = false;
  await ctx.reply('👋 Chat ended.', lobbyKb());
});
bot.command('next', async ctx => {
  const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) { await endChatForUser(s.anon_id, 'user_next'); s.inChat = false; }
  await startSearch(ctx, { mode:'random' });
});
bot.command('rules', async ctx => {
  await ctx.reply(
    `📜 *AnonymTalks Community Rules*\n\n` +
    `1️⃣ No sexual content involving minors — *instant permanent ban*\n` +
    `2️⃣ No threats or violence\n3️⃣ No doxxing (sharing personal info)\n` +
    `4️⃣ No spam or flooding\n5️⃣ No hate speech\n\n` +
    `Violations are auto-detected. Repeated reports = ban.\n_Be kind — real humans are here. 💙_`,
    { parse_mode:'Markdown' }
  );
});
bot.command('profile', async ctx => {
  const s = ensureSession(ctx); checkPremiumExpiry(s.anon_id);
  const u = getUser(s.anon_id); const r = getRating(s.anon_id);
  await ctx.reply([
    `👤 *Your Profile*`, '',
    `🆔 ID: \`${s.anon_id.slice(0,8)}...\``,
    `🏆 Rating: ${r} ${r>0?'⭐'.repeat(Math.round(r)):'unrated'}`,
    `💬 Chats: ${u.chat_count||0}`,
    `📨 Messages: ${u.total_messages||0}`,
    `🔥 Streak: ${u.streak_days||0} day(s)`,
    `🏷 Interests: ${u.interests||'not set'}`,
    `🎭 Mood: ${u.mood||'not set'}`,
    `🌐 Language: ${u.language||'any'}`,
    `💎 Tier: ${['🆓 Free','⭐ VIP','👑 Premium'][u.vip_tier||0]}`,
    u.premium_expires ? `⏳ Expires: ${u.premium_expires.slice(0,10)}` : '',
    `👥 Referrals: ${u.referral_count||0}`,
  ].filter(Boolean).join('\n'), { parse_mode:'Markdown' });
});
bot.command('bonus', async ctx => {
  const s = ensureSession(ctx);
  const today = new Date().toISOString().slice(0,10);
  const u = getUser(s.anon_id);
  if (u.last_bonus_date === today) return ctx.reply('⏰ Daily bonus already claimed! Come back tomorrow. 🌅');
  db.prepare('UPDATE users SET last_bonus_date=? WHERE anon_id=?').run(today, s.anon_id);
  s.queueJump = (s.queueJump||0) + 1;
  await ctx.reply(`🎁 *Daily Bonus Claimed!*\n\n✅ +1 Queue Jump Token added.\n🔥 Keep chatting daily!`, { parse_mode:'Markdown' });
});
bot.command('game', async ctx => {
  const m = tgToAnon[ctx.from.id]; if (!m) return ctx.reply('Start a chat first to play games! 🎮');
  const chat = activeChats.get(m.chatId); if (!chat) return ctx.reply('No active chat found.');
  if (gameStates.has(m.chatId)) return ctx.reply('🎮 A game is running!', Markup.inlineKeyboard([[Markup.button.callback('🛑 Stop Game', `sg_${m.chatId}`)]]));
  await ctx.reply('🎮 *Choose a Mini Game:*', { parse_mode:'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('🧠 Trivia', `gm_trivia_${m.chatId}`),    Markup.button.callback('🤔 Would You Rather', `gm_wyr_${m.chatId}`)],
    [Markup.button.callback('🎲 Truth or Dare', `gm_tod_${m.chatId}`), Markup.button.callback('🔤 Word Chain', `gm_wordchain_${m.chatId}`)],
    [Markup.button.callback('❌ Cancel', 'gm_cancel')],
  ]) });
});
bot.command('report', async ctx => {
  const s = ensureSession(ctx); const m = tgToAnon[ctx.from.id];
  if (!m) return ctx.reply('No active chat to report.');
  s.awaitingComplaint = { accusedAnon: m.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly:');
});
bot.command('leaderboard', showLeaderboard);
bot.command('refer',       showReferral);
bot.command('premium',     showPremiumPage);
bot.command('interests',   showInterestPicker);
bot.command('mood',        showMoodPicker);
bot.command('language',    showLanguagePicker);

// ─── LOBBY HEARS ──────────────────────────────────────────────────────────────
bot.hears('🚀 Random Chat',       ctx => startSearch(ctx, { mode:'random' }));
bot.hears('😍 Flirt Chat',        ctx => startSearch(ctx, { mode:'random', flirt:true }));
bot.hears('🔍 Match by Interest', showInterestPicker);
bot.hears('🎭 Match by Mood',     showMoodPicker);
bot.hears('👤 Profile',           ctx => bot.handleUpdate({...ctx.update, message:{...ctx.message, text:'/profile'}}));
bot.hears('🎁 Daily Bonus',       ctx => bot.handleUpdate({...ctx.update, message:{...ctx.message, text:'/bonus'}}));
bot.hears('📊 Leaderboard',       showLeaderboard);
bot.hears('🎮 Mini Games',        ctx => ctx.reply('Start a chat first, then use /game! 🎮'));
bot.hears('💎 Go Premium',        showPremiumPage);
bot.hears('🔗 Refer & Earn',      showReferral);
bot.hears('🤖 Our Bots',          showOurBots);
bot.hears('❌ Cancel Search',     async ctx => {
  const s = ensureSession(ctx);
  if (s.searchingSince) { removeFromPools(s.anon_id); s.searchingSince = null; return ctx.reply('🛑 Search cancelled.', lobbyKb()); }
  return ctx.reply('Not searching.', lobbyKb());
});

// ─── INLINE CALLBACKS ─────────────────────────────────────────────────────────
bot.action('rate_5',  async ctx => { await ctx.answerCbQuery(); await doRate(ctx, 5); });
bot.action('rate_1',  async ctx => { await ctx.answerCbQuery(); await doRate(ctx, 1); });
bot.action('show_rating', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('Rate your partner:', Markup.inlineKeyboard([[
    Markup.button.callback('1⭐','rate_exact_1'), Markup.button.callback('2⭐','rate_exact_2'),
    Markup.button.callback('3⭐','rate_exact_3'), Markup.button.callback('4⭐','rate_exact_4'),
    Markup.button.callback('5⭐','rate_exact_5'),
  ]]));
});
bot.action(/rate_exact_(\d)/, async ctx => { await ctx.answerCbQuery(); await doRate(ctx, parseInt(ctx.match[1])); });
bot.action('complain', async ctx => {
  await ctx.answerCbQuery(); const s = ensureSession(ctx); const m = tgToAnon[ctx.from.id];
  if (!m) return ctx.reply('No active chat.'); s.awaitingComplaint = { accusedAnon: m.partnerAnon };
  await ctx.reply('📝 Describe the violation briefly:');
});
bot.action('btn_next', async ctx => {
  await ctx.answerCbQuery(); const s = ensureSession(ctx);
  if (tgToAnon[ctx.from.id]?.chatId) { await endChatForUser(s.anon_id, 'user_next'); s.inChat = false; }
  await startSearch(ctx, { mode:'random' });
});
bot.action('go_lobby', async ctx => { await ctx.answerCbQuery(); await ctx.reply("🏠 You're in the lobby.", lobbyKb()); });
bot.action(/filter_(.+)/, async ctx => { await ctx.answerCbQuery(); await startSearch(ctx, { mode:'random', genderPref: ctx.match[1]==='any'?null:ctx.match[1] }); });
bot.action(/interest_(.+)/, async ctx => {
  if (ctx.match[1]==='done') { await ctx.answerCbQuery('Saved!'); const s=ensureSession(ctx); const u=getUser(s.anon_id); return ctx.editMessageText(`✅ Interests saved: ${u.interests||'none'}`); }
  await ctx.answerCbQuery(); const s=ensureSession(ctx); const tag=ctx.match[1]; const u=getUser(s.anon_id);
  const cur=u.interests?u.interests.split(','):[], idx=cur.indexOf(tag);
  if (idx>=0) cur.splice(idx,1); else cur.push(tag);
  const nv=cur.slice(0,5).join(',');
  db.prepare('UPDATE users SET interests=? WHERE anon_id=?').run(nv||null, s.anon_id);
  await ctx.editMessageText(`🏷 *Select interests* (max 5):\nSelected: ${nv||'none'}`, { parse_mode:'Markdown', ...buildInterestKb(nv) });
});
bot.action(/mood_(.+)/, async ctx => {
  await ctx.answerCbQuery(); const s=ensureSession(ctx); const mood=ctx.match[1];
  if (mood==='clear') { db.prepare('UPDATE users SET mood=NULL WHERE anon_id=?').run(s.anon_id); return ctx.editMessageText('🎭 Mood cleared.'); }
  db.prepare('UPDATE users SET mood=? WHERE anon_id=?').run(mood, s.anon_id);
  await ctx.editMessageText(`🎭 Mood set: ${mood}`);
});
bot.action(/lang_(.+)/, async ctx => {
  await ctx.answerCbQuery(); const s=ensureSession(ctx);
  db.prepare('UPDATE users SET language=? WHERE anon_id=?').run(ctx.match[1], s.anon_id);
  await ctx.editMessageText(`🌐 Language set: ${ctx.match[1]}`);
});
bot.action(/gm_(\w+)_(.+)/, async ctx => {
  await ctx.answerCbQuery('Starting!'); const [,name,chatId]=ctx.match;
  const chat=activeChats.get(chatId); if (!chat) return;
  await startGame(chatId, name, chat.a_tg, chat.b_tg);
  await ctx.deleteMessage().catch(()=>{});
});
bot.action(/sg_(.+)/, async ctx => {
  await ctx.answerCbQuery('Stopped!'); const chatId=ctx.match[1]; gameStates.delete(chatId);
  const chat=activeChats.get(chatId); if (chat) for (const id of [chat.a_tg,chat.b_tg]) try { await bot.telegram.sendMessage(id,'🛑 Game stopped.'); } catch(e){}
});
bot.action('gm_cancel', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('Cancelled. Use /game anytime!'); });

// ─── MAIN MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on('message', async (ctx, next) => {
  if (ctx.message?.successful_payment) {
    const p = ctx.message.successful_payment;
    const row = db.prepare("SELECT * FROM payments WHERE payload=? AND status='pending'").get(p.invoice_payload);
    if (!row) return;
    const pd = PREMIUM_PLANS[row.plan]; if (!pd) return;
    db.prepare("UPDATE payments SET status='completed',completed_at=datetime('now') WHERE payload=?").run(p.invoice_payload);
    const exp = new Date(Date.now() + pd.days*86400000).toISOString().slice(0,10);
    db.prepare('UPDATE users SET vip_tier=?,premium=1,premium_expires=? WHERE anon_id=?').run(pd.tier, exp, row.anon_id);
    const s = ensureSession(ctx); s.vip_tier = pd.tier;
    await ctx.reply(`🎉 *Payment Successful!*\n\n${pd.emoji} You are now *${pd.label}*!\n📅 Expires: ${exp}\n\n${pd.perks.join('\n')}\n\nEnjoy! 🚀`, { parse_mode:'Markdown', ...lobbyKb() });
    for (const aid of ADMIN_IDS) try { await bot.telegram.sendMessage(aid, `💰 *New Payment*\n\nPlan: ${pd.label}\nStars: ${pd.stars}\ntg_id: ${ctx.from.id}`, { parse_mode:'Markdown' }); } catch(e){}
    return;
  }

  const s     = ensureSession(ctx);
  const tg_id = ctx.from.id;
  if (isSpamming(tg_id)) return ctx.reply('🐢 Slow down!');

  // Admin add-bot flow
  if (isAdmin(ctx) && s.awaitingBotField) {
    const field = s.awaitingBotField;
    const val   = ctx.message.text?.trim();
    if (!val) return ctx.reply('Please send a text value.');
    s.pendingBot[field] = val;
    const steps = {
      name:        { next:'username',    p:'Step 2/6 — Enter the bot *username* (without @):' },
      username:    { next:'description', p:'Step 3/6 — Enter a short *description* (1-2 sentences):' },
      description: { next:'features',   p:'Step 4/6 — Enter key *features* (comma-separated):' },
      features:    { next:'category',   p:'Step 5/6 — Enter a *category* (Chat, Games, Tools, AI, Music, Utility):' },
      category:    { next:'link',        p:'Step 6/6 — Enter the *Telegram link* (https://t.me/username):' },
      link:        { next:null,          p:null },
    };
    const cur = steps[field];
    if (cur.next) {
      s.awaitingBotField = cur.next;
      return ctx.reply(cur.p, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'adm_canceladd')]]) });
    }
    const b = s.pendingBot;
    db.prepare('INSERT INTO managed_bots(name,username,description,features,category,link,active) VALUES(?,?,?,?,?,?,1)')
      .run(b.name, b.username, b.description, b.features, b.category, b.link);
    s.awaitingBotField = null; s.pendingBot = {};
    await ctx.reply(`✅ *Bot Added!*\n\n🤖 ${b.name} · @${b.username}\n📁 ${b.category}\n📝 ${b.description}`, { parse_mode:'Markdown' });
    return showAdminBots(ctx);
  }

  // Complaint text
  if (s.awaitingComplaint) {
    const accused = s.awaitingComplaint.accusedAnon;
    const excerpt = ctx.message.text || '[non-text]';
    const sev     = checkMod(excerpt)?.severity || 1;
    saveComplaint(s.anon_id, accused, 'user_report', excerpt, sev);
    s.awaitingComplaint = null;
    if (sev >= 3) { await endChatForUser(s.anon_id, 'complaint_high'); s.inChat = false; return ctx.reply('🚨 Severe violation reported. Chat ended.', lobbyKb()); }
    return ctx.reply('✅ Complaint submitted. Thank you!');
  }

  // Active chat
  const m = tgToAnon[tg_id];
  if (m?.chatId) {
    const chatId = m.chatId; const chat = activeChats.get(chatId);
    if (!chat) return ctx.reply('⚠️ Chat not found.', lobbyKb());
    const text = ctx.message.text;
    if (text) {
      const mod = checkMod(text);
      if (mod?.severity >= 3) {
        saveComplaint(m.anon, m.partnerAnon, mod.reason, text, mod.severity);
        await ctx.reply('🚨 Serious violation detected. Chat ended and reported.');
        try { await bot.telegram.sendMessage(m.partnerTg, '⚠️ Partner removed for a policy violation.'); } catch(e){}
        await endChat(chatId, 'auto_moderation'); s.inChat = false; return;
      }
      if (mod?.severity === 2) { saveComplaint(m.anon, m.partnerAnon, mod.reason, text, mod.severity); await ctx.reply('⚠️ Warning: message may violate rules.'); }
      if (mod?.severity === 1) { await ctx.reply('🔗 Links are not allowed.'); return; }
    }
    if (text) { const c = await handleGameInput(chatId, tg_id, text); if (c) return; }
    try {
      if (ctx.message.text) await bot.telegram.sendMessage(m.partnerTg, text, { protect_content:true });
      else if (ctx.message.sticker) await bot.telegram.sendSticker(m.partnerTg, ctx.message.sticker.file_id, { protect_content:true });
      else { await ctx.reply('🚫 Only text & stickers allowed for privacy & safety.'); return; }
    } catch(e) { console.error('Forward error:', e.message); }
    if (chat.a_tg === tg_id) chat.a_msgs++; else chat.b_msgs++;
    db.prepare('UPDATE users SET total_messages=total_messages+1 WHERE anon_id=?').run(m.anon);
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
      const u   = getUser(m.anon);
      const ms  = u.vip_tier >= 2 ? 30*60*1000 : 15*60*1000;
      chat.idleTimer = setTimeout(() => endChat(chatId, 'idle_timeout'), ms);
    }
    return;
  }

  if (ctx.message.text && !ctx.message.text.startsWith('/')) await ctx.reply("🏠 You're in the lobby.", lobbyKb());
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function doRate(ctx, value) {
  const m = tgToAnon[ctx.from.id];
  if (!m?.partnerAnon) return ctx.reply('No recent partner to rate.');
  saveRating(m.partnerAnon, value);
  const label = value>=4?'⭐ Great rating!':value>=2?'👍 Decent.':'💔 Low rating.';
  await ctx.reply(`${label} (${value}/5) saved.`);
}
function buildInterestKb(sel) {
  const selected = sel ? sel.split(',') : [];
  const btns     = INTEREST_TAGS.map(t => Markup.button.callback(`${selected.includes(t)?'✅':'○'} ${t}`, `interest_${t}`));
  const rows     = []; for (let i=0; i<btns.length; i+=2) rows.push(btns.slice(i,i+2));
  rows.push([Markup.button.callback('✅ Done','interest_done')]); return Markup.inlineKeyboard(rows);
}
async function showInterestPicker(ctx) {
  const s=ensureSession(ctx); const u=getUser(s.anon_id);
  await ctx.reply(`🏷 *Select interests* (max 5):\nSelected: ${u.interests||'none'}`, { parse_mode:'Markdown', ...buildInterestKb(u.interests) });
}
async function showMoodPicker(ctx) {
  const btns=MOODS.map(m=>Markup.button.callback(m,`mood_${m}`)); const rows=[];
  for (let i=0;i<btns.length;i+=2) rows.push(btns.slice(i,i+2));
  rows.push([Markup.button.callback('🚫 Clear Mood','mood_clear')]);
  await ctx.reply("🎭 *Set your mood:*\nWe'll match you with similar vibes!", { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
}
async function showLanguagePicker(ctx) {
  const btns=LANGUAGES.map(l=>Markup.button.callback(l,`lang_${l.toLowerCase()}`)); const rows=[];
  for (let i=0;i<btns.length;i+=2) rows.push(btns.slice(i,i+2));
  await ctx.reply('🌐 *Preferred language:*', { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
}
async function showLeaderboard(ctx) {
  const top = db.prepare(`SELECT anon_id,chat_count,streak_days,total_messages,CASE WHEN rating_count>0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count,1) ELSE 0 END as avg_rating FROM users ORDER BY chat_count DESC LIMIT 10`).all();
  if (!top.length) return ctx.reply('No users yet!');
  const m=['🥇','🥈','🥉'];
  const lines=top.map((u,i)=>`${m[i]||`${i+1}.`} \`${u.anon_id.slice(0,6)}...\` | 💬${u.chat_count} | 🔥${u.streak_days}d | ⭐${u.avg_rating}`).join('\n');
  await ctx.reply(`📊 *Top Chatters*\n\n${lines}`, { parse_mode:'Markdown' });
}
async function showReferral(ctx) {
  const s=ensureSession(ctx); const u=getUser(s.anon_id);
  const link=`https://t.me/${BOT_USERNAME}?start=ref_${u.referral_code}`;
  await ctx.reply(`🔗 *Refer & Earn*\n\nShare your link, earn bonuses!\n\nYour link:\n\`${link}\`\n\n👥 Referred: ${u.referral_count||0}\n🎁 Every 3 referrals = +1 VIP day`, { parse_mode:'Markdown' });
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', () => { console.log('⛔ Shutting down...'); if (db) db.close(); process.exit(0); });

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  await bot.launch();
  console.log('✅ AnonymTalks v4 running!');
  console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ')||'none'}`);
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS WEB SERVER + ADMIN API
// ═══════════════════════════════════════════════════════════════════════════════
const webApp = express();
webApp.use(express.json());

// CORS
webApp.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Dash-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Admin auth middleware for protected routes
function requireDashSecret(req, res, next) {
  const secret = req.headers['x-dash-secret'] || req.query.secret;
  if (secret !== DASH_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── PUBLIC: Health + basic stats ──────────────────────────────────────────────
webApp.get('/health', (req, res) => res.json({ status:'ok', uptime:process.uptime() }));

webApp.get('/api/stats', (req, res) => {
  res.json({
    total_users:    getTotalUsers(),
    total_chats:    getTotalChats(),
    total_messages: getTotalMsgs(),
    active_today:   getActiveToday(),
    active_now:     activeChats.size,
    searching_now:  Object.values(waitingPool).reduce((a,b) => a+b.length, 0),
  });
});

// ── ADMIN PROTECTED ROUTES ────────────────────────────────────────────────────
webApp.get('/api/admin/stats', requireDashSecret, (req, res) => {
  const bannedCount  = db.prepare('SELECT COUNT(*) as c FROM users WHERE banned=1').get()?.c || 0;
  const openComps    = db.prepare('SELECT COUNT(*) as c FROM complaints WHERE resolved=0').get()?.c || 0;
  const premiumUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE vip_tier>0').get()?.c || 0;
  const totalStars   = db.prepare("SELECT COALESCE(SUM(stars),0) as s FROM payments WHERE status='completed'").get()?.s || 0;
  const pendingPay   = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status='pending'").get()?.c || 0;

  res.json({
    total_users:    getTotalUsers(),
    total_chats:    getTotalChats(),
    total_messages: getTotalMsgs(),
    active_today:   getActiveToday(),
    active_now:     activeChats.size,
    searching_now:  Object.values(waitingPool).reduce((a,b) => a+b.length, 0),
    banned_users:   bannedCount,
    open_complaints:openComps,
    premium_users:  premiumUsers,
    total_stars:    totalStars,
    pending_payments: pendingPay,
    leaderboard:    db.prepare(`SELECT anon_id,chat_count,streak_days,total_messages,CASE WHEN rating_count>0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count,1) ELSE 0 END as avg_rating FROM users ORDER BY chat_count DESC LIMIT 10`).all(),
  });
});

webApp.get('/api/admin/complaints', requireDashSecret, (req, res) => {
  res.json(db.prepare('SELECT * FROM complaints WHERE resolved=0 ORDER BY timestamp DESC LIMIT 30').all());
});

webApp.post('/api/admin/resolve-complaint/:id', requireDashSecret, (req, res) => {
  db.prepare('UPDATE complaints SET resolved=1 WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok:true });
});

webApp.post('/api/admin/ban', requireDashSecret, (req, res) => {
  const { anon_id, reason } = req.body;
  if (!anon_id) return res.status(400).json({ error:'anon_id required' });
  db.prepare('UPDATE users SET banned=1,ban_reason=? WHERE anon_id=?').run(reason||'Admin action', anon_id);
  res.json({ ok:true });
});

webApp.post('/api/admin/unban', requireDashSecret, (req, res) => {
  const { anon_id } = req.body;
  if (!anon_id) return res.status(400).json({ error:'anon_id required' });
  db.prepare('UPDATE users SET banned=0,ban_reason=NULL WHERE anon_id=?').run(anon_id);
  res.json({ ok:true });
});

webApp.get('/api/admin/payments', requireDashSecret, (req, res) => {
  res.json(db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 50').all());
});

// ── Managed Bots API (admin) ──────────────────────────────────────────────────
webApp.get('/api/bots', (req, res) => {
  // Public: only active bots
  res.json(db.prepare('SELECT id,name,username,description,features,category,link,icon FROM managed_bots WHERE active=1 ORDER BY sort_order ASC, added_at DESC').all());
});

webApp.get('/api/admin/bots', requireDashSecret, (req, res) => {
  res.json(db.prepare('SELECT * FROM managed_bots ORDER BY sort_order ASC, added_at DESC').all());
});

webApp.post('/api/admin/bots', requireDashSecret, (req, res) => {
  const { name, username, description, features, category, link, icon } = req.body;
  if (!name || !username || !link) return res.status(400).json({ error:'name, username and link required' });
  db.prepare('INSERT INTO managed_bots(name,username,description,features,category,link,icon,active) VALUES(?,?,?,?,?,?,?,1)')
    .run(name, username, description||'', features||'', category||'General', link, icon||'🤖');
  res.json({ ok:true });
});

webApp.put('/api/admin/bots/:id', requireDashSecret, (req, res) => {
  const { name, username, description, features, category, link, icon, active, sort_order } = req.body;
  const id = parseInt(req.params.id);
  const b  = db.prepare('SELECT * FROM managed_bots WHERE id=?').get(id);
  if (!b) return res.status(404).json({ error:'Bot not found' });
  db.prepare('UPDATE managed_bots SET name=?,username=?,description=?,features=?,category=?,link=?,icon=?,active=?,sort_order=? WHERE id=?')
    .run(name??b.name, username??b.username, description??b.description, features??b.features, category??b.category, link??b.link, icon??b.icon, active??b.active, sort_order??b.sort_order, id);
  res.json({ ok:true });
});

webApp.delete('/api/admin/bots/:id', requireDashSecret, (req, res) => {
  db.prepare('DELETE FROM managed_bots WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok:true });
});

webApp.post('/api/admin/broadcast', requireDashSecret, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error:'message required' });
  const users = db.prepare('SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND banned=0').all();
  let sent=0, failed=0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.tg_id, `📢 *Announcement*\n\n${message}`, { parse_mode:'Markdown' }); sent++; }
    catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  res.json({ sent, failed });
});

// ── Public landing page (clean, no admin exposure) ────────────────────────────
webApp.get('/', (req, res) => {
  const tu = getTotalUsers(), tc = getTotalChats(), an = activeChats.size, sn = Object.values(waitingPool).reduce((a,b)=>a+b.length,0);
  const bots = db.prepare('SELECT * FROM managed_bots WHERE active=1 ORDER BY sort_order ASC').all();

  const botCards = bots.length ? bots.map(b => `
    <div class="bot-card">
      <div class="bot-card-icon">${b.icon||'🤖'}</div>
      <div class="bot-card-body">
        <div class="bot-card-name">${b.name}</div>
        <div class="bot-card-cat">${b.category}</div>
        <div class="bot-card-desc">${(b.description||'').slice(0,80)}</div>
        ${b.features ? `<div class="bot-card-feats">${b.features.split(',').slice(0,3).map(f=>`<span>${f.trim()}</span>`).join('')}</div>` : ''}
      </div>
      <a href="${b.link}" target="_blank" class="bot-card-btn">Open →</a>
    </div>`).join('') : '<p style="color:#64748b;text-align:center;padding:20px">More bots coming soon!</p>';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>AnonymTalks — Anonymous Chat Bot</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#04080f; --surface:#0b1120; --surface2:#111827;
  --blue:#3b82f6; --blue-d:#1d4ed8; --blue-l:#60a5fa;
  --purple:#8b5cf6; --pink:#ec4899; --green:#10b981;
  --text:#f1f5f9; --muted:#64748b; --border:rgba(255,255,255,.06);
  --r:16px; --r-sm:10px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden;line-height:1.6;}
a{color:inherit;text-decoration:none;}

/* NAV */
nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;padding:0 24px;height:60px;
  background:rgba(4,8,15,.8);backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
}
.nav-logo{display:flex;align-items:center;gap:10px;font-family:'Syne',sans-serif;font-size:19px;font-weight:800;}
.nav-logo .ghost{width:32px;height:32px;border-radius:10px;
  background:linear-gradient(135deg,var(--blue),var(--purple));
  display:flex;align-items:center;justify-content:center;font-size:16px;}
.nav-links{display:flex;align-items:center;gap:2px;margin:0 auto;}
.nav-link{padding:6px 14px;border-radius:8px;font-size:13px;font-weight:500;color:var(--muted);transition:.2s;}
.nav-link:hover{color:var(--text);background:var(--border);}
.nav-cta{display:flex;align-items:center;gap:7px;padding:8px 18px;border-radius:var(--r-sm);
  background:var(--blue);color:#fff;font-size:13px;font-weight:700;transition:.2s;}
.nav-cta:hover{background:var(--blue-d);transform:translateY(-1px);}

/* HERO */
.hero{
  min-height:100vh;display:flex;align-items:center;justify-content:center;
  position:relative;overflow:hidden;text-align:center;
  padding:80px 24px 60px;
}
.hero-glow{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-60%);
  width:700px;height:400px;border-radius:50%;pointer-events:none;
  background:radial-gradient(ellipse,rgba(59,130,246,.2) 0%,rgba(139,92,246,.1) 40%,transparent 70%);
}
.hero-badge{
  display:inline-flex;align-items:center;gap:8px;
  padding:6px 16px;border-radius:20px;margin-bottom:24px;
  background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);
  font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--blue-l);
}
.hero-badge .dot{width:6px;height:6px;border-radius:50%;background:#10b981;
  box-shadow:0 0 0 0 rgba(16,185,129,.4);animation:ping 2s infinite;}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(16,185,129,.4);}70%{box-shadow:0 0 0 10px transparent;}100%{box-shadow:0 0 0 0 transparent;}}

.hero-title{
  font-family:'Syne',sans-serif;font-size:clamp(42px,8vw,80px);
  font-weight:800;line-height:1.05;letter-spacing:-2px;margin-bottom:20px;
}
.grad-text{
  background:linear-gradient(135deg,#60a5fa 0%,#a78bfa 50%,#f472b6 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.hero-sub{font-size:18px;color:var(--muted);max-width:520px;margin:0 auto 36px;font-weight:400;}
.hero-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:48px;}
.btn-primary{
  display:inline-flex;align-items:center;gap:9px;padding:15px 28px;border-radius:var(--r);
  background:var(--blue);color:#fff;font-size:15px;font-weight:700;transition:.2s;
  box-shadow:0 0 30px rgba(59,130,246,.35);
}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 0 40px rgba(59,130,246,.5);}
.btn-secondary{
  display:inline-flex;align-items:center;gap:9px;padding:15px 28px;border-radius:var(--r);
  background:transparent;color:var(--text);font-size:15px;font-weight:600;
  border:1px solid var(--border);transition:.2s;backdrop-filter:blur(8px);
}
.btn-secondary:hover{background:var(--border);}

/* STATS STRIP */
.stats-strip{
  display:grid;grid-template-columns:repeat(4,1fr);
  border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  background:var(--surface);
}
.stat-cell{padding:28px 20px;border-right:1px solid var(--border);}
.stat-cell:last-child{border-right:none;}
.stat-n{
  font-family:'Syne',sans-serif;font-size:36px;font-weight:800;line-height:1;margin-bottom:4px;
  background:linear-gradient(135deg,var(--blue),var(--purple));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.stat-l{font-size:12px;color:var(--muted);font-weight:500;display:flex;align-items:center;gap:6px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0;animation:ping 2s infinite;}

/* SECTIONS */
.section{padding:80px 24px;max-width:1100px;margin:0 auto;}
.sec-tag{display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(59,130,246,.1);
  color:var(--blue-l);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:14px;}
.sec-h{font-family:'Syne',sans-serif;font-size:clamp(28px,4vw,44px);font-weight:800;letter-spacing:-1px;margin-bottom:14px;line-height:1.1;}
.sec-sub{font-size:15px;color:var(--muted);max-width:500px;line-height:1.7;}

/* FEATURES */
.features-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px;}
.feat{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:28px;transition:.2s;position:relative;overflow:hidden;
}
.feat:hover{border-color:rgba(59,130,246,.3);transform:translateY(-3px);}
.feat-icon{width:44px;height:44px;border-radius:12px;
  background:linear-gradient(135deg,rgba(59,130,246,.15),rgba(139,92,246,.1));
  display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:16px;
  border:1px solid rgba(59,130,246,.15);}
.feat-title{font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:8px;}
.feat-desc{font-size:13px;color:var(--muted);line-height:1.7;}

/* MARQUEE */
.marquee-wrap{overflow:hidden;background:var(--blue);padding:14px 0;border-top:1px solid rgba(255,255,255,.1);}
.marquee-track{display:flex;white-space:nowrap;animation:marquee 25s linear infinite;}
.mq-item{display:inline-flex;align-items:center;gap:14px;padding:0 20px;
  font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.07em;color:rgba(255,255,255,.75);}
.mq-gem{font-size:9px;color:#fff;}
@keyframes marquee{to{transform:translateX(-50%);}}

/* OUR BOTS */
.bots-section{background:var(--surface);padding:80px 0;}
.bots-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px;}
.bot-card{
  background:var(--bg);border:1px solid var(--border);border-radius:var(--r);
  padding:24px;display:flex;flex-direction:column;gap:12px;transition:.2s;
}
.bot-card:hover{border-color:rgba(59,130,246,.3);transform:translateY(-3px);}
.bot-card-icon{font-size:32px;width:52px;height:52px;border-radius:14px;
  background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.15);
  display:flex;align-items:center;justify-content:center;}
.bot-card-name{font-family:'Syne',sans-serif;font-size:16px;font-weight:800;}
.bot-card-cat{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--blue-l);margin-top:-6px;}
.bot-card-desc{font-size:13px;color:var(--muted);line-height:1.6;flex:1;}
.bot-card-feats{display:flex;flex-wrap:wrap;gap:6px;}
.bot-card-feats span{padding:3px 9px;border-radius:20px;background:rgba(59,130,246,.1);color:var(--blue-l);font-size:11px;font-weight:600;}
.bot-card-btn{
  display:inline-flex;align-items:center;justify-content:center;
  padding:10px;border-radius:var(--r-sm);background:var(--blue);color:#fff;
  font-size:13px;font-weight:700;transition:.2s;margin-top:4px;
}
.bot-card-btn:hover{background:var(--blue-d);}

/* PREMIUM */
.premium-section{padding:80px 24px;max-width:1100px;margin:0 auto;}
.premium-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:48px;}
.plan-card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:32px;position:relative;overflow:hidden;transition:.2s;
}
.plan-card.featured{border-color:rgba(59,130,246,.4);background:linear-gradient(135deg,rgba(59,130,246,.08),rgba(139,92,246,.05));}
.plan-badge{position:absolute;top:16px;right:16px;padding:3px 10px;border-radius:20px;background:var(--blue);color:#fff;font-size:11px;font-weight:700;}
.plan-price{font-family:'Syne',sans-serif;font-size:42px;font-weight:900;line-height:1;margin:12px 0 4px;}
.plan-price span{font-size:16px;color:var(--muted);font-weight:400;}
.plan-period{font-size:13px;color:var(--muted);margin-bottom:20px;}
.plan-perks{display:flex;flex-direction:column;gap:10px;margin-bottom:24px;}
.plan-perk{display:flex;align-items:center;gap:10px;font-size:14px;}
.plan-perk::before{content:'✓';color:var(--green);font-weight:700;flex-shrink:0;}
.plan-cta{
  display:block;text-align:center;padding:13px;border-radius:var(--r-sm);
  font-size:14px;font-weight:700;transition:.2s;
}
.plan-cta.primary{background:var(--blue);color:#fff;}
.plan-cta.primary:hover{background:var(--blue-d);}
.plan-cta.ghost{border:1px solid var(--border);color:var(--text);}
.plan-cta.ghost:hover{background:var(--border);}
.stars-note{text-align:center;margin-top:24px;font-size:13px;color:var(--muted);padding:16px;background:var(--surface);border-radius:var(--r-sm);border:1px solid var(--border);}

/* HOW IT WORKS */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:48px;}
.step{text-align:center;}
.step-n{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--purple));
  color:#fff;font-family:'Syne',sans-serif;font-size:20px;font-weight:800;
  display:flex;align-items:center;justify-content:center;margin:0 auto 18px;
  box-shadow:0 0 24px rgba(59,130,246,.4);}
.step-title{font-family:'Syne',sans-serif;font-size:16px;font-weight:700;margin-bottom:8px;}
.step-desc{font-size:14px;color:var(--muted);line-height:1.7;}

/* FOOTER */
footer{background:var(--surface);border-top:1px solid var(--border);padding:48px 24px 24px;}
.footer-inner{max-width:1100px;margin:0 auto;}
.footer-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:40px;}
.footer-logo{display:flex;align-items:center;gap:10px;font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:12px;}
.footer-tagline{font-size:13px;color:var(--muted);line-height:1.6;max-width:260px;}
.footer-col-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;}
.footer-links{display:flex;flex-direction:column;gap:10px;}
.footer-links a{font-size:13px;color:rgba(255,255,255,.4);transition:.15s;}
.footer-links a:hover{color:var(--text);}
.footer-bottom{border-top:1px solid var(--border);padding-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted);}

/* RESPONSIVE */
@media(max-width:900px){
  .features-grid,.bots-grid,.premium-grid,.steps{grid-template-columns:1fr 1fr;}
  .stats-strip{grid-template-columns:1fr 1fr;}
  .footer-grid{grid-template-columns:1fr 1fr;}
  .nav-links{display:none;}
}
@media(max-width:600px){
  .features-grid,.bots-grid,.premium-grid,.steps{grid-template-columns:1fr;}
  .stats-strip{grid-template-columns:1fr 1fr;}
  .hero-title{letter-spacing:-1px;}
  .footer-grid{grid-template-columns:1fr;}
}
</style>
</head>
<body>

<nav>
  <div class="nav-logo">
    <div class="ghost">👻</div>
    AnonymTalks
  </div>
  <div class="nav-links">
    <a class="nav-link" href="#features">Features</a>
    <a class="nav-link" href="#bots">Our Bots</a>
    <a class="nav-link" href="#premium">Premium</a>
    <a class="nav-link" href="#how">How It Works</a>
  </div>
  <a href="https://t.me/${BOT_USERNAME}" target="_blank" class="nav-cta">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.013 9.484c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L8.48 14.607l-2.95-.924c-.642-.2-.655-.642.136-.953l11.527-4.445c.537-.194 1.006.131.37.963z"/></svg>
    Open Bot
  </a>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-glow"></div>
  <div>
    <div class="hero-badge"><span class="dot"></span> Anonymous · Instant · Free</div>
    <h1 class="hero-title">Talk to Strangers.<br/><span class="grad-text">Stay Anonymous.</span></h1>
    <p class="hero-sub">Connect with real people worldwide — no name, no number, no trace. Just honest conversations.</p>
    <div class="hero-actions">
      <a href="https://t.me/${BOT_USERNAME}" target="_blank" class="btn-primary">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.013 9.484c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L8.48 14.607l-2.95-.924c-.642-.2-.655-.642.136-.953l11.527-4.445c.537-.194 1.006.131.37.963z"/></svg>
        Start Chatting Free
      </a>
      <a href="#premium" class="btn-secondary">💎 View Premium Plans</a>
    </div>
  </div>
</section>

<!-- STATS -->
<div class="stats-strip">
  <div class="stat-cell"><div class="stat-n">${tu.toLocaleString()}</div><div class="stat-l">Total Users</div></div>
  <div class="stat-cell"><div class="stat-n">${tc.toLocaleString()}</div><div class="stat-l">Chats Completed</div></div>
  <div class="stat-cell"><div class="stat-n" style="font-size:28px;display:flex;align-items:center;gap:8px"><span class="live-dot"></span>${an}</div><div class="stat-l">Active Right Now</div></div>
  <div class="stat-cell"><div class="stat-n">100%</div><div class="stat-l">Anonymous</div></div>
</div>

<!-- MARQUEE -->
<div class="marquee-wrap">
  <div class="marquee-track">
    ${['ANONYMOUS CHAT','TALK TO STRANGERS','MATCH BY MOOD','INTEREST MATCHING','MINI GAMES','AI PARTNER','ZERO REGISTRATION','SCREENSHOT PROTECTED','ANONYMOUS CHAT','TALK TO STRANGERS','MATCH BY MOOD','INTEREST MATCHING','MINI GAMES','AI PARTNER','ZERO REGISTRATION','SCREENSHOT PROTECTED']
      .map(t=>`<span class="mq-item"><span class="mq-gem">✦</span>${t}</span>`).join('')}
  </div>
</div>

<!-- FEATURES -->
<div class="section" id="features">
  <div class="sec-tag">What we offer</div>
  <h2 class="sec-h">Built for real conversations.</h2>
  <p class="sec-sub">Every feature is designed to make your anonymous chat experience richer, safer, and more engaging.</p>
  <div class="features-grid">
    <div class="feat"><div class="feat-icon">🎭</div><div class="feat-title">Smart Matching</div><div class="feat-desc">Match by mood, interests, language or gender. Our algorithm finds the most compatible partner in seconds.</div></div>
    <div class="feat"><div class="feat-icon">🔒</div><div class="feat-title">Total Privacy</div><div class="feat-desc">Zero personal data stored. Messages forwarded live, never logged. Screenshot protection on all messages.</div></div>
    <div class="feat"><div class="feat-icon">🎮</div><div class="feat-title">Mini Games</div><div class="feat-desc">Trivia, Would You Rather, Truth or Dare, Word Chain — play live with your anonymous partner.</div></div>
    <div class="feat"><div class="feat-icon">🤖</div><div class="feat-title">AI Fallback</div><div class="feat-desc">No humans online? Our AI partner keeps you engaged — so good you might not notice the difference.</div></div>
    <div class="feat"><div class="feat-icon">🔥</div><div class="feat-title">Streaks & Ranks</div><div class="feat-desc">Daily streaks, leaderboards and ratings reward consistent, quality conversations.</div></div>
    <div class="feat"><div class="feat-icon">🛡️</div><div class="feat-title">Auto Moderation</div><div class="feat-desc">Real-time AI moderation detects threats and harmful content before it reaches your partner.</div></div>
  </div>
</div>

<!-- OUR BOTS -->
<div class="bots-section" id="bots">
  <div class="section" style="padding-top:0;padding-bottom:0">
    <div class="sec-tag">Our Production</div>
    <h2 class="sec-h">More Bots From Our Team</h2>
    <p class="sec-sub">All bots below are built and maintained by the AnonymTalks team.</p>
    <div class="bots-grid">${botCards}</div>
  </div>
</div>

<!-- PREMIUM -->
<div class="premium-section" id="premium">
  <div style="text-align:center">
    <div class="sec-tag">Upgrade</div>
    <h2 class="sec-h">AnonymTalks Premium</h2>
    <p class="sec-sub" style="margin:0 auto">Unlock priority matching, advanced filters, and extended features.</p>
  </div>
  <div class="premium-grid">
    <div class="plan-card">
      <div style="font-size:28px;margin-bottom:8px">⭐</div>
      <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800">VIP</div>
      <div class="plan-price">50 <span>Stars</span></div>
      <div class="plan-period">per month · ≈ ₹85 / $1</div>
      <div class="plan-perks">
        <div class="plan-perk">Priority queue matching</div>
        <div class="plan-perk">Interest-based matching</div>
        <div class="plan-perk">Mood-based matching</div>
        <div class="plan-perk">3 queue jumps per day</div>
      </div>
      <a href="https://t.me/${BOT_USERNAME}?start=premium" target="_blank" class="plan-cta ghost">Get VIP</a>
    </div>
    <div class="plan-card featured">
      <div class="plan-badge">Most Popular</div>
      <div style="font-size:28px;margin-bottom:8px">👑</div>
      <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800">Premium</div>
      <div class="plan-price">100 <span>Stars</span></div>
      <div class="plan-period">per month · ≈ ₹170 / $2</div>
      <div class="plan-perks">
        <div class="plan-perk">Everything in VIP</div>
        <div class="plan-perk">Language filter</div>
        <div class="plan-perk">See partner mood before connecting</div>
        <div class="plan-perk">30-min extended idle timeout</div>
        <div class="plan-perk">Highest queue priority</div>
      </div>
      <a href="https://t.me/${BOT_USERNAME}?start=premium" target="_blank" class="plan-cta primary">Get Premium</a>
    </div>
  </div>
  <div class="stars-note">
    ⭐ <strong>Telegram Stars</strong> are Telegram's native payment method — no third-party, instant, safe.<br/>
    To buy Stars: open Telegram → Settings → My Stars → Get Stars.
  </div>
</div>

<!-- HOW IT WORKS -->
<div class="section" id="how">
  <div class="sec-tag">How it works</div>
  <h2 class="sec-h">Three steps to a conversation.</h2>
  <div class="steps">
    <div class="step"><div class="step-n">1</div><div class="step-title">Open the bot</div><div class="step-desc">Tap the Telegram button. No sign-up, no email, no phone number. Your anonymous ID is ready instantly.</div></div>
    <div class="step"><div class="step-n">2</div><div class="step-title">Set your vibe</div><div class="step-desc">Choose your mood and interests, or just go random. We find the most compatible partner in seconds.</div></div>
    <div class="step"><div class="step-n">3</div><div class="step-title">Start talking</div><div class="step-desc">Chat freely, play games, rate your partner. Press Next anytime to meet someone new instantly.</div></div>
  </div>
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-grid">
      <div>
        <div class="footer-logo"><div class="ghost" style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:14px">👻</div>AnonymTalks</div>
        <p class="footer-tagline">Anonymous 1-on-1 chat bot for Telegram. No registration, no data, just conversation.</p>
      </div>
      <div><div class="footer-col-title">Product</div><div class="footer-links"><a href="#features">Features</a><a href="#premium">Premium</a><a href="https://t.me/${BOT_USERNAME}" target="_blank">Open Bot</a></div></div>
      <div><div class="footer-col-title">Our Bots</div><div class="footer-links"><a href="#bots">See All Bots</a><a href="https://t.me/${BOT_USERNAME}" target="_blank">AnonymTalks</a></div></div>
      <div><div class="footer-col-title">Support</div><div class="footer-links"><a href="#how">How It Works</a><a href="https://t.me/${BOT_USERNAME}" target="_blank">Contact</a></div></div>
    </div>
    <div class="footer-bottom">
      <span>© ${new Date().getFullYear()} AnonymTalks. All rights reserved.</span>
      <span style="font-family:monospace;font-size:11px">v4.0.0 · Node.js + Telegraf</span>
    </div>
  </div>
</footer>

</body>
</html>`);
});

webApp.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));
