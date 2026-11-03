'use strict';

const mikrotikService = require('./mikrotikService');

// Traffic gauges use one shared router snapshot, rather than logging in once per
// customer/browser. The snapshot is refreshed by mikrotikService at most once per
// short cache window and concurrent refreshes are coalesced there.
const samples = new Map();
const SAMPLE_RETENTION_MS = 5 * 60 * 1000;

function readCounter(row, keys) {
  for (const key of keys) {
    const value = row && (row[key] ?? row[String(key).toLowerCase()]);
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return { found: true, value: number };
  }
  return { found: false, value: 0 };
}

function pruneSamples(now) {
  for (const [key, sample] of samples.entries()) {
    if (!sample || !sample.sampleAt || now - sample.sampleAt > SAMPLE_RETENTION_MS) samples.delete(key);
  }
}

function warmupResult(username, session, snapshot, stale = false) {
  return {
    ok: true,
    available: true,
    online: true,
    warmup: true,
    stale: Boolean(stale),
    username,
    iface: String(session && (session.interface || session.iface || session.name) || ''),
    uptime: String(session && session.uptime || ''),
    source: 'shared-pppoe-snapshot',
    checkedAt: snapshot && snapshot.checkedAt || null,
    rxMbps: 0,
    txMbps: 0
  };
}

async function getCustomerTraffic(routerId, usernameInput) {
  const username = String(usernameInput || '').trim();
  const userKey = username.toLowerCase();
  if (!username) return { ok: true, available: false, online: false, username: null, rxMbps: 0, txMbps: 0 };

  const snapshot = await mikrotikService.getPppoeActiveSnapshot(routerId, 25000);
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.rows)) {
    return {
      ok: false,
      available: false,
      online: false,
      stale: true,
      username,
      rxMbps: 0,
      txMbps: 0,
      error: String(snapshot && snapshot.error || 'Status PPPoE belum berhasil dibaca.')
    };
  }

  const session = snapshot.rows.find(row =>
    String(row && (row.name || row.user) || '').trim().toLowerCase() === userKey
  );
  const sampleKey = String(routerId == null || routerId === '' ? 'default' : routerId) + ':' + userKey;
  const now = Date.now();
  pruneSamples(now);

  if (!session) {
    if (!snapshot.stale) samples.delete(sampleKey);
    return {
      ok: true,
      available: true,
      online: false,
      stale: Boolean(snapshot.stale),
      username,
      checkedAt: snapshot.checkedAt || null,
      rxMbps: 0,
      txMbps: 0
    };
  }

  const rxCounter = readCounter(session, ['bytes-out', 'bytesOut', 'bytes_out', 'tx-byte', 'txByte', 'txBytes']);
  const txCounter = readCounter(session, ['bytes-in', 'bytesIn', 'bytes_in', 'rx-byte', 'rxByte', 'rxBytes']);
  const callerId = String(session['caller-id'] || session.callerId || session['mac-address'] || '');
  const address = String(session.address || session['remote-address'] || '');
  const iface = String(session.interface || session.iface || '');
  const sessionId = [String(session['.id'] || session.id || username), address, callerId, iface].join('|');
  const sampleAt = Date.parse(String(snapshot.checkedAt || '')) || now;
  const previous = samples.get(sampleKey);

  if (snapshot.stale) {
    // Never calculate a new rate from old counters. Return the last rate as stale,
    // or a zero-rate warm-up if this process has not observed this session before.
    if (previous && previous.sessionId === sessionId && previous.result) {
      return { ...previous.result, stale: true };
    }
    return warmupResult(username, session, snapshot, true);
  }

  // Several browser views may request the same customer against the same router
  // sample. Reuse the computed rate rather than advancing the sample multiple times.
  if (previous && previous.sampleAt === sampleAt && previous.sessionId === sessionId && previous.result) {
    return { ...previous.result, stale: false };
  }

  if (!rxCounter.found || !txCounter.found || !previous || previous.sessionId !== sessionId || sampleAt <= previous.sampleAt) {
    const result = warmupResult(username, session, snapshot, false);
    if (rxCounter.found && txCounter.found) {
      samples.set(sampleKey, {
        sampleAt,
        sessionId,
        rxBytes: rxCounter.value,
        txBytes: txCounter.value,
        result
      });
    }
    return result;
  }

  const dtSeconds = (sampleAt - previous.sampleAt) / 1000;
  const deltaRx = rxCounter.value - previous.rxBytes;
  const deltaTx = txCounter.value - previous.txBytes;
  if (!(dtSeconds > 0) || deltaRx < 0 || deltaTx < 0) {
    const result = warmupResult(username, session, snapshot, false);
    samples.set(sampleKey, { sampleAt, sessionId, rxBytes: rxCounter.value, txBytes: txCounter.value, result });
    return result;
  }

  const result = {
    ok: true,
    available: true,
    online: true,
    warmup: false,
    stale: false,
    username,
    iface: iface || null,
    uptime: String(session.uptime || ''),
    source: 'shared-pppoe-snapshot',
    checkedAt: snapshot.checkedAt || null,
    rxMbps: (deltaRx * 8) / dtSeconds / 1e6,
    txMbps: (deltaTx * 8) / dtSeconds / 1e6
  };
  if (!Number.isFinite(result.rxMbps)) result.rxMbps = 0;
  if (!Number.isFinite(result.txMbps)) result.txMbps = 0;
  samples.set(sampleKey, { sampleAt, sessionId, rxBytes: rxCounter.value, txBytes: txCounter.value, result });
  return result;
}

module.exports = { getCustomerTraffic };
