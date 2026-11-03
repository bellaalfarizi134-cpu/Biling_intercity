'use strict';

const db = require('../config/database');
const genieacs = require('../config/genieacs');
const oltService = require('./oltService');

const IGD_PATH = 'InternetGatewayDevice.IPPingDiagnostics';
const TR181_PATH = 'Device.IP.Diagnostics.IPPing';
const TARGET = '8.8.8.8';

db.exec(
  "CREATE TABLE IF NOT EXISTS tech_onu_ping_jobs (" +
  "customer_id INTEGER PRIMARY KEY, onu_sn TEXT NOT NULL, acs_device_id TEXT NOT NULL DEFAULT '', " +
  "acs_server_id TEXT, target_host TEXT NOT NULL DEFAULT '8.8.8.8', parameter_path TEXT NOT NULL DEFAULT '', " +
  "status TEXT NOT NULL DEFAULT 'waiting_parameters', success_count INTEGER, failure_count INTEGER, " +
  "attempts INTEGER NOT NULL DEFAULT 0, last_message TEXT NOT NULL DEFAULT '', requested_at TEXT, " +
  "last_checked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"
);

function nowIso() { return new Date().toISOString(); }
function stamp(value) {
  if (!value) return 0;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}
function ageMs(value) {
  const n = stamp(value);
  return n ? Math.max(0, Date.now() - n) : 0;
}
function valueOf(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value')
    ? value._value : value;
}
function getPath(root, path) {
  let node = root;
  for (const key of String(path || '').split('.').filter(Boolean)) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}
function upsert(customerId, data) {
  const old = db.prepare('SELECT * FROM tech_onu_ping_jobs WHERE customer_id=? LIMIT 1').get(Number(customerId));
  const serial = String(data.onu_sn || old && old.onu_sn || '').trim().toUpperCase();
  if (old && String(old.onu_sn || '').toUpperCase() !== serial) {
    db.prepare('DELETE FROM tech_onu_ping_jobs WHERE customer_id=?').run(Number(customerId));
  }
  db.prepare(
    'INSERT INTO tech_onu_ping_jobs ' +
    '(customer_id,onu_sn,acs_device_id,acs_server_id,target_host,parameter_path,status,success_count,failure_count,attempts,last_message,requested_at,last_checked_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET ' +
    'onu_sn=excluded.onu_sn,acs_device_id=excluded.acs_device_id,acs_server_id=excluded.acs_server_id,' +
    'target_host=excluded.target_host,parameter_path=excluded.parameter_path,status=excluded.status,' +
    'success_count=excluded.success_count,failure_count=excluded.failure_count,attempts=excluded.attempts,' +
    'last_message=excluded.last_message,requested_at=excluded.requested_at,last_checked_at=excluded.last_checked_at,updated_at=CURRENT_TIMESTAMP'
  ).run(Number(customerId), serial, String(data.acs_device_id || ''), data.acs_server_id || null,
    String(data.target_host || TARGET), String(data.parameter_path || ''), String(data.status || 'waiting_parameters'),
    data.success_count == null ? null : Number(data.success_count),
    data.failure_count == null ? null : Number(data.failure_count),
    Number(data.attempts || 0), String(data.last_message || '').slice(0, 800),
    data.requested_at || null, data.last_checked_at || nowIso());
  return db.prepare('SELECT * FROM tech_onu_ping_jobs WHERE customer_id=? LIMIT 1').get(Number(customerId));
}
function finish(customerId, job, status, message, counts = {}) {
  return upsert(customerId, {
    onu_sn: job.onu_sn, acs_device_id: job.acs_device_id, acs_server_id: job.acs_server_id,
    target_host: job.target_host, parameter_path: job.parameter_path, status,
    success_count: counts.success_count == null ? job.success_count : counts.success_count,
    failure_count: counts.failure_count == null ? job.failure_count : counts.failure_count,
    attempts: Number(job.attempts || 0), last_message: message,
    requested_at: job.requested_at, last_checked_at: nowIso()
  });
}

async function runOntPingDiagnostic(customerId, serial, targetHost = TARGET) {
  const customer = Number(customerId);
  const sn = String(serial || '').trim().toUpperCase();
  const host = String(targetHost || TARGET).trim();
  if (!Number.isSafeInteger(customer) || customer < 1) return { status: 'failed', message: 'ID pelanggan tidak valid untuk tes ping ONT.' };
  if (!/^[A-Z0-9-]{12,16}$/.test(sn)) return { status: 'failed', message: 'SN ONU tidak valid untuk tes ping ONT.' };
  if (host !== TARGET) return { status: 'failed', message: 'Target ping ONT otomatis dibatasi ke 8.8.8.8.' };

  let job = db.prepare('SELECT * FROM tech_onu_ping_jobs WHERE customer_id=? LIMIT 1').get(customer);
  if (job && String(job.onu_sn || '').toUpperCase() !== sn) job = null;
  // The provisioning loop can poll every 15 seconds; throttle absent-ACS lookups to one per minute.
  if (job && job.status === 'waiting_acs' && ageMs(job.last_checked_at) < 60 * 1000) {
    return { status: 'pending', message: job.last_message || 'Menunggu SN yang sama muncul di ACS sebelum tes ping.', target: host };
  }
  if (job && job.status === 'success' && ageMs(job.last_checked_at) < 15 * 60 * 1000) {
    return { status: 'success', message: job.last_message, success_count: Number(job.success_count || 0), target: host };
  }
  if (job && ['failed', 'unsupported'].includes(job.status) && ageMs(job.last_checked_at) < 15 * 60 * 1000) {
    return { status: job.status, message: job.last_message, success_count: Number(job.success_count || 0), target: host };
  }

  let acsCheck;
  try { acsCheck = await oltService.checkAcsDeviceBySerial(sn); }
  catch (error) {
    const msg = 'Belum dapat membaca ACS untuk tes ping ONT: ' + String(error.message || error).slice(0, 250);
    const saved = upsert(customer, {
      onu_sn: sn, acs_device_id: job && job.acs_device_id || '', acs_server_id: job && job.acs_server_id || null,
      target_host: host, parameter_path: job && job.parameter_path || '', status: 'waiting_acs',
      attempts: Number(job && job.attempts || 0) + 1, last_message: msg,
      requested_at: job && job.requested_at || null, last_checked_at: nowIso()
    });
    return { status: 'pending', message: saved.last_message, target: host };
  }
  if (!acsCheck || !acsCheck.found || !acsCheck.device) {
    const saved = upsert(customer, {
      onu_sn: sn, acs_device_id: '', acs_server_id: null, target_host: host,
      parameter_path: job && job.parameter_path || '', status: 'waiting_acs',
      attempts: Number(job && job.attempts || 0) + 1,
      last_message: 'SN ONU belum muncul di ACS; tes ping ONT menunggu perangkat yang sama terdaftar.',
      requested_at: job && job.requested_at || null, last_checked_at: nowIso()
    });
    return { status: 'pending', message: saved.last_message, target: host };
  }

  const device = acsCheck.device;
  const deviceId = String(acsCheck.deviceId || device._id || '');
  const serverId = device._acs_server_id || null;
  if (!deviceId) return { status: 'pending', message: 'ACS belum mengembalikan ID perangkat untuk tes ping.', target: host };

  const activeJob = job && job.status === 'requested';
  let path = String(job && job.parameter_path || '');
  if (!path) path = device.InternetGatewayDevice ? IGD_PATH : TR181_PATH;
  let diag = getPath(device, path);
  let diagState = String(valueOf(diag && diag.DiagnosticsState) || '').trim();
  if (!diag || !Object.prototype.hasOwnProperty.call(diag, 'DiagnosticsState')) {
    // Throttle refreshObject calls: the technician workflow also polls this every 15 seconds.
    if (job && job.status === 'waiting_parameters' && ageMs(job.last_checked_at) < 60 * 1000) {
      return { status: 'pending', message: job.last_message || 'Menunggu data ping diagnostics dari ACS.', target: host };
    }
    const attempts = Number(job && job.attempts || 0) + 1;
    if (attempts >= 6) {
      const message = 'ONT/ACS tidak menyediakan parameter IP ping diagnostics yang dapat dibaca setelah pemeriksaan ulang. WAN PPPoE bisa aktif, tetapi tes ping ONT otomatis tidak didukung model ini.';
      const saved = upsert(customer, {
        onu_sn: sn, acs_device_id: deviceId, acs_server_id: serverId, target_host: host,
        parameter_path: path, status: 'unsupported', attempts, last_message: message,
        requested_at: job && job.requested_at || null, last_checked_at: nowIso()
      });
      return { status: 'unsupported', message: saved.last_message, target: host };
    }
    // Probe both standard TR-069 IGD and TR-181 diagnostics, without assuming either exists.
    path = attempts <= 3 ? IGD_PATH : TR181_PATH;
    try {
      await genieacs.refreshObject(deviceId, path + '.', serverId);
    } catch (error) {
      // A refresh task might be accepted asynchronously even when the ACS adapter returns an error.
    }
    const message = 'Meminta ACS membaca parameter ping ONT untuk ' + host + ' (' + path + '); menunggu Inform berikutnya.';
    const saved = upsert(customer, {
      onu_sn: sn, acs_device_id: deviceId, acs_server_id: serverId, target_host: host,
      parameter_path: path, status: 'waiting_parameters', attempts,
      last_message: message, requested_at: job && job.requested_at || null, last_checked_at: nowIso()
    });
    return { status: 'pending', message: saved.last_message, target: host };
  }

  if (activeJob) {
    const successCount = Number(valueOf(diag.SuccessCount));
    const failureCount = Number(valueOf(diag.FailureCount));
    const stateTimestamp = stamp(diag.DiagnosticsState && diag.DiagnosticsState._timestamp);
    const requestTimestamp = stamp(job.requested_at);
    const freshResult = stateTimestamp > 0 && requestTimestamp > 0 && stateTimestamp >= requestTimestamp;
    if (/^complete$/i.test(diagState) && freshResult) {
      if (Number.isFinite(successCount) && successCount > 0) {
        const message = 'ONT berhasil ping ' + host + ' (' + successCount + ' balasan' +
          (Number.isFinite(failureCount) ? ', ' + failureCount + ' gagal' : '') + ').';
        const saved = finish(customer, job, 'success', message, { success_count: successCount, failure_count: Number.isFinite(failureCount) ? failureCount : null });
        return { status: 'success', message: saved.last_message, success_count: successCount, failure_count: saved.failure_count, target: host };
      }
      const message = 'Tes ping ONT selesai tetapi tidak mendapat balasan dari ' + host + '. Periksa WAN/VLAN, DNS/routing, dan parameter diagnostik ONT.';
      const saved = finish(customer, job, 'failed', message, { success_count: 0, failure_count: Number.isFinite(failureCount) ? failureCount : null });
      return { status: 'failed', message: saved.last_message, success_count: 0, failure_count: saved.failure_count, target: host };
    }
    if (/^error/i.test(diagState)) {
      const message = 'Tes ping ONT gagal dengan DiagnosticsState=' + diagState + '.';
      const saved = finish(customer, job, 'failed', message, { success_count: Number.isFinite(successCount) ? successCount : null, failure_count: Number.isFinite(failureCount) ? failureCount : null });
      return { status: 'failed', message: saved.last_message, target: host };
    }
    if (ageMs(job.requested_at) > 8 * 60 * 1000) {
      const message = 'ACS tidak mengembalikan hasil tes ping ONT dalam 8 menit. Tidak mengirim ping berulang otomatis; periksa ONT/ACS.';
      const saved = finish(customer, job, 'failed', message);
      return { status: 'failed', message: saved.last_message, target: host };
    }
    return { status: 'pending', message: 'Tes ping dari ONT ke ' + host + ' sedang berjalan; menunggu hasil DiagnosticsState.', target: host };
  }

  // Only start a new diagnostic when parameter support is present and the previous result is absent/expired.
  const params = {};
  params[path + '.Host'] = host;
  params[path + '.NumberOfRepetitions'] = 4;
  params[path + '.Timeout'] = 1000;
  const pending = upsert(customer, {
    onu_sn: sn, acs_device_id: deviceId, acs_server_id: serverId, target_host: host,
    parameter_path: path, status: 'requested', success_count: null, failure_count: null,
    attempts: Number(job && job.attempts || 0) + 1,
    last_message: 'Permintaan tes ping ONT ke ' + host + ' dikirim melalui ACS; menunggu hasil dari ONT.',
    requested_at: nowIso(), last_checked_at: nowIso()
  });
  try {
    await genieacs.setParameterValues(deviceId, params, serverId);
    const stateParam = {};
    stateParam[path + '.DiagnosticsState'] = 'Requested';
    await genieacs.setParameterValues(deviceId, stateParam, serverId);
    await genieacs.refreshObject(deviceId, path + '.', serverId);
  } catch (error) {
    const saved = finish(customer, pending, 'failed',
      'ACS menolak atau gagal mengantrekan tes ping ONT: ' + String(error.message || error).slice(0, 280));
    return { status: 'failed', message: saved.last_message, target: host };
  }
  return { status: 'pending', message: pending.last_message, target: host };
}

module.exports = { runOntPingDiagnostic };
