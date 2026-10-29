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
const path   = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const express   = require('express');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(x => parseInt(x)).filter(Boolean);
const DB_FILE      = process.env.DB_FILE      || './anonymtalks.db';
const BOT_USERNAME = process.env.BOT_USERNAME || 'TheGhostTalk_Bot';
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

  exec(`CREATE TABLE IF NOT EXISTS bot_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);

  ['total_users','total_chats','total_messages','active_today'].forEach(k => {
    if (!db.prepare('SELECT key FROM bot_stats WHERE key=?').get(k))
      db.prepare('INSERT INTO bot_stats(key,value) VALUES(?,0)').run(k);
  });

  const mbCount = db.prepare('SELECT COUNT(*) as c FROM managed_bots').get()?.c || 0;
  if (mbCount === 0) {
    db.prepare('INSERT INTO managed_bots(name,username,description,features,category,link,icon,active) VALUES(?,?,?,?,?,?,?,1)')
      .run('Ghost Music Bot', 'GhostMusic_Bot', 'Play high-quality music and songs directly in your Telegram Voice Chats (VC) 24/7.', 'Voice Chat Music,High Quality Audio,Queue System', 'Music', 'https://t.me/GhostMusic_Bot', '🎵');
    db.prepare('INSERT INTO managed_bots(name,username,description,features,category,link,icon,active) VALUES(?,?,?,?,?,?,?,1)')
      .run('GhostTalk', 'TheGhostTalk_Bot', 'Anonymous 1:1 chat bot. Match with strangers worldwide instantly.', 'Anonymous,Fast Matching,Mini Games', 'Chat', 'https://t.me/TheGhostTalk_Bot', '👻');
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
function getSetting(key, def = null) {
  try {
    const row = db.prepare('SELECT value FROM bot_settings WHERE key=?').get(key);
    return row ? row.value : def;
  } catch(e) { return def; }
}

function setSetting(key, val) {
  try {
    const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
    db.prepare('INSERT OR REPLACE INTO bot_settings(key, value) VALUES(?, ?)').run(key, strVal);
  } catch(e) {}
}

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
  let user = db.prepare('SELECT * FROM users WHERE anon_id=?').get(anon_id);
  if ((!user || !user.gender) && tg_id && db) {
    const existingWithProfile = db.prepare('SELECT * FROM users WHERE tg_id=? AND gender IS NOT NULL AND gender != "" ORDER BY created_at DESC').get(tg_id);
    if (existingWithProfile) return existingWithProfile;
  }
  return user;
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
  if (!u) return false;
  if (u.vip_tier > 0 && u.premium_expires && new Date(u.premium_expires) < new Date()) {
    db.prepare('UPDATE users SET vip_tier=0,premium=0,premium_expires=NULL WHERE anon_id=?').run(anon_id);
    return false;
  }
  return (u.vip_tier || 0) > 0 || (u.premium || 0) === 1;
}

function isVip(anon_id) {
  if (!anon_id) return false;
  return checkPremiumExpiry(anon_id);
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
const waitingPool = { random: [], flirt: [], female: [], male: [], other: [] };
const activeChats = new Map();
const tgToAnon    = {};
const spamTracker = {};
const gameStates  = new Map();

// Helper to reliably check if a user is currently engaged in an active chat
function isUserInChat(tg_id) {
  const m = tgToAnon[tg_id];
  return Boolean(m && m.chatId && activeChats.has(m.chatId));
}

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ─── AD / ANNOUNCEMENT BANNER ────────────────────────────────────────────────
let gameAdText = process.env.GAME_AD_TEXT || '🎮 Loading next question...';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MOODS = ['😊 Happy','😔 Sad','🤔 Philosophical','🔥 Flirty','😂 Funny','💪 Motivational','😴 Chill'];
const INTEREST_TAGS = ['🎵 Music','🎮 Gaming','📚 Books','🏋️ Fitness','🎨 Art','💻 Tech','🍕 Food','✈️ Travel','💰 Crypto','🎬 Movies','🌿 Nature','🧠 Philosophy'];
const LANGUAGES = ['🎲 Random / Any','English','Hindi','Indonesian','Iranian (Persian)','Spanish','Arabic','Russian','French'];

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
// Clean minimal main menu (matching modern anonymous bots)
const lobbyKb  = () => Markup.keyboard([
  ['🚀 Find a partner'],
  ['🔥 Flirt Chat', '⚙️ Settings']
]).resize();

// In-chat keyboard (simple one-tap access)
const inChatKb = () => Markup.keyboard([
  ['⏭ Next Chat', '🛑 Stop Chat'],
  ['🎮 Mini Game', '⭐ Rate Partner']
]).resize();

const settingsKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('👤 Profile', 'menu_profile'), Markup.button.callback('🎁 Daily Bonus', 'menu_bonus')],
  [Markup.button.callback('🌐 Language', 'menu_lang'), Markup.button.callback('💎 Go Premium', 'menu_premium')],
  [Markup.button.callback('🔗 Refer & Earn', 'menu_refer'), Markup.button.callback('🤖 Our Bots', 'menu_bots')],
  [Markup.button.callback('🔗 My Chat Link (/link)', 'menu_link')]
]);

const endChatFeedbackKb = (partnerAnon) => Markup.inlineKeyboard([
  [Markup.button.callback('👍', `fb_like_${partnerAnon}`), Markup.button.callback('👎', `fb_dislike_${partnerAnon}`)],
  [Markup.button.callback('📑 VCS Spam', `rep_spam_${partnerAnon}`)],
  [Markup.button.callback('❌ Vulgar partner', `rep_vulgar_${partnerAnon}`)],
  [Markup.button.callback('🔞 Underage User', `rep_underage_${partnerAnon}`)],
  [Markup.button.callback('⚠️ Report →', `rep_custom_${partnerAnon}`)]
]);

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
    const tg_id = ctx.from?.id;
    let existing = null;
    if (tg_id && db) {
      try {
        existing = db.prepare('SELECT anon_id, vip_tier, gender FROM users WHERE tg_id=? ORDER BY (gender IS NOT NULL AND gender != "") DESC, created_at DESC').get(tg_id);
      } catch(e) {}
    }
    const anon_id = existing?.anon_id || makeAnonId();

    ctx.session.anon = {
      anon_id: anon_id, inChat: false, chatId: null,
      searchingSince: null, awaitingComplaint: null,
      awaitingBotField: null, awaitingCustomMood: false,
      pendingBot: {},
      premium: true, vip_tier: existing?.vip_tier || 2, queueJump: 0,
    };
    ensureUserRow(anon_id, tg_id);
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
  ['random','flirt','male','female','other'].forEach(k => {
    if (waitingPool[k]) {
      waitingPool[k] = waitingPool[k].filter(u => u.anon_id !== anon_id);
    }
  });
}
function interestScore(a, b) {
  if (!a || !b) return 0;
  const sA = new Set(a.split(','));
  let n = 0; b.split(',').forEach(x => { if (sA.has(x)) n++; }); return n;
}
function tryMatch(item, opts = {}) {
  const isFlirt = opts.mode === 'flirt' || item.mode === 'flirt';
  if (isFlirt) {
    const pool = waitingPool.flirt;
    let best = -1, bestIdx = -1;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (c.anon_id === item.anon_id) continue;
      let score = 1;
      if (item.mood && c.mood === item.mood) score += 3;
      score += interestScore(item.interests, c.interests) * 2;
      if (score > best) { best = score; bestIdx = i; }
    }
    if (bestIdx >= 0) return pool.splice(bestIdx, 1)[0];
    return null;
  }

  // Random / Standard matching
  const pools = [];
  if (opts.genderPref && waitingPool[opts.genderPref]) {
    pools.push(waitingPool[opts.genderPref]);
  }
  pools.push(waitingPool.random);

  let best = -1, bestPool = null, bestIdx = -1;
  for (const pool of pools) {
    if (!pool) continue;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (c.anon_id === item.anon_id) continue;
      if (opts.genderPref && c.gender && c.gender !== opts.genderPref) continue;
      let score = 1;
      if (item.mood && c.mood === item.mood) score += 3;
      score += interestScore(item.interests, c.interests) * 2;
      if (score > best) { best = score; bestPool = pool; bestIdx = i; }
    }
    if (bestIdx >= 0) break;
  }
  if (bestIdx >= 0 && bestPool) return bestPool.splice(bestIdx, 1)[0];
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
  updateStreak(a.anon_id); updateStreak(b.anon_id);

  // Minimalist partner found message — keeps anonymity total so strangers have something to talk about
  try { await bot.telegram.sendMessage(a.tg_id, buildFoundMsg(a.anon_id), { protect_content:true, ...inChatKb() }); } catch(e) {}
  try { await bot.telegram.sendMessage(b.tg_id, buildFoundMsg(b.anon_id), { protect_content:true, ...inChatKb() }); } catch(e) {}
}

function buildFoundMsg(anon_id = null) {
  const lines = [
    'Partner found 😺', '',
    '/next — find a new partner',
    '/stop — stop this chat', '',
    `https://t.me/${BOT_USERNAME}`
  ];
  const isUserPremium = anon_id ? isVip(anon_id) : false;
  const adBannerEnabled = getSetting('ad_banner_enabled', 'false') === 'true';
  if (adBannerEnabled && !isUserPremium) {
    const adText = getSetting('ad_banner_text', '');
    if (adText) {
      lines.unshift(adText, '───────────────────');
    }
  }
  return lines.join('\n');
}

// ─── END CHAT ─────────────────────────────────────────────────────────────────
async function endChat(chatId, reason = 'ended', initiatorTg = null) {
  const chat = activeChats.get(chatId); if (!chat) return;
  const secs = Math.floor((Date.now() - chat.startedAt) / 1000);
  const total = (chat.a_msgs || 0) + (chat.b_msgs || 0);
  if (chat.idleTimer) clearTimeout(chat.idleTimer);
  activeChats.delete(chatId);

  for (const id of [chat.a_tg, chat.b_tg]) {
    delete tgToAnon[id];
    const isPartner = initiatorTg && id !== initiatorTg;
    const partnerAnon = (id === chat.a_tg) ? chat.b_anon : chat.a_anon;

    if (isPartner) {
      const partnerTxt = [
        'Your partner has stopped the chat 😔',
        'Type /search to find a new partner',
        '',
        `https://t.me/${BOT_USERNAME}`,
        '',
        'If you wish, leave your feedback about your partner. It will help us find better partners for you in the future'
      ].join('\n');
      try {
        await bot.telegram.sendMessage(id, partnerTxt, { ...endChatFeedbackKb(partnerAnon) });
      } catch(e) {}
    } else {
      const selfTxt = [
        'You have stopped the chat 🛑',
        'Type /search to find a new partner',
        '',
        `https://t.me/${BOT_USERNAME}`
      ].join('\n');
      try {
        await bot.telegram.sendMessage(id, selfTxt, { ...lobbyKb() });
      } catch(e) {}
    }
  }

  logChat(chatId, chat.a_anon, chat.b_anon, new Date(chat.startedAt).toISOString(), new Date().toISOString(), total, reason);
  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.a_msgs, chat.a_anon);
  db.prepare('UPDATE users SET total_messages=total_messages+? WHERE anon_id=?').run(chat.b_msgs, chat.b_anon);
  db.prepare("UPDATE bot_stats SET value=value+? WHERE key='total_messages'").run(total);
  gameStates.delete(chatId);
}

async function endChatForUser(anon_id, reason = 'ended', initiatorTg = null) {
  for (const [id, c] of activeChats.entries())
    if (c.a_anon === anon_id || c.b_anon === anon_id) { await endChat(id, reason, initiatorTg); return; }
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────
async function startSearch(ctx, opts = {}) {
  const s = ensureSession(ctx);
  if (isUserInChat(ctx.from.id)) {
    return ctx.reply('⚠️ You are already in a chat! Tap ⏭ Next Chat or type /stop to exit.');
  }
  s.inChat = false;

  let u = getUser(s.anon_id, ctx.from?.id);
  if ((!u || !u.gender) && ctx.from?.id && db) {
    const withProfile = db.prepare('SELECT * FROM users WHERE tg_id=? AND gender IS NOT NULL AND gender != "" ORDER BY created_at DESC').get(ctx.from.id);
    if (withProfile) {
      s.anon_id = withProfile.anon_id;
      u = withProfile;
    }
  }
  if (u.banned) return ctx.reply(`🚫 You are banned. Reason: ${u.ban_reason || 'rule violation'}`);

  // Quick onboarding if gender/profile not configured
  if (!u.gender) {
    return startOnboarding(ctx, s.anon_id);
  }

  // Mandatory Subscription / Sponsor Bots Wall
  const forceSubEnabled = getSetting('force_sub_enabled', 'true') === 'true';
  const isUserPremium = isVip(s.anon_id);

  if (forceSubEnabled && !isUserPremium && !opts.skipForceSub) {
    const interval = parseInt(getSetting('force_sub_interval', '3')) || 3;
    s.searchCountSinceSub = (s.searchCountSinceSub || 0) + 1;

    if (!s.subVerified || s.searchCountSinceSub >= interval) {
      let channels = [];
      try { channels = JSON.parse(getSetting('force_sub_channels', '[]')); } catch(e) {}
      if (!channels || !channels.length) {
        channels = [
          { name: '🎵 Ghost Music Bot', url: 'https://t.me/GhostMusic_Bot' },
          { name: '👻 The Ghost Talk Bot', url: `https://t.me/${BOT_USERNAME}` }
        ];
      }

      const rows = channels.map(ch => [Markup.button.url(ch.name, ch.url)]);
      rows.push([Markup.button.callback('✅ I subscribed', 'verify_sub')]);

      const subMsg = [
        '🔔 *To continue using the bot, please subscribe to the channels below:*',
        '',
        '💎 *Premium* — no mandatory channel subscriptions and no ads. Choose a plan:'
      ].join('\n');

      const subKb = Markup.inlineKeyboard([
        ...rows,
        [Markup.button.callback('❌ Disable ads', 'menu_premium')]
      ]);

      return ctx.reply(subMsg, { parse_mode: 'Markdown', ...subKb });
    }
  }

  if (s.searchingSince) {
    return ctx.reply('🔍 Already searching for a partner! Tap ❌ Cancel Search to stop.', searchKb());
  }

  s.searchingSince = Date.now();
  removeFromPools(s.anon_id);

  const mode = opts.mode || 'random';
  const item = {
    anon_id: s.anon_id,
    tg_id: ctx.from.id,
    gender: u.gender,
    mode: mode,
    premium: 2, // Free launch: everyone gets high priority
    joinedAt: Date.now(),
    mood: u.mood,
    interests: u.interests,
    language: u.language || 'any'
  };

  const gp = opts.genderPref || null;
  if (mode === 'flirt') {
    waitingPool.flirt.push(item);
  } else if (gp && waitingPool[gp]) {
    waitingPool[gp].push(item);
  } else {
    waitingPool.random.push(item);
  }

  await ctx.reply(mode === 'flirt' ? '🔥 Searching for a flirt chat partner...' : '🔍 Searching for a partner...', searchKb());

  let elapsed = 0, wide = false;
  const poll = setInterval(async () => {
    elapsed += 1000;
    if (!s.searchingSince || isUserInChat(ctx.from.id)) {
      clearInterval(poll);
      return;
    }
    const match = tryMatch(item, { genderPref: gp, mode: mode });
    if (match) {
      clearInterval(poll);
      s.searchingSince = null;
      removeFromPools(s.anon_id);
      removeFromPools(match.anon_id);
      await connectPair(item, match);
      return;
    }
    if (elapsed === 20000 && !wide && s.searchingSince) {
      wide = true;
      await ctx.reply('⏳ Still searching — widening filters...').catch(() => {});
    }
    if (elapsed >= 60000) {
      clearInterval(poll);
      removeFromPools(s.anon_id);
      s.searchingSince = null;
      await ctx.reply('🌱 *Nobody searching right now!*\n\nTry again in a few moments.\n🔗 Invite friends: /refer',
        { parse_mode:'Markdown', ...lobbyKb() }).catch(() => {});
    }
  }, 1000);
}

// ─── ONBOARDING WIZARD ────────────────────────────────────────────────────────
async function startOnboarding(ctx, anon_id) {
  const introPath = path.join(__dirname, 'ghosttalk_intro.jpg');
  const caption = (
    `👻 *Welcome to GhostTalk!*\n\n` +
    `Before we start matching you with awesome strangers, let's set up your anonymous profile in 3 quick steps:\n\n` +
    `*Step 1 of 3: Select your gender*`
  );
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('👨 Male', 'ob_g_male'), Markup.button.callback('👩 Female', 'ob_g_female')],
    [Markup.button.callback('🌈 Other', 'ob_g_other'), Markup.button.callback('🤐 Skip', 'ob_g_skip')]
  ]);

  if (fs.existsSync(introPath)) {
    try {
      return await ctx.replyWithPhoto({ source: introPath }, {
        caption,
        parse_mode: 'Markdown',
        ...kb
      });
    } catch(e) {}
  }
  await ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
}

// ─── MINI GAMES ───────────────────────────────────────────────────────────────
const TRIVIA = [
  { q:'What planet is closest to the sun?', a:'mercury', hint:'Starts with M' },
  { q:'How many continents are on Earth?', a:'7', hint:'Single digit number' },
  { q:'What gas do green plants absorb from the air?', a:'co2', hint:'Carbon...' },
  { q:'Who painted the Mona Lisa?', a:'da vinci', hint:'Famous Italian renaissance artist' },
  { q:'What is the largest ocean on Earth?', a:'pacific', hint:'Starts with P' },
  { q:'What is the capital of Japan?', a:'tokyo', hint:'Modern neon metropolis' },
  { q:'What is the fastest land animal?', a:'cheetah', hint:'Spotted big cat' },
  { q:'Which element has the chemical symbol Au?', a:'gold', hint:'Precious yellow metal' },
  { q:'How many colors are in a standard rainbow?', a:'7', hint:'VIBGYOR' },
  { q:'What is the hardest natural mineral on Earth?', a:'diamond', hint:'Used in luxury rings' },
  { q:'Which country originated tea as a drink?', a:'china', hint:'Asian nation' },
  { q:'What is the highest mountain peak above sea level?', a:'everest', hint:'Located in Himalayas' },
  { q:'How many bones are in the adult human body?', a:'206', hint:'Between 200 and 210' },
  { q:'What planet is famously known as the Red Planet?', a:'mars', hint:'Named after the god of war' },
  { q:'Which animal is culturally called the King of the Jungle?', a:'lion', hint:'Big feline with a mane' },
  { q:'What is the capital city of France?', a:'paris', hint:'City of lights & Eiffel tower' },
  { q:'What currency is officially used in the United Kingdom?', a:'pound', hint:'Symbol: £' },
  { q:'How many seconds are in one full hour?', a:'3600', hint:'60 x 60' },
  { q:'Which musical instrument has 88 black and white keys?', a:'piano', hint:'Grand or upright' },
  { q:'What is the freezing temperature of water in Celsius?', a:'0', hint:'Freezing baseline' },
  { q:'Who wrote the tragedy Romeo and Juliet?', a:'shakespeare', hint:'The Bard of Avon' },
  { q:'What is the largest living mammal on Earth?', a:'blue whale', hint:'Marine ocean giant' },
  { q:'Which organ pumps blood throughout the human body?', a:'heart', hint:'Beats in your chest' },
  { q:'What is the capital city of Australia?', a:'canberra', hint:'Not Sydney, not Melbourne' },
  { q:'What is the primary green ingredient in guacamole?', a:'avocado', hint:'Creamy green fruit' },
  { q:'How many players per team are on the field in football/soccer?', a:'11', hint:'Double digit' },
  { q:'Which continent is home to the Nile river and pyramids?', a:'africa', hint:'Second largest continent' },
  { q:'What is the square root of 64?', a:'8', hint:'8 x 8' },
  { q:'Which solar system planet is famous for giant icy rings?', a:'saturn', hint:'6th planet from Sun' },
  { q:'Which white bird is an international symbol of peace?', a:'dove', hint:'Pigeon family' },
  { q:'What is the chemical symbol for Silver?', a:'ag', hint:'Starts with A' },
  { q:'Which country has the largest population in the world?', a:'india', hint:'South Asian nation' },
  { q:'How many teeth does an adult human typically have?', a:'32', hint:'Multiple of 8' },
  { q:'What is the capital city of Canada?', a:'ottawa', hint:'Not Toronto, not Montreal' },
  { q:'Which planet in our solar system has the most moons?', a:'saturn', hint:'Famous for rings' },
  { q:'What is the main language spoken in Brazil?', a:'portuguese', hint:'European origin' },
  { q:'What is the longest river in the world?', a:'nile', hint:'Flows through Egypt' },
  { q:'Who developed the theory of relativity?', a:'einstein', hint:'Albert...' },
  { q:'In which year did the Titanic sink?', a:'1912', hint:'Early 20th century' },
  { q:'What is the smallest country in the world by area?', a:'vatican', hint:'Inside Rome' },
  { q:'What is the hardest substance in the human body?', a:'enamel', hint:'Tooth coating' },
  { q:'Which gas makes up approximately 78% of Earth\'s atmosphere?', a:'nitrogen', hint:'Starts with N' },
  { q:'What is the national animal of Scotland?', a:'unicorn', hint:'Mythical horned creature' },
  { q:'How many hearts does an octopus have?', a:'3', hint:'Odd number under 5' },
  { q:'What is the capital of Germany?', a:'berlin', hint:'Known for its historic wall' },
  { q:'Which famous scientist discovered gravity under an apple tree?', a:'newton', hint:'Isaac...' },
  { q:'What is the fastest bird in the world in a dive?', a:'falcon', hint:'Peregrine...' },
  { q:'What metal is liquid at standard room temperature?', a:'mercury', hint:'Used in older thermometers' },
  { q:'How many sides does a regular heptagon have?', a:'7', hint:'Between 6 and 8' },
  { q:'What is the capital city of Spain?', a:'madrid', hint:'Home to famous football clubs' },
  { q:'Which human blood type is known as the universal donor?', a:'o negative', hint:'Type O negative' },
  { q:'What is the largest internal organ in the human body?', a:'liver', hint:'Processes toxins' },
  { q:'Which continent has the most countries?', a:'africa', hint:'54 recognized countries' },
  { q:'What is the boiling point of pure water in Celsius?', a:'100', hint:'Century number' },
  { q:'Who was the first person to walk on the Moon?', a:'armstrong', hint:'Neil...' },
  { q:'What is the primary language spoken in Egypt?', a:'arabic', hint:'Middle Eastern language' },
  { q:'How many degrees are in a complete circle?', a:'360', hint:'Full rotation' },
  { q:'What is the deepest lake in the world?', a:'baikal', hint:'Located in Siberia, Russia' },
  { q:'What do bees collect from flowers to make honey?', a:'nectar', hint:'Sweet floral liquid' },
  { q:'What is the brightest star in the Earth\'s night sky?', a:'sirius', hint:'Also known as Dog Star' }
];

const WYR = [
  'Would you rather have the ability to fly OR be completely invisible?',
  'Would you rather live 500 years in the future OR 500 years in the past?',
  'Would you rather be world-famous OR billionaire-rich in absolute secret?',
  'Would you rather speak all human languages OR play every musical instrument?',
  'Would you rather explore the furthest depths of space OR the deepest trenches of the ocean?',
  'Would you rather never need sleep again OR never need to eat food again?',
  'Would you rather find your soulmate today OR win a guaranteed $10,000,000?',
  'Would you rather be able to read thoughts OR see 10 minutes into the future?',
  'Would you rather live on a sunny tropical beach OR in a cozy snow-covered mountain cabin?',
  'Would you rather always arrive 20 minutes early OR 20 minutes late?',
  'Would you rather live without music forever OR without movies/shows forever?',
  'Would you rather know the date of your death OR the cause of your death?',
  'Would you rather have free unlimited flights anywhere OR free unlimited dining at any restaurant?',
  'Would you rather be the funniest person in any room OR the most attractive person in any room?',
  'Would you rather give up your smartphone for a month OR give up sugar/junk food for a year?',
  'Would you rather fight 1 horse-sized duck OR 100 duck-sized horses?',
  'Would you rather have a life pause button OR a life rewind button?',
  'Would you rather be trapped in a cheesy romantic comedy OR a psychological thriller?',
  'Would you rather never feel physical anger OR never feel emotional sadness?',
  'Would you rather be able to communicate with animals OR speak every foreign language fluently?',
  'Would you rather date someone who talks non-stop OR someone who barely says 10 words a day?',
  'Would you rather have terrible WiFi everywhere you go OR a phone battery that never goes above 15%?',
  'Would you rather be able to teleport anywhere instantly OR possess super-human strength?',
  'Would you rather know all the mysteries of the universe OR live completely stress-free forever?',
  'Would you rather always have to say exactly what you are thinking OR never speak again?',
  'Would you rather be reincarnated as a majestic eagle OR as a pampered house cat?',
  'Would you rather win an Olympic Gold medal OR an Academy Award (Oscar)?',
  'Would you rather lose the ability to lie OR believe every lie anyone tells you?',
  'Would you rather have unlimited free coffee/tea for life OR unlimited free pizza/burgers?',
  'Would you rather live in a world where everyone knows your name OR a world where nobody knows who you are?',
  'Would you rather be able to control fire OR control water?',
  'Would you rather never have to do chores again OR never have to work for money again?',
  'Would you rather live without internet for a year OR without hot water for a year?',
  'Would you rather have a personal chef OR a personal chauffeur everywhere you go?',
  'Would you rather always know when someone is lying OR get away with any lie you tell?',
  'Would you rather wake up with 10 million dollars OR wake up 10 years younger with your current memories?',
  'Would you rather be famous on the internet OR completely unknown but living in luxury?',
  'Would you rather speak fluent Spanish OR fluent Japanese instantly?',
  'Would you rather be an Olympic athlete OR a bestselling novelist?',
  'Would you rather only be able to whisper OR only be able to shout?',
  'Would you rather have a photographic memory OR be able to forget anything you choose?',
  'Would you rather explore ancient ruins OR futuristic cyberpunk cities?',
  'Would you rather be stranded on a deserted tropical island OR trapped in an endless snow blizzard?',
  'Would you rather never eat your favorite meal again OR eat it every single day for the rest of your life?',
  'Would you rather be able to breathe underwater OR walk on air?',
  'Would you rather have a private jet OR a 100-foot luxury yacht?',
  'Would you rather know the history of every object you touch OR speak to ghosts?',
  'Would you rather always be the smartest person in the room OR the happiest person in the room?',
  'Would you rather be able to change your appearance at will OR change your voice at will?',
  'Would you rather live without social media forever OR live without video games/streaming forever?',
  'Would you rather meet your future self 20 years from now OR meet your past self 10 years ago?',
  'Would you rather have an infinite wardrobe of designer clothes OR infinite gadgets/tech for free?',
  'Would you rather never be stuck in traffic again OR never catch a cold or flu again?',
  'Would you rather live inside your favorite movie OR live inside your favorite video game?',
  'Would you rather have 3 wishes granted today OR 1 wish granted every year for the rest of your life?',
  'Would you rather be able to talk to plants OR talk to household pets?',
  'Would you rather have everyone laugh at your jokes OR have everyone take your advice seriously?',
  'Would you rather live in a penthouse overlooking New York OR a villa overlooking the Mediterranean Sea?',
  'Would you rather always wake up fully energized after 3 hours OR be able to sleep for 24 hours straight anytime?',
  'Would you rather know what everyone secretly thinks about you OR never care about anyone\'s opinion again?'
];

const TOD = [
  ["What is your most embarrassing memory that keeps you awake at night?", 'Send a voice message loudly declaring: "I am the champion!"'],
  ["What is one harmless lie you told recently to someone?", 'Type a full 10-word sentence with your eyes closed!'],
  ["What is your absolute biggest guilty pleasure?", 'Send the 3 most recently used emojis from your keyboard!'],
  ["Who was your very first childhood crush?", 'Send an honest compliment to your partner in ALL CAPS!'],
  ["What is your weirdest or most irrational fear?", 'Send the most random or funny sticker/GIF you have!'],
  ["What is something everyone loves that you secretly dislike?", 'Send a voice message whispering your favorite food!'],
  ["Have you ever secretly stalked an ex or crush on social media?", 'Rate your partner\'s vibe right now on a scale of 1 to 10 with a reason!'],
  ["What is the strangest food combination that you actually enjoy?", 'Send a recommendation for one song that defines your mood today!'],
  ["What is a hidden or unusual talent that you possess?", 'Send a voice message imitating your favorite animal sound!'],
  ["Have you ever made up an excuse to escape a boring conversation or date?", 'Send a dramatic movie quote pretending you are in an action movie!'],
  ["What is the most childish thing that you still do as an adult?", 'Send 3 emojis that describe your anonymous partner based on this chat!'],
  ["If you could erase one past mistake from existence, what would it be?", 'Describe your anonymous partner using only 3 adjectives!'],
  ["What is the worst piece of advice you have ever followed?", 'Write a fun 2-line rhyme about chatting with strangers!'],
  ["Do you believe in love at first sight or love at first conversation?", 'Tell your partner the funniest clean joke you know!'],
  ["What is your biggest everyday pet peeve that annoys you instantly?", 'Send a short voice note singing the chorus of any song you like!'],
  ["Have you ever had a crush on a cartoon or fictional character?", 'Send a funny photo or sticker that matches your reaction to this question!'],
  ["What is something you genuinely like about yourself?", 'Say something positive about your partner out loud right now!'],
  ["What is the craziest thing you have ever done spontaneously?", 'Send 5 emojis that represent your entire day today!'],
  ["Have you ever ghosted someone, and why did you do it?", 'Write a quick 2-line poetic compliment for your partner!'],
  ["What is one dream you haven't shared with people in real life?", 'Give your chat partner a fun nickname for the rest of this session!'],
  ["What was the most awkward handshake, high-five, or hug you ever had?", 'Share your favorite quote or life motto with your partner!'],
  ["What is the worst gift you have ever received from someone?", 'Describe your dream vacation destination in one descriptive sentence!'],
  ["What is your favorite late-night guilty habit?", 'Guess your partner\'s favorite music genre or hobby!'],
  ["Who is your biggest celebrity or influencer crush right now?", 'Confess what your first impression of your partner was!'],
  ["What is the biggest risk you have taken that paid off?", 'Send a friendly voice note saying: "Hello stranger, hope you\'re having a great day!"'],
  ["If you won $1,000,000 tomorrow, what is the very first purchase?", 'Tell your partner one reason you enjoy talking to them!'],
  ["What is the most trouble you ever got into in school?", 'Type a sentence without using the letter "e"!'],
  ["Have you ever practiced speaking or posing in front of a mirror?", 'Send a sticker that represents your current energy level!'],
  ["What is one thing on your bucket list you must do before you die?", 'Ask your partner any personal question of your own choosing!'],
  ["If you could change one thing about yourself, what would it be?", 'Send your partner a virtual high five and a warm wish!'],
  ["What is the most awkward text you have accidentally sent to the wrong person?", 'Send an audio recording whistling the happiest tune you know!'],
  ["Have you ever pretended to be sick to avoid hanging out with friends?", 'Send a 5-word message describing what you think your partner looks like right now!'],
  ["What is the biggest secret you have kept from your parents?", 'Write an acrostic poem using the word "GHOST" right now!'],
  ["Have you ever eavesdropped on a private conversation you weren't supposed to hear?", 'Type your response to this with your phone upside down!'],
  ["What is one song you love but are embarrassed to admit to people?", 'Send an audio note speaking in your best dramatic British accent!'],
  ["What is the most ridiculous superstition you still secretly follow?", 'Share the most bizarre thought you had in the last 24 hours!'],
  ["Have you ever bought something expensive that you immediately regretted?", 'Send a voice message saying: "I solemnly swear I am up to no good!"'],
  ["What is your favorite comfort food that you eat when nobody is watching?", 'Send a compliment to your partner in a language other than English!'],
  ["If you could swap lives with any celebrity for 24 hours, who would it be?", 'Describe your ideal romantic evening in only 4 words!'],
  ["What is the weirdest rumor you ever heard about yourself?", 'Type a creative motto for your life and share it!'],
  ["Have you ever snooped through someone\'s room, bag, or phone?", 'Send 3 funny emojis that describe your anonymous partner!'],
  ["What is the worst haircut or fashion choice you ever had in your life?", 'Share a movie title that accurately summarizes your current love life!'],
  ["What is one question you are terrified of being asked on a first date?", 'Send an audio note laughing like a cartoon villain!'],
  ["If your pet could suddenly speak, what embarrassing secret would they reveal?", 'Write a 2-sentence story about an adventurous ghost!'],
  ["What is the longest time you have gone without showering or brushing your teeth?", 'Send a dramatic apology to your partner for no reason at all!'],
  ["Have you ever had a crush on a friend\'s partner or sibling?", 'Share the best piece of wisdom you have ever received!'],
  ["What is something silly you believed was true well into your teenage years?", 'Send an audio message humming the first song that pops into your head!'],
  ["Have you ever walked into a glass door or slipped in public?", 'Type out the lyrics to the chorus of your current favorite song!'],
  ["What is your biggest fear about the future?", 'Give your partner a funny superhero name based on how they talk!'],
  ["What is the most bizarre dream you still remember clearly?", 'Send a voice note introducing yourself as an undercover secret agent!'],
  ["Have you ever cried while watching a children\'s movie or cartoon?", 'Predict where your anonymous partner will be in 5 years!'],
  ["What is something you pretend to understand just to fit into conversations?", 'Send a message using only emojis to tell a whole story!'],
  ["What is the most impulsive purchase you made late at night online?", 'Share the title of a book or song that changed your perspective!'],
  ["Have you ever rehearsed a conversation before making a phone call?", 'Send an audio message pretending to order an imaginary pizza with weird toppings!'],
  ["What is the most childish argument you have gotten into recently?", 'Compliment your partner on their conversation skills!'],
  ["What is one habit you have that other people might find strange?", 'Describe the color of your socks and what they say about your personality!'],
  ["If you were invisible for one whole hour, where would you go first?", 'Send an enthusiastic greeting in another language to your partner!'],
  ["What is your favorite guilty guilty pleasure TV show or guilty movie?", 'Tell your partner the most interesting random fact you know!'],
  ["Have you ever blamed a pet or sibling for something you did?", 'Send an audio note making your best impression of a robot!'],
  ["What is the kindest thing a stranger has ever done for you?", 'Wish your partner the best luck for tomorrow in a heartfelt message!']
];

async function startGame(chatId, name, tgA, tgB) {
  let msg = '', state = {};
  let buttonLabel = '🔄 Next Question';
  if (name === 'trivia') {
    const q = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
    state = { type:'trivia', question:q, answered:false };
    msg   = `🎯 *Trivia!*\n\n❓ ${q.q}\n💡 Hint: ${q.hint}\n\n_First correct answer wins!_`;
    buttonLabel = '🎯 Next Question';
  } else if (name === 'wyr') {
    const q = WYR[Math.floor(Math.random() * WYR.length)];
    state = { type:'wyr', question:q };
    msg   = `🤔 *Would You Rather?*\n\n${q}\n\n_Both reply with your choice!_`;
    buttonLabel = '🤔 Next Dilemma';
  } else if (name === 'tod') {
    const p = TOD[Math.floor(Math.random() * TOD.length)];
    state = { type:'tod', truth:p[0], dare:p[1] };
    msg   = `🎲 *Truth or Dare?*\n\n🔍 *Truth:* ${p[0]}\n💥 *Dare:* ${p[1]}\n\n_Pick one!_`;
    buttonLabel = '🎲 Next Truth & Dare';
  } else if (name === 'wordchain') {
    state = { type:'wordchain', lastWord:null, usedWords:[], turn:tgA };
    gameStates.set(chatId, state);
    const gameKb = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Restart Word Chain', `gm_next_wordchain_${chatId}`),
        Markup.button.callback('🛑 Stop Game', `sg_${chatId}`)
      ]
    ]);
    const msgA = `🔤 *Word Chain!*\nEach word must start with the last letter of the previous.\n\n👉 *Your turn!* You start by sending the first word:`;
    const msgB = `🔤 *Word Chain!*\nEach word must start with the last letter of the previous.\n\n⏳ *Partner goes first!* Waiting for their word...`;
    try { await bot.telegram.sendMessage(tgA, msgA, { parse_mode:'Markdown', ...gameKb }); } catch(e) {}
    try { await bot.telegram.sendMessage(tgB, msgB, { parse_mode:'Markdown', ...gameKb }); } catch(e) {}
    return;
  }
  gameStates.set(chatId, state);

  const gameKb = Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonLabel, `gm_next_${name}_${chatId}`),
      Markup.button.callback('🛑 Stop Game', `sg_${chatId}`)
    ]
  ]);

  for (const id of [tgA, tgB]) {
    try { await bot.telegram.sendMessage(id, msg, { parse_mode:'Markdown', ...gameKb }); } catch(e) {}
  }
}

async function handleGameInput(chatId, tg_id, text) {
  const game = gameStates.get(chatId); if (!game) return false;
  const chat = activeChats.get(chatId); if (!chat) return false;
  const partner = chat.a_tg === tg_id ? chat.b_tg : chat.a_tg;
  if (game.type === 'trivia' && !game.answered) {
    if (text.toLowerCase().trim() === game.question.a.toLowerCase().trim()) {
      game.answered = true;
      const nextKb = Markup.inlineKeyboard([
        [
          Markup.button.callback('🎯 Next Question', `gm_next_trivia_${chatId}`),
          Markup.button.callback('🛑 Stop Game', `sg_${chatId}`)
        ]
      ]);
      try { await bot.telegram.sendMessage(tg_id, `✅ *Correct!* Answer: *${game.question.a}* 🎉`, { parse_mode:'Markdown', ...nextKb }); } catch(e) {}
      try { await bot.telegram.sendMessage(partner, `❌ Partner got it! Answer was: *${game.question.a}*`, { parse_mode:'Markdown', ...nextKb }); } catch(e) {}
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
        [Markup.button.callback('📊 Top Users', 'adm_topusers'),   Markup.button.callback('📢 Game Ad', 'adm_gamead')],
        [Markup.button.callback('🔔 Sponsor Wall', 'adm_sponsorwall'), Markup.button.callback('🔄 Refresh', 'adm_refresh')],
      ])
    }
  );
}

bot.action('adm_sponsorwall', async ctx => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const enabled = getSetting('force_sub_enabled', 'true') === 'true';
  const interval = getSetting('force_sub_interval', '3');
  let channels = [];
  try { channels = JSON.parse(getSetting('force_sub_channels', '[]')); } catch(e) {}
  const chList = channels.map((c, i) => `${i+1}. ${c.name} (${c.url})`).join('\n') || 'None';
  await ctx.reply(
    `🔔 *Mandatory Channel / Sponsor Wall*\n\n` +
    `• Status: *${enabled ? '🟢 Active' : '🔴 Disabled'}*\n` +
    `• Trigger Interval: Every *${interval}* chats / searches\n\n` +
    `*Sponsor Channels & Bots:*\n${chList}\n\n` +
    `_Configure channels and interval easily on your Web Admin Dashboard!_`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(enabled ? '🔴 Disable Wall' : '🟢 Enable Wall', 'adm_togglesub')],
        [Markup.button.callback('« Back', 'adm_back')]
      ])
    }
  );
});

bot.action('adm_togglesub', async ctx => {
  if (!isAdmin(ctx)) return;
  const cur = getSetting('force_sub_enabled', 'true') === 'true';
  setSetting('force_sub_enabled', cur ? 'false' : 'true');
  await ctx.answerCbQuery(`Sponsor wall ${cur ? 'disabled' : 'enabled'}!`);
  await ctx.deleteMessage().catch(() => {});
  return showAdminDashboard(ctx);
});

bot.action('adm_gamead', async ctx => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(
    `📢 *Game Popup / Ad Banner*\n\n` +
    `Current Popup text:\n"${gameAdText}"\n\n` +
    `This popup toast appears at the top when users click "Next Question / Next Truth" in games.\n\n` +
    `To update, send:\n\`/setad <your new ad message>\``,
    { parse_mode: 'Markdown' }
  );
});

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
//  PREMIUM & LAUNCH PROMOTION (Payments temporarily disabled)
// ═══════════════════════════════════════════════════════════════════════════════
async function showPremiumPage(ctx) {
  await ctx.reply(
    `🎉 *Launch Celebration — All Features are FREE!*\n\n` +
    `For a limited time during our global launch, all Premium & VIP perks are *100% FREE* for all users!\n\n` +
    `✨ *Unlocked Perks:*\n` +
    `• ⚡ Priority queue matchmaking\n` +
    `• 🔍 Match by Interest\n` +
    `• 🎭 Match by Mood\n` +
    `• 🔥 Dedicated Flirt Chat\n` +
    `• ♾️ Unlimited chat duration (stay as long as you want!)\n\n` +
    `_No payments or Stars needed. Have fun chatting!_ 🚀`,
    { parse_mode: 'Markdown' }
  );
}

// ─── OUR BOTS (public view) ────────────────────────────────────────────────────
async function showOurBots(ctx) {
  let bots = db.prepare('SELECT * FROM managed_bots WHERE active=1 ORDER BY sort_order ASC, added_at DESC').all();
  if (!bots.length) {
    bots = [
      {
        name: 'Ghost Music Bot',
        username: 'GhostMusic_Bot',
        description: 'Play high-quality music and songs directly in your Telegram Voice Chats (VC) 24/7.',
        category: 'Music',
        link: 'https://t.me/GhostMusic_Bot',
        icon: '🎵'
      },
      {
        name: 'GhostTalk',
        username: 'TheGhostTalk_Bot',
        description: 'Anonymous 1:1 chat bot with zero traces. Fast matchmaking, mini-games & streaks.',
        category: 'Chat',
        link: 'https://t.me/TheGhostTalk_Bot',
        icon: '👻'
      }
    ];
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
  s.inChat = false;
  s.searchingSince = null;
  removeFromPools(s.anon_id);

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
        await ctx.reply('🎉 You joined via a referral link! Your friend earns bonus points.');
      }
    }
  }

  // Direct anonymous chat link connection (/link)
  if (payload?.startsWith('chat_')) {
    const targetAnon = payload.replace('chat_','');
    if (targetAnon === s.anon_id) {
      return ctx.reply("😅 You can't chat with yourself! Share this link with friends or on social media.", lobbyKb());
    }
    const targetUser = db.prepare('SELECT * FROM users WHERE anon_id=?').get(targetAnon);
    if (!targetUser || !targetUser.tg_id) {
      return ctx.reply("❌ That chat link is expired or invalid.", lobbyKb());
    }
    if (isUserInChat(targetUser.tg_id)) {
      return ctx.reply("⏳ That person is currently in another chat! Try again in a little while.", lobbyKb());
    }
    removeFromPools(s.anon_id);
    removeFromPools(targetAnon);
    const itemA = { anon_id: s.anon_id, tg_id: ctx.from.id, mode: 'direct' };
    const itemB = { anon_id: targetAnon, tg_id: targetUser.tg_id, mode: 'direct' };
    await connectPair(itemA, itemB);
    return;
  }

  const u = getUser(s.anon_id);
  if (!u.gender) {
    return startOnboarding(ctx, s.anon_id);
  }

  const welcomeText = (
    `👻 *Welcome to GhostTalk!*\n\n` +
    `Chat anonymously with people worldwide.\n` +
    `Your identity stays completely private — no names, no numbers.\n\n` +
    `Tap *🚀 Find a partner* below to begin chatting!`
  );
  const introPath = path.join(__dirname, 'ghosttalk_intro.jpg');
  if (fs.existsSync(introPath)) {
    try {
      return await ctx.replyWithPhoto({ source: introPath }, {
        caption: welcomeText,
        parse_mode: 'Markdown',
        ...lobbyKb()
      });
    } catch(e) {}
  }
  await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...lobbyKb() });
});

async function showProfile(ctx) {
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  const r = getRating(s.anon_id);
  await ctx.reply([
    `👤 *Your Profile*`, '',
    `🏆 Rating: ${r} ${r>0?'⭐'.repeat(Math.min(5, Math.round(r))):'unrated'}`,
    `👤 Gender: ${u.gender||'not set'}`,
    `🌐 Language: ${u.language||'English'}`,
    `💬 Chats: ${u.chat_count||0}`,
    `📨 Messages: ${u.total_messages||0}`,
    `🔥 Streak: ${u.streak_days||0} day(s)`,
    `🎭 Mood: ${u.mood||'not set'}`,
    `💎 Tier: ⭐ VIP (Free Launch Pass)`,
    `👥 Referrals: ${u.referral_count||0}`,
  ].filter(Boolean).join('\n'), { parse_mode:'Markdown', ...lobbyKb() });
}

async function claimBonus(ctx) {
  const s = ensureSession(ctx);
  const today = new Date().toISOString().slice(0,10);
  const u = getUser(s.anon_id);
  if (u.last_bonus_date === today) {
    return ctx.reply('⏰ Daily bonus already claimed today! Come back tomorrow. 🌅', lobbyKb());
  }

  // Top 3 chatters by chat count & rating
  const top3 = db.prepare(`SELECT anon_id FROM users ORDER BY chat_count DESC, rating_sum DESC LIMIT 3`).all();
  const isTop3 = top3.some(t => t.anon_id === s.anon_id);

  if (isTop3) {
    db.prepare('UPDATE users SET last_bonus_date=?, rating_sum=rating_sum+5, rating_count=rating_count+1 WHERE anon_id=?').run(today, s.anon_id);
    s.queueJump = (s.queueJump||0) + 3;
    await ctx.reply(
      `🏆 *Top 3 Exclusive Daily Bonus Claimed!*\n\n` +
      `⭐ You received *+5 Karma/Rating Points*!\n` +
      `⚡ +3 Priority Queue Jumps added!\n\n` +
      `Thank you for being one of our top chatters! Keep it up! 🔥`,
      { parse_mode:'Markdown', ...lobbyKb() }
    );
  } else {
    await ctx.reply(
      `🔒 *Top 3 Exclusive Bonus*\n\n` +
      `The Daily 5-Point Bonus is reserved exclusively for the *Top 3 chatters* on the leaderboard!\n\n` +
      `📈 *How to qualify:*\n` +
      `• Chat actively with strangers\n` +
      `• Maintain your daily chat streak (🔥)\n` +
      `• Earn high star ratings (⭐) from partners\n\n` +
      `Keep chatting to claim your spot in the Top 3! 🚀`,
      { parse_mode:'Markdown', ...lobbyKb() }
    );
  }
}

async function showSettings(ctx) {
  await ctx.reply(
    `⚙️ *Settings & Account*\n\n` +
    `Select an option below to manage your profile, bonus, language, or personal link:`,
    {
      parse_mode: 'Markdown',
      ...settingsKb()
    }
  );
}

async function showMyLink(ctx) {
  const s = ensureSession(ctx);
  const link = `https://t.me/${BOT_USERNAME}?start=chat_${s.anon_id}`;
  await ctx.reply(
    `🔗 *Your Personal Anonymous Chat Link:*\n\n` +
    `\`${link}\`\n\n` +
    `Share this link on your Instagram bio, WhatsApp status, or Discord!\n\n` +
    `Anyone who taps it will *connect directly with you in an anonymous 1:1 chat* inside this bot — without seeing your Telegram username or phone number! 🎭`,
    { parse_mode: 'Markdown' }
  );
}

async function showInterestPicker(ctx) {
  await ctx.reply(
    `🔒 *Match by Interest is Locked!*\n\n` +
    `This smart matching feature will automatically unlock after our community reaches *100,000 active users* (to ensure instant matches without queue waiting delays)!\n\n` +
    `_In the meantime, enjoy instant matching with 🚀 Find a partner!_`,
    { parse_mode: 'Markdown', ...lobbyKb() }
  );
}

bot.command('stop', async ctx => {
  const s = ensureSession(ctx);
  s.inChat = false;
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search cancelled.', lobbyKb());
  }
  if (isUserInChat(ctx.from.id)) {
    await endChatForUser(s.anon_id, 'user_stop', ctx.from.id);
  } else {
    await ctx.reply("🏠 You're in the lobby.", lobbyKb());
  }
});

bot.command('next', async ctx => {
  const s = ensureSession(ctx);
  if (isUserInChat(ctx.from.id)) {
    await endChatForUser(s.anon_id, 'user_next', ctx.from.id);
  }
  s.inChat = false;
  s.searchingSince = null;
  removeFromPools(s.anon_id);
  await startSearch(ctx, { mode:'random' });
});

bot.command('search', async ctx => {
  const s = ensureSession(ctx);
  if (isUserInChat(ctx.from.id)) {
    return ctx.reply('⚠️ You are already in a chat! Tap ⏭ Next Chat or type /stop to exit.', inChatKb());
  }
  await startSearch(ctx, { mode:'random' });
});

bot.command('rules', async ctx => {
  await ctx.reply(
    `📜 *GhostTalk Community Rules*\n\n` +
    `1️⃣ No sexual content involving minors — *instant permanent ban*\n` +
    `2️⃣ No threats or violence\n3️⃣ No doxxing (sharing personal info)\n` +
    `4️⃣ No spam or flooding\n5️⃣ No hate speech\n\n` +
    `Violations are auto-detected. Repeated reports = ban.\n_Be kind — real humans are here. 💙_`,
    { parse_mode:'Markdown' }
  );
});

bot.command('profile', showProfile);
bot.command('bonus', claimBonus);
bot.command('settings', showSettings);
bot.command('link', showMyLink);
bot.command('leaderboard', showLeaderboard);
bot.command('refer', showReferral);
bot.command('premium', showPremiumPage);
bot.command('interests', showInterestPicker);
bot.command('mood', showMoodPicker);
bot.command('language', showLanguagePicker);

bot.command('setad', async ctx => {
  if (!isAdmin(ctx)) return;
  const txt = ctx.message.text.replace('/setad', '').trim();
  if (!txt) return ctx.reply(`Current game ad/popup:\n"${gameAdText}"\n\nUsage: /setad Your ad text here`);
  gameAdText = txt;
  await ctx.reply(`✅ Next question popup updated to:\n"${gameAdText}"`);
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

// ─── LOBBY & IN-CHAT HEARS ───────────────────────────────────────────────────
bot.hears(['🚀 Find a partner', '🚀 Random Chat', '/search'], ctx => startSearch(ctx, { mode:'random' }));
bot.hears(['🔥 Flirt Chat', '😍 Flirt Chat'], ctx => startSearch(ctx, { mode:'flirt' }));
bot.hears(['⚙️ Settings', '/settings', 'Settings'], showSettings);
bot.hears(['👤 Profile', '/profile', 'Profile'], showProfile);
bot.hears(['🎁 Daily Bonus', '/bonus', 'Daily Bonus'], claimBonus);
bot.hears(['💎 Go Premium', '/premium'], showPremiumPage);
bot.hears(['🔗 Refer & Earn', '/refer'], showReferral);
bot.hears(['🤖 Our Bots', '/bots'], showOurBots);
bot.hears(['🔗 My Chat Link', '/link'], showMyLink);
bot.hears(['🔍 Match by Interest', '/interests'], showInterestPicker);
bot.hears(['🎭 Match by Mood', '/mood'], showMoodPicker);

// In-chat fast action buttons
bot.hears(['⏭ Next Chat', '/next'], async ctx => {
  const s = ensureSession(ctx);
  if (isUserInChat(ctx.from.id)) { await endChatForUser(s.anon_id, 'user_next', ctx.from.id); }
  s.inChat = false;
  s.searchingSince = null;
  removeFromPools(s.anon_id);
  await startSearch(ctx, { mode:'random' });
});

bot.hears(['🛑 Stop Chat', '🛑 End Chat', '/stop'], async ctx => {
  const s = ensureSession(ctx);
  s.inChat = false;
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search cancelled.', lobbyKb());
  }
  if (isUserInChat(ctx.from.id)) {
    await endChatForUser(s.anon_id, 'user_stop', ctx.from.id);
  } else {
    await ctx.reply("🏠 You're in the lobby.", lobbyKb());
  }
});

bot.hears(['🎮 Mini Game', '🎮 Mini Games', '/game'], async ctx => {
  const m = tgToAnon[ctx.from.id];
  if (!m) return ctx.reply('Start a chat first to play games! 🎮', lobbyKb());
  const chat = activeChats.get(m.chatId);
  if (!chat) return ctx.reply('No active chat found.', lobbyKb());
  if (gameStates.has(m.chatId)) {
    return ctx.reply('🎮 A game is already in progress!', Markup.inlineKeyboard([
      [Markup.button.callback('🛑 Stop Current Game', `sg_${m.chatId}`)]
    ]));
  }
  await ctx.reply('🎮 *Choose a Mini Game:*', {
    parse_mode:'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🧠 Trivia', `gm_trivia_${m.chatId}`),    Markup.button.callback('🤔 Would You Rather', `gm_wyr_${m.chatId}`)],
      [Markup.button.callback('🎲 Truth or Dare', `gm_tod_${m.chatId}`), Markup.button.callback('🔤 Word Chain', `gm_wordchain_${m.chatId}`)],
      [Markup.button.callback('❌ Cancel', 'gm_cancel')],
    ])
  });
});

bot.hears(['⭐ Rate Partner'], async ctx => {
  const m = tgToAnon[ctx.from.id];
  if (!m?.partnerAnon) return ctx.reply('No active chat partner to rate.');
  await ctx.reply('⭐ *Rate your current partner:*', Markup.inlineKeyboard([[
    Markup.button.callback('1⭐','rate_exact_1'), Markup.button.callback('2⭐','rate_exact_2'),
    Markup.button.callback('3⭐','rate_exact_3'), Markup.button.callback('4⭐','rate_exact_4'),
    Markup.button.callback('5⭐','rate_exact_5'),
  ]]));
});

bot.hears('❌ Cancel Search', async ctx => {
  const s = ensureSession(ctx);
  if (s.searchingSince) {
    removeFromPools(s.anon_id);
    s.searchingSince = null;
    return ctx.reply('🛑 Search cancelled.', lobbyKb());
  }
  if (isUserInChat(ctx.from.id)) {
    return ctx.reply('💬 You are currently in an active chat! Use the buttons below:', inChatKb());
  }
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
  if (isUserInChat(ctx.from.id)) { await endChatForUser(s.anon_id, 'user_next', ctx.from.id); }
  s.inChat = false;
  s.searchingSince = null;
  removeFromPools(s.anon_id);
  await startSearch(ctx, { mode:'random' });
});
bot.action('verify_sub', async ctx => {
  await ctx.answerCbQuery('✅ Subscribed! Finding partner now...');
  const s = ensureSession(ctx);
  s.subVerified = true;
  s.searchCountSinceSub = 0;
  try { await ctx.deleteMessage(); } catch(e) {}
  await startSearch(ctx, { mode: 'random', skipForceSub: true });
});
bot.action('go_lobby', async ctx => { await ctx.answerCbQuery(); await ctx.reply("🏠 You're in the lobby.", lobbyKb()); });
bot.action(/filter_(.+)/, async ctx => { await ctx.answerCbQuery(); await startSearch(ctx, { mode:'random', genderPref: ctx.match[1]==='any'?null:ctx.match[1] }); });

// Onboarding callbacks
bot.action(/ob_g_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  const g = ctx.match[1] === 'skip' ? 'unspecified' : ctx.match[1];
  const tg_id = ctx.from?.id || null;
  db.prepare('UPDATE users SET gender=? WHERE anon_id=? OR (tg_id=? AND tg_id IS NOT NULL)').run(g, s.anon_id, tg_id);
  await ctx.editMessageText(
    `✅ Gender saved!\n\n*Step 2 of 4: Preferred Language*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎲 Random / Any', 'ob_l_Random'), Markup.button.callback('English', 'ob_l_English')],
        [Markup.button.callback('Hindi (हिंदी)', 'ob_l_Hindi'), Markup.button.callback('Indonesian (Bahasa)', 'ob_l_Indonesian')],
        [Markup.button.callback('Iranian (فارسی)', 'ob_l_Iranian'), Markup.button.callback('Spanish (Español)', 'ob_l_Spanish')],
        [Markup.button.callback('Arabic (العربية)', 'ob_l_Arabic'), Markup.button.callback('Russian (Русский)', 'ob_l_Russian')],
        [Markup.button.callback('French (Français)', 'ob_l_French'), Markup.button.callback('⏩ Skip', 'ob_l_skip')]
      ])
    }
  );
});

bot.action(/ob_l_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  const l = ctx.match[1];
  if (l !== 'skip') {
    db.prepare('UPDATE users SET language=? WHERE anon_id=?').run(l, s.anon_id);
  }
  await ctx.editMessageText(
    `✅ Language saved!\n\n*Step 3 of 4: What's your vibe today? (Mood)*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('😊 Happy', 'ob_m_Happy'), Markup.button.callback('🔥 Flirty', 'ob_m_Flirty')],
        [Markup.button.callback('😂 Funny', 'ob_m_Funny'), Markup.button.callback('😴 Chill', 'ob_m_Chill')],
        [Markup.button.callback('🤔 Deep / Philosophical', 'ob_m_Philosophical')],
        [Markup.button.callback('✍️ Type Custom Mood', 'ob_m_custom'), Markup.button.callback('⏩ Skip', 'ob_m_skip')]
      ])
    }
  );
});

bot.action('ob_m_custom', async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  s.awaitingCustomMood = true;
  await ctx.reply('✍️ *Type and send your custom mood below:*\n(e.g., "Listening to lofi", "Looking for late night talks", "Bored at home")', { parse_mode: 'Markdown' });
});

bot.action(/ob_m_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  const m = ctx.match[1];
  if (m === 'custom') return;
  if (m !== 'skip') {
    db.prepare('UPDATE users SET mood=? WHERE anon_id=?').run(m, s.anon_id);
  }
  const tags = INTEREST_TAGS.slice(0, 8);
  const rows = [];
  for (let i = 0; i < tags.length; i += 2) {
    rows.push([
      Markup.button.callback(tags[i], `ob_i_${tags[i]}`),
      tags[i+1] ? Markup.button.callback(tags[i+1], `ob_i_${tags[i+1]}`) : null
    ].filter(Boolean));
  }
  rows.push([Markup.button.callback('✅ Complete Setup', 'ob_done')]);

  await ctx.editMessageText(
    `✅ Mood saved!\n\n*Step 4 of 4: Tap any interests you like (or Complete Setup):*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows)
    }
  );
});

bot.action(/ob_i_(.+)/, async ctx => {
  const s = ensureSession(ctx);
  const tag = ctx.match[1];
  const u = getUser(s.anon_id);
  const cur = u.interests ? u.interests.split(',') : [];
  if (!cur.includes(tag)) {
    cur.push(tag);
    db.prepare('UPDATE users SET interests=? WHERE anon_id=?').run(cur.join(','), s.anon_id);
    await ctx.answerCbQuery(`Added ${tag}!`);
  } else {
    await ctx.answerCbQuery(`Already added!`);
  }
});

bot.action('ob_done', async ctx => {
  await ctx.answerCbQuery('Setup complete!');
  const s = ensureSession(ctx);
  const tg_id = ctx.from?.id || null;
  db.prepare("UPDATE users SET gender=COALESCE(NULLIF(gender,''), 'unspecified') WHERE anon_id=? OR (tg_id=? AND tg_id IS NOT NULL)").run(s.anon_id, tg_id);
  const u = getUser(s.anon_id, tg_id);
  await ctx.reply(
    `🎉 *Profile Ready!*\n\n` +
    `👤 *Gender:* ${u.gender || 'Not specified'}\n` +
    `🌐 *Language:* ${u.language || 'English'}\n` +
    `🎭 *Mood:* ${u.mood || 'Not specified'}\n` +
    `🏷 *Interests:* ${u.interests || 'None selected'}\n\n` +
    `You're all set to chat anonymously! Tap *🚀 Find a partner* below to begin:`,
    { parse_mode: 'Markdown', ...lobbyKb() }
  );
});

// Settings menu callbacks
bot.action('menu_profile', async ctx => { await ctx.answerCbQuery(); await showProfile(ctx); });
bot.action('menu_bonus',   async ctx => { await ctx.answerCbQuery(); await claimBonus(ctx); });
bot.action('menu_lang',    async ctx => { await ctx.answerCbQuery(); await showLanguagePicker(ctx); });
bot.action('menu_premium', async ctx => { await ctx.answerCbQuery(); await showPremiumPage(ctx); });
bot.action('menu_refer',   async ctx => { await ctx.answerCbQuery(); await showReferral(ctx); });
bot.action('menu_bots',    async ctx => { await ctx.answerCbQuery(); await showOurBots(ctx); });
bot.action('menu_link',    async ctx => { await ctx.answerCbQuery(); await showMyLink(ctx); });

// End chat feedback & report callbacks
bot.action(/fb_like_(.+)/, async ctx => {
  await ctx.answerCbQuery('Thank you for your feedback! 👍');
  const partnerAnon = ctx.match[1];
  saveRating(partnerAnon, 5);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

bot.action(/fb_dislike_(.+)/, async ctx => {
  await ctx.answerCbQuery('Feedback noted! 👎');
  const partnerAnon = ctx.match[1];
  saveRating(partnerAnon, 1);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

bot.action(/rep_spam_(.+)/, async ctx => {
  await ctx.answerCbQuery('Report submitted: Spam');
  const s = ensureSession(ctx);
  const partnerAnon = ctx.match[1];
  saveComplaint(s.anon_id, partnerAnon, 'VCS Spam', '[reported via end chat: VCS Spam]', 2);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('⚠️ Thank you. The report has been sent to our moderation team.');
});

bot.action(/rep_vulgar_(.+)/, async ctx => {
  await ctx.answerCbQuery('Report submitted: Vulgar behavior');
  const s = ensureSession(ctx);
  const partnerAnon = ctx.match[1];
  saveComplaint(s.anon_id, partnerAnon, 'Vulgar partner', '[reported via end chat: Vulgar partner]', 2);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('⚠️ Thank you. We take safety seriously and will review this user.');
});

bot.action(/rep_underage_(.+)/, async ctx => {
  await ctx.answerCbQuery('Report submitted: Underage user');
  const s = ensureSession(ctx);
  const partnerAnon = ctx.match[1];
  saveComplaint(s.anon_id, partnerAnon, 'Underage User', '[reported via end chat: Underage User]', 3);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('🚨 Safety report logged. Our team prioritizes minor protection immediately.');
});

bot.action(/rep_custom_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  s.awaitingComplaint = { accusedAnon: ctx.match[1] };
  await ctx.reply('📝 Please describe what happened so our moderation team can take action:');
});

bot.action(/interest_(.+)/, async ctx => {
  if (ctx.match[1]==='done') { await ctx.answerCbQuery('Saved!'); const s=ensureSession(ctx); const u=getUser(s.anon_id); return ctx.editMessageText(`✅ Interests saved: ${u.interests||'none'}`); }
  await ctx.answerCbQuery(); const s=ensureSession(ctx); const tag=ctx.match[1]; const u=getUser(s.anon_id);
  const cur=u.interests?u.interests.split(','):[], idx=cur.indexOf(tag);
  if (idx>=0) cur.splice(idx,1); else cur.push(tag);
  const nv=cur.slice(0,5).join(',');
  db.prepare('UPDATE users SET interests=? WHERE anon_id=?').run(nv||null, s.anon_id);
  await ctx.editMessageText(`🏷 *Select interests* (max 5):\nSelected: ${nv||'none'}`, { parse_mode:'Markdown', ...buildInterestKb(nv) });
});

bot.action('mood_custom_input', async ctx => {
  await ctx.answerCbQuery();
  const s = ensureSession(ctx);
  s.awaitingCustomMood = true;
  await ctx.reply('✍️ Send a message with your mood (e.g. *Chilling with music*, *Adventurous*, *Bored*):', { parse_mode: 'Markdown' });
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
bot.action(/gm_next_(\w+)_(.+)/, async ctx => {
  await ctx.answerCbQuery(gameAdText || 'Loading next question...', { show_alert: false });
  const [, name, chatId] = ctx.match;
  const chat = activeChats.get(chatId);
  if (!chat) return ctx.reply('No active chat found.');
  await startGame(chatId, name, chat.a_tg, chat.b_tg);
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

  // Custom mood text input
  if (s.awaitingCustomMood) {
    const customMood = ctx.message.text?.trim()?.slice(0, 35);
    if (!customMood) return ctx.reply('Please send a text description of your mood.');
    db.prepare('UPDATE users SET mood=? WHERE anon_id=?').run(customMood, s.anon_id);
    s.awaitingCustomMood = false;
    await ctx.reply(`✅ Mood saved as: *${customMood}*!`, { parse_mode: 'Markdown' });
    const u = getUser(s.anon_id);
    if (!u.gender) {
      return startOnboarding(ctx, s.anon_id);
    }
    return ctx.reply("🏠 You're ready to chat!", lobbyKb());
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
    } catch(e) {
      console.error('Forward error:', e.message);
      // If partner blocked the bot or deleted Telegram
      if (e.message && (e.message.includes('blocked') || e.message.includes('deactivated') || e.message.includes('not found') || e.message.includes('chat not found'))) {
        await ctx.reply('⚠️ *Your partner has left or blocked the bot.*', { parse_mode:'Markdown', ...endChatKb() });
        await endChat(chatId, 'partner_left');
        return;
      }
    }
    if (chat.a_tg === tg_id) chat.a_msgs++; else chat.b_msgs++;
    db.prepare('UPDATE users SET total_messages=total_messages+1 WHERE anon_id=?').run(m.anon);
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
  const s = ensureSession(ctx);
  const u = getUser(s.anon_id);
  await ctx.reply(
    `🔒 *Match by Interest*\n\n` +
    `This feature will unlock once GhostTalk reaches *100,000 active users*! 🚀\n\n` +
    `For now, matches are made randomly. You can still set your interest tags so your vibe is visible on your profile:\n\n` +
    `Selected: ${u.interests || 'none'}`,
    { parse_mode: 'Markdown', ...buildInterestKb(u.interests) }
  );
}
async function showMoodPicker(ctx) {
  const btns=MOODS.map(m=>Markup.button.callback(m,`mood_${m}`)); const rows=[];
  for (let i=0;i<btns.length;i+=2) rows.push(btns.slice(i,i+2));
  rows.push([Markup.button.callback('✍️ Custom Mood', 'mood_custom_input'), Markup.button.callback('🚫 Clear Mood', 'mood_clear')]);
  await ctx.reply("🎭 *Set your mood:*\nChoose from below or type your custom mood!", { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
}
async function showLanguagePicker(ctx) {
  const btns = [
    Markup.button.callback('🎲 Random / Any', 'lang_any'),
    Markup.button.callback('English', 'lang_english'),
    Markup.button.callback('Hindi (हिंदी)', 'lang_hindi'),
    Markup.button.callback('Indonesian (Bahasa)', 'lang_indonesian'),
    Markup.button.callback('Iranian (فارسی)', 'lang_iranian'),
    Markup.button.callback('Spanish (Español)', 'lang_spanish'),
    Markup.button.callback('Arabic (العربية)', 'lang_arabic'),
    Markup.button.callback('Russian (Русский)', 'lang_russian'),
    Markup.button.callback('French (Français)', 'lang_french')
  ];
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  await ctx.reply('🌐 *Preferred language:*\nSelect your preferred language, or choose 🎲 Random / Any to chat with anyone worldwide!', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}
async function showLeaderboard(ctx) {
  if (!isAdmin(ctx)) {
    return ctx.reply('🔒 The Leaderboard is viewable on our Admin Web Dashboard.\n\nKeep chatting to earn streaks and climb the ranks!');
  }
  const top = db.prepare(`SELECT anon_id,chat_count,streak_days,total_messages,CASE WHEN rating_count>0 THEN ROUND(CAST(rating_sum AS FLOAT)/rating_count,1) ELSE 0 END as avg_rating FROM users ORDER BY chat_count DESC LIMIT 10`).all();
  if (!top.length) return ctx.reply('No users yet!');
  const m=['🥇','🥈','🥉'];
  const lines=top.map((u,i)=>`${m[i]||`${i+1}.`} \`${u.anon_id.slice(0,6)}...\` | 💬${u.chat_count} | 🔥${u.streak_days}d | ⭐${u.avg_rating}`).join('\n');
  await ctx.reply(`📊 *Admin Leaderboard Preview*\n\n${lines}`, { parse_mode:'Markdown' });
}
async function showReferral(ctx) {
  const s = ensureSession(ctx); const u = getUser(s.anon_id);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.referral_code}`;
  await ctx.reply(
    `🤝 *Affiliate & Referral Program*\n\n` +
    `Invite friends or your audience to GhostTalk using your personal affiliate link!\n\n` +
    `🔗 *Your Affiliate Link:*\n\`${link}\`\n\n` +
    `📊 *Your Stats:*\n` +
    `├ 👥 Total Users Invited: *${u.referral_count || 0}*\n` +
    `└ 🎁 Reward: *Every 3 invites = +1 Free VIP Day*\n\n` +
    `Share this link on your Telegram channels, groups, Instagram, or WhatsApp to earn rewards automatically!`,
    { parse_mode: 'Markdown' }
  );
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
  if (DASH_SECRET && DASH_SECRET !== 'change_me_in_env') {
    const secret = req.headers['x-dash-secret'] || req.query.secret;
    if (secret !== DASH_SECRET) return res.status(401).json({ error: 'Unauthorized: invalid dashboard secret' });
  }
  next();
}

// ── PUBLIC: Health + basic stats ──────────────────────────────────────────────
webApp.get(['/health', '/api/health'], (req, res) => res.json({ status:'ok', uptime:process.uptime() }));
webApp.get('/ghosttalk_intro.jpg', (req, res) => {
  const p = path.join(__dirname, 'ghosttalk_intro.jpg');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

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

webApp.get('/api/admin/ad', requireDashSecret, (req, res) => {
  res.json({ ok: true, adText: getSetting('ad_toast_text', gameAdText) || gameAdText });
});

webApp.post('/api/admin/set-ad', requireDashSecret, (req, res) => {
  const { adText } = req.body;
  if (typeof adText !== 'string') return res.status(400).json({ error: 'adText string required' });
  setSetting('ad_toast_text', adText);
  gameAdText = adText;
  res.json({ ok: true, adText: gameAdText });
});

webApp.get('/api/admin/ads-config', requireDashSecret, (req, res) => {
  let channels = [];
  try { channels = JSON.parse(getSetting('force_sub_channels', '[]')); } catch(e) {}
  if (!channels || !channels.length) {
    channels = [
      { name: '🎵 Ghost Music Bot', url: 'https://t.me/GhostMusic_Bot' },
      { name: '👻 The Ghost Talk Bot', url: `https://t.me/${BOT_USERNAME}` }
    ];
  }
  res.json({
    adToastText: getSetting('ad_toast_text', gameAdText) || gameAdText,
    adBannerEnabled: getSetting('ad_banner_enabled', 'false') === 'true',
    adBannerText: getSetting('ad_banner_text', `📢 *Sponsored:* [Ghost Music Bot](https://t.me/GhostMusic_Bot) — Play songs in Telegram VC!`),
    adBannerBtnText: getSetting('ad_banner_btn_text', '🎵 Try Ghost Music'),
    adBannerBtnUrl: getSetting('ad_banner_btn_url', 'https://t.me/GhostMusic_Bot'),
    forceSubEnabled: getSetting('force_sub_enabled', 'true') === 'true',
    forceSubInterval: parseInt(getSetting('force_sub_interval', '3')) || 3,
    forceSubChannels: channels
  });
});

webApp.post('/api/admin/ads-config', requireDashSecret, (req, res) => {
  const { adToastText, adBannerEnabled, adBannerText, adBannerBtnText, adBannerBtnUrl, forceSubEnabled, forceSubInterval, forceSubChannels } = req.body;
  if (adToastText !== undefined) {
    setSetting('ad_toast_text', adToastText);
    gameAdText = adToastText;
  }
  if (adBannerEnabled !== undefined) setSetting('ad_banner_enabled', String(adBannerEnabled));
  if (adBannerText !== undefined) setSetting('ad_banner_text', adBannerText);
  if (adBannerBtnText !== undefined) setSetting('ad_banner_btn_text', adBannerBtnText);
  if (adBannerBtnUrl !== undefined) setSetting('ad_banner_btn_url', adBannerBtnUrl);
  if (forceSubEnabled !== undefined) setSetting('force_sub_enabled', String(forceSubEnabled));
  if (forceSubInterval !== undefined) setSetting('force_sub_interval', String(forceSubInterval));
  if (forceSubChannels !== undefined) setSetting('force_sub_channels', JSON.stringify(forceSubChannels));
  res.json({ ok: true, message: 'Settings saved successfully' });
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
