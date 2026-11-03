'use strict';

const db = require('../config/database');
const hsgqWebOlt = require('./hsgqWebOltService');
const oltService = require('./oltService');

const TARGET_MODEL = 'HG6145D2';
const TARGET_VERSION = 'RP4592';
const ACTIVE = ['starting_upgrade', 'upgrade_uncertain', 'upgrading'];
let workerRunning = false;

db.exec(
  "CREATE TABLE IF NOT EXISTS hsgq_fiberhome_fleet_jobs (" +
  "olt_id INTEGER NOT NULL, pon_id INTEGER NOT NULL, onu_id INTEGER NOT NULL, onu_sn TEXT NOT NULL, " +
  "model TEXT NOT NULL DEFAULT 'HG6145D2', current_version TEXT NOT NULL DEFAULT '', " +
  "target_version TEXT NOT NULL DEFAULT 'RP4592', status TEXT NOT NULL DEFAULT 'queued', " +
  "last_message TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, upgrade_started_at TEXT, " +
  "verified_at TEXT, last_checked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
  "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(olt_id,pon_id,onu_id));" +
  "CREATE INDEX IF NOT EXISTS idx_hsgq_fiberhome_fleet_queue ON hsgq_fiberhome_fleet_jobs(olt_id,status,updated_at);" +
  "CREATE TABLE IF NOT EXISTS hsgq_fiberhome_fleet_scans (" +
  "olt_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unknown', last_message TEXT NOT NULL DEFAULT '', " +
  "last_scan_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"
);

function getJob(oltId, pon, onuId) {
  return db.prepare('SELECT * FROM hsgq_fiberhome_fleet_jobs WHERE olt_id=? AND pon_id=? AND onu_id=? LIMIT 1')
    .get(Number(oltId), Number(pon), Number(onuId)) || null;
}

function updateJob(oltId, pon, onuId, fields) {
  const allowed = new Set([
    'onu_sn','model','current_version','target_version','status','last_message',
    'attempts','upgrade_started_at','verified_at','last_checked_at'
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return getJob(oltId, pon, onuId);
  const sql = 'UPDATE hsgq_fiberhome_fleet_jobs SET ' +
    entries.map(([key]) => key + '=?').join(', ') +
    ', updated_at=CURRENT_TIMESTAMP WHERE olt_id=? AND pon_id=? AND onu_id=?';
  db.prepare(sql).run(...entries.map(([, value]) => value), Number(oltId), Number(pon), Number(onuId));
  return getJob(oltId, pon, onuId);
}

function getBarrier(oltId) {
  const sums = db.prepare(
    "SELECT SUM(CASE WHEN status IN ('queued','starting_upgrade','upgrade_uncertain','upgrading','offline') THEN 1 ELSE 0 END) AS pending, " +
    "SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, " +
    "SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready, " +
    "SUM(CASE WHEN status='offline' THEN 1 ELSE 0 END) AS offline " +
    "FROM hsgq_fiberhome_fleet_jobs WHERE olt_id=?"
  ).get(Number(oltId)) || {};
  const scan = db.prepare('SELECT status,last_message,last_scan_at FROM hsgq_fiberhome_fleet_scans WHERE olt_id=? LIMIT 1')
    .get(Number(oltId)) || {};
  return {
    oltId: Number(oltId),
    pending: Number(sums.pending || 0),
    failed: Number(sums.failed || 0),
    ready: Number(sums.ready || 0),
    offline: Number(sums.offline || 0),
    scanFailed: scan.status === 'failed',
    scanMessage: String(scan.last_message || ''),
    lastScanAt: scan.last_scan_at || null
  };
}

function scanFresh(oltId) {
  const scan = db.prepare('SELECT status,last_scan_at FROM hsgq_fiberhome_fleet_scans WHERE olt_id=? LIMIT 1')
    .get(Number(oltId));
  if (!scan || scan.status !== 'ok' || !scan.last_scan_at) return false;
  const stamp = Date.parse(scan.last_scan_at);
  if (!Number.isFinite(stamp) || Date.now() - stamp > 10 * 60 * 1000) return false;
  const offline = db.prepare("SELECT COUNT(*) AS n FROM hsgq_fiberhome_fleet_jobs WHERE olt_id=? AND status='offline'")
    .get(Number(oltId));
  // Recheck offline outdated ONTs periodically; they must not be flashed until online.
  return Number(offline.n || 0) === 0 || Date.now() - stamp < 90 * 1000;
}

function writeScan(oltId, status, message) {
  db.prepare(
    'INSERT INTO hsgq_fiberhome_fleet_scans(olt_id,status,last_message,last_scan_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ' +
    'ON CONFLICT(olt_id) DO UPDATE SET status=excluded.status,last_message=excluded.last_message,' +
    'last_scan_at=excluded.last_scan_at,updated_at=CURRENT_TIMESTAMP'
  ).run(Number(oltId), status, String(message || '').slice(0, 700), new Date().toISOString());
}

function onlineBySerial(inventory, serial) {
  const row = (Array.isArray(inventory) ? inventory : []).find(item =>
    hsgqWebOlt.sameSerial(item && (item.sn || item.serial), serial));
  return row ? /^online$/i.test(String(row.status || '').trim()) : false;
}

function upsertFleetRow(oltId, pon, onuId, serial, version, status, message) {
  const old = getJob(oltId, pon, onuId);
  if (old && hsgqWebOlt.sameSerial(old.onu_sn, serial)) {
    return updateJob(oltId, pon, onuId, {
      onu_sn: String(serial).toUpperCase(),
      model: TARGET_MODEL,
      current_version: String(version || ''),
      target_version: TARGET_VERSION,
      status,
      last_message: String(message || '').slice(0, 700),
      attempts: status === 'queued' && old.status !== 'queued' ? 0 : Number(old.attempts || 0),
      upgrade_started_at: status === 'queued' || status === 'offline' ? null : old.upgrade_started_at,
      verified_at: status === 'ready' ? new Date().toISOString() : null,
      last_checked_at: new Date().toISOString()
    });
  }
  db.prepare(
    'INSERT INTO hsgq_fiberhome_fleet_jobs ' +
    '(olt_id,pon_id,onu_id,onu_sn,model,current_version,target_version,status,last_message,attempts,upgrade_started_at,verified_at,last_checked_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,0,NULL,?,?) ' +
    'ON CONFLICT(olt_id,pon_id,onu_id) DO UPDATE SET onu_sn=excluded.onu_sn,model=excluded.model,' +
    'current_version=excluded.current_version,target_version=excluded.target_version,status=excluded.status,' +
    'last_message=excluded.last_message,attempts=0,upgrade_started_at=NULL,verified_at=excluded.verified_at,' +
    'last_checked_at=excluded.last_checked_at,updated_at=CURRENT_TIMESTAMP'
  ).run(Number(oltId), Number(pon), Number(onuId), String(serial).toUpperCase(), TARGET_MODEL,
    String(version || ''), TARGET_VERSION, status, String(message || '').slice(0, 700),
    status === 'ready' ? new Date().toISOString() : null, new Date().toISOString());
  return getJob(oltId, pon, onuId);
}

async function queueOutdatedOnus(oltId, options = {}) {
  const id = Number(oltId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('OLT ID tidak valid untuk pemindaian firmware FiberHome.');
  if (!options.force && scanFresh(id)) return getBarrier(id);
  writeScan(id, 'scanning', 'Memindai seluruh 8 PON untuk HG6145D2 dan versi firmware sebelum WAN.');
  try {
    const inventory = await oltService.getConfiguredOnusForProvision(id);
    if (!Array.isArray(inventory) || inventory.length === 0) {
      throw new Error('Inventaris OLT tidak tersedia; tidak ada upgrade atau WAN yang dikirim.');
    }
    let total = 0;
    let stale = 0;
    let offline = 0;
    for (let pon = 1; pon <= 8; pon++) {
      const rows = await hsgqWebOlt.readPonVersionRows(id, pon);
      for (const row of rows) {
        if (!/HG6145D2/i.test(String(row.equipmentId || ''))) continue;
        const identifier = Number(row.identifier);
        if (!Number.isInteger(identifier) || identifier < 0) continue;
        const rowPon = (identifier >> 8) & 255;
        const onuId = identifier & 255;
        if (rowPon !== pon || onuId < 0 || onuId > 127) continue;
        const serial = String(row.ontSn || '').trim().toUpperCase();
        if (!/^[A-Z0-9-]{12,16}$/.test(serial)) continue;
        total++;
        const version = String(row.mainSoftwareVersion || '').trim();
        const existing = getJob(id, pon, onuId);
        const active = existing && ACTIVE.includes(existing.status);
        const online = onlineBySerial(inventory, serial);

        // Do not change the state of a live flash job based on version alone; poll it first.
        if (active) {
          updateJob(id, pon, onuId, {
            onu_sn: serial, current_version: version,
            last_checked_at: new Date().toISOString()
          });
          continue;
        }
        if (/RP4592/i.test(version)) {
          if (existing && !hsgqWebOlt.sameSerial(existing.onu_sn, serial)) {
            upsertFleetRow(id, pon, onuId, serial, version, 'ready', 'Slot kini menampilkan SN yang benar dengan firmware RP4592.');
          } else if (existing && existing.status !== 'ready') {
            upsertFleetRow(id, pon, onuId, serial, version, 'ready', 'Firmware HG6145D2 RP4592 sudah terverifikasi pada Web OLT.');
          }
          continue;
        }
        stale++;
        if (!version || version === '--') {
          upsertFleetRow(id, pon, onuId, serial, version, 'failed',
            'Web OLT tidak melaporkan versi firmware untuk HG6145D2; flash otomatis ditahan demi keamanan.');
          continue;
        }
        if (!online) {
          offline++;
          if (!existing || existing.status !== 'failed') {
            upsertFleetRow(id, pon, onuId, serial, version, 'offline',
              'HG6145D2 belum RP4592 tetapi offline; menunggu ONT online sebelum upgrade.');
          }
          continue;
        }
        if (existing && existing.status === 'failed' && hsgqWebOlt.sameSerial(existing.onu_sn, serial)) {
          updateJob(id, pon, onuId, { current_version: version, last_checked_at: new Date().toISOString() });
          continue;
        }
        upsertFleetRow(id, pon, onuId, serial, version, 'queued',
          'HG6145D2 versi ' + version + ' belum RP4592; antrean upgrade berurutan.');
      }
    }
    writeScan(id, 'ok', 'Scan Web OLT selesai: ' + total + ' HG6145D2; ' + stale +
      ' belum RP4592; ' + offline + ' offline dan menunggu online. Tidak ada model lain yang di-flash.');
    return getBarrier(id);
  } catch (error) {
    writeScan(id, 'failed', String(error.message || error));
    throw error;
  }
}

function ageMinutes(value) {
  if (!value) return 0;
  const stamp = Date.parse(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(stamp) ? Math.max(0, (Date.now() - stamp) / 60000) : 0;
}

function matchingStatus(data, job) {
  const rows = Array.isArray(data && data.status) ? data.status : [];
  const matches = rows.filter(row =>
    Number(row && row.port_id) === Number(job.pon_id) &&
    Number(row && row.ont_id) === Number(job.onu_id) &&
    (!row.ont_sn || hsgqWebOlt.sameSerial(row.ont_sn, job.onu_sn)));
  if (matches.length > 1) throw new Error('Web OLT mengembalikan status upgrade duplikat; proses ditahan.');
  return matches[0] || null;
}

async function customerFlashIsActive(oltId) {
  const row = db.prepare(
    "SELECT customer_id FROM tech_onu_firmware_jobs WHERE olt_id=? " +
    "AND status IN ('starting_upgrade','upgrade_uncertain','upgrading') LIMIT 1"
  ).get(Number(oltId));
  return Boolean(row);
}

async function processJob(job) {
  const oltId = Number(job.olt_id), pon = Number(job.pon_id), onuId = Number(job.onu_id);
  const state = await hsgqWebOlt.readFirmwareState(oltId, pon, onuId, job.onu_sn);
  const model = String(state.equipmentId || '');
  const version = String(state.mainSoftwareVersion || '');
  updateJob(oltId, pon, onuId, {
    model, current_version: version,
    attempts: Number(job.attempts || 0) + 1,
    last_checked_at: new Date().toISOString()
  });
  job = getJob(oltId, pon, onuId);

  if (!/HG6145D2/i.test(model)) {
    return updateJob(oltId, pon, onuId, { status: 'failed', last_message: 'Model Web OLT berubah/tidak cocok; image RP4592 tidak dikirim.' });
  }
  if (/RP4592/i.test(version)) {
    if (ACTIVE.includes(job.status)) {
      const data = await hsgqWebOlt.readUpgradeStatus(oltId, pon);
      const row = matchingStatus(data, job);
      const s = String(row && row.upgrade_status || '').trim().toLowerCase();
      const global = Number(data && data.upgrade_state);
      if (['failed','failure','aborted','error'].includes(s) || (!row && [3,4].includes(global))) {
        return updateJob(oltId, pon, onuId, { status: 'failed', last_message: 'OLT melaporkan upgrade gagal/batal walau versi utama RP4592; pemeriksaan manual diperlukan.' });
      }
      if (['in process','processing','started','upgrading'].includes(s) || global === 1) {
        return updateJob(oltId, pon, onuId, { status: 'upgrading', last_message: 'RP4592 terbaca, tetapi Web OLT masih menyatakan upgrade berjalan.' });
      }
    }
    return updateJob(oltId, pon, onuId, {
      status: 'ready', current_version: version, verified_at: new Date().toISOString(),
      last_message: 'Firmware HG6145D2 RP4592 terverifikasi dan upgrade tidak lagi berjalan.',
      last_checked_at: new Date().toISOString()
    });
  }

  if (ACTIVE.includes(job.status)) {
    const data = await hsgqWebOlt.readUpgradeStatus(oltId, pon);
    const row = matchingStatus(data, job);
    const s = String(row && row.upgrade_status || '').trim().toLowerCase();
    const global = Number(data && data.upgrade_state);
    if (['failed','failure','aborted','error'].includes(s) || (!row && [3,4].includes(global))) {
      return updateJob(oltId, pon, onuId, { status: 'failed', last_message: 'Web OLT melaporkan upgrade gagal/dibatalkan; tidak ada flash ulang otomatis.' });
    }
    if (ageMinutes(job.upgrade_started_at) > 45) {
      return updateJob(oltId, pon, onuId, { status: 'failed', last_message: 'Upgrade melebihi 45 menit; flash ulang otomatis dihentikan.' });
    }
    if (['starting_upgrade','upgrade_uncertain'].includes(job.status) && !row && global !== 1 &&
        Number(job.attempts || 0) >= 12 && ageMinutes(job.upgrade_started_at) >= 10) {
      return updateJob(oltId, pon, onuId, { status: 'failed', last_message: 'Web OLT tidak mengonfirmasi upgrade; perintah flash tidak diulang.' });
    }
    return updateJob(oltId, pon, onuId, {
      status: 'upgrading',
      last_message: 'Menunggu upgrade/reboot. Tahap=' + String(row && row.upgrade_stage || '-') + '.',
      last_checked_at: new Date().toISOString()
    });
  }

  if (await customerFlashIsActive(oltId)) {
    return updateJob(oltId, pon, onuId, { last_message: 'Menunggu upgrade firmware pelanggan lain selesai pada OLT yang sama.' });
  }

  // The OLT API upload function validates the exact firmware SHA-256 and skips upload if it is already staged.
  await hsgqWebOlt.uploadTargetFirmware(oltId);
  updateJob(oltId, pon, onuId, {
    status: 'starting_upgrade',
    upgrade_started_at: new Date().toISOString(),
    attempts: Number(job.attempts || 0) + 1,
    last_message: 'Menandai perintah upgrade sebelum mengirim flash satu kali untuk SN/PON/ONU yang cocok.',
    last_checked_at: new Date().toISOString()
  });
  job = getJob(oltId, pon, onuId);

  try {
    const result = await hsgqWebOlt.startTargetUpgrade(oltId, pon, onuId, job.onu_sn, model);
    if (result.alreadyUpdated) {
      return updateJob(oltId, pon, onuId, {
        status: 'ready', current_version: 'RP4592', verified_at: new Date().toISOString(),
        last_message: 'RP4592 sudah aktif; upgrade dilewati.'
      });
    }
    return updateJob(oltId, pon, onuId, {
      status: 'upgrading',
      last_message: 'Web OLT menerima perintah upgrade untuk satu ONU; menunggu reboot dan verifikasi versi.'
    });
  } catch (error) {
    return updateJob(oltId, pon, onuId, {
      status: 'upgrade_uncertain',
      last_message: 'Hasil perintah flash belum pasti: ' + String(error.message || error).slice(0, 350) +
        '. Sistem memantau status OLT dan tidak mengirim ulang otomatis.',
      last_checked_at: new Date().toISOString()
    });
  }
}

async function processPendingJobs() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const active = db.prepare(
      "SELECT * FROM hsgq_fiberhome_fleet_jobs WHERE status IN ('starting_upgrade','upgrade_uncertain','upgrading') " +
      "ORDER BY updated_at ASC LIMIT 1"
    ).get();
    if (active) {
      try { await processJob(active); } catch (error) {
        updateJob(active.olt_id, active.pon_id, active.onu_id, {
          attempts: Number(active.attempts || 0) + 1,
          last_message: 'Polling status upgrade belum berhasil: ' + String(error.message || error).slice(0, 350),
          last_checked_at: new Date().toISOString()
        });
      }
      return;
    }

    const offline = db.prepare("SELECT olt_id FROM hsgq_fiberhome_fleet_jobs WHERE status='offline' ORDER BY updated_at ASC LIMIT 1").get();
    if (offline) {
      try { await queueOutdatedOnus(offline.olt_id, { force: true }); } catch (_) {}
      return;
    }

    const queued = db.prepare("SELECT * FROM hsgq_fiberhome_fleet_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
    if (!queued) return;
    if (await customerFlashIsActive(queued.olt_id)) return;
    try { await processJob(queued); } catch (error) {
      const detail = String(error.message || error).slice(0, 500);
      updateJob(queued.olt_id, queued.pon_id, queued.onu_id, {
        attempts: Number(queued.attempts || 0) + 1,
        last_message: 'Antrean upgrade belum berhasil: ' + detail,
        last_checked_at: new Date().toISOString()
      });
      if (/Hash firmware berbeda|File firmware HG6145D2 RP4592 tidak ditemukan|CAPTCHA aktif|Login Web OLT otomatis gagal|model ONU dari OLT bukan/i.test(detail)) {
        updateJob(queued.olt_id, queued.pon_id, queued.onu_id, { status: 'failed' });
      }
    }
  } finally {
    workerRunning = false;
  }
}

module.exports = { queueOutdatedOnus, getBarrier, processPendingJobs, getJob };
