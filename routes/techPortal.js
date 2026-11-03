const express = require('express');
const { logger } = require('../config/logger');
const crypto = require('crypto');
const router = express.Router();
const techSvc = require('../services/techService');
const customerSvc = require('../services/customerService');
const customerMapSvc = require('../services/customerMapService');
const customerOnuSerialSvc = require('../services/customerOnuSerialService');
const mapOltStatusSvc = require('../services/mapOltStatusService');
const odpSvc = require('../services/odpService');
const { getSetting, getNowLocal, getNowLocalISO, formatDateLocal, getSettings, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const mikrotikService = require('../services/mikrotikService');
const networkTopologyStatusSvc = require('../services/networkTopologyStatusService');
const db = require('../config/database');
// Separate technician ONU provisioning queue from customer creation.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS tech_onu_jobs (
    customer_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    pon_id INTEGER,
    onu_id INTEGER,
    onu_sn TEXT,
    last_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provisioned_at TEXT,
    technician_id INTEGER
  )`);
} catch (e) { console.error('[TECH ONU JOBS] table init failed:', e.message); }
try {
  const techJobColumns = new Set(db.prepare('PRAGMA table_info(tech_onu_jobs)').all().map(column => column.name));
  if (techJobColumns.size && !techJobColumns.has('onu_vendor')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN onu_vendor TEXT NOT NULL DEFAULT ''");
  if (techJobColumns.size && !techJobColumns.has('olt_index')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN olt_index TEXT NOT NULL DEFAULT ''");
  if (techJobColumns.size && !techJobColumns.has('reboot_method')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN reboot_method TEXT NOT NULL DEFAULT 'acs'");
} catch (e) { console.error('[TECH ONU JOBS] column migration failed:', e.message); }
const oltSvc = require('../services/oltService');
const onuProvisionSvc = require('../services/onuProvisionService');
const onuWanProvisionSvc = require('../services/onuWanProvisionService');
const fiberHomeFirmwareSvc = require('../services/fiberHomeFirmwareService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const genieacsApi = require('../config/genieacs');
const rawAxios = require('axios');
const techAiSvc = require('../services/techAiService');

// AI Teknisi hanya memproses gambar di RAM; foto tidak ditulis ke folder publik.
const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    cb(new Error('Foto harus JPEG, PNG, atau WebP.'));
  }
});

function validAiImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

const axios = {
  get: async (url, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && (url.startsWith('local/') || url === 'local')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.get(reqPath, config);
    }
    return rawAxios.get(url, config);
  },
  post: async (url, data, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.post(reqPath, data, config);
    }
    return rawAxios.post(url, data, config);
  },
  delete: async (url, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.delete(reqPath, config);
    }
    return rawAxios.delete(url, config);
  },
  put: async (url, data, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.put(reqPath, data, config);
    }
    return rawAxios.put(url, data, config);
  }
};

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../public/uploads/tickets');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ticket-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diperbolehkan (JPEG, PNG, GIF, WebP)'));
    }
  }
});

const waSendDedup = new Map();
function normalizeWaDigits(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  if (digits.length < 8) return '';
  return digits;
}
function shouldSendWa(key, ttlMs = 15000) {
  const now = Date.now();
  const last = waSendDedup.get(key);
  if (last && (now - last) < ttlMs) return false;
  waSendDedup.set(key, now);
  if (waSendDedup.size > 5000) {
    for (const [k, t] of waSendDedup.entries()) {
      if ((now - t) > 10 * 60 * 1000) waSendDedup.delete(k);
    }
  }
  return true;
}

function requireTechSession(req, res, next) {
  if (req.session && req.session.isTechnician && req.session.techId) {
    return next();
  }
  const wantsJson = String(req.get('accept') || '').includes('application/json') || String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
  if (wantsJson) return res.status(401).json({ success: false, code: 'TECH_SESSION_EXPIRED', message: 'Sesi teknisi sudah habis. Login kembali untuk melanjutkan pemeriksaan status.' });
  return res.redirect('/tech/login');
}

// Each provisioning/binding task belongs to exactly one technician account.
// Never reveal or mutate another technician's task by guessing a customer ID.
function requireOwnedOnuJob(req, res, next) {
  const rawId = req.params.customerId || req.query.customer_id || req.query.customerId || (req.body && req.body.customer_id);
  const customerId = Number(rawId);
  const technicianId = Number(req.session && req.session.techId);
  const wantsJson = String(req.get('accept') || '').includes('application/json') ||
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
  if (!Number.isSafeInteger(customerId) || customerId < 1 || !Number.isSafeInteger(technicianId) || technicianId < 1) {
    if (wantsJson) return res.status(404).json({ success: false, message: 'Tugas binding tidak ditemukan di akun teknisi ini.' });
    req.session._msg = { type: 'error', text: 'Tugas binding tidak ditemukan di akun teknisi ini.' };
    return res.redirect('/tech/provisioning');
  }
  const job = db.prepare('SELECT customer_id, status, technician_id FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? LIMIT 1')
    .get(customerId, technicianId);
  if (!job) {
    if (wantsJson) return res.status(404).json({ success: false, message: 'Tugas binding tidak ditemukan di akun teknisi ini.' });
    req.session._msg = { type: 'error', text: 'Tugas binding tidak ditemukan di akun teknisi ini.' };
    return res.redirect('/tech/provisioning');
  }
  req.ownedOnuJob = job;
  return next();
}

// A fresh action may create a new task, but may not take over another technician's task.
function preventOtherTechOnuJob(req, res, next) {
  const customerId = Number(req.params.customerId);
  const technicianId = Number(req.session && req.session.techId);
  const wantsJson = String(req.get('accept') || '').includes('application/json') ||
    String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
  const reject = () => {
    const message = 'Tugas binding tidak ditemukan di akun teknisi ini.';
    if (wantsJson) return res.status(404).json({ success: false, message });
    req.session._msg = { type: 'error', text: message };
    return res.redirect('/tech/provisioning');
  };
  if (!Number.isSafeInteger(customerId) || customerId < 1 || !Number.isSafeInteger(technicianId) || technicianId < 1) return reject();
  const job = db.prepare('SELECT technician_id FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(customerId);
  if (job && Number(job.technician_id) !== technicianId) return reject();
  return next();
}

// Binding Saja and network edits must respect the existing queue owner.
// This is checked both at request entry and again inside the write transaction.
function assertBindingOnlyTaskOwner(customerId, technicianId, options = {}) {
  const job = db.prepare('SELECT customer_id, status, technician_id FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(customerId);
  if (!job) return null;
  const owner = Number(job.technician_id || 0);
  const status = String(job.status || '').toLowerCase();
  // Binding that is already done is no longer exclusive to its original technician.
  // It may be selected by anyone, but claimBindingOnlyTask atomically changes it to
  // working and assigns the new owner before any asynchronous OLT/RouterOS operation.
  if (status === 'done' && options.allowCompletedTakeover === true) return job;
  if (owner > 0 && owner !== Number(technicianId)) {
    throw new Error('Tugas binding untuk pelanggan ini tidak tersedia di akun teknisi ini. Hubungi admin bila perlu diperiksa.');
  }
  if (owner <= 0 && status !== 'pending') {
    throw new Error('Tugas binding ini belum memiliki pemilik teknisi. Minta admin menetapkan pemilik tugas sebelum melanjutkan.');
  }
  return job;
}

function guardBindingOnlyTaskOwner(req, res, next) {
  const customerId = Number(req.body && req.body.customer_id);
  const technicianId = Number(req.session && req.session.techId);
  // Let the route's normal validation render the canonical message for malformed IDs.
  if (!Number.isSafeInteger(customerId) || customerId < 1) return next();
  try {
    assertBindingOnlyTaskOwner(customerId, technicianId, { allowCompletedTakeover: true });
    return next();
  } catch (e) {
    req.session._msg = { type: 'error', text: String(e.message || e) };
    return res.redirect('/tech/binding-only?customer_id=' + customerId);
  }
}

// Atomically claim unqueued customers before any RouterOS/OLT side effect.
// SQLite's IMMEDIATE transaction makes simultaneous claims by different technicians exclusive.
function claimBindingOnlyTask(customerId, technicianId, options = {}) {
  let created = false;
  let claimed = false;
  const claim = db.transaction(() => {
    let job = assertBindingOnlyTaskOwner(customerId, technicianId, options);
    if (!job) {
      const inserted = db.prepare(`INSERT OR IGNORE INTO tech_onu_jobs
        (customer_id, status, last_message, technician_id)
        VALUES (?, 'pending', 'Tugas binding diklaim oleh teknisi; verifikasi SN dan OLT sebelum melanjutkan.', ?)`)
        .run(customerId, technicianId);
      created = inserted.changes > 0;
      claimed = created;
    } else if (String(job.status || '').toLowerCase() === 'done' && options.allowCompletedTakeover === true) {
      const previousOwner = Number(job.technician_id || 0);
      const updated = db.prepare(`UPDATE tech_onu_jobs SET status='working', technician_id=?,
        last_message='Binding sebelumnya sudah done. Tugas diambil teknisi baru untuk pemeriksaan ulang.', updated_at=CURRENT_TIMESTAMP
        WHERE customer_id=? AND status='done' AND COALESCE(technician_id,0)=?`).run(technicianId, customerId, previousOwner);
      if (!updated.changes) throw new Error('Tugas binding baru saja diambil teknisi lain. Muat ulang daftar pelanggan.');
      claimed = true;
    } else if (Number(job.technician_id || 0) <= 0 && String(job.status || '') === 'pending') {
      const updated = db.prepare(`UPDATE tech_onu_jobs SET technician_id=?,
        last_message='Tugas binding ulang diklaim setelah SN lama terhapus dan diverifikasi dari OLT.', updated_at=CURRENT_TIMESTAMP
        WHERE customer_id=? AND status='pending' AND COALESCE(technician_id,0)=0`).run(technicianId, customerId);
      if (!updated.changes) throw new Error('Tugas binding baru saja diklaim teknisi lain. Muat ulang daftar pelanggan.');
      claimed = true;
    }
    job = db.prepare('SELECT customer_id, status, technician_id FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(customerId);
    if (!job || Number(job.technician_id || 0) !== Number(technicianId)) {
      throw new Error('Tugas binding untuk pelanggan ini tidak tersedia di akun teknisi ini. Hubungi admin bila perlu diperiksa.');
    }
  });
  claim.immediate();
  return { created, claimed };
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function company() { return getSetting('company_header', 'ISP App'); }

router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.settings = getSettings();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  next();
});

let loginRateLimiter = (req, res, next) => next();
try {
  const rlMod = require('../middleware/rateLimiter');
  if (rlMod && typeof rlMod.loginRateLimiter === 'function') {
    loginRateLimiter = rlMod.loginRateLimiter;
  }
} catch (e) {}

// --- AUTH ---
router.get('/login', (req, res) => {
  if (req.session && req.session.isTechnician) return res.redirect('/tech');
  res.render('tech/login', { title: 'Teknisi Login', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const tech = techSvc.authenticate(username, password);
  if (tech) {
    req.session.isTechnician = true;
    req.session.techId = tech.id;
    req.session.techName = tech.name;
    return res.redirect('/tech');
  }
  res.render('tech/login', { title: 'Teknisi Login', company: company(), error: 'Username atau password salah!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/tech/login');
});

// --- TECHNICIAN USER GUIDE ---
router.get('/guide', requireTechSession, (req, res) => {
  res.render('tech/guide', {
    title: 'Panduan Teknisi',
    company: company(),
    activePage: 'guide',
    msg: flashMsg(req)
  });
});

// --- AI TEKNISI: chat lokal + foto + pemeriksaan server read-only ---
router.get('/ai', requireTechSession, (req, res) => {
  res.render('tech/ai', {
    title: 'Gawa 😎 · Asisten Teknisi',
    company: company(),
    activePage: 'ai',
    msg: flashMsg(req)
  });
});

router.get('/api/ai/status', requireTechSession, async (req, res) => {
  try { res.json(await techAiSvc.status()); }
  catch (err) { res.status(200).json({ localOnly: true, modelAvailable: false, detail: 'Status model lokal belum tersedia.' }); }
});

router.get('/api/ai/history', requireTechSession, (req, res) => {
  try { res.json({ success: true, messages: techAiSvc.getHistory(req.session.techId, 30) }); }
  catch (err) { console.error('[TECH AI] history read failed:', err.message); res.status(500).json({ success: false, message: 'Riwayat chat belum dapat dibaca.' }); }
});

router.post('/api/ai/history/clear', requireTechSession, (req, res) => {
  try {
    const deleted = techAiSvc.clearHistory(req.session.techId);
    res.json({ success: true, deleted, message: 'Riwayat chat Gawa berhasil direset.' });
  } catch (err) {
    console.error('[TECH AI] history clear failed:', err.message);
    res.status(500).json({ success: false, message: 'Riwayat chat belum dapat direset.' });
  }
});

router.get('/api/ai/jobs/:jobId', requireTechSession, (req, res) => {
  const job = techAiSvc.getJob(req.params.jobId, req.session.techId);
  if (!job) return res.status(404).json({ success: false, message: 'Tugas AI tidak ditemukan atau bukan milik akun ini.' });
  res.json(job);
});

router.post('/api/ai/chat', requireTechSession, (req, res, next) => {
  aiUpload.single('photo')(req, res, err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Foto maksimal 5 MB.' : err.message || 'Upload foto gagal.' });
    next();
  });
}, (req, res) => {
  try {
    const image = req.file || null;
    if (image && !validAiImage(image.buffer, image.mimetype)) return res.status(400).json({ success: false, message: 'Isi file tidak cocok dengan gambar JPEG, PNG, atau WebP.' });
    const message = String(req.body.message || '').trim();
    const diagnose = req.body.diagnose === '1';
    if (!message && !image && !diagnose) return res.status(400).json({ success: false, message: 'Tulis pertanyaan atau lampirkan foto terlebih dahulu.' });
    const jobId = techAiSvc.startChat({
      technicianId: req.session.techId,
      message,
      diagnose,
      imageBuffer: image ? image.buffer : null,
      imageMime: image ? image.mimetype : null
    });
    res.status(202).json({ success: true, pending: true, jobId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'AI Teknisi gagal memulai permintaan.' });
  }
});

// --- DASHBOARD (My Tickets) ---
router.get('/', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const stats = techSvc.getTechStats(techId);
  const techProfile = techSvc.getTechById(techId) || {
    id: techId, username: '', name: req.session.techName || 'Teknisi', phone: '', area: '', is_active: 1, created_at: null
  };
  const myTickets = techSvc.getAssignedTickets(techId);
  const provisioningCount = db.prepare("SELECT COUNT(*) AS count FROM tech_onu_jobs WHERE technician_id=? AND status <> 'done'").get(techId).count;
  
  res.render('tech/dashboard', {
    title: 'Dashboard Teknisi',
    company: company(),
    techName: techProfile.name || req.session.techName,
    techProfile,
    activePage: 'dashboard',
    stats,
    tickets: myTickets,
    provisioningCount,
    msg: flashMsg(req)
  });
});

// --- OPEN TICKETS (Pool) ---
router.get('/pool', requireTechSession, (req, res) => {
  const openTickets = techSvc.getOpenTickets();
  res.render('tech/pool', {
    title: 'Tiket Baru', 
    company: company(), 
    activePage: 'pool',
    tickets: openTickets,
    msg: flashMsg(req)
  });
});

// --- HISTORY TICKETS ---
router.get('/history', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const historyTickets = techSvc.getResolvedTickets(techId);
  res.render('tech/history', {
    title: 'Riwayat Tiket', 
    company: company(), 
    activePage: 'history',
    tickets: historyTickets,
    msg: flashMsg(req)
  });
});

// --- NETWORK MAP ---
router.get('/map', requireTechSession, (req, res) => {
  const customers = customerMapSvc.getAllMapCustomers();
  const odps = odpSvc.getAllOdps();
  const odcs = db.prepare('SELECT d.*, o.name AS olt_name FROM odcs d LEFT JOIN olts o ON o.id = d.olt_id ORDER BY d.name COLLATE NOCASE ASC').all();
  let routers = [];
  let olts = [];
  try {
    routers = mikrotikService.getAllRouters().map(r => ({
      id: Number(r.id),
      name: r.name || ('MikroTik #' + r.id),
      host: r.host || '',
      lat: Number(r.lat),
      lng: Number(r.lng),
      is_active: Number(r.is_active) !== 0
    }));
  } catch (e) { console.warn('[TECH MAP] gagal membaca MikroTik:', e.message); }
  try {
    olts = oltSvc.getAllOlts().map(o => ({
      id: Number(o.id),
      name: o.name || ('OLT #' + o.id),
      host: o.host || '',
      brand: o.brand || '',
      pon_port_count: Number(o.pon_port_count) > 0 ? Number(o.pon_port_count) : null,
      lat: Number(o.lat),
      lng: Number(o.lng),
      is_active: Number(o.is_active) !== 0
    }));
  } catch (e) { console.warn('[TECH MAP] gagal membaca OLT:', e.message); }

  const validGps = odps.filter(o => Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)) && Number(o.lat) !== 0 && Number(o.lng) !== 0);
  const settings = getSetting('office_lat') ? { office_lat: getSetting('office_lat'), office_lng: getSetting('office_lng') } : {};
  const center = validGps.length
    ? { lat: validGps.reduce((s, o) => s + Number(o.lat), 0) / validGps.length, lng: validGps.reduce((s, o) => s + Number(o.lng), 0) / validGps.length }
    : { lat: Number(settings.office_lat) || -6.2, lng: Number(settings.office_lng) || 106.816666 };

  olts = olts.map(o => {
    const related = odps.filter(x => Number(x.olt_id) === Number(o.id) && Number(x.lat) && Number(x.lng));
    const hasStored = Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)) && Number(o.lat) !== 0 && Number(o.lng) !== 0;
    const p = hasStored ? { lat: Number(o.lat), lng: Number(o.lng) }
      : (related.length ? { lat: related.reduce((s, x) => s + Number(x.lat), 0) / related.length, lng: related.reduce((s, x) => s + Number(x.lng), 0) / related.length } : center);
    return Object.assign({}, o, p, { virtual_position: !hasStored && !related.length });
  });
  const routerFallback = olts.length
    ? { lat: olts.reduce((s, o) => s + Number(o.lat), 0) / olts.length, lng: olts.reduce((s, o) => s + Number(o.lng), 0) / olts.length }
    : center;
  routers = routers.map((r, idx) => {
    const hasStored = Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && Number(r.lat) !== 0 && Number(r.lng) !== 0;
    return Object.assign({}, r, hasStored
      ? { lat: Number(r.lat), lng: Number(r.lng), virtual_position: false }
      : { lat: routerFallback.lat + (idx * 0.00015), lng: routerFallback.lng + (idx * 0.00015), virtual_position: true });
  });

  // Topologi kabel untuk teknisi: gunakan jalur manual admin bila tersedia,
  // jika belum ada maka gambar jalur otomatis antar perangkat yang memang terhubung.
  let manualCablePaths = [];
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS network_cable_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      path_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(segment_type, source_type, source_id, target_type, target_id)
    )`);
    manualCablePaths = db.prepare('SELECT * FROM network_cable_paths ORDER BY id ASC').all();
  } catch (e) {
    console.warn('[TECH MAP] gagal membaca jalur kabel:', e.message);
  }

  const topologyLinks = [];
  const odpById = new Map(odps.map(o => [Number(o.id), o]));
  const odcById = new Map(odcs.map(o => [Number(o.id), o]));
  const oltById = new Map(olts.map(o => [Number(o.id), o]));
  const routerById = new Map(routers.map(r => [Number(r.id), r]));

  // Pelanggan -> ODP
  customers.forEach(c => {
    if (c.odp_id && odpById.has(Number(c.odp_id)) && Number(c.lat) && Number(c.lng)) {
      topologyLinks.push({
        source_type: 'customer', source_id: Number(c.id),
        target_type: 'odp', target_id: Number(c.odp_id),
        status: c.status === 'active' ? 'active' : 'inactive',
        segment_type: 'odp-customer', manual_path: null
      });
    }
  });

  // Alur kabel baku: ODP -> ODC -> OLT -> MikroTik. Tidak menggambar bypass ODP -> OLT.
  odps.forEach(o => {
    const odcId = o.odc_id && odcById.has(Number(o.odc_id)) ? Number(o.odc_id) : null;
    if (!odcId) return;
    const manual = manualCablePaths.find(p => p.segment_type === 'odp-odc' && Number(p.source_id) === Number(o.id) && Number(p.target_id) === odcId);
    topologyLinks.push({ source_type:'odp', source_id:Number(o.id), target_type:'odc', target_id:odcId, status:manual ? manual.status : 'unknown', segment_type:'odp-odc', manual_path:manual ? JSON.parse(manual.path_json || '[]') : null });
  });

  odcs.forEach(d => {
    const oltId = d.olt_id && oltById.has(Number(d.olt_id)) ? Number(d.olt_id) : (olts.length === 1 ? Number(olts[0].id) : null);
    if (!oltId) return;
    const manual = manualCablePaths.find(p => p.segment_type === 'odc-olt' && Number(p.source_id) === Number(d.id) && Number(p.target_id) === oltId);
    topologyLinks.push({ source_type:'odc', source_id:Number(d.id), target_type:'olt', target_id:oltId, status:manual ? manual.status : 'unknown', segment_type:'odc-olt', manual_path:manual ? JSON.parse(manual.path_json || '[]') : null });
  });

  // OLT -> MikroTik
  const manualBackbone = manualCablePaths.filter(p => p.segment_type === 'olt-router');
  if (manualBackbone.length) {
    manualBackbone.forEach(p => topologyLinks.push({
      source_type: 'olt', source_id: Number(p.source_id),
      target_type: 'router', target_id: Number(p.target_id),
      status: p.status, segment_type: 'olt-router',
      manual_path: JSON.parse(p.path_json || '[]')
    }));
  } else if (olts.length === 1 && routers.length === 1) {
    topologyLinks.push({ source_type: 'olt', source_id: Number(olts[0].id), target_type: 'router', target_id: Number(routers[0].id), status: 'unknown', segment_type: 'olt-router', manual_path: null, inferred: true });
  }

  res.render('tech/map', {
    title: 'Peta Jaringan',
    company: company(),
    activePage: 'map',
    customers,
    odps,
    odcs,
    routers,
    olts,
    topologyLinks,
    msg: flashMsg(req),
    settings
  });
});

// --- ACTIONS ---
router.post('/tickets/:id/take', requireTechSession, (req, res) => {
  try {
    techSvc.takeTicket(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Tiket berhasil diambil. Silakan mulai kerjakan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mengambil tiket: ' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tickets/:id/close', requireTechSession, (req, res) => {
  try {
    techSvc.closeTicket(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Tugas berhasil ditandai selesai dan masuk Riwayat Tugas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menutup tugas: ' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tickets/:id/update', requireTechSession, upload.array('photos', 10), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const ticketId = req.params.id;
    const techId = req.session.techId;

    // Prepare photo data
    let photoPaths = [];
    let photoMetadata = [];

    if (req.files && req.files.length > 0) {
      photoPaths = req.files.map(f => '/uploads/tickets/' + f.filename);
      photoMetadata = req.files.map((f, idx) => ({
        filename: f.filename,
        originalName: f.originalname,
        size: f.size,
        uploadedAt: getNowLocalISO(),
        lat: req.body.gps_lat || '',
        lng: req.body.gps_lng || ''
      }));
    }

    // Update ticket with photos and notes
    techSvc.updateTicketStatus(ticketId, techId, status, {
      notes: notes || '',
      photos: JSON.stringify(photoPaths),
      photoMetadata: JSON.stringify(photoMetadata)
    });

    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET ---
    if (status === 'resolved') {
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const settings = getSettingsWithCache();

        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticketSvc = require('../services/ticketService');
          const ticket = ticketSvc.getTicketById(ticketId);

          if (ticket) {
            const photoCount = photoPaths.length;
            const photoText = photoCount > 0 ? `\n📸 *Foto Pekerjaan:* ${photoCount} foto terlampir` : '';

            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Teknisi:* ${req.session.techName}${photoText}\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              const digits = normalizeWaDigits(ticket.customer_phone);
              if (digits) {
                const key = `ticket:resolved:customer:${ticketId}:${digits}`;
                if (shouldSendWa(key)) await sendWA(digits, waMsg);
              }
            }

            // Kirim ke Admin dengan info foto
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const notesText = notes ? `\n💬 *Catatan:* ${notes}` : '';
              const adminMsg = `✅ *LAPORAN TIKET SELESAI*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `🛠️ *Teknisi:* ${req.session.techName}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}${notesText}${photoText}`;
              const recipients = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                const digits = normalizeWaDigits(adminPhone);
                if (digits) recipients.add(digits);
              }
              for (const digits of recipients) {
                const key = `ticket:resolved:admin:${ticketId}:${digits}`;
                if (!shouldSendWa(key)) continue;
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[TechPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('/tech');
});

// --- MONITORING ONU ---
router.get('/monitoring', requireTechSession, async (req, res) => {
  const acsServers = genieacsApi.getAllACSServers();
  let pppoeProfiles = [];
  try {
      const selectedRouterId = req.query.router_id ? Number(req.query.router_id) : null;
      pppoeProfiles = await mikrotikService.getPppoeProfiles(selectedRouterId);
  } catch (e) {
      console.error('Failed to load PPPoE profiles from MikroTik:', e.message);
  }
  res.render('tech/monitoring', {
    title: 'Monitoring ONU', company: company(), activePage: 'monitoring',
    acsServers, pppoeProfiles, msg: flashMsg(req)
  });
});

// Save legacy customer coordinates and optional ODP without running provisioning.
router.post('/provisioning/customer/:customerId/location', requireTechSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const customerId = Number(req.params.customerId);
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid');
    const customer = db.prepare('SELECT id FROM customers WHERE id=?').get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    const latText = String(req.body.lat || '').trim();
    const lngText = String(req.body.lng || '').trim();
    const lat = latText === '' ? null : Number(latText);
    const lng = lngText === '' ? null : Number(lngText);
    if ((latText !== '' && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lngText !== '' && (!Number.isFinite(lng) || lng < -180 || lng > 180))) throw new Error('Koordinat tidak valid. Latitude -90 sampai 90, longitude -180 sampai 180.');
    if ((lat === null) !== (lng === null)) throw new Error('Isi latitude dan longitude sekaligus, atau kosongkan keduanya.');
    const odpId = String(req.body.odp_id || '').trim() ? Number(req.body.odp_id) : null;
    if (odpId !== null && (!Number.isSafeInteger(odpId) || !odpSvc.getOdpById(odpId))) throw new Error('ODP yang dipilih tidak ditemukan');
    db.prepare('UPDATE customers SET lat=?, lng=?, odp_id=? WHERE id=?').run(lat === null ? '' : String(lat), lng === null ? '' : String(lng), odpId, customerId);
    req.session._msg = { type: 'success', text: 'Lokasi pelanggan berhasil disimpan. Belum ada perubahan pada OLT.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan lokasi: ' + e.message };
  }
  res.redirect('/tech/provisioning/import');
});

// Import legacy customers selectively; never enqueue every existing customer automatically.
router.get('/provisioning/import', requireTechSession, (req, res) => {
  try {
    const candidates = db.prepare(`
      SELECT c.id, c.name, c.phone, c.address, c.pppoe_username, c.genieacs_tag, c.olt_id, c.odp_id, c.lat, c.lng,
             p.name AS package_name, o.name AS olt_name, d.name AS odp_name
      FROM customers c
      LEFT JOIN tech_onu_jobs j ON j.customer_id = c.id
      LEFT JOIN packages p ON p.id = c.package_id
      LEFT JOIN olts o ON o.id = c.olt_id
      LEFT JOIN odps d ON d.id = c.odp_id
      WHERE j.customer_id IS NULL AND COALESCE(c.status, 'active') = 'active'
        AND COALESCE(c.genieacs_tag, '') = ''
      ORDER BY c.name COLLATE NOCASE LIMIT 500
    `).all();
    const odps = odpSvc.getAllOdps();
    res.render('tech/provisioning_import', { title: 'Migrasi Customer', company: company(), activePage: 'provisioning', candidates, odps, msg: flashMsg(req) });
  } catch (e) {
    console.error('[TECH PROVISIONING IMPORT] gagal memuat pelanggan:', e.message);
    req.session._msg = { type: 'error', text: 'Daftar pelanggan lama gagal dimuat: ' + e.message };
    res.redirect('/tech/provisioning');
  }
});

router.post('/provisioning/import', requireTechSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const raw = req.body.customer_ids;
    const ids = [...new Set((Array.isArray(raw) ? raw : (raw ? [raw] : [])).map(v => Number(v)).filter(v => Number.isSafeInteger(v) && v > 0))].slice(0, 500);
    if (!ids.length) {
      req.session._msg = { type: 'error', text: 'Pilih minimal satu pelanggan terlebih dahulu.' };
      return res.redirect('/tech/provisioning/import');
    }
    const insert = db.prepare(`INSERT INTO tech_onu_jobs (customer_id, status, last_message, technician_id)
      SELECT c.id, 'pending', 'Pelanggan lama dipilih manual; periksa lokasi ONU sebelum binding', ?
      FROM customers c LEFT JOIN tech_onu_jobs j ON j.customer_id=c.id
      WHERE c.id=? AND j.customer_id IS NULL AND COALESCE(c.status, 'active')='active'
        AND COALESCE(c.genieacs_tag, '')=''`);
    let added = 0;
    const tx = db.transaction(() => { for (const id of ids) added += insert.run(req.session.techId || null, id).changes; });
    tx();
    req.session._msg = { type: added ? 'success' : 'error', text: added ? `${added} pelanggan lama dimasukkan ke antrean. Pastikan pelanggan benar-benar belum terpasang di OLT sebelum binding.` : 'Tidak ada pelanggan yang dapat dimasukkan; mungkin sudah ada di antrean atau sudah memiliki tag ACS.' };
  } catch (e) {
    console.error('[TECH PROVISIONING IMPORT] gagal menyimpan:', e.message);
    req.session._msg = { type: 'error', text: 'Gagal memasukkan pelanggan: ' + e.message };
  }
  res.redirect('/tech/provisioning');
});

// Jarak binding wajib diverifikasi dari koordinat pelanggan ke ODP (garis lurus).
// Batas 200 m berlaku di server supaya tidak bisa dilewati dari browser/API langsung.
function assertOdpDistanceWithin200m(customerLatValue, customerLngValue, odp) {
  const customerLatText = String(customerLatValue == null ? '' : customerLatValue).trim();
  const customerLngText = String(customerLngValue == null ? '' : customerLngValue).trim();
  const odpLatText = String(odp && odp.lat != null ? odp.lat : '').trim();
  const odpLngText = String(odp && odp.lng != null ? odp.lng : '').trim();
  const customerLat = Number(customerLatText), customerLng = Number(customerLngText);
  const odpLat = Number(odpLatText), odpLng = Number(odpLngText);
  const customerValid = customerLatText !== '' && customerLngText !== '' && Number.isFinite(customerLat) && Number.isFinite(customerLng) && customerLat >= -90 && customerLat <= 90 && customerLng >= -180 && customerLng <= 180;
  const odpValid = odpLatText !== '' && odpLngText !== '' && Number.isFinite(odpLat) && Number.isFinite(odpLng) && odpLat >= -90 && odpLat <= 90 && odpLng >= -180 && odpLng <= 180;
  if (!customerValid) throw new Error('GPS pelanggan wajib diisi agar jarak ke ODP bisa dibatasi maksimal 200 meter. Tekan Ambil GPS saat di lokasi pelanggan.');
  if (!odpValid) throw new Error('Koordinat GPS ODP belum tersedia/valid. Minta admin melengkapi lokasi ODP sebelum binding.');
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(odpLat - customerLat);
  const dLng = toRad(odpLng - customerLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(customerLat)) * Math.cos(toRad(odpLat)) * Math.sin(dLng / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  if (!Number.isFinite(distance)) throw new Error('Jarak pelanggan ke ODP gagal dihitung. Periksa koordinat GPS.');
  // A micrometre-scale epsilon avoids rejecting a mathematically exact 200 m because of floating-point GPS math; it does not relax the practical 200 m limit.
  if (distance > 200 + 1e-6) throw new Error('Jarak pelanggan ke ODP sekitar ' + Math.round(distance) + ' meter. Batas binding 200 meter; pilih ODP lain yang lebih dekat.');
  return Math.round(distance);
}

// Standalone modem-only binding: authorizes an ONU on HSGQ without changing PPPoE/WAN settings.
// Legacy URL: technicians now use the full Provisioning workflow.
function guardBindingOnlySelectedCustomer(req, res, next) {
  const rawId = req.query.customer_id;
  if (rawId === undefined || String(rawId).trim() === '') return next();
  const customerId = Number(rawId);
  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    req.session._msg = { type: 'error', text: 'Pilih pelanggan yang benar.' };
    return res.redirect('/tech/binding-only');
  }
  try {
    assertBindingOnlyTaskOwner(customerId, Number(req.session.techId), { allowCompletedTakeover: true });
    return next();
  } catch (e) {
    req.session._msg = { type: 'error', text: String(e.message || e) };
    return res.redirect('/tech/binding-only');
  }
}

router.get('/binding-only', requireTechSession, guardBindingOnlySelectedCustomer, (req, res) => {
  try {
    // Include incomplete customer records so technicians can complete OLT/ODP/GPS here.
    const rawCustomers = db.prepare(`SELECT c.id,c.name,c.pppoe_username,c.phone,c.address,c.olt_id,c.odp_id,c.pon_port,c.lat,c.lng,
        o.name AS olt_name,o.brand,o.is_active,
        d.name AS odp_name,d.olt_id AS odp_olt_id,d.lat AS odp_lat,d.lng AS odp_lng
      FROM customers c
      LEFT JOIN olts o ON o.id=c.olt_id
      LEFT JOIN odps d ON d.id=c.odp_id
      WHERE COALESCE(c.status,'active') <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM tech_onu_jobs j WHERE j.customer_id=c.id
            AND COALESCE(j.status,'') <> 'done'
            AND (
              (COALESCE(j.technician_id,0) > 0 AND j.technician_id <> ?)
              OR (COALESCE(j.technician_id,0) <= 0 AND COALESCE(j.status,'') <> 'pending')
            )
        )
      ORDER BY c.name COLLATE NOCASE LIMIT 2000`).all(Number(req.session.techId));
    const customers = rawCustomers.map(c => {
      const latText = String(c.lat == null ? '' : c.lat).trim();
      const lngText = String(c.lng == null ? '' : c.lng).trim();
      const lat = Number(latText), lng = Number(lngText);
      const coordinatesValid = latText !== '' && lngText !== '' && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
      const odpLatText = String(c.odp_lat == null ? '' : c.odp_lat).trim();
      const odpLngText = String(c.odp_lng == null ? '' : c.odp_lng).trim();
      const odpLat = Number(odpLatText), odpLng = Number(odpLngText);
      const odpCoordsValid = odpLatText !== '' && odpLngText !== '' && Number.isFinite(odpLat) && Number.isFinite(odpLng) && odpLat >= -90 && odpLat <= 90 && odpLng >= -180 && odpLng <= 180;
      let distanceMeters = null;
      if (coordinatesValid && odpCoordsValid) {
        const toRad = value => value * Math.PI / 180;
        const dLat = toRad(odpLat - lat), dLng = toRad(odpLng - lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(odpLat)) * Math.sin(dLng / 2) ** 2;
        distanceMeters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
      }
      const distanceReady = Number.isFinite(distanceMeters) && distanceMeters <= 200 + 1e-6;
      const port = Number(c.pon_port);
      const oltReady = Number(c.olt_id) > 0 && Number(c.is_active) === 1 && String(c.brand || '').toUpperCase() === 'HSGQ';
      const odpReady = Number(c.odp_id) > 0 && Number(c.odp_olt_id) === Number(c.olt_id);
      return { ...c, odp_distance_m: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null, odp_distance_ready: distanceReady, olt_ready: oltReady, binding_complete: oltReady && odpReady && Number.isInteger(port) && port >= 1 && port <= 8 && coordinatesValid && distanceReady };
    });
    const olts = db.prepare(`SELECT id,name,brand,is_active FROM olts
      WHERE COALESCE(is_active,0)=1 AND UPPER(COALESCE(brand,''))='HSGQ'
      ORDER BY name COLLATE NOCASE`).all();
    const odps = db.prepare(`SELECT id,name,olt_id,pon_port,port_capacity,lat,lng FROM odps ORDER BY name COLLATE NOCASE`).all();
    const selectedCustomerId = Number(req.query.customer_id) || 0;
    const bindingDraft = req.session._bindingOnlyDraft || null;
    delete req.session._bindingOnlyDraft;
    let watchBindingStatus = false;
    if (selectedCustomerId > 0) {
      try {
        const existingJob = db.prepare('SELECT status,last_message FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? LIMIT 1').get(selectedCustomerId, Number(req.session.techId));
        watchBindingStatus = Boolean(existingJob && (
          (String(req.query.watch || '') === '1' && ['pending','working'].includes(String(existingJob.status || ''))) ||
          (String(existingJob.status || '') === 'pending' && String(existingJob.last_message || '').startsWith('WAN_PENDING:'))
        ));
      } catch (_) {}
    }
    res.render('tech/binding_only', {
      title: 'Modem Binding Saja', company: company(), customers, olts, odps,
      selectedCustomerId, bindingDraft,
      startBindingStep: String(req.query.step || '') === '3' || watchBindingStatus,
      watchBindingStatus,
      msg: flashMsg(req), activePage: 'dashboard'
    });
  } catch (e) {
    console.error('[TECH BINDING ONLY] gagal memuat pelanggan:', e.message);
    req.session._msg = { type: 'error', text: 'Daftar pelanggan gagal dimuat: ' + e.message };
    res.redirect('/tech');
  }
});

router.get('/binding-only/status', requireTechSession, (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid.' });
  }
  try {
    const job = db.prepare(`SELECT customer_id,status,last_message,onu_sn,pon_id,onu_id,updated_at
      FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? LIMIT 1`).get(customerId, Number(req.session.techId));
    if (!job) return res.status(404).json({ success: false, message: 'Status binding tidak ditemukan.' });
    let firmware = null;
    try {
      const row = db.prepare(`SELECT status,model,current_version,target_version,last_message
        FROM tech_onu_firmware_jobs WHERE customer_id=? LIMIT 1`).get(customerId);
      if (row) firmware = row;
    } catch (_) {}
    let postcheck = null;
    try {
      const row = db.prepare(`SELECT status,reboot_status,session_down_seen,last_message
        FROM tech_onu_wan_postcheck WHERE customer_id=? LIMIT 1`).get(customerId);
      if (row) postcheck = row;
    } catch (_) {}
    return res.json({ success: true, job, firmware, postcheck });
  } catch (error) {
    console.error('[TECH BINDING STATUS] gagal membaca:', error.message);
    return res.status(500).json({ success: false, message: 'Status binding belum dapat dibaca.' });
  }
});

router.get('/binding-only/autofind', requireTechSession, async (req, res) => {
  try {
    const customerId = Number(req.query.customer_id);
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('Pilih pelanggan terlebih dahulu.');
    // Even read-only OLT discovery is restricted to the task owner so another
    // technician cannot open the binding workflow around someone else's assignment.
    assertBindingOnlyTaskOwner(customerId, Number(req.session.techId));
    const customer = db.prepare(`SELECT c.id,c.olt_id,o.brand,o.is_active
      FROM customers c LEFT JOIN olts o ON o.id=c.olt_id WHERE c.id=? LIMIT 1`).get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan.');

    // SN scanning is read-only: an incomplete legacy customer may scan the OLT
    // selected in the form without saving or changing the customer's network data.
    let scanOltId = Number(customer.olt_id) || 0;
    const requestedOltId = Number(req.query.olt_id);
    if (Number.isSafeInteger(requestedOltId) && requestedOltId > 0) {
      const requestedOlt = db.prepare('SELECT id,brand,is_active FROM olts WHERE id=? LIMIT 1').get(requestedOltId);
      if (!requestedOlt || Number(requestedOlt.is_active) !== 1 || String(requestedOlt.brand || '').toUpperCase() !== 'HSGQ') {
        throw new Error('Pilih OLT HSGQ yang aktif.');
      }
      if (scanOltId > 0 && scanOltId !== requestedOltId) {
        throw new Error('OLT pilihan berbeda dari OLT yang tersimpan pada pelanggan.');
      }
      scanOltId = requestedOltId;
    }
    if (!scanOltId) {
      const activeOlts = db.prepare(`SELECT id FROM olts
        WHERE COALESCE(is_active,0)=1 AND UPPER(COALESCE(brand,''))='HSGQ' ORDER BY id`).all();
      if (activeOlts.length === 1) scanOltId = Number(activeOlts[0].id);
      else if (activeOlts.length === 0) throw new Error('Tidak ada OLT HSGQ aktif untuk pemindaian.');
      else throw new Error('Pilih OLT pada bagian Data Jaringan sebelum membaca SN.');
    }

    const oltConfig = getTechProvisionOltConfig(scanOltId);
    const maxPon = getTechProvisionPonCount(oltConfig);
    const items = [];
    const seen = new Set();
    const failedPons = [];
    let scannedPons = 0;
    for (let pon = 1; pon <= maxPon; pon++) {
      try {
        const discovered = await onuProvisionSvc.hsgqGetUnconfiguredONUs(oltConfig, String(pon));
        scannedPons++;
        for (const item of (Array.isArray(discovered) ? discovered : [])) {
          const rawSn = String(item.sn || '').trim().toUpperCase();
          if (!/^[A-Z0-9-]{12,16}$/.test(rawSn)) continue;
          const sn = normalizeTechSerialToAlias(rawSn);
          const key = `${pon}:${sn}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const prefix = sn.slice(0, 4);
          const vendorByPrefix = {
            FHTT: 'FIBERHOME', ZTEG: 'ZTE', HWTC: 'HUAWEI', ALCL: 'NOKIA',
            CMHI: 'CMHI', ZXIC: 'OTHER', ZION: 'OTHER', RTEG: 'OTHER', ZICG: 'OTHER', CMDC: 'OTHER'
          };
          items.push({ pon, sn, vendor: vendorByPrefix[prefix] || 'OTHER', model: String(item.model || 'Unknown') });
        }
      } catch (e) {
        failedPons.push(pon);
        console.warn(`[TECH BINDING ONLY] autofind PON ${pon} gagal: ${String(e.message || e)}`);
      }
    }
    if (scannedPons === 0) {
      return res.status(502).json({ success: false, message: 'SN belum bisa dibaca dari OLT. Periksa koneksi dan kredensial CLI/Telnet OLT.' });
    }
    items.sort((a, b) => a.pon - b.pon || a.sn.localeCompare(b.sn));
    return res.json({
      success: true, items, scannedPons, maxPon, oltName: oltConfig.name,
      message: items.length ? `Ditemukan ${items.length} modem yang belum terdaftar di ${oltConfig.name}.` : `Tidak ada modem baru yang terdeteksi di ${oltConfig.name}. Pastikan ONU menyala dan kabel fiber terpasang.`,
      warning: failedPons.length ? `PON ${failedPons.join(', ')} tidak berhasil dipindai; hasil mungkin belum lengkap.` : ''
    });
  } catch (e) {
    console.warn('[TECH BINDING ONLY] autofind gagal:', String(e.message || e));
    return res.status(400).json({ success: false, message: String(e.message || 'Pembacaan SN gagal.') });
  }
});

async function findRegisteredHsgqOnuOnPons(oltConfig, serial, vendor) {
  const wanted = normalizeHsgqSerial(serial, vendor);
  // First consult the OLT's configured-ONU inventory. HSGQ may report the ONU
  // there even when its CLI table format does not match the text parser below.
  // This is read-only and prevents issuing a duplicate "ont add" for an existing SN.
  const inventory = await oltSvc.getConfiguredOnusForProvision(oltConfig.id);
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error('Inventaris ONU OLT tidak dapat diverifikasi. Binding dihentikan agar tidak menambahkan SN ganda.');
  }
  const inventoryMatches = inventory.filter(item => {
    const observedSn = String(item.sn || item.serial || item.serial_number || '').trim();
    return observedSn && normalizeHsgqSerial(observedSn, vendor) === wanted;
  });
  if (inventoryMatches.length > 1) {
    throw new Error('SN ini muncul lebih dari sekali pada inventaris ONU OLT. Tidak ada perubahan dilakukan.');
  }
  if (inventoryMatches.length === 1) {
    const item = inventoryMatches[0];
    const index = String(item.id || item.olt_index || '').match(/(?:^|\/)(\d+):(\d+)$/);
    if (!index) throw new Error('SN ditemukan pada inventaris OLT, tetapi PON/ONU ID tidak dapat dipastikan. Tidak ada perubahan dilakukan.');
    const pon = Number(index[1]), onuId = Number(index[2]);
    if (!Number.isInteger(pon) || pon < 1 || pon > getTechProvisionPonCount(oltConfig) || !Number.isInteger(onuId) || onuId < 0 || onuId > 127) {
      throw new Error('SN ditemukan pada inventaris OLT, tetapi indeks PON/ONU di luar rentang valid. Tidak ada perubahan dilakukan.');
    }
    return { pon, onuId, serial: String(item.sn || item.serial || item.serial_number).trim().toUpperCase() };
  }

  const matches = [];
  const maxPon = getTechProvisionPonCount(oltConfig);
  for (let pon = 1; pon <= maxPon; pon++) {
    const raw = await onuProvisionSvc.runHSGQTelnet(oltConfig, [
      'enable', 'configure', 'interface gpon ' + pon, 'show ont-info all'
    ]);
    const clean = String(raw || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '').replace(/\r/g, '');
    if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input)/i.test(clean) ||
        !/PON\/ONU/i.test(clean)) {
      throw new Error('Tidak dapat memastikan SN yang sudah terdaftar pada PON ' + pon + '. Binding dihentikan agar tidak membuat ONU ganda.');
    }
    for (const line of clean.split('\n')) {
      const row = line.trim().match(/^(\d+)\/(\d+)\s+(?:GPON|EPON)\s+([A-Z0-9-]{8,16})\s+\S+\s+\S+/i);
      if (!row || Number(row[1]) !== pon) continue;
      if (normalizeHsgqSerial(row[3], vendor) === wanted) {
        matches.push({ pon, onuId: Number(row[2]), serial: row[3].toUpperCase() });
      }
    }
  }
  if (matches.length > 1) {
    throw new Error('SN ini terdaftar lebih dari satu kali di OLT (' + matches.map(m => 'PON ' + m.pon + '/ONU ' + m.onuId).join(', ') + '). Tidak ada perubahan dilakukan.');
  }
  return matches[0] || null;
}

router.post('/binding-only', requireTechSession, express.urlencoded({ extended: true }), guardBindingOnlyTaskOwner, async (req, res) => {
  const customerId = Number(req.body.customer_id);
  const action = String(req.body.action || 'bind');
  let bindingConfirmed = false;
  let bindingTaskClaimed = false;
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('Pilih pelanggan yang benar.');
    const customer = db.prepare('SELECT id,name,olt_id,odp_id,pon_port,lat,lng FROM customers WHERE id=? LIMIT 1').get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan.');

    if (action === 'save_network') {
      const oltId = Number(req.body.olt_id);
      const odpId = Number(req.body.odp_id);
      const portText = String(req.body.pon_port || '').trim();
      let port = Number(portText);
      const latText = String(req.body.lat || '').trim();
      const lngText = String(req.body.lng || '').trim();
      const lat = latText === '' ? NaN : Number(latText);
      const lng = lngText === '' ? NaN : Number(lngText);

      const olt = Number.isSafeInteger(oltId) && oltId > 0
        ? db.prepare('SELECT id,name,brand,is_active FROM olts WHERE id=? LIMIT 1').get(oltId) : null;
      if (!olt || Number(olt.is_active) !== 1 || String(olt.brand || '').toUpperCase() !== 'HSGQ') {
        throw new Error('Pilih OLT HSGQ yang aktif.');
      }
      const odp = Number.isSafeInteger(odpId) && odpId > 0
        ? db.prepare('SELECT id,name,olt_id,port_capacity,lat,lng FROM odps WHERE id=? LIMIT 1').get(odpId) : null;
      if (!odp) throw new Error('Pilih ODP yang terdaftar.');
      if (odp.olt_id && Number(odp.olt_id) !== oltId) throw new Error('ODP yang dipilih terhubung ke OLT berbeda.');
      if (!/^[0-9]+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 8) {
        throw new Error('Port ODP wajib angka 1–8.');
      }
      if ((latText !== '' && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
          (lngText !== '' && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        throw new Error('Koordinat GPS tidak valid. Latitude -90 sampai 90, longitude -180 sampai 180.');
      }
      if ((latText === '') !== (lngText === '')) throw new Error('Isi latitude dan longitude sekaligus.');
      const odpDistanceMeters = assertOdpDistanceWithin200m(latText, lngText, odp);

      let reassignedPortFrom = null;
      const tx = db.transaction(() => {
        // Recheck the task owner under the same write lock as customer/ODP changes.
        assertBindingOnlyTaskOwner(customerId, Number(req.session.techId), { allowCompletedTakeover: true });
        // An ODP without an OLT can be attached here; never reassign one already owned by another OLT.
        if (!odp.olt_id) {
          const attached = db.prepare('UPDATE odps SET olt_id=? WHERE id=? AND olt_id IS NULL').run(oltId, odpId);
          if (!attached.changes) throw new Error('ODP baru saja berubah. Muat ulang lalu pilih ulang ODP.');
        }
        // A splitter port can belong to only one customer on the same ODP.
        // Recheck inside the transaction to protect against another technician saving at the same time.
        const occupiedRows = db.prepare("SELECT pon_port FROM customers WHERE odp_id=? AND id<>? AND TRIM(COALESCE(pon_port,''))<>''").all(odpId, customerId);
        const occupied = new Set(occupiedRows.map(row => {
          const value = String(row.pon_port || '').trim();
          return /^[0-9]+$/.test(value) ? Number(value) : 0;
        }).filter(value => Number.isInteger(value) && value >= 1 && value <= 8));
        if (occupied.has(port)) {
          const requestedPort = port;
          let freePort = null;
          for (let step = 1; step <= 8; step++) {
            const candidate = ((requestedPort + step - 1) % 8) + 1;
            if (!occupied.has(candidate)) { freePort = candidate; break; }
          }
          if (freePort === null) throw new Error('Semua port 1–8 pada ODP ini sudah digunakan. Pilih ODP lain.');
          reassignedPortFrom = requestedPort;
          port = freePort;
        }
        db.prepare('UPDATE customers SET olt_id=?,odp_id=?,pon_port=?,lat=?,lng=? WHERE id=?')
          .run(oltId, odpId, String(port), latText === '' ? null : String(lat), lngText === '' ? null : String(lng), customerId);
      });
      tx.immediate();
      req.session._bindingOnlyDraft = {
        customer_id: String(customerId), olt_id: String(oltId), odp_id: String(odpId),
        pon_port: String(port), lat: latText === '' ? '' : String(lat), lng: lngText === '' ? '' : String(lng),
        onu_sn: String(req.body.onu_sn || ''), onu_vendor: String(req.body.onu_vendor || 'FIBERHOME')
      };
      req.session._msg = {
        type: 'success',

        text: reassignedPortFrom ? 'Port ' + reassignedPortFrom + ' sudah digunakan pelanggan lain, sehingga sistem memilih port kosong ' + port + '. Jarak ke ODP ' + odpDistanceMeters + ' m (maks. 200 m). Data jaringan tersimpan. Silakan lanjutkan pendaftaran ONT.' : 'Data jaringan berhasil disimpan. Jarak ke ODP ' + odpDistanceMeters + ' m (maks. 200 m), dan ketersediaan port sudah diperiksa. Silakan lanjutkan pendaftaran ONT.'
      };
      return res.redirect('/tech/binding-only?customer_id=' + customerId + '&step=3');
    }

    // Binding requires a verified OLT, ODP, splitter port, and GPS distance <= 200 m.
    const currentNetwork = db.prepare(`SELECT c.olt_id,c.odp_id,c.pon_port,c.lat,c.lng,
        o.name AS olt_name,o.brand,o.is_active,d.name AS odp_name,d.olt_id AS odp_olt_id,d.lat AS odp_lat,d.lng AS odp_lng
      FROM customers c LEFT JOIN olts o ON o.id=c.olt_id LEFT JOIN odps d ON d.id=c.odp_id
      WHERE c.id=? LIMIT 1`).get(customerId);
    const latText = String(currentNetwork?.lat == null ? '' : currentNetwork.lat).trim();
    const lngText = String(currentNetwork?.lng == null ? '' : currentNetwork.lng).trim();
    assertOdpDistanceWithin200m(latText, lngText, { lat: currentNetwork?.odp_lat, lng: currentNetwork?.odp_lng });
    const lat = Number(latText), lng = Number(lngText), port = Number(currentNetwork?.pon_port);
    const networkReady = currentNetwork &&
      Number(currentNetwork.olt_id) > 0 && Number(currentNetwork.is_active) === 1 &&
      String(currentNetwork.brand || '').toUpperCase() === 'HSGQ' &&
      Number(currentNetwork.odp_id) > 0 && Number(currentNetwork.odp_olt_id) === Number(currentNetwork.olt_id) &&
      Number.isInteger(port) && port >= 1 && port <= 8 &&
      ((latText === '' && lngText === '') ||
        (latText !== '' && lngText !== '' && Number.isFinite(lat) && Number.isFinite(lng) &&
          lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180));
    if (!networkReady) throw new Error('Data pelanggan belum lengkap. Simpan OLT HSGQ, ODP, port ODP, dan GPS pelanggan terlebih dahulu. Jarak ke ODP harus maksimal 200 meter.');

    const oltConfig = getTechProvisionOltConfig(customer.olt_id);
    const vendor = String(req.body.onu_vendor || 'FIBERHOME').trim().toUpperCase();
    if (!['FIBERHOME','ZTE','HUAWEI','NOKIA','CMHI','ZXIC','ZIONCOM','RTEG','ZICG','CMDC','OTHER'].includes(vendor)) throw new Error('Pilih merek ONT yang tersedia.');
    // Binding Saja uses the most-used live OLT line profile (INET, ID 1).
    // Service profile 0 is the only service profile currently present on this OLT.
    const lineProfile = 1;
    const raw = String(req.body.onu_sn || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/g,'').toUpperCase();
    const sn = canonicalizeBindingOnlySerial(raw, vendor);
    if (!/^[A-Z0-9-]{12,16}$/.test(sn)) throw new Error('SN ONU harus 12–16 karakter. Periksa SN pada label modem.');
    // Preflight WAN path BEFORE any live OLT command. This prevents a device from
    // being authorized successfully and then left half-provisioned when its chosen
    // vendor path (e.g. ZTE ONU through the current HSGQ OLT) is not supported.
    const wanPlan = onuWanProvisionSvc.getWanProvisioningPlan({
      customerId, onuVendor: vendor, serial: sn,
      oltIndex: String(req.body.olt_index || '').trim(),
      // Binding Saja discovers the final HSGQ PON/ONU index only after the OLT
      // has confirmed the SN. The WAN plan must allow that deferred resolution.
      allowMissingIndex: true
    });
    if (!wanPlan.supported) {
      throw new Error(`Pra-validasi WAN gagal; ONU belum diubah di OLT. ${wanPlan.message}`);
    }
    // Check task ownership and any existing customer/SN binding before contacting
    // MikroTik or OLT. A wrong technician must not consume RouterOS sessions or make
    // the same generic SN/fiber error appear to unrelated technicians.
    const previousBindingJob = db.prepare('SELECT status, onu_sn, technician_id FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(customerId);
    const previousTechId = Number(previousBindingJob && previousBindingJob.technician_id || 0);
    if (previousBindingJob && previousTechId > 0 && previousTechId !== Number(req.session.techId)
        && String(previousBindingJob.status || '').toLowerCase() !== 'done') {
      throw new Error('Tugas binding untuk pelanggan ini tidak tersedia di akun teknisi ini. Hubungi admin bila perlu diperiksa.');
    }
    if (previousBindingJob && previousTechId <= 0 && !['done', 'pending'].includes(String(previousBindingJob.status || ''))) {
      throw new Error('Tugas binding lama belum memiliki pemilik teknisi. Minta admin memeriksa antrean sebelum melanjutkan.');
    }
    if (previousBindingJob && String(previousBindingJob.onu_sn || '').trim() && ['working', 'pending', 'bound_manual', 'done'].includes(String(previousBindingJob.status || '')) && normalizeHsgqSerial(previousBindingJob.onu_sn, vendor) !== normalizeHsgqSerial(sn, vendor)) {
      throw new Error(`Pelanggan ini sudah terikat ke SN ${previousBindingJob.onu_sn} dengan status ${previousBindingJob.status}. Pastikan pelanggan dan SN yang dipilih benar sebelum mengganti modem.`);
    }
    // The task is claimed atomically before any RouterOS/OLT call. If two
    // technicians submit simultaneously, only the task owner may continue.
    const bindingClaim = claimBindingOnlyTask(customerId, Number(req.session.techId), { allowCompletedTakeover: true });
    bindingTaskClaimed = Boolean(bindingClaim.created || bindingClaim.claimed);

    // ONT registration is separate from subscriber WAN activation. A missing
    // PPPoE password or a secret-profile/rate-limit mismatch must not hide the
    // OLT binding result. These conditions are NOT repaired or bypassed on MikroTik:
    // the later WAN stage will retain bound_manual until the account/profile is fixed.
    // Every other preflight error remains a hard stop before any OLT mutation.
    try {
      await onuWanProvisionSvc.preflightCustomerWan(customerId);
    } catch (preflightError) {
      const preflightMessage = String(preflightError && preflightError.message || preflightError).trim();
      if (/^Password PPPoE tidak tersedia di Billing maupun secret MikroTik\.?$/i.test(preflightMessage)) {
        console.warn('[TECH BINDING ONLY] password PPPoE belum tersedia; lanjutkan registrasi ONT saja, WAN tetap manual.');
      } else if (/^Profile secret PPPoE tidak cocok dengan profil\/rate-limit paket Billing; koreksi sebelum binding\.?$/i.test(preflightMessage)) {
        console.warn('[TECH BINDING ONLY] profil secret PPPoE berbeda dari paket Billing; lanjutkan registrasi ONT saja. WAN tidak diubah dan perlu koreksi profil/status pelanggan.');
      } else if (/too many concurrent logins|maximum number of concurrent sessions|concurrent login limit/i.test(preflightMessage)) {
        // A transient RouterOS management-session limit must not be misreported as a bad ONU SN
        // or prevent the independent OLT registration. WAN stays pending until MikroTik is reachable.
        console.warn('[TECH BINDING ONLY] MikroTik menolak preflight karena batas sesi login; lanjutkan registrasi ONT saja, WAN tetap menunggu koneksi MikroTik.');
      } else {
        throw preflightError;
      }
    }

    // Binding Saja order: verify SN in OLT, register only if absent, then enforce the central FiberHome firmware gate.
    // Add WAN waits for the same SN in ACS; firmware-upgrade/pending states cannot bypass the WAN gate.

    // Check the live OLT registration table first. Existing SNs are reused without re-registering.
    const registeredOnu = await findRegisteredHsgqOnuOnPons(oltConfig, sn, vendor);
    let result;
    if (registeredOnu) {
      result = {
        verified: true, alreadyRegistered: true, pon: registeredOnu.pon, onuId: registeredOnu.onuId,
        sn: registeredOnu.serial, registeredSerial: registeredOnu.serial,
        message: 'SN sudah terdaftar di OLT; proses binding dilewati.'
      };
      console.info('[TECH BINDING ONLY] SN sudah terdaftar di OLT; skip add ONU', registeredOnu);
    } else {
      // Allocate/register only after verifying that the SN is not already configured.
      const configuredOnus = await oltSvc.getConfiguredOnusForProvision(customer.olt_id);
      if (!Array.isArray(configuredOnus) || configuredOnus.length === 0) {
        throw new Error('Tidak bisa membaca daftar modem OLT. Coba lagi atau hubungi admin.');
      }
      const occupiedOnus = configuredOnus.map(item => {
        const match = String(item.id || '').match(/(?:^|\/)(\d+):(\d+)$/);
        return match ? { pon: Number(match[1]), onuId: Number(match[2]) } : null;
      }).filter(item => item && Number.isInteger(item.pon) && item.pon >= 1 && item.pon <= 8 &&
        Number.isInteger(item.onuId) && item.onuId >= 0 && item.onuId <= 127);
      if (occupiedOnus.length === 0) {
        throw new Error('Daftar modem OLT belum bisa diverifikasi. Binding dibatalkan.');
      }
      result = await onuProvisionSvc.hsgqBindOnlyONU(oltConfig, {
        sn, lineProfile, srvProfile: 0,
        maxPon: getTechProvisionPonCount(oltConfig), occupiedOnus
      });
      result.alreadyRegistered = false;
    }
    // hsgqBindOnlyONU may receive an explicit OLT success and complete `save`
    // before the status table catches up. It only returns success=true after that
    // accepted-and-saved path; hsgqProvisionONU below performs the running-config check.
    if (!result.verified && result.success !== true) {
      req.session._msg = {
        type: 'error',
        text: 'Binding belum terverifikasi pada OLT. Tidak ada tugas WAN yang dibuat; periksa status ONU terlebih dahulu agar tidak terjadi binding ganda.'
      };
      return res.redirect('/tech/binding-only?customer_id=' + customerId);
    }
    bindingConfirmed = true;
    const confirmedBindingSn = String(result.registeredSerial || result.sn || sn).trim().toUpperCase();
    customerOnuSerialSvc.saveConfirmedSerial(customerId, confirmedBindingSn, 'Binding Saja / OLT terverifikasi');

    // Binding Saja obtains the definitive HSGQ physical index only after the ONU SN
    // is matched: 0/PON:ONU-ID (e.g. 0/4:11). Persist this exact index for WAN and repair.
    const resolvedOltIndex = '0/' + Number(result.pon) + ':' + Number(result.onuId);

    // Persist the confirmed OLT binding before any TR-069/WAN follow-up. If the
    // following step fails, the UI will not silently repeat a binding operation.
    db.prepare(`INSERT INTO tech_onu_jobs
      (customer_id, status, pon_id, onu_id, onu_sn, last_message, technician_id, onu_vendor, olt_index, reboot_method, updated_at)
      VALUES (?, 'bound_manual', ?, ?, ?, 'Binding terverifikasi; menyiapkan WAN dan reboot pascaaktivasi via CLI OLT.', ?, ?, ?, 'olt_cli', CURRENT_TIMESTAMP)
      ON CONFLICT(customer_id) DO UPDATE SET status='bound_manual', pon_id=excluded.pon_id,
        onu_id=excluded.onu_id, onu_sn=excluded.onu_sn, last_message=excluded.last_message,
        technician_id=excluded.technician_id, onu_vendor=excluded.onu_vendor, olt_index=excluded.olt_index,
        reboot_method='olt_cli', updated_at=CURRENT_TIMESTAMP
    `).run(customerId, Number(result.pon), Number(result.onuId), sn,
      req.session.techId || null, vendor, resolvedOltIndex);

    // Confirm the ONU is registered in the OLT before the vendor-specific WAN step.
    const onuProfile = result.alreadyRegistered
      ? { registeredSerial: result.registeredSerial || result.sn || sn, message: 'SN sudah terdaftar di OLT; binding tidak diulang.' }
      : await onuProvisionSvc.hsgqProvisionONU(oltConfig, {
          vendor: 'HSGQ', pon: String(result.pon), onuId: String(result.onuId), sn,
          name: customer.name || sn, lineProfile: String(lineProfile), srvProfile: '0'
        });

    const registeredSn = String(onuProfile.registeredSerial || confirmedBindingSn).trim().toUpperCase();
    if (registeredSn !== confirmedBindingSn) customerOnuSerialSvc.saveConfirmedSerial(customerId, registeredSn, 'SN terdaftar final pada OLT');

    // WAN setup uses the central FiberHome firmware gate before any WAN change.
    // Once the gate passes, verify PPPoE and use the OLT CLI for one controlled restart and internet check.
    const wan = await onuWanProvisionSvc.provisionCustomerWan(
      customerId, registeredSn, vendor, resolvedOltIndex,
      { allowAddObjectRetry: true, rebootMethod: 'olt_cli' }
    );
    const status = wan.done ? 'done' : (wan.manual ? 'bound_manual' : 'pending');
    const lastMessage = wan.done
      ? `DONE: Binding OLT berhasil dan Internet terverifikasi. ${onuProfile.message} ${wan.message}`
      : (wan.manual
        ? `WAN_MANUAL: Binding OLT berhasil tetapi Internet belum terverifikasi. ${onuProfile.message} ${wan.message}`
        : `WAN_PENDING: Binding OLT berhasil: ${onuProfile.message} ${wan.message || 'WAN menunggu verifikasi.'}`);
    db.prepare(`INSERT INTO tech_onu_jobs
      (customer_id, status, pon_id, onu_id, onu_sn, last_message, technician_id, onu_vendor, olt_index, updated_at, provisioned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP,
        CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT(customer_id) DO UPDATE SET status=excluded.status, pon_id=excluded.pon_id,
        onu_id=excluded.onu_id, onu_sn=excluded.onu_sn, last_message=excluded.last_message,
        technician_id=excluded.technician_id, onu_vendor=excluded.onu_vendor, olt_index=excluded.olt_index,
        updated_at=CURRENT_TIMESTAMP,
        provisioned_at=CASE WHEN excluded.status='done' THEN CURRENT_TIMESTAMP ELSE tech_onu_jobs.provisioned_at END
    `).run(customerId, status, Number(result.pon), Number(result.onuId), registeredSn,
      String(lastMessage).slice(0, 1000), req.session.techId || null, vendor,
      resolvedOltIndex, status);

    req.session._msg = {
      type: wan.done ? 'success' : (wan.manual ? 'error' : 'success'),
      text: wan.done
        ? `Binding selesai dan Internet terverifikasi. ${wan.message}`
        : (wan.manual
          ? `ONU sudah binding, tetapi WAN perlu diperiksa manual. ${wan.message}`
          : `ONU sudah binding. Jalur ${wanPlan.label} dipilih otomatis; WAN sedang menunggu ACS/PPPoE: ${wan.message}`)
    };
    console.info(`[TECH BINDING ONLY] tech=${req.session.techId || '-'} customer=${customerId} vendor=${vendor} WAN=${wanPlan.label} SN=${registeredSn} PON=${result.pon} ONU=${result.onuId} status=${status}`);
  } catch (e) {
    console.warn(`[TECH BINDING ONLY] gagal customer=${Number.isSafeInteger(customerId) && customerId > 0 ? customerId : '-'} action=${action}:`, String(e.message || e));
    if (Number.isSafeInteger(customerId) && customerId > 0) {
      req.session._bindingOnlyDraft = {
        customer_id: String(customerId), olt_id: String(req.body.olt_id || ''),
        odp_id: String(req.body.odp_id || ''), pon_port: String(req.body.pon_port || ''),
        lat: String(req.body.lat || ''), lng: String(req.body.lng || ''),
        onu_sn: String(req.body.onu_sn || ''), onu_vendor: String(req.body.onu_vendor || 'FIBERHOME')
      };
    }
    const rawMessage = String(e.message || e);
    if (bindingTaskClaimed && !bindingConfirmed && action !== 'save_network') {
      try {
        db.prepare(`UPDATE tech_onu_jobs SET status='pending', last_message=?, updated_at=CURRENT_TIMESTAMP
          WHERE customer_id=? AND technician_id=? AND status<>'done'`)
          .run(('Proses binding belum tuntas; periksa status OLT sebelum mencoba ulang. ' + rawMessage).slice(0, 1000), customerId, Number(req.session.techId));
      } catch (claimUpdateError) {
        console.warn('[TECH BINDING ONLY] gagal memperbarui status tugas yang sudah diklaim:', String(claimUpdateError.message || claimUpdateError));
      }
    }
    if (bindingConfirmed && action !== 'save_network') {
      const needsManual = /\[WAN_ADDOBJECT_MANUAL\]|\[WAN_OLT_MANUAL\]|\[WAN_OLT_UNSUPPORTED\]|\[WAN_OLT_INDEX_REQUIRED\]|username\/password PPPoE.*belum lengkap|password PPPoE tidak tersedia|paket billing pelanggan belum dipilih|belum memiliki profile bernama sama|rate-limit profile .*tidak cocok|profile secret .*tidak cocok|secret .*disabled|tidak menunjuk tepat ke satu interface aman/i.test(rawMessage);
      const jobStatus = needsManual ? 'bound_manual' : 'pending';
      const jobMessage = needsManual
        ? ('WAN_MANUAL: Binding OLT sudah terverifikasi, tetapi WAN belum aktif dan perlu tindakan teknisi: ' + rawMessage)
        : ('WAN_PENDING: Binding OLT sudah terverifikasi; WAN belum selesai dan akan diperiksa ulang otomatis: ' + rawMessage);
      try {
        db.prepare("UPDATE tech_onu_jobs SET status=?,last_message=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND status<>'done'")
          .run(jobStatus, jobMessage.slice(0, 1000), customerId);
      } catch (jobUpdateError) {
        console.warn('[TECH BINDING ONLY] gagal menyimpan status post-binding WAN:', String(jobUpdateError.message || jobUpdateError));
      }
    }
    let userMessage = rawMessage;
    if (action !== 'save_network') {
      if (bindingConfirmed) {
        if (/too many concurrent logins|maximum number of concurrent sessions|concurrent login limit/i.test(rawMessage)) {
          userMessage = 'Binding ONT sudah terverifikasi di OLT, tetapi WAN belum dapat diperiksa karena MikroTik menolak koneksi manajemen: batas sesi login bersamaan tercapai. Ini bukan bukti SN atau redaman salah. Jangan ulangi binding; pulihkan sesi manajemen MikroTik, lalu gunakan Perbaiki Layanan.';
        } else if (/password PPPoE tidak tersedia di Billing maupun secret MikroTik/i.test(rawMessage)) {
          userMessage = 'ONT sudah didaftarkan ke OLT, tetapi WAN belum aktif karena password PPPoE tidak tersedia di Billing maupun secret MikroTik. Jangan ulangi binding. Pulihkan atau isi password PPPoE terlebih dahulu, lalu gunakan Perbaiki Layanan.';
        } else {
          userMessage = 'ONT sudah terdaftar di OLT, tetapi koneksi internet belum aktif. Jangan ulangi binding. Periksa akun PPPoE dan konfigurasi WAN, lalu gunakan Perbaiki Layanan atau hubungi admin jaringan.';
        }
      } else if (/Tugas binding untuk pelanggan ini tidak tersedia di akun teknisi ini/i.test(rawMessage)) {
        userMessage = 'Binding dibatalkan: antrean pelanggan ini masih ditugaskan ke akun teknisi lain. SN dan konfigurasi OLT tidak diubah. Login dengan akun teknisi pemilik tugas atau minta admin memindahkan tugas ke akun yang benar.';
      } else if (/Tugas binding (?:lama|ini) belum memiliki pemilik teknisi/i.test(rawMessage)) {
        userMessage = 'Binding dibatalkan karena tugas belum memiliki pemilik teknisi. SN dan konfigurasi OLT tidak diubah. Minta admin menetapkan pemilik tugas sebelum melanjutkan.';
      } else if (/too many concurrent logins|maximum number of concurrent sessions|concurrent login limit/i.test(rawMessage)) {
        userMessage = 'Pemeriksaan awal gagal karena MikroTik menolak koneksi manajemen: batas sesi login bersamaan tercapai. Ini bukan bukti SN atau redaman salah. Periksa sesi manajemen MikroTik; jangan mengulang binding berkali-kali.';
      } else if (/SN .* tidak ditemukan di autofind PON|tidak ditemukan di autofind/i.test(rawMessage)) {
        userMessage = 'OLT belum menampilkan SN ini pada daftar ONU yang siap didaftarkan (autofind). Binding belum dilanjutkan. Pastikan ONT menyala dan terhubung ke PON yang benar, lalu muat ulang daftar SN sebelum mencoba lagi.';
      } else if (/pra-validasi WAN gagal|auto provisioning dihentikan sebelum binding|WAN_OLT_UNSUPPORTED|aktivasi otomatis.*belum didukung/i.test(rawMessage)) {
        userMessage = 'Aktivasi otomatis untuk ONT ini belum didukung oleh OLT yang dipilih. ONT belum diubah. Hubungi admin jaringan.';
      } else if (/sudah terikat ke SN/i.test(rawMessage)) {
        userMessage = 'Pelanggan ini sudah terhubung ke nomor seri ONT lain. Pastikan pelanggan dan SN yang dipilih benar sebelum mengganti perangkat.';
      } else if (/Pilih pelanggan yang benar|Pelanggan tidak ditemukan|ID pelanggan tidak valid/i.test(rawMessage)) {
        userMessage = 'Pilih pelanggan yang benar dari daftar, lalu coba lagi.';
      } else if (/Pilih OLT HSGQ yang aktif|Pilih OLT pada bagian Data Jaringan|OLT pilihan berbeda|OLT yang dipilih tidak aktif/i.test(rawMessage)) {
        userMessage = 'Pilih OLT HSGQ yang aktif dan sesuai dengan data jaringan pelanggan.';
      } else if (/Pilih ODP yang terdaftar|ODP yang dipilih terhubung ke OLT berbeda|ODP baru saja berubah/i.test(rawMessage)) {
        userMessage = 'Pilih ODP yang terhubung ke OLT pelanggan, lalu simpan kembali data jaringan.';
      } else if (/Port ODP wajib angka|port ODP|Port ODP/i.test(rawMessage)) {
        userMessage = 'Pilih port ODP bernomor 1–8 yang masih tersedia.';
      } else if (/Koordinat GPS tidak valid|Isi latitude dan longitude/i.test(rawMessage)) {
        userMessage = 'Lokasi GPS tidak valid. Periksa latitude dan longitude, atau kosongkan keduanya untuk mengisi nanti.';
      } else if (/Pilih merek ONT|Vendor ONU tidak valid/i.test(rawMessage)) {
        userMessage = 'Pilih merek ONT yang tersedia.';
      } else if (/data pelanggan belum lengkap/i.test(rawMessage)) {
        userMessage = 'Lengkapi data OLT, ODP, dan port ODP terlebih dahulu. Lokasi GPS boleh diisi nanti.';
      } else if (/tidak ditemukan di autofind|ONT belum terdeteksi pada port OLT/i.test(rawMessage)) {
        userMessage = 'ONT belum terdeteksi di OLT. Pastikan SN sesuai label, ONT menyala, dan kabel fiber terpasang.';
      } else if (/ditemukan di lebih dari satu PON/i.test(rawMessage)) {
        userMessage = 'ONT terdeteksi di lebih dari satu port. Hentikan proses dan hubungi admin jaringan.';
      } else if (/port PON ini penuh/i.test(rawMessage)) {
        userMessage = 'Port OLT sudah penuh. Hubungi admin jaringan untuk memilih port yang tersedia.';
      } else if (/sudah berisi informasi ONT|sudah dipakai serial/i.test(rawMessage)) {
        userMessage = 'Slot ONU sudah digunakan. Jangan ulangi binding sebelum admin memeriksa konfigurasi OLT.';
      } else if (/Line profile ID|Service profile ID/i.test(rawMessage)) {
        userMessage = 'Profil layanan pada OLT belum sesuai. Hubungi admin jaringan.';
      } else if (/OLT melaporkan gagal binding/i.test(rawMessage)) {
        const detail = rawMessage.match(/Detail respons OLT:\s*(.*)/i);
        userMessage = detail
          ? 'OLT menolak pendaftaran ONT. Jangan ulangi proses sebelum admin memeriksa status port.'
          : 'OLT menolak pendaftaran ONT. Jangan ulangi proses sebelum admin memeriksa status port.';
      } else if (/profil registrasi|line profile|service profile|ont-lineprofile|ont-srvprofile/i.test(rawMessage)) {
        userMessage = 'Profil layanan pada OLT belum sesuai. Hubungi admin jaringan.';
      } else if (/penyimpanan konfigurasi startup gagal/i.test(rawMessage)) {
        userMessage = 'ONT mungkin sudah terdaftar, tetapi penyimpanan konfigurasi belum berhasil. Jangan ulangi binding; hubungi admin jaringan.';
      } else if (/belum dapat dipastikan|belum terkonfirmasi|tidak bisa membaca daftar modem|daftar modem OLT|SNMP|Telnet|running-config|OLT menolak|timeout|OID ONU|koneksi telnet/i.test(rawMessage)) {
        userMessage = 'Status OLT belum dapat dipastikan. Jangan ulangi binding dulu. Periksa koneksi OLT atau hubungi admin jaringan.';
      } else if (/serial number ONU tidak valid|SN ONU harus|SN modem/i.test(rawMessage)) {
        userMessage = 'Periksa kembali SN pada label ONT.';
      } else if (/OLT yang dipilih tidak aktif|kredensial CLI|Alamat OLT|Kredensial/i.test(rawMessage)) {
        userMessage = 'Koneksi OLT belum siap. Hubungi admin jaringan.';
      } else {
        userMessage = 'Binding belum dapat diselesaikan karena pemeriksaan teknis gagal. Pesan ini tidak otomatis berarti SN salah atau redaman buruk. Jangan ulangi dulu; minta admin memeriksa alasan rinci pada log server agar tidak terjadi binding ganda.';
      }
    } else if (/SQLITE|database is locked|constraint failed|no such column|UNIQUE constraint/i.test(rawMessage)) {
      userMessage = 'Data jaringan belum tersimpan. Muat ulang halaman dan coba lagi. Jika tetap gagal, hubungi admin jaringan.';
    }
    req.session._msg = { type: 'error', text: userMessage };
  }
  const bindingTarget = '/tech/binding-only' +
    (Number.isSafeInteger(customerId) && customerId > 0 ? '?customer_id=' + customerId : '') +
    (bindingConfirmed && action !== 'save_network' ? '&watch=1' : '');
  res.redirect(bindingTarget);
});


// Isolated HSGQ SN deletion page; it does not create or modify activation jobs.
router.get('/provisioning/delete-sn', requireTechSession, (req, res) => {
  try {
    const olts = oltSvc.getActiveOlts().filter(o => String(o.brand || '').toUpperCase() === 'HSGQ');
    // Include every active customer assigned to an active HSGQ OLT, even when
    // the customer has no saved SN yet. Prefer the customer SN, then the owned
    // provisioning-job SN; conflicting values are marked for manual review.
    const rawCustomers = db.prepare(`
      SELECT c.id,c.name,c.pppoe_username,c.address,c.olt_id,o.name AS olt_name,
             c.onu_sn AS customer_sn,j.onu_sn AS job_sn
      FROM customers c
      JOIN olts o ON o.id=c.olt_id
      LEFT JOIN tech_onu_jobs j ON j.customer_id=c.id
      WHERE COALESCE(c.status,'active') <> 'deleted'
        AND COALESCE(o.is_active,0)=1 AND UPPER(COALESCE(o.brand,''))='HSGQ'
      ORDER BY c.name COLLATE NOCASE,c.id LIMIT 2000
    `).all();
    const customers = rawCustomers.map(customer => {
      const customerSn = String(customer.customer_sn || '').trim().toUpperCase();
      const jobSn = String(customer.job_sn || '').trim().toUpperCase();
      const customerKey = customerSn ? normalizeHsgqSerial(customerSn) : '';
      const jobKey = jobSn ? normalizeHsgqSerial(jobSn) : '';
      const conflict = Boolean(customerKey && jobKey && customerKey !== jobKey);
      return {
        ...customer,
        delete_sn: conflict ? '' : (customerSn || jobSn),
        delete_sn_state: conflict ? 'conflict' : ((customerSn || jobSn) ? 'ready' : 'missing')
      };
    });
    return res.render('tech/delete_sn', {
      title: 'Hapus SN ONT',
      company: company(),
      activePage: 'provisioning',
      olts,
      customers,
      msg: flashMsg(req)
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Halaman Hapus SN ONT gagal dibuka.' };
    return res.redirect('/tech/provisioning');
  }
});


// Find a single registered HSGQ ONT by serial; no need to browse the full list.
router.post('/provisioning/delete-sn/lookup', requireTechSession, express.json(), async (req, res) => {
  try {
    const oltId = Number(req.body && req.body.oltId);
    const inputSn = String(req.body && req.body.sn || '').trim().toUpperCase();
    const normalizedSn = normalizeTechSerialToAlias(inputSn).replace(/[^A-Z0-9]/g, '');
    if (!Number.isSafeInteger(oltId) || oltId < 1) {
      return res.status(400).json({ success: false, message: 'Pilih OLT HSGQ terlebih dahulu.' });
    }
    if (!/^[A-Z0-9]{12,16}$/.test(normalizedSn)) {
      return res.status(400).json({ success: false, message: 'Format SN tidak valid. Masukkan SN ONT lengkap, misalnya FHTT12345678.' });
    }
    const oltConfig = getTechProvisionOltConfig(oltId);
    // Read the configured ONU inventory; full running-config may time out on this HSGQ firmware.
    const inventory = await oltSvc.getConfiguredOnusForProvision(oltId);
    if (!Array.isArray(inventory) || inventory.length === 0) {
      throw new Error('Inventaris ONT dari OLT tidak tersedia atau kosong; SN belum dapat diverifikasi.');
    }
    const wantedKey = normalizeHsgqSerial(normalizedSn);
    const matches = [];
    for (const item of inventory) {
      const loc = String(item.id || item.index || '').match(/(?:^|\/)(\d+):(\d+)$/);
      if (!loc) continue;
      const registeredSn = normalizeTechSerialToAlias(item.sn || item.serialNumber || item.mac || '').toUpperCase();
      if (!registeredSn || normalizeHsgqSerial(registeredSn) !== wantedKey) continue;
      matches.push({
        pon: Number(loc[1]),
        onuId: Number(loc[2]),
        sn: registeredSn,
        name: String(item.name || '').slice(0, 100),
        status: String(item.status || '').slice(0, 30)
      });
    }
    if (matches.length === 0) {
      return res.status(404).json({ success: false, message: 'SN tidak ditemukan pada inventaris ONT di OLT ' + oltConfig.name + '. Periksa pilihan OLT dan pastikan SN lengkap.' });
    }
    if (matches.length > 1) {
      return res.status(409).json({ success: false, message: 'SN yang sama ditemukan lebih dari satu kali dalam inventaris OLT. Demi keamanan, penghapusan otomatis dibatalkan; minta admin memeriksa konfigurasi.' });
    }
    const customerRows = db.prepare(`
      SELECT c.id,c.name,c.pppoe_username,c.address,c.onu_sn AS customer_sn,j.onu_sn AS job_sn
      FROM customers c LEFT JOIN tech_onu_jobs j ON j.customer_id=c.id
      WHERE c.olt_id=? AND COALESCE(c.status,'active') <> 'deleted'
      ORDER BY c.name COLLATE NOCASE,c.id
    `).all(oltId);
    const linkedCustomers = customerRows.filter(customer => {
      const saved = [customer.customer_sn, customer.job_sn].map(value => String(value || '').trim()).filter(Boolean);
      return saved.some(value => normalizeHsgqSerial(value) === wantedKey);
    }).map(customer => ({
      id: Number(customer.id), name: String(customer.name || ''),
      pppoeUsername: String(customer.pppoe_username || ''), address: String(customer.address || '')
    }));
    return res.json({
      success: true, olt: { id: oltConfig.id, name: oltConfig.name }, onu: matches[0],
      customer: linkedCustomers.length === 1 ? linkedCustomers[0] : null,
      customerMatches: linkedCustomers.length
    });
  } catch (e) {
    console.error('[TECH DELETE SN] lookup gagal:', String(e.message || e));
    return res.status(502).json({ success: false, message: String(e.message || 'Gagal mencari SN di inventaris OLT.').slice(0, 220) });
  }
});

router.post('/provisioning/delete-sn/scan', requireTechSession, express.json(), async (req, res) => {
  try {
    const oltId = Number(req.body && req.body.oltId);
    if (!Number.isSafeInteger(oltId) || oltId < 1) {
      return res.status(400).json({ success: false, message: 'Pilih OLT HSGQ terlebih dahulu.' });
    }
    const oltConfig = getTechProvisionOltConfig(oltId);
    const raw = await onuProvisionSvc.runHSGQTelnet(oltConfig, ['enable', 'configure', 'show running-config']);
    const clean = String(raw || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    if (!/interface\s+gpon\s+\d+/i.test(clean)) {
      throw new Error('Konfigurasi GPON tidak terbaca dari OLT; daftar tidak dapat diverifikasi.');
    }
    const onus = [];
    let currentPon = null;
    for (const line of clean.split('\n')) {
      const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
      if (iface) { currentPon = Number(iface[1]); continue; }
      if (/^\s*exit\s*$/i.test(line)) { currentPon = null; continue; }
      const add = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b(.*)$/i);
      if (!add || !Number.isInteger(currentPon) || currentPon < 1 || currentPon > 16) continue;
      const sn = normalizeTechSerialToAlias(add[2]).toUpperCase();
      if (!/^[A-Z0-9]{12,16}$/.test(sn)) continue;
      if (onus.some(row => row.pon === currentPon && row.onuId === Number(add[1]))) continue;
      onus.push({ pon: currentPon, onuId: Number(add[1]), sn, details: String(add[3] || '').trim().slice(0, 80) });
    }
    onus.sort((a, b) => a.pon - b.pon || a.onuId - b.onuId);
    return res.json({ success: true, olt: { id: oltConfig.id, name: oltConfig.name }, onus });
  } catch (e) {
    console.error('[TECH DELETE SN] scan gagal:', String(e.message || e));
    return res.status(502).json({ success: false, message: String(e.message || 'Gagal membaca SN dari OLT.').slice(0, 220) });
  }
});

router.post('/provisioning/delete-sn', requireTechSession, express.json(), async (req, res) => {
  try {
    const oltId = Number(req.body && req.body.oltId);
    const pon = Number(req.body && req.body.pon);
    const onuId = Number(req.body && req.body.onuId);
    const sn = String(req.body && req.body.sn || '').trim().toUpperCase();
    const confirmationSn = String(req.body && req.body.confirmationSn || '').trim().toUpperCase();
    const normalize = value => normalizeHsgqSerial(String(value || '').trim().toUpperCase());
    if (!Number.isSafeInteger(oltId) || oltId < 1 ||
        !Number.isInteger(pon) || pon < 1 || pon > 16 ||
        !Number.isInteger(onuId) || onuId < 0 || onuId > 127 ||
        !/^[A-Z0-9]{12,16}$/.test(sn) || normalize(sn) !== normalize(confirmationSn)) {
      return res.status(400).json({ success: false, message: 'Data tidak valid. Ketik ulang SN ONT yang sama persis untuk mengonfirmasi.' });
    }
    const oltConfig = getTechProvisionOltConfig(oltId);
    const result = await onuProvisionSvc.deleteONU(oltConfig, 'HSGQ', { oltId, pon: String(pon), onuId, sn });
    if (!result || result.success !== true) {
      throw new Error(result && result.message ? result.message : 'OLT tidak mengonfirmasi penghapusan.');
    }

    // Once HSGQ deletion is independently verified against the live OLT inventory,
    // release the matching completed Billing binding so the customer can appear in
    // Binding Saja again. Active/pending jobs and ambiguous duplicate mappings are
    // intentionally preserved; no other customer's serial or job is touched.
    const normalizedDeletedSn = normalize(sn);
    const linkedRows = db.prepare(`
      SELECT c.id,c.name,c.onu_sn AS customer_sn,j.onu_sn AS job_sn,
             j.status AS job_status,j.technician_id AS job_technician_id
      FROM customers c LEFT JOIN tech_onu_jobs j ON j.customer_id=c.id
      WHERE c.olt_id=? AND COALESCE(c.status,'active') <> 'deleted'
    `).all(oltId);
    const linked = linkedRows.filter(row => {
      const customerMatch = String(row.customer_sn || '').trim() && normalize(row.customer_sn) === normalizedDeletedSn;
      const jobMatch = String(row.job_sn || '').trim() && normalize(row.job_sn) === normalizedDeletedSn;
      return customerMatch || jobMatch;
    });
    let billingRelease = { customerId: null, customerName: '', released: false, reason: 'no_matching_billing_record' };
    if (linked.length === 1) {
      const row = linked[0];
      const customerMatches = String(row.customer_sn || '').trim() && normalize(row.customer_sn) === normalizedDeletedSn;
      const jobMatches = String(row.job_sn || '').trim() && normalize(row.job_sn) === normalizedDeletedSn;
      const jobExists = row.job_status !== null && row.job_status !== undefined;
      const jobStatus = String(row.job_status || '').toLowerCase();
      if (jobExists && jobStatus !== 'done') {
        billingRelease = { customerId: Number(row.id), customerName: row.name, released: false, reason: 'binding_job_not_completed' };
      } else if (row.job_sn && !jobMatches) {
        billingRelease = { customerId: Number(row.id), customerName: row.name, released: false, reason: 'job_serial_conflict' };
      } else if (!customerMatches && !jobMatches) {
        billingRelease = { customerId: Number(row.id), customerName: row.name, released: false, reason: 'serial_mapping_not_confirmed' };
      } else {
        const release = db.transaction(() => {
          if (customerMatches) {
            db.prepare("UPDATE customers SET onu_sn='',onu_sn_updated_at='' WHERE id=?").run(row.id);
          }
          if (row.job_status && jobStatus === 'done' && (jobMatches || (!row.job_sn && customerMatches))) {
            db.prepare(`UPDATE tech_onu_jobs SET status='pending',pon_id=NULL,onu_id=NULL,onu_sn=NULL,
              last_message=?,technician_id=NULL,olt_index='',provisioned_at=NULL,updated_at=CURRENT_TIMESTAMP
              WHERE customer_id=? AND status='done'`).run(
                `SN ${sn} sudah dihapus dan diverifikasi tidak ada di OLT ${oltConfig.name}. Tugas binding dilepas agar dapat diklaim ulang oleh teknisi.`, row.id
            );
          }
        });
        release.immediate();
        billingRelease = { customerId: Number(row.id), customerName: row.name, released: true,
          jobReset: Boolean(row.job_status && jobStatus === 'done'), reason: 'verified_olt_deletion' };
      }
    } else if (linked.length > 1) {
      billingRelease = { customerId: null, customerName: '', released: false, reason: 'multiple_billing_matches' };
    }

    try {
      require('../services/auditTrailService').logAuditTrail({
        action: 'DELETE',
        entity_type: 'olt_onu_serial',
        entity_id: sn,
        actor_type: 'technician',
        actor_id: String(req.session && req.session.techId || ''),
        actor_name: String(req.session && (req.session.techName || req.session.username) || 'Teknisi'),
        details: { olt_id: oltId, olt_name: oltConfig.name, vendor: 'HSGQ', pon, onu_id: onuId,
          operation: 'hapus registrasi SN dari running-config OLT', billing_release: billingRelease },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    } catch (auditError) {
      console.warn('[TECH DELETE SN] audit gagal dicatat:', String(auditError.message || auditError));
    }
    const releaseMessage = billingRelease.released
      ? ` Data pelanggan ${billingRelease.customerName} (ID ${billingRelease.customerId}) sudah dilepas dari SN lama dan tugas binding dibuka kembali agar muncul di pilihan Binding Saja.`
      : (billingRelease.reason === 'no_matching_billing_record'
        ? ' Tidak ada pasangan SN ini di Billing; data pelanggan tidak diubah.'
        : ' Registrasi OLT terhapus, tetapi catatan Billing tidak dilepas otomatis (' + billingRelease.reason + '). Minta admin memeriksa sebelum binding ulang.');
    return res.json({ success: true, billingRelease, message: result.message + releaseMessage });
  } catch (e) {
    console.error('[TECH DELETE SN] hapus gagal:', String(e.message || e));
    return res.status(502).json({ success: false, message: String(e.message || 'Penghapusan SN ONT gagal.').slice(0, 240) });
  }
});

// Separate ONU provisioning queue: customer data/PPPoE is saved first, ONT binding is done here.
router.get('/provisioning', requireTechSession, (req, res) => {
  try {
    const jobs = db.prepare(`
      SELECT c.id, c.name, c.phone, c.address, c.lat, c.lng, c.pppoe_username, c.router_id, c.olt_id,
             c.odp_id, c.pon_port, c.status AS customer_status,
             r.name AS router_name, p.name AS package_name, o.name AS olt_name, d.name AS odp_name,
             j.status AS job_status, j.pon_id, j.onu_id, j.onu_sn, j.last_message, j.updated_at
      FROM tech_onu_jobs j
      JOIN customers c ON c.id = j.customer_id
      LEFT JOIN routers r ON r.id = c.router_id
      LEFT JOIN packages p ON p.id = c.package_id
      LEFT JOIN olts o ON o.id = c.olt_id
      LEFT JOIN odps d ON d.id = c.odp_id
      WHERE j.status <> 'done' AND j.technician_id = ?
      ORDER BY CASE j.status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, c.name COLLATE NOCASE
      LIMIT 500
    `).all(Number(req.session.techId));
    const olts = oltSvc.getAllOlts();
    const odps = odpSvc.getAllOdps();
    const customers = db.prepare("SELECT id,name,phone FROM customers WHERE COALESCE(status,'active') <> 'deleted' ORDER BY name COLLATE NOCASE LIMIT 2000").all();
    res.render('tech/provisioning', { title: 'Provisioning ONU', company: company(), activePage: 'provisioning', jobs, olts, odps, customers, msg: flashMsg(req) });
  } catch (e) {
    console.error('[TECH PROVISIONING] gagal memuat antrean:', e.message);
    req.session._msg = { type: 'error', text: 'Antrean provisioning gagal dimuat: ' + e.message };
    res.redirect('/tech');
  }
});

// Diagnostik WAN read-only: periksa Billing dan sesi MikroTik tanpa mengubah konfigurasi pelanggan.
router.get('/provisioning/:customerId/diagnose-wan', requireTechSession, requireOwnedOnuJob, async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isSafeInteger(customerId) || customerId < 1) return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid.' });
  try {
    const result = await onuWanProvisionSvc.diagnoseCustomerWan(customerId);
    return res.json({ success: true, result });
  } catch (e) {
    const status = /tidak ditemukan/i.test(String(e.message || e)) ? 404 : 502;
    return res.status(status).json({ success: false, message: String(e.message || e).slice(0, 250) });
  }
});

// Pindahkan tugas antrean ke pelanggan lain dengan aman; jangan membawa SN/binding pelanggan lama.
router.post('/provisioning/:customerId/change-customer', requireTechSession, express.urlencoded({ extended: true }), requireOwnedOnuJob, (req, res) => {
  const currentId = Number(req.params.customerId);
  const targetId = Number(req.body.target_customer_id);
  try {
    if (!Number.isSafeInteger(currentId) || currentId < 1 || !Number.isSafeInteger(targetId) || targetId < 1) throw new Error('Pilih pelanggan yang valid.');
    if (currentId === targetId) throw new Error('Pelanggan yang dipilih sama dengan pelanggan saat ini.');
    const currentJob = db.prepare('SELECT customer_id,status FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? LIMIT 1').get(currentId,Number(req.session.techId));
    if (!currentJob) throw new Error('Tugas pelanggan saat ini tidak ditemukan.');
    if (['working','done'].includes(String(currentJob.status))) throw new Error('Pelanggan tidak dapat diganti saat proses berjalan atau tugas sudah selesai.');
    const target = db.prepare("SELECT id FROM customers WHERE id=? AND COALESCE(status,'active') <> 'deleted' LIMIT 1").get(targetId);
    if (!target) throw new Error('Pelanggan tujuan tidak ditemukan atau sudah dihapus.');
    const existing = db.prepare('SELECT status FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(targetId);
    if (existing) throw new Error('Pelanggan tujuan sudah memiliki tugas provisioning. Buka tugas pelanggan tersebut.');
    const moved = db.prepare("UPDATE tech_onu_jobs SET customer_id=?,status='pending',onu_sn=NULL,pon_id=NULL,onu_id=NULL,last_message='Pelanggan diganti. Periksa OLT, ODP, titik GPS, dan SN sebelum aktivasi.',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND technician_id=? AND status IN ('pending','failed')").run(targetId,currentId,Number(req.session.techId));
    if (!moved.changes) throw new Error('Tugas tidak berubah. Muat ulang halaman lalu coba lagi.');
    req.session._msg = { type: 'success', text: 'Tugas dipindahkan ke pelanggan baru. SN dan binding lama dihapus dari tugas; pilih ulang OLT/ODP/GPS dan masukkan SN pelanggan baru.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mengganti pelanggan: ' + e.message };
  }
  res.redirect('/tech/provisioning');
});

// Simpan OLT, ODP, port pelanggan, dan titik koordinat dari antrean teknisi.
router.post('/provisioning/:customerId/odp', requireTechSession, express.urlencoded({ extended: true }), requireOwnedOnuJob, (req, res) => {
  const customerId = Number(req.params.customerId);
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid');
    const customer = customerSvc.getCustomerById(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const oltId = Number(req.body.olt_id);
    const odpId = Number(req.body.odp_id);
    const portText = String(req.body.pon_port || '').trim();
    const portNumber = Number(portText);
    const latText = String(req.body.lat || '').trim();
    const lngText = String(req.body.lng || '').trim();
    const lat = latText === '' ? '' : Number(latText);
    const lng = lngText === '' ? '' : Number(lngText);
    const olt = Number.isSafeInteger(oltId) && oltId > 0 ? oltSvc.getOltById(oltId) : null;
    const odp = Number.isSafeInteger(odpId) && odpId > 0 ? odpSvc.getOdpById(odpId) : null;

    if (!olt) throw new Error('Pilih OLT yang valid');
    if (!odp) throw new Error('Pilih ODP yang valid');
    if (odp.olt_id && Number(odp.olt_id) !== oltId) throw new Error('ODP tidak terhubung ke OLT yang dipilih');
    if (!/^\d+$/.test(portText) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 128) throw new Error('Port pelanggan pada ODP wajib diisi (1–128)');
    if ((latText && !Number.isFinite(lat)) || (lngText && !Number.isFinite(lng)) || (latText && (lat < -90 || lat > 90)) || (lngText && (lng < -180 || lng > 180))) throw new Error('Koordinat GPS tidak valid');
    if ((latText === '') !== (lngText === '')) throw new Error('Isi latitude dan longitude sekaligus, atau kosongkan keduanya');
    // Jangan simpan pasangan OLT/ODP pada alur Binding ONT jika pelanggan terlalu jauh.
    // Pakai GPS baru dari form, atau GPS pelanggan yang sudah tersimpan.
    const effectiveLatText = latText !== '' ? latText : String(customer.lat == null ? '' : customer.lat).trim();
    const effectiveLngText = lngText !== '' ? lngText : String(customer.lng == null ? '' : customer.lng).trim();
    assertOdpDistanceWithin200m(effectiveLatText, effectiveLngText, odp);

    customerSvc.updateCustomer(customerId, {
      ...customer,
      olt_id: oltId,
      odp_id: odpId,
      pon_port: String(portNumber),
      lat: latText === '' ? (customer.lat || '') : String(lat),
      lng: lngText === '' ? (customer.lng || '') : String(lng)
    });
    req.session._msg = { type: 'success', text: 'OLT, ODP, port, dan titik pelanggan berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan ODP/titik pelanggan: ' + e.message };
  }
  res.redirect('/tech/provisioning');
});

// Cancel only queued/failed jobs; never remove a task currently provisioning or completed.
router.post('/provisioning/:customerId/cancel', requireTechSession, express.urlencoded({ extended: true }), requireOwnedOnuJob, (req, res) => {
  const customerId = Number(req.params.customerId);
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid');
    const result = db.prepare("DELETE FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? AND status IN ('pending','failed')").run(customerId,Number(req.session.techId));
    if (!result.changes) throw new Error('Tugas sedang diproses atau sudah selesai, jadi tidak dapat dibatalkan dari antrean.');
    req.session._msg = { type: 'success', text: 'Tugas provisioning dibatalkan dari antrean. Data pelanggan tetap tersimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Tugas tidak dapat dibatalkan: ' + e.message };
  }
  res.redirect('/tech/provisioning');
});

// Build Telnet credentials from the OLT assigned to this customer's technician job.
function getTechProvisionOltConfig(oltId) {
  const id = Number(oltId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Pilih OLT pada bagian Edit ODP terlebih dahulu');
  const olt = db.prepare('SELECT id,name,host,brand,is_active,cli_user,cli_password,web_user,web_password,telnet_port,enable_password FROM olts WHERE id = ? LIMIT 1').get(id);
  if (!olt || Number(olt.is_active) !== 1) throw new Error('OLT yang dipilih tidak aktif atau tidak ditemukan');
  if (String(olt.brand || '').toUpperCase() !== 'HSGQ') throw new Error('Provisioning teknisi saat ini mendukung OLT HSGQ. OLT terpilih: ' + (olt.name || olt.brand));
  // Prefer dedicated CLI credentials; legacy OLT records may already store working Telnet credentials in web_user/web_password.
  const username = String(olt.cli_user || olt.web_user || '').trim();
  const password = String(olt.cli_password || olt.web_password || '');
  if (!olt.host || !username || !password) throw new Error('Kredensial CLI/Telnet OLT belum diisi. Buka Admin → Manajemen OLT, isi kredensial CLI/Telnet, lalu simpan.');
  return { id: olt.id, name: olt.name, vendor: 'HSGQ', host: String(olt.host).trim(), port: Number(olt.telnet_port || 23), username, password, enablePassword: String(olt.enable_password || '') };
}

// Physical GPON port count for the HSGQ OLTs used by this installation.
// Keep other HSGQ records on their previous 8-PON range unless named otherwise.
function getTechProvisionPonCount(oltConfig) {
  const name = String(oltConfig && oltConfig.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (name.includes('mendit')) return 2;
  if (name.includes('luring') || name.includes('lunring') || name.includes('lurung')) return 8;
  return 8;
}

// Read-only HSGQ scan across all PONs for the OLT assigned to this customer.
router.get('/provisioning/discover', requireTechSession, requireOwnedOnuJob, async (req, res) => {
  try {
    const customerId = Number(req.query.customerId);
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid untuk scan ONU');
    const customer = db.prepare('SELECT id,olt_id FROM customers WHERE id = ? LIMIT 1').get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    const requestedOltId = Number(req.query.oltId);
    if (!Number.isSafeInteger(requestedOltId) || requestedOltId < 1) throw new Error('Pilih OLT HSGQ untuk pemindaian.');
    if (Number(customer.olt_id) !== requestedOltId) throw new Error('OLT yang dipilih berbeda dari OLT pelanggan. Perbarui OLT pada bagian Data Jaringan terlebih dahulu.');
    const oltConfig = getTechProvisionOltConfig(requestedOltId);
    const foundAll = [];
    const alreadyRegistered = [];
    const ponChecks = [];
    const maxPon = getTechProvisionPonCount(oltConfig);
    const occupiedByPon = new Map();
    const registeredBindings = new Map();
    let inventorySource = 'running-config';
    let inventoryWarning = '';

    // Prefer the authoritative CLI config, but do not let its pagination/timeout
    // prevent an otherwise successful read-only autofind scan. HSGQ SNMP inventory
    // is the fallback for already-registered serials and occupied ONU IDs.
    try {
      const running = await onuProvisionSvc.runHSGQTelnet(oltConfig, [
        'enable', 'configure', 'show running-config'
      ]);
      const cleanConfig = String(running || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
      if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|Connection timed out|Unable to connect)/i.test(cleanConfig)) {
        throw new Error('OLT tidak memberikan konfigurasi yang dapat dibaca.');
      }
      let currentPon = null;
      for (const line of cleanConfig.split('\n')) {
        const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
        if (iface) { currentPon = Number(iface[1]); if (!occupiedByPon.has(currentPon)) occupiedByPon.set(currentPon, new Set()); continue; }
        if (/^\s*exit\s*$/i.test(line)) { currentPon = null; continue; }
        const add = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b/i);
        if (add && Number.isInteger(currentPon)) {
          occupiedByPon.get(currentPon).add(Number(add[1]));
          const serialKey = normalizeHsgqSerial(add[2]);
          if (!registeredBindings.has(serialKey)) {
            registeredBindings.set(serialKey, { pon: currentPon, onuId: Number(add[1]), sn: add[2].toUpperCase() });
          }
        }
      }
      if (!occupiedByPon.size) throw new Error('Konfigurasi tidak memuat daftar interface GPON.');
    } catch (cliError) {
      console.warn('[TECH ONU DISCOVER] running-config tidak tersedia; mencoba inventaris SNMP:', String(cliError.message || cliError));
      occupiedByPon.clear();
      registeredBindings.clear();
      try {
        const configured = await oltSvc.getConfiguredOnusForProvision(requestedOltId);
        if (!Array.isArray(configured) || configured.length === 0) throw new Error('Inventaris SNMP ONT kosong atau tidak tersedia.');
        for (const item of configured) {
          const idx = String(item.id || '').match(/(?:^|\/)(\d+):(\d+)$/);
          if (!idx) continue;
          const pon = Number(idx[1]);
          const onuId = Number(idx[2]);
          if (!Number.isInteger(pon) || pon < 1 || pon > maxPon || !Number.isInteger(onuId) || onuId < 0 || onuId > 127) continue;
          if (!occupiedByPon.has(pon)) occupiedByPon.set(pon, new Set());
          occupiedByPon.get(pon).add(onuId);
          const sn = normalizeTechSerialToAlias(String(item.sn || '').trim());
          if (/^[A-Za-z0-9-]{12,16}$/.test(sn)) {
            const serialKey = normalizeHsgqSerial(sn);
            if (!registeredBindings.has(serialKey)) registeredBindings.set(serialKey, { pon, onuId, sn });
          }
        }
        if (!occupiedByPon.size) throw new Error('SNMP tidak memberikan nomor PON/ONU yang valid.');
        inventorySource = 'snmp';
        inventoryWarning = 'Daftar ONT dibaca melalui SNMP karena konfigurasi CLI OLT tidak merespons.';
      } catch (snmpError) {
        inventorySource = 'unverified';
        inventoryWarning = 'SN terdeteksi dapat ditampilkan, tetapi daftar ONT terdaftar belum bisa diverifikasi. Aktivasi ditahan sampai slot ONU dapat dipastikan. Hubungi admin jaringan.';
        console.warn('[TECH ONU DISCOVER] inventaris SNMP juga tidak tersedia:', String(snmpError.message || snmpError));
      }
    }
    const failedPons = [];
    let scannedPons = 0;
    for (let pon = 1; pon <= maxPon; pon++) {
      let discovered;
      try {
        discovered = await onuProvisionSvc.hsgqGetUnconfiguredONUs(oltConfig, String(pon));
        scannedPons++;
      } catch (scanError) {
        failedPons.push(pon);
        ponChecks.push({ pon, found: 0, alreadyRegistered: 0, failed: true });
        console.warn(`[TECH ONU DISCOVER] autofind PON ${pon} gagal: ${String(scanError.message || scanError)}`);
        continue;
      }
      const found = [];
      let registeredCount = 0;
      for (const item of (Array.isArray(discovered) ? discovered : [])) {
        const sn = normalizeTechSerialToAlias(String(item.sn || '').trim());
        if (!/^[A-Za-z0-9-]{12,16}$/.test(sn)) continue;
        const candidate = { pon, sn, model: item.model || 'Unknown' };
        // Autofind is expected to return unbound ONTs, but defensively exclude any SN
        // already present in running-config so a registered ONT is never offered again.
        const registered = registeredBindings.get(normalizeHsgqSerial(sn));
        if (registered) {
          alreadyRegistered.push({ pon: registered.pon, onuId: registered.onuId, sn: registered.sn, model: candidate.model });
          registeredCount++;
          continue;
        }
        if (!found.some(o => normalizeHsgqSerial(o.sn) === normalizeHsgqSerial(sn))) found.push(candidate);
      }
      const occupied = occupiedByPon.get(pon) || new Set();
      let suggestedOnuId = null;
      if (inventorySource !== 'unverified') {
        for (let id = 1; id <= 127; id++) { if (!occupied.has(id)) { suggestedOnuId = id; break; } }
      }
      const idCheck = suggestedOnuId
        ? `ID ONU ${suggestedOnuId} dipilih dari ${inventorySource === 'snmp' ? 'inventaris SNMP OLT' : 'konfigurasi OLT'}.`
        : (inventorySource === 'unverified'
          ? 'ID ONU belum dapat dipastikan. Aktivasi dinonaktifkan sampai admin memverifikasi slot OLT.'
          : 'Semua ONU ID 1–127 terpakai atau tidak dapat dipastikan.');
      found.forEach(o => foundAll.push(Object.assign({}, o, { suggestedOnuId, idCheck })));
      ponChecks.push({ pon, found: found.length, alreadyRegistered: registeredCount });
    }
    if (scannedPons === 0) {
      throw new Error('Tidak ada port PON yang berhasil dipindai. Periksa koneksi Telnet OLT dan coba lagi.');
    }
    const warnings = [];
    if (inventoryWarning) warnings.push(inventoryWarning);
    if (failedPons.length) warnings.push(`PON ${failedPons.join(', ')} tidak berhasil dipindai; hasil yang tampil hanya dari PON yang berhasil dibaca.`);
    res.json({ success: true, maxPon, found: foundAll, alreadyRegistered, ponChecks, warning: warnings.join(' ') });
  } catch (e) {
    console.error('[TECH ONU DISCOVER] scan gagal:', e.message);
    res.status(502).json({ success: false, message: 'Deteksi ONU gagal: ' + e.message });
  }
});

router.post('/provisioning/:customerId/repair', requireTechSession, express.urlencoded({ extended: true }), requireOwnedOnuJob, async (req, res) => {
  const customerId = Number(req.params.customerId);
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid');
    const customer = db.prepare('SELECT id, name, olt_id, odp_id, pon_port, lat, lng FROM customers WHERE id = ? LIMIT 1').get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    if (!customer.olt_id) throw new Error('Pilih OLT pelanggan terlebih dahulu');

    // Repair can register/bind the ONU again, so it must not bypass the ODP distance
    // check that protects initial Binding Saja and automatic provisioning.
    if (!customer.odp_id) throw new Error('Pilih ODP pelanggan terlebih dahulu sebelum Perbaiki Layanan.');
    const selectedOdp = odpSvc.getOdpById(customer.odp_id);
    if (!selectedOdp) throw new Error('ODP pelanggan tidak ditemukan; perbaikan dibatalkan sebelum mengubah OLT.');
    if (Number(selectedOdp.olt_id) !== Number(customer.olt_id)) throw new Error('ODP pelanggan harus terhubung ke OLT yang sama sebelum perbaikan.');
    const odpPortText = String(customer.pon_port || '').trim();
    const odpPortNumber = Number(odpPortText);
    const odpCapacity = Number(selectedOdp.port_capacity) > 0 ? Number(selectedOdp.port_capacity) : 16;
    if (!/^\d+$/.test(odpPortText) || !Number.isInteger(odpPortNumber) || odpPortNumber < 1 || odpPortNumber > odpCapacity) {
      throw new Error('Port pelanggan pada ODP wajib berupa angka 1–' + odpCapacity + ' sebelum perbaikan.');
    }
    assertOdpDistanceWithin200m(customer.lat, customer.lng, selectedOdp);

    const wanPrereq = db.prepare(`SELECT c.router_id, c.package_id, c.pppoe_username, c.pppoe_password,
      r.is_active AS router_active, p.name AS package_name FROM customers c
      LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN packages p ON p.id=c.package_id
      WHERE c.id=? LIMIT 1`).get(customerId);
    if (!wanPrereq || !wanPrereq.router_id || !wanPrereq.router_active || !wanPrereq.package_id || !wanPrereq.package_name ||
        !String(wanPrereq.pppoe_username || '').trim() || !String(wanPrereq.pppoe_password || '').trim()) {
      throw new Error('Perbaikan otomatis dihentikan sebelum mengubah OLT: router aktif, paket, username PPPoE, dan password PPPoE harus lengkap.');
    }
    const pon = Number(req.body.pon);
    const onuId = Number(req.body.onu_id);
    const sn = String(req.body.onu_sn || '').trim();
    if (!Number.isInteger(pon) || pon < 1 || pon > 8) throw new Error('Port PON harus 1 sampai 8');
    if (!Number.isInteger(onuId) || onuId < 1 || onuId > 127) throw new Error('ONU ID harus 1 sampai 127');
    if (!/^[A-Za-z0-9-]{12,16}$/.test(sn)) throw new Error('Nomor seri ONU tidak valid');
    const onuVendor = String(req.body.onu_vendor || onuWanProvisionSvc.normalizeOnuVendor('', sn)).trim().toUpperCase();
    const submittedOltIndex = String(req.body.olt_index || '').trim();
    const oltIndex = submittedOltIndex || ('0/' + pon + ':' + onuId);
    const wanPlan = onuWanProvisionSvc.getWanProvisioningPlan({ customerId, onuVendor, serial: sn, oltIndex });
    if (!wanPlan.supported) throw new Error(`Perbaikan dihentikan sebelum konfigurasi: ${wanPlan.message}`);
    const oltConfig = getTechProvisionOltConfig(customer.olt_id);
    const result = await onuProvisionSvc.hsgqProvisionONU(oltConfig, {
      vendor: 'HSGQ', pon: String(pon), onuId: String(onuId), sn,
      name: customer.name || sn, lineProfile: '0', srvProfile: '1'
    });
    customerOnuSerialSvc.saveConfirmedSerial(customerId, result.registeredSerial || sn, 'Perbaiki Layanan / OLT terverifikasi');
    // FiberHome firmware enforcement runs centrally in provisionCustomerWan() via the live Web OLT driver.
    // This keeps the repair endpoint from using the unsupported `show ont-version` Telnet command
    // and also prevents a manual repair from bypassing the RP4592 gate.
    const wan = await onuWanProvisionSvc.provisionCustomerWan(customerId, sn, onuVendor, oltIndex);
    const status = wan.done ? 'done' : (wan.manual ? 'bound_manual' : 'pending');
    const message = (wan.done || wan.manual) ? `${result.message} ${wan.message}` : `WAN_PENDING: ${result.message} ${wan.message}`;
    db.prepare(`UPDATE tech_onu_jobs SET status=?, pon_id=?, onu_id=?, onu_sn=?, last_message=?, onu_vendor=?, olt_index=?, updated_at=CURRENT_TIMESTAMP,
      provisioned_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE provisioned_at END WHERE customer_id=?`)
      .run(status, pon, onuId, sn, String(message).slice(0, 1000), onuVendor, oltIndex, status, customerId);
    req.session._msg = {
      type: wan.done ? 'success' : (wan.manual ? 'error' : 'success'),
      text: wan.done ? 'WAN PPPoE terverifikasi: ' + wan.message
        : (wan.manual ? 'Binding selesai; WAN perlu pemeriksaan manual: ' + wan.message : 'Binding/profil OLT tersimpan. Jalur ' + wanPlan.label + ' dipilih otomatis; WAN menunggu verifikasi: ' + wan.message)
    };
  } catch (e) {
    console.error('[TECH ONU SERVICE REPAIR] gagal:', e.message);
    req.session._msg = { type: 'error', text: 'Perbaikan layanan ONU gagal: ' + e.message };
  }
  res.redirect('/tech/provisioning');
});

const HSGQ_TECH_SERIAL_PREFIXES = {
  FIBERHOME: { alias: 'FHTT', hex: '46485454' },
  ZTE: { alias: 'ZTEG', hex: '5A544547' },
  HUAWEI: { alias: 'HWTC', hex: '48575443' },
  NOKIA: { alias: 'ALCL', hex: '414C434C' },
  CMHI: { alias: 'CMHI', hex: '434D4849' },
  ZXIC: { alias: 'ZXIC', hex: '5A584943' },
  ZIONCOM: { alias: 'ZION', hex: '5A494F4E' },
  RTEG: { alias: 'RTEG', hex: '52544547' },
  ZICG: { alias: 'ZICG', hex: '5A494347' },
  CMDC: { alias: 'CMDC', hex: '434D4443' }
};

function canonicalizeTechOnuSerial(value, vendor) {
  let serial = String(value || '').trim().toUpperCase();
  const selectedVendor = String(vendor || '').trim().toUpperCase();
  const prefix = HSGQ_TECH_SERIAL_PREFIXES[selectedVendor];
  // Convert only a matching known vendor's ASCII-prefix hex to its short SN alias.
  // Technicians can paste the serial as printed on the ONU label without hex conversion.
  if (prefix) {
    const rawHex = serial.match(new RegExp('^' + prefix.hex + '([0-9A-F]{8})$'));
    if (rawHex) serial = prefix.alias + rawHex[1];
  }
  return serial;
}

// Format known 16-character ASCII-prefix hex serials into the compact vendor alias.
// The prefix itself identifies the vendor, so an incorrect dropdown choice cannot
// accidentally leave a long known SN in the OLT running configuration.
function normalizeTechSerialToAlias(value) {
  const serial = String(value || '').trim().toUpperCase();
  const rawHex = serial.match(/^([0-9A-F]{8})([0-9A-F]{8})$/);
  if (!rawHex) return serial;
  // Decode any valid ASCII vendor prefix, not only the prefixes hard-coded above.
  // This lets third-party ONTs use their normal short SN without manual conversion.
  const decodedPrefix = Buffer.from(rawHex[1], 'hex').toString('ascii').toUpperCase();
  return /^[A-Z0-9]{4}$/.test(decodedPrefix) ? decodedPrefix + rawHex[2] : serial;
}

function canonicalizeBindingOnlySerial(value, vendor) {
  return normalizeTechSerialToAlias(canonicalizeTechOnuSerial(value, vendor));
}

function normalizeHsgqSerial(value, vendor) {
  const serial = normalizeTechSerialToAlias(value);
  // Convert any short ASCII-vendor SN back to its byte-equivalent key so matching
  // works whether this OLT firmware reports a short alias or 16-character hex SN.
  const alias = serial.match(/^([A-Z0-9]{4})([0-9A-F]{8})$/);
  if (alias) return Buffer.from(alias[1], 'ascii').toString('hex').toUpperCase() + alias[2];
  return serial;
}

async function resolveHsgqOnuBySerial(oltConfig, serial, vendor) {
  const wanted = normalizeHsgqSerial(serial, vendor);
  // HSGQ-G02ID firmware rejects `show ont-info all`. Use the running configuration,
  // which this provisioning flow also uses to verify existing registrations and TR-069.
  const running = await onuProvisionSvc.runHSGQTelnet(oltConfig, [
    'enable', 'configure', 'show running-config'
  ]);
  const clean = String(running || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|Connection timed out|Unable to connect)/i.test(clean)) {
    throw new Error('Tidak bisa membaca running-config OLT untuk memeriksa binding yang sudah ada; tidak ada perubahan dilakukan.');
  }
  const occupied = new Map();
  let currentPon = null;
  for (const line of clean.split('\n')) {
    const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
    if (iface) { currentPon = Number(iface[1]); continue; }
    if (/^\s*exit\s*$/i.test(line)) { currentPon = null; continue; }
    const add = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b/i);
    if (!add || !Number.isInteger(currentPon)) continue;
    const onuId = Number(add[1]);
    if (!occupied.has(currentPon)) occupied.set(currentPon, new Map());
    occupied.get(currentPon).set(onuId, add[2].toUpperCase());
    if (normalizeHsgqSerial(add[2], vendor) === wanted) {
      return { pon: currentPon, onuId, alreadyRegistered: true, registeredSerial: add[2].toUpperCase() };
    }
  }

  // Only allocate an ID after the exact serial appears in the live autofind list.
  const maxPon = getTechProvisionPonCount(oltConfig);
  for (let pon = 1; pon <= maxPon; pon++) {
    const discovered = await onuProvisionSvc.hsgqGetUnconfiguredONUs(oltConfig, String(pon));
    const match = (Array.isArray(discovered) ? discovered : []).find(
      o => normalizeHsgqSerial(o.sn, vendor) === wanted
    );
    if (!match) continue;
    const used = occupied.get(pon) || new Map();
    let onuId = 1;
    while (onuId <= 127 && used.has(onuId)) onuId++;
    if (onuId > 127) throw new Error(`SN ditemukan di PON ${pon}, tetapi semua ONU ID 1–127 sudah dipakai.`);
    return { pon, onuId, alreadyRegistered: false, discoveredSerial: match.sn };
  }
  throw new Error('ONT belum terdeteksi pada port OLT. Pastikan SN sesuai label perangkat, ONT menyala, dan kabel fiber terpasang.');
}

async function runProvisioningUntilActive(customerId, sn, onuVendor, oltConfig, customerName, lineProfile, srvProfile, technicianId, oltIndex = '') {
  const startedAt = Date.now();
  const deadline = startedAt + 10 * 60 * 1000;
  const updateJob = (status, message, extra = {}) => {
    const fields = { status, last_message: String(message || '').slice(0, 1000), updated_at: new Date().toISOString(), ...extra };
    db.prepare(`INSERT INTO tech_onu_jobs
      (customer_id, status, last_message, updated_at, pon_id, onu_id, onu_sn, technician_id, provisioned_at, onu_vendor, olt_index)
      VALUES (@customer_id, @status, @last_message, CURRENT_TIMESTAMP, @pon_id, @onu_id, @onu_sn, @technician_id,
        CASE WHEN @status='done' THEN CURRENT_TIMESTAMP ELSE NULL END, @onu_vendor, @olt_index)
      ON CONFLICT(customer_id) DO UPDATE SET
        status=excluded.status, last_message=excluded.last_message, updated_at=CURRENT_TIMESTAMP,
        pon_id=COALESCE(excluded.pon_id, tech_onu_jobs.pon_id),
        onu_id=COALESCE(excluded.onu_id, tech_onu_jobs.onu_id),
        onu_sn=excluded.onu_sn,
        onu_vendor=excluded.onu_vendor,
        olt_index=excluded.olt_index,
        technician_id=COALESCE(excluded.technician_id, tech_onu_jobs.technician_id),
        provisioned_at=CASE WHEN excluded.status='done' THEN CURRENT_TIMESTAMP ELSE tech_onu_jobs.provisioned_at END`).run({
        status: fields.status, last_message: fields.last_message,
        pon_id: extra.pon_id ?? null, onu_id: extra.onu_id ?? null, onu_sn: sn,
        onu_vendor: String(onuVendor || 'OTHER'), olt_index: String(extra.olt_index ?? oltIndex ?? ''),
        customer_id: customerId, technician_id: technicianId ?? null
      });
  };
  try {
    const bindingDeadline = Math.min(deadline, startedAt + 5 * 60 * 1000);
    let resolved = null;
    let bindingAttempt = 0;
    let lastBindingMessage = '';
    while (!resolved && Date.now() < bindingDeadline) {
      bindingAttempt++;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      updateJob('working', `TAHAP 1/2 — PROSES BINDING: mencari SN ONU di OLT (percobaan ${bindingAttempt}). Waktu berjalan ${Math.floor(elapsed/60)} menit ${elapsed%60} detik; batas pencarian SN 05:00.`, { pon_id: null, onu_id: null });
      try {
        resolved = await resolveHsgqOnuBySerial(oltConfig, sn, onuVendor);
      } catch (e) {
        lastBindingMessage = String(e.message || e);
        if (!/SN tidak ditemukan pada autofind OLT|ONT belum terdeteksi pada port OLT/i.test(lastBindingMessage)) throw e;
        const remaining = bindingDeadline - Date.now();
        if (remaining <= 0) break;
        updateJob('working', `TAHAP 1/2 — PROSES BINDING: SN belum ditemukan. Sistem mencari ulang otomatis; ${Math.floor(Math.max(0, remaining)/1000)} detik tersisa. Pastikan ONU menyala dan fiber tersambung.`, { pon_id: null, onu_id: null });
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, remaining)));
      }
    }
    if (!resolved || Date.now() >= bindingDeadline) throw new Error(`GAGAL BINDING: SN ${sn} tidak ditemukan dalam batas 5 menit. Periksa serial number, daya ONU, dan konektor fiber. ${lastBindingMessage}`);
    const pon = Number(resolved.pon), onuId = Number(resolved.onuId);
    // Existing HSGQ inventory can use ONU ID 0. Reuse it only for an exact already-bound SN;
    // newly discovered/unregistered ONTs must still receive a free ID in the 1–127 range.
    if (!Number.isInteger(pon) || pon < 1 || pon > 8 || !Number.isInteger(onuId) || onuId < 0 || onuId > 127 || (onuId === 0 && !resolved.alreadyRegistered)) {
      throw new Error('PON atau ONU ID hasil pencarian OLT tidak valid; ONU ID 0 hanya diterima bila SN yang sama sudah terdaftar.');
    }
    if (Date.now() >= deadline) throw new Error('Batas waktu 10 menit habis saat mencari SN di OLT.');
    updateJob('working', `TAHAP 1/2 — PROSES BINDING: SN cocok. Mengikat ONU ke OLT pada PON ${pon}, ONU ID ${onuId}...`, { pon_id: pon, onu_id: onuId });
    const oltResult = await onuProvisionSvc.hsgqProvisionONU(oltConfig, {
      vendor: 'HSGQ', pon: String(pon), onuId: String(onuId), sn,
      name: customerName, lineProfile: String(lineProfile), srvProfile: String(srvProfile)
    });
    const confirmedSerial = String(oltResult.registeredSerial || sn).trim().toUpperCase();
    customerOnuSerialSvc.saveConfirmedSerial(customerId, confirmedSerial, 'Provisioning otomatis / OLT terverifikasi');
    if (Date.now() >= deadline) throw new Error('Batas waktu 10 menit habis setelah perintah binding. Periksa status ONU di OLT sebelum mencoba ulang.');

    // Resolve the physical index and immediately start the FiberHome Web OLT firmware workflow after binding.
    oltIndex = '0/' + pon + ':' + onuId;
    const registeredSn = String(oltResult.registeredSerial || sn).trim().toUpperCase();
    let firmwareSummary = '';
    if (onuVendor === 'FIBERHOME') {
      const firmwareJob = await fiberHomeFirmwareSvc.queueAfterBinding({
        customerId, oltId: Number(oltConfig.id), serial: registeredSn, pon, onuId, oltIndex
      });
      if (!firmwareJob || !['ready', 'not_required'].includes(String(firmwareJob.status || ''))) {
        const failed = firmwareJob && firmwareJob.status === 'failed';
        const message = `BINDING SELESAI pada PON ${pon}, ONU ${onuId}. ${String(firmwareJob?.last_message || 'Pemeriksaan/upgrade firmware FiberHome dijadwalkan otomatis.')} WAN PPPoE belum dikirim; binding tidak diulang.`;
        updateJob(failed ? 'bound_manual' : 'pending', failed ? message : 'WAN_PENDING: ' + message,
          { pon_id: pon, onu_id: onuId, olt_index: oltIndex });
        return;
      }
      firmwareSummary = `Firmware Web OLT: ${firmwareJob.model || 'model terverifikasi'} ${firmwareJob.current_version || firmwareJob.target_version}. `;
    }

    let lastWanMessage = 'WAN PPPoE belum terverifikasi.';
    let wanAttempt = 0;
    while (Date.now() < deadline) {
      wanAttempt++;
      const remainingSeconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      updateJob('working', `TAHAP 2/2 — BINDING ONU SELESAI pada PON ${pon}, ONU ID ${onuId}. Memeriksa WAN/PPPoE otomatis (percobaan ${wanAttempt}); sisa waktu maksimal ${Math.floor(remainingSeconds/60)} menit ${remainingSeconds%60} detik.`, { pon_id: pon, onu_id: onuId });
      try {
        // Use the serial read from the OLT's registered binding for ACS/IP WAN lookup.
        // This prevents the technician-entered alias from selecting a different ACS identity.
        const registeredSn = String(oltResult.registeredSerial || sn).trim().toUpperCase();
        const wan = await onuWanProvisionSvc.provisionCustomerWan(customerId, registeredSn, onuVendor, oltIndex);
        lastWanMessage = String(wan.message || 'WAN belum terverifikasi.');
        if (wan.manual) {
          updateJob('bound_manual', `BINDING SELESAI: ${oltResult.message} PON ${pon}, ONU ID ${onuId}. ${firmwareSummary}${lastWanMessage}`, { pon_id: pon, onu_id: onuId, olt_index: oltIndex });
          console.warn(`[TECH PROVISIONING] customer ID ${customerId}: WAN memerlukan pemeriksaan manual; retry otomatis dihentikan.`);
          return;
        }
        if (wan.done) {
          updateJob('done', `ONU BINDING + INTERNET AKTIF: ${oltResult.message} ${firmwareSummary}${lastWanMessage}`, { pon_id: pon, onu_id: onuId, olt_index: oltIndex });
          console.info(`[TECH PROVISIONING] customer ID ${customerId}: ONU binding dan WAN terverifikasi aktif.`);
          return;
        }
      } catch (wanError) {
        lastWanMessage = String(wanError.message || wanError).slice(0, 500);
        // An OLT direct-WAN command may have partially succeeded even when its final
        // response/save step fails. Do not resend Add WAN automatically to avoid duplicates.
        if (/WAN_OLT_MANUAL/.test(lastWanMessage)) {
          updateJob('bound_manual', `BINDING SELESAI pada PON ${pon}, ONU ${onuId}. ${firmwareSummary}${lastWanMessage} Periksa konfigurasi WAN di OLT sebelum mencoba kembali.`, { pon_id: pon, onu_id: onuId, olt_index: oltIndex });
          console.warn(`[TECH PROVISIONING] customer ID ${customerId}: direct WAN command error; retry dihentikan untuk mencegah duplikasi.`);
          return;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      updateJob('working', `BINDING ONU SUKSES; internet belum aktif. Sistem mencoba ulang otomatis. Diagnostik terakhir: ${lastWanMessage}`, { pon_id: pon, onu_id: onuId });
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, remaining)));
    }
    updateJob('bound_manual', `BINDING DONE: ${oltResult.message} PON ${pon}, ONU ID ${onuId}. ${firmwareSummary}PPPoE/INTERNET GAGAL setelah batas proses 10 menit. Kesalahan terakhir: ${lastWanMessage}. Periksa WAN di OLT sebelum mencoba ulang; data pelanggan dan binding OLT tetap tersimpan.`, { pon_id: pon, onu_id: onuId, olt_index: oltIndex });
    console.warn(`[TECH PROVISIONING] customer ID ${customerId}: binding OK, PPPoE gagal setelah batas waktu: ${lastWanMessage}`);
    return;
  } catch (err) {
    updateJob('failed', `GAGAL: ${String(err.message || err).slice(0, 900)}`);
    console.warn(`[TECH PROVISIONING] customer ID ${customerId} gagal: ${String(err.message || err).slice(0, 500)}`);
  }
}

router.post('/provisioning/:customerId/ack-manual', requireTechSession, express.urlencoded({ extended: true }), requireOwnedOnuJob, (req, res) => {
  const customerId = Number(req.params.customerId);
  const wantsJson = String(req.get('accept') || '').includes('application/json') ||
    String(req.get('x-requested-with') || '') === 'XMLHttpRequest';
  let success = false;
  let message = '';
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid.');
    const result = db.prepare("DELETE FROM tech_onu_jobs WHERE customer_id=? AND technician_id=? AND status='bound_manual'").run(customerId,Number(req.session.techId));
    if (!result.changes) throw new Error('Tugas belum berstatus binding selesai / PPPoE manual, atau sudah dihapus.');
    success = true;
    message = 'Tugas provisioning ditutup. Data pelanggan dan binding OLT tetap tersimpan; PPPoE dapat dilanjutkan manual pada ONT.';
    req.session._msg = { type: 'success', text: message };
  } catch (e) {
    message = 'Tugas belum dapat ditutup: ' + e.message;
    req.session._msg = { type: 'error', text: message };
  }
  if (wantsJson) return res.status(success ? 200 : 400).json({ success, message });
  return res.redirect('/tech/provisioning');
});

router.get('/provisioning/:customerId/status', requireTechSession, requireOwnedOnuJob, (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isSafeInteger(customerId) || customerId < 1) return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid.' });
  try {
    const job = db.prepare(`SELECT j.customer_id, j.status, j.last_message, j.onu_sn, j.pon_id, j.onu_id, j.updated_at,
      c.name AS customer_name FROM tech_onu_jobs j JOIN customers c ON c.id=j.customer_id WHERE j.customer_id=? AND j.technician_id=? LIMIT 1`).get(customerId,Number(req.session.techId));
    if (!job) return res.status(404).json({ success: false, message: 'Tugas provisioning tidak ditemukan.' });
    return res.json({ success: true, job });
  } catch (err) { return res.status(500).json({ success: false, message: 'Gagal membaca status provisioning.' }); }
});

router.post('/provisioning/:customerId', requireTechSession, express.urlencoded({ extended: true }), preventOtherTechOnuJob, async (req, res) => {
  const customerId = Number(req.params.customerId);
  const wantsJson = String(req.get('accept') || '').includes('application/json') || String(req.get('x-requested-with') || '') === 'XMLHttpRequest';
  try {
    if (!Number.isSafeInteger(customerId) || customerId < 1) throw new Error('ID pelanggan tidak valid');
    const customer = db.prepare('SELECT id, name, olt_id, odp_id, pon_port, lat, lng FROM customers WHERE id = ? LIMIT 1').get(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    if (!customer.olt_id) throw new Error('Pilih OLT di bagian Edit ODP terlebih dahulu');
    // Full auto-provisioning must not bind the ONU and only then discover that WAN
    // prerequisites are missing. Require the actual router/package/PPPoE data first.
    const wanPrereq = db.prepare(`SELECT c.router_id, c.package_id, c.pppoe_username, c.pppoe_password,
      r.is_active AS router_active, r.name AS router_name, p.name AS package_name
      FROM customers c LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN packages p ON p.id=c.package_id
      WHERE c.id=? LIMIT 1`).get(customerId);
    if (!wanPrereq || !wanPrereq.router_id || !wanPrereq.router_active || !wanPrereq.package_id || !wanPrereq.package_name ||
        !String(wanPrereq.pppoe_username || '').trim() || !String(wanPrereq.pppoe_password || '').trim()) {
      throw new Error('Auto provisioning dihentikan sebelum mengubah OLT: data WAN belum lengkap. Isi router MikroTik aktif, paket layanan, username PPPoE, dan password PPPoE pada data pelanggan. Jika hanya ingin mengikat modem tanpa mengaktifkan internet, gunakan menu Binding Saja.');
    }
    if (!customer.odp_id) throw new Error('Pilih ODP di bagian Edit ODP terlebih dahulu');
    if (!String(customer.pon_port || '').trim()) throw new Error('Isi port pelanggan pada ODP terlebih dahulu');
    const selectedOdp = odpSvc.getOdpById(customer.odp_id);
    if (!selectedOdp) throw new Error('ODP pelanggan tidak ditemukan');
    if (selectedOdp.olt_id && Number(selectedOdp.olt_id) !== Number(customer.olt_id)) throw new Error('ODP yang dipilih tidak cocok dengan OLT pelanggan');
    // Periksa lagi tepat sebelum aktivasi agar pemanggilan endpoint langsung tidak bisa melewati batas 200 m.
    assertOdpDistanceWithin200m(customer.lat, customer.lng, selectedOdp);
    // Normalize common copy/paste artifacts before validating the ONU serial.
    // SN values are ASCII alphanumeric; strip whitespace (including internal accidental spaces)
    // and normalize case before applying HSGQ/FiberHome alias conversion.
    const rawEnteredSn = String(req.body.onu_sn || '');
    const onuVendor = String(req.body.onu_vendor || 'FIBERHOME').trim().toUpperCase();
    if (!['FIBERHOME', 'ZTE', 'HUAWEI', 'NOKIA', 'CMHI', 'ZXIC', 'ZIONCOM', 'RTEG', 'ZICG', 'CMDC', 'OTHER'].includes(onuVendor)) {
      throw new Error('Pilih vendor ONU yang tersedia atau Vendor lain / SN asli.');
    }
    // Remove invisible Unicode characters from mobile copy/paste. Normalize raw hex
    // serials to the vendor alias before sending the HSGQ `ont add` command.
    const cleanedEnteredSn = rawEnteredSn.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim().toUpperCase();
    const enteredSn = canonicalizeTechOnuSerial(cleanedEnteredSn, onuVendor);
    const sn = enteredSn;
    const lineProfile = Number(req.body.line_profile ?? 1);
    const srvProfile = Number(req.body.srv_profile ?? 0);
    const oltConfig = getTechProvisionOltConfig(customer.olt_id);
    if (!/^[A-Z0-9-]{12,16}$/.test(sn)) {
      const receivedLength = Array.from(enteredSn).length;
      throw new Error(`Serial Number ONU tidak valid setelah normalisasi (panjang diterima ${receivedLength}; SN asli harus 12–16 huruf/angka/tanda hubung).`);
    }
    if (!Number.isInteger(lineProfile) || lineProfile < 0 || lineProfile > 2047 || !Number.isInteger(srvProfile) || srvProfile < 0 || srvProfile > 2047) throw new Error('ID profile tidak valid');
    const wanPlan = onuWanProvisionSvc.getWanProvisioningPlan({
      customerId, onuVendor, serial: sn,
      oltIndex: String(req.body.olt_index || '').trim(),
      // The HSGQ PON/ONU index is only definitive after the SN is discovered and bound.
      allowMissingIndex: true
    });
    if (!wanPlan.supported) {
      throw new Error(`Auto provisioning dihentikan sebelum binding: ${wanPlan.message}`);
    }
    // Atomically reserve this activation task for the initiating technician before
    // any asynchronous preflight. Another technician cannot win the task during a wait.
    claimBindingOnlyTask(customerId, Number(req.session.techId));
    await onuWanProvisionSvc.preflightCustomerWan(customerId);
    // FiberHome is allowed to bind before ACS enrollment. Firmware is checked/updated on the OLT first;
    // provisionCustomerWan waits for this exact SN to appear in ACS before creating WAN.
    const technicianId = Number(req.session.techId);
    const startProvisioning = db.transaction(() => {
      assertBindingOnlyTaskOwner(customerId, technicianId);
      const currentJob = db.prepare('SELECT status,technician_id FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(customerId);
      if (!currentJob || Number(currentJob.technician_id || 0) !== technicianId) {
        throw new Error('Tugas aktivasi tidak lagi dimiliki akun teknisi ini. Proses binding dibatalkan.');
      }
      if (currentJob.status === 'working') throw new Error('Provisioning pelanggan ini sedang berjalan. Tunggu proses yang aktif agar tidak terjadi binding ganda.');
      if (currentJob.status === 'bound_manual') throw new Error('Binding ONU sudah berhasil. Jangan ulangi binding; lanjutkan pengisian PPPoE manual atau gunakan menu perbaikan layanan.');
      const updated = db.prepare(`UPDATE tech_onu_jobs SET status='working', onu_sn=?,
        last_message='Menyiapkan proses aktivasi maksimal 10 menit...', updated_at=CURRENT_TIMESTAMP,
        technician_id=?, onu_vendor=?, olt_index=?, reboot_method='acs'
        WHERE customer_id=? AND technician_id=?`).run(sn, technicianId, onuVendor, String(req.body.olt_index || '').trim(), customerId, technicianId);
      if (!updated.changes) throw new Error('Tugas aktivasi tidak lagi dimiliki akun teknisi ini. Proses binding dibatalkan.');
    });
    startProvisioning.immediate();
    if (wantsJson) {
      res.status(202).json({ success: true, customerId, message: 'Proses dimulai. Binding ONU diproses maksimal 10 menit; jika PPPoE otomatis gagal, hasil binding tetap disimpan agar teknisi dapat mengisi PPPoE manual.' });
      setImmediate(() => runProvisioningUntilActive(customerId, sn, onuVendor, oltConfig, customer.name, lineProfile, srvProfile, req.session.techId || null, String(req.body.olt_index || '').trim()));
      return;
    }
    await runProvisioningUntilActive(customerId, sn, onuVendor, oltConfig, customer.name, lineProfile, srvProfile, req.session.techId || null, String(req.body.olt_index || '').trim());
    const finalJob = db.prepare('SELECT status,last_message FROM tech_onu_jobs WHERE customer_id=?').get(customerId);
    req.session._msg = { type: finalJob && finalJob.status === 'done' ? 'success' : 'error', text: finalJob ? finalJob.last_message : 'Proses selesai; status tugas tidak tersedia.' };
  } catch (e) {
    if (wantsJson) return res.status(400).json({ success: false, message: String(e.message || e) });
    req.session._msg = { type: 'error', text: 'Provisioning gagal: ' + e.message };
  }
  return res.redirect('/tech/provisioning');
});

// PPPoE shortcut for technicians: show customers with PPPoE accounts.
router.get('/ppoe', requireTechSession, (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT c.id, c.name, c.phone, c.pppoe_username, c.status, c.router_id,
             r.name AS router_name, p.name AS package_name
      FROM customers c
      LEFT JOIN routers r ON r.id = c.router_id
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.pppoe_username IS NOT NULL AND TRIM(c.pppoe_username) <> ''
      ORDER BY c.name COLLATE NOCASE ASC
      LIMIT 1000
    `).all();
    res.render('tech/ppoe', {
      title: 'PPPoE', company: company(), activePage: 'ppoe',
      customers, msg: flashMsg(req)
    });
  } catch (e) {
    console.error('[TECH PPPoE] gagal memuat daftar:', e.message);
    req.session._msg = { type: 'error', text: 'Daftar PPPoE gagal dimuat: ' + e.message };
    res.redirect('/tech');
  }
});

// --- CREATE CUSTOMER (Technician) ---
router.get('/customers/new', requireTechSession, (req, res) => {
  const packages = customerSvc.getAllPackages();
  const odps = odpSvc.getAllOdps();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  res.render('tech/create_customer', {
    title: 'Tambah Pelanggan',
    company: company(),
    activePage: 'create_customer',
    packages,
    odps,
    routers,
    olts,
    msg: flashMsg(req)
  });
});

router.post('/customers', requireTechSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Nama pelanggan wajib diisi');

    const customerData = {
      name,
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),

      address: String(req.body.address || '').trim(),
      package_id: req.body.package_id ? Number(req.body.package_id) : null,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      pppoe_password: String(req.body.pppoe_password || '').trim(),
      router_id: req.body.router_id ? Number(req.body.router_id) : null,
      olt_id: req.body.olt_id ? Number(req.body.olt_id) : null,
      odp_id: req.body.odp_id ? Number(req.body.odp_id) : null,
      pon_port: String(req.body.pon_port || '').trim(),
      lat: String(req.body.lat || '').trim(),
      lng: String(req.body.lng || '').trim(),
      isolir_profile: String(req.body.isolir_profile || 'isolir').trim() || 'isolir',
      status: String(req.body.status || 'active').trim() || 'active',
      install_date: req.body.install_date ? String(req.body.install_date).trim() : null,
      notes: String(req.body.notes || '').trim(),
      auto_isolate: req.body.auto_isolate !== undefined ? Number(req.body.auto_isolate) : 1,
      isolate_day: req.body.isolate_day !== undefined ? Number(req.body.isolate_day) : 10
    };

    const newPppoePassword = String(req.body.pppoe_password || '').trim();
    const autoPppoe = Boolean(newPppoePassword);
    let pppoeAccountReused = false;
    let pppoeAccountCreated = false;

    // VALIDATION: If customer has PPPoE connection, router_id is REQUIRED.
    if (customerData.pppoe_username && !customerData.router_id) {
      throw new Error('Router harus dipilih jika menggunakan koneksi PPPoE');
    }

    if (autoPppoe && !customerData.pppoe_username) {
      throw new Error('Isi PPPoE Username sebelum membuat user PPPoE otomatis');
    }

    if (customerData.pppoe_username) {
      const normalizedUsername = customerData.pppoe_username.trim();
      const existing = db.prepare(`
        SELECT id, name FROM customers
        WHERE router_id IS ? AND lower(trim(pppoe_username)) = lower(?)
        LIMIT 1
      `).get(customerData.router_id ?? null, normalizedUsername);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      // Check the selected router first, regardless of whether the password field
      // is filled. A password on the form must never cause an existing secret to be
      // added a second time or have its password/profile silently replaced.
      let conn = null;
      let matchingSecrets = [];
      try {
        conn = await mikrotikService.getConnection(customerData.router_id);
        const secrets = await conn.client.menu('/ppp/secret').get();
        matchingSecrets = (Array.isArray(secrets) ? secrets : []).filter(secret =>
          String(secret.name || '').trim().toLowerCase() === normalizedUsername.toLowerCase()
        );
      } finally {
        if (conn && conn.api) await conn.api.close();
      }

      if (matchingSecrets.length > 1) {
        throw new Error('Username ditemukan lebih dari satu kali pada MikroTik. Minta admin memeriksa secret sebelum menambahkan pelanggan.');
      }

      const existingSecret = matchingSecrets[0] || null;
      if (existingSecret) {
        if (String(existingSecret.service || '').trim().toLowerCase() !== 'pppoe') {
          throw new Error('Username sudah ada di MikroTik tetapi servicenya bukan PPPoE. Secret tidak diubah; minta admin memeriksa akun tersebut.');
        }
        if (String(existingSecret.disabled || '').toLowerCase() === 'true') {
          throw new Error('Username PPPoE sudah ada tetapi sedang dinonaktifkan di MikroTik. Secret tidak diaktifkan otomatis; minta admin memeriksanya.');
        }

        // Reuse the exact RouterOS username/profile. Ignore any password typed in
        // the optional "create new account" field; never overwrite an existing secret.
        customerData.pppoe_username = String(existingSecret.name || normalizedUsername).trim();
        customerData.pppoe_password = '';
        customerData.pppoe_profile = String(existingSecret.profile || '').trim();
        pppoeAccountReused = true;
      } else if (autoPppoe) {
        let targetProfile = 'default';
        if (customerData.status === 'suspended') {
          targetProfile = customerData.isolir_profile || 'isolir';
        } else if (customerData.package_id) {
          const pkg = customerSvc.getPackageById(customerData.package_id);
          if (pkg && pkg.name) targetProfile = pkg.name;
        }
        await mikrotikService.addPppoeSecret({
          name: normalizedUsername,
          password: newPppoePassword,
          service: 'pppoe',
          profile: targetProfile,
          comment: `${name} - dibuat teknisi`
        }, customerData.router_id);
        customerData.pppoe_username = normalizedUsername;
        customerData.pppoe_profile = targetProfile;
        pppoeAccountCreated = true;
      } else {
        throw new Error('Username PPPoE belum ditemukan pada router yang dipilih. Periksa pilihan router dan ejaan username, atau isi password untuk membuat akun PPPoE baru.');
      }
    }

    // This endpoint only creates the customer record. It does not alter an
    // existing PPPoE secret/profile, disconnect a session, or create ONU jobs.
    // ONU activation/binding must be started separately from the activation flow.
    const inserted = customerSvc.createCustomer(customerData);

    const updateOdpFlag = String(req.body.update_odp || '') === '1';
    if (updateOdpFlag && customerData.odp_id) {
      const existing = odpSvc.getOdpById(customerData.odp_id);
      if (existing) {
        const newLat = String(req.body.odp_lat || '').trim();
        const newLng = String(req.body.odp_lng || '').trim();
        const newCap = req.body.odp_port_capacity !== undefined && req.body.odp_port_capacity !== null && String(req.body.odp_port_capacity).trim() !== ''
          ? Number(req.body.odp_port_capacity)
          : (existing.port_capacity || 16);
        const newPon = String(req.body.odp_pon_port || '').trim();

        odpSvc.updateOdp(existing.id, {
          name: existing.name,
          olt_id: existing.olt_id,
          pon_port: newPon || existing.pon_port || '',
          port_capacity: Number.isFinite(newCap) && newCap > 0 ? Math.floor(newCap) : (existing.port_capacity || 16),
          lat: newLat || existing.lat || '',
          lng: newLng || existing.lng || '',
          description: existing.description || ''
        });
      }
    }

    req.session._msg = {
      type: 'success',
      text: `Pelanggan "${name}" berhasil dibuat.${pppoeAccountReused ? ' Akun PPPoE yang sudah ada digunakan kembali; password dan profil MikroTik tidak diubah.' : (pppoeAccountCreated ? ' Akun PPPoE baru berhasil dibuat.' : '')} Aktivasi ONU tidak dijalankan dari menu Tambah Pelanggan.`
    };
    res.redirect('/tech/customers/new');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat pelanggan: ' + e.message };
    res.redirect('/tech/customers/new');
  }
});

// API Endpoints for Technician
const customerDevice = require('../services/customerDeviceService');

router.get('/api/mikrotik/pppoe-users', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    const usedRows = db.prepare('SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ""').all(routerId);
    const used = new Set(usedRows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/pppoe-profiles', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PPPoE status source: MikroTik secrets and active sessions, not billing records.
const techPppoeSecretCache = new Map();
router.get('/api/map/link-status', requireTechSession, async (req, res) => {
  try {
    const statusPayload = await networkTopologyStatusSvc.getMapLinkStatus();
    const oltMapStatus = mapOltStatusSvc.getPayload();
    return res.json({ ...statusPayload, ...oltMapStatus });
  } catch (e) {
    console.warn('[TECH NETWORK MAP] gagal mengambil status jalur:', e.message);
    return res.status(503).json({ ok: false, error: 'Status pelanggan sementara tidak tersedia.' });
  }
});

// Baca RX optik pelanggan dari ACS terlebih dahulu; jika telemetry tidak tersedia, coba data optik baca-saja dari OLT.
router.get('/api/map/optical/customer/:id', requireTechSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isSafeInteger(customerId) || customerId < 1) return res.status(400).json({ ok: false, message: 'ID pelanggan tidak valid.' });
  const parseDbm = value => {
    if (value === null || value === undefined || value === '' || value === '-' || value === 'N/A') return null;
    const match = String(value).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) && number >= -60 && number <= 10 ? number : null;
  };
  const serialKey = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  try {
    const customer = db.prepare('SELECT id,name,genieacs_tag,pppoe_username,olt_id,odp_id FROM customers WHERE id=? LIMIT 1').get(customerId);
    if (!customer) return res.status(404).json({ ok: false, message: 'Pelanggan tidak ditemukan.' });

    let acsData = null;
    let acsError = '';
    const tokens = [...new Set([customer.genieacs_tag, customer.pppoe_username].map(v => String(v || '').trim()).filter(Boolean))];
    for (const token of tokens) {
      try {
        const resolved = await customerDevice.resolveDeviceToken(token);
        if (!resolved || !resolved._id) continue;
        const rawDevice = await customerDevice.fetchFullDevice(resolved._id);
        if (!rawDevice) continue;
        acsData = customerDevice.mapDeviceData(rawDevice, token, false);
        break;
      } catch (error) { acsError = error.message || 'ACS tidak dapat dibaca'; }
    }

    const acsRx = parseDbm(acsData && acsData.rxPower);
    const acsTx = parseDbm(acsData && acsData.txPower);
    if (acsRx !== null) {
      return res.json({
        ok: true, actual: true, source: 'ACS', rxPower: acsRx, txPower: acsTx,
        serialNumber: acsData.serialNumber || '-', status: acsData.status || '-',
        lastInform: acsData.lastInform || '-', note: 'RX adalah daya optik yang dilaporkan ONT ke ACS.'
      });
    }

    let oltRows = null;
    let oltError = '';
    if (Number(customer.olt_id) > 0) {
      try {
        oltRows = await oltSvc.getConfiguredOnusForProvision(Number(customer.olt_id));
        if (!Array.isArray(oltRows)) {
          const stats = await oltSvc.getOltStats(Number(customer.olt_id), true);
          oltRows = Array.isArray(stats && stats.onus) ? stats.onus : [];
          if (stats && stats.error) oltError = stats.error;
        }
      } catch (error) { oltError = error.message || 'Pembacaan optik OLT gagal'; }
    }

    const snTokens = [acsData && acsData.serialNumber, customer.genieacs_tag].map(serialKey).filter(v => v.length >= 8);
    const oltMatch = (Array.isArray(oltRows) ? oltRows : []).find(row => {
      const keys = [row.serialNumber, row.sn, row.mac].map(serialKey).filter(v => v.length >= 8);
      return keys.some(a => snTokens.some(b => a === b || (Math.min(a.length, b.length) >= 8 && (a.endsWith(b) || b.endsWith(a)))));
    });
    const oltRx = parseDbm(oltMatch && (oltMatch.rxPower || oltMatch.rx || oltMatch.rx_power));
    if (oltRx !== null) {
      return res.json({
        ok: true, actual: true, source: 'OLT', rxPower: oltRx,
        txPower: parseDbm(oltMatch.txPower || oltMatch.tx),
        serialNumber: oltMatch.serialNumber || oltMatch.sn || customer.genieacs_tag || '-',
        status: oltMatch.status || '-', note: 'Daya RX ONT dibaca langsung dari tabel optik OLT.'
      });
    }

    return res.json({
      ok: true, actual: false, source: null, rxPower: null, txPower: acsTx,
      serialNumber: (acsData && acsData.serialNumber) || customer.genieacs_tag || '-',
      status: (acsData && acsData.status) || '-',
      lastInform: (acsData && acsData.lastInform) || '-',
      message: acsError || oltError
        ? 'Nilai RX optik aktual belum dapat dibaca. ACS/OLT tidak mengembalikan nilai yang valid.'
        : 'Perangkat belum melaporkan RX optik ke ACS dan OLT.'
    });
  } catch (error) {
    console.warn('[TECH MAP OPTICAL] gagal membaca pelanggan ' + customerId + ': ' + (error.message || error));
    return res.status(503).json({ ok: false, message: 'Pembacaan RX aktual sementara tidak tersedia.' });
  }
});

router.get('/api/mikrotik/pppoe-status', requireTechSession, async (req, res) => {
  try {
    const routers = mikrotikService.getAllRouters();
    const billingCustomers = customerSvc.getAllCustomers();
    const customerByUsername = new Map(billingCustomers.filter(c => String(c.pppoe_username || '').trim()).map(c => [String(c.pppoe_username).trim().toLowerCase(), c]));
    const result = [];
    const routerErrors = [];
    for (const routerRow of routers) {
      const rid = Number(routerRow.id);
      const routerName = routerRow.name || ('MikroTik #' + rid);
      let secrets;
      const cached = techPppoeSecretCache.get(rid);
      if (cached && Date.now() - cached.at < 30000) secrets = cached.rows;
      else {
        try {
          secrets = await mikrotikService.getPppoeUsers(rid);
          if (!Array.isArray(secrets)) secrets = [];
          techPppoeSecretCache.set(rid, { at: Date.now(), rows: secrets });
        } catch (e) { routerErrors.push({ router: routerName, error: e.message }); continue; }
      }
      let activeMap;
      try {
        const activeRows = await mikrotikService.getPppoeActive(rid);
        activeMap = new Map();
        for (const row of (Array.isArray(activeRows) ? activeRows : [])) {
          const username = String(row.name || row.user || '').trim().toLowerCase();
          if (username) activeMap.set(username, row);
        }
      } catch (e) { routerErrors.push({ router: routerName, error: e.message }); activeMap = null; }
      for (const secret of secrets) {
        const username = String(secret.name || '').trim();
        if (!username) continue;
        const customer = customerByUsername.get(username.toLowerCase());
        const session = activeMap ? (activeMap.get(username.toLowerCase()) || null) : null;
        result.push({ id: String(rid) + ':' + username, name: customer?.name || username, phone: customer?.phone || '-', pppoe: username, routerId: rid, routerName, packageName: customer?.package_name || secret.profile || '-', profile: secret.profile || '-', disabled: Boolean(secret.disabled), status: activeMap === null ? 'unknown' : (session ? 'active' : 'disconnected'), ip: session?.address || session?.['remote-address'] || '-', uptime: session?.uptime || '-', service: 'pppoe' });
      }
    }
    res.json({ ok: true, updatedAt: new Date().toISOString(), routerErrors, summary: { total: result.length, active: result.filter(x => x.status === 'active').length, disconnected: result.filter(x => x.status === 'disconnected').length, unknown: result.filter(x => x.status === 'unknown').length }, customers: result });
  } catch (e) { console.error('[TECH PPPoE STATUS]', e); res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/odps/:id/ports', requireTechSession, (req, res) => {
  try {
    const odpId = Number(req.params.id);
    if (!odpId) return res.status(400).json({ error: 'ODP tidak valid' });
    const usage = odpSvc.getOdpPortUsage(odpId);
    if (!usage) return res.status(404).json({ error: 'ODP tidak ditemukan' });
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/devices', requireTechSession, async (req, res) => {
  try {
    const { search, status, acs, limit = 999999, offset = 0 } = req.query;
    const customers = db.prepare('SELECT id, name, phone, pppoe_username, genieacs_tag FROM customers').all();
    const byPppoe = new Map();
    const byTag = new Map();
    for (const c of customers) {
      const pu = String(c.pppoe_username || '').trim().toLowerCase();
      const tg = String(c.genieacs_tag || '').trim();
      if (pu) byPppoe.set(pu, c);
      if (tg) byTag.set(tg, c);
    }

    const result = await customerDevice.listAllDevices(999999, acs);
    if (!result.ok) return res.json({ error: result.message });
    
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
    let devices = result.devices.map(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive);
      const pu = String(mapped.pppoeUsername || '').trim();
      const puKey = pu && pu !== 'N/A' ? pu.toLowerCase() : '';
      let customer = puKey ? byPppoe.get(puKey) : null;
      if (!customer && Array.isArray(d._tags)) {
        for (const t of d._tags) {
          const hit = byTag.get(String(t || '').trim());
          if (hit) { customer = hit; break; }
        }
      }
      const visibleTags = Array.isArray(d._tags)
        ? d._tags.filter(Boolean).map(String).filter(t => t.trim().toLowerCase() !== 'bootstrapped')
        : [];
      return {
        id: String(d._id || ''),
        tags: visibleTags,
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid,
        // Show only active clients in the device-list count; Hosts.Host can also
        // include stale/inactive DHCP entries which remain useful in the detail view.
        wifiClientCount: Array.isArray(mapped.connectedUsers)
          ? mapped.connectedUsers.filter(u =>
              u && u.mac && u.mac !== '-' && String(u.status || '').toLowerCase() === 'online'
            ).length
          : 0,
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : '',
        customerPhone: customer ? customer.phone : '',
        acsServerName: d._acs_server_name || 'Default ACS',
        acsServerId: d._acs_server_id || 'legacy',
        manufacturer: d._deviceId?._Manufacturer || d._deviceId?.Manufacturer || '-'
      };
    });

    if (search) {
      const s = search.toLowerCase();
      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s)) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.customerName && d.customerName.toLowerCase().includes(s)) ||
        (d.customerPhone && d.customerPhone.toLowerCase().includes(s))
      );
    }

    if (acs && acs !== 'all') {
      devices = devices.filter(d => String(d.acsServerId) === String(acs));
    }

    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    
    res.json({ devices: devices, total: devices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/device/:tag', requireTechSession, async (req, res) => {
  try {
    const actor = {
      type: 'technician',
      id: req.session?.userId || req.session?.techId || req.session?.user?.id || null,
      name: String(req.session?.username || req.session?.user?.username || 'Technician'),
      ip: req.ip,
      userAgent: req.get('user-agent')
    };
    const forceRefresh = String(req.query.refresh || '') === '1';
    let refreshResult = null;
    if (forceRefresh) {
      // This is a read-only Wi-Fi client refresh. It does not write SSID, password,
      // WAN, PPPoE, reboot, or any other ONU configuration.
      refreshResult = await customerDevice.requestRefresh(req.params.tag, actor, { clientDetails: true });
    }

    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });

    const deviceIsOnline = String(data.status || '').toLowerCase() === 'online';
    let clientsSyncing = Boolean(data.syncInProgress || refreshResult?.queued || refreshResult?.busy);

    // Automatically request a fresh client snapshot when the panel is first opened
    // and the last confirmed client-table read is older than one hour.
    if (!forceRefresh && deviceIsOnline && data.clientDataFresh !== true && !data.syncInProgress) {
      try {
        refreshResult = await customerDevice.requestRefresh(req.params.tag, actor, { clientDetails: true });
        clientsSyncing = Boolean(refreshResult?.queued || refreshResult?.busy);
      } catch (_) {}
    }

    res.json({
      ...data,
      clientsSyncing,
      clientRefreshMessage: refreshResult?.message || '',
      clientRefreshQueued: Boolean(refreshResult?.queued)
    });
  } catch (e) {
    console.error('[TECH ACS CLIENT DETAILS] failed:', e.message);
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireTechSession, express.json(), async (req, res) => {
  try {
    const ssid24 = String(req.body.ssid24 || '').trim();
    const ssid5 = String(req.body.ssid5 || '').trim();
    const actor = {
      type: 'technician',
      id: req.session?.userId || req.session?.techId || req.session?.user?.id || null,
      name: req.session?.username || req.session?.user?.username || 'Technician',
      ip: req.ip,
      userAgent: req.get('user-agent')
    };
    const result = await customerDevice.requestWifiSsidUpdate(req.params.tag, ssid24, ssid5, actor);
    if (result && result.handled) {
      if (!result.success) {
        return res.status(409).json({
          success: false, code: result.code || 'SSID_UPDATE_REJECTED',
          message: result.message || 'Perubahan nama Wi-Fi tidak dapat dikirim.'
        });
      }
      return res.status(202).json({
        success: true, pending: true, taskId: result.taskId,
        verifyTaskId: result.verifyTaskId, message: result.message
      });
    }
    return res.status(409).json({
      success: false, code: 'ACS_TASK_STATUS_UNAVAILABLE',
      message: 'ACS perangkat ini belum mendukung verifikasi perubahan nama Wi-Fi. Tidak ada perubahan yang dikirim.'
    });
  } catch (error) {
    logger.error('[TechWiFi] SSID update route failed: ' + String(error.message || error).slice(0, 180));
    return res.status(500).json({ success: false, message: 'Gagal memproses perubahan nama Wi-Fi.' });
  }
});

router.get('/api/device/:tag/ssid/status/:taskId', requireTechSession, async (req, res) => {
  try {
    const device = await customerDevice.resolveDeviceToken(req.params.tag);
    if (!device || !device._id) {
      return res.status(404).json({ success: false, done: true, message: 'ONT tidak ditemukan.' });
    }
    const taskId = Number(req.params.taskId);
    const verifyTaskId = Number(req.query.verifyTaskId);
    if (!Number.isSafeInteger(taskId) || taskId <= 0 || !Number.isSafeInteger(verifyTaskId) || verifyTaskId <= 0) {
      return res.status(400).json({ success: false, done: true, message: 'ID task perubahan nama Wi-Fi tidak valid.' });
    }
    const task = db.prepare('SELECT id,name,status,result,payload FROM acs_tasks WHERE id=? AND device_id=?')
      .get(taskId, String(device._id));
    const verifyTask = db.prepare('SELECT id,name,status,result FROM acs_tasks WHERE id=? AND device_id=?')
      .get(verifyTaskId, String(device._id));
    if (!task || task.name !== 'setParameterValues' || !verifyTask || verifyTask.name !== 'getParameterValues') {
      return res.status(404).json({ success: false, done: true, message: 'Task perubahan atau verifikasi SSID tidak ditemukan.' });
    }
    if (task.status === 'pending' || task.status === 'in_progress' || verifyTask.status === 'pending' || verifyTask.status === 'in_progress') {
      return res.json({ success: true, pending: true, done: false, taskId, verifyTaskId });
    }
    if (task.status !== 'completed') {
      return res.json({ success: false, pending: false, done: true, message: 'ONT gagal menjalankan perubahan nama Wi-Fi. Status task: ' + String(task.status || 'tidak diketahui') + '.' });
    }
    let writeResult = {};
    let verifyResult = {};
    let writePayload = {};
    try { writeResult = JSON.parse(task.result || '{}'); } catch (_) {}
    try { verifyResult = JSON.parse(verifyTask.result || '{}'); } catch (_) {}
    try { writePayload = JSON.parse(task.payload || '{}'); } catch (_) {}
    if (String(writeResult.status ?? '') !== '0') {
      return res.json({ success: false, pending: false, done: true, message: 'ONT menyelesaikan task tetapi menolak SetParameterValues. Nama Wi-Fi belum dinyatakan berubah.' });
    }
    if (verifyTask.status !== 'completed') {
      return res.json({ success: false, pending: false, done: true, message: 'Task perubahan diterima, tetapi pembacaan ulang SSID gagal. Periksa nama Wi-Fi sebelum mencoba lagi.' });
    }
    const expected = Array.isArray(writePayload.parameterValues) ? writePayload.parameterValues : [];
    const mismatches = expected.filter(item => {
      if (!Array.isArray(item) || !item[0]) return true;
      const actual = verifyResult[item[0]];
      const actualValue = actual && typeof actual === 'object' && Object.prototype.hasOwnProperty.call(actual, '_value')
        ? actual._value : actual;
      return String(actualValue ?? '').trim() !== String(item[1] ?? '').trim();
    });
    if (mismatches.length) {
      return res.json({ success: false, pending: false, done: true, message: 'Perintah diterima, tetapi hasil baca ulang dari ONT belum cocok. Nama Wi-Fi belum dinyatakan berhasil.' });
    }

    // Save a one-time notification marker in the write-task result to avoid repeated WhatsApp alerts.
    if (!writeResult.wifiVerified) {
      writeResult.wifiVerified = true;
      writeResult.verifiedAt = new Date().toISOString();
      const update = db.prepare('UPDATE acs_tasks SET result=? WHERE id=? AND device_id=?');
      update.run(JSON.stringify(writeResult), taskId, String(device._id));
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const settings = getSettingsWithCache();
        if (settings.whatsapp_enabled) {
          const cust = customerSvc.findCustomerByAny(req.params.tag);
          if (cust && cust.phone) {
            const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
            if (whatsappStatus && whatsappStatus.connection === 'open') {
              const names = expected.map(item => ((item[0].includes('WLANConfiguration.1.') || item[0].includes('Device.WiFi.SSID.1.')) ? '2,4 GHz' : '5 GHz') + ': ' + item[1]).join('\n');
              await sendWA(cust.phone, `📶 *PERUBAHAN NAMA WI-FI*\n\nPelanggan: ${cust.name}\nNama baru sudah terverifikasi oleh ACS:\n${names}\n\nSilakan sambungkan ulang perangkat Anda.`);
            }
          }
        }
      } catch (_) { /* notification failure does not invalidate ACS verification */ }
    }
    return res.json({ success: true, pending: false, done: true, message: 'Nama Wi-Fi 2,4 GHz/5 GHz berhasil diterapkan dan diverifikasi ulang dari ONT.' });
  } catch (error) {
    logger.error('[TechWiFi] SSID status check failed: ' + String(error.message || error).slice(0, 180));
    return res.status(500).json({ success: false, done: true, message: 'Gagal memeriksa hasil perubahan nama Wi-Fi.' });
  }
});

router.post('/api/device/:tag/password', requireTechSession, express.json(), async (req, res) => {
  const { password } = req.body;
  const band = String(req.body.band || 'both').trim().toLowerCase();
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  if (!['2g', '5g', 'both'].includes(band)) {
    return res.status(400).json({ success: false, code: 'INVALID_WIFI_BAND', message: 'Pilihan band Wi-Fi tidak valid.' });
  }
  const techWifiResult = await customerDevice.requestWifiPasswordUpdate(req.params.tag, password, band);
  if (techWifiResult && techWifiResult.handled) {
    if (!techWifiResult.success) {
      return res.status(409).json({
        success: false,
        code: techWifiResult.code || 'WIFI_UPDATE_REJECTED',
        message: techWifiResult.message || 'Perubahan password WiFi belum dapat dikirim.'
      });
    }
    return res.status(202).json({
      success: true,
      pending: true,
      taskId: techWifiResult.taskId,
      activeWlanIndexes: techWifiResult.activeWlanIndexes,
      message: techWifiResult.message
    });
  }

  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan only for the legacy path;
  // FiberHome HG6145D2 is reported as pending until ACS confirms its task.
  if (ok) {
    try {
      const { getSettingsWithCache } = require('../config/settingsManager');
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const tag = req.params.tag;
        const cust = customerSvc.findCustomerByAny(tag);
        if (cust && cust.phone) {
          const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
          if (whatsappStatus && whatsappStatus.connection === 'open') {
            const now = getNowLocal();
            const msg = `\ud83d\udd11 *PERUBAHAN PASSWORD WIFI*\n\n` +
              `\ud83d\udc64 *Pelanggan:* ${cust.name}\n` +
              `\ud83d\udd52 *Waktu:* ${now}\n\n` +
              `Password WiFi Anda sudah diperbarui menjadi:\n` +
              `\ud83d\udd10 *${password}*\n\n` +
              `Silakan gunakan password baru untuk terhubung.\n` +
              `\u26a0\ufe0f Jangan bagikan password ini ke orang lain.`;
            await sendWA(cust.phone, msg);
          }
        }
      }
    } catch (e) { /* ignore WA notification errors */ }
  }
  res.json({ success: ok });
});


router.get('/api/device/:tag/password/status/:taskId', requireTechSession, async (req, res) => {
  try {
    const device = await customerDevice.resolveDeviceToken(req.params.tag);
    if (!device || !device._id) {
      return res.status(404).json({ success: false, done: true, message: 'ONT tidak ditemukan.' });
    }
    const taskId = Number(req.params.taskId);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ success: false, done: true, message: 'ID task tidak valid.' });
    }
    const task = db.prepare(
      'SELECT id,name,status,result FROM acs_tasks WHERE id=? AND device_id=?'
    ).get(taskId, String(device._id));
    if (!task || task.name !== 'setParameterValues') {
      return res.status(404).json({ success: false, done: true, message: 'Task perubahan WiFi tidak ditemukan.' });
    }
    if (task.status === 'pending' || task.status === 'in_progress') {
      return res.json({ success: true, pending: true, done: false, taskId });
    }
    if (task.status === 'completed') {
      let result = {};
      try { result = JSON.parse(task.result || '{}'); } catch (_) {}
      const accepted = String(result.status ?? '') === '0';
      return res.json({
        success: accepted,
        pending: false,
        done: true,
        taskId,
        message: accepted
          ? 'ONT sudah menerima perubahan password WiFi dari ACS.'
          : 'ONT menyelesaikan respons task, tetapi status SetParameterValues bukan sukses. Periksa hasil ACS.'
      });
    }
    return res.json({
      success: false,
      pending: false,
      done: true,
      taskId,
      message: task.status === 'failed'
        ? 'ONT menolak atau gagal menjalankan perubahan password WiFi.'
        : 'Task perubahan password WiFi berstatus ' + String(task.status || 'tidak diketahui') + '.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, done: true, message: 'Gagal membaca status task ACS.' });
  }
});

router.post('/api/device/:tag/reboot', requireTechSession, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

// Attendance feature removed from the technician portal.

// Helpers for GenieACS Server DB access inside Technician Portal
function getACSServers(id = null) {
    if (genieacsApi.isBuiltinAcsEnabled()) {
        const builtinServer = {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
        if (id && id !== 'all') {
            return id === 'builtin' ? [builtinServer] : [];
        }
        return [builtinServer];
    }

    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        return row ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    return legacyServer ? [legacyServer, ...rows] : rows;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', '')
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 15000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    return config;
}

function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toBool(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

// FiberHome HG6145D2 reports PPPoE_Routed on working WANs. Keep the legacy
// vendor mapping for other models until their actual ConnectionType is discovered.
function getWanConnectionType(mode, manufacturer, productClass) {
    if (String(mode || '').toLowerCase() !== 'pppoe') return 'Bridged';
    const make = String(manufacturer || '').toLowerCase();
    const model = String(productClass || '').toUpperCase();
    if (make.includes('fiberhome') && model.includes('HG6145D2')) return 'PPPoE_Routed';
    return 'IP_Routed';
}

function normalizeSelectionArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return Array.from(new Set(
        items.map(v => String(v || '').trim()).filter(Boolean)
    ));
}

function buildSingleParamTasks(parameterValues) {
    return (parameterValues || [])
        .filter(pv => Array.isArray(pv) && pv.length >= 2 && pv[0])
        .map(pv => ({
            name: 'setParameterValues',
            payload: { parameterValues: [pv] }
        }));
}

function getParamLeafValue(obj, key) {
    if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    const value = obj[key];
    if (value && typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, '_value')) return value._value;
        if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
    }
    return value;
}

// Reuse a failed PPPoE entry with the same username rather than creating WAN.3/4/... on every retry.
// If state is not known, stop instead of risking a duplicate interface.
function findExistingPppoeByUsername(wanConnectionDevices, username) {
    const wanted = String(username || '').trim();
    if (!wanted) return null;
    for (const [wanDeviceInstance, wcd] of Object.entries(wanConnectionDevices || {})) {
        if (!/^\d+$/.test(wanDeviceInstance) || !wcd || typeof wcd !== 'object') continue;
        const table = wcd.WANPPPConnection || {};
        for (const [connectionInstance, ppp] of Object.entries(table)) {
            if (!/^\d+$/.test(connectionInstance) || !ppp || typeof ppp !== 'object') continue;
            const currentUser = String(getParamLeafValue(ppp, 'Username') ?? '').trim();
            if (!currentUser || currentUser !== wanted) continue;
            const hasIp = Object.prototype.hasOwnProperty.call(ppp, 'ExternalIPAddress');
            const ip = hasIp ? String(getParamLeafValue(ppp, 'ExternalIPAddress') ?? '').trim() : null;
            if (!hasIp) return { state: 'unknown', wanDeviceInstance, connectionInstance, ip: null };
            if (!ip || ip === '0.0.0.0') return { state: 'reusable', wanDeviceInstance, connectionInstance, ip };
            return { state: 'active', wanDeviceInstance, connectionInstance, ip };
        }
    }
    return null;
}

async function queueExistingWanFollowups(axiosClient, baseUrl, deviceId, followups, vars, config) {
    let firstTaskId = null;
    for (const spec of (Array.isArray(followups) ? followups : [])) {
        if (!spec || !spec.name) continue;
        const rawPayload = spec.payload && typeof spec.payload === 'object' ? spec.payload : {};
        const body = JSON.parse(JSON.stringify({ name: spec.name, ...rawPayload })
            .replace(/\{\{wanDeviceInstance\}\}/g, String(vars.wanDeviceInstance))
            .replace(/\{\{wanConnectionInstance\}\}/g, String(vars.wanConnectionInstance)));
        const response = await axiosClient.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, body, config);
        if (firstTaskId === null) {
            const parsed = parseInt(response?.data?._id, 10);
            if (Number.isFinite(parsed)) firstTaskId = parsed;
        }
    }
    return firstTaskId;
}

function buildBuiltinAddWanWorkflow({
    mode,
    parsedVlan,
    pppoeUser,
    pppoePass,
    dhcp,
    lanPorts,
    wlanSsids,
    configureWifi,
    wifiSsid24,
    wifiPass24,
    wifiSsid5,
    wifiPass5,
    manufacturer,
    productClass,
    wlanConfig,
    wanConnectionDevices
}) {
    const isPppoe = mode === 'pppoe';
    const manufacturerKey = String(manufacturer || '').toLowerCase();
    const productClassKey = String(productClass || '').toUpperCase();
    const isZteF6600P = manufacturerKey.includes('zte') && productClassKey.includes('F6600P');
    const isFiberHomeHG6145D2 = manufacturerKey.includes('fiberhome') && productClassKey.includes('HG6145D2');
    const connectionType = isPppoe ? 'WANPPPConnection' : 'WANIPConnection';
    const lanPortsArray = normalizeSelectionArray(lanPorts);
    const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
    const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.{{wanConnectionInstance}}`;
    const followup = [];

    const baseParamValues = [
        [`${baseConnPath}.ConnectionType`, getWanConnectionType(mode, manufacturer, productClass), 'xsd:string']
    ];

    if (isPppoe) {
        baseParamValues.push(
            [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
            [`${baseConnPath}.Username`, pppoeUser, 'xsd:string'],
            [`${baseConnPath}.Password`, pppoePass, 'xsd:string']
        );
        if (isFiberHomeHG6145D2) {
            // FiberHome WAN service names and dial-on-demand behavior must be configured on
            // the NEW PPP interface, never on the existing TR-069 WAN interface.
            baseParamValues.push(
                [`${baseConnPath}.Name`, `{{wanDeviceInstance}}_INTERNET_R_VID_${parsedVlan}`, 'xsd:string'],
                [`${baseConnPath}.ConnectionTrigger`, 'AlwaysOn', 'xsd:string']
            );
            // On the tested HG6145D2, TransportType is read-only (CWMP 9008).
            // IP_Routed + PPP credentials + VLANID is the verified configuration path.
        }
    }

    const vendorParamValues = [];
    if (isFiberHomeHG6145D2) {
        // HG6145D2's tested PPP VLAN leaf is VLANID. X_FH_ServiceList is also
        // configured on the new PPP instance; do not assume VLANEnable without readback.
        vendorParamValues.push([baseConnPath + '.VLANID', parsedVlan, 'xsd:unsignedInt']);
        if (isPppoe) {
            // X_FH_ServiceList is verified on HG6145D2; VLANID is the supported
            // PPP leaf, while VLANEnable is not assumed without a successful readback.
            vendorParamValues.push([`${baseConnPath}.X_FH_ServiceList`, 'INTERNET', 'xsd:string']);
        }
    } else if (manufacturer.includes('huawei')) {
        vendorParamValues.push(
            [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_HW_WANMode`, isPppoe ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else if (manufacturer.includes('zte') && String(productClass || '').toUpperCase().includes('F6600P')) {
        // ZTE F6600P reports these vendor-specific names on its existing WAN tree.
        vendorParamValues.push(
            [`${baseConnPath}.X_ZTE-COM_ServiceList`, 'INTERNET', 'xsd:string'],
            [`${baseConnPath}.X_ZTE-COM_VLANEnable`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_ZTE-COM_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE-COM_8021P`, 0, 'xsd:unsignedInt']
        );
    } else if (manufacturer.includes('zte')) {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else {
        // Generic fallback: do not guess vendor-specific VLANIDMark/VLANMode paths.
        vendorParamValues.push([`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt']);
    }

    // HG6145D2 models the PON/VLAN link per WANConnectionDevice. Create a fresh
    // WANConnectionDevice and configure its link first; changing the old container can
    // disturb TR-069 (for example VLAN 1011) when adding customer PPPoE VLAN 100.
    if (isFiberHomeHG6145D2 && isPppoe) {
        const linkBase = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.X_FH_WANGponLinkConfig';
        followup.push(...buildSingleParamTasks([
            [`${linkBase}.Enable`, true, 'xsd:boolean'],
            [`${linkBase}.Mode`, 2, 'xsd:unsignedInt'],
            [`${linkBase}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${linkBase}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${linkBase}.802-1pMark`, 0, 'xsd:unsignedInt']
        ]));
    }
    followup.push(...buildSingleParamTasks(baseParamValues));
    followup.push(...buildSingleParamTasks(vendorParamValues));
    // Enable last: some firmware rejects enabling a new WAN before required fields exist.
    followup.push({ name: 'setParameterValues', payload: { parameterValues: [[`${baseConnPath}.Enable`, true, 'xsd:boolean']] } });

    followup.push({
        name: 'setParameterValues',
        payload: {
            parameterValues: [[
                'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable',
                toBool(dhcp),
                'xsd:boolean'
            ]]
        }
    });

    const verifyNames = [
        `${baseConnPath}.Enable`,
        `${baseConnPath}.ConnectionType`,
        `${baseConnPath}.ConnectionStatus`,
        `${baseConnPath}.ExternalIPAddress`,
        `${baseConnPath}.Uptime`
    ];
    if (isPppoe) {
        verifyNames.push(`${baseConnPath}.Username`, `${baseConnPath}.NATEnabled`, `${baseConnPath}.VLANID`);
        if (isFiberHomeHG6145D2) {
            verifyNames.push(
                `${baseConnPath}.Name`,
                `${baseConnPath}.X_FH_ServiceList`,
                `${baseConnPath}.ConnectionTrigger`
            );
        }
    }

    const wifiParamValues = [];
    const wlanObj = wlanConfig || {};
    if (toBool(configureWifi)) {
        if (wlanObj['1'] && wifiSsid24) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
            verifyNames.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            if (wifiPass24) {
                if (isZteF6600P) {
                    wifiParamValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']);
                } else {
                    wifiParamValues.push(
                        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', wifiPass24, 'xsd:string'],
                        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']
                    );
                }
            }
        }

        const fiveGIndex = wlanObj['5'] ? '5' : (wlanObj['2'] ? '2' : null);
        if (fiveGIndex && wifiSsid5) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
            verifyNames.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`);
            if (wifiPass5) {
                if (isZteF6600P) {
                    wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']);
                } else {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }
        }
    }

    followup.push(...buildSingleParamTasks(wifiParamValues));
    followup.push({
        name: 'getParameterValues',
        payload: {
            parameterNames: Array.from(new Set(verifyNames))
        }
    });

    // For FiberHome HG6145D2 PPPoE, a separate WANConnectionDevice is required.
    // Its existing WCD contains the management WAN (WANIPConnection, VLAN 1011); adding
    // PPP inside that same container can leave it Unconfigured or disrupt ACS management.
    if (isFiberHomeHG6145D2 && isPppoe) {
        return {
            name: 'addObject',
            objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.',
            instanceVariable: 'wanDeviceInstance',
            followup: [{
                name: 'addObject',
                payload: {
                    objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.`,
                    instanceVariable: 'wanConnectionInstance',
                    followup
                }
            }]
        };
    }

    const existingWanInstances = Object.keys(wanConnectionDevices || {})
        .filter(key => /^\d+$/.test(key)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (existingWanInstances.length > 0) {
        const wanDeviceInstance = existingWanInstances[0];
        return {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanDeviceInstance}.${connectionType}`,
            instanceVariable: 'wanConnectionInstance',
            templateVars: { wanDeviceInstance: String(wanDeviceInstance) },
            followup
        };
    }
    return {
        name: 'addObject',
        objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
        instanceVariable: 'wanDeviceInstance',
        followup: [{
            name: 'addObject',
            payload: {
                objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}`,
                instanceVariable: 'wanConnectionInstance',
                followup
            }
        }]
    };
}

function getNestedValue(obj, path) {
    try {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }
        if (current && typeof current === 'object' && '_value' in current) {
            return current._value;
        }
        return current;
    } catch (e) {
        return null;
    }
}

// GET /tech/api/wifi-settings/:deviceId
router.get('/api/wifi-settings/:deviceId', requireTechSession, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).json({ success: false, message: 'ACS Server not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        
        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration,Device.WiFi.SSID,Device.WiFi.AccessPoint'
            }
        });
        
        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).json({ success: false, message: 'Device not found' });
        
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        
        // Return all SSID indices (1 to 8) that exist on the ONU
        for (let i = 1; i <= 8; i++) {
            if (wlanConfig[String(i)]) {
                bands.push({
                    index: String(i),
                    ssid: getNestedValue(wlanConfig[String(i)], 'SSID') || `SSID ${i}`,
                    name: i <= 4 ? `Wi-Fi 2.4GHz (SSID ${i})` : `Wi-Fi 5GHz (SSID ${i})`
                });
            }
        }
        
        const getSsid = value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value') ? value._value : value;
        const tr181Ssids = deviceData.Device?.WiFi?.SSID || {};
        const ssid24Config = wlanConfig['1'] || {};
        const ssid5Config = wlanConfig['5'] || wlanConfig['2'] || {};
        const ssid24 = getSsid(ssid24Config.SSID) || getSsid(tr181Ssids['1']?.SSID) || '';
        const ssid5 = getSsid(ssid5Config.SSID) || getSsid(tr181Ssids['2']?.SSID) || '';
        const wifiDisabled = config => {
            const enabled = String(getSsid(config?.Enable) ?? '').trim().toLowerCase();
            const status = String(getSsid(config?.Status) ?? '').trim().toLowerCase();
            const radio = String(getSsid(config?.RadioEnabled) ?? '').trim().toLowerCase();
            return /^(0|false|no|off|disabled)$/.test(enabled) ||
                /^(disabled|down|notpresent|lowerlayerdown|error)$/.test(status) ||
                /^(0|false|no|off|disabled)$/.test(radio);
        };
        const ssid24Disabled = wifiDisabled(ssid24Config);
        const ssid5Disabled = wifiDisabled(ssid5Config);
        res.json({ success: true, bands, ssid24: String(ssid24 || ''), ssid5: String(ssid5 || ''),
            has5g: Boolean(ssid5) && !ssid5Disabled, ssid24Disabled, ssid5Disabled });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /tech/api/add-wan/:deviceId
router.post('/api/add-wan/:deviceId', requireTechSession, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const {
            acsId,
            mode,
            vlanId,
            pppoeUser,
            pppoePass,
            pppoeProfile,
            autoCreateMikrotik,
            lanPorts,
            wlanSsids,
            configureWifi,
            wifiSsid24,
            wifiPass24,
            wifiSsid5,
            wifiPass5,
            dhcp
        } = req.body;
        
        // 1. Validasi awal

        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['pppoe', 'bridge'].includes(normalizedMode)) {
            return res.json({ success: false, message: 'Mode WAN tidak valid' });
        }

        const parsedVlan = parseInt(vlanId, 10);
        if (isNaN(parsedVlan) || parsedVlan < 1 || parsedVlan > 4094) {
            return res.json({ success: false, message: 'VLAN ID tidak valid (harus 1-4094)' });
        }
        
        const trimmedPppoeUser = String(pppoeUser || '').trim();
        const trimmedPppoePass = String(pppoePass || '').trim();
        if (normalizedMode === 'pppoe' && (!trimmedPppoeUser || !trimmedPppoePass)) {
            return res.json({ success: false, message: 'Username dan password PPPoE wajib diisi untuk mode PPPoE' });
        }
        
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS Server tidak ditemukan' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const config = getAxiosConfig(server);
        
        // 2. Jika Auto-create MikroTik diaktifkan
        if (normalizedMode === 'pppoe' && toBool(autoCreateMikrotik)) {
            try {
                await mikrotikService.createPppoeSecret({
                    username: trimmedPppoeUser,
                    password: trimmedPppoePass,
                    profile: pppoeProfile || 'default'
                });
            } catch (mErr) {
                console.error('[TechAddWAN] Failed to create PPPoE Secret in MikroTik:', mErr.message);
                return res.json({ success: false, message: `Gagal membuat akun PPPoE di MikroTik: ${mErr.message}` });
            }
        }
        
        // 3. Ambil data instansi WANConnectionDevice saat ini untuk menghitung nextInstance
        const getDeviceRes = await axios.get(`${baseUrl}/devices`, {
            ...config,
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_deviceId.Manufacturer,_deviceId._Manufacturer,_deviceId.ProductClass,_deviceId._ProductClass,InternetGatewayDevice.WANDevice.1.WANConnectionDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(getDeviceRes.data) && getDeviceRes.data.length > 0 ? getDeviceRes.data[0] : null;
        if (!deviceData) return res.json({ success: false, message: 'CPE/Device tidak ditemukan di GenieACS' });
        
        const manufacturer = String(deviceData._deviceId?._Manufacturer || deviceData._deviceId?.Manufacturer || '').toLowerCase();
        const productClass = String(deviceData._deviceId?._ProductClass || deviceData._deviceId?.ProductClass || '').toUpperCase();
        const isFiberHomeHG6145D2 = manufacturer.includes('fiberhome') && productClass.includes('HG6145D2');
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const wanConnObj = deviceData.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
        const isBuiltinServer = String(server.id || '').trim() === 'builtin' || baseUrl === 'local';

        if (isBuiltinServer) {
            const task = buildBuiltinAddWanWorkflow({
                mode: normalizedMode,
                parsedVlan,
                pppoeUser: trimmedPppoeUser,
                pppoePass: trimmedPppoePass,
                dhcp,
                lanPorts,
                wlanSsids,
                configureWifi,
                wifiSsid24,
                wifiPass24,
                wifiSsid5,
                wifiPass5,
                manufacturer,
                productClass,
                wlanConfig,
                wanConnectionDevices: wanConnObj
            });

            if (normalizedMode === 'pppoe') {
                const existing = findExistingPppoeByUsername(wanConnObj, trimmedPppoeUser);
                const existingContainer = existing ? (wanConnObj[String(existing.wanDeviceInstance)] || {}) : {};
                const existingIpWan = existingContainer.WANIPConnection || {};
                const existingSharesTr069 = isFiberHomeHG6145D2 && Object.values(existingIpWan).some(ipWan => {
                    const name = String(getParamLeafValue(ipWan, 'Name') ?? '').trim();
                    const vlan = String(getParamLeafValue(ipWan, 'VLANID') ?? '').trim();
                    return /TR[- ]?069/i.test(name) || vlan === '1011';
                });
                if (existing?.state === 'active') {
                    return res.status(409).json({ success: false, message: `Username PPPoE sudah aktif pada WAN ${existing.wanDeviceInstance}/${existing.connectionInstance} dengan IP ${existing.ip}; tidak dibuat duplikat.` });
                }
                if (existing?.state === 'unknown' && !existingSharesTr069) {
                    return res.status(409).json({ success: false, message: `Username PPPoE sudah ada pada WAN ${existing.wanDeviceInstance}/${existing.connectionInstance}, tetapi ExternalIPAddress belum terbaca. Segarkan data ACS terlebih dahulu; WAN baru tidak dibuat agar tidak duplikat.` });
                }
                if (existing?.state === 'reusable' && !existingSharesTr069) {
                    let rootTaskId = null;
                    for (const spec of (Array.isArray(task.followup) ? task.followup : [])) {
                        if (!spec || !spec.name) continue;
                        const rawPayload = spec.payload && typeof spec.payload === 'object' ? spec.payload : {};
                        const body = JSON.parse(JSON.stringify({ name: spec.name, ...rawPayload })
                            .replace(/\{\{wanDeviceInstance\}\}/g, String(existing.wanDeviceInstance))
                            .replace(/\{\{wanConnectionInstance\}\}/g, String(existing.connectionInstance)));
                        const queued = await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, body, config);
                        if (rootTaskId === null) {
                            const parsed = parseInt(queued?.data?._id, 10);
                            if (Number.isFinite(parsed)) rootTaskId = parsed;
                        }
                    }
                    return res.json({ success: true, reusedExistingWan: true, rootTaskId,
                        message: `WAN PPPoE lama ${existing.wanDeviceInstance}/${existing.connectionInstance} memiliki IP kosong. Parameter diperbaiki pada instance yang sama; tidak menambah WAN duplikat.` });
                }
            }

            await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, task, config);
            if (isFiberHomeHG6145D2 && normalizedMode === 'pppoe') {
                return res.json({ success: true, pending: true, message: 'Perintah dikirim: ACS akan membuat WANConnectionDevice baru yang terpisah dari TR-069, menambahkan PPPoE, lalu membaca kembali VLAN dan status koneksi. Tunggu verifikasi ACS; ini belum berarti PPPoE sudah Connected.' });
            }
            return res.json({ success: true, pending: true, message: 'Workflow Add WAN built-in berhasil diantrekan. Hasil konfigurasi perlu diverifikasi dari Inform/readback ONT.' });
        }

        const existingKeys = Object.keys(wanConnObj).filter(k => /^\d+$/.test(k)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        const connectionType = normalizedMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection';
        let wanInstance;
        if (existingKeys.length > 0) {
            wanInstance = existingKeys[0];
        } else {
            await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                name: 'addObject',
                objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
            }, config);
            wanInstance = 1;
        }
        const connectionObj = wanConnObj[String(wanInstance)]?.[connectionType] || {};
        const childKeys = Object.keys(connectionObj).filter(k => /^\d+$/.test(k)).map(Number).filter(Number.isFinite);
        const nextConnectionInstance = childKeys.length > 0 ? Math.max(...childKeys) + 1 : 1;
        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanInstance}.${connectionType}.`
        }, config);

        const paramValues = [];
        const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanInstance}.${connectionType}.${nextConnectionInstance}`;
        paramValues.push([`${baseConnPath}.Enable`, true, 'xsd:boolean']);

        if (normalizedMode === 'pppoe') {
            paramValues.push(
                [`${baseConnPath}.ConnectionType`, getWanConnectionType(normalizedMode, manufacturer, deviceData._deviceId?._ProductClass || deviceData._deviceId?.ProductClass || ''), 'xsd:string'],
                [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
                [`${baseConnPath}.Username`, trimmedPppoeUser, 'xsd:string'],
                [`${baseConnPath}.Password`, trimmedPppoePass, 'xsd:string']
            );
        } else {
            paramValues.push([`${baseConnPath}.ConnectionType`, 'Bridged', 'xsd:string']);
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: [[`InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable`, toBool(dhcp), 'xsd:boolean']]
        }, config).catch(() => {});

        const lanPortsArray = normalizeSelectionArray(lanPorts);
        const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
        if (manufacturer.includes('huawei')) {
            paramValues.push(
                [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
                [`${baseConnPath}.X_HW_WANMode`, normalizedMode === 'pppoe' ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else if (manufacturer.includes('zte')) {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else {
            // Generic fallback: avoid invalid vendor-specific parameters.
            paramValues.push([`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt']);
        }

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: paramValues
        }, config);

        if (toBool(configureWifi)) {
            const wifiParamValues = [];
            if (wlanConfig['1'] && wifiSsid24) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
                if (wifiPass24) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey`, wifiPass24, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase`, wifiPass24, 'xsd:string']
                    );
                }
            }

            const fiveGIndex = wlanConfig['5'] ? '5' : (wlanConfig['2'] ? '2' : null);
            if (fiveGIndex && wifiSsid5) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
                if (wifiPass5) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }

            if (wifiParamValues.length > 0) {
                await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                    name: 'setParameterValues',
                    parameterValues: wifiParamValues
                }, config);
            }
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'refreshObject',
            objectName: ''
        }, config).catch(() => {});
        
        res.json({ success: true, message: 'Semua antrean tugas Add WAN (dan Wi-Fi) berhasil dikirimkan ke GenieACS.' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

module.exports = router;
