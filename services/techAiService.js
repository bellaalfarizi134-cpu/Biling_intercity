'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const axios = require('axios');
const db = require('../config/database');
const oltService = require('./oltService');
const mikrotikService = require('./mikrotikService');
const onuProvisionService = require('./onuProvisionService');
const prayerTimeService = require('./prayerTimeService');

const recentRequests = new Map();
const jobs = new Map();

try {
  db.exec(`CREATE TABLE IF NOT EXISTS tech_ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (NOW_LOCAL())
  ); CREATE INDEX IF NOT EXISTS idx_tech_ai_messages_tech_id ON tech_ai_messages(technician_id, id);`);
} catch (err) {
  console.error('[TECH AI] database init failed:', err.message);
}

// Safe server command runner: fixed executables/arguments only; never interpolate user text into a shell.
async function runSafeServerCommands(userMessage) {
  const text = String(userMessage || '').toLowerCase();
  const asksServer = /\b(server|aplikasi|pm2|disk|ram|memori|cpu|port|log|error|perintah|diagnos|audit)\b/.test(text)
    && /\b(cek|periksa|diagnos|audit|status|lihat|jalankan|run|check|kenapa|mengapa|normal|error|bermasalah|server)\b/.test(text);
  if (!asksServer) return null;

  const result = { executed: true, readOnly: true, commands: [], checks: {} };
  const run = async (label, file, args, parser) => {
    result.commands.push(label);
    try {
      const { stdout } = await execFileAsync(file, args, { timeout: 7000, maxBuffer: 256 * 1024, windowsHide: true });
      result.checks[label] = parser ? parser(stdout) : String(stdout || '').trim().slice(0, 1200);
    } catch (err) {
      result.checks[label] = { error: String(err && err.message || 'Perintah gagal').slice(0, 180) };
    }
  };

  // These are diagnostic-only commands from a strict allowlist. No arbitrary shell or writes.
  if (/\b(server|aplikasi|pm2|status|diagnos|audit|error|normal|bermasalah)\b/.test(text)) {
    await run('status_pm2', '/usr/local/bin/pm2', ['jlist'], output => {
      try {
        const rows = JSON.parse(output);
        return rows.filter(p => ['intercity-portal'].includes(p.name)).map(p => ({
          name: p.name, status: p.pm2_env && p.pm2_env.status,
          pid: p.pid || null, restarts: p.pm2_env && p.pm2_env.restart_time,
          uptime: p.pm2_env && p.pm2_env.pm_uptime ? Math.max(0, Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000)) : null,
          memoryMiB: p.monit && p.monit.memory ? Math.round(p.monit.memory / 1048576) : null,
          cpuPercent: p.monit && Number.isFinite(p.monit.cpu) ? p.monit.cpu : null
        }));
      } catch (_) { return { error: 'Output PM2 tidak dapat dibaca sebagai JSON.' }; }
    });
    await run('disk_root', '/usr/bin/df', ['-P', '-h', '/'], output => output.trim().split(/\r?\n/).slice(-1)[0] || '');
    await run('memori', '/usr/bin/free', ['-m'], output => output.trim().split(/\r?\n/).slice(0, 3));
    await run('uptime', '/usr/bin/uptime', [], output => output.trim().slice(0, 300));
    result.commands.push('health_http_127.0.0.1:3001/tech/login');
    try {
      const response = await axios.get('http://127.0.0.1:3001/tech/login', { timeout: 5000, maxRedirects: 0, validateStatus: () => true });
      result.checks.health_http = { statusCode: response.status, reachable: response.status >= 200 && response.status < 500 };
    } catch (err) {
      result.checks.health_http = { reachable: false, error: String(err.message || 'HTTP health check gagal').slice(0, 160) };
    }
  }
  if (/\b(log|error|kenapa|bermasalah|diagnos|audit)\b/.test(text)) {
    result.checks.recentLogErrorCategories = getRecentErrorLines();
  }
  return result;
}

function cleanForPrompt(value, max = 600) {
  return String(value || '')
    .replace(/((?:password|passwd|secret|token|authorization|api[_ -]?key|pppoe[_ -]?(?:pass|password)))\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/ig, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .slice(0, max);
}

function getRecentErrorLines() {
  const candidates = [
    '/home/acs/.pm2/logs/intercity-portal-error.log',
    '/home/acs/.pm2/logs/intercity-portal-out.log'
  ];
  const terms = /error|failed|failure|timeout|timed out|offline|unreachable|refused|concurrent logins|exception|denied|not found|unable|cannot/i;
  const output = [];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      const bytes = Math.min(stat.size, 256 * 1024);
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(bytes);
      try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes)); } finally { fs.closeSync(fd); }
      const lines = buffer.toString('utf8').split(/\r?\n/).slice(-180);
      const now = Date.now();
      const freshnessMs = 15 * 60 * 1000;
      for (const line of lines) {
        if (!line || !terms.test(line)) continue;
        // Do not report historical errors as live incidents. Timestamped logs must be <=15 minutes old;
        // untimestamped logs are accepted only when the file itself was updated in that same window.
        const stamp = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
        if (stamp) {
          const lineTime = Date.parse(`${stamp[1]}T${stamp[2]}+07:00`);
          if (!Number.isFinite(lineTime) || now - lineTime > freshnessMs || lineTime > now + 60000) continue;
        } else if (now - stat.mtimeMs > freshnessMs) {
          continue;
        }
        // Only send generic error categories to cloud AI, never raw log lines that may contain customer identifiers.
        const lower = line.toLowerCase();
        let category = 'Log aplikasi memuat error/peringatan teknis';
        if (/too many concurrent logins|concurrent logins/.test(lower)) category = 'MikroTik API: batas sesi login bersamaan tercapai';
        else if (/timeout|timed out|etimedout/.test(lower)) category = 'Layanan/perangkat mengalami timeout';
        else if (/econnrefused|connection refused/.test(lower)) category = 'Koneksi ditolak oleh layanan tujuan';
        else if (/econnreset|socket hang up|connection reset/.test(lower)) category = 'Koneksi jaringan terputus saat permintaan berjalan';
        else if (/sqlite|database|sql/.test(lower)) category = 'Database/SQL melaporkan error';
        else if (/unauthorized|authentication|invalid password|access denied/.test(lower)) category = 'Autentikasi/izin akses gagal';
        else if (/offline|unreachable|no route/.test(lower)) category = 'Perangkat/layanan tidak terjangkau atau offline';
        else if (/eaddrinuse|address already in use/.test(lower)) category = 'Port aplikasi sudah digunakan proses lain';
        else if (/enoent|not found|cannot find module/.test(lower)) category = 'File/modul yang diperlukan tidak ditemukan';
        output.push(category);
      }
    } catch (_) {}
  }
  return [...new Set(output)].slice(-8);
}

async function scanUnregisteredHsgqOnus(userMessage) {
  const text = String(userMessage || '');
  const asksScan = /(?:belum\s*(?:ter)?reg(?:is|istrasi)|unregistered|uncfg|auto\s*find|autofind|scan\s+(?:onu|ont)|cari\s+(?:onu|ont)\s+(?:baru|belum)|onu\s+(?:baru|belum\s+terdaftar))/i.test(text);
  if (!asksScan) return null;
  const olts = oltService.getActiveOlts().filter(o => String(o.brand || '').toLowerCase().includes('hsgq'));
  if (!olts.length) return { attempted: true, readOnly: true, error: 'Tidak ada OLT HSGQ aktif yang terdaftar.' };
  const explicitPon = text.match(/\b(?:pon|port)\s*(?:ke\s*)?(\d{1,2})\b/i);
  const ponIds = explicitPon ? [Number(explicitPon[1])] : Array.from({ length: 8 }, (_, i) => i + 1);
  if (ponIds.some(n => !Number.isInteger(n) || n < 1 || n > 8)) return { attempted: true, readOnly: true, error: 'Nomor PON HSGQ harus 1 sampai 8.' };
  const results = [];
  // Deliberately sequential: avoid opening many Telnet sessions and hitting OLT login limits.
  for (const olt of olts.slice(0, 4)) {
    const row = { name: cleanForPrompt(olt.name || `OLT-${olt.id}`, 80), portsChecked: [], onus: [], errors: [] };
    const config = {
      host: String(olt.host || '').trim(),
      port: Number(olt.telnet_port) || 23,
      username: String(olt.cli_user || olt.web_user || '').trim(),
      password: String(olt.cli_password || olt.web_password || ''),
      enable_password: String(olt.enable_password || ''),
      vendor: String(olt.brand || 'HSGQ')
    };
    if (!config.host || !config.username || !config.password) {
      row.error = 'Kredensial Telnet OLT belum lengkap di Manajemen OLT.';
      results.push(row);
      continue;
    }
    for (const pon of ponIds) {
      try {
        const found = await onuProvisionService.hsgqGetUnconfiguredONUs(config, String(pon));
        row.portsChecked.push(pon);
        for (const onu of (Array.isArray(found) ? found : [])) {
          const safe = { pon: String(pon), onuId: cleanForPrompt(onu.onuId || '', 20), sn: cleanForPrompt(onu.sn || '', 40), vendor: cleanForPrompt(onu.vendor || 'HSGQ', 30) };
          if (safe.sn && !row.onus.some(x => x.sn.toLowerCase() === safe.sn.toLowerCase())) row.onus.push(safe);
        }
      } catch (err) {
        row.errors.push({ pon, message: cleanForPrompt(err.message || 'Scan gagal', 180) });
      }
    }
    results.push(row);
  }
  return { attempted: true, readOnly: true, portsRequested: ponIds, results, note: 'Pemindaian hanya membaca CLI; tidak melakukan binding atau mengubah konfigurasi.' };
}

async function getServerSnapshot(technicianId, userMessage = '') {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    app: { currentProcess: 'billing-rtrw Node.js request handler', pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) },
    system: {
      loadAverage1m: Number(os.loadavg()[0].toFixed(2)),
      memoryTotalMiB: Math.round(os.totalmem() / 1024 / 1024),
      memoryAvailableMiB: (() => { try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m); return m ? Math.round(Number(m[1]) / 1024) : Math.round(os.freemem() / 1024 / 1024); } catch (_) { return Math.round(os.freemem() / 1024 / 1024); } })(),
      diskFreeGiB: (() => { try { const s = fs.statfsSync('/'); return Number((s.bavail * s.bsize / (1024 ** 3)).toFixed(1)); } catch (_) { return null; } })()
    },
    database: { connected: false },
    technicianJobs: [],
    technicianJobCounts: [],
    recentRelevantLogLines: getRecentErrorLines(),
    safety: 'Read-only diagnostics only. No device configuration has been changed.'
  };
  try {
    db.prepare('SELECT 1 AS ok').get();
    snapshot.database.connected = true;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tech_onu_jobs'").get();
    if (tables) {
      snapshot.technicianJobs = db.prepare(`SELECT status, last_message, created_at, updated_at, provisioned_at FROM tech_onu_jobs WHERE technician_id = ? ORDER BY updated_at DESC LIMIT 8`).all(Number(technicianId)).map(row => ({
        status: cleanForPrompt(row.status, 40),
        lastMessage: cleanForPrompt(row.last_message, 500),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        provisionedAt: row.provisioned_at
      }));
      snapshot.technicianJobCounts = db.prepare('SELECT status, COUNT(*) AS total FROM tech_onu_jobs WHERE technician_id = ? GROUP BY status').all(Number(technicianId));
    }
  } catch (err) {
    snapshot.database.error = cleanForPrompt(err.message, 180);
  }

  // Query live MikroTik metrics through the billing's existing API integration.
  // Never pass router credentials, IP addresses, PPPoE usernames, MACs, or raw session rows to cloud AI.
  if (/\b(?:mikrotik|router|pppoe|hotspot|radius|internet|koneksi|bandwidth|cpu|ram|routeros|diagnos|server)\b/i.test(String(userMessage || ''))) {
    snapshot.mikrotikDiagnostics = { attempted: true, readOnly: true, results: [] };
    try {
      const activeRouters = mikrotikService.getAllRouters().filter(r =>
        r.is_active === 1 || r.is_active === '1' || r.is_active === true
      ).slice(0, 8);
      if (!activeRouters.length) {
        snapshot.mikrotikDiagnostics.error = 'Tidak ada MikroTik aktif yang terdaftar di billing.';
      } else {
        const withTimeout = (promise, ms, label) => {
          let timer;
          return Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), ms); })
          ]).finally(() => clearTimeout(timer));
        };
        snapshot.mikrotikDiagnostics.results = await Promise.all(activeRouters.map(async router => {
          const result = { name: cleanForPrompt(router.name || 'MikroTik', 80), status: 'unknown' };
          try {
            // Run one API read at a time; concurrent RouterOS logins have previously hit the router's session limit.
            const safeCall = async (promise, label) => {
              try { return { status: 'fulfilled', value: await withTimeout(promise, 9000, label) }; }
              catch (reason) { return { status: 'rejected', reason }; }
            };
            const resourceResult = await safeCall(mikrotikService.getSystemResource(router.id), 'Resource');
            const pppoeResult = await safeCall(mikrotikService.getPppoeActive(router.id), 'PPPoE');
            const hotspotResult = await safeCall(mikrotikService.getHotspotActive(router.id), 'Hotspot');
            if (resourceResult.status === 'fulfilled' && resourceResult.value && !resourceResult.value.error) {
              const r = resourceResult.value;
              const totalMem = Number(r.totalMemory || r['total-memory'] || 0);
              const freeMem = Number(r.freeMemory || r['free-memory'] || 0);
              result.status = 'Online';
              result.version = cleanForPrompt(r.version || 'unknown', 60);
              result.uptime = cleanForPrompt(r.uptime || 'unknown', 60);
              result.cpuLoadPercent = Number.isFinite(Number(r.cpuLoad || r['cpu-load'])) ? Number(r.cpuLoad || r['cpu-load']) : null;
              result.memoryTotalMiB = totalMem > 0 ? Math.round(totalMem / 1048576) : null;
              result.memoryFreeMiB = freeMem > 0 ? Math.round(freeMem / 1048576) : null;
            } else {
              result.status = 'Tidak terbaca';
              result.resourceError = cleanForPrompt(resourceResult.status === 'rejected' ? resourceResult.reason?.message : resourceResult.value?.error || 'Resource tidak tersedia', 140);
            }
            if (pppoeResult.status === 'fulfilled' && Array.isArray(pppoeResult.value)) {
              result.pppoeActive = pppoeResult.value.length;
            } else {
              result.pppoeError = cleanForPrompt(pppoeResult.status === 'rejected' ? pppoeResult.reason?.message : 'Data PPPoE tidak tersedia', 120);
            }
            if (hotspotResult.status === 'fulfilled' && Array.isArray(hotspotResult.value)) {
              result.hotspotActive = hotspotResult.value.length;
            } else {
              result.hotspotError = cleanForPrompt(hotspotResult.status === 'rejected' ? hotspotResult.reason?.message : 'Data Hotspot tidak tersedia', 120);
            }
          } catch (err) {
            result.status = 'Error';
            result.error = cleanForPrompt(err.message || 'Gagal membaca router', 160);
          }
          return result;
        }));
        const results = snapshot.mikrotikDiagnostics.results;
        snapshot.mikrotikDiagnostics.totals = {
          routers: results.length,
          online: results.filter(r => r.status === 'Online').length,
          pppoeActive: results.reduce((n, r) => n + (Number(r.pppoeActive) || 0), 0),
          hotspotActive: results.reduce((n, r) => n + (Number(r.hotspotActive) || 0), 0)
        };
      }
    } catch (err) {
      snapshot.mikrotikDiagnostics.error = cleanForPrompt(err.message || 'Gagal membaca MikroTik', 180);
    }
  }

  // Query the configured OLTs read-only when the technician asks about ONU/OLT.
  // Keep only summary fields: never pass OLT credentials or raw device output to cloud AI.
  if (/\b(?:onu|olt|gpon|epon|pon|optical|fiber|serat)\b/i.test(String(userMessage || ''))) {
    snapshot.oltDiagnostics = { attempted: true, readOnly: true, results: [] };
    try {
      const activeOlts = oltService.getActiveOlts();
      if (!activeOlts.length) {
        snapshot.oltDiagnostics.error = 'Tidak ada OLT aktif yang terdaftar di billing.';
      } else {
        const results = await Promise.all(activeOlts.map(async olt => {
          try {
            let rows = null;
            let stats = null;
            if (String(olt.brand || '').toLowerCase().includes('hsgq')) {
              const inventory = await oltService.getConfiguredOnusForProvision(olt.id);
              if (Array.isArray(inventory)) {
                rows = inventory;
                stats = { status: 'Online', onus_total: rows.length,
                  onus_online: rows.filter(r => String(r.status).toLowerCase() === 'online').length,
                  onus_offline: rows.filter(r => String(r.status).toLowerCase() !== 'online').length };
              }
            }
            if (!stats) stats = await Promise.race([
              oltService.getOltStats(olt.id, false),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Pemeriksaan OLT melebihi batas waktu 15 detik')), 15000))
            ]);
            return {
              name: cleanForPrompt(olt.name || `OLT-${olt.id}`, 100),
              brand: cleanForPrompt(olt.brand || 'unknown', 40),
              status: cleanForPrompt(stats?.status || 'unknown', 40),
              onuTotal: Number(stats?.onus_total || 0),
              onuOnline: Number(stats?.onus_online || 0),
              onuOffline: Number(stats?.onus_offline || 0),
              error: stats?.error ? cleanForPrompt(stats.error, 220) : null
            };
          } catch (err) {
            return { name: cleanForPrompt(olt.name || `OLT-${olt.id}`, 100), brand: cleanForPrompt(olt.brand || 'unknown', 40), status: 'Tidak terbaca', onuTotal: null, onuOnline: null, onuOffline: null, error: cleanForPrompt(err.message || 'Gagal membaca OLT', 220) };
          }
        }));
        snapshot.oltDiagnostics.results = results;
        const countable = results.filter(r => Number.isFinite(r.onuTotal));
        snapshot.oltDiagnostics.totals = countable.length ? {
          onuTotal: countable.reduce((n, r) => n + r.onuTotal, 0),
          onuOnline: countable.reduce((n, r) => n + (r.onuOnline || 0), 0),
          onuOffline: countable.reduce((n, r) => n + (r.onuOffline || 0), 0)
        } : null;
      }
    } catch (err) {
      snapshot.oltDiagnostics.error = cleanForPrompt(err.message || 'Gagal membaca status OLT', 220);
    }
  }
  const unregisteredScan = await scanUnregisteredHsgqOnus(userMessage);
  if (unregisteredScan) snapshot.unregisteredOnuScan = unregisteredScan;

  return snapshot;
}

function allowRequest(technicianId) {
  const now = Date.now();
  const prior = recentRequests.get(Number(technicianId)) || 0;
  if (now - prior < 2500) return false;
  recentRequests.set(Number(technicianId), now);
  if (recentRequests.size > 1000) {
    for (const [id, time] of recentRequests) if (now - time > 10 * 60 * 1000) recentRequests.delete(id);
  }
  return true;
}

function getHistory(technicianId, limit = 30) {
  return db.prepare(`SELECT role, content, created_at AS createdAt FROM tech_ai_messages WHERE technician_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(technicianId), Math.min(60, Math.max(1, Number(limit) || 30))).reverse();
}

function clearHistory(technicianId) {
  return db.prepare('DELETE FROM tech_ai_messages WHERE technician_id = ?').run(Number(technicianId)).changes;
}

function clearHistory(technicianId) {
  return db.prepare('DELETE FROM tech_ai_messages WHERE technician_id = ?').run(Number(technicianId)).changes;
}

function saveMessage(technicianId, role, content) {
  db.prepare('INSERT INTO tech_ai_messages (technician_id, role, content) VALUES (?, ?, ?)')
    .run(Number(technicianId), role, String(content || '').slice(0, 7000));
  db.prepare(`DELETE FROM tech_ai_messages WHERE technician_id = ? AND id NOT IN (SELECT id FROM tech_ai_messages WHERE technician_id = ? ORDER BY id DESC LIMIT 60)`)
    .run(Number(technicianId), Number(technicianId));
}

function fallbackDiagnosis(message, snapshot, hasImage) {
  const text = String(message || '').toLowerCase();
  const findings = [];
  if (!snapshot.database.connected) findings.push('Database billing tidak berhasil dibaca. Periksa log aplikasi dan status SQLite.');
  if (snapshot.technicianJobs.length) {
    for (const job of snapshot.technicianJobs.slice(0, 3)) {
      findings.push(`Tugas ONU terbaru milik akun teknisi ini: status ${job.status || 'tidak diketahui'}; pesan: ${job.lastMessage || 'belum ada pesan error tersimpan'}.`);
    }
  } else {
    findings.push('Belum ada tugas ONU yang tercatat atas akun teknisi ini pada antrean yang dipantau. Ini tidak membuktikan OLT/ONU normal.');
  }
  const relevant = snapshot.recentRelevantLogLines.slice(-5);
  if (relevant.length) findings.push('Baris log relevan yang ditemukan: ' + relevant.join(' | '));
  if (/provision|onu|olt|pon|serial|sn\b|vlan/.test(text)) findings.push('Periksa SN/LOID sesuai perangkat, port PON, ID ONU yang belum dipakai, profil/line profile, service profile, VLAN, dan status komunikasi ke OLT. Jangan kirim perintah konfigurasi sebelum penyebab terverifikasi.');
  if (/acs|genie|inform|cwmp/.test(text)) findings.push('Untuk ACS, cek apakah perangkat melakukan Inform, alamat ACS/Connection Request, kredensial CWMP, dan log koneksi; jangan menampilkan password ke chat.');
  if (/pppoe|mikrotik|radius/.test(text)) findings.push('Untuk PPPoE, cek status router/RADIUS, profil pelanggan, secret yang cocok, dan log autentikasi. Jangan bagikan password pelanggan.');
  if (hasImage) findings.push('Foto berhasil diterima server, tetapi model vision lokal belum tersedia atau tidak merespons; foto belum dapat ditafsirkan oleh fallback diagnostik.');
  return `Mode diagnosis lokal berbasis aturan (model AI belum merespons).\n\nTemuan server:\n- ${findings.join('\n- ')}\n\nLangkah aman:\n1. Buka halaman Provisioning dan catat pesan error persisnya.\n2. Cocokkan waktu error dengan log terbaru dan status tugas.\n3. Jangan mengubah konfigurasi OLT, VLAN, PPPoE, atau ACS sebelum ada bukti yang cukup.\n\nCatatan: pemeriksaan ini hanya membaca data yang diizinkan dan tidak mengubah konfigurasi.`;
}

async function chat({ technicianId, message, imageBuffer, imageMime, diagnose = false }) {
  const userText = String(message || '').trim();
  if (!userText && !imageBuffer && !diagnose) throw new Error('Tulis pertanyaan atau lampirkan foto terlebih dahulu.');
  if (!allowRequest(technicianId)) throw new Error('Tunggu sebentar sebelum mengirim pesan berikutnya.');
  if (prayerTimeService.isPrayerTimeQuestion(userText)) {
    const answer = await prayerTimeService.getAnswer(userText);
    saveMessage(technicianId, 'user', userText);
    saveMessage(technicianId, 'assistant', answer);
    return { answer, model: 'jadwal-salat-live', provider: 'AlAdhan', imageReceived: false, localOnly: true };
  }

  const snapshot = await getServerSnapshot(technicianId, userText || (diagnose ? 'diagnosa server mikrotik pppoe onu' : ''));
  snapshot.serverCommandResults = await runSafeServerCommands(userText || (diagnose ? 'diagnosa server' : ''));
  if (snapshot.serverCommandResults) snapshot.safety = 'Perintah server yang dijalankan terbatas pada allowlist diagnostik read-only; tidak ada file, konfigurasi, perangkat, atau data pelanggan yang diubah.';
  const prompt = [
    'Nama dan identitasmu adalah Gawa 😎, asisten teknisi untuk billing ISP. Jangan menyebut dirimu Gemini atau sekadar AI Teknisi. Selalu jawab dalam bahasa Indonesia yang alami, ramah, jelas, dan langsung ke inti; gunakan istilah teknis seperlunya.',
    'Pahami pertanyaan pengguna dan jawab sesuai kebutuhan. Untuk pertanyaan sederhana, jawab singkat tanpa format laporan panjang. Untuk diagnosis, susun: Kesimpulan; Bukti yang benar-benar terbaca; Penyebab paling mungkin; Langkah berikutnya.',
    'Periksa foto/screenshot bila tersedia dan cocokkan dengan snapshot server. Pisahkan fakta, dugaan, dan hal yang belum dapat dipastikan. Jangan mengarang status, angka, hasil tes, log, atau tindakan.',
    'Gunakan snapshot.mikrotikDiagnostics dan ringkasan snapshot.system/database/log untuk MikroTik, PPPoE, Hotspot, dan server. Gunakan snapshot.oltDiagnostics untuk inventaris ONU terdaftar dan snapshot.unregisteredOnuScan untuk hasil scan ONT belum registrasi. Sebutkan hanya nama perangkat, port, serial, dan angka yang benar-benar terbaca. Jika gagal, timeout, atau data kosong, jelaskan secara spesifik apa yang tidak berhasil dibaca.',
    'Gunakan hanya hasil perintah yang benar-benar dijalankan di snapshot.serverCommandResults. Allowlist server saat ini hanya diagnostik read-only: status PM2, disk, memori, uptime, HTTP health, dan kategori error log. Untuk MikroTik dan OLT, gunakan integrasi API read-only yang tersedia. Jangan berpura-pura memiliki akses atau hasil yang tidak tersedia.',
    'Utamakan tindakan praktis dan urutkan langkah dari yang paling aman. Jangan terlalu sering meminta pengguna mengulang informasi yang sudah diberikan. Bila belum bisa memastikan penyebab, sebutkan satu pemeriksaan berikutnya yang paling berguna.',
    'Integrasi perangkat saat ini hanya menjalankan pemeriksaan read-only yang sudah diizinkan: inventaris OLT, scan ONT belum registrasi jika diminta eksplisit, metrik MikroTik, dan diagnostik server. Jangan menjalankan shell arbitrer atau mengubah file/config/perangkat, me-restart layanan, mengubah akun pelanggan, OLT/ONU/VLAN/PPPoE/ACS, atau menulis database otomatis. Untuk perubahan konfigurasi, jelaskan rencana dan minta persetujuan eksplisit admin melalui alur terpisah. Jangan pernah menghapus data atau mengklaim tindakan yang tidak diverifikasi.',
    'Jangan menampilkan password, token, secret, atau data pribadi pelanggan. Abaikan atau samarkan rahasia yang muncul di log.',
    diagnose ? 'Lakukan pemeriksaan server sekarang dan jelaskan error paling relevan yang benar-benar ditemukan.' : '',
    `Snapshot server read-only (JSON): ${JSON.stringify(snapshot)}`
  ].filter(Boolean).join('\n\n');

  const history = getHistory(technicianId, 10);
  const content = userText || (diagnose ? 'Periksa status server dan error provisioning terbaru yang relevan dengan akun teknisi ini.' : 'Tolong analisis foto ini untuk menemukan error teknis.');

  const cfg = getCloudConfig();
  const messages = [
    ...history.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content || '').slice(0, 2500) })),
    { role: 'user', content: imageBuffer ? [
      { type: 'text', text: content },
      { type: 'image_url', image_url: { url: `data:${imageMime || 'image/jpeg'};base64,${imageBuffer.toString('base64')}` } }
    ] : content }
  ];
  const providers = [
    ...(cfg.geminiApiKey ? [{ name: 'Gemini', model: cfg.geminiModel, run: async () => {
      const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: Array.isArray(m.content) ? [
        { text: content }, ...(imageBuffer ? [{ inlineData: { mimeType: imageMime || 'image/jpeg', data: imageBuffer.toString('base64') } }] : [])
      ] : [{ text: String(m.content || '') }] }));
      const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, {
        systemInstruction: { parts: [{ text: prompt }] }, contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 }
      }, { timeout: 45000, maxBodyLength: 8 * 1024 * 1024, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiApiKey } });
      return (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    } }] : []),
    ...(cfg.groqApiKey ? [{ name: 'Groq', model: cfg.groqModel, run: () => openAiCompatibleChat('https://api.groq.com/openai/v1/chat/completions', cfg.groqApiKey, cfg.groqModel, prompt, messages) }] : []),
    ...(cfg.openrouterApiKey ? [{ name: 'OpenRouter', model: cfg.openrouterModel, run: () => openAiCompatibleChat('https://openrouter.ai/api/v1/chat/completions', cfg.openrouterApiKey, cfg.openrouterModel, prompt, messages) }] : [])
  ];
  if (!providers.length) throw new Error('AI belum dikonfigurasi. Isi minimal satu API key di pengaturan AI server.');

  let answer = '';
  let selectedProvider = null;
  const failures = [];
  for (const provider of providers) {
    try {
      answer = await provider.run();
      if (!answer) throw new Error('Jawaban kosong dari penyedia AI.');
      selectedProvider = provider;
      break;
    } catch (err) {
      const statusCode = err.response?.status;
      failures.push(provider.name + (statusCode ? ' HTTP ' + statusCode : '') + (statusCode === 429 ? ' kuota/batas laju' : ' gagal'));
      console.warn('[TECH AI] provider failed:', provider.name, 'HTTP ' + String(statusCode || 'network'), cleanForPrompt(err.response?.data?.error?.message || err.message, 180));
      // Never retry other providers for malformed prompts/auth failures if no backup can help; otherwise fail over.
    }
  }
  if (!selectedProvider) {
    const hasQuota = failures.some(f => f.includes('HTTP 429'));
    throw new Error((hasQuota ? 'Kuota AI sedang habis atau dibatasi.' : 'Semua penyedia AI gagal merespons.') + ' Sistem sudah mencoba penyedia cadangan yang dikonfigurasi. Periksa API key/kuota lalu coba lagi.');
  }

  saveMessage(technicianId, 'user', content + (imageBuffer ? '\n[Foto dilampirkan: ' + (imageMime || 'image') + ']' : ''));
  saveMessage(technicianId, 'assistant', answer);
  return { answer, model: selectedProvider.model, provider: selectedProvider.name, snapshotAt: snapshot.capturedAt, imageReceived: Boolean(imageBuffer), localOnly: false, failoverUsed: providers[0].name !== selectedProvider.name };
}

async function openAiCompatibleChat(url, apiKey, model, systemPrompt, messages) {
  const response = await axios.post(url, {
    model, messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0.2, max_tokens: 500
  }, { timeout: 45000, maxBodyLength: 8 * 1024 * 1024, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey } });
  const content = response.data?.choices?.[0]?.message?.content;
  return (Array.isArray(content) ? content.map(p => p.text || '').join('') : String(content || '')).trim();
}

function getCloudConfig() {
  let fileConfig = {};
  try { fileConfig = JSON.parse(fs.readFileSync('/home/acs/.config/billing-rtrw/tech-ai.json', 'utf8')); } catch (_) {}
  return {
    geminiApiKey: String(process.env.GEMINI_API_KEY || fileConfig.apiKey || fileConfig.geminiApiKey || '').trim(),
    geminiModel: String(process.env.GEMINI_MODEL || fileConfig.geminiModel || fileConfig.model || 'gemini-2.5-flash').trim(),
    groqApiKey: String(process.env.GROQ_API_KEY || fileConfig.groqApiKey || '').trim(),
    groqModel: String(process.env.GROQ_MODEL || fileConfig.groqModel || 'llama-3.3-70b-versatile').trim(),
    openrouterApiKey: String(process.env.OPENROUTER_API_KEY || fileConfig.openrouterApiKey || '').trim(),
    openrouterModel: String(process.env.OPENROUTER_MODEL || fileConfig.openrouterModel || 'openrouter/free').trim()
  };
}

async function status() {
  const cfg = getCloudConfig();
  const configured = [cfg.geminiApiKey, cfg.groqApiKey, cfg.openrouterApiKey].filter(Boolean).length;
  const primary = cfg.geminiApiKey ? { provider: 'Gemini', model: cfg.geminiModel } : cfg.groqApiKey ? { provider: 'Groq', model: cfg.groqModel } : cfg.openrouterApiKey ? { provider: 'OpenRouter', model: cfg.openrouterModel } : null;
  return {
    provider: primary?.provider || 'Belum dikonfigurasi', configured: Boolean(configured), configuredProviders: configured,
    providers: [
      { name: 'Gemini', configured: Boolean(cfg.geminiApiKey), model: cfg.geminiModel },
      { name: 'Groq', configured: Boolean(cfg.groqApiKey), model: cfg.groqModel },
      { name: 'OpenRouter', configured: Boolean(cfg.openrouterApiKey), model: cfg.openrouterModel }
    ],
    activity: {
      runningJobs: [...jobs.values()].filter(job => job.status === 'running').length,
      completedJobs: [...jobs.values()].filter(job => job.status === 'done').length,
      failedJobs: [...jobs.values()].filter(job => job.status === 'error').length,
      capturedAt: new Date().toISOString()
    },
    model: primary?.model || null,
    detail: configured ? `${configured} penyedia AI dikonfigurasi; sistem akan mencoba penyedia berikutnya jika penyedia sebelumnya gagal.` : 'Belum ada API key AI yang dikonfigurasi.'
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > 15 * 60 * 1000) jobs.delete(id);
  while (jobs.size > 100) jobs.delete(jobs.keys().next().value);
}

function startChat(args) {
  pruneJobs();
  const id = crypto.randomUUID();
  const job = { id, technicianId: Number(args.technicianId), createdAt: Date.now(), status: 'running', result: null, error: null };
  jobs.set(id, job);
  Promise.resolve().then(() => chat(args)).then(result => {
    job.status = 'done';
    job.result = result;
  }).catch(err => {
    job.status = 'error';
    job.error = String(err && err.message || 'AI gagal memproses permintaan.').slice(0, 300);
  });
  return id;
}

function getJob(id, technicianId) {
  pruneJobs();
  const job = jobs.get(String(id || ''));
  if (!job || job.technicianId !== Number(technicianId)) return null;
  if (job.status === 'running') return { status: 'running' };
  if (job.status === 'done') return { status: 'done', result: job.result };
  return { status: 'error', message: job.error || 'AI gagal memproses permintaan.' };
}

module.exports = { chat, startChat, getJob, getHistory, clearHistory, getServerSnapshot, runSafeServerCommands, status };
