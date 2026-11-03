const mikrotikService = require('./mikrotikService');
const db = require('../config/database');

// A one-minute cache prevents duplicate API sessions when admin and technician maps
// are opened together. Once stale, requests wait for one shared refresh so the map
// does not keep showing an old PPPoE state after the router data has changed.
let cache = { at: 0, data: null };
let inFlight = null;
const CACHE_MS = 60 * 1000;

// Keep the last successful PPPoE observation across a portal restart. If RouterOS
// temporarily refuses an API login, the map can retain known colors and explicitly
// mark them stale rather than painting every customer unknown.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS network_map_pppoe_snapshot (
    router_id INTEGER PRIMARY KEY,
    active_sessions_json TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
} catch (error) {
  console.warn('[NETWORK MAP] persistent PPPoE snapshot table unavailable:', String(error.message || error));
}

function savePersistentPppoeSnapshot(routerId, activeUsernames, checkedAt) {
  try {
    db.prepare(`INSERT INTO network_map_pppoe_snapshot (router_id, active_sessions_json, checked_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(router_id) DO UPDATE SET active_sessions_json=excluded.active_sessions_json,
        checked_at=excluded.checked_at, updated_at=CURRENT_TIMESTAMP`)
      .run(Number(routerId), JSON.stringify(activeUsernames), String(checkedAt || new Date().toISOString()));
  } catch (error) {
    console.warn('[NETWORK MAP] gagal menyimpan snapshot PPPoE router #' + Number(routerId) + ': ' + String(error.message || error));
  }
}

function getPersistentPppoeSnapshot(routerId) {
  try {
    const row = db.prepare('SELECT active_sessions_json,checked_at FROM network_map_pppoe_snapshot WHERE router_id=? LIMIT 1').get(Number(routerId));
    if (!row) return null;
    const names = JSON.parse(row.active_sessions_json || '[]');
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return null;
    return { usernames: names, checkedAt: String(row.checked_at || '') };
  } catch (error) {
    console.warn('[NETWORK MAP] gagal membaca snapshot PPPoE router #' + Number(routerId) + ': ' + String(error.message || error));
    return null;
  }
}

async function readLivePppoeSnapshot() {
  const routers = mikrotikService.getAllRouters();
  const routerStatus = {};
  const activeSessions = [];
  const staleRouterIds = [];
  const checkedTimes = [];

  routers.forEach(router => {
    const id = String(Number(router.id));
    const enabled = Number(router.is_active) === 1 || router.is_active === true || router.is_active === '1';
    routerStatus[id] = enabled ? 'unknown' : 'disabled';
  });

  const enabledRouters = routers.filter(router =>
    Number(router.is_active) === 1 || router.is_active === true || router.is_active === '1'
  );

  // Reuse the same PPPoE active-session cache as billing/ACS/diagnostics. This
  // prevents the map from opening a competing API login every minute. The service
  // also coalesces simultaneous reads for a given router and reports stale data.
  await Promise.all(enabledRouters.map(async router => {
    const routerId = Number(router.id);
    const id = String(routerId);
    const keyPrefix = id + ':';
    try {
      if (typeof mikrotikService.getPppoeActiveSnapshot !== 'function') {
        throw new Error('Snapshot PPPoE bersama belum tersedia.');
      }
      const result = await mikrotikService.getPppoeActiveSnapshot(routerId, CACHE_MS);
      if (!result || !result.ok || !Array.isArray(result.rows)) {
        const saved = getPersistentPppoeSnapshot(routerId);
        if (saved) {
          routerStatus[id] = 'stale';
          staleRouterIds.push(id);
          if (saved.checkedAt) checkedTimes.push(saved.checkedAt);
          saved.usernames.forEach(username => activeSessions.push(keyPrefix + String(username).trim().toLowerCase()));
          console.warn('[NETWORK MAP] memakai snapshot PPPoE tersimpan untuk router #' + id + ' karena pembacaan baru gagal: ' + String(result && result.error || 'tidak ada data valid'));
        } else {
          routerStatus[id] = 'unknown';
          console.warn('[NETWORK MAP] status PPPoE belum terbaca pada router #' + id + ': ' + String(result && result.error || 'tidak ada data valid dan belum ada snapshot tersimpan'));
        }
        return;
      }
      routerStatus[id] = result.stale ? 'stale' : 'ok';
      if (result.stale) staleRouterIds.push(id);
      if (result.checkedAt) checkedTimes.push(String(result.checkedAt));
      const activeUsernames = [];
      result.rows.forEach(row => {
        const username = String(row && (row.name || row.user) || '').trim().toLowerCase();
        if (username) {
          activeSessions.push(keyPrefix + username);
          activeUsernames.push(username);
        }
      });
      if (!result.stale && result.checkedAt) savePersistentPppoeSnapshot(routerId, activeUsernames, result.checkedAt);
      if (result.stale) {
        console.warn('[NETWORK MAP] memakai status PPPoE terakhir untuk router #' + id + ': ' + String(result.error || 'data snapshot sudah usang'));
      }
    } catch (error) {
      routerStatus[id] = 'unknown';
      console.warn('[NETWORK MAP] status PPPoE tidak bisa diperiksa pada router #' + id + ': ' + String(error.message || error));
    }
  }));

  // If any router is using a previous successful snapshot, show its original
  // observation time, not the time this map request happened.
  const checkedAt = checkedTimes.sort()[0] || null;
  return {
    checkedAt,
    attemptedAt: new Date().toISOString(),
    routerStatus,
    activeSessions,
    staleRouterIds,
    stale: staleRouterIds.length > 0
  };
}

async function refreshLivePppoeSnapshot() {
  if (inFlight) return inFlight;
  inFlight = readLivePppoeSnapshot()
    .then(data => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function cachedMapHasRecoverableStatus() {
  if (!cache.data || !cache.data.routerStatus) return false;
  // Another billing feature may successfully refresh PPPoE after the map's first
  // read was rejected. If that success created a persistent snapshot, refresh now
  // instead of returning the map's short-lived all-unknown result for a full minute.
  return Object.entries(cache.data.routerStatus).some(([routerId, state]) =>
    state === 'unknown' && Boolean(getPersistentPppoeSnapshot(Number(routerId)))
  );
}

async function getLivePppoeSnapshot() {
  // Fresh snapshots normally return immediately. An unknown snapshot can be
  // recovered right away if another successful reader has since saved a last-good
  // snapshot for that router. Stale/known snapshots remain cached to avoid login spam.
  if (cache.data && Date.now() - cache.at < CACHE_MS && !cachedMapHasRecoverableStatus()) return cache.data;
  if (cache.data) return refreshLivePppoeSnapshot();
  return refreshLivePppoeSnapshot();
}

// Refresh PPPoE sessions in the background every minute. This keeps a
// recent snapshot ready before a technician opens the map.
const pppoeRefreshTimer = setInterval(() => {
  refreshLivePppoeSnapshot().catch(error => {
    console.warn('[NETWORK MAP] refresh berkala status PPPoE gagal:', String(error.message || error));
  });
}, CACHE_MS);
if (pppoeRefreshTimer && typeof pppoeRefreshTimer.unref === 'function') pppoeRefreshTimer.unref();
setTimeout(() => {
  refreshLivePppoeSnapshot().catch(error => {
    console.warn('[NETWORK MAP] pemanasan awal status PPPoE gagal:', String(error.message || error));
  });
}, 0).unref?.();

async function getMapLinkStatus() {
  const [snapshot, customers] = await Promise.all([
    getLivePppoeSnapshot(),
    Promise.resolve(db.prepare('SELECT id, router_id, pppoe_username, odp_id, status, pppoe_profile, isolir_profile FROM customers').all())
  ]);
  const activeSet = new Set(snapshot.activeSessions);
  const customerStates = {};
  const odpStates = {};

  customers.forEach(customer => {
    const customerId = String(Number(customer.id));
    const username = String(customer.pppoe_username || '').trim().toLowerCase();
    const routerId = Number(customer.router_id);
    const status = String(customer.status || '').trim().toLowerCase();
    const profile = String(customer.pppoe_profile || '').trim().toLowerCase();
    const isolationProfile = String(customer.isolir_profile || 'isolir').trim().toLowerCase();
    const isolated = ['suspended', 'isolir', 'isolated', 'inactive', 'ditangguhkan'].includes(status)
      || profile === 'isolir'
      || Boolean(isolationProfile && profile && profile === isolationProfile)
      || /^\[isolir\]/i.test(String(customer.pppoe_username || '').trim());
    // Show real PPPoE session state independently from billing/profile isolation.
    // `state` still hides isolated accounts from physical path alarms; `pppoeState`
    // is the display-only session result requested by the map popup.
    let pppoeState = 'unknown';
    let pppoeReason = '';
    if (!username) {
      pppoeReason = 'username_missing';
    } else if (!Number.isSafeInteger(routerId) || routerId <= 0) {
      pppoeReason = 'router_missing';
    } else if (snapshot.routerStatus[String(routerId)] === 'ok' || snapshot.routerStatus[String(routerId)] === 'stale') {
      pppoeState = activeSet.has(String(routerId) + ':' + username) ? 'online' : 'offline';
    } else if (snapshot.routerStatus[String(routerId)] === 'disabled') {
      pppoeReason = 'router_disabled';
    } else {
      pppoeReason = 'router_unavailable';
    }
    const state = isolated ? 'isolated' : pppoeState;
    customerStates[customerId] = {
      state,
      pppoeState,
      pppoeReason,
      stale: snapshot.routerStatus[String(routerId)] === 'stale'
    };

    // Isolated accounts are intentionally not cabled on this map and must not
    // make their ODP appear broken. Count only customers that are not isolated.
    if (isolated) return;
    const odpId = Number(customer.odp_id);
    if (!Number.isSafeInteger(odpId) || odpId <= 0) return;
    if (!odpStates[String(odpId)]) odpStates[String(odpId)] = { totalCount: 0, onlineCount: 0, offlineCount: 0, unknownCount: 0, isolatedCount: 0, alert: false };
    const item = odpStates[String(odpId)];
    item.totalCount++;
    if (state === 'online') item.onlineCount++;
    else if (state === 'offline') item.offlineCount++;
    else item.unknownCount++;
  });

  Object.values(odpStates).forEach(item => {
    // Backbone ODP→ODC is only red when every non-isolated mapped customer is
    // confirmed offline. One online customer means the shared path stays normal.
    // Unknown states prevent false alarms because the whole ODP is not verified.
    item.alert = item.offlineCount > 0 && item.onlineCount === 0 && item.unknownCount === 0;
  });

  return {
    ok: true,
    checkedAt: snapshot.checkedAt,
    attemptedAt: snapshot.attemptedAt,
    stale: Boolean(snapshot.stale),
    staleRouterIds: snapshot.staleRouterIds || [],
    routerStatus: snapshot.routerStatus,
    customers: customerStates,
    odps: odpStates
  };
}

module.exports = { getLivePppoeSnapshot, getMapLinkStatus };
