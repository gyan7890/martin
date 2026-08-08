require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('🛡 [24/7 Shield] UncaughtException caught cleanly:', err?.stack || err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡 [24/7 Shield] UnhandledRejection caught cleanly:', reason?.stack || reason?.message || reason);
});

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');

// =====================
// CONFIG
// =====================
const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();
const STORE_NAME = process.env.STORE_NAME || 'Digital Store';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '@support';
const CHANNEL_URL = process.env.CHANNEL_URL || '';
const DEFAULT_CURRENCY = String(process.env.STORE_CURRENCY || 'USD').toUpperCase();
const BOT_USERNAME = String(process.env.BOT_USERNAME || '').replace('@', '').trim();
const PORT = Number(process.env.PORT || 3000);
const SHOP_PAGE_SIZE = Number(process.env.SHOP_PAGE_SIZE || 12);
const POLL_TIMEOUT = Number(process.env.POLL_TIMEOUT || 8);
const WEB_BASE_URL = String(process.env.WEB_BASE_URL || process.env.APP_URL || process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || '').trim();
const UPI_ID = process.env.UPI_ID || 'yourupi@paytm';
const UPI_NAME = process.env.UPI_NAME || 'Global Store';
const UPI_QR_URL = process.env.UPI_QR_URL || '';
const PAYMENT_LINK = process.env.PAYMENT_LINK || '';

const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const BINANCE_LOOKBACK_DAYS = Number(process.env.BINANCE_DEPOSIT_LOOKBACK_DAYS || 7);
const BINANCE_AMOUNT_TOLERANCE = Number(process.env.BINANCE_AMOUNT_TOLERANCE || 0.02);
const BINANCE_ALLOW_PARTIAL_TXID = String(process.env.BINANCE_ALLOW_PARTIAL_TXID || 'false').toLowerCase() === 'true';

function _dbReady() { try { return db && db.settings; } catch(e) { return null; } }
function getStoreName() {
  const s = _dbReady(); return (s && s.storeName) ? s.storeName : STORE_NAME;
}
function getBotToken() {
  const s = _dbReady(); return (s && s.botToken) ? s.botToken : BOT_TOKEN;
}
function getAdminId() {
  const s = _dbReady(); return (s && s.adminId) ? s.adminId : ADMIN_ID;
}
function getAdminWebUser() {
  const s = _dbReady(); return (s && s.adminWebUser) ? s.adminWebUser : (process.env.ADMIN_WEB_USER || 'admin');
}
function getAdminWebPassword() {
  const s = _dbReady(); return (s && s.adminWebPassword) ? s.adminWebPassword : (process.env.ADMIN_WEB_PASSWORD || 'admin123');
}

console.log('🚀 Booting', STORE_NAME);
console.log('🔐 BOT_TOKEN:', BOT_TOKEN ? 'SET' : 'MISSING');
console.log('👑 ADMIN_ID:', ADMIN_ID);
console.log('💵 STORE_CURRENCY:', DEFAULT_CURRENCY);
console.log('⚡ Vercel Mode:', IS_VERCEL ? 'ENABLED' : 'DISABLED');

if (!getBotToken() || !/^\d+:[A-Za-z0-9_-]+$/.test(getBotToken())) {
  console.warn('⚠️ BOT_TOKEN missing or invalid. Set BOT_TOKEN in .env or via Web Admin panel.');
}

function getApiUrl() {
  return `https://api.telegram.org/bot${getBotToken()}`;
}
const API = getApiUrl();
const DATA_FILE = IS_VERCEL ? path.join('/tmp', 'data.json') : path.join(__dirname, 'data.json');

function getUpiId() {
  return (typeof db !== 'undefined' && db?.settings?.upiId) ? db.settings.upiId : UPI_ID;
}

function getUpiName() {
  return (typeof db !== 'undefined' && db?.settings?.upiName) ? db.settings.upiName : UPI_NAME;
}

function getUpiQrUrl(amount = '') {
  if (typeof db !== 'undefined' && db?.settings?.upiQrUrl) return db.settings.upiQrUrl;
  if (UPI_QR_URL) return UPI_QR_URL;
  const upiId = getUpiId();
  const upiName = getUpiName();
  const amtNum = Number(amount);
  const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName)}${amtNum > 0 ? '&am=' + amtNum : ''}&cu=INR`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiUri)}`;
}

async function sendUpiPayment(chatId, amount = 'Custom') {
  const upiId = getUpiId();
  const upiName = getUpiName();
  const qrUrl = getUpiQrUrl(amount !== 'Custom' ? amount : '');
  const payLink = PAYMENT_LINK || (typeof db !== 'undefined' && db?.settings?.paymentLink) || '';

  const text = `💳 <b>UPI Payment Info</b>\n\n🏪 <b>Store:</b> ${escapeHtml(STORE_NAME)}\n👤 <b>Payee Name:</b> <code>${escapeHtml(upiName)}</code>\n🆔 <b>UPI ID:</b> <code>${escapeHtml(upiId)}</code>\n💰 <b>Amount:</b> ${escapeHtml(String(amount))}\n\n📲 <b>Scan QR Code or copy UPI ID above to pay via PhonePe / Paytm / GPay / BHIM.</b>\n\n📸 <i>After payment, send your transaction screenshot or UTR to support.</i>`;

  const buttons = [];
  if (payLink) buttons.push([{ text: '💳 Pay Now', url: payLink }]);
  buttons.push([{ text: '📲 Scan QR Code', url: qrUrl }]);
  buttons.push([{ text: '👨‍💻 Contact Support', url: `https://t.me/${SUPPORT_USERNAME.replace('@','')}` }]);

  return sendMessage(chatId, text, inline(buttons));
}

const LOCK_FILE = path.join(__dirname, '.global_ott_store_bot.lock');
const sessions = new Map();
let updateOffset = 0;
let botUsername = BOT_USERNAME || 'YourBotUsername';
let lastHeartbeat = 0;

// Runtime health/speed stats used by Health Checker and Telegram API speed tracker.
const runtimeStats = {
  startedAt: Date.now(),
  updates: 0,
  messages: 0,
  callbacks: 0,
  groupMessages: 0,
  errors: 0,
  lastUpdateAt: 0,
  lastCallback: '',
  lastMessage: '',
  apiCalls: 0,
  apiErrors: 0,
  apiTotalMs: 0,
  apiMaxMs: 0,
  apiSamples: []
};

// =====================
// SINGLE INSTANCE LOCK
// =====================
const TOKEN_HASH = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 16);

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function acquireSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
      const [oldHash, oldPidRaw] = raw.includes(':') ? raw.split(':') : ['', raw];
      const oldPid = Number(oldPidRaw);
      if (oldHash === TOKEN_HASH && oldPid && oldPid !== process.pid && isProcessAlive(oldPid)) {
        console.log(`⚠️ Same bot token already running with PID ${oldPid}. Exiting duplicate process.`);
        process.exit(0);
      }
    }
    fs.writeFileSync(LOCK_FILE, `${TOKEN_HASH}:${process.pid}`, 'utf8');
    console.log(`✅ Single instance lock acquired. PID: ${process.pid}`);
  } catch (err) {
    console.error('⚠️ Lock error:', err.message);
  }
}

process.on('exit', () => {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
      if (raw === `${TOKEN_HASH}:${process.pid}`) fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
});

if (!IS_VERCEL) acquireSingleInstanceLock();

process.on('unhandledRejection', (err) => console.error('❌ Unhandled:', err?.stack || err?.message || err));
process.on('uncaughtException', (err) => console.error('❌ Uncaught:', err?.stack || err?.message || err));

// =====================
// STORAGE
// =====================
function now() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    users: {},
    chatMessages: {},
    products: [
      {
        code: 'P001',
        emoji: '🤖',
        name: 'ChatGPT Plus 1 Month',
        price: 2.5,
        currency: DEFAULT_CURRENCY,
        description: '✅ Instant Coupon Delivery\n✅ 1 Month Warranty',
        stock: ['CHATGPT-CODE-001'],
        sold: 0,
        active: true,
        pinned: true,
        logoFileId: '',
        specialPrices: {},
        stockFormat: 'coupon_code',
        createdAt: now()
      },
      {
        code: 'P002',
        emoji: '🎨',
        name: 'Canva Business 1 Year',
        price: 20,
        currency: DEFAULT_CURRENCY,
        description: '✅ Instant Coupon Delivery\n✅ Full Year Warranty',
        stock: ['CANVA-CODE-001'],
        sold: 0,
        active: true,
        pinned: false,
        logoFileId: '',
        specialPrices: {},
        stockFormat: 'coupon_code',
        createdAt: now()
      },
      {
        code: 'P003',
        emoji: '🔍',
        name: 'Perplexity Pro 1 Year',
        price: 8,
        currency: DEFAULT_CURRENCY,
        description: '✅ Instant Coupon Delivery\n✅ Full Year Warranty',
        stock: ['PERPLEXITY-CODE-001'],
        sold: 0,
        active: true,
        pinned: false,
        logoFileId: '',
        specialPrices: {},
        stockFormat: 'coupon_code',
        createdAt: now()
      }
    ],
    orders: [],
    payments: [],
    deposits: [],
    coupons: [],
    webAudit: [],
    supportTickets: [],
    channelRules: [],
    alertGroups: [],
    groupAlertLogs: [],
    healthLogs: [],
    deliveryAuditLogs: [],
    stockWaitLogs: [],
    adminNotes: [],
    autoVerifyLogs: [],
    wishlists: {},
    restockRequests: [],
    reviews: [],
    admins: [],
    adminActionLogs: [],
    securityLogs: [],
    securityCounters: {},
    securityLocks: {},
    paymentMethods: [
      { id: 'PM001', key: 'BINANCE_PAY', icon: '🟡', name: 'Binance Pay', details: 'Pay normal amount using Binance UID. No TXID needed.', active: true },
      { id: 'PM002', key: 'USDT_BEP20', icon: '🟨', name: 'USDT BEP20', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM003', key: 'USDT_TRC20', icon: '🟢', name: 'USDT TRC20', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM004', key: 'USDT_ERC20', icon: '⚪', name: 'USDT ERC20', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM005', key: 'USDT_POLYGON', icon: '🟣', name: 'USDT Polygon', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM006', key: 'SOL', icon: '🟪', name: 'SOL Solana', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM007', key: 'LTC', icon: '🔵', name: 'LTC Litecoin', details: 'Send normal amount. No TXID needed.', active: true },
      { id: 'PM008', key: 'BTC', icon: '🟠', name: 'BTC Bitcoin', details: 'Send normal amount. No TXID needed.', active: true }
    ],
    settings: {
      storeCurrency: DEFAULT_CURRENCY,
      botUsername: BOT_USERNAME || '',
      supportUsername: SUPPORT_USERNAME,
      channelUrl: CHANNEL_URL,
      binanceId: process.env.BINANCE_ID || '1138472888',
      binanceName: process.env.BINANCE_NAME || 'YourStore',
      binanceCoin: process.env.BINANCE_COIN || 'USDT',
      binanceApiKey: process.env.BINANCE_API_KEY || '',
      binanceSecretKey: process.env.BINANCE_SECRET_KEY || '',
      binanceBaseUrl: BINANCE_BASE_URL,
      binanceLookbackDays: BINANCE_LOOKBACK_DAYS,
      binanceAmountTolerance: BINANCE_AMOUNT_TOLERANCE,
      binanceAllowPartialTxid: BINANCE_ALLOW_PARTIAL_TXID,
      paymentVerifyMode: 'both',
      bep20Address: process.env.BEP20_ADDRESS || ''
    }
  };
}

const MONGODB_URI = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
const MONGODB_DB = String(process.env.MONGODB_DB || 'global_ott_store').trim();
const MONGODB_COLLECTION = String(process.env.MONGODB_COLLECTION || 'bot_data').trim();

let mongoClient = null;
let mongoCol = null;
let lastMongoSaveMs = 0;
let isMongoInitialized = false;

async function getMongoCollection() {
  if (!MONGODB_URI) return null;
  if (mongoCol) return mongoCol;
  try {
    const { MongoClient } = require('mongodb');
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
      });
      await mongoClient.connect();
      console.log('✅ Connected to MongoDB Atlas cloud database');
    }
    const dbObj = mongoClient.db(MONGODB_DB);
    mongoCol = dbObj.collection(MONGODB_COLLECTION);
    return mongoCol;
  } catch (err) {
    console.error('⚠️ MongoDB Atlas connection error:', err.message);
    return null;
  }
}

async function loadDataFromMongo() {
  if (!MONGODB_URI) return null;
  try {
    const col = await getMongoCollection();
    if (!col) return null;
    const doc = await col.findOne({ _id: 'store_data' });
    if (doc && doc.data && typeof doc.data === 'object') {
      console.log('✅ Loaded latest store data from MongoDB Atlas cloud database');
      return doc.data;
    }
  } catch (err) {
    console.error('⚠️ Failed loading data from MongoDB Atlas:', err.message);
  }
  return null;
}

async function saveDataToMongo(force = false) {
  if (!MONGODB_URI) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastMongoSaveMs < 500) return;
  lastMongoSaveMs = nowMs;
  try {
    const col = await getMongoCollection();
    if (!col) return;
    await col.updateOne(
      { _id: 'store_data' },
      { $set: { _id: 'store_data', data: db, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('⚠️ MongoDB Atlas save failed:', err.message);
  }
}

function sanitizeLoadedDb(d) {
  if (!d || typeof d !== 'object') d = defaultData();
  d.users ||= {};
  d.chatMessages ||= {};
  d.products ||= [];
  d.orders ||= [];
  d.payments ||= [];
  d.deposits ||= [];
  d.coupons ||= [];
  d.webAudit ||= [];
  d.supportTickets ||= [];
  d.channelRules ||= [];
  d.autoVerifyLogs ||= [];
  d.wishlists ||= {};
  d.restockRequests ||= [];
  d.reviews ||= [];
  d.admins ||= [];
  d.adminActionLogs ||= [];
  d.campaignLogs ||= [];
  if (!d.admins.some(a => String(a.id) === ADMIN_ID)) d.admins.unshift({ id: ADMIN_ID, username: '', name: 'Owner', role: 'owner', active: true, addedBy: 'system', addedAt: now(), note: 'Main owner from ADMIN_ID' });
  d.settings ||= {};
  d.settings.storeNotice ||= '';
  d.settings.featuredProductCode ||= '';
  d.settings.lowStockThreshold ||= 2;
  d.settings.channelAlertsEnabled = d.settings.channelAlertsEnabled === false ? false : true;
  d.settings.channelAutoReplyEnabled = d.settings.channelAutoReplyEnabled === false ? false : true;
  d.settings.channelIds ||= '';
  d.alertGroups ||= [];
  d.groupAlertLogs ||= [];
  d.settings.autoRegisterGroups = d.settings.autoRegisterGroups === false ? false : true;
  d.settings.groupAlertsEnabled = d.settings.groupAlertsEnabled === false ? false : true;
  d.settings.groupKeywordReplyEnabled = d.settings.groupKeywordReplyEnabled === false ? false : true;
  d.settings.groupReplyDirectBuyKeyboard = d.settings.groupReplyDirectBuyKeyboard === false ? false : true;
  d.settings.groupReplyOnlyRegisteredGroups = d.settings.groupReplyOnlyRegisteredGroups === true ? true : false;
  d.settings.groupReplyWithSupportButton = d.settings.groupReplyWithSupportButton === false ? false : true;
  d.settings.groupReplyWithShopButton = d.settings.groupReplyWithShopButton === false ? false : true;
  d.settings.groupWelcomeOnRegister = d.settings.groupWelcomeOnRegister === false ? false : true;
  d.settings.groupAlertCooldownMinutes ||= 10;
  d.settings.publicAlertChatIds ||= '';
  d.settings.paymentVerifyMode ||= 'both';
  d.settings.bep20Address ||= process.env.BEP20_ADDRESS || '';
  d.settings.purchaseAlertsEnabled = d.settings.purchaseAlertsEnabled === false ? false : true;
  d.settings.groupAutoReplyEnabled = d.settings.groupAutoReplyEnabled === false ? false : true;
  d.settings.premiumProductCards = d.settings.premiumProductCards === false ? false : true;
  d.settings.autoVerifyEnabled = d.settings.autoVerifyEnabled === false ? false : true;
  d.settings.autoVerifyIntervalSec ||= 25;
  d.settings.autoVerifyAmountMatch = d.settings.autoVerifyAmountMatch === false ? false : true;
  d.settings.autoVerifyMaxAgeHours ||= 24;
  d.settings.noTxidMode = d.settings.noTxidMode === false ? false : true;
  d.settings.uniqueAmountEnabled = d.settings.uniqueAmountEnabled === true ? true : false;
  d.settings.uniqueAmountMaxCents ||= 99;
  d.settings.noTxidTolerance ||= 0.001;
  d.settings.paymentReminderMinutes ||= 3;
  d.settings.paymentExpiryMinutes ||= 30;
  d.settings.pendingExpiryNotifyUser = d.settings.pendingExpiryNotifyUser === false ? false : true;
  d.settings.stockWaitAutoDelivery = d.settings.stockWaitAutoDelivery === false ? false : true;
  d.settings.stockWaitNotifyUser = d.settings.stockWaitNotifyUser === false ? false : true;
  d.settings.stockWaitPriorityFirst = d.settings.stockWaitPriorityFirst === false ? false : true;
  d.stockWaitLogs ||= [];
  d.adminNotes ||= [];
  d.settings.lowStockThreshold ||= 2;
  d.settings.faqText ||= '❓ FAQ\n\n1. Delivery is automatic after payment approval.\n2. Use correct payment note/reference for faster verification.\n3. For bulk orders, contact support.';
  d.settings.deliveryMessageTemplate ||= '';
  d.settings.afterDeliveryNote ||= 'Please save your delivery details safely. For any issue, contact support with your Order ID.';
  d.settings.productDescriptionStyle ||= 'premium_detailed';
  d.settings.autoDetailedDescriptions = d.settings.autoDetailedDescriptions === false ? false : true;
  d.settings.loyaltyEnabled = d.settings.loyaltyEnabled === false ? false : true;
  d.settings.loyaltyPointsPerDollar ||= 1;
  d.settings.premiumStockAlertTemplate ||= '';
  d.settings.premiumFlashSaleTemplate ||= '';
  d.settings.premiumGroupReplyTemplate ||= '';
  d.settings.alertFooterText ||= 'Fast checkout • Auto delivery • Premium support';
  Object.values(d.users || {}).forEach((u) => { u.banned = u.banned === true ? true : false; });
  d.paymentMethods ||= [];
  if (!d.paymentMethods.some(m => m.key === 'UPI_PAY')) {
    d.paymentMethods.unshift({ id: 'PM000', key: 'UPI_PAY', icon: '🇮🇳', name: 'UPI / PhonePe / GPay / Paytm', details: 'Pay instantly via UPI ID or QR Code. Enter UTR / Reference after payment.', active: true });
  }
  d.settings.upiId ||= process.env.UPI_ID || 'yourupi@paytm';
  d.settings.upiName ||= process.env.UPI_NAME || 'Global Store';
  d.settings.upiQrUrl ||= process.env.UPI_QR_URL || '';
  d.products.forEach((p) => {
    p.specialPrices ||= {};
    p.stock ||= [];
    p.stockFormat ||= 'redeem_link';
    p.deliveryMessageTemplate ||= '';
    p.shortDetails ||= '';
    p.warrantyText ||= '';
    p.redeemSteps ||= '';
    p.importantNotes ||= '';
    p.customStockAlertTemplate ||= '';
    p.customFlashSaleTemplate ||= '';
    p.customGroupReplyTemplate ||= '';
    p.groupKeywords ||= '';
    p.groupReplyCount ||= 0;
    p.safeDeliveryEnabled = p.safeDeliveryEnabled === false ? false : true;
    p.active = p.active === false ? false : true;
  });
  d.securityLogs ||= [];
  d.securityCounters ||= {};
  d.securityLocks ||= {};
  d.settings.storeCurrency ||= DEFAULT_CURRENCY;
  d.settings.botUsername ||= BOT_USERNAME || '';
  d.settings.webBaseUrl ||= WEB_BASE_URL || '';
  d.settings.supportUsername ||= SUPPORT_USERNAME;
  d.settings.channelUrl ||= CHANNEL_URL;
  d.settings.maintenanceMode ||= false;
  d.settings.maintenanceMessage ||= 'Store is under maintenance. Please try again later.';
  d.settings.binanceId ||= process.env.BINANCE_ID || '1138472888';
  d.settings.binanceName ||= process.env.BINANCE_NAME || 'YourStore';
  d.settings.binanceCoin ||= process.env.BINANCE_COIN || 'USDT';
  d.settings.binanceApiKey ||= process.env.BINANCE_API_KEY || '';
  d.settings.binanceSecretKey ||= process.env.BINANCE_SECRET_KEY || '';
  d.settings.binanceBaseUrl ||= BINANCE_BASE_URL;
  d.settings.binanceLookbackDays ||= BINANCE_LOOKBACK_DAYS;
  d.settings.binanceAmountTolerance ||= BINANCE_AMOUNT_TOLERANCE;
  d.settings.securityRateLimitEnabled = d.settings.securityRateLimitEnabled === false ? false : true;
  d.settings.userMessageLimitPerMin ||= 30;
  d.settings.userCallbackLimitPerMin ||= 50;
  d.settings.paymentVerifyLimitPer10Min ||= 6;
  d.settings.txidSubmitLimitPer15Min ||= 5;
  d.settings.autoLockSuspiciousPayments = d.settings.autoLockSuspiciousPayments === false ? false : true;
  d.settings.paymentFailReviewThreshold ||= 5;
  d.settings.securityAlertsToAdmins = d.settings.securityAlertsToAdmins === false ? false : true;
  d.settings.autoBackupEnabled = d.settings.autoBackupEnabled === false ? false : true;
  d.settings.autoBackupIntervalHours ||= 6;
  d.settings.autoBackupMaxFiles ||= 30;
  d.settings.businessSummaryEnabled = d.settings.businessSummaryEnabled === false ? false : true;
  if (d.settings.binanceAllowPartialTxid === undefined) d.settings.binanceAllowPartialTxid = BINANCE_ALLOW_PARTIAL_TXID;
  return d;
}

function loadData() {
  const rootDataPath = path.join(__dirname, 'data.json');
  if (IS_VERCEL && !fs.existsSync(DATA_FILE) && fs.existsSync(rootDataPath)) {
    try {
      fs.copyFileSync(rootDataPath, DATA_FILE);
      console.log('✅ Copied root data.json to /tmp/data.json for Vercel serverless execution');
    } catch (e) {
      console.error('Failed copying data.json to /tmp:', e.message);
    }
  }

  if (!fs.existsSync(DATA_FILE)) {
    const fresh = defaultData();
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
      console.log('✅ Fresh data.json created');
    } catch (e) {
      console.error('Failed writing fresh data.json:', e.message);
    }
    return fresh;
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return sanitizeLoadedDb(d);
  } catch (err) {
    const backup = `${DATA_FILE}.broken-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, backup); } catch (_) {}
    console.error('❌ data.json invalid, backup at', backup);
    const fresh = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    console.log('✅ Fresh data.json created after broken backup');
    return fresh;
  }
}

let db = loadData();

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (err) {
    console.error('File saveData error:', err.message);
  }
  if (MONGODB_URI) {
    saveDataToMongo().catch((e) => console.error('Background Mongo save failed:', e.message));
  }
}

// =====================
// UTILS
// =====================
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function trim(s, max = 3900) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 20) + '\n...trimmed' : s;
}


function adminUsernameList() {
  return String(process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map(x => x.replace('@', '').trim().toLowerCase())
    .filter(Boolean);
}

function isOwnerUsername(username = '') {
  const u = String(username || '').replace('@', '').trim().toLowerCase();
  return Boolean(u && adminUsernameList().includes(u));
}

function ensureTelegramAdmin(from) {
  if (!from?.id) return false;
  db.admins ||= [];
  const id = String(from.id);
  const username = String(from.username || '');
  const firstName = String(from.first_name || from.firstName || username || 'Admin');

  if ((ADMIN_ID && id === ADMIN_ID) || isOwnerUsername(username)) {
    const existing = db.admins.find(a => String(a.id) === id);
    if (existing) {
      existing.role = 'owner';
      existing.active = true;
      existing.username = username || existing.username || '';
      existing.name = firstName || existing.name || 'Owner';
    } else {
      db.admins.unshift({
        id,
        username,
        name: firstName || 'Owner',
        role: 'owner',
        active: true,
        addedBy: 'auto-owner-username',
        addedAt: now(),
        note: 'Auto owner admin from ADMIN_ID/ADMIN_USERNAMES'
      });
    }
    saveData();
    return true;
  }

  const a = db.admins.find(x => String(x.id) === id);
  if (a) {
    if (username && a.username !== username) a.username = username;
    if (firstName && a.name !== firstName) a.name = firstName;
    saveData();
    return a.active !== false;
  }
  return false;
}


function adminAccessDebugText(from = {}) {
  const username = String(from.username || '').replace('@', '');
  return `🛠 <b>Telegram Admin Access Debug</b>

Your Telegram ID: <code>${escapeHtml(from.id || '-')}</code>
Username: ${username ? '@' + escapeHtml(username) : '-'}

Current ADMIN_ID: <code>${escapeHtml(ADMIN_ID)}</code>
Owner usernames: <code>${escapeHtml(adminUsernameList().join(', ') || '-')}</code>

If this is your owner account, set in hosting ENV:
<code>ADMIN_ID=${escapeHtml(from.id || '')}</code>
<code>ADMIN_USERNAMES=${escapeHtml(username || 'yourstore')}</code>

Then restart/redeploy bot.`;
}



function addHealthLog(type, detail = {}, severity = 'info') {
  try {
    db.healthLogs ||= [];
    db.healthLogs.unshift({
      id: 'HL' + Date.now() + Math.floor(Math.random() * 999),
      type: String(type || 'event'),
      detail,
      severity,
      at: now()
    });
    db.healthLogs = db.healthLogs.slice(0, 500);
    saveData();
  } catch (_) {}
}

function addDeliveryAuditLog(type, orderId = '', detail = {}, severity = 'info') {
  try {
    db.deliveryAuditLogs ||= [];
    db.deliveryAuditLogs.unshift({
      id: 'DL' + Date.now() + Math.floor(Math.random() * 999),
      type,
      orderId: String(orderId || ''),
      detail,
      severity,
      at: now()
    });
    db.deliveryAuditLogs = db.deliveryAuditLogs.slice(0, 500);
    saveData();
  } catch (_) {}
}

function dataFileBytes() {
  try { return fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : 0; } catch (_) { return 0; }
}

function runtimeHealthSnapshot() {
  const mem = process.memoryUsage();
  const paymentsPending = (db.payments || []).filter(p => p.status === 'pending' || p.status === 'review').length;
  const ordersFailed = (db.orders || []).filter(o => o.deliveryStatus === 'failed').length;
  const undelivered = typeof undeliveredPayments === 'function' ? undeliveredPayments().length : 0;
  const duplicateTxids = securitySummary().dupRefs.length;
  const groupsActive = typeof activeAlertGroups === 'function' ? activeAlertGroups().length : 0;
  const ok =
    runtimeStats.errors < 10 &&
    runtimeStats.apiErrors < 10 &&
    ordersFailed === 0 &&
    paymentsPending < 50 &&
    mem.rss < 512 * 1024 * 1024;
  return {
    ok,
    uptime: runtimeUptimeText(),
    uptimeSec: Math.floor((Date.now() - runtimeStats.startedAt) / 1000),
    ramMb: Math.round(mem.rss / 1024 / 1024),
    heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    apiAvg: apiAvgMs(),
    apiP95: apiP95Ms(),
    apiMax: Math.round(runtimeStats.apiMaxMs || 0),
    apiCalls: runtimeStats.apiCalls || 0,
    apiErrors: runtimeStats.apiErrors || 0,
    updates: runtimeStats.updates,
    messages: runtimeStats.messages,
    callbacks: runtimeStats.callbacks,
    errors: runtimeStats.errors,
    users: Object.keys(db.users || {}).length,
    products: (db.products || []).length,
    stock: (db.products || []).reduce((a,p)=>a+(p.stock?.length||0),0),
    orders: (db.orders || []).length,
    pendingPayments: paymentsPending,
    undelivered,
    failedDeliveries: ordersFailed,
    stockWait: stockWaitPayments().length,
    duplicateTxids,
    activeGroups: groupsActive,
    dataSize: dataFileBytes(),
    backups: typeof listDataBackups === 'function' ? listDataBackups().length : 0
  };
}

function healthStatusEmoji(s) {
  if (!s.ok) return '🔴';
  if (s.apiP95 > Number(db.settings.speedWarnMs || 2500) || s.failedDeliveries > 0 || s.undelivered > 0) return '🟡';
  return '🟢';
}

function premiumHealthText() {
  const s = runtimeHealthSnapshot();
  return `${healthStatusEmoji(s)} <b>BOT HEALTH & SPEED CHECKER</b>
━━━━━━━━━━━━━━━━━━━━

⚡ <b>Status:</b> ${s.ok ? 'Healthy' : 'Needs Attention'}
⏱ <b>Uptime:</b> ${escapeHtml(s.uptime)}
🧠 <b>RAM:</b> ${s.ramMb} MB | Heap: ${s.heapMb} MB

🚀 <b>Speed</b>
• API Avg: <b>${s.apiAvg} ms</b>
• API P95: <b>${s.apiP95} ms</b>
• API Max: <b>${s.apiMax} ms</b>
• API Calls: <b>${s.apiCalls}</b>
• API Errors: <b>${s.apiErrors}</b>

📊 <b>Traffic</b>
• Updates: <b>${s.updates}</b>
• Messages: <b>${s.messages}</b>
• Button Clicks: <b>${s.callbacks}</b>
• Runtime Errors: <b>${s.errors}</b>

📦 <b>Store</b>
• Users: <b>${s.users}</b>
• Products: <b>${s.products}</b>
• Stock Items: <b>${s.stock}</b>
• Orders: <b>${s.orders}</b>

🛡 <b>Safety</b>
• Pending/Review Payments: <b>${s.pendingPayments}</b>
• Undelivered Payments: <b>${s.undelivered}</b>
• Failed Deliveries: <b>${s.failedDeliveries}</b>
• Duplicate TXID Groups: <b>${s.duplicateTxids}</b>
• Active Alert Groups: <b>${s.activeGroups}</b>

💾 <b>Data:</b> ${escapeHtml(bytesHuman(s.dataSize))} | Backups: <b>${s.backups}</b>
━━━━━━━━━━━━━━━━━━━━
${s.ok ? '✅ <b>Everything looks stable.</b>' : '⚠️ <b>Review warnings above.</b>'}`;
}

async function runSpeedTest() {
  const started = Date.now();
  const tests = [];
  async function timed(name, fn) {
    const t = Date.now();
    try {
      await fn();
      tests.push({ name, ms: Date.now() - t, ok: true });
    } catch (err) {
      tests.push({ name, ms: Date.now() - t, ok: false, error: err.message });
    }
  }
  await timed('Telegram getMe', () => tgGet('getMe', {}, 12000));
  await timed('Data file check', async () => dataFileBytes());
  await timed('Product scan', async () => (db.products || []).reduce((a,p)=>a+(p.stock?.length||0),0));
  await timed('Security summary', async () => securitySummary());
  return { totalMs: Date.now() - started, tests };
}

function speedTestText(result) {
  let out = `⚡ <b>SPEED TEST RESULT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  result.tests.forEach((t, i) => {
    out += `${t.ok ? '🟢' : '🔴'} <b>${escapeHtml(t.name)}</b>: ${t.ms} ms${t.error ? `\n   Error: ${escapeHtml(t.error)}` : ''}\n`;
  });
  out += `\n⏱ <b>Total:</b> ${result.totalMs} ms\n`;
  out += `📈 <b>API Avg:</b> ${apiAvgMs()} ms | <b>P95:</b> ${apiP95Ms()} ms\n`;
  out += `━━━━━━━━━━━━━━━━━━━━\n${result.totalMs < 3000 ? '✅ <b>Speed is good.</b>' : '⚠️ <b>Speed is slow, check hosting/API.</b>'}`;
  return out;
}

function safeDeliverySummary() {
  const orders = db.orders || [];
  const failed = orders.filter(o => o.deliveryStatus === 'failed');
  const sent = orders.filter(o => o.deliveryStatus === 'sent' || o.deliveryStatus === 'delivered');
  const noItems = orders.filter(o => !Array.isArray(o.deliveredItems) || !o.deliveredItems.length);
  const duplicatePaymentIds = {};
  orders.filter(o => o.paymentId).forEach(o => {
    duplicatePaymentIds[o.paymentId] ||= [];
    duplicatePaymentIds[o.paymentId].push(o);
  });
  const dupPay = Object.values(duplicatePaymentIds).filter(x => x.length > 1);
  const approvedNoOrder = (db.payments || []).filter(p => p.type !== 'deposit' && p.status === 'approved' && !orders.some(o => o.paymentId === p.id));
  return { failed, sent, noItems, dupPay, approvedNoOrder, audit: db.deliveryAuditLogs || [] };
}

function safeDeliveryText() {
  const s = safeDeliverySummary();
  let out = `🚚 <b>SAFE DELIVERY CENTER</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += `✅ Sent/Delivered Orders: <b>${s.sent.length}</b>\n`;
  out += `❌ Failed Deliveries: <b>${s.failed.length}</b>\n`;
  out += `⚠️ Orders Without Items: <b>${s.noItems.length}</b>\n`;
  out += `🔁 Duplicate Payment Orders: <b>${s.dupPay.length}</b>\n`;
  out += `🚑 Approved Payment Without Order: <b>${s.approvedNoOrder.length}</b>\n`;
  out += `📜 Delivery Audit Logs: <b>${s.audit.length}</b>\n\n`;
  if (s.failed.length) {
    out += `<b>Recent Failed Deliveries:</b>\n`;
    s.failed.slice(0, 8).forEach((o,i) => {
      out += `${i+1}. <code>${escapeHtml(o.id)}</code> — ${escapeHtml(o.productName || '-')}\nUser: <code>${escapeHtml(o.telegramId)}</code>\nError: ${escapeHtml(short(o.deliveryError || '-', 120))}\n\n`;
    });
  } else {
    out += `✅ <b>No failed delivery found.</b>\n`;
  }
  return out;
}

function safeDeliveryButtons() {
  return inline([
    [
      { text: '🚑 Repair Delivery', callback_data: 'admin_repair_delivery' },
      { text: '🔁 Retry Failed', callback_data: 'safe_retry_failed' }
    ],
    [
      { text: '📜 Audit Logs', callback_data: 'safe_delivery_logs' },
      { text: '🧪 Health Check', callback_data: 'admin_health_speed' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

async function retryFailedDeliveries(limit = 10) {
  const failed = (db.orders || []).filter(o => o.deliveryStatus === 'failed').slice(0, limit);
  let ok = 0, fail = 0, logs = [];
  for (const o of failed) {
    try {
      await sendDeliveryMessage(o.telegramId, o.productName, o.qty, o.total, o.currency, o.deliveredItems || [], o.id, o.productCode);
      o.deliveryStatus = 'sent';
      o.deliveryResentAt = now();
      o.deliveryError = '';
      addDeliveryAuditLog('retry_success', o.id, { user: o.telegramId }, 'info');
      ok++;
    } catch (err) {
      o.deliveryError = err.message;
      addDeliveryAuditLog('retry_failed', o.id, { user: o.telegramId, error: err.message }, 'error');
      fail++;
    }
    logs.push(`${o.id}: ${ok ? 'ok' : 'checked'}`);
  }
  saveData();
  return { ok, fail, logs };
}

function securityScanSummary() {
  const s = securitySummary();
  const payments = db.payments || [];
  const users = Object.values(db.users || {});
  const manyFails = payments.filter(p => Number(p.failedVerifyAttempts || 0) >= Number(db.settings.paymentFailReviewThreshold || 5));
  const locked = Object.keys(db.securityLocks || {}).filter(isUserSecurityLocked);
  const banned = users.filter(u => u.banned === true);
  const duplicateRefs = s.dupRefs;
  const oldPending = payments.filter(p => ['pending','review'].includes(p.status) && p.createdAt && Date.now() - Date.parse(p.createdAt) > 24*60*60*1000);
  return { manyFails, locked, banned, duplicateRefs, oldPending, logs: db.securityLogs || [] };
}

function securityScanText() {
  const s = securityScanSummary();
  let out = `🛡 <b>SECURITY SCAN</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += `🔒 Locked Users: <b>${s.locked.length}</b>\n`;
  out += `🚫 Banned Users: <b>${s.banned.length}</b>\n`;
  out += `⚠️ High Failed Payments: <b>${s.manyFails.length}</b>\n`;
  out += `🔁 Duplicate TXID Groups: <b>${s.duplicateRefs.length}</b>\n`;
  out += `⏳ Old Pending/Review: <b>${s.oldPending.length}</b>\n`;
  out += `📜 Security Logs: <b>${s.logs.length}</b>\n\n`;
  if (s.manyFails.length) {
    out += `<b>Risk Payments:</b>\n`;
    s.manyFails.slice(0, 8).forEach((p, i) => out += `${i+1}. <code>${escapeHtml(p.id)}</code> User: <code>${escapeHtml(p.telegramId)}</code> Attempts: ${p.failedVerifyAttempts}\n`);
  } else out += `✅ No high-risk payment attempts found.\n`;
  return out;
}

function attractiveAdminMessage(title, body, footer = '') {
  if (db.settings.attractiveSystemMessages === false) return `${title}\n\n${body}`;
  return `✨ <b>${escapeHtml(title)}</b>
━━━━━━━━━━━━━━━━━━━━

${body}

━━━━━━━━━━━━━━━━━━━━
${footer || '⚡ Fast dashboard • Safe delivery • Secure automation'}`;
}



function manageStats() {
  const products = db.products || [];
  const active = products.filter(p => p.active !== false);
  const hidden = products.filter(p => p.active === false);
  const lowThreshold = Number(db.settings.lowStockThreshold || 2);
  const low = active.filter(p => (p.stock || []).length <= lowThreshold);
  const oos = active.filter(p => !(p.stock || []).length);
  const pending = (db.payments || []).filter(p => ['pending','review'].includes(String(p.status || '').toLowerCase()));
  const waiting = typeof stockWaitPayments === 'function' ? stockWaitPayments() : [];
  const failedDelivery = typeof safeDeliverySummary === 'function' ? safeDeliverySummary().failed : [];
  const notes = (db.adminNotes || []).filter(n => n.done !== true);
  return { products, active, hidden, low, oos, pending, waiting, failedDelivery, notes, lowThreshold };
}

function easyManageText() {
  const s = manageStats();
  return `🧰 <b>Easy Manage Center</b>
━━━━━━━━━━━━━━━━━━━━

📦 Products: <b>${s.active.length}</b> active / <b>${s.hidden.length}</b> hidden
⚠️ Low Stock: <b>${s.low.length}</b> under ${s.lowThreshold}
📭 Out of Stock: <b>${s.oos.length}</b>
⏳ Paid Waiting Stock: <b>${s.waiting.length}</b>
💳 Pending/Review Payments: <b>${s.pending.length}</b>
🚚 Failed Deliveries: <b>${s.failedDelivery.length}</b>
📝 Open Notes/Tasks: <b>${s.notes.length}</b>

<b>Quick Actions</b>
• Hide out-of-stock products
• Restore hidden products
• Process paid waiting stock queue
• Expire pending payments
• Create backup
• Toggle maintenance mode
• Bulk price update
• Admin notes/tasks`;
}

function easyManageButtons() {
  return inline([
    [
      { text: '📭 Hide OOS', callback_data: 'manage_hide_oos' },
      { text: '♻️ Restore All', callback_data: 'manage_restore_all' }
    ],
    [
      { text: '⏳ Process Stock Wait', callback_data: 'manage_process_stockwait' },
      { text: '⌛ Expire Pending', callback_data: 'manage_expire_payments' }
    ],
    [
      { text: '💾 Backup Now', callback_data: 'manage_backup_now' },
      { text: db.settings.maintenanceMode ? '✅ Maintenance OFF' : '🛠 Maintenance ON', callback_data: 'manage_maintenance_toggle' }
    ],
    [
      { text: '💵 Bulk Price %', callback_data: 'manage_bulk_price_percent' },
      { text: '⚠️ Low Stock', callback_data: 'manage_low_stock' }
    ],
    [
      { text: '📝 Notes/Tasks', callback_data: 'manage_notes' },
      { text: '🧹 Clean Logs', callback_data: 'manage_cleanup_logs' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function addAdminNote(textValue, by = '') {
  db.adminNotes ||= [];
  const note = {
    id: 'N' + Date.now() + Math.floor(Math.random() * 999),
    text: String(textValue || '').trim().slice(0, 1000),
    by: String(by || ''),
    done: false,
    createdAt: now()
  };
  if (!note.text) return null;
  db.adminNotes.unshift(note);
  db.adminNotes = db.adminNotes.slice(0, 200);
  saveData();
  return note;
}

function notesText() {
  const list = db.adminNotes || [];
  let out = `📝 <b>Admin Notes / Tasks</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (!list.length) return out + `No notes yet.\n\nUse <code>/addnote your note</code> or Web → Easy Manage.`;
  list.slice(0, 25).forEach((n, i) => {
    out += `${n.done ? '✅' : '🟡'} <b>${i + 1}. ${escapeHtml(short(n.text, 160))}</b>\n`;
    out += `ID: <code>${escapeHtml(n.id)}</code> | By: ${escapeHtml(n.by || '-')}\n`;
    out += `${escapeHtml(n.createdAt ? new Date(n.createdAt).toLocaleString() : '-')}\n\n`;
  });
  return out;
}

function notesButtons() {
  const rows = [];
  (db.adminNotes || []).slice(0, 10).forEach(n => {
    rows.push([
      { text: `${n.done ? '↩️ Reopen' : '✅ Done'} ${short(n.text, 18)}`, callback_data: `note_done:${n.id}` },
      { text: '🗑', callback_data: `note_delete:${n.id}` }
    ]);
  });
  rows.push([{ text: '➕ Add Note', callback_data: 'note_add' }, { text: '🧰 Manage', callback_data: 'admin_easy_manage' }]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

function hideOutOfStockProducts() {
  let n = 0;
  for (const p of db.products || []) {
    if (p.active !== false && !(p.stock || []).length) { p.active = false; n++; }
  }
  saveData();
  return n;
}

function restoreAllProducts() {
  let n = 0;
  for (const p of db.products || []) {
    if (p.active === false) { p.active = true; n++; }
  }
  saveData();
  return n;
}

function bulkPriceUpdate(percent = 0, onlyActive = true) {
  const pct = Number(percent || 0);
  if (!Number.isFinite(pct) || pct === 0) return { count: 0, pct };
  let count = 0;
  for (const p of db.products || []) {
    if (onlyActive && p.active === false) continue;
    const old = Number(p.price || 0);
    if (old <= 0) continue;
    p.oldPriceBeforeBulkUpdate = old;
    p.price = Math.max(0.01, Number((old * (1 + pct / 100)).toFixed(2)));
    p.bulkPriceUpdatedAt = now();
    count++;
  }
  saveData();
  return { count, pct };
}

function cleanOldLogs(limit = 300) {
  const keys = ['securityLogs','autoVerifyLogs','campaignLogs','groupAlertLogs','healthLogs','deliveryAuditLogs','stockWaitLogs','webAudit','adminActionLogs'];
  const result = {};
  for (const k of keys) {
    if (Array.isArray(db[k])) {
      const before = db[k].length;
      db[k] = db[k].slice(0, limit);
      result[k] = before - db[k].length;
    }
  }
  saveData();
  return result;
}

function easyManageWebCards() {
  const s = manageStats();
  return `<div class="grid">
    <div class="card"><h3>📦 Products</h3><div class="stat">${s.active.length}</div><p class="muted">${s.hidden.length} hidden · ${s.oos.length} out of stock</p></div>
    <div class="card"><h3>⚠️ Low Stock</h3><div class="stat">${s.low.length}</div><p class="muted">Threshold: ${s.lowThreshold}</p></div>
    <div class="card"><h3>⏳ Stock Wait</h3><div class="stat">${s.waiting.length}</div><p class="muted">Paid orders waiting for stock</p></div>
    <div class="card"><h3>💳 Pending</h3><div class="stat">${s.pending.length}</div><p class="muted">Pending/review payments</p></div>
  </div>`;
}

function webNotesRows() {
  return (db.adminNotes || []).map(n => `<tr><td>${n.done ? '✅' : '🟡'}</td><td>${webEsc(n.text)}</td><td>${webEsc(n.by || '-')}</td><td>${webEsc(n.createdAt ? new Date(n.createdAt).toLocaleString() : '-')}</td><td><form method="post" action="/admin-web/easy-manage/notes/${encodeURIComponent(n.id)}/toggle"><button class="btn secondary">${n.done ? 'Reopen' : 'Done'}</button></form><form method="post" action="/admin-web/easy-manage/notes/${encodeURIComponent(n.id)}/delete"><button class="btn danger">Delete</button></form></td></tr>`).join('');
}

function lowStockManageText() {
  const threshold = Number(db.settings.lowStockThreshold || 2);
  const items = (db.products || []).filter(p => p.active !== false && (p.stock || []).length <= threshold).sort((a,b)=>(a.stock||[]).length-(b.stock||[]).length);
  let out = `⚠️ <b>Low Stock Manager</b>\nThreshold: <b>${threshold}</b>\n\n`;
  if (!items.length) return out + '✅ No low-stock products.';
  items.slice(0, 30).forEach((p, i) => {
    out += `${i+1}. ${productLogoHtml ? productLogoHtml(p) : (p.emoji || '📦')} <b>${escapeHtml(p.name)}</b>\nCode: <code>${escapeHtml(p.code)}</code> | Stock: <b>${(p.stock||[]).length}</b> | Price: ${money(p.price, p.currency || currency())}\n\n`;
  });
  return out;
}

function webBaseUrl() {
  return String(db.settings.webBaseUrl || WEB_BASE_URL || '').trim().replace(/\/$/, '');
}

function webAdminUrl(pathPart = '') {
  const base = webBaseUrl();
  if (!base) return '';
  const p = String(pathPart || '').startsWith('/') ? pathPart : '/' + String(pathPart || '');
  return base + p;
}

function runtimeUptimeText() {
  const sec = Math.floor((Date.now() - runtimeStats.startedAt) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function telegramAdminDiagnosticText(from = {}) {
  const s = getWebStats();
  const groups = db.alertGroups || [];
  const web = webAdminUrl('/admin-web');
  const mem = process.memoryUsage();
  return `🧪 <b>App + Web Admin Diagnostic</b>

🤖 Bot: @${escapeHtml(getBotUsername() || botUsername || '-')}
⏱ Uptime: <b>${escapeHtml(runtimeUptimeText())}</b>
🟢 Node: <code>${escapeHtml(process.version)}</code>
🧠 RAM: <b>${Math.round(mem.rss/1024/1024)} MB</b>

👑 Your ID: <code>${escapeHtml(from.id || '-')}</code>
🔐 Admin Access: <b>${isAdmin(from.id) ? 'YES' : 'NO'}</b>
🧾 Role: <b>${escapeHtml(adminRole(from.id) || '-')}</b>

📦 Products: <b>${s.active.length}</b> active / <b>${s.hidden.length}</b> hidden
📊 Stock: <b>${s.stock}</b>
👥 Users: <b>${Object.keys(db.users || {}).length}</b>
🧾 Orders: <b>${(db.orders || []).length}</b>
💳 Pending/Review: <b>${(db.payments || []).filter(p => p.status === 'pending' || p.status === 'review').length}</b>
👥 Alert Groups: <b>${groups.length}</b> total / <b>${activeAlertGroups().length}</b> active

📥 Updates: <b>${runtimeStats.updates}</b>
💬 Messages: <b>${runtimeStats.messages}</b>
🔘 Callbacks: <b>${runtimeStats.callbacks}</b>
⚠️ Errors: <b>${runtimeStats.errors}</b>
Last Callback: <code>${escapeHtml(runtimeStats.lastCallback || '-')}</code>
Last Message: <code>${escapeHtml(short(runtimeStats.lastMessage || '-', 80))}</code>

🌐 Web Panel: ${web ? `<a href="${escapeHtml(web)}">Open Web Admin</a>` : '<b>Not set</b>'}`;
}

function adminParityButtons() {
  const web = webAdminUrl('/admin-web');
  const rows = [
    [
      { text: '🧪 App/Web Check', callback_data: 'admin_diag' },
      { text: '⚡ Health & Speed', callback_data: 'admin_health_speed' }
    ],
    [
      { text: '🚚 Safe Delivery', callback_data: 'admin_safe_delivery' },
      { text: '⏳ Stock Wait', callback_data: 'admin_stock_wait' }
    ],
    [
      { text: '🛡 Security Scan', callback_data: 'admin_security_scan' },
      { text: '⌛ Expire Pending', callback_data: 'payments_expire_now' }
    ],
    [
      { text: '🧾 Feature Map', callback_data: 'admin_feature_map' },
      { text: '🧪 Feature Check', callback_data: 'admin_feature_check' }
    ],
    [
      { text: '🧪 Speed Test', callback_data: 'admin_speed_test' },
      { text: '🔐 Team Web Access', callback_data: 'admin_help' }
    ],
    [
      { text: '👥 Group Alerts', callback_data: 'admin_groups' },
      { text: '⌨️ Keyword Test', callback_data: 'admin_keyword_test' }
    ],
    [
      { text: '🔎 Quick Find', callback_data: 'admin_quick_find' },
      { text: '🚨 Payment Risk', callback_data: 'admin_payment_risk' }
    ],
    [
      { text: '🛠 Repair Delivery', callback_data: 'admin_repair_delivery' },
      { text: '💾 Backup Center', callback_data: 'admin_backup_center' }
    ]
  ];
  if (web) rows.push([{ text: '🌐 Open Web Admin', url: web }]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

function adminFeatureMapText() {
  return `🧾 <b>Admin Feature Map</b>

<b>Telegram App Admin</b>
✅ Product Manager
✅ Add Stock / View Stock
✅ Premium Stock Alerts
✅ Flash Sale Preview
✅ Group Alerts Manager
✅ Keyword Reply Preview/Test
✅ Quick Find
✅ Payment Risk Center
✅ Security Center
✅ Security Scan
✅ Health & Speed Checker
✅ Safe Delivery Center
✅ Backup Center
✅ Orders / Users / Pending
✅ Delivery Resend / Repair
✅ Custom Announcements
✅ Description Generator
✅ Custom Emoji / Brand Codes

<b>Web Admin Panel</b>
✅ Dashboard
✅ Products Create/Edit
✅ Product Delivery Template
✅ Product Group Keywords
✅ Custom Emoji Codes
✅ Group Alerts Manager
✅ Keyword Reply Test
✅ Orders / Users / Payments
✅ Settings
✅ Security Center
✅ Business Summary
✅ Inventory Valuation
✅ Backup / Export
✅ System Health
✅ Health & Speed Dashboard
✅ Safe Delivery Dashboard
✅ Security Scan Dashboard

<b>Parity Status</b>
🟢 Major controls available on both Telegram app and Web panel.`;
}

function testAdminButtonsText() {
  return `🔘 <b>Admin Button Test</b>

Tap these buttons to confirm Telegram app admin callbacks are working.

If buttons respond here, Telegram admin panel is working.
If Web also opens, web panel is working.`;
}


function forceOwnerIfAllowed(from = {}) {
  if (!from?.id) return false;
  const username = String(from.username || '').replace('@','').trim().toLowerCase();
  const allowed = isOwnerUsername(username) || (ADMIN_ID && String(from.id) === ADMIN_ID);
  if (!allowed) return false;

  db.admins ||= [];
  const id = String(from.id);
  let a = db.admins.find(x => String(x.id) === id);
  if (!a) {
    a = { id, username, name: from.first_name || username || 'Owner', role: 'owner', active: true, addedBy: 'claim-owner', addedAt: now(), note: 'Telegram owner recovery' };
    db.admins.unshift(a);
  } else {
    a.username = username || a.username || '';
    a.name = from.first_name || a.name || username || 'Owner';
    a.role = 'owner';
    a.active = true;
  }
  saveData();
  return true;
}


function adminRecord(id) {
  id = String(id || '').trim();
  if (!id) return null;
  if (id === ADMIN_ID) {
    return { id: ADMIN_ID, username: '', name: 'Owner', role: 'owner', active: true, owner: true };
  }
  return (db.admins || []).find(a => String(a.id) === id && a.active !== false) || null;
}


function isBannedUser(id) {
  const u = db.users?.[String(id)];
  return Boolean(u && u.banned === true);
}

function banStatusText(id) {
  return isBannedUser(id) ? '🚫 Banned' : '✅ Active';
}

function isAdmin(id) {
  return Boolean(adminRecord(id));
}

function isOwnerAdmin(id) {
  id = String(id || '').trim();
  if (id === ADMIN_ID) return true;
  const a = (db.admins || []).find(x => String(x.id) === id);
  return Boolean(a && a.active !== false && a.role === 'owner');
}

function adminRole(id) {
  const a = adminRecord(id);
  return a?.role || '';
}

function findUserByRef(ref) {
  ref = String(ref || '').trim();
  if (!ref) return null;
  const clean = ref.replace('@', '').toLowerCase();
  if (db.users[String(ref)]) return db.users[String(ref)];
  return Object.values(db.users || {}).find(u =>
    String(u.telegramId) === ref ||
    String(u.username || '').toLowerCase() === clean ||
    String(u.firstName || '').toLowerCase() === clean
  ) || null;
}

function normalizeAdminRole(role) {
  role = String(role || 'manager').toLowerCase().trim();
  const allowed = ['owner', 'manager', 'support', 'stock', 'finance', 'viewer'];
  return allowed.includes(role) ? role : 'manager';
}

function adminRoleLabel(role) {
  role = normalizeAdminRole(role);
  const map = {
    owner: '👑 Owner',
    manager: '🛡 Manager',
    support: '🎫 Support',
    stock: '📦 Stock',
    finance: '💰 Finance',
    viewer: '👁 Viewer'
  };
  return map[role] || role;
}

function adminList() {
  db.admins ||= [];
  if (!db.admins.some(a => String(a.id) === ADMIN_ID)) {
    db.admins.unshift({ id: ADMIN_ID, username: '', name: 'Owner', role: 'owner', active: true, addedBy: 'system', addedAt: now(), note: 'Main owner from ADMIN_ID' });
  }
  return db.admins;
}

function addAdminLog(action, by, target = '', detail = {}) {
  try {
    db.adminActionLogs ||= [];
    db.adminActionLogs.unshift({
      id: 'ADL' + Date.now() + Math.floor(Math.random() * 999),
      action,
      by: String(by || ''),
      target: String(target || ''),
      detail,
      at: now()
    });
    db.adminActionLogs = db.adminActionLogs.slice(0, 500);
    saveData();
  } catch (_) {}
}

async function notifyAllAdmins(message, replyMarkup) {
  const ids = [...new Set([ADMIN_ID, ...(adminList().filter(a => a.active !== false).map(a => String(a.id)))])];
  let sent = 0;
  for (const id of ids) {
    try {
      await sendMessage(id, message, replyMarkup || adminButtons());
      sent++;
      await new Promise(r => setTimeout(r, 100));
    } catch (_) {}
  }
  return sent;
}

function adminManagerRows() {
  const rows = [];
  for (const a of adminList()) {
    rows.push([
      { text: `${a.active === false ? '⛔' : '✅'} ${adminRoleLabel(a.role)} ${a.name || a.username || a.id}`, callback_data: `adm_view:${a.id}` }
    ]);
  }
  rows.push([
    { text: '➕ Add Admin', callback_data: 'adm_add' },
    { text: '📣 Message Admins', callback_data: 'adm_broadcast' }
  ]);
  rows.push([
    { text: '📜 Admin Logs', callback_data: 'adm_logs' },
    { text: '⚙️ Admin Panel', callback_data: 'admin' }
  ]);
  return rows;
}


async function addTelegramAdminFromRef(ref, roleRaw, addedBy) {
  const role = normalizeAdminRole(roleRaw || 'manager');
  const user = findUserByRef(ref);
  const id = String(user?.telegramId || String(ref || '').replace('@', '').trim());
  if (!/^\d+$/.test(id)) throw new Error('Valid numeric Telegram user ID required. Username works only if user has already started the bot.');
  if (String(id) === ADMIN_ID || adminList().some(a => String(a.id) === id)) throw new Error('This user is already admin.');
  const admin = {
    id,
    username: user?.username || '',
    name: user?.firstName || user?.username || 'Admin',
    role,
    active: true,
    addedBy: String(addedBy || 'owner'),
    addedAt: now(),
    note: 'Added from V50 admin system'
  };
  db.admins ||= [];
  db.admins.push(admin);
  saveData();
  addAdminLog('admin_added_v50', addedBy, id, { role, username: admin.username || '' });
  try {
    await sendMessage(id, `✅ <b>You are now admin of ${escapeHtml(STORE_NAME)}</b>\n\nRole: <b>${escapeHtml(adminRoleLabel(role))}</b>\n\nSend /admin to open your admin panel.`);
  } catch (_) {}
  return admin;
}

function adminDetailButtons(adminId) {
  const a = adminList().find(x => String(x.id) === String(adminId));
  const disabled = a?.active === false;
  const rows = [];
  if (String(adminId) !== ADMIN_ID) {
    rows.push([
      { text: disabled ? '✅ Enable' : '⛔ Disable', callback_data: `adm_toggle:${adminId}` },
      { text: '🗑 Remove', callback_data: `adm_remove:${adminId}` }
    ]);
    rows.push([
      { text: '🛡 Manager Role', callback_data: `adm_role:${adminId}:manager` },
      { text: '🎫 Support Role', callback_data: `adm_role:${adminId}:support` }
    ]);
    rows.push([
      { text: '📦 Stock Role', callback_data: `adm_role:${adminId}:stock` },
      { text: '💰 Finance Role', callback_data: `adm_role:${adminId}:finance` }
    ]);
  }
  rows.push([
    { text: '📩 Message', callback_data: `adm_msg:${adminId}` },
    { text: '👑 Admin Manager', callback_data: 'admin_manager' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

function currency() {
  return String(db.settings.storeCurrency || DEFAULT_CURRENCY || 'USD').toUpperCase();
}

function getBotUsername() {
  return String(db.settings.botUsername || botUsername || BOT_USERNAME || '').replace('@', '').trim();
}

function money(n, curr = currency()) {
  const x = Number(n || 0);
  if (curr === 'USD' || curr === 'USDT') return `$${x % 1 ? x.toFixed(2) : x.toFixed(0)}`;
  return `${x % 1 ? x.toFixed(2) : x.toFixed(0)} ${curr}`;
}

function short(s, max = 36) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function inline(rows) {
  return { inline_keyboard: rows };
}

function removeKeyboardMarkup() {
  return { remove_keyboard: true };
}

function getSession(uid) {
  return sessions.get(String(uid));
}

function setSession(uid, data) {
  sessions.set(String(uid), data);
}

function clearSession(uid) {
  sessions.delete(String(uid));
}


function cleanCategory(cat = '') {
  const v = String(cat || '').trim();
  return v ? v.slice(0, 40) : 'General';
}

function productTags(p) {
  if (!p) return [];
  if (Array.isArray(p.tags)) return p.tags.map(x => String(x).trim()).filter(Boolean);
  return String(p.tags || '').split(',').map(x => x.trim()).filter(Boolean);
}

function tagString(p) {
  return productTags(p).join(', ');
}

function productCategories(includeHidden = false) {
  const set = new Set();
  (db.products || [])
    .filter(p => includeHidden || p.active !== false)
    .forEach(p => set.add(cleanCategory(p.category || 'General')));
  return [...set].sort((a,b)=>a.localeCompare(b));
}

function productsByCategory(category) {
  const cat = cleanCategory(category);
  return activeProducts().filter(p => cleanCategory(p.category || 'General').toLowerCase() === cat.toLowerCase());
}

function categoryIndexToName(index) {
  const cats = productCategories(false);
  return cats[Math.max(0, Number(index || 0))] || cats[0] || 'General';
}

function profitForOrder(order) {
  const p = db.products.find(x => String(x.code) === String(order.productCode));
  const cost = Number(order.costPrice ?? p?.costPrice ?? 0) * Number(order.qty || 1);
  const revenue = Number(order.total || 0);
  return { revenue, cost, profit: revenue - cost, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0 };
}

function profitSummary(orders = db.orders || []) {
  let revenue = 0, cost = 0, profit = 0;
  const byProduct = {};
  for (const o of orders) {
    const r = profitForOrder(o);
    revenue += r.revenue; cost += r.cost; profit += r.profit;
    byProduct[o.productCode] ||= { code: o.productCode, name: o.productName, revenue: 0, cost: 0, profit: 0, qty: 0 };
    byProduct[o.productCode].revenue += r.revenue;
    byProduct[o.productCode].cost += r.cost;
    byProduct[o.productCode].profit += r.profit;
    byProduct[o.productCode].qty += Number(o.qty || 0);
  }
  return { revenue, cost, profit, margin: revenue ? (profit / revenue) * 100 : 0, byProduct: Object.values(byProduct).sort((a,b)=>b.profit-a.profit) };
}

function productBulkStats() {
  const products = db.products || [];
  return {
    total: products.length,
    active: products.filter(p => p.active !== false).length,
    hidden: products.filter(p => p.active === false).length,
    noStock: products.filter(p => !(p.stock || []).length).length,
    categories: productCategories(true).length,
    costMissing: products.filter(p => !Number(p.costPrice || 0)).length
  };
}


function activeProducts() {
  return db.products
    .filter((p) => p.active !== false)
    .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
}

function productByCode(code) {
  return db.products.find((p) => String(p.code).toUpperCase() === String(code).toUpperCase() && p.active !== false);
}

function getSpecialPrice(p, userId) {
  if (!p) return 0;
  p.specialPrices ||= {};
  const key = String(userId || '');
  const v = p.specialPrices[key];
  const n = Number(v);
  return n > 0 ? n : null;
}


function activeFlashSale(p) {
  if (!p || !p.flashSale || p.flashSale.active === false) return null;
  const sale = p.flashSale;
  const price = Number(sale.price || 0);
  if (!price || price <= 0) return null;
  if (sale.endsAt && Date.parse(sale.endsAt) && Date.now() > Date.parse(sale.endsAt)) return null;
  return sale;
}

function flashSaleLabel(p) {
  const sale = activeFlashSale(p);
  if (!sale) return '';
  const end = sale.endsAt ? new Date(sale.endsAt).toLocaleString() : 'soon';
  return `⚡ Flash Sale till ${end}`;
}

function flashSaleText(product) {
  const template = String(product?.customFlashSaleTemplate || db.settings.premiumFlashSaleTemplate || '').trim();
  if (template) return renderPremiumTemplate(template, product, { note: activeFlashSale(product)?.note || '' });
  return defaultFlashSaleText(product);
}

function campaignLog(type, by, target, message, count = 0, extra = {}) {
  db.campaignLogs ||= [];
  db.campaignLogs.unshift({
    id: 'CMP' + Date.now() + Math.floor(Math.random() * 999),
    type,
    by: String(by || ''),
    target: String(target || ''),
    message: String(message || '').slice(0, 1000),
    count,
    extra,
    at: now()
  });
  db.campaignLogs = db.campaignLogs.slice(0, 500);
  saveData();
}

function getSegmentUsers(segment = 'all') {
  segment = String(segment || 'all').toLowerCase();
  const users = Object.values(db.users || {}).filter(u => u?.telegramId && u.banned !== true && u.notifications !== false);
  const buyers = new Set((db.orders || []).map(o => String(o.telegramId)));
  if (segment === 'buyers') return users.filter(u => buyers.has(String(u.telegramId)));
  if (segment === 'nonbuyers') return users.filter(u => !buyers.has(String(u.telegramId)));
  if (segment === 'wallet') return users.filter(u => Number(u.balance || 0) > 0);
  if (segment === 'inactive') {
    const recent = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return users.filter(u => {
      const t = Date.parse(u.lastSeenAt || u.createdAt || 0);
      return !Number.isFinite(t) || t < recent;
    });
  }
  return users;
}

function segmentLabel(segment = 'all') {
  const m = { all: 'All Users', buyers: 'Buyers Only', nonbuyers: 'Non-Buyers', wallet: 'Wallet Balance Users', inactive: 'Inactive Users' };
  return m[String(segment || 'all').toLowerCase()] || 'All Users';
}

async function broadcastToSegment(segment, message, replyMarkup) {
  const users = getSegmentUsers(segment);
  let sent = 0;
  for (const user of users) {
    try {
      await sendMessage(user.telegramId, message, replyMarkup);
      sent++;
      await new Promise(r => setTimeout(r, 120));
    } catch (_) {}
  }
  return sent;
}

async function sendCampaign({ type = 'custom', segment = 'all', productCode = '', message = '', toChannels = true, by = '' } = {}) {
  const product = productCode ? productByCode(productCode) : null;
  let body = message;
  let markup = inline([[{ text: '🛍 Open Store', callback_data: 'shop:1' }]]);

  if (type === 'flash' && product) {
    body = flashSaleText(product);
    markup = channelBuyButtons(product);
  } else if (type === 'product' && product) {
    body = productPromoForChannel(product, 'campaign');
    markup = channelBuyButtons(product);
  } else {
    body = `📣 <b>Premium Store Update</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${escapeHtml(message || 'New update from store.')}\n\n✨ Open the bot and grab latest deals.`;
  }

  const userSent = await broadcastToSegment(segment, body, markup);
  let channelSent = 0;
  if (toChannels) channelSent = await sendToConfiguredChannels(body, product ? channelBuyButtons(product) : inline([[{ text: '🛍 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
  let groupSent = 0;
  if (toChannels) groupSent = await sendToRegisteredGroups(body, product ? channelBuyButtons(product) : inline([[{ text: '🛍 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]), 'campaign', productCode);
  campaignLog(type, by, segment, body, userSent + channelSent + groupSent, { userSent, channelSent, groupSent, productCode });
  return { userSent, channelSent, total: userSent + channelSent };
}

function campaignStats() {
  const logs = db.campaignLogs || [];
  return {
    total: logs.length,
    last: logs[0] || null,
    sent: logs.reduce((a,l)=>a+Number(l.count||0),0)
  };
}



function normalizeBulkPrices(p) {
  if (!p) return [];
  p.bulkPrices ||= [];
  if (!Array.isArray(p.bulkPrices)) p.bulkPrices = [];
  p.bulkPrices = p.bulkPrices
    .map(t => ({ minQty: Number(t.minQty || t.qty || 0), price: Number(t.price || 0), note: String(t.note || '').trim() }))
    .filter(t => t.minQty > 1 && t.price > 0)
    .sort((a, b) => a.minQty - b.minQty);
  return p.bulkPrices;
}

function bulkPriceForQty(p, qty) {
  qty = Number(qty || 1);
  const tiers = normalizeBulkPrices(p);
  let best = null;
  for (const tier of tiers) {
    if (qty >= Number(tier.minQty)) best = tier;
  }
  return best;
}

function getProductUnitPrice(p, userId = '', qty = 1) {
  const special = getSpecialPrice(p, userId);
  if (special) return Number(special);
  const bulk = bulkPriceForQty(p, qty);
  if (bulk) return Number(bulk.price);
  const sale = activeFlashSale(p);
  if (sale) return Number(sale.price);
  return Number(p?.price || 0);
}

function bulkPricingText(p) {
  const tiers = normalizeBulkPrices(p);
  if (!tiers.length) return '';
  return tiers.map(t => `• ${t.minQty}+ qty = ${money(t.price, p.currency || currency())} each${t.note ? ' · ' + t.note : ''}`).join('\n');
}

function bulkPricingHtml(p) {
  const tiers = normalizeBulkPrices(p);
  if (!tiers.length) return '<span class="muted">No bulk pricing set.</span>';
  return tiers.map(t => `<div class="chip">${webEsc(t.minQty)}+ = ${webMoney(t.price)} each${t.note ? ' · ' + webEsc(t.note) : ''}</div>`).join(' ');
}

function parseBulkPricingLines(raw = '') {
  return String(raw || '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|').map(x => x.trim());
      return { minQty: Number(parts[0] || 0), price: Number(parts[1] || 0), note: parts.slice(2).join('|').trim() };
    })
    .filter(t => t.minQty > 1 && t.price > 0)
    .sort((a,b)=>a.minQty-b.minQty);
}

function bulkPricingLines(p) {
  return normalizeBulkPrices(p).map(t => `${t.minQty}|${t.price}${t.note ? '|' + t.note : ''}`).join('\n');
}

function bulkSavingsLine(p, qty, userId = '') {
  const qtyNum = Number(qty || 1);
  const unit = getProductUnitPrice(p, userId, qtyNum);
  const base = Number(p.price || unit);
  if (qtyNum > 1 && unit < base) {
    const save = (base - unit) * qtyNum;
    return `\n💸 Bulk Saving: <b>${money(save, p.currency || currency())}</b>`;
  }
  return '';
}


function getProductPrice(p, userId) {
  return getProductUnitPrice(p, userId, 1);
}

function priceLabel(p, userId, qty = 1) {
  const special = getSpecialPrice(p, userId);
  const bulk = bulkPriceForQty(p, qty);
  const sale = activeFlashSale(p);
  if (special) return `${money(special, p.currency || currency())} <b>Special Price</b> <s>${money(p.price, p.currency || currency())}</s>`;
  if (bulk) return `📦 ${money(bulk.price, p.currency || currency())} <b>Bulk Price</b> <s>${money(p.price, p.currency || currency())}</s>`;
  if (sale) return `🔥 ${money(sale.price, p.currency || currency())} <b>Flash Sale</b> <s>${money(p.price, p.currency || currency())}</s>`;
  return `${money(p.price, p.currency || currency())}`;
}

function cleanDeliveryTemplate(template) {
  return String(template || '')
    .trim()
    .replace(/\s*\|\s*/g, '|')
    .replace(/\|+/g, '|')
    .replace(/^\||\|$/g, '')
    .slice(0, 120);
}

function isKnownStockFormat(format) {
  const f = String(format || '').toLowerCase();
  return ['redeem_link', 'id_password', 'coupon_code'].includes(f);
}

function isCustomDeliveryFormat(format) {
  const f = String(format || '').trim();
  return f.toLowerCase().startsWith('custom:') || (!isKnownStockFormat(f) && f.includes('|'));
}

function normalizeDeliveryFormat(format, fallback = 'redeem_link') {
  const raw = String(format || '').trim();
  const lower = raw.toLowerCase();

  if (['redeem_link', 'redeem', 'redeem link', 'link', 'url'].includes(lower)) return 'redeem_link';
  if (['id_password', 'id password', 'id/password', 'login', 'account'].includes(lower)) return 'id_password';
  if (['coupon_code', 'coupon', 'code', 'coupon code'].includes(lower)) return 'coupon_code';

  if (lower.startsWith('custom:')) {
    const template = cleanDeliveryTemplate(raw.slice(raw.indexOf(':') + 1));
    return template ? `custom:${template}` : fallback;
  }

  if (raw.includes('|')) {
    const template = cleanDeliveryTemplate(raw);
    return template ? `custom:${template}` : fallback;
  }

  return fallback;
}

function deliveryTemplateFromFormat(format) {
  const f = String(format || '').trim();
  if (f.toLowerCase().startsWith('custom:')) return cleanDeliveryTemplate(f.slice(f.indexOf(':') + 1));
  if (!isKnownStockFormat(f) && f.includes('|')) return cleanDeliveryTemplate(f);
  if (String(format || '').toLowerCase() === 'id_password') return 'ID|Password';
  if (String(format || '').toLowerCase() === 'coupon_code') return 'Code';
  if (String(format || '').toLowerCase() === 'redeem_link') return 'Redeem Link';
  return 'Item';
}

function deliveryFieldsFromFormat(format) {
  return deliveryTemplateFromFormat(format)
    .split('|')
    .map(x => x.trim())
    .filter(Boolean);
}

function stockFormatName(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'id_password') return 'ID / Password';
  if (f === 'coupon_code') return 'Coupon / Code';
  if (f === 'redeem_link') return 'Redeem Link';
  if (isCustomDeliveryFormat(format)) return deliveryTemplateFromFormat(format);
  return 'Delivery Item';
}

function stockFormatEmoji(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'id_password') return '🔐';
  if (f === 'coupon_code') return '🎟';
  if (f === 'redeem_link') return '🔗';
  if (isCustomDeliveryFormat(format)) return '🧾';
  return '🔑';
}

function stockFormatDescription(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'id_password') return 'Delivery format: ID + Password / Login details';
  if (f === 'coupon_code') return 'Delivery format: Coupon / redeem code';
  if (f === 'redeem_link') return 'Delivery format: Redeem link';
  if (isCustomDeliveryFormat(format)) return `Delivery format: ${deliveryTemplateFromFormat(format)}`;
  return 'Delivery format: Auto delivery item';
}

function stockLineExample(format) {
  const f = normalizeDeliveryFormat(format);
  if (f === 'id_password') return 'email@example.com|password123';
  if (f === 'coupon_code') return 'ABCD-1234-CODE';
  if (f === 'redeem_link') return 'https://example.com/redeem/xxxxx';
  const fields = deliveryFieldsFromFormat(f);
  const examples = {
    mail: 'user@example.com',
    email: 'user@example.com',
    id: 'user@example.com',
    pass: 'Password123',
    password: 'Password123',
    'mail pass': 'MailPass123',
    'chatgpt pass': 'ChatGPTPass123',
    '2fa': 'ABCDEF123456',
    otp: '123456',
    code: 'CODE-1234',
    coupon: 'COUPON-1234',
    link: 'https://example.com/redeem/xxxxx'
  };
  return fields.map(field => {
    const key = field.toLowerCase();
    return examples[key] || `${field.replace(/\s+/g, '')}Value`;
  }).join('|');
}

function customStockItemObject(format, raw) {
  const template = deliveryTemplateFromFormat(format);
  const fields = deliveryFieldsFromFormat(format);
  const values = String(raw || '').split('|').map(x => x.trim());
  const mapped = {};
  fields.forEach((field, i) => {
    mapped[field] = values[i] || '';
  });
  if (values.length > fields.length) mapped.Extra = values.slice(fields.length).join('|');
  return { __gosStock: true, format: 'custom', template, fields, values, mapped, raw };
}

function createStockItemObject(format, raw) {
  return makeStockItem(format, raw);
}


function splitFormatFields(fmt = '') {
  return String(fmt || '')
    .replace(/^custom:/i, '')
    .split('|')
    .map(x => x.trim())
    .filter(Boolean);
}

function parseConstantsMap(raw = '') {
  const map = {};
  String(raw || '').split(/\r?\n/).forEach(line => {
    const s = line.trim();
    if (!s) return;
    let m = s.match(/^([^:=|]+)\s*[:=]\s*([\s\S]*)$/);
    if (!m && s.includes('|')) {
      const parts = s.split('|');
      m = [s, parts.shift(), parts.join('|')];
    }
    if (m) map[String(m[1] || '').trim().toLowerCase()] = String(m[2] || '').trim();
  });
  return map;
}

function normalizeFieldName(x = '') {
  return String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function detectDelimiter(line = '', preferred = '|') {
  const p = String(preferred || '|');
  if (p && p !== 'auto') return p;
  const tests = ['|', ',', ';', '\t'];
  return tests.sort((a,b) => (String(line).split(b).length - String(line).split(a).length))[0] || '|';
}

function splitDataLine(line = '', delimiter = '|') {
  const d = String(delimiter || '|');
  if (d === '\\t' || d === 'tab') return String(line).split('\t').map(x => x.trim());
  return String(line).split(d).map(x => x.trim());
}

function extractFromText(raw = '', mode = 'links') {
  const s = String(raw || '');
  let re;
  if (mode === 'emails') re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  else if (mode === 'codes') re = /\b[A-Z0-9][A-Z0-9_-]{5,}\b/gi;
  else re = /https?:\/\/[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  return [...new Set((s.match(re) || []).map(x => x.trim()))];
}

function runBulkDataHelper(input = {}) {
  const raw = String(input.raw || input.sourceData || '').trim();
  const mode = String(input.mode || 'format');
  const inputFormat = String(input.inputFormat || '').trim();
  const outputFormat = String(input.outputFormat || input.stockFormat || '').trim();
  const delimiter = String(input.delimiter || '|');
  const constants = parseConstantsMap(input.constants || '');
  const prefix = String(input.prefix || '');
  const suffix = String(input.suffix || '');
  const removeBlank = input.removeBlank !== false && String(input.removeBlank || 'true') !== 'false';
  const dedupe = String(input.dedupe || '') === 'true';
  const lowerMap = (obj) => Object.fromEntries(Object.entries(obj).map(([k,v]) => [normalizeFieldName(k), v]));

  if (!raw) return { ok: false, error: 'No input data provided.', lines: [], text: '' };

  if (['links', 'emails', 'codes'].includes(mode)) {
    let lines = extractFromText(raw, mode);
    if (dedupe) lines = [...new Set(lines)];
    lines = lines.map(x => `${prefix}${x}${suffix}`);
    return { ok: true, mode, lines, text: lines.join('\n'), count: lines.length, skipped: 0, inputFormat, outputFormat };
  }

  const inFields = splitFormatFields(inputFormat);
  const outFields = splitFormatFields(outputFormat || inputFormat);
  if (!inFields.length) return { ok: false, error: 'Input format is required. Example: Mail|Pass|2FA', lines: [], text: '' };
  if (!outFields.length) return { ok: false, error: 'Output format is required. Example: Mail|Pass|2FA|2FA Link', lines: [], text: '' };

  const result = [];
  let skipped = 0;
  const sourceLines = String(raw || '').split(/\r?\n/).map(x => x.trim()).filter(x => removeBlank ? Boolean(x) : true);

  for (const line of sourceLines) {
    if (!line && removeBlank) continue;
    const d = detectDelimiter(line, delimiter);
    const parts = splitDataLine(line, d);
    const row = {};
    inFields.forEach((field, i) => row[normalizeFieldName(field)] = parts[i] ?? '');
    const map = { ...lowerMap(constants), ...row };
    const out = outFields.map(field => {
      const key = normalizeFieldName(field);
      if (map[key] !== undefined) return map[key];
      if (constants[key] !== undefined) return constants[key];
      return '';
    });
    if (out.every(x => !String(x || '').trim())) { skipped++; continue; }
    result.push(`${prefix}${out.join('|')}${suffix}`);
  }

  const lines = dedupe ? [...new Set(result)] : result;
  return {
    ok: true,
    mode,
    lines,
    text: lines.join('\n'),
    count: lines.length,
    skipped,
    inputFormat,
    outputFormat,
    constants,
    prefix,
    suffix
  };
}

function bulkDataHelperGuideText() {
  return `🧩 <b>Bulk Data Helper</b>

Use this to convert/extract/merge stock data quickly.

Example:
Input Format:
<code>Mail|Pass|2FA</code>

Output Format:
<code>Mail|Pass|2FA|2FA Link</code>

Constants:
<code>2FA Link=https://2fa.live/</code>

Then send lines like:
<code>user@mail.com|pass123|ABCSECRET</code>

Output:
<code>user@mail.com|pass123|ABCSECRET|https://2fa.live/</code>`;
}


function makeStockItem(format, line) {
  const raw = String(line || '').trim();
  const f = normalizeDeliveryFormat(format || 'redeem_link');
  if (!raw) return '';
  if (raw.startsWith('{') && raw.includes('__gosStock')) return raw;

  if (isCustomDeliveryFormat(f)) {
    return JSON.stringify(customStockItemObject(f, raw));
  }

  if (f === 'id_password') {
    const parts = raw.split('|').map(x => x.trim());
    const id = parts[0] || raw;
    const pass = parts.slice(1).join('|') || '';
    return JSON.stringify({ __gosStock: true, format: 'id_password', id, password: pass, raw });
  }

  if (f === 'coupon_code') {
    return JSON.stringify({ __gosStock: true, format: 'coupon_code', code: raw, raw });
  }

  return JSON.stringify({ __gosStock: true, format: 'redeem_link', link: raw, raw });
}

function parseStockItem(item) {
  if (item && typeof item === 'object' && item.__gosStock) return item;
  const s = String(item ?? '').trim();
  try {
    const o = JSON.parse(s);
    if (o && o.__gosStock) {
      if (o.format === 'custom') {
        o.template ||= (o.fields || []).join('|') || 'Custom';
        o.fields ||= deliveryFieldsFromFormat(`custom:${o.template}`);
        o.values ||= String(o.raw || '').split('|').map(x => x.trim());
        o.mapped ||= {};
        o.fields.forEach((field, i) => { if (!(field in o.mapped)) o.mapped[field] = o.values[i] || ''; });
      }
      return o;
    }
  } catch (_) {}
  const looksLikeUrl = /^https?:\/\//i.test(s);
  return { __gosStock: true, format: looksLikeUrl ? 'redeem_link' : 'coupon_code', raw: s, link: looksLikeUrl ? s : '', code: looksLikeUrl ? '' : s };
}

function stockItemCopyText(item) {
  const o = parseStockItem(item);
  if (o.format === 'custom') return String(o.raw || '').trim();
  if (o.format === 'id_password') return `ID: ${o.id || ''}\nPassword: ${o.password || ''}`.trim();
  if (o.format === 'redeem_link') return String(o.link || o.raw || '').trim();
  if (o.format === 'coupon_code') return String(o.code || o.raw || '').trim();
  return String(o.raw || '').trim();
}

function stockItemDisplay(item, index = 0) {
  const o = parseStockItem(item);
  const n = index ? `${index}. ` : '';
  if (o.format === 'custom') {
    const fields = o.fields || [];
    const values = o.values || String(o.raw || '').split('|').map(x => x.trim());
    const lines = fields.map((field, i) => `   ${field}: ${values[i] || '-'}`);
    if (values.length > fields.length) lines.push(`   Extra: ${values.slice(fields.length).join('|')}`);
    return `${n}🧾 ${o.template || 'Custom Delivery'}\n${lines.join('\n')}`;
  }
  if (o.format === 'id_password') return `${n}🔐 Login Details\n   ID: ${o.id || '-'}\n   Password: ${o.password || '-'}`;
  if (o.format === 'redeem_link') return `${n}🔗 Redeem Link\n   ${o.link || o.raw || '-'}`;
  if (o.format === 'coupon_code') return `${n}🎟 Coupon / Code\n   ${o.code || o.raw || '-'}`;
  return `${n}🔑 ${o.raw || item}`;
}

function resolveWebStockFormat(stockFormat, customTemplate, fallback = 'redeem_link') {
  const selected = String(stockFormat || '').trim();
  if (selected === 'custom') {
    const template = cleanDeliveryTemplate(customTemplate || '');
    return template ? `custom:${template}` : normalizeDeliveryFormat(fallback);
  }
  return normalizeDeliveryFormat(selected || fallback);
}


function formatDeliveredItems(items) {
  return (items || []).map((item, index) => stockItemDisplay(item, index + 1)).join('\n\n');
}

function deliveryCopyButtons(orderId, items) {
  const rows = [];
  const allText = formatDeliveredItems(items || []);
  rows.push([{ text: '📋 Copy All TXT', copy_text: { text: allText.slice(0, 4096) } }]);
  (items || []).slice(0, 20).forEach((item, i) => {
    const o = parseStockItem(item);
    const label = o.format === 'custom' ? `📋 Copy Item ${i + 1}` : o.format === 'id_password' ? `📋 Copy Login ${i + 1}` : o.format === 'coupon_code' ? `📋 Copy Code ${i + 1}` : `📋 Copy Link ${i + 1}`;
    rows.push([{ text: label, copy_text: { text: stockItemCopyText(item).slice(0, 1024) } }]);
  });
  const shareText = encodeURIComponent(`Your order delivery from ${STORE_NAME}\n\n${allText}`.slice(0, 3500));
  rows.push([{ text: '📤 Share All', url: `https://t.me/share/url?url=&text=${shareText}` }]);
  const order = (db.orders || []).find(o => String(o.id) === String(orderId));
  if (order) {
    rows.push([
      { text: '⭐ Review Order', callback_data: `review_order:${order.id}` },
      { text: '🔁 Buy Again', callback_data: `view:${order.productCode}` }
    ]);
  }
  rows.push([
    { text: '🎫 Support', callback_data: 'support_ticket' },
    { text: '📦 My Orders', callback_data: 'orders' },
    { text: '🏠 Main Menu', callback_data: 'home' }
  ]);
  return inline(rows);
}

function deliveryFallbackButtons(orderId, items) {
  const allText = formatDeliveredItems(items || []);
  const shareText = encodeURIComponent(`Your order delivery from ${STORE_NAME}\n\n${allText}`.slice(0, 3500));
  const order = (db.orders || []).find(o => String(o.id) === String(orderId));
  const rows = [[{ text: '📤 Share All', url: `https://t.me/share/url?url=&text=${shareText}` }]];
  if (order) rows.push([{ text: '⭐ Review Order', callback_data: `review_order:${order.id}` }, { text: '🔁 Buy Again', callback_data: `view:${order.productCode}` }]);
  rows.push([{ text: '🎫 Support', callback_data: 'support_ticket' }, { text: '📦 My Orders', callback_data: 'orders' }, { text: '🏠 Main Menu', callback_data: 'home' }]);
  return inline(rows);
}

function deliveryTypeFromItems(items) {
  const first = (items || [])[0];
  if (!first) return 'Auto Delivery';
  const parsed = parseStockItem(first);
  return `${stockFormatEmoji(parsed.format)} ${stockFormatName(parsed.format)}`;
}


function findProductForDelivery(productName = '', productCode = '') {
  if (productCode) {
    const p = productByCode(productCode);
    if (p) return p;
  }
  const n = String(productName || '').trim().toLowerCase();
  return (db.products || []).find(p => String(p.name || '').trim().toLowerCase() === n) || null;
}

function defaultDeliveryTemplate() {
  return `🎉 [b]Order Delivered Successfully[/b]
[line]

📦 [b]Product:[/b] {product}
🧮 [b]Quantity:[/b] {qty}
💵 [b]Paid:[/b] {total}
🚚 [b]Delivery Type:[/b] {delivery_type}
🆔 [b]Order ID:[/b] [code]{order_id}[/code]

🔑 [b]Your Delivery Details:[/b]
{items}
{access_block}

⚠️ [b]Important:[/b] {note}

✅ Use copy buttons below to save/share your delivery.`;
}

function deliveryTemplateFor(product = null) {
  const custom = String(product?.deliveryMessageTemplate || '').trim();
  if (custom) return custom;
  const global = String(db.settings.deliveryMessageTemplate || '').trim();
  if (global) return global;
  return defaultDeliveryTemplate();
}

function deliveryTemplateHelpText() {
  return `🚚 <b>Custom Delivery Message Template</b>

You can customize delivery message using variables:

<code>{product}</code>
<code>{qty}</code>
<code>{total}</code>
<code>{currency}</code>
<code>{order_id}</code>
<code>{delivery_type}</code>
<code>{items}</code>
<code>{access_block}</code>
<code>{website}</code>
<code>{access_link}</code>
<code>{access_instructions}</code>
<code>{support}</code>
<code>{store}</code>
<code>{bot}</code>
<code>{note}</code>

Formatting:
<code>[b]bold[/b]</code>
<code>**bold**</code>
<code>[i]italic[/i]</code>
<code>[code]code[/code]</code>
<code>[line]</code>

Commands:
<code>/setdeliverymsg P001 TEMPLATE</code>
<code>/deliverypreview P001</code>
<code>/deliverymsghelp</code>`;
}


function accessValue(v = '') {
  return String(v || '').trim();
}

function normalizeUrl(v = '') {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return 'https://' + s;
  return s;
}

function parseAccessInfoInput(raw = '') {
  const s = String(raw || '').trim();
  if (!s || /^(skip|no|none|n\/a|-)$/.test(s.toLowerCase())) return { website: '', accessLink: '', instructions: '' };

  const info = { website: '', accessLink: '', instructions: '' };
  const lines = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z ]{2,24})\s*[:=-]\s*(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (/website|site|portal|panel/.test(key)) info.website = normalizeUrl(val);
      else if (/access|link|url|redeem/.test(key)) info.accessLink = normalizeUrl(val);
      else if (/instruction|note|guide|step|how/.test(key)) info.instructions = val;
      else info.instructions += (info.instructions ? '\n' : '') + line;
    } else if (/^https?:\/\//i.test(line) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(line)) {
      if (!info.accessLink) info.accessLink = normalizeUrl(line);
      else if (!info.website) info.website = normalizeUrl(line);
      else info.instructions += (info.instructions ? '\n' : '') + line;
    } else {
      info.instructions += (info.instructions ? '\n' : '') + line;
    }
  }
  return info;
}

function applyProductAccessInfo(product, info = {}) {
  if (!product) return;
  product.deliveryAccessWebsite = accessValue(info.website ?? product.deliveryAccessWebsite);
  product.deliveryAccessLink = normalizeUrl(info.accessLink ?? product.deliveryAccessLink);
  product.deliveryAccessInstructions = accessValue(info.instructions ?? product.deliveryAccessInstructions);
}

function productAccessInfo(product = {}) {
  return {
    website: accessValue(product.deliveryAccessWebsite),
    accessLink: normalizeUrl(product.deliveryAccessLink),
    instructions: accessValue(product.deliveryAccessInstructions)
  };
}

function accessInfoBlock(product = {}) {
  const info = productAccessInfo(product);
  const parts = [];
  if (info.website) parts.push(`🌐 <b>Website:</b> ${escapeHtml(info.website)}`);
  if (info.accessLink) {
    const safe = escapeHtml(info.accessLink);
    parts.push(`🔗 <b>Access Link:</b> <a href="${safe}">Open Access Link</a>`);
  }
  if (info.instructions) parts.push(`📝 <b>Instructions:</b>\n${escapeHtml(info.instructions)}`);
  return parts.length ? `\n\n🌟 <b>Access / Website Details</b>\n${parts.join('\n')}` : '';
}

function accessInfoPlain(product = {}) {
  const info = productAccessInfo(product);
  const out = [];
  if (info.website) out.push(`Website: ${info.website}`);
  if (info.accessLink) out.push(`Access Link: ${info.accessLink}`);
  if (info.instructions) out.push(`Instructions: ${info.instructions}`);
  return out.join('\n');
}

function accessInfoPromptText(product = {}) {
  return `🌐 <b>Access Link / Website Info</b>

Product: <b>${escapeHtml(product.name || product.code || 'Product')}</b>

Send website/access info that should appear in delivery message.

Examples:
<code>Website: https://example.com
Access Link: https://example.com/redeem
Instructions: Login / redeem from this link</code>

Or send <code>skip</code> if no extra website/access link.`;
}

function stockPreviewConfirmButtons() {
  return inline([
    [
      { text: '✅ Confirm Add + Deliver Queue', callback_data: 'stock_confirm_add' },
      { text: '👀 Preview Again', callback_data: 'stock_preview_again' }
    ],
    [
      { text: '✍️ Edit Delivery Msg', callback_data: 'stock_edit_delivery_template' },
      { text: '🌐 Edit Access Info', callback_data: 'stock_edit_access_info' }
    ],
    [{ text: '❌ Cancel', callback_data: 'cancel' }]
  ]);
}

function stockAddPreviewText(session = {}) {
  const p = productByCode(session.productCode);
  if (!p) return '❌ Product not found.';
  const temp = { ...p };
  applyProductAccessInfo(temp, session.accessInfo || {});
  if (session.deliveryMessageTemplate) temp.deliveryMessageTemplate = session.deliveryMessageTemplate;
  const format = normalizeDeliveryFormat(session.stockFormat || p.stockFormat || 'redeem_link');
  const firstLine = (session.stockLines || [])[0] || stockLineExample(format);
  const sampleItem = makeStockItem(format, firstLine);
  const preview = deliveryText(temp.name, Math.max(1, Math.min(1, (session.stockLines || []).length || 1)), temp.price || 0, temp.currency || currency(), [sampleItem], 'DEMO-ORDER', true, temp.code);
  return `👀 <b>Delivery Message Preview</b>
━━━━━━━━━━━━━━━━━━━━

📦 Product: <b>${escapeHtml(temp.name)}</b>
📥 Stock Lines: <b>${(session.stockLines || []).length}</b>
🚚 Format: <b>${escapeHtml(stockFormatName(format))}</b>

${preview}

━━━━━━━━━━━━━━━━━━━━
✅ If this preview is correct, tap <b>Confirm Add + Deliver Queue</b>.
✍️ If you want bold/custom text, tap <b>Edit Delivery Msg</b>.`;
}

async function finishStockAddWorkflow(userId, chatId, session = {}) {
  const p = productByCode(session.productCode);
  if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
  const lines = (session.stockLines || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!lines.length) return sendMessage(chatId, '❌ No stock lines found.', productManagerButtons(p));
  const format = normalizeDeliveryFormat(session.stockFormat || p.stockFormat || 'redeem_link');

  p.stockFormat = format;
  p.stock ||= [];
  if (session.deliveryMessageTemplate) p.deliveryMessageTemplate = String(session.deliveryMessageTemplate || '').trim();
  applyProductAccessInfo(p, session.accessInfo || {});
  p.stock.push(...lines.map(line => makeStockItem(format, line)));
  p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
  saveData();

  const waitResult = await processStockWaitQueue(p.code, 'stock-added');
  const remainingAdded = Math.max(0, lines.length - waitResult.ok);
  if (remainingAdded > 0 && p.stock.length > 0) {
    broadcastStockAlert(p, remainingAdded).catch((err) => console.error('Stock alert failed:', err.message));
  }
  clearSession(userId);

  return sendMessage(chatId, `✅ <b>Stock Added Successfully</b>
━━━━━━━━━━━━━━━━━━━━

📦 Product: <b>${escapeHtml(p.name)}</b>
🚚 Format: <b>${escapeHtml(stockFormatName(format))}</b>
📥 Added: <b>${lines.length}</b>

⏳ Queue Delivered First: <b>${waitResult.ok}</b>
⏭ Waiting/Skipped: <b>${waitResult.skipped}</b>
❌ Failed: <b>${waitResult.fail}</b>
📦 Current Stock Left: <b>${p.stock.length}</b>

${accessInfoPlain(p) ? `🌐 <b>Access Info Saved:</b>\n<code>${escapeHtml(accessInfoPlain(p))}</code>\n\n` : ''}${waitResult.ok ? '✅ Paid waiting orders were completed before public stock alert.' : '📢 Public stock alert started if stock remains.'}`, productManagerButtons(p));
}

function deliveryTemplateEditorHelp(product = null) {
  return `✍️ <b>Edit Delivery Message Template</b>

Use these variables:
<code>{product}</code> <code>{qty}</code> <code>{total}</code>
<code>{order_id}</code> <code>{items}</code>
<code>{access_block}</code> <code>{website}</code>
<code>{access_link}</code> <code>{access_instructions}</code>
<code>{support}</code> <code>{bot}</code> <code>{note}</code>

Formatting:
<code>[b]bold[/b]</code> or <code>**bold**</code>
<code>[i]italic[/i]</code>
<code>[code]code[/code]</code>
<code>[line]</code>

Current product: <b>${escapeHtml(product?.name || '-')}</b>`;
}

function appFeatureCheckText() {
  const missing = [];
  if (typeof createStockItemObject !== 'function') missing.push('createStockItemObject');
  if (typeof processStockWaitQueue !== 'function') missing.push('processStockWaitQueue');
  if (typeof sendDeliveryMessage !== 'function') missing.push('sendDeliveryMessage');
  if (typeof directBuyKeyboard !== 'function') missing.push('directBuyKeyboard');

  const s = runtimeHealthSnapshot();
  return `🧪 <b>Feature Check</b>
━━━━━━━━━━━━━━━━━━━━

${missing.length ? '🔴 Missing: ' + missing.map(escapeHtml).join(', ') : '🟢 Core functions OK'}

📦 Products: <b>${(db.products || []).length}</b>
👥 Users: <b>${Object.keys(db.users || {}).length}</b>
💳 Payments: <b>${(db.payments || []).length}</b>
🧾 Orders: <b>${(db.orders || []).length}</b>
⏳ Stock Wait: <b>${stockWaitPayments().length}</b>
🚚 Failed Delivery: <b>${safeDeliverySummary().failed.length}</b>
⚡ API Avg: <b>${s.apiAvg}ms</b>

✅ Telegram admin panel + Web panel feature check complete.`;
}


function renderDeliveryTemplate(product, productName, qty, total, curr, items, orderId, note = true) {
  const list = formatDeliveredItems(items || []);
  const support = db.settings.supportUsername || SUPPORT_USERNAME;
  const bot = getBotUsername() || botUsername || BOT_USERNAME || '';
  const htmlVars = {
    product: escapeHtml(productName || product?.name || 'Product'),
    qty: escapeHtml(qty),
    total: escapeHtml(money(total, curr)),
    currency: escapeHtml(curr || currency()),
    order_id: escapeHtml(orderId),
    delivery_type: escapeHtml(deliveryTypeFromItems(items)),
    items: `<code>${escapeHtml(list)}</code>`,
    raw_items: escapeHtml(list),
    access_block: accessInfoBlock(product),
    website: escapeHtml(productAccessInfo(product).website || ''),
    access_link: escapeHtml(productAccessInfo(product).accessLink || ''),
    access_instructions: escapeHtml(productAccessInfo(product).instructions || ''),
    support: escapeHtml(support),
    store: escapeHtml(STORE_NAME),
    bot: bot ? '@' + escapeHtml(bot) : escapeHtml(STORE_NAME),
    note: escapeHtml(db.settings.afterDeliveryNote || 'Please save your delivery details safely.'),
    loyalty: escapeHtml(String((db.users?.[String((db.orders || []).find(o => String(o.id) === String(orderId))?.telegramId)] || {}).loyaltyPoints || 0))
  };

  let formatted = formatAdminCustomMarkup(deliveryTemplateFor(product));
  for (const [key, val] of Object.entries(htmlVars)) {
    formatted = formatted.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(val));
  }
  if (note && !formatted.includes('copy buttons')) {
    formatted += `\n\n📋 Use buttons below to copy each item or share all.`;
  }
  return formatted;
}


function deliveryText(productName, qty, total, curr, items, orderId, note = true, productCode = '') {
  const product = findProductForDelivery(productName, productCode);
  return renderDeliveryTemplate(product, productName, qty, total, curr, items, orderId, note);
}

async function sendLongDeliveryText(chatId, productName, qty, total, curr, items, orderId, replyMarkup, productCode = '') {
  const full = deliveryText(productName, qty, total, curr, items, orderId, true, productCode);
  if (full.length <= 3900) return sendMessage(chatId, full, replyMarkup);

  const header = `🎉 <b>Order Delivered Successfully</b>\n\n📦 <b>Product:</b> ${escapeHtml(productName)}\n🧮 <b>Quantity:</b> ${qty}\n💵 <b>Paid:</b> ${money(total, curr)}\n🚚 <b>Delivery Type:</b> ${escapeHtml(deliveryTypeFromItems(items))}\n🆔 <b>Order ID:</b> <code>${escapeHtml(orderId)}</code>\n\nLarge delivery list is split below.`;
  await sendMessage(chatId, header);
  const blocks = formatDeliveredItems(items).split('\n\n');
  let chunk = '';
  for (const block of blocks) {
    if ((chunk + block + '\n\n').length > 3400) {
      await sendMessage(chatId, `<code>${escapeHtml(chunk.trim())}</code>`);
      chunk = '';
    }
    chunk += block + '\n\n';
  }
  if (chunk.trim()) await sendMessage(chatId, `<code>${escapeHtml(chunk.trim())}</code>`);
  return sendMessage(chatId, '📋 Delivery complete. Use buttons below:', replyMarkup);
}

async function sendDeliveryMessage(chatId, productName, qty, total, curr, items, orderId, productCode = '') {
  const order = (db.orders || []).find(o => String(o.id) === String(orderId));
  if (order) {
    order.deliveryAttempts = Number(order.deliveryAttempts || 0) + 1;
    order.lastDeliveryAttemptAt = now();
    order.deliveryStatus = order.deliveryStatus || 'sending';
    addDeliveryAuditLog('delivery_attempt', orderId, { chatId, productCode, qty }, 'info');
    saveData();
  }
  try {
    const msg = await sendLongDeliveryText(chatId, productName, qty, total, curr, items, orderId, deliveryCopyButtons(orderId, items), productCode);
    if (order) {
      order.deliveryStatus = 'sent';
      order.deliveredAt ||= now();
      order.deliveryMessageId = msg?.message_id || order.deliveryMessageId || '';
      order.deliveryError = '';
      addDeliveryAuditLog('delivery_sent', orderId, { chatId, messageId: msg?.message_id || '' }, 'info');
      saveData();
    }
    return msg;
  } catch (err) {
    console.error('Delivery with copy buttons failed, trying fallback:', err.message);
    try {
      const msg2 = await sendLongDeliveryText(chatId, productName, qty, total, curr, items, orderId, deliveryFallbackButtons(orderId, items), productCode);
      if (order) {
        order.deliveryStatus = 'sent';
        order.deliveredAt ||= now();
        order.deliveryMessageId = msg2?.message_id || order.deliveryMessageId || '';
        order.deliveryError = '';
        addDeliveryAuditLog('delivery_sent_fallback', orderId, { chatId, messageId: msg2?.message_id || '' }, 'warn');
        saveData();
      }
      return msg2;
    } catch (err2) {
      console.error('Delivery fallback failed:', err2.message);
      if (order) {
        order.deliveryStatus = 'failed';
        order.deliveryError = err2.message;
        order.deliveryFailedAt = now();
        addDeliveryAuditLog('delivery_failed', orderId, { chatId, error: err2.message }, 'error');
        if (db.settings.deliveryFailureAutoReview !== false) {
          const payment = (db.payments || []).find(p => p.id === order.paymentId);
          if (payment) {
            payment.deliveryReview = true;
            payment.lastCheckReason = `Delivery failed after order creation: ${err2.message}`;
          }
        }
        saveData();
      }
      throw err2;
    }
  }
}


function specialPriceRows(p) {
  const entries = Object.entries(p.specialPrices || {});
  if (!entries.length) return 'No special pricing set.';
  return entries.map(([uid, price]) => {
    const u = db.users?.[uid];
    const name = u ? `${u.firstName || 'User'} ${u.username ? '@' + u.username : ''}` : 'Unknown User';
    return `${uid} | ${name} → ${money(price, p.currency || currency())}`;
  }).join('\n');
}



function findCoupon(code) {
  const c = (db.coupons || []).find((x) => String(x.code || '').toUpperCase() === String(code || '').toUpperCase());
  if (!c || c.active === false) return null;
  if (Number(c.maxUses || 0) > 0 && Number(c.uses || 0) >= Number(c.maxUses || 0)) return null;
  return c;
}

function applyCoupon(total, coupon) {
  total = Number(total || 0);
  if (!coupon) return { discount: 0, final: total };
  const min = Number(coupon.minAmount || 0);
  if (min && total < min) return { discount: 0, final: total, error: `Minimum order amount is ${money(min)}` };
  let discount = 0;
  if (coupon.type === 'percent') discount = total * (Number(coupon.value || 0) / 100);
  else discount = Number(coupon.value || 0);
  discount = Math.max(0, Math.min(total, Number(discount.toFixed(2))));
  return { discount, final: Math.max(0, Number((total - discount).toFixed(2))) };
}

function couponRows() {
  const list = db.coupons || [];
  if (!list.length) return 'No coupons yet.';
  return list.map((c) => `${c.active === false ? 'OFF' : 'ON'} | ${c.code} | ${c.type === 'percent' ? c.value + '%' : money(c.value)} | Uses ${c.uses || 0}/${c.maxUses || '∞'}`).join('\n');
}

function nextCouponId() {
  return 'CP' + Date.now();
}


function productReviews(code) {
  return (db.reviews || []).filter(r => r.productCode === String(code).toUpperCase());
}

function productRatingSummary(code) {
  const list = productReviews(code);
  if (!list.length) return { count: 0, avg: 0 };
  const avg = list.reduce((a, r) => a + Number(r.rating || 0), 0) / list.length;
  return { count: list.length, avg: Math.round(avg * 10) / 10 };
}

function ratingStars(n) {
  n = Math.round(Number(n || 0));
  return '⭐'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - Math.max(0, Math.min(5, n))));
}

function findReviewByOrder(orderId) {
  return (db.reviews || []).find(r => r.orderId === String(orderId));
}

function createOrUpdateReview(order, from, rating, message = '') {
  db.reviews ||= [];
  let r = findReviewByOrder(order.id);
  if (!r) {
    r = {
      id: 'REV' + Date.now() + Math.floor(Math.random() * 999),
      orderId: order.id,
      telegramId: String(from.id),
      firstName: from.first_name || db.users?.[String(from.id)]?.firstName || 'User',
      username: from.username || db.users?.[String(from.id)]?.username || '',
      productCode: order.productCode,
      productName: order.productName,
      rating: Number(rating),
      message: String(message || '').trim(),
      createdAt: now(),
      updatedAt: now()
    };
    db.reviews.unshift(r);
  } else {
    r.rating = Number(rating || r.rating || 5);
    if (String(message || '').trim()) r.message = String(message || '').trim();
    r.updatedAt = now();
  }
  saveData();
  return r;
}

function reviewRowsText(limit = 10) {
  const list = (db.reviews || []).slice(0, limit);
  if (!list.length) return 'No reviews yet.';
  return list.map((r, i) => `${i + 1}. ${ratingStars(r.rating)} ${r.rating}/5\n${r.productName}\nUser: ${r.firstName || 'User'} ${r.username ? '@' + r.username : ''}\n${r.message ? 'Review: ' + r.message : ''}`).join('\n\n');
}

function productMarketingPack(product) {
  const rating = productRatingSummary(product.code);
  const stockLine = product.stock?.length ? `📦 Stock: ${product.stock.length} available` : '❌ Currently out of stock';
  const ratingLine = rating.count ? `⭐ Rating: ${rating.avg}/5 (${rating.count} reviews)` : '⭐ New product';
  const bot = getBotUsername() || botUsername || 'YourBotUsername';
  const buyLink = `https://t.me/${bot}?start=buy_${product.code}`;
  const groupPost = `🔥 ${product.emoji || '📦'} ${product.name}\n\n${product.description || ''}\n\n💰 Price: ${money(product.price, product.currency || currency())}\n${stockLine}\n${ratingLine}\n\n🛒 Buy Now: @${bot}\n${buyLink}`;
  const shortPost = `🔥 ${product.name}\n💰 ${money(product.price, product.currency || currency())}\n${stockLine}\nBuy: @${bot}`;
  const channelPost = `🆕 <b>${escapeHtml(product.name)}</b>\n\n💰 Price: <b>${money(product.price, product.currency || currency())}</b>\n${stockLine}\n${ratingLine}\n\n⚡ Fast checkout from bot.`;
  return { groupPost, shortPost, channelPost, buyLink };
}


async function approveReplacementTicket(ticket, adminLabel = 'admin') {
  if (!ticket) throw new Error('Ticket not found');
  if (ticket.type !== 'replacement') throw new Error('This ticket is not a replacement request');

  if (ticket.status === 'replacement_approved' && ticket.replacementOrderId) {
    return `Replacement already approved. Order: ${ticket.replacementOrderId}`;
  }

  const product = productByCode(ticket.productCode);
  if (!product) throw new Error('Product not found for replacement');
  const qty = Number(ticket.qty || ticket.orderQty || 1);

  if ((product.stock || []).length < qty) {
    ticket.status = 'replacement_wait_stock';
    ticket.replacementStatus = 'waiting_stock';
    ticket.updatedAt = now();
    saveData();
    try {
      await sendMessage(ticket.telegramId, `🛡 <b>Replacement Approved - Waiting For Stock</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nProduct: <b>${escapeHtml(ticket.productName)}</b>\n\nAdmin approved your request, but stock is currently not enough. You will receive replacement after restock.`, homeButtons(ticket.telegramId));
    } catch (_) {}
    return `Replacement approved but waiting for stock. Required ${qty}, available ${(product.stock || []).length}.`;
  }

  const replacementOrder = await createManualOrder(ticket.telegramId, ticket.productCode, qty, `Replacement Approved | Ticket ${ticket.id} | Original ${ticket.orderId || '-'}`);
  replacementOrder.replacementForOrderId = ticket.orderId || '';
  replacementOrder.replacementTicketId = ticket.id;
  replacementOrder.replacementApprovedBy = adminLabel;
  replacementOrder.replacementApprovedAt = now();

  ticket.status = 'replacement_approved';
  ticket.replacementStatus = 'approved';
  ticket.replacementOrderId = replacementOrder.id;
  ticket.replacementApprovedBy = adminLabel;
  ticket.replacementApprovedAt = now();
  ticket.updatedAt = now();
  ticket.replies ||= [];
  ticket.replies.push({ by: adminLabel, message: `Replacement approved and delivered. Replacement order: ${replacementOrder.id}`, at: now() });
  saveData();

  try {
    await sendMessage(ticket.telegramId, `✅ <b>Replacement Approved & Delivered</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nOriginal Order: <code>${escapeHtml(ticket.orderId || '-')}</code>\nReplacement Order: <code>${escapeHtml(replacementOrder.id)}</code>\n\nDelivery has been sent above.`, homeButtons(ticket.telegramId));
  } catch (_) {}

  return `Replacement approved and delivered. Replacement order: ${replacementOrder.id}`;
}

async function rejectReplacementTicket(ticket, adminLabel = 'admin', reason = '') {
  if (!ticket) throw new Error('Ticket not found');
  if (ticket.type !== 'replacement') throw new Error('This ticket is not a replacement request');

  ticket.status = 'replacement_rejected';
  ticket.replacementStatus = 'rejected';
  ticket.replacementRejectedBy = adminLabel;
  ticket.replacementRejectedAt = now();
  ticket.updatedAt = now();
  ticket.replies ||= [];
  ticket.replies.push({ by: adminLabel, message: reason || 'Replacement request rejected by admin.', at: now() });
  saveData();

  try {
    await sendMessage(ticket.telegramId, `❌ <b>Replacement Request Rejected</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nOrder: <code>${escapeHtml(ticket.orderId || '-')}</code>\n\n${reason ? 'Reason: ' + escapeHtml(reason) : 'Please contact support if you think this is a mistake.'}`, homeButtons(ticket.telegramId));
  } catch (_) {}

  return `Replacement rejected: ${ticket.id}`;
}


async function createReplacementTicket(from, order) {
  db.supportTickets ||= [];
  const existing = db.supportTickets.find(t => t.type === 'replacement' && t.orderId === order.id && t.telegramId === String(from.id) && !['closed', 'replacement_rejected'].includes(String(t.status || '')));
  if (existing) return { ticket: existing, created: false };
  const ticket = {
    id: nextTicketId(),
    type: 'replacement',
    orderId: order.id,
    telegramId: String(from.id),
    firstName: from.first_name || db.users?.[String(from.id)]?.firstName || 'User',
    username: from.username || db.users?.[String(from.id)]?.username || '',
    productCode: order.productCode,
    productName: order.productName,
    message: `Replacement request for order ${order.id} | Product: ${order.productName} | Qty: ${order.qty}`,
    qty: Number(order.qty || 1),
    orderQty: Number(order.qty || 1),
    replacementStatus: 'pending_admin_approval',
    replies: [],
    status: 'replacement_pending',
    createdAt: now(),
    updatedAt: now()
  };
  db.supportTickets.unshift(ticket);
  saveData();
  try {
    await sendMessage(ADMIN_ID, `🛡 <b>Replacement Approval Needed</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nOriginal Order: <code>${escapeHtml(order.id)}</code>\nProduct: <b>${escapeHtml(order.productName)}</b>\nQty: <b>${escapeHtml(order.qty || 1)}</b>\nUser: <b>${escapeHtml(ticket.firstName)}</b> ${ticket.username ? '@' + escapeHtml(ticket.username) : ''}\nUser ID: <code>${escapeHtml(ticket.telegramId)}</code>\n\nApprove karne par stock cut hoga aur replacement auto deliver hoga.`, ticketAdminButtons(ticket.id));
  } catch (_) {}
  return { ticket, created: true };
}



function openTickets() {
  return (db.supportTickets || []).filter(t => t.status !== 'closed' && t.status !== 'replacement_approved' && t.status !== 'replacement_rejected');
}

function nextTicketId() {
  const max = (db.supportTickets || []).reduce((m, x) => Math.max(m, Number(String(x.id || '').replace(/\D/g, ''))), 0);
  return 'T' + String(max + 1).padStart(4, '0');
}

function ticketAdminButtons(ticketId) {
  return inline([
    [{ text: '✅ Approve Replacement', callback_data: `ticket_approve_repl:${ticketId}` }, { text: '❌ Reject Replacement', callback_data: `ticket_reject_repl:${ticketId}` }],
    [{ text: '✍️ Reply', callback_data: `ticket_reply:${ticketId}` }, { text: '🔒 Close Ticket', callback_data: `ticket_close:${ticketId}` }],
    [{ text: '🎫 All Tickets', callback_data: 'admin_tickets' }]
  ]);
}

function ticketStatusLabel(t) {
  if (t.type === 'replacement') {
    if (t.status === 'replacement_approved') return '🟢 Replacement Approved';
    if (t.status === 'replacement_rejected') return '🔴 Replacement Rejected';
    if (t.status === 'replacement_wait_stock') return '🟡 Waiting Stock';
    return '🛡 Replacement Pending';
  }
  if (t.status === 'closed') return '⚪ Closed';
  if (t.status === 'answered') return '🔵 Answered';
  return '🟡 Open';
}

function createSupportTicket(from, text) {
  db.supportTickets ||= [];
  const ticket = {
    id: nextTicketId(),
    type: 'support',
    telegramId: String(from.id),
    firstName: from.first_name || db.users?.[String(from.id)]?.firstName || 'User',
    username: from.username || db.users?.[String(from.id)]?.username || '',
    message: text,
    replies: [],
    status: 'open',
    createdAt: now(),
    updatedAt: now()
  };
  db.supportTickets.unshift(ticket);
  saveData();
  return ticket;
}

async function notifyAdminTicket(ticket) {
  try {
    await sendMessage(ADMIN_ID, `🎫 <b>New Support Ticket</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nUser: <b>${escapeHtml(ticket.firstName)}</b> ${ticket.username ? '@' + escapeHtml(ticket.username) : ''}\nUser ID: <code>${escapeHtml(ticket.telegramId)}</code>\n\n<b>Message:</b>\n${escapeHtml(ticket.message)}`, ticketAdminButtons(ticket.id));
  } catch (_) {}
}

async function createManualOrder(telegramId, productCode, qty, note = 'Manual Delivery') {
  const p = productByCode(productCode);
  if (!p) throw new Error('Product not found');
  if ((p.stock || []).length < qty) throw new Error(`Not enough stock. Available: ${(p.stock || []).length}`);
  const items = deliverStock(p, qty);
  const orderId = 'O' + Date.now();
  const order = {
    id: orderId,
    telegramId: String(telegramId),
    productCode: p.code,
    productName: p.name,
    qty: Number(qty),
    total: 0,
    unitPrice: Number(p.price || 0),
    subtotal: 0,
    discount: 0,
    couponCode: '',
    currency: p.currency || currency(),
    method: 'Manual Delivery (' + note + ')',
    deliveredItems: items,
    status: 'paid',
    createdAt: now()
  };
  db.orders.push(order);
  saveData();
  try {
    await sendDeliveryMessage(telegramId, p.name, qty, 0, p.currency || currency(), items, orderId, p.code);
  } catch (_) {}
  return order;
}

function orderStatusLabel(order) {
  if (order.replacementForOrderId) return '🛡 Replacement';
  if (order.status === 'paid') return '✅ Delivered';
  return String(order.status || 'order').toUpperCase();
}

function orderSearchMatch(order, q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return true;
  return [
    order.id,
    order.telegramId,
    order.productCode,
    order.productName,
    order.couponCode,
    order.paymentId,
    order.method,
    order.status
  ].some(v => String(v || '').toLowerCase().includes(q));
}

function userOrders(uid) {
  return db.orders.filter(o => String(o.telegramId) === String(uid)).sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function orderStats(orders) {
  const total = orders.length;
  const revenue = orders.reduce((a,o)=>a+Number(o.total||0),0);
  const qty = orders.reduce((a,o)=>a+Number(o.qty||0),0);
  const products = {};
  orders.forEach(o => {
    products[o.productCode || o.productName] ||= { name: o.productName, qty: 0, total: 0 };
    products[o.productCode || o.productName].qty += Number(o.qty || 0);
    products[o.productCode || o.productName].total += Number(o.total || 0);
  });
  const top = Object.values(products).sort((a,b)=>b.qty-a.qty)[0] || null;
  return { total, revenue, qty, top };
}

function orderHistoryText(orders, title = 'Order History', limit = 30) {
  const s = orderStats(orders);
  let out = `🧾 <b>${escapeHtml(title)}</b>\n\n`;
  out += `Total Orders: <b>${s.total}</b>\nTotal Qty: <b>${s.qty}</b>\nTotal Spent/Revenue: <b>${money(s.revenue)}</b>\n`;
  if (s.top) out += `Top Product: <b>${escapeHtml(s.top.name)}</b> (${s.top.qty})\n`;
  out += '\n';
  if (!orders.length) return out + 'No orders found.';
  orders.slice(0, limit).forEach((o, i) => {
    out += `${i + 1}. <b>${escapeHtml(o.productName)}</b>\n`;
    out += `Order: <code>${escapeHtml(o.id)}</code>\n`;
    out += `Status: ${escapeHtml(orderStatusLabel(o))}\n`;
    out += `Qty: ${escapeHtml(o.qty || 0)} | Total: <b>${money(o.total, o.currency)}</b>\n`;
    out += `Date: ${escapeHtml(new Date(o.createdAt).toLocaleString())}\n\n`;
  });
  if (orders.length > limit) out += `And ${orders.length - limit} more...\n`;
  return out;
}

function orderHistoryPlainText(orders, title = 'Order History') {
  const s = orderStats(orders);
  let out = `${title}\n\n`;
  out += `Total Orders: ${s.total}\nTotal Qty: ${s.qty}\nTotal Spent/Revenue: ${money(s.revenue)}\n`;
  if (s.top) out += `Top Product: ${s.top.name} (${s.top.qty})\n`;
  out += `\n`;
  orders.forEach((o, i) => {
    out += `${i + 1}. ${o.productName}\n`;
    out += `Order: ${o.id}\nUser: ${o.telegramId}\nStatus: ${orderStatusLabel(o)}\nQty: ${o.qty}\nTotal: ${money(o.total, o.currency)}\nMethod: ${o.method || '-'}\nCoupon: ${o.couponCode || '-'}\nDate: ${new Date(o.createdAt).toLocaleString()}\n\n`;
  });
  return out;
}

function filterWebOrders(query = {}) {
  let list = db.orders.slice().sort((a,b)=>new Date(b.createdAt || 0)-new Date(a.createdAt || 0));
  const q = String(query.q || '').trim();
  const user = String(query.user || '').trim();
  const product = String(query.product || '').trim().toLowerCase();
  const status = String(query.status || '').trim();
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();

  if (q) list = list.filter(o => orderSearchMatch(o, q));
  if (user) list = list.filter(o => String(o.telegramId).includes(user.replace('@','')) || String(db.users?.[o.telegramId]?.username || '').toLowerCase().includes(user.replace('@','').toLowerCase()));
  if (product) list = list.filter(o => String(o.productCode || '').toLowerCase().includes(product) || String(o.productName || '').toLowerCase().includes(product));
  if (status) {
    if (status === 'replacement') list = list.filter(o => o.replacementForOrderId);
    else list = list.filter(o => String(o.status || '').toLowerCase() === status.toLowerCase());
  }
  if (from) {
    const t = Date.parse(from + 'T00:00:00');
    if (Number.isFinite(t)) list = list.filter(o => Date.parse(o.createdAt || 0) >= t);
  }
  if (to) {
    const t = Date.parse(to + 'T23:59:59');
    if (Number.isFinite(t)) list = list.filter(o => Date.parse(o.createdAt || 0) <= t);
  }
  return list;
}

function csvEscape(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

function ordersToCsv(orders) {
  const header = ['orderId','userId','username','productCode','productName','qty','total','currency','status','method','coupon','paymentId','replacementFor','createdAt'].join(',');
  const rows = orders.map(o => [
    o.id,
    o.telegramId,
    db.users?.[String(o.telegramId)]?.username || '',
    o.productCode || '',
    o.productName || '',
    o.qty || 0,
    o.total || 0,
    o.currency || currency(),
    orderStatusLabel(o),
    o.method || '',
    o.couponCode || '',
    o.paymentId || '',
    o.replacementForOrderId || '',
    o.createdAt || ''
  ].map(csvEscape).join(','));
  return [header, ...rows].join('\n');
}


function orderDetailButtons(order) {
  const rows = [];
  if (order?.deliveredItems?.length) {
    rows.push([{ text: '📋 Copy All TXT', copy_text: { text: formatDeliveredItems(order.deliveredItems) } }]);
    order.deliveredItems.slice(0, 20).forEach((item, i) => rows.push([{ text: `📋 Copy Link ${i + 1}`, copy_text: { text: (typeof stockItemCopyText === 'function' ? stockItemCopyText(item) : String(item)) } }]));
    const shareText = encodeURIComponent(`Your order delivery from ${STORE_NAME}\n\n${formatDeliveredItems(order.deliveredItems)}`);
    rows.push([{ text: '📤 Share All', url: `https://t.me/share/url?url=&text=${shareText}` }]);
  }
  rows.push([
    { text: '⭐ Rate Order', callback_data: `review_order:${order.id}` },
    { text: '🛡 Replacement', callback_data: `replace_order:${order.id}` }
  ]);
  rows.push([{ text: '📦 My Orders', callback_data: 'orders' }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return inline(rows);
}

async function showOrderDetail(chatId, from, orderId) {
  const order = db.orders.find((o) => o.id === orderId && o.telegramId === String(from.id));
  if (!order) return sendMessage(chatId, '❌ Order not found.', homeButtons(from.id));
  const delivered = order.deliveredItems?.length ? `<code>${escapeHtml(formatDeliveredItems(order.deliveredItems))}</code>` : 'No delivery saved.';
  return sendMessage(chatId, `🧾 <b>Order Detail</b>\n\n🆔 Order: <code>${escapeHtml(order.id)}</code>\n📦 Product: <b>${escapeHtml(order.productName)}</b>\n🧮 Quantity: <b>${order.qty}</b>\n💵 Total: <b>${money(order.total, order.currency)}</b>\n🎟 Coupon: <b>${escapeHtml(order.couponCode || '-')}</b>\n📅 Date: ${escapeHtml(new Date(order.createdAt).toLocaleString())}\n\n🔑 <b>Delivery:</b>\n${delivered}`, orderDetailButtons(order));
}

async function broadcastWebAnnouncement(message) {
  return broadcastAnnouncement(message);
}


function nextProductCode() {
  const max = db.products.reduce((m, p) => Math.max(m, Number(String(p.code || '').replace(/\D/g, '')) || 0), 0);
  return 'P' + String(max + 1).padStart(3, '0');
}

function getUser(from, ref = '') {
  const uid = String(from.id);
  if (!db.users[uid]) {
    db.users[uid] = {
      telegramId: uid,
      firstName: from.first_name || '',
      username: from.username || '',
      balance: 0,
      referrals: 0,
      referredBy: ref && ref !== uid ? ref : '',
      notifications: true,
      banned: false,
      createdAt: now()
    };
    if (db.users[uid].referredBy && db.users[db.users[uid].referredBy]) {
      db.users[db.users[uid].referredBy].referrals = Number(db.users[db.users[uid].referredBy].referrals || 0) + 1;
    }
    saveData();
  } else {
    db.users[uid].firstName = from.first_name || db.users[uid].firstName;
    db.users[uid].username = from.username || db.users[uid].username;
  }
  db.users[uid].loyaltyPoints ||= 0;
  return db.users[uid];
}

function addLoyaltyPointsForOrder(order) {
  if (!order || order.loyaltyAdded) return 0;
  if (db.settings.loyaltyEnabled === false) return 0;
  const user = ensureUserById(order.telegramId);
  const rate = Number(db.settings.loyaltyPointsPerDollar || 1);
  const points = Math.max(0, Math.floor(Number(order.total || 0) * rate));
  if (points > 0) {
    user.loyaltyPoints = Number(user.loyaltyPoints || 0) + points;
    order.loyaltyAdded = true;
  }
  return points;
}

function loyaltyLine(uid) {
  const u = db.users?.[String(uid)] || {};
  return `🏆 Loyalty Points: <b>${Number(u.loyaltyPoints || 0)}</b>`;
}

function homeButtons(uid) {
  const rows = [
    [
      { text: '🛍 Shop', callback_data: 'shop:1' },
      { text: '🗂 Categories', callback_data: 'categories' }
    ],
    [
      { text: '💰 Deposit', callback_data: 'deposit' },
      { text: '🔥 Top Deals', callback_data: 'user_top_deals' }
    ],
    [
      { text: '👤 Profile', callback_data: 'profile' },
      { text: '🎁 Freebie', callback_data: 'claim_freebie' }
    ],
    [
      { text: '🧰 Tools', callback_data: 'user_tools' },
      { text: '🆘 Support', callback_data: 'support' }
    ],
    [
      { text: '🧹 Clear Chat', callback_data: 'clear' }
    ]
  ];
  if (db.settings.channelUrl) rows.push([{ text: '🌐 Channel', url: db.settings.channelUrl }]);
  if (isAdmin(uid)) rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

async function showFreebie(chatId, from) {
  const user = getUser(from);
  if (isBannedUser(from.id)) return sendMessage(chatId, '🚫 Access blocked.', homeButtons(from.id));
  
  if (db.settings.freebieEnabled === false) {
    return sendMessage(chatId, '🎁 <b>Freebies Currently Offline</b>\n\nDaily freebies are temporarily disabled by admin. Please check back later!', homeButtons(from.id));
  }

  const freebieAmount = Number(db.settings.freebieAmount || 5);
  const cooldownHours = Math.max(1, Number(db.settings.freebieCooldownHours || 24));
  const nowTs = Date.now();
  const COOLDOWN_MS = cooldownHours * 60 * 60 * 1000;
  const lastClaim = Number(user.lastFreebieClaim || 0);
  const timePassed = nowTs - lastClaim;

  if (timePassed < COOLDOWN_MS) {
    const remainingMs = COOLDOWN_MS - timePassed;
    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    
    const text = `🎁 <b>Daily Freebie Reward</b>

⏰ <b>Already Claimed Today!</b>

You have already claimed your freebie reward. Come back when the cooldown finishes!

⏳ <b>Next Claim Available In:</b> <code>${hours}h ${mins}m</code>
💰 <b>Current Wallet Balance:</b> <b>${money(user.balance)}</b>
🎁 <b>Total Freebies Claimed:</b> <b>${user.totalFreebiesClaimed || 0} times</b> (${money(user.freebieEarnings || 0)})`;

    return sendMessage(chatId, text, inline([
      [{ text: '🛍 Shop Products', callback_data: 'shop:1' }, { text: '🏠 Main Menu', callback_data: 'home' }]
    ]));
  }

  user.lastFreebieClaim = nowTs;
  user.totalFreebiesClaimed = (Number(user.totalFreebiesClaimed) || 0) + 1;
  user.freebieEarnings = (Number(user.freebieEarnings) || 0) + freebieAmount;
  user.balance = (Number(user.balance) || 0) + freebieAmount;
  saveData();

  const successText = `🎉 <b>Freebie Reward Claimed!</b>
━━━━━━━━━━━━━━━━━━━━

🎁 <b>Freebie Bonus:</b> <b>+${money(freebieAmount)}</b>
👛 <b>New Wallet Balance:</b> <b>${money(user.balance)}</b>
🏆 <b>Total Claims:</b> <b>${user.totalFreebiesClaimed}</b>

You can use your wallet balance to buy any digital product or OTT subscription!

⏰ <b>Next Claim Available:</b> ${cooldownHours} Hours`;

  return sendMessage(chatId, successText, inline([
    [{ text: '🛍 Shop Products', callback_data: 'shop:1' }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]));
}


function shopButtons(page = 1, userId = '') {
  const all = activeProducts();
  const totalPages = Math.max(1, Math.ceil(all.length / SHOP_PAGE_SIZE));
  const safe = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const items = all.slice((safe - 1) * SHOP_PAGE_SIZE, safe * SHOP_PAGE_SIZE);
  const rows = items.map((p) => [styleButton({
    text: styledProductButtonText(p, userId),
    callback_data: `view:${p.code}`,
    ...buttonIconFields(p)
  }, 'success')]);
  rows.push([
    { text: '🗂 Categories', callback_data: 'categories' },
    { text: '↻ Refresh', callback_data: `shop:${safe}` }
  ]);
  rows.push([
    { text: 'Back', callback_data: 'home' }
  ]);
  rows.push([
    { text: safe > 1 ? '↩ Prev' : '·', callback_data: safe > 1 ? `shop:${safe - 1}` : 'noop' },
    { text: `${safe}/${totalPages}`, callback_data: 'noop' },
    { text: safe < totalPages ? 'Next ↪' : '·', callback_data: safe < totalPages ? `shop:${safe + 1}` : 'noop' }
  ]);
  return { safe, totalPages, markup: inline(rows) };
}

function productButtons(p, uid = '') {
  const fav = uid && isWishlisted(uid, p.code);
  if (!p.stock.length) {
    return inline([
      [{ text: '❌ Out of Stock', callback_data: 'noop' }],
      [{ text: '🔔 Notify Me When Restocked', callback_data: `restock:${p.code}` }],
      [{ text: fav ? '⭐ Remove From Wishlist' : '⭐ Add To Wishlist', callback_data: `fav:${p.code}` }],
      [{ text: 'Back to Store', callback_data: 'shop:1' }]
    ]);
  }
  return inline([
    [styleButton({ text: 'Buy Now', callback_data: `buy:${p.code}`, ...buttonIconFields(p) }, 'success')],
    [
      { text: fav ? '⭐ Remove Wishlist' : '⭐ Add Wishlist', callback_data: `fav:${p.code}` },
      { text: '📤 Share', url: `https://t.me/share/url?url=https://t.me/${getBotUsername() || botUsername}?start=buy_${p.code}&text=${encodeURIComponent(p.name + ' available at ' + STORE_NAME)}` }
    ],
    [{ text: 'Back to Store', callback_data: 'shop:1' }]
  ]);
}

function qtyButtons(productCode, maxStock) {
  const nums = [1, 2, 3, 5, 10, 15, 20, 25].filter((n) => n <= maxStock);
  const rows = [];
  for (let i = 0; i < nums.length; i += 4) {
    rows.push(nums.slice(i, i + 4).map((n) => ({ text: String(n), callback_data: `qty:${productCode}:${n}` })));
  }
  rows.push([{ text: '✍️ Custom Amount', callback_data: `qtycustom:${productCode}` }]);
  rows.push([{ text: 'Back', callback_data: `view:${productCode}` }]);
  return inline(rows);
}

function checkoutButtons(productCode, qty) {
  return inline([
    [{ text: '💳 Pay Directly', callback_data: `paymethods:${productCode}:${qty}` }],
    [{ text: '🎟 Apply Coupon', callback_data: 'coupon' }],
    [{ text: 'Cancel', callback_data: 'home' }]
  ]);
}


function paymentVerifyMode() {
  const m = String(db.settings.paymentVerifyMode || 'both').toLowerCase();
  if (m === 'txid') return 'txid';
  if (m === 'auto') return 'auto';
  return 'both';
}

function isTxidVerifyMode() {
  return paymentVerifyMode() === 'txid';
}

function safeDualVerifyEnabled() {
  return paymentVerifyMode() === 'both';
}

function paymentMethodAddress(methodKey) {
  const key = String(methodKey || '').toUpperCase();
  if (key === 'USDT_BEP20') return db.settings.bep20Address || '';
  if (key === 'BEP20') return db.settings.bep20Address || '';
  return '';
}

function paymentMethodNetwork(methodKey) {
  const key = String(methodKey || '').toUpperCase();
  if (key === 'USDT_BEP20') return 'BEP20 / BSC';
  if (key === 'USDT_TRC20') return 'TRC20 / Tron';
  if (key === 'USDT_ERC20') return 'ERC20 / Ethereum';
  if (key === 'USDT_POLYGON') return 'Polygon';
  return '';
}

function verifyModeLine() {
  return '🛡 <b>Safe Binance API Verify</b> — Auto verifies exact Reference Note from Binance API. If note is missing, TXID / Order ID is verified from Binance API.';
}


function paymentMethodButtons(userBalance, total) {
  const rows = [];
  rows.push([{ text: userBalance >= total ? `👛 Pay via Wallet (${money(userBalance)})` : `👛 Pay via Wallet (low: ${money(userBalance)}/${money(total)})`, callback_data: userBalance >= total ? 'paywallet' : 'noop' }]);
  db.paymentMethods.filter((m) => m.active !== false).forEach((m) => {
    rows.push([{ text: `${m.icon || '💳'} ${m.name}`, callback_data: `paymethod:${m.id}` }]);
  });
  rows.push([{ text: 'Back', callback_data: 'checkout_back' }]);
  return inline(rows);
}


function paymentAgeMinutes(p) {
  const t = Date.parse(p?.createdAt || 0);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function paymentExpired(p) {
  const exp = Date.parse(p?.expiresAt || 0);
  return Number.isFinite(exp) && Date.now() > exp;
}


function paymentExpiryMinutes() {
  return Math.max(5, Number(db.settings.paymentExpiryMinutes || 30));
}

function paymentExpiryAt() {
  return new Date(Date.now() + paymentExpiryMinutes() * 60 * 1000).toISOString();
}

function paymentExpiresText(payment) {
  const exp = Date.parse(payment?.expiresAt || 0);
  if (!Number.isFinite(exp)) return `${paymentExpiryMinutes()} minutes`;
  const mins = Math.max(0, Math.ceil((exp - Date.now()) / 60000));
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

function stockWaitLog(type, payment, detail = {}, severity = 'info') {
  try {
    db.stockWaitLogs ||= [];
    db.stockWaitLogs.unshift({
      id: 'SWL' + Date.now() + Math.floor(Math.random() * 999),
      type,
      paymentId: payment?.id || '',
      productCode: payment?.productCode || '',
      telegramId: payment?.telegramId || '',
      detail,
      severity,
      at: now()
    });
    db.stockWaitLogs = db.stockWaitLogs.slice(0, 300);
    saveData();
  } catch (_) {}
}

function stockWaitPayments(productCode = '') {
  const code = String(productCode || '').toUpperCase();
  return (db.payments || []).filter(p => {
    const status = String(p.status || '').toLowerCase();
    if (!['stock_wait', 'stock_issue'].includes(status)) return false;
    if (p.type === 'deposit') return false;
    if (findOrderByPaymentId(p.id)) return false;
    if (code && String(p.productCode || '').toUpperCase() !== code) return false;
    return true;
  }).sort((a,b) => Date.parse(a.verifiedAt || a.stockWaitAt || a.createdAt || 0) - Date.parse(b.verifiedAt || b.stockWaitAt || b.createdAt || 0));
}

function stockWaitText(limit = 20) {
  const list = stockWaitPayments();
  let out = `⏳ <b>Stock Wait Queue</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += `Queued Paid Orders: <b>${list.length}</b>\nAuto Delivery: <b>${db.settings.stockWaitAutoDelivery === false ? 'OFF' : 'ON'}</b>\nPriority First: <b>${db.settings.stockWaitPriorityFirst === false ? 'OFF' : 'ON'}</b>\n\n`;
  if (!list.length) {
    out += '✅ No paid orders waiting for stock.';
    return out;
  }
  list.slice(0, limit).forEach((p, i) => {
    const product = productByCode(p.productCode);
    out += `${i + 1}. <code>${escapeHtml(p.id)}</code>\n`;
    out += `${product ? productLogoHtml(product) + ' ' : ''}<b>${escapeHtml(p.productName || product?.name || '-')}</b>\n`;
    out += `User: <code>${escapeHtml(p.telegramId)}</code> | Qty: <b>${escapeHtml(p.qty || 1)}</b>\n`;
    out += `Paid: <b>${money(p.amount, p.currency)}</b> | Waiting: ${paymentAgeMinutes({ createdAt: p.stockWaitAt || p.verifiedAt || p.createdAt })}m\n\n`;
  });
  return out;
}

function stockWaitButtons() {
  return inline([
    [
      { text: '🔁 Process Queue', callback_data: 'stockwait_process_all' },
      { text: '📜 Logs', callback_data: 'stockwait_logs' }
    ],
    [
      { text: db.settings.stockWaitAutoDelivery === false ? '✅ Auto Delivery ON' : '⛔ Auto Delivery OFF', callback_data: 'stockwait_toggle_auto' },
      { text: '📥 Add Stock', callback_data: 'admin_add_stock' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

async function notifyStockWaitUser(payment, product = null) {
  if (db.settings.stockWaitNotifyUser === false || payment.stockWaitUserNotifiedAt) return false;
  product ||= productByCode(payment.productCode);
  try {
    await sendMessage(payment.telegramId, `✅ <b>Payment Received Successfully</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${product ? productLogoHtml(product) + ' ' : '📦 '}<b>${escapeHtml(payment.productName || product?.name || 'Product')}</b>\n\n💰 Paid: <b>${money(payment.amount, payment.currency)}</b>\n🧮 Quantity: <b>${escapeHtml(payment.qty || 1)}</b>\n🆔 Payment ID: <code>${escapeHtml(payment.id)}</code>\n\n⚠️ <b>Stock is currently finished.</b>\nPlease wait — when we add stock, your order will get <b>instant automatic delivery</b>.\n\nYou do not need to pay again. Your payment is safely saved in queue.`, homeButtons(payment.telegramId));
    payment.stockWaitUserNotifiedAt = now();
    stockWaitLog('user_notified_stock_wait', payment, {}, 'info');
    saveData();
    return true;
  } catch (err) {
    stockWaitLog('user_notify_failed', payment, { error: err.message }, 'warn');
    return false;
  }
}

async function markPaymentStockWait(payment, reason = 'Stock finished after payment verification', opts = {}) {
  if (!payment) return '';
  const product = productByCode(payment.productCode);
  payment.status = 'stock_wait';
  payment.stockWaitAt ||= now();
  payment.lastCheckReason = reason;
  payment.verifiedAt ||= now();
  payment.approvedBy ||= opts.approvedBy || 'auto-stock-wait';
  payment.autoVerifiedBy ||= opts.method || payment.autoVerifiedBy || '';
  stockWaitLog('payment_stock_wait', payment, { reason, qty: payment.qty, available: product?.stock?.length || 0 }, 'warn');
  saveData();
  await notifyStockWaitUser(payment, product);
  try {
    await notifyAllAdmins(`⏳ <b>Paid Order Waiting For Stock</b>\n\nPayment: <code>${escapeHtml(payment.id)}</code>\nUser: <code>${escapeHtml(payment.telegramId)}</code>\nProduct: <b>${escapeHtml(payment.productName || product?.name || '-')}</b>\nQty: <b>${escapeHtml(payment.qty || 1)}</b>\nPaid: <b>${money(payment.amount, payment.currency)}</b>\n\nWhen stock is added, this order will be delivered first.`, stockWaitButtons());
  } catch (_) {}
  return `✅ Payment received but stock is finished. Added to stock wait queue: ${payment.id}`;
}

async function deliverStockWaitPayment(payment, source = 'stock-wait-auto') {
  if (!payment || findOrderByPaymentId(payment.id)) return { ok: false, reason: 'Already delivered or invalid' };
  const product = productByCode(payment.productCode);
  if (!product) return { ok: false, reason: 'Product not found' };
  const qty = Number(payment.qty || 1);
  if ((product.stock || []).length < qty) return { ok: false, reason: `Need ${qty}, available ${(product.stock || []).length}` };

  const items = deliverStock(product, qty);
  if (payment.couponCode) {
    const c = findCoupon(payment.couponCode);
    if (c) c.uses = Number(c.uses || 0) + 1;
  }

  const orderId = 'O' + Date.now() + Math.floor(Math.random() * 99);
  const order = {
    id: orderId,
    telegramId: String(payment.telegramId),
    productCode: product.code,
    productName: product.name,
    qty,
    total: Number(payment.amount || 0),
    unitPrice: Number(payment.unitPrice || 0),
    subtotal: Number(payment.subtotal || payment.amount || 0),
    discount: Number(payment.discount || 0),
    couponCode: payment.couponCode || '',
    currency: payment.currency || product.currency || currency(),
    method: payment.methodName || source,
    deliveredItems: items,
    status: 'paid',
    deliveryStatus: 'created',
    deliveryAttempts: 0,
    paymentId: payment.id,
    stockWaitFulfilled: true,
    createdAt: now()
  };
  db.orders.push(order);
  const earnedPoints = addLoyaltyPointsForOrder(order);
  payment.status = 'approved';
  payment.verifiedAt ||= now();
  payment.approvedBy ||= source;
  payment.stockWaitDeliveredAt = now();
  saveData();

  try {
    await sendMessage(payment.telegramId, `🎉 <b>Stock Added — Your Order Is Ready!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b>\n\n✅ Your payment was already received.\n🚚 Stock is available now, sending your instant delivery below...`);
  } catch (_) {}

  await sendDeliveryMessage(payment.telegramId, product.name, qty, Number(payment.amount || 0), payment.currency || product.currency || currency(), items, orderId, product.code);
  stockWaitLog('stock_wait_delivered', payment, { orderId, source, points: earnedPoints }, 'info');
  try { await notifyPublicPurchase(order, product); } catch (_) {}
  return { ok: true, orderId };
}

async function processStockWaitQueue(productCode = '', source = 'stock-added') {
  if (db.settings.stockWaitAutoDelivery === false && source !== 'manual') return { ok: 0, fail: 0, skipped: 0, logs: [] };
  const queue = stockWaitPayments(productCode);
  let ok = 0, fail = 0, skipped = 0;
  const logs = [];
  for (const p of queue) {
    const product = productByCode(p.productCode);
    const qty = Number(p.qty || 1);
    if (!product || (product.stock || []).length < qty) {
      skipped++;
      logs.push(`${p.id}: waiting (${product?.stock?.length || 0}/${qty})`);
      continue;
    }
    try {
      const result = await deliverStockWaitPayment(p, source);
      if (result.ok) {
        ok++;
        logs.push(`${p.id}: delivered ${result.orderId}`);
      } else {
        skipped++;
        logs.push(`${p.id}: ${result.reason}`);
      }
    } catch (err) {
      fail++;
      p.lastCheckReason = `Stock wait delivery failed: ${err.message}`;
      stockWaitLog('stock_wait_delivery_failed', p, { error: err.message }, 'error');
      logs.push(`${p.id}: failed ${err.message}`);
      saveData();
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok, fail, skipped, logs };
}

async function expirePendingPaymentsAndNotify(minutes = paymentExpiryMinutes()) {
  let count = 0, notified = 0;
  for (const p of (db.payments || [])) {
    const status = String(p.status || '').toLowerCase();
    if (!['pending', 'review'].includes(status)) continue;
    if (p.type === 'deposit') continue;
    if (findOrderByPaymentId(p.id)) continue;
    const expired = paymentExpired(p) || paymentAgeMinutes(p) >= minutes;
    if (!expired) continue;

    p.status = 'expired';
    p.expiredAt = now();
    p.lastCheckReason = `Payment invoice expired after ${minutes} minutes`;
    count++;
    stockWaitLog('payment_expired', p, { minutes }, 'warn');

    if (db.settings.pendingExpiryNotifyUser !== false && !p.expiryUserNotifiedAt) {
      try {
        await sendMessage(p.telegramId, `⌛ <b>Payment Invoice Expired</b>\n━━━━━━━━━━━━━━━━━━━━\n\n📦 Product: <b>${escapeHtml(p.productName || 'Product')}</b>\n💰 Amount: <b>${money(p.amount, p.currency)}</b>\n🆔 Payment ID: <code>${escapeHtml(p.id)}</code>\n\nThis pending payment was valid for <b>${minutes} minutes</b> and has now expired.\n\nIf you already paid, contact support with payment screenshot/TXID. Otherwise, please create a new order from the bot.`, homeButtons(p.telegramId));
        p.expiryUserNotifiedAt = now();
        notified++;
      } catch (err) {
        p.expiryNotifyError = err.message;
      }
    }
  }
  if (count) saveData();
  return { count, notified };
}


function paymentRiskSummary() {
  const pending = (db.payments || []).filter(p => p.status === 'pending' || p.status === 'review');
  const expired = pending.filter(paymentExpired);
  const needsTxid = pending.filter(p => String(p.lastCheckReason || '').toLowerCase().includes('note') || String(p.lastCheckReason || '').toLowerCase().includes('txid'));
  const old = pending.filter(p => paymentAgeMinutes(p) >= 30);
  const byAmount = {};
  pending.forEach(p => {
    const key = `${p.currency || currency()}_${Number(p.amount || 0).toFixed(4)}`;
    byAmount[key] ||= [];
    byAmount[key].push(p);
  });
  const duplicateAmounts = Object.values(byAmount).filter(list => list.length > 1);
  const approvedRefs = {};
  (db.payments || []).filter(p => p.status === 'approved' && p.submittedReference).forEach(p => {
    const k = String(p.submittedReference || '').toLowerCase();
    approvedRefs[k] ||= [];
    approvedRefs[k].push(p);
  });
  const duplicateRefs = Object.values(approvedRefs).filter(list => list.length > 1);
  return { pending, expired, needsTxid, old, duplicateAmounts, duplicateRefs };
}

function riskCenterText(limit = 10) {
  const r = paymentRiskSummary();
  let out = `🚨 <b>Payment Risk Center</b>\n\n`;
  out += `⏳ Pending/Review: <b>${r.pending.length}</b>\n`;
  out += `🧾 Need TXID/Note: <b>${r.needsTxid.length}</b>\n`;
  out += `⌛ Old Pending 30m+: <b>${r.old.length}</b>\n`;
  out += `⛔ Expired: <b>${r.expired.length}</b>\n`;
  out += `⚠️ Same Amount Groups: <b>${r.duplicateAmounts.length}</b>\n`;
  out += `🔁 Duplicate Approved TXID: <b>${r.duplicateRefs.length}</b>\n\n`;

  const list = [...new Map([...r.needsTxid, ...r.old, ...r.expired, ...r.pending].map(p => [p.id, p])).values()].slice(0, limit);
  if (list.length) {
    out += `<b>Priority Payments:</b>\n`;
    list.forEach((p, i) => {
      out += `${i + 1}. <code>${escapeHtml(p.id)}</code> | ${escapeHtml(p.type || 'payment')}\n`;
      out += `User: <code>${escapeHtml(p.telegramId)}</code> | ${money(p.amount, p.currency)} | Age: ${paymentAgeMinutes(p)}m\n`;
      out += `Reason: ${escapeHtml(short(p.lastCheckReason || '-', 100))}\n\n`;
    });
  } else out += '✅ No risky pending payments found.';
  return out;
}

function riskCenterButtons() {
  return inline([
    [
      { text: '▶️ Run Safe Scan', callback_data: 'risk_scan_now' },
      { text: '🧹 Expire Old', callback_data: 'risk_expire_old' }
    ],
    [
      { text: '⏳ Pending', callback_data: 'admin_pending:1' },
      { text: '💳 Payments', callback_data: 'admin_payments' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function expireOldPendingPayments(minutes = paymentExpiryMinutes()) {
  let count = 0;
  for (const p of (db.payments || [])) {
    if ((p.status === 'pending' || p.status === 'review') && paymentAgeMinutes(p) >= minutes) {
      p.status = 'expired';
      p.expiredAt = now();
      p.lastCheckReason = `Expired automatically after ${minutes} minutes`;
      count++;
      try { if (db.settings.pendingExpiryNotifyUser !== false && !p.expiryUserNotifiedAt) { sendMessage(p.telegramId, `⌛ <b>Payment Invoice Expired</b>\n\nPayment ID: <code>${escapeHtml(p.id)}</code>\nProduct: <b>${escapeHtml(p.productName || 'Product')}</b>\nAmount: <b>${money(p.amount, p.currency)}</b>\n\nThis payment was valid for <b>${minutes} minutes</b>. Create a new order or contact support if already paid.`, homeButtons(p.telegramId)); p.expiryUserNotifiedAt = now(); } } catch (_) {}
    }
  }
  if (count) saveData();
  return count;
}

function quickFind(ref = '') {
  const q = String(ref || '').trim();
  if (!q) return { type: 'none' };
  const low = q.toLowerCase().replace('@', '');

  const order = (db.orders || []).find(o =>
    String(o.id || '').toLowerCase() === low ||
    String(o.paymentId || '').toLowerCase() === low
  );
  if (order) return { type: 'order', item: order };

  const payment = (db.payments || []).find(p =>
    String(p.id || '').toLowerCase() === low ||
    String(p.submittedReference || '').toLowerCase() === low ||
    String(p.note || '').toLowerCase() === low
  );
  if (payment) return { type: 'payment', item: payment };

  const user = Object.values(db.users || {}).find(u =>
    String(u.telegramId || '') === q ||
    String(u.username || '').toLowerCase() === low ||
    String(u.firstName || '').toLowerCase().includes(low)
  );
  if (user) return { type: 'user', item: user };

  const product = (db.products || []).find(p =>
    String(p.code || '').toLowerCase() === low ||
    String(p.name || '').toLowerCase().includes(low)
  );
  if (product) return { type: 'product', item: product };

  return { type: 'none' };
}

function quickFindText(ref = '') {
  const f = quickFind(ref);
  if (f.type === 'none') return `🔎 <b>Quick Find</b>\n\nNo result found for: <code>${escapeHtml(ref)}</code>`;

  if (f.type === 'order') {
    const o = f.item;
    const u = db.users[String(o.telegramId)] || {};
    return `🧾 <b>Order Found</b>\n\nOrder: <code>${escapeHtml(o.id)}</code>\nPayment: <code>${escapeHtml(o.paymentId || '-')}</code>\nUser: <b>${escapeHtml(u.firstName || 'User')}</b> ${u.username ? '@' + escapeHtml(u.username) : ''}\nUser ID: <code>${escapeHtml(o.telegramId)}</code>\nProduct: <b>${escapeHtml(o.productName)}</b>\nQty: <b>${escapeHtml(o.qty)}</b>\nTotal: <b>${money(o.total, o.currency)}</b>\nStatus: <b>${escapeHtml(orderStatusLabel(o))}</b>\nDate: ${escapeHtml(new Date(o.createdAt).toLocaleString())}`;
  }

  if (f.type === 'payment') {
    const p = f.item;
    return `💳 <b>Payment Found</b>\n\nID: <code>${escapeHtml(p.id)}</code>\nType: <b>${escapeHtml(p.type || 'payment')}</b>\nStatus: <b>${escapeHtml(String(p.status || '').toUpperCase())}</b>\nUser: <code>${escapeHtml(p.telegramId)}</code>\nProduct: <b>${escapeHtml(p.productName || 'Wallet Deposit')}</b>\nAmount: <b>${money(p.amount, p.currency)}</b>\nMethod: ${escapeHtml(p.methodName || '-')}\nNote: <code>${escapeHtml(p.note || '-')}</code>\nTXID/Ref: <code>${escapeHtml(p.submittedReference || '-')}</code>\nLast Check: ${escapeHtml(p.lastCheckReason || '-')}`;
  }

  if (f.type === 'user') {
    const u = f.item;
    const stats = user360Stats(u.telegramId);
    return `👤 <b>User Found</b>\n\nName: <b>${escapeHtml(u.firstName || 'User')}</b>\nUsername: ${u.username ? '@' + escapeHtml(u.username) : '-'}\nID: <code>${escapeHtml(u.telegramId)}</code>\nWallet: <b>${money(u.balance || 0)}</b>\nOrders: <b>${stats.orders.length}</b>\nSpent: <b>${money(stats.spent)}</b>\nStatus: <b>${u.banned ? 'Banned' : 'Active'}</b>\nNotifications: <b>${u.notifications === false ? 'OFF' : 'ON'}</b>`;
  }

  const p = f.item;
  return `📦 <b>Product Found</b>\n\nCode: <code>${escapeHtml(p.code)}</code>\nName: <b>${escapeHtml(p.name)}</b>\nPrice: <b>${money(p.price, p.currency || currency())}</b>\nStock: <b>${(p.stock || []).length}</b>\nCategory: <b>${escapeHtml(cleanCategory(p.category || 'General'))}</b>\nStatus: <b>${p.active === false ? 'Hidden' : 'Active'}</b>`;
}

function quickFindButtons(ref = '') {
  const f = quickFind(ref);
  if (f.type === 'order') return inline([[{ text: '🧾 Open Order', callback_data: `admin_order_view:${f.item.id}` }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]);
  if (f.type === 'payment') return inline([[{ text: '🚀 Force Deliver/Approve', callback_data: `payforce:${f.item.id}` }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]);
  if (f.type === 'user') return inline([[{ text: '👤 User Orders', callback_data: `user_orders:${f.item.telegramId}` }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]);
  if (f.type === 'product') return inline([[{ text: '📦 Manage Product', callback_data: `admin_product:${f.item.code}` }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]);
  return adminButtons();
}

function saleTemplateText(productName = 'Gemini Pro 18 Months', oldPrice = '$1.8', newPrice = '$1', stock = '8') {
  return `${productName} Price Dropped\nOld Price: ${oldPrice}\nNew Price: ${newPrice}\nOnly ${stock} stock left\nGrab fast from bot`;
}

function maintenanceTemplateText(reason = 'new updates and improvements') {
  return `Bot under maintenance\nReason: ${reason}\nWe are improving speed, stability and features\nPlease wait, bot will be back soon`;
}


function paymentStatusButtons(paymentId) {
  return inline([
    [{ text: '✅ Auto Verify First', callback_data: `paystatus:${paymentId}` }],
    [{ text: 'Cancel Payment', callback_data: `cancelpay:${paymentId}` }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]);
}

function paymentFallbackButtons(paymentId) {
  return inline([
    [{ text: '🧾 Submit TXID / Order ID', callback_data: `submit:${paymentId}` }],
    [{ text: '🔁 Try Auto Verify Again', callback_data: `paystatus:${paymentId}` }],
    [{ text: 'Cancel Payment', callback_data: `cancelpay:${paymentId}` }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]);
}


function depositAmountButtons() {
  return inline([
    [
      { text: '$5', callback_data: 'depamt:5' },
      { text: '$10', callback_data: 'depamt:10' },
      { text: '$20', callback_data: 'depamt:20' }
    ],
    [
      { text: '$50', callback_data: 'depamt:50' },
      { text: '$100', callback_data: 'depamt:100' },
      { text: '$200', callback_data: 'depamt:200' }
    ],
    [{ text: '✍️ Custom Amount', callback_data: 'depcustom' }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]);
}

function depositMethodButtons(amount) {
  const rows = [];
  db.paymentMethods.filter((m) => m.active !== false).forEach((m) => {
    rows.push([{ text: `${m.icon || '💳'} ${m.name}`, callback_data: `depmethod:${amount}:${m.id}` }]);
  });
  rows.push([{ text: '⬅️ Change Amount', callback_data: 'deposit' }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return inline(rows);
}

function adminButtons() {
  return inline([
    [
      { text: '🧰 Easy Manage', callback_data: 'admin_easy_manage' },
      { text: '🛠 Product Manager', callback_data: 'admin_products:1' }
    ],
    [
      { text: '➕ Add Product', callback_data: 'admin_add_product' },
      { text: '📝 Notes/Tasks', callback_data: 'manage_notes' }
    ],
    [
      { text: '📥 Add Stock', callback_data: 'admin_add_stock' },
      { text: '♻️ Hidden/Restore', callback_data: 'admin_hidden:1' }
    ],
    [
      { text: '💰 Balance', callback_data: 'admin_balance' },
      { text: '👥 Users', callback_data: 'admin_users:1' }
    ],
    [
      { text: '🧾 Orders', callback_data: 'admin_orders:1' },
      { text: '⏳ Pending', callback_data: 'admin_pending:1' }
    ],
    [
      { text: '🚑 Repair Delivery', callback_data: 'admin_repair_delivery' },
      { text: '🚨 Payment Risk', callback_data: 'admin_payment_risk' }
    ],
    [
      { text: '💳 Recent Payments', callback_data: 'admin_payments' },
      { text: '🔎 Quick Find', callback_data: 'admin_quick_find' }
    ],
    [
      { text: '🤖 Auto Verify', callback_data: 'admin_auto_verify' },
      { text: '🔍 Binance Test', callback_data: 'admin_binance_test' }
    ],
    [
      { text: '📊 Store Stats', callback_data: 'admin_stats' },
      { text: '🧾 Today Summary', callback_data: 'admin_today_summary' }
    ],
    [
      { text: '⚠️ Low Stock', callback_data: 'admin_low_stock' },
      { text: '🏷 Inventory Value', callback_data: 'admin_inventory_value' }
    ],
    [
      { text: '✨ AI Description', callback_data: 'admin_desc_generator' },
      { text: '📈 Reports', callback_data: 'admin_stats' }
    ],
    [
      { text: '🎫 Tickets', callback_data: 'admin_tickets' },
      { text: '🚚 Manual Delivery', callback_data: 'admin_manual_order' }
    ],
    [
      { text: '⚡ Flash Sale', callback_data: 'admin_flash_sale' },
      { text: '📣 Campaign Center', callback_data: 'admin_campaign_center' }
    ],
    [
      { text: '🧰 Bulk Product Tools', callback_data: 'admin_bulk_tools' },
      { text: '📈 Profit Report', callback_data: 'admin_profit_report' }
    ],
    [
      { text: '🔔 Restock Requests', callback_data: 'admin_restock_requests' },
      { text: '👑 Top Buyers', callback_data: 'admin_top_buyers' }
    ],
    [
      { text: '⭐ Reviews', callback_data: 'admin_reviews' },
      { text: '📣 Marketing Kit', callback_data: 'admin_marketing_kit' }
    ],
    [
      { text: '💳 Pay Methods', callback_data: 'admin_methods' },
      { text: '🔐 Binance API', callback_data: 'admin_binance' }
    ],
    [
      { text: '⚙️ Bot Settings', callback_data: 'admin_bot_settings' },
      { text: '💵 Currency', callback_data: 'admin_currency' }
    ],
    [
      { text: '🎟 Coupons', callback_data: 'admin_coupons' },
      { text: '🛠 Maintenance', callback_data: 'admin_maintenance' }
    ],
    [
      { text: '📣 Announcement', callback_data: 'admin_announcement' },
      { text: '📢 Channels', callback_data: 'admin_channels' }
    ],
    [
      { text: '🔗 Bot Username', callback_data: 'admin_bot_username' },
      { text: '🧪 Test Channel', callback_data: 'test_channel_send' }
    ],
    [
      { text: '🔔 Stock Alert', callback_data: 'admin_stock_alert' },
      { text: '🆕 New Stock Alert', callback_data: 'admin_new_stock_alert' }
    ],
    [
      { text: '👑 Admin Manager', callback_data: 'admin_manager' },
      { text: '💳 Payment Mode', callback_data: 'admin_payment_mode' }
    ],
    [
      { text: '🧰 Admin Tools', callback_data: 'admin_tools' },
      { text: '🎨 Premium Alerts', callback_data: 'admin_alert_preview' }
    ],
    [
      { text: '🛡 Security Center', callback_data: 'admin_security_center' },
      { text: '💾 Backup Center', callback_data: 'admin_backup_center' }
    ],
    [
      { text: '📜 Admin Logs', callback_data: 'adm_logs' },
      { text: '📊 7D Summary', callback_data: 'admin_summary_7d' }
    ],
    [
      { text: '🧪 App/Web Check', callback_data: 'admin_diag' },
      { text: '🧾 Feature Map', callback_data: 'admin_feature_map' }
    ],
    [
      { text: '👥 Group Alerts', callback_data: 'admin_groups' },
      { text: '⌨️ Keyword Test', callback_data: 'admin_keyword_test' }
    ],
    [
      { text: '🧾 Admin Help', callback_data: 'admin_help' },
      { text: '🔐 Security Logs', callback_data: 'security_logs' }
    ],
    [
      { text: '🛠 Maint. Template', callback_data: 'announce_template_maint' },
      { text: '💸 Sale Template', callback_data: 'announce_template_sale' }
    ],
    [
      { text: '✍️ Custom Premium Msg', callback_data: 'admin_custom_announce' },
      { text: '🎯 Product Logos', callback_data: 'admin_logo_help' }
    ],
    [
      { text: '🧩 Custom Emoji IDs', callback_data: 'admin_custom_emoji_help' },
      { text: '🧾 Brand Codes', callback_data: 'admin_brand_codes' }
    ],
    [
      { text: '🏠 User Menu', callback_data: 'home' }
    ]
  ]);
}


function productManagerButtons(product) {
  const p = product;
  return inline([
    [
      { text: '✏️ Name', callback_data: `editfield:${p.code}:name` },
      { text: '💵 Price', callback_data: `editfield:${p.code}:price` }
    ],
    [
      { text: '📝 Description', callback_data: `editfield:${p.code}:description` },
      { text: '✨ Gen Desc', callback_data: `gen_desc:${p.code}` }
    ],
    [
      { text: '🚚 Delivery Msg', callback_data: `delivery_msg:${p.code}` },
      { text: '👀 Delivery Preview', callback_data: `delivery_preview:${p.code}` }
    ],
    [
      { text: '🌐 Access Info', callback_data: `access_info:${p.code}` },
      { text: '😀 Emoji', callback_data: `editfield:${p.code}:emoji` }
    ],
    [
      { text: '📥 Add Stock', callback_data: `admin_product_stock:${p.code}` },
      { text: '📋 View Stock', callback_data: `view_stock:${p.code}` }
    ],
    [
      { text: '🖼 Logo', callback_data: `admin_product_logo:${p.code}` },
      { text: p.pinned ? '📌 Unpin' : '📌 Pin', callback_data: `admin_product_pin:${p.code}` }
    ],
    [
      { text: '💎 Special Price', callback_data: `special_price:${p.code}` },
      { text: '📦 Bulk Pricing', callback_data: `bulk_price:${p.code}` }
    ],
    [
      { text: '📢 Send Stock Alert', callback_data: `product_alert:${p.code}` },
      { text: '👀 Stock Preview', callback_data: `stock_alert_preview:${p.code}` }
    ],
    [
      { text: '⚡ Flash Preview', callback_data: `flash_alert_preview:${p.code}` },
      { text: '⌨️ Reply Preview', callback_data: `group_reply_preview:${p.code}` }
    ],
    [
      { text: '🔎 Keywords', callback_data: `editfield:${p.code}:groupKeywords` },
      { text: '📋 Bulk List', callback_data: `bulk_list:${p.code}` }
    ],
    [
      { text: '📄 Duplicate', callback_data: `duplicate_product:${p.code}` },
      { text: '👥 View Specials', callback_data: `special_list:${p.code}` }
    ],
    [
      { text: '🗑 Hide', callback_data: `admin_product_hide:${p.code}` },
      { text: '🔥 Delete Forever', callback_data: `confirm_delete:${p.code}` }
    ],
    [
      { text: '⬅️ Products', callback_data: 'admin_products:1' },
      { text: '⚙️ Admin Panel', callback_data: 'admin' }
    ]
  ]);
}

function deleteConfirmButtons(code) {
  return inline([
    [{ text: '🔥 Yes, Delete Forever', callback_data: `delete_yes:${code}` }],
    [{ text: '❌ Cancel', callback_data: `admin_product:${code}` }]
  ]);
}

function restoreProductButtons(code) {
  return inline([
    [{ text: '♻️ Restore Product', callback_data: `restore_product:${code}` }],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function adminBackButtons() {
  return inline([[{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]);
}

function balanceActionButtons(userId) {
  return inline([
    [
      { text: '➕ Add Balance', callback_data: `bal_add:${userId}` },
      { text: '➖ Deduct Balance', callback_data: `bal_deduct:${userId}` }
    ],
    [
      { text: '🧾 User Orders', callback_data: `user_orders:${userId}` },
      { text: '⏳ User Payments', callback_data: `user_payments:${userId}` }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function paymentAdminButtons(paymentId) {
  return inline([
    [
      { text: '✅ Approve + Deliver', callback_data: `payapprove:${paymentId}` },
      { text: '🚀 Force Deliver', callback_data: `payforce:${paymentId}` }
    ],
    [
      { text: '🔁 Resend Delivery', callback_data: `payresend:${paymentId}` },
      { text: '❌ Reject', callback_data: `payreject:${paymentId}` }
    ],
    [
      { text: '🧾 Payment Detail', callback_data: `paydetail:${paymentId}` },
      { text: '⚙️ Admin Panel', callback_data: 'admin' }
    ]
  ]);
}

function nextPaymentMethodId() {
  const max = db.paymentMethods.reduce((m, x) => Math.max(m, Number(String(x.id || '').replace(/\D/g, '')) || 0), 0);
  return 'PM' + String(max + 1).padStart(3, '0');
}

function paymentMethodAdminButtons() {
  const rows = db.paymentMethods.map((m) => [{
    text: `${m.active === false ? '🔴 OFF' : '🟢 ON'} ${m.icon || '💳'} ${m.name}`,
    callback_data: `paymethod_manage:${m.id}`
  }]);
  rows.push([
    { text: '➕ Add Method', callback_data: 'paymethod_add' },
    { text: '🧪 Test Binance', callback_data: 'test_binance' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

function paymentMethodManageButtons(method) {
  return inline([
    [
      { text: method.active === false ? '🟢 Enable' : '🔴 Disable', callback_data: `pm_toggle:${method.id}` },
      { text: '✏️ Name', callback_data: `pm_edit:${method.id}:name` }
    ],
    [
      { text: '😀 Icon', callback_data: `pm_edit:${method.id}:icon` },
      { text: '🔑 Key', callback_data: `pm_edit:${method.id}:key` }
    ],
    [
      { text: '📝 Details', callback_data: `pm_edit:${method.id}:details` },
      { text: '🧪 Test', callback_data: `pm_test:${method.id}` }
    ],
    [
      { text: '🗑 Delete', callback_data: `pm_delete_confirm:${method.id}` },
      { text: '⬅️ Methods', callback_data: 'admin_methods' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function paymentMethodDeleteButtons(methodId) {
  return inline([
    [{ text: '🔥 Yes, Delete Method', callback_data: `pm_delete_yes:${methodId}` }],
    [{ text: '❌ Cancel', callback_data: `paymethod_manage:${methodId}` }]
  ]);
}

function binanceAdminButtons() {
  return inline([
    [
      { text: '🆔 Set UID', callback_data: 'set_binance_id' },
      { text: '🏷 Set Name', callback_data: 'set_binance_name' }
    ],
    [
      { text: '🪙 Set Coin', callback_data: 'set_binance_coin' },
      { text: '🌐 Base URL', callback_data: 'set_binance_base' }
    ],
    [
      { text: '🔑 API Key', callback_data: 'set_binance_api' },
      { text: '🔐 Secret Key', callback_data: 'set_binance_secret' }
    ],
    [
      { text: '📅 Lookback Days', callback_data: 'set_binance_lookback' },
      { text: '🎯 Tolerance', callback_data: 'set_binance_tolerance' }
    ],
    [
      { text: '🧩 Partial TXID ON/OFF', callback_data: 'toggle_binance_partial' },
      { text: '🧪 Test API', callback_data: 'test_binance' }
    ],
    [
      { text: '📋 Recent Deposits', callback_data: 'binance_recent_deposits' },
      { text: '🧹 Clear API Keys', callback_data: 'clear_binance_api_confirm' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function clearBinanceConfirmButtons() {
  return inline([
    [{ text: '🧹 Yes, Clear API Keys', callback_data: 'clear_binance_api_yes' }],
    [{ text: '❌ Cancel', callback_data: 'admin_binance' }]
  ]);
}

function cancelAdminButtons() {

  return inline([[{ text: '❌ Cancel', callback_data: 'admin' }]]);
}


// =====================
// CHAT CLEANUP + USER TOOLS
// =====================
function trackBotMessage(chatId, messageId) {
  try {
    const key = String(chatId);
    db.chatMessages ||= {};
    db.chatMessages[key] ||= [];
    db.chatMessages[key].push(Number(messageId));
    db.chatMessages[key] = [...new Set(db.chatMessages[key])].slice(-80);
    saveData();
  } catch (_) {}
}

async function sendTrackedMessage(chatId, text, replyMarkup) {
  const msg = await sendMessage(chatId, text, replyMarkup);
  if (msg?.message_id) trackBotMessage(chatId, msg.message_id);
  return msg;
}

async function sendTrackedPhoto(chatId, fileId, caption, replyMarkup) {
  const msg = await sendPhoto(chatId, fileId, caption, replyMarkup);
  if (msg?.message_id) trackBotMessage(chatId, msg.message_id);
  return msg;
}

async function clearTrackedChat(chatId, currentMessageId) {
  let deleted = 0;
  const key = String(chatId);
  const ids = [...new Set([...(db.chatMessages?.[key] || []), currentMessageId].filter(Boolean))];
  for (const id of ids.reverse()) {
    try {
      await deleteMessage(chatId, id);
      deleted++;
      await new Promise((r) => setTimeout(r, 35));
    } catch (_) {}
  }
  if (db.chatMessages) db.chatMessages[key] = [];
  saveData();
  return deleted;
}


function wishlistOf(uid) {
  db.wishlists ||= {};
  db.wishlists[String(uid)] ||= [];
  return db.wishlists[String(uid)];
}

function isWishlisted(uid, code) {
  return wishlistOf(uid).includes(String(code).toUpperCase());
}

function toggleWishlist(uid, code) {
  const list = wishlistOf(uid);
  code = String(code).toUpperCase();
  const idx = list.indexOf(code);
  if (idx >= 0) {
    list.splice(idx, 1);
    saveData();
    return false;
  }
  list.push(code);
  saveData();
  return true;
}

function activeRestockRequest(uid, code) {
  return (db.restockRequests || []).find(r => r.telegramId === String(uid) && r.productCode === String(code).toUpperCase() && r.status === 'open');
}

function createRestockRequest(from, code) {
  db.restockRequests ||= [];
  const p = productByCode(code);
  if (!p) throw new Error('Product not found');
  const existing = activeRestockRequest(from.id, p.code);
  if (existing) return { request: existing, created: false };
  const req = {
    id: 'RST' + Date.now() + Math.floor(Math.random() * 999),
    telegramId: String(from.id),
    firstName: from.first_name || db.users?.[String(from.id)]?.firstName || 'User',
    username: from.username || db.users?.[String(from.id)]?.username || '',
    productCode: p.code,
    productName: p.name,
    status: 'open',
    createdAt: now(),
    notifiedAt: ''
  };
  db.restockRequests.unshift(req);
  saveData();
  return { request: req, created: true };
}

async function notifyRestockRequesters(product) {
  const requests = (db.restockRequests || []).filter(r => r.productCode === product.code && r.status === 'open');
  if (!requests.length || !product.stock?.length) return 0;
  let sent = 0;
  const markup = inline([
    [{ text: `🛒 Buy Now - ${money(product.price, product.currency || currency())}`, callback_data: `view:${product.code}` }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]);
  for (const r of requests) {
    try {
      await sendMessage(r.telegramId, `🔔 <b>Restock Alert</b>\n\n${product.emoji || '📦'} <b>${escapeHtml(product.name)}</b> is back in stock!\n\n📦 Available: <b>${product.stock.length}</b>\n💰 Price: <b>${money(getProductPrice(product, r.telegramId), product.currency || currency())}</b>\n\nTap below to buy before it sells out.`, markup);
      r.status = 'notified';
      r.notifiedAt = now();
      sent++;
      await new Promise(res => setTimeout(res, 120));
    } catch (_) {}
  }
  if (sent) saveData();
  return sent;
}

function customerInsights() {
  const users = Object.values(db.users || {});
  const orderCounts = {};
  const spent = {};
  for (const o of db.orders || []) {
    const uid = String(o.telegramId);
    orderCounts[uid] = (orderCounts[uid] || 0) + 1;
    spent[uid] = (spent[uid] || 0) + Number(o.total || 0);
  }
  const topBuyers = users.filter(u => orderCounts[String(u.telegramId)]).sort((a,b) => (spent[String(b.telegramId)] || 0) - (spent[String(a.telegramId)] || 0)).slice(0, 10);
  const walletUsers = users.filter(u => Number(u.balance || 0) > 0).sort((a,b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 10);
  const nonBuyers = users.filter(u => !orderCounts[String(u.telegramId)]).slice(0, 20);
  return { topBuyers, walletUsers, nonBuyers, orderCounts, spent };
}

async function maybeSendPaymentReminder(payment) {
  const mins = Number(db.settings.paymentReminderMinutes || 3);
  if (!mins || mins < 1) return;
  if (payment.reminderSentAt) return;
  const created = Date.parse(payment.createdAt || now());
  if (!Number.isFinite(created) || Date.now() - created < mins * 60 * 1000) return;
  try {
    await sendMessage(payment.telegramId, `⏳ <b>Payment Reminder</b>\n\n${payment.type === 'deposit' ? 'Wallet Deposit' : escapeHtml(payment.productName)}\nAmount: <b>${money(payment.amount, payment.currency)}</b>\n\nIf you paid with the exact Reference Note, tap Auto Verify. If not, submit TXID / Hash.`, paymentStatusButtons(payment.id));
    payment.reminderSentAt = now();
    saveData();
  } catch (_) {}
}


function userToolsButtons(uid) {
  const rows = [
    [
      { text: '📊 Account Summary', callback_data: 'profile' },
      { text: '📦 My Orders', callback_data: 'orders' }
    ],
    [
      { text: '💳 My Payments', callback_data: 'user_payments_list' },
      { text: '💰 Wallet History', callback_data: 'wallet_history' }
    ],
    [
      { text: '🎁 Referral Link', callback_data: 'refer_user' },
      { text: '📊 Profile', callback_data: 'profile' }
    ],
    [
      { text: '🔎 Search Product', callback_data: 'search_product' },
      { text: '🔔 Notifications', callback_data: 'toggle_notifications' }
    ],
    [
      { text: '🔥 Top Deals', callback_data: 'user_top_deals' },
      { text: '🏆 Best Sellers', callback_data: 'user_best_sellers' }
    ],
    [
      { text: '🗂 Categories', callback_data: 'categories' },
      { text: '📦 All Products', callback_data: 'shop:1' }
    ],
    [
      { text: '⭐ My Wishlist', callback_data: 'wishlist' },
      { text: '🔔 Restock Requests', callback_data: 'my_restock_requests' }
    ],
    [
      { text: '⭐ My Reviews', callback_data: 'my_reviews' },
      { text: '🛡 Replacement Help', callback_data: 'replacement_help' }
    ],
    [
      { text: '❓ FAQ', callback_data: 'user_faq' },
      { text: '🎫 Support Ticket', callback_data: 'support_ticket' }
    ],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ];
  return inline(rows);
}

function userPaymentStatusLabel(p) {
  if (p.status === 'approved') return '✅ APPROVED';
  if (p.status === 'rejected') return '❌ REJECTED';
  if (p.status === 'cancelled') return '🚫 CANCELLED';
  return '⏳ PENDING';
}



async function showCategories(chatId, from) {
  const cats = productCategories(false);
  if (!cats.length) return sendTrackedMessage(chatId, '🗂 <b>Categories</b>\n\nNo categories found.', userToolsButtons(from.id));
  const rows = cats.map((cat, i) => {
    const count = productsByCategory(cat).length;
    return [{ text: `🗂 ${cat} (${count})`, callback_data: `cat:${i}:1` }];
  });
  rows.push([{ text: '🛍 All Products', callback_data: 'shop:1' }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return sendTrackedMessage(chatId, '🗂 <b>Product Categories</b>\n\nChoose category to browse products:', inline(rows));
}

async function showCategoryProducts(chatId, from, categoryIndex = 0, page = 1) {
  const cat = categoryIndexToName(categoryIndex);
  const all = productsByCategory(cat);
  const pageSize = SHOP_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const items = all.slice((safe - 1) * pageSize, safe * pageSize);
  const rows = items.map(p => [styleButton({
    text: styledProductButtonText(p, from.id),
    callback_data: `view:${p.code}`,
    ...buttonIconFields(p)
  }, 'success')]);
  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `cat:${categoryIndex}:${safe - 1}` : 'noop' },
    { text: `${safe}/${totalPages}`, callback_data: 'noop' },
    { text: safe < totalPages ? 'Next ➡️' : '·', callback_data: safe < totalPages ? `cat:${categoryIndex}:${safe + 1}` : 'noop' }
  ]);
  rows.push([{ text: '🗂 Categories', callback_data: 'categories' }, { text: '🏠 Home', callback_data: 'home' }]);
  const stock = all.reduce((a,p)=>a+(p.stock?.length||0),0);
  return sendTrackedMessage(chatId, `🗂 <b>${escapeHtml(cat)}</b>\n\nProducts: <b>${all.length}</b>\nTotal Stock: <b>${stock}</b>\n\nTap product to view details:`, inline(rows));
}


async function showTopDeals(chatId, from) {
  const products = activeProducts()
    .filter(p => (p.stock || []).length > 0)
    .sort((a,b) => getProductPrice(a, from.id) - getProductPrice(b, from.id))
    .slice(0, 10);
  if (!products.length) return sendTrackedMessage(chatId, '🔥 <b>Top Deals</b>\n\nNo in-stock products right now.', userToolsButtons(from.id));
  const rows = products.map(p => [{ text: `${p.emoji || '📦'} ${short(p.name, 36)} — ${money(getProductPrice(p, from.id), p.currency || currency())}`, callback_data: `view:${p.code}` }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return sendTrackedMessage(chatId, '🔥 <b>Top Deals</b>\n\nCheapest in-stock products are listed below.', inline(rows));
}

async function showBestSellers(chatId, from) {
  const products = activeProducts()
    .slice()
    .sort((a,b) => Number(b.sold || 0) - Number(a.sold || 0))
    .slice(0, 10);
  if (!products.length) return sendTrackedMessage(chatId, '🏆 <b>Best Sellers</b>\n\nNo products yet.', userToolsButtons(from.id));
  const rows = products.map(p => [{ text: `${p.emoji || '📦'} ${short(p.name, 36)} — Sold ${Number(p.sold || 0)}`, callback_data: `view:${p.code}` }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return sendTrackedMessage(chatId, '🏆 <b>Best Sellers</b>\n\nPopular products in your store.', inline(rows));
}




async function showMyReviews(chatId, from) {
  const uid = String(from.id);
  const list = (db.reviews || []).filter(r => r.telegramId === uid).slice(0, 10);
  if (!list.length) return sendTrackedMessage(chatId, '⭐ <b>My Reviews</b>\n\nYou have not reviewed any order yet. Open My Orders → View Order → Rate Order.', userToolsButtons(uid));
  let out = '⭐ <b>My Reviews</b>\n\n';
  list.forEach((r, i) => {
    out += `${i + 1}. ${ratingStars(r.rating)} ${r.rating}/5\n${escapeHtml(r.productName)}\n${r.message ? 'Review: ' + escapeHtml(r.message) : ''}\n\n`;
  });
  return sendTrackedMessage(chatId, out, userToolsButtons(uid));
}

async function showWishlist(chatId, from) {
  const uid = String(from.id);
  const codes = wishlistOf(uid);
  const products = codes.map(c => productByCode(c)).filter(Boolean);
  if (!products.length) return sendTrackedMessage(chatId, '⭐ <b>My Wishlist</b>\n\nNo products saved yet. Open a product and tap “Add Wishlist”.', userToolsButtons(uid));
  const rows = products.map(p => [{ text: `${p.emoji || '📦'} ${short(p.name, 38)} · ${p.stock.length ? money(getProductPrice(p, uid), p.currency || currency()) : 'Out of Stock'}`, callback_data: `view:${p.code}` }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return sendTrackedMessage(chatId, '⭐ <b>My Wishlist</b>\n\nSaved products are listed below.', inline(rows));
}

async function showMyRestockRequests(chatId, from) {
  const uid = String(from.id);
  const list = (db.restockRequests || []).filter(r => r.telegramId === uid).slice(0, 10);
  if (!list.length) return sendTrackedMessage(chatId, '🔔 <b>Restock Requests</b>\n\nNo restock requests yet.', userToolsButtons(uid));
  let out = '🔔 <b>My Restock Requests</b>\n\n';
  const rows = [];
  list.forEach((r, i) => {
    out += `${i + 1}. ${escapeHtml(r.productName)}\nStatus: ${r.status === 'open' ? 'Waiting' : 'Notified'}\nDate: ${escapeHtml(new Date(r.createdAt).toLocaleString())}\n\n`;
    rows.push([{ text: `📦 ${short(r.productName, 36)}`, callback_data: `view:${r.productCode}` }]);
  });
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);
  return sendTrackedMessage(chatId, out, inline(rows));
}


async function showWalletHistory(chatId, from) {
  const uid = String(from.id);
  const deposits = (db.deposits || []).filter((d) => d.telegramId === uid).slice(-15).reverse();
  let out = `💰 <b>Wallet History</b>\n\n`;
  if (!deposits.length) out += 'No wallet history yet.';
  for (const d of deposits) {
    const sign = Number(d.amount) >= 0 ? '+' : '';
    out += `${sign}${money(d.amount, d.currency || currency())} | ${escapeHtml(d.method || 'Wallet')}\n${escapeHtml(new Date(d.createdAt).toLocaleString())}\n\n`;
  }
  return sendTrackedMessage(chatId, out, userToolsButtons(uid));
}

async function showUserPaymentsList(chatId, from) {
  const uid = String(from.id);
  const payments = db.payments.filter((p) => p.telegramId === uid).slice(-12).reverse();
  let out = `💳 <b>My Payments</b>\n\n`;
  if (!payments.length) out += 'No payments yet.';
  for (const p of payments) {
    out += `${p.id} | ${userPaymentStatusLabel(p)}\n${p.type === 'deposit' ? 'Wallet Deposit' : escapeHtml(p.productName)}\nAmount: ${money(p.amount, p.currency)}\nMethod: ${escapeHtml(p.methodName || '-')}\n\n`;
  }
  return sendTrackedMessage(chatId, out, userToolsButtons(uid));
}

async function showReferral(chatId, from) {
  const uid = String(from.id);
  const u = getUser(from);
  const link = `https://t.me/${getBotUsername() || botUsername}?start=${uid}`;
  return sendTrackedMessage(chatId, `🎁 <b>Refer & Earn</b>\n\nShare your referral link with friends.\n\nYour Referrals: <b>${u.referrals || 0}</b>\n\n<code>${escapeHtml(link)}</code>`, userToolsButtons(uid));
}

async function toggleUserNotifications(chatId, from) {
  const u = getUser(from);
  u.notifications = u.notifications === false ? true : false;
  saveData();
  return sendTrackedMessage(chatId, `🔔 Notifications are now: <b>${u.notifications === false ? 'OFF' : 'ON'}</b>\n\nThis controls announcements and stock alerts.`, userToolsButtons(from.id));
}

async function searchProducts(chatId, from, query) {
  const q = String(query || '').trim().toLowerCase();
  const found = activeProducts().filter((p) => 
    p.name.toLowerCase().includes(q) || String(p.code).toLowerCase() === q || String(p.description || '').toLowerCase().includes(q)
  ).slice(0, 12);

  if (!found.length) {
    return sendTrackedMessage(chatId, `🔎 No product found for: <b>${escapeHtml(query)}</b>`, userToolsButtons(from.id));
  }

  const rows = found.map((p) => [styleButton({
    text: styledProductButtonText(p, from.id),
    callback_data: `view:${p.code}`,
    ...buttonIconFields(p)
  }, 'success')]);
  rows.push([{ text: '🔎 Search Again', callback_data: 'search_product' }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'home' }]);

  return sendTrackedMessage(chatId, `🔎 <b>Search Results</b>\n\nQuery: ${escapeHtml(query)}\nFound: ${found.length}`, inline(rows));
}


// Runtime stats guard: prevents startup crash if future archive edit removes the top declaration.
if (typeof runtimeStats === 'undefined') {
  throw new Error('runtimeStats boot guard failed: runtimeStats must be defined near updateOffset/botUsername.');
}

// =====================
// TELEGRAM API
// =====================
function recordApiSpeed(method, ms, ok = true) {
  runtimeStats.apiCalls ||= 0;
  runtimeStats.apiErrors ||= 0;
  runtimeStats.apiTotalMs ||= 0;
  runtimeStats.apiMaxMs ||= 0;
  runtimeStats.apiSamples ||= [];
  runtimeStats.apiCalls++;
  if (!ok) runtimeStats.apiErrors++;
  runtimeStats.apiTotalMs += Number(ms || 0);
  runtimeStats.apiMaxMs = Math.max(Number(runtimeStats.apiMaxMs || 0), Number(ms || 0));
  runtimeStats.apiSamples.push({ method, ms: Number(ms || 0), ok, at: Date.now() });
  runtimeStats.apiSamples = runtimeStats.apiSamples.slice(-200);
}

function apiAvgMs() {
  return runtimeStats.apiCalls ? Math.round(Number(runtimeStats.apiTotalMs || 0) / runtimeStats.apiCalls) : 0;
}

function apiP95Ms() {
  const arr = (runtimeStats.apiSamples || []).map(x => Number(x.ms || 0)).sort((a,b)=>a-b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
}

async function tg(method, payload = {}, timeout = 15000) {
  const started = Date.now();
  try {
    const res = await axios.post(`${API}/${method}`, payload, { timeout });
    const ms = Date.now() - started;
    recordApiSpeed(method, ms, true);
    if (ms > Number(db.settings.speedWarnMs || 2500)) addHealthLog('telegram_api_slow', { method, ms }, 'warn');
    if (!res.data?.ok) throw new Error(JSON.stringify(res.data));
    return res.data.result;
  } catch (err) {
    const ms = Date.now() - started;
    recordApiSpeed(method, ms, false);
    const tgDesc = err.response?.data?.description || err.response?.data?.message || err.message;
    const code = err.response?.status || err.response?.data?.error_code || '';
    addHealthLog('telegram_api_error', { method, ms, code, error: String(tgDesc || '').slice(0, 300) }, 'error');
    throw new Error(`${method} failed${code ? ' (' + code + ')' : ''}: ${tgDesc}`);
  }
}

async function tgGet(method, params = {}, timeout = 30000) {
  const started = Date.now();
  try {
    const res = await axios.get(`${API}/${method}`, { params, timeout });
    const ms = Date.now() - started;
    recordApiSpeed(method, ms, true);
    if (ms > Number(db.settings.speedWarnMs || 2500)) addHealthLog('telegram_api_slow', { method, ms }, 'warn');
    if (!res.data?.ok) throw new Error(JSON.stringify(res.data));
    return res.data.result;
  } catch (err) {
    const ms = Date.now() - started;
    recordApiSpeed(method, ms, false);
    addHealthLog('telegram_api_error', { method, ms, error: String(err.message || '').slice(0, 300) }, 'error');
    throw err;
  }
}

async function sendMessage(chatId, text, replyMarkup) {
  const msg = await tg('sendMessage', {
    chat_id: chatId,
    text: trim(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
  if (msg?.message_id) {
    try {
      const key = String(chatId);
      db.chatMessages ||= {};
      db.chatMessages[key] ||= [];
      db.chatMessages[key].push(Number(msg.message_id));
      db.chatMessages[key] = [...new Set(db.chatMessages[key])].slice(-80);
      saveData();
    } catch (_) {}
  }
  return msg;
}

async function sendPhoto(chatId, fileId, caption, replyMarkup) {
  const msg = await tg('sendPhoto', {
    chat_id: chatId,
    photo: fileId,
    caption: trim(caption, 900),
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
  if (msg?.message_id) {
    try {
      const key = String(chatId);
      db.chatMessages ||= {};
      db.chatMessages[key] ||= [];
      db.chatMessages[key].push(Number(msg.message_id));
      db.chatMessages[key] = [...new Set(db.chatMessages[key])].slice(-80);
      saveData();
    } catch (_) {}
  }
  return msg;
}

async function deleteMessage(chatId, messageId) {
  try { await tg('deleteMessage', { chat_id: chatId, message_id: messageId }, 8000); } catch (_) {}
}

async function clearOldReplyKeyboard(chatId) {
  // This removes any old bottom reply keyboard from previous versions.
  // Then deletes the small temporary message so chat stays clean.
  try {
    const msg = await sendMessage(chatId, '⌨️ Updating menu...', removeKeyboardMarkup());
    await deleteMessage(chatId, msg.message_id);
  } catch (_) {}
}

async function answerCallback(id, text = '') {
  try { await tg('answerCallbackQuery', { callback_query_id: id, text }, 8000); } catch (_) {}
}

// =====================
// BINANCE AUTO VERIFY
// =====================
function binanceCfg() {
  return {
    id: db.settings.binanceId || process.env.BINANCE_ID || '',
    coin: String(db.settings.binanceCoin || process.env.BINANCE_COIN || 'USDT').toUpperCase(),
    apiKey: db.settings.binanceApiKey || process.env.BINANCE_API_KEY || '',
    secretKey: db.settings.binanceSecretKey || process.env.BINANCE_SECRET_KEY || '',
    baseUrl: db.settings.binanceBaseUrl || BINANCE_BASE_URL,
    lookbackDays: Number(db.settings.binanceLookbackDays || BINANCE_LOOKBACK_DAYS),
    tolerance: Number(db.settings.binanceAmountTolerance || BINANCE_AMOUNT_TOLERANCE),
    allowPartialTxid: Boolean(db.settings.binanceAllowPartialTxid),
    autoVerifyEnabled: db.settings.autoVerifyEnabled === false ? false : true,
    autoVerifyAmountMatch: db.settings.autoVerifyAmountMatch === false ? false : true,
    autoVerifyMaxAgeHours: Number(db.settings.autoVerifyMaxAgeHours || 24)
  };
}

function mask(s) {
  s = String(s || '');
  return s ? (s.length > 8 ? s.slice(0, 4) + '...' + s.slice(-4) : '****') : 'Not set';
}

function signedQuery(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret || '').update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

function autoVerifyLog(type, message, data = {}) {
  try {
    db.autoVerifyLogs ||= [];
    db.autoVerifyLogs.unshift({
      id: 'AVL' + Date.now() + Math.floor(Math.random() * 999),
      type,
      message: String(message || '').slice(0, 500),
      data,
      at: now()
    });
    db.autoVerifyLogs = db.autoVerifyLogs.slice(0, 250);
    saveData();
  } catch (_) {}
}

function normalizeBinanceTx(raw, source = 'deposit') {
  const amount = Number(raw.amount || raw.quantity || raw.receiveAmount || raw.totalFee || raw.orderAmount || raw.fiatAmount || 0);
  const coin = String(raw.coin || raw.currency || raw.asset || raw.cryptoCurrency || binanceCfg().coin || '').toUpperCase();
  const txId = String(raw.txId || raw.txID || raw.tranId || raw.transactionId || raw.orderId || raw.merchantTradeNo || raw.prepayId || raw.id || '').trim();
  const timeVal = Number(raw.insertTime || raw.applyTime || raw.successTime || raw.transactionTime || raw.createTime || raw.time || raw.timestamp || Date.now());
  const status = String(raw.status ?? raw.orderStatus ?? raw.transferStatus ?? '').toLowerCase();
  const note = String(raw.note || raw.remark || raw.memo || raw.info || raw.reference || raw.description || '').trim();
  return { source, txId, amount, coin, time: timeVal, status, note, raw };
}

async function fetchDeposits(coin) {
  const cfg = binanceCfg();
  if (!cfg.apiKey || !cfg.secretKey) throw new Error('Binance API key/secret missing. Set from Admin → Binance API.');
  const endTime = Date.now();
  const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
  const query = signedQuery({
    coin: coin || cfg.coin,
    status: 1,
    startTime,
    endTime,
    limit: 1000,
    recvWindow: 60000,
    timestamp: Date.now()
  }, cfg.secretKey);

  const res = await axios.get(`${cfg.baseUrl}/sapi/v1/capital/deposit/hisrec?${query}`, {
    timeout: 15000,
    headers: { 'X-MBX-APIKEY': cfg.apiKey }
  });
  return (Array.isArray(res.data) ? res.data : []).map(x => normalizeBinanceTx(x, 'capital_deposit'));
}

async function fetchBinancePayTransactions() {
  const cfg = binanceCfg();
  if (!cfg.apiKey || !cfg.secretKey) throw new Error('Binance API key/secret missing.');
  const endTime = Date.now();
  const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
  const query = signedQuery({
    startTime,
    endTime,
    limit: 100,
    recvWindow: 60000,
    timestamp: Date.now()
  }, cfg.secretKey);

  try {
    const res = await axios.get(`${cfg.baseUrl}/sapi/v1/pay/transactions?${query}`, {
      timeout: 15000,
      headers: { 'X-MBX-APIKEY': cfg.apiKey }
    });
    const arr = Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    return arr.map(x => normalizeBinanceTx(x, 'binance_pay'));
  } catch (err) {
    autoVerifyLog('warn', 'Binance Pay transaction endpoint not available or permission missing', { error: err.response?.data || err.message });
    return [];
  }
}

async function fetchAllBinanceTxs() {
  const all = [];
  try {
    all.push(...await fetchDeposits(binanceCfg().coin));
  } catch (err) {
    autoVerifyLog('error', 'Capital deposit fetch failed', { error: err.response?.data || err.message });
  }
  const payTxs = await fetchBinancePayTransactions();
  all.push(...payTxs);
  return all;
}

// =====================
// BYBIT AUTO VERIFY V5
// =====================
function bybitCfg() {
  return {
    apiKey: db.settings.bybitApiKey || process.env.BYBIT_API_KEY || 'I4LQnHRcTSkwATueh1',
    secretKey: db.settings.bybitSecretKey || process.env.BYBIT_SECRET_KEY || 'Mkav0oU7pvfZfj6dsjzXwF3t3ZbmrY6sEwu1',
    baseUrl: db.settings.bybitBaseUrl || process.env.BYBIT_BASE_URL || 'https://api.bybit.com',
    coin: String(db.settings.bybitCoin || process.env.BYBIT_COIN || 'USDT').toUpperCase(),
    lookbackDays: Number(db.settings.bybitLookbackDays || 7)
  };
}

function bybitSignature(timestamp, apiKey, recvWindow, queryString, secretKey) {
  const preHash = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  return crypto.createHmac('sha256', secretKey || '').update(preHash).digest('hex');
}

async function fetchBybitDeposits(coin) {
  const cfg = bybitCfg();
  if (!cfg.apiKey || !cfg.secretKey) throw new Error('Bybit API key/secret missing.');
  
  const timestamp = Date.now();
  const recvWindow = 20000;
  const endTime = timestamp;
  const startTime = endTime - cfg.lookbackDays * 24 * 60 * 60 * 1000;
  
  const targetCoin = (coin || cfg.coin).toUpperCase();
  const params = new URLSearchParams({
    coin: targetCoin,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: '50'
  });
  
  const queryString = params.toString();
  const sign = bybitSignature(timestamp, cfg.apiKey, recvWindow, queryString, cfg.secretKey);

  const res = await axios.get(`${cfg.baseUrl}/v5/asset/deposit/query-record?${queryString}`, {
    timeout: 15000,
    headers: {
      'X-BAPI-API-KEY': cfg.apiKey,
      'X-BAPI-TIMESTAMP': String(timestamp),
      'X-BAPI-RECV-WINDOW': String(recvWindow),
      'X-BAPI-SIGN': sign
    }
  });

  if (res.data && res.data.retCode === 0 && res.data.result && Array.isArray(res.data.result.rows)) {
    return res.data.result.rows.map(r => ({
      source: 'bybit_deposit',
      txId: String(r.txID || r.txId || r.id || '').trim(),
      amount: Number(r.amount || 0),
      coin: String(r.coin || targetCoin).toUpperCase(),
      time: Number(r.successTime || r.createTime || Date.now()),
      status: Number(r.status) === 3 ? 'success' : String(r.status),
      note: String(r.memo || r.remark || '').trim(),
      raw: r
    }));
  }
  return [];
}

async function fetchAllCryptoTxs() {
  const all = [];
  
  // 1. Binance Txs
  try {
    const bCfg = binanceCfg();
    if (bCfg.apiKey && bCfg.secretKey) {
      const bTxs = await fetchAllBinanceTxs();
      all.push(...bTxs);
    }
  } catch (err) {
    autoVerifyLog('warn', 'Binance deposit fetch skipped: ' + err.message);
  }

  // 2. Bybit Txs
  try {
    const yCfg = bybitCfg();
    if (yCfg.apiKey && yCfg.secretKey) {
      const bybitTxs = await fetchBybitDeposits(yCfg.coin);
      all.push(...bybitTxs);
    }
  } catch (err) {
    autoVerifyLog('warn', 'Bybit deposit fetch skipped: ' + err.message);
  }

  return all;
}

function txMatch(apiTx, userTx, rawObj = null) {
  const cfg = binanceCfg();
  const a = String(apiTx || '').trim().toLowerCase();
  const u = String(userTx || '').trim().toLowerCase();
  const raw = rawObj ? JSON.stringify(rawObj).toLowerCase() : '';
  if (!u) return false;
  if (a && a === u) return true;
  if (raw && raw.includes(u)) return true;
  if (!cfg.allowPartialTxid) return false;
  return (a && u.length >= 8 && a.includes(u)) || (a && a.length >= 8 && u.includes(a));
}

function alreadyUsedBinanceTx(tx, currentPaymentId = '') {
  const id = String(tx?.txId || '').toLowerCase();
  if (!id) return false;
  return db.payments.some(p =>
    p.id !== currentPaymentId &&
    p.status === 'approved' &&
    String(p.binanceTxId || p.submittedReference || '').toLowerCase() === id
  );
}


function roundMoney(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function uniqueAmountSuffix() {
  const max = Math.max(9, Math.min(999, Number(db.settings.uniqueAmountMaxCents || 99)));
  return (crypto.randomInt(1, max + 1)) / 1000;
}

function makeUniquePayableAmount(baseAmount) {
  const base = roundMoney(baseAmount);
  // V41 default: no unique amount. User pays normal product/deposit amount.
  if (db.settings.uniqueAmountEnabled !== true) return base;

  const active = (db.payments || []).filter(p =>
    !['approved', 'cancelled', 'rejected'].includes(String(p.status || '').toLowerCase()) &&
    Date.now() - Date.parse(p.createdAt || now()) < 60 * 60 * 1000
  );

  for (let i = 0; i < 80; i++) {
    const amount = roundMoney(base + uniqueAmountSuffix());
    const clash = active.some(p => Math.abs(Number(p.amount || 0) - amount) <= Number(db.settings.noTxidTolerance || 0.001));
    if (!clash) return amount;
  }
  return base;
}

function paymentDisplayAmount(payment) {
  return Number(payment.amount || payment.payableAmount || payment.baseAmount || 0);
}


function amountMatches(found, required) {
  const tol = db.settings.noTxidMode === false
    ? Number(binanceCfg().tolerance || 0.02)
    : Number(db.settings.noTxidTolerance || 0.001);
  return Math.abs(Number(found || 0) - Number(required || 0)) <= tol;
}

function paymentCreatedMs(payment) {
  const t = Date.parse(payment.createdAt || payment.expiresAt || now());
  return Number.isFinite(t) ? t : Date.now();
}


function paymentNoteToken(payment) {
  return String(payment?.note || '').trim().toUpperCase();
}

function txTextBlob(tx) {
  try {
    return `${tx?.txId || ''} ${tx?.note || ''} ${JSON.stringify(tx?.raw || {})}`.toLowerCase();
  } catch (_) {
    return `${tx?.txId || ''} ${tx?.note || ''}`.toLowerCase();
  }
}

function txHasPaymentNote(tx, payment) {
  const note = paymentNoteToken(payment).toLowerCase();
  if (!note || note.length < 4) return false;
  return txTextBlob(tx).includes(note);
}

function safeAutoVerifyHelp(payment) {
  return `Auto verify is locked to your Reference Note: ${payment?.note || '-'}.
If you did not add this exact note while paying, use Submit TXID / Hash instead.`;
}


async function verifyPayment(payment) {
  const cfg = binanceCfg();
  const ref = String(payment.submittedReference || '').trim();
  const requiredAmount = Number(payment.amount || payment.payableAmount || 0);
  const createdMs = paymentCreatedMs(payment);
  const maxAgeMs = Number(cfg.autoVerifyMaxAgeHours || 24) * 60 * 60 * 1000;

  const txs = await fetchAllCryptoTxs();
  const baseCandidates = txs.filter(tx => {
    if (!amountMatches(tx.amount, requiredAmount)) return false;
    if (String(tx.coin || cfg.coin).toUpperCase() !== String(cfg.coin).toUpperCase()) return false;
    if (alreadyUsedBinanceTx(tx, payment.id)) return false;
    if (tx.time && tx.time < createdMs - (10 * 60 * 1000)) return false;
    if (tx.time && tx.time > Date.now() + (5 * 60 * 1000)) return false;
    if (Date.now() - createdMs > maxAgeMs) return false;
    return true;
  });

  // TXID / Hash path: safe because user submitted the exact transaction reference.
  if (ref.length >= 4) {
    const used = db.payments.find((p) =>
      p.id !== payment.id &&
      p.status === 'approved' &&
      String(p.submittedReference || '').toLowerCase() === ref.toLowerCase()
    );
    if (used) return { ok: false, reason: 'This TXID/reference is already used.' };

    const match = baseCandidates.find((d) => txMatch(d.txId || d.note, ref, d.raw));
    if (!match) {
      return { ok: false, reason: `TXID / Order ID not found in Binance API yet for ${money(requiredAmount)}. Make sure network/amount is correct and try again after a few minutes.` };
    }
    return { ok: true, amount: Number(match.amount || 0), raw: match.raw, txId: match.txId || ref, source: match.source, matchType: 'txid/hash' };
  }

  // Auto Verify path: NEVER approve by amount only.
  // It must match amount + time + exact payment note to avoid crediting the wrong user.
  const note = paymentNoteToken(payment);
  if (!note) {
    return { ok: false, reason: 'Auto verify stopped: payment note missing. Submit TXID / Hash instead.' };
  }

  const noteCandidates = baseCandidates.filter(tx => txHasPaymentNote(tx, payment));

  if (noteCandidates.length === 1) {
    const match = noteCandidates[0];
    return {
      ok: true,
      amount: Number(match.amount || 0),
      raw: match.raw,
      txId: match.txId || `NOTE:${note}`,
      source: match.source,
      matchType: 'auto amount+note'
    };
  }

  if (noteCandidates.length > 1) {
    return { ok: false, reason: `Multiple payments matched note ${note}. Admin check required.` };
  }

  if (baseCandidates.length > 0) {
    return { ok: false, reason: `Payment amount found in Binance API, but Reference Note ${note} was not found in Binance record. ${safeAutoVerifyHelp(payment)}` };
  }

  return { ok: false, reason: `No payment found yet for ${money(requiredAmount)}. Pay exact amount and add Reference Note ${note}, or submit TXID / Hash.` };
}

async function markAutoVerified(payment, result) {
  payment.status = 'approved';
  payment.verifiedAt = now();
  payment.binanceAmount = result?.amount || payment.amount;
  payment.binanceRaw = result?.raw || null;
  payment.binanceTxId = result?.txId || payment.submittedReference || '';
  payment.autoVerifiedBy = result?.matchType || 'auto';
  payment.autoVerifiedSource = result?.source || '';
  saveData();
}

async function autoApprovePayment(payment, result, source = 'auto-binance') {
  if (!payment) throw new Error('Payment not found');
  await markAutoVerified(payment, result);

  if (payment.type === 'deposit') {
    return approveAndDeliverPayment(payment, {
      approvedBy: source,
      method: `${source} ${result?.matchType || ''}`.trim(),
      reference: result?.txId || payment.submittedReference || ''
    });
  }

  return approveAndDeliverPayment(payment, {
    approvedBy: source,
    method: `${source} ${result?.matchType || ''}`.trim(),
    reference: result?.txId || payment.submittedReference || ''
  });
}

// =====================
// PREMIUM SMART UI HELPERS
// =====================
function niceLine(line) {
  line = String(line || '').trim();
  if (!line) return '';
  line = line.replace(/^[✅✔️•\-–—*\s]+/, '').trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function brandLogoForName(name = '') {
  const code = brandCodeForName(name);
  const item = brandCodeCatalog()[code];
  return item?.icon || '📦';
}



function productLogo(pOrName = '') {
  if (pOrName && typeof pOrName === 'object') {
    const custom = String(pOrName.logo || pOrName.icon || pOrName.emoji || '').trim();
    if (custom) return custom.slice(0, 12);
    const code = String(pOrName.brandCode || brandCodeForName(pOrName.name || '')).toLowerCase();
    return brandCodeCatalog()[code]?.icon || brandLogoForName(pOrName.name || '');
  }
  return brandLogoForName(pOrName);
}

function premiumIconForName(name = '') {
  return brandLogoForName(name);
}


function brandCodeCatalog() {
  return {
  "chatgpt": {
    "name": "ChatGPT / OpenAI",
    "icon": "🤖",
    "cat": "ai",
    "keywords": [
      "chatgpt",
      "gpt",
      "openai",
      "plus",
      "pro"
    ]
  },
  "gemini": {
    "name": "Gemini / Google AI",
    "icon": "💎",
    "cat": "ai",
    "keywords": [
      "gemini",
      "google ai",
      "bard",
      "jio gemini"
    ]
  },
  "google": {
    "name": "Google / Google One",
    "icon": "🔷",
    "cat": "ai",
    "keywords": [
      "google one",
      "google storage",
      "google pro",
      "google"
    ]
  },
  "claude": {
    "name": "Claude / Anthropic",
    "icon": "🧠",
    "cat": "ai",
    "keywords": [
      "claude",
      "anthropic"
    ]
  },
  "perplexity": {
    "name": "Perplexity",
    "icon": "🔎",
    "cat": "ai",
    "keywords": [
      "perplexity",
      "pplx"
    ]
  },
  "grok": {
    "name": "Grok / xAI",
    "icon": "✦",
    "cat": "ai",
    "keywords": [
      "grok",
      "xai",
      "x ai"
    ]
  },
  "copilot": {
    "name": "Microsoft Copilot",
    "icon": "🌀",
    "cat": "ai",
    "keywords": [
      "copilot",
      "microsoft ai"
    ]
  },
  "poe": {
    "name": "Poe",
    "icon": "🧩",
    "cat": "ai",
    "keywords": [
      "poe"
    ]
  },
  "you": {
    "name": "You.com",
    "icon": "🔍",
    "cat": "ai",
    "keywords": [
      "you.com",
      "you ai"
    ]
  },
  "phind": {
    "name": "Phind",
    "icon": "🔎",
    "cat": "ai",
    "keywords": [
      "phind"
    ]
  },
  "merlin": {
    "name": "Merlin AI",
    "icon": "🪄",
    "cat": "ai",
    "keywords": [
      "merlin"
    ]
  },
  "blackbox": {
    "name": "Blackbox AI",
    "icon": "⬛",
    "cat": "ai",
    "keywords": [
      "blackbox"
    ]
  },
  "monica": {
    "name": "Monica AI",
    "icon": "🟣",
    "cat": "ai",
    "keywords": [
      "monica"
    ]
  },
  "jasper": {
    "name": "Jasper AI",
    "icon": "🟠",
    "cat": "ai",
    "keywords": [
      "jasper"
    ]
  },
  "copyai": {
    "name": "Copy.ai",
    "icon": "✍️",
    "cat": "ai",
    "keywords": [
      "copy.ai",
      "copy ai"
    ]
  },
  "writesonic": {
    "name": "Writesonic",
    "icon": "⚡",
    "cat": "ai",
    "keywords": [
      "writesonic"
    ]
  },
  "quillbot": {
    "name": "QuillBot",
    "icon": "🪶",
    "cat": "ai",
    "keywords": [
      "quillbot",
      "quill bot"
    ]
  },
  "grammarly": {
    "name": "Grammarly",
    "icon": "🟢",
    "cat": "ai",
    "keywords": [
      "grammarly"
    ]
  },
  "deepl": {
    "name": "DeepL",
    "icon": "🌍",
    "cat": "ai",
    "keywords": [
      "deepl",
      "deep l"
    ]
  },
  "elevenlabs": {
    "name": "ElevenLabs",
    "icon": "🎙",
    "cat": "ai",
    "keywords": [
      "eleven",
      "elevenlabs",
      "eleven labs"
    ]
  },
  "suno": {
    "name": "Suno AI",
    "icon": "🎵",
    "cat": "ai",
    "keywords": [
      "suno"
    ]
  },
  "udio": {
    "name": "Udio",
    "icon": "🎼",
    "cat": "ai",
    "keywords": [
      "udio"
    ]
  },
  "heygen": {
    "name": "HeyGen",
    "icon": "🧑‍💼",
    "cat": "ai",
    "keywords": [
      "heygen"
    ]
  },
  "synthesia": {
    "name": "Synthesia",
    "icon": "🎥",
    "cat": "ai",
    "keywords": [
      "synthesia"
    ]
  },
  "gamma": {
    "name": "Gamma",
    "icon": "📊",
    "cat": "ai",
    "keywords": [
      "gamma"
    ]
  },
  "beautifulai": {
    "name": "Beautiful.ai",
    "icon": "📊",
    "cat": "ai",
    "keywords": [
      "beautiful.ai",
      "beautiful ai"
    ]
  },
  "tome": {
    "name": "Tome",
    "icon": "📖",
    "cat": "ai",
    "keywords": [
      "tome"
    ]
  },
  "fireflies": {
    "name": "Fireflies AI",
    "icon": "🔥",
    "cat": "ai",
    "keywords": [
      "fireflies",
      "fireflies ai"
    ]
  },
  "tldv": {
    "name": "tl;dv",
    "icon": "🎥",
    "cat": "ai",
    "keywords": [
      "tl;dv",
      "tldv"
    ]
  },
  "midjourney": {
    "name": "Midjourney",
    "icon": "🖼",
    "cat": "image",
    "keywords": [
      "midjourney",
      "mid journey"
    ]
  },
  "runway": {
    "name": "Runway",
    "icon": "🎥",
    "cat": "image",
    "keywords": [
      "runway"
    ]
  },
  "leonardo": {
    "name": "Leonardo AI",
    "icon": "🎨",
    "cat": "image",
    "keywords": [
      "leonardo"
    ]
  },
  "ideogram": {
    "name": "Ideogram",
    "icon": "🖌",
    "cat": "image",
    "keywords": [
      "ideogram"
    ]
  },
  "krea": {
    "name": "Krea AI",
    "icon": "🎨",
    "cat": "image",
    "keywords": [
      "krea"
    ]
  },
  "pika": {
    "name": "Pika",
    "icon": "🐇",
    "cat": "image",
    "keywords": [
      "pika"
    ]
  },
  "kling": {
    "name": "Kling AI",
    "icon": "🎬",
    "cat": "image",
    "keywords": [
      "kling"
    ]
  },
  "luma": {
    "name": "Luma AI",
    "icon": "🌌",
    "cat": "image",
    "keywords": [
      "luma",
      "dream machine"
    ]
  },
  "stable": {
    "name": "Stable Diffusion",
    "icon": "🧪",
    "cat": "image",
    "keywords": [
      "stable diffusion",
      "stability"
    ]
  },
  "firefly": {
    "name": "Adobe Firefly",
    "icon": "🔥",
    "cat": "image",
    "keywords": [
      "firefly",
      "adobe firefly"
    ]
  },
  "removebg": {
    "name": "Remove.bg",
    "icon": "🧽",
    "cat": "image",
    "keywords": [
      "remove.bg",
      "removebg"
    ]
  },
  "clipdrop": {
    "name": "Clipdrop",
    "icon": "📎",
    "cat": "image",
    "keywords": [
      "clipdrop"
    ]
  },
  "freepik": {
    "name": "Freepik",
    "icon": "🖼",
    "cat": "image",
    "keywords": [
      "freepik"
    ]
  },
  "envato": {
    "name": "Envato",
    "icon": "🍃",
    "cat": "image",
    "keywords": [
      "envato"
    ]
  },
  "picsart": {
    "name": "Picsart",
    "icon": "🅿️",
    "cat": "image",
    "keywords": [
      "picsart"
    ]
  },
  "cursor": {
    "name": "Cursor",
    "icon": "⬛",
    "cat": "dev",
    "keywords": [
      "cursor"
    ]
  },
  "replit": {
    "name": "Replit",
    "icon": "🟧",
    "cat": "dev",
    "keywords": [
      "replit"
    ]
  },
  "github": {
    "name": "GitHub",
    "icon": "🐙",
    "cat": "dev",
    "keywords": [
      "github",
      "copilot github"
    ]
  },
  "bolt": {
    "name": "Bolt.new",
    "icon": "⚡",
    "cat": "dev",
    "keywords": [
      "bolt",
      "bolt.new"
    ]
  },
  "lovable": {
    "name": "Lovable",
    "icon": "🌈",
    "cat": "dev",
    "keywords": [
      "lovable"
    ]
  },
  "v0": {
    "name": "V0 / Vercel",
    "icon": "△",
    "cat": "dev",
    "keywords": [
      "v0",
      "vercel"
    ]
  },
  "windsurf": {
    "name": "Windsurf",
    "icon": "🌊",
    "cat": "dev",
    "keywords": [
      "windsurf"
    ]
  },
  "codeium": {
    "name": "Codeium",
    "icon": "💠",
    "cat": "dev",
    "keywords": [
      "codeium"
    ]
  },
  "codium": {
    "name": "CodiumAI / Qodo",
    "icon": "🧪",
    "cat": "dev",
    "keywords": [
      "codium",
      "qodo"
    ]
  },
  "tabnine": {
    "name": "Tabnine",
    "icon": "9️⃣",
    "cat": "dev",
    "keywords": [
      "tabnine"
    ]
  },
  "jetbrains": {
    "name": "JetBrains",
    "icon": "🧩",
    "cat": "dev",
    "keywords": [
      "jetbrains"
    ]
  },
  "stackblitz": {
    "name": "StackBlitz",
    "icon": "⚡",
    "cat": "dev",
    "keywords": [
      "stackblitz"
    ]
  },
  "glitch": {
    "name": "Glitch",
    "icon": "🐟",
    "cat": "dev",
    "keywords": [
      "glitch"
    ]
  },
  "render": {
    "name": "Render",
    "icon": "⬡",
    "cat": "dev",
    "keywords": [
      "render"
    ]
  },
  "railway": {
    "name": "Railway",
    "icon": "🚆",
    "cat": "dev",
    "keywords": [
      "railway"
    ]
  },
  "heroku": {
    "name": "Heroku",
    "icon": "🟪",
    "cat": "dev",
    "keywords": [
      "heroku"
    ]
  },
  "digitalocean": {
    "name": "DigitalOcean",
    "icon": "🌊",
    "cat": "dev",
    "keywords": [
      "digitalocean",
      "digital ocean"
    ]
  },
  "hostinger": {
    "name": "Hostinger",
    "icon": "🟣",
    "cat": "dev",
    "keywords": [
      "hostinger"
    ]
  },
  "cloudflare": {
    "name": "Cloudflare",
    "icon": "☁️",
    "cat": "dev",
    "keywords": [
      "cloudflare"
    ]
  },
  "netlify": {
    "name": "Netlify",
    "icon": "🟩",
    "cat": "dev",
    "keywords": [
      "netlify"
    ]
  },
  "notion": {
    "name": "Notion",
    "icon": "▣",
    "cat": "productivity",
    "keywords": [
      "notion"
    ]
  },
  "canva": {
    "name": "Canva",
    "icon": "🟣",
    "cat": "design",
    "keywords": [
      "canva"
    ]
  },
  "adobe": {
    "name": "Adobe Creative Cloud",
    "icon": "🌈",
    "cat": "design",
    "keywords": [
      "adobe",
      "creative cloud",
      "photoshop",
      "premiere",
      "illustrator"
    ]
  },
  "capcut": {
    "name": "CapCut",
    "icon": "✂️",
    "cat": "design",
    "keywords": [
      "capcut"
    ]
  },
  "figma": {
    "name": "Figma",
    "icon": "🎨",
    "cat": "design",
    "keywords": [
      "figma"
    ]
  },
  "framer": {
    "name": "Framer",
    "icon": "◆",
    "cat": "design",
    "keywords": [
      "framer"
    ]
  },
  "webflow": {
    "name": "Webflow",
    "icon": "🌐",
    "cat": "design",
    "keywords": [
      "webflow"
    ]
  },
  "wix": {
    "name": "Wix",
    "icon": "✦",
    "cat": "design",
    "keywords": [
      "wix"
    ]
  },
  "squarespace": {
    "name": "Squarespace",
    "icon": "⬛",
    "cat": "design",
    "keywords": [
      "squarespace"
    ]
  },
  "miro": {
    "name": "Miro",
    "icon": "🟨",
    "cat": "productivity",
    "keywords": [
      "miro"
    ]
  },
  "trello": {
    "name": "Trello",
    "icon": "📋",
    "cat": "productivity",
    "keywords": [
      "trello"
    ]
  },
  "asana": {
    "name": "Asana",
    "icon": "🔴",
    "cat": "productivity",
    "keywords": [
      "asana"
    ]
  },
  "monday": {
    "name": "Monday.com",
    "icon": "🟡",
    "cat": "productivity",
    "keywords": [
      "monday"
    ]
  },
  "clickup": {
    "name": "ClickUp",
    "icon": "✅",
    "cat": "productivity",
    "keywords": [
      "clickup"
    ]
  },
  "airtable": {
    "name": "Airtable",
    "icon": "🧱",
    "cat": "productivity",
    "keywords": [
      "airtable"
    ]
  },
  "zapier": {
    "name": "Zapier",
    "icon": "🟠",
    "cat": "productivity",
    "keywords": [
      "zapier"
    ]
  },
  "make": {
    "name": "Make.com",
    "icon": "🟣",
    "cat": "productivity",
    "keywords": [
      "make.com",
      "integromat"
    ]
  },
  "coursera": {
    "name": "Coursera",
    "icon": "🌐",
    "cat": "edu",
    "keywords": [
      "coursera"
    ]
  },
  "udemy": {
    "name": "Udemy",
    "icon": "🎓",
    "cat": "edu",
    "keywords": [
      "udemy"
    ]
  },
  "linkedin": {
    "name": "LinkedIn Learning",
    "icon": "💼",
    "cat": "edu",
    "keywords": [
      "linkedin",
      "linkedin learning"
    ]
  },
  "skillshare": {
    "name": "Skillshare",
    "icon": "🟢",
    "cat": "edu",
    "keywords": [
      "skillshare"
    ]
  },
  "datacamp": {
    "name": "DataCamp",
    "icon": "📊",
    "cat": "edu",
    "keywords": [
      "datacamp"
    ]
  },
  "brilliant": {
    "name": "Brilliant",
    "icon": "💡",
    "cat": "edu",
    "keywords": [
      "brilliant"
    ]
  },
  "codecademy": {
    "name": "Codecademy",
    "icon": "💻",
    "cat": "edu",
    "keywords": [
      "codecademy"
    ]
  },
  "duolingo": {
    "name": "Duolingo",
    "icon": "🦉",
    "cat": "edu",
    "keywords": [
      "duolingo"
    ]
  },
  "khan": {
    "name": "Khan Academy",
    "icon": "🎓",
    "cat": "edu",
    "keywords": [
      "khan academy",
      "khan"
    ]
  },
  "youtube": {
    "name": "YouTube",
    "icon": "▶️",
    "cat": "media",
    "keywords": [
      "youtube",
      "yt",
      "youtube premium"
    ]
  },
  "spotify": {
    "name": "Spotify",
    "icon": "🎵",
    "cat": "media",
    "keywords": [
      "spotify"
    ]
  },
  "netflix": {
    "name": "Netflix",
    "icon": "🎬",
    "cat": "media",
    "keywords": [
      "netflix"
    ]
  },
  "prime": {
    "name": "Prime Video",
    "icon": "📺",
    "cat": "media",
    "keywords": [
      "prime video",
      "amazon prime"
    ]
  },
  "disney": {
    "name": "Disney+ / Hotstar",
    "icon": "🏰",
    "cat": "media",
    "keywords": [
      "disney",
      "hotstar"
    ]
  },
  "crunchyroll": {
    "name": "Crunchyroll",
    "icon": "🍥",
    "cat": "media",
    "keywords": [
      "crunchyroll"
    ]
  },
  "telegram": {
    "name": "Telegram",
    "icon": "✈️",
    "cat": "social",
    "keywords": [
      "telegram"
    ]
  },
  "discord": {
    "name": "Discord",
    "icon": "💬",
    "cat": "social",
    "keywords": [
      "discord"
    ]
  },
  "instagram": {
    "name": "Instagram",
    "icon": "📸",
    "cat": "social",
    "keywords": [
      "instagram",
      "insta"
    ]
  },
  "tiktok": {
    "name": "TikTok",
    "icon": "🎵",
    "cat": "social",
    "keywords": [
      "tiktok"
    ]
  },
  "facebook": {
    "name": "Facebook",
    "icon": "🔵",
    "cat": "social",
    "keywords": [
      "facebook"
    ]
  },
  "x": {
    "name": "X / Twitter",
    "icon": "𝕏",
    "cat": "social",
    "keywords": [
      "twitter",
      "x premium",
      "x.com"
    ]
  },
  "snapchat": {
    "name": "Snapchat",
    "icon": "👻",
    "cat": "social",
    "keywords": [
      "snapchat"
    ]
  },
  "zoom": {
    "name": "Zoom",
    "icon": "📹",
    "cat": "office",
    "keywords": [
      "zoom"
    ]
  },
  "slack": {
    "name": "Slack",
    "icon": "💬",
    "cat": "office",
    "keywords": [
      "slack"
    ]
  },
  "teams": {
    "name": "Microsoft Teams",
    "icon": "👥",
    "cat": "office",
    "keywords": [
      "teams",
      "microsoft teams"
    ]
  },
  "office": {
    "name": "Microsoft Office / 365",
    "icon": "🧾",
    "cat": "office",
    "keywords": [
      "office 365",
      "microsoft 365",
      "ms office"
    ]
  },
  "gmail": {
    "name": "Gmail / Mail",
    "icon": "📧",
    "cat": "office",
    "keywords": [
      "gmail",
      "mail",
      "email"
    ]
  },
  "proton": {
    "name": "Proton",
    "icon": "🔐",
    "cat": "office",
    "keywords": [
      "proton",
      "protonmail"
    ]
  },
  "semrush": {
    "name": "SEMrush",
    "icon": "📈",
    "cat": "marketing",
    "keywords": [
      "semrush"
    ]
  },
  "ahrefs": {
    "name": "Ahrefs",
    "icon": "📊",
    "cat": "marketing",
    "keywords": [
      "ahrefs"
    ]
  },
  "moz": {
    "name": "Moz",
    "icon": "🟦",
    "cat": "marketing",
    "keywords": [
      "moz"
    ]
  },
  "similarweb": {
    "name": "Similarweb",
    "icon": "🌐",
    "cat": "marketing",
    "keywords": [
      "similarweb"
    ]
  },
  "mailchimp": {
    "name": "Mailchimp",
    "icon": "🐵",
    "cat": "marketing",
    "keywords": [
      "mailchimp"
    ]
  },
  "hubspot": {
    "name": "HubSpot",
    "icon": "🟠",
    "cat": "marketing",
    "keywords": [
      "hubspot"
    ]
  },
  "hootsuite": {
    "name": "Hootsuite",
    "icon": "🦉",
    "cat": "marketing",
    "keywords": [
      "hootsuite"
    ]
  },
  "binance": {
    "name": "Binance",
    "icon": "🟨",
    "cat": "finance",
    "keywords": [
      "binance"
    ]
  },
  "paypal": {
    "name": "PayPal",
    "icon": "💙",
    "cat": "finance",
    "keywords": [
      "paypal"
    ]
  },
  "stripe": {
    "name": "Stripe",
    "icon": "💳",
    "cat": "finance",
    "keywords": [
      "stripe"
    ]
  },
  "nordvpn": {
    "name": "NordVPN",
    "icon": "🛡",
    "cat": "security",
    "keywords": [
      "nordvpn",
      "nord vpn"
    ]
  },
  "expressvpn": {
    "name": "ExpressVPN",
    "icon": "🔐",
    "cat": "security",
    "keywords": [
      "expressvpn",
      "express vpn"
    ]
  },
  "surfshark": {
    "name": "Surfshark",
    "icon": "🦈",
    "cat": "security",
    "keywords": [
      "surfshark"
    ]
  },
  "malwarebytes": {
    "name": "Malwarebytes",
    "icon": "🛡",
    "cat": "security",
    "keywords": [
      "malwarebytes"
    ]
  },
  "default": {
    "name": "Default Product",
    "icon": "📦",
    "cat": "other",
    "keywords": []
  }
};
}

function brandCategories() {
  return [...new Set(Object.values(brandCodeCatalog()).map(x => x.cat || 'other'))].sort();
}

function brandCodeForName(name = '') {
  const n = String(name || '').toLowerCase();
  const catalog = brandCodeCatalog();
  for (const [code, item] of Object.entries(catalog)) {
    if (code !== 'default' && ((item.keywords || []).some(k => n.includes(String(k).toLowerCase())) || n.includes(code))) return code;
  }
  return 'default';
}

function brandCodeRowsText(category = 'all') {
  const catalog = brandCodeCatalog();
  const cat = String(category || 'all').toLowerCase();
  const entries = Object.entries(catalog)
    .filter(([code]) => code !== 'default')
    .filter(([code, item]) => cat === 'all' || String(item.cat || '').toLowerCase() === cat);

  let out = `🧩 <b>Brand Code List${cat !== 'all' ? ' · ' + escapeHtml(cat.toUpperCase()) : ''}</b>\n\n`;
  out += `Categories: <code>${brandCategories().join('</code>, <code>')}</code>\n\n`;

  entries.slice(0, 80).forEach(([code, item]) => {
    const id = db.customEmojiMap?.[code] || '';
    out += `${item.icon} <code>${code}</code> — ${escapeHtml(item.name)}${id ? `\nID: <code>${escapeHtml(id)}</code>` : ''}\n`;
  });
  if (entries.length > 80) out += `\n...and ${entries.length - 80} more. Use <code>/brandcodes ai</code> or web panel for full list.\n`;
  if (!entries.length) out += 'No codes in this category.\n';
  out += `\n<b>Commands:</b>\n<code>/brandcodes ai</code>\n<code>/setbrandemoji gemini EMOJI_ID</code>\n<code>/setcustomemoji P001 EMOJI_ID</code>\n<code>/setbrand P001 gemini</code>\n<code>/autobrandproducts</code>`;
  return out;
}


function customEmojiIdForName(name = '') {
  const code = brandCodeForName(name);
  return db.customEmojiMap?.[code] || '';
}

function productCustomEmojiId(pOrName = '') {
  if (pOrName && typeof pOrName === 'object') {
    const code = String(pOrName.brandCode || brandCodeForName(pOrName.name || '')).toLowerCase();
    return String(pOrName.customEmojiId || db.customEmojiMap?.[code] || customEmojiIdForName(pOrName.name || '') || '').trim();
  }
  return String(customEmojiIdForName(pOrName) || '').trim();
}

function tgEmoji(fallback = '📦', emojiId = '') {
  const id = String(emojiId || '').trim();
  if (!id) return escapeHtml(fallback);
  return `<tg-emoji emoji-id="${escapeHtml(id)}">${escapeHtml(fallback || '📦')}</tg-emoji>`;
}

function productLogoHtml(pOrName = '') {
  const fallback = productLogo(pOrName);
  return tgEmoji(fallback, productCustomEmojiId(pOrName));
}

function buttonIconFields(pOrName = '') {
  const id = productCustomEmojiId(pOrName);
  return id ? { icon_custom_emoji_id: id } : {};
}

function styleButton(button, style = '') {
  if (style) button.style = style;
  return button;
}

function extractCustomEmojiIdsFromMessage(msg = {}) {
  const entities = [
    ...(msg.entities || []),
    ...(msg.caption_entities || [])
  ];
  return entities
    .filter(e => e.type === 'custom_emoji' && e.custom_emoji_id)
    .map(e => String(e.custom_emoji_id));
}

function customEmojiHelpText() {
  return `🧩 <b>Custom Emoji ID Setup</b>\n\n1. Send /emojiids\n2. Send the custom emoji/logo in next message\n3. Bot will show custom_emoji_id\n4. Add it:\n<code>/setcustomemoji P001 EMOJI_ID</code>\nor\n<code>/setbrandemoji gemini EMOJI_ID</code>\n\n<b>Brand codes:</b>\nchatgpt, gemini, google, claude, perplexity, grok, copilot, cursor, replit, lovable, v0, bolt, windsurf, github, notion, canva, capcut, adobe, coursera, udemy, linkedin, youtube, zoom, spotify, netflix, discord, telegram, gmail, elevenlabs, midjourney, runway, leonardo, gamma, framer, figma, quillbot, grammarly, deepl, semrush, ahrefs, envato, picsart`;
}


function styledProductButtonText(p, userId = '') {
  const logo = productLogo(p);
  const price = money(getProductPrice(p, userId), p.currency || currency());
  const stock = (p.stock || []).length;
  const stockIcon = stock > 0 ? '📦' : '❌';
  const saleIcon = activeFlashSale(p) ? '⚡ ' : '';
  const specialIcon = getSpecialPrice(p, userId) ? ' 🔥' : '';
  return `${logo} ${saleIcon}${short(p.name, 34)} | ${price}${specialIcon} | ${stockIcon} ${stock}`;
}

function formatAdminCustomMarkup(raw = '') {
  // Admin-friendly safe formatter:
  // Supports [b]bold[/b], [i]italic[/i], [u]underline[/u], [code]code[/code], **bold**, __italic__, `code`, [line], [quote].
  let s = escapeHtml(String(raw || '').trim());

  s = s
    .replace(/\[line\]/gi, '━━━━━━━━━━━━━━━━━━━━')
    .replace(/\[br\]/gi, '\n')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, '<code>$1</code>')
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>');

  s = s
    .replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n][\s\S]*?)__/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  return s;
}

function premiumCustomAnnouncementText(raw = '') {
  const body = formatAdminCustomMarkup(raw);
  return `📣 <b>PREMIUM ANNOUNCEMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${body}\n\n━━━━━━━━━━━━━━━━━━━━\n⚡ <b>Fast checkout • Premium service • Auto delivery</b>`;
}

function renderTemplate(template = '', vars = {}) {
  const defaults = {
    name: '',
    price: '',
    stock: '',
    bot: getBotUsername() || botUsername || BOT_USERNAME || '',
    store: STORE_NAME,
    link: ''
  };
  const v = { ...defaults, ...vars };
  return String(template || '').replace(/\{(name|price|stock|bot|store|link|emoji)\}/gi, (_, key) => String(v[key.toLowerCase()] ?? ''));
}

function productCustomPromo(product, trigger = '') {
  const template = String(product?.customPromo || '').trim();
  if (!template) return '';
  const msg = renderTemplate(template, {
    name: product.name,
    price: money(getProductPrice(product, ''), product.currency || currency()),
    stock: (product.stock || []).length,
    bot: getBotUsername() || botUsername || BOT_USERNAME || '',
    store: STORE_NAME,
    link: productDeepLink(product.code),
    emoji: productLogoHtml(product)
  });
  const extra = trigger ? `\n\n🔎 Matched: <b>${escapeHtml(trigger)}</b>` : '';
  return formatAdminCustomMarkup(msg) + extra;
}




function premiumAlertVars(product, extra = {}) {
  const sale = activeFlashSale(product);
  const salePrice = sale ? Number(sale.price || 0) : Number(getProductPrice(product, ''));
  const link = productDeepLink(product.code);
  const bot = getBotUsername() || botUsername || BOT_USERNAME || '';
  const currentPrice = money(getProductPrice(product, ''), product.currency || currency());
  const stock = (product.stock || []).length;
  const oldPrice = money(product.price, product.currency || currency());
  const endsAt = sale?.endsAt ? new Date(sale.endsAt).toLocaleString() : (extra.ends || 'Soon');
  return {
    emoji: productLogoHtml(product),
    icon: productLogoHtml(product),
    fallback_emoji: escapeHtml(productLogo(product)),
    name: escapeHtml(product.name),
    price: escapeHtml(currentPrice),
    old_price: escapeHtml(oldPrice),
    sale_price: escapeHtml(money(salePrice, product.currency || currency())),
    stock: escapeHtml(stock),
    added: escapeHtml(extra.added ?? extra.addedCount ?? 0),
    qty: escapeHtml(extra.qty ?? 1),
    currency: escapeHtml(product.currency || currency()),
    code: escapeHtml(product.code),
    bot: bot ? '@' + escapeHtml(bot) : escapeHtml(STORE_NAME),
    bot_username: escapeHtml(bot),
    store: escapeHtml(STORE_NAME),
    link: escapeHtml(link),
    buy_link: link ? `<a href="${escapeHtml(link)}">Buy Now</a>` : escapeHtml(STORE_NAME),
    ends: escapeHtml(endsAt),
    note: escapeHtml(extra.note || sale?.note || ''),
    footer: escapeHtml(db.settings.alertFooterText || 'Fast checkout • Auto delivery • Premium support')
  };
}

function renderPremiumTemplate(template = '', product, extra = {}) {
  let out = formatAdminCustomMarkup(String(template || ''));
  const vars = premiumAlertVars(product, extra);
  for (const [key, val] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(val));
  }
  return out.trim();
}

function productButtonLabel(product) {
  return `${productLogo(product)} ${short(product.name, 38)} | ${money(getProductPrice(product, ''), product.currency || currency())} | 📦 ${(product.stock || []).length}`;
}

function premiumAlertHighlights(product, max = 4) {
  const desc = String(product.description || '').split('\n').map(x => x.trim()).filter(Boolean);
  const picked = desc
    .filter(x => /^✅|^•|^-/.test(x) || /warranty|activation|access|credit|month|storage|delivery|redeem/i.test(x))
    .map(x => x.replace(/^[✅•\-\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
  const fallback = [
    'Instant checkout from bot',
    'Automatic delivery after payment confirmation',
    'Limited stock available',
    'Support available for order issues'
  ];
  return (picked.length ? picked : fallback).slice(0, max).map(x => `✅ ${escapeHtml(x)}`).join('\n');
}

function defaultStockAlertText(product, addedCount = 0) {
  const price = money(getProductPrice(product, ''), product.currency || currency());
  const link = productDeepLink(product.code);
  return `📊 <b>${escapeHtml(addedCount || 0)} new stock added for ${escapeHtml(product.name)}!</b>\n\n` +
    `🌀 <b>Available:</b> ${(product.stock || []).length} items\n` +
    `💐 <b>Price:</b> ${price}\n\n` +
    `${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b> is live now.\n` +
    `⚡ <b>Fresh stock just arrived — grab before it ends.</b>\n\n` +
    `✨ <b>Highlights:</b>\n${premiumAlertHighlights(product, 3)}\n\n` +
    `${link ? `🛒 <b>Buy Link:</b> <a href="${escapeHtml(link)}">Tap here to buy now</a>\n` : ''}` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🚀 <b>${escapeHtml(db.settings.alertFooterText || 'Fast checkout • Auto delivery • Premium support')}</b>`;
}

function defaultGroupReplyText(product, trigger = '') {
  const price = money(getProductPrice(product, ''), product.currency || currency());
  const link = productDeepLink(product.code);
  const sale = activeFlashSale(product);
  return `${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b>\n\n` +
    `${sale ? '🚨 <b>FLASH DEAL ACTIVE</b>\n' : '🔥 <b>LOW RATE DEAL LIVE</b>\n'}` +
    `💰 <b>Price:</b> ${price}\n` +
    `${sale ? `💸 <b>Old Price:</b> <s>${money(product.price, product.currency || currency())}</s>\n` : ''}` +
    `📦 <b>Stock:</b> ${(product.stock || []).length} left\n` +
    `${bulkPricingText(product) ? `📦 <b>Bulk Pricing:</b>\n${escapeHtml(bulkPricingText(product))}\n` : ''}` +
    `\n✨ <b>What You Get:</b>\n${premiumAlertHighlights(product, 5)}\n\n` +
    `${link ? `🛒 <b>Buy Now:</b> <a href="${escapeHtml(link)}">Open product in bot</a>\n` : ''}` +
    `🤖 <b>Bot:</b> @${escapeHtml(getBotUsername() || botUsername || 'YourBotUsername')}` +
    `${trigger ? `\n\n🔎 Matched: <b>${escapeHtml(trigger)}</b>` : ''}`;
}

function defaultFlashSaleText(product) {
  const sale = activeFlashSale(product);
  const salePrice = sale ? Number(sale.price) : Number(getProductPrice(product, ''));
  const stock = (product.stock || []).length;
  const link = productDeepLink(product.code);
  const old = Number(product.price || 0);
  const discountPct = old && salePrice && salePrice < old ? Math.round(((old - salePrice) / old) * 100) : 0;
  return `🚨 <b>FLASH SALE LIVE — LIMITED TIME</b> 🚨\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b>\n\n` +
    `💸 <b>Old Price:</b> <s>${money(product.price, product.currency || currency())}</s>\n` +
    `🔥 <b>New Price:</b> ${money(salePrice, product.currency || currency())}${discountPct ? `  (${discountPct}% OFF)` : ''}\n` +
    `📦 <b>Stock Left:</b> ${stock}\n` +
    `⏰ <b>Price Changes:</b> ${escapeHtml(sale?.endsAt ? new Date(sale.endsAt).toLocaleString() : 'Soon')}\n\n` +
    `${sale?.note ? `📢 <b>Note:</b> ${escapeHtml(sale.note)}\n\n` : ''}` +
    `✨ <b>Deal Benefits:</b>\n${premiumAlertHighlights(product, 4)}\n\n` +
    `${link ? `🛒 <b>Buy Link:</b> <a href="${escapeHtml(link)}">Tap here and grab fast</a>\n` : ''}` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>Fast buyers win. Stock and price can change anytime.</b>`;
}

function premiumAlertPreviewText(product, addedCount = 10) {
  return `🎨 <b>Premium Alert Preview</b>\n\n<b>Stock Alert:</b>\n${premiumStockAlertText(product, addedCount)}\n\n<b>Flash Sale:</b>\n${flashSaleText(product)}`;
}


function splitDetailsForPremium(raw = '') {
  const lines = String(raw || '')
    .split(/\n|;/)
    .map(x => x.trim())
    .filter(Boolean);

  const out = { details: [], requirements: [], redeem: [], note: [], warranty: [], delivery: [] };
  let section = 'details';
  for (let line of lines) {
    const lower = line.toLowerCase().replace(/[:：]/g, '').trim();
    if (/^(requirements?|requirement|req)$/i.test(lower)) { section = 'requirements'; continue; }
    if (/^(how to redeem|redeem|activation|activate|steps?)$/i.test(lower)) { section = 'redeem'; continue; }
    if (/^(note|notes|important)$/i.test(lower)) { section = 'note'; continue; }
    if (/^(warranty|guarantee)$/i.test(lower)) { section = 'warranty'; continue; }
    if (/^(delivery|delivery type)$/i.test(lower)) { section = 'delivery'; continue; }
    line = line.replace(/^[-•*]\s*/, '').trim();
    if (!line) continue;

    if (/^(req|requirement):/i.test(line)) out.requirements.push(line.split(':').slice(1).join(':').trim());
    else if (/^(how|redeem|step):/i.test(line)) out.redeem.push(line.split(':').slice(1).join(':').trim());
    else if (/^(note|important):/i.test(line)) out.note.push(line.split(':').slice(1).join(':').trim());
    else if (/^(warranty|guarantee):/i.test(line)) out.warranty.push(line.split(':').slice(1).join(':').trim());
    else if (/^(delivery):/i.test(line)) out.delivery.push(line.split(':').slice(1).join(':').trim());
    else out[section].push(niceLine(line));
  }
  return out;
}

function stockFormatShort(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'redeem_link') return 'redeem link';
  if (f === 'id_password') return 'id password';
  if (f === 'coupon_code') return 'code';
  if (isCustomDeliveryFormat(format)) return deliveryTemplateFromFormat(format);
  return 'code';
}

function cleanBulletText(x = '') {
  return niceLine(String(x || '').replace(/^[✅✔️•\-–—*\s]+/, '').trim());
}

function detectProductBenefits(name = '', stockFormat = '') {
  const n = String(name || '').toLowerCase();
  const benefits = [];
  if (/chatgpt|gpt|openai/.test(n)) benefits.push('ChatGPT Plus/AI tools access for productivity, writing, study and business use');
  if (/gemini|google/.test(n)) benefits.push('Google AI/Gemini benefits with smooth activation and easy redeem process');
  if (/adobe|photoshop|premiere|creative/.test(n)) benefits.push('Creative tools access for editing, design, video and content creation');
  if (/coursera|udemy|learning|course/.test(n)) benefits.push('Learning access for skill building, certificates and professional growth');
  if (/canva|figma|design/.test(n)) benefits.push('Design and editing features for posts, posters, presentations and branding');
  if (/cursor|replit|github|code|dev/.test(n)) benefits.push('Developer-friendly tools for coding, projects and faster workflow');
  if (/spotify|netflix|youtube|ott|prime|disney/.test(n)) benefits.push('Entertainment or premium streaming access at low cost');
  if (!benefits.length) benefits.push('Premium digital product with fast checkout and smooth delivery');
  if (isCustomDeliveryFormat(stockFormat)) benefits.push(`Delivery format supported: ${deliveryTemplateFromFormat(stockFormat)}`);
  else benefits.push(`Delivery format supported: ${stockFormatShort(stockFormat)}`);
  return benefits;
}

function smartProductDescription(name, shortDetails, stockFormat = '') {
  const parts = splitDetailsForPremium(shortDetails);
  const icon = premiumIconForName(name);
  const cleanName = String(name || 'Premium Product').trim();
  const details = parts.details.length ? parts.details.map(cleanBulletText).filter(Boolean) : detectProductBenefits(cleanName, stockFormat);

  let out = `💎 Product Overview\n`;
  out += `✅ ${cleanName} is available with instant checkout and clean delivery flow.\n`;
  out += details.slice(0, 10).map(x => `✅ ${x}`).join('\n');

  out += `\n\n🔥 Key Benefits\n`;
  const benefits = detectProductBenefits(cleanName, stockFormat).filter(x => !details.includes(x));
  const keyBenefits = [
    ...benefits,
    'Fast support for order/payment related help',
    'Professional delivery message with copy/share buttons',
    'Best for single buyers and bulk/reseller orders'
  ];
  out += keyBenefits.slice(0, 8).map(x => `✅ ${x}`).join('\n');

  if (parts.warranty.length) {
    out += `\n\n🛡 Warranty / Policy\n` + parts.warranty.slice(0, 8).map(x => `✅ ${cleanBulletText(x)}`).join('\n');
  } else {
    out += `\n\n🛡 Warranty / Policy\n✅ Warranty/replacement depends on seller policy mentioned with product\n✅ Please check all details before placing order\n✅ For any issue, contact support with Order ID`;
  }

  if (parts.requirements.length) {
    out += `\n\n⚠️ Requirements\n` + parts.requirements.slice(0, 8).map(x => `• ${cleanBulletText(x)}`).join('\n');
  } else {
    out += `\n\n⚠️ Requirements\n• Use correct email/account if activation is required\n• Read delivery format carefully before using stock details\n• Keep your order ID safe for support`;
  }

  if (parts.redeem.length) {
    out += `\n\n🛠 How to Use / Redeem\n`;
    out += parts.redeem.slice(0, 10).map(x => `▌ ${cleanBulletText(x)}`).join('\n');
  } else {
    out += `\n\n🛠 How to Use / Redeem\n▌ Complete payment from bot\n▌ Wait for verification/approval\n▌ Bot will send delivery details automatically\n▌ Use the delivered link/code/login details as per format`;
  }

  if (parts.note.length) {
    out += `\n\n⚡ Important Notes\n` + parts.note.slice(0, 8).map(x => `• ${cleanBulletText(x)}`).join('\n');
  } else {
    out += `\n\n⚡ Important Notes\n• Delivery is automatic after payment confirmation\n• Do not share private delivery details publicly\n• Bulk quantity buyers can contact support for special pricing`;
  }

  out += `\n\n${icon} Delivery Format: ${stockFormatShort(stockFormat)}`;
  out += `\n<i>Secure checkout • Fast delivery • Premium support</i>`;
  return out;
}

function formatRichProductDescription(desc = '') {
  let safe = escapeHtml(String(desc || '').trim());
  if (!safe) return '';
  const lines = safe.split('\n').map(line => {
    const t = line.trim();
    if (/^(💎 Product Overview|📦 Product Details|🔥 Key Benefits|⚠️ Requirements|🛠 How to Use|🛠 How to Redeem|⚡ Important Notes|⚡ Note|🛡 Warranty|🛡 Warranty \/ Policy|✅ Activation|🔥 Offer|💎 Benefits)/i.test(t)) return `<b>${t}</b>`;
    if (/^▌/.test(t)) return `<blockquote>${t.replace(/^▌\s*/, '')}</blockquote>`;
    return line;
  });
  return lines.join('\n');
}

function premiumProductCard(product, uid = '') {
  const p = product;
  const icon = productLogo(p);
  const price = priceLabel(p, uid);
  const fmt = stockFormatShort(p.stockFormat || 'coupon_code');
  const rating = typeof productRatingSummary === 'function' ? productRatingSummary(p.code) : { count: 0, avg: 0 };
  const ratingLine = rating.count ? `\n⭐ <b>Rating:</b> ${rating.avg}/5 (${rating.count} reviews)` : '';
  const statusLine = (p.stock || []).length > 0 ? '✅ Available' : '⚠️ Out of Stock';
  const categoryLine = `\n🗂 <b>Category:</b> ${escapeHtml(cleanCategory(p.category || 'General'))}`;
  const tagsLine = productTags(p).length ? `\n🏷 <b>Tags:</b> ${escapeHtml(productTags(p).slice(0, 5).join(', '))}` : '';
  const bulkLine = bulkPricingText(p) ? `\n\n📦 <b>Bulk Order Pricing:</b>\n${escapeHtml(bulkPricingText(p))}` : '';
  const saleLine = activeFlashSale(p) ? `\n⚡ <b>Sale Ends:</b> ${escapeHtml(new Date(activeFlashSale(p).endsAt || Date.now()).toLocaleString())}` : '';
  const generatedDesc = (!p.description && db.settings.autoDetailedDescriptions !== false) ? smartProductDescription(p.name, p.shortDetails || '', p.stockFormat || '') : '';
  const desc = (p.description || generatedDesc) ? `\n\n${formatRichProductDescription(p.description || generatedDesc)}` : '';

  return `${productLogoHtml(p)} <b>${escapeHtml(p.name)}</b>\n\n` +
    `🎯 <b>Logo/Icon:</b> ${productLogoHtml(p)}\n` +
    `👜 <b>Price:</b> ${price} / ${escapeHtml(fmt)}\n` +
    `📦 <b>Available Stock:</b> ${(p.stock || []).length}\n` +
    `🚦 <b>Status:</b> ${statusLine}${categoryLine}${tagsLine}${ratingLine}${saleLine}` +
    `${bulkLine}${desc}`;
}

function premiumGroupProductReply(product, trigger = '') {
  const custom = productCustomPromo(product, trigger);
  if (custom) return custom;
  const template = String(product?.customGroupReplyTemplate || db.settings.premiumGroupReplyTemplate || '').trim();
  if (template) return renderPremiumTemplate(template, product, { trigger }) + (trigger ? `

🔎 Matched: <b>${escapeHtml(trigger)}</b>` : '');
  return premiumGroupKeyboardReplyText(product, trigger);
}

function premiumStockAlertText(product, addedCount = 0) {
  const template = String(product?.customStockAlertTemplate || db.settings.premiumStockAlertTemplate || '').trim();
  if (template) return renderPremiumTemplate(template, product, { added: addedCount, addedCount });
  return defaultStockAlertText(product, addedCount);
}

function premiumPurchaseAlert(order, product) {
  const icon = product ? productLogo(product) : premiumIconForName(order?.productName || '');
  return `🛒 <b>SOMEONE JUST BOUGHT!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${product ? productLogoHtml(product) : escapeHtml(icon)} <b>${escapeHtml(order.productName)}</b>\n\n` +
    `📦 <b>Quantity:</b> ${escapeHtml(order.qty || 1)}×\n` +
    `💰 <b>Amount:</b> ${money(order.total, order.currency)}\n` +
    `🚀 <b>Delivery:</b> Completed Automatically\n` +
    `📊 <b>Stock Left:</b> ${product ? (product.stock || []).length : '-'}\n\n` +
    `✨ <b>Premium service is live — tap below to buy yours.</b>`;
}


function isGroupChat(chat = {}) {
  return ['group', 'supergroup'].includes(String(chat.type || '').toLowerCase());
}

function groupTitle(chat = {}) {
  return String(chat.title || chat.username || chat.id || 'Group').trim();
}

function normalizeChatId(id) {
  return String(id || '').trim();
}

function findAlertGroup(chatId) {
  const id = normalizeChatId(chatId);
  db.alertGroups ||= [];
  return db.alertGroups.find(g => String(g.id) === id) || null;
}

function registerAlertGroup(chat = {}, meta = {}) {
  if (!isGroupChat(chat)) return null;
  db.alertGroups ||= [];
  const id = normalizeChatId(chat.id);
  if (!id) return null;

  let g = findAlertGroup(id);
  const isNew = !g;
  if (!g) {
    g = {
      id,
      title: groupTitle(chat),
      type: String(chat.type || 'group'),
      username: chat.username || '',
      active: true,
      alertsEnabled: true,
      keywordReplyEnabled: true,
      autoRegistered: meta.auto !== false,
      addedBy: String(meta.addedBy || ''),
      registeredAt: now(),
      lastSeenAt: now(),
      lastAlertAt: '',
      sentCount: 0,
      failCount: 0,
      lastError: ''
    };
    db.alertGroups.unshift(g);
  } else {
    g.title = groupTitle(chat) || g.title;
    g.type = String(chat.type || g.type || 'group');
    g.username = chat.username || g.username || '';
    g.active = g.active === false ? false : true;
    if (g.alertsEnabled !== false) g.alertsEnabled = true;
    if (g.keywordReplyEnabled !== false) g.keywordReplyEnabled = true;
    g.lastSeenAt = now();
    g.leftAt = '';
  }
  saveData();
  if (isNew) console.log(`✅ Auto registered alert group: ${g.title} (${g.id})`);
  return g;
}

function deactivateAlertGroup(chatId, reason = 'bot_left') {
  const g = findAlertGroup(chatId);
  if (!g) return null;
  g.active = false;
  g.leftAt = now();
  g.lastError = reason;
  saveData();
  return g;
}

function activeAlertGroups() {
  db.alertGroups ||= [];
  return db.alertGroups.filter(g => g && g.active !== false && g.alertsEnabled !== false);
}

function groupAlertLog(type, groupId, message = '', data = {}) {
  db.groupAlertLogs ||= [];
  db.groupAlertLogs.unshift({
    id: 'GAL' + Date.now() + Math.floor(Math.random() * 999),
    type,
    groupId: String(groupId || ''),
    message: String(message || '').slice(0, 500),
    data,
    at: now()
  });
  db.groupAlertLogs = db.groupAlertLogs.slice(0, 300);
  saveData();
}

function groupListText(limit = 25) {
  const groups = db.alertGroups || [];
  let out = `👥 <b>Registered Alert Groups</b>\n\n`;
  out += `Total: <b>${groups.length}</b>\nActive Alerts: <b>${activeAlertGroups().length}</b>\nAuto Register: <b>${db.settings.autoRegisterGroups === false ? 'OFF' : 'ON'}</b>\nGroup Alerts: <b>${db.settings.groupAlertsEnabled === false ? 'OFF' : 'ON'}</b>\n\n`;
  if (!groups.length) {
    out += `No groups registered yet.\n\nAdd bot to group and it will auto-register.`;
    return out;
  }
  groups.slice(0, limit).forEach((g, i) => {
    out += `${i + 1}. ${g.active === false ? '🔴' : '🟢'} <b>${escapeHtml(g.title || 'Group')}</b>\n`;
    out += `ID: <code>${escapeHtml(g.id)}</code>\n`;
    out += `Alerts: <b>${g.alertsEnabled === false ? 'OFF' : 'ON'}</b> | Keyword: <b>${g.keywordReplyEnabled === false ? 'OFF' : 'ON'}</b>\n`;
    out += `Sent: <b>${g.sentCount || 0}</b> | Last: ${escapeHtml(g.lastAlertAt ? new Date(g.lastAlertAt).toLocaleString() : '-')}\n\n`;
  });
  if (groups.length > limit) out += `...and ${groups.length - limit} more in web panel.`;
  return out;
}

function groupManagerButtons() {
  const rows = [
    [
      { text: db.settings.autoRegisterGroups === false ? '✅ Auto Register ON' : '⛔ Auto Register OFF', callback_data: 'groups_toggle_autoreg' },
      { text: db.settings.groupAlertsEnabled === false ? '✅ Alerts ON' : '⛔ Alerts OFF', callback_data: 'groups_toggle_alerts' }
    ],
    [
      { text: db.settings.groupKeywordReplyEnabled === false ? '✅ Keyword Reply ON' : '⛔ Keyword Reply OFF', callback_data: 'groups_toggle_keyword' },
      { text: '🧪 Test All Groups', callback_data: 'groups_test_all' }
    ]
  ];
  (db.alertGroups || []).slice(0, 10).forEach(g => {
    rows.push([
      { text: `${g.alertsEnabled === false ? '🔕' : '🔔'} ${short(g.title || g.id, 24)}`, callback_data: `group_toggle:${g.id}` },
      { text: '🧪 Test', callback_data: `group_test:${g.id}` }
    ]);
  });
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return inline(rows);
}

function groupCommandHelpText(chat = {}) {
  return `👥 <b>Group Auto Alert System</b>\n\nThis group is registered for store alerts.\n\nGroup: <b>${escapeHtml(groupTitle(chat))}</b>\nGroup ID: <code>${escapeHtml(chat.id)}</code>\n\nWhen stock/flash sale is posted, this group can receive premium alerts with buy button.`;
}

async function sendToRegisteredGroups(message, replyMarkup, type = 'alert', productCode = '') {
  if (db.settings.groupAlertsEnabled === false) return 0;
  const groups = activeAlertGroups();
  let sent = 0;
  const cooldownMs = Number(db.settings.groupAlertCooldownMinutes || 10) * 60 * 1000;

  for (const g of groups) {
    try {
      if (cooldownMs > 0 && g.lastAlertAt && Date.now() - Date.parse(g.lastAlertAt) < cooldownMs && type !== 'test') {
        continue;
      }
      await sendMessage(g.id, message, replyMarkup);
      g.sentCount = Number(g.sentCount || 0) + 1;
      g.lastAlertAt = now();
      g.lastError = '';
      groupAlertLog(type, g.id, 'sent', { productCode });
      sent++;
      await new Promise(r => setTimeout(r, 180));
    } catch (err) {
      g.failCount = Number(g.failCount || 0) + 1;
      g.lastError = err.message;
      groupAlertLog(type + '_failed', g.id, err.message, { productCode });
      if (/bot was kicked|chat not found|forbidden|not enough rights/i.test(String(err.message))) {
        g.active = false;
        g.leftAt = now();
      }
    }
  }
  saveData();
  return sent;
}

function groupKeywordCooldownKey(groupId, productCode) {
  return `${groupId}:${productCode}`;
}

function canGroupKeywordReply(groupId, productCode) {
  db.groupKeywordCooldowns ||= {};
  const key = groupKeywordCooldownKey(groupId, productCode);
  const last = Number(db.groupKeywordCooldowns[key] || 0);
  const cooldownMs = Math.max(1, Number(db.settings.groupKeywordCooldownMinutes || 3)) * 60 * 1000;
  if (Date.now() - last < cooldownMs) return false;
  db.groupKeywordCooldowns[key] = Date.now();
  saveData();
  return true;
}

async function maybeHandleGroupText(msg) {
  const chat = msg.chat || {};
  if (!isGroupChat(chat)) return false;
  if (db.settings.autoRegisterGroups !== false) registerAlertGroup(chat, { addedBy: msg.from?.id, auto: true });

  const textValue = msg.text || msg.caption || '';
  const cmd = String(textValue || '').split(/\s+/)[0].split('@')[0].toLowerCase();

  if (cmd === '/groupid') {
    return sendMessage(chat.id, groupCommandHelpText(chat));
  }
  if (cmd === '/registergroup') {
    const g = registerAlertGroup(chat, { addedBy: msg.from?.id, auto: false });
    if (g) {
      g.active = true;
      g.alertsEnabled = true;
      saveData();
    }
    return sendMessage(chat.id, `✅ <b>Group Registered</b>\n\n${groupCommandHelpText(chat)}`);
  }
  if (cmd === '/alertoff') {
    const g = registerAlertGroup(chat, { addedBy: msg.from?.id, auto: false });
    g.alertsEnabled = false;
    saveData();
    return sendMessage(chat.id, '🔕 Group alerts are now OFF.');
  }
  if (cmd === '/alerton') {
    const g = registerAlertGroup(chat, { addedBy: msg.from?.id, auto: false });
    g.alertsEnabled = true;
    g.active = true;
    saveData();
    return sendMessage(chat.id, '🔔 Group alerts are now ON.');
  }
  if (cmd === '/keywordoff') {
    const g = registerAlertGroup(chat, { addedBy: msg.from?.id, auto: false });
    g.keywordReplyEnabled = false;
    saveData();
    return sendMessage(chat.id, '🔕 Keyword auto reply is now OFF for this group.');
  }
  if (cmd === '/keywordon') {
    const g = registerAlertGroup(chat, { addedBy: msg.from?.id, auto: false });
    g.keywordReplyEnabled = true;
    saveData();
    return sendMessage(chat.id, '🔎 Keyword auto reply is now ON for this group.');
  }

  if (String(textValue || '').startsWith('/')) return false;
  if (db.settings.groupKeywordReplyEnabled === false || db.settings.groupAutoReplyEnabled === false) return false;
  const g = findAlertGroup(chat.id);
  if (db.settings.groupReplyOnlyRegisteredGroups === true && !g) return false;
  if (g && g.keywordReplyEnabled === false) return false;

  const rule = findChannelRuleByText(textValue);
  if (!rule) return false;
  const product = productByCode(rule.productCode);
  if (!product || product.active === false) return false;
  if (!canGroupKeywordReply(chat.id, product.code)) return true;

  try {
    product.groupReplyCount = Number(product.groupReplyCount || 0) + 1;
    product.lastGroupReplyAt = now();
    if (g) {
      g.lastKeywordAt = now();
      g.lastKeywordProduct = product.code;
    }
    saveData();

    await tg('sendMessage', {
      chat_id: chat.id,
      text: premiumGroupProductReply(product, rule.matchedKeyword || rule.keywords || textValue),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: msg.message_id,
      reply_markup: directBuyKeyboard(product, 'group')
    });
    return true;
  } catch (err) {
    console.error('Group keyword reply failed:', err.message);
    return false;
  }
}

async function handleMembershipUpdate(update) {
  const my = update.my_chat_member || update.chat_member;
  if (!my) return false;
  const chat = my.chat || {};
  if (!isGroupChat(chat)) return false;

  const newStatus = String(my.new_chat_member?.status || '').toLowerCase();
  const oldStatus = String(my.old_chat_member?.status || '').toLowerCase();

  if (['member', 'administrator'].includes(newStatus)) {
    const g = registerAlertGroup(chat, { addedBy: my.from?.id, auto: true });
    if (db.settings.groupWelcomeOnRegister !== false) {
      try {
        await sendMessage(chat.id, `✅ <b>Bot connected to group</b>\n\nThis group has been auto-added to alert groups.\n\nUse <code>/groupid</code> to see ID.\nUse <code>/alertoff</code> to stop alerts.\nUse <code>/keywordoff</code> to stop keyword replies.`);
      } catch (_) {}
    }
    return true;
  }

  if (['left', 'kicked'].includes(newStatus) || ['member','administrator'].includes(oldStatus) && ['left','kicked'].includes(newStatus)) {
    deactivateAlertGroup(chat.id, 'bot_left_or_removed');
    return true;
  }
  return false;
}

async function handleGroupServiceMessage(msg) {
  const chat = msg.chat || {};
  if (!isGroupChat(chat)) return false;

  if (msg.new_chat_members?.length) {
    const meName = (getBotUsername() || botUsername || '').toLowerCase();
    const botAdded = msg.new_chat_members.some(m => m.is_bot && (!meName || String(m.username || '').toLowerCase() === meName));
    if (botAdded) {
      registerAlertGroup(chat, { addedBy: msg.from?.id, auto: true });
      if (db.settings.groupWelcomeOnRegister !== false) {
        await sendMessage(chat.id, `✅ <b>Group Auto-Registered</b>\n\nGroup: <b>${escapeHtml(groupTitle(chat))}</b>\nID: <code>${escapeHtml(chat.id)}</code>\n\nStock alerts and flash sale alerts can now be sent here.`);
      }
      return true;
    }
  }

  if (msg.left_chat_member?.is_bot) {
    deactivateAlertGroup(chat.id, 'bot_removed');
    return true;
  }

  if (db.settings.autoRegisterGroups !== false) {
    registerAlertGroup(chat, { addedBy: msg.from?.id, auto: true });
  }
  return false;
}


function configuredChannels() {
  const raw = String(db.settings.channelIds || db.settings.channelUrl || CHANNEL_URL || '').trim();
  if (!raw) return [];
  return raw.split(/[\n,]+/).map(x => x.trim()).filter(Boolean).map(x => {
    if (/^-?\d+$/.test(x)) return x;
    if (x.includes('t.me/')) return '@' + x.split('t.me/').pop().replace('/', '').trim();
    if (x.startsWith('@')) return x;
    return '@' + x;
  });
}

function productDeepLink(productCode) {
  const user = getBotUsername() || botUsername || BOT_USERNAME || '';
  return user ? `https://t.me/${user}?start=buy_${productCode}` : '';
}

function channelBuyButtons(product) {
  return directBuyKeyboard(product, 'public');
}

function productPromoForChannel(product, trigger = '') {
  return premiumGroupProductReply(product, trigger);
}

async function sendToConfiguredChannels(message, replyMarkup) {
  if (db.settings.channelAlertsEnabled === false) return 0;
  const chans = configuredChannels();
  let sent = 0;
  for (const ch of chans) {
    try {
      await sendMessage(ch, message, replyMarkup);
      sent++;
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      console.error('Channel send failed:', ch, err.message);
    }
  }
  return sent;
}


function productKeywordList(product) {
  const raw = [
    product?.name || '',
    product?.code || '',
    product?.category || '',
    Array.isArray(product?.tags) ? product.tags.join(',') : product?.tags || '',
    product?.groupKeywords || ''
  ].join(',');

  const words = new Set();
  String(raw).split(/[,|\n]+/).forEach(x => {
    const s = String(x || '').trim().toLowerCase();
    if (s) words.add(s);
  });

  String(product?.name || '').toLowerCase().split(/[^a-z0-9+]+/i)
    .filter(w => w.length >= 3)
    .forEach(w => words.add(w));

  // Common aliases
  const n = String(product?.name || '').toLowerCase();
  if (/chatgpt|gpt|openai/.test(n)) ['chatgpt','gpt','openai','plus','chatgpt plus'].forEach(x => words.add(x));
  if (/gemini|google/.test(n)) ['gemini','google ai','google one','5tb','18 months','gemini pro'].forEach(x => words.add(x));
  if (/notion/.test(n)) ['notion','notion plus','notion pro'].forEach(x => words.add(x));
  if (/lovable/.test(n)) ['lovable','lovable pro','ai website'].forEach(x => words.add(x));
  if (/coursera/.test(n)) ['coursera','course','learning'].forEach(x => words.add(x));
  if (/canva/.test(n)) ['canva','canva pro','design'].forEach(x => words.add(x));
  if (/adobe/.test(n)) ['adobe','photoshop','premiere','creative cloud'].forEach(x => words.add(x));
  return [...words].filter(x => x.length >= 2);
}

function keywordMatchScore(message = '', product) {
  const msg = String(message || '').toLowerCase();
  if (!msg || !product) return { score: 0, keyword: '' };
  const keywords = productKeywordList(product);
  let best = { score: 0, keyword: '' };

  for (const kw of keywords) {
    if (!kw) continue;
    let score = 0;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (msg === kw) score = 100;
    else if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(msg)) score = 80;
    else if (kw.length >= 5 && msg.includes(kw)) score = 55;
    else if (kw.length >= 4 && msg.includes(kw.replace(/\s+/g, ''))) score = 35;
    if (score > best.score) best = { score, keyword: kw };
  }
  return best;
}

function findProductByKeywordText(textValue = '') {
  const candidates = activeProducts().map(p => ({ product: p, ...keywordMatchScore(textValue, p) }))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score || (b.product.stock || []).length - (a.product.stock || []).length);
  return candidates[0] || null;
}

function directBuyKeyboard(product, mode = 'group') {
  const link = productDeepLink(product.code);
  const bot = getBotUsername() || botUsername || BOT_USERNAME || '';
  const rows = [];
  if (link) {
    rows.push([styleButton({ text: `🛒 Buy ${short(product.name, 30)}`, url: link, ...buttonIconFields(product) }, 'success')]);
    rows.push([{ text: '⚡ Direct Buy Link', url: link }]);
  }
  if (db.settings.groupReplyWithShopButton !== false && bot) rows.push([{ text: '🛍 Open Full Store', url: `https://t.me/${bot}?start=shop` }]);
  if (db.settings.groupReplyWithSupportButton !== false && db.settings.supportUsername) rows.push([{ text: '💬 Support', url: `https://t.me/${String(db.settings.supportUsername).replace('@','')}` }]);
  return inline(rows.length ? rows : [[{ text: '🤖 Open Bot', url: `https://t.me/${bot}` }]]);
}

function premiumGroupKeyboardReplyText(product, trigger = '', requester = '') {
  const price = money(getProductPrice(product, ''), product.currency || currency());
  const stock = (product.stock || []).length;
  const link = productDeepLink(product.code);
  const sale = activeFlashSale(product);

  let out = `${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b>\n`;
  out += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += sale ? `🚨 <b>FLASH SALE ACTIVE</b>\n` : `🔥 <b>AVAILABLE NOW</b>\n`;
  out += `💰 <b>Price:</b> ${price}\n`;
  if (sale) out += `💸 <b>Old Price:</b> <s>${money(product.price, product.currency || currency())}</s>\n`;
  out += `📦 <b>Stock:</b> ${stock} left\n`;
  if (bulkPricingText(product)) out += `📊 <b>Bulk Price:</b>\n${escapeHtml(bulkPricingText(product))}\n`;
  out += `\n✨ <b>Highlights:</b>\n${premiumAlertHighlights(product, 4)}\n\n`;
  if (link) out += `🔗 <b>Direct Buy:</b> <a href="${escapeHtml(link)}">Tap here to buy this product</a>\n`;
  out += `🤖 <b>Bot:</b> @${escapeHtml(getBotUsername() || botUsername || 'YourBotUsername')}`;
  if (trigger) out += `\n\n🔎 Matched keyword: <b>${escapeHtml(trigger)}</b>`;
  if (requester) out += `\n👤 Requested by: ${escapeHtml(requester)}`;
  return out;
}

function groupReplyStatsText(product) {
  return `🔎 <b>Group Reply Setup</b>\n\n${productLogoHtml(product)} <b>${escapeHtml(product.name)}</b>\nCode: <code>${escapeHtml(product.code)}</code>\n\nKeywords:\n<code>${escapeHtml(productKeywordList(product).slice(0, 60).join(', '))}</code>\n\nReplies Sent: <b>${Number(product.groupReplyCount || 0)}</b>`;
}


function findChannelRuleByText(textValue) {
  const msg = String(textValue || '').toLowerCase();

  // 1) Manual channel/group rules first
  const rules = (db.channelRules || []).filter(r => r.active !== false);
  for (const r of rules) {
    const keywords = String(r.keywords || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const hit = keywords.find(k => msg.includes(k));
    if (hit) return { ...r, matchedKeyword: hit };
  }

  // 2) Product group keywords / aliases
  const match = findProductByKeywordText(textValue);
  if (match?.product) {
    return {
      productCode: match.product.code,
      keywords: match.keyword || match.product.name,
      matchedKeyword: match.keyword || match.product.name,
      score: match.score,
      active: true,
      auto: true
    };
  }
  return null;
}

function nextChannelRuleId() {
  return 'CHR' + Date.now();
}

function channelRuleRows() {
  const rows = (db.channelRules || []);
  if (!rows.length) return 'No channel keyword rules yet.';
  return rows.map(r => `${r.active === false ? 'OFF' : 'ON'} | ${r.id} | ${r.keywords} → ${r.productCode}`).join('\n');
}

async function handleChannelPost(post) {
  if (db.settings.channelAutoReplyEnabled === false) return;
  const chat = post.chat || {};
  const textValue = post.text || post.caption || '';
  if (!textValue) return;

  const rule = findChannelRuleByText(textValue);
  if (!rule) return;

  const product = productByCode(rule.productCode);
  if (!product || product.active === false) return;

  try {
    await tg('sendMessage', {
      chat_id: chat.id,
      text: productPromoForChannel(product, rule.keywords || ''),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: post.message_id,
      reply_markup: channelBuyButtons(product)
    });
  } catch (err) {
    console.error('Channel auto reply failed:', err.message);
  }
}

async function testChannelSend(chatId) {
  const chans = configuredChannels();
  if (!chans.length) return sendMessage(chatId, '❌ No channel configured. Add channel username/ID in Bot Settings.', adminButtons());
  const msg = `✅ <b>${escapeHtml(STORE_NAME)} Channel Test</b>\n\nIf you see this message, channel notification is working.\n\nBot must be admin in the channel with permission to post messages.`;
  const sent = await sendToConfiguredChannels(msg, inline([[{ text: '🤖 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
  return sendMessage(chatId, `📢 Channel test completed.\n\nConfigured: ${chans.length}\nSent: ${sent}\n\nIf sent is 0, add bot as channel admin and check channel username/ID.`, adminButtons());
}


function generateDescriptionPack(name, shortDetails = '', opts = {}) {
  const price = opts.price ? Number(opts.price) : 0;
  const botUser = opts.botUsername || getBotUsername() || process.env.BOT_USERNAME || '';
  const base = smartProductDescription(name, shortDetails, opts.stockFormat || '');
  const cleanName = String(name || 'Premium Product').trim();
  const icon = premiumIconForName(cleanName);
  const priceLine = price ? `\n💰 Price: ${money(price)}` : '';
  const botLine = botUser ? `@${botUser}` : STORE_NAME;

  const groupPromo = `🚨 FLASH SALE — LIMITED STOCK 🚨\n\n${icon} ${cleanName}\n${priceLine}\n\n✨ What You Get:\n${base.split('\n').filter(x => x.startsWith('✅')).slice(0, 7).join('\n') || '✅ Premium access\n✅ Smooth service\n✅ Fast delivery'}\n\n🛒 Buy from bot: ${botLine}\n⚡ Fast checkout • Auto delivery • Limited stock`;

  const shortPromo = `🔥 ${cleanName}${price ? ` — ${money(price)}` : ''}\n\n✅ Premium quality\n✅ Fast checkout\n✅ Auto delivery\n\n🛒 Buy: ${botLine}`;

  const stockAlert = `🆕 NEW STOCK ADDED\n\n${icon} ${cleanName}${priceLine}\n\n📦 Fresh stock live now\n⚡ Limited quantity available\n\n🛒 Buy fast: ${botLine}`;

  const purchaseAlert = `🛒 Someone just bought 1× ${cleanName}!\n\n${price ? `💰 Price: ${money(price)}\n` : ''}⚡ Auto delivery completed.`;

  return { description: base, groupPromo, shortPromo, stockAlert, purchaseAlert };
}

function segmentUsersForBroadcast(segment) {
  const users = Object.values(db.users || {});
  const buyers = new Set((db.orders || []).map(o => String(o.telegramId)));
  if (segment === 'buyers') return users.filter(u => buyers.has(String(u.telegramId)));
  if (segment === 'nonbuyers') return users.filter(u => !buyers.has(String(u.telegramId)));
  if (segment === 'wallet') return users.filter(u => Number(u.balance || 0) > 0);
  if (segment === 'notifications') return users.filter(u => u.notifications !== false);
  return users;
}

async function broadcastToSpecificUsers(users, text, replyMarkup) {
  let sent = 0;
  for (const user of users) {
    if (!user?.telegramId || user.notifications === false) continue;
    try {
      await sendMessage(user.telegramId, text, replyMarkup);
      sent++;
      await new Promise((r) => setTimeout(r, 120));
    } catch (_) {}
  }
  return sent;
}

async function broadcastSegmentAnnouncement(message, segment = 'all', buttonText = '🛍 Open Store') {
  const markup = inline([
    [{ text: buttonText, callback_data: 'shop:1' }],
    [{ text: '🌐 Channel', url: db.settings.channelUrl || CHANNEL_URL }]
  ]);
  return broadcastToSpecificUsers(segmentUsersForBroadcast(segment), premiumAnnouncementText(message), markup);
}


function addSecurityLog(type, userId = '', detail = {}, severity = 'info') {
  try {
    db.securityLogs ||= [];
    db.securityLogs.unshift({
      id: 'SEC' + Date.now() + Math.floor(Math.random() * 999),
      type: String(type || 'event'),
      userId: String(userId || ''),
      detail,
      severity,
      at: now()
    });
    db.securityLogs = db.securityLogs.slice(0, 500);
    saveData();
  } catch (_) {}
}

async function securityNotifyAdmins(message) {
  if (db.settings.securityAlertsToAdmins === false) return 0;
  return notifyAllAdmins(`🛡 <b>Security Alert</b>\n\n${message}`, adminButtons()).catch(() => 0);
}

function securityWindowKey(type, id, windowMs) {
  const bucket = Math.floor(Date.now() / Number(windowMs || 60000));
  return `${type}:${id}:${bucket}`;
}

function rateLimitHit(type, id, limit, windowMs, detail = {}) {
  if (db.settings.securityRateLimitEnabled === false) return false;
  db.securityCounters ||= {};
  const key = securityWindowKey(type, id, windowMs);
  db.securityCounters[key] = Number(db.securityCounters[key] || 0) + 1;

  if (Object.keys(db.securityCounters).length > 2000) {
    const nowMinute = Math.floor(Date.now() / 60000);
    for (const k of Object.keys(db.securityCounters)) {
      const bucket = Number(k.split(':').pop() || 0);
      if (Number.isFinite(bucket) && bucket < nowMinute - 120) delete db.securityCounters[k];
    }
  }
  saveData();
  const hit = db.securityCounters[key] > Number(limit || 10);
  if (hit) addSecurityLog('rate_limit_hit', id, { type, limit, count: db.securityCounters[key], ...detail }, 'warn');
  return hit;
}

function isUserSecurityLocked(userId) {
  const lock = db.securityLocks?.[String(userId)];
  if (!lock) return false;
  if (lock.until && Date.parse(lock.until) && Date.now() > Date.parse(lock.until)) {
    delete db.securityLocks[String(userId)];
    saveData();
    return false;
  }
  return true;
}

function lockUserSecurity(userId, reason = 'Suspicious activity', minutes = 60) {
  db.securityLocks ||= {};
  db.securityLocks[String(userId)] = {
    reason,
    lockedAt: now(),
    until: minutes ? new Date(Date.now() + Number(minutes) * 60000).toISOString() : '',
    minutes: Number(minutes || 0)
  };
  addSecurityLog('user_security_locked', userId, { reason, minutes }, 'high');
  saveData();
}

function unlockUserSecurity(userId) {
  if (db.securityLocks?.[String(userId)]) {
    delete db.securityLocks[String(userId)];
    addSecurityLog('user_security_unlocked', userId, {}, 'info');
    saveData();
  }
}

function securitySummary() {
  const logs = db.securityLogs || [];
  const locks = Object.keys(db.securityLocks || {}).filter(isUserSecurityLocked);
  const suspiciousPayments = (db.payments || []).filter(p =>
    (p.status === 'review' && String(p.lastCheckReason || '').toLowerCase().includes('security')) ||
    Number(p.failedVerifyAttempts || 0) >= Number(db.settings.paymentFailReviewThreshold || 5)
  );
  const txidDuplicates = {};
  (db.payments || []).filter(p => p.submittedReference).forEach(p => {
    const k = String(p.submittedReference || '').toLowerCase();
    txidDuplicates[k] ||= [];
    txidDuplicates[k].push(p);
  });
  const dupRefs = Object.values(txidDuplicates).filter(list => list.length > 1);
  return {
    logs,
    locks,
    suspiciousPayments,
    dupRefs,
    recentHigh: logs.filter(l => ['high','critical'].includes(l.severity)).slice(0, 20)
  };
}

function securityCenterText() {
  const s = securitySummary();
  let out = `🛡 <b>Security Center</b>\n\n`;
  out += `🔒 Locked Users: <b>${s.locks.length}</b>\n`;
  out += `⚠️ Suspicious Payments: <b>${s.suspiciousPayments.length}</b>\n`;
  out += `🔁 Duplicate TXID Groups: <b>${s.dupRefs.length}</b>\n`;
  out += `📜 Security Logs: <b>${s.logs.length}</b>\n`;
  out += `🚦 Rate Limit: <b>${db.settings.securityRateLimitEnabled === false ? 'OFF' : 'ON'}</b>\n\n`;

  const recent = s.logs.slice(0, 10);
  if (recent.length) {
    out += `<b>Recent Logs:</b>\n`;
    recent.forEach((l, i) => {
      out += `${i + 1}. ${l.severity === 'high' ? '🚨' : l.severity === 'warn' ? '⚠️' : 'ℹ️'} ${escapeHtml(l.type)}\nUser: <code>${escapeHtml(l.userId || '-')}</code> | ${escapeHtml(new Date(l.at).toLocaleString())}\n\n`;
    });
  } else out += '✅ No security logs yet.';
  return out;
}

function securityCenterButtons() {
  return inline([
    [
      { text: db.settings.securityRateLimitEnabled === false ? '🚦 Rate Limit ON' : '🚦 Rate Limit OFF', callback_data: 'security_toggle_rate' },
      { text: '📜 Logs', callback_data: 'security_logs' }
    ],
    [
      { text: '🔒 Locked Users', callback_data: 'security_locks' },
      { text: '🧹 Clear Old Logs', callback_data: 'security_clear_logs' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}

function txidAlreadyUsedElsewhere(txid, paymentId) {
  const ref = String(txid || '').trim().toLowerCase();
  if (!ref) return null;
  return (db.payments || []).find(p =>
    p.id !== paymentId &&
    String(p.submittedReference || '').trim().toLowerCase() === ref &&
    ['approved', 'pending', 'review'].includes(String(p.status || '').toLowerCase())
  ) || null;
}

function recordPaymentFail(payment, reason = '') {
  if (!payment) return;
  payment.failedVerifyAttempts = Number(payment.failedVerifyAttempts || 0) + 1;
  payment.lastFailedVerifyAt = now();
  const threshold = Number(db.settings.paymentFailReviewThreshold || 5);
  addSecurityLog('payment_verify_failed', payment.telegramId, { paymentId: payment.id, attempts: payment.failedVerifyAttempts, reason: short(reason, 160) }, payment.failedVerifyAttempts >= threshold ? 'high' : 'warn');

  if (db.settings.autoLockSuspiciousPayments !== false && payment.failedVerifyAttempts >= threshold) {
    payment.status = 'review';
    payment.lastCheckReason = `Security review: ${payment.failedVerifyAttempts} failed verify attempts. ${reason}`;
    addSecurityLog('payment_moved_to_review', payment.telegramId, { paymentId: payment.id, attempts: payment.failedVerifyAttempts }, 'high');
    securityNotifyAdmins(`Payment moved to review.\n\nPayment: <code>${escapeHtml(payment.id)}</code>\nUser: <code>${escapeHtml(payment.telegramId)}</code>\nAttempts: <b>${payment.failedVerifyAttempts}</b>\nReason: ${escapeHtml(short(reason, 250))}`);
  }
  saveData();
}


function addWebAudit(action, detail = {}, req = null) {
  try {
    db.webAudit ||= [];
    db.webAudit.unshift({
      id: 'AUD' + Date.now() + Math.floor(Math.random() * 999),
      action,
      detail,
      ip: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '',
      ua: req?.headers?.['user-agent'] || '',
      at: now()
    });
    db.webAudit = db.webAudit.slice(0, 250);
    saveData();
  } catch (_) {}
}


function stockAlertText(product, addedCount) {
  return `🆕 <b>New Stock Added</b>\n\n🔔 <b>${addedCount} new stock added for ${escapeHtml(product.emoji || '📦')} ${escapeHtml(product.name)}</b>\n\n📦 Now Available: <b>${product.stock.length} items</b>\n💰 Price: <b>${money(product.price, product.currency || currency())}</b>\n\n⚡ Limited quantity — tap below to buy quickly.`;
}

async function broadcastToUsers(text, replyMarkup) {
  let sent = 0;
  for (const user of Object.values(db.users)) {
    if (!user?.telegramId || user.notifications === false) continue;
    try {
      await sendMessage(user.telegramId, text, replyMarkup);
      sent++;
      await new Promise((r) => setTimeout(r, 120));
    } catch (_) {}
  }
  return sent;
}

async function broadcastStockAlert(product, addedCount) {
  if (!addedCount || addedCount < 1) return 0;
  product.restockedAt = now();
  const userMarkup = inline([
    [{ text: `${product.emoji || premiumIconForName(product.name)} ${short(product.name, 35)} - ${money(product.price, product.currency || currency())} (Stock: ${product.stock.length})`, callback_data: `view:${product.code}` }]
  ]);
  const alertText = premiumStockAlertText(product, addedCount);
  const userSent = await broadcastToUsers(alertText, userMarkup);
  const requestSent = await notifyRestockRequesters(product);
  const channelSent = await sendToConfiguredChannels(alertText, channelBuyButtons(product));
  const groupSent = await sendToRegisteredGroups(alertText, channelBuyButtons(product), 'stock', product.code);
  return userSent + requestSent + channelSent + groupSent;
}



function premiumAnnouncementText(message = '') {
  const raw = String(message || '').trim();
  const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
  const first = lines[0] || 'Store Update';
  const rest = lines.slice(1);

  const isMaint = /maint|maintenance|update|server|down|under/i.test(raw);
  const isSale = /sale|price|drop|offer|discount|limited/i.test(raw);
  const isStock = /stock|added|available|left/i.test(raw);

  const titleIcon = isMaint ? '🛠' : isSale ? '🚨' : isStock ? '🆕' : '📣';
  const title = isMaint ? 'IMPORTANT MAINTENANCE UPDATE' : isSale ? 'PREMIUM DEAL ALERT' : isStock ? 'NEW STOCK ALERT' : 'PREMIUM ANNOUNCEMENT';

  let out = `${titleIcon} <b>${title}</b>\n`;
  out += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += `✨ <b>${escapeHtml(first)}</b>\n\n`;

  if (rest.length) {
    out += rest.slice(0, 10).map(line => {
      const safe = escapeHtml(line);
      if (/price|old|new|\$|₹|rs/i.test(line)) return `💰 <b>${safe}</b>`;
      if (/stock|left|available|qty|quantity/i.test(line)) return `📦 <b>${safe}</b>`;
      if (/time|hour|today|tomorrow|soon|am|pm/i.test(line)) return `⏰ ${safe}`;
      if (/bot|buy|order|grab|join/i.test(line)) return `🛒 <b>${safe}</b>`;
      return `✅ ${safe}`;
    }).join('\n') + '\n\n';
  }

  out += `━━━━━━━━━━━━━━━━━━━━\n`;
  out += isMaint
    ? `⏳ <b>Please wait, service will be back soon.</b>\n❤️ Thank you for your patience.`
    : `⚡ <b>Fast checkout • Premium service • Limited availability</b>\n🛒 Tap below to open store.`;

  return out;
}


async function broadcastAnnouncement(message, buttonText = '🛍 Open Store') {
  const markup = inline([
    [{ text: buttonText, callback_data: 'shop:1' }],
    [{ text: '🌐 Channel', url: db.settings.channelUrl || CHANNEL_URL }]
  ]);
  const userSent = await broadcastToUsers(premiumAnnouncementText(message), markup);
  const channelSent = await sendToConfiguredChannels(premiumAnnouncementText(message), inline([[{ text: buttonText, url: `https://t.me/${getBotUsername() || botUsername}` }]]));
  return userSent + channelSent;
}

async function broadcastProductAlert(product, title = '🔔 Stock Alert') {
  const markup = inline([
    [{ text: `${product.emoji || '📦'} ${short(product.name, 35)} - ${money(product.price, product.currency || currency())} (Stock: ${product.stock.length})`, callback_data: `view:${product.code}` }],
    [{ text: '🛍 Open Store', callback_data: 'shop:1' }]
  ]);
  const msg = `${title}\n\n${product.emoji || '📦'} <b>${escapeHtml(product.name)}</b>\n\n📦 Available: <b>${product.stock.length} items</b>\n💰 Price: <b>${money(product.price, product.currency || currency())}</b>\n\n🚀 Limited stock available. Tap below to view product.`;
  return broadcastToUsers(msg, markup);
}


// =====================
// SCREENS
// =====================
async function showHome(chatId, from, rawText = '') {
  const ref = String(rawText || '').split(' ')[1] || '';
  const user = getUser(from, ref);
  if (isBannedUser(from.id)) return sendMessage(chatId, '🚫 <b>Your access to this store is blocked.</b>\n\nContact support if you think this is a mistake.');
  if (db.settings.maintenanceMode && !isAdmin(from.id)) return sendMessage(chatId, `🛠 <b>Store Maintenance</b>\n\n${escapeHtml(db.settings.maintenanceMessage || 'Store is under maintenance. Please try again later.')}`);
  clearSession(from.id);
  await clearOldReplyKeyboard(chatId); // removes old bottom keyboard from earlier versions

  const noticeLine = db.settings.storeNotice ? `\n\n📢 <b>Store Notice:</b> ${escapeHtml(db.settings.storeNotice)}` : '';
  const featured = db.settings.featuredProductCode ? productByCode(db.settings.featuredProductCode) : null;
  const featuredLine = featured ? `\n\n🌟 <b>Featured:</b> ${escapeHtml(featured.emoji || '📦')} ${escapeHtml(featured.name)} — ${money(getProductPrice(featured, from.id), featured.currency || currency())}` : '';

  const text = `🔥 <b>Welcome to ${escapeHtml(STORE_NAME)}</b>

<b>Hey ${escapeHtml(user.firstName || 'Cyber')} 👋</b>

Your trusted digital store for premium tools, OTT plans, AI products and software deals. Fast checkout, secure payments and instant delivery after verification.

<blockquote>🛍 <b>Shop</b> — Browse products, check price/stock & buy
💰 <b>Deposit</b> — Add wallet balance with auto verification
👤 <b>Profile</b> — Wallet, orders & account details
🆘 <b>Support</b> — Contact us for help or bulk orders
🧹 <b>Clear Chat</b> — Clean conversation and open fresh menu
🌐 <b>Channel</b> — Join updates, offers and restock alerts</blockquote>

${noticeLine}${featuredLine}

💰 <b>Wallet Balance:</b> ${money(user.balance)}

✨ Select an option below to continue.`;

  return sendMessage(chatId, text, homeButtons(from.id));
}

async function showShop(chatId, from, page = 1) {
  getUser(from);
  const all = activeProducts();
  const { safe, totalPages, markup } = shopButtons(page, from.id);
  setSession(from.id, { type: 'shop', page: safe });
  if (!all.length) return sendMessage(chatId, '💼 Available Products :\n\nNo products available right now.', homeButtons(from.id));
  return sendMessage(chatId, '💼 <b>Available Products</b>\n\nTap any product below to view details, stock and buy options:', markup);
}

async function showProduct(chatId, from, code) {
  const p = productByCode(code);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  setSession(from.id, { type: 'product', productCode: p.code });

  const text = db.settings.premiumProductCards === false
    ? `${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\n\n💲 <b>Price:</b> ${priceLabel(p, from.id)} / code\n📊 <b>Stock:</b> ${p.stock.length} available\n\n${p.description ? escapeHtml(p.description) + '\n\n' : ''}⚡ <b>Delivery:</b> Automatic after payment confirmation.`
    : premiumProductCard(p, from.id);

  if (p.logoFileId) {
    try { return await sendPhoto(chatId, p.logoFileId, text, productButtons(p, from.id)); } catch (_) {}
  }
  return sendMessage(chatId, text, productButtons(p, from.id));
}

async function askQty(chatId, from, code) {
  const p = productByCode(code);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  if (!p.stock.length) return showProduct(chatId, from, code);

  setSession(from.id, { type: 'qty', productCode: p.code });
  return sendMessage(chatId, `${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\n\n💲 Price: ${priceLabel(p, from.id)} / code${bulkPricingText(p) ? `\n\n📦 <b>Bulk Pricing:</b>\n${escapeHtml(bulkPricingText(p))}` : ''}\n\n📣 How many codes do you want?`, qtyButtons(p.code, p.stock.length));
}

async function showCheckoutSummary(chatId, from, checkout) {
  const p = productByCode(checkout.productCode);
  const user = getUser(from);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  const unitPrice = Number(checkout.unitPrice ?? getProductUnitPrice(p, from.id, Number(checkout.qty || 1)));
  const subtotal = Number(checkout.subtotal ?? (unitPrice * Number(checkout.qty || 1)));
  const discount = Number(checkout.discount || 0);
  const finalTotal = Math.max(0, Number((subtotal - discount).toFixed(2)));
  const couponLine = checkout.couponCode ? `\n🎟 Coupon: <b>${escapeHtml(checkout.couponCode)}</b>\n💸 Discount: <b>-${money(discount, p.currency || currency())}</b>` : '';
  const nextCheckout = { ...checkout, unitPrice, subtotal, total: finalTotal, discount, type: 'checkout' };
  setSession(from.id, nextCheckout);
  return sendMessage(chatId, `${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\n\n🧮 Quantity: ${checkout.qty}\n💵 Unit Price: ${priceLabel(p, from.id, checkout.qty)}\n💵 Subtotal: ${money(subtotal, p.currency || currency())}${couponLine}\n💰 Final Payable: <b>${money(finalTotal, p.currency || currency())}</b>${bulkSavingsLine(p, checkout.qty, from.id)}\n\n👛 Your Wallet: ${money(user.balance, p.currency || currency())}`, checkoutButtons(p.code, checkout.qty));
}

async function showCheckout(chatId, from, code, qty) {
  const p = productByCode(code);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  qty = Number(qty || 0);
  if (!qty || qty < 1) return sendMessage(chatId, '❌ Invalid quantity.', qtyButtons(p.code, p.stock.length));
  if (qty > p.stock.length) return sendMessage(chatId, `❌ Only ${p.stock.length} available.`, qtyButtons(p.code, p.stock.length));

  const unitPrice = getProductUnitPrice(p, from.id, qty);
  const subtotal = Number(unitPrice) * qty;
  const bulkTier = bulkPriceForQty(p, qty);
  return showCheckoutSummary(chatId, from, { productCode: p.code, qty, unitPrice, subtotal, total: subtotal, discount: 0, couponCode: '', bulkTier: bulkTier || null });
}

async function showPaymentMethods(chatId, from, checkout) {
  const p = productByCode(checkout.productCode);
  const user = getUser(from);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  setSession(from.id, { ...checkout, type: 'payment_methods' });
  const low = Number(user.balance) < Number(checkout.total);
  return sendMessage(chatId, `💳 <b>Payment Method</b>\n\n📦 Product: ${escapeHtml(p.name)}\n🧮 Quantity: ${checkout.qty}\n💵 Subtotal: ${money(checkout.subtotal || checkout.total, p.currency || currency())}${checkout.couponCode ? `\n🎟 Coupon: <b>${escapeHtml(checkout.couponCode)}</b>\n💸 Discount: <b>-${money(checkout.discount || 0, p.currency || currency())}</b>` : ''}\n💰 Final Payable: ${money(checkout.total, p.currency || currency())}\n\n👛 Your Wallet: ${money(user.balance, p.currency || currency())}${low ? '\n⚠️ Wallet balance is too low for this order — pick another method or top up.' : ''}`, paymentMethodButtons(Number(user.balance), Number(checkout.total)));
}

function createPayment(userId, checkout, method) {
  const p = productByCode(checkout.productCode);
  const baseAmount = roundMoney(checkout.total);
  const payableAmount = makeUniquePayableAmount(baseAmount); // normal amount by default; unique only if enabled in settings
  return {
    id: 'PAY' + Date.now(),
    telegramId: String(userId),
    productCode: p.code,
    productName: p.name,
    qty: Number(checkout.qty),
    baseAmount,
    payableAmount,
    amount: payableAmount,
    unitPrice: Number(checkout.unitPrice || 0),
    subtotal: Number(checkout.subtotal || checkout.total),
    discount: Number(checkout.discount || 0),
    couponCode: checkout.couponCode || '',
    currency: p.currency || currency(),
    methodId: method.id,
    methodName: method.name,
    methodKey: method.key,
    note: 'CUA' + crypto.randomBytes(2).toString('hex').toUpperCase(),
    status: 'pending',
    submittedReference: '',
    noTxidMode: true,
    createdAt: now(),
    expiresAt: paymentExpiryAt()
  };
}

async function showPaymentInstruction(chatId, from, payment) {
  const cfg = binanceCfg();
  setSession(from.id, { type: 'payment', paymentId: payment.id });
  const baseLine = payment.baseAmount && Number(payment.baseAmount) !== Number(payment.amount)
    ? `\n🧾 Product Total: <b>${money(payment.baseAmount, payment.currency)}</b>\n💵 Pay Amount: <b>${money(payment.amount, payment.currency)}</b>`
    : `\n💵 Amount: <b>${money(payment.amount, payment.currency)}</b>`;

  const address = paymentMethodAddress(payment.methodKey);
  const network = paymentMethodNetwork(payment.methodKey);
  const modeLine = verifyModeLine();

  if (payment.methodKey === 'UPI_PAY') {
    const upiId = getUpiId();
    const upiName = getUpiName();
    const qrUrl = getUpiQrUrl(payment.amount);
    const txt = `💎 <b>Premium Payment Invoice</b>\n\n🇮🇳 <b>UPI / QR Code Payment</b>\n📦 Product: <b>${escapeHtml(payment.productName)}</b>\n🧮 Quantity: <b>${payment.qty}</b>${baseLine}\n\n🆔 <b>UPI ID:</b> <code>${escapeHtml(upiId)}</code>\n👤 <b>Payee Name:</b> <code>${escapeHtml(upiName)}</code>\n✅ <b>Pay exact amount:</b> <code>${money(payment.amount, payment.currency)}</code>\n📝 <b>Reference Note / Remarks:</b> <code>${escapeHtml(payment.note)}</code>\n\n📲 <b>Instructions:</b>\n1. Copy UPI ID <code>${escapeHtml(upiId)}</code> or scan QR code below.\n2. Open PhonePe / GPay / Paytm / BHIM to complete payment.\n3. Enter <code>${escapeHtml(payment.note)}</code> in UPI Note (if supported).\n4. Click <b>Submit TXID / Order ID</b> below and enter your UTR / Ref No.\n\n🆔 Payment ID: <code>${escapeHtml(payment.id)}</code>\n⌛ Valid for: <b>${paymentExpiresText(payment)}</b>`;
    const btnObj = paymentStatusButtons(payment.id);
    if (btnObj && btnObj.inline_keyboard) {
      btnObj.inline_keyboard.unshift([{ text: '📲 Open QR Code', url: qrUrl }]);
    }
    return sendMessage(chatId, txt, btnObj);
  }

  const txt = payment.methodKey === 'BINANCE_PAY'
    ? `💎 <b>Premium Payment Invoice</b>\n\n🟡 <b>Binance Pay</b>\n📦 Product: <b>${escapeHtml(payment.productName)}</b>\n🧮 Quantity: <b>${payment.qty}</b>${baseLine}\n🆔 Binance UID: <code>${escapeHtml(cfg.id)}</code>\n\n✅ <b>Pay this amount:</b> <code>${money(payment.amount, payment.currency)}</code>\n📝 <b>Reference Note / Remark:</b> <code>${escapeHtml(payment.note)}</code>\n\n⚠️ <b>2 Verify Options:</b>\n✅ Auto Verify: payment me exact Reference Note add karo.\n🧾 TXID Verify: Auto fail ho ya note bhul gaye, TXID / Order ID submit karo.\n\n${modeLine}\n\n🆔 Payment ID: <code>${escapeHtml(payment.id)}</code>\n⌛ Valid for: <b>${paymentExpiresText(payment)}</b>`
    : `💎 <b>Premium Payment Invoice</b>\n\n💳 <b>${escapeHtml(payment.methodName)}</b>${network ? `\n🌐 Network: <b>${escapeHtml(network)}</b>` : ''}\n📦 Product: <b>${escapeHtml(payment.productName)}</b>\n🧮 Quantity: <b>${payment.qty}</b>${baseLine}\n${address ? `\n🔗 <b>Wallet Address:</b>\n<code>${escapeHtml(address)}</code>\n👇 Tap and hold to copy\n` : ''}\n✅ <b>Pay this amount:</b> <code>${money(payment.amount, payment.currency)}</code>\n📝 <b>Reference Note:</b> <code>${payment.note}</code>\n\n⚠️ <b>2 Verify Options:</b>\n✅ Auto Verify: exact Reference Note required.\n🧾 TXID Verify: note support nahi hai ya note bhul gaye, TXID / Order ID submit karo.\n\n${modeLine}\n\n🆔 Payment ID: <code>${escapeHtml(payment.id)}</code>`;
  return sendMessage(chatId, txt, paymentStatusButtons(payment.id));
}

function deliverStock(p, qty) {
  const items = p.stock.splice(0, qty);
  p.sold = Number(p.sold || 0) + qty;
  return items;
}

async function completeWalletOrder(chatId, from, checkout) {
  const user = getUser(from);
  const p = productByCode(checkout.productCode);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  if (Number(user.balance) < Number(checkout.total)) return sendMessage(chatId, '❌ Wallet balance low.', paymentMethodButtons(Number(user.balance), Number(checkout.total)));
  if (p.stock.length < checkout.qty) return sendMessage(chatId, '❌ Stock changed. Please try again.', homeButtons(from.id));

  user.balance = Number(user.balance) - Number(checkout.total);
  const items = deliverStock(p, checkout.qty);
  if (checkout.couponCode) { const c = findCoupon(checkout.couponCode); if (c) c.uses = Number(c.uses || 0) + 1; }
  const orderId = 'O' + Date.now();
  db.orders.push({
    id: orderId,
    telegramId: String(from.id),
    productCode: p.code,
    productName: p.name,
    qty: checkout.qty,
    total: checkout.total,
    unitPrice: checkout.unitPrice || 0,
    subtotal: checkout.subtotal || checkout.total,
    discount: checkout.discount || 0,
    couponCode: checkout.couponCode || '',
    currency: p.currency || currency(),
    method: 'Wallet',
    deliveredItems: items,
    status: 'paid',
    createdAt: now()
  });
  saveData();
  clearSession(from.id);

  return sendDeliveryMessage(chatId, p.name, checkout.qty, checkout.total, p.currency || currency(), items, orderId, p.code);
}

async function completeVerifiedPayment(chatId, from, payment, result) {
  if (payment.type === 'deposit') {
    const user = getUser(from);
    user.balance = Number(user.balance || 0) + Number(payment.amount || 0);
    payment.status = 'approved';
    payment.verifiedAt = now();
    payment.binanceAmount = result?.amount || payment.amount;
    payment.binanceRaw = result?.raw || null;

    db.deposits ||= [];
    db.deposits.push({
      id: payment.id,
      telegramId: String(from.id),
      amount: Number(payment.amount || 0),
      currency: payment.currency || currency(),
      method: payment.methodName,
      reference: payment.submittedReference || '',
      status: 'approved',
      createdAt: now()
    });

    saveData();
    clearSession(from.id);

    return sendMessage(chatId, `✅ <b>Deposit Verified Automatically</b>\n\n💵 Amount Added: <b>${money(payment.amount, payment.currency)}</b>\n👛 New Wallet Balance: <b>${money(user.balance, payment.currency)}</b>\n🆔 Deposit ID: <code>${escapeHtml(payment.id)}</code>\n\nNow you can buy products using wallet balance.`, homeButtons(from.id));
  }

  const p = productByCode(payment.productCode);
  if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
  if (p.stock.length < payment.qty) {
    await markPaymentStockWait(payment, 'Payment verified but stock finished during payment flow', { approvedBy: 'instant-auto-check', method: result?.matchType || 'auto' });
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Payment Received</b>\n\n⚠️ Stock finished right now. Your paid order is saved in queue.\n\nWhen admin adds stock, you will get <b>instant automatic delivery</b>.`, homeButtons(from.id));
  }

  const items = deliverStock(p, payment.qty);
  if (payment.couponCode) { const c = findCoupon(payment.couponCode); if (c) c.uses = Number(c.uses || 0) + 1; }
  payment.status = 'approved';
  payment.verifiedAt = now();
  payment.binanceAmount = result?.amount || payment.amount;
  payment.binanceRaw = result?.raw || null;
  const orderId = 'O' + Date.now();

  db.orders.push({
    id: orderId,
    telegramId: String(from.id),
    productCode: p.code,
    productName: p.name,
    qty: payment.qty,
    total: payment.amount,
    unitPrice: payment.unitPrice || 0,
    subtotal: payment.subtotal || payment.amount,
    discount: payment.discount || 0,
    couponCode: payment.couponCode || '',
    currency: payment.currency,
    method: payment.methodName,
    deliveredItems: items,
    status: 'paid',
    deliveryStatus: 'created',
    deliveryAttempts: 0,
    paymentId: payment.id,
    createdAt: now()
  });

  saveData();
  clearSession(from.id);

  return sendDeliveryMessage(chatId, p.name, payment.qty, payment.amount, payment.currency || p.currency || currency(), items, orderId, p.code);
}


function findOrderByPaymentId(paymentId) {
  return db.orders.find((o) => String(o.paymentId || '') === String(paymentId || ''));
}

function undeliveredPayments() {
  return db.payments.filter((p) =>
    p.type !== 'deposit' &&
    ['pending', 'review', 'approved', 'stock_issue', 'stock_wait'].includes(String(p.status || '').toLowerCase()) &&
    !findOrderByPaymentId(p.id)
  );
}

function ensureUserById(id, fallback = {}) {
  const key = String(id);
  db.users[key] ||= {
    telegramId: key,
    firstName: fallback.firstName || 'User',
    username: fallback.username || '',
    balance: 0,
    referrals: 0,
    referredBy: '',
    notifications: true,
    createdAt: now()
  };
  return db.users[key];
}

async function approveAndDeliverPayment(payment, opts = {}) {
  if (!payment) throw new Error('Payment not found');

  if (payment.type === 'deposit') {
    const user = ensureUserById(payment.telegramId);
    const alreadyCredited = (db.deposits || []).some((d) => String(d.id) === String(payment.id));

    if (!alreadyCredited) {
      user.balance = Number(user.balance || 0) + Number(payment.amount || 0);
      db.deposits ||= [];
      db.deposits.push({
        id: payment.id,
        telegramId: payment.telegramId,
        amount: Number(payment.amount || 0),
        currency: payment.currency || currency(),
        method: payment.methodName || 'Approved',
        reference: payment.submittedReference || opts.reference || 'admin-approved',
        status: 'approved',
        createdAt: now()
      });
    }

    payment.status = 'approved';
    payment.verifiedAt ||= now();
    payment.approvedBy ||= opts.approvedBy || 'admin';
    saveData();

    if (opts.notifyUser !== false) {
      try {
        await sendMessage(payment.telegramId, `✅ <b>Deposit Approved</b>\n\n💵 Amount Added: <b>${money(payment.amount, payment.currency)}</b>\n👛 New Wallet: <b>${money(user.balance, payment.currency)}</b>\n🆔 Deposit ID: <code>${escapeHtml(payment.id)}</code>`, homeButtons(payment.telegramId));
      } catch (err) {
        return `✅ Deposit approved, but Telegram message failed: ${err.message}`;
      }
    }
    return alreadyCredited ? `✅ Deposit already credited earlier: ${payment.id}` : `✅ Deposit approved and wallet credited: ${payment.id}`;
  }

  const product = productByCode(payment.productCode);
  if (!product) throw new Error('Product not found for this payment');

  const existingOrder = findOrderByPaymentId(payment.id);
  if (existingOrder) {
    payment.status = 'approved';
    payment.verifiedAt ||= now();
    saveData();
    if (opts.resend !== false) {
      try {
        await sendDeliveryMessage(existingOrder.telegramId, existingOrder.productName, existingOrder.qty, existingOrder.total, existingOrder.currency, existingOrder.deliveredItems || [], existingOrder.id, existingOrder.productCode);
      } catch (err) {
        return `✅ Order already exists (${existingOrder.id}), but resend failed: ${err.message}`;
      }
    }
    return `✅ Order already delivered earlier. Order ID: ${existingOrder.id}`;
  }

  const qty = Number(payment.qty || 1);
  if ((product.stock || []).length < qty) {
    return markPaymentStockWait(payment, `Payment received but stock finished. Required ${qty}, available ${(product.stock || []).length}.`, {
      approvedBy: opts.approvedBy || 'admin',
      method: opts.method || 'approved'
    });
  }

  const items = deliverStock(product, qty);
  if (payment.couponCode) {
    const c = findCoupon(payment.couponCode);
    if (c) c.uses = Number(c.uses || 0) + 1;
  }

  const orderId = 'O' + Date.now();
  const order = {
    id: orderId,
    telegramId: String(payment.telegramId),
    productCode: product.code,
    productName: product.name,
    qty,
    total: Number(payment.amount || 0),
    subtotal: Number(payment.subtotal || payment.amount || 0),
    discount: Number(payment.discount || 0),
    couponCode: payment.couponCode || '',
    currency: payment.currency || product.currency || currency(),
    method: payment.methodName || opts.method || 'Admin Approved',
    deliveredItems: items,
    status: 'paid',
    paymentId: payment.id,
    createdAt: now()
  };

  db.orders.push(order);
  const earnedPoints = addLoyaltyPointsForOrder(order);
  try { await notifyPublicPurchase(order, product); } catch (err) { console.error('Purchase public alert failed:', err.message); }
  payment.status = 'approved';
  payment.verifiedAt ||= now();
  payment.approvedBy ||= opts.approvedBy || 'admin';
  saveData();

  if (opts.notifyUser !== false) {
    try {
      await sendDeliveryMessage(payment.telegramId, product.name, qty, Number(payment.amount || 0), payment.currency || product.currency || currency(), items, orderId, product.code);
    } catch (err) {
      return `✅ Order created (${orderId}) but Telegram delivery failed: ${err.message}. Safe Delivery Center logged it. Use Repair Delivery / Retry Failed.`;
    }
  }

  return `✅ Payment approved and order delivered. Order ID: ${orderId}`;
}


async function notifyPublicPurchase(order, product) {
  if (db.settings.purchaseAlertsEnabled === false) return 0;
  const body = premiumPurchaseAlert(order, product);
  const markup = product ? channelBuyButtons(product) : inline([[{ text: '🤖 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]);
  const channelSent = await sendToConfiguredChannels(body, markup);
  const groupSent = await sendToRegisteredGroups(body, markup, 'purchase', product?.code || order?.productCode || '');
  return channelSent + groupSent;
}


async function notifyAdminPaymentReview(payment, reason) {
  try {
    await sendMessage(ADMIN_ID, `🧾 <b>Payment Needs Review</b>\n\nPayment: <code>${escapeHtml(payment.id)}</code>\nUser: <code>${escapeHtml(payment.telegramId)}</code>\nProduct: <b>${escapeHtml(payment.productName || 'Wallet Deposit')}</b>\nAmount: <b>${money(payment.amount, payment.currency)}</b>\nMethod: ${escapeHtml(payment.methodName || '-')}\nRef/TXID: <code>${escapeHtml(payment.submittedReference || '-')}</code>\n\nReason:\n${escapeHtml(reason || 'Not verified automatically')}\n\nTap approve only after checking payment manually.`, paymentAdminButtons(payment.id));
  } catch (_) {}
}

async function repairAllApprovedPayments() {
  const list = db.payments.filter((p) => p.type !== 'deposit' && p.status === 'approved' && !findOrderByPaymentId(p.id));
  let ok = 0, fail = 0, logs = [];
  for (const p of list) {
    try {
      const msg = await approveAndDeliverPayment(p, { approvedBy: 'repair-tool', method: 'Repair Tool' });
      ok++;
      logs.push(`${p.id}: ${msg}`);
    } catch (err) {
      fail++;
      logs.push(`${p.id}: ${err.message}`);
    }
  }
  return { ok, fail, logs };
}



function shouldAskTxidAfterAutoFail(reason = '') {
  const r = String(reason || '').toLowerCase();
  return r.includes('reference note') ||
    r.includes('note was not found') ||
    r.includes('note missing') ||
    r.includes('submit txid') ||
    r.includes('payment amount found');
}


async function autoCheckPayment(chatId, from, payment) {
  if (!payment) return sendMessage(chatId, '❌ Payment not found.', homeButtons(from.id));
  if (payment.status === 'approved') return sendMessage(chatId, '✅ Payment already approved.', homeButtons(from.id));
  if (!isAdmin(from.id) && rateLimitHit('payverify', `${from.id}:${payment.id}`, Number(db.settings.paymentVerifyLimitPer10Min || 6), 10 * 60 * 1000, { paymentId: payment.id })) {
    recordPaymentFail(payment, 'Too many verify attempts');
    return sendMessage(chatId, `🚦 <b>Too many verify attempts</b>

Please wait 10 minutes or submit correct TXID / Order ID. Admin has been notified if this repeats.`, paymentFallbackButtons(payment.id));
  }

  await sendMessage(chatId, '⏳ Auto checking payment. Please wait...');
  try {
    const result = await verifyPayment(payment);
    if (result.ok) {
      await autoApprovePayment(payment, result, 'instant-auto-check');
      if (payment.type === 'deposit') {
        const user = db.users[String(payment.telegramId)] || {};
        clearSession(from.id);
        return sendMessage(chatId, `✅ <b>Deposit Verified Automatically</b>\n\n💵 Amount Added: <b>${money(payment.amount, payment.currency)}</b>\n👛 New Wallet Balance: <b>${money(user.balance, payment.currency)}</b>\n🆔 Deposit ID: <code>${escapeHtml(payment.id)}</code>\n\nNow you can buy products using wallet balance.`, homeButtons(from.id));
      }
      const order = findOrderByPaymentId(payment.id);
      if (order) {
        clearSession(from.id);
        return sendMessage(chatId, `✅ <b>Payment Verified</b>\n\nDelivery has been sent automatically.\nOrder ID: <code>${escapeHtml(order.id)}</code>`, inline([[{ text: '📦 View Order', callback_data: `order_view:${order.id}` }], [{ text: '🏠 Main Menu', callback_data: 'home' }]]));
      }
      return sendMessage(chatId, '✅ Payment verified automatically.', homeButtons(from.id));
    }

    payment.lastCheckReason = result.reason;
    payment.lastCheck = now();
    if (payment.status !== 'review') payment.status = 'pending';
    recordPaymentFail(payment, result.reason);
    saveData();

    if (shouldAskTxidAfterAutoFail(result.reason) && !payment.submittedReference) {
      return sendMessage(chatId, `🧾 <b>Auto Verify Failed</b>\n\n${escapeHtml(result.reason)}\n\nAgar user ne payment me <b>Reference Note</b> add karna bhul gaya hai, to ab <b>TXID / Order ID</b> submit kare.\n\nPayment ID: <code>${escapeHtml(payment.id)}</code>\nAmount: <b>${money(payment.amount, payment.currency)}</b>`, paymentFallbackButtons(payment.id));
    }

    return sendMessage(chatId, `⏳ <b>Auto Verification Running</b>\n\n${escapeHtml(result.reason)}\n\nAuto Verify safe hai: exact Reference Note + amount check hota hai.\n\nAgar note add nahi kiya, Auto fail hone ke baad <b>Submit TXID / Order ID</b> option milega.\n\nPayment ID: <code>${escapeHtml(payment.id)}</code>`, paymentStatusButtons(payment.id));
  } catch (err) {
    payment.lastCheckReason = err.message;
    payment.lastCheck = now();
    if (payment.status !== 'review') payment.status = 'pending';
    recordPaymentFail(payment, err.message);
    saveData();
    autoVerifyLog('error', 'Instant auto check failed', { paymentId: payment.id, error: err.message });
    return sendMessage(chatId, `⏳ <b>Auto Verification Still Running</b>\n\nAPI check failed: ${escapeHtml(err.message)}\n\nTry Auto Verify again. If note was not added or API keeps failing, submit TXID / Order ID.\n\nPayment ID: <code>${escapeHtml(payment.id)}</code>`, paymentFallbackButtons(payment.id));
  }
}

async function showPaymentStatus(chatId, from, paymentId) {
  const p = db.payments.find((x) => x.id === paymentId && x.telegramId === String(from.id));
  if (!p) return sendMessage(chatId, '❌ Payment not found.', homeButtons(from.id));
  setSession(from.id, { type: 'payment', paymentId });
  if (p.status === 'pending') {
    if (!isTxidVerifyMode()) return autoCheckPayment(chatId, from, p);
    if (p.submittedReference) return autoCheckPayment(chatId, from, p);
  }
  return sendMessage(chatId, `⏳ <b>${p.type === 'deposit' ? 'Deposit' : 'Payment'} ${escapeHtml(p.id)}</b>\n\nStatus: ${p.status.toUpperCase()}\nMethod: ${escapeHtml(p.methodName)}\nVerify Mode: <b>Safe Dual: Auto Note + TXID</b>\nAmount: ${money(p.amount, p.currency)}\nNote: <code>${escapeHtml(p.note)}</code>\nExpires: ${escapeHtml(p.expiresAt.replace('T', ' ').replace('.000Z', ' UTC'))}${p.submittedReference ? `\nTXID: <code>${escapeHtml(p.submittedReference)}</code>` : ''}${p.lastCheckReason ? `\n\nLast Check: ${escapeHtml(p.lastCheckReason)}` : ''}`, paymentStatusButtons(p.id));
}

async function showProfile(chatId, from) {
  const u = getUser(from);
  const s = user360Stats(from.id);
  const pending = s.payments.filter(p => p.status === 'pending' || p.status === 'review').length;
  const wishlistCount = (db.wishlists?.[String(from.id)] || []).length;
  const openTickets = s.tickets.filter(t => t.status !== 'closed' && t.status !== 'replacement_approved' && t.status !== 'replacement_rejected').length;
  const lastOrder = s.orders.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0];

  return sendMessage(chatId, `👤 <b>My Account Summary</b>\n\nID: <code>${from.id}</code>\nUsername: ${from.username ? '@' + escapeHtml(from.username) : '-'}\n\n💰 Wallet: <b>${money(u.balance)}</b>\n${loyaltyLine(from.id)}\n📦 Orders: <b>${s.orders.length}</b>\n🧮 Items Bought: <b>${s.qty}</b>\n💵 Total Spent: <b>${money(s.spent)}</b>\n⏳ Pending Payments: <b>${pending}</b>\n🎫 Open Tickets: <b>${openTickets}</b>\n⭐ Reviews: <b>${s.reviews.length}</b>\n🔔 Restock Requests: <b>${s.restock.length}</b>\n⭐ Wishlist: <b>${wishlistCount}</b>\n🎁 Referrals: <b>${u.referrals || 0}</b>\n🔔 Notifications: <b>${u.notifications === false ? 'OFF' : 'ON'}</b>${lastOrder ? `\n\n🧾 Last Order:\n${escapeHtml(lastOrder.productName)}\n<code>${escapeHtml(lastOrder.id)}</code>` : ''}`, inline([
    [
      { text: '📦 My Orders', callback_data: 'orders' },
      { text: '💳 Payments', callback_data: 'user_payments_list' }
    ],
    [
      { text: '💰 Wallet History', callback_data: 'wallet_history' },
      { text: '⭐ Wishlist', callback_data: 'wishlist' }
    ],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]));
}

async function showOrders(chatId, from, page = 1, search = '') {
  let orders = userOrders(from.id);
  if (search) orders = orders.filter(o => orderSearchMatch(o, search));
  const pageSize = 5;
  const total = Math.max(1, Math.ceil(orders.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = orders.slice((safe - 1) * pageSize, safe * pageSize);

  if (!orders.length) {
    return sendMessage(chatId, search ? `📭 No orders found for: <b>${escapeHtml(search)}</b>` : '📭 No orders found.', inline([
      [{ text: '🔎 Search Order', callback_data: 'orders_search' }],
      [{ text: '🏠 Main Menu', callback_data: 'home' }]
    ]));
  }

  const s = orderStats(orders);
  let out = `📦 <b>My Order History</b> ${search ? `\n🔎 Search: <b>${escapeHtml(search)}</b>` : ''}\n\n`;
  out += `🧾 Total Orders: <b>${s.total}</b>\n📦 Total Qty: <b>${s.qty}</b>\n💵 Total Spent: <b>${money(s.revenue)}</b>\n`;
  if (s.top) out += `🏆 Top Product: <b>${escapeHtml(s.top.name)}</b>\n`;
  out += `\nPage ${safe}/${total}\n\n`;

  const rows = [];
  items.forEach((o, i) => {
    const index = (safe - 1) * pageSize + i + 1;
    out += `${index}. <b>${escapeHtml(o.productName)}</b>\n`;
    out += `Order: <code>${escapeHtml(o.id)}</code>\n`;
    out += `Status: ${escapeHtml(orderStatusLabel(o))}\n`;
    out += `Qty: ${o.qty} | Total: <b>${money(o.total, o.currency)}</b>\n`;
    out += `Date: ${escapeHtml(new Date(o.createdAt).toLocaleString())}\n\n`;
    rows.push([{ text: `🧾 View ${index}`, callback_data: `order_view:${o.id}` }]);
  });

  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `orders_page:${safe - 1}:${encodeURIComponent(search)}` : 'noop' },
    { text: `${safe}/${total}`, callback_data: 'noop' },
    { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `orders_page:${safe + 1}:${encodeURIComponent(search)}` : 'noop' }
  ]);
  rows.push([
    { text: '🔎 Search Order', callback_data: 'orders_search' },
    { text: '📊 Order Stats', callback_data: 'orders_stats' }
  ]);
  rows.push([
    { text: '📄 Export TXT', callback_data: 'orders_export_txt' },
    { text: '🏠 Main Menu', callback_data: 'home' }
  ]);
  return sendMessage(chatId, out, inline(rows));
}

async function showDeposit(chatId, from) {
  const user = getUser(from);
  clearSession(from.id);
  return sendMessage(chatId, `💰 <b>Wallet Deposit</b>\n\nAdd balance to your wallet and use it for fast product checkout.\n\n👛 Current Wallet: <b>${money(user.balance)}</b>\n\nChoose deposit amount below:`, depositAmountButtons());
}

async function showDepositMethods(chatId, from, amount) {
  amount = Number(amount || 0);
  if (!amount || amount <= 0) return sendMessage(chatId, '❌ Invalid amount. Choose again.', depositAmountButtons());
  setSession(from.id, { type: 'deposit_amount_selected', amount });
  return sendMessage(chatId, `💳 <b>Select Deposit Method</b>\n\n💵 Amount: <b>${money(amount)}</b>\n\nChoose a payment method below. Bot will give you UID/address and a unique Reference Note. Auto Verify needs the exact note; TXID / Hash option is also available.`, depositMethodButtons(amount));
}

function createDepositPayment(userId, amount, method) {
  const baseAmount = roundMoney(amount);
  const payableAmount = makeUniquePayableAmount(baseAmount); // normal amount by default; unique only if enabled in settings
  return {
    id: 'DEP' + Date.now(),
    type: 'deposit',
    telegramId: String(userId),
    productCode: '',
    productName: 'Wallet Deposit',
    qty: 1,
    baseAmount,
    payableAmount,
    amount: payableAmount,
    currency: currency(),
    methodId: method.id,
    methodName: method.name,
    methodKey: method.key,
    note: 'DEP' + crypto.randomBytes(2).toString('hex').toUpperCase(),
    status: 'pending',
    submittedReference: '',
    noTxidMode: true,
    createdAt: now(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };
}

async function showDepositInstruction(chatId, from, payment) {
  const cfg = binanceCfg();
  setSession(from.id, { type: 'payment', paymentId: payment.id });

  const baseLine = payment.baseAmount && Number(payment.baseAmount) !== Number(payment.amount)
    ? `\n🧾 Deposit Request: <b>${money(payment.baseAmount, payment.currency)}</b>\n💵 Pay Amount: <b>${money(payment.amount, payment.currency)}</b>`
    : `\n💵 Deposit Amount: <b>${money(payment.amount, payment.currency)}</b>`;

  const address = paymentMethodAddress(payment.methodKey);
  const network = paymentMethodNetwork(payment.methodKey);
  const modeLine = verifyModeLine();

  const text = payment.methodKey === 'BINANCE_PAY'
    ? `💰 <b>Wallet Deposit Invoice</b>\n🟡 <b>Binance Pay</b>${baseLine}\n🆔 Binance UID: <code>${escapeHtml(cfg.id)}</code>\n\n✅ <b>Pay this amount:</b> <code>${money(payment.amount, payment.currency)}</code>\n📝 <b>Reference Note / Remark:</b> <code>${escapeHtml(payment.note)}</code>\n\n⚠️ <b>2 Verify Options:</b>\n✅ Auto Verify: exact Reference Note se wallet credit hoga.\n🧾 TXID Verify: note bhul gaye ho to TXID / Hash submit karo.\n\n${modeLine}\n\n🆔 Deposit ID: <code>${escapeHtml(payment.id)}</code>`
    : `💰 <b>Wallet Deposit Invoice</b>\n💳 <b>${escapeHtml(payment.methodName)}</b>${network ? `\n🌐 Network: <b>${escapeHtml(network)}</b>` : ''}${baseLine}\n${address ? `\n🔗 <b>Wallet Address:</b>\n<code>${escapeHtml(address)}</code>\n👇 Tap and hold to copy\n` : ''}\n✅ <b>Pay this amount:</b> <code>${money(payment.amount, payment.currency)}</code>\n📝 <b>Reference Note:</b> <code>${payment.note}</code>\n\n⚠️ <b>2 Verify Options:</b>\n✅ Auto Verify: exact Reference Note required.\n🧾 TXID Verify: note support nahi hai ya note bhul gaye, TXID / Order ID submit karo.\n\n${modeLine}\n\n🆔 Deposit ID: <code>${escapeHtml(payment.id)}</code>`;

  return sendMessage(chatId, text, paymentStatusButtons(payment.id));
}

async function showSupport(chatId, from) {
  return sendMessage(chatId, `🆘 <b>Support Center</b>\n\nNeed help with payment, delivery, warranty or bulk order?\n\nChoose an option below.`, inline([
    [{ text: '🎫 Open Support Ticket', callback_data: 'support_ticket' }],
    [{ text: '📨 Contact Support', url: `https://t.me/${String(db.settings.supportUsername || SUPPORT_USERNAME).replace('@', '')}` }],
    [{ text: '🏠 Main Menu', callback_data: 'home' }]
  ]));
}


function adminMoney(n) {
  return money(Number(n || 0), currency());
}

function revenueStats() {
  const paidOrders = db.orders.filter((o) => o.status === 'paid');
  const revenue = paidOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const deposits = (db.deposits || []).reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const stockCount = db.products.reduce((sum, p) => sum + (p.active !== false ? p.stock.length : 0), 0);
  return { paidOrders, revenue, deposits, stockCount };
}

async function showAdminStats(chatId) {
  const stats = revenueStats();
  const pending = db.payments.filter((p) => p.status === 'pending').length;
  const products = db.products.filter((p) => p.active !== false);
  const low = products.filter((p) => p.stock.length <= 2).length;
  const users = Object.keys(db.users).length;

  return sendMessage(chatId, `📊 <b>Store Dashboard</b>\n\n👥 <b>Total Users:</b> ${users}\n📦 <b>Active Products:</b> ${products.length}\n📊 <b>Total Stock:</b> ${stats.stockCount}\n⚠️ <b>Low Stock Products:</b> ${low}\n\n🧾 <b>Paid Orders:</b> ${stats.paidOrders.length}\n💳 <b>Pending Payments:</b> ${pending}\n💰 <b>Wallet Deposits:</b> ${adminMoney(stats.deposits)}\n📈 <b>Order Revenue:</b> ${adminMoney(stats.revenue)}\n\n✨ Use admin tools below to manage your store.`, adminButtons());
}

async function showAdminUsers(chatId, page = 1) {
  const users = Object.values(db.users).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const pageSize = 10;
  const total = Math.max(1, Math.ceil(users.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = users.slice((safe - 1) * pageSize, safe * pageSize);

  let out = `👥 <b>Users ${safe}/${total}</b>\n\n`;
  if (!items.length) out += 'No users yet.';
  for (const u of items) {
    out += `👤 <b>${escapeHtml(u.firstName || 'User')}</b> ${u.username ? '@' + escapeHtml(u.username) : ''}\nID: <code>${escapeHtml(u.telegramId)}</code>\nWallet: <b>${money(u.balance || 0)}</b> | Ref: ${u.referrals || 0}\n\n`;
  }

  return sendMessage(chatId, out, inline([
    [
      { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `admin_users:${safe - 1}` : 'noop' },
      { text: `${safe}/${total}`, callback_data: 'noop' },
      { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `admin_users:${safe + 1}` : 'noop' }
    ],
    [{ text: '💰 Manage Balance', callback_data: 'admin_balance' }],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]));
}

async function showAdminOrders(chatId, page = 1, search = '') {
  let orders = db.orders.slice().sort((a,b)=>new Date(b.createdAt || 0)-new Date(a.createdAt || 0));
  if (search) orders = orders.filter(o => orderSearchMatch(o, search));
  const pageSize = 6;
  const total = Math.max(1, Math.ceil(orders.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = orders.slice((safe - 1) * pageSize, safe * pageSize);
  const s = orderStats(orders);

  let out = `🧾 <b>Admin Order History</b> ${search ? `\n🔎 Search: <b>${escapeHtml(search)}</b>` : ''}\n\n`;
  out += `Orders: <b>${s.total}</b> | Qty: <b>${s.qty}</b> | Revenue: <b>${money(s.revenue)}</b>\n`;
  if (s.top) out += `Top: <b>${escapeHtml(s.top.name)}</b> (${s.top.qty})\n`;
  out += `\nPage ${safe}/${total}\n\n`;

  const rows = [];
  if (!items.length) out += 'No orders found.';
  for (const o of items) {
    const user = db.users[String(o.telegramId)] || {};
    out += `<b>${escapeHtml(o.id)}</b> | ${escapeHtml(orderStatusLabel(o))}\n`;
    out += `👤 ${escapeHtml(user.firstName || 'User')} ${user.username ? '@' + escapeHtml(user.username) : ''}\n`;
    out += `ID: <code>${escapeHtml(o.telegramId)}</code>\n`;
    out += `📦 ${escapeHtml(o.productName)}\n`;
    out += `Qty: ${o.qty} | Total: <b>${money(o.total, o.currency)}</b>\n`;
    out += `Date: ${escapeHtml(new Date(o.createdAt).toLocaleString())}\n\n`;
    rows.push([{ text: `🧾 ${o.id}`, callback_data: `admin_order_view:${o.id}` }]);
  }

  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `admin_orders:${safe - 1}:${encodeURIComponent(search)}` : 'noop' },
    { text: `${safe}/${total}`, callback_data: 'noop' },
    { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `admin_orders:${safe + 1}:${encodeURIComponent(search)}` : 'noop' }
  ]);
  rows.push([
    { text: '🔎 Search Orders', callback_data: 'admin_orders_search' },
    { text: '📊 Order Stats', callback_data: 'admin_orders_stats' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return sendMessage(chatId, out, inline(rows));
}

async function showAdminOrderDetail(chatId, orderId) {
  const o = db.orders.find(x => x.id === orderId);
  if (!o) return sendMessage(chatId, '❌ Order not found.', adminButtons());
  const user = db.users[String(o.telegramId)] || {};
  const review = typeof findReviewByOrder === 'function' ? findReviewByOrder(o.id) : null;
  const delivered = o.deliveredItems?.length ? `<code>${escapeHtml(formatDeliveredItems(o.deliveredItems).slice(0, 2500))}</code>` : 'No delivery saved.';
  const out = `🧾 <b>Admin Order Detail</b>\n\n` +
    `Order: <code>${escapeHtml(o.id)}</code>\n` +
    `Status: <b>${escapeHtml(orderStatusLabel(o))}</b>\n` +
    `User: <b>${escapeHtml(user.firstName || 'User')}</b> ${user.username ? '@' + escapeHtml(user.username) : ''}\n` +
    `User ID: <code>${escapeHtml(o.telegramId)}</code>\n\n` +
    `Product: <b>${escapeHtml(o.productName)}</b>\n` +
    `Code: <code>${escapeHtml(o.productCode || '-')}</code>\n` +
    `Qty: <b>${escapeHtml(o.qty)}</b>\n` +
    `Total: <b>${money(o.total, o.currency)}</b>\n` +
    `Method: ${escapeHtml(o.method || '-')}\n` +
    `Coupon: ${escapeHtml(o.couponCode || '-')}\n` +
    `Payment ID: <code>${escapeHtml(o.paymentId || '-')}</code>\n` +
    `Date: ${escapeHtml(new Date(o.createdAt).toLocaleString())}\n` +
    `${review ? `Rating: ${ratingStars(review.rating)} ${review.rating}/5\n` : ''}\n` +
    `🔑 <b>Delivery:</b>\n${delivered}`;
  return sendMessage(chatId, out, inline([
    [
      { text: '🔁 Resend Delivery', callback_data: `admin_order_resend:${o.id}` },
      { text: '👤 User Orders', callback_data: `user_orders:${o.telegramId}` }
    ],
    [
      { text: '📩 Message User', callback_data: `admin_msg_user:${o.telegramId}` },
      { text: '🧾 Orders', callback_data: 'admin_orders:1' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]));
}

async function showAdminPending(chatId, page = 1) {
  const payments = db.payments.filter((p) => p.status === 'pending' || p.status === 'review').slice().reverse();
  const pageSize = 6;
  const total = Math.max(1, Math.ceil(payments.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = payments.slice((safe - 1) * pageSize, safe * pageSize);

  let out = `⏳ <b>Pending Payments ${safe}/${total}</b>\n\n`;
  if (!items.length) out += 'No pending payments.';
  const rows = [];
  for (const p of items) {
    out += `<b>${escapeHtml(p.id)}</b> | ${p.type === 'deposit' ? 'Deposit' : 'Order'}\n👤 <code>${escapeHtml(p.telegramId)}</code>\n📦 ${escapeHtml(p.productName)}\n💵 ${money(p.amount, p.currency)}\nMethod: ${escapeHtml(p.methodName)}\nRef: <code>${escapeHtml(p.submittedReference || '-')}</code>\n\n`;
    rows.push([{ text: `Manage ${p.id}`, callback_data: `manage_payment:${p.id}` }]);
  }
  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `admin_pending:${safe - 1}` : 'noop' },
    { text: `${safe}/${total}`, callback_data: 'noop' },
    { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `admin_pending:${safe + 1}` : 'noop' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return sendMessage(chatId, out, inline(rows));
}

async function showLowStock(chatId) {
  const items = db.products.filter((p) => p.active !== false && p.stock.length <= 2)
    .sort((a, b) => a.stock.length - b.stock.length);

  let out = '⚠️ <b>Low Stock Products</b>\n\n';
  if (!items.length) out += '✅ All products have enough stock.';
  for (const p of items) {
    out += `${p.code} | ${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\nStock: <b>${p.stock.length}</b> | Price: ${money(p.price, p.currency || currency())}\n\n`;
  }

  return sendMessage(chatId, out, inline([
    [{ text: '📥 Add Stock', callback_data: 'admin_add_stock' }],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]));
}

async function showUserOrders(chatId, userId) {
  const orders = db.orders.filter((o) => o.telegramId === String(userId)).slice(-10).reverse();
  let out = `🧾 <b>User Orders</b>\nUser: <code>${escapeHtml(userId)}</code>\n\n`;
  if (!orders.length) out += 'No orders found.';
  for (const o of orders) {
    out += `#${escapeHtml(o.id)}\n📦 ${escapeHtml(o.productName)}\nQty: ${o.qty} | Total: ${money(o.total, o.currency)}\n\n`;
  }
  return sendMessage(chatId, out, adminBackButtons());
}

async function showUserPayments(chatId, userId) {
  const payments = db.payments.filter((p) => p.telegramId === String(userId)).slice(-10).reverse();
  let out = `💳 <b>User Payments</b>\nUser: <code>${escapeHtml(userId)}</code>\n\n`;
  if (!payments.length) out += 'No payments found.';
  for (const p of payments) {
    out += `${escapeHtml(p.id)} | ${p.status.toUpperCase()}\n${p.type === 'deposit' ? 'Deposit' : escapeHtml(p.productName)}\nAmount: ${money(p.amount, p.currency)}\n\n`;
  }
  return sendMessage(chatId, out, adminBackButtons());
}

async function manualApprovePayment(chatId, adminFrom, payment) {
  try {
    const msg = await approveAndDeliverPayment(payment, { approvedBy: String(adminFrom.id || 'telegram-admin'), method: 'Telegram Admin Approved' });
    return sendMessage(chatId, msg, adminButtons());
  } catch (err) {
    return sendMessage(chatId, `❌ Approve/Delivery failed:\n\n${escapeHtml(err.message)}`, payment ? paymentAdminButtons(payment.id) : adminButtons());
  }
}


async function showAdmin(chatId, from, data = '') {
  data = String(data || '');
  ensureTelegramAdmin(from);
  if (!isAdmin(from.id)) return sendMessage(chatId, `❌ <b>Access denied.</b>\n\n${adminAccessDebugText(from)}\n\nOwner can add you with:\n<code>/addadmin ${escapeHtml(from.id)} manager</code>\n\nIf this is owner account, try:\n<code>/claimowner</code>`);

  if (data === 'admin_bulk_tools') {
    const s = productBulkStats();
    return sendMessage(chatId, `🧰 <b>Bulk Product Tools</b>\n\nProducts: <b>${s.total}</b>\nActive: <b>${s.active}</b>\nHidden: <b>${s.hidden}</b>\nOut of Stock: <b>${s.noStock}</b>\nCategories: <b>${s.categories}</b>\nMissing Cost: <b>${s.costMissing}</b>\n\nChoose action:`, inline([
      [{ text: '🙈 Hide Out-of-Stock', callback_data: 'bulk_hide_oos' }],
      [{ text: '✅ Show All Products', callback_data: 'bulk_show_all' }],
      [{ text: '🧹 Remove Duplicate Stock', callback_data: 'admin_stock_audit' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'bulk_hide_oos') {
    let n = 0;
    for (const p of db.products) {
      if (!(p.stock || []).length && p.active !== false) { p.active = false; n++; }
    }
    saveData();
    return sendMessage(chatId, `✅ Hidden ${n} out-of-stock product(s).`, adminButtons());
  }
  if (data === 'bulk_show_all') {
    let n = 0;
    for (const p of db.products) {
      if (p.active === false) { p.active = true; n++; }
    }
    saveData();
    return sendMessage(chatId, `✅ Restored ${n} product(s).`, adminButtons());
  }
  if (data === 'admin_profit_report') {
    const s = profitSummary();
    let out = `📈 <b>Profit Report</b>\n\nRevenue: <b>${money(s.revenue)}</b>\nCost: <b>${money(s.cost)}</b>\nProfit: <b>${money(s.profit)}</b>\nMargin: <b>${s.margin.toFixed(1)}%</b>\n\n<b>Top Products:</b>\n`;
    s.byProduct.slice(0, 10).forEach((p, i) => { out += `${i + 1}. ${escapeHtml(p.name)}\nQty: ${p.qty} | Profit: <b>${money(p.profit)}</b>\n\n`; });
    return sendMessage(chatId, out, adminButtons());
  }
  if (data === 'admin_campaign_center') {
    const stats = campaignStats();
    return sendMessage(chatId, `📣 <b>Campaign Center</b>\n\nTotal Campaigns: <b>${stats.total}</b>\nTotal Sent: <b>${stats.sent}</b>\nLast: <b>${stats.last ? escapeHtml(new Date(stats.last.at).toLocaleString()) : '-'}</b>\n\nChoose a campaign type:`, inline([
      [{ text: '📣 Custom Broadcast', callback_data: 'camp_custom' }],
      [{ text: '📦 Product Promo', callback_data: 'camp_product' }],
      [{ text: '⚡ Flash Sale Promo', callback_data: 'camp_flash' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'camp_custom') {
    setSession(from.id, { type: 'camp_custom_text' });
    return sendMessage(chatId, '📣 <b>Custom Campaign</b>\n\nSend message to broadcast.\n\nIt will ask target segment after this.', cancelAdminButtons());
  }
  if (data === 'camp_product' || data === 'camp_flash') {
    setSession(from.id, { type: data === 'camp_flash' ? 'camp_flash_code' : 'camp_product_code' });
    return sendMessage(chatId, `${data === 'camp_flash' ? '⚡ Flash Sale Promo' : '📦 Product Promo'}\n\nSend product code.\nExample: <code>P001</code>`, cancelAdminButtons());
  }
  if (data.startsWith('camp_seg:')) {
    const seg = data.split(':')[1] || 'all';
    const s = getSession(from.id);
    if (!s || !s.campaignMessage) return sendMessage(chatId, '❌ Campaign session expired.', adminButtons());
    const result = await sendCampaign({ type: s.campaignType || 'custom', segment: seg, productCode: s.productCode || '', message: s.campaignMessage, toChannels: true, by: from.id });
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Campaign Sent</b>\n\nTarget: <b>${escapeHtml(segmentLabel(seg))}</b>\nUsers: <b>${result.userSent}</b>\nChannels: <b>${result.channelSent}</b>\nTotal: <b>${result.total}</b>`, adminButtons());
  }
  if (data === 'admin_flash_sale') {
    setSession(from.id, { type: 'flash_code' });
    return sendMessage(chatId, '⚡ <b>Create Flash Sale</b>\n\nSend product code.\nExample: <code>P001</code>', cancelAdminButtons());
  }
  if (data.startsWith('flash_disable:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.flashSale = { ...(p.flashSale || {}), active: false };
    saveData();
    return sendMessage(chatId, `✅ Flash sale disabled for ${escapeHtml(p.name)}.`, productManagerButtons(p));
  }
  if (data === 'admin_payment_mode') {
    return sendMessage(chatId, `💳 <b>Safe Payment Verification</b>\n\nCurrent: <b>🛡 Auto Note + TXID both available</b>\n\nBEP20 Address:\n<code>${escapeHtml(db.settings.bep20Address || '')}</code>\n\n✅ Auto Verify: exact amount + exact Reference Note only\n🧾 TXID Verify: user submits transaction hash\n\nThis prevents funds from going to the wrong wallet.`, inline([
      [{ text: '🛡 Safe Dual Mode Active', callback_data: 'admin_payment_mode' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data.startsWith('set_verify:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change payment verify mode.', adminButtons());
    const mode = data.split(':')[1] === 'txid' ? 'txid' : 'auto';
    db.settings.paymentVerifyMode = mode;
    saveData();
    addAdminLog('payment_verify_mode_changed', from.id, mode, {});
    return sendMessage(chatId, `✅ Payment verify mode changed to: <b>${mode === 'txid' ? 'TXID / Hash Verify' : 'Auto Verify'}</b>`, adminButtons());
  }
  if (data === 'admin_alert_preview') {
    const p = activeProducts()[0] || db.products[0];
    if (!p) return sendMessage(chatId, 'No product found for preview.', adminButtons());
    const fakeOrder = { productName: p.name, qty: 1, total: getProductPrice(p, ''), currency: p.currency || currency() };
    return sendMessage(chatId, `🎨 <b>Premium Alert Preview</b>\n\n<b>Purchase Alert:</b>\n${premiumPurchaseAlert(fakeOrder, p)}\n\n<b>Stock Alert:</b>\n${premiumStockAlertText(p, 5)}`, adminButtons());
  }
  if (data === 'admin_manager') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can manage admins.', adminButtons());
    const admins = adminList();
    let out = `👑 <b>Admin Manager</b>\n\nTotal Admins: <b>${admins.length}</b>\nActive: <b>${admins.filter(a => a.active !== false).length}</b>\n\n`;
    admins.forEach((a, i) => {
      out += `${i + 1}. ${a.active === false ? '⛔' : '✅'} <b>${escapeHtml(a.name || a.username || 'Admin')}</b> ${a.username ? '@' + escapeHtml(a.username) : ''}\n`;
      out += `ID: <code>${escapeHtml(a.id)}</code>\nRole: <b>${escapeHtml(adminRoleLabel(a.role))}</b>\nAdded: ${escapeHtml(a.addedAt ? new Date(a.addedAt).toLocaleString() : '-')}\n\n`;
    });
    return sendMessage(chatId, out, inline(adminManagerRows()));
  }
  if (data === 'adm_add') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can add admins.', adminButtons());
    setSession(from.id, { type: 'adm_add_id' });
    return sendMessage(chatId, '➕ <b>Add Admin</b>\n\nSend Telegram User ID or @username if that user already used the bot.\n\nExample:\n<code>123456789</code>\n<code>@username</code>', cancelAdminButtons());
  }
  if (data.startsWith('adm_view:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can view admin manager.', adminButtons());
    const id = data.split(':')[1];
    const a = adminList().find(x => String(x.id) === String(id));
    if (!a) return sendMessage(chatId, '❌ Admin not found.', inline(adminManagerRows()));
    const logs = (db.adminActionLogs || []).filter(l => String(l.by) === String(id) || String(l.target) === String(id)).slice(0, 5).map(l => `${new Date(l.at).toLocaleString()} — ${l.action}`).join('\n') || 'No logs yet.';
    return sendMessage(chatId, `👤 <b>Admin Detail</b>\n\nName: <b>${escapeHtml(a.name || 'Admin')}</b>\nUsername: ${a.username ? '@' + escapeHtml(a.username) : '-'}\nID: <code>${escapeHtml(a.id)}</code>\nRole: <b>${escapeHtml(adminRoleLabel(a.role))}</b>\nStatus: <b>${a.active === false ? 'Disabled' : 'Active'}</b>\nAdded By: <code>${escapeHtml(a.addedBy || '-')}</code>\nAdded At: ${escapeHtml(a.addedAt ? new Date(a.addedAt).toLocaleString() : '-')}\n\n<b>Recent Admin Logs:</b>\n<code>${escapeHtml(logs)}</code>`, adminDetailButtons(id));
  }
  if (data.startsWith('adm_toggle:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can disable admins.', adminButtons());
    const id = data.split(':')[1];
    if (String(id) === ADMIN_ID) return sendMessage(chatId, '❌ Main owner cannot be disabled.', adminButtons());
    const a = adminList().find(x => String(x.id) === String(id));
    if (!a) return sendMessage(chatId, '❌ Admin not found.', adminButtons());
    a.active = a.active === false ? true : false;
    saveData();
    addAdminLog(a.active ? 'admin_enabled' : 'admin_disabled', from.id, id, { username: a.username || '' });
    try { await sendMessage(id, a.active ? '✅ Your admin access has been enabled.' : '⛔ Your admin access has been disabled.'); } catch (_) {}
    return sendMessage(chatId, `✅ Admin ${a.active ? 'enabled' : 'disabled'}: ${escapeHtml(a.name || a.id)}`, adminDetailButtons(id));
  }
  if (data.startsWith('adm_remove:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can remove admins.', adminButtons());
    const id = data.split(':')[1];
    if (String(id) === ADMIN_ID) return sendMessage(chatId, '❌ Main owner cannot be removed.', adminButtons());
    db.admins = adminList().filter(a => String(a.id) !== String(id));
    saveData();
    addAdminLog('admin_removed', from.id, id, {});
    try { await sendMessage(id, '🗑 Your admin access has been removed.'); } catch (_) {}
    return sendMessage(chatId, `🗑 Admin removed: <code>${escapeHtml(id)}</code>`, inline(adminManagerRows()));
  }
  if (data.startsWith('adm_role:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change admin role.', adminButtons());
    const [, id, roleRaw] = data.split(':');
    if (String(id) === ADMIN_ID) return sendMessage(chatId, '❌ Main owner role cannot be changed.', adminButtons());
    const a = adminList().find(x => String(x.id) === String(id));
    if (!a) return sendMessage(chatId, '❌ Admin not found.', adminButtons());
    a.role = normalizeAdminRole(roleRaw);
    saveData();
    addAdminLog('admin_role_changed', from.id, id, { role: a.role });
    try { await sendMessage(id, `🛡 Your admin role changed to: ${adminRoleLabel(a.role)}`); } catch (_) {}
    return sendMessage(chatId, `✅ Role updated: ${escapeHtml(adminRoleLabel(a.role))}`, adminDetailButtons(id));
  }
  if (data.startsWith('adm_msg:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can message admins from manager.', adminButtons());
    setSession(from.id, { type: 'adm_direct_msg', adminId: data.split(':')[1] });
    return sendMessage(chatId, `📩 Send message for admin <code>${escapeHtml(data.split(':')[1])}</code>.`, cancelAdminButtons());
  }
  if (data === 'adm_broadcast') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can broadcast to admins.', adminButtons());
    setSession(from.id, { type: 'adm_broadcast_msg' });
    return sendMessage(chatId, '📣 Send message to broadcast to all active admins.', cancelAdminButtons());
  }
  if (data === 'adm_logs') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const logs = (db.adminActionLogs || []).slice(0, 25);
    let out = '📜 <b>Admin Action Logs</b>\n\n';
    if (!logs.length) out += 'No admin logs yet.';
    logs.forEach((l, i) => {
      out += `${i + 1}. <b>${escapeHtml(l.action)}</b>\nBy: <code>${escapeHtml(l.by || '-')}</code> | Target: <code>${escapeHtml(l.target || '-')}</code>\n${escapeHtml(new Date(l.at).toLocaleString())}\n\n`;
    });
    return sendMessage(chatId, out, adminButtons());
  }

  clearSession(from.id);
  const stats = revenueStats();
  const active = db.products.filter((p) => p.active !== false);
  const hidden = db.products.filter((p) => p.active === false).length;
  const pending = db.payments.filter((p) => p.status === 'pending' || p.status === 'review').length;
  const low = active.filter((p) => p.stock.length <= 2).length;

  return sendMessage(chatId, `⚙️ <b>${escapeHtml(STORE_NAME)} Pro Admin Panel</b>\n👤 Admin Role: <b>${escapeHtml(adminRoleLabel(adminRole(from.id) || 'manager'))}</b>\nActive Admins: <b>${adminList().filter(a => a.active !== false).length}</b>\n\n\n<blockquote>👥 <b>Users:</b> ${Object.keys(db.users).length}\n📦 <b>Active Products:</b> ${active.length}\n♻️ <b>Hidden Products:</b> ${hidden}\n📊 <b>Total Stock:</b> ${stats.stockCount}\n⚠️ <b>Low Stock:</b> ${low}\n🧾 <b>Orders:</b> ${db.orders.length}\n💳 <b>Pending:</b> ${pending}\n💰 <b>Revenue:</b> ${adminMoney(stats.revenue)}</blockquote>\n\n🛠 <b>Product Manager</b> me product edit/delete/stock/logo/pin sab ek jagah manage hoga.\n✨ Choose an admin tool below.`, adminButtons());
}

async function showAdminProducts(chatId, page = 1) {
  const all = activeProducts();
  const total = Math.max(1, Math.ceil(all.length / SHOP_PAGE_SIZE));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = all.slice((safe - 1) * SHOP_PAGE_SIZE, safe * SHOP_PAGE_SIZE);

  let out = `🛠 <b>Product Manager ${safe}/${total}</b>\n\nTap any product below to manage edit, stock, logo, pin, hide or delete.\n\n`;
  if (!items.length) out += 'No active products found.';
  items.forEach((p) => {
    out += `${p.code} | ${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\nPrice: ${money(p.price, p.currency || currency())} | Stock: ${p.stock.length} | ${p.pinned ? '📌 Pinned' : 'Normal'}\n\n`;
  });

  const rows = items.map((p) => [{
    text: `${p.code} ${p.emoji || '📦'} ${short(p.name, 28)} | Stock ${p.stock.length}`,
    callback_data: `admin_product:${p.code}`
  }]);

  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `admin_products:${safe - 1}` : 'noop' },
    { text: `${safe}/${total}`, callback_data: 'noop' },
    { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `admin_products:${safe + 1}` : 'noop' }
  ]);
  rows.push([
    { text: '➕ Add Product', callback_data: 'admin_add_product' },
    { text: '♻️ Hidden', callback_data: 'admin_hidden:1' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);

  return sendMessage(chatId, out, inline(rows));
}

async function showAdminProductManage(chatId, code) {
  const p = db.products.find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
  if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());

  const active = p.active !== false ? '🟢 Active' : '🔴 Hidden';
  const desc = p.description ? escapeHtml(short(p.description.replace(/\n/g, ' '), 180)) : 'No description';
  const previewStock = p.stock.slice(0, 3).map((x, i) => `${i + 1}. ${escapeHtml(short(x, 45))}`).join('\n') || 'No stock';

  return sendMessage(chatId, `🛠 <b>Manage Product</b>\n\n<blockquote>${p.code} | ${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\n${active}\n💵 Price: <b>${money(p.price, p.currency || currency())}</b>\n📦 Stock: <b>${p.stock.length}</b>\n📌 Pinned: <b>${p.pinned ? 'Yes' : 'No'}</b></blockquote>\n\n📝 <b>Description Preview:</b>\n${desc}\n\n📋 <b>Stock Preview:</b>\n<code>${previewStock}</code>\n\n💎 <b>Special Prices:</b>\n<code>${escapeHtml(specialPriceRows(p))}</code>\n\nChoose what you want to do:`, productManagerButtons(p));
}

async function showHiddenProducts(chatId, page = 1) {
  const hidden = db.products.filter((p) => p.active === false);
  const pageSize = 8;
  const total = Math.max(1, Math.ceil(hidden.length / pageSize));
  const safe = Math.min(Math.max(Number(page) || 1, 1), total);
  const items = hidden.slice((safe - 1) * pageSize, safe * pageSize);

  let out = `♻️ <b>Hidden Products ${safe}/${total}</b>\n\n`;
  if (!items.length) out += 'No hidden products.';
  items.forEach((p) => {
    out += `${p.code} | ${p.emoji || '📦'} ${escapeHtml(p.name)}\nPrice: ${money(p.price, p.currency || currency())} | Stock: ${p.stock.length}\n\n`;
  });

  const rows = items.map((p) => [{
    text: `♻️ Restore ${p.code} ${short(p.name, 25)}`,
    callback_data: `restore_product:${p.code}`
  }]);
  rows.push([
    { text: safe > 1 ? '⬅️ Prev' : '·', callback_data: safe > 1 ? `admin_hidden:${safe - 1}` : 'noop' },
    { text: `${safe}/${total}`, callback_data: 'noop' },
    { text: safe < total ? 'Next ➡️' : '·', callback_data: safe < total ? `admin_hidden:${safe + 1}` : 'noop' }
  ]);
  rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);

  return sendMessage(chatId, out, inline(rows));
}

async function showProductStock(chatId, code) {
  const p = db.products.find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
  if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
  let out = `📋 <b>Stock for ${p.code}</b>\n${escapeHtml(p.name)}\n\nTotal: <b>${p.stock.length}</b>\n\n`;
  if (!p.stock.length) out += 'No stock available.';
  else out += '<code>' + escapeHtml(p.stock.slice(0, 30).map((x, i) => `${i + 1}. ${x}`).join('\n')) + '</code>';
  if (p.stock.length > 30) out += `\n\n...and ${p.stock.length - 30} more`;
  return sendMessage(chatId, out, inline([
    [{ text: '📥 Add Stock', callback_data: `admin_product_stock:${p.code}` }],
    [{ text: '⬅️ Manage Product', callback_data: `admin_product:${p.code}` }]
  ]));
}

async function showPaymentMethodManage(chatId, methodId) {
  const m = db.paymentMethods.find((x) => x.id === methodId);
  if (!m) return sendMessage(chatId, '❌ Payment method not found.', paymentMethodAdminButtons());

  return sendMessage(chatId, `💳 <b>Manage Payment Method</b>\n\n<blockquote>ID: <code>${escapeHtml(m.id)}</code>\nStatus: <b>${m.active === false ? 'OFF 🔴' : 'ON 🟢'}</b>\nIcon: ${escapeHtml(m.icon || '💳')}\nName: <b>${escapeHtml(m.name)}</b>\nKey: <code>${escapeHtml(m.key || '')}</code></blockquote>\n\n📝 <b>Details:</b>\n${escapeHtml(m.details || 'No payment details set.')}\n\nChoose action below.`, paymentMethodManageButtons(m));
}

async function showRecentBinanceDeposits(chatId) {
  await sendMessage(chatId, '⏳ Fetching recent Binance deposits...');
  try {
    const deposits = await fetchDeposits(binanceCfg().coin);
    let out = `📋 <b>Recent Binance Deposits</b>\n\nCoin: <b>${escapeHtml(binanceCfg().coin)}</b>\nFound: <b>${deposits.length}</b>\n\n`;
    deposits.slice(0, 8).forEach((d, i) => {
      out += `${i + 1}. Amount: <b>${escapeHtml(d.amount || '-')}</b>\nTXID: <code>${escapeHtml(short(d.txId || '-', 70))}</code>\nTime: ${d.insertTime ? escapeHtml(new Date(d.insertTime).toLocaleString()) : '-'}\n\n`;
    });
    if (!deposits.length) out += 'No successful deposits found in lookback window.';
    return sendMessage(chatId, out, binanceAdminButtons());
  } catch (err) {
    return sendMessage(chatId, `❌ Could not fetch deposits:\n${escapeHtml(err.message)}`, binanceAdminButtons());
  }
}

async function showBotSettings(chatId) {
  return sendMessage(chatId, `⚙️ <b>Bot Settings</b>\n\n<blockquote>🏪 Store Name: <b>${escapeHtml(STORE_NAME)}</b>\n🤖 Bot Username: <b>@${escapeHtml(getBotUsername() || botUsername || '-')}</b>\n🆘 Support: <b>${escapeHtml(db.settings.supportUsername || SUPPORT_USERNAME)}</b>\n🌐 Channel: <code>${escapeHtml(db.settings.channelUrl || CHANNEL_URL || '-')}</code>\n💵 Currency: <b>${escapeHtml(currency())}</b></blockquote>\n\nNote: Actual Telegram username can only be changed from <b>BotFather</b>. This setting is used for referral links and bot links inside your store.`, inline([
    [
      { text: '🔗 Bot Username', callback_data: 'admin_bot_username' },
      { text: '🆘 Support Username', callback_data: 'admin_support_username' }
    ],
    [
      { text: '🌐 Channel URL', callback_data: 'admin_channel_url' },
      { text: '💵 Currency', callback_data: 'admin_currency' }
    ],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]));
}

async function showBinanceAdmin(chatId) {
  const cfg = binanceCfg();
  return sendMessage(chatId, `🔐 <b>Binance Auto Verify Settings</b>\n\n<blockquote>🆔 UID: <code>${escapeHtml(cfg.id || '-')}</code>\n🏷 Name: <b>${escapeHtml(db.settings.binanceName || 'YourStore')}</b>\n🪙 Coin: <b>${escapeHtml(cfg.coin)}</b>\n🌐 Base URL: <code>${escapeHtml(cfg.baseUrl)}</code>\n📅 Lookback: <b>${cfg.lookbackDays} days</b>\n🎯 Amount Tolerance: <b>${cfg.tolerance}</b>\n🧩 Partial TXID: <b>${cfg.allowPartialTxid ? 'ON' : 'OFF'}</b>\n🔑 API Key: <b>${mask(cfg.apiKey)}</b>\n🔐 Secret: <b>${mask(cfg.secretKey)}</b></blockquote>\n\n⚠️ Binance API should have <b>Reading ON</b> and <b>Withdrawal OFF</b>.\n\nChoose setting below:`, binanceAdminButtons());
}

// =====================
// CALLBACKS
// =====================
async function handleCallback(q) {
  runtimeStats.callbacks++; runtimeStats.lastUpdateAt = Date.now();
  const data = String(q.data || '');
  runtimeStats.lastCallback = data;
  const chatId = q.message.chat.id;
  const from = q.from;
  await answerCallback(q.id);
  getUser(from);
  ensureTelegramAdmin(from);
  if (!isAdmin(from.id) && isUserSecurityLocked(from.id)) {
    const lock = db.securityLocks[String(from.id)] || {};
    return sendMessage(chatId, `🔒 <b>Security Lock</b>

Your account is temporarily locked.
Reason: ${escapeHtml(lock.reason || 'Security protection')}
Until: ${escapeHtml(lock.until ? new Date(lock.until).toLocaleString() : 'manual unlock')}

Contact support if this is a mistake.`);
  }
  if (!isAdmin(from.id) && rateLimitHit('callback', from.id, Number(db.settings.userCallbackLimitPerMin || 50), 60 * 1000, { data })) {
    return sendMessage(chatId, `🚦 <b>Slow down</b>

Too many button clicks. Try again after 1 minute.`);
  }
  if (isBannedUser(from.id)) return sendMessage(chatId, '🚫 <b>Your access to this store is blocked.</b>');
  if (db.settings.maintenanceMode && !isAdmin(from.id) && data !== 'support') return sendMessage(chatId, `🛠 <b>Store Maintenance</b>\n\n${escapeHtml(db.settings.maintenanceMessage || 'Store is under maintenance. Please try again later.')}`);

  if (data === 'noop') return;
  if (data === 'home') return showHome(chatId, from);
  if (data === 'clear') {
    clearSession(from.id);
    const deleted = await clearTrackedChat(chatId, q.message?.message_id);
    await sendMessage(chatId, `🧹 <b>Chat Restarted</b>\n\nDeleted recent bot messages: ${deleted}\nSession reset successfully.\n\nNote: Telegram only allows bots to delete messages they are allowed to delete.`, homeButtons(from.id));
    return showHome(chatId, from);
  }
  if (data === 'categories') return showCategories(chatId, from);
  if (data.startsWith('cat:')) {
    const [, idx, page] = data.split(':');
    return showCategoryProducts(chatId, from, Number(idx || 0), Number(page || 1));
  }
  if (data.startsWith('shop:')) return showShop(chatId, from, Number(data.split(':')[1]) || 1);
  if (data.startsWith('view:')) return showProduct(chatId, from, data.split(':')[1]);
  if (data.startsWith('buy:')) return askQty(chatId, from, data.split(':')[1]);
  if (data.startsWith('qty:')) {
    const [, code, qty] = data.split(':');
    return showCheckout(chatId, from, code, Number(qty));
  }
  if (data.startsWith('qtycustom:')) {
    setSession(from.id, { type: 'custom_qty', productCode: data.split(':')[1] });
    return sendMessage(chatId, '✍️ Send custom quantity.', inline([[{ text: 'Cancel', callback_data: 'home' }]]));
  }
  if (data.startsWith('paymethods:')) {
    const [, code, qtyRaw] = data.split(':');
    const p = productByCode(code);
    if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
    const qty = Number(qtyRaw);
    const unitPrice = getProductUnitPrice(p, from.id, qty);
    return showPaymentMethods(chatId, from, { productCode: code, qty, unitPrice, subtotal: unitPrice * qty, total: unitPrice * qty, discount: 0, couponCode: '' });
  }
  if (data === 'checkout_back') {
    const s = getSession(from.id);
    if (s?.productCode && s?.qty) return showCheckout(chatId, from, s.productCode, s.qty);
    return showShop(chatId, from, 1);
  }
  if (data === 'paywallet') {
    const s = getSession(from.id);
    if (!s?.productCode) return sendMessage(chatId, '❌ Open checkout first.', homeButtons(from.id));
    return completeWalletOrder(chatId, from, s);
  }
  if (data.startsWith('paymethod:')) {
    const s = getSession(from.id);
    if (!s?.productCode) return sendMessage(chatId, '❌ Open checkout first.', homeButtons(from.id));
    const method = db.paymentMethods.find((m) => m.id === data.split(':')[1] && m.active !== false);
    if (!method) return sendMessage(chatId, '❌ Payment method not found.', homeButtons(from.id));
    const payment = createPayment(from.id, s, method);
    db.payments.push(payment);
    saveData();
    return showPaymentInstruction(chatId, from, payment);
  }
  if (data === 'coupon') {
    const s = getSession(from.id);
    if (!s?.productCode || !s?.qty) return sendMessage(chatId, '❌ Open checkout first.', homeButtons(from.id));
    setSession(from.id, { ...s, type: 'coupon_input' });
    return sendMessage(chatId, '🎟 Send coupon code now.\nExample: SAVE10', inline([[{ text: 'Back', callback_data: 'checkout_back' }]]));
  }
  if (data.startsWith('submit:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1] && x.telegramId === String(from.id));
    if (!p) return sendMessage(chatId, '❌ Payment not found.', homeButtons(from.id));
    setSession(from.id, { type: 'submit_txid', paymentId: p.id });
    return sendMessage(chatId, `🧾 <b>Submit TXID / Order ID</b>

Payment ID: <code>${escapeHtml(p.id)}</code>
Amount: <b>${money(p.amount, p.currency)}</b>

Auto Verify fail ho gaya ya Reference Note add karna bhul gaye ho, to Binance ka TXID / Hash / Order ID bhejo.

👇 Send TXID / Order ID now.`, inline([
      [{ text: '✅ Try Auto Verify Again', callback_data: `paystatus:${p.id}` }],
      [{ text: 'Cancel', callback_data: `cancelpay:${p.id}` }]
    ]));
  }
  if (data.startsWith('paystatus:')) return showPaymentStatus(chatId, from, data.split(':')[1]);
  if (data.startsWith('cancelpay:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1] && x.telegramId === String(from.id));
    if (p) {
      p.status = 'cancelled';
      saveData();
    }
    clearSession(from.id);
    return sendMessage(chatId, '❌ Payment cancelled.', homeButtons(from.id));
  }
  if (data === 'user_tools') {
    return sendTrackedMessage(chatId, `🧰 <b>User Tools</b>\n\nManage your orders, payments, wallet history, referral link, notifications and product search.`, userToolsButtons(from.id));
  }
  if (data === 'claim_freebie' || data === 'freebie') return showFreebie(chatId, from);
  if (data === 'user_top_deals') return showTopDeals(chatId, from);
  if (data === 'user_best_sellers') return showBestSellers(chatId, from);
  if (data === 'wallet_history') return showWalletHistory(chatId, from);
  if (data === 'user_payments_list') return showUserPaymentsList(chatId, from);
  if (data === 'refer_user') return showReferral(chatId, from);
  if (data === 'toggle_notifications') return toggleUserNotifications(chatId, from);
  if (data === 'search_product') {
    setSession(from.id, { type: 'search_product' });
    return sendTrackedMessage(chatId, '🔎 Send product name or code to search.\nExample: ChatGPT or P001', inline([[{ text: '🏠 Main Menu', callback_data: 'home' }]]));
  }
  if (data === 'profile') return showProfile(chatId, from);
  if (data === 'my_reviews') return showMyReviews(chatId, from);
  if (data === 'replacement_help') return sendMessage(chatId, '🛡 <b>Replacement Help</b>\n\nFor any issue in delivered item:\n1. Open My Orders\n2. Tap View Order\n3. Tap Replacement\n\nAdmin will receive your request with order details.', userToolsButtons(from.id));
  if (data.startsWith('review_order:')) {
    const order = db.orders.find(o => o.id === data.split(':')[1] && o.telegramId === String(from.id));
    if (!order) return sendMessage(chatId, '❌ Order not found.', userToolsButtons(from.id));
    return sendMessage(chatId, `⭐ <b>Rate Your Order</b>\n\n${escapeHtml(order.productName)}\nOrder: <code>${escapeHtml(order.id)}</code>\n\nChoose rating:`, inline([
      [
        { text: '⭐ 1', callback_data: `rate_order:${order.id}:1` },
        { text: '⭐ 2', callback_data: `rate_order:${order.id}:2` },
        { text: '⭐ 3', callback_data: `rate_order:${order.id}:3` }
      ],
      [
        { text: '⭐ 4', callback_data: `rate_order:${order.id}:4` },
        { text: '⭐ 5', callback_data: `rate_order:${order.id}:5` }
      ],
      [{ text: 'Back to Order', callback_data: `order_view:${order.id}` }]
    ]));
  }
  if (data.startsWith('rate_order:')) {
    const [, orderId, ratingRaw] = data.split(':');
    const order = db.orders.find(o => o.id === orderId && o.telegramId === String(from.id));
    if (!order) return sendMessage(chatId, '❌ Order not found.', userToolsButtons(from.id));
    const rating = Math.max(1, Math.min(5, Number(ratingRaw || 5)));
    setSession(from.id, { type: 'review_text', orderId, rating });
    createOrUpdateReview(order, from, rating, '');
    return sendMessage(chatId, `✅ Rating saved: ${ratingStars(rating)} ${rating}/5\n\nSend a short review message now, or tap Skip.`, inline([
      [{ text: 'Skip Review Text', callback_data: `review_skip:${order.id}` }],
      [{ text: '🏠 Main Menu', callback_data: 'home' }]
    ]));
  }
  if (data.startsWith('review_skip:')) {
    clearSession(from.id);
    return sendMessage(chatId, '✅ Thank you for your rating! ❤️', userToolsButtons(from.id));
  }
  if (data.startsWith('replace_order:')) {
    const order = db.orders.find(o => o.id === data.split(':')[1] && o.telegramId === String(from.id));
    if (!order) return sendMessage(chatId, '❌ Order not found.', userToolsButtons(from.id));
    const { ticket, created } = await createReplacementTicket(from, order);
    return sendMessage(chatId, created ? `🛡 <b>Replacement Request Sent</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\nOrder: <code>${escapeHtml(order.id)}</code>\n\nStatus: <b>Waiting for admin approval</b>\n\nAdmin approve karega tab replacement auto deliver hoga.` : `✅ Replacement request already pending.\nTicket: <code>${escapeHtml(ticket.id)}</code>\nStatus: <b>${escapeHtml(ticket.replacementStatus || ticket.status)}</b>`, userToolsButtons(from.id));
  }
  if (data.startsWith('order_view:')) return showOrderDetail(chatId, from, data.split(':')[1]);
  if (data === 'orders') return showOrders(chatId, from, 1);
  if (data.startsWith('orders_page:')) {
    const parts = data.split(':');
    const page = Number(parts[1] || 1);
    const search = decodeURIComponent(parts.slice(2).join(':') || '');
    return showOrders(chatId, from, page, search);
  }
  if (data === 'orders_search') {
    setSession(from.id, { type: 'order_search' });
    return sendMessage(chatId, '🔎 <b>Search Your Orders</b>\n\nSend order ID, product name, product code, coupon or status.\nExample: Gemini', inline([[{ text: 'Cancel', callback_data: 'orders' }]]));
  }
  if (data === 'orders_stats') {
    const orders = userOrders(from.id);
    return sendMessage(chatId, orderHistoryText(orders, 'My Order Stats', 12), inline([
      [{ text: '📄 Export TXT', callback_data: 'orders_export_txt' }],
      [{ text: '📦 My Orders', callback_data: 'orders' }]
    ]));
  }
  if (data === 'orders_export_txt') {
    const orders = userOrders(from.id);
    const txt = orderHistoryPlainText(orders, `Order History - ${from.first_name || from.id}`);
    return sendMessage(chatId, `<b>📄 Your Order History TXT</b>\n\n<code>${escapeHtml(txt.slice(0, 3800))}</code>${txt.length > 3800 ? '\n\nToo long: showing first part only.' : ''}`, inline([[{ text: '📦 My Orders', callback_data: 'orders' }], [{ text: '🏠 Main Menu', callback_data: 'home' }]]));
  }
  if (data === 'deposit') return showDeposit(chatId, from);
  if (data.startsWith('depamt:')) return showDepositMethods(chatId, from, Number(data.split(':')[1]));
  if (data === 'depcustom') {
    setSession(from.id, { type: 'custom_deposit_amount' });
    return sendMessage(chatId, '✍️ Send deposit amount.\nExample: 25', inline([[{ text: 'Cancel', callback_data: 'deposit' }]]));
  }
  if (data.startsWith('depmethod:')) {
    const [, amountRaw, methodId] = data.split(':');
    const amount = Number(amountRaw);
    const method = db.paymentMethods.find((m) => m.id === methodId && m.active !== false);
    if (!amount || !method) return sendMessage(chatId, '❌ Invalid deposit request.', depositAmountButtons());
    const payment = createDepositPayment(from.id, amount, method);
    db.payments.push(payment);
    saveData();
    return showDepositInstruction(chatId, from, payment);
  }
  if (data === 'wishlist') return showWishlist(chatId, from);
  if (data === 'my_restock_requests') return showMyRestockRequests(chatId, from);
  if (data.startsWith('fav:')) {
    const code = data.split(':')[1];
    const added = toggleWishlist(from.id, code);
    const p = productByCode(code);
    return sendMessage(chatId, `${added ? '⭐ Added to wishlist' : '🗑 Removed from wishlist'}\n\n${p ? escapeHtml(p.name) : code}`, p ? productButtons(p, from.id) : userToolsButtons(from.id));
  }
  if (data.startsWith('restock:')) {
    try {
      const { request, created } = createRestockRequest(from, data.split(':')[1]);
      await sendMessage(ADMIN_ID, `🔔 <b>New Restock Request</b>\n\nProduct: <b>${escapeHtml(request.productName)}</b>\nUser: <b>${escapeHtml(request.firstName)}</b> ${request.username ? '@' + escapeHtml(request.username) : ''}\nID: <code>${escapeHtml(request.telegramId)}</code>`, adminButtons());
      return sendMessage(chatId, created ? `✅ Restock request saved.\n\nYou will be notified when <b>${escapeHtml(request.productName)}</b> is back in stock.` : `✅ You already requested restock for <b>${escapeHtml(request.productName)}</b>.`, userToolsButtons(from.id));
    } catch (err) {
      return sendMessage(chatId, `❌ ${escapeHtml(err.message)}`, userToolsButtons(from.id));
    }
  }
  if (data === 'user_faq') return sendMessage(chatId, escapeHtml(db.settings.faqText || 'No FAQ added yet.'), userToolsButtons(from.id));
  if (data === 'support_ticket') {
    setSession(from.id, { type: 'support_ticket_msg' });
    return sendMessage(chatId, '🎫 <b>Open Support Ticket</b>\n\nSend your issue/message now. Include order ID or payment ID if related.', inline([[{ text: 'Cancel', callback_data: 'home' }]]));
  }
  if (data === 'support') return showSupport(chatId, from);

  // Admin
  if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
  if (data === 'admin') return showAdmin(chatId, from, data);
  const legacyAdminCallbacks = [
    'admin_bulk_tools',
    'bulk_hide_oos',
    'bulk_show_all',
    'admin_profit_report',
    'admin_campaign_center',
    'camp_custom',
    'camp_product',
    'camp_flash',
    'admin_flash_sale',
    'admin_payment_mode',
    'admin_alert_preview',
    'admin_manager',
    'adm_add',
    'adm_broadcast',
    'adm_logs'
  ];
  if (
    legacyAdminCallbacks.includes(data) ||
    data.startsWith('camp_seg:') ||
    data.startsWith('flash_disable:') ||
    data.startsWith('set_verify:') ||
    data.startsWith('adm_view:') ||
    data.startsWith('adm_toggle:') ||
    data.startsWith('adm_remove:') ||
    data.startsWith('adm_role:') ||
    data.startsWith('adm_msg:')
  ) {
    return showAdmin(chatId, from, data);
  }

  if (data.startsWith('gen_desc:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', p.stockFormat || 'redeem_link');
    saveData();
    return sendMessage(chatId, `✅ <b>Detailed description generated</b>\n\n${formatRichProductDescription(p.description)}`, productManagerButtons(p));
  }
  if (data.startsWith('delivery_msg:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'delivery_msg_template', productCode: p.code });
    return sendMessage(chatId, `🚚 <b>Set Delivery Message Template</b>\n\nProduct: <b>${escapeHtml(p.name)}</b>\n\nSend template now.\n\n${deliveryTemplateHelpText()}`, cancelAdminButtons());
  }
  if (data === 'admin_custom_announce') {
    setSession(from.id, { type: 'custom_announcement' });
    return sendMessage(chatId, `✍️ <b>Custom Premium Message</b>\n\nSend your message and choose what to bold using:\n<code>[b]bold[/b]</code> or <code>**bold**</code>\n\nAlso supported: <code>[i]italic[/i]</code>, <code>[code]code[/code]</code>, <code>[line]</code>`, cancelAdminButtons());
  }
  if (data === 'admin_custom_emoji_help') {
    setSession(from.id, { type: 'capture_custom_emoji_ids' });
    return sendMessage(chatId, customEmojiHelpText() + `\n\n👇 Now send custom emoji/logo message.`, cancelAdminButtons());
  }
  if (data.startsWith('brandcodes:')) {
    return sendMessage(chatId, brandCodeRowsText(data.split(':')[1] || 'all'), adminButtons());
  }
  if (data === 'admin_brand_codes') {
    return sendMessage(chatId, brandCodeRowsText('all'), inline([
      [{ text: '🤖 AI', callback_data: 'brandcodes:ai' }, { text: '🖼 Image', callback_data: 'brandcodes:image' }],
      [{ text: '💻 Dev', callback_data: 'brandcodes:dev' }, { text: '🎨 Design', callback_data: 'brandcodes:design' }],
      [{ text: '🎓 Edu', callback_data: 'brandcodes:edu' }, { text: '⚙️ Admin', callback_data: 'admin' }]
    ]));
  }
  if (data === 'admin_logo_help') {
    return sendMessage(chatId, `🎯 <b>Product Logo / Icon System</b>\n\nBot auto-detects logos for:\nCoursera, Gemini, Notion, Lovable, ChatGPT, Canva, Cursor, Claude, Perplexity, Adobe, CapCut, Replit, YouTube and more.\n\nSet custom logo:\n<code>/setlogo P001 💎</code>\n\nSet custom promo template:\n<code>/setpromo P001 [b]{name}[/b]\n💰 Price: {price}\n📦 Stock: {stock}\n🛒 Buy @{bot}</code>\n\nVariables: <code>{name}</code>, <code>{price}</code>, <code>{stock}</code>, <code>{bot}</code>, <code>{store}</code>, <code>{link}</code>`, adminButtons());
  }
  if (data === 'admin_today_summary') {
    return sendMessage(chatId, businessSummaryText(1), adminButtons());
  }
  if (data === 'admin_summary_7d') {
    return sendMessage(chatId, businessSummaryText(7), adminButtons());
  }
  if (data === 'admin_inventory_value') {
    return sendMessage(chatId, inventoryValuationText(), adminButtons());
  }
  if (data === 'admin_backup_center') {
    return sendMessage(chatId, backupStatusText(), backupAdminButtons());
  }
  if (data === 'backup_create_now') {
    try {
      const b = createDataBackup('telegram-admin');
      pruneOldBackups(db.settings.autoBackupMaxFiles || 30);
      addSecurityLog('manual_backup_created', from.id, { file: b.file, size: b.size }, 'info');
      return sendMessage(chatId, `✅ <b>Backup Created</b>\n\nFile: <code>${escapeHtml(b.file)}</code>\nSize: <b>${escapeHtml(bytesHuman(b.size))}</b>`, backupAdminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Backup failed: ${escapeHtml(err.message)}`, backupAdminButtons());
    }
  }
  if (data === 'backup_toggle_auto') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change backup settings.', backupAdminButtons());
    db.settings.autoBackupEnabled = db.settings.autoBackupEnabled === false ? true : false;
    saveData();
    addSecurityLog('auto_backup_toggled', from.id, { enabled: db.settings.autoBackupEnabled }, 'info');
    return sendMessage(chatId, `✅ Auto Backup is now <b>${db.settings.autoBackupEnabled ? 'ON' : 'OFF'}</b>.`, backupAdminButtons());
  }
  if (data.startsWith('group_reply_preview:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, premiumGroupProductReply(p, productKeywordList(p)[0] || p.name), directBuyKeyboard(p, 'group'));
  }
if (data === 'admin_stock_wait') {
    return sendMessage(chatId, stockWaitText(), stockWaitButtons());
  }
  if (data === 'stockwait_process_all') {
    const r = await processStockWaitQueue('', 'manual');
    return sendMessage(chatId, `🔁 <b>Stock Wait Queue Processed</b>\n\n✅ Delivered: <b>${r.ok}</b>\n⏭ Skipped: <b>${r.skipped}</b>\n❌ Failed: <b>${r.fail}</b>`, stockWaitButtons());
  }
  if (data === 'stockwait_toggle_auto') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change this.', stockWaitButtons());
    db.settings.stockWaitAutoDelivery = db.settings.stockWaitAutoDelivery === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Stock wait auto delivery: <b>${db.settings.stockWaitAutoDelivery === false ? 'OFF' : 'ON'}</b>`, stockWaitButtons());
  }
  if (data === 'stockwait_logs') {
    const rows = (db.stockWaitLogs || []).slice(0, 25);
    let out = `📜 <b>Stock Wait Logs</b>\n\n`;
    if (!rows.length) out += 'No stock wait logs yet.';
    rows.forEach((l, i) => out += `${i+1}. ${l.severity === 'error' ? '🔴' : l.severity === 'warn' ? '🟡' : '🟢'} <b>${escapeHtml(l.type)}</b>\nPayment: <code>${escapeHtml(l.paymentId || '-')}</code>\nProduct: <code>${escapeHtml(l.productCode || '-')}</code>\n${escapeHtml(new Date(l.at).toLocaleString())}\n\n`);
    return sendMessage(chatId, out, stockWaitButtons());
  }
  if (data === 'payments_expire_now') {
    const r = await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
    return sendMessage(chatId, `⌛ <b>Pending Payment Expiry Scan</b>\n\nExpired: <b>${r.count}</b>\nNotified: <b>${r.notified}</b>\nValid Time: <b>${paymentExpiryMinutes()} minutes</b>`, adminButtons());
  }
if (data === 'stock_preview_again') {
    const s = getSession(from.id);
    if (!s || !s.productCode) return sendMessage(chatId, '❌ No pending stock preview session.', adminButtons());
    return sendMessage(chatId, stockAddPreviewText(s), stockPreviewConfirmButtons());
  }
  if (data === 'stock_edit_delivery_template') {
    const s = getSession(from.id);
    const p = s?.productCode ? productByCode(s.productCode) : null;
    if (!s || !p) return sendMessage(chatId, '❌ No pending stock session.', adminButtons());
    s.type = 'stock_delivery_template_edit';
    setSession(from.id, s);
    return sendMessage(chatId, `${deliveryTemplateEditorHelp(p)}\n\nCurrent template:\n<code>${escapeHtml(s.deliveryMessageTemplate || p.deliveryMessageTemplate || defaultDeliveryTemplate())}</code>\n\nSend new template now.`, cancelAdminButtons());
  }
  if (data === 'stock_edit_access_info') {
    const s = getSession(from.id);
    const p = s?.productCode ? productByCode(s.productCode) : null;
    if (!s || !p) return sendMessage(chatId, '❌ No pending stock session.', adminButtons());
    s.type = 'stock_access_info';
    setSession(from.id, s);
    return sendMessage(chatId, accessInfoPromptText(p), cancelAdminButtons());
  }
  if (data === 'stock_confirm_add') {
    const s = getSession(from.id);
    if (!s || !s.productCode) return sendMessage(chatId, '❌ No pending stock session.', adminButtons());
    return finishStockAddWorkflow(from.id, chatId, s);
  }
  if (data.startsWith('delivery_preview:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const sampleItem = p.stock?.[0] || createStockItemObject(p.stockFormat || 'redeem_link', stockLineExample(p.stockFormat || 'redeem_link'));
    return sendMessage(chatId, deliveryText(p.name, 1, p.price, p.currency || currency(), [sampleItem], 'DEMO-ORDER', true, p.code), productManagerButtons(p));
  }
  if (data.startsWith('access_info:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'product_access_info', productCode: p.code });
    return sendMessage(chatId, accessInfoPromptText(p), cancelAdminButtons());
  }
if (data === 'admin_feature_check') {
    return sendMessage(chatId, appFeatureCheckText(), adminButtons());
  }
  if (data === 'admin_easy_manage') {
    return sendMessage(chatId, easyManageText(), easyManageButtons());
  }
  if (data === 'manage_hide_oos') {
    const n = hideOutOfStockProducts();
    return sendMessage(chatId, `✅ Hidden <b>${n}</b> out-of-stock product(s).`, easyManageButtons());
  }
  if (data === 'manage_restore_all') {
    const n = restoreAllProducts();
    return sendMessage(chatId, `✅ Restored <b>${n}</b> hidden product(s).`, easyManageButtons());
  }
  if (data === 'manage_process_stockwait') {
    const r = await processStockWaitQueue('', 'easy-manage');
    return sendMessage(chatId, `⏳ <b>Stock Wait Processed</b>\n\n✅ Delivered: <b>${r.ok}</b>\n⏭ Skipped: <b>${r.skipped}</b>\n❌ Failed: <b>${r.fail}</b>`, easyManageButtons());
  }
  if (data === 'manage_expire_payments') {
    const r = await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
    return sendMessage(chatId, `⌛ <b>Expired Pending Payments</b>\n\nExpired: <b>${r.count}</b>\nNotified: <b>${r.notified}</b>`, easyManageButtons());
  }
  if (data === 'manage_backup_now') {
    const b = createDataBackup('easy-manage');
    return sendMessage(chatId, `💾 <b>Backup Created</b>\n\nFile: <code>${escapeHtml(b.file)}</code>\nSize: <b>${escapeHtml(bytesHuman(b.size))}</b>`, easyManageButtons());
  }
  if (data === 'manage_maintenance_toggle') {
    db.settings.maintenanceMode = !db.settings.maintenanceMode;
    saveData();
    return sendMessage(chatId, `🛠 Maintenance Mode: <b>${db.settings.maintenanceMode ? 'ON' : 'OFF'}</b>`, easyManageButtons());
  }
  if (data === 'manage_bulk_price_percent') {
    setSession(from.id, { type: 'manage_bulk_price_percent' });
    return sendMessage(chatId, `💵 <b>Bulk Price Update</b>\n\nSend percentage to update all active product prices.\n\nExamples:\n<code>10</code> = increase by 10%\n<code>-15</code> = decrease by 15%`, cancelAdminButtons());
  }
  if (data === 'manage_low_stock') {
    return sendMessage(chatId, lowStockManageText(), inline([[{ text: '📥 Add Stock', callback_data: 'admin_add_stock' }, { text: '🧰 Manage', callback_data: 'admin_easy_manage' }]]));
  }
  if (data === 'manage_cleanup_logs') {
    const result = cleanOldLogs(300);
    return sendMessage(chatId, `🧹 <b>Logs Cleaned</b>\n\n<code>${escapeHtml(JSON.stringify(result, null, 2))}</code>`, easyManageButtons());
  }
  if (data === 'manage_notes') {
    return sendMessage(chatId, notesText(), notesButtons());
  }
  if (data === 'note_add') {
    setSession(from.id, { type: 'admin_note_add' });
    return sendMessage(chatId, '📝 Send note/task text now.', cancelAdminButtons());
  }
  if (data.startsWith('note_done:')) {
    const id = data.split(':')[1];
    const n = (db.adminNotes || []).find(x => x.id === id);
    if (n) { n.done = !n.done; n.doneAt = n.done ? now() : ''; saveData(); }
    return sendMessage(chatId, notesText(), notesButtons());
  }
  if (data.startsWith('note_delete:')) {
    const id = data.split(':')[1];
    db.adminNotes = (db.adminNotes || []).filter(x => x.id !== id);
    saveData();
    return sendMessage(chatId, notesText(), notesButtons());
  }
if (data === 'admin_health_speed') {
    return sendMessage(chatId, premiumHealthText(), adminParityButtons());
  }
  if (data === 'admin_speed_test') {
    await sendMessage(chatId, '⏳ Running speed test...');
    const result = await runSpeedTest();
    addHealthLog('manual_speed_test', { totalMs: result.totalMs, tests: result.tests }, result.totalMs > Number(db.settings.speedWarnMs || 2500) ? 'warn' : 'info');
    return sendMessage(chatId, speedTestText(result), adminParityButtons());
  }
  if (data === 'admin_safe_delivery') {
    return sendMessage(chatId, safeDeliveryText(), safeDeliveryButtons());
  }
  if (data === 'safe_retry_failed') {
    const r = await retryFailedDeliveries(10);
    return sendMessage(chatId, `🔁 <b>Retry Failed Deliveries</b>\n\n✅ Success: <b>${r.ok}</b>\n❌ Failed: <b>${r.fail}</b>`, safeDeliveryButtons());
  }
  if (data === 'safe_delivery_logs') {
    const rows = (db.deliveryAuditLogs || []).slice(0, 25);
    let out = `📜 <b>Delivery Audit Logs</b>\n\n`;
    if (!rows.length) out += 'No delivery logs yet.';
    rows.forEach((l,i) => out += `${i+1}. ${l.severity === 'error' ? '🔴' : l.severity === 'warn' ? '🟡' : '🟢'} <b>${escapeHtml(l.type)}</b>\nOrder: <code>${escapeHtml(l.orderId || '-')}</code>\n${escapeHtml(new Date(l.at).toLocaleString())}\n\n`);
    return sendMessage(chatId, out, safeDeliveryButtons());
  }
  if (data === 'admin_security_scan') {
    return sendMessage(chatId, securityScanText(), securityCenterButtons());
  }
if (data === 'admin_diag') {
    return sendMessage(chatId, telegramAdminDiagnosticText(from), adminParityButtons());
  }
  if (data === 'admin_feature_map') {
    return sendMessage(chatId, adminFeatureMapText(), adminParityButtons());
  }
  if (data === 'admin_keyword_test') {
    setSession(from.id, { type: 'admin_keyword_test' });
    return sendMessage(chatId, `⌨️ <b>Keyword Test</b>\n\nSend any group keyword like:\n<code>gemini</code>\n<code>chatgpt</code>\n<code>notion</code>\n\nBot will show matched product + direct buy keyboard.`, cancelAdminButtons());
  }
if (data === 'admin_groups') {
    return sendMessage(chatId, groupListText(), groupManagerButtons());
  }
  if (data === 'groups_toggle_autoreg') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change this.', groupManagerButtons());
    db.settings.autoRegisterGroups = db.settings.autoRegisterGroups === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Auto Register Groups: <b>${db.settings.autoRegisterGroups === false ? 'OFF' : 'ON'}</b>`, groupManagerButtons());
  }
  if (data === 'groups_toggle_alerts') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change this.', groupManagerButtons());
    db.settings.groupAlertsEnabled = db.settings.groupAlertsEnabled === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Group Alerts: <b>${db.settings.groupAlertsEnabled === false ? 'OFF' : 'ON'}</b>`, groupManagerButtons());
  }
  if (data === 'groups_toggle_keyword') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change this.', groupManagerButtons());
    db.settings.groupKeywordReplyEnabled = db.settings.groupKeywordReplyEnabled === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Group Keyword Reply: <b>${db.settings.groupKeywordReplyEnabled === false ? 'OFF' : 'ON'}</b>`, groupManagerButtons());
  }
  if (data === 'groups_test_all') {
    const sent = await sendToRegisteredGroups(`🧪 <b>Group Alert Test</b>\n\nIf you see this message, group alerts are working.\n\n🤖 Bot: @${escapeHtml(getBotUsername() || botUsername || '')}`, inline([[{ text: '🛍 Open Store', url: `https://t.me/${getBotUsername() || botUsername}` }]]), 'test');
    return sendMessage(chatId, `✅ Test alert sent to <b>${sent}</b> group(s).`, groupManagerButtons());
  }
  if (data.startsWith('group_toggle:')) {
    const id = data.split(':').slice(1).join(':');
    const g = findAlertGroup(id);
    if (!g) return sendMessage(chatId, '❌ Group not found.', groupManagerButtons());
    g.alertsEnabled = g.alertsEnabled === false ? true : false;
    g.active = true;
    saveData();
    return sendMessage(chatId, `✅ ${escapeHtml(g.title)} alerts: <b>${g.alertsEnabled === false ? 'OFF' : 'ON'}</b>`, groupManagerButtons());
  }
  if (data.startsWith('group_test:')) {
    const id = data.split(':').slice(1).join(':');
    const g = findAlertGroup(id);
    if (!g) return sendMessage(chatId, '❌ Group not found.', groupManagerButtons());
    try {
      await sendMessage(g.id, `🧪 <b>Group Alert Test</b>\n\nGroup: <b>${escapeHtml(g.title)}</b>\nAlerts are working ✅`, inline([[{ text: '🛍 Open Store', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
      return sendMessage(chatId, `✅ Test sent to ${escapeHtml(g.title)}.`, groupManagerButtons());
    } catch (err) {
      g.lastError = err.message;
      saveData();
      return sendMessage(chatId, `❌ Test failed for ${escapeHtml(g.title)}:\n${escapeHtml(err.message)}`, groupManagerButtons());
    }
  }
if (data === 'admin_security_center') {
    return sendMessage(chatId, securityCenterText(), securityCenterButtons());
  }
  if (data === 'security_toggle_rate') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can change security settings.', securityCenterButtons());
    db.settings.securityRateLimitEnabled = db.settings.securityRateLimitEnabled === false ? true : false;
    addSecurityLog('rate_limit_toggled', from.id, { enabled: db.settings.securityRateLimitEnabled }, 'info');
    saveData();
    return sendMessage(chatId, `✅ Rate limit is now <b>${db.settings.securityRateLimitEnabled === false ? 'OFF' : 'ON'}</b>.`, securityCenterButtons());
  }
  if (data === 'security_logs') {
    const rows = (db.securityLogs || []).slice(0, 25);
    let out = '🔐 <b>Security Logs</b>\n\n';
    if (!rows.length) out += 'No security logs yet.';
    rows.forEach((l, i) => {
      out += `${i + 1}. ${l.severity === 'high' ? '🚨' : l.severity === 'warn' ? '⚠️' : 'ℹ️'} <b>${escapeHtml(l.type)}</b>\nUser: <code>${escapeHtml(l.userId || '-')}</code>\n${escapeHtml(new Date(l.at).toLocaleString())}\n\n`;
    });
    return sendMessage(chatId, out, securityCenterButtons());
  }
  if (data === 'security_locks') {
    const ids = Object.keys(db.securityLocks || {}).filter(isUserSecurityLocked);
    let out = `🔒 <b>Locked Users</b>\n\nTotal: <b>${ids.length}</b>\n\n`;
    const rows = [];
    ids.slice(0, 15).forEach(id => {
      const lock = db.securityLocks[id] || {};
      out += `User: <code>${escapeHtml(id)}</code>\nReason: ${escapeHtml(lock.reason || '-')}\nUntil: ${escapeHtml(lock.until ? new Date(lock.until).toLocaleString() : 'manual')}\n\n`;
      rows.push([{ text: `🔓 Unlock ${id}`, callback_data: `security_unlock:${id}` }]);
    });
    rows.push([{ text: '🛡 Security Center', callback_data: 'admin_security_center' }]);
    return sendMessage(chatId, out, inline(rows));
  }
  if (data.startsWith('security_unlock:')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can unlock users.', securityCenterButtons());
    const id = data.split(':')[1];
    unlockUserSecurity(id);
    return sendMessage(chatId, `✅ User unlocked: <code>${escapeHtml(id)}</code>`, securityCenterButtons());
  }
  if (data === 'security_clear_logs') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can clear logs.', securityCenterButtons());
    db.securityLogs = [];
    saveData();
    return sendMessage(chatId, '🧹 Security logs cleared.', securityCenterButtons());
  }
  if (data === 'admin_payment_risk') {
    return sendMessage(chatId, riskCenterText(12), riskCenterButtons());
  }
  if (data === 'risk_scan_now') {
    await autoScannerTick();
    return sendMessage(chatId, `✅ Safe scan completed.\n\n${riskCenterText(8)}`, riskCenterButtons());
  }
  if (data === 'risk_expire_old') {
    const count = expireOldPendingPayments(60);
    return sendMessage(chatId, `🧹 Expired ${count} pending/review payment(s) older than 60 minutes.`, riskCenterButtons());
  }
  if (data === 'admin_quick_find') {
    setSession(from.id, { type: 'admin_quick_find' });
    return sendMessage(chatId, `🔎 <b>Quick Find</b>\n\nSend any:\n• Order ID\n• Payment ID\n• TXID / Reference\n• User ID / @username\n• Product code / name`, cancelAdminButtons());
  }
  if (data === 'announce_template_maint') {
    setSession(from.id, { type: 'announcement' });
    return sendMessage(chatId, `🛠 <b>Maintenance Template</b>\n\nCopy/edit and send this:\n\n<code>${escapeHtml(maintenanceTemplateText())}</code>`, cancelAdminButtons());
  }
  if (data === 'announce_template_sale') {
    setSession(from.id, { type: 'announcement' });
    return sendMessage(chatId, `💸 <b>Sale Template</b>\n\nCopy/edit and send this:\n\n<code>${escapeHtml(saleTemplateText())}</code>`, cancelAdminButtons());
  }
  if (data === 'admin_auto_verify') {
    const pending = paymentsForAutoScan();
    return sendMessage(chatId, `🤖 <b>Auto Verify Status</b>\n\nScanner: <b>${db.settings.autoVerifyEnabled === false ? 'OFF' : 'ON'}</b>\nPending scan: <b>${pending.length}</b>\nInterval: <b>${db.settings.autoVerifyIntervalSec || 25}s</b>\nAmount match: <b>${db.settings.autoVerifyAmountMatch === false ? 'OFF' : 'ON'}</b>\n\nUse buttons below.`, inline([
      [{ text: '▶️ Run Scan Now', callback_data: 'admin_auto_scan_now' }],
      [{ text: '🔍 Test Binance API', callback_data: 'admin_binance_test' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'admin_auto_scan_now') {
    await autoScannerTick();
    return sendMessage(chatId, '✅ Auto verifier scan completed.', adminButtons());
  }
  if (data === 'admin_binance_test') {
    try {
      const txs = await fetchAllBinanceTxs();
      return sendMessage(chatId, `✅ <b>Binance API OK</b>\n\nRecent transactions found: <b>${txs.length}</b>\n\nIf count is 0, it means Binance API did not return recent deposits/pay transactions for this API key/account.`, adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ <b>Binance API Failed</b>\n\n${escapeHtml(err.message)}\n\nCheck API key, secret, permissions and IP restrictions.`, adminButtons());
    }
  }
  if (data === 'admin_channels') {
    return sendMessage(chatId, `📢 <b>Channel Manager</b>\n\nChannels:\n<code>${escapeHtml(configuredChannels().join('\n') || 'No channel set')}</code>\n\nAlerts: <b>${db.settings.channelAlertsEnabled === false ? 'OFF' : 'ON'}</b>\nAuto Reply: <b>${db.settings.channelAutoReplyEnabled === false ? 'OFF' : 'ON'}</b>\n\nKeyword Rules:\n<code>${escapeHtml(channelRuleRows())}</code>`, inline([
      [{ text: '➕ Add Rule', callback_data: 'channel_rule_add' }],
      [
        { text: db.settings.channelAlertsEnabled === false ? '🔔 Alerts ON' : '🔕 Alerts OFF', callback_data: 'toggle_channel_alerts' },
        { text: db.settings.channelAutoReplyEnabled === false ? '💬 Reply ON' : '🙊 Reply OFF', callback_data: 'toggle_channel_reply' }
      ],
      [{ text: '🧪 Test Channel', callback_data: 'test_channel_send' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'toggle_channel_alerts') {
    db.settings.channelAlertsEnabled = db.settings.channelAlertsEnabled === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Channel alerts: ${db.settings.channelAlertsEnabled ? 'ON' : 'OFF'}`, adminButtons());
  }
  if (data === 'toggle_channel_reply') {
    db.settings.channelAutoReplyEnabled = db.settings.channelAutoReplyEnabled === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Channel auto reply: ${db.settings.channelAutoReplyEnabled ? 'ON' : 'OFF'}`, adminButtons());
  }
  if (data === 'test_channel_send') return testChannelSend(chatId);
  if (data === 'channel_rule_add') {
    setSession(from.id, { type: 'channel_rule_keywords' });
    return sendMessage(chatId, '📢 Send keywords separated by comma.\nExample: Gemini, Gemini 18 Months, Gemini Pro', cancelAdminButtons());
  }
  if (data === 'admin_tools') {
    const audit = stockAuditSummary();
    const backups = listDataBackups().slice(0, 3);
    return sendMessage(chatId, `🧰 <b>Admin Tools</b>\n\n📊 Stock Items: <b>${audit.totalStock}</b>\n⚠️ Duplicate Stock: <b>${audit.duplicateCount}</b>\n📦 Empty Stock Products: <b>${audit.emptyStock}</b>\n🔻 Low Stock Products: <b>${audit.lowStock}</b>\n\n💾 Recent Backups:\n${escapeHtml(backups.map(b => `${b.file} (${bytesHuman(b.size)})`).join('\n') || 'No backups yet')}`, inline([
      [
        { text: '📊 Stock Audit', callback_data: 'admin_stock_audit' },
        { text: '💾 Create Backup', callback_data: 'admin_create_backup' }
      ],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'admin_stock_audit') {
    const audit = stockAuditSummary();
    let out = `📊 <b>Stock Audit</b>\n\nTotal Stock: <b>${audit.totalStock}</b>\nDuplicate Items: <b>${audit.duplicateCount}</b>\nDuplicate Products: <b>${audit.duplicateProducts.length}</b>\nEmpty Stock Products: <b>${audit.emptyStock}</b>\nLow Stock Products: <b>${audit.lowStock}</b>\n\n`;
    audit.duplicateProducts.slice(0, 12).forEach((p, i) => {
      const st = stockStatsForProduct(p);
      out += `${i + 1}. ${escapeHtml(p.name)}\nCode: ${p.code} | Duplicates: ${st.duplicates}\n\n`;
    });
    return sendMessage(chatId, out, inline([[{ text: '🧰 Admin Tools', callback_data: 'admin_tools' }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]));
  }
  if (data === 'admin_create_backup') {
    try {
      const b = createDataBackup('telegram');
      return sendMessage(chatId, `✅ Backup created\n\nFile: <code>${escapeHtml(b.file)}</code>\nSize: ${escapeHtml(bytesHuman(b.size))}\n\nDownload from Web Admin → Backups.`, adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Backup failed:\n${escapeHtml(err.message)}`, adminButtons());
    }
  }
  if (data === 'admin_reviews') {
    return sendMessage(chatId, `⭐ <b>Latest Reviews</b>\n\n${escapeHtml(reviewRowsText(10))}`, adminButtons());
  }
  if (data === 'admin_marketing_kit') {
    const products = activeProducts().slice(0, 12);
    if (!products.length) return sendMessage(chatId, 'No active products.', adminButtons());
    return sendMessage(chatId, '📣 <b>Marketing Kit</b>\n\nSelect product to generate promo copy:', inline([
      ...products.map(p => [{ text: `${p.emoji || '📦'} ${short(p.name, 38)}`, callback_data: `mk_product:${p.code}` }]),
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data.startsWith('mk_product:')) {
    const p = productByCode(data.split(':')[1]);
    if (!p) return sendMessage(chatId, 'Product not found.', adminButtons());
    const pack = productMarketingPack(p);
    return sendMessage(chatId, `📣 <b>Marketing Copy</b>\n\n<b>Group Post:</b>\n<code>${escapeHtml(pack.groupPost)}</code>\n\n<b>Short Post:</b>\n<code>${escapeHtml(pack.shortPost)}</code>`, inline([
      [{ text: '📤 Share Product', url: `https://t.me/share/url?url=${encodeURIComponent(pack.buyLink)}&text=${encodeURIComponent(pack.shortPost)}` }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'admin_restock_requests') {
    const list = (db.restockRequests || []).filter(r => r.status === 'open').slice(0, 15);
    if (!list.length) return sendMessage(chatId, '✅ No open restock requests.', adminButtons());
    let out = '🔔 <b>Open Restock Requests</b>\n\n';
    const rows = [];
    list.forEach((r, i) => {
      out += `${i + 1}. ${escapeHtml(r.productName)}\nUser: ${escapeHtml(r.firstName)} ${r.username ? '@' + escapeHtml(r.username) : ''}\nID: <code>${escapeHtml(r.telegramId)}</code>\n\n`;
      rows.push([{ text: `📦 Manage ${r.productCode}`, callback_data: `admin_product:${r.productCode}` }]);
    });
    rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
    return sendMessage(chatId, out, inline(rows));
  }
  if (data === 'admin_top_buyers') {
    const ins = customerInsights();
    let out = '👑 <b>Top Buyers</b>\n\n';
    if (!ins.topBuyers.length) out += 'No buyers yet.';
    ins.topBuyers.forEach((u, i) => {
      const uid = String(u.telegramId);
      out += `${i + 1}. ${escapeHtml(u.firstName || 'User')} ${u.username ? '@' + escapeHtml(u.username) : ''}\nOrders: ${ins.orderCounts[uid] || 0} | Spent: ${money(ins.spent[uid] || 0)}\n\n`;
    });
    return sendMessage(chatId, out, adminButtons());
  }
  if (data === 'admin_tickets') return showTicketList(chatId);
  if (data.startsWith('ticket_view:')) return showTicketDetail(chatId, data.split(':')[1]);
  if (data.startsWith('replace_approve:')) {
    const t = (db.supportTickets || []).find(x => x.id === data.split(':')[1]);
    try {
      const msg = await approveReplacementTicket(t, `telegram-admin-${from.id}`);
      return sendMessage(chatId, `✅ ${escapeHtml(msg)}`, t ? ticketAdminButtons(t.id) : adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Replacement approve failed:\n\n${escapeHtml(err.message)}`, t ? ticketAdminButtons(t.id) : adminButtons());
    }
  }
  if (data.startsWith('replace_reject:')) {
    const t = (db.supportTickets || []).find(x => x.id === data.split(':')[1]);
    try {
      const msg = await rejectReplacementTicket(t, `telegram-admin-${from.id}`);
      return sendMessage(chatId, `❌ ${escapeHtml(msg)}`, adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Replacement reject failed:\n\n${escapeHtml(err.message)}`, t ? ticketAdminButtons(t.id) : adminButtons());
    }
  }
  if (data.startsWith('ticket_reply:')) {
    const t = (db.supportTickets || []).find(x => x.id === data.split(':')[1]);
    if (!t) return sendMessage(chatId, '❌ Ticket not found.', adminButtons());
    setSession(from.id, { type: 'ticket_reply_msg', ticketId: t.id });
    return sendMessage(chatId, `✍️ Send reply for ticket ${escapeHtml(t.id)}.`, cancelAdminButtons());
  }
  if (data.startsWith('ticket_close:')) {
    const t = (db.supportTickets || []).find(x => x.id === data.split(':')[1]);
    if (!t) return sendMessage(chatId, '❌ Ticket not found.', adminButtons());
    t.status = 'closed'; t.updatedAt = now(); saveData();
    try { await sendMessage(t.telegramId, `✅ <b>Your support ticket has been closed.</b>\nTicket: <code>${escapeHtml(t.id)}</code>`, homeButtons(t.telegramId)); } catch (_) {}
    return sendMessage(chatId, `✅ Ticket closed: ${escapeHtml(t.id)}`, adminButtons());
  }
  if (data === 'admin_manual_order') {
    setSession(from.id, { type: 'manual_order_user' });
    return sendMessage(chatId, '🚚 <b>Manual Delivery</b>\n\nSend user Telegram ID.', cancelAdminButtons());
  }
  if (data === 'admin_help') {
    return sendMessage(chatId, `🧾 <b>Admin Quick Guide</b>\n\n🛠 <b>Product Manager</b> — edit/delete/stock/logo/pin products\n💰 <b>Balance</b> — add/deduct wallet balance\n📣 <b>Announcement</b> — send update to all users\n🔔 <b>Stock Alert</b> — manual stock alert for product\n🆕 <b>New Stock Alert</b> — restock alert for product\n💳 <b>Pending</b> — approve/reject payments\n💳 <b>Pay Methods</b> — add/edit/delete payment methods\n🔐 <b>Binance API</b> — UID, API key, coin, tolerance, recent deposits\n⚠️ <b>Low Stock</b> — see products with low stock
🎫 <b>Tickets</b> — answer support tickets
🚚 <b>Manual Delivery</b> — create manual orders
🛡 <b>Replacement</b> — requests need admin approve; approve cuts stock and delivers
🚫 <b>Blacklist</b> — ban/unban problem users
📢 <b>Channels</b> — stock alerts + channel keyword auto-reply\n\nTip: use Product Manager for all product related actions.`, adminButtons());
  }
  
  
  if (data === 'admin_desc_generator') {
    setSession(from.id, { type: 'descgen_name' });
    return sendMessage(chatId, '✨ <b>AI Description Generator</b>\n\nSend product name.\nExample: Gemini Pro Jio 18 Months Link', cancelAdminButtons());
  }
  if (data === 'admin_coupons') {
    return sendMessage(chatId, `🎟 <b>Coupon Manager</b>\n\n<code>${escapeHtml(couponRows())}</code>\n\nUse Web Admin for full coupon add/edit/delete, or tap Add Quick Coupon below.`, inline([
      [{ text: '➕ Add Coupon', callback_data: 'coupon_add' }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (data === 'coupon_add') {
    setSession(from.id, { type: 'coupon_add_code' });
    return sendMessage(chatId, '🎟 Send coupon code.\nExample: SAVE10', cancelAdminButtons());
  }
  if (data === 'admin_maintenance') {
    db.settings.maintenanceMode = !Boolean(db.settings.maintenanceMode);
    saveData();
    return sendMessage(chatId, `🛠 Maintenance mode is now: <b>${db.settings.maintenanceMode ? 'ON' : 'OFF'}</b>\n\nWhen ON, normal users cannot shop/start. Admin can still use bot.`, adminButtons());
  }

  if (data.startsWith('admin_product:')) return showAdminProductManage(chatId, data.split(':')[1]);
  if (data.startsWith('bulk_price:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'bulk_price_lines', productCode: p.code });
    return sendMessage(chatId, `📦 <b>Set Bulk Order Pricing</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\nBase Price: <b>${money(p.price, p.currency || currency())}</b>\n\nSend tiers line by line:\n<code>minQty|price|note optional</code>\n\nExample:\n<code>5|1.50|5+ pieces\n10|1.20|10+ pieces</code>\n\nSend <code>clear</code> to remove all bulk pricing.`, cancelAdminButtons());
  }
  if (data.startsWith('bulk_list:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const tiers = bulkPricingText(p) || 'No bulk pricing set.';
    return sendMessage(chatId, `📦 <b>Bulk Pricing</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\nBase Price: <b>${money(p.price, p.currency || currency())}</b>\n\n${escapeHtml(tiers)}`, productManagerButtons(p));
  }
  if (data.startsWith('special_price:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'special_user', productCode: p.code });
    return sendMessage(chatId, `💎 <b>Set Special Price</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\nNormal Price: ${money(p.price, p.currency || currency())}\n\nSend user Telegram ID or @username.`, cancelAdminButtons());
  }
  if (data.startsWith('special_list:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, `💎 <b>Special Prices</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\n\n<code>${escapeHtml(specialPriceRows(p))}</code>`, productManagerButtons(p));
  }
  if (data.startsWith('remove_special:')) {
    const [, code, uid] = data.split(':');
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.specialPrices ||= {};
    delete p.specialPrices[uid];
    saveData();
    return sendMessage(chatId, `✅ Special price removed for ${uid}.`, productManagerButtons(p));
  }

  if (data.startsWith('admin_hidden:')) return showHiddenProducts(chatId, Number(data.split(':')[1]) || 1);
  if (data.startsWith('restore_product:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.active = true;
    saveData();
    return sendMessage(chatId, `♻️ Product restored.\n\n${p.code} | ${escapeHtml(p.name)}`, productManagerButtons(p));
  }
  if (data.startsWith('admin_product_stock:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'stock_format', productCode: p.code });
    return sendMessage(chatId, `📦 <b>Select Stock / Delivery Format</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\n\nReply with one option:\n\n1. redeem link\n2. id password\n3. coupon\n4. custom format\n\nCustom examples:\n<code>Mail|Pass</code>\n<code>Mail|Pass|2fa</code>\n<code>Mail|ChatGPT Pass|Mail Pass|2FA</code>`, cancelAdminButtons());
  }
  if (data.startsWith('admin_product_logo:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    setSession(from.id, { type: 'logo_photo', productCode: p.code });
    return sendMessage(chatId, `🖼 Send new logo/photo for ${p.code} | ${escapeHtml(p.name)}.`, cancelAdminButtons());
  }
  if (data.startsWith('admin_product_pin:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.pinned = !p.pinned;
    saveData();
    return showAdminProductManage(chatId, p.code);
  }
  if (data.startsWith('admin_product_hide:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.active = false;
    saveData();
    return sendMessage(chatId, `🗑 Product hidden from store.\n\n${p.code} | ${escapeHtml(p.name)}\n\nYou can restore it from Hidden/Restore.`, adminButtons());
  }
  if (data.startsWith('confirm_delete:')) {
    const code = data.split(':')[1];
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, `🔥 <b>Permanent Delete?</b>\n\nThis will remove product and stock forever.\n\n${p.code} | ${escapeHtml(p.name)}\nStock: ${p.stock.length}\n\nRecommended: use Hide instead unless you are sure.`, deleteConfirmButtons(p.code));
  }
  if (data.startsWith('delete_yes:')) {
    const code = data.split(':')[1];
    const index = db.products.findIndex((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
    if (index < 0) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const [deleted] = db.products.splice(index, 1);
    saveData();
    return sendMessage(chatId, `🔥 Product permanently deleted.\n\n${deleted.code} | ${escapeHtml(deleted.name)}`, adminButtons());
  }
  if (data.startsWith('view_stock:')) return showProductStock(chatId, data.split(':')[1]);
  if (data.startsWith('duplicate_product:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const copy = { ...p, code: nextProductCode(), name: p.name + ' Copy', stock: [], sold: 0, pinned: false, active: true, createdAt: now() };
    db.products.push(copy);
    saveData();
    return sendMessage(chatId, `📄 Product duplicated.\n\nNew: ${copy.code} | ${escapeHtml(copy.name)}\nStock is empty.`, productManagerButtons(copy));
  }
  if (data.startsWith('product_alert:')) {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(data.split(':')[1]).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const sent = await broadcastStockAlert(p, Math.max(1, p.stock.length || 1));
    return sendMessage(chatId, `📢 Stock alert sent to ${sent} user(s).\n\n${p.code} | ${escapeHtml(p.name)}`, productManagerButtons(p));
  }
  if (data === 'admin_stats') return showAdminStats(chatId);
  if (data.startsWith('admin_users:')) return showAdminUsers(chatId, Number(data.split(':')[1]) || 1);
  if (data.startsWith('admin_orders:')) { const parts = data.split(':'); return showAdminOrders(chatId, Number(parts[1]) || 1, decodeURIComponent(parts.slice(2).join(':') || '')); }
  if (data === 'admin_orders_search') {
    setSession(from.id, { type: 'admin_order_search' });
    return sendMessage(chatId, '🔎 <b>Search All Orders</b>\n\nSend order ID, user ID, username, product name, product code, coupon, status or payment ID.', cancelAdminButtons());
  }
  if (data === 'admin_orders_stats') {
    const orders = db.orders.slice().sort((a,b)=>new Date(b.createdAt || 0)-new Date(a.createdAt || 0));
    return sendMessage(chatId, orderHistoryText(orders, 'Admin Order Stats', 20), adminButtons());
  }
  if (data.startsWith('admin_order_view:')) return showAdminOrderDetail(chatId, data.split(':')[1]);
  if (data.startsWith('admin_order_resend:')) {
    const o = db.orders.find(x => x.id === data.split(':')[1]);
    if (!o) return sendMessage(chatId, '❌ Order not found.', adminButtons());
    try {
      await sendDeliveryMessage(o.telegramId, o.productName, o.qty, o.total, o.currency, o.deliveredItems || [], o.id, o.productCode);
      return sendMessage(chatId, `✅ Delivery resent for order ${escapeHtml(o.id)}.`, inline([[{ text: 'Back to Order', callback_data: `admin_order_view:${o.id}` }], [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]]));
    } catch (err) {
      return sendMessage(chatId, `❌ Resend failed:\n${escapeHtml(err.message)}`, inline([[{ text: 'Back to Order', callback_data: `admin_order_view:${o.id}` }]]));
    }
  }
  if (data.startsWith('admin_msg_user:')) {
    setSession(from.id, { type: 'direct_msg_user', userId: data.split(':')[1] });
    return sendMessage(chatId, `📩 Send message for user <code>${escapeHtml(data.split(':')[1])}</code>.`, cancelAdminButtons());
  }
  if (data.startsWith('admin_pending:')) return showAdminPending(chatId, Number(data.split(':')[1]) || 1);
  if (data === 'admin_low_stock') return showLowStock(chatId);
  if (data === 'admin_balance') {
    setSession(from.id, { type: 'balance_user' });
    return sendMessage(chatId, '💰 <b>Balance Manager</b>\n\nSend user Telegram ID to manage balance.', cancelAdminButtons());
  }
  if (data.startsWith('bal_add:')) {
    setSession(from.id, { type: 'balance_amount', action: 'add', userId: data.split(':')[1] });
    return sendMessage(chatId, '➕ Send amount to add.\nExample: 10', cancelAdminButtons());
  }
  if (data.startsWith('bal_deduct:')) {
    setSession(from.id, { type: 'balance_amount', action: 'deduct', userId: data.split(':')[1] });
    return sendMessage(chatId, '➖ Send amount to deduct.\nExample: 10', cancelAdminButtons());
  }
  if (data.startsWith('user_orders:')) return showUserOrders(chatId, data.split(':')[1]);
  if (data.startsWith('user_payments:')) return showUserPayments(chatId, data.split(':')[1]);
  if (data === 'admin_methods') {
    return sendMessage(chatId, '💳 <b>Payment Method Manager</b>\n\nTap any method to edit, enable/disable, test or delete.\n\nActive methods are shown to users during checkout and wallet deposit.', paymentMethodAdminButtons());
  }
  if (data.startsWith('paymethod_manage:')) return showPaymentMethodManage(chatId, data.split(':')[1]);
  if (data.startsWith('pm_toggle:')) {
    const m = db.paymentMethods.find((x) => x.id === data.split(':')[1]);
    if (!m) return sendMessage(chatId, '❌ Method not found.', paymentMethodAdminButtons());
    m.active = m.active === false ? true : false;
    saveData();
    return showPaymentMethodManage(chatId, m.id);
  }
  if (data.startsWith('pm_edit:')) {
    const [, methodId, field] = data.split(':');
    const m = db.paymentMethods.find((x) => x.id === methodId);
    if (!m) return sendMessage(chatId, '❌ Method not found.', paymentMethodAdminButtons());
    setSession(from.id, { type: 'pm_edit_value', methodId, field });
    const label = field === 'details' ? 'payment details/address/instructions' : field;
    return sendMessage(chatId, `✏️ Send new ${label} for ${escapeHtml(m.name)}.`, cancelAdminButtons());
  }
  if (data.startsWith('pm_delete_confirm:')) {
    const m = db.paymentMethods.find((x) => x.id === data.split(':')[1]);
    if (!m) return sendMessage(chatId, '❌ Method not found.', paymentMethodAdminButtons());
    return sendMessage(chatId, `🗑 <b>Delete Payment Method?</b>\n\n${escapeHtml(m.icon || '💳')} <b>${escapeHtml(m.name)}</b>\n\nThis will remove it from future checkout/deposit screens. Existing old payments will remain in history.`, paymentMethodDeleteButtons(m.id));
  }
  if (data.startsWith('pm_delete_yes:')) {
    const methodId = data.split(':')[1];
    const index = db.paymentMethods.findIndex((x) => x.id === methodId);
    if (index < 0) return sendMessage(chatId, '❌ Method not found.', paymentMethodAdminButtons());
    const [deleted] = db.paymentMethods.splice(index, 1);
    saveData();
    return sendMessage(chatId, `✅ Payment method deleted.\n\n${escapeHtml(deleted.name)}`, paymentMethodAdminButtons());
  }
  if (data === 'paymethod_add') {
    setSession(from.id, { type: 'pm_add_name', data: {} });
    return sendMessage(chatId, '➕ <b>Add Payment Method</b>\n\nSend method name.\nExample: USDT BEP20', cancelAdminButtons());
  }
  if (data.startsWith('pm_test:')) {
    const m = db.paymentMethods.find((x) => x.id === data.split(':')[1]);
    if (!m) return sendMessage(chatId, '❌ Method not found.', paymentMethodAdminButtons());
    if (String(m.key || '').includes('BINANCE') || String(m.key || '').includes('USDT')) {
      await sendMessage(chatId, '⏳ Testing Binance API...');
      try {
        const deposits = await fetchDeposits(binanceCfg().coin);
        return sendMessage(chatId, `✅ Binance API working.\nMethod: ${escapeHtml(m.name)}\nRecent successful deposits: ${deposits.length}`, paymentMethodManageButtons(m));
      } catch (err) {
        return sendMessage(chatId, `❌ Test failed:\n${escapeHtml(err.message)}`, paymentMethodManageButtons(m));
      }
    }
    return sendMessage(chatId, `ℹ️ Manual method test:\n\n${escapeHtml(m.name)} is active: ${m.active === false ? 'NO' : 'YES'}\nDetails saved: ${m.details ? 'YES' : 'NO'}`, paymentMethodManageButtons(m));
  }
  if (data === 'admin_hide_product') {
    setSession(from.id, { type: 'hide_product' });
    return sendMessage(chatId, '🗑 Send product code to hide.\nExample: P001', cancelAdminButtons());
  }
  if (data.startsWith('manage_payment:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Payment not found.', adminButtons());
    return sendMessage(chatId, `💳 <b>Manage Payment</b>\n\nID: <code>${escapeHtml(p.id)}</code>\nUser: <code>${escapeHtml(p.telegramId)}</code>\nType: ${p.type === 'deposit' ? 'Deposit' : 'Order'}\nItem: ${escapeHtml(p.productName)}\nAmount: ${money(p.amount, p.currency)}\nStatus: ${p.status.toUpperCase()}\nMethod: ${escapeHtml(p.methodName)}\nRef: <code>${escapeHtml(p.submittedReference || '-')}</code>`, paymentAdminButtons(p.id));
  }
  if (data.startsWith('payapprove:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1]);
    return manualApprovePayment(chatId, from, p);
  }
  if (data.startsWith('payforce:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1]);
    try {
      const msg = await approveAndDeliverPayment(p, { approvedBy: String(from.id), method: 'Force Deliver' });
      return sendMessage(chatId, msg, adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Force delivery failed:\n\n${escapeHtml(err.message)}`, p ? paymentAdminButtons(p.id) : adminButtons());
    }
  }
  if (data.startsWith('payresend:')) {
    const paymentId = data.split(':')[1];
    const order = findOrderByPaymentId(paymentId);
    if (!order) return sendMessage(chatId, '❌ No delivered order found for this payment yet. Use Approve + Deliver first.', paymentAdminButtons(paymentId));
    try {
      await sendDeliveryMessage(order.telegramId, order.productName, order.qty, order.total, order.currency, order.deliveredItems || [], order.id, order.productCode);
      return sendMessage(chatId, `✅ Delivery resent.\nOrder: ${order.id}`, paymentAdminButtons(paymentId));
    } catch (err) {
      return sendMessage(chatId, `❌ Resend failed:\n\n${escapeHtml(err.message)}`, paymentAdminButtons(paymentId));
    }
  }
  if (data.startsWith('paydetail:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1]);
    if (!p) return sendMessage(chatId, '❌ Payment not found.', adminButtons());
    const order = findOrderByPaymentId(p.id);
    return sendMessage(chatId, `🧾 <b>Payment Detail</b>\n\nID: <code>${escapeHtml(p.id)}</code>\nStatus: <b>${escapeHtml(String(p.status || '').toUpperCase())}</b>\nUser: <code>${escapeHtml(p.telegramId)}</code>\nType: ${escapeHtml(p.type || 'order')}\nProduct: <b>${escapeHtml(p.productName || 'Wallet Deposit')}</b>\nQty: ${escapeHtml(p.qty || 1)}\nAmount: <b>${money(p.amount, p.currency)}</b>\nMethod: ${escapeHtml(p.methodName || '-')}\nTXID/Ref: <code>${escapeHtml(p.submittedReference || '-')}</code>\nNote: <code>${escapeHtml(p.note || '-')}</code>\nOrder: ${order ? '<code>' + escapeHtml(order.id) + '</code>' : 'Not delivered yet'}\nReason: ${escapeHtml(p.lastCheckReason || '-')}`, paymentAdminButtons(p.id));
  }
  if (data.startsWith('payreject:')) {
    const p = db.payments.find((x) => x.id === data.split(':')[1]);
    if (p) {
      p.status = 'rejected';
      saveData();
      try { await sendMessage(p.telegramId, `❌ <b>Payment Rejected</b>\n\nPayment ID: <code>${escapeHtml(p.id)}</code>\nPlease contact support if you think this is a mistake.`, homeButtons(p.telegramId)); } catch (_) {}
    }
    return sendMessage(chatId, '❌ Payment rejected.', adminButtons());
  }

  if (data.startsWith('admin_products:')) return showAdminProducts(chatId, Number(data.split(':')[1]) || 1);
  if (data === 'admin_add_product') {
    setSession(from.id, { type: 'add_name', data: {} });
    return sendMessage(chatId, '➕ Send product name.\nExample: ChatGPT Plus 1 Month', cancelAdminButtons());
  }
  if (data === 'admin_add_stock') {
    setSession(from.id, { type: 'stock_code' });
    return sendMessage(chatId, '📥 Send product code.\nExample: P001', cancelAdminButtons());
  }
  if (data === 'admin_edit_product') {
    setSession(from.id, { type: 'edit_code' });
    return sendMessage(chatId, '✏️ Send product code.\nExample: P001', cancelAdminButtons());
  }
  if (data === 'admin_logo') {
    setSession(from.id, { type: 'logo_code' });
    return sendMessage(chatId, '🖼 Send product code for logo.\nExample: P001', cancelAdminButtons());
  }
  if (data === 'admin_pin') {
    setSession(from.id, { type: 'pin_code' });
    return sendMessage(chatId, '📌 Send product code.', cancelAdminButtons());
  }
  if (data === 'admin_repair_delivery') {
    const list = undeliveredPayments();
    if (!list.length) return sendMessage(chatId, '✅ No undelivered approved/review payments found.', adminButtons());
    let out = `🚑 <b>Delivery Repair</b>\n\nFound ${list.length} payment(s) without delivered order.\n\n`;
    const rows = [];
    list.slice(0, 12).forEach((p, i) => {
      out += `${i + 1}. ${p.id} | ${String(p.status).toUpperCase()}\nUser: ${p.telegramId}\nProduct: ${escapeHtml(p.productName)}\nAmount: ${money(p.amount, p.currency)}\n\n`;
      rows.push([{ text: `🚀 Deliver ${p.id}`, callback_data: `payforce:${p.id}` }]);
    });
    rows.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
    return sendMessage(chatId, out, inline(rows));
  }
  if (data === 'admin_payments') {
    let out = '💳 <b>Recent Payments</b>\n\n';
    db.payments.slice(-12).reverse().forEach((p) => {
      out += `${p.id} | ${p.status.toUpperCase()}\nUser: ${p.telegramId}\nProduct: ${escapeHtml(p.productName)}\nAmount: ${money(p.amount, p.currency)}\nRef: ${escapeHtml(p.submittedReference || '-')}\n\n`;
    });
    return sendMessage(chatId, out || 'No payments.', adminButtons());
  }
  if (data === 'admin_binance') return showBinanceAdmin(chatId);
  if (data === 'test_binance') {
    await sendMessage(chatId, '⏳ Testing Binance API...');
    try {
      const deposits = await fetchDeposits(binanceCfg().coin);
      return sendMessage(chatId, `✅ <b>Binance API Working</b>\n\nCoin: ${escapeHtml(binanceCfg().coin)}\nRecent successful deposits: <b>${deposits.length}</b>\n\nAuto verify is ready for TXID based deposits.`, binanceAdminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ <b>Binance API Failed</b>\n\n${escapeHtml(err.message)}\n\nCheck API key, secret, permissions, IP restriction and coin.`, binanceAdminButtons());
    }
  }
  if (data === 'binance_recent_deposits') return showRecentBinanceDeposits(chatId);
  if (data === 'toggle_binance_partial') {
    db.settings.binanceAllowPartialTxid = !Boolean(db.settings.binanceAllowPartialTxid);
    saveData();
    return showBinanceAdmin(chatId);
  }
  if (data === 'clear_binance_api_confirm') {
    return sendMessage(chatId, '🧹 <b>Clear Binance API Keys?</b>\n\nThis will remove saved API key and secret from local data. Environment variables will still work if set in Hostinger.', clearBinanceConfirmButtons());
  }
  if (data === 'clear_binance_api_yes') {
    db.settings.binanceApiKey = '';
    db.settings.binanceSecretKey = '';
    saveData();
    return sendMessage(chatId, '✅ Binance API keys cleared from bot data.', binanceAdminButtons());
  }
  if (['set_binance_id', 'set_binance_name', 'set_binance_coin', 'set_binance_api', 'set_binance_secret', 'set_binance_base', 'set_binance_lookback', 'set_binance_tolerance'].includes(data)) {
    setSession(from.id, { type: data });
    const labels = {
      set_binance_id: 'Binance UID / Pay ID',
      set_binance_name: 'Binance display name',
      set_binance_coin: 'coin code (example: USDT)',
      set_binance_api: 'Binance API Key',
      set_binance_secret: 'Binance Secret Key',
      set_binance_base: 'Base URL (default https://api.binance.com)',
      set_binance_lookback: 'lookback days (example: 7)',
      set_binance_tolerance: 'amount tolerance (example: 0.02)'
    };
    return sendMessage(chatId, `Send new ${labels[data]}:`, cancelAdminButtons());
  }
  if (data === 'admin_bot_settings') return showBotSettings(chatId);
  if (data === 'admin_bot_username') {
    setSession(from.id, { type: 'set_bot_username' });
    return sendMessage(chatId, `Current bot username: @${escapeHtml(getBotUsername() || botUsername || '-')}

Send new bot username without @.
Example: YourBotUsername`, cancelAdminButtons());
  }
  if (data === 'admin_support_username') {
    setSession(from.id, { type: 'set_support_username' });
    return sendMessage(chatId, `Current support: ${escapeHtml(db.settings.supportUsername || SUPPORT_USERNAME)}

Send new support username.
Example: @support`, cancelAdminButtons());
  }
  if (data === 'admin_channel_url') {
    setSession(from.id, { type: 'set_channel_url' });
    return sendMessage(chatId, `Current channel URL:
${escapeHtml(db.settings.channelUrl || CHANNEL_URL || '-')}

Send new channel URL.
Example: https://t.me/your_channel`, cancelAdminButtons());
  }
  if (data === 'admin_currency') {
    setSession(from.id, { type: 'set_currency' });
    return sendMessage(chatId, `Current: ${currency()}\nSend new currency like USD or USDT.`, cancelAdminButtons());
  }
  if (data === 'admin_announcement' || data === 'admin_broadcast') {
    setSession(from.id, { type: 'announcement' });
    return sendMessage(chatId, '📣 <b>Premium Announcement Generator</b>\n\nSend your normal text. Bot will auto-format with premium emojis, bold headings and clean divider style.\n\nExample:\nGemini Pro 18 Months price dropped\nOld price $1.8\nNew price $1\nOnly 8 stock left', cancelAdminButtons());
  }
  if (data === 'admin_stock_alert') {
    setSession(from.id, { type: 'stock_alert_code', alertTitle: '🔔 Stock Alert' });
    return sendMessage(chatId, '🔔 <b>Stock Alert</b>\n\nSend product code to send stock alert to all users.\nExample: P001', cancelAdminButtons());
  }
  if (data === 'admin_new_stock_alert') {
    setSession(from.id, { type: 'stock_alert_code', alertTitle: '🆕 New Stock Alert' });
    return sendMessage(chatId, '🆕 <b>New Stock Alert</b>\n\nSend product code to announce new stock to all users.\nExample: P001\n\nNote: Add Stock already sends automatic new stock alert too.', cancelAdminButtons());
  }
}

// =====================
// TEXT + PHOTO HANDLERS
// =====================
async function handleText(msg) {
  runtimeStats.messages++;
  runtimeStats.lastUpdateAt = Date.now();
  runtimeStats.lastMessage = String(msg.text || msg.caption || '').slice(0, 200);
  if (isGroupChat(msg.chat)) runtimeStats.groupMessages++;
  console.log(`📩 Incoming text from ${msg.from?.id}: ${String(msg.text || '').slice(0, 100)}`);
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = String(msg.text || msg.caption || '').trim();

  if (text === '/pay' || text === '/upi') {
    await sendUpiPayment(chatId);
    return;
  }
  if (isGroupChat(msg.chat)) {
    const handledGroup = await maybeHandleGroupText(msg);
    if (handledGroup) return;
  }
  ensureTelegramAdmin(from);
  if (!isAdmin(from.id) && isUserSecurityLocked(from.id)) {
    const lock = db.securityLocks[String(from.id)] || {};
    return sendMessage(chatId, `🔒 <b>Security Lock</b>

Your account is temporarily locked.
Reason: ${escapeHtml(lock.reason || 'Security protection')}
Until: ${escapeHtml(lock.until ? new Date(lock.until).toLocaleString() : 'manual unlock')}`);
  }
  if (!isAdmin(from.id) && rateLimitHit('message', from.id, Number(db.settings.userMessageLimitPerMin || 30), 60 * 1000, { text: short(text, 80) })) {
    return sendMessage(chatId, `🚦 <b>Slow down</b>

Too many messages. Try again after 1 minute.`);
  }
  const session = getSession(from.id);

  if (text === '/cancel') { clearSession(from.id); return sendMessage(chatId, '✅ Cancelled.', adminButtons()); }

  if (session?.type === 'bulk_helper_input_format') {
    session.inputFormat = text.trim();
    session.type = 'bulk_helper_output_format';
    setSession(from.id, session);
    return sendMessage(chatId, `<b>Step 2/4:</b> Send output format.\n\nExample:\n<code>${escapeHtml(session.inputFormat)}|2FA Link</code>`, cancelAdminButtons());
  }
  if (session?.type === 'bulk_helper_output_format') {
    session.outputFormat = text.trim();
    session.type = 'bulk_helper_constants';
    setSession(from.id, session);
    return sendMessage(chatId, `<b>Step 3/4:</b> Send constants / same value for all lines.\n\nExample:\n<code>2FA Link=https://2fa.live/</code>\n\nSend <code>skip</code> if not needed.`, cancelAdminButtons());
  }
  if (session?.type === 'bulk_helper_constants') {
    session.constants = /^(skip|no|none|-)/i.test(text.trim()) ? '' : text.trim();
    session.type = 'bulk_helper_data';
    setSession(from.id, session);
    return sendMessage(chatId, `<b>Step 4/4:</b> Send bulk data lines now.\n\nInput format:\n<code>${escapeHtml(session.inputFormat)}</code>`, cancelAdminButtons());
  }
  if (session?.type === 'bulk_helper_data') {
    const result = runBulkDataHelper({ raw: text, inputFormat: session.inputFormat, outputFormat: session.outputFormat, constants: session.constants, delimiter: '|', dedupe: 'false' });
    clearSession(from.id);
    if (!result.ok) return sendMessage(chatId, `❌ ${escapeHtml(result.error)}`, adminButtons());
    const output = result.text.length > 3300 ? result.text.slice(0, 3300) + `\n...trimmed. Use Web Data Helper for full large output.` : result.text;
    return sendMessage(chatId, `✅ <b>Bulk Data Converted</b>\n\nLines: <b>${result.count}</b>\nSkipped: <b>${result.skipped}</b>\n\n<code>${escapeHtml(output)}</code>\n\nFor adding to stock directly, use Web Admin → Bulk Data Helper.`, adminButtons());
  }

  if (text === '/ping') return sendMessage(chatId, 'pong ✅ Bot is receiving messages.', homeButtons(from.id));
  if (text === '/start' || text.startsWith('/start ')) return showHome(chatId, from, text);
  if (text === '/freebie' || text === '/claim' || text === '/daily') return showFreebie(chatId, from);
  if (text === '/myid' || text === '/id') return sendMessage(chatId, adminAccessDebugText(from));
  if (text === '/claimowner' || text === '/fixadmin') {
    if (forceOwnerIfAllowed(from)) return sendMessage(chatId, '✅ <b>Owner admin access recovered.</b>\n\nNow use /admin or tap Admin Panel.', adminButtons());
    return sendMessage(chatId, adminAccessDebugText(from));
  }
  if (text === '/admin' || text === '/panel' || text === '/adminpanel') return showAdmin(chatId, from);
  if (text === '/products') return isAdmin(from.id) ? showAdminProducts(chatId, 1) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/orders') return isAdmin(from.id) ? showAdminOrders(chatId, 1) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/pending') return isAdmin(from.id) ? showAdminPending(chatId, 1) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/users') return isAdmin(from.id) ? showAdminUsers(chatId, 1) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/payments') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    let out = '💳 <b>Recent Payments</b>\n\n';
    db.payments.slice(-12).reverse().forEach((p) => {
      out += `${p.id} | ${String(p.status).toUpperCase()}\nUser: ${p.telegramId}\nAmount: ${money(p.amount, p.currency)}\nRef: ${escapeHtml(p.submittedReference || '-')}\n\n`;
    });
    return sendMessage(chatId, out || 'No payments.', adminButtons());
  }
  if (text === '/stock') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    setSession(from.id, { type: 'stock_code' });
    return sendMessage(chatId, '📥 Send product code to add stock.\nExample: P001', cancelAdminButtons());
  }
  if (text === '/announce' || text === '/broadcast') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    setSession(from.id, { type: 'announcement' });
    return sendMessage(chatId, '📣 <b>Premium Announcement</b>\n\nSend your announcement text. I will auto-convert it into premium emoji + bold format.', cancelAdminButtons());
  }
  if (text.startsWith('/announce ') || text.startsWith('/broadcast ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const msg = text.replace(/^\/(announce|broadcast)\s+/i, '').trim();
    const sent = await broadcastAnnouncement(msg);
    return sendMessage(chatId, `✅ <b>Premium Announcement Sent</b>\n\nSent to: ${sent} user/channel(s)\n\nPreview:\n${premiumAnnouncementText(msg)}`, adminButtons());
  }
  if (text === '/customannounce' || text === '/rawannounce') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    setSession(from.id, { type: 'custom_announcement' });
    return sendMessage(chatId, `✍️ <b>Custom Premium Message</b>\n\nSend message with your own formatting.\n\nSupported:\n<code>[b]bold[/b]</code>\n<code>**bold**</code>\n<code>[i]italic[/i]</code>\n<code>[code]code[/code]</code>\n<code>[line]</code>\n\nExample:\n<code>🚨 [b]FLASH SALE LIVE[/b]\n[line]\n💰 Old: $1.8\n🔥 New: [b]$1[/b]\n🛒 Buy from @supportbot</code>`, cancelAdminButtons());
  }
  if (text.startsWith('/customannounce ') || text.startsWith('/rawannounce ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const msg = text.replace(/^\/(customannounce|rawannounce)\s+/i, '').trim();
    const formatted = premiumCustomAnnouncementText(msg);
    const sentUsers = await broadcastToUsers(formatted, inline([[{ text: '🛍 Open Store', callback_data: 'shop:1' }]]));
    const sentChannels = await sendToConfiguredChannels(formatted, inline([[{ text: '🛍 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
    return sendMessage(chatId, `✅ <b>Custom Premium Message Sent</b>\n\nUsers: ${sentUsers}\nChannels: ${sentChannels}\n\n<b>Preview:</b>\n${formatted}`, adminButtons());
  }
  if (text.startsWith('/setlogo ') || text.startsWith('/logo ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split(/\s+/);
    const code = (parts[1] || '').toUpperCase();
    const logo = parts.slice(2).join(' ').trim();
    const p = productByCode(code);
    if (!p || !logo) return sendMessage(chatId, 'Usage: <code>/setlogo P001 💎</code>', adminButtons());
    p.logo = logo.slice(0, 12);
    p.emoji = p.emoji || p.logo;
    saveData();
    return sendMessage(chatId, `✅ Product logo updated\n\n${p.logo} <b>${escapeHtml(p.name)}</b>\nCode: <code>${escapeHtml(p.code)}</code>`, productManagerButtons(p));
  }
  if (text.startsWith('/setpromo ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const m = text.match(/^\/setpromo\s+(\S+)\s+([\s\S]+)/i);
    if (!m) return sendMessage(chatId, 'Usage:\n<code>/setpromo P001 [b]{name}[/b]\\nPrice {price}\\nBuy @{bot}</code>', adminButtons());
    const p = productByCode(m[1].toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.customPromo = m[2].trim();
    saveData();
    return sendMessage(chatId, `✅ Custom promo template saved for ${escapeHtml(p.name)}\n\n<b>Preview:</b>\n${productCustomPromo(p)}`, productManagerButtons(p));
  }
  if (text.startsWith('/stockpreview ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split(/\s+/);
    const p = productByCode(parts[1]?.toUpperCase());
    const added = Number(parts[2] || Math.max(1, p?.stock?.length || 1));
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, premiumStockAlertText(p, added), channelBuyButtons(p));
  }
  if (text.startsWith('/flashpreview ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const p = productByCode(text.split(/\s+/)[1]?.toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, flashSaleText(p), channelBuyButtons(p));
  }
  if (text.startsWith('/sendstock ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split(/\s+/);
    const p = productByCode(parts[1]?.toUpperCase());
    const added = Number(parts[2] || Math.max(1, p?.stock?.length || 1));
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const sent = await broadcastStockAlert(p, added);
    return sendMessage(chatId, `✅ Premium stock alert sent: <b>${sent}</b>\n\n${premiumStockAlertText(p, added)}`, productManagerButtons(p));
  }
  if (text.startsWith('/sendflash ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const p = productByCode(text.split(/\s+/)[1]?.toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const result = await sendCampaign({ type: 'flash', segment: 'all', productCode: p.code, toChannels: true, by: from.id });
    return sendMessage(chatId, `✅ Flash sale message sent.\nUsers/Channels: <b>${result.total}</b>\n\n${flashSaleText(p)}`, productManagerButtons(p));
  }
  if (text.startsWith('/setstockmsg ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const m = text.match(/^\/setstockmsg\s+(\S+)\s+([\s\S]+)/i);
    if (!m) return sendMessage(chatId, 'Usage:\n<code>/setstockmsg P001 📊 [b]{added} new stock added for {name}![/b]</code>', adminButtons());
    const p = productByCode(m[1].toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.customStockAlertTemplate = m[2].trim();
    saveData();
    return sendMessage(chatId, `✅ Custom stock alert template saved.\n\n<b>Preview:</b>\n${premiumStockAlertText(p, 10)}`, productManagerButtons(p));
  }
  if (text.startsWith('/setflashmsg ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const m = text.match(/^\/setflashmsg\s+(\S+)\s+([\s\S]+)/i);
    if (!m) return sendMessage(chatId, 'Usage:\n<code>/setflashmsg P001 🚨 [b]FLASH SALE[/b] {name} {sale_price}</code>', adminButtons());
    const p = productByCode(m[1].toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.customFlashSaleTemplate = m[2].trim();
    saveData();
    return sendMessage(chatId, `✅ Custom flash sale template saved.\n\n<b>Preview:</b>\n${flashSaleText(p)}`, productManagerButtons(p));
  }
  if (text === '/today') return isAdmin(from.id) ? sendMessage(chatId, businessSummaryText(1), adminButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/week') return isAdmin(from.id) ? sendMessage(chatId, businessSummaryText(7), adminButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/inventory') return isAdmin(from.id) ? sendMessage(chatId, inventoryValuationText(), adminButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/backupnow') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    try {
      const b = createDataBackup('telegram-command');
      pruneOldBackups(db.settings.autoBackupMaxFiles || 30);
      return sendMessage(chatId, `✅ Backup created\nFile: <code>${escapeHtml(b.file)}</code>\nSize: ${escapeHtml(bytesHuman(b.size))}`, backupAdminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Backup failed: ${escapeHtml(err.message)}`, adminButtons());
    }
  }
  if (text === '/backup') return isAdmin(from.id) ? sendMessage(chatId, backupStatusText(), backupAdminButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/autobackup') {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can toggle auto backup.');
    db.settings.autoBackupEnabled = db.settings.autoBackupEnabled === false ? true : false;
    saveData();
    return sendMessage(chatId, `✅ Auto Backup: <b>${db.settings.autoBackupEnabled ? 'ON' : 'OFF'}</b>`, backupAdminButtons());
  }
  if (text.startsWith('/setkeywords ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const m = text.match(/^\/setkeywords\s+(\S+)\s+([\s\S]+)/i);
    if (!m) return sendMessage(chatId, 'Usage:\n<code>/setkeywords P001 gemini, google ai, 18 months</code>', adminButtons());
    const p = productByCode(m[1].toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.groupKeywords = m[2].trim();
    saveData();
    return sendMessage(chatId, `✅ Keywords saved.\n\n${groupReplyStatsText(p)}`, productManagerButtons(p));
  }
  if (text.startsWith('/keywords ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const p = productByCode(text.split(/\s+/)[1]?.toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    return sendMessage(chatId, groupReplyStatsText(p), productManagerButtons(p));
  }
  if (text.startsWith('/groupreplypreview ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split(/\s+/);
    const p = productByCode(parts[1]?.toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const trigger = parts.slice(2).join(' ') || (productKeywordList(p)[0] || p.name);
    return sendMessage(chatId, premiumGroupProductReply(p, trigger), directBuyKeyboard(p, 'group'));
  }
  if (text.startsWith('/testkeyword ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const query = text.replace(/^\/testkeyword\s+/i, '').trim();
    const rule = findChannelRuleByText(query);
    if (!rule) return sendMessage(chatId, `❌ No product matched for:\n<code>${escapeHtml(query)}</code>`, adminButtons());
    const p = productByCode(rule.productCode);
    return sendMessage(chatId, `✅ Matched: <b>${escapeHtml(p?.name || rule.productCode)}</b>\nKeyword: <code>${escapeHtml(rule.matchedKeyword || rule.keywords || '')}</code>\nScore: <b>${escapeHtml(rule.score || '-')}</b>\n\n${p ? premiumGroupProductReply(p, rule.matchedKeyword || query) : ''}`, p ? directBuyKeyboard(p, 'group') : adminButtons());
  }
if (text.startsWith('/setperms ')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can set permissions.');
    const m = text.match(/^\/setperms\s+(\S+)\s+([\w,]+)$/i);
    if (!m) return sendMessage(chatId, `Usage:\n<code>/setperms ADMIN_ID products,stock,orders</code>\n\nAvailable:\n<code>${webPermissionCatalog().map(p=>p.id).join(',')}</code>`, adminButtons());
    const a = (db.admins || []).find(x => String(x.id) === String(m[1]) || String(x.username || '').replace('@','').toLowerCase() === String(m[1]).replace('@','').toLowerCase());
    if (!a) return sendMessage(chatId, '❌ Admin not found.', adminButtons());
    a.permissions = normalizePermissionList(m[2].split(','));
    if (String(a.id) === ADMIN_ID || String(a.role).toLowerCase() === 'owner') a.permissions = ['all'];
    a.permissionsUpdatedAt = now();
    a.permissionsUpdatedBy = String(from.id);
    saveData();
    return sendMessage(chatId, `✅ Permissions updated.\n\nAdmin: <b>${escapeHtml(a.name || a.username || a.id)}</b>\nAllowed: <b>${escapeHtml(adminPermissionLabels(a))}</b>`, adminButtons());
  }
  if (text.startsWith('/perms ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const ref = text.split(/\s+/)[1];
    const a = (db.admins || []).find(x => String(x.id) === String(ref) || String(x.username || '').replace('@','').toLowerCase() === String(ref || '').replace('@','').toLowerCase());
    if (!a) return sendMessage(chatId, '❌ Admin not found.', adminButtons());
    return sendMessage(chatId, `🔐 <b>Admin Permissions</b>\n\nAdmin: <b>${escapeHtml(a.name || a.username || a.id)}</b>\nRole: <b>${escapeHtml(adminRoleLabel(a.role))}</b>\nAllowed: <b>${escapeHtml(adminPermissionLabels(a))}</b>\n\nAvailable:\n<code>${webPermissionCatalog().map(p=>p.id).join(',')}</code>`, adminButtons());
  }
  if (session?.type === 'manage_bulk_price_percent') {
    const pct = Number(text);
    if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 90) return sendMessage(chatId, '❌ Send a valid percentage between -90 and 90. Example: 10 or -15', cancelAdminButtons());
    const r = bulkPriceUpdate(pct, true);
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Bulk Price Updated</b>\n\nProducts updated: <b>${r.count}</b>\nChange: <b>${r.pct}%</b>`, easyManageButtons());
  }
  if (session?.type === 'admin_note_add') {
    const n = addAdminNote(text, from.username || from.id);
    clearSession(from.id);
    return sendMessage(chatId, n ? `✅ Note added.\n\n${notesText()}` : '❌ Empty note.', notesButtons());
  }

  if (text === '/datahelper' || text === '/bulkhelper' || text === '/formathelper') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    setSession(from.id, { type: 'bulk_helper_input_format' });
    return sendMessage(chatId, bulkDataHelperGuideText() + `\n\n<b>Step 1/4:</b> Send input format now.\nExample: <code>Mail|Pass|2FA</code>`, cancelAdminButtons());
  }
if (text === '/manage' || text === '/quickmanage') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, easyManageText(), easyManageButtons());
  }
  if (text === '/notes' || text === '/tasks') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, notesText(), notesButtons());
  }
  if (text.startsWith('/addnote ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const n = addAdminNote(text.replace(/^\/addnote\s+/i, ''), from.username || from.id);
    return sendMessage(chatId, n ? '✅ Note added.' : '❌ Empty note.', notesButtons());
  }
  if (text.startsWith('/setlowstock ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const v = Math.max(0, Number(text.split(/\s+/)[1] || 2));
    db.settings.lowStockThreshold = v;
    saveData();
    return sendMessage(chatId, `✅ Low-stock threshold set to <b>${v}</b>.`, easyManageButtons());
  }
  if (text.startsWith('/bulkprice ')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can bulk update prices.');
    const pct = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 90) return sendMessage(chatId, 'Usage: <code>/bulkprice 10</code> or <code>/bulkprice -15</code>');
    const r = bulkPriceUpdate(pct, true);
    return sendMessage(chatId, `✅ Bulk price updated.\nProducts: <b>${r.count}</b>\nChange: <b>${r.pct}%</b>`, easyManageButtons());
  }
  if (text.startsWith('/setwebpass ')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can set web panel passwords.');
    const m = text.match(/^\/setwebpass\s+(\S+)\s+(.{6,})$/);
    if (!m) return sendMessage(chatId, 'Usage:\n<code>/setwebpass 123456789 strongPassword</code>', adminButtons());
    const a = (db.admins || []).find(x => String(x.id) === String(m[1]) || String(x.username || '').replace('@','').toLowerCase() === String(m[1]).replace('@','').toLowerCase());
    if (!a) return sendMessage(chatId, '❌ Admin not found. Add admin first.', adminButtons());
    a.webPasswordHash = hashWebPassword(m[2]);
    a.webPasswordSetAt = now();
    saveData();
    return sendMessage(chatId, `✅ Web panel access enabled.\n\nAdmin: <b>${escapeHtml(a.name || a.username || a.id)}</b>\nRole: <b>${escapeHtml(adminRoleLabel(a.role))}</b>\nLogin: <code>${escapeHtml(a.username || a.id)}</code>\n\nShare password privately only.`, adminButtons());
  }
  if (text === '/webteam') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    let out = `🔐 <b>Team Web Access</b>\n\n`;
    (db.admins || []).forEach((a, i) => {
      out += `${i+1}. ${a.webPasswordHash ? '✅' : '❌'} <b>${escapeHtml(a.name || a.username || a.id)}</b>\nID: <code>${escapeHtml(a.id)}</code>\nRole: ${escapeHtml(adminRoleLabel(a.role))}\nWeb: ${a.webPasswordHash ? 'Enabled' : 'Disabled'}\n\n`;
    });
    return sendMessage(chatId, out, adminButtons());
  }
  if (text === '/featurecheck' || text === '/checkfeatures') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, appFeatureCheckText(), adminButtons());
  }
if (text === '/stockwait' || text === '/waitingstock') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, stockWaitText(), stockWaitButtons());
  }
  if (text === '/processstockwait') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const r = await processStockWaitQueue('', 'manual');
    return sendMessage(chatId, `🔁 <b>Stock Wait Queue Processed</b>\n\n✅ Delivered: <b>${r.ok}</b>\n⏭ Skipped: <b>${r.skipped}</b>\n❌ Failed: <b>${r.fail}</b>`, stockWaitButtons());
  }
  if (text === '/expirepayments') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const r = await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
    return sendMessage(chatId, `⌛ <b>Pending Payment Expiry Scan</b>\n\nExpired: <b>${r.count}</b>\nNotified: <b>${r.notified}</b>\nValid Time: <b>${paymentExpiryMinutes()} minutes</b>`, adminButtons());
  }
if (text === '/healthcheck' || text === '/health' || text === '/speed') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, premiumHealthText(), adminParityButtons());
  }
  if (text === '/speedtest') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    await sendMessage(chatId, '⏳ Running speed test...');
    const result = await runSpeedTest();
    addHealthLog('manual_speed_test', { totalMs: result.totalMs, tests: result.tests }, result.totalMs > Number(db.settings.speedWarnMs || 2500) ? 'warn' : 'info');
    return sendMessage(chatId, speedTestText(result), adminParityButtons());
  }
  if (text === '/safedelivery') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, safeDeliveryText(), safeDeliveryButtons());
  }
  if (text === '/retrydelivery') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const r = await retryFailedDeliveries(10);
    return sendMessage(chatId, `🔁 <b>Retry Failed Deliveries</b>\n\n✅ Success: <b>${r.ok}</b>\n❌ Failed: <b>${r.fail}</b>`, safeDeliveryButtons());
  }
  if (text === '/securityscan') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, securityScanText(), securityCenterButtons());
  }
if (text === '/diag' || text === '/admincheck' || text === '/botstatus') {
    if (!isAdmin(from.id)) return sendMessage(chatId, adminAccessDebugText(from));
    return sendMessage(chatId, telegramAdminDiagnosticText(from), adminParityButtons());
  }
  if (text === '/features' || text === '/featuremap') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, adminFeatureMapText(), adminParityButtons());
  }
  if (text === '/testbuttons' || text === '/apptest') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, testAdminButtonsText(), adminParityButtons());
  }
  if (text === '/web' || text === '/webadmin') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const web = webAdminUrl('/admin-web');
    return sendMessage(chatId, web ? `🌐 <b>Web Admin Panel</b>\n\n<a href="${escapeHtml(web)}">Open Web Admin</a>` : `🌐 <b>Web Admin URL not set.</b>\n\nSet <code>WEB_BASE_URL</code> in hosting ENV or Web Settings.`, adminParityButtons());
  }
if (text === '/groups' || text === '/alertgroups') return isAdmin(from.id) ? sendMessage(chatId, groupListText(), groupManagerButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/testgroups') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const sent = await sendToRegisteredGroups(`🧪 <b>Group Alert Test</b>\n\nIf you see this message, group alerts are working.\n\n🤖 Bot: @${escapeHtml(getBotUsername() || botUsername || '')}`, inline([[{ text: '🛍 Open Store', url: `https://t.me/${getBotUsername() || botUsername}` }]]), 'test');
    return sendMessage(chatId, `✅ Test alert sent to <b>${sent}</b> group(s).`, groupManagerButtons());
  }
  if (text.startsWith('/sendstockgroups ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split(/\s+/);
    const p = productByCode(parts[1]?.toUpperCase());
    const added = Number(parts[2] || (p?.stock?.length || 1));
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const sent = await sendToRegisteredGroups(premiumStockAlertText(p, added), channelBuyButtons(p), 'stock', p.code);
    return sendMessage(chatId, `✅ Stock alert sent to <b>${sent}</b> registered group(s).`, groupManagerButtons());
  }
if (text === '/security') return isAdmin(from.id) ? sendMessage(chatId, securityCenterText(), securityCenterButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text.startsWith('/lockuser ')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can lock users.');
    const parts = text.split(/\s+/);
    const id = parts[1];
    const mins = Number(parts[2] || 60);
    const reason = parts.slice(3).join(' ') || 'Manual security lock';
    lockUserSecurity(id, reason, mins);
    return sendMessage(chatId, `🔒 User locked: <code>${escapeHtml(id)}</code>\nMinutes: ${mins}\nReason: ${escapeHtml(reason)}`, securityCenterButtons());
  }
  if (text.startsWith('/unlockuser ')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can unlock users.');
    const id = text.split(/\s+/)[1];
    unlockUserSecurity(id);
    return sendMessage(chatId, `🔓 User unlocked: <code>${escapeHtml(id)}</code>`, securityCenterButtons());
  }
  if (text === '/risk') return isAdmin(from.id) ? sendMessage(chatId, riskCenterText(12), riskCenterButtons()) : sendMessage(chatId, '❌ Access denied.');
  if (text === '/find') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    setSession(from.id, { type: 'admin_quick_find' });
    return sendMessage(chatId, '🔎 Send order/payment/user/product ID to search.', cancelAdminButtons());
  }
  if (text.startsWith('/find ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const ref = text.replace(/^\/find\s+/i, '').trim();
    return sendMessage(chatId, quickFindText(ref), quickFindButtons(ref));
  }
  if (text.startsWith('/sale ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const parts = text.split('|').map(x => x.trim());
    const body = saleTemplateText(parts[0].replace(/^\/sale\s+/i, '') || 'Premium Product', parts[1] || '$1.8', parts[2] || '$1', parts[3] || 'limited');
    const sent = await broadcastAnnouncement(body);
    return sendMessage(chatId, `✅ <b>Sale announcement sent</b>\nSent: ${sent}\n\n${premiumAnnouncementText(body)}`, adminButtons());
  }
  if (text === '/maint' || text.startsWith('/maint ')) {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    const body = maintenanceTemplateText(text.replace(/^\/maint\s*/i, '').trim() || 'new updates and improvements');
    const sent = await broadcastAnnouncement(body);
    return sendMessage(chatId, `✅ <b>Maintenance announcement sent</b>\nSent: ${sent}\n\n${premiumAnnouncementText(body)}`, adminButtons());
  }
  if (text === '/helpadmin') {
    if (!isAdmin(from.id)) return sendMessage(chatId, '❌ Access denied.');
    return sendMessage(chatId, `🧾 <b>Admin Commands</b>\n\n<code>/admin</code> - Open admin panel
<code>/datahelper</code> - Bulk data extract/merge helper
<code>/manage</code> - Easy manage center
<code>/notes</code> - Admin notes/tasks
<code>/addnote text</code> - Add admin note
<code>/bulkprice 10</code> - Bulk price % update
<code>/setlowstock 2</code> - Low stock threshold
<code>/featurecheck</code> - Check important bot features
<code>/setwebpass ADMIN_ID password</code> - Enable team web panel login
<code>/setperms ADMIN_ID products,stock</code> - Set web permissions
<code>/perms ADMIN_ID</code> - Show admin permissions
<code>/webteam</code> - Show team web access
<code>/stockwait</code> - Paid orders waiting for stock
<code>/processstockwait</code> - Deliver queued orders when stock available
<code>/expirepayments</code> - Expire old pending payments
<code>/healthcheck</code> - Health and speed status
<code>/speedtest</code> - Live speed test
<code>/safedelivery</code> - Safe delivery center
<code>/retrydelivery</code> - Retry failed deliveries
<code>/securityscan</code> - Security scan
<code>/diag</code> - App + web admin diagnostic
<code>/web</code> - Web admin link
<code>/features</code> - App/web feature map
<code>/testbuttons</code> - Telegram admin button test
<code>/myid</code> - Show Telegram ID
<code>/claimowner</code> - Recover owner admin access\n<code>/products</code> - Product manager\n<code>/orders</code> - Orders\n<code>/pending</code> - Pending payments\n<code>/users</code> - Users\n<code>/payments</code> - Recent payments\n<code>/stock</code> - Add stock\n<code>/announce</code> - Premium announcement\n<code>/announce Your message</code> - Send instantly
<code>/customannounce</code> - Custom bold/style message
<code>/setlogo P001 💎</code> - Set product logo
<code>/emojiids</code> - Extract custom emoji IDs
<code>/brandcodes</code> or <code>/brandcodes ai</code> - Show app/AI website codes
<code>/setbrandemoji gemini ID</code> - Set app code custom emoji
<code>/setcustomemoji P001 ID</code> - Set product custom emoji
<code>/setbrand P001 gemini</code> - Set product brand code
<code>/autobrandproducts</code> - Auto assign brand codes
<code>/setpromo P001 template</code> - Set product promo template\n<code>/addadmin USER_ID manager</code> - Add admin\n<code>/removeadmin USER_ID</code> - Remove admin`, adminButtons());
  }
  if (text.startsWith('/admins')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can open Admin Manager.', adminButtons());
    return sendMessage(chatId, '👑 <b>Admin Manager</b>\n\nChoose an option below.', inline(adminManagerRows()));
  }
  if (text.startsWith('/addadmin') || text.startsWith('/adminadd')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can add admins.', adminButtons());
    const parts = text.split(/\s+/).filter(Boolean);
    const ref = parts[1] || '';
    const role = parts[2] || 'manager';
    if (!ref) return sendMessage(chatId, 'Usage:\n<code>/addadmin 123456789 manager</code>\n\nRoles: manager, support, stock, finance, viewer', adminButtons());
    try {
      const admin = await addTelegramAdminFromRef(ref, role, from.id);
      return sendMessage(chatId, `✅ <b>Admin added</b>\n\nID: <code>${escapeHtml(admin.id)}</code>\nRole: <b>${escapeHtml(adminRoleLabel(admin.role))}</b>`, inline(adminManagerRows()));
    } catch (err) {
      return sendMessage(chatId, `❌ Add admin failed:\n${escapeHtml(err.message)}`, adminButtons());
    }
  }
  if (text.startsWith('/removeadmin')) {
    if (!isOwnerAdmin(from.id)) return sendMessage(chatId, '❌ Only owner can remove admins.', adminButtons());
    const id = text.split(/\s+/)[1];
    if (!id) return sendMessage(chatId, 'Usage: <code>/removeadmin 123456789</code>', adminButtons());
    if (String(id) === ADMIN_ID) return sendMessage(chatId, '❌ Main owner cannot be removed.', adminButtons());
    db.admins = adminList().filter(a => String(a.id) !== String(id));
    saveData();
    addAdminLog('admin_removed_command', from.id, id, {});
    try { await sendMessage(id, '🗑 Your admin access has been removed.'); } catch (_) {}
    return sendMessage(chatId, `🗑 Admin removed: <code>${escapeHtml(id)}</code>`, inline(adminManagerRows()));
  }

  if (['group', 'supergroup'].includes(msg.chat?.type)) {
    const replied = await handleGroupKeywordMessage(msg);
    if (replied) return;
  }
  getUser(from);
  if (isBannedUser(from.id)) return sendMessage(chatId, '🚫 <b>Your access to this store is blocked.</b>');

  if (session?.type === 'admin_order_search') {
    clearSession(from.id);
    return showAdminOrders(chatId, 1, text);
  }

  if (session?.type === 'order_search') {
    clearSession(from.id);
    return showOrders(chatId, from, 1, text);
  }

  if (session?.type === 'review_text') {
    const order = db.orders.find(o => o.id === session.orderId && o.telegramId === String(from.id));
    if (!order) { clearSession(from.id); return sendMessage(chatId, '❌ Order not found.', userToolsButtons(from.id)); }
    const review = createOrUpdateReview(order, from, session.rating || 5, text);
    clearSession(from.id);
    try {
      await sendMessage(ADMIN_ID, `⭐ <b>New Review</b>\n\n${ratingStars(review.rating)} ${review.rating}/5\nProduct: <b>${escapeHtml(review.productName)}</b>\nUser: <b>${escapeHtml(review.firstName)}</b> ${review.username ? '@' + escapeHtml(review.username) : ''}\n\nReview:\n${escapeHtml(review.message || '-')}`, adminButtons());
    } catch (_) {}
    return sendMessage(chatId, '✅ Review saved. Thank you! ❤️', userToolsButtons(from.id));
  }

  if (session?.type === 'support_ticket_msg') {
    if (text.length < 3) return sendMessage(chatId, '❌ Please send a proper message for support.', homeButtons(from.id));
    const ticket = createSupportTicket(from, text);
    clearSession(from.id);
    await notifyAdminTicket(ticket);
    return sendMessage(chatId, `✅ <b>Support Ticket Created</b>\n\nTicket ID: <code>${escapeHtml(ticket.id)}</code>\nAdmin will reply soon.`, homeButtons(from.id));
  }

  if (session?.type === 'ticket_reply_msg') {
    const ticket = (db.supportTickets || []).find(t => t.id === session.ticketId);
    if (!ticket) { clearSession(from.id); return sendMessage(chatId, '❌ Ticket not found.', adminButtons()); }
    ticket.replies ||= [];
    ticket.replies.push({ by: 'admin', message: text, at: now() });
    ticket.status = 'answered'; ticket.updatedAt = now(); saveData(); clearSession(from.id);
    try { await sendMessage(ticket.telegramId, `🎫 <b>Support Reply</b>\n\nTicket: <code>${escapeHtml(ticket.id)}</code>\n\n${escapeHtml(text)}`, inline([[{ text: '🆘 Open New Ticket', callback_data: 'support_ticket' }], [{ text: '🏠 Main Menu', callback_data: 'home' }]])); } catch (_) {}
    return sendMessage(chatId, '✅ Reply sent to user.', ticketAdminButtons(ticket.id));
  }

  if (session?.type === 'direct_msg_user') {
    const userId = session.userId;
    clearSession(from.id);
    try { await sendDirectUserMessage(userId, text); return sendMessage(chatId, `✅ Message sent to ${userId}.`, adminButtons()); } catch (err) { return sendMessage(chatId, `❌ Failed: ${escapeHtml(err.message)}`, adminButtons()); }
  }

  if (session?.type === 'manual_order_user') {
    const userId = text.trim();
    if (!db.users[userId]) return sendMessage(chatId, '❌ User not found. Send valid Telegram ID.', cancelAdminButtons());
    session.userId = userId; session.type = 'manual_order_product'; setSession(from.id, session);
    return sendMessage(chatId, 'Send product code for manual delivery. Example: P003', cancelAdminButtons());
  }
  if (session?.type === 'manual_order_product') {
    const p = productByCode(text.trim().toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found. Send valid code.', cancelAdminButtons());
    session.productCode = p.code; session.type = 'manual_order_qty'; setSession(from.id, session);
    return sendMessage(chatId, `Product: ${escapeHtml(p.name)}\nStock: ${p.stock.length}\n\nSend quantity.`, cancelAdminButtons());
  }
  if (session?.type === 'manual_order_qty') {
    const qty = Number(text);
    if (!qty || qty < 1) return sendMessage(chatId, '❌ Send valid quantity.', cancelAdminButtons());
    try { const order = await createManualOrder(session.userId, session.productCode, qty, 'Manual Admin Delivery'); clearSession(from.id); return sendMessage(chatId, `✅ Manual order delivered.\nOrder: ${order.id}`, adminButtons()); } catch (err) { return sendMessage(chatId, `❌ Manual delivery failed:\n${escapeHtml(err.message)}`, adminButtons()); }
  }

  if (session?.type === 'channel_rule_keywords') {
    session.keywords = text.trim();
    session.type = 'channel_rule_product';
    setSession(from.id, session);
    return sendMessage(chatId, 'Now send product code for this keyword rule.\nExample: P003', cancelAdminButtons());
  }
  if (session?.type === 'channel_rule_product') {
    const p = productByCode(text.trim().toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found. Send valid product code.', cancelAdminButtons());
    db.channelRules ||= [];
    db.channelRules.push({ id: nextChannelRuleId(), keywords: session.keywords, productCode: p.code, active: true, createdAt: now() });
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Channel keyword rule added.\n\nKeywords: ${escapeHtml(session.keywords)}\nProduct: ${p.code} | ${escapeHtml(p.name)}`, adminButtons());
  }

  if (session?.type === 'descgen_name') {
    session.name = text.trim();
    session.type = 'descgen_details';
    setSession(from.id, session);
    return sendMessage(chatId, 'Now send short details / key points.\n\nExample:\nInstant redeem link\nGemini Pro + 5TB storage\nValidity 18 months', cancelAdminButtons());
  }
  if (session?.type === 'descgen_details') {
    const pack = generateDescriptionPack(session.name, text, {});
    clearSession(from.id);
    return sendMessage(chatId, `✨ <b>Generated Description</b>\n\n<code>${escapeHtml(pack.description)}</code>\n\n📣 <b>Group Promo</b>\n<code>${escapeHtml(pack.groupPromo)}</code>\n\n⚡ <b>Short Promo</b>\n<code>${escapeHtml(pack.shortPromo)}</code>`, adminButtons());
  }

  if (session?.type === 'coupon_input') {
    const s = { ...session };
    const p = productByCode(s.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', homeButtons(from.id));
    const coupon = findCoupon(text);
    if (!coupon) return sendMessage(chatId, '❌ Invalid or expired coupon code.', inline([[{ text: 'Back', callback_data: 'checkout_back' }]]));
    const subtotal = Number(s.subtotal || (getProductPrice(p, from.id) * Number(s.qty || 1)));
    const applied = applyCoupon(subtotal, coupon);
    if (applied.error) return sendMessage(chatId, `❌ ${escapeHtml(applied.error)}`, inline([[{ text: 'Back', callback_data: 'checkout_back' }]]));
    clearSession(from.id);
    return showCheckoutSummary(chatId, from, { productCode: p.code, qty: s.qty, subtotal, discount: applied.discount, total: applied.final, couponCode: coupon.code });
  }

  if (session?.type === 'coupon_add_code') {
    session.code = text.trim().toUpperCase().replace(/\s+/g, '');
    session.type = 'coupon_add_type';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send coupon type: percent or fixed', cancelAdminButtons());
  }
  if (session?.type === 'coupon_add_type') {
    const type = text.trim().toLowerCase();
    if (!['percent', 'fixed'].includes(type)) return sendMessage(chatId, '❌ Send percent or fixed.', cancelAdminButtons());
    session.discountType = type;
    session.type = 'coupon_add_value';
    setSession(from.id, session);
    return sendMessage(chatId, `Send coupon value.\nExample: ${type === 'percent' ? '10' : '2.5'}`, cancelAdminButtons());
  }
  if (session?.type === 'coupon_add_value') {
    const value = Number(text);
    if (!value || value <= 0) return sendMessage(chatId, '❌ Send valid value.', cancelAdminButtons());
    db.coupons ||= [];
    db.coupons.push({ id: nextCouponId(), code: session.code, type: session.discountType, value, active: true, maxUses: 0, uses: 0, minAmount: 0, createdAt: now() });
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Coupon created: ${escapeHtml(session.code)}\nDiscount: ${session.discountType === 'percent' ? value + '%' : money(value)}`, adminButtons());
  }

  if (session?.type === 'search_product') {
    clearSession(from.id);
    return searchProducts(chatId, from, text);
  }

  if (session?.type === 'custom_deposit_amount') {
    const amount = Number(text);
    if (!amount || amount <= 0) return sendMessage(chatId, '❌ Send valid deposit amount.', inline([[{ text: 'Cancel', callback_data: 'deposit' }]]));
    return showDepositMethods(chatId, from, amount);
  }

  if (session?.type === 'custom_qty') {
    const qty = Number(text);
    if (!qty || qty < 1) return sendMessage(chatId, '❌ Send valid quantity.', inline([[{ text: 'Cancel', callback_data: 'home' }]]));
    return showCheckout(chatId, from, session.productCode, qty);
  }

  if (session?.type === 'submit_txid') {
    const p = db.payments.find((x) => x.id === session.paymentId && x.telegramId === String(from.id));
    if (!p) { clearSession(from.id); return sendMessage(chatId, '❌ Payment not found.', homeButtons(from.id)); }
    const txid = text.trim();
    if (!isAdmin(from.id) && rateLimitHit('txid_submit', `${from.id}:${p.id}`, Number(db.settings.txidSubmitLimitPer15Min || 5), 15 * 60 * 1000, { paymentId: p.id })) {
      recordPaymentFail(p, 'Too many TXID submissions');
      return sendMessage(chatId, '🚦 Too many TXID submissions. Please wait 15 minutes or contact support.', paymentFallbackButtons(p.id));
    }
    if (txid.length < 4) {
      recordPaymentFail(p, 'Invalid/too short TXID submitted');
      return sendMessage(chatId, '❌ Please send a valid TXID / Order ID / transaction hash.', paymentFallbackButtons(p.id));
    }
    const used = txidAlreadyUsedElsewhere(txid, p.id);
    if (used) {
      recordPaymentFail(p, `TXID already used by payment ${used.id}`);
      addSecurityLog('duplicate_txid_submit', from.id, { paymentId: p.id, txid: short(txid, 80), usedBy: used.id }, 'high');
      await securityNotifyAdmins(`Duplicate TXID/Order ID submitted.

User: <code>${escapeHtml(from.id)}</code>
Payment: <code>${escapeHtml(p.id)}</code>
Already used by: <code>${escapeHtml(used.id)}</code>`);
      return sendMessage(chatId, `❌ <b>This TXID / Order ID is already used.</b>

If this is a mistake, contact support with screenshot.`, paymentFallbackButtons(p.id));
    }
    p.submittedReference = txid;
    p.status = 'pending';
    p.lastCheckReason = '';
    saveData();
    clearSession(from.id);
    return autoCheckPayment(chatId, from, p);
  }

  if (!isAdmin(from.id)) return sendMessage(chatId, 'Use menu buttons below.', homeButtons(from.id));

  if (session?.type === 'adm_add_id') {
    if (!isOwnerAdmin(from.id)) { clearSession(from.id); return sendMessage(chatId, '❌ Only owner can add admins.', adminButtons()); }
    const ref = text.trim();
    const user = findUserByRef(ref);
    const id = user?.telegramId || ref.replace('@', '');
    if (!/^\d+$/.test(String(id))) return sendMessage(chatId, '❌ Send valid Telegram numeric user ID. If using username, that user must have started the bot first.', cancelAdminButtons());
    if (String(id) === ADMIN_ID || adminList().some(a => String(a.id) === String(id))) return sendMessage(chatId, '⚠️ This user is already admin.', inline(adminManagerRows()));
    setSession(from.id, { type: 'adm_add_role', adminId: String(id), userSnapshot: user || null });
    return sendMessage(chatId, `🛡 Select role for <code>${escapeHtml(id)}</code>:\n\nReply one of:\n<code>manager</code>\n<code>support</code>\n<code>stock</code>\n<code>finance</code>\n<code>viewer</code>\n\nRecommended: <b>manager</b>`, cancelAdminButtons());
  }
  if (session?.type === 'adm_add_role') {
    if (!isOwnerAdmin(from.id)) { clearSession(from.id); return sendMessage(chatId, '❌ Only owner can add admins.', adminButtons()); }
    const role = normalizeAdminRole(text);
    const u = session.userSnapshot || db.users[String(session.adminId)] || {};
    db.admins ||= [];
    db.admins.push({
      id: String(session.adminId),
      username: u.username || '',
      name: u.firstName || 'Admin',
      role,
      active: true,
      addedBy: String(from.id),
      addedAt: now(),
      note: 'Added from Telegram admin manager'
    });
    saveData();
    addAdminLog('admin_added', from.id, session.adminId, { role, username: u.username || '' });
    clearSession(from.id);
    try { await sendMessage(session.adminId, `✅ You have been added as admin in ${escapeHtml(STORE_NAME)}.\nRole: <b>${escapeHtml(adminRoleLabel(role))}</b>\n\nSend /admin to open admin panel.`); } catch (_) {}
    return sendMessage(chatId, `✅ Admin added successfully.\nID: <code>${escapeHtml(session.adminId)}</code>\nRole: <b>${escapeHtml(adminRoleLabel(role))}</b>`, inline(adminManagerRows()));
  }
  if (session?.type === 'adm_direct_msg') {
    if (!isOwnerAdmin(from.id)) { clearSession(from.id); return sendMessage(chatId, '❌ Only owner can message admins.', adminButtons()); }
    const target = session.adminId;
    clearSession(from.id);
    try {
      await sendMessage(target, `📩 <b>Message from Owner</b>\n\n${escapeHtml(text)}`, adminButtons());
      addAdminLog('admin_direct_message', from.id, target, { length: text.length });
      return sendMessage(chatId, `✅ Message sent to admin <code>${escapeHtml(target)}</code>.`, adminButtons());
    } catch (err) {
      return sendMessage(chatId, `❌ Failed to message admin:\n${escapeHtml(err.message)}`, adminButtons());
    }
  }
  if (session?.type === 'adm_broadcast_msg') {
    if (!isOwnerAdmin(from.id)) { clearSession(from.id); return sendMessage(chatId, '❌ Only owner can broadcast to admins.', adminButtons()); }
    clearSession(from.id);
    const sent = await notifyAllAdmins(`📣 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`, adminButtons());
    addAdminLog('admin_broadcast', from.id, 'all_admins', { sent, length: text.length });
    return sendMessage(chatId, `✅ Admin broadcast sent to ${sent} admin(s).`, adminButtons());
  }


  // Admin text sessions
  if (session?.type === 'camp_custom_text') {
    setSession(from.id, { type: 'camp_segment', campaignType: 'custom', campaignMessage: text });
    return sendMessage(chatId, `📣 <b>Choose Target Segment</b>\n\nPreview:\n${escapeHtml(text).slice(0, 600)}`, inline([
      [{ text: '👥 All Users', callback_data: 'camp_seg:all' }],
      [{ text: '🛒 Buyers Only', callback_data: 'camp_seg:buyers' }],
      [{ text: '🆕 Non-Buyers', callback_data: 'camp_seg:nonbuyers' }],
      [{ text: '💰 Wallet Users', callback_data: 'camp_seg:wallet' }],
      [{ text: '😴 Inactive Users', callback_data: 'camp_seg:inactive' }],
      [{ text: 'Cancel', callback_data: 'admin' }]
    ]));
  }

  if (session?.type === 'camp_product_code' || session?.type === 'camp_flash_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found. Send product code like P001.', cancelAdminButtons());
    const type = session.type === 'camp_flash_code' ? 'flash' : 'product';
    setSession(from.id, { type: 'camp_segment', campaignType: type, productCode: p.code, campaignMessage: type === 'flash' ? flashSaleText(p) : productPromoForChannel(p, 'campaign') });
    return sendMessage(chatId, `📣 <b>Choose Target Segment</b>\n\nProduct: <b>${escapeHtml(p.name)}</b>\nType: <b>${type}</b>`, inline([
      [{ text: '👥 All Users', callback_data: 'camp_seg:all' }],
      [{ text: '🛒 Buyers Only', callback_data: 'camp_seg:buyers' }],
      [{ text: '🆕 Non-Buyers', callback_data: 'camp_seg:nonbuyers' }],
      [{ text: '💰 Wallet Users', callback_data: 'camp_seg:wallet' }],
      [{ text: '😴 Inactive Users', callback_data: 'camp_seg:inactive' }],
      [{ text: 'Cancel', callback_data: 'admin' }]
    ]));
  }

  if (session?.type === 'flash_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found. Send product code like P001.', cancelAdminButtons());
    setSession(from.id, { type: 'flash_price', productCode: p.code });
    return sendMessage(chatId, `⚡ <b>Flash Sale Price</b>\n\nProduct: <b>${escapeHtml(p.name)}</b>\nCurrent Price: <b>${money(p.price, p.currency || currency())}</b>\n\nSend sale price.\nExample: <code>1</code>`, cancelAdminButtons());
  }

  if (session?.type === 'flash_price') {
    const p = productByCode(session.productCode);
    const price = Number(text);
    if (!p || !price || price <= 0) return sendMessage(chatId, '❌ Send valid sale price.', cancelAdminButtons());
    setSession(from.id, { type: 'flash_hours', productCode: p.code, salePrice: price });
    return sendMessage(chatId, `⏰ <b>Flash Sale Duration</b>\n\nSale Price: <b>${money(price, p.currency || currency())}</b>\n\nSend duration in hours.\nExample: <code>6</code>`, cancelAdminButtons());
  }

  if (session?.type === 'flash_hours') {
    const p = productByCode(session.productCode);
    const hours = Number(text);
    if (!p || !hours || hours <= 0) return sendMessage(chatId, '❌ Send valid duration hours.', cancelAdminButtons());
    p.flashSale = {
      active: true,
      price: Number(session.salePrice),
      startsAt: now(),
      endsAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
      note: `Limited time price drop for ${hours} hour(s)`,
      createdBy: String(from.id)
    };
    saveData();
    clearSession(from.id);
    const result = await sendCampaign({ type: 'flash', segment: 'all', productCode: p.code, toChannels: true, by: from.id });
    return sendMessage(chatId, `✅ <b>Flash Sale Started</b>\n\nProduct: <b>${escapeHtml(p.name)}</b>\nSale Price: <b>${money(p.flashSale.price, p.currency || currency())}</b>\nEnds: <b>${escapeHtml(new Date(p.flashSale.endsAt).toLocaleString())}</b>\n\nCampaign sent: <b>${result.total}</b>`, inline([
      [{ text: '❌ Disable Flash Sale', callback_data: `flash_disable:${p.code}` }],
      [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
    ]));
  }

  if (session?.type === 'admin_quick_find') {
    clearSession(from.id);
    return sendMessage(chatId, quickFindText(text), quickFindButtons(text));
  }

  if (session?.type === 'capture_custom_emoji_ids') {
    const ids = extractCustomEmojiIdsFromMessage(msg);
    if (!ids.length) return sendMessage(chatId, `❌ No custom emoji ID found.\n\nSend an actual Telegram custom emoji, not a normal emoji.\n\n${customEmojiHelpText()}`, cancelAdminButtons());
    clearSession(from.id);
    let out = `🧩 <b>Custom Emoji IDs Found</b>\n\n`;
    ids.forEach((id, i) => out += `${i + 1}. <code>${escapeHtml(id)}</code>\n`);
    out += `\n<b>Use:</b>\n<code>/setcustomemoji P001 ${escapeHtml(ids[0])}</code>\n<code>/setbrandemoji gemini ${escapeHtml(ids[0])}</code>`;
    return sendMessage(chatId, out, adminButtons());
  }

  if (session?.type === 'admin_keyword_test') {
    const rule = findChannelRuleByText(text);
    if (!rule) return sendMessage(chatId, `❌ No product matched.\n\nQuery: <code>${escapeHtml(text)}</code>`, adminParityButtons());
    const p = productByCode(rule.productCode);
    clearSession(from.id);
    if (!p) return sendMessage(chatId, '❌ Matched product not found.', adminParityButtons());
    return sendMessage(chatId, `✅ <b>Keyword Matched</b>\n\nQuery: <code>${escapeHtml(text)}</code>\nProduct: <b>${escapeHtml(p.name)}</b>\nKeyword: <code>${escapeHtml(rule.matchedKeyword || rule.keywords || '')}</code>\n\n${premiumGroupProductReply(p, rule.matchedKeyword || text)}`, directBuyKeyboard(p, 'group'));
  }

  if (session?.type === 'product_access_info') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    applyProductAccessInfo(p, parseAccessInfoInput(text));
    saveData();
    clearSession(from.id);
    const sampleItem = p.stock?.[0] || createStockItemObject(p.stockFormat || 'redeem_link', stockLineExample(p.stockFormat || 'redeem_link'));
    return sendMessage(chatId, `✅ <b>Access info saved</b>\n\n<code>${escapeHtml(accessInfoPlain(p) || 'No access info')}</code>\n\n<b>Delivery preview:</b>\n${deliveryText(p.name, 1, p.price, p.currency || currency(), [sampleItem], 'DEMO-ORDER', true, p.code)}`, productManagerButtons(p));
  }

  if (session?.type === 'delivery_msg_template') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    p.deliveryMessageTemplate = text.trim();
    saveData();
    clearSession(from.id);
    const sampleItem = p.stock?.[0] || createStockItemObject(p.stockFormat || 'redeem_link', stockLineExample(p.stockFormat || 'redeem_link'));
    return sendMessage(chatId, `✅ <b>Delivery message template saved</b>\n\n<b>Preview:</b>\n${deliveryText(p.name, 1, p.price, p.currency || currency(), [sampleItem], 'DEMO-ORDER', true, p.code)}`, productManagerButtons(p));
  }

  if (session?.type === 'custom_announcement') {
    const formatted = premiumCustomAnnouncementText(text);
    const sentUsers = await broadcastToUsers(formatted, inline([[{ text: '🛍 Open Store', callback_data: 'shop:1' }]]));
    const sentChannels = await sendToConfiguredChannels(formatted, inline([[{ text: '🛍 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Custom Premium Message Sent</b>\n\nUsers: ${sentUsers}\nChannels: ${sentChannels}\n\n<b>Preview:</b>\n${formatted}`, adminButtons());
  }

  if (session?.type === 'announcement') {
    const sent = await broadcastAnnouncement(text);
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Premium Announcement Sent</b>\n\nSent to: ${sent} user/channel(s)\n\n<b>Preview:</b>\n${premiumAnnouncementText(text)}`, adminButtons());
  }

  if (session?.type === 'stock_alert_code') {
    const p = db.products.find((x) => String(x.code).toUpperCase() === String(text).toUpperCase());
    if (!p) return sendMessage(chatId, '❌ Product not found. Send valid product code like P001.', cancelAdminButtons());
    const sent = await broadcastProductAlert(p, session.alertTitle || '🔔 Stock Alert');
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>${escapeHtml(session.alertTitle || 'Stock Alert')} Sent</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\nStock: ${p.stock.length}\nSent to: ${sent} user(s)`, productManagerButtons(p));
  }

  if (session?.type === 'balance_user') {
    const target = text.trim();
    const u = db.users[target];
    if (!u) return sendMessage(chatId, '❌ User not found. Ask user to /start the bot first, then try again.', cancelAdminButtons());
    clearSession(from.id);
    return sendMessage(chatId, `💰 <b>Balance Manager</b>\n\n👤 User: <b>${escapeHtml(u.firstName || 'User')}</b> ${u.username ? '@' + escapeHtml(u.username) : ''}\nID: <code>${escapeHtml(target)}</code>\nCurrent Balance: <b>${money(u.balance || 0)}</b>\n\nChoose action:`, balanceActionButtons(target));
  }

  if (session?.type === 'balance_amount') {
    const amount = Number(text);
    const target = session.userId;
    const u = db.users[target];
    if (!u) return sendMessage(chatId, '❌ User not found.', adminButtons());
    if (!amount || amount <= 0) return sendMessage(chatId, '❌ Send valid amount.', cancelAdminButtons());

    const before = Number(u.balance || 0);
    if (session.action === 'add') u.balance = before + amount;
    else u.balance = Math.max(0, before - amount);

    db.deposits ||= [];
    db.deposits.push({
      id: 'MANUAL' + Date.now(),
      telegramId: target,
      amount: session.action === 'add' ? amount : -amount,
      currency: currency(),
      method: session.action === 'add' ? 'Admin Balance Add' : 'Admin Balance Deduct',
      reference: `Admin ${from.id}`,
      status: 'approved',
      createdAt: now()
    });

    saveData();
    clearSession(from.id);

    try {
      await sendMessage(target, `${session.action === 'add' ? '✅ Wallet Balance Added' : '⚠️ Wallet Balance Deducted'}\n\nAmount: ${money(amount)}\nNew Balance: ${money(u.balance)}`, homeButtons(target));
    } catch (_) {}

    return sendMessage(chatId, `✅ Balance updated.\n\nUser: <code>${escapeHtml(target)}</code>\nBefore: ${money(before)}\nAfter: <b>${money(u.balance)}</b>`, adminButtons());
  }

  if (session?.type === 'hide_product') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found.', cancelAdminButtons());
    p.active = false;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `🗑 Product hidden.\n\n${p.code} | ${escapeHtml(p.name)}`, adminButtons());
  }

  if (session?.type === 'add_name') {
    session.data.name = text;
    session.type = 'add_price';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send price.\nExample: 2.5', cancelAdminButtons());
  }
  if (session?.type === 'add_price') {
    const price = Number(text);
    if (!price || price <= 0) return sendMessage(chatId, '❌ Send valid price.', cancelAdminButtons());
    session.data.price = price;
    session.type = 'add_short_details';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send short product details / key points.\n\nExample:\nInstant coupon delivery\nFull warranty\nPremium stable plan\n\nBot will auto-generate attractive description from this.', cancelAdminButtons());
  }
  if (session?.type === 'add_short_details') {
    session.data.shortDetails = text;
    session.data.description = smartProductDescription(session.data.name, text);
    session.type = 'add_emoji';
    setSession(from.id, session);
    return sendMessage(chatId, `✨ Auto description generated:\n\n${escapeHtml(session.data.description)}\n\nNow send emoji/icon.\nExample: 🤖`, cancelAdminButtons());
  }
  if (session?.type === 'add_emoji') {
    const p = {
      code: nextProductCode(),
      emoji: text.slice(0, 8),
      name: session.data.name,
      price: session.data.price,
      currency: currency(),
      description: session.data.description,
      shortDetails: session.data.shortDetails || '',
      stock: [],
      sold: 0,
      active: true,
      pinned: false,
      logoFileId: '',
      specialPrices: {},
      createdAt: now()
    };
    db.products.push(p);
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Product added</b>\n\n${p.code} | ${p.emoji} ${escapeHtml(p.name)}\nPrice: ${money(p.price)}\n\nNow use <b>Add Stock</b>. When stock is added, users will get an automatic stock alert.`, adminButtons());
  }
  if (session?.type === 'stock_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found.', cancelAdminButtons());
    setSession(from.id, { type: 'stock_format', productCode: p.code });
    return sendMessage(chatId, `📦 <b>Select Stock / Delivery Format</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\n\nReply with one option:\n\n1. redeem link\n2. id password\n3. coupon\n4. custom format\n\nCustom examples:\n<code>Mail|Pass</code>\n<code>Mail|Pass|2fa</code>\n<code>Mail|ChatGPT Pass|Mail Pass|2FA</code>`, cancelAdminButtons());
  }
  if (session?.type === 'stock_format') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const raw = text.trim();
    const v = raw.toLowerCase();
    let format = '';
    if (['1', 'redeem', 'redeem link', 'link', 'url'].includes(v)) format = 'redeem_link';
    else if (['2', 'id', 'id password', 'id/password', 'login', 'account'].includes(v)) format = 'id_password';
    else if (['3', 'coupon', 'code', 'coupon code'].includes(v)) format = 'coupon_code';
    else if (['4', 'custom', 'other', 'others', 'custom format'].includes(v)) {
      setSession(from.id, { type: 'stock_custom_format', productCode: p.code });
      return sendMessage(chatId, `✨ <b>Send Custom Delivery Format</b>\n\nExamples:\n<code>Mail|Pass</code>\n<code>Mail|Pass|2fa</code>\n<code>Mail|ChatGPT Pass|Mail Pass|2FA</code>\n<code>Username|Password|Recovery Mail</code>\n\nAfter this, stock lines must follow same format.`, cancelAdminButtons());
    } else if (raw.includes('|')) {
      format = normalizeDeliveryFormat(raw);
    }
    if (!format) return sendMessage(chatId, '❌ Invalid format. Reply:\n1 redeem link\n2 id password\n3 coupon\n4 custom\n\nOr directly send custom format like:\nMail|Pass|2fa', cancelAdminButtons());
    p.stockFormat = format;
    p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
    saveData();
    setSession(from.id, { type: 'stock_lines', productCode: p.code, stockFormat: format });
    const example = stockLineExample(format);
    return sendMessage(chatId, `✅ Format set: <b>${escapeHtml(stockFormatName(format))}</b>\n\nNow send stock items line by line.\nExample:\n<code>${escapeHtml(example)}</code>`, cancelAdminButtons());
  }
  if (session?.type === 'stock_custom_format') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const template = cleanDeliveryTemplate(text);
    if (!template || !template.includes('|')) return sendMessage(chatId, '❌ Custom format must use | separator.\nExample: <code>Mail|Pass|2fa</code>', cancelAdminButtons());
    const format = `custom:${template}`;
    p.stockFormat = format;
    p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
    saveData();
    setSession(from.id, { type: 'stock_lines', productCode: p.code, stockFormat: format });
    return sendMessage(chatId, `✅ Custom format set: <b>${escapeHtml(stockFormatName(format))}</b>\n\nNow send stock items line by line.\nExample:\n<code>${escapeHtml(stockLineExample(format))}</code>`, cancelAdminButtons());
  }
  if (session?.type === 'stock_lines') {
    const p = productByCode(session.productCode);
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!p || !lines.length) return sendMessage(chatId, '❌ Invalid stock.', adminButtons());
    const format = normalizeDeliveryFormat(session.stockFormat || p.stockFormat || 'redeem_link');
    setSession(from.id, { type: 'stock_access_info', productCode: p.code, stockFormat: format, stockLines: lines });
    return sendMessage(chatId, accessInfoPromptText(p), cancelAdminButtons());
  }
  if (session?.type === 'stock_access_info') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    session.accessInfo = parseAccessInfoInput(text);
    session.type = 'stock_preview_confirm';
    setSession(from.id, session);
    return sendMessage(chatId, stockAddPreviewText(session), stockPreviewConfirmButtons());
  }
  if (session?.type === 'stock_delivery_template_edit') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    session.deliveryMessageTemplate = text.trim();
    session.type = 'stock_preview_confirm';
    setSession(from.id, session);
    return sendMessage(chatId, stockAddPreviewText(session), stockPreviewConfirmButtons());
  }
    if (session?.type === 'edit_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found.', cancelAdminButtons());
    setSession(from.id, { type: 'edit_field', productCode: p.code });
    return sendMessage(chatId, `Choose field for ${p.code}:`, inline([
      [
        { text: 'Name', callback_data: `editfield:${p.code}:name` },
        { text: 'Price', callback_data: `editfield:${p.code}:price` }
      ],
      [
        { text: 'Description', callback_data: `editfield:${p.code}:description` },
        { text: 'Emoji', callback_data: `editfield:${p.code}:emoji` }
      ],
      [{ text: 'Admin Panel', callback_data: 'admin' }]
    ]));
  }
  if (session?.type === 'bulk_price_lines') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    if (text.trim().toLowerCase() === 'clear') {
      p.bulkPrices = [];
      saveData();
      clearSession(from.id);
      return sendMessage(chatId, `✅ Bulk pricing cleared for ${escapeHtml(p.name)}.`, productManagerButtons(p));
    }
    const tiers = parseBulkPricingLines(text);
    if (!tiers.length) return sendMessage(chatId, '❌ Invalid tiers. Use:\n<code>5|1.50|5+ pieces</code>\n<code>10|1.20</code>', cancelAdminButtons());
    p.bulkPrices = tiers;
    normalizeBulkPrices(p);
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ <b>Bulk pricing saved</b>\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\n\n${escapeHtml(bulkPricingText(p))}`, productManagerButtons(p));
  }

  if (session?.type === 'special_user') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    let input = text.trim().replace('@', '');
    let user = db.users[input] || Object.values(db.users || {}).find((u) => String(u.username || '').toLowerCase() === input.toLowerCase());
    if (!user) return sendMessage(chatId, '❌ User not found. Send Telegram ID, or ask user to /start the bot first.', cancelAdminButtons());
    session.userId = String(user.telegramId);
    session.type = 'special_price_value';
    setSession(from.id, session);
    return sendMessage(chatId, `💎 User selected: ${escapeHtml(user.firstName || 'User')} ${user.username ? '@' + escapeHtml(user.username) : ''}\n\nSend special price for ${escapeHtml(p.name)}.\nExample: 1.8\n\nSend 0 to remove special price.`, cancelAdminButtons());
  }

  if (session?.type === 'special_price_value') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    const price = Number(text);
    if (Number.isNaN(price) || price < 0) return sendMessage(chatId, '❌ Send valid price, or 0 to remove.', cancelAdminButtons());
    p.specialPrices ||= {};
    if (price === 0) delete p.specialPrices[String(session.userId)];
    else p.specialPrices[String(session.userId)] = price;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Special price ${price === 0 ? 'removed' : 'saved'}.\n\nProduct: ${p.code} | ${escapeHtml(p.name)}\nUser: <code>${escapeHtml(session.userId)}</code>${price > 0 ? `\nSpecial Price: ${money(price, p.currency || currency())}` : ''}`, productManagerButtons(p));
  }

  if (session?.type === 'edit_value') {
    const p = productByCode(session.productCode);
    if (!p) return sendMessage(chatId, '❌ Product not found.', adminButtons());
    if (session.field === 'price') {
      const price = Number(text);
      if (!price || price <= 0) return sendMessage(chatId, '❌ Send valid price.', cancelAdminButtons());
      p.price = price;
    } else if (session.field === 'name') p.name = text;
    else if (session.field === 'description') p.description = text;
    else if (session.field === 'emoji') p.emoji = text.slice(0, 8);
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Updated ${p.code}.`, productManagerButtons(p));
  }
  if (session?.type === 'logo_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found.', cancelAdminButtons());
    setSession(from.id, { type: 'logo_photo', productCode: p.code });
    return sendMessage(chatId, `Send photo/logo for ${p.code}.`, cancelAdminButtons());
  }
  if (session?.type === 'pin_code') {
    const p = productByCode(text);
    if (!p) return sendMessage(chatId, '❌ Product not found.', cancelAdminButtons());
    p.pinned = !p.pinned;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ ${p.pinned ? 'Pinned' : 'Unpinned'} ${p.code}.`, adminButtons());
  }
  if (session?.type === 'set_bot_username') {
    const username = text.trim().replace('@', '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      return sendMessage(chatId, '❌ Send valid bot username without @.\nOnly letters, numbers and underscore, 5-32 chars.', cancelAdminButtons());
    }
    db.settings.botUsername = username;
    botUsername = username;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Bot username saved for links: @${escapeHtml(username)}\n\nIf you want to change actual Telegram username, change it in BotFather too.`, adminButtons());
  }

  if (session?.type === 'set_support_username') {
    let username = text.trim();
    if (!username.startsWith('@')) username = '@' + username.replace('@', '');
    db.settings.supportUsername = username;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Support username updated: ${escapeHtml(username)}`, adminButtons());
  }

  if (session?.type === 'set_channel_url') {
    const url = text.trim();
    if (!/^https:\/\/t\.me\/[A-Za-z0-9_+\-/]+$/i.test(url)) {
      return sendMessage(chatId, '❌ Send valid Telegram channel URL.\nExample: https://t.me/your_channel', cancelAdminButtons());
    }
    db.settings.channelUrl = url;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Channel URL updated:\n${escapeHtml(url)}`, adminButtons());
  }

  if (session?.type === 'set_currency') {
    db.settings.storeCurrency = text.toUpperCase().trim();
    db.products.forEach((p) => { p.currency = db.settings.storeCurrency; });
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Currency set to ${db.settings.storeCurrency}.`, adminButtons());
  }
  if (session?.type === 'pm_add_name') {
    session.data.name = text.trim();
    session.type = 'pm_add_icon';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send icon/emoji for this method.\nExample: 🟨', cancelAdminButtons());
  }
  if (session?.type === 'pm_add_icon') {
    session.data.icon = text.trim().slice(0, 8) || '💳';
    session.type = 'pm_add_key';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send method key.\nExample: USDT_BEP20 or BINANCE_PAY\n\nTip: use simple uppercase key without spaces.', cancelAdminButtons());
  }
  if (session?.type === 'pm_add_key') {
    session.data.key = text.trim().toUpperCase().replace(/\s+/g, '_');
    session.type = 'pm_add_details';
    setSession(from.id, session);
    return sendMessage(chatId, 'Send payment details / address / instructions for users.', cancelAdminButtons());
  }
  if (session?.type === 'pm_add_details') {
    const method = {
      id: nextPaymentMethodId(),
      key: session.data.key || 'MANUAL',
      icon: session.data.icon || '💳',
      name: session.data.name || 'New Method',
      details: text.trim(),
      active: true
    };
    db.paymentMethods.push(method);
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Payment method added.\n\n${method.id} | ${escapeHtml(method.icon)} ${escapeHtml(method.name)}`, paymentMethodManageButtons(method));
  }
  if (session?.type === 'pm_edit_value') {
    const m = db.paymentMethods.find((x) => x.id === session.methodId);
    if (!m) {
      clearSession(from.id);
      return sendMessage(chatId, '❌ Payment method not found.', paymentMethodAdminButtons());
    }
    if (session.field === 'name') m.name = text.trim();
    else if (session.field === 'icon') m.icon = text.trim().slice(0, 8) || '💳';
    else if (session.field === 'key') m.key = text.trim().toUpperCase().replace(/\s+/g, '_');
    else if (session.field === 'details') m.details = text.trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Payment method updated.\n\n${escapeHtml(m.icon || '💳')} ${escapeHtml(m.name)}`, paymentMethodManageButtons(m));
  }

  if (session?.type === 'set_binance_id') {
    db.settings.binanceId = text.trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, '✅ Binance UID updated.', binanceAdminButtons());
  }
  if (session?.type === 'set_binance_name') {
    db.settings.binanceName = text.trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, '✅ Binance display name updated.', binanceAdminButtons());
  }
  if (session?.type === 'set_binance_coin') {
    db.settings.binanceCoin = text.toUpperCase().trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, '✅ Binance coin updated.', binanceAdminButtons());
  }
  if (session?.type === 'set_binance_base') {
    const url = text.trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(url)) return sendMessage(chatId, '❌ Send valid URL starting with https://', cancelAdminButtons());
    db.settings.binanceBaseUrl = url;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, '✅ Binance base URL updated.', binanceAdminButtons());
  }
  if (session?.type === 'set_binance_lookback') {
    const days = Number(text);
    if (!days || days < 1 || days > 90) return sendMessage(chatId, '❌ Send valid days between 1 and 90.', cancelAdminButtons());
    db.settings.binanceLookbackDays = days;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Binance lookback updated: ${days} days`, binanceAdminButtons());
  }
  if (session?.type === 'set_binance_tolerance') {
    const tolerance = Number(text);
    if (Number.isNaN(tolerance) || tolerance < 0 || tolerance > 10) return sendMessage(chatId, '❌ Send valid tolerance between 0 and 10. Example: 0.02', cancelAdminButtons());
    db.settings.binanceAmountTolerance = tolerance;
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Binance tolerance updated: ${tolerance}`, binanceAdminButtons());
  }
  if (session?.type === 'set_binance_api') {
    db.settings.binanceApiKey = text.trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ API key saved: ${mask(text)}`, binanceAdminButtons());
  }
  if (session?.type === 'set_binance_secret') {
    db.settings.binanceSecretKey = text.trim();
    saveData();
    clearSession(from.id);
    return sendMessage(chatId, `✅ Secret key saved: ${mask(text)}`, binanceAdminButtons());
  }
  if (session?.type === 'broadcast') {
    clearSession(from.id);
    let sent = 0;
    for (const u of Object.values(db.users)) {
      try {
        await sendMessage(u.telegramId, `📢 ${escapeHtml(STORE_NAME)}\n\n${escapeHtml(text)}`, homeButtons(u.telegramId));
        sent++;
      } catch (_) {}
    }
    return sendMessage(chatId, `✅ Broadcast sent to ${sent} users.`, adminButtons());
  }
}

async function handlePhoto(msg) {
  const session = getSession(msg.from.id);
  if (!isAdmin(msg.from.id) || session?.type !== 'logo_photo') return;
  const p = productByCode(session.productCode);
  const photo = msg.photo?.[msg.photo.length - 1];
  if (!p || !photo) return;
  p.logoFileId = photo.file_id;
  saveData();
  clearSession(msg.from.id);
  return sendMessage(msg.chat.id, `✅ Logo updated for ${p.code}.`, productManagerButtons(p));
}

async function handleUpdate(update) {
  try {
    if (update.my_chat_member || update.chat_member) return handleMembershipUpdate(update);
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.channel_post?.text || update.channel_post?.caption) return handleChannelPost(update.channel_post);
    if (update.edited_channel_post?.text || update.edited_channel_post?.caption) return handleChannelPost(update.edited_channel_post);
    if (update.message && isGroupChat(update.message.chat)) {
      if (update.message.new_chat_members || update.message.left_chat_member) return handleGroupServiceMessage(update.message);
      if (update.message.text || update.message.caption) return handleText(update.message);
    }
    if (update.message?.photo) return handlePhoto(update.message);
    if (update.message?.text) return handleText(update.message);
  } catch (err) {
    runtimeStats.errors++;
    console.error('❌ Update error:', err?.stack || err?.message || err);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      try { await sendMessage(chatId, '❌ Bot error. Try again.', undefined); } catch (_) {}
    }
  }
}

// Inline edit-field callback patch
const originalHandleCallback = handleCallback;
handleCallback = async function(q) {
  const data = String(q.data || '');
  if (data.startsWith('editfield:')) {
    await answerCallback(q.id);
    if (!isAdmin(q.from.id)) return;
    const [, code, field] = data.split(':');
    setSession(q.from.id, { type: 'edit_value', productCode: code, field });
    return sendMessage(q.message.chat.id, `Send new ${field}.`, cancelAdminButtons());
  }
  return originalHandleCallback(q);
};

// =====================
// SERVER + POLLING
// =====================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

function webhookPath() {
  return WEBHOOK_SECRET ? `/api/telegram/${encodeURIComponent(WEBHOOK_SECRET)}` : '/api/telegram';
}

async function telegramWebhookHandler(req, res) {
  try {
    if (MONGODB_URI && !isMongoInitialized) {
      try {
        const cloudData = await Promise.race([
          loadDataFromMongo(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Mongo timeout')), 3000))
        ]);
        if (cloudData) {
          db = sanitizeLoadedDb(cloudData);
          isMongoInitialized = true;
        }
      } catch (e) {
        console.warn('⚠️ MongoDB initial sync skipped/timed out:', e.message);
      }
    }
    const update = req.body || {};
    if (!update || typeof update !== 'object' || !Object.keys(update).length) {
      return res.status(400).json({ ok: false, error: 'empty_update' });
    }
    runtimeStats.updates++;
    await handleUpdate(update);
    if (MONGODB_URI) {
      saveDataToMongo(true).catch(e => console.error('Async Mongo save failed:', e.message));
    }
    return res.json({ ok: true });
  } catch (err) {
    runtimeStats.errors++;
    console.error('Telegram webhook error:', err?.stack || err?.message || err);
    return res.status(200).json({ ok: false, error: String(err?.message || err).slice(0, 200) });
  }
}

app.post('/api/telegram', telegramWebhookHandler);
app.post('/telegram', telegramWebhookHandler);
app.post('/api/webhook', telegramWebhookHandler);
app.post('/api/index', telegramWebhookHandler);
app.post('/api/index.js', telegramWebhookHandler);
app.post('/', telegramWebhookHandler);
app.post('/api/telegram/:secret', (req, res) => {
  if (WEBHOOK_SECRET && req.params.secret !== WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'bad_secret' });
  return telegramWebhookHandler(req, res);
});

app.get('/api/set-webhook', async (req, res) => {
  try {
    let base = String(req.query.url || WEB_BASE_URL || '').trim().replace(/\/$/, '');
    if (!base) {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) base = `${proto}://${host}`;
    }
    if (!base) return res.status(400).json({ ok: false, error: 'Set WEB_BASE_URL or call /api/set-webhook?url=https://your-app.vercel.app' });
    const url = `${base}${webhookPath()}`;
    const result = await tg('setWebhook', {
      url,
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member']
    }, 15000);
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.send(`<!doctype html><html><head><title>Webhook Activated</title><style>body{font-family:sans-serif;background:#050711;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;}.card{background:#0f172a;padding:30px;border-radius:20px;border:1px solid #00f2fe;max-width:500px;text-align:center;box-shadow:0 10px 40px rgba(0,242,254,0.2);}h1{color:#00f2fe;margin-top:0;}code{background:#1e293b;padding:4px 8px;border-radius:6px;color:#a5f3fc;font-size:14px;}</style></head><body><div class="card"><h1>✅ Webhook Activated 24/7!</h1><p>Telegram is now sending all bot messages to Vercel URL:</p><p><code>${url}</code></p><p>Your bot is 100% live on Vercel!</p></div></body></html>`);
    }
    return res.json({ ok: true, webhook: url, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err).slice(0, 500) });
  }
});

app.get('/api/webhook-info', async (_req, res) => {
  try {
    const info = await tgGet('getWebhookInfo', {}, 15000);
    return res.json({ ok: true, info });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err).slice(0, 500) });
  }
});

// =====================
// SECURE WEB ADMIN PANEL
// =====================
const ADMIN_WEB_USER = String(process.env.ADMIN_WEB_USER || 'admin').trim();
const ADMIN_WEB_PASSWORD = String(process.env.ADMIN_WEB_PASSWORD || '').trim();
const ADMIN_WEB_SECRET = String(process.env.ADMIN_WEB_SECRET || getBotToken() || 'change-this-secret').trim();
const WEB_SESSION_HOURS = Number(process.env.ADMIN_WEB_SESSION_HOURS || 12);
const webSessions = new Map();

function webEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function webMoney(n) {
  return money(Number(n || 0), currency());
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function makeWebSession() {
  return crypto.randomBytes(32).toString('hex');
}

function signValue(v) {
  return crypto.createHmac('sha256', ADMIN_WEB_SECRET).update(String(v)).digest('hex');
}

function setSessionCookie(res, sid) {
  const value = `${sid}.${signValue(sid)}`;
  res.setHeader('Set-Cookie', `gos_admin=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/admin-web; Max-Age=${WEB_SESSION_HOURS * 3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'gos_admin=; HttpOnly; SameSite=Strict; Path=/admin-web; Max-Age=0');
}


function hashWebPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyWebPassword(stored, password) {
  const s = String(stored || '');
  const parts = s.split('$');
  if (parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return false;
  const hash = crypto.scryptSync(String(password || ''), parts[1], 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(parts[2], 'hex'));
  } catch (_) {
    return false;
  }
}

function findAdminByLogin(login) {
  const q = String(login || '').trim().replace('@','').toLowerCase();
  if (!q) return null;
  return (db.admins || []).find(a =>
    String(a.id || '').toLowerCase() === q ||
    String(a.username || '').replace('@','').toLowerCase() === q
  ) || null;
}

function webPermissionCatalog() {
  return [
    { id: 'all', label: '👑 All Access', paths: ['*'] },
    { id: 'dashboard', label: '📊 Dashboard + Diagnostics', paths: ['/dashboard','/easy-manage','/telegram-diagnostics','/feature-map','/health-speed','/system','/health'] },
    { id: 'products', label: '📦 Products', paths: ['/products','/add-product','/description-generator','/custom-emojis'] },
    { id: 'stock', label: '📥 Stock Manager', paths: ['/stock-manager','/stock-tools','/stock-wait','/inventory-valuation','/data-helper'] },
    { id: 'data_helper', label: '🧩 Bulk Data Helper', paths: ['/data-helper'] },
    { id: 'orders', label: '🧾 Orders + Safe Delivery', paths: ['/orders','/safe-delivery','/reviews','/restock'] },
    { id: 'users', label: '👥 Users + Balance', paths: ['/users','/message-user','/tickets'] },
    { id: 'payments', label: '💳 Payments + Auto Verify', paths: ['/payments','/auto-verify','/payment-risk','/quick-find'] },
    { id: 'marketing', label: '📣 Marketing + Groups', paths: ['/campaigns','/custom-message','/channels','/groups','/flash-sales'] },
    { id: 'reports', label: '📈 Reports + Profit', paths: ['/reports','/business-summary','/profit-analytics','/insights'] },
    { id: 'security', label: '🛡 Security', paths: ['/security','/security-scan'] },
    { id: 'settings', label: '⚙️ Settings', paths: ['/settings','/export','/import','/backup'] },
    { id: 'team_access', label: '🔐 Team Web Access', paths: ['/admins','/team-access'] }
  ];
}

function normalizePermissionList(perms) {
  if (!Array.isArray(perms)) return [];
  const valid = new Set(webPermissionCatalog().map(p => p.id));
  return [...new Set(perms.map(x => String(x || '').trim()).filter(x => valid.has(x)))];
}

function adminRecordById(id) {
  const sid = String(id || '');
  return (db.admins || []).find(a => String(a.id) === sid) || null;
}

function roleDefaultPermissions(role) {
  const r = String(role || 'viewer').toLowerCase();
  if (r === 'owner' || r === 'manager') return ['all'];
  if (r === 'stock') return ['dashboard','products','stock','data_helper','orders'];
  if (r === 'support') return ['dashboard','orders','users','marketing'];
  if (r === 'finance') return ['dashboard','payments','reports','stock'];
  return ['dashboard','reports'];
}

function adminSessionPermissions(session = {}) {
  const rec = adminRecordById(session.id);
  const direct = normalizePermissionList(rec?.permissions || session.permissions || []);
  if (direct.length) return direct;
  return roleDefaultPermissions(rec?.role || session.role || 'viewer');
}

function adminHasWebPermission(session = {}, permissionId = 'dashboard') {
  const rec = adminRecordById(session.id);
  const role = String(rec?.role || session.role || 'viewer').toLowerCase();
  if (role === 'owner' || String(session.id) === ADMIN_ID) return true;
  const perms = adminSessionPermissions(session);
  return perms.includes('all') || perms.includes(permissionId);
}

function webRoleAllowed(sessionOrRole, pathName) {
  const session = typeof sessionOrRole === 'object' && sessionOrRole !== null ? sessionOrRole : { role: sessionOrRole };
  const p = String(pathName || '').toLowerCase();
  if (p === '/' || p === '/logout') return true;
  const catalog = webPermissionCatalog().filter(x => x.id !== 'all');
  const match = catalog.find(item => item.paths.some(path => p.startsWith(path.toLowerCase())));
  if (!match) return adminHasWebPermission(session, 'settings');
  return adminHasWebPermission(session, match.id);
}

function permissionCheckboxes(admin) {
  const current = normalizePermissionList(admin.permissions || []);
  const roleDefaults = roleDefaultPermissions(admin.role || 'viewer');
  const effective = current.length ? current : roleDefaults;
  return `<div class="permGrid">` + webPermissionCatalog().map(p => {
    const checked = effective.includes('all') || effective.includes(p.id) ? 'checked' : '';
    return `<label><input type="checkbox" name="permissions" value="${webEsc(p.id)}" ${checked}> ${webEsc(p.label)}</label>`;
  }).join('') + `</div>`;
}

function adminPermissionLabels(admin) {
  const perms = adminSessionPermissions({ id: admin.id, role: admin.role });
  if (perms.includes('all')) return '👑 All Access';
  const map = Object.fromEntries(webPermissionCatalog().map(p => [p.id, p.label]));
  return perms.map(p => map[p] || p).join(', ') || 'No access';
}

function requireWebAccess(req, res, next) {
  const pathName = String(req.originalUrl || '').replace(/^\/admin-web/, '').split('?')[0] || '/dashboard';
  if (!webRoleAllowed(req.webAdmin, pathName)) {
    return res.status(403).send(adminLayout('Access denied', `<div class="card"><h2>🔐 Access denied</h2><p>Your role <b>${webEsc(req.webAdmin?.role || 'viewer')}</b> does not have permission for this page.</p><p>Ask owner to allow this page from <b>Team Web Access</b>.</p><a class="btn" href="/admin-web/dashboard">Back Dashboard</a></div>`));
  }
  next();
}

function webTeamRows() {
  return (db.admins || []).map(a => `<tr><td><b>${webEsc(a.name || 'Admin')}</b><br>${a.username ? '@'+webEsc(a.username) : ''}<br><span class="code">${webEsc(a.id)}</span></td><td>${webEsc(adminRoleLabel(a.role))}</td><td>${a.active === false ? '⛔ Disabled' : '✅ Active'}</td><td>${a.webPasswordHash ? '✅ Web login enabled' : '❌ No web password'}<br><span class="muted">${webEsc(adminPermissionLabels(a))}</span></td><td>${webEsc(a.webLastLoginAt ? new Date(a.webLastLoginAt).toLocaleString() : '-')}</td><td class="actions"><form method="post" action="/admin-web/team-access/${encodeURIComponent(a.id)}/password"><input name="password" type="password" placeholder="New web password" required><button class="btn">Set Password</button></form><form method="post" action="/admin-web/team-access/${encodeURIComponent(a.id)}/permissions">${permissionCheckboxes(a)}<button class="btn secondary">Save Permissions</button></form><form method="post" action="/admin-web/team-access/${encodeURIComponent(a.id)}/clear"><button class="btn danger">Disable Web Login</button></form></td></tr>`).join('');
}


function getWebSession(req) {
  const cookie = parseCookies(req).gos_admin || '';
  const [sid, sig] = cookie.split('.');
  if (!sid || !sig || sig !== signValue(sid)) return null;
  const session = webSessions.get(sid);
  if (!session || Date.now() > session.expiresAt) {
    webSessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

function requireWebAuth(req, res, next) {
  const session = getWebSession(req);
  if (!session) return res.redirect('/admin-web/login');
  req.webAdmin = session;
  next();
}

function redirectMsg(res, path, msg) {
  res.redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg || '')}`);
}

function adminLayout(title, body, msg = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${webEsc(title)} - ${webEsc(getStoreName())}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{
  --bg-main:#060814;
  --bg-card:rgba(15, 23, 42, 0.75);
  --bg-card-hover:rgba(30, 41, 59, 0.85);
  --border:rgba(255, 255, 255, 0.08);
  --border-glow:rgba(0, 242, 254, 0.35);
  --txt:#f8fafc;
  --muted:#94a3b8;
  --cyan:#00f2fe;
  --blue:#3b82f6;
  --purple:#8b5cf6;
  --green:#10b981;
  --gold:#f59e0b;
  --danger:#ef4444;
  --shadow:0 20px 60px rgba(0, 0, 0, 0.55);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;color:var(--txt);
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  background:
    radial-gradient(circle at 5% 5%, rgba(139, 92, 246, 0.18), transparent 30%),
    radial-gradient(circle at 95% 10%, rgba(0, 242, 254, 0.14), transparent 35%),
    radial-gradient(circle at 50% 95%, rgba(16, 185, 129, 0.10), transparent 40%),
    linear-gradient(135deg, #050711 0%, #0b0f1e 50%, #04060d 100%);
  background-attachment:fixed;
  min-height:100vh;
}
body:before{
  content:"";position:fixed;inset:0;pointer-events:none;opacity:.08;z-index:0;
  background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);
  background-size:36px 36px;
}
h1,h2,h3,h4,.logo,.title{font-family:'Outfit',sans-serif}
a{color:inherit;text-decoration:none}
.wrap{display:flex;min-height:100vh;position:relative;z-index:1}

/* Sidebar */
.side{
  width:290px;position:sticky;top:0;height:100vh;overflow-y:auto;z-index:10;
  background:rgba(10, 15, 30, 0.85);backdrop-filter:blur(24px);
  border-right:1px solid var(--border);padding:20px 16px;
  box-shadow:10px 0 40px rgba(0,0,0,.4);
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent;
}
.logoBox{
  border:1px solid rgba(0,242,254,.25);border-radius:20px;padding:16px;
  background:linear-gradient(135deg, rgba(0,242,254,.12), rgba(139,92,246,.08));
  margin-bottom:14px;box-shadow:0 8px 32px rgba(0,242,254,.08);
}
.logo{font-weight:900;font-size:22px;line-height:1.1;letter-spacing:-.4px;background:linear-gradient(90deg,#fff,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:var(--muted);font-size:12px;margin-top:6px;display:flex;align-items:center;gap:6px}
.statusDot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.2)}}

.navSearch{
  width:100%;background:rgba(5,10,20,.8);border:1px solid rgba(255,255,255,.1);
  color:#fff;border-radius:12px;padding:10px 12px;margin-bottom:14px;font-size:13px;outline:none;
  transition:.2s ease;
}
.navSearch:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,242,254,.15)}

.navCat{font-size:11px;font-weight:800;letter-spacing:1px;color:rgba(255,255,255,.4);margin:16px 8px 6px;text-transform:uppercase}
.nav{display:flex;flex-direction:column;gap:3px}
.nav a{
  display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;
  color:#cbd5e1;font-size:13.5px;font-weight:600;transition:all .18s ease;
  border:1px solid transparent;
}
.nav a:hover{
  color:#fff;background:rgba(255,255,255,.06);transform:translateX(3px);
  border-color:rgba(255,255,255,.08);
}
.nav a.active{
  color:#fff;background:linear-gradient(90deg, rgba(0,242,254,.18), rgba(139,92,246,.12));
  border-color:var(--border-glow);box-shadow:0 4px 20px rgba(0,242,254,.12);
}

/* Main Content */
.main{flex:1;padding:26px 32px;max-width:1420px;margin:0 auto;width:100%;min-width:0}
.top{
  display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:22px;
  border:1px solid var(--border);border-radius:20px;padding:16px 22px;
  background:rgba(15, 23, 42, 0.65);backdrop-filter:blur(20px);box-shadow:var(--shadow)
}
.title{font-size:28px;font-weight:800;letter-spacing:-.6px}
.topRight{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{
  padding:7px 14px;border-radius:999px;background:linear-gradient(90deg,var(--green),#059669);
  color:#fff;font-weight:800;font-size:12px;letter-spacing:.5px;box-shadow:0 0 16px rgba(16,185,129,.35)
}
.miniPill{padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:#cbd5e1;font-size:12.5px;font-weight:700}

/* Cards & UI Components */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.card{
  background:var(--bg-card);border:1px solid var(--border);border-radius:20px;
  padding:20px;box-shadow:var(--shadow);backdrop-filter:blur(18px);
  position:relative;overflow:hidden;transition:all .25s ease
}
.card:hover{
  transform:translateY(-3px);border-color:var(--border-glow);
  box-shadow:0 24px 60px rgba(0,0,0,.6), 0 0 25px rgba(0,242,254,.1)
}
.card h3{margin:0 0 8px;font-size:16px;font-weight:700;color:#e2e8f0}
.stat{font-size:32px;font-weight:900;color:var(--cyan);letter-spacing:-.8px;font-family:'Outfit',sans-serif}
.muted{color:var(--muted)}
.msg{background:rgba(0,242,254,.12);border:1px solid rgba(0,242,254,.4);padding:14px 18px;border-radius:16px;margin-bottom:18px;color:#e0f7fa;font-weight:600}

/* Tables */
.tableWrap{overflow:auto;border-radius:18px;border:1px solid var(--border);box-shadow:var(--shadow)}
.table{width:100%;border-collapse:collapse;background:rgba(10,15,30,.8);overflow:hidden}
.table th,.table td{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left;vertical-align:middle}
.table th{color:#94a3b8;background:rgba(20,30,55,.85);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px}
.table tr:hover td{background:rgba(0,242,254,.04)}

/* Buttons & Inputs */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;
  padding:10px 16px;margin:3px;background:linear-gradient(90deg,var(--cyan),var(--blue));
  color:#040914;font-weight:800;cursor:pointer;box-shadow:0 8px 24px rgba(0,242,254,.25);
  transition:all .2s ease;font-size:13.5px;font-family:'Inter',sans-serif
}
.btn:hover{transform:translateY(-2px);filter:brightness(1.1);box-shadow:0 12px 32px rgba(0,242,254,.35)}
.btn.secondary{background:rgba(30,41,59,.9);color:#e2e8f0;border:1px solid rgba(255,255,255,.1);box-shadow:none}
.btn.secondary:hover{background:rgba(51,65,85,1);border-color:rgba(255,255,255,.2)}
.btn.danger{background:linear-gradient(90deg,#ef4444,#dc2626);color:#fff;box-shadow:0 8px 24px rgba(239,68,68,.3)}
.btn.warn{background:linear-gradient(90deg,#f59e0b,#d97706);color:#fff;box-shadow:0 8px 24px rgba(245,158,11,.3)}

input,textarea,select{
  width:100%;background:rgba(5,10,24,.9);border:1px solid rgba(255,255,255,.12);color:#fff;
  border-radius:14px;padding:12px 14px;margin:6px 0 14px;font-size:14px;outline:none;
  font-family:'Inter',sans-serif;transition:all .2s ease
}
input:focus,textarea:focus,select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,242,254,.15)}
textarea{min-height:110px;resize:vertical}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.small{font-size:12px}.actions form{display:inline}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.1);padding:4px 8px;border-radius:8px;font-size:12.5px;color:var(--cyan)}
.quick{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.section{margin-top:20px}
.two{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}
.badge{font-weight:800;color:var(--cyan)}

.heroPanel{
  padding:24px;border-radius:24px;border:1px solid var(--border-glow);
  background:linear-gradient(135deg, rgba(0,242,254,.12), rgba(139,92,246,.10), rgba(16,185,129,.08));
  box-shadow:var(--shadow);margin-bottom:20px
}
.heroPanel h2{margin:0 0 8px;font-size:26px;font-weight:900}
.kpiLine{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.kpiLine span{padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid var(--border);font-weight:700;font-size:13px;color:#e2e8f0}

@media(max-width:980px){
  .wrap{display:block}
  .side{position:relative;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--border)}
  .main{padding:16px}
  .top{display:block}
  .topRight{margin-top:12px}
  .two{grid-template-columns:1fr}
  .title{font-size:22px}
}
</style>
<script>
function filterSideNav() {
  const q = document.getElementById('sideNavSearch').value.toLowerCase();
  const links = document.querySelectorAll('.nav a');
  links.forEach(a => {
    const text = a.textContent.toLowerCase();
    a.style.display = text.includes(q) ? 'flex' : 'none';
  });
}
</script>
</head>
<body>
<div class="wrap">
<aside class="side">
  <div class="logoBox">
    <div class="logo">⚡ ${webEsc(getStoreName())}</div>
    <div class="sub"><span class="statusDot"></span> 24/7 LIVE · @${webEsc(getBotUsername() || botUsername || 'bot')}</div>
  </div>
  <input type="text" id="sideNavSearch" class="navSearch" placeholder="🔍 Search menu..." oninput="filterSideNav()" />
  
  <div class="nav">
    <div class="navCat">🚀 Overview</div>
    <a href="/admin-web/dashboard">📊 Dashboard</a>
    <a href="/admin-web/easy-manage">🧰 Easy Manage</a>
    <a href="/admin-web/system">🖥 System Health</a>
    <a href="/admin-web/reports">📈 Reports</a>
    <a href="/admin-web/business-summary">🧾 Business Summary</a>

    <div class="navCat">📦 Inventory & Stock</div>
    <a href="/admin-web/products">🛠 Products</a>
    <a href="/admin-web/products/new">➕ Add Product</a>
    <a href="/admin-web/stock-manager">📥 Stock Manager</a>
    <a href="/admin-web/data-helper">🧩 Bulk Data Helper</a>
    <a href="/admin-web/stock-tools">🧹 Stock Tools</a>
    <a href="/admin-web/description-generator">✨ AI Description</a>
    <a href="/admin-web/inventory-valuation">🏷 Inventory Valuation</a>

    <div class="navCat">👥 Sales & Customers</div>
    <a href="/admin-web/users">👥 Users & Balance</a>
    <a href="/admin-web/orders">🧾 Orders</a>
    <a href="/admin-web/manual-delivery">🚚 Manual Delivery</a>
    <a href="/admin-web/tickets">🎫 Support Tickets</a>
    <a href="/admin-web/restock">🔔 Restock Requests</a>
    <a href="/admin-web/insights">👑 Customer Insights</a>
    <a href="/admin-web/message-user">📩 Message User</a>
    <a href="/admin-web/blacklist">🚫 Blacklist</a>

    <div class="navCat">💳 Payments & Gateways</div>
    <a href="/admin-web/payments">💳 Payments</a>
    <a href="/admin-web/methods">💳 Payment Methods</a>
    <a href="/admin-web/auto-verify">🤖 Auto Verify</a>
    <a href="/admin-web/delivery-repair">🚑 Delivery Repair</a>
    <a href="/admin-web/payment-risk">🚨 Payment Risk</a>
    <a href="/admin-web/coupons">🎟 Coupons</a>

    <div class="navCat">📢 Marketing & Community</div>
    <a href="/admin-web/freebies">🎁 Freebies & Daily Rewards</a>
    <a href="/admin-web/flash-sales">⚡ Flash Sales</a>
    <a href="/admin-web/announce">📣 Announce</a>
    <a href="/admin-web/channels">📢 Channels</a>
    <a href="/admin-web/groups">👥 Group Alerts</a>
    <a href="/admin-web/marketing-kit">📣 Marketing Kit</a>
    <a href="/admin-web/campaigns">📣 Campaign Center</a>
    <a href="/admin-web/custom-message">✍️ Custom Message</a>
    <a href="/admin-web/custom-emojis">🧩 Custom Emojis</a>
    <a href="/admin-web/reviews">⭐ Reviews</a>

    <div class="navCat">⚙️ System & Settings</div>
    <a href="/admin-web/settings">⚙️ Bot Settings</a>
    <a href="/admin-web/admins">👑 Admin Manager</a>
    <a href="/admin-web/team-access">🔐 Team Access</a>
    <a href="/admin-web/security">🛡 Security Center</a>
    <a href="/admin-web/quick-find">🔎 Quick Find</a>
    <a href="/admin-web/profit-analytics">📈 Profit Analytics</a>
    <a href="/admin-web/audit">🛡 Audit Logs</a>
    <a href="/admin-web/backups">💾 Backups</a>
    <a href="/admin-web/export">⬇️ Export Data</a>
    <a href="/admin-web/logout">🚪 Logout</a>
  </div>
</aside>
<main class="main">
  <div class="top">
    <div>
      <div class="title">${webEsc(title)}</div>
      <div class="muted small">Manage bot products, stock, users, payments and reports in real time.</div>
    </div>
    <div class="topRight">
      <span class="miniPill">🤖 @${webEsc(getBotUsername() || botUsername || 'bot')}</span>
      <span class="pill">24/7 ONLINE</span>
    </div>
  </div>
  ${msg ? `<div class="msg">${webEsc(msg)}</div>` : ''}
  ${body}
</main>
</div>
</body>
</html>`;
}

function loginPage(msg = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login - ${webEsc(getStoreName())}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  background:radial-gradient(circle at 10% 10%, rgba(139,92,246,.22), transparent 30%),
             radial-gradient(circle at 90% 90%, rgba(0,242,254,.18), transparent 35%),
             linear-gradient(135deg, #050711, #0a0e1e 50%, #04060d);
  font-family:'Inter',system-ui,sans-serif;color:#f8fafc;
}
.box{
  width:100%;max-width:440px;background:rgba(15, 23, 42, 0.8);backdrop-filter:blur(24px);
  border:1px solid rgba(255, 255, 255, 0.1);border-radius:28px;padding:34px;
  box-shadow:0 30px 90px rgba(0, 0, 0, 0.6);
}
.logo{
  width:64px;height:64px;border-radius:20px;
  background:linear-gradient(135deg, #00f2fe, #7f00ff);
  display:grid;place-items:center;font-size:32px;margin-bottom:20px;
  box-shadow:0 10px 30px rgba(0,242,254,.3);
}
h1{margin:0 0 8px;font-family:'Outfit',sans-serif;font-size:30px;font-weight:900;letter-spacing:-.6px}
p{color:#94a3b8;font-size:14px;line-height:1.5;margin-top:0}
label{font-weight:700;color:#e2e8f0;font-size:13.5px}
input{
  width:100%;background:rgba(5, 10, 24, 0.9);border:1px solid rgba(255, 255, 255, 0.12);
  color:#fff;border-radius:14px;padding:14px;margin:8px 0 18px;font-size:15px;outline:none;
  transition:all .2s ease
}
input:focus{border-color:#00f2fe;box-shadow:0 0 0 3px rgba(0,242,254,.15)}
.btn{
  width:100%;border:0;border-radius:14px;padding:15px;
  background:linear-gradient(90deg, #00f2fe, #4facfe);
  font-weight:900;color:#040914;font-size:16px;cursor:pointer;
  box-shadow:0 10px 30px rgba(0,242,254,.3);transition:all .2s ease;
  font-family:'Outfit',sans-serif
}
.btn:hover{transform:translateY(-2px);filter:brightness(1.1)}
.msg{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);color:#fca5a5;padding:12px 14px;border-radius:14px;margin:14px 0;font-size:14px;font-weight:600}
.foot{font-size:12px;color:#64748b;margin-top:18px;text-align:center}
</style>
</head>
<body>
<div class="box">
  <div class="logo">⚡</div>
  <h1>Secure Web Admin</h1>
  <p>${webEsc(getStoreName())} Control Center · Complete store & bot management.</p>
  ${msg ? `<div class="msg">${webEsc(msg)}</div>` : ''}
  <form method="post" action="/admin-web/login">
    <label>Admin Username</label>
    <input name="username" autocomplete="username" required placeholder="admin">
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password" required placeholder="Enter secure password">
    <button class="btn">Login Securely →</button>
  </form>
  <p class="foot">Default login: <b>admin</b> / <b>admin123</b> — change in Settings after login.</p>
</div>
</body>
</html>`;
}

function productRows(products) {
  return products.map((p) => `<tr><td><b>${webEsc(p.code)}</b><br><span class="muted">${p.active === false ? 'Hidden' : 'Active'} ${p.pinned ? '· Pinned' : ''}</span></td><td>${webEsc(productLogo(p))} <b>${webEsc(p.name)}</b><br><span class="muted">${webEsc(short((p.description || '').replace(/\n/g,' '), 80))}</span></td><td>${webMoney(p.price)}${activeFlashSale(p) ? '<br><span class="muted">Sale ' + webMoney(activeFlashSale(p).price) + '</span>' : ''}</td><td>${normalizeBulkPrices(p).length ? normalizeBulkPrices(p).length + ' tier(s)' : '-'}</td><td>${webEsc(cleanCategory(p.category || 'General'))}<br><span class="muted">${webEsc(tagString(p))}</span></td><td>${webEsc(stockFormatName(p.stockFormat || 'redeem_link'))}</td><td>${p.stock?.length || 0}</td><td class="actions"><a class="btn" href="/admin-web/products/${encodeURIComponent(p.code)}">Manage</a><form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/clone"><button class="btn secondary">Clone</button></form></td></tr>`).join('');
}


function user360Stats(uid) {
  uid = String(uid);
  const user = db.users[uid] || {};
  const orders = db.orders.filter(o => String(o.telegramId) === uid);
  const payments = db.payments.filter(p => String(p.telegramId) === uid);
  const deposits = (db.deposits || []).filter(d => String(d.telegramId) === uid);
  const tickets = (db.supportTickets || []).filter(t => String(t.telegramId) === uid);
  const reviews = (db.reviews || []).filter(r => String(r.telegramId) === uid);
  const restock = (db.restockRequests || []).filter(r => String(r.telegramId) === uid);
  const spent = orders.reduce((a,o)=>a+Number(o.total||0),0);
  const qty = orders.reduce((a,o)=>a+Number(o.qty||0),0);
  return { user, orders, payments, deposits, tickets, reviews, restock, spent, qty };
}

function stockStatsForProduct(p) {
  const stock = (p.stock || []).map(x => String(x || '').trim()).filter(Boolean);
  const seen = new Set();
  let duplicates = 0;
  for (const item of stock) {
    const key = item.toLowerCase();
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return { total: stock.length, unique: seen.size, duplicates, empty: (p.stock || []).length - stock.length };
}

function stockAuditSummary() {
  const products = db.products || [];
  const totalStock = products.reduce((a,p)=>a+(p.stock?.length||0),0);
  const duplicateProducts = products.filter(p => stockStatsForProduct(p).duplicates > 0);
  const duplicateCount = duplicateProducts.reduce((a,p)=>a+stockStatsForProduct(p).duplicates,0);
  const emptyStock = products.filter(p => !p.stock?.length).length;
  const lowStock = products.filter(p => p.active !== false && (p.stock?.length || 0) <= Number(db.settings.lowStockThreshold || 2)).length;
  return { totalStock, duplicateProducts, duplicateCount, emptyStock, lowStock };
}

function dedupeProductStock(p) {
  const before = (p.stock || []).length;
  const seen = new Set();
  const cleaned = [];
  for (const item of (p.stock || [])) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(item);
  }
  p.stock = cleaned;
  const removed = before - cleaned.length;
  if (removed) saveData();
  return removed;
}

function backupDirPath() {
  const dir = path.join(__dirname, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeBackupName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_.-]/g, '');
}

function createDataBackup(label = 'manual') {
  const dir = backupDirPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `data-${label}-${stamp}.json`;
  const out = path.join(dir, file);
  fs.copyFileSync(DATA_FILE, out);
  return { file, path: out, size: fs.statSync(out).size, createdAt: now() };
}

function listDataBackups() {
  const dir = backupDirPath();
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { file: f, size: st.size, createdAt: st.mtime };
    })
    .sort((a,b)=>b.createdAt-a.createdAt);
}

function bytesHuman(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return Math.round(n/1024) + ' KB';
  return (n/(1024*1024)).toFixed(2) + ' MB';
}

function autoBackup(label = 'auto') {
  try {
    const backups = listDataBackups();
    const last = backups[0];
    if (!last || Date.now() - new Date(last.createdAt).getTime() > 30 * 60 * 1000) {
      return createDataBackup(label);
    }
  } catch (_) {}
  return null;
}



function ordersInLastDays(days = 1) {
  const from = Date.now() - Number(days || 1) * 24 * 60 * 60 * 1000;
  return (db.orders || []).filter(o => {
    const t = Date.parse(o.createdAt || 0);
    return Number.isFinite(t) && t >= from;
  });
}

function paymentsInLastDays(days = 1) {
  const from = Date.now() - Number(days || 1) * 24 * 60 * 60 * 1000;
  return (db.payments || []).filter(p => {
    const t = Date.parse(p.createdAt || 0);
    return Number.isFinite(t) && t >= from;
  });
}

function businessSummary(days = 1) {
  const orders = ordersInLastDays(days);
  const payments = paymentsInLastDays(days);
  const revenue = orders.reduce((a,o)=>a+Number(o.total||0),0);
  const qty = orders.reduce((a,o)=>a+Number(o.qty||0),0);
  const profit = profitSummary(orders);
  const buyers = new Set(orders.map(o => String(o.telegramId))).size;
  const pending = payments.filter(p => ['pending','review'].includes(String(p.status||'').toLowerCase())).length;
  const approved = payments.filter(p => p.status === 'approved').length;
  const topMap = {};
  orders.forEach(o => {
    topMap[o.productCode] ||= { code: o.productCode, name: o.productName, qty: 0, revenue: 0 };
    topMap[o.productCode].qty += Number(o.qty || 0);
    topMap[o.productCode].revenue += Number(o.total || 0);
  });
  const topProducts = Object.values(topMap).sort((a,b)=>b.revenue-a.revenue);
  return { days, orders, payments, revenue, qty, profit, buyers, pending, approved, topProducts };
}

function businessSummaryText(days = 1) {
  const s = businessSummary(days);
  let out = `📊 <b>Business Summary (${days} Day${days > 1 ? 's' : ''})</b>\n\n`;
  out += `🧾 Orders: <b>${s.orders.length}</b>\n`;
  out += `📦 Items Sold: <b>${s.qty}</b>\n`;
  out += `👥 Buyers: <b>${s.buyers}</b>\n`;
  out += `💰 Revenue: <b>${money(s.revenue)}</b>\n`;
  out += `📈 Profit: <b>${money(s.profit.profit)}</b>\n`;
  out += `⏳ Pending/Review Payments: <b>${s.pending}</b>\n`;
  out += `✅ Approved Payments: <b>${s.approved}</b>\n\n`;
  if (s.topProducts.length) {
    out += `<b>Top Products:</b>\n`;
    s.topProducts.slice(0, 8).forEach((p, i) => {
      out += `${i + 1}. ${escapeHtml(p.name)}\nQty: ${p.qty} | Revenue: <b>${money(p.revenue)}</b>\n`;
    });
  } else {
    out += 'No sales in this period.';
  }
  return out;
}

function inventoryValuation() {
  const rows = (db.products || []).map(p => {
    const stock = Number((p.stock || []).length);
    const price = Number(getProductPrice(p, '') || p.price || 0);
    const cost = Number(p.costPrice || 0);
    const retailValue = stock * price;
    const costValue = stock * cost;
    const potentialProfit = retailValue - costValue;
    return {
      code: p.code,
      name: p.name,
      category: cleanCategory(p.category || 'General'),
      stock,
      price,
      cost,
      retailValue,
      costValue,
      potentialProfit,
      active: p.active !== false
    };
  }).sort((a,b)=>b.retailValue-a.retailValue);

  const totalStock = rows.reduce((a,r)=>a+r.stock,0);
  const retailValue = rows.reduce((a,r)=>a+r.retailValue,0);
  const costValue = rows.reduce((a,r)=>a+r.costValue,0);
  const potentialProfit = retailValue - costValue;
  const zeroStock = rows.filter(r => r.stock === 0).length;
  const lowStock = rows.filter(r => r.active && r.stock <= Number(db.settings.lowStockThreshold || 2)).length;
  return { rows, totalStock, retailValue, costValue, potentialProfit, zeroStock, lowStock };
}

function inventoryValuationText() {
  const s = inventoryValuation();
  let out = `🏷 <b>Inventory Valuation</b>\n\n`;
  out += `📦 Total Stock: <b>${s.totalStock}</b>\n`;
  out += `💰 Retail Value: <b>${money(s.retailValue)}</b>\n`;
  out += `🧾 Cost Value: <b>${money(s.costValue)}</b>\n`;
  out += `📈 Potential Profit: <b>${money(s.potentialProfit)}</b>\n`;
  out += `⚠️ Low Stock Products: <b>${s.lowStock}</b>\n`;
  out += `⛔ Zero Stock Products: <b>${s.zeroStock}</b>\n\n`;
  out += `<b>Top Inventory Value:</b>\n`;
  s.rows.slice(0, 10).forEach((r, i) => {
    out += `${i + 1}. ${escapeHtml(r.name)}\nStock: ${r.stock} | Value: <b>${money(r.retailValue)}</b>\n`;
  });
  return out;
}

function pruneOldBackups(maxFiles = 30) {
  const backups = listDataBackups();
  const max = Math.max(3, Number(maxFiles || 30));
  const toDelete = backups.slice(max);
  let deleted = 0;
  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(backupDirPath(), b.file));
      deleted++;
    } catch (_) {}
  }
  return deleted;
}

let autoBackupStarted = false;
function startScheduledBackups() {
  if (autoBackupStarted) return;
  autoBackupStarted = true;
  if (db.settings.autoBackupEnabled === false) return;
  const hours = Math.max(1, Number(db.settings.autoBackupIntervalHours || 6));
  const run = () => {
    try {
      const b = autoBackup('scheduled');
      const deleted = pruneOldBackups(db.settings.autoBackupMaxFiles || 30);
      if (b) {
        console.log(`💾 Scheduled backup created: ${b.file}`);
        addSecurityLog('scheduled_backup_created', 'system', { file: b.file, deleted }, 'info');
      }
    } catch (err) {
      console.error('Scheduled backup failed:', err.message);
      addSecurityLog('scheduled_backup_failed', 'system', { error: err.message }, 'warn');
    }
  };
  setInterval(run, hours * 60 * 60 * 1000);
  setTimeout(run, 12000);
}

function backupStatusText() {
  const backups = listDataBackups();
  const last = backups[0];
  return `💾 <b>Backup Status</b>\n\nAuto Backup: <b>${db.settings.autoBackupEnabled === false ? 'OFF' : 'ON'}</b>\nInterval: <b>${db.settings.autoBackupIntervalHours || 6}h</b>\nMax Files: <b>${db.settings.autoBackupMaxFiles || 30}</b>\nAvailable Backups: <b>${backups.length}</b>\nLast Backup: <b>${last ? escapeHtml(new Date(last.createdAt).toLocaleString()) : '-'}</b>`;
}

function backupAdminButtons() {
  return inline([
    [{ text: '💾 Create Backup Now', callback_data: 'backup_create_now' }],
    [{ text: db.settings.autoBackupEnabled === false ? '✅ Turn Auto Backup ON' : '⛔ Turn Auto Backup OFF', callback_data: 'backup_toggle_auto' }],
    [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
  ]);
}


function getWebStats() {
  const active = db.products.filter((p) => p.active !== false);
  const hidden = db.products.filter((p) => p.active === false);
  const stock = active.reduce((a, p) => a + (p.stock?.length || 0), 0);
  const low = active.filter((p) => (p.stock?.length || 0) <= Number(db.settings.lowStockThreshold || 2)).length;
  const revenue = db.orders.filter((o) => o.status === 'paid').reduce((a, o) => a + Number(o.total || 0), 0);
  const deposits = (db.deposits || []).reduce((a, d) => a + Number(d.amount || 0), 0);
  return { active, hidden, stock, low, revenue, deposits };
}

async function webApprovePayment(payment) {
  return approveAndDeliverPayment(payment, { approvedBy: 'web-admin', method: 'Web Admin Approved' });
}



async function webRejectPayment(payment) {
  if (!payment) throw new Error('Payment not found');
  payment.status = 'rejected';
  payment.rejectedAt = now();
  saveData();
  try { await sendMessage(payment.telegramId, `❌ <b>Payment Rejected</b>\n\nPayment ID: <code>${escapeHtml(payment.id)}</code>\nPlease contact support if this is a mistake.`, homeButtons(payment.telegramId)); } catch (_) {}
  return 'Payment rejected';
}

app.get('/', (_, res) => res.send(`${getStoreName()} bot running ✅<br><a href="/admin-web">Open Web Admin</a>`));
app.get('/health', (_, res) => res.json({
  ok: runtimeHealthSnapshot().ok,
  mode: IS_VERCEL ? 'vercel-serverless-24-7' : 'local-polling',
  mongoPersistence: Boolean(MONGODB_URI),
  mongoConnected: Boolean(mongoCol),
  bot: getStoreName(),
  username: getBotUsername() || botUsername,
  featureVersion: db.settings.featureVersion || '',
  health: runtimeHealthSnapshot()
}));

app.get('/admin-web/login', (req, res) => {
  res.send(loginPage(req.query.msg || ''));
});

app.post('/admin-web/login', (req, res) => {
  const login = String(req.body.username || '').trim();
  const pass = String(req.body.password || '');
  let auth = null;

  const currentWebUser = getAdminWebUser();
  const currentWebPass = getAdminWebPassword();
  if (currentWebPass && login === currentWebUser && pass === currentWebPass) {
    auth = { username: currentWebUser, id: getAdminId(), role: 'owner', permissions: ['all'], source: 'env' };
  } else {
    const admin = findAdminByLogin(login);
    if (admin && admin.active !== false && admin.webPasswordHash && verifyWebPassword(admin.webPasswordHash, pass)) {
      admin.webLastLoginAt = now();
      auth = { username: admin.username || admin.id, id: String(admin.id), role: admin.role || 'viewer', permissions: normalizePermissionList(admin.permissions || []), source: 'team' };
      saveData();
    }
  }

  if (!auth) {
    addWebAudit('login_failed', { username: login }, req);
    return res.send(loginPage('Invalid admin ID/username or password.'));
  }

  const sid = makeWebSession();
  webSessions.set(sid, { ...auth, createdAt: Date.now(), expiresAt: Date.now() + WEB_SESSION_HOURS * 3600 * 1000 });
  setSessionCookie(res, sid);
  addWebAudit('login_success', { username: auth.username, id: auth.id, role: auth.role, source: auth.source }, req);
  res.redirect('/admin-web/dashboard');
});

app.get('/admin-web/logout', (req, res) => {
  const session = getWebSession(req);
  if (session) webSessions.delete(session.sid);
  addWebAudit('logout', { username: session?.username || '' }, req);
  clearSessionCookie(res);
  res.redirect('/admin-web/login?msg=Logged%20out');
});

app.use('/admin-web', requireWebAuth, requireWebAccess);

app.get('/admin-web', (_, res) => res.redirect('/admin-web/dashboard'));


app.get('/admin-web/easy-manage', (req, res) => {
  const s = manageStats();
  const lowRows = s.low.slice(0, 50).map(p => `<tr><td><b>${webEsc(p.name)}</b><br><span class="code">${webEsc(p.code)}</span></td><td>${(p.stock||[]).length}</td><td>${webMoney(p.price)}</td><td><a class="btn secondary" href="/admin-web/products/${encodeURIComponent(p.code)}">Manage</a></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🧰 Easy Manage Center</h2><div class="muted">One page for daily management: stock, payments, backups, notes, maintenance and price changes.</div><div class="kpiLine"><span>${s.active.length} active products</span><span>${s.oos.length} out of stock</span><span>${s.waiting.length} paid waiting</span><span>${s.pending.length} pending payments</span><span>${s.notes.length} notes</span></div></div>
  ${easyManageWebCards()}<br>
  <div class="two">
    <div class="card"><h3>⚡ Quick Actions</h3>
      <a class="btn" href="/admin-web/data-helper">🧩 Bulk Data Helper</a>
      <form method="post" action="/admin-web/easy-manage/hide-oos"><button class="btn">Hide Out-of-Stock Products</button></form>
      <form method="post" action="/admin-web/easy-manage/restore-all"><button class="btn secondary">Restore All Hidden Products</button></form>
      <form method="post" action="/admin-web/easy-manage/process-stockwait"><button class="btn">Process Paid Stock Wait Queue</button></form>
      <form method="post" action="/admin-web/easy-manage/expire-payments"><button class="btn secondary">Expire Old Pending Payments</button></form>
      <form method="post" action="/admin-web/easy-manage/backup"><button class="btn">Create Backup Now</button></form>
      <form method="post" action="/admin-web/easy-manage/maintenance"><button class="btn ${db.settings.maintenanceMode ? 'danger' : ''}">${db.settings.maintenanceMode ? 'Turn Maintenance OFF' : 'Turn Maintenance ON'}</button></form>
    </div>
    <div class="card"><h3>💵 Bulk Price + Threshold</h3>
      <form method="post" action="/admin-web/easy-manage/bulk-price"><label>Bulk update active product prices by %</label><input name="percent" type="number" step="0.01" placeholder="10 or -15" required><button class="btn">Apply Price Change</button><p class="muted small">Example: 10 increases active product prices by 10%, -15 decreases by 15%.</p></form>
      <form method="post" action="/admin-web/easy-manage/low-threshold"><label>Low-stock threshold</label><input name="threshold" type="number" value="${webEsc(db.settings.lowStockThreshold || 2)}"><button class="btn secondary">Save Threshold</button></form>
      <form method="post" action="/admin-web/easy-manage/clean-logs"><button class="btn secondary">Clean Old Logs</button></form>
    </div>
  </div><br>
  <div class="two">
    <div class="card"><h3>📝 Add Admin Note / Task</h3><form method="post" action="/admin-web/easy-manage/notes"><textarea name="text" placeholder="Write task/note for team..." required></textarea><button class="btn">Add Note</button></form></div>
    <div class="card"><h3>📤 Quick Export</h3><a class="btn" href="/admin-web/export/users.csv">Export Users CSV</a><a class="btn secondary" href="/admin-web/export/orders.csv">Export Orders CSV</a><a class="btn secondary" href="/admin-web/export/payments.csv">Export Payments CSV</a></div>
  </div><br>
  <div class="tableWrap"><h3>⚠️ Low Stock Products</h3><table class="table"><thead><tr><th>Product</th><th>Stock</th><th>Price</th><th>Action</th></tr></thead><tbody>${lowRows || '<tr><td colspan="4">No low-stock products.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>📝 Notes / Tasks</h3><table class="table"><thead><tr><th>Status</th><th>Note</th><th>By</th><th>Created</th><th>Action</th></tr></thead><tbody>${webNotesRows() || '<tr><td colspan="5">No notes.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Easy Manage', body, req.query.msg));
});

app.post('/admin-web/easy-manage/hide-oos', (req, res) => {
  const n = hideOutOfStockProducts();
  addWebAudit('easy_hide_oos', { hidden: n }, req);
  redirectMsg(res, '/admin-web/easy-manage', `Hidden ${n} out-of-stock product(s)`);
});

app.post('/admin-web/easy-manage/restore-all', (req, res) => {
  const n = restoreAllProducts();
  addWebAudit('easy_restore_all', { restored: n }, req);
  redirectMsg(res, '/admin-web/easy-manage', `Restored ${n} product(s)`);
});

app.post('/admin-web/easy-manage/process-stockwait', async (req, res) => {
  const r = await processStockWaitQueue('', 'easy-web');
  addWebAudit('easy_stockwait_process', r, req);
  redirectMsg(res, '/admin-web/easy-manage', `Stock wait processed: ${r.ok} delivered, ${r.skipped} skipped, ${r.fail} failed`);
});

app.post('/admin-web/easy-manage/expire-payments', async (req, res) => {
  const r = await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
  addWebAudit('easy_expire_payments', r, req);
  redirectMsg(res, '/admin-web/easy-manage', `Expired ${r.count} pending payment(s), notified ${r.notified}`);
});

app.post('/admin-web/easy-manage/backup', (req, res) => {
  const b = createDataBackup('easy-web');
  addWebAudit('easy_backup', { file: b.file, size: b.size }, req);
  redirectMsg(res, '/admin-web/easy-manage', `Backup created: ${b.file}`);
});

app.post('/admin-web/easy-manage/maintenance', (req, res) => {
  db.settings.maintenanceMode = !db.settings.maintenanceMode;
  saveData();
  addWebAudit('easy_maintenance_toggle', { maintenanceMode: db.settings.maintenanceMode }, req);
  redirectMsg(res, '/admin-web/easy-manage', `Maintenance mode ${db.settings.maintenanceMode ? 'ON' : 'OFF'}`);
});

app.post('/admin-web/easy-manage/bulk-price', (req, res) => {
  const pct = Number(req.body.percent || 0);
  if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 90) return redirectMsg(res, '/admin-web/easy-manage', 'Invalid percentage. Use -90 to 90.');
  const r = bulkPriceUpdate(pct, true);
  addWebAudit('easy_bulk_price', r, req);
  redirectMsg(res, '/admin-web/easy-manage', `Updated ${r.count} active products by ${r.pct}%`);
});

app.post('/admin-web/easy-manage/low-threshold', (req, res) => {
  db.settings.lowStockThreshold = Math.max(0, Number(req.body.threshold || 2));
  saveData();
  addWebAudit('easy_low_threshold', { threshold: db.settings.lowStockThreshold }, req);
  redirectMsg(res, '/admin-web/easy-manage', `Low-stock threshold saved: ${db.settings.lowStockThreshold}`);
});

app.post('/admin-web/easy-manage/clean-logs', (req, res) => {
  const r = cleanOldLogs(300);
  addWebAudit('easy_clean_logs', r, req);
  redirectMsg(res, '/admin-web/easy-manage', 'Old logs cleaned');
});

app.post('/admin-web/easy-manage/notes', (req, res) => {
  const n = addAdminNote(req.body.text, req.webAdmin?.username || req.webAdmin?.id || 'web');
  addWebAudit('easy_note_add', { id: n?.id }, req);
  redirectMsg(res, '/admin-web/easy-manage', n ? 'Note added' : 'Empty note');
});

app.post('/admin-web/easy-manage/notes/:id/toggle', (req, res) => {
  const n = (db.adminNotes || []).find(x => x.id === req.params.id);
  if (n) { n.done = !n.done; n.doneAt = n.done ? now() : ''; saveData(); }
  redirectMsg(res, '/admin-web/easy-manage', 'Note updated');
});

app.post('/admin-web/easy-manage/notes/:id/delete', (req, res) => {
  db.adminNotes = (db.adminNotes || []).filter(x => x.id !== req.params.id);
  saveData();
  redirectMsg(res, '/admin-web/easy-manage', 'Note deleted');
});

// =====================
// FREEBIE & REWARDS CONTROL
// =====================
app.get('/admin-web/freebies', (req, res) => {
  const enabled = db.settings.freebieEnabled !== false;
  const amount = Number(db.settings.freebieAmount || 5);
  const cooldown = Number(db.settings.freebieCooldownHours || 24);

  const usersList = Object.values(db.users || {});
  const totalClaims = usersList.reduce((acc, u) => acc + (Number(u.totalFreebiesClaimed) || 0), 0);
  const totalEarnings = usersList.reduce((acc, u) => acc + (Number(u.freebieEarnings) || 0), 0);
  const activeClaimers = usersList.filter(u => (u.totalFreebiesClaimed || 0) > 0).length;

  const topClaimers = usersList
    .filter(u => (u.totalFreebiesClaimed || 0) > 0)
    .sort((a, b) => (b.totalFreebiesClaimed || 0) - (a.totalFreebiesClaimed || 0))
    .slice(0, 30)
    .map(u => `<tr>
      <td><b>${webEsc(u.firstName || 'User')}</b><br><span class="code">${webEsc(u.telegramId)}</span></td>
      <td><span class="badge">🎁 ${u.totalFreebiesClaimed || 0}</span></td>
      <td><b>${webMoney(u.freebieEarnings || 0)}</b></td>
      <td>${u.lastFreebieClaim ? new Date(u.lastFreebieClaim).toLocaleString() : '-'}</td>
      <td>
        <form method="post" action="/admin-web/freebies/reset/${encodeURIComponent(u.telegramId)}">
          <button class="btn secondary small">Reset Timer</button>
        </form>
      </td>
    </tr>`).join('');

  const body = `<div class="heroPanel">
    <h2>🎁 Freebie & Daily Rewards Center</h2>
    <div class="muted">Control freebie rewards, daily bonus credit, claim timers, and view claim statistics.</div>
    <div class="kpiLine">
      <span>Status: ${enabled ? '✅ Active' : '⛔ Offline'}</span>
      <span>Daily Bonus: ${webMoney(amount)}</span>
      <span>Cooldown: ${cooldown} Hours</span>
      <span>Total Claims: ${totalClaims}</span>
      <span>Total Distributed: ${webMoney(totalEarnings)}</span>
    </div>
  </div>

  <div class="two">
    <div class="card">
      <h3>⚙️ Freebie Settings</h3>
      <form method="post" action="/admin-web/freebies/settings">
        <label><b>Freebie System Status</b></label>
        <select name="enabled">
          <option value="true" ${enabled ? 'selected' : ''}>✅ Enabled (Users can claim daily rewards)</option>
          <option value="false" ${!enabled ? 'selected' : ''}>⛔ Disabled (Freebies offline)</option>
        </select>
        
        <label><b>Daily Reward Amount (${webEsc(currency())})</b></label>
        <input name="amount" type="number" step="0.01" value="${amount}" placeholder="5.00" required />
        <p class="muted small">This bonus credit is added directly to user's wallet balance when claimed.</p>

        <label><b>Claim Cooldown (Hours)</b></label>
        <input name="cooldown" type="number" min="1" max="720" value="${cooldown}" placeholder="24" required />
        <p class="muted small">Default: 24 hours (once per day).</p>

        <button class="btn">Save Freebie Settings</button>
      </form>
    </div>

    <div class="card">
      <h3>📊 Freebie Overview Stats</h3>
      <div class="stat">${totalClaims}</div>
      <div class="muted">Total Freebies Claimed</div>
      <br>
      <div class="stat" style="color:var(--green);">${webMoney(totalEarnings)}</div>
      <div class="muted">Total Bonus Given to Users</div>
      <br>
      <div class="stat" style="color:var(--purple);">${activeClaimers}</div>
      <div class="muted">Active Claimers</div>
    </div>
  </div><br>

  <div class="tableWrap">
    <h3>🏆 Top Freebie Claimers</h3>
    <table class="table">
      <thead>
        <tr>
          <th>User</th>
          <th>Claims</th>
          <th>Total Earned</th>
          <th>Last Claimed</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${topClaimers || '<tr><td colspan="5">No freebie claims yet. Users can claim from the bot menu!</td></tr>'}
      </tbody>
    </table>
  </div>`;

  res.send(adminLayout('Freebies & Daily Rewards', body, req.query.msg));
});

app.post('/admin-web/freebies/settings', (req, res) => {
  db.settings.freebieEnabled = req.body.enabled === 'true';
  const amt = Number(req.body.amount);
  if (Number.isFinite(amt) && amt >= 0) db.settings.freebieAmount = amt;
  const cd = Number(req.body.cooldown);
  if (Number.isFinite(cd) && cd > 0) db.settings.freebieCooldownHours = cd;
  saveData();
  redirectMsg(res, '/admin-web/freebies', `Freebie settings saved! Amount: ${webMoney(db.settings.freebieAmount)}, Cooldown: ${db.settings.freebieCooldownHours}h`);
});

app.post('/admin-web/freebies/reset/:uid', (req, res) => {
  const u = db.users ? db.users[req.params.uid] : null;
  if (u) {
    u.lastFreebieClaim = 0;
    saveData();
  }
  redirectMsg(res, '/admin-web/freebies', `Freebie timer reset for user ${req.params.uid}`);
});


app.get('/admin-web/dashboard', (req, res) => {
  const s = getWebStats();
  const body = `<div class="heroPanel"><h2>⚡ Ultra Control Center</h2><div class="muted">Live bot control, delivery repair, stock, payments, users, reports and automation tools.</div><div class="kpiLine"><span>👥 ${Object.keys(db.users).length} users</span><span>📦 ${db.products.length} products</span><span>🧾 ${db.orders.length} orders</span><span>🚑 ${undeliveredPayments().length} need delivery</span><span>🤖 ${paymentsForAutoScan().length} auto scan</span><span>🚨 ${paymentRiskSummary().needsTxid.length} need TXID</span><span>🛡 ${(db.securityLogs||[]).length} security logs</span><span>🔒 ${Object.keys(db.securityLocks||{}).filter(isUserSecurityLocked).length} locked</span><span>⭐ ${(db.reviews||[]).length} reviews</span><span>🧹 ${stockAuditSummary().duplicateCount} duplicate stock</span><span>👑 ${adminList().filter(a=>a.active!==false).length} admins</span><span>🗂 ${productCategories(true).length} categories</span><span>📈 ${webMoney(profitSummary().profit)} profit</span><span>🏷 ${webMoney(inventoryValuation().retailValue)} inventory</span></div></div><div class="grid">
    <div class="card"><h3>👥 Users</h3><div class="stat">${Object.keys(db.users).length}</div></div>
    <div class="card"><h3>📦 Active Products</h3><div class="stat">${s.active.length}</div><div class="muted">${s.hidden.length} hidden</div></div>
    <div class="card"><h3>📊 Total Stock</h3><div class="stat">${s.stock}</div><div class="muted">${s.low} low stock</div></div>
    <div class="card"><h3>🧾 Orders</h3><div class="stat">${db.orders.length}</div></div>
    <div class="card"><h3>⏳ Pending</h3><div class="stat">${db.payments.filter(p => p.status === 'pending' || p.status === 'review').length}</div></div>
    <div class="card"><h3>🚑 Need Delivery</h3><div class="stat">${undeliveredPayments().length}</div></div>
    <div class="card"><h3>💰 Revenue</h3><div class="stat">${webMoney(s.revenue)}</div></div>
    <div class="card"><h3>🎟 Coupons</h3><div class="stat">${(db.coupons || []).length}</div><div class="muted">${(db.coupons || []).filter(c=>c.active!==false).length} active</div></div>
    <div class="card"><h3>📣 Campaigns</h3><div class="stat">${(db.campaignLogs || []).length}</div><div class="muted">marketing alerts</div></div>
  </div>
  <div class="card section"><h3>⚡ Quick Actions</h3><div class="quick">
    <a class="btn" href="/admin-web/products/new">➕ Add Product</a>
    <a class="btn" href="/admin-web/description-generator">✨ AI Description</a>
    <a class="btn" href="/admin-web/tickets">🎫 Tickets</a>
    <a class="btn" href="/admin-web/restock">🔔 Restock</a>
    <a class="btn" href="/admin-web/reviews">⭐ Reviews</a>
    <a class="btn" href="/admin-web/marketing-kit">📣 Marketing Kit</a>
    <a class="btn" href="/admin-web/insights">👑 Insights</a>
    <a class="btn" href="/admin-web/channels">📢 Channels</a>
    <a class="btn" href="/admin-web/manual-delivery">🚚 Manual Delivery</a>
    <a class="btn" href="/admin-web/stock-manager">📥 Stock Manager</a>
    <a class="btn" href="/admin-web/stock-tools">🧹 Stock Tools</a>
    <a class="btn" href="/admin-web/admins">👑 Admin Manager</a>
    <a class="btn" href="/admin-web/campaigns">📣 Campaign Center</a>
    <a class="btn" href="/admin-web/flash-sales">⚡ Flash Sales</a>
    <a class="btn" href="/admin-web/products">🛠 Manage Products</a>
    <a class="btn" href="/admin-web/payments">💳 Review Payments</a>
    <a class="btn" href="/admin-web/auto-verify">🤖 Auto Verify</a>
    <a class="btn warn" href="/admin-web/delivery-repair">🚑 Repair Delivery</a>
    <a class="btn" href="/admin-web/users">👥 Users & Balance</a>
    <a class="btn" href="/admin-web/methods">💳 Payment Methods</a>
    <a class="btn" href="/admin-web/settings">⚙️ Settings</a>
    <a class="btn" href="/admin-web/reports">📈 Reports</a>
    <a class="btn" href="/admin-web/easy-manage">🧰 Easy Manage</a>
    <a class="btn" href="/admin-web/data-helper">🧩 Bulk Data Helper</a>
    <a class="btn" href="/admin-web/health-speed">⚡ Health & Speed</a>
    <a class="btn" href="/admin-web/stock-wait">⏳ Stock Wait</a>
    <a class="btn" href="/admin-web/safe-delivery">🚚 Safe Delivery</a>
    <a class="btn" href="/admin-web/security-scan">🛡 Security Scan</a>
    <a class="btn" href="/admin-web/telegram-diagnostics">🧪 App/Web Check</a>
    <a class="btn" href="/admin-web/custom-message">✍️ Custom Message</a>
    <a class="btn" href="/admin-web/custom-emojis">🧩 Emoji Codes</a>
    <a class="btn" href="/admin-web/business-summary">🧾 Summary</a>
    <a class="btn" href="/admin-web/inventory-valuation">🏷 Inventory Value</a>
    <a class="btn" href="/admin-web/orders">🧾 Order History</a>
    <a class="btn" href="/admin-web/security">🛡 Security Center</a>
    <a class="btn" href="/admin-web/payment-risk">🚨 Payment Risk</a>
    <a class="btn" href="/admin-web/quick-find">🔎 Quick Find</a>
    <a class="btn secondary" href="/admin-web/export">⬇️ Export Backup</a>
    <a class="btn secondary" href="/admin-web/backups">💾 Backups</a>
    <a class="btn secondary" href="/admin-web/export/users.csv">👥 Users CSV</a>
    <a class="btn secondary" href="/admin-web/export/orders.csv">🧾 Orders CSV</a>
  </div></div>
  <div class="two section">
    <div class="card"><h3>⚠️ Low Stock</h3>${s.active.filter(p => (p.stock?.length || 0) <= Number(db.settings.lowStockThreshold || 2)).slice(0,8).map(p => `<div>${webEsc(p.code)} · ${webEsc(p.name)} <b>${p.stock?.length || 0}</b> left</div>`).join('') || '<span class="muted">No low stock products.</span>'}</div>
    <div class="card"><h3>🧾 Recent Orders</h3>${db.orders.slice(-6).reverse().map(o => `<div><b>${webEsc(o.productName)}</b> · ${webMoney(o.total)}<br><span class="muted">${webEsc(o.telegramId)} · ${webEsc(o.id)}</span></div><br>`).join('') || '<span class="muted">No orders yet.</span>'}</div>
  </div>`;
  res.send(adminLayout('Dashboard', body, req.query.msg));
});


app.get('/admin-web/categories', (req, res) => {
  const cats = productCategories(true);
  const rows = cats.map(cat => {
    const products = (db.products || []).filter(p => cleanCategory(p.category || 'General').toLowerCase() === cat.toLowerCase());
    const stock = products.reduce((a,p)=>a+(p.stock?.length||0),0);
    return `<tr><td><b>${webEsc(cat)}</b></td><td>${products.length}</td><td>${stock}</td><td>${webMoney(products.reduce((a,p)=>a+Number(p.price||0),0))}</td><td><a class="btn secondary" href="/admin-web/products?category=${encodeURIComponent(cat)}">View</a></td></tr>`;
  }).join('');
  const body = `<div class="heroPanel"><h2>🗂 Categories</h2><div class="muted">Organize products into clean categories for user browsing.</div><div class="kpiLine"><span>${cats.length} categories</span><span>${db.products.length} products</span></div></div>
  <div class="card"><form method="post" action="/admin-web/categories/rename"><div class="row"><input name="oldName" placeholder="Old category"><input name="newName" placeholder="New category"></div><button class="btn">Rename Category</button></form></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Category</th><th>Products</th><th>Stock</th><th>Total Base Price</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No categories.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Categories', body, req.query.msg));
});

app.post('/admin-web/categories/rename', (req, res) => {
  const oldName = cleanCategory(req.body.oldName || '');
  const newName = cleanCategory(req.body.newName || '');
  if (!oldName || !newName) return redirectMsg(res, '/admin-web/categories', 'Old and new category required');
  let count = 0;
  for (const p of db.products || []) {
    if (cleanCategory(p.category || 'General').toLowerCase() === oldName.toLowerCase()) {
      p.category = newName;
      count++;
    }
  }
  saveData();
  addWebAudit('category_renamed', { oldName, newName, count }, req);
  redirectMsg(res, '/admin-web/categories', `Renamed ${count} product(s).`);
});

app.get('/admin-web/product-bulk-tools', (req, res) => {
  const stats = productBulkStats();
  const cats = productCategories(true).map(c => `<option value="${webEsc(c)}">${webEsc(c)}</option>`).join('');
  const body = `<div class="heroPanel"><h2>🧰 Product Bulk Tools</h2><div class="muted">Fast actions for pricing, visibility, stock and categories.</div><div class="kpiLine"><span>${stats.total} products</span><span>${stats.noStock} out-of-stock</span><span>${stats.categories} categories</span><span>${stats.costMissing} missing cost</span></div></div>
  <div class="grid">
    <div class="card"><h3>💵 Bulk Price Update</h3><form method="post" action="/admin-web/product-bulk-tools/price"><label>Percent Change</label><input name="percent" type="number" step="0.01" placeholder="10 or -10" required><label>Category optional</label><select name="category"><option value="">All Products</option>${cats}</select><button class="btn">Apply Price Change</button></form></div>
    <div class="card"><h3>🙈 Visibility</h3><form method="post" action="/admin-web/product-bulk-tools/hide-oos"><button class="btn">Hide Out-of-Stock</button></form><form method="post" action="/admin-web/product-bulk-tools/show-all"><button class="btn secondary">Show All Products</button></form></div>
    <div class="card"><h3>🏷 Set Category</h3><form method="post" action="/admin-web/product-bulk-tools/set-category"><label>Product Codes comma separated</label><textarea name="codes" placeholder="P001,P002"></textarea><label>New Category</label><input name="category" placeholder="AI Tools"><button class="btn">Set Category</button></form></div>
    <div class="card"><h3>📈 Profit Setup</h3><p class="muted">Set cost price in product manage page to get profit reports.</p><a class="btn" href="/admin-web/profit-analytics">Open Profit Analytics</a></div>
    <div class="card"><h3>📦 Bulk Order Pricing</h3><p class="muted">Open any product → Bulk Order Pricing to set quantity based prices like 5|1.5 and 10|1.2.</p><a class="btn" href="/admin-web/products">Open Products</a></div>
  </div>`;
  res.send(adminLayout('Product Bulk Tools', body, req.query.msg));
});

app.post('/admin-web/product-bulk-tools/price', (req, res) => {
  const percent = Number(req.body.percent || 0);
  const category = String(req.body.category || '').trim();
  if (!percent) return redirectMsg(res, '/admin-web/product-bulk-tools', 'Percent required');
  let count = 0;
  for (const p of db.products || []) {
    if (category && cleanCategory(p.category || 'General').toLowerCase() !== category.toLowerCase()) continue;
    p.price = Number((Number(p.price || 0) * (1 + percent / 100)).toFixed(2));
    count++;
  }
  saveData();
  addWebAudit('bulk_price_update', { percent, category, count }, req);
  redirectMsg(res, '/admin-web/product-bulk-tools', `Updated ${count} product price(s).`);
});

app.post('/admin-web/product-bulk-tools/hide-oos', (req, res) => {
  let count = 0;
  for (const p of db.products || []) if (!(p.stock || []).length && p.active !== false) { p.active = false; count++; }
  saveData();
  addWebAudit('bulk_hide_out_of_stock', { count }, req);
  redirectMsg(res, '/admin-web/product-bulk-tools', `Hidden ${count} out-of-stock product(s).`);
});

app.post('/admin-web/product-bulk-tools/show-all', (req, res) => {
  let count = 0;
  for (const p of db.products || []) if (p.active === false) { p.active = true; count++; }
  saveData();
  addWebAudit('bulk_show_all_products', { count }, req);
  redirectMsg(res, '/admin-web/product-bulk-tools', `Restored ${count} product(s).`);
});

app.post('/admin-web/product-bulk-tools/set-category', (req, res) => {
  const codes = String(req.body.codes || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const category = cleanCategory(req.body.category || 'General');
  let count = 0;
  for (const p of db.products || []) {
    if (codes.includes(String(p.code).toUpperCase())) { p.category = category; count++; }
  }
  saveData();
  addWebAudit('bulk_set_category', { category, count, codes }, req);
  redirectMsg(res, '/admin-web/product-bulk-tools', `Updated category for ${count} product(s).`);
});

app.get('/admin-web/profit-analytics', (req, res) => {
  const s = profitSummary();
  const rows = s.byProduct.map(p => `<tr><td>${webEsc(p.code)}</td><td>${webEsc(p.name)}</td><td>${p.qty}</td><td>${webMoney(p.revenue)}</td><td>${webMoney(p.cost)}</td><td>${webMoney(p.profit)}</td><td>${p.revenue ? ((p.profit/p.revenue)*100).toFixed(1) : '0.0'}%</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>📈 Profit Analytics</h2><div class="muted">Revenue, cost, profit and margin based on product cost price.</div><div class="kpiLine"><span>Revenue ${webMoney(s.revenue)}</span><span>Cost ${webMoney(s.cost)}</span><span>Profit ${webMoney(s.profit)}</span><span>Margin ${s.margin.toFixed(1)}%</span></div></div>
  <div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Qty</th><th>Revenue</th><th>Cost</th><th>Profit</th><th>Margin</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No sales yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Profit Analytics', body, req.query.msg));
});


app.get('/admin-web/products', (req, res) => {
  const all = db.products.slice().sort((a,b) => (a.active === false) - (b.active === false) || String(a.code).localeCompare(String(b.code)));
  const stats = productBulkStats();
  const body = `<div class="heroPanel"><h2>📦 Product Manager</h2><div class="muted">Manage products, categories, pricing, flash sales and stock.</div><div class="kpiLine"><span>${stats.total} products</span><span>${stats.active} active</span><span>${stats.noStock} out of stock</span><span>${stats.categories} categories</span></div></div><div class="card"><a class="btn" href="/admin-web/products/new">➕ Add New Product</a><a class="btn secondary" href="/admin-web/product-bulk-tools">🧰 Bulk Tools</a><a class="btn secondary" href="/admin-web/categories">🗂 Categories</a></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Price</th><th>Bulk</th><th>Category/Tags</th><th>Format</th><th>Stock</th><th>Action</th></tr></thead><tbody>${productRows(all)}</tbody></table></div>`;
  res.send(adminLayout('Product Manager', body, req.query.msg));
});

app.get('/admin-web/products/new', (req, res) => {
  const body = `<div class="card"><form method="post" action="/admin-web/products/new">
    <label>Product Name</label><input name="name" required placeholder="Gemini Pro Jio 18 Months Link">
    <div class="row"><div><label>Price</label><input name="price" type="number" step="0.01" required></div><div><label>Cost Price (optional)</label><input name="costPrice" type="number" step="0.01" placeholder="For profit report"></div><div><label>Emoji</label><input name="emoji" placeholder="🤖"></div><div><label>Button Logo/Icon</label><input name="logo" placeholder="💎 / 🤖 / 🟣"></div></div><div class="row"><div><label>Telegram Custom Emoji ID</label><input name="customEmojiId" placeholder="5368324170671202286"></div><div><label>Brand Code</label><input name="brandCode" placeholder="gemini / chatgpt / notion"></div></div>
    <div class="row"><div><label>Category</label><input name="category" placeholder="AI Tools"></div><div><label>Tags</label><input name="tags" placeholder="gemini, google, 18 months"></div></div>
    <label>Default Delivery Format</label><select name="stockFormat"><option value="redeem_link">🔗 Redeem Link</option><option value="id_password">🔐 ID / Password</option><option value="coupon_code">🎟 Coupon / Code</option><option value="custom">✨ Custom Format</option></select>
    <label>Custom Format (optional)</label><input name="stockFormatCustom" placeholder="Mail|Pass|2fa">
    <label>Bulk Pricing Tiers (optional)</label><textarea name="bulkPrices" placeholder="5|1.50|5+ qty price&#10;10|1.20|10+ qty price"></textarea>
    <label>Custom Promo Template (optional)</label><textarea name="customPromo" placeholder="[b]{name}[/b]&#10;💰 Price: [b]{price}[/b]&#10;📦 Stock: {stock}&#10;🛒 Buy from @{bot}"></textarea>
    <label>Custom Delivery Message Template (optional)</label><textarea name="deliveryMessageTemplate" placeholder="🎉 [b]Order Delivered[/b]&#10;Product: {product}&#10;Order: [code]{order_id}[/code]&#10;{items}"></textarea>
    <label>Custom Stock Alert Template (optional)</label><textarea name="customStockAlertTemplate" placeholder="📊 [b]{added} new stock added for {name}![/b]&#10;🌀 Available: {stock} items&#10;💐 Price: {price}&#10;🛒 {buy_link}"></textarea>
    <label>Custom Flash Sale Template (optional)</label><textarea name="customFlashSaleTemplate" placeholder="🚨 [b]FLASH SALE LIVE[/b] {name} {sale_price}"></textarea>
    <label>Custom Group Reply Template (optional)</label><textarea name="customGroupReplyTemplate" placeholder="{emoji} [b]{name}[/b]&#10;💰 Price: {price}&#10;📦 Stock: {stock}&#10;🛒 {buy_link}"></textarea>
    <label>Short details</label><textarea name="details" placeholder="Instant redeem link delivery&#10;Validity 18 months&#10;Gemini Pro + 5TB Storage"></textarea>
    <button class="btn">Create Product</button>
    <a class="btn secondary" href="/admin-web/description-generator">Open AI Description Generator</a>
  </form></div>`;
  res.send(adminLayout('Add Product', body, req.query.msg));
});

app.post('/admin-web/products/new', (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = Number(req.body.price || 0);
  if (!name || !price) return redirectMsg(res, '/admin-web/products/new', 'Name and price required');
  const details = String(req.body.details || '').trim();
  const stockFormat = resolveWebStockFormat(req.body.stockFormat, req.body.stockFormatCustom, 'redeem_link');
  const p = {
    code: nextProductCode(),
    emoji: String(req.body.emoji || '📦').trim().slice(0, 8),
    name,
    price,
    costPrice: Number(req.body.costPrice || 0),
    category: cleanCategory(req.body.category || 'General'),
    tags: String(req.body.tags || '').split(',').map(x => x.trim()).filter(Boolean),
    currency: currency(),
    description: typeof smartProductDescription === 'function' ? smartProductDescription(name, details, stockFormat) : details,
    shortDetails: details,
    stock: [],
    sold: 0,
    active: true,
    pinned: false,
    logoFileId: '',
    specialPrices: {},
    stockFormat,
    createdAt: now()
  };
  db.products.push(p);
  saveData();
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `Product ${p.code} created`);
});

app.get('/admin-web/products/:code', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  const stockPreview = (p.stock || []).slice(0, 30).map((x,i) => webEsc(stockItemDisplay(x, i + 1))).join('<br><br>') || '<span class="muted">No stock</span>';
  const body = `<div class="card"><h3>${webEsc(p.code)} · ${webEsc(productLogo(p))} ${webEsc(p.name)}</h3><p class="muted">${p.active === false ? '🔴 Hidden' : '🟢 Active'} · ${p.pinned ? '📌 Pinned' : 'Normal'} · 📦 Stock ${p.stock.length} · 💵 ${webMoney(p.price)}</p>
  <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/update">
    <label>Name</label><input name="name" value="${webEsc(p.name)}">
    <div class="row"><div><label>Price</label><input name="price" type="number" step="0.01" value="${webEsc(p.price)}"></div><div><label>Cost Price</label><input name="costPrice" type="number" step="0.01" value="${webEsc(p.costPrice || 0)}"></div><div><label>Emoji</label><input name="emoji" value="${webEsc(p.emoji || '')}"></div><div><label>Button Logo/Icon</label><input name="logo" value="${webEsc(p.logo || productLogo(p))}" placeholder="💎 / 🤖 / 🟣"></div></div><div class="row"><div><label>Telegram Custom Emoji ID</label><input name="customEmojiId" value="${webEsc(p.customEmojiId || productCustomEmojiId(p))}" placeholder="5368324170671202286"></div><div><label>Brand Code</label><input name="brandCode" value="${webEsc(p.brandCode || brandCodeForName(p.name))}" placeholder="gemini / chatgpt / notion"></div></div>
    <div class="row"><div><label>Category</label><input name="category" value="${webEsc(cleanCategory(p.category || 'General'))}"></div><div><label>Tags</label><input name="tags" value="${webEsc(tagString(p))}" placeholder="gemini, google, ai"></div></div>
    <label>Group Reply Keywords / Aliases</label><input name="groupKeywords" value="${webEsc(p.groupKeywords || '')}" placeholder="gemini, google ai, 18 months, 5tb">
    <label>Default Delivery Format</label><select name="stockFormat"><option value="redeem_link" ${p.stockFormat === 'redeem_link' ? 'selected' : ''}>🔗 Redeem Link</option><option value="id_password" ${p.stockFormat === 'id_password' ? 'selected' : ''}>🔐 ID / Password</option><option value="coupon_code" ${p.stockFormat === 'coupon_code' ? 'selected' : ''}>🎟 Coupon / Code</option><option value="custom" ${isCustomDeliveryFormat(p.stockFormat) ? 'selected' : ''}>✨ Custom Format</option></select>
    <label>Custom Format</label><input name="stockFormatCustom" value="${isCustomDeliveryFormat(p.stockFormat) ? webEsc(deliveryTemplateFromFormat(p.stockFormat)) : ''}" placeholder="Mail|Pass|2fa">
    <label>Bulk Pricing Tiers</label><textarea name="bulkPrices" placeholder="5|1.50|5+ qty&#10;10|1.20|10+ qty">${webEsc(bulkPricingLines(p))}</textarea>
    <label>Custom Promo Template (optional)</label><textarea name="customPromo" placeholder="[b]{name}[/b]&#10;💰 Price: [b]{price}[/b]&#10;📦 Stock: {stock}&#10;🛒 Buy from @{bot}">${webEsc(p.customPromo || '')}</textarea>
    <p class="muted small">Template variables: {name}, {price}, {stock}, {bot}, {store}, {link}. Formatting: [b]bold[/b], **bold**, [line].</p>
    <label>Custom Delivery Message Template</label><textarea name="deliveryMessageTemplate" placeholder="🎉 [b]Order Delivered[/b]&#10;Product: {product}&#10;Order: [code]{order_id}[/code]&#10;{items}&#10;{access_block}">${webEsc(p.deliveryMessageTemplate || '')}</textarea>
    <p class="muted small">Delivery variables: {product}, {qty}, {total}, {order_id}, {delivery_type}, {items}, {access_block}, {website}, {access_link}, {access_instructions}, {support}, {store}, {bot}, {note}. Formatting: [b]bold[/b], **bold**, [line].</p>
    <div class="row"><div><label>Website / Portal</label><input name="deliveryAccessWebsite" value="${webEsc(p.deliveryAccessWebsite || '')}" placeholder="https://example.com"></div><div><label>Access Link</label><input name="deliveryAccessLink" value="${webEsc(p.deliveryAccessLink || '')}" placeholder="https://example.com/redeem"></div></div>
    <label>Access Instructions</label><textarea name="deliveryAccessInstructions" placeholder="Open the link, login/redeem, then follow steps">${webEsc(p.deliveryAccessInstructions || '')}</textarea>
    <label>Custom Stock Alert Template</label><textarea name="customStockAlertTemplate" placeholder="📊 [b]{added} new stock added for {name}![/b]&#10;&#10;🌀 Available: {stock} items&#10;💐 Price: {price}&#10;🛒 {buy_link}">${webEsc(p.customStockAlertTemplate || '')}</textarea>
    <label>Custom Flash Sale Template</label><textarea name="customFlashSaleTemplate" placeholder="🚨 [b]FLASH SALE LIVE[/b]&#10;{emoji} {name}&#10;💸 Old: {old_price}&#10;🔥 New: {sale_price}&#10;📦 Stock: {stock}&#10;🛒 {buy_link}">${webEsc(p.customFlashSaleTemplate || '')}</textarea>
    <p class="muted small">Alert variables: {emoji}, {name}, {price}, {old_price}, {sale_price}, {stock}, {added}, {buy_link}, {link}, {bot}, {ends}, {note}.</p>
    <label>Description</label><textarea name="description">${webEsc(p.description || '')}</textarea>
    <button class="btn">Save Product</button>
  </form></div>
  <div class="row" style="margin-top:14px">
    <div class="card"><h3>⚡ Flash Sale</h3>
      <p class="muted">Current: ${activeFlashSale(p) ? 'LIVE · ' + webMoney(activeFlashSale(p).price) + ' till ' + webEsc(new Date(activeFlashSale(p).endsAt).toLocaleString()) : 'Not active'}</p>
      <form method="post" action="/admin-web/flash-sales/create">
        <input type="hidden" name="code" value="${webEsc(p.code)}">
        <div class="row"><input name="price" type="number" step="0.01" placeholder="Sale price"><input name="hours" type="number" placeholder="Hours" value="6"></div>
        <input name="note" placeholder="Offer note">
        <button class="btn">Start Sale + Alert</button>
      </form>
      <form method="post" action="/admin-web/flash-sales/${encodeURIComponent(p.code)}/disable"><button class="btn danger">Disable Sale</button></form>
    </div>
  </div>

  <div class="row" style="margin-top:14px">
    <div class="card"><h3>📦 Bulk Order Pricing</h3>
      <p class="muted">Current tiers:</p>
      <div>${bulkPricingHtml(p)}</div>
      <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/bulk-pricing">
        <label>Bulk Tiers</label><textarea name="bulkPrices" placeholder="5|1.50|5+ qty&#10;10|1.20|10+ qty">${webEsc(bulkPricingLines(p))}</textarea>
        <button class="btn">Save Bulk Pricing</button>
      </form>
      <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/bulk-pricing-clear"><button class="btn danger">Clear Bulk Pricing</button></form>
    </div>
  </div>

  <div class="row" style="margin-top:14px">
    <div class="card"><h3>✨ Regenerate Description</h3>
      <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/regenerate-description">
        <label>Short details / key points</label><textarea name="details">${webEsc(p.shortDetails || '')}</textarea>
        <button class="btn">Generate Detailed Premium Description</button>
      </form>
    </div>
    <div class="card"><h3>📣 Promo Preview</h3><textarea class="preview" onclick="this.select()" readonly>${webEsc(generateDescriptionPack(p.name, p.shortDetails || p.description || '', { price: p.price }).groupPromo)}</textarea></div>
    <div class="card"><h3>🚚 Delivery Preview</h3><textarea class="preview" onclick="this.select()" readonly>${webEsc(deliveryText(p.name, 1, p.price, p.currency || currency(), [p.stock?.[0] || createStockItemObject(p.stockFormat || 'redeem_link', stockLineExample(p.stockFormat || 'redeem_link'))], 'DEMO-ORDER', true, p.code).replace(/<[^>]+>/g, ''))}</textarea></div>
  </div>
  <div class="row" style="margin-top:14px">
    <div class="card"><h3>📥 Add Stock</h3><form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/stock">
      <label>Delivery Format</label><select name="stockFormat"><option value="redeem_link" ${p.stockFormat === 'redeem_link' ? 'selected' : ''}>🔗 Redeem Link</option><option value="id_password" ${p.stockFormat === 'id_password' ? 'selected' : ''}>🔐 ID / Password</option><option value="coupon_code" ${p.stockFormat === 'coupon_code' ? 'selected' : ''}>🎟 Coupon / Code</option><option value="custom" ${isCustomDeliveryFormat(p.stockFormat) ? 'selected' : ''}>✨ Custom Format</option></select>
      <label>Custom Format</label><input name="stockFormatCustom" value="${isCustomDeliveryFormat(p.stockFormat) ? webEsc(deliveryTemplateFromFormat(p.stockFormat)) : ''}" placeholder="Mail|Pass|2fa">
      <div class="row"><div><label>Website / Portal</label><input name="deliveryAccessWebsite" value="${webEsc(p.deliveryAccessWebsite || '')}" placeholder="https://example.com"></div><div><label>Access Link</label><input name="deliveryAccessLink" value="${webEsc(p.deliveryAccessLink || '')}" placeholder="https://example.com/redeem"></div></div>
      <label>Access Instructions</label><textarea name="deliveryAccessInstructions" placeholder="Optional delivery instructions">${webEsc(p.deliveryAccessInstructions || '')}</textarea>
      <textarea name="stock" placeholder="Redeem link: one link per line&#10;Mail|Pass: mail@example.com|pass123&#10;Mail|Pass|2fa: mail@example.com|pass123|ABC123&#10;Coupon: one code per line"></textarea><button class="btn">Add Stock + Preview/Deliver Queue</button></form></div>
    <div class="card"><h3>📋 Stock Preview</h3><div class="code">${stockPreview}</div></div>
  </div>
  <div class="row" style="margin-top:14px">
    <div class="card"><h3>💎 Special Pricing</h3>
      <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/special-price">
        <label>User ID or @username</label><input name="user" placeholder="8316371997 or @username" required>
        <label>Special price</label><input name="price" type="number" step="0.01" placeholder="1.8" required>
        <button class="btn">Save Special Price</button>
      </form>
      <p class="muted small">Set user-specific price. Send 0 from remove form below to remove.</p>
    </div>
    <div class="card"><h3>👥 Current Specials</h3><div class="code">${webEsc(specialPriceRows(p)).replace(/\n/g, '<br>')}</div>
      <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/special-price-remove" style="margin-top:10px">
        <input name="user" placeholder="User ID to remove special price">
        <button class="btn danger">Remove Special Price</button>
      </form>
    </div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Actions</h3>
    <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/pin"><button class="btn secondary">${p.pinned ? 'Unpin' : 'Pin'}</button></form>
    <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/toggle"><button class="btn warn">${p.active === false ? 'Restore / Show' : 'Hide Product'}</button></form>
    <form method="post" action="/admin-web/products/${encodeURIComponent(p.code)}/delete" onsubmit="return confirm('Delete forever?')"><button class="btn danger">Delete Forever</button></form>
    <a class="btn secondary" href="/admin-web/products">Back</a>
  </div>`;
  res.send(adminLayout('Manage Product', body, req.query.msg));
});

app.post('/admin-web/products/:code/special-price', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  const userInput = String(req.body.user || '').trim().replace('@', '');
  const price = Number(req.body.price || 0);
  if (!userInput || !price || price <= 0) return redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, 'Valid user and price required');
  const u = db.users[userInput] || Object.values(db.users || {}).find(x => String(x.username || '').toLowerCase() === userInput.toLowerCase());
  if (!u) return redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, 'User not found. Ask user to /start bot first or add user in Users page.');
  p.specialPrices ||= {};
  p.specialPrices[String(u.telegramId)] = price;
  saveData();
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `Special price saved for ${u.firstName || u.telegramId}`);
});

app.post('/admin-web/products/:code/special-price-remove', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  const userInput = String(req.body.user || '').trim().replace('@', '');
  const u = db.users[userInput] || Object.values(db.users || {}).find(x => String(x.username || '').toLowerCase() === userInput.toLowerCase());
  const uid = u ? String(u.telegramId) : userInput;
  p.specialPrices ||= {};
  delete p.specialPrices[uid];
  saveData();
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `Special price removed for ${uid}`);
});

app.post('/admin-web/products/:code/update', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  p.name = String(req.body.name || p.name).trim();
  p.price = Number(req.body.price || p.price);
  p.costPrice = Number(req.body.costPrice || 0);
  p.category = cleanCategory(req.body.category || 'General');
  p.tags = String(req.body.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  p.bulkPrices = parseBulkPricingLines(req.body.bulkPrices || '');
  p.emoji = String(req.body.emoji || p.emoji || '📦').trim().slice(0, 8);
  p.logo = String(req.body.logo || p.logo || p.emoji || productLogo(p)).trim().slice(0, 12);
  p.customPromo = String(req.body.customPromo || '').trim();
  p.deliveryMessageTemplate = String(req.body.deliveryMessageTemplate || '').trim();
  p.deliveryAccessWebsite = normalizeUrl(req.body.deliveryAccessWebsite || '');
  p.deliveryAccessLink = normalizeUrl(req.body.deliveryAccessLink || '');
  p.deliveryAccessInstructions = String(req.body.deliveryAccessInstructions || '').trim();
  p.customStockAlertTemplate = String(req.body.customStockAlertTemplate || '').trim();
  p.customFlashSaleTemplate = String(req.body.customFlashSaleTemplate || '').trim();
  p.customGroupReplyTemplate = String(req.body.customGroupReplyTemplate || '').trim();
  p.groupKeywords = String(req.body.groupKeywords || '').trim();
  p.customEmojiId = String(req.body.customEmojiId || '').trim();
  p.brandCode = String(req.body.brandCode || brandCodeForName(p.name)).toLowerCase().trim();
  p.stockFormat = resolveWebStockFormat(req.body.stockFormat, req.body.stockFormatCustom, p.stockFormat || 'redeem_link');
  p.description = String(req.body.description || '').trim();
  saveData();
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, 'Product updated');
});

app.post('/admin-web/products/:code/clone', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  const copy = JSON.parse(JSON.stringify(p));
  copy.code = nextProductCode();
  copy.name = `${p.name} Copy`;
  copy.stock = [];
  copy.sold = 0;
  copy.pinned = false;
  copy.active = true;
  copy.createdAt = now();
  db.products.push(copy);
  saveData();
  addWebAudit('product_cloned', { from: p.code, to: copy.code }, req);
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(copy.code)}`, `Product cloned from ${p.code}`);
});

app.post('/admin-web/products/:code/bulk-pricing', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  p.bulkPrices = parseBulkPricingLines(req.body.bulkPrices || '');
  normalizeBulkPrices(p);
  saveData();
  addWebAudit('bulk_pricing_updated', { code: p.code, tiers: p.bulkPrices.length }, req);
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `Bulk pricing saved: ${p.bulkPrices.length} tier(s)`);
});

app.post('/admin-web/products/:code/bulk-pricing-clear', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  p.bulkPrices = [];
  saveData();
  addWebAudit('bulk_pricing_cleared', { code: p.code }, req);
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, 'Bulk pricing cleared');
});

app.post('/admin-web/products/:code/stock', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/products', 'Product not found');
  const lines = String(req.body.stock || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.length) return redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, 'No stock lines found');
  const format = resolveWebStockFormat(req.body.stockFormat, req.body.stockFormatCustom, p.stockFormat || 'redeem_link');
  p.stockFormat = format;
  applyProductAccessInfo(p, {
    website: req.body.deliveryAccessWebsite || p.deliveryAccessWebsite || '',
    accessLink: req.body.deliveryAccessLink || p.deliveryAccessLink || '',
    instructions: req.body.deliveryAccessInstructions || p.deliveryAccessInstructions || ''
  });
  p.stock.push(...lines.map(line => makeStockItem(format, line)));
  p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
  saveData();
  processStockWaitQueue(p.code, 'web-stock-added').then((waitResult) => {
    const remainingAdded = Math.max(0, lines.length - waitResult.ok);
    if (remainingAdded > 0 && p.stock.length > 0) broadcastStockAlert(p, remainingAdded).catch(err => console.error('Web stock alert failed:', err.message));
  }).catch(err => console.error('Web stock wait queue failed:', err.message));
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `${lines.length} stock added. Paid waiting queue will be delivered first.`);
});

app.post('/admin-web/products/:code/pin', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (p) { p.pinned = !p.pinned; saveData(); }
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(req.params.code)}`, 'Pin status updated');
});

app.post('/admin-web/products/:code/toggle', (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (p) { p.active = p.active === false ? true : false; saveData(); }
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(req.params.code)}`, 'Visibility updated');
});

app.post('/admin-web/products/:code/delete', (req, res) => {
  const index = db.products.findIndex(x => String(x.code).toUpperCase() === String(req.params.code).toUpperCase());
  if (index >= 0) { db.products.splice(index, 1); saveData(); }
  redirectMsg(res, '/admin-web/products', 'Product deleted forever');
});


function findUserByIdOrUsername(input) {
  const q = String(input || '').trim().replace('@', '').toLowerCase();
  if (!q) return null;
  return Object.values(db.users || {}).find((u) =>
    String(u.telegramId || '').toLowerCase() === q ||
    String(u.username || '').toLowerCase() === q
  ) || null;
}

async function resolveTelegramUserIdFromUsername(username) {
  const clean = String(username || '').trim().replace('@', '');
  if (!clean) return null;
  try {
    const chat = await tgGet('getChat', { chat_id: '@' + clean }, 12000);
    if (chat && chat.id) {
      return {
        telegramId: String(chat.id),
        firstName: chat.first_name || chat.title || clean,
        username: chat.username || clean
      };
    }
  } catch (_) {}
  return null;
}

app.get('/admin-web/users', (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  let list = Object.values(db.users || {}).sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (query) {
    const q = query.replace('@', '');
    list = list.filter((u) =>
      String(u.telegramId || '').includes(q) ||
      String(u.username || '').toLowerCase().includes(q) ||
      String(u.firstName || '').toLowerCase().includes(q)
    );
  }
  const rows = list.map(u => `<tr><td><b>${webEsc(u.firstName || 'User')}</b><br><span class="muted">${u.username ? '@'+webEsc(u.username) : 'No username'}</span></td><td><span class="code">${webEsc(u.telegramId)}</span></td><td>${webMoney(u.balance || 0)}</td><td>${u.referrals || 0}</td><td>${u.notifications === false ? 'OFF 🔕' : 'ON 🔔'}</td><td>${u.banned ? '🚫 Banned' : '✅ Active'}<br><a class="btn secondary" href="/admin-web/users/${encodeURIComponent(u.telegramId)}/profile">User 360</a><form method="post" action="/admin-web/users/${encodeURIComponent(u.telegramId)}/ban"><button class="btn secondary">${u.banned ? 'Unban' : 'Ban'}</button></form></td><td><form method="post" action="/admin-web/users/balance"><input type="hidden" name="telegramId" value="${webEsc(u.telegramId)}"><div class="row"><input name="amount" type="number" step="0.01" placeholder="Amount"><select name="action"><option value="add">Add</option><option value="deduct">Deduct</option></select></div><button class="btn">Update Balance</button></form></td></tr>`).join('');
  const body = `<div class="grid">
    <div class="card"><h3>👥 Total Users</h3><div class="stat">${Object.keys(db.users || {}).length}</div></div>
    <div class="card"><h3>🔎 Showing</h3><div class="stat">${list.length}</div></div>
    <div class="card"><h3>💰 Total Wallet</h3><div class="stat">${webMoney(Object.values(db.users || {}).reduce((a,u)=>a+Number(u.balance||0),0))}</div></div>
  </div>

  <div class="two section">
    <div class="card"><h3>➕ Add User Manually</h3>
      <form method="post" action="/admin-web/users/add">
        <div class="row">
          <div><label>Telegram User ID</label><input name="telegramId" placeholder="Example: 8316371997"></div>
          <div><label>Username</label><input name="username" placeholder="@username"></div>
        </div>
        <div class="row">
          <div><label>Name</label><input name="firstName" placeholder="User name"></div>
          <div><label>Wallet Balance</label><input name="balance" type="number" step="0.01" value="0"></div>
        </div>
        <button class="btn">Add / Update User</button>
      </form>
      <p class="muted small">Best: use Telegram User ID. Username only will try Telegram lookup; if not found, it saves as pending username record.</p>
    </div>

    <div class="card"><h3>🔎 Search User</h3>
      <form method="get" action="/admin-web/users">
        <input name="q" value="${webEsc(req.query.q || '')}" placeholder="Search by ID, username or name">
        <button class="btn">Search</button>
        <a class="btn secondary" href="/admin-web/users">Reset</a>
      </form>
      <p class="muted small">Use this to quickly find user and add/deduct wallet balance.</p>
    </div>
  </div>

  <div class="section tableWrap"><table class="table"><thead><tr><th>User</th><th>ID</th><th>Wallet</th><th>Refs</th><th>Notify</th><th>Status</th><th>Balance Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No users found.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Users & Balance', body, req.query.msg));
});

app.post('/admin-web/users/add', async (req, res) => {
  let telegramId = String(req.body.telegramId || '').trim();
  let username = String(req.body.username || '').trim().replace('@', '');
  let firstName = String(req.body.firstName || '').trim();
  const balance = Number(req.body.balance || 0);

  if (!telegramId && username) {
    const resolved = await resolveTelegramUserIdFromUsername(username);
    if (resolved) {
      telegramId = resolved.telegramId;
      username = resolved.username || username;
      firstName ||= resolved.firstName || username;
    }
  }

  if (!telegramId && !username) return redirectMsg(res, '/admin-web/users', 'User ID or username required');

  // Real Telegram users need numeric ID for bot messages. Username-only users are stored as pending.
  const key = telegramId || `username:${username.toLowerCase()}`;
  const existing = db.users[key] || {};
  db.users[key] = {
    telegramId: key,
    firstName: firstName || existing.firstName || username || 'User',
    username: username || existing.username || '',
    balance: Math.max(Number(existing.balance || 0), balance || 0),
    referrals: Number(existing.referrals || 0),
    referredBy: existing.referredBy || '',
    notifications: existing.notifications === false ? false : true,
    pendingUsernameOnly: telegramId ? false : true,
    createdAt: existing.createdAt || now()
  };
  saveData();
  redirectMsg(res, '/admin-web/users', telegramId ? `User ${key} added/updated` : `Username-only user saved as pending: @${username}. Ask user to /start bot for real ID.`);
});


app.get('/admin-web/users/:id/profile', (req, res) => {
  const uid = String(req.params.id);
  const s = user360Stats(uid);
  if (!s.user.telegramId) return redirectMsg(res, '/admin-web/users', 'User not found');
  const orderRows = s.orders.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0, 25).map(o => `<tr><td><b>${webEsc(o.id)}</b><br>${webEsc(new Date(o.createdAt).toLocaleString())}</td><td>${webEsc(o.productName)}</td><td>${o.qty}</td><td>${webMoney(o.total)}</td><td><a class="btn secondary" href="/admin-web/orders?q=${encodeURIComponent(o.id)}">Open</a></td></tr>`).join('');
  const paymentRows = s.payments.slice().reverse().slice(0, 20).map(p => `<tr><td>${webEsc(p.id)}</td><td>${webEsc(p.productName || 'Wallet Deposit')}</td><td>${webMoney(p.amount)}</td><td>${webEsc(p.status)}</td><td>${webEsc(new Date(p.createdAt).toLocaleString())}</td></tr>`).join('');
  const depositRows = s.deposits.slice().reverse().slice(0, 20).map(d => `<tr><td>${webMoney(d.amount)}</td><td>${webEsc(d.method || '-')}</td><td>${webEsc(new Date(d.createdAt).toLocaleString())}</td></tr>`).join('');
  const ticketRows = s.tickets.slice(0, 20).map(t => `<tr><td>${webEsc(t.id)}</td><td>${webEsc(t.type || 'support')}</td><td>${webEsc(t.status)}</td><td>${webEsc(t.message || '-')}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>👤 User 360 Profile</h2><div class="muted">${webEsc(s.user.firstName || 'User')} ${s.user.username ? '@'+webEsc(s.user.username) : ''} · ${webEsc(uid)}</div><div class="kpiLine"><span>Wallet ${webMoney(s.user.balance || 0)}</span><span>${s.orders.length} orders</span><span>${webMoney(s.spent)} spent</span><span>${s.payments.length} payments</span><span>${s.tickets.length} tickets</span></div></div>
  <div class="grid"><div class="card"><h3>Balance</h3><div class="stat">${webMoney(s.user.balance || 0)}</div></div><div class="card"><h3>Orders</h3><div class="stat">${s.orders.length}</div></div><div class="card"><h3>Items</h3><div class="stat">${s.qty}</div></div><div class="card"><h3>Reviews</h3><div class="stat">${s.reviews.length}</div></div></div>
  <div class="card section"><h3>Quick Actions</h3><div class="quick"><a class="btn" href="/admin-web/message-user?telegramId=${encodeURIComponent(uid)}">Message User</a><a class="btn secondary" href="/admin-web/orders?user=${encodeURIComponent(uid)}">All Orders</a><a class="btn secondary" href="/admin-web/users">Back Users</a></div></div>
  <div class="two section"><div class="tableWrap"><h3>Recent Orders</h3><table class="table"><thead><tr><th>Order</th><th>Product</th><th>Qty</th><th>Total</th><th>Action</th></tr></thead><tbody>${orderRows || '<tr><td colspan="5">No orders.</td></tr>'}</tbody></table></div><div class="tableWrap"><h3>Recent Payments</h3><table class="table"><thead><tr><th>ID</th><th>Item</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${paymentRows || '<tr><td colspan="5">No payments.</td></tr>'}</tbody></table></div></div>
  <div class="two section"><div class="tableWrap"><h3>Wallet Ledger</h3><table class="table"><thead><tr><th>Amount</th><th>Method</th><th>Date</th></tr></thead><tbody>${depositRows || '<tr><td colspan="3">No wallet ledger.</td></tr>'}</tbody></table></div><div class="tableWrap"><h3>Tickets</h3><table class="table"><thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Message</th></tr></thead><tbody>${ticketRows || '<tr><td colspan="4">No tickets.</td></tr>'}</tbody></table></div></div>`;
  res.send(adminLayout('User 360 Profile', body, req.query.msg));
});


app.post('/admin-web/users/balance', async (req, res) => {
  const id = String(req.body.telegramId || '').trim();
  const amount = Number(req.body.amount || 0);
  const action = String(req.body.action || 'add');
  const u = db.users[id];
  if (!u || !amount || amount <= 0) return redirectMsg(res, '/admin-web/users', 'Invalid user or amount');
  const before = Number(u.balance || 0);
  u.balance = action === 'deduct' ? Math.max(0, before - amount) : before + amount;
  db.deposits ||= [];
  db.deposits.push({ id: 'WEBMANUAL' + Date.now(), telegramId: id, amount: action === 'deduct' ? -amount : amount, currency: currency(), method: action === 'deduct' ? 'Web Admin Deduct' : 'Web Admin Add', reference: 'web-admin', status: 'approved', createdAt: now() });
  saveData();
  try { await sendMessage(id, `${action === 'deduct' ? '⚠️ Wallet Balance Deducted' : '✅ Wallet Balance Added'}\n\nAmount: ${money(amount)}\nNew Balance: ${money(u.balance)}`, homeButtons(id)); } catch (_) {}
  redirectMsg(res, '/admin-web/users', `Balance updated for ${id}`);
});

app.get('/admin-web/payments', (req, res) => {
  const filter = String(req.query.filter || 'all');
  let payments = db.payments.slice().reverse();
  if (filter !== 'all') payments = payments.filter((p) => String(p.status || '').toLowerCase() === filter);
  payments = payments.slice(0, 200);
  const undelivered = undeliveredPayments().length;
  const rows = payments.map(p => {
    const order = findOrderByPaymentId(p.id);
    const user = db.users[p.telegramId] || {};
    return `<tr><td><b>${webEsc(p.id)}</b><br><span class="muted">${p.type === 'deposit' ? 'Deposit' : 'Order'} · ${webEsc(new Date(p.createdAt).toLocaleString())}</span></td><td>${webEsc(user.firstName || 'User')}<br><span class="code">${webEsc(p.telegramId)}</span></td><td>${webEsc(p.productName || 'Wallet Deposit')}<br><span class="muted">Qty ${webEsc(p.qty || 1)} · ${order ? '✅ Delivered ' + webEsc(order.id) : '⚠️ No order'}</span></td><td>${webMoney(p.amount)}</td><td><b>${webEsc(p.status)}</b><br><span class="muted">${webEsc(short(p.lastCheckReason || '', 55))}</span></td><td><span class="code">${webEsc(short(p.submittedReference || p.note || '-', 80))}</span></td><td class="actions"><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/approve"><button class="btn">Approve + Deliver</button></form><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/force"><button class="btn warn">Force Deliver</button></form><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/resend"><button class="btn secondary">Resend</button></form><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/reject"><button class="btn danger">Reject</button></form></td></tr>`;
  }).join('');
  const body = `<div class="grid">
    <div class="card"><h3>⏳ Pending</h3><div class="stat">${db.payments.filter(p => p.status === 'pending').length}</div></div>
    <div class="card"><h3>📝 Review</h3><div class="stat">${db.payments.filter(p => p.status === 'review').length}</div></div>
    <div class="card"><h3>🚑 Need Delivery</h3><div class="stat">${undelivered}</div></div>
    <div class="card"><h3>✅ Approved</h3><div class="stat">${db.payments.filter(p => p.status === 'approved').length}</div></div>
  </div>
  <div class="card section"><div class="quick">
    <a class="btn secondary" href="/admin-web/payments?filter=all">All</a>
    <a class="btn secondary" href="/admin-web/payments?filter=pending">Pending</a>
    <a class="btn secondary" href="/admin-web/payments?filter=review">Review</a>
    <a class="btn secondary" href="/admin-web/payments?filter=approved">Approved</a>
    <a class="btn" href="/admin-web/delivery-repair">🚑 Delivery Repair</a>
  </div></div>
  <div class="section tableWrap"><table class="table"><thead><tr><th>ID</th><th>User</th><th>Item</th><th>Amount</th><th>Status</th><th>Reference</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No payments found.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Payments & Delivery', body, req.query.msg));
});


app.post('/admin-web/payments/:id/approve', async (req, res) => {
  try {
    const msg = await webApprovePayment(db.payments.find(p => p.id === req.params.id));
    redirectMsg(res, '/admin-web/payments', msg);
  } catch (err) {
    redirectMsg(res, '/admin-web/payments', err.message);
  }
});

app.post('/admin-web/payments/:id/force', async (req, res) => {
  try {
    const msg = await approveAndDeliverPayment(db.payments.find(p => p.id === req.params.id), { approvedBy: 'web-force-deliver', method: 'Web Force Deliver' });
    redirectMsg(res, '/admin-web/payments', msg);
  } catch (err) {
    redirectMsg(res, '/admin-web/payments', err.message);
  }
});

app.post('/admin-web/payments/:id/resend', async (req, res) => {
  const order = findOrderByPaymentId(req.params.id);
  if (!order) return redirectMsg(res, '/admin-web/payments', 'No delivered order found for this payment yet');
  try {
    await sendDeliveryMessage(order.telegramId, order.productName, order.qty, order.total, order.currency, order.deliveredItems || [], order.id, order.productCode);
    redirectMsg(res, '/admin-web/payments', 'Delivery resent to user');
  } catch (err) {
    redirectMsg(res, '/admin-web/payments', 'Resend failed: ' + err.message);
  }
});

app.get('/admin-web/delivery-repair', (req, res) => {
  const list = undeliveredPayments();
  const rows = list.map(p => `<tr><td><b>${webEsc(p.id)}</b><br>${webEsc(p.status)}</td><td>${webEsc(p.telegramId)}</td><td>${webEsc(p.productName)}</td><td>${webMoney(p.amount)}</td><td>${webEsc(p.submittedReference || p.note || '-')}</td><td><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/force"><button class="btn">Approve + Deliver</button></form></td></tr>`).join('');
  const body = `<div class="card"><h3>🚑 Delivery Repair Tool</h3><p class="muted">This page shows payments that do not have an order/delivery yet. Use it when payment is received but product did not deliver.</p></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Payment</th><th>User</th><th>Product</th><th>Amount</th><th>Ref</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No undelivered payments found.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Delivery Repair', body, req.query.msg));
});



app.post('/admin-web/payments/:id/reject', async (req, res) => {
  try {
    const msg = await webRejectPayment(db.payments.find(p => p.id === req.params.id));
    redirectMsg(res, '/admin-web/payments', msg);
  } catch (err) {
    redirectMsg(res, '/admin-web/payments', err.message);
  }
});

app.get('/admin-web/methods', (req, res) => {
  const rows = db.paymentMethods.map(m => `<tr><td><b>${webEsc(m.id)}</b><br>${m.active === false ? '🔴 OFF' : '🟢 ON'}</td><td>${webEsc(m.icon || '💳')} ${webEsc(m.name)}</td><td><span class="code">${webEsc(m.key || '')}</span></td><td>${webEsc(short(m.details || '', 80))}</td><td><form method="post" action="/admin-web/methods/${encodeURIComponent(m.id)}/update"><div class="row"><input name="name" value="${webEsc(m.name)}"><input name="icon" value="${webEsc(m.icon || '')}"><input name="key" value="${webEsc(m.key || '')}"></div><textarea name="details">${webEsc(m.details || '')}</textarea><select name="active"><option value="true" ${m.active !== false ? 'selected' : ''}>ON</option><option value="false" ${m.active === false ? 'selected' : ''}>OFF</option></select><button class="btn">Save</button></form><form method="post" action="/admin-web/methods/${encodeURIComponent(m.id)}/delete" onsubmit="return confirm('Delete method?')"><button class="btn danger">Delete</button></form></td></tr>`).join('');
  const body = `<div class="card"><h3>➕ Add Payment Method</h3><form method="post" action="/admin-web/methods/add"><div class="row"><input name="name" placeholder="USDT BEP20"><input name="icon" placeholder="🟨"><input name="key" placeholder="USDT_BEP20"></div><textarea name="details" placeholder="Payment address or instructions"></textarea><button class="btn">Add Method</button></form></div><br><div class="tableWrap"><table class="table"><thead><tr><th>ID</th><th>Name</th><th>Key</th><th>Details</th><th>Edit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  res.send(adminLayout('Payment Methods', body, req.query.msg));
});

app.post('/admin-web/methods/add', (req, res) => {
  const m = { id: nextPaymentMethodId(), name: String(req.body.name || 'New Method').trim(), icon: String(req.body.icon || '💳').trim().slice(0,8), key: String(req.body.key || 'MANUAL').trim().toUpperCase().replace(/\s+/g,'_'), details: String(req.body.details || '').trim(), active: true };
  db.paymentMethods.push(m);
  saveData();
  redirectMsg(res, '/admin-web/methods', 'Payment method added');
});

app.post('/admin-web/methods/:id/update', (req, res) => {
  const m = db.paymentMethods.find(x => x.id === req.params.id);
  if (!m) return redirectMsg(res, '/admin-web/methods', 'Method not found');
  m.name = String(req.body.name || m.name).trim();
  m.icon = String(req.body.icon || m.icon || '💳').trim().slice(0,8);
  m.key = String(req.body.key || m.key || 'MANUAL').trim().toUpperCase().replace(/\s+/g,'_');
  m.details = String(req.body.details || '').trim();
  m.active = String(req.body.active) === 'false' ? false : true;
  saveData();
  redirectMsg(res, '/admin-web/methods', 'Method updated');
});

app.post('/admin-web/methods/:id/delete', (req, res) => {
  const i = db.paymentMethods.findIndex(x => x.id === req.params.id);
  if (i >= 0) { db.paymentMethods.splice(i, 1); saveData(); }
  redirectMsg(res, '/admin-web/methods', 'Payment method deleted');
});

app.get('/admin-web/settings', (req, res) => {
  const body = `<div class="card"><form method="post" action="/admin-web/settings">
    <h3>🏪 Core Store Settings</h3>
    <div class="row"><div><label>Store Name</label><input name="storeName" value="${webEsc(getStoreName())}" placeholder="My Digital Store"></div><div><label>Bot Token</label><input name="botToken" value="${webEsc(getBotToken())}" placeholder="123456:ABC-DEF..." type="password"></div></div>
    <div class="row"><div><label>Admin Telegram ID</label><input name="adminId" value="${webEsc(getAdminId())}" placeholder="123456789"></div><div><label>Currency</label><input name="currency" value="${webEsc(currency())}"></div></div>
    <div class="row"><div><label>Admin Web Username</label><input name="adminWebUser" value="${webEsc(getAdminWebUser())}" placeholder="admin"></div><div><label>Admin Web Password</label><input name="adminWebPassword" type="password" placeholder="Leave blank to keep current" autocomplete="new-password"></div></div>
    <p class="muted small">⚠️ Changing Bot Token or Admin ID will take effect after restart (or next Vercel cold start). Admin Web credentials take effect immediately.</p>
    <h3>⚙️ Bot Identity</h3>
    <div class="row"><div><label>Bot Username</label><input name="botUsername" value="${webEsc(getBotUsername() || '')}"></div><div><label>Support Username</label><input name="supportUsername" value="${webEsc(db.settings.supportUsername || SUPPORT_USERNAME)}"></div></div>
    <div class="row"><div><label>Channel URL</label><input name="channelUrl" value="${webEsc(db.settings.channelUrl || CHANNEL_URL)}"></div><div><label>Web Base URL</label><input name="webBaseUrl" value="${webEsc(webBaseUrl())}" placeholder="https://your-domain.com"></div></div>
    <h3>⏳ Payment Expiry + Stock Wait</h3>
    <div class="row"><div><label>Pending Payment Valid Minutes</label><input name="paymentExpiryMinutes" type="number" value="${webEsc(db.settings.paymentExpiryMinutes || 30)}"></div><div><label>Notify User On Expiry</label><select name="pendingExpiryNotifyUser"><option value="true" ${db.settings.pendingExpiryNotifyUser === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.pendingExpiryNotifyUser === false ? 'selected' : ''}>OFF</option></select></div><div><label>Stock Wait Auto Delivery</label><select name="stockWaitAutoDelivery"><option value="true" ${db.settings.stockWaitAutoDelivery === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.stockWaitAutoDelivery === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Notify User On Stock Wait</label><select name="stockWaitNotifyUser"><option value="true" ${db.settings.stockWaitNotifyUser === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.stockWaitNotifyUser === false ? 'selected' : ''}>OFF</option></select></div><div><label>Deliver Waiting Orders First</label><select name="stockWaitPriorityFirst"><option value="true" ${db.settings.stockWaitPriorityFirst === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.stockWaitPriorityFirst === false ? 'selected' : ''}>OFF</option></select></div></div>
    <h3>⚡ Health / Speed / Safe Delivery</h3>
    <div class="row"><div><label>Health Check</label><select name="healthCheckEnabled"><option value="true" ${db.settings.healthCheckEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.healthCheckEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Speed Warning MS</label><input name="speedWarnMs" type="number" value="${webEsc(db.settings.speedWarnMs || 2500)}"></div><div><label>Attractive System Messages</label><select name="attractiveSystemMessages"><option value="true" ${db.settings.attractiveSystemMessages === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.attractiveSystemMessages === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Safe Delivery</label><select name="safeDeliveryEnabled"><option value="true" ${db.settings.safeDeliveryEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.safeDeliveryEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Delivery Failure Auto Review</label><select name="deliveryFailureAutoReview"><option value="true" ${db.settings.deliveryFailureAutoReview === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.deliveryFailureAutoReview === false ? 'selected' : ''}>OFF</option></select></div><div><label>Delivery Retry Limit</label><input name="deliveryRetryLimit" type="number" value="${webEsc(db.settings.deliveryRetryLimit || 3)}"></div></div>
    <h3>👥 Group Alert Settings</h3>
    <div class="row"><div><label>Auto Register Groups</label><select name="autoRegisterGroups"><option value="true" ${db.settings.autoRegisterGroups === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoRegisterGroups === false ? 'selected' : ''}>OFF</option></select></div><div><label>Group Alerts</label><select name="groupAlertsEnabled"><option value="true" ${db.settings.groupAlertsEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupAlertsEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Keyword Reply</label><select name="groupKeywordReplyEnabled"><option value="true" ${db.settings.groupKeywordReplyEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupKeywordReplyEnabled === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Alert Cooldown Minutes</label><input name="groupAlertCooldownMinutes" type="number" value="${webEsc(db.settings.groupAlertCooldownMinutes || 10)}"></div><div><label>Keyword Cooldown Minutes</label><input name="groupKeywordCooldownMinutes" type="number" value="${webEsc(db.settings.groupKeywordCooldownMinutes || 3)}"></div><div><label>Welcome When Added</label><select name="groupWelcomeOnRegister"><option value="true" ${db.settings.groupWelcomeOnRegister === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupWelcomeOnRegister === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Direct Buy Keyboard</label><select name="groupReplyDirectBuyKeyboard"><option value="true" ${db.settings.groupReplyDirectBuyKeyboard === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupReplyDirectBuyKeyboard === false ? 'selected' : ''}>OFF</option></select></div><div><label>Reply Only Registered Groups</label><select name="groupReplyOnlyRegisteredGroups"><option value="false" ${db.settings.groupReplyOnlyRegisteredGroups === true ? '' : 'selected'}>OFF</option><option value="true" ${db.settings.groupReplyOnlyRegisteredGroups === true ? 'selected' : ''}>ON</option></select></div><div><label>Support Button In Replies</label><select name="groupReplyWithSupportButton"><option value="true" ${db.settings.groupReplyWithSupportButton === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupReplyWithSupportButton === false ? 'selected' : ''}>OFF</option></select></div></div>
    <h3>🚚 Global Delivery Message</h3>
    <label>Global Delivery Message Template</label><textarea name="deliveryMessageTemplate" placeholder="Leave empty for default. Variables: {product}, {qty}, {total}, {order_id}, {delivery_type}, {items}, {support}, {store}, {bot}, {note}">${webEsc(db.settings.deliveryMessageTemplate || '')}</textarea>
    <label>After Delivery Note</label><input name="afterDeliveryNote" value="${webEsc(db.settings.afterDeliveryNote || '')}" placeholder="Please save your details safely.">
    <h3>📊 Premium Alert Message Templates</h3>
    <label>Global Stock Alert Template</label><textarea name="premiumStockAlertTemplate" placeholder="Leave empty for default. Variables: {emoji}, {name}, {price}, {stock}, {added}, {buy_link}, {bot}">${webEsc(db.settings.premiumStockAlertTemplate || '')}</textarea>
    <label>Global Flash Sale Template</label><textarea name="premiumFlashSaleTemplate" placeholder="Leave empty for default. Variables: {emoji}, {name}, {old_price}, {sale_price}, {stock}, {ends}, {buy_link}">${webEsc(db.settings.premiumFlashSaleTemplate || '')}</textarea>
    <label>Global Group Reply Template</label><textarea name="premiumGroupReplyTemplate" placeholder="Leave empty for default. Used when someone writes Gemini/ChatGPT in group.">${webEsc(db.settings.premiumGroupReplyTemplate || '')}</textarea>
    <label>Alert Footer Text</label><input name="alertFooterText" value="${webEsc(db.settings.alertFooterText || '')}" placeholder="Fast checkout • Auto delivery • Premium support">
    <h3>✨ Product Description Settings</h3>
    <div class="row"><div><label>Auto Detailed Description Fallback</label><select name="autoDetailedDescriptions"><option value="true" ${db.settings.autoDetailedDescriptions === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoDetailedDescriptions === false ? 'selected' : ''}>OFF</option></select></div><div><label>Description Style</label><select name="productDescriptionStyle"><option value="premium_detailed" selected>Premium Detailed</option></select></div></div>
    <h3>🏆 Loyalty Settings</h3>
    <div class="row"><div><label>Loyalty Points</label><select name="loyaltyEnabled"><option value="true" ${db.settings.loyaltyEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.loyaltyEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Points Per $1</label><input name="loyaltyPointsPerDollar" type="number" step="1" value="${webEsc(db.settings.loyaltyPointsPerDollar || 1)}"></div></div>
    <h3>💾 Auto Backup Settings</h3>
    <div class="row"><div><label>Auto Backup</label><select name="autoBackupEnabled"><option value="true" ${db.settings.autoBackupEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoBackupEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Backup Interval Hours</label><input name="autoBackupIntervalHours" type="number" value="${webEsc(db.settings.autoBackupIntervalHours || 6)}"></div><div><label>Max Backup Files</label><input name="autoBackupMaxFiles" type="number" value="${webEsc(db.settings.autoBackupMaxFiles || 30)}"></div></div>
    <h3>🛡 Security Settings</h3>
    <div class="row"><div><label>Rate Limit Protection</label><select name="securityRateLimitEnabled"><option value="true" ${db.settings.securityRateLimitEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.securityRateLimitEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Auto Review Suspicious Payments</label><select name="autoLockSuspiciousPayments"><option value="true" ${db.settings.autoLockSuspiciousPayments === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoLockSuspiciousPayments === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Messages / Minute</label><input name="userMessageLimitPerMin" type="number" value="${webEsc(db.settings.userMessageLimitPerMin || 30)}"></div><div><label>Button Clicks / Minute</label><input name="userCallbackLimitPerMin" type="number" value="${webEsc(db.settings.userCallbackLimitPerMin || 50)}"></div><div><label>Verify Attempts / 10 Min</label><input name="paymentVerifyLimitPer10Min" type="number" value="${webEsc(db.settings.paymentVerifyLimitPer10Min || 6)}"></div></div>
    <div class="row"><div><label>TXID Submits / 15 Min</label><input name="txidSubmitLimitPer15Min" type="number" value="${webEsc(db.settings.txidSubmitLimitPer15Min || 5)}"></div><div><label>Failed Verify → Review Threshold</label><input name="paymentFailReviewThreshold" type="number" value="${webEsc(db.settings.paymentFailReviewThreshold || 5)}"></div><div><label>Security Alerts To Admins</label><select name="securityAlertsToAdmins"><option value="true" ${db.settings.securityAlertsToAdmins === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.securityAlertsToAdmins === false ? 'selected' : ''}>OFF</option></select></div></div>
    <h3>💳 Payment Verification Mode</h3>
    <div class="row"><div><label>Active Verify Mode</label><select name="paymentVerifyMode"><option value="both" ${paymentVerifyMode() === 'both' ? 'selected' : ''}>🛡 Safe Dual: Auto Note + TXID</option><option value="auto" ${paymentVerifyMode() === 'auto' ? 'selected' : ''}>🤖 Auto Note Verify Default</option><option value="txid" ${paymentVerifyMode() === 'txid' ? 'selected' : ''}>🧾 TXID Verify Default</option></select></div><div><label>BEP20 / BSC Wallet Address</label><input name="bep20Address" value="${webEsc(db.settings.bep20Address || '')}"></div></div>
    <p class="muted small">Safe Dual is recommended: users see both Auto Verify and TXID. Auto Verify approves only exact Reference Note + amount, never amount-only.</p>
    <h3>🇮🇳 UPI Payment Settings</h3>
    <div class="row"><div><label>UPI ID</label><input name="upiId" value="${webEsc(db.settings.upiId || getUpiId())}" placeholder="yourupi@paytm"></div><div><label>UPI Payee Name</label><input name="upiName" value="${webEsc(db.settings.upiName || getUpiName())}" placeholder="Global Store"></div></div>
    <label>Custom UPI QR Code Image URL (optional)</label><input name="upiQrUrl" value="${webEsc(db.settings.upiQrUrl || '')}" placeholder="https://.../qr.png (leave blank for auto QR generation)">
    <label>Direct Payment Gateway / Link (optional)</label><input name="paymentLink" value="${webEsc(db.settings.paymentLink || PAYMENT_LINK || '')}" placeholder="https://pay.example.com">
    <h3>Binance Settings</h3>
    <div class="row"><input name="binanceId" placeholder="Binance UID" value="${webEsc(db.settings.binanceId || '')}"><input name="binanceName" placeholder="Binance Name" value="${webEsc(db.settings.binanceName || '')}"><input name="binanceCoin" placeholder="USDT" value="${webEsc(db.settings.binanceCoin || 'USDT')}"></div>
    <div class="row"><input name="binanceBaseUrl" value="${webEsc(db.settings.binanceBaseUrl || BINANCE_BASE_URL)}"><input name="binanceLookbackDays" type="number" value="${webEsc(db.settings.binanceLookbackDays || 7)}"><input name="binanceAmountTolerance" type="number" step="0.01" value="${webEsc(db.settings.binanceAmountTolerance || 0.02)}"></div>
    <label>Binance API Key (leave blank to keep current)</label><input name="binanceApiKey" placeholder="${webEsc(mask(db.settings.binanceApiKey || process.env.BINANCE_API_KEY || ''))}">
    <label>Binance Secret Key (leave blank to keep current)</label><input name="binanceSecretKey" placeholder="${webEsc(mask(db.settings.binanceSecretKey || process.env.BINANCE_SECRET_KEY || ''))}">
    <h3>⚡ No TXID Verify Mode</h3>
    <div class="row"><div><label>No TXID Mode</label><select name="noTxidMode"><option value="true" ${db.settings.noTxidMode === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.noTxidMode === false ? 'selected' : ''}>OFF</option></select></div><div><label>Optional Unique Amount</label><select name="uniqueAmountEnabled"><option value="false" ${db.settings.uniqueAmountEnabled === true ? '' : 'selected'}>OFF - Normal Amount</option><option value="true" ${db.settings.uniqueAmountEnabled === true ? 'selected' : ''}>ON - Unique Amount</option></select></div></div>
    <div class="row"><div><label>Unique Suffix Max /1000</label><input name="uniqueAmountMaxCents" type="number" min="9" max="999" value="${webEsc(db.settings.uniqueAmountMaxCents || 99)}"></div><div><label>Amount Match Tolerance</label><input name="noTxidTolerance" type="number" step="0.0001" value="${webEsc(db.settings.noTxidTolerance || 0.001)}"></div></div>
    <p class="muted small">V41 default is Normal Amount. User pays the product/deposit amount, then clicks Verify. Unique Amount is optional and OFF by default.</p>
    <h3>🤖 Full Auto Binance Verification</h3>
    <div class="row"><div><label>Auto Verify Scanner</label><select name="autoVerifyEnabled"><option value="true" ${db.settings.autoVerifyEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoVerifyEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Scan Interval Seconds</label><input name="autoVerifyIntervalSec" type="number" min="10" value="${webEsc(db.settings.autoVerifyIntervalSec || 25)}"></div></div>
    <div class="row"><div><label>Unique Amount Match</label><select name="autoVerifyAmountMatch"><option value="true" ${db.settings.autoVerifyAmountMatch === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.autoVerifyAmountMatch === false ? 'selected' : ''}>OFF</option></select></div><div><label>Max Age Hours</label><input name="autoVerifyMaxAgeHours" type="number" min="1" value="${webEsc(db.settings.autoVerifyMaxAgeHours || 24)}"></div></div>
    <p class="muted small">Auto scanner checks pending order/deposit payments every few seconds. TXID/reference match is safest. Unique amount match works only when exactly one Binance transaction matches the amount/time.</p>
    <h3>💎 Premium UI + Group Alerts</h3>
    <div class="row"><div><label>Premium Product Cards</label><select name="premiumProductCards"><option value="true" ${db.settings.premiumProductCards === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.premiumProductCards === false ? 'selected' : ''}>OFF</option></select></div><div><label>Group Keyword Auto Reply</label><select name="groupAutoReplyEnabled"><option value="true" ${db.settings.groupAutoReplyEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.groupAutoReplyEnabled === false ? 'selected' : ''}>OFF</option></select></div></div>
    <div class="row"><div><label>Purchase Public Alerts</label><select name="purchaseAlertsEnabled"><option value="true" ${db.settings.purchaseAlertsEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.purchaseAlertsEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Public Alert Chat IDs / Groups / Channels</label><textarea name="publicAlertChatIds" placeholder="@channel or -100groupid">${webEsc(db.settings.publicAlertChatIds || '')}</textarea></div></div>
    <p class="muted small">Group keyword reply works when bot can read group messages. Disable privacy in BotFather or mention the bot in group.</p>
    <h3>Channel Notifications & Auto Reply</h3>
    <label>Channel usernames or IDs (one per line or comma separated)</label><textarea name="channelIds" placeholder="@yourchannel or -100xxxxxxxx">${webEsc(db.settings.channelIds || '')}</textarea>
    <div class="row"><div><label>Channel Stock/Announcement Alerts</label><select name="channelAlertsEnabled"><option value="true" ${db.settings.channelAlertsEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.channelAlertsEnabled === false ? 'selected' : ''}>OFF</option></select></div><div><label>Channel Auto Reply</label><select name="channelAutoReplyEnabled"><option value="true" ${db.settings.channelAutoReplyEnabled === false ? '' : 'selected'}>ON</option><option value="false" ${db.settings.channelAutoReplyEnabled === false ? 'selected' : ''}>OFF</option></select></div></div>
    <p class="muted small">Add bot as Admin in the channel with permission to post messages. For auto reply, bot must receive channel posts.</p>
    <h3>⏳ Payment Reminder</h3>
    <label>Reminder after minutes</label><input name="paymentReminderMinutes" type="number" min="0" value="${webEsc(db.settings.paymentReminderMinutes || 3)}">
    <p class="muted small">Set 0 to disable automatic unpaid payment reminders.</p>
    <h3>FAQ / Help Text</h3>
    <label>FAQ shown to users</label><textarea name="faqText">${webEsc(db.settings.faqText || '')}</textarea>
    <h3>Store Notice & Featured Product</h3>
    <label>Store Notice shown on user welcome</label><textarea name="storeNotice">${webEsc(db.settings.storeNotice || '')}</textarea>
    <div class="row"><div><label>Featured Product Code</label><input name="featuredProductCode" value="${webEsc(db.settings.featuredProductCode || '')}" placeholder="P003"></div><div><label>Low Stock Threshold</label><input name="lowStockThreshold" type="number" value="${webEsc(db.settings.lowStockThreshold || 2)}"></div></div>
    <h3>Maintenance Mode</h3>
    <select name="maintenanceMode"><option value="false" ${db.settings.maintenanceMode ? '' : 'selected'}>OFF</option><option value="true" ${db.settings.maintenanceMode ? 'selected' : ''}>ON</option></select>
    <label>Maintenance Message</label><textarea name="maintenanceMessage">${webEsc(db.settings.maintenanceMessage || '')}</textarea>
    <button class="btn">Save Settings</button>
  </form></div>`;
  res.send(adminLayout('Bot Settings', body, req.query.msg));
});

app.post('/admin-web/settings', (req, res) => {
  // Core store settings (editable from panel)
  if (String(req.body.storeName || '').trim()) db.settings.storeName = String(req.body.storeName).trim();
  if (String(req.body.botToken || '').trim()) db.settings.botToken = String(req.body.botToken).trim();
  if (String(req.body.adminId || '').trim()) db.settings.adminId = String(req.body.adminId).trim();
  if (String(req.body.adminWebUser || '').trim()) db.settings.adminWebUser = String(req.body.adminWebUser).trim();
  if (String(req.body.adminWebPassword || '').trim()) db.settings.adminWebPassword = String(req.body.adminWebPassword).trim();
  db.settings.botUsername = String(req.body.botUsername || '').replace('@','').trim();
  db.settings.storeCurrency = String(req.body.currency || currency()).toUpperCase().trim();
  db.settings.supportUsername = String(req.body.supportUsername || SUPPORT_USERNAME).trim();
  db.settings.webBaseUrl = String(req.body.webBaseUrl || '').trim().replace(/\/$/, '');
  db.settings.paymentExpiryMinutes = Number(req.body.paymentExpiryMinutes || 30);
  db.settings.pendingExpiryNotifyUser = String(req.body.pendingExpiryNotifyUser) === 'false' ? false : true;
  db.settings.stockWaitAutoDelivery = String(req.body.stockWaitAutoDelivery) === 'false' ? false : true;
  db.settings.stockWaitNotifyUser = String(req.body.stockWaitNotifyUser) === 'false' ? false : true;
  db.settings.stockWaitPriorityFirst = String(req.body.stockWaitPriorityFirst) === 'false' ? false : true;
  db.settings.healthCheckEnabled = String(req.body.healthCheckEnabled) === 'false' ? false : true;
  db.settings.speedWarnMs = Number(req.body.speedWarnMs || 2500);
  db.settings.attractiveSystemMessages = String(req.body.attractiveSystemMessages) === 'false' ? false : true;
  db.settings.safeDeliveryEnabled = String(req.body.safeDeliveryEnabled) === 'false' ? false : true;
  db.settings.deliveryFailureAutoReview = String(req.body.deliveryFailureAutoReview) === 'false' ? false : true;
  db.settings.deliveryRetryLimit = Number(req.body.deliveryRetryLimit || 3);
  db.settings.channelUrl = String(req.body.channelUrl || CHANNEL_URL).trim();
  db.settings.autoRegisterGroups = String(req.body.autoRegisterGroups) === 'false' ? false : true;
  db.settings.groupAlertsEnabled = String(req.body.groupAlertsEnabled) === 'false' ? false : true;
  db.settings.groupKeywordReplyEnabled = String(req.body.groupKeywordReplyEnabled) === 'false' ? false : true;
  db.settings.groupWelcomeOnRegister = String(req.body.groupWelcomeOnRegister) === 'false' ? false : true;
  db.settings.groupReplyDirectBuyKeyboard = String(req.body.groupReplyDirectBuyKeyboard) === 'false' ? false : true;
  db.settings.groupReplyOnlyRegisteredGroups = String(req.body.groupReplyOnlyRegisteredGroups) === 'true' ? true : false;
  db.settings.groupReplyWithSupportButton = String(req.body.groupReplyWithSupportButton) === 'false' ? false : true;
  db.settings.groupAlertCooldownMinutes = Number(req.body.groupAlertCooldownMinutes || 10);
  db.settings.groupKeywordCooldownMinutes = Number(req.body.groupKeywordCooldownMinutes || 3);
  db.settings.deliveryMessageTemplate = String(req.body.deliveryMessageTemplate || '').trim();
  db.settings.afterDeliveryNote = String(req.body.afterDeliveryNote || '').trim();
  db.settings.premiumStockAlertTemplate = String(req.body.premiumStockAlertTemplate || '').trim();
  db.settings.premiumFlashSaleTemplate = String(req.body.premiumFlashSaleTemplate || '').trim();
  db.settings.premiumGroupReplyTemplate = String(req.body.premiumGroupReplyTemplate || '').trim();
  db.settings.alertFooterText = String(req.body.alertFooterText || 'Fast checkout • Auto delivery • Premium support').trim();
  db.settings.autoDetailedDescriptions = String(req.body.autoDetailedDescriptions) === 'false' ? false : true;
  db.settings.productDescriptionStyle = String(req.body.productDescriptionStyle || 'premium_detailed').trim();
  db.settings.loyaltyEnabled = String(req.body.loyaltyEnabled) === 'false' ? false : true;
  db.settings.loyaltyPointsPerDollar = Number(req.body.loyaltyPointsPerDollar || 1);
  db.settings.autoBackupEnabled = String(req.body.autoBackupEnabled) === 'false' ? false : true;
  db.settings.autoBackupIntervalHours = Number(req.body.autoBackupIntervalHours || 6);
  db.settings.autoBackupMaxFiles = Number(req.body.autoBackupMaxFiles || 30);
  db.settings.securityRateLimitEnabled = String(req.body.securityRateLimitEnabled) === 'false' ? false : true;
  db.settings.autoLockSuspiciousPayments = String(req.body.autoLockSuspiciousPayments) === 'false' ? false : true;
  db.settings.userMessageLimitPerMin = Number(req.body.userMessageLimitPerMin || 30);
  db.settings.userCallbackLimitPerMin = Number(req.body.userCallbackLimitPerMin || 50);
  db.settings.paymentVerifyLimitPer10Min = Number(req.body.paymentVerifyLimitPer10Min || 6);
  db.settings.txidSubmitLimitPer15Min = Number(req.body.txidSubmitLimitPer15Min || 5);
  db.settings.paymentFailReviewThreshold = Number(req.body.paymentFailReviewThreshold || 5);
  db.settings.securityAlertsToAdmins = String(req.body.securityAlertsToAdmins) === 'false' ? false : true;
  db.settings.paymentVerifyMode = ['auto','txid','both'].includes(String(req.body.paymentVerifyMode || 'both').toLowerCase()) ? String(req.body.paymentVerifyMode || 'both').toLowerCase() : 'both';
  db.settings.bep20Address = String(req.body.bep20Address || '').trim();
  db.settings.upiId = String(req.body.upiId || UPI_ID).trim();
  db.settings.upiName = String(req.body.upiName || UPI_NAME).trim();
  db.settings.upiQrUrl = String(req.body.upiQrUrl || '').trim();
  db.settings.paymentLink = String(req.body.paymentLink || '').trim();
  db.settings.binanceId = String(req.body.binanceId || '').trim();
  db.settings.binanceName = String(req.body.binanceName || '').trim();
  db.settings.binanceCoin = String(req.body.binanceCoin || 'USDT').toUpperCase().trim();
  db.settings.binanceBaseUrl = String(req.body.binanceBaseUrl || BINANCE_BASE_URL).trim().replace(/\/$/, '');
  db.settings.binanceLookbackDays = Number(req.body.binanceLookbackDays || 7);
  db.settings.binanceAmountTolerance = Number(req.body.binanceAmountTolerance || 0.02);
  db.settings.noTxidMode = String(req.body.noTxidMode) === 'false' ? false : true;
  db.settings.uniqueAmountEnabled = String(req.body.uniqueAmountEnabled) === 'true';
  db.settings.uniqueAmountMaxCents = Number(req.body.uniqueAmountMaxCents || 99);
  db.settings.noTxidTolerance = Number(req.body.noTxidTolerance || 0.001);
  db.settings.premiumProductCards = String(req.body.premiumProductCards) === 'false' ? false : true;
  db.settings.groupAutoReplyEnabled = String(req.body.groupAutoReplyEnabled) === 'false' ? false : true;
  db.settings.purchaseAlertsEnabled = String(req.body.purchaseAlertsEnabled) === 'false' ? false : true;
  db.settings.publicAlertChatIds = String(req.body.publicAlertChatIds || '').trim();
  db.settings.autoVerifyEnabled = String(req.body.autoVerifyEnabled) === 'false' ? false : true;
  db.settings.autoVerifyIntervalSec = Number(req.body.autoVerifyIntervalSec || 25);
  db.settings.autoVerifyAmountMatch = String(req.body.autoVerifyAmountMatch) === 'false' ? false : true;
  db.settings.autoVerifyMaxAgeHours = Number(req.body.autoVerifyMaxAgeHours || 24);
  db.settings.channelIds = String(req.body.channelIds || '').trim();
  db.settings.channelAlertsEnabled = String(req.body.channelAlertsEnabled) === 'false' ? false : true;
  db.settings.channelAutoReplyEnabled = String(req.body.channelAutoReplyEnabled) === 'false' ? false : true;
  db.settings.paymentReminderMinutes = Number(req.body.paymentReminderMinutes || 0);
  db.settings.faqText = String(req.body.faqText || '').trim();
  db.settings.storeNotice = String(req.body.storeNotice || '').trim();
  db.settings.featuredProductCode = String(req.body.featuredProductCode || '').trim().toUpperCase();
  db.settings.lowStockThreshold = Number(req.body.lowStockThreshold || 2);
  db.settings.maintenanceMode = String(req.body.maintenanceMode) === 'true';
  db.settings.maintenanceMessage = String(req.body.maintenanceMessage || 'Store is under maintenance. Please try again later.').trim();
  if (String(req.body.binanceApiKey || '').trim()) db.settings.binanceApiKey = String(req.body.binanceApiKey).trim();
  if (String(req.body.binanceSecretKey || '').trim()) db.settings.binanceSecretKey = String(req.body.binanceSecretKey).trim();
  db.products.forEach((p) => { p.currency = db.settings.storeCurrency; });
  saveData();
  redirectMsg(res, '/admin-web/settings', 'Settings saved');
});




app.get('/admin-web/payment-risk', (req, res) => {
  const r = paymentRiskSummary();
  const priority = [...new Map([...r.needsTxid, ...r.old, ...r.expired, ...r.pending].map(p => [p.id, p])).values()];
  const rows = priority.slice(0, 200).map(p => `<tr><td><b>${webEsc(p.id)}</b><br><span class="muted">${webEsc(p.type || 'payment')} · ${paymentAgeMinutes(p)}m old</span></td><td><span class="code">${webEsc(p.telegramId)}</span><br>${webEsc(db.users?.[String(p.telegramId)]?.username || '')}</td><td>${webMoney(p.amount)}</td><td>${webEsc(p.status)}</td><td>${webEsc(p.lastCheckReason || '-')}</td><td><form method="post" action="/admin-web/payments/${encodeURIComponent(p.id)}/force"><button class="btn">Force Approve/Deliver</button></form></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🚨 Payment Risk Center</h2><div class="muted">Find stuck, expired, duplicate and TXID-needed payments.</div><div class="kpiLine"><span>${r.pending.length} pending</span><span>${r.needsTxid.length} need TXID</span><span>${r.old.length} old 30m+</span><span>${r.expired.length} expired</span><span>${r.duplicateAmounts.length} same amount groups</span></div></div>
  <div class="card"><form method="post" action="/admin-web/payment-risk/expire-old"><button class="btn danger">Expire Pending Older Than 60 Minutes</button></form></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Payment</th><th>User</th><th>Amount</th><th>Status</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No risky payments.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Payment Risk Center', body, req.query.msg));
});

app.post('/admin-web/payment-risk/expire-old', (req, res) => {
  const count = expireOldPendingPayments(60);
  addWebAudit('expire_old_pending_payments', { count }, req);
  redirectMsg(res, '/admin-web/payment-risk', `Expired ${count} old payment(s).`);
});

app.get('/admin-web/quick-find', (req, res) => {
  const q = String(req.query.q || '').trim();
  const result = q ? quickFindText(q).replace(/\n/g, '<br>') : 'Search order, payment, user or product.';
  const body = `<div class="heroPanel"><h2>🔎 Quick Find</h2><div class="muted">Search by order ID, payment ID, TXID, user ID, username, product code or product name.</div></div>
  <div class="card"><form method="get" action="/admin-web/quick-find"><input name="q" value="${webEsc(q)}" placeholder="ORD..., PAY..., TXID, user ID, @username, P001"><button class="btn">Search</button></form></div><br>
  <div class="card"><h3>Result</h3><p>${result}</p></div>`;
  res.send(adminLayout('Quick Find', body, req.query.msg));
});


app.get('/admin-web/orders', (req, res) => {
  const all = filterWebOrders(req.query);
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.max(20, Math.min(300, Number(req.query.limit || 100)));
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const safe = Math.min(page, totalPages);
  const list = all.slice((safe - 1) * pageSize, safe * pageSize);
  const s = orderStats(all);
  const q = webEsc(req.query.q || '');
  const user = webEsc(req.query.user || '');
  const product = webEsc(req.query.product || '');
  const status = webEsc(req.query.status || '');
  const from = webEsc(req.query.from || '');
  const to = webEsc(req.query.to || '');
  const qs = new URLSearchParams(req.query);
  qs.delete('page');

  const rows = list.map(o => {
    const u = db.users[String(o.telegramId)] || {};
    const review = typeof findReviewByOrder === 'function' ? findReviewByOrder(o.id) : null;
    return `<tr><td><b>${webEsc(o.id)}</b><br><span class="muted">${webEsc(new Date(o.createdAt).toLocaleString())}</span><br><span class="muted">${webEsc(orderStatusLabel(o))}</span></td><td>${webEsc(u.firstName || 'User')}<br>${u.username ? '@'+webEsc(u.username) : ''}<br><span class="code">${webEsc(o.telegramId)}</span></td><td>${webEsc(o.productName)}<br><span class="muted">Qty ${o.qty} · ${webEsc(o.couponCode || '-')}</span><br><span class="code">${webEsc(o.productCode || '-')}</span></td><td>${webMoney(o.total)}</td><td>${review ? ratingStars(review.rating) + ' ' + webEsc(review.rating) + '/5' : '-'}</td><td><span class="code">${webEsc(formatDeliveredItems(o.deliveredItems || []).slice(0, 120))}</span></td><td class="actions"><form method="post" action="/admin-web/orders/${encodeURIComponent(o.id)}/resend"><button class="btn">Resend</button></form><a class="btn secondary" href="/admin-web/orders/${encodeURIComponent(o.id)}/delivery">View TXT</a><a class="btn secondary" href="/admin-web/users?q=${encodeURIComponent(o.telegramId)}">User</a></td></tr>`;
  }).join('');

  const body = `<div class="heroPanel"><h2>🧾 Admin Order History</h2><div class="muted">Search, filter, export and resend deliveries from one place.</div><div class="kpiLine"><span>${s.total} orders</span><span>${s.qty} qty sold</span><span>${webMoney(s.revenue)} revenue</span><span>${s.top ? webEsc(s.top.name) + ' top' : 'No top product'}</span></div></div>
  <div class="card"><form method="get" action="/admin-web/orders">
    <div class="row"><input name="q" value="${q}" placeholder="Search order/user/product/payment"><input name="user" value="${user}" placeholder="User ID or username"><input name="product" value="${product}" placeholder="Product code/name"></div>
    <div class="row"><select name="status"><option value="">All status</option><option value="paid" ${status==='paid'?'selected':''}>Paid/Delivered</option><option value="replacement" ${status==='replacement'?'selected':''}>Replacement</option></select><input name="from" type="date" value="${from}"><input name="to" type="date" value="${to}"></div>
    <div class="quick"><button class="btn">Apply Filter</button><a class="btn secondary" href="/admin-web/orders">Reset</a><a class="btn secondary" href="/admin-web/orders/export.csv?${qs.toString()}">Export CSV</a></div>
  </form></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Order</th><th>User</th><th>Product</th><th>Total</th><th>Rating</th><th>Delivery</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No orders found.</td></tr>'}</tbody></table></div>
  <div class="card section"><div class="quick"><a class="btn secondary" href="/admin-web/orders?${qs.toString()}&page=${Math.max(1, safe-1)}">⬅️ Prev</a><span class="btn secondary">Page ${safe}/${totalPages}</span><a class="btn secondary" href="/admin-web/orders?${qs.toString()}&page=${Math.min(totalPages, safe+1)}">Next ➡️</a></div></div>`;
  res.send(adminLayout('Order History', body, req.query.msg));
});



app.get('/admin-web/orders/export.csv', (req, res) => {
  const list = filterWebOrders(req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="global-ott-orders-${Date.now()}.csv"`);
  res.send(ordersToCsv(list));
});

app.get('/admin-web/orders/:id/delivery', (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return redirectMsg(res, '/admin-web/orders', 'Order not found');
  const txt = formatDeliveredItems(o.deliveredItems || []);
  const body = `<div class="card"><h3>🔑 Delivery TXT</h3><p><b>${webEsc(o.productName)}</b> · ${webEsc(o.id)} · User ${webEsc(o.telegramId)}</p><textarea onclick="this.select()" readonly style="min-height:320px">${webEsc(txt)}</textarea><div class="quick"><a class="btn" href="/admin-web/orders">Back to Orders</a><form method="post" action="/admin-web/orders/${encodeURIComponent(o.id)}/resend"><button class="btn secondary">Resend Delivery</button></form></div><p class="muted small">If Telegram resend fails, copy this TXT manually and send to user.</p></div>`;
  res.send(adminLayout('Delivery TXT', body, req.query.msg));
});

app.post('/admin-web/orders/:id/resend', async (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return redirectMsg(res, '/admin-web/orders', 'Order not found');
  try {
    await sendDeliveryMessage(o.telegramId, o.productName, o.qty, o.total, o.currency, o.deliveredItems || [], o.id, o.productCode);
    redirectMsg(res, '/admin-web/orders', '✅ Delivery resent to user successfully');
  } catch (err) {
    const msg = String(err.message || '');
    let hint = msg;
    if (/chat not found|bot was blocked|user is deactivated|forbidden/i.test(msg)) {
      hint = 'Telegram cannot message this user. User must open/start the bot again, or they blocked the bot. Details: ' + msg;
    } else if (/400|Bad Request|reply_markup|copy_text/i.test(msg)) {
      hint = 'Telegram rejected the resend format. Fallback already tried. Details: ' + msg;
    }
    redirectMsg(res, '/admin-web/orders', '❌ Failed to resend: ' + hint);
  }
});

app.get('/admin-web/coupons', (req, res) => {
  const rows = (db.coupons || []).map(c => `<tr><td><b>${webEsc(c.code)}</b><br>${c.active === false ? '🔴 OFF' : '🟢 ON'}</td><td>${webEsc(c.type)}</td><td>${webEsc(c.value)}</td><td>${webEsc(c.minAmount || 0)}</td><td>${webEsc(c.uses || 0)} / ${webEsc(c.maxUses || '∞')}</td><td><form method="post" action="/admin-web/coupons/${encodeURIComponent(c.id)}/toggle"><button class="btn secondary">Toggle</button></form><form method="post" action="/admin-web/coupons/${encodeURIComponent(c.id)}/delete" onsubmit="return confirm('Delete coupon?')"><button class="btn danger">Delete</button></form></td></tr>`).join('');
  const body = `<div class="card"><h3>➕ Add Coupon</h3><form method="post" action="/admin-web/coupons/add"><div class="row"><input name="code" placeholder="SAVE10" required><select name="type"><option value="percent">Percent %</option><option value="fixed">Fixed Amount</option></select><input name="value" type="number" step="0.01" placeholder="10" required></div><div class="row"><input name="minAmount" type="number" step="0.01" placeholder="Min amount 0"><input name="maxUses" type="number" placeholder="Max uses 0 = unlimited"></div><button class="btn">Create Coupon</button></form></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Min</th><th>Uses</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No coupons.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Coupon Manager', body, req.query.msg));
});

app.post('/admin-web/coupons/add', (req, res) => {
  const code = String(req.body.code || '').toUpperCase().replace(/\s+/g, '');
  const type = String(req.body.type || 'percent');
  const value = Number(req.body.value || 0);
  if (!code || !value) return redirectMsg(res, '/admin-web/coupons', 'Code and value required');
  db.coupons ||= [];
  db.coupons.push({ id: nextCouponId(), code, type, value, minAmount: Number(req.body.minAmount || 0), maxUses: Number(req.body.maxUses || 0), uses: 0, active: true, createdAt: now() });
  saveData();
  redirectMsg(res, '/admin-web/coupons', 'Coupon created');
});

app.post('/admin-web/coupons/:id/toggle', (req, res) => {
  const c = (db.coupons || []).find(x => x.id === req.params.id);
  if (c) { c.active = c.active === false ? true : false; saveData(); }
  redirectMsg(res, '/admin-web/coupons', 'Coupon updated');
});

app.post('/admin-web/coupons/:id/delete', (req, res) => {
  db.coupons = (db.coupons || []).filter(x => x.id !== req.params.id);
  saveData();
  redirectMsg(res, '/admin-web/coupons', 'Coupon deleted');
});

app.get('/admin-web/announce', (req, res) => {
  const body = `<div class="card"><h3>📣 Smart Announcement</h3><form method="post" action="/admin-web/announce">
    <label>Target Segment</label>
    <select name="segment"><option value="all">All users</option><option value="notifications">Notifications ON</option><option value="buyers">Buyers only</option><option value="nonbuyers">Non-buyers</option><option value="wallet">Users with wallet balance</option></select>
    <label>Button Text</label><input name="buttonText" value="🛍 Open Store">
    <label>Message</label><textarea name="message" placeholder="Write announcement message..." required></textarea>
    <button class="btn">Send Announcement</button>
  </form><p class="muted small">Segmented broadcast helps avoid spam and target the right users.</p></div>`;
  res.send(adminLayout('Smart Announcement', body, req.query.msg));
});

app.post('/admin-web/announce', async (req, res) => {
  try {
    const segment = String(req.body.segment || 'all');
    const sent = await broadcastSegmentAnnouncement(String(req.body.message || '').trim(), segment, String(req.body.buttonText || '🛍 Open Store'));
    addWebAudit('announcement_sent', { segment, sent }, req);
    redirectMsg(res, '/admin-web/announce', `Announcement sent to ${sent} users in segment: ${segment}`);
  } catch (err) {
    redirectMsg(res, '/admin-web/announce', 'Announcement failed: ' + err.message);
  }
});





app.get('/admin-web/tickets', (req, res) => {
  const rows = (db.supportTickets || []).slice(0, 250).map(t => {
    const isReplacement = t.type === 'replacement';
    const canApprove = isReplacement && !['replacement_approved', 'replacement_rejected', 'closed'].includes(String(t.status || ''));
    const replacementActions = canApprove ? `<form method="post" action="/admin-web/tickets/${encodeURIComponent(t.id)}/approve-replacement"><button class="btn">Approve Replacement</button></form><form method="post" action="/admin-web/tickets/${encodeURIComponent(t.id)}/reject-replacement"><button class="btn danger">Reject Replacement</button></form>` : (isReplacement ? `<span class="muted">Replacement: ${webEsc(t.replacementStatus || t.status)}</span>` : '');
    return `<tr><td><b>${webEsc(t.id)}</b><br>${ticketStatusLabel(t)}<br>${isReplacement ? '🛡 Replacement<br>' : ''}<span class="muted">${webEsc(new Date(t.createdAt).toLocaleString())}</span></td><td>${webEsc(t.firstName || 'User')}<br>${t.username ? '@'+webEsc(t.username) : ''}<br><span class="code">${webEsc(t.telegramId)}</span></td><td>${webEsc(t.message)}${isReplacement ? `<br><br><b>Original Order:</b> <span class="code">${webEsc(t.orderId || '-')}</span><br><b>Replacement Order:</b> <span class="code">${webEsc(t.replacementOrderId || '-')}</span>` : ''}<br><br><b>Replies:</b><br><span class="muted">${webEsc((t.replies || []).map(r => r.by + ': ' + r.message).join(' | ') || '-')}</span></td><td>${replacementActions}<form method="post" action="/admin-web/tickets/${encodeURIComponent(t.id)}/reply"><textarea name="message" placeholder="Reply..." required></textarea><button class="btn secondary">Reply</button></form><form method="post" action="/admin-web/tickets/${encodeURIComponent(t.id)}/close"><button class="btn secondary">Close</button></form></td></tr>`;
  }).join('');
  const pendingReplacements = (db.supportTickets || []).filter(t => t.type === 'replacement' && !['replacement_approved', 'replacement_rejected', 'closed'].includes(String(t.status || ''))).length;
  const body = `<div class="grid"><div class="card"><h3>🟡 Open</h3><div class="stat">${openTickets().length}</div></div><div class="card"><h3>🛡 Pending Replacement</h3><div class="stat">${pendingReplacements}</div></div><div class="card"><h3>🎫 Total</h3><div class="stat">${(db.supportTickets || []).length}</div></div></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Ticket</th><th>User</th><th>Message</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No tickets.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Support Tickets', body, req.query.msg));
});


app.post('/admin-web/tickets/:id/reply', async (req, res) => {
  const t = (db.supportTickets || []).find(x => x.id === req.params.id);
  if (!t) return redirectMsg(res, '/admin-web/tickets', 'Ticket not found');
  const msg = String(req.body.message || '').trim();
  t.replies ||= []; t.replies.push({ by: 'admin', message: msg, at: now() }); t.status = 'answered'; t.updatedAt = now(); saveData();
  try { await sendMessage(t.telegramId, `🎫 <b>Support Reply</b>\n\nTicket: <code>${escapeHtml(t.id)}</code>\n\n${escapeHtml(msg)}`, homeButtons(t.telegramId)); } catch (_) {}
  addWebAudit('ticket_reply', { ticket: t.id }, req);
  redirectMsg(res, '/admin-web/tickets', 'Reply sent');
});

app.post('/admin-web/tickets/:id/close', async (req, res) => {
  const t = (db.supportTickets || []).find(x => x.id === req.params.id);
  if (t) { t.status = 'closed'; t.updatedAt = now(); saveData(); try { await sendMessage(t.telegramId, `✅ Your support ticket has been closed.\nTicket: ${t.id}`, homeButtons(t.telegramId)); } catch (_) {} }
  redirectMsg(res, '/admin-web/tickets', 'Ticket closed');
});

app.get('/admin-web/blacklist', (req, res) => {
  const banned = Object.values(db.users || {}).filter(u => u.banned);
  const rows = banned.map(u => `<tr><td>${webEsc(u.firstName || 'User')}<br>${u.username ? '@'+webEsc(u.username) : ''}</td><td><span class="code">${webEsc(u.telegramId)}</span></td><td><form method="post" action="/admin-web/users/${encodeURIComponent(u.telegramId)}/ban"><button class="btn">Unban</button></form></td></tr>`).join('');
  const body = `<div class="card"><h3>🚫 Ban / Unban User</h3><form method="post" action="/admin-web/blacklist/ban"><input name="telegramId" placeholder="Telegram User ID" required><button class="btn danger">Toggle Ban</button></form></div><br><div class="tableWrap"><table class="table"><thead><tr><th>User</th><th>ID</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No banned users.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Blacklist', body, req.query.msg));
});

app.post('/admin-web/users/:id/ban', (req, res) => {
  const u = db.users[String(req.params.id)];
  if (!u) return redirectMsg(res, '/admin-web/users', 'User not found');
  u.banned = !u.banned; saveData(); addWebAudit('user_ban_toggle', { user: u.telegramId, banned: u.banned }, req);
  redirectMsg(res, req.headers.referer && req.headers.referer.includes('/blacklist') ? '/admin-web/blacklist' : '/admin-web/users', u.banned ? 'User banned' : 'User unbanned');
});

app.post('/admin-web/blacklist/ban', (req, res) => {
  const id = String(req.body.telegramId || '').trim();
  if (!db.users[id]) db.users[id] = { telegramId: id, firstName: 'User', username: '', balance: 0, referrals: 0, referredBy: '', notifications: true, banned: false, createdAt: now() };
  db.users[id].banned = !db.users[id].banned; saveData();
  redirectMsg(res, '/admin-web/blacklist', db.users[id].banned ? 'User banned' : 'User unbanned');
});

app.get('/admin-web/message-user', (req, res) => {
  const body = `<div class="card"><h3>📩 Send Direct Message</h3><form method="post" action="/admin-web/message-user"><input name="telegramId" placeholder="Telegram User ID" required><textarea name="message" placeholder="Message..." required></textarea><button class="btn">Send Message</button></form></div>`;
  res.send(adminLayout('Direct Message', body, req.query.msg));
});

app.post('/admin-web/message-user', async (req, res) => {
  try { await sendDirectUserMessage(String(req.body.telegramId || '').trim(), String(req.body.message || '').trim()); addWebAudit('direct_message', { user: req.body.telegramId }, req); redirectMsg(res, '/admin-web/message-user', 'Message sent'); }
  catch (err) { redirectMsg(res, '/admin-web/message-user', 'Failed: ' + err.message); }
});

app.get('/admin-web/manual-delivery', (req, res) => {
  const productOptions = db.products.map(p => `<option value="${webEsc(p.code)}">${webEsc(p.code)} · ${webEsc(p.name)} · Stock ${p.stock?.length || 0}</option>`).join('');
  const body = `<div class="card"><h3>🚚 Manual Delivery</h3><form method="post" action="/admin-web/manual-delivery"><input name="telegramId" placeholder="User Telegram ID" required><select name="productCode">${productOptions}</select><input name="qty" type="number" min="1" value="1"><button class="btn">Create Order + Deliver</button></form><p class="muted small">Use this for replacement/warranty/manual delivery. It will cut stock and send delivery to user.</p></div>`;
  res.send(adminLayout('Manual Delivery', body, req.query.msg));
});

app.post('/admin-web/manual-delivery', async (req, res) => {
  try { const order = await createManualOrder(String(req.body.telegramId || '').trim(), String(req.body.productCode || '').trim(), Number(req.body.qty || 1), 'Web Manual Delivery'); addWebAudit('manual_delivery', { order: order.id }, req); redirectMsg(res, '/admin-web/manual-delivery', `Delivered. Order ${order.id}`); }
  catch (err) { redirectMsg(res, '/admin-web/manual-delivery', 'Failed: ' + err.message); }
});




app.get('/admin-web/auto-verify', (req, res) => {
  const pending = paymentsForAutoScan();
  const logs = (db.autoVerifyLogs || []).slice(0, 80).map(l => `<tr><td><b>${webEsc(l.type)}</b><br><span class="muted">${webEsc(new Date(l.at).toLocaleString())}</span></td><td>${webEsc(l.message)}</td><td><span class="code">${webEsc(JSON.stringify(l.data || {})).slice(0, 220)}</span></td></tr>`).join('');
  const pendingRows = pending.slice(0, 100).map(p => `<tr><td><b>${webEsc(p.id)}</b><br>${webEsc(p.type || 'order')}</td><td>${webEsc(p.telegramId)}</td><td>${webEsc(p.productName || 'Wallet Deposit')}</td><td>${webMoney(p.amount)}</td><td>${webEsc(p.status)}<br><span class="muted">${webEsc(short(p.lastCheckReason || '', 80))}</span></td><td><form method="post" action="/admin-web/auto-verify/check/${encodeURIComponent(p.id)}"><button class="btn">Check Now</button></form></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🤖 Full Auto Binance Verifier</h2><div class="muted">Auto checks deposits/orders and delivers without admin approval when Binance API returns matching transaction.</div><div class="kpiLine"><span>Scanner ${db.settings.autoVerifyEnabled === false ? 'OFF' : 'ON'}</span><span>${pending.length} pending scan</span><span>Interval ${db.settings.autoVerifyIntervalSec || 25}s</span><span>No TXID ${db.settings.noTxidMode === false ? 'OFF' : 'ON'}</span><span>Unique Amount ${db.settings.uniqueAmountEnabled === true ? 'ON' : 'OFF'}</span></div></div>
  <div class="quick"><form method="post" action="/admin-web/auto-verify/run"><button class="btn">Run Scanner Now</button></form><form method="post" action="/admin-web/auto-verify/test-binance"><button class="btn secondary">Test Binance API</button></form><form method="post" action="/admin-web/auto-verify/test-bybit"><button class="btn secondary">Test Bybit API</button></form><a class="btn secondary" href="/admin-web/settings">Auto Verify Settings</a></div><br>
  <div class="tableWrap"><h3>⏳ Pending Auto Scan</h3><table class="table"><thead><tr><th>Payment</th><th>User</th><th>Item</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${pendingRows || '<tr><td colspan="6">No pending auto payments.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>📜 Auto Verify Logs</h3><table class="table"><thead><tr><th>Type</th><th>Message</th><th>Data</th></tr></thead><tbody>${logs || '<tr><td colspan="3">No logs yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Auto Verify', body, req.query.msg));
});

app.post('/admin-web/auto-verify/run', async (req, res) => {
  try {
    await autoScannerTick();
    redirectMsg(res, '/admin-web/auto-verify', 'Auto verifier scan completed');
  } catch (err) {
    redirectMsg(res, '/admin-web/auto-verify', 'Auto scan failed: ' + err.message);
  }
});

app.post('/admin-web/auto-verify/check/:id', async (req, res) => {
  const p = db.payments.find(x => x.id === req.params.id);
  if (!p) return redirectMsg(res, '/admin-web/auto-verify', 'Payment not found');
  try {
    const result = await verifyPayment(p);
    if (result.ok) {
      const msg = await autoApprovePayment(p, result, 'web-auto-check');
      return redirectMsg(res, '/admin-web/auto-verify', msg);
    }
    p.lastCheckReason = result.reason; p.lastCheck = now(); saveData();
    redirectMsg(res, '/admin-web/auto-verify', result.reason);
  } catch (err) {
    redirectMsg(res, '/admin-web/auto-verify', 'Check failed: ' + err.message);
  }
});

app.post('/admin-web/auto-verify/test-binance', async (req, res) => {
  try {
    const txs = await fetchAllBinanceTxs();
    autoVerifyLog('info', `Binance API test OK. Found ${txs.length} recent transaction(s).`, { count: txs.length });
    redirectMsg(res, '/admin-web/auto-verify', `Binance API OK. Found ${txs.length} recent transaction(s).`);
  } catch (err) {
    autoVerifyLog('error', 'Binance API test failed', { error: err.response?.data || err.message });
    redirectMsg(res, '/admin-web/auto-verify', 'Binance API failed: ' + err.message);
  }
});

app.post('/admin-web/auto-verify/test-bybit', async (req, res) => {
  try {
    const txs = await fetchBybitDeposits();
    autoVerifyLog('info', `Bybit API test OK. Found ${txs.length} recent deposit(s).`, { count: txs.length });
    redirectMsg(res, '/admin-web/auto-verify', `Bybit API OK. Found ${txs.length} recent deposit(s).`);
  } catch (err) {
    autoVerifyLog('error', 'Bybit API test failed', { error: err.response?.data || err.message });
    redirectMsg(res, '/admin-web/auto-verify', 'Bybit API failed: ' + err.message);
  }
});





app.get('/admin-web/flash-sales', (req, res) => {
  const options = db.products.map(p => `<option value="${webEsc(p.code)}">${webEsc(p.code)} · ${webEsc(p.name)}</option>`).join('');
  const rows = db.products.filter(p => p.flashSale).map(p => {
    const sale = activeFlashSale(p);
    return `<tr><td><b>${webEsc(p.name)}</b><br><span class="code">${webEsc(p.code)}</span></td><td>${p.flashSale?.active === false ? 'OFF' : sale ? 'LIVE' : 'EXPIRED'}</td><td>${webMoney(p.price)}</td><td>${webMoney(p.flashSale?.price || 0)}</td><td>${webEsc(p.flashSale?.endsAt ? new Date(p.flashSale.endsAt).toLocaleString() : '-')}</td><td><a class="btn secondary" href="/admin-web/flash-sales/${encodeURIComponent(p.code)}/preview">Preview</a><form method="post" action="/admin-web/flash-sales/${encodeURIComponent(p.code)}/disable"><button class="btn danger">Disable</button></form></td></tr>`;
  }).join('');
  const body = `<div class="heroPanel"><h2>⚡ Flash Sales</h2><div class="muted">Create limited-time price drops and auto-send premium campaign alerts.</div></div>
  <div class="card"><form method="post" action="/admin-web/flash-sales/create">
    <div class="row"><div><label>Product</label><select name="code">${options}</select></div><div><label>Sale Price</label><input name="price" type="number" step="0.01" required></div><div><label>Duration Hours</label><input name="hours" type="number" value="6" required></div></div>
    <label>Offer Note</label><input name="note" placeholder="Price dropped for some hours only">
    <button class="btn">Start Flash Sale + Send Campaign</button>
  </form></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Product</th><th>Status</th><th>Old Price</th><th>Sale Price</th><th>Ends</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No flash sales yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Flash Sales', body, req.query.msg));
});

app.post('/admin-web/flash-sales/create', async (req, res) => {
  const p = productByCode(req.body.code);
  const price = Number(req.body.price || 0);
  const hours = Number(req.body.hours || 0);
  if (!p || !price || !hours) return redirectMsg(res, '/admin-web/flash-sales', 'Product, price and hours required');
  p.flashSale = { active: true, price, startsAt: now(), endsAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(), note: String(req.body.note || '').trim(), createdBy: req.webAdmin?.username || 'web-admin' };
  saveData();
  const result = await sendCampaign({ type: 'flash', segment: 'all', productCode: p.code, toChannels: true, by: req.webAdmin?.username || 'web-admin' });
  addWebAudit('flash_sale_created', { code: p.code, price, hours, sent: result.total }, req);
  redirectMsg(res, '/admin-web/flash-sales', `Flash sale started and campaign sent to ${result.total}`);
});


app.get('/admin-web/flash-sales/:code/preview', (req, res) => {
  const p = productByCode(req.params.code);
  if (!p) return redirectMsg(res, '/admin-web/flash-sales', 'Product not found');
  const body = `<div class="heroPanel"><h2>⚡ Flash Sale Preview</h2><div class="muted">Copy this message or send campaign from Flash Sales page.</div></div><div class="card"><textarea class="preview" onclick="this.select()" readonly>${webEsc(flashSaleText(p).replace(/<[^>]+>/g, ''))}</textarea></div><br><a class="btn" href="/admin-web/flash-sales">Back</a>`;
  res.send(adminLayout('Flash Sale Preview', body, req.query.msg));
});

app.post('/admin-web/flash-sales/:code/disable', (req, res) => {
  const p = productByCode(req.params.code);
  if (p) { p.flashSale = { ...(p.flashSale || {}), active: false }; saveData(); addWebAudit('flash_sale_disabled', { code: p.code }, req); }
  redirectMsg(res, '/admin-web/flash-sales', 'Flash sale disabled');
});

app.get('/admin-web/campaigns', (req, res) => {
  const productOptions = db.products.map(p => `<option value="${webEsc(p.code)}">${webEsc(p.code)} · ${webEsc(p.name)}</option>`).join('');
  const logs = (db.campaignLogs || []).slice(0, 80).map(l => `<tr><td><b>${webEsc(l.type)}</b><br><span class="muted">${webEsc(new Date(l.at).toLocaleString())}</span></td><td>${webEsc(segmentLabel(l.target))}</td><td>${webEsc(l.count)}</td><td>${webEsc(l.message).slice(0, 180)}</td></tr>`).join('');
  const stats = campaignStats();
  const body = `<div class="heroPanel"><h2>📣 Campaign Center</h2><div class="muted">Send premium alerts to selected user segments and channels.</div><div class="kpiLine"><span>${stats.total} campaigns</span><span>${stats.sent} total sent</span><span>${Object.keys(db.users||{}).length} users</span></div></div>
  <div class="two"><div class="card"><h3>📣 Custom Campaign</h3><form method="post" action="/admin-web/campaigns/send"><input type="hidden" name="type" value="custom"><label>Target Segment</label><select name="segment"><option value="all">All Users</option><option value="buyers">Buyers Only</option><option value="nonbuyers">Non-Buyers</option><option value="wallet">Wallet Balance Users</option><option value="inactive">Inactive Users</option></select><label>Message</label><textarea name="message" required placeholder="Offer message..."></textarea><label><input type="checkbox" name="toChannels" value="true" checked> Also send to configured channels</label><button class="btn">Send Campaign</button></form></div>
  <div class="card"><h3>📦 Product Campaign</h3><form method="post" action="/admin-web/campaigns/send"><label>Type</label><select name="type"><option value="product">Product Promo</option><option value="flash">Flash Sale Promo</option></select><label>Product</label><select name="productCode">${productOptions}</select><label>Target Segment</label><select name="segment"><option value="all">All Users</option><option value="buyers">Buyers Only</option><option value="nonbuyers">Non-Buyers</option><option value="wallet">Wallet Balance Users</option><option value="inactive">Inactive Users</option></select><label><input type="checkbox" name="toChannels" value="true" checked> Also send to configured channels</label><button class="btn">Send Product Campaign</button></form></div></div><br>
  <div class="tableWrap"><h3>Campaign Logs</h3><table class="table"><thead><tr><th>Type</th><th>Segment</th><th>Sent</th><th>Message</th></tr></thead><tbody>${logs || '<tr><td colspan="4">No campaigns yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Campaign Center', body, req.query.msg));
});

app.post('/admin-web/campaigns/send', async (req, res) => {
  const type = String(req.body.type || 'custom');
  const segment = String(req.body.segment || 'all');
  const productCode = String(req.body.productCode || '').trim().toUpperCase();
  const message = String(req.body.message || '').trim();
  const toChannels = String(req.body.toChannels || '') === 'true';
  try {
    const result = await sendCampaign({ type, segment, productCode, message, toChannels, by: req.webAdmin?.username || 'web-admin' });
    addWebAudit('campaign_sent', { type, segment, productCode, sent: result.total }, req);
    redirectMsg(res, '/admin-web/campaigns', `Campaign sent: ${result.total}`);
  } catch (err) {
    redirectMsg(res, '/admin-web/campaigns', 'Campaign failed: ' + err.message);
  }
});


app.get('/admin-web/reviews', (req, res) => {
  const avg = db.reviews?.length ? (db.reviews.reduce((a,r)=>a+Number(r.rating||0),0)/db.reviews.length) : 0;
  const rows = (db.reviews || []).slice(0, 300).map(r => `<tr><td><b>${ratingStars(r.rating)} ${webEsc(r.rating)}/5</b><br><span class="muted">${webEsc(new Date(r.createdAt).toLocaleString())}</span></td><td>${webEsc(r.productName)}<br><span class="code">${webEsc(r.productCode)}</span></td><td>${webEsc(r.firstName || 'User')}<br>${r.username ? '@'+webEsc(r.username) : ''}<br><span class="code">${webEsc(r.telegramId)}</span></td><td>${webEsc(r.message || '-')}</td><td><span class="code">${webEsc(r.orderId)}</span></td></tr>`).join('');
  const body = `<div class="grid"><div class="card"><h3>⭐ Average Rating</h3><div class="stat">${avg ? Math.round(avg*10)/10 : 0}/5</div></div><div class="card"><h3>📝 Reviews</h3><div class="stat">${(db.reviews||[]).length}</div></div></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Rating</th><th>Product</th><th>User</th><th>Review</th><th>Order</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No reviews yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Reviews', body, req.query.msg));
});



app.get('/admin-web/custom-emojis', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const cat = String(req.query.cat || 'all').toLowerCase();
  const entries = Object.entries(brandCodeCatalog())
    .filter(([code]) => code !== 'default')
    .filter(([code, item]) => cat === 'all' || String(item.cat || '').toLowerCase() === cat)
    .filter(([code, item]) => !q || code.includes(q) || String(item.name || '').toLowerCase().includes(q) || (item.keywords || []).some(k => String(k).toLowerCase().includes(q)));

  const catOptions = ['all', ...brandCategories()].map(c => `<option value="${webEsc(c)}" ${cat === c ? 'selected' : ''}>${webEsc(c.toUpperCase())}</option>`).join('');
  const rows = entries.map(([code, item]) => {
    const id = db.customEmojiMap?.[code] || '';
    return `<tr><td>${webEsc(item.icon)}</td><td><code>${webEsc(code)}</code></td><td>${webEsc(item.name)}<br><span class="muted">${webEsc(item.cat || 'other')} · ${webEsc((item.keywords||[]).slice(0,6).join(', '))}</span></td><td><input form="emojiForm" name="emoji_${webEsc(code)}" value="${webEsc(id)}" placeholder="custom_emoji_id"></td></tr>`;
  }).join('');

  const body = `<div class="heroPanel"><h2>🧩 Custom Emoji Codes</h2><div class="muted">Add Telegram custom_emoji_id for AI apps and websites. Use /emojiids in bot to extract IDs.</div><div class="kpiLine"><span>${Object.keys(brandCodeCatalog()).length - 1} codes</span><span>${brandCategories().length} categories</span><span>${Object.keys(db.customEmojiMap || {}).length} IDs saved</span></div></div>
  <div class="card"><form method="get" action="/admin-web/custom-emojis"><div class="row"><input name="q" value="${webEsc(q)}" placeholder="Search app / website / AI tool"><select name="cat">${catOptions}</select></div><button class="btn">Filter</button></form><p><b>Commands:</b> <code>/emojiids</code>, <code>/brandcodes ai</code>, <code>/setbrandemoji gemini ID</code>, <code>/setcustomemoji P001 ID</code>, <code>/setbrand P001 gemini</code></p></div><br>
  <form id="emojiForm" method="post" action="/admin-web/custom-emojis/save"><div class="tableWrap"><table class="table"><thead><tr><th>Fallback</th><th>Code</th><th>Name/Keywords</th><th>Custom Emoji ID</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No brand codes found.</td></tr>'}</tbody></table></div><br><button class="btn">Save Custom Emoji IDs</button></form>`;
  res.send(adminLayout('Custom Emoji Codes', body, req.query.msg));
});

app.post('/admin-web/custom-emojis/save', (req, res) => {
  db.customEmojiMap ||= {};
  for (const code of Object.keys(brandCodeCatalog())) {
    const id = String(req.body[`emoji_${code}`] || '').trim();
    if (id) db.customEmojiMap[code] = id;
    else delete db.customEmojiMap[code];
  }
  saveData();
  addWebAudit('custom_emoji_map_saved', { count: Object.keys(db.customEmojiMap || {}).length }, req);
  redirectMsg(res, '/admin-web/custom-emojis', 'Custom emoji codes saved');
});


app.get('/admin-web/custom-message', (req, res) => {
  const sample = String(req.query.message || '🚨 [b]FLASH SALE LIVE[/b]\n[line]\n💰 Old Price: $1.8\n🔥 New Price: [b]$1[/b]\n📦 Only 8 stock left\n🛒 Buy from @supportbot').trim();
  const preview = premiumCustomAnnouncementText(sample);
  const body = `<div class="heroPanel"><h2>✍️ Custom Premium Message</h2><div class="muted">Write your own announcement. Use [b]bold[/b], **bold**, [i]italic[/i], [code]code[/code], [line].</div></div>
  <div class="two"><div class="card"><form method="get" action="/admin-web/custom-message"><label>Message</label><textarea name="message" rows="12">${webEsc(sample)}</textarea><button class="btn">Preview</button></form><form method="post" action="/admin-web/custom-message/send"><input type="hidden" name="message" value="${webEsc(sample)}"><button class="btn danger">Send To Users + Channels</button></form></div>
  <div class="card"><h3>Preview</h3><div class="preview">${preview.replace(/\n/g, '<br>')}</div></div></div>`;
  res.send(adminLayout('Custom Premium Message', body, req.query.msg));
});

app.post('/admin-web/custom-message/send', async (req, res) => {
  const msg = String(req.body.message || '').trim();
  if (!msg) return redirectMsg(res, '/admin-web/custom-message', 'Message required');
  const formatted = premiumCustomAnnouncementText(msg);
  const sentUsers = await broadcastToUsers(formatted, inline([[{ text: '🛍 Open Store', callback_data: 'shop:1' }]]));
  const sentChannels = await sendToConfiguredChannels(formatted, inline([[{ text: '🛍 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
  addWebAudit('custom_premium_message_sent', { sentUsers, sentChannels }, req);
  redirectMsg(res, '/admin-web/custom-message', `Sent to ${sentUsers} users and ${sentChannels} channels`);
});


app.get('/admin-web/marketing-kit', (req, res) => {
  const code = String(req.query.product || '').toUpperCase();
  const productOptions = db.products.filter(p => p.active !== false).map(p => `<option value="${webEsc(p.code)}" ${p.code === code ? 'selected' : ''}>${webEsc(p.code)} · ${webEsc(p.name)}</option>`).join('');
  const p = productByCode(code) || db.products.find(p => p.active !== false);
  const pack = p ? productMarketingPack(p) : { groupPost:'No product found', shortPost:'', channelPost:'', buyLink:'' };
  const body = `<div class="heroPanel"><h2>📣 Marketing Kit</h2><div class="muted">Generate ready-to-post promo messages for groups, channels and DMs.</div></div>
  <div class="card"><form method="get" action="/admin-web/marketing-kit"><label>Select Product</label><select name="product">${productOptions}</select><button class="btn">Generate Kit</button></form></div><br>
  <div class="grid">
    <div class="card"><h3>📢 Group Promo</h3><textarea class="preview" onclick="this.select()" readonly>${webEsc(pack.groupPost)}</textarea></div>
    <div class="card"><h3>⚡ Short Promo</h3><textarea class="preview" onclick="this.select()" readonly>${webEsc(pack.shortPost)}</textarea></div>
    <div class="card"><h3>📣 Channel Post</h3><textarea class="preview" onclick="this.select()" readonly>${webEsc(pack.channelPost)}</textarea></div>
  </div>
  <br><div class="quick"><a class="btn" href="https://t.me/share/url?url=${encodeURIComponent(pack.buyLink)}&text=${encodeURIComponent(pack.shortPost)}">Share on Telegram</a><a class="btn secondary" href="/admin-web/products">Product Manager</a></div>`;
  res.send(adminLayout('Marketing Kit', body, req.query.msg));
});


app.get('/admin-web/restock', (req, res) => {
  const status = String(req.query.status || 'open');
  let list = (db.restockRequests || []).slice();
  if (status !== 'all') list = list.filter(r => r.status === status);
  const rows = list.map(r => {
    const p = productByCode(r.productCode);
    return `<tr><td><b>${webEsc(r.productName)}</b><br><span class="code">${webEsc(r.productCode)}</span></td><td>${webEsc(r.firstName || 'User')}<br>${r.username ? '@'+webEsc(r.username) : ''}<br><span class="code">${webEsc(r.telegramId)}</span></td><td>${webEsc(r.status)}</td><td>${webEsc(new Date(r.createdAt).toLocaleString())}</td><td>${p ? (p.stock?.length || 0) : 0}</td><td><a class="btn secondary" href="/admin-web/products/${encodeURIComponent(r.productCode)}">Manage Product</a><form method="post" action="/admin-web/restock/${encodeURIComponent(r.id)}/close"><button class="btn">Close</button></form></td></tr>`;
  }).join('');
  const body = `<div class="heroPanel"><h2>🔔 Restock Requests</h2><div class="muted">Users waiting for out-of-stock products. They get notified automatically when stock is added.</div><div class="kpiLine"><span>${(db.restockRequests||[]).filter(r=>r.status==='open').length} open</span><span>${(db.restockRequests||[]).filter(r=>r.status==='notified').length} notified</span></div></div>
  <div class="quick"><a class="btn secondary" href="/admin-web/restock?status=open">Open</a><a class="btn secondary" href="/admin-web/restock?status=notified">Notified</a><a class="btn secondary" href="/admin-web/restock?status=all">All</a></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Product</th><th>User</th><th>Status</th><th>Date</th><th>Stock</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No restock requests.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Restock Requests', body, req.query.msg));
});

app.post('/admin-web/restock/:id/close', (req, res) => {
  const r = (db.restockRequests || []).find(x => x.id === req.params.id);
  if (r) { r.status = 'closed'; r.closedAt = now(); saveData(); addWebAudit('restock_request_closed', { id: r.id }, req); }
  redirectMsg(res, '/admin-web/restock', 'Restock request closed');
});

app.get('/admin-web/insights', (req, res) => {
  const ins = customerInsights();
  const buyerRows = ins.topBuyers.map((u, i) => {
    const uid = String(u.telegramId);
    return `<tr><td>${i+1}</td><td><b>${webEsc(u.firstName || 'User')}</b><br>${u.username ? '@'+webEsc(u.username) : ''}<br><span class="code">${webEsc(uid)}</span></td><td>${ins.orderCounts[uid] || 0}</td><td>${webMoney(ins.spent[uid] || 0)}</td><td><form method="post" action="/admin-web/message-user"><input type="hidden" name="telegramId" value="${webEsc(uid)}"><input name="message" placeholder="Message top buyer"><button class="btn">Message</button></form></td></tr>`;
  }).join('');
  const walletRows = ins.walletUsers.map(u => `<tr><td><b>${webEsc(u.firstName || 'User')}</b><br>${u.username ? '@'+webEsc(u.username) : ''}</td><td><span class="code">${webEsc(u.telegramId)}</span></td><td>${webMoney(u.balance || 0)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>👑 Customer Insights</h2><div class="muted">Top buyers, wallet users and non-buyers for marketing decisions.</div><div class="kpiLine"><span>${ins.topBuyers.length} buyers</span><span>${ins.walletUsers.length} wallet users</span><span>${ins.nonBuyers.length} non-buyers sample</span></div></div>
  <div class="two"><div class="tableWrap"><h3>👑 Top Buyers</h3><table class="table"><thead><tr><th>#</th><th>User</th><th>Orders</th><th>Spent</th><th>Action</th></tr></thead><tbody>${buyerRows || '<tr><td colspan="5">No buyers yet.</td></tr>'}</tbody></table></div>
  <div class="tableWrap"><h3>💰 Wallet Balance Users</h3><table class="table"><thead><tr><th>User</th><th>ID</th><th>Wallet</th></tr></thead><tbody>${walletRows || '<tr><td colspan="3">No wallet balances.</td></tr>'}</tbody></table></div></div>`;
  res.send(adminLayout('Customer Insights', body, req.query.msg));
});




app.get('/admin-web/groups/keyword-test', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rule = q ? findChannelRuleByText(q) : null;
  const p = rule ? productByCode(rule.productCode) : null;
  const body = `<div class="heroPanel"><h2>⌨️ Group Keyword Reply Test</h2><div class="muted">Test which product will reply in group and direct-buy keyboard.</div></div>
  <div class="card"><form method="get" action="/admin-web/groups/keyword-test"><input name="q" value="${webEsc(q)}" placeholder="Type keyword e.g. gemini"><button class="btn">Test</button></form></div><br>
  <div class="card"><h3>Result</h3>${!q ? '<p>Enter keyword to test.</p>' : p ? `<p>Matched Product: <b>${webEsc(p.name)}</b></p><p>Keyword: <code>${webEsc(rule.matchedKeyword || rule.keywords || '')}</code></p><p>Score: ${webEsc(rule.score || '-')}</p><textarea class="preview" onclick="this.select()" readonly>${webEsc(premiumGroupProductReply(p, rule.matchedKeyword || q).replace(/<[^>]+>/g, ''))}</textarea><p><a class="btn" href="${webEsc(productDeepLink(p.code))}">Open Direct Buy Link</a></p>` : `<p>No product matched for <code>${webEsc(q)}</code>.</p>`}</div>`;
  res.send(adminLayout('Keyword Reply Test', body, req.query.msg));
});


app.get('/admin-web/groups', (req, res) => {
  const rows = (db.alertGroups || []).map(g => `<tr><td>${g.active === false ? '🔴' : '🟢'} <b>${webEsc(g.title || 'Group')}</b><br><span class="muted">${webEsc(g.type || 'group')} · ${webEsc(g.username ? '@' + g.username : '')}</span></td><td><span class="code">${webEsc(g.id)}</span></td><td>${g.alertsEnabled === false ? 'OFF' : 'ON'}</td><td>${g.keywordReplyEnabled === false ? 'OFF' : 'ON'}</td><td>${g.sentCount || 0}</td><td>${webEsc(g.lastError || '-')}</td><td><form method="post" action="/admin-web/groups/${encodeURIComponent(g.id)}/toggle"><button class="btn secondary">Toggle Alerts</button></form><form method="post" action="/admin-web/groups/${encodeURIComponent(g.id)}/keyword"><button class="btn secondary">Toggle Keyword</button></form><form method="post" action="/admin-web/groups/${encodeURIComponent(g.id)}/test"><button class="btn">Test</button></form><form method="post" action="/admin-web/groups/${encodeURIComponent(g.id)}/delete"><button class="btn danger">Remove</button></form></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>👥 Group Alerts Manager</h2><div class="muted">Groups are auto-saved when bot is added to group. Alerts go to active registered groups.</div><div class="kpiLine"><span>${(db.alertGroups||[]).length} groups</span><span>${activeAlertGroups().length} active alerts</span><span>Auto Register ${db.settings.autoRegisterGroups === false ? 'OFF' : 'ON'}</span><span>Alerts ${db.settings.groupAlertsEnabled === false ? 'OFF' : 'ON'}</span><span>Keyword ${db.settings.groupKeywordReplyEnabled === false ? 'OFF' : 'ON'}</span></div></div>
  <div class="two">
    <div class="card"><h3>How it works</h3><p class="muted">Add bot to group. It will auto-register. In group you can use <code>/groupid</code>, <code>/alerton</code>, <code>/alertoff</code>, <code>/keywordon</code>, <code>/keywordoff</code>.</p><form method="post" action="/admin-web/groups/test-all"><button class="btn">Send Test To All Groups</button></form></div>
    <div class="card"><h3>Manual Add Group ID</h3><form method="post" action="/admin-web/groups/add"><input name="id" placeholder="-100xxxxxxxxxx" required><input name="title" placeholder="Group Title"><button class="btn">Add Group</button></form></div>
    <div class="card"><h3>⌨️ Test Keyword Reply</h3><form method="get" action="/admin-web/groups/keyword-test"><input name="q" placeholder="gemini / chatgpt / notion"><button class="btn">Test Match</button></form><p class="muted">Bot replies in groups with direct Buy button keyboard when keyword matches.</p></div>
  </div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Group</th><th>ID</th><th>Alerts</th><th>Keyword</th><th>Sent</th><th>Last Error</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No groups yet. Add bot to group first.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Group Alerts', body, req.query.msg));
});

app.post('/admin-web/groups/add', (req, res) => {
  const id = String(req.body.id || '').trim();
  if (!id) return redirectMsg(res, '/admin-web/groups', 'Group ID required');
  db.alertGroups ||= [];
  let g = findAlertGroup(id);
  if (!g) {
    g = { id, title: String(req.body.title || id).trim(), type: 'group', username: '', active: true, alertsEnabled: true, keywordReplyEnabled: true, autoRegistered: false, addedBy: 'web', registeredAt: now(), lastSeenAt: now(), sentCount: 0, failCount: 0, lastError: '' };
    db.alertGroups.unshift(g);
  } else {
    g.title = String(req.body.title || g.title || id).trim();
    g.active = true;
    g.alertsEnabled = true;
  }
  saveData();
  addWebAudit('group_added', { id }, req);
  redirectMsg(res, '/admin-web/groups', 'Group added');
});

app.post('/admin-web/groups/:id/toggle', (req, res) => {
  const g = findAlertGroup(req.params.id);
  if (!g) return redirectMsg(res, '/admin-web/groups', 'Group not found');
  g.alertsEnabled = g.alertsEnabled === false ? true : false;
  g.active = true;
  saveData();
  addWebAudit('group_alert_toggle', { id: g.id, enabled: g.alertsEnabled }, req);
  redirectMsg(res, '/admin-web/groups', 'Group alerts updated');
});

app.post('/admin-web/groups/:id/keyword', (req, res) => {
  const g = findAlertGroup(req.params.id);
  if (!g) return redirectMsg(res, '/admin-web/groups', 'Group not found');
  g.keywordReplyEnabled = g.keywordReplyEnabled === false ? true : false;
  saveData();
  addWebAudit('group_keyword_toggle', { id: g.id, enabled: g.keywordReplyEnabled }, req);
  redirectMsg(res, '/admin-web/groups', 'Group keyword updated');
});

app.post('/admin-web/groups/:id/test', async (req, res) => {
  const g = findAlertGroup(req.params.id);
  if (!g) return redirectMsg(res, '/admin-web/groups', 'Group not found');
  try {
    await sendMessage(g.id, `🧪 <b>Group Alert Test</b>\n\nGroup: <b>${escapeHtml(g.title)}</b>\nAlerts are working ✅`, inline([[{ text: '🛍 Open Store', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
    redirectMsg(res, '/admin-web/groups', 'Test sent');
  } catch (err) {
    g.lastError = err.message;
    saveData();
    redirectMsg(res, '/admin-web/groups', 'Test failed: ' + err.message);
  }
});

app.post('/admin-web/groups/test-all', async (req, res) => {
  const sent = await sendToRegisteredGroups(`🧪 <b>Group Alert Test</b>\n\nIf you see this message, group alerts are working.`, inline([[{ text: '🛍 Open Store', url: `https://t.me/${getBotUsername() || botUsername}` }]]), 'test');
  addWebAudit('group_test_all', { sent }, req);
  redirectMsg(res, '/admin-web/groups', `Test sent to ${sent} group(s)`);
});

app.post('/admin-web/groups/:id/delete', (req, res) => {
  db.alertGroups = (db.alertGroups || []).filter(g => String(g.id) !== String(req.params.id));
  saveData();
  addWebAudit('group_removed', { id: req.params.id }, req);
  redirectMsg(res, '/admin-web/groups', 'Group removed from list');
});


app.get('/admin-web/channels', (req, res) => {
  const productOptions = db.products.map(p => `<option value="${webEsc(p.code)}">${webEsc(p.code)} · ${webEsc(p.name)}</option>`).join('');
  const rules = (db.channelRules || []).map(r => `<tr><td>${r.active === false ? 'OFF' : 'ON'}</td><td><b>${webEsc(r.keywords)}</b></td><td>${webEsc(r.productCode)}</td><td><form method="post" action="/admin-web/channels/rule/${encodeURIComponent(r.id)}/toggle"><button class="btn secondary">Toggle</button></form><form method="post" action="/admin-web/channels/rule/${encodeURIComponent(r.id)}/delete"><button class="btn danger">Delete</button></form></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>📢 Channel Manager</h2><div class="muted">Send stock alerts to channels and auto-reply to channel posts with product buy buttons.</div><div class="kpiLine"><span>Alerts ${db.settings.channelAlertsEnabled === false ? 'OFF' : 'ON'}</span><span>Auto Reply ${db.settings.channelAutoReplyEnabled === false ? 'OFF' : 'ON'}</span><span>${configuredChannels().length} channels</span><span>Purchase Alerts ${db.settings.purchaseAlertsEnabled === false ? 'OFF' : 'ON'}</span><span>Group Reply ${db.settings.groupAutoReplyEnabled === false ? 'OFF' : 'ON'}</span></div></div>
  <div class="two">
    <div class="card"><h3>⚙️ Channel Settings</h3><form method="post" action="/admin-web/channels/settings">
      <label>Channels username/ID</label><textarea name="channelIds" placeholder="@yourchannel or -100xxxxxxxx">${webEsc(db.settings.channelIds || '')}</textarea>
      <div class="row"><select name="channelAlertsEnabled"><option value="true" ${db.settings.channelAlertsEnabled === false ? '' : 'selected'}>Alerts ON</option><option value="false" ${db.settings.channelAlertsEnabled === false ? 'selected' : ''}>Alerts OFF</option></select><select name="channelAutoReplyEnabled"><option value="true" ${db.settings.channelAutoReplyEnabled === false ? '' : 'selected'}>Auto Reply ON</option><option value="false" ${db.settings.channelAutoReplyEnabled === false ? 'selected' : ''}>Auto Reply OFF</option></select></div>
      <button class="btn">Save Channel Settings</button>
    </form><form method="post" action="/admin-web/channels/test"><button class="btn secondary">Send Test Message</button></form></div>
    <div class="card"><h3>➕ Add Keyword Rule</h3><form method="post" action="/admin-web/channels/rule/add">
      <label>Keywords</label><input name="keywords" placeholder="Gemini, Gemini 18 Months, Gemini Pro" required>
      <label>Product</label><select name="productCode">${productOptions}</select>
      <button class="btn">Add Rule</button>
    </form><p class="muted small">If someone posts these keywords in channel, bot replies with product promo and Buy Now button.</p></div>
  </div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Status</th><th>Keywords</th><th>Product</th><th>Action</th></tr></thead><tbody>${rules || '<tr><td colspan="4">No keyword rules yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Channel Manager', body, req.query.msg));
});

app.post('/admin-web/channels/settings', (req, res) => {
  db.settings.autoVerifyEnabled = String(req.body.autoVerifyEnabled) === 'false' ? false : true;
  db.settings.autoVerifyIntervalSec = Number(req.body.autoVerifyIntervalSec || 25);
  db.settings.autoVerifyAmountMatch = String(req.body.autoVerifyAmountMatch) === 'false' ? false : true;
  db.settings.autoVerifyMaxAgeHours = Number(req.body.autoVerifyMaxAgeHours || 24);
  db.settings.channelIds = String(req.body.channelIds || '').trim();
  db.settings.channelAlertsEnabled = String(req.body.channelAlertsEnabled) === 'false' ? false : true;
  db.settings.channelAutoReplyEnabled = String(req.body.channelAutoReplyEnabled) === 'false' ? false : true;
  saveData();
  addWebAudit('channel_settings_updated', { channels: configuredChannels().length }, req);
  redirectMsg(res, '/admin-web/channels', 'Channel settings saved');
});

app.post('/admin-web/channels/test', async (req, res) => {
  try {
    const sent = await sendToConfiguredChannels(`✅ <b>${escapeHtml(STORE_NAME)} Channel Test</b>\n\nChannel alerts are working.`, inline([[{ text: '🤖 Open Bot', url: `https://t.me/${getBotUsername() || botUsername}` }]]));
    redirectMsg(res, '/admin-web/channels', `Test sent to ${sent} channel(s)`);
  } catch (err) {
    redirectMsg(res, '/admin-web/channels', 'Test failed: ' + err.message);
  }
});

app.post('/admin-web/channels/rule/add', (req, res) => {
  const keywords = String(req.body.keywords || '').trim();
  const productCode = String(req.body.productCode || '').trim().toUpperCase();
  if (!keywords || !productByCode(productCode)) return redirectMsg(res, '/admin-web/channels', 'Valid keywords and product required');
  db.channelRules ||= [];
  db.channelRules.push({ id: nextChannelRuleId(), keywords, productCode, active: true, createdAt: now() });
  saveData();
  addWebAudit('channel_rule_added', { keywords, productCode }, req);
  redirectMsg(res, '/admin-web/channels', 'Keyword rule added');
});

app.post('/admin-web/channels/rule/:id/toggle', (req, res) => {
  const r = (db.channelRules || []).find(x => x.id === req.params.id);
  if (r) { r.active = r.active === false ? true : false; saveData(); }
  redirectMsg(res, '/admin-web/channels', 'Rule updated');
});

app.post('/admin-web/channels/rule/:id/delete', (req, res) => {
  db.channelRules = (db.channelRules || []).filter(x => x.id !== req.params.id);
  saveData();
  redirectMsg(res, '/admin-web/channels', 'Rule deleted');
});


app.get('/admin-web/description-generator', (req, res) => {
  const body = `<div class="two">
    <div class="card"><h3>✨ AI Description Generator</h3><form method="post" action="/admin-web/description-generator">
      <label>Product Name</label><input name="name" placeholder="Gemini Pro Jio 18 Months Link" required>
      <div class="row"><div><label>Price</label><input name="price" type="number" step="0.01" placeholder="1.8"></div><div><label>Bot Username</label><input name="botUsername" value="${webEsc(getBotUsername() || '')}"></div></div>
      <label>Delivery / Stock Format</label><select name="stockFormat"><option value="redeem_link">🔗 Redeem Link</option><option value="id_password">🔐 ID / Password</option><option value="coupon_code">🎟 Coupon / Code</option><option value="custom">✨ Custom Format</option></select>
      <label>Custom Format (optional)</label><input name="stockFormatCustom" placeholder="Mail|Pass|2fa">
      <label>Short Details / Key Points</label><textarea name="details" placeholder="Instant redeem link&#10;Gemini Pro + 5TB storage&#10;Validity 18 months"></textarea>
      <button class="btn">Generate</button>
    </form></div>
    <div class="card"><h3>💡 Tips</h3><p class="muted">Enter raw points only. Generator will make premium product description, group promo, short promo and stock alert copy.</p></div>
  </div>`;
  res.send(adminLayout('AI Description Generator', body, req.query.msg));
});

app.post('/admin-web/description-generator', (req, res) => {
  const stockFormat = resolveWebStockFormat(req.body.stockFormat, req.body.stockFormatCustom, 'redeem_link');
  const pack = generateDescriptionPack(String(req.body.name || ''), String(req.body.details || ''), { price: req.body.price, botUsername: String(req.body.botUsername || ''), stockFormat });
  const body = `<div class="heroPanel"><h2>✨ Generated Content</h2><div class="muted">Click any box to select and copy manually.</div></div>
  <div class="grid">
    <div class="card"><h3>📦 Product Description</h3><textarea class="preview copyBox" onclick="this.select()" readonly>${webEsc(pack.description)}</textarea></div>
    <div class="card"><h3>📣 Group Promo</h3><textarea class="preview copyBox" onclick="this.select()" readonly>${webEsc(pack.groupPromo)}</textarea></div>
    <div class="card"><h3>⚡ Short Promo</h3><textarea class="preview copyBox" onclick="this.select()" readonly>${webEsc(pack.shortPromo)}</textarea></div>
    <div class="card"><h3>🔔 Stock Alert</h3><textarea class="preview copyBox" onclick="this.select()" readonly>${webEsc(pack.stockAlert)}</textarea></div>
    <div class="card"><h3>🛒 Purchase Alert</h3><textarea class="preview copyBox" onclick="this.select()" readonly>${webEsc(pack.purchaseAlert || '')}</textarea></div>
  </div><br><a class="btn" href="/admin-web/description-generator">Generate Another</a>`;
  addWebAudit('description_generated', { name: String(req.body.name || '') }, req);
  res.send(adminLayout('Generated Description', body, req.query.msg));
});


app.get('/admin-web/stock-tools', (req, res) => {
  const audit = stockAuditSummary();
  const rows = db.products.map(p => {
    const st = stockStatsForProduct(p);
    return `<tr><td><b>${webEsc(p.name)}</b><br><span class="code">${webEsc(p.code)}</span></td><td>${st.total}</td><td>${st.unique}</td><td>${st.duplicates}</td><td>${st.empty}</td><td>${p.active === false ? 'Hidden' : 'Active'}</td><td><form method="post" action="/admin-web/stock-tools/${encodeURIComponent(p.code)}/dedupe"><button class="btn">Remove Duplicates</button></form><a class="btn secondary" href="/admin-web/stock-tools/${encodeURIComponent(p.code)}/export.txt">Export TXT</a><a class="btn secondary" href="/admin-web/products/${encodeURIComponent(p.code)}">Manage</a></td></tr>`;
  }).join('');
  const body = `<div class="heroPanel"><h2>🧹 Stock Tools</h2><div class="muted">Audit stock, remove duplicates and export product stock safely.</div><div class="kpiLine"><span>${audit.totalStock} total stock</span><span>${audit.duplicateCount} duplicates</span><span>${audit.emptyStock} empty products</span><span>${audit.lowStock} low stock</span></div></div>
  <div class="card"><form method="post" action="/admin-web/stock-tools/dedupe-all"><button class="btn">Remove Duplicates From All Products</button></form></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Product</th><th>Total</th><th>Unique</th><th>Duplicates</th><th>Empty</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No products.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Stock Tools', body, req.query.msg));
});

app.post('/admin-web/stock-tools/dedupe-all', (req, res) => {
  let removed = 0;
  for (const p of db.products || []) removed += dedupeProductStock(p);
  addWebAudit('stock_dedupe_all', { removed }, req);
  redirectMsg(res, '/admin-web/stock-tools', `Removed ${removed} duplicate/empty stock item(s).`);
});

app.post('/admin-web/stock-tools/:code/dedupe', (req, res) => {
  const p = productByCode(req.params.code);
  if (!p) return redirectMsg(res, '/admin-web/stock-tools', 'Product not found');
  const removed = dedupeProductStock(p);
  addWebAudit('stock_dedupe_product', { code: p.code, removed }, req);
  redirectMsg(res, '/admin-web/stock-tools', `Removed ${removed} duplicate/empty item(s) from ${p.code}`);
});

app.get('/admin-web/stock-tools/:code/export.txt', (req, res) => {
  const p = productByCode(req.params.code);
  if (!p) return res.status(404).send('Product not found');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${p.code}-stock-${Date.now()}.txt"`);
  res.send((p.stock || []).map(item => typeof stockItemCopyText === 'function' ? stockItemCopyText(item) : String(item)).join('\n'));
});



function dataHelperPage(result = null, reqBody = {}, msg = '') {
  const products = (db.products || []).map(p => `<option value="${webEsc(p.code)}" ${String(reqBody.code || '') === String(p.code) ? 'selected' : ''}>${webEsc(p.code)} · ${webEsc(p.name)} · Stock ${p.stock?.length || 0}</option>`).join('');
  const sample = `PruynStancey098@hotmail.com|Matthew2962136|UPUY54ILYO7QHPNIQCN4YCH6EAOO2PPN\nStrausserHenkhaus392@hotmail.com|Michael1464635|Y5ALB7RQ6UFUBCDSS5HJB35DPZ3XVPBS`;
  const resultHtml = result ? `<br><div class="card"><h3>${result.ok ? '✅ Result' : '❌ Error'}</h3>${result.ok ? `<div class="kpiLine"><span>${result.count} lines</span><span>${result.skipped || 0} skipped</span><span>${bytesHuman(Buffer.byteLength(result.text || '', 'utf8'))}</span></div><textarea class="preview" onclick="this.select()" readonly>${webEsc(result.text)}</textarea><div class="quick"><form method="post" action="/admin-web/data-helper/download"><input type="hidden" name="result" value="${webEsc(result.text)}"><button class="btn">Download TXT</button></form><form method="post" action="/admin-web/data-helper/add-stock"><input type="hidden" name="result" value="${webEsc(result.text)}"><input type="hidden" name="outputFormat" value="${webEsc(reqBody.outputFormat || result.outputFormat || '')}"><select name="code">${products}</select><button class="btn">Add Result To Product Stock</button></form></div>` : `<p>${webEsc(result.error)}</p>`}</div>` : '';

  return `<div class="heroPanel"><h2>🧩 Bulk Data Helper</h2><div class="muted">Extract, merge and convert bulk stock data. Add same website/link/word to every line automatically.</div><div class="kpiLine"><span>Format converter</span><span>Link/email/code extractor</span><span>Direct add to stock</span><span>TXT export</span></div></div>
  <div class="two">
    <div class="card"><h3>🔧 Convert / Merge Format</h3><form method="post" action="/admin-web/data-helper/run">
      <label>Mode</label><select name="mode"><option value="format" ${reqBody.mode !== 'links' && reqBody.mode !== 'emails' && reqBody.mode !== 'codes' ? 'selected' : ''}>Format / Merge Fields</option><option value="links" ${reqBody.mode === 'links' ? 'selected' : ''}>Extract Links</option><option value="emails" ${reqBody.mode === 'emails' ? 'selected' : ''}>Extract Emails</option><option value="codes" ${reqBody.mode === 'codes' ? 'selected' : ''}>Extract Codes</option></select>
      <label>Input Format</label><input name="inputFormat" value="${webEsc(reqBody.inputFormat || 'Mail|Pass|2FA')}" placeholder="Mail|Pass|2FA">
      <label>Output Format</label><input name="outputFormat" value="${webEsc(reqBody.outputFormat || 'Mail|Pass|2FA|2FA Link')}" placeholder="Mail|Pass|2FA|2FA Link">
      <label>Constants / Same Value For All Lines</label><textarea name="constants" placeholder="2FA Link=https://2fa.live/&#10;Website=https://example.com">${webEsc(reqBody.constants || '2FA Link=https://2fa.live/')}</textarea>
      <div class="row"><div><label>Delimiter</label><select name="delimiter"><option value="|" selected>| Pipe</option><option value=",">, Comma</option><option value=";">; Semicolon</option><option value="tab">Tab</option><option value="auto">Auto Detect</option></select></div><div><label>Prefix every line</label><input name="prefix" value="${webEsc(reqBody.prefix || '')}" placeholder="optional"></div><div><label>Suffix every line</label><input name="suffix" value="${webEsc(reqBody.suffix || '')}" placeholder="optional"></div></div>
      <label>Bulk Input Data</label><textarea name="raw" style="min-height:260px" placeholder="${webEsc(sample)}">${webEsc(reqBody.raw || '')}</textarea>
      <label><input type="checkbox" name="dedupe" value="true" ${reqBody.dedupe === 'true' ? 'checked' : ''}> Remove duplicate output lines</label>
      <button class="btn">Generate / Extract</button>
    </form></div>
    <div class="card"><h3>📌 Examples</h3>
      <p><b>Add 2FA website to all lines:</b></p>
      <pre style="white-space:pre-wrap"><code>Input Format: Mail|Pass|2FA
Output Format: Mail|Pass|2FA|2FA Link
Constants: 2FA Link=https://2fa.live/</code></pre>
      <p><b>Add redeem website:</b></p>
      <pre style="white-space:pre-wrap"><code>Input Format: Coupon
Output Format: Coupon|Website
Constants: Website=https://example.com/redeem</code></pre>
      <p><b>Extract links:</b> select mode Extract Links and paste any text.</p>
      <p><b>Direct Add:</b> Generate result then choose product and click Add Result To Product Stock.</p>
    </div>
  </div>${resultHtml}`;
}

app.get('/admin-web/data-helper', (req, res) => {
  res.send(adminLayout('Bulk Data Helper', dataHelperPage(null, {}, req.query.msg), req.query.msg));
});

app.post('/admin-web/data-helper/run', (req, res) => {
  const result = runBulkDataHelper(req.body || {});
  addWebAudit('data_helper_run', { ok: result.ok, count: result.count || 0, mode: req.body.mode || 'format' }, req);
  res.send(adminLayout('Bulk Data Helper', dataHelperPage(result, req.body || {}), req.query.msg));
});

app.post('/admin-web/data-helper/download', (req, res) => {
  const result = String(req.body.result || '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bulk-data-helper-output.txt"');
  res.send(result);
});

app.post('/admin-web/data-helper/add-stock', async (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.body.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/data-helper', 'Product not found');
  const lines = String(req.body.result || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return redirectMsg(res, '/admin-web/data-helper', 'No result lines to add');
  const fmtRaw = String(req.body.outputFormat || p.stockFormat || 'redeem_link').trim();
  const format = normalizeDeliveryFormat(fmtRaw || p.stockFormat || 'redeem_link');
  p.stockFormat = format;
  p.stock ||= [];
  p.stock.push(...lines.map(line => makeStockItem(format, line)));
  p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
  saveData();

  const waitResult = await processStockWaitQueue(p.code, 'data-helper-stock-added');
  const remainingAdded = Math.max(0, lines.length - waitResult.ok);
  if (remainingAdded > 0 && p.stock.length > 0) {
    try { await broadcastStockAlert(p, remainingAdded); } catch (err) { console.error('Data helper stock alert failed:', err.message); }
  }
  addWebAudit('data_helper_add_stock', { code: p.code, count: lines.length, deliveredWaiting: waitResult.ok }, req);
  redirectMsg(res, `/admin-web/products/${encodeURIComponent(p.code)}`, `${lines.length} formatted stock lines added. Waiting paid orders delivered: ${waitResult.ok}`);
});


app.get('/admin-web/stock-manager', (req, res) => {
  const options = db.products.map(p => `<option value="${webEsc(p.code)}">${webEsc(p.code)} · ${webEsc(p.name)} · Stock ${p.stock?.length || 0}</option>`).join('');
  const lowRows = db.products.filter(p => p.active !== false && (p.stock?.length || 0) <= Number(db.settings.lowStockThreshold || 2)).map(p => `<tr><td>${webEsc(p.code)}</td><td>${webEsc(p.name)}</td><td>${p.stock?.length || 0}</td><td><a class="btn secondary" href="/admin-web/products/${encodeURIComponent(p.code)}">Manage</a></td></tr>`).join('');
  const body = `<div class="two">
    <div class="card"><h3>📥 Bulk Add Stock</h3><form method="post" action="/admin-web/stock-manager/add">
      <label>Select Product</label><select name="code">${options}</select>
      <label>Delivery Format</label><select name="stockFormat"><option value="redeem_link">🔗 Redeem Link</option><option value="id_password">🔐 ID / Password</option><option value="coupon_code">🎟 Coupon / Code</option><option value="custom">✨ Custom Format</option></select>
      <label>Custom Format (optional)</label><input name="stockFormatCustom" placeholder="Mail|ChatGPT Pass|Mail Pass|2FA">
      <div class="row"><div><label>Website / Portal</label><input name="deliveryAccessWebsite" placeholder="https://example.com"></div><div><label>Access Link</label><input name="deliveryAccessLink" placeholder="https://example.com/redeem"></div></div>
      <label>Access Instructions</label><textarea name="deliveryAccessInstructions" placeholder="Optional access/delivery instructions"></textarea>
      <label>Stock / Codes / Links</label><textarea name="stock" placeholder="Redeem link: one link per line&#10;Mail|Pass: mail@example.com|pass123&#10;Mail|Pass|2fa: mail@example.com|pass123|ABC123&#10;Coupon: one code per line" required></textarea>
      <button class="btn">Add Stock + Send Alert</button>
    </form></div>
    <div class="card"><h3>⚠️ Low Stock Products</h3><div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Stock</th><th>Action</th></tr></thead><tbody>${lowRows || '<tr><td colspan="4">No low stock products.</td></tr>'}</tbody></table></div></div>
  </div>`;
  res.send(adminLayout('Stock Manager', body, req.query.msg));
});

app.post('/admin-web/stock-manager/add', async (req, res) => {
  const p = db.products.find(x => String(x.code).toUpperCase() === String(req.body.code).toUpperCase());
  if (!p) return redirectMsg(res, '/admin-web/stock-manager', 'Product not found');
  const lines = String(req.body.stock || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return redirectMsg(res, '/admin-web/stock-manager', 'No stock lines found');
  const format = resolveWebStockFormat(req.body.stockFormat, req.body.stockFormatCustom, p.stockFormat || 'redeem_link');
  p.stockFormat = format;
  p.stock ||= [];
  applyProductAccessInfo(p, {
    website: req.body.deliveryAccessWebsite || p.deliveryAccessWebsite || '',
    accessLink: req.body.deliveryAccessLink || p.deliveryAccessLink || '',
    instructions: req.body.deliveryAccessInstructions || p.deliveryAccessInstructions || ''
  });
  p.stock.push(...lines.map(line => makeStockItem(format, line)));
  p.description = smartProductDescription(p.name, p.shortDetails || p.description || '', format);
  saveData();
  const waitResult = await processStockWaitQueue(p.code, 'web-stock-manager');
  const remainingAdded = Math.max(0, lines.length - waitResult.ok);
  if (remainingAdded > 0 && p.stock.length > 0) { try { await broadcastStockAlert(p, remainingAdded); } catch (_) {} }
  addWebAudit('stock_added', { code: p.code, count: lines.length, deliveredWaiting: waitResult.ok }, req);
  redirectMsg(res, '/admin-web/stock-manager', `${lines.length} stock added to ${p.code}. Waiting paid orders delivered: ${waitResult.ok}`);
});



app.get('/admin-web/team-access', (req, res) => {
  if (!adminHasWebPermission(req.webAdmin, 'team_access')) return res.status(403).send(adminLayout('Access denied', '<div class="card"><h2>🔐 Team Access permission required</h2></div>'));
  const body = `<div class="heroPanel"><h2>🔐 Team Web Access</h2><div class="muted">Give secure Web Panel login to your team members. Team must already be added as Telegram admin.</div><div class="kpiLine"><span>${(db.admins||[]).length} admins</span><span>${(db.admins||[]).filter(a=>a.webPasswordHash).length} web logins</span><span>Custom permission controls active</span></div></div>
  <div class="card"><h3>How it works</h3><p class="muted">Add team member in Admin Manager, set role, then set web password here. Login can be Admin ID or username. Roles limit pages automatically.</p></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Web Login</th><th>Last Login</th><th>Action</th></tr></thead><tbody>${webTeamRows() || '<tr><td colspan="6">No admins.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Team Web Access', body, req.query.msg));
});

app.post('/admin-web/team-access/:id/password', (req, res) => {
  if (!adminHasWebPermission(req.webAdmin, 'team_access')) return redirectMsg(res, '/admin-web/dashboard', 'Access denied');
  const a = (db.admins || []).find(x => String(x.id) === String(req.params.id));
  const pw = String(req.body.password || '');
  if (!a) return redirectMsg(res, '/admin-web/team-access', 'Admin not found');
  if (pw.length < 6) return redirectMsg(res, '/admin-web/team-access', 'Password must be at least 6 characters');
  a.webPasswordHash = hashWebPassword(pw);
  a.webPasswordSetAt = now();
  saveData();
  addWebAudit('team_web_password_set', { id: a.id, username: a.username || '' }, req);
  redirectMsg(res, '/admin-web/team-access', 'Web password set securely');
});


app.post('/admin-web/team-access/:id/permissions', (req, res) => {
  if (!adminHasWebPermission(req.webAdmin, 'team_access')) return redirectMsg(res, '/admin-web/dashboard', 'Access denied');
  const a = (db.admins || []).find(x => String(x.id) === String(req.params.id));
  if (!a) return redirectMsg(res, '/admin-web/team-access', 'Admin not found');
  let perms = req.body.permissions || [];
  if (!Array.isArray(perms)) perms = [perms];
  a.permissions = normalizePermissionList(perms);
  if (String(a.id) === ADMIN_ID || String(a.role).toLowerCase() === 'owner') a.permissions = ['all'];
  a.permissionsUpdatedAt = now();
  a.permissionsUpdatedBy = req.webAdmin?.id || req.webAdmin?.username || 'web';
  saveData();
  addWebAudit('team_permissions_updated', { id: a.id, permissions: a.permissions }, req);
  redirectMsg(res, '/admin-web/team-access', 'Permissions updated');
});

app.post('/admin-web/team-access/:id/clear', (req, res) => {
  if (!adminHasWebPermission(req.webAdmin, 'team_access')) return redirectMsg(res, '/admin-web/dashboard', 'Access denied');
  const a = (db.admins || []).find(x => String(x.id) === String(req.params.id));
  if (!a) return redirectMsg(res, '/admin-web/team-access', 'Admin not found');
  delete a.webPasswordHash;
  delete a.webPasswordSetAt;
  saveData();
  addWebAudit('team_web_password_clear', { id: a.id, username: a.username || '' }, req);
  redirectMsg(res, '/admin-web/team-access', 'Web login disabled for team member');
});


app.get('/admin-web/admins', (req, res) => {
  const admins = adminList();
  const rows = admins.map(a => {
    const canEdit = String(a.id) !== ADMIN_ID;
    return `<tr><td><b>${webEsc(a.name || 'Admin')}</b><br>${a.username ? '@'+webEsc(a.username) : ''}<br><span class="code">${webEsc(a.id)}</span></td><td>${webEsc(adminRoleLabel(a.role))}</td><td>${a.active === false ? '⛔ Disabled' : '✅ Active'}</td><td>${webEsc(a.addedBy || '-')}<br><span class="muted">${webEsc(a.addedAt ? new Date(a.addedAt).toLocaleString() : '-')}</span></td><td class="actions">${canEdit ? `<form method="post" action="/admin-web/admins/${encodeURIComponent(a.id)}/toggle"><button class="btn secondary">${a.active === false ? 'Enable' : 'Disable'}</button></form><form method="post" action="/admin-web/admins/${encodeURIComponent(a.id)}/role"><select name="role"><option value="manager">Manager</option><option value="support">Support</option><option value="stock">Stock</option><option value="finance">Finance</option><option value="viewer">Viewer</option></select><button class="btn secondary">Set Role</button></form><form method="post" action="/admin-web/admins/${encodeURIComponent(a.id)}/remove"><button class="btn danger">Remove</button></form>` : '<span class="muted">Main owner</span>'}</td></tr>`;
  }).join('');
  const logs = (db.adminActionLogs || []).slice(0, 40).map(l => `<tr><td><b>${webEsc(l.action)}</b><br><span class="muted">${webEsc(new Date(l.at).toLocaleString())}</span></td><td><span class="code">${webEsc(l.by || '-')}</span></td><td><span class="code">${webEsc(l.target || '-')}</span></td><td>${webEsc(JSON.stringify(l.detail || {})).slice(0, 160)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>👑 Admin Manager</h2><div class="muted">Add, disable, remove and monitor Telegram admins. Main owner is always protected.</div><div class="kpiLine"><span>${admins.length} total admins</span><span>${admins.filter(a=>a.active!==false).length} active</span><span>${(db.adminActionLogs||[]).length} logs</span></div></div>
  <div class="two"><div class="card"><h3>➕ Add Admin</h3><form method="post" action="/admin-web/admins/add"><label>User ID or @username</label><input name="ref" placeholder="123456789 or @username" required><label>Role</label><select name="role"><option value="manager">🛡 Manager</option><option value="support">🎫 Support</option><option value="stock">📦 Stock</option><option value="finance">💰 Finance</option><option value="viewer">👁 Viewer</option></select><button class="btn">Add Admin</button></form><p class="muted small">Username works only if the user has already started the bot.</p></div>
  <div class="card"><h3>📣 Message All Admins</h3><form method="post" action="/admin-web/admins/broadcast"><textarea name="message" placeholder="Message for admins..." required></textarea><button class="btn">Send Broadcast</button></form></div></div><br>
  <div class="tableWrap"><h3>Admins</h3><table class="table"><thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Added</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No admins.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>Admin Action Logs</h3><table class="table"><thead><tr><th>Action</th><th>By</th><th>Target</th><th>Detail</th></tr></thead><tbody>${logs || '<tr><td colspan="4">No logs yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Admin Manager', body, req.query.msg));
});

app.post('/admin-web/admins/add', async (req, res) => {
  const ref = String(req.body.ref || '').trim();
  const role = normalizeAdminRole(req.body.role || 'manager');
  const user = findUserByRef(ref);
  const id = user?.telegramId || ref.replace('@', '');
  if (!/^\\d+$/.test(String(id))) return redirectMsg(res, '/admin-web/admins', 'Valid numeric Telegram user ID required. Username works only after user starts bot.');
  if (String(id) === ADMIN_ID || adminList().some(a => String(a.id) === String(id))) return redirectMsg(res, '/admin-web/admins', 'This user is already admin.');
  db.admins.push({ id: String(id), username: user?.username || '', name: user?.firstName || 'Admin', role, active: true, addedBy: req.webAdmin?.username || 'web-admin', addedAt: now(), note: 'Added from web admin manager' });
  saveData();
  addAdminLog('admin_added_web', req.webAdmin?.username || 'web-admin', id, { role });
  addWebAudit('telegram_admin_added', { id, role }, req);
  try { await sendMessage(id, `✅ You have been added as admin in ${escapeHtml(STORE_NAME)}.\\nRole: <b>${escapeHtml(adminRoleLabel(role))}</b>\\n\\nSend /admin to open admin panel.`); } catch (_) {}
  redirectMsg(res, '/admin-web/admins', 'Admin added successfully.');
});

app.post('/admin-web/admins/:id/toggle', async (req, res) => {
  const id = String(req.params.id);
  if (id === ADMIN_ID) return redirectMsg(res, '/admin-web/admins', 'Main owner cannot be disabled.');
  const a = adminList().find(x => String(x.id) === id);
  if (!a) return redirectMsg(res, '/admin-web/admins', 'Admin not found.');
  a.active = a.active === false ? true : false;
  saveData();
  addAdminLog(a.active ? 'admin_enabled_web' : 'admin_disabled_web', req.webAdmin?.username || 'web-admin', id, {});
  addWebAudit('telegram_admin_toggle', { id, active: a.active }, req);
  try { await sendMessage(id, a.active ? '✅ Your admin access has been enabled.' : '⛔ Your admin access has been disabled.'); } catch (_) {}
  redirectMsg(res, '/admin-web/admins', a.active ? 'Admin enabled.' : 'Admin disabled.');
});

app.post('/admin-web/admins/:id/role', async (req, res) => {
  const id = String(req.params.id);
  if (id === ADMIN_ID) return redirectMsg(res, '/admin-web/admins', 'Main owner role cannot be changed.');
  const a = adminList().find(x => String(x.id) === id);
  if (!a) return redirectMsg(res, '/admin-web/admins', 'Admin not found.');
  a.role = normalizeAdminRole(req.body.role || 'manager');
  saveData();
  addAdminLog('admin_role_changed_web', req.webAdmin?.username || 'web-admin', id, { role: a.role });
  addWebAudit('telegram_admin_role', { id, role: a.role }, req);
  try { await sendMessage(id, `🛡 Your admin role changed to: ${adminRoleLabel(a.role)}`); } catch (_) {}
  redirectMsg(res, '/admin-web/admins', 'Role updated.');
});

app.post('/admin-web/admins/:id/remove', async (req, res) => {
  const id = String(req.params.id);
  if (id === ADMIN_ID) return redirectMsg(res, '/admin-web/admins', 'Main owner cannot be removed.');
  db.admins = adminList().filter(a => String(a.id) !== id);
  saveData();
  addAdminLog('admin_removed_web', req.webAdmin?.username || 'web-admin', id, {});
  addWebAudit('telegram_admin_removed', { id }, req);
  try { await sendMessage(id, '🗑 Your admin access has been removed.'); } catch (_) {}
  redirectMsg(res, '/admin-web/admins', 'Admin removed.');
});

app.post('/admin-web/admins/broadcast', async (req, res) => {
  const msg = String(req.body.message || '').trim();
  const sent = await notifyAllAdmins(`📣 <b>Admin Broadcast</b>\\n\\n${escapeHtml(msg)}`, adminButtons());
  addAdminLog('admin_broadcast_web', req.webAdmin?.username || 'web-admin', 'all_admins', { sent, length: msg.length });
  addWebAudit('admin_broadcast', { sent }, req);
  redirectMsg(res, '/admin-web/admins', `Broadcast sent to ${sent} admin(s).`);
});



app.get('/admin-web/security', (req, res) => {
  const s = securitySummary();
  const logRows = (db.securityLogs || []).slice(0, 200).map(l => `<tr><td><b>${webEsc(l.type)}</b><br><span class="muted">${webEsc(new Date(l.at).toLocaleString())}</span></td><td><span class="code">${webEsc(l.userId || '-')}</span></td><td>${webEsc(l.severity || 'info')}</td><td>${webEsc(JSON.stringify(l.detail || {})).slice(0, 240)}</td></tr>`).join('');
  const lockRows = Object.keys(db.securityLocks || {}).filter(isUserSecurityLocked).map(id => {
    const lock = db.securityLocks[id] || {};
    return `<tr><td><span class="code">${webEsc(id)}</span></td><td>${webEsc(lock.reason || '-')}</td><td>${webEsc(lock.until ? new Date(lock.until).toLocaleString() : 'manual')}</td><td><form method="post" action="/admin-web/security/unlock/${encodeURIComponent(id)}"><button class="btn">Unlock</button></form></td></tr>`;
  }).join('');
  const body = `<div class="heroPanel"><h2>🛡 Security Center</h2><div class="muted">Rate limits, suspicious payment protection, TXID duplicate detection and user locks.</div><div class="kpiLine"><span>${s.locks.length} locked users</span><span>${s.suspiciousPayments.length} suspicious payments</span><span>${s.dupRefs.length} duplicate TXID groups</span><span>${(db.securityLogs||[]).length} security logs</span></div></div>
  <div class="two"><div class="card"><h3>Manual Lock User</h3><form method="post" action="/admin-web/security/lock"><input name="telegramId" placeholder="Telegram ID" required><input name="minutes" type="number" value="60"><input name="reason" placeholder="Reason"><button class="btn danger">Lock User</button></form></div>
  <div class="card"><h3>Security Settings</h3><p class="muted">Change limits from Settings page.</p><a class="btn" href="/admin-web/settings">Open Settings</a></div></div><br>
  <div class="tableWrap"><h3>Locked Users</h3><table class="table"><thead><tr><th>User</th><th>Reason</th><th>Until</th><th>Action</th></tr></thead><tbody>${lockRows || '<tr><td colspan="4">No locked users.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>Security Logs</h3><table class="table"><thead><tr><th>Type</th><th>User</th><th>Severity</th><th>Detail</th></tr></thead><tbody>${logRows || '<tr><td colspan="4">No security logs yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Security Center', body, req.query.msg));
});

app.post('/admin-web/security/lock', (req, res) => {
  const id = String(req.body.telegramId || '').trim();
  const minutes = Number(req.body.minutes || 60);
  const reason = String(req.body.reason || 'Manual web security lock').trim();
  if (!id) return redirectMsg(res, '/admin-web/security', 'Telegram ID required');
  lockUserSecurity(id, reason, minutes);
  addWebAudit('security_user_locked', { id, minutes, reason }, req);
  redirectMsg(res, '/admin-web/security', 'User locked');
});

app.post('/admin-web/security/unlock/:id', (req, res) => {
  unlockUserSecurity(req.params.id);
  addWebAudit('security_user_unlocked', { id: req.params.id }, req);
  redirectMsg(res, '/admin-web/security', 'User unlocked');
});


app.get('/admin-web/audit', (req, res) => {
  const rows = (db.webAudit || []).slice(0, 200).map(a => `<tr><td><b>${webEsc(a.action)}</b><br><span class="muted">${webEsc(new Date(a.at).toLocaleString())}</span></td><td><span class="code">${webEsc(a.ip || '-')}</span></td><td>${webEsc(JSON.stringify(a.detail || {})).slice(0, 240)}</td></tr>`).join('');
  const body = `<div class="card"><h3>🛡 Web Admin Audit Logs</h3><p class="muted">Recent login, announcement, stock and description generator actions.</p></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Action</th><th>IP</th><th>Detail</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No audit logs yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Audit Logs', body, req.query.msg));
});



app.get('/admin-web/health-speed', (req, res) => {
  const s = runtimeHealthSnapshot();
  const apiRows = (runtimeStats.apiSamples || []).slice(-50).reverse().map(x => `<tr><td>${webEsc(new Date(x.at).toLocaleTimeString())}</td><td>${webEsc(x.method)}</td><td>${x.ok ? '🟢 OK' : '🔴 FAIL'}</td><td>${x.ms} ms</td></tr>`).join('');
  const logRows = (db.healthLogs || []).slice(0, 50).map(l => `<tr><td>${webEsc(new Date(l.at).toLocaleString())}</td><td>${webEsc(l.severity)}</td><td>${webEsc(l.type)}</td><td>${webEsc(JSON.stringify(l.detail || {})).slice(0,240)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>⚡ Health & Speed Checker</h2><div class="muted">Live bot health, Telegram API speed and hosting load.</div><div class="kpiLine"><span>${healthStatusEmoji(s)} ${s.ok ? 'Healthy' : 'Needs Attention'}</span><span>${s.apiAvg}ms API avg</span><span>${s.apiP95}ms P95</span><span>${s.ramMb}MB RAM</span><span>${s.errors} errors</span><span>${s.apiErrors} API errors</span></div></div>
  <div class="quick"><form method="post" action="/admin-web/health-speed/speedtest"><button class="btn">Run Speed Test</button></form><a class="btn" href="/health">Health JSON</a><a class="btn secondary" href="/admin-web/system">System</a></div><br>
  <div class="grid"><div class="card"><h3>⏱ Uptime</h3><div class="stat">${webEsc(s.uptime)}</div></div><div class="card"><h3>🚀 API Avg</h3><div class="stat">${s.apiAvg}ms</div></div><div class="card"><h3>📈 API P95</h3><div class="stat">${s.apiP95}ms</div></div><div class="card"><h3>🧠 RAM</h3><div class="stat">${s.ramMb}MB</div></div></div><br>
  <div class="tableWrap"><h3>Recent API Samples</h3><table class="table"><thead><tr><th>Time</th><th>Method</th><th>Status</th><th>Speed</th></tr></thead><tbody>${apiRows || '<tr><td colspan="4">No samples yet.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>Health Logs</h3><table class="table"><thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Detail</th></tr></thead><tbody>${logRows || '<tr><td colspan="4">No health logs.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Health & Speed', body, req.query.msg));
});

app.post('/admin-web/health-speed/speedtest', async (req, res) => {
  const result = await runSpeedTest();
  addHealthLog('web_speed_test', { totalMs: result.totalMs, tests: result.tests }, result.totalMs > Number(db.settings.speedWarnMs || 2500) ? 'warn' : 'info');
  redirectMsg(res, '/admin-web/health-speed', `Speed test complete: ${result.totalMs}ms`);
});


app.get('/admin-web/stock-wait', (req, res) => {
  const list = stockWaitPayments();
  const rows = list.map(p => {
    const product = productByCode(p.productCode);
    return `<tr><td><code>${webEsc(p.id)}</code><br><span class="muted">${webEsc(p.status)}</span></td><td>${webEsc(p.productName || product?.name || '-')}<br><span class="muted">${webEsc(p.productCode || '')}</span></td><td><code>${webEsc(p.telegramId)}</code></td><td>${webEsc(p.qty || 1)}</td><td>${webMoney(p.amount || 0)}</td><td>${product?.stock?.length || 0}</td><td>${webEsc(p.stockWaitAt ? new Date(p.stockWaitAt).toLocaleString() : '-')}</td></tr>`;
  }).join('');
  const logRows = (db.stockWaitLogs || []).slice(0, 80).map(l => `<tr><td>${webEsc(new Date(l.at).toLocaleString())}</td><td>${webEsc(l.severity)}</td><td>${webEsc(l.type)}</td><td><code>${webEsc(l.paymentId || '-')}</code></td><td>${webEsc(JSON.stringify(l.detail || {})).slice(0,240)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>⏳ Stock Wait Queue</h2><div class="muted">Paid orders that could not be delivered because stock finished during payment.</div><div class="kpiLine"><span>${list.length} waiting paid orders</span><span>Expiry ${paymentExpiryMinutes()}m</span><span>Auto Delivery ${db.settings.stockWaitAutoDelivery === false ? 'OFF' : 'ON'}</span><span>Priority First ${db.settings.stockWaitPriorityFirst === false ? 'OFF' : 'ON'}</span></div></div>
  <div class="quick"><form method="post" action="/admin-web/stock-wait/process"><button class="btn">Process Queue Now</button></form><form method="post" action="/admin-web/stock-wait/expire"><button class="btn secondary">Expire Old Pending</button></form><a class="btn secondary" href="/admin-web/products">Add Stock</a></div><br>
  <div class="tableWrap"><h3>Waiting Paid Orders</h3><table class="table"><thead><tr><th>Payment</th><th>Product</th><th>User</th><th>Qty</th><th>Paid</th><th>Stock</th><th>Waiting Since</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No paid orders waiting for stock.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>Stock Wait Logs</h3><table class="table"><thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Payment</th><th>Detail</th></tr></thead><tbody>${logRows || '<tr><td colspan="5">No logs.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Stock Wait Queue', body, req.query.msg));
});

app.post('/admin-web/stock-wait/process', async (req, res) => {
  const r = await processStockWaitQueue('', 'manual');
  redirectMsg(res, '/admin-web/stock-wait', `Queue processed: ${r.ok} delivered, ${r.skipped} skipped, ${r.fail} failed`);
});

app.post('/admin-web/stock-wait/expire', async (req, res) => {
  const r = await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
  redirectMsg(res, '/admin-web/stock-wait', `Expired ${r.count} pending payments and notified ${r.notified}`);
});


app.get('/admin-web/safe-delivery', (req, res) => {
  const s = safeDeliverySummary();
  const failedRows = s.failed.map(o => `<tr><td><code>${webEsc(o.id)}</code></td><td>${webEsc(o.productName)}</td><td><code>${webEsc(o.telegramId)}</code></td><td>${webEsc(o.deliveryError || '-')}</td><td><form method="post" action="/admin-web/safe-delivery/retry/${encodeURIComponent(o.id)}"><button class="btn">Retry</button></form></td></tr>`).join('');
  const logRows = (db.deliveryAuditLogs || []).slice(0, 80).map(l => `<tr><td>${webEsc(new Date(l.at).toLocaleString())}</td><td>${webEsc(l.severity)}</td><td>${webEsc(l.type)}</td><td><code>${webEsc(l.orderId || '-')}</code></td><td>${webEsc(JSON.stringify(l.detail || {})).slice(0,240)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🚚 Safe Delivery Center</h2><div class="muted">Delivery audit, failed delivery retry and order safety checks.</div><div class="kpiLine"><span>${s.sent.length} sent</span><span>${s.failed.length} failed</span><span>${s.noItems.length} no item</span><span>${s.dupPay.length} duplicate payments</span><span>${s.approvedNoOrder.length} approved without order</span></div></div>
  <div class="quick"><form method="post" action="/admin-web/safe-delivery/retry-failed"><button class="btn">Retry Failed Deliveries</button></form><a class="btn secondary" href="/admin-web/orders">Orders</a><a class="btn secondary" href="/admin-web/payment-risk">Payment Risk</a></div><br>
  <div class="tableWrap"><h3>Failed Deliveries</h3><table class="table"><thead><tr><th>Order</th><th>Product</th><th>User</th><th>Error</th><th>Action</th></tr></thead><tbody>${failedRows || '<tr><td colspan="5">No failed deliveries.</td></tr>'}</tbody></table></div><br>
  <div class="tableWrap"><h3>Delivery Audit Logs</h3><table class="table"><thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Order</th><th>Detail</th></tr></thead><tbody>${logRows || '<tr><td colspan="5">No logs.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Safe Delivery', body, req.query.msg));
});

app.post('/admin-web/safe-delivery/retry-failed', async (req, res) => {
  const r = await retryFailedDeliveries(25);
  redirectMsg(res, '/admin-web/safe-delivery', `Retry complete: ${r.ok} success, ${r.fail} failed`);
});

app.post('/admin-web/safe-delivery/retry/:id', async (req, res) => {
  const o = (db.orders || []).find(x => String(x.id) === String(req.params.id));
  if (!o) return redirectMsg(res, '/admin-web/safe-delivery', 'Order not found');
  try {
    await sendDeliveryMessage(o.telegramId, o.productName, o.qty, o.total, o.currency, o.deliveredItems || [], o.id, o.productCode);
    redirectMsg(res, '/admin-web/safe-delivery', 'Delivery retry sent');
  } catch (err) {
    redirectMsg(res, '/admin-web/safe-delivery', 'Retry failed: ' + err.message);
  }
});

app.get('/admin-web/security-scan', (req, res) => {
  const s = securityScanSummary();
  const riskRows = s.manyFails.slice(0,100).map(p => `<tr><td><code>${webEsc(p.id)}</code></td><td><code>${webEsc(p.telegramId)}</code></td><td>${webEsc(p.productName || p.type || '-')}</td><td>${p.failedVerifyAttempts || 0}</td><td>${webEsc(p.lastCheckReason || '-')}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🛡 Security Scan</h2><div class="muted">Risk payments, locks, duplicate TXIDs and pending review scanner.</div><div class="kpiLine"><span>${s.locked.length} locked</span><span>${s.banned.length} banned</span><span>${s.manyFails.length} high fail</span><span>${s.duplicateRefs.length} duplicate refs</span><span>${s.oldPending.length} old pending</span></div></div>
  <div class="quick"><a class="btn" href="/admin-web/security">Security Center</a><a class="btn" href="/admin-web/payment-risk">Payment Risk</a><a class="btn" href="/admin-web/quick-find">Quick Find</a></div><br>
  <div class="tableWrap"><h3>High Failed Payments</h3><table class="table"><thead><tr><th>Payment</th><th>User</th><th>Product</th><th>Attempts</th><th>Reason</th></tr></thead><tbody>${riskRows || '<tr><td colspan="5">No high-risk payments.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Security Scan', body, req.query.msg));
});


app.get('/admin-web/telegram-diagnostics', (req, res) => {
  const s = getWebStats();
  const rows = [
    ['Bot username', '@' + webEsc(getBotUsername() || botUsername || '-')],
    ['Uptime', webEsc(runtimeUptimeText())],
    ['Updates', runtimeStats.updates],
    ['Messages', runtimeStats.messages],
    ['Callbacks', runtimeStats.callbacks],
    ['Errors', runtimeStats.errors],
    ['Products', `${s.active.length} active / ${s.hidden.length} hidden`],
    ['Users', Object.keys(db.users || {}).length],
    ['Orders', (db.orders || []).length],
    ['Alert Groups', `${(db.alertGroups||[]).length} total / ${activeAlertGroups().length} active`],
    ['Web Base URL', webBaseUrl() || 'Not set'],
    ['Feature Version', db.settings.featureVersion || '-']
  ].map(r => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🧪 App + Web Admin Check</h2><div class="muted">Use this page to confirm Telegram app admin and Web admin feature parity.</div></div>
  <div class="quick"><a class="btn" href="/admin-web/groups">Group Alerts</a><a class="btn" href="/admin-web/groups/keyword-test">Keyword Test</a><a class="btn" href="/admin-web/system">System</a><a class="btn" href="/health">Health JSON</a></div><br>
  <div class="tableWrap"><table class="table"><tbody>${rows}</tbody></table></div>
  <br><div class="card"><h3>Telegram Commands</h3><p><code>/admin</code> <code>/diag</code> <code>/web</code> <code>/features</code> <code>/testbuttons</code> <code>/groups</code> <code>/testkeyword gemini</code></p></div>`;
  res.send(adminLayout('App + Web Admin Check', body, req.query.msg));
});

app.get('/admin-web/feature-map', (req, res) => {
  const body = `<div class="heroPanel"><h2>🧾 Feature Map</h2><div class="muted">Telegram app and Web admin feature map.</div></div>
  <div class="card"><pre style="white-space:pre-wrap">${webEsc(adminFeatureMapText().replace(/<[^>]+>/g, ''))}</pre></div>`;
  res.send(adminLayout('Feature Map', body, req.query.msg));
});


app.get('/admin-web/system', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  const body = `<div class="grid">
    <div class="card"><h3>⏱ Uptime</h3><div class="stat">${Math.floor(uptime/3600)}h</div><div class="muted">${uptime}s total</div></div>
    <div class="card"><h3>🧠 RAM Used</h3><div class="stat">${Math.round(mem.rss/1024/1024)} MB</div></div>
    <div class="card"><h3>🟢 Node</h3><div class="stat">${webEsc(process.version)}</div></div>
    <div class="card"><h3>📁 Data</h3><div class="stat">${Object.keys(db.users || {}).length}</div><div class="muted">users in data.json</div></div>
    <div class="card"><h3>💾 Backups</h3><div class="stat">${listDataBackups().length}</div><div class="muted">${db.settings.autoBackupEnabled === false ? 'auto off' : 'auto on'}</div></div>
  </div><br><div class="card"><h3>✅ Health</h3><p>Bot process is running. Use Export Backup before major changes.</p><div class="quick"><a class="btn" href="/health">Open Health JSON</a><a class="btn" href="/admin-web/health-speed">Health & Speed</a><a class="btn" href="/admin-web/safe-delivery">Safe Delivery</a><a class="btn secondary" href="/admin-web/export">Download Backup</a></div></div>`;
  res.send(adminLayout('System Health', body, req.query.msg));
});


app.get('/admin-web/export/users.csv', (req, res) => {
  const header = 'telegramId,firstName,username,balance,orders,referrals\n';
  const rows = Object.values(db.users || {}).map(u => {
    const orders = db.orders.filter(o => o.telegramId === String(u.telegramId)).length;
    return [u.telegramId, JSON.stringify(u.firstName || ''), JSON.stringify(u.username || ''), Number(u.balance || 0), orders, Number(u.referrals || 0)].join(',');
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="global-ott-users-${Date.now()}.csv"`);
  res.send(header + rows);
});

app.get('/admin-web/export/orders.csv', (req, res) => {
  const header = 'orderId,telegramId,productCode,productName,qty,total,currency,method,createdAt\n';
  const rows = db.orders.map(o => [o.id, o.telegramId, o.productCode, JSON.stringify(o.productName || ''), o.qty, o.total, o.currency, JSON.stringify(o.method || ''), o.createdAt].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="global-ott-orders-${Date.now()}.csv"`);
  res.send(header + rows);
});


app.get('/admin-web/business-summary', (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days || 1)));
  const s = businessSummary(days);
  const rows = s.topProducts.map(p => `<tr><td>${webEsc(p.code)}</td><td>${webEsc(p.name)}</td><td>${p.qty}</td><td>${webMoney(p.revenue)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🧾 Business Summary</h2><div class="muted">Live business performance summary for selected period.</div><div class="kpiLine"><span>${days} day view</span><span>${s.orders.length} orders</span><span>${s.qty} items sold</span><span>${webMoney(s.revenue)} revenue</span><span>${webMoney(s.profit.profit)} profit</span><span>${s.pending} pending</span></div></div>
  <div class="card"><form method="get" action="/admin-web/business-summary"><label>Days</label><input name="days" type="number" value="${days}" min="1" max="90"><button class="btn">Update</button></form></div><br>
  <div class="tableWrap"><h3>Top Products</h3><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Qty</th><th>Revenue</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No sales.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Business Summary', body, req.query.msg));
});

app.get('/admin-web/inventory-valuation', (req, res) => {
  const s = inventoryValuation();
  const rows = s.rows.map(r => `<tr><td>${webEsc(r.code)}</td><td><b>${webEsc(r.name)}</b><br><span class="muted">${webEsc(r.category)}</span></td><td>${r.stock}</td><td>${webMoney(r.price)}</td><td>${webMoney(r.cost)}</td><td>${webMoney(r.retailValue)}</td><td>${webMoney(r.costValue)}</td><td>${webMoney(r.potentialProfit)}</td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>🏷 Inventory Valuation</h2><div class="muted">Stock value, cost value and potential profit based on current inventory.</div><div class="kpiLine"><span>${s.totalStock} total stock</span><span>${webMoney(s.retailValue)} retail value</span><span>${webMoney(s.costValue)} cost value</span><span>${webMoney(s.potentialProfit)} potential profit</span><span>${s.lowStock} low stock</span><span>${s.zeroStock} zero stock</span></div></div>
  <div class="quick"><a class="btn" href="/admin-web/export/inventory.csv">Export Inventory CSV</a><a class="btn secondary" href="/admin-web/products">Manage Products</a></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Stock</th><th>Sell Price</th><th>Cost</th><th>Retail Value</th><th>Cost Value</th><th>Profit</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No products.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Inventory Valuation', body, req.query.msg));
});

app.get('/admin-web/export/inventory.csv', (req, res) => {
  const s = inventoryValuation();
  const header = 'code,name,category,stock,sell_price,cost_price,retail_value,cost_value,potential_profit\n';
  const rows = s.rows.map(r => [r.code, JSON.stringify(r.name || ''), JSON.stringify(r.category || ''), r.stock, r.price, r.cost, r.retailValue, r.costValue, r.potentialProfit].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="global-ott-inventory-${Date.now()}.csv"`);
  res.send(header + rows);
});


app.get('/admin-web/reports', (req, res) => {
  const profit = profitSummary();
  const byProduct = {};
  db.orders.forEach(o => {
    byProduct[o.productCode] ||= { name: o.productName, qty: 0, revenue: 0 };
    byProduct[o.productCode].qty += Number(o.qty || 0);
    byProduct[o.productCode].revenue += Number(o.total || 0);
  });
  const rows = Object.entries(byProduct).sort((a,b)=>b[1].revenue-a[1].revenue).map(([code, r]) => `<tr><td>${webEsc(code)}</td><td>${webEsc(r.name)}</td><td>${r.qty}</td><td>${webMoney(r.revenue)}</td></tr>`).join('');
  const body = `<div class="grid"><div class="card"><h3>💰 Revenue</h3><div class="stat">${webMoney(db.orders.reduce((a,o)=>a+Number(o.total||0),0))}</div></div><div class="card"><h3>🧾 Orders</h3><div class="stat">${db.orders.length}</div></div><div class="card"><h3>📦 Products Sold</h3><div class="stat">${db.orders.reduce((a,o)=>a+Number(o.qty||0),0)}</div></div><div class="card"><h3>🎫 Open Tickets</h3><div class="stat">${openTickets().length}</div></div><div class="card"><h3>📈 Profit</h3><div class="stat">${webMoney(profit.profit)}</div><div class="muted">${profit.margin.toFixed(1)}% margin</div></div><div class="card"><h3>🚫 Banned</h3><div class="stat">${Object.values(db.users||{}).filter(u=>u.banned).length}</div></div></div><br><div class="tableWrap"><table class="table"><thead><tr><th>Code</th><th>Product</th><th>Qty Sold</th><th>Revenue</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No sales yet.</td></tr>'}</tbody></table></div><br><div class="quick"><a class="btn" href="/admin-web/export/users.csv">Export Users CSV</a><a class="btn" href="/admin-web/export/orders.csv">Export Orders CSV</a></div>`;
  res.send(adminLayout('Reports', body, req.query.msg));
});



app.get('/admin-web/backups', (req, res) => {
  const backups = listDataBackups();
  const rows = backups.map(b => `<tr><td><b>${webEsc(b.file)}</b><br><span class="muted">${webEsc(new Date(b.createdAt).toLocaleString())}</span></td><td>${webEsc(bytesHuman(b.size))}</td><td><a class="btn" href="/admin-web/backups/${encodeURIComponent(b.file)}/download">Download</a><form method="post" action="/admin-web/backups/${encodeURIComponent(b.file)}/delete"><button class="btn danger">Delete</button></form></td></tr>`).join('');
  const body = `<div class="heroPanel"><h2>💾 Backup Manager</h2><div class="muted">Create and download safe data.json backups before major changes.</div><div class="kpiLine"><span>${backups.length} backups</span><span>Current users ${Object.keys(db.users||{}).length}</span><span>Orders ${db.orders.length}</span><span>Products ${db.products.length}</span></div></div>
  <div class="card"><form method="post" action="/admin-web/backups/create"><button class="btn">Create Backup Now</button></form><p class="muted small">Backups are stored inside hosting app folder: /backups</p></div><br>
  <div class="tableWrap"><table class="table"><thead><tr><th>File</th><th>Size</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No backups created yet.</td></tr>'}</tbody></table></div>`;
  res.send(adminLayout('Backup Manager', body, req.query.msg));
});

app.post('/admin-web/backups/create', (req, res) => {
  try {
    const b = createDataBackup('web');
    addWebAudit('backup_created', { file: b.file, size: b.size }, req);
    redirectMsg(res, '/admin-web/backups', `Backup created: ${b.file}`);
  } catch (err) {
    redirectMsg(res, '/admin-web/backups', 'Backup failed: ' + err.message);
  }
});

app.get('/admin-web/backups/:name/download', (req, res) => {
  const name = safeBackupName(req.params.name);
  const full = path.join(backupDirPath(), name);
  if (!name || !fs.existsSync(full)) return res.status(404).send('Backup not found');
  res.download(full, name);
});

app.post('/admin-web/backups/:name/delete', (req, res) => {
  const name = safeBackupName(req.params.name);
  const full = path.join(backupDirPath(), name);
  if (name && fs.existsSync(full)) fs.unlinkSync(full);
  addWebAudit('backup_deleted', { file: name }, req);
  redirectMsg(res, '/admin-web/backups', 'Backup deleted');
});


app.get('/admin-web/export', (req, res) => {
  const safeName = `global-ott-store-data-${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.send(JSON.stringify(db, null, 2));
});


let autoScannerRunning = false;
let autoScannerStarted = false;

function paymentsForAutoScan() {
  const maxAgeMs = Number(db.settings.autoVerifyMaxAgeHours || 24) * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  return (db.payments || []).filter(p => {
    if (!p || ['approved', 'cancelled', 'rejected', 'review', 'expired'].includes(String(p.status || '').toLowerCase())) return false;
    if (['stock_issue', 'stock_wait'].includes(String(p.status || '').toLowerCase())) return false;
    if (paymentExpired(p)) return false;
    const created = Date.parse(p.createdAt || p.expiresAt || now());
    if (Number.isFinite(created) && created < cutoff) return false;
    return true;
  });
}

async function autoScannerTick() {
  await expirePendingPaymentsAndNotify(paymentExpiryMinutes());
  if (db.settings.autoVerifyEnabled === false) return;
  if (autoScannerRunning) return;
  autoScannerRunning = true;
  try {
    const list = paymentsForAutoScan();
    if (!list.length) return;
    console.log(`🤖 Auto verifier scanning ${list.length} payment(s)...`);

    for (const payment of list) {
      try {
        const result = await verifyPayment(payment);
        payment.lastCheck = now();
        if (result.ok) {
          const msg = await autoApprovePayment(payment, result, 'background-auto-scanner');
          autoVerifyLog('success', msg, { paymentId: payment.id, type: payment.type, amount: payment.amount, matchType: result.matchType, txId: result.txId || '' });
          console.log(`✅ Auto verified ${payment.id}: ${msg}`);
        } else {
          payment.lastCheckReason = result.reason;
          if (payment.status !== 'review') payment.status = 'pending';
          saveData();
          await maybeSendPaymentReminder(payment);
        }
      } catch (err) {
        payment.lastCheck = now();
        payment.lastCheckReason = err.message;
        if (payment.status !== 'review') payment.status = 'pending';
        saveData();
        autoVerifyLog('error', `Payment ${payment.id} scan failed: ${err.message}`, { paymentId: payment.id });
      }
      await new Promise(r => setTimeout(r, 350));
    }
  } finally {
    autoScannerRunning = false;
  }
}

function startAutoVerifier() {
  if (autoScannerStarted) return;
  autoScannerStarted = true;
  const sec = Math.max(10, Number(db.settings.autoVerifyIntervalSec || 25));
  console.log(`🤖 Full auto Binance verifier started. Interval: ${sec}s`);
  setInterval(() => autoScannerTick().catch(err => console.error('Auto verifier tick failed:', err.message)), sec * 1000);
  setInterval(() => expirePendingPaymentsAndNotify(paymentExpiryMinutes()).catch(err => console.error('Payment expiry tick failed:', err.message)), 60 * 1000);
  setTimeout(() => autoScannerTick().catch(err => console.error('Auto verifier initial scan failed:', err.message)), 5000);
}


// Vercel serverless: export the express app, skip polling + listen
if (IS_VERCEL) {
  console.log('☁️ Vercel serverless mode: exporting express app, skipping polling.');
  module.exports = app;
} else {
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ Health server running on port ${PORT}`));
  console.log(`🌐 Web admin URL: /admin-web`);

  async function startPolling() {
    try {
      await tg('deleteWebhook', { drop_pending_updates: false }, 12000);
      console.log('✅ Webhook cleared for polling');
    } catch (err) {
      console.log('⚠️ deleteWebhook failed:', err.message);
    }

    console.log('🔁 Polling loop started');
    while (true) {
      try {
        const updates = await tgGet('getUpdates', {
          timeout: POLL_TIMEOUT,
          offset: updateOffset,
          allowed_updates: JSON.stringify(['message', 'callback_query', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member'])
        }, 30000);

        if (updates.length) console.log(`📬 Received ${updates.length} update(s)`);
        if (!updates.length && Date.now() - lastHeartbeat > 60000) {
          console.log('💓 Polling alive, waiting for Telegram updates...');
          lastHeartbeat = Date.now();
        }

        for (const upd of updates) {
          runtimeStats.updates++;
          updateOffset = upd.update_id + 1;
          await handleUpdate(upd);
        }
      } catch (err) {
        console.error('❌ Polling error:', err.message);
        if (String(err.message).includes('409')) {
          console.error('🚨 409 Conflict: same BOT_TOKEN is running somewhere else. Stop old deployment or revoke token.');
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async function startup() {
    if (!getBotToken() || !/^\d+:[A-Za-z0-9_-]+$/.test(getBotToken())) {
      console.error('❌ BOT_TOKEN missing or invalid. Web admin panel is running at http://localhost:' + PORT + '/admin-web — set BOT_TOKEN there.');
      return;
    }
    const me = await tgGet('getMe');
    botUsername = me.username || botUsername;
    if (!db.settings.botUsername) {
      db.settings.botUsername = botUsername;
      saveData();
    }
    console.log(`✅ Telegram connected as @${botUsername}`);
    console.log(`🔗 Configured bot username: @${getBotUsername() || botUsername}`);
    console.log('✅ Inline chat-screen UI active. Old bottom keyboard will be removed on /start.');
    startAutoVerifier();
    startScheduledBackups();
    startPolling();
  }

  startup().catch((err) => console.error('❌ Startup failed:', err?.stack || err?.message || err));
}
