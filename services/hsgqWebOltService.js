'use strict';

const db = require('../config/database');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');

const TARGET_MODEL = 'HG6145D2';
const TARGET_VERSION = 'RP4592';
const FIRMWARE_FILE = path.join(__dirname, '..', 'storage', 'firmware', 'fiberhome', 'HG6145D2-RP4592.bin');
const FIRMWARE_SHA256 = '85ea516c449159076d97629d9e0f2f196eae496b55895fcd22679a5702da6508';
const tokenCache = new Map();

function getOltConfig(oltId) {
  const id = Number(oltId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('OLT ID tidak valid.');
  const olt = db.prepare('SELECT id,name,host,brand,is_active,web_user,web_password FROM olts WHERE id=? LIMIT 1').get(id);
  if (!olt || Number(olt.is_active) !== 1) throw new Error('OLT Web tidak ditemukan atau tidak aktif.');
  if (String(olt.brand || '').trim().toLowerCase() !== 'hsgq') throw new Error('Upgrade firmware otomatis hanya diizinkan untuk OLT HSGQ yang sudah didukung.');
  if (!String(olt.host || '').trim() || !String(olt.web_user || '').trim() || !String(olt.web_password || '')) {
    throw new Error('Alamat atau kredensial Web OLT belum lengkap di Manajemen OLT.');
  }
  return { id: Number(olt.id), name: String(olt.name || ''), host: String(olt.host).trim(), username: String(olt.web_user).trim(), password: String(olt.web_password) };
}

function apiRoot(host, preferHttps = false) {
  const value = String(host || '').trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return (preferHttps ? 'https://' : 'http://') + value;
}

async function getSession(oltId, force = false, preferHttps = false) {
  const olt = getOltConfig(oltId);
  const baseURL = apiRoot(olt.host, preferHttps);
  const key = String(olt.id) + '|' + baseURL + '|' + olt.username;
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return { olt, client: cached.client };
  const client = axios.create({
    baseURL,
    timeout: 15000,
    maxBodyLength: 45 * 1024 * 1024,
    maxContentLength: 45 * 1024 * 1024,
    validateStatus: () => true,
    httpsAgent: preferHttps ? new https.Agent({ rejectUnauthorized: false, keepAlive: true }) : undefined,
    headers: { Accept: 'application/json' }
  });
  const customRes = await client.get('/system_custom');
  const custom = customRes.data && customRes.data.data;
  if (customRes.status !== 200 || customRes.data?.code !== 1 || !custom) {
    throw new Error('Web OLT tidak merespons pemeriksaan konfigurasi/login.');
  }
  if (Number(custom.captcha || 0) === 1) {
    throw new Error('Login Web OLT memakai CAPTCHA aktif; otomasi upgrade ditahan agar tidak melewati CAPTCHA.');
  }
  const keyHash = crypto.createHash('md5').update(olt.username + ':' + olt.password).digest('hex');
  const loginRes = await client.post('/userlogin?form=login', {
    method: 'set',
    param: { name: olt.username, key: keyHash, value: Buffer.from(olt.password, 'utf8').toString('base64'), captcha_v: '', captcha_f: '' }
  });
  const token = String(loginRes.headers?.['x-token'] || '').trim();
  if (loginRes.status !== 200 || loginRes.data?.code !== 1 || !token) {
    tokenCache.delete(key);
    throw new Error('Login Web OLT otomatis gagal (' + String(loginRes.data?.message || loginRes.status) + '). Tidak ada upgrade yang dikirim.');
  }
  client.defaults.headers.common['X-Token'] = token;
  tokenCache.set(key, { client, expiresAt: Date.now() + 4 * 60 * 1000 });
  return { olt, client };
}

function assertApiSuccess(response, operation) {
  if (response.status === 401 || response.status === 403 || response.data?.code === 0 && /token|login/i.test(String(response.data?.message || ''))) {
    throw new Error('Sesi Web OLT untuk ' + operation + ' ditolak atau habis masa berlakunya.');
  }
  if (response.status !== 200 || response.data?.code !== 1) {
    throw new Error(operation + ' gagal di Web OLT (' + String(response.data?.message || response.status) + ').');
  }
  return response.data.data;
}

function normalizeSerial(value) {
  let sn = String(value || '').trim().toUpperCase().replace(/\(\w+\)/g, '').replace(/[^A-Z0-9]/g, '');
  if (/^46485454[0-9A-F]{8}$/.test(sn)) sn = 'FHTT' + sn.slice(8);
  return sn;
}

function sameSerial(a, b) {
  const left = normalizeSerial(a), right = normalizeSerial(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // HSGQ Web sometimes displays only the vendor-prefix + last eight hex digits.
  return left.length >= 8 && right.length >= 8 && left.slice(-8) === right.slice(-8) &&
    (/^(FHTT|46485454)/.test(left) || /^(FHTT|46485454)/.test(right));
}

function findOnuRow(data, pon, onuId, serial) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.ont_info) ? data.ont_info : [];
  const matches = rows.filter(row => {
    const identifier = Number(row?.identifier);
    const rowPon = Number.isFinite(identifier) ? ((identifier >> 8) & 255) : Number(row?.port_id);
    const rowOnu = Number.isFinite(identifier) ? (identifier & 255) : Number(row?.ont_id ?? row?.onu_id);
    return rowPon === Number(pon) && rowOnu === Number(onuId) && sameSerial(row?.ont_sn || row?.sn || row?.serial, serial);
  });
  if (matches.length > 1) throw new Error('Web OLT mengembalikan lebih dari satu ONU cocok untuk SN; upgrade dibatalkan.');
  return matches[0] || null;
}

async function readFirmwareState(oltId, pon, onuId, serial) {
  const p = Number(pon), id = Number(onuId);
  // HSGQ inventory can contain an existing ONU ID 0. Allow 0 for read/verify; new bindings still allocate IDs 1–127.
  if (!Number.isInteger(p) || p < 1 || p > 8 || !Number.isInteger(id) || id < 0 || id > 127) throw new Error('Indeks PON/ONU tidak valid (PON 1–8, ONU 0–127).');
  const { olt, client } = await getSession(oltId);
  const versionRes = await client.get('/gpon_ontupgrade', { params: { form: 'ont_version', port_id: p } });
  const versionData = assertApiSuccess(versionRes, 'baca versi firmware ONU');
  const row = findOnuRow(versionData, p, id, serial);
  if (!row) throw new Error('SN yang sama belum ditemukan pada daftar versi Web OLT untuk PON ' + p + ' / ONU ' + id + '.');
  const equipmentId = String(row.equipmentid || '').trim();
  const mainSoftwareVersion = String(row.mainversion || '').trim();
  if (!equipmentId || equipmentId === '--' || !mainSoftwareVersion || mainSoftwareVersion === '--') {
    throw new Error('Web OLT menemukan baris ONU tetapi belum melaporkan model dan main firmware version secara valid. WAN tetap ditahan.');
  }
  const infoRes = await client.get('/gpon_ontupgrade', { params: { form: 'ont_upgradeinfo', port_id: p } });
  const upgradeInfo = assertApiSuccess(infoRes, 'baca profil upgrade firmware');
  const infoRow = findOnuRow(upgradeInfo?.ont_info || upgradeInfo, p, id, serial);
  return {
    oltId: olt.id, oltName: olt.name, pon: p, onuId: id, serial: String(row.ont_sn || serial),
    vendorId: String(row.vendorid || ''), equipmentId: String(row.equipmentid || ''),
    mainSoftwareVersion: String(row.mainversion || ''), standbySoftwareVersion: String(row.stbversion || ''),
    upgradeAvailable: Boolean(infoRow), upgradeInfo: infoRow || null
  };
}

async function readPonVersionRows(oltId, pon) {
  const p = Number(pon);
  if (!Number.isInteger(p) || p < 1 || p > 8) throw new Error('Port PON tidak valid.');
  const { client } = await getSession(oltId);
  const response = await client.get('/gpon_ontupgrade', { params: { form: 'ont_version', port_id: p } });
  const data = assertApiSuccess(response, 'baca daftar versi firmware ONU');
  const rows = Array.isArray(data) ? data : [];
  return rows.map(row => ({
    identifier: Number(row.identifier), ontSn: String(row.ont_sn || ''),
    equipmentId: String(row.equipmentid || ''), mainSoftwareVersion: String(row.mainversion || ''),
    standbySoftwareVersion: String(row.stbversion || ''), vendorId: String(row.vendorid || '')
  }));
}

async function readUpgradeStatus(oltId, pon) {
  const p = Number(pon);
  if (!Number.isInteger(p) || p < 1 || p > 8) throw new Error('Port PON tidak valid.');
  const { client } = await getSession(oltId);
  const response = await client.get('/gpon_ontupgrade', { params: { form: 'ont_upgrade_status', port_id: p } });
  return assertApiSuccess(response, 'baca status upgrade ONT');
}

async function readFirmwareImageInfo(oltId, preferHttps = false) {
  const { client } = await getSession(oltId, false, preferHttps);
  const response = await client.get('/gpon_ontupgrade', { params: { form: 'ont_upgradeinfo', port_id: 0 } });
  const data = assertApiSuccess(response, 'baca metadata image upgrade');
  return { fileSize: Number(data?.file_size || 0), data };
}

async function uploadTargetFirmware(oltId) {
  if (!fs.existsSync(FIRMWARE_FILE)) throw new Error('File firmware HG6145D2 RP4592 tidak ditemukan di server.');
  const fileSize = fs.statSync(FIRMWARE_FILE).size;
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(FIRMWARE_FILE)).digest('hex');
  if (actualHash !== FIRMWARE_SHA256) throw new Error('Hash firmware berbeda dari image resmi yang sudah diverifikasi; upload dibatalkan.');

  // Prefer HTTPS for the large multipart upload. Some HSGQ builds reset the
  // connection on one transport; after a reset, read metadata first so an upload
  // that actually completed is not blindly repeated. If the image is still absent,
  // retry once over HTTP. This only stages the image; ONU flash is a separate step
  // and remains blocked until the OLT reports the exact expected file size.
  const uploadVia = async (preferHttps) => {
    const { client } = await getSession(oltId, false, preferHttps);
    const form = new FormData();
    form.append('file', fs.createReadStream(FIRMWARE_FILE), {
      filename: 'RP4592_ont_atos_20250812205459.bin',
      contentType: 'application/octet-stream',
      knownLength: fileSize
    });
    const formLength = form.getLengthSync();
    const response = await client.post('/upgrade?type=ontimage', form, {
      headers: { ...form.getHeaders(), 'Content-Length': formLength, 'X-Token': client.defaults.headers.common['X-Token'] },
      maxBodyLength: 45 * 1024 * 1024,
      maxContentLength: 45 * 1024 * 1024,
      timeout: 0
    });
    return assertApiSuccess(response, 'upload image RP4592');
  };
  let uploadResult;
  try {
    uploadResult = await uploadVia(true);
  } catch (httpsError) {
    // A reset can happen after the OLT has already stored the file; verify before retry.
    let currentSize = 0;
    try { currentSize = (await readFirmwareImageInfo(oltId, false)).fileSize; } catch (_) {}
    if (currentSize !== fileSize) {
      try {
        uploadResult = await uploadVia(false);
      } catch (httpError) {
        throw new Error('Upload image RP4592 gagal lewat HTTPS (' + String(httpsError.message || httpsError).slice(0, 160) +
          ') dan HTTP (' + String(httpError.message || httpError).slice(0, 160) + '). Metadata OLT=' + currentSize +
          ' byte; perintah flash tidak dikirim.');
      }
    } else {
      uploadResult = { verifiedAfterReset: true };
    }
  }
  // No ONU flash starts until OLT reports the exact file size.
  const meta = await readFirmwareImageInfo(oltId, false);
  if (meta.fileSize !== fileSize) {
    throw new Error('Web OLT mengakui upload, tetapi ukuran image yang terbaca ' + meta.fileSize + ' byte, target ' + fileSize + ' byte. Perintah flash tidak dikirim.');
  }
  return { ...(uploadResult && typeof uploadResult === 'object' ? uploadResult : {}), fileSize: meta.fileSize };
}

async function startTargetUpgrade(oltId, pon, onuId, serial, equipmentId) {
  const state = await readFirmwareState(oltId, pon, onuId, serial);
  if (!/HG6145D2/i.test(state.equipmentId) || !/HG6145D2/i.test(String(equipmentId || state.equipmentId))) {
    throw new Error('Model ONU dari OLT bukan FiberHome HG6145D2; firmware RP4592 tidak dikirim ke perangkat ini.');
  }
  if (/RP4592/i.test(state.mainSoftwareVersion)) return { alreadyUpdated: true, state };
  const { client } = await getSession(oltId);
  const response = await client.post('/gpon_ontupgrade?form=upgrade', {
    method: 'set',
    param: { port_id: Number(pon), flag: 1, onu_ids: [Number(onuId)], rule: 1, version: '', equipment: '' }
  });
  const data = assertApiSuccess(response, 'mulai upgrade ONT');
  return { alreadyUpdated: false, state, response: data };
}

module.exports = {
  TARGET_MODEL, TARGET_VERSION, FIRMWARE_FILE, FIRMWARE_SHA256,
  readFirmwareState, readPonVersionRows, readUpgradeStatus, readFirmwareImageInfo,
  uploadTargetFirmware, startTargetUpgrade, normalizeSerial, sameSerial
};
