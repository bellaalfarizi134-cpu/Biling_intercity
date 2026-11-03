const db = require('../config/database');
const oltService = require('./oltService');

const REFRESH_INTERVAL_MS = 90 * 1000;
const OPTICAL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const STATUS_TTL_MS = 3 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS map_olt_status_cache (
    olt_id INTEGER NOT NULL,
    olt_name TEXT NOT NULL DEFAULT '',
    serial_key TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Unknown',
    offline_reason TEXT NOT NULL DEFAULT '',
    pon_id INTEGER,
    onu_id INTEGER,
    olt_index TEXT NOT NULL DEFAULT '',
    rx TEXT NOT NULL DEFAULT '',
    tx TEXT NOT NULL DEFAULT '',
    vendor TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL,
    PRIMARY KEY (olt_id, serial_key)
  );
  CREATE INDEX IF NOT EXISTS idx_map_olt_status_serial ON map_olt_status_cache(serial_key);
  CREATE TABLE IF NOT EXISTS map_olt_status_meta (
    olt_id INTEGER PRIMARY KEY,
    olt_name TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0
  );
`);

// Optical readings persist separately from the faster OLT online/offline refresh.
const mapStatusColumns = db.prepare('PRAGMA table_info(map_olt_status_cache)').all();
if (!mapStatusColumns.some(column => column.name === 'optical_checked_at')) {
  db.exec("ALTER TABLE map_olt_status_cache ADD COLUMN optical_checked_at TEXT NOT NULL DEFAULT ''");
}
// Existing cached readings remain immediately available after deployment.
db.prepare("UPDATE map_olt_status_cache SET optical_checked_at=checked_at WHERE optical_checked_at='' AND checked_at<>'' AND (TRIM(COALESCE(rx,'')) NOT IN ('','-','N/A') OR TRIM(COALESCE(tx,'')) NOT IN ('','-','N/A'))").run();
// Do not mark empty optical values as freshly read; let the next OLT scan seed them.
db.prepare("UPDATE map_olt_status_cache SET optical_checked_at='' WHERE TRIM(COALESCE(rx,'')) IN ('','-','N/A') AND TRIM(COALESCE(tx,'')) IN ('','-','N/A')").run();

let refreshPromise = null;
let lastAttemptMs = 0;

function normalizeSerial(value) {
  let sn = String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  // HSGQ SNMP may encode the four-letter vendor prefix as 8 ASCII hex digits.
  if (/^[0-9A-F]{16,}$/.test(sn)) {
    const prefix = Buffer.from(sn.slice(0, 8), 'hex').toString('ascii').toUpperCase();
    if (/^[A-Z]{4}$/.test(prefix)) sn = prefix + sn.slice(8);
  }
  return sn;
}

function parsePonOnu(onu) {
  const raw = String(onu && (onu.olt_index || onu.id || onu.index) || '').trim();
  const m = raw.match(/(?:^|\/)(\d+)\s*[:/]\s*(\d+)$/) || raw.match(/^(\d+)\s*[:/]\s*(\d+)$/);
  if (!m) return { pon_id: null, onu_id: null, olt_index: raw };
  return { pon_id: Number(m[1]), onu_id: Number(m[2]), olt_index: raw };
}

function normalizeOfflineReason(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('dying_gasp') || lower.includes('power_off') || lower.includes('poweroff') || /power[\s_-]*down/.test(lower)) {
    return 'Daya ONT mati / adaptor dicabut (indikasi OLT: Power Down)';
  }
  if (lower.includes('los') || lower.includes('wire_down') || lower.includes('link_down')) {
    return 'Kabel fiber terindikasi LOS / sambungan terputus';
  }
  if (lower.includes('timeout') || lower.includes('unregister') || lower.includes('mpcp')) {
    return 'Koneksi terputus / registrasi ONU timeout';
  }
  if (lower.includes('deactive') || lower.includes('manual')) {
    return 'ONT dinonaktifkan dari konfigurasi OLT';
  }
  return raw;
}

function getStatusRows() {
  return db.prepare(`
    SELECT olt_id, olt_name, serial_key, serial_number, status, offline_reason,
           pon_id, onu_id, olt_index, rx, tx, optical_checked_at, vendor, checked_at
    FROM map_olt_status_cache
    ORDER BY checked_at DESC, olt_id ASC
  `).all();
}

function getPayload() {
  requestRefreshIfStale();
  const rows = getStatusRows();
  const meta = db.prepare('SELECT olt_id,olt_name,checked_at,last_attempt_at,last_error,item_count FROM map_olt_status_meta ORDER BY checked_at DESC, olt_id ASC').all();
  const checkedAt = meta.map(x => x.checked_at).filter(Boolean).sort().pop() || null;
  const online = rows.filter(x => String(x.status).toLowerCase() === 'online').length;
  const offline = rows.filter(x => String(x.status).toLowerCase() === 'offline').length;
  return {
    olt_statuses: rows,
    olt_status_checked_at: checkedAt,
    olt_status_count: rows.length,
    olt_status_online: online,
    olt_status_offline: offline,
    olt_status_refreshing: Boolean(refreshPromise),
    olt_status_error: meta.find(x => x.last_error)?.last_error || ''
  };
}

function requestRefreshIfStale(force = false) {
  if (refreshPromise) return refreshPromise;
  const now = Date.now();
  const meta = db.prepare('SELECT MAX(checked_at) AS checked_at, MAX(last_attempt_at) AS last_attempt_at FROM map_olt_status_meta').get() || {};
  const checkedMs = meta.checked_at ? Date.parse(meta.checked_at) : 0;
  const attemptMs = Math.max(lastAttemptMs, meta.last_attempt_at ? Date.parse(meta.last_attempt_at) : 0);
  if (!force && checkedMs && Number.isFinite(checkedMs) && (now - checkedMs) < REFRESH_INTERVAL_MS) return null;
  if (!force && attemptMs && Number.isFinite(attemptMs) && (now - attemptMs) < REFRESH_INTERVAL_MS) return null;

  lastAttemptMs = now;
  const attemptIso = new Date(now).toISOString();
  db.prepare(`INSERT INTO map_olt_status_meta (olt_id,olt_name,checked_at,last_attempt_at,last_error,item_count)
    SELECT id,name,'',?,'',0 FROM olts WHERE is_active=1
    ON CONFLICT(olt_id) DO UPDATE SET olt_name=excluded.olt_name,last_attempt_at=excluded.last_attempt_at,last_error=''`).run(attemptIso);

  refreshPromise = refreshAll(attemptIso).catch(error => {
    console.warn('[MAP OLT STATUS] refresh gagal:', String(error && error.message || error));
  }).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function refreshAll(attemptIso) {
  const olts = db.prepare('SELECT id,name,brand,is_active FROM olts WHERE is_active=1 ORDER BY id').all();
  for (const olt of olts) {
    try {
      const result = await oltService.getConfiguredOnusForProvision(Number(olt.id));
      if (!Array.isArray(result)) {
        db.prepare('UPDATE map_olt_status_meta SET last_error=?,last_attempt_at=? WHERE olt_id=?')
          .run('Status SN untuk vendor ' + String(olt.brand || 'tidak dikenal') + ' belum didukung sumber inventaris peta.', attemptIso, Number(olt.id));
        continue;
      }
      const previousOptics = new Map(db.prepare('SELECT serial_key,rx,tx,optical_checked_at,checked_at FROM map_olt_status_cache WHERE olt_id=?').all(Number(olt.id)).map(row => [row.serial_key, row]));
      const checkedAt = new Date().toISOString();
      const rows = result.map(onu => {
        const serial = String(onu.serialNumber || onu.serial_number || onu.sn || onu.mac || '').trim();
        const key = normalizeSerial(serial);
        if (!key || serial === '-') return null;
        const loc = parsePonOnu(onu);
        const previous = previousOptics.get(key) || null;
        const priorOpticalAt = String(previous?.optical_checked_at || previous?.checked_at || '');
        const priorOpticalMs = priorOpticalAt ? Date.parse(priorOpticalAt) : 0;
        const opticalDue = !previous || !Number.isFinite(priorOpticalMs) || !priorOpticalMs || (Date.now() - priorOpticalMs) >= OPTICAL_REFRESH_INTERVAL_MS;
        const incomingRx = String(onu.rx || onu.rxPower || '').trim();
        const incomingTx = String(onu.tx || onu.txPower || '').trim();
        const incomingOpticsAvailable = [incomingRx, incomingTx].some(value => value && !/^(?:-|N\/A|N\/A dBm|null|undefined)$/i.test(value));
        const acceptIncomingOptics = opticalDue && incomingOpticsAvailable;
        const rawReason = String(onu.offline_reason || onu.offlineReason || '').trim();
        const state = ['online','offline'].includes(String(onu.status || '').toLowerCase())
          ? (String(onu.status).toLowerCase() === 'online' ? 'Online' : 'Offline')
          : 'Unknown';
        return {
          olt_id: Number(olt.id),
          olt_name: String(olt.name || ''),
          serial_key: key,
          serial_number: serial,
          status: state,
          offline_reason: state === 'Offline' ? normalizeOfflineReason(rawReason) : '',
          pon_id: Number.isFinite(loc.pon_id) ? loc.pon_id : null,
          onu_id: Number.isFinite(loc.onu_id) ? loc.onu_id : null,
          olt_index: loc.olt_index,
          rx: acceptIncomingOptics ? incomingRx : String(previous?.rx || ''),
          tx: acceptIncomingOptics ? incomingTx : String(previous?.tx || ''),
          optical_checked_at: acceptIncomingOptics ? checkedAt : priorOpticalAt,
          vendor: String(onu.vendor || olt.brand || ''),
          checked_at: checkedAt
        };
      }).filter(Boolean);

      const save = db.transaction(() => {
        db.prepare('DELETE FROM map_olt_status_cache WHERE olt_id=?').run(Number(olt.id));
        const put = db.prepare(`INSERT INTO map_olt_status_cache
          (olt_id,olt_name,serial_key,serial_number,status,offline_reason,pon_id,onu_id,olt_index,rx,tx,optical_checked_at,vendor,checked_at)
          VALUES (@olt_id,@olt_name,@serial_key,@serial_number,@status,@offline_reason,@pon_id,@onu_id,@olt_index,@rx,@tx,@optical_checked_at,@vendor,@checked_at)`);
        for (const row of rows) put.run(row);
        db.prepare('UPDATE map_olt_status_meta SET checked_at=?,last_attempt_at=?,last_error=?,item_count=? WHERE olt_id=?')
          .run(checkedAt, attemptIso, '', rows.length, Number(olt.id));
      });
      save();
      const opticalUpdated = rows.filter(row => row.optical_checked_at === checkedAt).length;
      console.info('[MAP OLT STATUS] OLT ' + olt.name + ': menyimpan ' + rows.length + ' serial dari inventaris; redaman diperbarui ' + opticalUpdated + ' serial (interval 10 menit).');
    } catch (error) {
      db.prepare('UPDATE map_olt_status_meta SET last_error=?,last_attempt_at=? WHERE olt_id=?')
        .run(String(error && error.message || error).slice(0, 400), attemptIso, Number(olt.id));
      console.warn('[MAP OLT STATUS] OLT ' + olt.name + ' tidak terbaca:', String(error && error.message || error));
    }
  }
}

async function refreshNow() {
  if (refreshPromise) return refreshPromise;
  requestRefreshIfStale(true);
  return refreshPromise || Promise.resolve();
}

function getStatusBySerial() {
  const rows = getStatusRows();
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.serial_key)) result.set(row.serial_key, row);
  }
  return result;
}

// Keep the persistent cache warm while the map is closed. Status is refreshed every 90s;
// optical RX/TX values are only replaced when their own 10-minute TTL expires.
const mapStatusPeriodicTimer = setInterval(() => {
  try { requestRefreshIfStale(); } catch (error) {
    console.warn('[MAP OLT STATUS] refresh berkala gagal:', String(error && error.message || error));
  }
}, REFRESH_INTERVAL_MS);
if (mapStatusPeriodicTimer && typeof mapStatusPeriodicTimer.unref === 'function') mapStatusPeriodicTimer.unref();
const mapStatusStartupTimer = setTimeout(() => {
  try { requestRefreshIfStale(); } catch (error) {
    console.warn('[MAP OLT STATUS] refresh awal gagal:', String(error && error.message || error));
  }
}, 2500);
if (mapStatusStartupTimer && typeof mapStatusStartupTimer.unref === 'function') mapStatusStartupTimer.unref();

module.exports = {
  normalizeSerial,
  getPayload,
  getStatusRows,
  getStatusBySerial,
  requestRefreshIfStale,
  refreshNow,
  STATUS_TTL_MS
};
