'use strict';

const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const oltService = require('./oltService');
const genieacs = require('../config/genieacs');
const fiberHomeFirmwareSvc = require('./fiberHomeFirmwareService');
const ontPingDiagnosticsSvc = require('./ontPingDiagnosticsService');
const { logger } = require('../config/logger');

// Migrate the existing technician job table in place; keep all saved task history.
try {
  const columns = new Set(db.prepare('PRAGMA table_info(tech_onu_jobs)').all().map(column => column.name));
  if (columns.size && !columns.has('onu_vendor')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN onu_vendor TEXT NOT NULL DEFAULT ''");
  if (columns.size && !columns.has('olt_index')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN olt_index TEXT NOT NULL DEFAULT ''");
  if (columns.size && !columns.has('reboot_method')) db.exec("ALTER TABLE tech_onu_jobs ADD COLUMN reboot_method TEXT NOT NULL DEFAULT 'acs'");
} catch (error) {
  logger.warn(`[ONU-WAN] Vendor routing migration not complete: ${error.message}`);
}

db.exec(`CREATE TABLE IF NOT EXISTS tech_onu_wan_postcheck (
  customer_id INTEGER PRIMARY KEY,
  onu_sn TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting_session',
  last_message TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
try {
  const postcheckColumns = new Set(db.prepare('PRAGMA table_info(tech_onu_wan_postcheck)').all().map(column => column.name));
  if (postcheckColumns.size && !postcheckColumns.has('reboot_status')) {
    db.exec("ALTER TABLE tech_onu_wan_postcheck ADD COLUMN reboot_status TEXT NOT NULL DEFAULT 'not_sent'");
  }
  if (postcheckColumns.size && !postcheckColumns.has('reboot_requested_at')) {
    db.exec('ALTER TABLE tech_onu_wan_postcheck ADD COLUMN reboot_requested_at TEXT');
  }
  if (postcheckColumns.size && !postcheckColumns.has('session_down_seen')) {
    db.exec('ALTER TABLE tech_onu_wan_postcheck ADD COLUMN session_down_seen INTEGER NOT NULL DEFAULT 0');
  }
  if (postcheckColumns.size && !postcheckColumns.has('reboot_message')) {
    db.exec("ALTER TABLE tech_onu_wan_postcheck ADD COLUMN reboot_message TEXT NOT NULL DEFAULT ''");
  }
  if (postcheckColumns.size && !postcheckColumns.has('reboot_method')) {
    db.exec("ALTER TABLE tech_onu_wan_postcheck ADD COLUMN reboot_method TEXT NOT NULL DEFAULT 'acs'");
  }
} catch (error) {
  logger.warn(`[ONU-WAN] Migrasi tahapan reboot belum selesai: ${error.message}`);
}
try {
  const pingColumns = new Set(db.prepare('PRAGMA table_info(tech_onu_ping_jobs)').all().map(column => column.name));
  if (pingColumns.size && !pingColumns.has('reboot_status')) {
    db.exec("ALTER TABLE tech_onu_ping_jobs ADD COLUMN reboot_status TEXT NOT NULL DEFAULT 'not_sent'");
  }
  if (pingColumns.size && !pingColumns.has('reboot_message')) {
    db.exec("ALTER TABLE tech_onu_ping_jobs ADD COLUMN reboot_message TEXT NOT NULL DEFAULT ''");
  }
} catch (error) {
  logger.warn(`[ONU-WAN] Reboot status migration not complete: ${error.message}`);
}

function normalizeOnuVendor(value, serial = '') {
  const supplied = String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[_-]+/g, '');
  if (supplied.includes('FIBERHOME') || supplied === 'FHTT' || supplied === 'FH') return 'FIBERHOME';
  if (supplied === 'ZTE' || supplied.startsWith('ZTEG')) return 'ZTE';
  if (supplied === 'HUAWEI' || supplied === 'HWTC') return 'HUAWEI';
  if (supplied === 'NOKIA' || supplied === 'ALCL') return 'NOKIA';
  if (['CMHI', 'ZXIC', 'ZIONCOM', 'ZION', 'RTEG', 'ZICG', 'CMDC'].includes(supplied)) return supplied;
  if (supplied && supplied !== 'OTHER') return supplied;
  const sn = String(serial || '').trim().toUpperCase();
  if (/^(?:FHTT|46485454)/.test(sn)) return 'FIBERHOME';
  if (/^(?:ZTEG|5A544547)/.test(sn)) return 'ZTE';
  if (/^(?:HWTC|48575443)/.test(sn)) return 'HUAWEI';
  if (/^(?:ALCL|414C434C)/.test(sn)) return 'NOKIA';
  return supplied || 'OTHER';
}

// Vendor policy: FiberHome uses TR-069/ACS; ZTE/Huawei and explicitly enabled CMHI ONUs
// on HSGQ use the same validated per-PON ONT WAN command. Do not confuse ONU vendor with OLT brand.
function getWanProvisioningPlan({ customerId, onuVendor, serial = '', oltIndex = '', allowMissingIndex = false }) {
  const vendor = normalizeOnuVendor(onuVendor, serial);
  if (vendor === 'FIBERHOME') {
    return { vendor, method: 'tr069', supported: true, label: 'FiberHome → TR-069/ACS' };
  }

  const customer = db.prepare('SELECT id, olt_id FROM customers WHERE id = ? LIMIT 1').get(Number(customerId));
  if (!customer) throw new Error('Data pelanggan untuk pemilihan jalur WAN tidak ditemukan.');
  const olt = customer.olt_id ? oltService.getOltById(customer.olt_id) : null;
  if (!olt) {
    return {
      vendor, method: 'olt', supported: false, code: 'WAN_OLT_UNSUPPORTED', label: 'OLT direct IP config',
      message: `[WAN_OLT_UNSUPPORTED] ONU vendor ${vendor} harus dikonfigurasi melalui OLT, tetapi OLT belum dipilih. Tidak ada konfigurasi WAN atau secret PPPoE yang dibuat.`
    };
  }

  const brand = String(olt.brand || '').trim().toLowerCase();
  const job = db.prepare('SELECT olt_index FROM tech_onu_jobs WHERE customer_id = ? LIMIT 1').get(Number(customerId));
  const index = String(oltIndex || job?.olt_index || '').trim();

  if (brand === 'hsgq') {
    if (!['ZTE', 'HUAWEI', 'CMHI'].includes(vendor)) {
      return {
        vendor, method: 'olt', supported: false, code: 'WAN_OLT_VENDOR_UNSUPPORTED', label: 'HSGQ IP Config', oltBrand: brand,
        message: `[WAN_OLT_UNSUPPORTED] Jalur Add WAN HSGQ dari Binding hanya diizinkan untuk ONU vendor ZTE/Huawei/CMHI. Vendor ${vendor} tetap tidak diubah; WAN/secret PPPoE belum dibuat.`
      };
    }
    // HSGQ inventory IDs use the format 0/PON:ONU-ID (for example 0/4:11),
    // not the 3-level ZTE/Huawei slot format. During Binding Saja preflight the
    // ONU ID is not known until the SN has been matched and bound.
    const match = index.match(/^\d+\/([1-8]):(\d+)$/);
    if (!match) {
      if (allowMissingIndex) {
        return { vendor, method: 'olt', supported: true, label: 'HSGQ Add WAN / IP Config', oltBrand: brand, oltId: Number(olt.id), oltIndex: '', needsResolvedIndex: true };
      }
      return {
        vendor, method: 'olt', supported: false, code: 'WAN_OLT_INDEX_REQUIRED', label: 'HSGQ Add WAN / IP Config', oltBrand: brand,
        message: `[WAN_OLT_INDEX_REQUIRED] Indeks HSGQ belum valid untuk ONU ${vendor}. Diperlukan format 0/PON:ONU-ID (contoh 0/4:11); tidak ada perintah WAN yang dikirim.`
      };
    }
    const pon = Number(match[1]);
    const onuId = Number(match[2]);
    if (!Number.isInteger(onuId) || onuId < 1 || onuId > 127) {
      return {
        vendor, method: 'olt', supported: false, code: 'WAN_OLT_INDEX_REQUIRED', label: 'HSGQ Add WAN / IP Config', oltBrand: brand,
        message: '[WAN_OLT_INDEX_REQUIRED] ONU ID HSGQ di luar rentang 0–127. WAN belum dikirim.'
      };
    }
    return { vendor, method: 'olt', supported: true, label: 'HSGQ Add WAN / IP Config', oltBrand: brand, oltId: Number(olt.id), oltIndex: index, oltPon: pon, oltOnuId: onuId };
  }

  // The existing non-HSGQ direct driver is specific to ZTE OLTs.
  if (brand !== 'zte') {
    return {
      vendor, method: 'olt', supported: false, code: 'WAN_OLT_UNSUPPORTED', label: 'OLT direct IP config', oltBrand: brand,
      message: `[WAN_OLT_UNSUPPORTED] ONU vendor ${vendor} dipilih untuk jalur OLT/IP Config, tetapi OLT ${olt.name || olt.id} ber-brand ${brand || '(kosong)'} belum memiliki driver WAN langsung yang tervalidasi di Billing. Jalur PPPoE belum dikirim dan secret/router tidak diubah.`
    };
  }
  const indexWithoutPrefix = index.replace(/^gpon-onu_/i, '');
  const indexParts = indexWithoutPrefix.split(':');
  const pathParts = indexParts.length === 2 ? indexParts[0].split('/') : [];
  const validIndex = indexParts.length === 2 && /^\d+$/.test(indexParts[1]) &&
    pathParts.length === 3 && pathParts.every(part => /^\d+$/.test(part));
  if (!validIndex) {
    if (allowMissingIndex) {
      return { vendor, method: 'olt', supported: true, label: 'OLT direct IP config', oltBrand: brand, oltId: Number(olt.id), oltIndex: '', needsResolvedIndex: true };
    }
    return {
      vendor, method: 'olt', supported: false, code: 'WAN_OLT_INDEX_REQUIRED', label: 'OLT direct IP config', oltBrand: brand,
      message: `[WAN_OLT_INDEX_REQUIRED] OLT ${olt.name || olt.id} mendukung jalur WAN langsung, tetapi indeks fisik PON/ONU belum tersimpan (contoh: 1/1/2:5). WAN belum dikirim agar tidak mengenai ONU yang salah.`
    };
  }
  return { vendor, method: 'olt', supported: true, label: 'OLT direct IP config', oltBrand: brand, oltId: Number(olt.id), oltIndex: index };
}

async function readRouterPppoeState(routerId) {
  const conn = await mikrotikService.getConnection(routerId);
  try {
    // Bypass the dashboard's short-lived/stale caches: provisioning must use live RouterOS data.
    const secretRows = await conn.api.send([
      '/ppp/secret/print',
      '=.proplist=.id,name,password,profile,disabled,service'
    ]);
    const activeRows = await conn.api.send([
      '/ppp/active/print',
      '=.proplist=.id,name,address,uptime,service,caller-id'
    ]);
    const profileRows = await conn.api.send([
      '/ppp/profile/print',
      '=.proplist=.id,name,rate-limit'
    ]);
    return {
      secrets: Array.isArray(secretRows) ? secretRows : [],
      active: Array.isArray(activeRows) ? activeRows : [],
      profiles: Array.isArray(profileRows) ? profileRows : []
    };
  } finally {
    if (conn && conn.api) {
      try { await conn.api.close(); } catch (_) {}
    }
  }
}

function truthyRouterFlag(value) {
  return value === true || value === 1 || /^(true|yes|1)$/i.test(String(value || ''));
}

function rateToKbps(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)([kmg]?)$/i);
  if (!match) return null;
  const factor = ({ '': 1, k: 1, m: 1000, g: 1000000 })[match[2].toLowerCase()];
  return Number(match[1]) * factor;
}

function profileMatchesPackageSpeed(profile, customer) {
  const limit = String(profile?.['rate-limit'] || profile?.rateLimit || '').trim();
  const parts = limit.split('/');
  const down = Number(customer.speed_down || 0);
  const up = Number(customer.speed_up || 0);
  if (!limit || limit === '-' || parts.length < 2 || down <= 0 || up <= 0) return false;
  const first = rateToKbps(parts[0].split(/\s+/)[0]);
  const second = rateToKbps(parts[1].split(/\s+/)[0]);
  // Billing speed values are stored in Kbps. MikroTik rate-limit's two directions
  // are compared to the configured download/upload speeds before any profile is reused.
  return first === down && second === up;
}

async function ensurePppoeSecret(customer) {
  const username = String(customer.pppoe_username || '').trim();
  const billingPassword = String(customer.pppoe_password || '');
  const routerId = Number(customer.router_id);
  if (String(customer.connection_type || 'pppoe').toLowerCase() !== 'pppoe') {
    throw new Error('Jenis koneksi pelanggan bukan PPPoE; WAN otomatis tidak dijalankan.');
  }
  if (!username) throw new Error('Username PPPoE pelanggan belum diisi.');
  if (!Number.isSafeInteger(routerId) || routerId < 1) throw new Error('Router MikroTik belum dipilih pada data pelanggan.');
  const router = mikrotikService.getAllRouters().find(r => Number(r.id) === routerId);
  if (!router || !(router.is_active === 1 || router.is_active === '1' || router.is_active === true)) {
    throw new Error(`Router MikroTik ID ${routerId} tidak ditemukan atau sedang nonaktif.`);
  }

  let state = await readRouterPppoeState(routerId);
  const profileNames = state.profiles.map(p => String(p.name || '').trim()).filter(Boolean);
  const packageName = String(customer.package_name || '').trim();
  const existing = state.secrets.find(s => String(s.name || '').trim().toLowerCase() === username.toLowerCase());
  // For a legacy customer, RouterOS is the authoritative source for an existing secret's
  // PPPoE password. Never print or persist that credential; use it only for ACS provisioning.
  const password = existing && String(existing.password || '') ? String(existing.password) : billingPassword;
  if (!password) throw new Error('Password PPPoE tidak tersedia di Billing maupun secret MikroTik; lengkapi kredensial sebelum provisioning.');

  let desiredProfile = '';
  if (packageName) {
    const exact = state.profiles.find(p => String(p.name || '').trim().toLowerCase() === packageName.toLowerCase());
    if (!exact) {
      throw new Error(`Paket billing "${packageName}" belum memiliki profile bernama sama pada MikroTik ${router.name}. Secret tidak dibuat dengan profile default agar kecepatan pelanggan tidak salah.`);
    }
    desiredProfile = String(exact.name).trim();
    if (!profileMatchesPackageSpeed(exact, customer)) {
      throw new Error(`Rate-limit profile "${desiredProfile}" tidak cocok dengan kecepatan paket Billing (${customer.speed_down || 0} Kbps download / ${customer.speed_up || 0} Kbps upload). Koreksi profil atau kecepatan paket sebelum provisioning.`);
    }
  } else if (existing && String(existing.profile || '').trim()) {
    const actual = String(existing.profile).trim();
    if (!profileNames.some(p => p.toLowerCase() === actual.toLowerCase())) {
      throw new Error(`Pelanggan belum memilih paket dan profile lama "${actual}" tidak ditemukan pada MikroTik ${router.name}.`);
    }
    desiredProfile = actual;
  } else {
    throw new Error(`Paket billing pelanggan belum dipilih. Pilih paket sebelum membuat secret PPPoE baru pada MikroTik ${router.name}.`);
  }

  let created = false;
  if (existing) {
    if (truthyRouterFlag(existing.disabled)) {
      throw new Error(`Secret PPPoE ${username} sudah ada tetapi disabled pada MikroTik ${router.name}; tidak diaktifkan otomatis agar aturan isolir tidak terlewati.`);
    }
    const service = String(existing.service || 'pppoe').trim().toLowerCase();
    if (service !== 'pppoe' && service !== 'any') {
      throw new Error(`Secret ${username} ada pada MikroTik tetapi servicenya ${service}, bukan PPPoE.`);
    }
    const actualProfile = String(existing.profile || '').trim();
    if (actualProfile.toLowerCase() !== desiredProfile.toLowerCase()) {
      const actualProfileRow = state.profiles.find(p => String(p.name || '').trim().toLowerCase() === actualProfile.toLowerCase());
      if (!packageName || !profileMatchesPackageSpeed(actualProfileRow, customer)) {
        throw new Error(`Profile secret ${username} di MikroTik adalah "${actualProfile || '(kosong)'}", sedangkan paket Billing memerlukan "${desiredProfile}" dengan rate-limit yang sesuai. Secret tidak diubah otomatis.`);
      }
      desiredProfile = actualProfile;
    }
  } else {
    const secret = {
      name: username,
      password,
      service: 'pppoe',
      profile: desiredProfile,
      comment: `Auto-provisioned: ${String(customer.name || customer.id || '').slice(0, 80)}`
    };
    if (String(customer.pppoe_remote_address || '').trim()) secret['remote-address'] = String(customer.pppoe_remote_address).trim();
    await mikrotikService.addPppoeSecret(secret, routerId);
    created = true;
    logger.info(`[ONU-WAN] PPPoE secret dibuat untuk customer ID ${customer.id} pada router ID ${routerId}.`);
    // Read again from RouterOS; a successful API call alone is not treated as proof of creation.
    state = await readRouterPppoeState(routerId);
    const verified = state.secrets.find(s => String(s.name || '').trim().toLowerCase() === username.toLowerCase());
    if (!verified) throw new Error(`MikroTik menerima perintah, tetapi secret ${username} belum terverifikasi saat dibaca ulang.`);
    if (truthyRouterFlag(verified.disabled) || String(verified.profile || '').trim().toLowerCase() !== desiredProfile.toLowerCase()) {
      throw new Error(`Secret ${username} ditemukan setelah dibuat, tetapi status/profile tidak cocok dengan paket billing.`);
    }
  }
  return { created, routerId, routerName: router.name, profile: desiredProfile, password, message: created
    ? `Secret PPPoE terverifikasi pada MikroTik ${router.name}, profil ${desiredProfile}.`
    : `Secret PPPoE yang sudah ada terverifikasi pada MikroTik ${router.name}, profil ${desiredProfile}${!billingPassword ? ' (password dipakai langsung dari secret MikroTik karena kolom Billing kosong)' : (String(existing?.password || '') && billingPassword !== String(existing.password) ? ' (password Billing berbeda; WAN memakai password secret MikroTik agar koneksi tetap cocok)' : '')}.` };
}

// Read-only preflight: validate the customer's PPPoE/router/profile before changing ONT binding or WAN.
async function preflightCustomerWan(customerId) {
  const customer = db.prepare("SELECT c.id,c.name,c.router_id,c.package_id,c.connection_type,c.pppoe_username,c.pppoe_password,c.pppoe_remote_address,p.name AS package_name,p.speed_down,p.speed_up FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.id=? LIMIT 1").get(Number(customerId));
  if (!customer) throw new Error('Data pelanggan untuk preflight WAN tidak ditemukan.');
  const username = String(customer.pppoe_username || '').trim();
  const billingPassword = String(customer.pppoe_password || '');
  const routerId = Number(customer.router_id);
  if (String(customer.connection_type || 'pppoe').toLowerCase() !== 'pppoe') throw new Error('Jenis koneksi pelanggan bukan PPPoE; binding otomatis ditahan.');
  if (!username) throw new Error('Username PPPoE pelanggan belum diisi.');
  if (!Number.isSafeInteger(routerId) || routerId < 1) throw new Error('Router MikroTik belum dipilih pada data pelanggan.');
  const router = mikrotikService.getAllRouters().find(r => Number(r.id) === routerId);
  if (!router || !(router.is_active === 1 || router.is_active === '1' || router.is_active === true)) {
    throw new Error('Router MikroTik pelanggan tidak ditemukan atau nonaktif.');
  }

  const state = await readRouterPppoeState(routerId);
  const existing = state.secrets.find(s => String(s.name || '').trim().toLowerCase() === username.toLowerCase());
  const password = existing && String(existing.password || '') ? String(existing.password) : billingPassword;
  if (!password) throw new Error('Password PPPoE tidak tersedia di Billing maupun secret MikroTik.');
  const packageName = String(customer.package_name || '').trim();
  const profileNames = state.profiles.map(p => String(p.name || '').trim()).filter(Boolean);
  let desiredProfile = '';
  if (packageName) {
    const exact = state.profiles.find(p => String(p.name || '').trim().toLowerCase() === packageName.toLowerCase());
    if (!exact) throw new Error('Paket billing "' + packageName + '" belum memiliki profile bernama sama di MikroTik ' + router.name + '.');
    desiredProfile = String(exact.name).trim();
    if (!profileMatchesPackageSpeed(exact, customer)) {
      throw new Error('Rate-limit profile "' + desiredProfile + '" tidak cocok dengan kecepatan paket Billing.');
    }
  } else if (existing && String(existing.profile || '').trim()) {
    desiredProfile = String(existing.profile).trim();
    if (!profileNames.some(p => p.toLowerCase() === desiredProfile.toLowerCase())) {
      throw new Error('Profile secret PPPoE yang lama tidak ditemukan pada MikroTik.');
    }
  } else {
    throw new Error('Paket billing pelanggan belum dipilih dan tidak ada profile secret PPPoE yang dapat dipakai.');
  }

  if (existing) {
    if (truthyRouterFlag(existing.disabled)) throw new Error('Secret PPPoE pelanggan disabled pada MikroTik; binding otomatis ditahan agar aturan isolir tidak terlewati.');
    const service = String(existing.service || 'pppoe').trim().toLowerCase();
    if (service !== 'pppoe' && service !== 'any') throw new Error('Secret pelanggan di MikroTik bukan layanan PPPoE.');
    const actualProfile = String(existing.profile || '').trim();
    if (actualProfile.toLowerCase() !== desiredProfile.toLowerCase()) {
      const actualProfileRow = state.profiles.find(p => String(p.name || '').trim().toLowerCase() === actualProfile.toLowerCase());
      if (!packageName || !profileMatchesPackageSpeed(actualProfileRow, customer)) {
        throw new Error('Profile secret PPPoE tidak cocok dengan profil/rate-limit paket Billing; koreksi sebelum binding.');
      }
    }
  }
  return { ok: true, customerId: Number(customer.id), routerId, routerName: router.name, packageName: packageName || desiredProfile };
}

async function diagnoseCustomerWan(customerId) {
  const customer = db.prepare(`
    SELECT c.id, c.name, c.router_id, c.package_id, c.connection_type,
           c.pppoe_username, c.pppoe_password, p.name AS package_name, p.speed_down, p.speed_up
    FROM customers c LEFT JOIN packages p ON p.id = c.package_id
    WHERE c.id = ? LIMIT 1
  `).get(Number(customerId));
  if (!customer) throw new Error('Data pelanggan tidak ditemukan.');
  const routerId = Number(customer.router_id);
  const router = mikrotikService.getAllRouters().find(r => Number(r.id) === routerId);
  const result = {
    billing: {
      customerFound: true,
      package: customer.package_name || null,
      pppoeUsernamePresent: Boolean(String(customer.pppoe_username || '').trim()),
      pppoePasswordPresent: Boolean(String(customer.pppoe_password || '')),
      routerAssigned: Boolean(Number.isSafeInteger(routerId) && routerId > 0),
      connectionType: String(customer.connection_type || 'pppoe')
    },
    mikrotik: { connected: false, secretExists: false, activeSession: false, profileMatchesPackage: null, message: '' }
  };
  if (!router || !(router.is_active === 1 || router.is_active === '1' || router.is_active === true)) {
    result.mikrotik.message = 'Router MikroTik pelanggan belum dipilih, tidak ditemukan, atau nonaktif.';
    return result;
  }
  try {
    const state = await readRouterPppoeState(routerId);
    result.mikrotik.connected = true;
    result.mikrotik.routerName = router.name;
    const username = String(customer.pppoe_username || '').trim().toLowerCase();
    const secret = state.secrets.find(s => String(s.name || '').trim().toLowerCase() === username);
    const session = state.active.find(s => String(s.name || '').trim().toLowerCase() === username);
    result.mikrotik.secretExists = Boolean(secret);
    result.mikrotik.secretEnabled = secret ? !truthyRouterFlag(secret.disabled) : false;
    result.mikrotik.secretProfile = secret ? String(secret.profile || '') : null;
    result.mikrotik.activeSession = Boolean(session);
    result.mikrotik.activeIp = session ? (session.address || null) : null;
    result.mikrotik.activeUptime = session ? (session.uptime || null) : null;
    if (customer.package_name) {
      const profile = state.profiles.find(p => String(p.name || '').trim().toLowerCase() === String(customer.package_name).trim().toLowerCase());
      const actualProfile = secret ? state.profiles.find(p => String(p.name || '').trim().toLowerCase() === String(secret.profile || '').trim().toLowerCase()) : null;
      result.mikrotik.profileExists = Boolean(profile);
      result.mikrotik.profileRateLimit = actualProfile ? String(actualProfile['rate-limit'] || actualProfile.rateLimit || '') : null;
      result.mikrotik.profileMatchesPackage = Boolean(secret && profile && actualProfile && (String(secret.profile || '').trim().toLowerCase() === String(profile.name).trim().toLowerCase() || profileMatchesPackageSpeed(actualProfile, customer)));
    } else {
      result.mikrotik.profileExists = secret ? state.profiles.some(p => String(p.name || '').trim().toLowerCase() === String(secret.profile || '').trim().toLowerCase()) : false;
      result.mikrotik.profileMatchesPackage = null;
    }
    result.mikrotik.message = session
      ? `Sesi PPPoE aktif di ${router.name}.`
      : secret ? `Secret terbaca di ${router.name}, tetapi sesi PPPoE belum aktif.` : `Secret PPPoE belum ditemukan di ${router.name}.`;
  } catch (e) {
    result.mikrotik.message = `Pemeriksaan langsung MikroTik gagal: ${String(e.message || e).slice(0, 220)}`;
  }
  return result;
}


async function pingRouterInternet(routerId) {
  const conn = await mikrotikService.getConnection(routerId);
  try {
    const rows = await conn.api.send(['/ping', '=address=1.1.1.1', '=count=3', '=interval=500ms']);
    const replies = Array.isArray(rows) ? rows : [];
    const done = replies.find(row => row && (row.received != null || row['packet-loss'] != null || row['packet-loss-percent'] != null));
    if (done) {
      const received = Number(done.received || 0);
      const lossText = String(done['packet-loss'] ?? done['packet-loss-percent'] ?? '');
      if (received > 0 || (lossText && !/^100(?:\.0+)?%?$/.test(lossText))) return { ok: true, message: `Ping internet berhasil (${received || 'ada'} balasan).` };
    }
    const replyRows = replies.filter(row => row && row.time && !/timeout|unreachable/i.test(String(row.status || '')));
    if (replyRows.length) return { ok: true, message: `Ping internet berhasil (${replyRows.length} balasan).` };
    return { ok: false, message: 'Ping ke 1.1.1.1 dari MikroTik belum mendapat balasan.' };
  } finally {
    if (conn && conn.api) { try { await conn.api.close(); } catch (_) {} }
  }
}

function getWanPostcheck(customerId, serial) {
  const row = db.prepare('SELECT * FROM tech_onu_wan_postcheck WHERE customer_id=? LIMIT 1').get(Number(customerId));
  if (!row || String(row.onu_sn || '').trim().toUpperCase() !== String(serial || '').trim().toUpperCase()) return null;
  return row;
}

function saveWanPostcheck(customerId, serial, status, message, extras = {}) {
  const id = Number(customerId);
  const sn = String(serial || '').trim().toUpperCase();
  const old = getWanPostcheck(id, sn);
  const field = key => Object.prototype.hasOwnProperty.call(extras, key);
  const rebootStatus = field('reboot_status') ? String(extras.reboot_status || 'not_sent') : String(old?.reboot_status || 'not_sent');
  const rebootRequestedAt = field('reboot_requested_at') ? extras.reboot_requested_at : (old?.reboot_requested_at || null);
  const sessionDownSeen = field('session_down_seen') ? Number(extras.session_down_seen ? 1 : 0) : Number(old?.session_down_seen || 0);
  const rebootMessage = field('reboot_message') ? String(extras.reboot_message || '') : String(old?.reboot_message || '');
  const requestedMethod = field('reboot_method') ? String(extras.reboot_method || '') : String(old?.reboot_method || '');
  const rebootMethod = requestedMethod === 'olt_cli' ? 'olt_cli' : 'acs';
  const saved = db.prepare(`
    INSERT INTO tech_onu_wan_postcheck
      (customer_id,onu_sn,status,reboot_status,reboot_requested_at,session_down_seen,reboot_message,reboot_method,last_message,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(customer_id) DO UPDATE SET
      onu_sn=excluded.onu_sn,status=excluded.status,reboot_status=excluded.reboot_status,
      reboot_requested_at=excluded.reboot_requested_at,session_down_seen=excluded.session_down_seen,
      reboot_message=excluded.reboot_message,reboot_method=excluded.reboot_method,
      last_message=excluded.last_message,updated_at=CURRENT_TIMESTAMP
  `).run(id, sn, String(status), rebootStatus, rebootRequestedAt, sessionDownSeen,
    rebootMessage.slice(0, 500), rebootMethod, String(message || '').slice(0, 900));

  // A completed WAN post-check means this serial passed PPPoE return + internet-ping
  // verification. Sync it to the customer master so technician pages can find it.
  // Never overwrite a different serial already stored on the customer.
  if (String(status) === 'complete' && id > 0 && /^[A-Z0-9-]{8,32}$/.test(sn)) {
    try {
      const customer = db.prepare('SELECT onu_sn FROM customers WHERE id=? LIMIT 1').get(id);
      const currentSn = String(customer?.onu_sn || '').replace(/\s+/g, '').trim().toUpperCase();
      if (customer && !currentSn) {
        require('./customerOnuSerialService').saveConfirmedSerial(id, sn, 'WAN PPPoE + reboot + ping terverifikasi');
      } else if (currentSn && currentSn !== sn) {
        logger.warn(`[ONU-WAN] Customer ${id}: serial post-check ${sn} berbeda dengan SN master ${currentSn}; sinkronisasi dilewati untuk mencegah overwrite.`);
      }
    } catch (syncError) {
      logger.warn(`[ONU-WAN] Customer ${id}: gagal sinkron SN setelah post-check complete: ${String(syncError.message || syncError)}`);
    }
  }
  return saved;
}

async function requestOntRebootAfterPing(customerId, serial) {
  const job = db.prepare('SELECT onu_sn,acs_device_id,acs_server_id,status,reboot_status,reboot_message FROM tech_onu_ping_jobs WHERE customer_id=? LIMIT 1').get(Number(customerId));
  if (!job || String(job.onu_sn || '').trim().toUpperCase() !== String(serial || '').trim().toUpperCase() ||
      String(job.status || '') !== 'success' || !String(job.acs_device_id || '').trim()) {
    return { ok: false, message: 'Ping ONT belum berstatus sukses di ACS; reboot tidak dikirim.' };
  }
  const state = String(job.reboot_status || 'not_sent');
  if (state === 'sent') return { ok: true, message: 'Perintah reboot ACS sebelumnya sudah terkirim; tidak dikirim ulang.' };
  if (state !== 'not_sent') {
    return { ok: false, message: 'Status reboot sebelumnya tidak pasti. Perintah tidak dikirim ulang agar ONT tidak reboot berkali-kali.' };
  }
  const claim = db.prepare(`
    UPDATE tech_onu_ping_jobs SET reboot_status='requested',
      reboot_message='Perintah reboot sedang dikirim setelah ping ONT berhasil.', updated_at=CURRENT_TIMESTAMP
    WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?) AND COALESCE(reboot_status,'not_sent')='not_sent'
  `).run(Number(customerId), String(serial || '').trim());
  if (!claim.changes) {
    const latest = db.prepare('SELECT reboot_status,reboot_message FROM tech_onu_ping_jobs WHERE customer_id=? LIMIT 1').get(Number(customerId));
    return String(latest?.reboot_status || '') === 'sent'
      ? { ok: true, message: 'Perintah reboot ACS sebelumnya sudah terkirim; tidak dikirim ulang.' }
      : { ok: false, message: 'Reboot sudah diklaim proses lain; tidak dikirim ulang.' };
  }
  try {
    await genieacs.reboot(String(job.acs_device_id), job.acs_server_id || null);
    db.prepare("UPDATE tech_onu_ping_jobs SET reboot_status='sent', reboot_message=?, updated_at=CURRENT_TIMESTAMP WHERE customer_id=?")
      .run('Perintah reboot ONT terkirim melalui ACS setelah ping 8.8.8.8 berhasil.', Number(customerId));
    return { ok: true, message: 'Perintah reboot ONT terkirim melalui ACS.' };
  } catch (error) {
    const message = 'ACS gagal memastikan hasil perintah reboot: ' + String(error.message || error).slice(0, 240);
    db.prepare("UPDATE tech_onu_ping_jobs SET reboot_status='uncertain', reboot_message=?, updated_at=CURRENT_TIMESTAMP WHERE customer_id=?")
      .run(message, Number(customerId));
    return { ok: false, message: message + ' Tidak akan dicoba ulang otomatis.' };
  }
}

const runningWanPostchecks = new Set();
const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readActivePppoeSession(routerId, username) {
  const conn = await mikrotikService.getConnection(routerId);
  try {
    const rows = await conn.api.send(['/ppp/active/print', '=.proplist=name,address,uptime,service,caller-id']);
    return (Array.isArray(rows) ? rows : []).find(row =>
      String(row.name || '').trim().toLowerCase() === String(username || '').trim().toLowerCase()) || null;
  } finally {
    if (conn && conn.api) { try { await conn.api.close(); } catch (_) {} }
  }
}

async function continueWanPostcheckAfterReboot(customerId, serial, routerIdOverride = null, routerNameOverride = '') {
  const id = Number(customerId);
  const sn = String(serial || '').trim().toUpperCase();
  if (runningWanPostchecks.has(id)) {
    return { done: false, pending: true, message: 'Pemeriksaan reboot/PPPoE masih berjalan pada proses lain; tidak ada reboot atau Add WAN kedua yang dikirim.' };
  }
  runningWanPostchecks.add(id);
  try {
    let postcheck = getWanPostcheck(id, sn);
    if (!postcheck) return { done: false, pending: true, message: 'Status pascareboot belum tersimpan; menunggu pemeriksaan ulang.' };
    if (postcheck.status === 'complete') {
      return { done: true, pending: false, message: postcheck.last_message || 'PPPoE kembali aktif dan ping berhasil.' };
    }
    if (postcheck.status === 'failed' || postcheck.reboot_status === 'uncertain') {
      return { done: false, pending: false, manual: true, message: postcheck.last_message || 'Status reboot tidak pasti; perintah tidak dikirim ulang otomatis.' };
    }

    const customer = db.prepare(`
      SELECT c.id,c.router_id,c.olt_id,c.pppoe_username,r.name AS router_name,r.is_active AS router_active
      FROM customers c LEFT JOIN routers r ON r.id=c.router_id WHERE c.id=? LIMIT 1
    `).get(id);
    if (!customer || !customer.router_id || !(customer.router_active === 1 || customer.router_active === '1' || customer.router_active === true) ||
        !String(customer.pppoe_username || '').trim()) {
      const message = 'Pelanggan/router/username PPPoE belum lengkap untuk memantau reboot. Tidak ada reboot ulang yang dikirim.';
      saveWanPostcheck(id, sn, 'failed', message);
      return { done: false, pending: false, manual: true, message };
    }
    const routerId = Number(routerIdOverride || customer.router_id);
    const routerName = routerNameOverride || customer.router_name || 'MikroTik';

    if (postcheck.reboot_status === 'not_sent' && postcheck.reboot_method === 'olt_cli') {
      // Binding Saja uses OLT CLI only after the exact PPPoE session is active and an Internet ping succeeds.
      let activeSession = null;
      try {
        activeSession = await readActivePppoeSession(routerId, customer.pppoe_username);
      } catch (error) {
        const message = 'Menunggu sesi PPPoE MikroTik bisa diperiksa sebelum reboot CLI: ' + String(error.message || error).slice(0, 180);
        saveWanPostcheck(id, sn, 'waiting_reboot_down', message, { reboot_method: 'olt_cli' });
        return { done: false, pending: true, message, routerId };
      }
      if (!activeSession) {
        const message = 'Sesi PPPoE pelanggan belum aktif di MikroTik; reboot CLI ditahan.';
        saveWanPostcheck(id, sn, 'waiting_reboot_down', message, { reboot_method: 'olt_cli' });
        return { done: false, pending: true, message, routerId };
      }
      let prePing;
      try {
        prePing = await pingRouterInternet(routerId);
      } catch (error) {
        prePing = { ok: false, message: String(error.message || error).slice(0, 180) };
      }
      if (!prePing.ok) {
        const message = 'PPPoE aktif, tetapi ping pra-reboot gagal; reboot CLI ditahan. ' + String(prePing.message || '');
        saveWanPostcheck(id, sn, 'waiting_ping', message, { reboot_method: 'olt_cli' });
        return { done: false, pending: true, message, routerId };
      }

      const binding = db.prepare('SELECT onu_sn,pon_id,onu_id,olt_index FROM tech_onu_jobs WHERE customer_id=? LIMIT 1').get(id);
      const index = String(binding?.olt_index || (binding && binding.pon_id != null && binding.onu_id != null
        ? '0/' + Number(binding.pon_id) + ':' + Number(binding.onu_id) : '')).trim();
      if (!customer.olt_id || !binding || String(binding.onu_sn || '').trim().toUpperCase() !== sn || !index) {
        const message = 'Reboot CLI dibatalkan: binding SN/PON/ONU atau OLT pelanggan tidak lengkap/tidak cocok. Periksa manual.';
        saveWanPostcheck(id, sn, 'failed', message, { reboot_status: 'not_sent', reboot_method: 'olt_cli', reboot_message: message });
        return { done: false, pending: false, manual: true, message };
      }

      // Claim once before the side-effecting CLI command; uncertain outcomes are never retried automatically.
      const claim = db.prepare("UPDATE tech_onu_wan_postcheck SET reboot_status='requested',reboot_requested_at=CURRENT_TIMESTAMP,status='waiting_reboot_down',reboot_message='Perintah reboot CLI sedang dikirim setelah PPPoE aktif dan ping berhasil.',last_message='PPPoE aktif dan ping pra-reboot sukses; mengirim reboot satu kali melalui CLI OLT.',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?) AND reboot_status='not_sent'").run(id, sn);
      if (!claim.changes) {
        postcheck = getWanPostcheck(id, sn);
      } else {
        try {
          const result = await oltService.rebootOnuViaCli(Number(customer.olt_id), index, sn);
          saveWanPostcheck(id, sn, 'waiting_reboot_down',
            'Reboot CLI OLT terkirim setelah sesi PPPoE aktif dan ping pra-reboot sukses; menunggu sesi turun dan naik kembali. ' + result.message,
            { reboot_status: 'sent', reboot_method: 'olt_cli', reboot_message: result.message });
        } catch (error) {
          const message = 'Hasil perintah reboot CLI tidak pasti: ' + String(error.message || error).slice(0, 220) +
            '. Tidak akan dikirim ulang otomatis; periksa status ONT dan OLT.';
          saveWanPostcheck(id, sn, 'failed', message, {
            reboot_status: 'uncertain', reboot_method: 'olt_cli', reboot_message: message
          });
          return { done: false, pending: false, manual: true, message };
        }
        postcheck = getWanPostcheck(id, sn);
      }
    }

    if (postcheck.reboot_status === 'not_sent' && postcheck.reboot_method !== 'olt_cli') {
      let acsCheck;
      try { acsCheck = await oltService.checkAcsDeviceBySerial(sn); }
      catch (error) {
        return { done: false, pending: true, message: 'Menunggu perangkat yang sama dapat dihubungi di ACS sebelum reboot: ' + String(error.message || error).slice(0, 180) };
      }
      if (!acsCheck || !acsCheck.found || !acsCheck.device) {
        return { done: false, pending: true, message: 'PPPoE sudah aktif; menunggu SN yang sama tersedia di ACS untuk reboot terkontrol.' };
      }
      // Claim the one-time reboot before sending it. A timeout/restart never triggers a second reboot.
      const claim = db.prepare(`UPDATE tech_onu_wan_postcheck SET reboot_status='requested',
        reboot_requested_at=CURRENT_TIMESTAMP,status='waiting_reboot_down',
        reboot_message='Permintaan reboot ACS sedang dikirim; menunggu sesi PPPoE turun lalu naik kembali.',
        last_message='PPPoE aktif; mengirim reboot satu kali melalui ACS.',updated_at=CURRENT_TIMESTAMP
        WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?) AND reboot_status='not_sent'`).run(id, sn);
      if (!claim.changes) {
        postcheck = getWanPostcheck(id, sn);
      } else {
        try {
          await genieacs.reboot(String(acsCheck.deviceId || acsCheck.device._id), acsCheck.device._acs_server_id || null);
          saveWanPostcheck(id, sn, 'waiting_reboot_down',
            'Reboot sudah diterima ACS; menunggu sesi PPPoE turun dan kembali aktif.', {
              reboot_status: 'sent', reboot_message: 'Reboot ONT terkirim sekali melalui ACS.'
            });
        } catch (error) {
          const message = 'Hasil perintah reboot tidak pasti: ' + String(error.message || error).slice(0, 220) +
            '. Perintah tidak akan dikirim ulang; periksa status ONT/ACS.';
          saveWanPostcheck(id, sn, 'failed', message, {
            reboot_status: 'uncertain', reboot_message: message
          });
          return { done: false, pending: false, manual: true, message };
        }
        postcheck = getWanPostcheck(id, sn);
      }
    }

    if (postcheck.reboot_status === 'uncertain') {
      return { done: false, pending: false, manual: true, message: postcheck.last_message || 'Hasil reboot tidak pasti; tidak dikirim ulang.' };
    }
    const requestedStamp = Date.parse(String(postcheck.reboot_requested_at || '').replace(' ', 'T') + 'Z');
    const rebootAgeMs = () => Number.isFinite(requestedStamp) ? Math.max(0, Date.now() - requestedStamp) : 0;
    let downSeen = Number(postcheck.session_down_seen || 0) === 1;
    let session = null;
    let readError = '';
    try {
      session = await readActivePppoeSession(routerId, customer.pppoe_username);
    } catch (error) {
      readError = String(error.message || error).slice(0, 180);
    }

    // This function advances exactly one state-machine step, then returns promptly.
    // A short cron poll continues the process even if the technician closes the page.
    // The one-time reboot marker prevents any automatic second reboot.
    if (readError) {
      saveWanPostcheck(id, sn, downSeen ? 'waiting_reboot_up' : 'waiting_reboot_down',
        'Menunggu sesi MikroTik dapat dibaca setelah reboot: ' + readError);
    } else if (!session) {
      downSeen = true;
      saveWanPostcheck(id, sn, 'waiting_reboot_up',
        'Sesi PPPoE turun setelah reboot; menunggu username yang sama aktif kembali.',
        { session_down_seen: 1 });
    } else if (downSeen) {
      saveWanPostcheck(id, sn, 'waiting_ping',
        'Sesi PPPoE kembali aktif setelah reboot; menjalankan ping internet dari MikroTik.',
        { session_down_seen: 1 });
      const ping = await pingRouterInternet(routerId);
      if (ping.ok) {
        const message = `DONE — PPPoE kembali aktif setelah reboot di MikroTik ${routerName} (IP ${session.address || '-'}). ${ping.message}`;
        saveWanPostcheck(id, sn, 'complete', message, {
          reboot_status: 'sent', session_down_seen: 1,
          reboot_message: 'Reboot terkonfirmasi: sesi PPPoE turun dan kembali aktif.'
        });
        return { done: true, pending: false, message, routerId, session: { address: session.address || null, uptime: session.uptime || null }, ping };
      }
      const message = 'PPPoE sudah kembali aktif setelah reboot, tetapi ping internet belum berhasil: ' + ping.message;
      if (rebootAgeMs() >= 10 * 60 * 1000) {
        saveWanPostcheck(id, sn, 'failed', message + ' Batas waktu terlampaui; reboot tidak diulang.', {
          reboot_status: postcheck.reboot_status === 'requested' ? 'uncertain' : postcheck.reboot_status,
          session_down_seen: 1
        });
        return { done: false, pending: false, manual: true, message };
      }
      saveWanPostcheck(id, sn, 'waiting_ping', message, { session_down_seen: 1 });
      return { done: false, pending: true, message, routerId };
    } else {
      saveWanPostcheck(id, sn, 'waiting_reboot_down',
        'Reboot sudah dikirim satu kali; menunggu sesi PPPoE terputus agar reboot dapat dipastikan.');
    }

    if (rebootAgeMs() >= 10 * 60 * 1000) {
      const message = !downSeen
        ? 'Reboot sudah dikirim tetapi sesi PPPoE tidak teramati turun dalam 10 menit. Tidak dikirim ulang; periksa status reboot di ACS.'
        : 'Sesi PPPoE turun setelah reboot tetapi belum kembali aktif dalam 10 menit. Periksa ONT, ACS, dan MikroTik.';
      saveWanPostcheck(id, sn, 'failed', message, {
        reboot_status: postcheck.reboot_status === 'requested' ? 'uncertain' : postcheck.reboot_status,
        session_down_seen: downSeen ? 1 : 0
      });
      return { done: false, pending: false, manual: true, message };
    }

    const message = readError
      ? 'Menunggu pembacaan sesi MikroTik setelah reboot: ' + readError
      : !downSeen
        ? 'Reboot sudah dikirim satu kali; menunggu sesi PPPoE turun.'
        : 'Sesi PPPoE turun; menunggu username yang sama aktif kembali setelah reboot.';
    saveWanPostcheck(id, sn, downSeen ? 'waiting_reboot_up' : 'waiting_reboot_down',
      message, { session_down_seen: downSeen ? 1 : 0 });
    return { done: false, pending: true, message, routerId };
  } finally {
    runningWanPostchecks.delete(id);
  }
}

async function finishWanAfterSession(customerId, serial, routerId, routerName, session, secretMessage = '', rebootMethod = '') {
  const postcheck = getWanPostcheck(customerId, serial);
  const preferredMethod = rebootMethod === 'olt_cli' || (!rebootMethod && postcheck?.reboot_method === 'olt_cli') ? 'olt_cli' : 'acs';
  if (!postcheck) {
    saveWanPostcheck(customerId, serial, 'waiting_reboot_down',
      `${secretMessage} Sesi PPPoE aktif di MikroTik ${routerName} (IP ${session.address || '-'}); memulai reboot terkontrol satu kali.`,
      { reboot_method: preferredMethod });
  } else if (String(postcheck.reboot_status || 'not_sent') === 'not_sent' && !postcheck.reboot_requested_at &&
      postcheck.status !== 'complete') {
    saveWanPostcheck(customerId, serial, postcheck.status || 'waiting_reboot_down',
      postcheck.last_message || `${secretMessage} Sesi PPPoE aktif di MikroTik ${routerName} (IP ${session.address || '-'}).`,
      { reboot_method: preferredMethod });
  }
  return continueWanPostcheckAfterReboot(customerId, serial, routerId, routerName);
}

async function continueOltWanPostcheck(customerId, serial) {
  const customer = db.prepare(`
    SELECT c.id,c.router_id,c.pppoe_username,r.name AS router_name,r.is_active AS router_active
    FROM customers c LEFT JOIN routers r ON r.id=c.router_id WHERE c.id=? LIMIT 1
  `).get(Number(customerId));
  if (!customer || !customer.router_id || !(customer.router_active === 1 || customer.router_active === '1' || customer.router_active === true) ||
      !String(customer.pppoe_username || '').trim()) {
    const message = 'WAN sudah dikirim ke OLT, tetapi pelanggan/router/username PPPoE belum lengkap. Periksa manual; Add WAN tidak akan diulang.';
    saveWanPostcheck(customerId, serial, 'failed', message);
    return { done: false, pending: false, manual: true, message };
  }
  let liveState;
  try {
    liveState = await readRouterPppoeState(customer.router_id);
  } catch (error) {
    const message = 'WAN sudah dikirim satu kali ke OLT; belum bisa membaca sesi MikroTik dan akan diperiksa ulang tanpa mengirim ulang Add WAN: ' + String(error.message || error).slice(0, 200);
    saveWanPostcheck(customerId, serial, 'waiting_session', message);
    return { done: false, pending: true, message, routerId: customer.router_id };
  }
  const username = String(customer.pppoe_username || '').trim().toLowerCase();
  const session = liveState.active.find(row => String(row.name || '').trim().toLowerCase() === username);
  if (!session) {
    const message = 'WAN sudah dikirim satu kali ke OLT; menunggu sesi PPPoE aktif di MikroTik. Add WAN tidak akan dikirim ulang.';
    saveWanPostcheck(customerId, serial, 'waiting_session', message);
    return { done: false, pending: true, message, routerId: customer.router_id };
  }
  saveWanPostcheck(customerId, serial, 'waiting_ping', 'Sesi PPPoE aktif; menjalankan ping ONT ke 8.8.8.8.');
  const result = await finishWanAfterSession(customerId, serial, customer.router_id, customer.router_name || 'MikroTik', session,
    'WAN PPPoE sudah dikonfigurasi satu kali melalui OLT/IP Config.');
  if (result.done) {
    saveWanPostcheck(customerId, serial, 'complete', result.message);
  } else if (result.pending) {
    saveWanPostcheck(customerId, serial, 'waiting_ping', result.message);
  } else {
    saveWanPostcheck(customerId, serial, 'failed', result.message);
  }
  return result;
}

async function provisionCustomerWanViaOlt(customer, serial, plan, existingSecret = null, rebootMethod = '') {
  // Add WAN is sent once. All subsequent waits resume at the post-check stage and never replay the OLT command.
  const secret = existingSecret || await ensurePppoeSecret(customer);
  let output;
  try {
    output = await oltService.configureOnuWan(plan.oltId, {
      index: plan.oltIndex,
      onuVendor: plan.vendor,
      mode: 'PPPoE',
      vlan: 100,
      username: String(customer.pppoe_username || '').trim(),
      password: secret.password,
      lans: '1,2,3,4',
      ssids: '1,2'
    });
  } catch (error) {
    throw new Error(`[WAN_OLT_MANUAL] ${String(error.message || error).slice(0, 500)} OLT config tidak akan dikirim ulang otomatis; periksa hasil IP Config sebelum mencoba lagi.`);
  }

  const outputText = String(output || '');
  const lowerOutput = outputText.toLowerCase();
  if (['unknown command', 'invalid input', 'command incomplete', ' failed', 'failure', 'error:'].some(token => lowerOutput.includes(token))) {
    throw new Error(`[WAN_OLT_MANUAL] OLT mengembalikan hasil yang mengindikasikan konfigurasi ditolak. ${outputText.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').slice(-300)} Tidak diulang otomatis.`);
  }

  saveWanPostcheck(customer.id, serial, 'waiting_session',
    'Add WAN sudah dikirim satu kali ke OLT; menunggu sesi MikroTik, ping internet, lalu reboot satu kali setelah prasyarat terverifikasi.',
    { reboot_method: rebootMethod === 'olt_cli' ? 'olt_cli' : 'acs' });
  return continueOltWanPostcheck(customer.id, serial);
}

async function readHsgqLiveOnuStatus(oltId, pon, onuId, serial) {
  const olt = oltService.getOltById(Number(oltId));
  if (!olt || String(olt.brand || '').trim().toLowerCase() !== 'hsgq') return null;

  const username = String(olt.cli_user || olt.web_user || '').trim();
  const password = String(olt.cli_password || olt.web_password || '');
  if (!username || !password) {
    throw new Error('Kredensial CLI HSGQ tidak lengkap; status online ONU belum dapat diverifikasi.');
  }

  // Read-only live state: do not retry ACS work or send WAN/reboot commands while
  // the exact registered ONU is offline or cannot be uniquely matched on the OLT.
  const onuProvisionService = require('./onuProvisionService');
  const hsgqWebOlt = require('./hsgqWebOltService');
  const config = {
    ...olt,
    username,
    password,
    enablePassword: String(olt.enable_password || ''),
    port: Number(olt.telnet_port) || 23
  };
  const output = await onuProvisionService.runHSGQTelnet(config, [
    'enable', 'configure', `interface gpon ${Number(pon)}`, 'show ont-info all'
  ]);
  if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input)/i.test(String(output || ''))) {
    throw new Error('OLT menolak pembacaan status ONT; provisioning WAN ditahan.');
  }

  const rows = oltService.parseHsgqGponOnuTable(output);
  const expectedId = `${Number(pon)}/${Number(onuId)}`;
  const matches = rows.filter(row =>
    String(row.id || '').trim() === expectedId &&
    hsgqWebOlt.sameSerial(row.serialNumber || row.mac, serial)
  );
  if (matches.length !== 1) {
    throw new Error('SN/PON/ONU target belum dapat dicocokkan secara unik dengan status live OLT; provisioning WAN ditahan.');
  }
  return { status: matches[0].status, offlineReason: String(matches[0].offlineReason || '').trim() };
}

async function provisionCustomerWan(customerId, serial, onuVendor = '', oltIndex = '', options = {}) {
  const customer = db.prepare(`
    SELECT c.id, c.name, c.router_id, c.olt_id, c.package_id, c.connection_type,
           c.pppoe_username, c.pppoe_password, c.pppoe_remote_address,
           p.name AS package_name, p.speed_down, p.speed_up
    FROM customers c LEFT JOIN packages p ON p.id = c.package_id
    WHERE c.id = ? LIMIT 1
  `).get(Number(customerId));
  if (!customer) throw new Error('Data pelanggan untuk WAN PPPoE tidak ditemukan.');

  const savedJob = db.prepare('SELECT onu_vendor, olt_index, reboot_method FROM tech_onu_jobs WHERE customer_id = ? LIMIT 1').get(Number(customerId));
  const vendor = normalizeOnuVendor(onuVendor || savedJob?.onu_vendor, serial);
  const plan = getWanProvisioningPlan({
    customerId, onuVendor: vendor, serial,
    oltIndex: oltIndex || savedJob?.olt_index || ''
  });
  if (!plan.supported) throw new Error(plan.message);
  const rebootMethod = options?.rebootMethod === 'olt_cli' || savedJob?.reboot_method === 'olt_cli' ? 'olt_cli' : 'acs';

  // Resume a previously sent Add WAN/reboot state first. Never create another WAN object
  // and never send a second reboot for the same ONU while these stages are pending.
  let postcheck = getWanPostcheck(customerId, serial);
  // A Binding Saja retry may switch a not-yet-sent legacy reboot from ACS to OLT CLI.
  // Never change the method once a reboot was requested/sent or the postcheck is terminal.
  if (postcheck && options?.rebootMethod === 'olt_cli' &&
      String(postcheck.reboot_status || 'not_sent') === 'not_sent' && !postcheck.reboot_requested_at &&
      !['complete', 'failed'].includes(String(postcheck.status || ''))) {
    saveWanPostcheck(customerId, serial, postcheck.status, postcheck.last_message, { reboot_method: 'olt_cli' });
    postcheck = getWanPostcheck(customerId, serial);
  }
  if (postcheck) {
    if (postcheck.status === 'complete') {
      return { done: true, pending: false, message: postcheck.last_message || 'PPPoE kembali aktif setelah reboot dan ping berhasil.' };
    }
    if (postcheck.status === 'failed' || postcheck.reboot_status === 'uncertain') {
      // An explicit technician WAN repair may continue after a failed post-reboot check,
      // but only when the previous reboot is positively recorded as sent. The existing
      // live PPPoE session check still runs before AddObject; this option never reboots.
      const allowedWanRepair = options?.allowWanRepair === true &&
        postcheck.status === 'failed' && postcheck.reboot_status === 'sent';
      if (!allowedWanRepair) {
        return { done: false, pending: false, manual: true, message: postcheck.last_message || 'Pemeriksaan pascareboot gagal; perintah tidak dikirim ulang.' };
      }
      logger.warn(`[ONU-WAN] Customer ${customerId}: explicit WAN repair allowed after failed postcheck; no reboot will be sent by this repair.`);
    }
    const repairingFailedWanOnly = options?.allowWanRepair === true &&
      postcheck.status === 'failed' && postcheck.reboot_status === 'sent';
    if (!repairingFailedWanOnly && (
        ['waiting_reboot_down','waiting_reboot_up','waiting_ping'].includes(String(postcheck.status || '')) ||
        ['requested','sent','uncertain'].includes(String(postcheck.reboot_status || '')))) {
      return continueWanPostcheckAfterReboot(customerId, serial);
    }
    if (plan.method === 'olt' && postcheck.status === 'waiting_session') {
      return continueOltWanPostcheck(customerId, serial);
    }
  }

  // Mandatory FiberHome firmware barrier for every route and retry path. A target HG6145D2
  // cannot reach ACS AddObject until its exact model/SN/version and completed upgrade are verified.
  if (vendor === 'FIBERHOME') {
    const firmwareGate = await fiberHomeFirmwareSvc.checkWanFirmwareGate({
      customerId: Number(customerId), oltId: Number(customer.olt_id), serial,
      oltIndex: oltIndex || savedJob?.olt_index || ''
    });
    if (!firmwareGate.allowed) {
      return {
        done: false, pending: !firmwareGate.manual, manual: Boolean(firmwareGate.manual),
        message: 'Firmware FiberHome: ' + String(firmwareGate.message || 'versi belum terverifikasi; WAN ditahan.')
      };
    }
  }

  // On HSGQ, do not queue repeated ACS refreshes or attempt WAN work for a known-offline
  // FiberHome ONU. A live OLT state is read-only and must confirm this exact SN/PON/ONU.
  const effectiveOltIndex = String(oltIndex || savedJob?.olt_index || '');
  const hsgqIndexMatch = effectiveOltIndex.match(/^\d+\/([1-8]):(\d+)$/);
  if (vendor === 'FIBERHOME' && hsgqIndexMatch && Number(customer.olt_id) > 0) {
    let liveOnu;
    try {
      liveOnu = await readHsgqLiveOnuStatus(customer.olt_id, Number(hsgqIndexMatch[1]), Number(hsgqIndexMatch[2]), serial);
    } catch (error) {
      logger.warn(`[ONU-WAN] Customer ${customerId}: HSGQ live ONU state could not be verified; WAN/ACS writes deferred: ${String(error.message || error).slice(0, 180)}`);
      return {
        done: false, pending: true,
        message: 'Status live ONU dari HSGQ belum dapat diverifikasi. WAN/ACS ditunda agar tidak menambah tugas berulang atau mengubah ONU yang statusnya belum pasti.'
      };
    }
    if (liveOnu && liveOnu.status !== 'Online') {
      const reason = liveOnu.offlineReason ? ' Keterangan OLT: ' + liveOnu.offlineReason + '.' : '';
      return {
        done: false, pending: true,
        message: `ONT FiberHome ${effectiveOltIndex} berstatus ${liveOnu.status} di HSGQ.${reason} Menunggu ONT Online sebelum refresh ACS/Add WAN; tidak ada AddObject atau reboot yang dikirim.`
      };
    }
  }

  // First check MikroTik PPPoE. A live session means WAN already exists; skip Add WAN.
  // Read the existing secret/password and check the live MikroTik session BEFORE
  // Add WAN. If this username is already active, do not create a duplicate WAN object.
  const secret = await ensurePppoeSecret(customer);
  let session;
  try {
    session = await readActivePppoeSession(secret.routerId, customer.pppoe_username);
  } catch (error) {
    return { done: false, pending: true, message: `${secret.message} Belum dapat memastikan sesi PPPoE di MikroTik; Add WAN ditahan agar tidak membuat WAN ganda: ${String(error.message || error).slice(0, 220)}`, secretCreated: secret.created, routerId: secret.routerId };
  }
  if (session) {
    return finishWanAfterSession(customerId, serial, secret.routerId, secret.routerName, session,
      `${secret.message} Sesi PPPoE sudah aktif; Add WAN dilewati agar tidak membuat interface duplikat.`, rebootMethod);
  }

  if (plan.method === 'olt') {
    logger.info(`[ONU-WAN] Customer ID ${customerId}: sesi PPPoE belum aktif; membuat WAN satu kali melalui ${plan.label}.`);
    return provisionCustomerWanViaOlt(customer, serial, plan, secret, rebootMethod);
  }

  // FiberHome: only after firmware is verified and the PPPoE session is confirmed absent,
  // wait for the exact same SN to appear in ACS before creating WAN.
  let acsCheck;
  try { acsCheck = await oltService.checkAcsDeviceBySerial(serial); }
  catch (error) {
    return { done: false, pending: true, message: `Belum bisa memeriksa SN ${serial} di ACS; WAN belum dikirim: ${String(error.message || error).slice(0, 220)}` };
  }
  if (!acsCheck || !acsCheck.found || !acsCheck.device) {
    return { done: false, pending: true, message: `SN ${serial} belum ditemukan di ACS. Binding OLT dan firmware tetap tersimpan; Add WAN menunggu SN yang sama muncul di ACS.` };
  }

  // FiberHome: firmware is gated above and exact SN has been matched in ACS. AddObject
  // requests are keyed by customer/SN so retries do not create duplicate PPP objects.
  const wan = await oltService.configureWanViaAcs(serial, {
    customerId: Number(customerId),
    mode: 'PPPoE', vlan: 100,
    username: String(customer.pppoe_username).trim(),
    password: secret.password,
    allowAddObjectRetry: options && options.allowAddObjectRetry === true
  });
  const wanMessage = String(wan.message || '').replace(/^WAN_PENDING:\s*/i, '').trim();
  if (!wan.configured) {
    const message = `${secret.message} ${wanMessage}`.trim();
    if (wan.manual) return { done: false, pending: false, manual: true, message, secretCreated: secret.created, routerId: secret.routerId };
    return { done: false, pending: true, message, secretCreated: secret.created, routerId: secret.routerId };
  }

  // ACS reports the WAN configured, but do not call it complete until PPPoE is active.
  try {
    session = await readActivePppoeSession(secret.routerId, customer.pppoe_username);
  } catch (error) {
    return { done: false, pending: true, message: `${secret.message} WAN sudah dikonfigurasi ACS; pemeriksaan PPPoE menunggu: ${String(error.message || error).slice(0, 200)}`, secretCreated: secret.created, routerId: secret.routerId };
  }
  if (!session) {
    const message = `${secret.message} WAN sudah dikonfigurasi ACS, tetapi sesi PPPoE ${String(customer.pppoe_username).trim()} belum aktif di MikroTik ${secret.routerName}; sistem akan memeriksa ulang tanpa mengulang AddObject.`;
    return { done: false, pending: true, message, secretCreated: secret.created, routerId: secret.routerId };
  }
  return finishWanAfterSession(customerId, serial, secret.routerId, secret.routerName, session, secret.message, rebootMethod);
}

async function retryPendingWanProvisioning() {
  let jobs = [];
  try {
    jobs = db.prepare(`
      SELECT j.customer_id, j.onu_sn, j.onu_vendor, j.olt_index
      FROM tech_onu_jobs j
      WHERE j.status = 'pending'
        AND j.onu_sn IS NOT NULL AND TRIM(j.onu_sn) <> ''
        AND j.last_message LIKE 'WAN_PENDING:%'
        AND j.updated_at <= datetime('now', '-2 minutes')
      ORDER BY j.updated_at ASC LIMIT 20
    `).all();
  } catch (e) {
    logger.warn(`[ONU-WAN] Antrean retry belum tersedia: ${e.message}`);
    return;
  }

  for (const job of jobs) {
    try {
      const result = await provisionCustomerWan(job.customer_id, job.onu_sn, job.onu_vendor, job.olt_index);
      const status = result.done ? 'done' : (result.manual ? 'bound_manual' : 'pending');
      const message = (result.done || result.manual) ? result.message : `WAN_PENDING: ${result.message}`;
      db.prepare(`UPDATE tech_onu_jobs SET status=?, last_message=?, updated_at=CURRENT_TIMESTAMP,
        provisioned_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE provisioned_at END WHERE customer_id=?`)
        .run(status, String(message).slice(0, 1000), status, job.customer_id);
      if (result.done) logger.info(`[ONU-WAN] WAN PPPoE terverifikasi untuk customer ID ${job.customer_id}.`);
    } catch (e) {
      const detail = String(e.message || e).slice(0, 850);
      // Permanent data/profile mismatches need a technician/admin correction, not an endless retry loop.
      const permanent = ['[WAN_OLT_MANUAL]', '[WAN_OLT_UNSUPPORTED]', '[WAN_OLT_INDEX_REQUIRED]'].some(code => detail.includes(code)) || /username\/password.*belum lengkap|password PPPoE tidak tersedia|paket billing pelanggan belum dipilih|belum memiliki profile bernama sama|rate-limit profile .*tidak cocok|profile secret .*tidak cocok|secret .*disabled|servicenya .*bukan PPPoE|router mikroTik ID .*nonaktif|router mikroTik belum dipilih|jenis koneksi pelanggan bukan PPPoE|profile lama .*tidak ditemukan/i.test(detail);
      const status = permanent ? 'failed' : 'pending';
      const message = permanent ? `Provisioning perlu diperbaiki: ${detail}` : `WAN_PENDING: ${detail}`;
      db.prepare("UPDATE tech_onu_jobs SET status=?, last_message=?, updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND status='pending'")
        .run(status, message, job.customer_id);
      logger.warn(`[ONU-WAN] Retry customer ID ${job.customer_id} ${permanent ? 'ditandai gagal untuk perbaikan data' : 'belum berhasil'}: ${detail}`);
    }
  }
}

let pendingPostcheckWorkerRunning = false;
async function retryPendingWanPostchecks() {
  if (pendingPostcheckWorkerRunning) return;
  pendingPostcheckWorkerRunning = true;
  try {
    const jobs = db.prepare(`
      SELECT customer_id,onu_sn FROM tech_onu_wan_postcheck
      WHERE status IN ('waiting_reboot_down','waiting_reboot_up','waiting_ping')
        AND reboot_status IN ('not_sent','requested','sent')
      ORDER BY updated_at ASC LIMIT 40
    `).all();
    for (const job of jobs) {
      try {
        const result = await continueWanPostcheckAfterReboot(job.customer_id, job.onu_sn);
        if (result.done) {
          db.prepare(`UPDATE tech_onu_jobs SET status='done',last_message=?,updated_at=CURRENT_TIMESTAMP,
            provisioned_at=CURRENT_TIMESTAMP WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?)`)
            .run(String(result.message || 'PPPoE aktif setelah reboot dan ping berhasil.').slice(0, 1000), job.customer_id, job.onu_sn);
          logger.info(`[ONU-WAN-POSTCHECK] Customer ${job.customer_id}: PPPoE kembali aktif dan ping berhasil; Binding Saja berstatus done.`);
        } else if (result.manual) {
          db.prepare(`UPDATE tech_onu_jobs SET status='bound_manual',last_message=?,updated_at=CURRENT_TIMESTAMP
            WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?) AND status<>'done'`)
            .run(String(result.message || 'Pemeriksaan pascareboot perlu tindakan teknisi.').slice(0, 1000), job.customer_id, job.onu_sn);
        } else {
          db.prepare(`UPDATE tech_onu_jobs SET status='pending',last_message=?,updated_at=CURRENT_TIMESTAMP
            WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?) AND status<>'done'`)
            .run(('WAN_PENDING: ' + String(result.message || 'Menunggu PPPoE/ping setelah reboot.')).slice(0, 1000), job.customer_id, job.onu_sn);
        }
      } catch (error) {
        logger.warn(`[ONU-WAN-POSTCHECK] Customer ${job.customer_id}: ${String(error.message || error).slice(0, 250)}`);
      }
    }
  } catch (error) {
    logger.warn('[ONU-WAN-POSTCHECK] Gagal membaca antrean: ' + String(error.message || error).slice(0, 250));
  } finally {
    pendingPostcheckWorkerRunning = false;
  }
}

module.exports = {
  provisionCustomerWan, retryPendingWanProvisioning, retryPendingWanPostchecks,
  diagnoseCustomerWan, preflightCustomerWan, normalizeOnuVendor, getWanProvisioningPlan
};



