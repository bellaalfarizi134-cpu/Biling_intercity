const db = require('../config/database');

function normalizeSerial(value) {
  return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim().toUpperCase();
}

function saveConfirmedSerial(customerId, value, source = 'OLT binding') {
  const id = Number(customerId);
  const serial = normalizeSerial(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('ID pelanggan tidak valid saat menyimpan SN ONT.');
  if (!/^[A-Z0-9-]{8,32}$/.test(serial)) throw new Error('SN ONT hasil binding tidak valid; SN pelanggan tidak diubah.');
  const customer = db.prepare('SELECT id,onu_sn FROM customers WHERE id=? LIMIT 1').get(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan saat menyimpan SN ONT.');
  const previous = normalizeSerial(customer.onu_sn);
  db.prepare('UPDATE customers SET onu_sn=?,onu_sn_updated_at=CURRENT_TIMESTAMP WHERE id=?').run(serial, id);
  console.info('[CUSTOMER ONU SN] SN tersimpan dari ' + String(source || 'OLT binding') + ': customer=' + id + ', SN=' + serial + (previous && previous !== serial ? ', serial_lama=' + previous : ''));
  return { customerId: id, serialNumber: serial, previousSerial: previous };
}

module.exports = { normalizeSerial, saveConfirmedSerial };
