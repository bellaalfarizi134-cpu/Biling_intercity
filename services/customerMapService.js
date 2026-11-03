const db = require('../config/database');
const customerService = require('./customerService');
const mapOltStatusSvc = require('./mapOltStatusService');

const serialKey = value => mapOltStatusSvc.normalizeSerial(value);

function loadAcsPppoeSerialIndex() {
  const usernames = new Map();
  const serials = new Map();
  try {
    const devices = db.prepare('SELECT id,serial_number,manufacturer,product_class,params,last_inform FROM acs_devices').all();
    for (const device of devices) {
      const sn = String(device.serial_number || '').trim();
      const snKey = serialKey(sn);
      if (sn && snKey && !serials.has(snKey)) serials.set(snKey, { sn, deviceId: String(device.id || ''), lastInform: String(device.last_inform || '') });
      if (!sn) continue;
      let params = {};
      try { params = JSON.parse(device.params || '{}'); } catch (_) {}
      for (const [path, value] of Object.entries(params || {})) {
        // Match only the WAN's actual PPP/IP username parameter, never ACS login or Wi-Fi credentials.
        if (!/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WAN(?:PPP|IP)Connection\.\d+\.Username$/i.test(path)) continue;
        const username = String(value || '').trim().toLowerCase();
        if (!username) continue;
        if (!usernames.has(username)) usernames.set(username, new Map());
        const current = usernames.get(username);
        const key = serialKey(sn);
        if (!current.has(key)) current.set(key, { sn, lastInform: String(device.last_inform || ''), deviceId: String(device.id || '') });
      }
    }
  } catch (error) {
    console.warn('[CUSTOMER MAP] gagal membuat indeks username WAN ACS:', String(error.message || error));
  }
  return { usernames, serials };
}

function loadExplicitAcsLinks() {
  const linked = new Map();
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acs_customer_links' LIMIT 1").get();
    if (!table) return linked;
    const rows = db.prepare(`
      SELECT l.customer_id, l.device_id, l.updated_at, d.serial_number
      FROM acs_customer_links l LEFT JOIN acs_devices d ON d.id = l.device_id
      ORDER BY l.updated_at DESC
    `).all();
    for (const row of rows) {
      const id = Number(row.customer_id);
      let sn = String(row.serial_number || '').trim();
      if (!sn) sn = String(row.device_id || '').split('-').pop().trim();
      if (Number.isSafeInteger(id) && id > 0 && sn && !linked.has(id)) {
        linked.set(id, { sn, source: 'ACS link pelanggan', updatedAt: String(row.updated_at || '') });
      }
    }
  } catch (error) {
    console.warn('[CUSTOMER MAP] gagal membaca link ACS pelanggan:', String(error.message || error));
  }
  return linked;
}

function loadHistoricalCustomerSerials() {
  const sources = [
    ['tech_onu_jobs', 'onu_sn', 'catatan ONU'],
    ['tech_onu_acs_wan_jobs', 'onu_sn', 'catatan WAN ACS'],
    ['tech_onu_wan_postcheck', 'onu_sn', 'catatan pemeriksaan WAN'],
    ['tech_onu_firmware_jobs', 'onu_sn', 'catatan firmware'],
    ['tech_onu_ping_jobs', 'onu_sn', 'catatan ping ONT']
  ];
  const byCustomer = new Map();
  const entries = [];
  for (const [table, serialColumn, label] of sources) {
    try {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table);
      if (!exists) continue;
      const columns = db.prepare('PRAGMA table_info("' + table + '")').all().map(c => c.name);
      if (!columns.includes('customer_id') || !columns.includes(serialColumn)) continue;
      const updatedCol = columns.includes('updated_at') ? 'updated_at' : (columns.includes('created_at') ? 'created_at' : null);
      const updated = updatedCol ? ', "' + updatedCol + '" AS updated_at' : ", '' AS updated_at";
      const rows = db.prepare('SELECT customer_id, "' + serialColumn + '" AS sn' + updated + ' FROM "' + table + '" WHERE TRIM(COALESCE("' + serialColumn + '",\'\')) <> \'\'').all();
      for (const row of rows) {
        const id = Number(row.customer_id);
        const sn = String(row.sn || '').trim();
        if (Number.isSafeInteger(id) && id > 0 && sn) entries.push({ id, sn, source: label, updatedAt: String(row.updated_at || '') });
      }
    } catch (error) {
      console.warn('[CUSTOMER MAP] gagal membaca SN lokal dari ' + table + ':', String(error.message || error));
    }
  }
  entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const entry of entries) if (!byCustomer.has(entry.id)) byCustomer.set(entry.id, entry);
  return byCustomer;
}

function loadBindingJobs() {
  const jobsByCustomer = new Map();
  try {
    const hasJobsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tech_onu_jobs' LIMIT 1").get();
    if (!hasJobsTable) return jobsByCustomer;
    const jobs = db.prepare(`SELECT customer_id,status,pon_id,onu_id,onu_sn,last_message,updated_at
      FROM tech_onu_jobs ORDER BY updated_at DESC`).all();
    for (const job of jobs) {
      const id = Number(job.customer_id);
      if (Number.isSafeInteger(id) && id > 0 && !jobsByCustomer.has(id)) jobsByCustomer.set(id, job);
    }
  } catch (error) {
    console.warn('[CUSTOMER MAP] gagal membaca status binding:', String(error.message || error));
  }
  return jobsByCustomer;
}

function getAllMapCustomers() {
  const baseCustomers = customerService.getAllCustomers();
  const topologyByOdp = new Map();
  try {
    const topologyRows = db.prepare(`
      SELECT p.id AS odp_id, p.name AS odp_name, d.name AS odc_name, l.name AS olt_name
      FROM odps p
      LEFT JOIN odcs d ON d.id = p.odc_id
      LEFT JOIN olts l ON l.id = COALESCE(p.olt_id, d.olt_id)
    `).all();
    for (const row of topologyRows) topologyByOdp.set(Number(row.odp_id), row);
  } catch (error) {
    console.warn('[CUSTOMER MAP] gagal membaca nama ODP/ODC/OLT:', String(error.message || error));
  }
  const customers = baseCustomers.map(customer => {
    const topology = topologyByOdp.get(Number(customer.odp_id)) || {};
    return {
      ...customer,
      odp_name: topology.odp_name || customer.odp_name || '',
      odc_name: topology.odc_name || customer.odc_name || '',
      olt_name: topology.olt_name || customer.olt_name || ''
    };
  });
  const { usernames: acsByPppoe, serials: acsSerials } = loadAcsPppoeSerialIndex();
  const explicitLinks = loadExplicitAcsLinks();
  const historicalSerials = loadHistoricalCustomerSerials();
  const jobsByCustomer = loadBindingJobs();
  const oltPayload = mapOltStatusSvc.getPayload();
  const oltInventoryHasBeenChecked = Boolean(oltPayload.olt_status_checked_at);
  const oltBySerial = mapOltStatusSvc.getStatusBySerial();
  let snResolved = 0;
  let snAmbiguous = 0;

  const result = customers.map(customer => {
    const customerId = Number(customer.id);
    const job = jobsByCustomer.get(customerId) || null;
    const status = String(job?.status || '').trim().toLowerCase();
    const message = String(job?.last_message || '');
    const jobSerial = String(job?.onu_sn || '').trim();
    const explicit = explicitLinks.get(customerId) || null;
    const storedCustomerSn = String(customer.onu_sn || '').trim();
    const username = String(customer.pppoe_username || '').trim().toLowerCase();
    const pppoeCandidates = [...(acsByPppoe.get(username)?.values() || [])];
    const rawTag = String(customer.genieacs_tag || '').trim();
    const tag = serialKey(rawTag);
    const tagSuffix = serialKey(rawTag.split('-').pop());
    const tagDevice = (tag ? acsSerials.get(tag) : null) || (tagSuffix ? acsSerials.get(tagSuffix) : null);

    let sn = '';
    let snSource = '';
    let matchStatus = 'not_found';
    if (storedCustomerSn) {
      sn = storedCustomerSn;
      snSource = 'SN ONT tersimpan pada data pelanggan';
      matchStatus = 'matched';
    } else if (explicit && explicit.sn) {
      sn = explicit.sn;
      snSource = explicit.source;
      matchStatus = 'matched';
    } else if (tagDevice && tagDevice.sn) {
      sn = tagDevice.sn;
      snSource = 'tag perangkat ACS';
      matchStatus = 'matched';
    } else if (pppoeCandidates.length === 1) {
      sn = pppoeCandidates[0].sn;
      snSource = 'username PPPoE pada WAN ACS';
      matchStatus = 'matched';
    } else if (pppoeCandidates.length > 1) {
      const oltCandidates = pppoeCandidates.filter(candidate => oltBySerial.has(serialKey(candidate.sn)));
      const jobCandidate = pppoeCandidates.find(candidate => serialKey(candidate.sn) === serialKey(jobSerial));
      if (oltCandidates.length === 1) {
        sn = oltCandidates[0].sn;
        snSource = 'username PPPoE + kecocokan inventaris OLT';
        matchStatus = 'matched';
      } else if (jobCandidate) {
        sn = jobCandidate.sn;
        snSource = 'username PPPoE + catatan serial pelanggan';
        matchStatus = 'matched';
      } else {
        matchStatus = 'ambiguous';
        snSource = 'username PPPoE cocok ke beberapa perangkat ACS';
      }
    } else {
      const historical = historicalSerials.get(customerId);
      if (historical && historical.sn) {
        sn = historical.sn;
        snSource = historical.source;
        matchStatus = 'matched';
      }
    }

    const oltRecord = sn ? (oltBySerial.get(serialKey(sn)) || null) : null;
    let oltStatus = 'unknown';
    let oltStatusLabel = 'SN belum tersedia';
    let oltReason = '';
    let oltCheckedAt = '';
    let oltPonId = null;
    let oltOnuId = null;
    let oltName = '';
    if (matchStatus === 'ambiguous') {
      oltStatusLabel = 'SN belum pasti';
      oltReason = 'Username PPPoE yang sama cocok ke beberapa serial ACS; status OLT tidak ditempelkan sampai SN terverifikasi.';
    } else if (oltRecord) {
      oltStatus = String(oltRecord.status || 'Unknown').toLowerCase();
      oltName = String(oltRecord.olt_name || '');
      oltCheckedAt = String(oltRecord.checked_at || '');
      oltPonId = oltRecord.pon_id == null ? null : Number(oltRecord.pon_id);
      oltOnuId = oltRecord.onu_id == null ? null : Number(oltRecord.onu_id);
      if (oltStatus === 'online') {
        oltStatusLabel = 'ONLINE di OLT';
      } else if (oltStatus === 'offline') {
        oltStatusLabel = 'OFFLINE di OLT';
        oltReason = String(oltRecord.offline_reason || '').trim() ||
          'OLT tidak mengirim penyebab spesifik. Periksa alarm LOS/RX optik, sambungan fiber, dan daya ONT.';
      } else {
        oltStatusLabel = 'Status OLT belum pasti';
      }
    } else if (sn && matchStatus === 'matched') {
      oltStatusLabel = oltInventoryHasBeenChecked ? 'SN tidak ditemukan di inventaris OLT' : 'Menunggu pembacaan status OLT';
      oltReason = oltInventoryHasBeenChecked
        ? 'SN ada pada data ACS/riwayat, tetapi tidak ditemukan pada pembacaan inventaris OLT terakhir. Ini belum membuktikan ONT mati.'
        : 'Inventaris OLT belum selesai dibaca. Status mati/hidup belum dapat dipastikan.';
    } else if (matchStatus === 'ambiguous') {
      oltStatusLabel = 'SN belum pasti';
    }

    if (sn && matchStatus === 'matched') snResolved++;
    if (matchStatus === 'ambiguous') snAmbiguous++;

    const hasSerial = Boolean(sn);
    const hasOnuPosition = job?.pon_id != null && Number(job.pon_id) >= 1 && job?.onu_id != null && Number(job.onu_id) >= 0;
    const explicitBindingMessage = /binding olt berhasil|binding terverifikasi|binding selesai|onu binding \+ internet aktif/i.test(message);
    const bindingConfirmed = Boolean(job && (
      status === 'done' || status === 'bound_manual' ||
      (hasSerial && hasOnuPosition && explicitBindingMessage)
    ));

    let bindingLabel = 'Belum ada data binding';
    if (status === 'done') bindingLabel = 'Binding berhasil · internet aktif';
    else if (status === 'bound_manual') bindingLabel = 'Binding berhasil · WAN perlu diperiksa';
    else if (bindingConfirmed) bindingLabel = 'Binding berhasil · WAN menunggu';
    else if (status === 'working') bindingLabel = 'Proses binding berlangsung';
    else if (status === 'pending') bindingLabel = 'Menunggu proses binding';
    else if (status === 'failed') bindingLabel = 'Binding gagal / perlu diperiksa';

    return {
      ...customer,
      onu_sn: sn,
      onu_sn_source: snSource,
      onu_sn_match_status: matchStatus,
      onu_olt_status: oltStatus,
      onu_olt_status_label: oltStatusLabel,
      onu_olt_reason: oltReason,
      onu_olt_checked_at: oltCheckedAt,
      // Optical RX/TX are read-only values from the local OLT cache, not ACS telemetry.
      onu_olt_rx: oltRecord ? String(oltRecord.rx || '') : '',
      onu_olt_tx: oltRecord ? String(oltRecord.tx || '') : '',
      onu_olt_optical_checked_at: oltRecord ? String(oltRecord.optical_checked_at || '') : '',
      onu_olt_pon_id: oltPonId,
      onu_olt_onu_id: oltOnuId,
      onu_olt_name: oltName,
      onu_binding_status: status || 'none',
      onu_binding_confirmed: bindingConfirmed,
      onu_binding_label: bindingLabel,
      onu_binding_sn: sn,
      onu_binding_pon_id: job?.pon_id == null ? null : Number(job.pon_id),
      onu_binding_onu_id: job?.onu_id == null ? null : Number(job.onu_id),
      onu_binding_message: message,
      onu_binding_updated_at: String(job?.updated_at || '')
    };
  });

  // A small audit metric without exposing usernames or device credentials.
  if (process.env.NODE_ENV !== 'test') {
    console.info('[CUSTOMER MAP SN AUDIT] pelanggan=' + customers.length + ', SN cocok=' + snResolved + ', SN ambigu=' + snAmbiguous + ', status OLT tersedia=' + result.filter(c => c.onu_olt_status === 'online' || c.onu_olt_status === 'offline').length);
  }
  return result;
}

module.exports = { getAllMapCustomers };
