const db = require('../config/database');

function authenticate(username, password) {
  const tech = db.prepare('SELECT * FROM technicians WHERE username = ? AND password = ? AND is_active = 1').get(username, password);
  return tech;
}

function getTechById(id) {
  return db.prepare('SELECT id, username, name, phone, area, is_active, created_at FROM technicians WHERE id = ?').get(id);
}

function getTechStats(techId) {
  const total = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ?").get(techId).count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'in_progress'").get(techId).count;
  const resolved = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'resolved'").get(techId).count;
  
  // Ambil open tickets yang belum ada teknisinya atau di-assign ke teknisi ini
  const open = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'open'").get().count;

  return { total, open, inProgress, resolved };
}

function getAssignedTickets(techId) {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
           tech.name as technician_name
    FROM tickets t
    JOIN customers c ON t.customer_id = c.id
    LEFT JOIN technicians tech ON tech.id = t.technician_id
    WHERE t.technician_id = ? AND t.status != 'resolved'
    ORDER BY COALESCE(t.taken_at, t.updated_at, t.created_at) DESC
  `).all(techId);
}

function getOpenTickets() {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address 
    FROM tickets t 
    JOIN customers c ON t.customer_id = c.id 
    WHERE t.status = 'open'
    ORDER BY t.created_at DESC
  `).all();
}

function getResolvedTickets(techId) {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address 
    FROM tickets t 
    JOIN customers c ON t.customer_id = c.id 
    WHERE t.technician_id = ? AND t.status = 'resolved'
    ORDER BY t.updated_at DESC LIMIT 50
  `).all(techId);
}

function takeTicket(ticketId, techId) {
  const validTechId = Number(techId);
  if (!Number.isInteger(validTechId) || validTechId <= 0) throw new Error('Akun teknisi tidak valid');
  const technician = db.prepare('SELECT id FROM technicians WHERE id = ? AND is_active = 1').get(validTechId);
  if (!technician) throw new Error('Akun teknisi tidak aktif atau tidak ditemukan');

  // Klaim atomik: hanya tiket yang masih open dan belum memiliki teknisi yang dapat diambil.
  const result = db.prepare(`
    UPDATE tickets
    SET technician_id = ?, status = 'in_progress', taken_at = (NOW_LOCAL()), updated_at = (NOW_LOCAL())
    WHERE id = ? AND status = 'open' AND technician_id IS NULL
  `).run(validTechId, ticketId);
  if (result.changes === 1) return validTechId;

  const current = db.prepare('SELECT status, technician_id FROM tickets WHERE id = ?').get(ticketId);
  if (!current) throw new Error('Tiket tidak ditemukan');
  if (Number(current.technician_id) === validTechId && current.status !== 'resolved') return validTechId;
  throw new Error('Tiket sudah diambil teknisi lain atau statusnya sudah berubah');
}

function updateTicketStatus(ticketId, techId, status, extraData = {}) {
  const { notes, photos, photoMetadata } = extraData;
  
  const updates = ['status = ?', 'updated_at = (NOW_LOCAL())'];
  const params = [status];
  
  if (techId) {
    updates.push('technician_id = COALESCE(technician_id, ?)');
    params.push(techId);
  }
  if (notes !== undefined) {
    updates.push('technician_notes = ?');
    params.push(notes);
  }
  if (photos !== undefined) {
    updates.push('photos = ?');
    params.push(photos);
  }
  if (photoMetadata !== undefined) {
    updates.push('photo_metadata = ?');
    params.push(photoMetadata);
  }
  
  params.push(ticketId);
  const sql = `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...params);
}

function closeTicket(ticketId, techId) {
  const id = Number(ticketId);
  const technicianId = Number(techId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(technicianId) || technicianId <= 0) {
    throw new Error('ID tiket atau teknisi tidak valid');
  }
  const result = db.prepare(`
    UPDATE tickets
    SET status = 'resolved', updated_at = (NOW_LOCAL())
    WHERE id = ? AND technician_id = ? AND status = 'in_progress'
  `).run(id, technicianId);
  if (result.changes === 1) return true;
  const current = db.prepare('SELECT status, technician_id FROM tickets WHERE id = ?').get(id);
  if (!current) throw new Error('Tiket tidak ditemukan');
  if (Number(current.technician_id) !== technicianId) throw new Error('Tiket ini bukan tugas akun teknisi Anda');
  if (current.status === 'resolved') throw new Error('Tugas ini sudah ditutup sebelumnya');
  throw new Error('Tugas hanya bisa ditutup saat status Sedang Dikerjakan');
}

// Admin helper
function getAllTechnicians() {
  return db.prepare('SELECT id, username, name, phone, area, is_active FROM technicians').all();
}

function createTechnician(data) {
  const stmt = db.prepare('INSERT INTO technicians (username, password, name, phone, area) VALUES (?, ?, ?, ?, ?)');
  return stmt.run(data.username, data.password, data.name, data.phone || '', data.area || '');
}

module.exports = {
  authenticate,
  getTechById,
  getTechStats,
  getAssignedTickets,
  getOpenTickets,
  getResolvedTickets,
  takeTicket,
  updateTicketStatus,
  closeTicket,
  getAllTechnicians,
  createTechnician
};
