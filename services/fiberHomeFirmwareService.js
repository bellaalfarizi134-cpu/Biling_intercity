'use strict';

const db = require('../config/database');
const hsgqWebOlt = require('./hsgqWebOltService');
const fiberHomeFleetSvc = require('./fiberHomeFleetFirmwareService');

const TARGET_MODEL = 'HG6145D2';
const TARGET_VERSION = 'RP4592';
let workerRunning = false;
const runningCustomers = new Set();

db.exec(`
  CREATE TABLE IF NOT EXISTS tech_onu_firmware_jobs (
    customer_id INTEGER PRIMARY KEY,
    olt_id INTEGER NOT NULL,
    onu_sn TEXT NOT NULL,
    pon_id INTEGER NOT NULL,
    onu_id INTEGER NOT NULL,
    olt_index TEXT NOT NULL,
    onu_vendor TEXT NOT NULL DEFAULT 'FIBERHOME',
    model TEXT NOT NULL DEFAULT '',
    current_version TEXT NOT NULL DEFAULT '',
    target_version TEXT NOT NULL DEFAULT 'RP4592',
    status TEXT NOT NULL DEFAULT 'queued',
    last_message TEXT NOT NULL DEFAULT '',
    upload_attempted INTEGER NOT NULL DEFAULT 0,
    upgrade_commanded INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    upgrade_started_at TEXT,
    verified_at TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_tech_onu_firmware_jobs_queue
    ON tech_onu_firmware_jobs(status, updated_at);
  CREATE TABLE IF NOT EXISTS hsgq_olt_firmware_images (
    olt_id INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    uploaded_at TEXT,
    last_message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (olt_id, sha256)
  );
`);

function getJob(customerId) {
  return db.prepare('SELECT * FROM tech_onu_firmware_jobs WHERE customer_id=? LIMIT 1').get(Number(customerId)) || null;
}

function updateJob(customerId, fields) {
  const allowed = new Set([
    'olt_id','onu_sn','pon_id','onu_id','olt_index','onu_vendor','model','current_version',
    'target_version','status','last_message','upload_attempted','upgrade_commanded','attempts',
    'upgrade_started_at','verified_at','last_checked_at'
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return getJob(customerId);
  const sql = 'UPDATE tech_onu_firmware_jobs SET ' +
    entries.map(([key]) => key + '=?').join(', ') +
    ', updated_at=CURRENT_TIMESTAMP WHERE customer_id=?';
  db.prepare(sql).run(...entries.map(([, value]) => value), Number(customerId));
  return getJob(customerId);
}

function writeTechJob(customerId, status, message) {
  db.prepare(`UPDATE tech_onu_jobs SET status=?, last_message=?, updated_at=CURRENT_TIMESTAMP
    WHERE customer_id=?`).run(status, String(message || '').slice(0, 1000), Number(customerId));
}

function queueJob(input) {
  const customerId = Number(input.customerId);
  const oltId = Number(input.oltId);
  const pon = Number(input.pon);
  const onuId = Number(input.onuId);
  const serial = String(input.serial || '').trim().toUpperCase();
  const oltIndex = String(input.oltIndex || ('0/' + pon + ':' + onuId)).trim();
  if (!Number.isSafeInteger(customerId) || customerId < 1 ||
      !Number.isSafeInteger(oltId) || oltId < 1 ||
      !Number.isInteger(pon) || pon < 1 || pon > 8 ||
      !Number.isInteger(onuId) || onuId < 0 || onuId > 127 ||
      !/^[A-Z0-9-]{12,16}$/.test(serial) ||
      !/^\d+\/[1-8]:\d+$/.test(oltIndex)) {
    throw new Error('Data pelanggan/SN/PON/ONU tidak valid untuk antrean firmware.');
  }
  const previous = getJob(customerId);
  if (previous && previous.onu_sn === serial && Number(previous.olt_id) === oltId &&
      Number(previous.pon_id) === pon && Number(previous.onu_id) === onuId &&
      ['queued','image_uploaded','starting_upgrade','upgrade_uncertain','upgrading','ready','not_required'].includes(previous.status)) {
    return previous;
  }
  db.prepare(`INSERT INTO tech_onu_firmware_jobs
    (customer_id,olt_id,onu_sn,pon_id,onu_id,olt_index,onu_vendor,target_version,status,last_message,
     upload_attempted,upgrade_commanded,attempts,upgrade_started_at,verified_at,last_checked_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'FIBERHOME',?,'queued','Pemeriksaan firmware setelah binding dijadwalkan.',0,0,0,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(customer_id) DO UPDATE SET
      olt_id=excluded.olt_id,onu_sn=excluded.onu_sn,pon_id=excluded.pon_id,onu_id=excluded.onu_id,
      olt_index=excluded.olt_index,onu_vendor='FIBERHOME',model='',current_version='',
      target_version=excluded.target_version,status='queued',last_message=excluded.last_message,
      upload_attempted=0,upgrade_commanded=0,attempts=0,upgrade_started_at=NULL,verified_at=NULL,
      last_checked_at=NULL,updated_at=CURRENT_TIMESTAMP`)
    .run(customerId, oltId, serial, pon, onuId, oltIndex, TARGET_VERSION);
  return getJob(customerId);
}

function markTerminal(customerId, status, message, state = {}) {
  updateJob(customerId, {
    status,
    model: String(state.equipmentId || state.model || ''),
    current_version: String(state.mainSoftwareVersion || state.current_version || ''),
    last_message: message,
    verified_at: status === 'ready' || status === 'not_required' ? new Date().toISOString() : null,
    last_checked_at: new Date().toISOString()
  });
  if (status === 'failed') {
    writeTechJob(customerId, 'bound_manual', 'Upgrade firmware otomatis dihentikan: ' + message + ' WAN belum dikirim; periksa Web OLT sebelum mencoba kembali.');
  } else {
    writeTechJob(customerId, 'pending', 'WAN_PENDING: ' + message);
  }
  return getJob(customerId);
}

async function uploadImageOnce(oltId, customerId) {
  const hash = hsgqWebOlt.FIRMWARE_SHA256;
  const existing = db.prepare('SELECT * FROM hsgq_olt_firmware_images WHERE olt_id=? AND sha256=? LIMIT 1').get(Number(oltId), hash);
  if (existing && existing.status === 'uploaded') return true;
  if (existing && ['uploading','failed'].includes(existing.status)) {
    const stamp = Date.parse(String(existing.updated_at || '').replace(' ', 'T') + 'Z');
    // Avoid repeated 35 MB uploads on every cron tick after transient or validation errors.
    if (Number.isFinite(stamp) && Date.now() - stamp < 10 * 60 * 1000) return false;
  }
  db.prepare(`INSERT INTO hsgq_olt_firmware_images(olt_id,sha256,status,last_message,updated_at)
    VALUES(?,?,'uploading','Unggah image firmware RP4592 sedang berjalan.',CURRENT_TIMESTAMP)
    ON CONFLICT(olt_id,sha256) DO UPDATE SET status='uploading',
      last_message='Unggah image firmware RP4592 sedang berjalan.',updated_at=CURRENT_TIMESTAMP`)
    .run(Number(oltId), hash);
  try {
    const result = await hsgqWebOlt.uploadTargetFirmware(oltId);
    db.prepare(`UPDATE hsgq_olt_firmware_images SET status='uploaded',uploaded_at=CURRENT_TIMESTAMP,
      last_message=?,updated_at=CURRENT_TIMESTAMP WHERE olt_id=? AND sha256=?`)
      .run('Web OLT menerima image resmi HG6145D2 RP4592. ' + JSON.stringify(result || {}).slice(0, 240), Number(oltId), hash);
    return true;
  } catch (error) {
    db.prepare(`UPDATE hsgq_olt_firmware_images SET status='failed',last_message=?,updated_at=CURRENT_TIMESTAMP
      WHERE olt_id=? AND sha256=?`)
      .run(String(error.message || error).slice(0, 500), Number(oltId), hash);
    throw error;
  }
}

function matchingUpgradeStatus(data, job) {
  const rows = Array.isArray(data?.status) ? data.status : [];
  const exact = rows.filter(row =>
    Number(row?.port_id) === Number(job.pon_id) &&
    Number(row?.ont_id) === Number(job.onu_id) &&
    (!row?.ont_sn || hsgqWebOlt.sameSerial(row.ont_sn, job.onu_sn))
  );
  if (exact.length > 1) throw new Error('Status upgrade OLT memuat lebih dari satu baris yang cocok; proses ditahan.');
  return exact[0] || null;
}

function ageMinutes(value) {
  if (!value) return 0;
  const stamp = Date.parse(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(stamp) ? Math.max(0, (Date.now() - stamp) / 60000) : 0;
}

// Keep the firmware gate strict when Web OLT omits equipmentid for an ONU ID 0 row.
// We only allow a read-only model fallback when the exact live OLT row proves this
// PON/ONU/SN and RP4592, and one recent ACS record for the exact same SN independently
// confirms FiberHome HG6145D2 and the same software version. This fallback never starts
// a flash for an older/unknown version; upgrades still require the direct OLT model gate.
async function readVerifiedFirmwareState(oltId, pon, onuId, serial) {
  try {
    return await hsgqWebOlt.readFirmwareState(oltId, pon, onuId, serial);
  } catch (error) {
    const originalMessage = String(error.message || error);
    if (!/Web OLT menemukan baris ONU tetapi belum melaporkan model dan main firmware version secara valid/i.test(originalMessage)) {
      throw error;
    }

    const p = Number(pon);
    const onu = Number(onuId);
    const expectedIdentifier = (p << 8) | onu;
    const rows = await hsgqWebOlt.readPonVersionRows(oltId, p);
    const matches = rows.filter(row =>
      Number(row.identifier) === expectedIdentifier &&
      hsgqWebOlt.normalizeSerial(row.ontSn) === hsgqWebOlt.normalizeSerial(serial)
    );
    if (matches.length !== 1) throw error;

    const row = matches[0];
    const liveVersion = String(row.mainSoftwareVersion || '').trim();
    if (!liveVersion || liveVersion === '--') throw error;
    if (liveVersion.toUpperCase() !== TARGET_VERSION) {
      throw new Error('Model belum dapat diverifikasi langsung di Web OLT dan firmware utama saat ini ' +
        liveVersion + ' belum sama dengan target ' + TARGET_VERSION +
        '. WAN tetap ditahan dan proses flash otomatis tidak dijalankan.');
    }

    const serialKey = hsgqWebOlt.normalizeSerial(serial);
    const devices = db.prepare('SELECT id,serial_number,manufacturer,product_class,software_version,last_inform FROM acs_devices')
      .all()
      .filter(device => hsgqWebOlt.normalizeSerial(device.serial_number) === serialKey);
    if (devices.length !== 1) {
      throw new Error('Model Web OLT tidak terbaca; ACS harus memiliki tepat satu perangkat dengan SN yang sama untuk verifikasi silang. WAN tetap ditahan.');
    }

    const acs = devices[0];
    const informAt = Date.parse(String(acs.last_inform || ''));
    const informAge = Date.now() - informAt;
    if (!Number.isFinite(informAt) || informAge < -5 * 60 * 1000 || informAge > 24 * 60 * 60 * 1000) {
      throw new Error('Model ACS ditemukan, tetapi data inform untuk SN yang sama tidak cukup baru untuk verifikasi silang. WAN tetap ditahan.');
    }
    if (!/fiberhome/i.test(String(acs.manufacturer || '')) ||
        String(acs.product_class || '').trim().toUpperCase() !== TARGET_MODEL ||
        String(acs.software_version || '').trim().toUpperCase() !== liveVersion.toUpperCase()) {
      throw new Error('Verifikasi silang gagal: pabrikan/model/versi ACS tidak cocok dengan SN dan firmware live Web OLT. WAN tetap ditahan.');
    }

    return {
      oltId: Number(oltId),
      pon: p,
      onuId: onu,
      serial: String(row.ontSn || serial),
      vendorId: String(row.vendorId || ''),
      equipmentId: String(acs.product_class || ''),
      mainSoftwareVersion: liveVersion,
      standbySoftwareVersion: String(row.standbySoftwareVersion || ''),
      upgradeAvailable: false,
      upgradeInfo: null,
      modelSource: 'ACS exact-SN model cross-checked against live Web OLT RP4592'
    };
  }
}

async function processCustomer(customerId) {
  const id = Number(customerId);
  if (runningCustomers.has(id)) return getJob(id);
  runningCustomers.add(id);
  try {
    let job = getJob(id);
    if (!job || ['ready','not_required','failed'].includes(job.status)) return job;
    const state = await readVerifiedFirmwareState(job.olt_id, job.pon_id, job.onu_id, job.onu_sn);
    const model = String(state.equipmentId || '');
    const version = String(state.mainSoftwareVersion || '');
    updateJob(id, {
      model, current_version: version, attempts: Number(job.attempts || 0) + 1,
      last_checked_at: new Date().toISOString()
    });
    job = getJob(id);

    if (!/HG6145D2/i.test(model)) {
      return markTerminal(id, 'not_required',
        'Firmware dibaca dari Web OLT: model ' + (model || 'tidak teridentifikasi') +
        ' versi ' + (version || '-') + '. Image RP4592 tidak berlaku untuk model ini; WAN dilanjutkan tanpa flash.',
        state);
    }
    if (/RP4592/i.test(version)) {
      if (['starting_upgrade','upgrade_uncertain','upgrading'].includes(job.status)) {
        const completedStatus = await hsgqWebOlt.readUpgradeStatus(job.olt_id, job.pon_id);
        const completedRow = matchingUpgradeStatus(completedStatus, job);
        const rowState = String(completedRow?.upgrade_status || '').trim().toLowerCase();
        const stateCode = Number(completedStatus?.upgrade_state);
        if (['failure','failed','aborted','error'].includes(rowState) || (!completedRow && [3, 4].includes(stateCode))) {
          return markTerminal(id, 'failed',
            'Web OLT melaporkan upgrade gagal atau dibatalkan meskipun main version terbaca RP4592. Periksa status ONT secara manual sebelum WAN.', state);
        }
        if (['in process','processing','started','upgrading'].includes(rowState) || stateCode === 1) {
          updateJob(id, { status: 'upgrading', current_version: version,
            last_message: 'Versi RP4592 sudah terbaca, tetapi status Web OLT masih menunjukkan upgrade berjalan; menunggu status selesai sebelum WAN.',
            last_checked_at: new Date().toISOString() });
          writeTechJob(id, 'pending', 'WAN_PENDING: Firmware RP4592 sudah terbaca, tetapi Web OLT masih melaporkan upgrade berjalan. Menunggu selesai sebelum ACS/WAN.');
          return getJob(id);
        }
      }
      return markTerminal(id, 'ready',
        'Firmware FiberHome HG6145D2 RP4592 terverifikasi. ' +
        (state.modelSource ? 'Model dikonfirmasi dari ACS berdasarkan SN yang sama dan versi RP4592 dicocokkan dengan Web OLT live. ' : '') +
        'Web OLT tidak lagi melaporkan upgrade berjalan. Tahap berikutnya menunggu provisioning WAN PPPoE.',
        state);
    }

    if (['starting_upgrade','upgrade_uncertain','upgrading'].includes(job.status)) {
      const statusData = await hsgqWebOlt.readUpgradeStatus(job.olt_id, job.pon_id);
      const statusRow = matchingUpgradeStatus(statusData, job);
      const rowStatus = String(statusRow?.upgrade_status || '').trim().toLowerCase();
      const globalState = Number(statusData?.upgrade_state);
      if (['failure','failed','aborted','error'].includes(rowStatus) || (!statusRow && [3, 4].includes(globalState))) {
        const failureLabel = rowStatus || (globalState === 3 ? 'failure' : 'aborted');
        return markTerminal(id, 'failed',
          'OLT melaporkan upgrade ONT ' + failureLabel + '. Versi firmware masih ' + (version || 'tidak diketahui') + '.',
          state);
      }
      if (ageMinutes(job.upgrade_started_at) > 45) {
        return markTerminal(id, 'failed',
          'Menunggu upgrade RP4592 lebih dari 45 menit; status=' + (rowStatus || String(statusData?.upgrade_state ?? 'tidak tersedia')) +
          ', versi saat ini=' + (version || '-') + '. Tidak ada perintah upgrade ulang otomatis.',
          state);
      }
      if (['starting_upgrade','upgrade_uncertain'].includes(job.status) && !statusRow && globalState !== 1 &&
          Number(job.attempts || 0) >= 12 && ageMinutes(job.upgrade_started_at) >= 10) {
        return markTerminal(id, 'failed',
          'Web OLT belum mengonfirmasi proses upgrade setelah beberapa pemeriksaan. Tidak mengirim perintah ulang agar tidak memulai flash ganda.',
          state);
      }
      const stage = String(statusRow?.upgrade_stage || '').trim();
      const progress = statusRow?.bytes_transmitted == null ? '' : ' (' + statusRow.bytes_transmitted + ' byte terkirim)';
      updateJob(id, {
        status: 'upgrading',
        last_message: 'Upgrade firmware RP4592 sedang dipantau di Web OLT. ' + (stage ? 'Tahap: ' + stage + '.' : '') + progress,
        last_checked_at: new Date().toISOString()
      });
      writeTechJob(id, 'pending', 'WAN_PENDING: Upgrade firmware RP4592 masih berjalan atau menunggu ONT reboot. WAN/PPPoE ditahan sampai versi RP4592 terverifikasi.');
      return getJob(id);
    }

    // The HSGQ OLT has a shared upgrade-state screen; serialize upgrades per OLT.
    // Never start a second ONU flash while another customer's target upgrade is active/uncertain.
    const otherUpgrade = db.prepare(`SELECT customer_id FROM tech_onu_firmware_jobs
      WHERE olt_id=? AND customer_id<>? AND status IN ('starting_upgrade','upgrade_uncertain','upgrading')
      LIMIT 1`).get(Number(job.olt_id), id);
    if (otherUpgrade) {
      updateJob(id, { last_message: 'Menunggu upgrade firmware ONU lain di OLT yang sama selesai; tidak ada perintah flash tambahan yang dikirim.', last_checked_at: new Date().toISOString() });
      writeTechJob(id, 'pending', 'WAN_PENDING: Menunggu upgrade firmware ONU lain di OLT yang sama selesai sebelum memulai upgrade ini.');
      return getJob(id);
    }

    const uploaded = await uploadImageOnce(job.olt_id, id);
    if (!uploaded) {
      updateJob(id, { last_message: 'Menunggu proses unggah image RP4592 yang sedang berlangsung pada OLT yang sama.', last_checked_at: new Date().toISOString() });
      writeTechJob(id, 'pending', 'WAN_PENDING: Menunggu image firmware RP4592 selesai diunggah ke Web OLT.');
      return getJob(id);
    }
    updateJob(id, { status: 'image_uploaded', upload_attempted: 1, last_message: 'Image RP4592 sudah diunggah ke Web OLT; memulai upgrade hanya untuk ONU yang cocok.', last_checked_at: new Date().toISOString() });
    job = getJob(id);

    // Save a durable "command started" marker before sending the non-idempotent flash request.
    updateJob(id, {
      status: 'starting_upgrade', upgrade_commanded: 1, upgrade_started_at: new Date().toISOString(),
      last_message: 'Mengirim perintah upgrade hanya untuk HG6145D2 pada PON/ONU dan SN yang sudah cocok.',
      last_checked_at: new Date().toISOString()
    });
    writeTechJob(id, 'pending', 'WAN_PENDING: Perintah upgrade firmware RP4592 sedang dikirim; WAN ditahan sampai firmware terverifikasi.');
    try {
      const started = await hsgqWebOlt.startTargetUpgrade(job.olt_id, job.pon_id, job.onu_id, job.onu_sn, model);
      if (started.alreadyUpdated) {
        return markTerminal(id, 'ready', 'Firmware FiberHome HG6145D2 sudah RP4592; upgrade tidak diperlukan. Menunggu ACS untuk Add WAN.', started.state);
      }
      updateJob(id, { status: 'upgrading', current_version: version, last_message: 'Web OLT menerima perintah upgrade RP4592 untuk satu ONU; menunggu status dan versi terbaru.' });
      writeTechJob(id, 'pending', 'WAN_PENDING: Web OLT menerima upgrade RP4592. Menunggu proses upgrade selesai dan versi firmware terverifikasi sebelum WAN.');
    } catch (error) {
      updateJob(id, {
        status: 'upgrade_uncertain',
        last_message: 'Hasil perintah upgrade belum dapat dipastikan: ' + String(error.message || error).slice(0, 360) +
          ' Sistem akan membaca status OLT; perintah flash tidak dikirim ulang otomatis.',
        last_checked_at: new Date().toISOString()
      });
      writeTechJob(id, 'pending', 'WAN_PENDING: Hasil perintah upgrade RP4592 sedang diverifikasi melalui status Web OLT. WAN belum dikirim dan perintah flash tidak akan diulang otomatis.');
    }
    return getJob(id);
  } catch (error) {
    const job = getJob(id);
    if (!job) throw error;
    const detail = String(error.message || error).slice(0, 420);
    if (/Hash firmware berbeda|File firmware HG6145D2 RP4592 tidak ditemukan|ukuran image yang terbaca|CAPTCHA aktif|Login Web OLT otomatis gagal/i.test(detail)) {
      return markTerminal(id, 'failed', detail, { equipmentId: job.model, mainSoftwareVersion: job.current_version });
    }
    updateJob(id, {
      attempts: Number(job.attempts || 0) + 1,
      last_message: 'Pemeriksaan firmware otomatis belum berhasil: ' + detail,
      last_checked_at: new Date().toISOString()
    });
    writeTechJob(id, 'pending', 'WAN_PENDING: ' + detail +
      ' Binding dipertahankan; sistem akan mencoba membaca ulang Web OLT. WAN belum dikirim.');
    return getJob(id);
  } finally {
    runningCustomers.delete(id);
  }
}

async function queueAfterBinding(input) {
  // Queue only the ONT that was just bound and return promptly to the technician UI.
  // The background worker performs upload/upgrade so a 35 MB image transfer never
  // holds the HTTP binding request open.
  return queueJob(input);
}

async function checkWanFirmwareGate({ customerId, oltId, serial, oltIndex }) {
  const vendorSn = String(serial || '').trim().toUpperCase();
  // Only this customer's exact model/SN/ONU controls the WAN firmware gate.
  // A slow or outdated unrelated ONT on the same OLT must not block or trigger a fleet rollout.
  const match = String(oltIndex || '').match(/^\d+\/([1-8]):(\d+)$/);
  if (!Number.isSafeInteger(Number(customerId)) || !Number.isSafeInteger(Number(oltId)) || !match) {
    return { allowed: false, message: 'WAN ditahan: SN FiberHome belum memiliki indeks PON/ONU HSGQ yang valid untuk memverifikasi firmware melalui Web OLT.' };
  }
  const pon = Number(match[1]), onuId = Number(match[2]);
  let job = getJob(customerId);

  // The binding flow resolves the real PON/ONU index from live HSGQ data.
  // A previous successful firmware result must never be reused for a stale index
  // (for example, an old 0/2:0 record when the live binding resolves to 0/2:5).
  // Requeue a terminal/verified job against the exact current SN and index. If an
  // upgrade may still be running, do not move the job underneath that worker.
  const jobMatchesLiveTarget = Boolean(job &&
    Number(job.olt_id) === Number(oltId) &&
    hsgqWebOlt.sameSerial(job.onu_sn, vendorSn) &&
    Number(job.pon_id) === pon &&
    Number(job.onu_id) === onuId &&
    String(job.olt_index || '').trim() === String(oltIndex || '').trim());
  if (job && !jobMatchesLiveTarget) {
    if (['queued','image_uploaded','starting_upgrade','upgrade_uncertain','upgrading'].includes(String(job.status || ''))) {
      return {
        allowed: false, manual: true,
        message: 'WAN ditahan: antrean firmware masih menunjuk ke indeks ONU yang berbeda (' +
          String(job.olt_index || 'kosong') + '). Jangan ulangi binding/upgrade; pastikan proses firmware lama berhenti sebelum menetapkan indeks baru ' + String(oltIndex || '') + '.'
      };
    }
    try {
      queueJob({ customerId, oltId, serial: vendorSn, pon, onuId, oltIndex });
      job = getJob(customerId);
      console.warn('[FIBERHOME FW] Indeks firmware lama diperbarui sesuai binding live untuk customer ' +
        Number(customerId) + ': ' + String(oltIndex || '') + '. Pemeriksaan model/versi diulang sebelum WAN.');
    } catch (error) {
      return { allowed: false, message: 'WAN ditahan: antrean firmware belum dapat diselaraskan dengan indeks ONU live: ' + String(error.message || error).slice(0, 260) };
    }
  }

  if (!job) {
    try {
      queueJob({ customerId, oltId, serial: vendorSn, pon, onuId, oltIndex });
      job = getJob(customerId);
      await processCustomer(Number(customerId));
      job = getJob(customerId);
    } catch (error) {
      return { allowed: false, message: 'WAN ditahan karena firmware FiberHome belum dapat diverifikasi: ' + String(error.message || error).slice(0, 300) };
    }
  }
  if (['queued','image_uploaded','starting_upgrade','upgrade_uncertain','upgrading'].includes(job?.status)) {
    await processCustomer(Number(customerId));
    job = getJob(customerId);
    if (['queued','image_uploaded','starting_upgrade','upgrade_uncertain','upgrading'].includes(job?.status)) {
      return { allowed: false, message: 'WAN ditahan: ' + String(job.last_message || 'upgrade firmware RP4592 sedang diproses.') };
    }
  }
  if (job?.status === 'failed') {
    return { allowed: false, manual: true, message: 'WAN ditahan karena proses firmware gagal: ' + String(job.last_message || 'perlu pemeriksaan teknisi.') };
  }
  try {
    const live = await readVerifiedFirmwareState(oltId, pon, onuId, vendorSn);
    if (/HG6145D2/i.test(live.equipmentId)) {
      if (!/RP4592/i.test(live.mainSoftwareVersion)) {
        if (job?.status === 'ready') {
          updateJob(customerId, { status: 'queued', current_version: live.mainSoftwareVersion, upgrade_commanded: 0, upgrade_started_at: null, attempts: 0, last_message: 'Versi firmware berubah atau belum RP4592; upgrade dijadwalkan ulang setelah pemeriksaan ulang.' });
          await processCustomer(Number(customerId));
        }
        return { allowed: false, message: 'WAN ditahan: FiberHome HG6145D2 saat ini melaporkan versi ' + (live.mainSoftwareVersion || 'tidak diketahui') + '; target RP4592 belum terverifikasi.' };
      }
      if (job?.status !== 'ready') {
        markTerminal(customerId, 'ready', 'Firmware FiberHome HG6145D2 RP4592 terverifikasi ulang langsung dari Web OLT.', live);
      }
      return { allowed: true, message: 'Firmware HG6145D2 RP4592 terverifikasi.' };
    }
    if (!job || job.status !== 'not_required') {
      markTerminal(customerId, 'not_required',
        'Model FiberHome ' + (live.equipmentId || 'tidak diketahui') + ' bukan HG6145D2. Image RP4592 khusus HG6145D2 tidak diterapkan; lanjut via ACS.',
        live);
    }
    return { allowed: true, message: 'Firmware model FiberHome ini tidak menggunakan image RP4592 HG6145D2.' };
  } catch (error) {
    return { allowed: false, message: 'WAN ditahan: gagal membaca model/versi FiberHome dari Web OLT: ' + String(error.message || error).slice(0, 300) };
  }
}

async function processPendingJobs() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    // Process only per-customer firmware jobs. The fleet-wide scanner is deliberately
    // not invoked from the Binding Saja worker.
    const jobs = db.prepare(`SELECT customer_id FROM tech_onu_firmware_jobs
      WHERE status IN ('queued','image_uploaded','starting_upgrade','upgrade_uncertain','upgrading')
        AND updated_at <= datetime('now','-35 seconds')
      ORDER BY updated_at ASC LIMIT 10`).all();
    for (const row of jobs) {
      try {
        await processCustomer(row.customer_id);
      } catch (error) {
        writeTechJob(row.customer_id, 'pending', 'WAN_PENDING: Pemeriksaan firmware belum berhasil: ' + String(error.message || error).slice(0, 300));
      }
    }
  } finally {
    workerRunning = false;
  }
}

module.exports = {
  TARGET_MODEL, TARGET_VERSION, queueAfterBinding, queueJob, processCustomer,
  processPendingJobs, checkWanFirmwareGate, getJob
};
