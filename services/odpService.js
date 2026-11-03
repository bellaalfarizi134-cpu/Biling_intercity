const db = require('../config/database');

/**
 * ODP SERVICE
 * Mengelola data Optical Distribution Point (ODP)
 */

function getAllOdps() {
  return db.prepare('SELECT o.*, olt.name AS olt_name, odc.name AS odc_name FROM odps o LEFT JOIN olts olt ON o.olt_id = olt.id LEFT JOIN odcs odc ON o.odc_id = odc.id ORDER BY o.name COLLATE NOCASE ASC').all();
}

function getOdpById(id) {
  return db.prepare('SELECT * FROM odps WHERE id = ?').get(id);
}

function normalizeOdpInput(data, existing = null) {
  const has = key => Object.prototype.hasOwnProperty.call(data, key);
  const name = String(has('name') ? data.name : (existing?.name || '')).trim();
  if (!name) throw new Error('Nama ODP wajib diisi.');

  const rawOdcId = has('odc_id') ? String(data.odc_id || '').trim() : String(existing?.odc_id || '').trim();
  const odcId = rawOdcId ? Number(rawOdcId) : null;
  if (odcId !== null && (!Number.isSafeInteger(odcId) || odcId < 1)) throw new Error('ODC induk tidak valid.');
  const odc = odcId ? db.prepare('SELECT id, olt_id FROM odcs WHERE id = ?').get(odcId) : null;
  if (odcId && !odc) throw new Error('ODC yang dipilih tidak ditemukan.');

  const rawOltId = has('olt_id') ? String(data.olt_id || '').trim() : String(odc && Number(odc.olt_id) > 0 ? '' : (existing?.olt_id || '')).trim();
  const requestedOltId = rawOltId ? Number(rawOltId) : null;
  if (requestedOltId !== null) {
    if (!Number.isSafeInteger(requestedOltId) || requestedOltId < 1 || !db.prepare('SELECT id FROM olts WHERE id = ?').get(requestedOltId)) {
      throw new Error('OLT induk tidak valid.');
    }
  }
  if (odc && Number(odc.olt_id) > 0 && requestedOltId && Number(odc.olt_id) !== requestedOltId) {
    throw new Error('OLT milik ODC berbeda dengan OLT yang dipilih. Sesuaikan hubungan ODC terlebih dahulu.');
  }
  const oltId = odc && Number(odc.olt_id) > 0 ? Number(odc.olt_id) : requestedOltId;

  const ponPort = String(has('pon_port') ? (data.pon_port || '') : (existing?.pon_port || '')).trim();
  if (ponPort.length > 64 || (ponPort && !/^[A-Za-z0-9 ./_:-]+$/.test(ponPort))) {
    throw new Error('Port PON OLT maksimal 64 karakter; gunakan huruf, angka, spasi, titik, garis miring, titik dua, garis bawah, atau tanda hubung.');
  }
  const capacityText = has('port_capacity') ? String(data.port_capacity ?? '').trim() : '';
  const capacity = capacityText !== '' ? Number(capacityText) : Number(existing?.port_capacity || 16);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) throw new Error('Kapasitas port ODP harus angka 1–128.');
  const splitterRatioText = has('splitter_ratio') ? String(data.splitter_ratio ?? '').trim() : '';
  const splitterRatio = splitterRatioText !== ''
    ? Number(splitterRatioText)
    : Number(existing?.splitter_ratio || (capacity <= 8 ? 8 : 16));
  if (![8, 16].includes(splitterRatio)) throw new Error('Rasio splitter ODP hanya 1:8 atau 1:16.');
  if (existing) {
    const used = db.prepare("SELECT COUNT(DISTINCT TRIM(pon_port)) AS n FROM customers WHERE odp_id = ? AND pon_port IS NOT NULL AND TRIM(pon_port) <> ''").get(Number(existing.id));
    if (capacity < Number(used?.n || 0)) throw new Error('Kapasitas tidak boleh lebih kecil dari jumlah port ODP yang sudah terpakai (' + Number(used?.n || 0) + ').');
  }

  const lat = String(has('lat') ? (data.lat || '') : (existing?.lat || '')).trim();
  const lng = String(has('lng') ? (data.lng || '') : (existing?.lng || '')).trim();
  if ((lat && !lng) || (!lat && lng)) throw new Error('Latitude dan longitude harus diisi bersama.');
  if (lat && lng) {
    const latitude = Number(lat), longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('Koordinat ODP tidak valid.');
    }
  }
  const description = String(has('description') ? (data.description || '') : (existing?.description || '')).trim();
  return { name, olt_id: oltId, odc_id: odcId, pon_port: ponPort, port_capacity: capacity, splitter_ratio: splitterRatio, lat, lng, description };
}

function createOdp(data) {
  const input = normalizeOdpInput(data || {});
  const stmt = db.prepare('INSERT INTO odps (name, olt_id, odc_id, pon_port, port_capacity, splitter_ratio, lat, lng, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return stmt.run(input.name, input.olt_id, input.odc_id, input.pon_port, input.port_capacity, input.splitter_ratio, input.lat, input.lng, input.description);
}

function updateOdp(id, data) {
  const odpId = Number(id);
  if (!Number.isSafeInteger(odpId) || odpId < 1) throw new Error('ID ODP tidak valid.');
  const existing = getOdpById(odpId);
  if (!existing) throw new Error('ODP tidak ditemukan.');
  const input = normalizeOdpInput(data || {}, existing);
  const stmt = db.prepare('UPDATE odps SET name = ?, olt_id = ?, odc_id = ?, pon_port = ?, port_capacity = ?, splitter_ratio = ?, lat = ?, lng = ?, description = ? WHERE id = ?');
  return stmt.run(input.name, input.olt_id, input.odc_id, input.pon_port, input.port_capacity, input.splitter_ratio, input.lat, input.lng, input.description, odpId);
}

function deleteOdp(id) {
  return db.prepare('DELETE FROM odps WHERE id = ?').run(id);
}

function getOdpPortUsage(odpId) {
  const odp = getOdpById(odpId);
  if (!odp) return null;
  const usedRaw = db.prepare("SELECT pon_port FROM customers WHERE odp_id = ? AND pon_port IS NOT NULL AND TRIM(pon_port) != ''").all(odpId);
  const usedPorts = Array.from(new Set(usedRaw.map(r => String(r.pon_port).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'id-ID', { numeric: true }));
  const capacity = Number(odp.port_capacity || 16) || 16;
  const usedCount = usedPorts.length;
  const remaining = Math.max(0, capacity - usedCount);
  return { odpId: Number(odpId), capacity, usedCount, remaining, usedPorts };
}

module.exports = { getAllOdps, getOdpById, createOdp, updateOdp, deleteOdp, getOdpPortUsage };
