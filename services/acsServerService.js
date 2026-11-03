/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Built-in ACS Server Service  (TR-069 / CWMP)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Handles CWMP SOAP communication with CPE devices (ONUs / routers) directly
 * within the billing application – no external GenieACS required.
 *
 * Protocol flow:
 *   1. CPE  → POST Inform        → ACS responds InformResponse
 *   2. CPE  → POST Empty         → ACS sends queued task  (or 204)
 *   3. CPE  → POST TaskResponse  → ACS marks task, sends next or 204
 *
 * Exports:
 *   handleCwmpRequest        – Express handler for POST /acs
 *   triggerConnectionRequest – Kick a CPE to reconnect
 *   getBuiltinDevices        – Query acs_devices
 *   getBuiltinDevice         – Single device lookup
 *   createBuiltinTask        – Insert task + trigger CR
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting, getNowLocal } = require('../config/settingsManager');

// Versioned bootstrap migration — retry discovery only for devices missing key telemetry.
try {
  const BOOTSTRAP_VERSION = 4; // Existing generation; ongoing telemetry discovery remains read-only
  const migRow = db.prepare("SELECT value FROM app_settings WHERE key = 'acs_bootstrap_version'").get();
  const currentVersion = migRow ? parseInt(migRow.value, 10) : 0;
  if (currentVersion < BOOTSTRAP_VERSION) {
    const devices = db.prepare('SELECT id, tags, manufacturer, product_class, params FROM acs_devices').all();
    let resetCount = 0;
    for (const dev of devices) {
      let tags = [];
      let params = {};
      try { tags = JSON.parse(dev.tags || '[]'); } catch (_) {}
      try { params = JSON.parse(dev.params || '{}'); } catch (_) {}
      if (!tags.includes('bootstrapped')) continue;
      const entries = Object.entries(params || {});
      const hasSsid = entries.some(([key, value]) =>
        /(?:WLANConfiguration\.\d+\.SSID|Device\.WiFi\.SSID\.\d+\.SSID)$/i.test(key) &&
        value !== null && value !== undefined && String(value).trim() !== '' && String(value) !== '-'
      );
      const isLikelyOnt = /fiberhome|zte|cmhi|huawei|rteg|tm|hwtc|zicg|cmdc/i.test(String(dev.manufacturer || ''))
        || /HG60|HG61|HG81|F609|F660|F663|F670|XPON/i.test(String(dev.product_class || ''));
      const hasRx = entries.some(([key, value]) =>
        /(?:RXPower|RxPower|ReceivePower|ReceiveSignalLevel|OpticalSignalLevel|redaman)$/i.test(key) &&
        value !== null && value !== undefined && String(value).trim() !== '' && String(value) !== '-'
      );
      if (!hasSsid || (isLikelyOnt && hasSsid && !hasRx)) {
        tags = tags.filter(tag => tag !== 'bootstrapped');
        db.prepare('UPDATE acs_devices SET tags = ? WHERE id = ?').run(JSON.stringify(tags), dev.id);
        resetCount++;
      }
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('acs_bootstrap_version', ?)").run(String(BOOTSTRAP_VERSION));
    logger.info(`[ACS] Bootstrap migration v${BOOTSTRAP_VERSION} completed — scheduled rediscovery for ${resetCount} incomplete device(s)`);
  }
} catch (err) {
  logger.error(`[ACS] Failed bootstrap migration: ${err.message}`);
}

// Retire read-only ACS requests that were already sent but never received a response.
// CWMP sessions expire well before 15 minutes; keeping an in-progress read forever
// blocks fresh discovery after reconnects. Keep history and do not touch configuration tasks.
try {
  const staleReadResult = JSON.stringify({ maintenance: 'stale read-only ACS task expired after 15 minutes; history retained' });
  const staleReadCount = db.prepare(
    `UPDATE acs_tasks
     SET status = 'failed', result = COALESCE(NULLIF(result, ''), ?), updated_at = ?
     WHERE status = 'in_progress'
       AND name IN ('getParameterValues', 'getParameterNames', 'refreshObject')
       AND julianday(updated_at) < julianday('now', '-15 minutes')`
  ).run(staleReadResult, nowLocal()).changes;
  if (staleReadCount) logger.warn(`[ACS] Expired ${staleReadCount} stale in-progress read-only task(s); task history retained`);
} catch (err) {
  logger.error(`[ACS] Failed stale read-only task cleanup: ${err.message}`);
}

// Pending read-only requests older than 24 hours must not block the device queue.
// These tasks only read CWMP parameters; configuration/write tasks are excluded.
function expireStalePendingReadOnlyTasks() {
  try {
    const result = JSON.stringify({
      maintenance: 'pending read-only ACS task expired after 24 hours; task history retained; no ONU configuration changed'
    });
    const changed = db.prepare(
      `UPDATE acs_tasks
       SET status = 'failed', result = COALESCE(NULLIF(result, ''), ?), updated_at = ?
       WHERE status = 'pending'
         AND name IN ('getParameterValues', 'getParameterNames', 'refreshObject')
         AND julianday(created_at) < julianday('now', '-24 hours')`
    ).run(result, nowLocal()).changes;
    if (changed) logger.warn(`[ACS] Retired ${changed} stale pending read-only task(s) older than 24 hours; history retained`);
  } catch (err) {
    logger.error(`[ACS] Failed stale pending read-only task cleanup: ${err.message}`);
  }
}
expireStalePendingReadOnlyTasks();
const stalePendingReadTimer = setInterval(expireStalePendingReadOnlyTasks, 60 * 60 * 1000);
if (typeof stalePendingReadTimer.unref === 'function') stalePendingReadTimer.unref();

// Retain new client-discovery tasks. Only retire monitoring probes that have been
// stuck for more than 24 hours; never delete fresh AssociatedDevice/Host reads on restart.
try {
  db.prepare(
    `UPDATE acs_tasks
     SET status = 'failed',
         result = COALESCE(result, ?),
         updated_at = ?
     WHERE status IN ('pending', 'in_progress')
       AND name IN ('getParameterValues', 'getParameterNames', 'refreshObject')
       AND (
         payload LIKE '%WLANConfiguration.5.AssociatedDevice%' OR
         payload LIKE '%WLANConfiguration.5.TotalAssociations%' OR
         payload LIKE '%WLANConfiguration.5.AssociatedDeviceNumberOfEntries%' OR
         payload LIKE '%Hosts.HostNumberOfEntries%' OR
         payload LIKE '%AssociatedDeviceNumberOfEntries%'
       )
       AND julianday(updated_at) < julianday('now', '-24 hours')`
  ).run(JSON.stringify({ maintenance: 'stale monitoring probe retired after 24 hours; history retained' }), nowLocal());
} catch (err) {
  logger.error(`[ACS] Failed stale monitoring task cleanup: ${err.message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOAP NAMESPACES & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const CWMP_NS = 'urn:dslforum-org:cwmp-1-0';
const XSD_NS  = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS  = 'http://www.w3.org/2001/XMLSchema-instance';
const SOAP_ENC_NS = 'http://schemas.xmlsoap.org/soap/encoding/';

const SESSION_TIMEOUT_MS = 120_000; // 120 seconds

// ═══════════════════════════════════════════════════════════════════════════════
//  IN-MEMORY SESSION STORE
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {Map<string, {deviceId:string, step:string, currentTaskId:number|null, lastActivity:number}>} */
const sessions = new Map();
const lastDeviceByIp = new Map();
const recentFaultLogs = new Map();

/** Periodically clean expired sessions (every 60 s) */
setInterval(() => {
  const now = Date.now();
  for (const [sid, sess] of sessions) {
    if (now - sess.lastActivity > SESSION_TIMEOUT_MS) {
      sessions.delete(sid);
    }
  }
}, 60_000);

// Do not leave write/configuration tasks marked in_progress forever when their CWMP
// session never returns. The outcome is uncertain, so mark history failed for operator
// review only; never replay a non-idempotent write/delete automatically.
function expireStaleConfigurationTasks() {
  try {
    const result = JSON.stringify({
      maintenance: 'configuration task response timed out after 15 minutes; outcome uncertain; inspect ONU before manual retry; not automatically replayed'
    });
    const changed = db.prepare(
      `UPDATE acs_tasks
       SET status = 'failed', result = COALESCE(NULLIF(result, ''), ?), updated_at = ?
       WHERE status = 'in_progress'
         AND name NOT IN ('getParameterValues', 'getParameterNames', 'refreshObject')
         AND julianday(updated_at) < julianday('now', '-15 minutes')`
    ).run(result, nowLocal()).changes;
    if (changed) logger.warn(`[ACS] Marked ${changed} stale configuration task(s) failed/uncertain; no write/delete was replayed.`);
  } catch (err) {
    logger.error(`[ACS] Failed stale configuration-task cleanup: ${err.message}`);
  }
}
expireStaleConfigurationTasks();
setInterval(expireStaleConfigurationTasks, 60_000);

// Recover stale READ-ONLY Wi-Fi/connected-client tasks. A CPE can disappear in the
// middle of a CWMP session, leaving the last task permanently 'in_progress'; that
// suppresses future probes for the same object. Never expire configuration/write tasks.
setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stale = db.prepare(
      `SELECT id FROM acs_tasks
       WHERE status = 'in_progress'
         AND name IN ('getParameterValues', 'getParameterNames', 'refreshObject')
         AND (payload LIKE '%AssociatedDevice%' OR payload LIKE '%Hosts.Host%' OR payload LIKE '%TotalAssociations%')
         AND julianday(updated_at) < julianday(?)`
    ).all(cutoff);
    if (!stale.length) return;
    const now = new Date().toISOString();
    const result = JSON.stringify({
      maintenance: 'stale read-only client telemetry expired after 10 minutes without a CPE response; eligible for retry on a later Inform'
    });
    const update = db.prepare(
      `UPDATE acs_tasks SET status = 'failed', result = ?, updated_at = ?
       WHERE id = ? AND status = 'in_progress'`
    );
    let changed = 0;
    for (const task of stale) changed += update.run(result, now, task.id).changes;
    if (changed) logger.warn(`[ACS] Expired ${changed} stale read-only client telemetry task(s)`);
  } catch (err) {
    logger.warn(`[ACS] Stale client telemetry cleanup failed: ${err.message}`);
  }
}, 60_000);

// Cleanup stale lastTriggerTimes entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [deviceId, ts] of lastTriggerTimes) {
    if (ts < cutoff) lastTriggerTimes.delete(deviceId);
  }
}, 5 * 60 * 1000);

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, ts] of recentFaultLogs) {
    if (ts < cutoff) recentFaultLogs.delete(key);
  }
}, 5 * 60 * 1000);

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function getOrCreateSession(req, res) {
  // Try to read existing session from cookie
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)acs_session=([^;]+)/);
  let sid = match ? match[1] : null;

  if (sid && sessions.has(sid)) {
    const sess = sessions.get(sid);
    sess.lastActivity = Date.now();
    return { sid, session: sess, isNew: false };
  }

  // Create new session
  sid = generateSessionId();
  const session = { deviceId: null, step: null, currentTaskId: null, lastActivity: Date.now() };
  sessions.set(sid, session);
  res.setHeader('Set-Cookie', `acs_session=${sid}; Path=/acs; HttpOnly`);
  return { sid, session, isNew: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TIMESTAMP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function nowLocal() {
  // Use ISO 8601 UTC format for ACS timestamps.
  // This ensures correct Date.now() comparison regardless of server timezone.
  // getNowLocal() returns local time WITHOUT timezone offset (e.g. "2026-06-08 11:49:50"),
  // which causes incorrect parsing on servers with UTC system timezone.
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REGEX-BASED SOAP / XML PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the text content of a simple XML element.
 * Handles namespace-prefixed elements like <ns:Tag> and <Tag>.
 */
function xmlValue(xml, tag) {
  // Match both <tag>value</tag> and <ns:tag>value</ns:tag>
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Detect whether the SOAP body contains a specific CWMP method.
 * E.g. hasCwmpMethod(xml, 'Inform') => true if <cwmp:Inform> or <Inform xmlns=...>
 */
function hasCwmpMethod(xml, method) {
  // <cwmp:Method> or <ns123:Method> or <Method xmlns="urn:dslforum-org:cwmp-1-0">
  const re = new RegExp(`<(?:[\\w-]+:)?${method}[\\s>]`, 'i');
  return re.test(xml);
}

/**
 * Extract CWMP ID from the SOAP header.
 */
function extractCwmpId(xml) {
  // <cwmp:ID ...>value</cwmp:ID> or <ID ...>value</ID>
  const m = xml.match(/<(?:[\w-]+:)?ID[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?ID>/i);
  return m ? m[1].trim() : '1';
}

/**
 * Parse <DeviceId> block from an Inform message.
 */
function parseDeviceId(xml) {
  const deviceIdBlock = xmlValue(xml, 'DeviceId');
  if (!deviceIdBlock) return null;
  return {
    Manufacturer: xmlValue(deviceIdBlock, 'Manufacturer'),
    OUI: xmlValue(deviceIdBlock, 'OUI'),
    SerialNumber: xmlValue(deviceIdBlock, 'SerialNumber'),
    ProductClass: xmlValue(deviceIdBlock, 'ProductClass'),
  };
}

/**
 * Parse all <ParameterValueStruct> entries.
 * Returns a flat object: { 'Device.Path.Name': 'value', ... }
 */
function parseParameterValues(xml) {
  const params = {};
  // Match each ParameterValueStruct block
  const structRe = /<(?:[\w-]+:)?ParameterValueStruct>([\s\S]*?)<\/(?:[\w-]+:)?ParameterValueStruct>/gi;
  let m;
  while ((m = structRe.exec(xml)) !== null) {
    const block = m[1];
    const name = xmlValue(block, 'Name');
    const value = xmlValue(block, 'Value');
    if (name) {
      params[name] = value;
    }
  }
  return params;
}

/**
 * Parse GetParameterValuesResponse – same structure as Inform parameter list.
 */
function parseGetParameterValuesResponse(xml) {
  return parseParameterValues(xml);
}

function parseGetParameterNamesResponse(xml) {
  const names = [];
  const structRe = /<(?:[\w-]+:)?ParameterInfoStruct>([\s\S]*?)<\/(?:[\w-]+:)?ParameterInfoStruct>/gi;
  let m;
  while ((m = structRe.exec(xml)) !== null) {
    const block = m[1];
    const name = xmlValue(block, 'Name');
    if (name) names.push(name);
  }
  return names;
}

/**
 * Parse AddObjectResponse – returns InstanceNumber and Status.
 */
function parseAddObjectResponse(xml) {
  return {
    instanceNumber: xmlValue(xml, 'InstanceNumber'),
    status: xmlValue(xml, 'Status'),
  };
}

/**
 * Parse SetParameterValuesResponse – returns Status (0 = success).
 */
function parseSetParameterValuesResponseStatus(xml) {
  const status = xmlValue(xml, 'Status');
  return status === '' ? null : status;
}

/**
 * Parse FaultCode / FaultString from a SOAP Fault.
 */
function parseFault(xml) {
  if (!/<(?:[\w-]+:)?Fault/i.test(xml)) return null;
  return {
    faultCode: xmlValue(xml, 'FaultCode') || xmlValue(xml, 'faultcode'),
    faultString: xmlValue(xml, 'FaultString') || xmlValue(xml, 'faultstring'),
    detail: xmlValue(xml, 'detail') || xmlValue(xml, 'Detail'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOAP RESPONSE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function soapEnvelopeWrap(cwmpId, bodyContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope
  xmlns:soap="${SOAP_NS}"
  xmlns:cwmp="${CWMP_NS}"
  xmlns:xsd="${XSD_NS}"
  xmlns:xsi="${XSI_NS}"
  xmlns:soap-enc="${SOAP_ENC_NS}">
  <soap:Header>
    <cwmp:ID soap:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap:Header>
  <soap:Body>
    ${bodyContent}
  </soap:Body>
</soap:Envelope>`;
}

function buildInformResponse(cwmpId) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:InformResponse>
      <MaxEnvelopes>1</MaxEnvelopes>
    </cwmp:InformResponse>`
  );
}

function buildReboot(cwmpId) {
  const cmdKey = `reboot-${Date.now()}`;
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:Reboot>
      <CommandKey>${cmdKey}</CommandKey>
    </cwmp:Reboot>`
  );
}

function buildFactoryReset(cwmpId) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:FactoryReset></cwmp:FactoryReset>`
  );
}

/**
 * Build SetParameterValues SOAP envelope.
 * @param {string} cwmpId
 * @param {Array} parameterValues – array of [path, value, type?] or [path, value]
 */
function buildSetParameterValues(cwmpId, parameterValues) {
  const pvList = (parameterValues || []).map(pv => {
    const name = pv[0];
    const value = pv[1];
    const xsdType = pv[2] || 'xsd:string';
    return `        <ParameterValueStruct>
          <Name>${escapeXml(name)}</Name>
          <Value xsi:type="${escapeXml(xsdType)}">${escapeXml(String(value))}</Value>
        </ParameterValueStruct>`;
  }).join('\n');

  const arrayType = `cwmp:ParameterValueStruct[${parameterValues.length}]`;

  return soapEnvelopeWrap(cwmpId,
    `<cwmp:SetParameterValues>
      <ParameterList soap-enc:arrayType="${arrayType}">
${pvList}
      </ParameterList>
      <ParameterKey>${Date.now()}</ParameterKey>
    </cwmp:SetParameterValues>`
  );
}

/**
 * Build GetParameterValues SOAP envelope.
 * @param {string} cwmpId
 * @param {string[]} parameterNames
 */
function buildGetParameterValues(cwmpId, parameterNames) {
  const names = (parameterNames || []).map(n =>
    `        <string>${escapeXml(n)}</string>`
  ).join('\n');

  return soapEnvelopeWrap(cwmpId,
    `<cwmp:GetParameterValues>
      <ParameterNames soap-enc:arrayType="xsd:string[${parameterNames.length}]">
${names}
      </ParameterNames>
    </cwmp:GetParameterValues>`
  );
}

function buildGetParameterNames(cwmpId, objectName, nextLevel = 0) {
  let path = objectName || '';
  if (path && !path.endsWith('.')) path += '.';
  const nl = nextLevel ? '1' : '0';
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:GetParameterNames>
      <ParameterPath>${escapeXml(path)}</ParameterPath>
      <NextLevel>${nl}</NextLevel>
    </cwmp:GetParameterNames>`
  );
}

/**
 * Build GetParameterNames for subtree refresh (refreshObject).
 */
function buildRefreshObject(cwmpId, objectName) {
  return buildGetParameterNames(cwmpId, objectName, 0);
}

function normalizeObjectPath(objectName) {
  let path = String(objectName || '').trim();
  if (path && !path.endsWith('.')) path += '.';
  return path;
}

/**
 * Build AddObject SOAP envelope.
 * @param {string} cwmpId
 * @param {string} objectName – e.g. "InternetGatewayDevice.WANDevice.1.WANConnectionDevice."
 */
function buildAddObject(cwmpId, objectName) {
  const normalizedObjectName = normalizeObjectPath(objectName);
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:AddObject>
      <ObjectName>${escapeXml(normalizedObjectName)}</ObjectName>
      <ParameterKey></ParameterKey>
    </cwmp:AddObject>`
  );
}

function buildDeleteObject(cwmpId, objectName) {
  const normalizedObjectName = normalizeObjectPath(objectName);
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:DeleteObject>
      <ObjectName>${escapeXml(normalizedObjectName)}</ObjectName>
      <ParameterKey></ParameterKey>
    </cwmp:DeleteObject>`
  );
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATABASE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert device from Inform data.
 */
function upsertDevice(deviceId, deviceInfo, params, ipAddress) {
  const now = nowLocal();

  // Extract well-known parameters
  const swVer = params['InternetGatewayDevice.DeviceInfo.SoftwareVersion']
    || params['Device.DeviceInfo.SoftwareVersion']
    || '';
  const hwVer = params['InternetGatewayDevice.DeviceInfo.HardwareVersion']
    || params['Device.DeviceInfo.HardwareVersion']
    || '';

  // Connection request URL – look in multiple possible locations
  const connReqUrl = params['InternetGatewayDevice.ManagementServer.ConnectionRequestURL']
    || params['Device.ManagementServer.ConnectionRequestURL']
    || '';
  const connReqUser = params['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername']
    || params['Device.ManagementServer.ConnectionRequestUsername']
    || '';
  const connReqPass = params['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword']
    || params['Device.ManagementServer.ConnectionRequestPassword']
    || '';

  // Keep TR-069/Connection Request host separate from PPPoE session IP.
  // If a CPE omits or sends an invalid URL, preserve the existing management IP rather than
  // replacing it with the reverse-proxy/source address from the incoming Inform.
  let ipToSave = ipAddress;
  let hasValidConnReqHost = false;
  if (connReqUrl) {
    try {
      const cleanUrl = String(connReqUrl).trim();
      // Normalize scheme detection case-insensitively; URLs may arrive with no scheme or uppercase HTTP.
      const normalizedUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleanUrl) ? cleanUrl : `http://${cleanUrl}`;
      const urlObj = new URL(normalizedUrl);
      const host = String(urlObj.hostname || '').replace(/^\[|\]$/g, '');
      const protocolOk = urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
      const hostOk = host && host !== '0.0.0.0' && host !== '127.0.0.1' && host !== '::1'
        && !host.startsWith('169.254.') && !host.toLowerCase().startsWith('fe80:');
      if (protocolOk && hostOk) {
        ipToSave = urlObj.hostname;
        hasValidConnReqHost = true;
      }
    } catch (_) { /* keep last known valid management host */ }
  }
  
  // Clean IPv6 mapped IPv4 prefix
  if (ipToSave && ipToSave.startsWith('::ffff:')) {
    ipToSave = ipToSave.slice(7);
  }

  // Check if device exists and keep its trusted management IP when the current Inform lacks a valid URL host.
  const existing = db.prepare('SELECT id, ip_address, params, tags FROM acs_devices WHERE id = ?').get(deviceId);

  if (existing) {
    const ipToStore = hasValidConnReqHost ? ipToSave : (existing.ip_address || ipToSave);
    // Merge existing params with new params (new values overwrite)
    let mergedParams = {};
    try { mergedParams = JSON.parse(existing.params || '{}'); } catch (_) { /* empty */ }
    mergedParams = mergeParamsKeepingKnownWifiValues(mergedParams, params);

    db.prepare(`
      UPDATE acs_devices SET
        serial_number = ?,
        manufacturer = ?,
        product_class = ?,
        oui = ?,
        software_version = ?,
        hardware_version = ?,
        ip_address = ?,
        connection_request_url = CASE WHEN ? != '' THEN ? ELSE connection_request_url END,
        connection_request_user = CASE WHEN ? != '' THEN ? ELSE connection_request_user END,
        connection_request_pass = CASE WHEN ? != '' THEN ? ELSE connection_request_pass END,
        params = ?,
        last_inform = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      deviceInfo.SerialNumber,
      deviceInfo.Manufacturer,
      deviceInfo.ProductClass,
      deviceInfo.OUI,
      swVer,
      hwVer,
      ipToStore,
      connReqUrl, connReqUrl,
      connReqUser, connReqUser,
      connReqPass, connReqPass,
      JSON.stringify(mergedParams),
      now,
      now,
      deviceId
    );
  } else {
    db.prepare(`
      INSERT INTO acs_devices
        (id, serial_number, manufacturer, product_class, oui,
         software_version, hardware_version, ip_address,
         connection_request_url, connection_request_user, connection_request_pass,
         tags, params, last_inform, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
    `).run(
      deviceId,
      deviceInfo.SerialNumber,
      deviceInfo.Manufacturer,
      deviceInfo.ProductClass,
      deviceInfo.OUI,
      swVer,
      hwVer,
      hasValidConnReqHost ? ipToSave : '',
      connReqUrl,
      connReqUser,
      connReqPass,
      JSON.stringify(params),
      now,
      now,
      now
    );
  }
}

/**
 * Some CPE firmware returns an empty SSID or empty/write-only Wi-Fi secret
 * during a later Inform even though ACS previously read the real value.
 * Keep the last known non-empty value in cache rather than replacing it with
 * an empty/redacted snapshot. This changes only the ACS cache, never the ONU.
 */
function hasUsableWifiValue(value) {
  let raw = value;
  if (raw && typeof raw === 'object') {
    if (Object.prototype.hasOwnProperty.call(raw, '_value')) raw = raw._value;
    else if (Object.prototype.hasOwnProperty.call(raw, 'value')) raw = raw.value;
  }
  if (raw === null || raw === undefined) return false;
  const text = String(raw).trim();
  if (!text || text === '-' || /^(?:\*{3,}|\[hidden\]|\(hidden\)|hidden)$/i.test(text)) return false;
  return true;
}

function mergeParamsKeepingKnownWifiValues(existingParams, incomingParams) {
  const merged = { ...(existingParams && typeof existingParams === 'object' ? existingParams : {}) };
  if (!incomingParams || typeof incomingParams !== 'object') return merged;
  for (const [path, value] of Object.entries(incomingParams)) {
    const isWifiIdentityOrSecret = /\.(?:SSID|KeyPassphrase|PreSharedKey)$/i.test(String(path));
    if (isWifiIdentityOrSecret && !hasUsableWifiValue(value) && hasUsableWifiValue(merged[path])) {
      continue; // Do not erase a previously readable value with a blank/redacted response.
    }
    merged[path] = value;
  }
  return merged;
}

/**
 * Merge GetParameterValuesResponse data into a device's params.
 */
function mergeDeviceParams(deviceId, newParams) {
  const now = nowLocal();
  const existing = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!existing) return;

  let merged = {};
  try { merged = JSON.parse(existing.params || '{}'); } catch (_) { /* empty */ }
  merged = mergeParamsKeepingKnownWifiValues(merged, newParams);

  // Keep dedicated Connection Request columns synchronized when fresh TR-069
  // values arrive. Never overwrite a stored value with an empty parameter.
  const crUrl = newParams['InternetGatewayDevice.ManagementServer.ConnectionRequestURL']
    || newParams['Device.ManagementServer.ConnectionRequestURL'] || '';
  const crUser = newParams['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername']
    || newParams['Device.ManagementServer.ConnectionRequestUsername'] || '';
  const crPass = newParams['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword']
    || newParams['Device.ManagementServer.ConnectionRequestPassword'] || '';

  db.prepare(`UPDATE acs_devices SET
      params = ?, updated_at = ?,
      connection_request_url = CASE WHEN ? != '' THEN ? ELSE connection_request_url END,
      connection_request_user = CASE WHEN ? != '' THEN ? ELSE connection_request_user END,
      connection_request_pass = CASE WHEN ? != '' THEN ? ELSE connection_request_pass END
    WHERE id = ?`)
    .run(JSON.stringify(merged), now,
      crUrl, crUrl, crUser, crUser, crPass, crPass, deviceId);
}

/**
 * Check if the device is missing WLAN, WAN, or RX optical power parameters,
 * and if so, queue a getParameterValues task to bootstrap them.
 */
function queueBootstrapTasksIfNeeded(deviceId, currentParams) {
  try {
    // Check if device is already tagged as bootstrapped to avoid infinite loops on unsupported features
    const device = db.prepare('SELECT tags, manufacturer, product_class FROM acs_devices WHERE id = ?').get(deviceId);
    if (!device) return;


    let tags = [];
    try { tags = JSON.parse(device.tags || '[]'); } catch (_) {}

    // Discover the actual WAN PPP interface for ONTs that have no cached PPPoE
    // username yet. Many FiberHome ONTs report a management WAN IP first, which
    // used to make hasWan=true and skip PPP discovery forever. This is read-only
    // and is queued once per device; no password or configuration leaf is read.
    const bootstrapParams = currentParams && typeof currentParams === 'object' ? currentParams : {};
    const bootstrapPaths = Object.keys(bootstrapParams);
    const hasPppoeUsername = bootstrapPaths.some(path =>
      /(?:WANPPPConnection\.\d+\.Username|Device\.PPP\.Interface\.\d+\.Username)$/i.test(path)
      && String(bootstrapParams[path] ?? '').trim() !== ''
      && !['-', 'n/a'].includes(String(bootstrapParams[path]).trim().toLowerCase())
    );
    const isLikelyOntForWanDiscovery = /fiberhome|zte|cmhi|huawei|rteg|tm|zioncom|zicg|hwtc|cmdc/i.test(String(device.manufacturer || ''))
      || /HG60|HG61|HG81|F609|F660|F663|F670|XPON/i.test(String(device.product_class || ''));
    const wanDiscoveryExists = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterNames'
       AND payload LIKE '%"discoverWan":true%' LIMIT 1`
    ).get(deviceId);
    if (isLikelyOntForWanDiscovery && !hasPppoeUsername && !wanDiscoveryExists) {
      const hasLegacyRoot = bootstrapPaths.some(path => path.startsWith('InternetGatewayDevice.'));
      const hasTr181Root = bootstrapPaths.some(path => path.startsWith('Device.DeviceInfo.') || path.startsWith('Device.ManagementServer.'));
      const useTr181 = hasTr181Root || (!hasLegacyRoot && bootstrapPaths.some(path => path.startsWith('Device.')));
      const objectName = useTr181 ? 'Device.PPP.Interface' : 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice';
      const now = nowLocal();
      db.prepare(
        `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
         VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
      ).run(deviceId, JSON.stringify({ objectName, nextLevel: true, discoverWan: true }), now, now);
      logger.info(`[ACS] Queued read-only WAN PPP discovery for ${deviceId} at ${objectName}`);
    }

    if (tags.includes('bootstrapped')) {
      return;
    }

    // Check if there is already a pending getParameterValues task for this device to prevent duplication
    const pending = db.prepare("SELECT COUNT(*) as c FROM acs_tasks WHERE device_id = ? AND name = 'getParameterValues' AND status = 'pending'").get(deviceId);
    if (pending && pending.c > 0) {
      return;
    }

    // Use cached values when available; optional metrics are queried as singleton
    // requests so an unsupported parameter cannot invalidate an entire batch.
    currentParams = currentParams && typeof currentParams === 'object' ? currentParams : {};
    const hasValue = (path) => currentParams[path] != null && String(currentParams[path]).trim() !== '';
    const cachedPaths = Object.keys(currentParams);
    // Some legacy TR-098 ONTs also expose one or two Device.PPP.* aliases.
    // Do not classify them as TR-181 solely because any key starts with Device.
    const hasTr181InfoRoot = cachedPaths.some(k => k.startsWith('Device.DeviceInfo.') || k.startsWith('Device.ManagementServer.'));
    const hasLegacyRoot = cachedPaths.some(k => k.startsWith('InternetGatewayDevice.'));
    const isTr181 = hasTr181InfoRoot || (!hasLegacyRoot && cachedPaths.some(k => k.startsWith('Device.')));
    const summaryText = String(currentParams['InternetGatewayDevice.DeviceSummary'] || currentParams['Device.DeviceInfo.DeviceSummary'] || '');
    const wifiCapable = /wifilan|wlan|wifi/i.test(summaryText)
      || /fiberhome|zte|cmhi|huawei|rteg|tm|zioncom|zicg|hwtc|cmdc/i.test(String(device.manufacturer || ''))
      || /HG60|HG61|HG81|F609|F660|F663|F670|N200RE|XPW300|H3-2s/i.test(String(device.product_class || ''));
    const hasSsid = cachedPaths.some(k => k.toLowerCase().endsWith('.ssid') && hasValue(k));
    const hasWlan = cachedPaths.some(k => (k.toLowerCase().endsWith('.ssid') || k.toLowerCase().includes('keypassphrase')) && hasValue(k));
    const hasWan = cachedPaths.some(k => k.toLowerCase().includes('username') || k.toLowerCase().includes('externalipaddress') || k.toLowerCase().includes('pppoe'));
    const hasRx = cachedPaths.some(k => /(?:rxpower|receivepower|receivesignallevel|opticalsignallevel|redaman)$/i.test(k) && hasValue(k));
    const uptimePath = isTr181 ? 'Device.DeviceInfo.UpTime' : 'InternetGatewayDevice.DeviceInfo.UpTime';
    // Discover optional telemetry from each ONT's actual parameter tree instead
    // of guessing vendor leaves. GetParameterNames responses are filtered to metrics only.
    const hasCoreMetrics = hasValue(uptimePath);
    const hasTx = cachedPaths.some(path => /(?:TXPower|TransmitPower)$/i.test(path));
    const hasMemory = cachedPaths.some(path => /MemoryStatus\.(?:Total|Free)$/i.test(path));
    const hasCpu = cachedPaths.some(path => /(?:CPUUsage|ProcessorLoad)$/i.test(path));
    const hasTraffic = cachedPaths.some(path => /\.(?:Ethernet|Total)?Bytes(?:Sent|Received)(?:64)?$/i.test(path));
    const needsMetricDiscovery = !hasCoreMetrics || !hasTx || !hasMemory || !hasCpu || !hasTraffic;

    // RX power is vendor/model specific. Do not probe guessed vendor paths.
    if (!hasWlan || !hasWan || needsMetricDiscovery) {
      logger.info(`[ACS] Device ${deviceId} is missing key parameters (WLAN:${hasWlan}, WAN:${hasWan}, RX:${hasRx}). Queuing bootstrap parameter fetches.`);
      
      const groups = [];
      const basicInfoPaths = isTr181
        ? ['Device.DeviceInfo.ModelName', 'Device.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.HardwareVersion']
        : ['InternetGatewayDevice.DeviceInfo.ModelName', 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'InternetGatewayDevice.DeviceInfo.HardwareVersion'];

      // CMHI F609 firmware in the live fleet rejects this path with CWMP 9005.
      // ProductClass from Inform already identifies the model, so do not probe it again.
      const skipModelName = /^CMHI$/i.test(String(device.manufacturer || ''))
        && /F609/i.test(String(device.product_class || ''));
      for (const path of basicInfoPaths) {
        if (hasValue(path)) continue;
        if (skipModelName && /\.DeviceInfo\.ModelName$/i.test(path)) continue;
        groups.push([path]);
      }

      // Do not guess WLAN instance indexes (1–8/1–16): many ONU models expose
      // fewer instances and return CWMP 9005 for unsupported paths. Wi-Fi leaves are
      // discovered from the device's own GetParameterNames tree below instead.

      if (isTr181) {
        // TR-181 (Modern ONUs): basic information and optional metrics are queued individually above.
        const cachedPaths = Object.keys(currentParams || {});
        const hasCachedPrefix = (prefix) => cachedPaths.some(path => path.startsWith(prefix));
        // Refresh every TR-181 SSID/AP instance already known to this device.
        // Password leaves are queried only when the cache has exposed that exact path.
        for (let wifiIndex = 1; wifiIndex <= 16; wifiIndex++) {
          const ssidPrefix = `Device.WiFi.SSID.${wifiIndex}.`;
          const apPrefix = `Device.WiFi.AccessPoint.${wifiIndex}.`;
          if (hasCachedPrefix(ssidPrefix)) {
            for (const leaf of ['SSID', 'Enable', 'Status']) {
              const path = ssidPrefix + leaf;
              if (Object.prototype.hasOwnProperty.call(currentParams, path)) groups.push([path]);
            }
          }
          if (hasCachedPrefix(apPrefix)) {
            for (const leaf of ['Enable', 'Status', 'SSIDReference', 'AssociatedDeviceNumberOfEntries', 'Security.KeyPassphrase', 'Security.PreSharedKey']) {
              const path = apPrefix + leaf;
              if (Object.prototype.hasOwnProperty.call(currentParams, path)) groups.push([path]);
            }
          }
        }
        if (hasCachedPrefix('Device.PPP.Interface.1.')) {
          for (const leaf of ['Username', 'ExternalIPAddress']) {
            const path = `Device.PPP.Interface.1.${leaf}`;
            if (Object.prototype.hasOwnProperty.call(currentParams, path)) groups.push([path]);
          }
        }
        // Optional Wi-Fi/host/optical statistics are not guessed. Query them only
        // after the model's parameter tree has explicitly exposed the relevant object.
      } else {
        // TR-098 (ZTE, Huawei, etc.) - query as safe individual tasks to prevent single-unsupported-path failure
        // Connection Request credentials/URL
        groups.push(['InternetGatewayDevice.ManagementServer.ConnectionRequestURL']);
        groups.push(['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername']);
        groups.push(['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword']);

        // Basic information and optional metrics are queued individually above.
        
        // Read Wi-Fi credentials only on leaves the modem has already reported.
        // Iterate every existing WLAN index; never guess unsupported paths (CWMP 9005).
        for (let wlanIndex = 1; wlanIndex <= 16; wlanIndex++) {
          const wlanPrefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wlanIndex}.`;
          if (!Object.keys(currentParams || {}).some(path => path.startsWith(wlanPrefix))) continue;
          const wlanCandidates = [
            `${wlanPrefix}SSID`,
            `${wlanPrefix}Enable`,
            `${wlanPrefix}Status`,
            `${wlanPrefix}KeyPassphrase`,
            `${wlanPrefix}PreSharedKey.1.KeyPassphrase`,
            `${wlanPrefix}PreSharedKey.1.PreSharedKey`,
            `${wlanPrefix}TotalAssociations`,
            `${wlanPrefix}AssociatedDeviceNumberOfEntries`
          ];
          for (const path of wlanCandidates) {
            if (Object.prototype.hasOwnProperty.call(currentParams, path)) groups.push([path]);
          }
        }
        
        // WAN / PPPoE (Extended indexes to check common interfaces only)
        // CIOT ONU hanya support max 3 WAN connections, reduce loop dari 5 ke 3
        const cachedPaths = Object.keys(currentParams || {});
        const hasCachedPrefix = (prefix) => cachedPaths.some(path => path.startsWith(prefix));
        // Only query PPP interfaces whose parent object is already present in this ONT's
        // reported parameter tree. This avoids guessing connection indexes on each model.
        for (let connIdx = 1; connIdx <= 3; connIdx++) {
          const connPrefix = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${connIdx}.`;
          if (!hasCachedPrefix(connPrefix)) continue;
          for (let pppIdx = 1; pppIdx <= 2; pppIdx++) {
            const pppPrefix = `${connPrefix}WANPPPConnection.${pppIdx}.`;
            if (!hasCachedPrefix(pppPrefix)) continue;
            // A reported PPP instance does not guarantee every optional leaf exists on
            // every firmware. Query only leaves already enumerated for this exact ONU;
            // otherwise a single guessed leaf can fault the task with CWMP 9005.
            for (const leaf of ['Username', 'ExternalIPAddress', 'ConnectionType', 'Uptime']) {
              const path = pppPrefix + leaf;
              if (Object.prototype.hasOwnProperty.call(currentParams, path)) groups.push([path]);
            }
            // Traffic counter leaves are discovered from this verified PPP subtree below;
            // do not guess EthernetBytes paths from the object prefix alone.
          }
        }
        
        // RX optical-power parameters are vendor-specific. Do not probe guessed OIDs;
        // add a path only after it has been verified for this device/model.
        // Active associations/client lists will be refreshed via object enumeration to avoid 9005 faults.
      }

      // Build a small list of known-existing objects to enumerate. DeviceInfo is
      // standard; optical roots come from cached RXPower paths; PPP roots come from
      // already-observed parameter paths. No unknown vendor path is fabricated.
      const metricDiscoveryObjects = new Set([
        isTr181 ? 'Device.DeviceInfo' : 'InternetGatewayDevice.DeviceInfo'
      ]);
      const wifiDiscoveryObjects = new Set();
      const opticalRoots = [...new Set(cachedPaths
        .filter(path => /(?:RXPower|ReceivePower|OpticalSignalLevel)$/i.test(path)
          && /^(?:InternetGatewayDevice\.WANDevice\.|Device\.XPON\.|Device\.Optical\.Interface\.)/i.test(path))
        .map(path => path.slice(0, path.lastIndexOf('.'))))].slice(0, 2);
      for (const root of opticalRoots) metricDiscoveryObjects.add(root);

      // Discover Wi-Fi tables and optical telemetry on incomplete devices using
      // their standard/vendor object tree, rather than requiring a leaf to exist first.
      if (wifiCapable && !hasSsid) {
        wifiDiscoveryObjects.add(isTr181 ? 'Device.WiFi' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration');
      }
      const opticalDevice = /fiberhome|zte|cmhi|huawei|rteg|tm|hwtc|zicg|cmdc/i.test(String(device.manufacturer || ''))
        || /HG60|HG61|HG81|F609|F660|F663|F670|XPON/i.test(String(device.product_class || ''));
      if (!hasRx && opticalDevice) {
        metricDiscoveryObjects.add(isTr181 ? 'Device.Optical.Interface.1' : 'InternetGatewayDevice.WANDevice.1');
      }

      const pppRoot = cachedPaths.map(path => {
        const text = String(path);
        const match = text.match(/^(InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.(?:WANPPPConnection|WANIPConnection)\.\d+)\./i)
          || text.match(/^(Device\.PPP\.Interface\.\d+)\./i);
        return match ? match[1] : '';
      }).find(Boolean);
      if (pppRoot) metricDiscoveryObjects.add(pppRoot);
      if (!pppRoot) {
        const trafficRoot = cachedPaths.map(path => {
          const text = String(path);
          const match = text.match(/^(InternetGatewayDevice\.WANDevice\.\d+\.(?:WANCommonInterfaceConfig|WANEthernetInterfaceConfig))\./i)
            || text.match(/^(Device\.(?:Ethernet|IP)\.Interface\.\d+)\./i);
          return match ? match[1] : '';
        }).find(Boolean);
        if (trafficRoot) metricDiscoveryObjects.add(trafficRoot);
      }

      // Add 'bootstrapped' tag to prevent infinite bootstrap loops
      if (!tags.includes('bootstrapped')) {
        tags.push('bootstrapped');
        const now = nowLocal();
        db.prepare('UPDATE acs_devices SET tags = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(tags), now, deviceId);
      }

      const now = nowLocal();
      for (const group of groups) {
        // GetParameterValues accepts parameter leaf paths, not object roots ending
        // with a dot. A prior cache edge case generated object-root requests that
        // stayed in_progress indefinitely and prevented useful WAN rediscovery.
        const safeGroup = (Array.isArray(group) ? group : [])
          .map(path => String(path || '').trim())
          .filter(path => path && !path.endsWith('.'));
        if (!safeGroup.length) continue;
        const payloadStr = JSON.stringify({ parameterNames: safeGroup });
        db.prepare(
          `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
           VALUES (?, 'getParameterValues', ?, 'pending', ?, ?)`
        ).run(deviceId, payloadStr, now, now);
      }
      for (const objectName of metricDiscoveryObjects) {
        const payloadStr = JSON.stringify({ objectName, nextLevel: false, discoverMetrics: true });
        db.prepare(
          `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
           VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
        ).run(deviceId, payloadStr, now, now);
      }
      // Discover advertised Wi-Fi object instances via GetParameterNames instead of
      // queuing guessed SSID indexes that generate repeated CWMP 9005 faults.
      for (const objectName of wifiDiscoveryObjects) {
        const payloadStr = JSON.stringify({ objectName, nextLevel: true, discoverWifi: true });
        db.prepare(
          `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
           VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
        ).run(deviceId, payloadStr, now, now);
      }

      // Do not bootstrap AssociatedDevice/Hosts refreshes here.
      // queueRealtimeMonitoringTasks() only refreshes objects confirmed present.

      // Queue task to configure Periodic Inform (300 seconds)
      const informPvs = [];
      if (isTr181) {
        informPvs.push(['Device.ManagementServer.PeriodicInformEnable', 'true', 'xsd:boolean']);
        informPvs.push(['Device.ManagementServer.PeriodicInformInterval', '300', 'xsd:unsignedInt']);
      } else {
        informPvs.push(['InternetGatewayDevice.ManagementServer.PeriodicInformEnable', 'true', 'xsd:boolean']);
        informPvs.push(['InternetGatewayDevice.ManagementServer.PeriodicInformInterval', '300', 'xsd:unsignedInt']);
      }
      db.prepare(
        `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
         VALUES (?, 'setParameterValues', ?, 'pending', ?, ?)`
      ).run(deviceId, JSON.stringify({ parameterValues: informPvs }), now, now);
    }
  } catch (err) {
    logger.error(`[ACS] Error in queueBootstrapTasksIfNeeded for ${deviceId}: ${err.message}`);
  }
}

function queueRealtimeMonitoringTasks(deviceId, currentParams) {
  // Poll read-only Wi-Fi client tables once the ONU reports a real WLAN interface.
  // The AssociatedDevice child table is normally absent from cache until probed;
  // requiring that child to exist first caused connected clients never to appear.
  if (!deviceId || !currentParams || typeof currentParams !== 'object') return;
  try {
    const keys = Object.keys(currentParams);
    const hasValue = (path) => currentParams[path] != null && String(currentParams[path]).trim() !== '';
    const meta = db.prepare('SELECT manufacturer, product_class FROM acs_devices WHERE id = ?').get(deviceId) || {};
    const manufacturer = String(meta.manufacturer || '');
    const model = String(meta.product_class || '');
    const wifiCapable = /fiberhome|zte|cmhi|huawei|rteg|tm|zioncom|zicg|hwtc/i.test(manufacturer)
      || /HG60|HG61|HG81|F609|F660|F663|F670|N200RE|XPW300|H3-2s/i.test(model);

    const parameterCandidates = [];
    const countCandidates = [];
    const clientObjects = [];

    // Discover every WLANConfiguration instance that the ONU has actually reported.
    // Do not assume every vendor uses only index 1 (2.4 GHz) and index 5 (5 GHz).
    const legacyRoot = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.';
    for (let index = 1; index <= 8; index++) {
      const prefix = legacyRoot + index + '.';
      const ssidPath = prefix + 'SSID';
      const hasWlanTree = keys.some(path => path.startsWith(prefix));
      if (wifiCapable && hasWlanTree && !hasValue(ssidPath)) {
        // Queue one read-only object-tree discovery at the parent instead of guessing SSID leaf paths.
        clientObjects.push(legacyRoot.slice(0, -1));
      }
      const wlanEnable = String(currentParams[prefix + 'Enable'] ?? '').trim().toLowerCase();
      const wlanStatus = String(currentParams[prefix + 'Status'] ?? '').trim().toLowerCase();
      const explicitlyDisabled = ['0', 'false', 'disabled', 'down', 'disable'].includes(wlanEnable)
        || ['0', 'false', 'disabled', 'down', 'disable'].includes(wlanStatus);
      if (hasValue(ssidPath) && !explicitlyDisabled) {
        countCandidates.push(prefix + 'TotalAssociations');
        clientObjects.push(prefix.slice(0, -1) + '.AssociatedDevice');
      }
    }

    // TR-181 SSID and AP instances are vendor-dependent. Probe only instances that
    // already have some reported parameter, with read-only queries for client tables.
    for (let index = 1; index <= 16; index++) {
      const ssidPrefix = 'Device.WiFi.SSID.' + index + '.';
      const apPrefix = 'Device.WiFi.AccessPoint.' + index + '.';
      const hasSsidTree = keys.some(path => path.startsWith(ssidPrefix));
      const hasApTree = keys.some(path => path.startsWith(apPrefix));
      if (wifiCapable && (hasSsidTree || hasApTree) && !hasValue(ssidPrefix + 'SSID')) {
        // Discover supported SSID leaves from the parent tree rather than guessing this index.
        clientObjects.push('Device.WiFi');
      }
      if (hasSsidTree || hasApTree) {
        countCandidates.push(apPrefix + 'AssociatedDeviceNumberOfEntries');
        clientObjects.push(apPrefix + 'AssociatedDevice');
      }
    }

    // If this ONT has never cached its Wi-Fi tree, enumerate the advertised object
    // hierarchy. Do not guess SSID.1.SSID because some vendors use different instances.
    const hasAnySsidValue = keys.some(path =>
      /(?:WLANConfiguration\.\d+\.SSID|Device\.WiFi\.SSID\.\d+\.SSID)$/i.test(path) && hasValue(path)
    );
    const hasLegacyWlanTree = keys.some(path => path.startsWith(legacyRoot));
    const hasTr181WlanTree = keys.some(path => path.startsWith('Device.WiFi.'));
    if (wifiCapable && !hasAnySsidValue && !hasLegacyWlanTree && !hasTr181WlanTree) {
      const isTr181 = keys.some(path => path.startsWith('Device.DeviceInfo.') || path.startsWith('Device.ManagementServer.'))
        && !keys.some(path => path.startsWith('InternetGatewayDevice.'));
      clientObjects.push(isTr181 ? 'Device.WiFi' : legacyRoot.slice(0, -1));
    }

    // Do not guess vendor RXPower leaves. Discover supported telemetry from the
    // model's advertised object tree; this avoids a cascade of CWMP 9005 faults.
    const hasRxValue = keys.some(path =>
      /(?:RXPower|RxPower|ReceivePower|ReceiveSignalLevel|OpticalSignalLevel|redaman)$/i.test(path) && hasValue(path)
    );
    const likelyOptical = /fiberhome|zte|cmhi|huawei|rteg|tm|hwtc|zicg|cmdc/i.test(manufacturer)
      || /HG60|HG61|HG81|F609|F660|F663|F670|XPON/i.test(model);
    if (likelyOptical && !hasRxValue) {
      const isTr181 = keys.some(path => path.startsWith('Device.DeviceInfo.') || path.startsWith('Device.ManagementServer.'))
        && !keys.some(path => path.startsWith('InternetGatewayDevice.'));
      clientObjects.push(isTr181 ? 'Device.Optical.Interface' : 'InternetGatewayDevice.WANDevice.1');
    }

    // Across legacy/TR-098 Wi-Fi ONUs, the standard Hosts.Host table is a useful
    // read-only fallback when AssociatedDevice is empty or unavailable.
    const hasLegacyWlanSsid = keys.some(path =>
      /^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.\d+\.SSID$/.test(path) && hasValue(path)
    );
    // Hosts.Host is a fallback, not a second full scan when AssociatedDevice already works.
    // Some TOTOLINK devices expose hundreds of Host rows; walking both tables creates
    // a large number of redundant read-only CWMP tasks.
    const hasLegacyAssociatedClientData = keys.some(path =>
      /^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.\d+\.AssociatedDevice\.\d+\./i.test(path)
    );
    if (wifiCapable && hasLegacyWlanSsid && !hasLegacyAssociatedClientData) {
      clientObjects.push('InternetGatewayDevice.LANDevice.1.Hosts.Host');
    }

    const now = nowLocal();
    const insertValues = db.prepare(
      `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
       VALUES (?, 'getParameterValues', ?, 'pending', ?, ?)`
    );
    const insertRefresh = db.prepare(
      `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
       VALUES (?, 'refreshObject', ?, 'pending', ?, ?)`
    );
    const activeValues = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterValues'
       AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
    );
    const unsupportedValues = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterValues'
       AND status = 'failed' AND payload LIKE ? AND result LIKE '%9005%' ORDER BY id DESC LIMIT 1`
    );
    const priorValues = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterValues'
       AND status = 'completed' AND payload LIKE ? ORDER BY id DESC LIMIT 1`
    );
    for (const path of [...new Set([...parameterCandidates, ...countCandidates])]) {
      if (hasValue(path)) continue;
      const likePath = `%${path}%`;
      if (activeValues.get(deviceId, likePath)) continue;
      if (unsupportedValues.get(deviceId, likePath)) continue;
      if (priorValues.get(deviceId, likePath)) continue;
      insertValues.run(deviceId, JSON.stringify({ parameterNames: [path] }), now, now);
    }

    const activeObject = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ?
       AND name IN ('refreshObject', 'getParameterNames')
       AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
    );
    const latestProbe = db.prepare(
      `SELECT status, result, updated_at, payload FROM acs_tasks WHERE device_id = ?
       AND name IN ('refreshObject', 'getParameterNames') AND payload LIKE ? ORDER BY id DESC LIMIT 1`
    );
    for (const objectName of [...new Set(clientObjects)]) {
      const normalizedObjectName = String(objectName || '').replace(/\.+$/, '');
      const isClientTable = /(?:AssociatedDevice|Hosts\.Host)$/i.test(normalizedObjectName);
      const isWifiRoot = /^(?:Device\.WiFi|InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration)$/i.test(normalizedObjectName);
      const isMetricRoot = /^(?:InternetGatewayDevice\.WANDevice\.1|Device\.Optical\.Interface)$/i.test(normalizedObjectName);
      const likePath = `%${normalizedObjectName}%`;
      if (activeObject.get(deviceId, likePath)) continue;
      const previous = latestProbe.get(deviceId, likePath);
      if (previous) {
        const ageHours = (Date.now() - new Date(previous.updated_at).getTime()) / 3600000;
        let previousPayload = {};
        try { previousPayload = JSON.parse(previous.payload || '{}'); } catch (_) {}
        const sameProbeKind = isWifiRoot
          ? previousPayload.discoverWifi === true
          : (isMetricRoot ? previousPayload.discoverMetrics === true : true);
        if (sameProbeKind) {
          // Back off for a week if the ONU explicitly rejects this object with CWMP 9005.
          if (previous.status === 'failed' && /9005/.test(String(previous.result || '')) && ageHours < 168) continue;
          // Authentication failures on the Connection Request endpoint are not
          // fixed by repeating the same wake-up every hour. Retry at most daily.
          if (previous.status === 'failed' && isClientTable
              && /(?:HTTP\s*401|unauthori[sz]ed|authentication failed)/i.test(String(previous.result || ''))
              && ageHours < 24) continue;
          // Client tables are re-read at most once per hour to keep ACS polling controlled.
          // General Wi-Fi/metric discovery remains cached for 24h to avoid unnecessary work.
          const successCacheHours = isClientTable ? 1 : 24;
          if (previous.status !== 'failed' && ageHours < successCacheHours) continue;
          if (previous.status === 'failed' && ageHours < (isClientTable ? 1 : (15 / 60))) continue;
        }
      }
      const nextPayload = { name: 'refreshObject', objectName: normalizedObjectName, nextLevel: !(isMetricRoot || isWifiRoot) };
      if (isClientTable) nextPayload.clientRefresh = true;
      if (isWifiRoot) nextPayload.discoverWifi = true;
      if (isMetricRoot) nextPayload.discoverMetrics = true;
      insertRefresh.run(deviceId, JSON.stringify(nextPayload), now, now);
    }
  } catch (err) {
    logger.warn(`[ACS] Could not queue safe connected-client telemetry for ${deviceId}: ${err.message}`);
  }
}

/**
 * Get the next pending task for a device.
 */
function getNextPendingTask(deviceId) {
  return db.prepare(
    `SELECT * FROM acs_tasks
     WHERE device_id = ? AND status = 'pending'
     ORDER BY id ASC LIMIT 1`
  ).get(deviceId) || null;
}

function getTaskById(taskId) {
  return db.prepare(
    `SELECT * FROM acs_tasks WHERE id = ? LIMIT 1`
  ).get(taskId) || null;
}

function applyTemplateVariables(value, templateVars) {
  const vars = templateVars && typeof templateVars === 'object' ? templateVars : {};
  if (Array.isArray(value)) {
    return value.map(item => applyTemplateVariables(item, vars));
  }
  if (value && typeof value === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = applyTemplateVariables(v, vars);
    }
    return next;
  }
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!(key in vars)) return match;
    const resolved = vars[key];
    return resolved == null ? '' : String(resolved);
  });
}

function enqueueFollowupTasks(deviceId, followupTasks, templateVars) {
  if (!deviceId || !Array.isArray(followupTasks) || followupTasks.length === 0) return 0;
  const now = nowLocal();
  const insertTask = db.prepare(
    `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  );
  let created = 0;

  for (const spec of followupTasks) {
    if (!spec || typeof spec !== 'object') continue;
    const taskName = String(spec.name || '').trim();
    if (!taskName) continue;

    const rawPayload = (spec.payload && typeof spec.payload === 'object' && !Array.isArray(spec.payload))
      ? spec.payload
      : Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'name'));
    const hydratedPayload = applyTemplateVariables(rawPayload, templateVars);

    if (spec.instanceVariable && !hydratedPayload.instanceVariable) {
      hydratedPayload.instanceVariable = spec.instanceVariable;
    }
    if (templateVars && typeof templateVars === 'object' && Object.keys(templateVars).length > 0) {
      hydratedPayload.templateVars = {
        ...(hydratedPayload.templateVars && typeof hydratedPayload.templateVars === 'object' ? hydratedPayload.templateVars : {}),
        ...templateVars
      };
    }

    insertTask.run(deviceId, taskName, JSON.stringify(hydratedPayload), now, now);
    created += 1;
  }

  return created;
}

const SENSITIVE_FIELD_PATTERN = /password|passphrase|presharedkey|secret|token|api[_-]?key|private[_-]?key/i;

function redactSensitiveObject(value) {
  if (Array.isArray(value)) {
    // TR-069 SetParameterValues entries are [parameterPath, parameterValue, 'xsd:...'].
    // Require the type marker so a GetParameterNames/parameterNames string array is untouched.
    const isParameterValuePair = value.length >= 3 && typeof value[0] === 'string'
      && typeof value[2] === 'string' && /^xsd:/i.test(value[2]);
    if (isParameterValuePair && SENSITIVE_FIELD_PATTERN.test(value[0])) {
      return [value[0], '[REDACTED]', ...value.slice(2).map(redactSensitiveObject)];
    }
    return value.map(redactSensitiveObject);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_FIELD_PATTERN.test(key) && child != null
        ? '[REDACTED]'
        : redactSensitiveObject(child);
    }
    return output;
  }
  return value;
}

function redactSensitivePayloadText(raw) {
  try { return JSON.stringify(redactSensitiveObject(JSON.parse(String(raw || '{}')))); }
  catch (_) {
    // Defensive fallback for an old malformed payload: mask common quoted secret fields.
    return String(raw || '').replace(/("[^"\n]*(?:password|passphrase|secret|token)[^"\n]*"\s*:\s*)"[^"\n]*"/gi, '$1"[REDACTED]"');
  }
}

function redactCompletedTaskPayload(taskId) {
  try {
    const row = db.prepare("SELECT payload FROM acs_tasks WHERE id=? AND status='completed'").get(taskId);
    if (!row || !row.payload) return;
    const safePayload = redactSensitivePayloadText(row.payload);
    if (safePayload !== row.payload) {
      db.prepare("UPDATE acs_tasks SET payload=? WHERE id=? AND status='completed'").run(safePayload, taskId);
    }
  } catch (error) {
    logger.warn(`[ACS] Could not redact completed task payload ${taskId}: ${String(error.message || error).slice(0, 160)}`);
  }
}

/**
 * Mark a task completed. Completed task payloads are no longer needed for CWMP replay;
 * scrub secrets from the retained audit record. AddObject callers may briefly preserve
 * the payload until their follow-up queue is created, then redact it explicitly.
 */
function completeTask(taskId, result, options = {}) {
  const now = nowLocal();
  db.prepare(
    `UPDATE acs_tasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ?`
  ).run(result ? JSON.stringify(result) : null, now, taskId);
  if (!options.preservePayload) redactCompletedTaskPayload(taskId);
}

/**
 * Mark a task as failed.
 */
function failTask(taskId, error) {
  const now = nowLocal();
  db.prepare(
    `UPDATE acs_tasks SET status = 'failed', result = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?`
  ).run(error ? JSON.stringify(error) : null, now, taskId);
}

/**
 * Keep technician WAN workflow state aligned with the actual CWMP task/readback.
 * Never create or replay WAN objects here; this function only records evidence.
 */
function updateTechBindingWanJobFromTask(deviceId, taskId, taskName, payload, result = {}) {
  try {
    const vars = payload?.templateVars && typeof payload.templateVars === 'object' ? payload.templateVars : {};
    const workflowType = String(payload?.workflowType || vars.workflowType || '');
    if (workflowType !== 'tech_binding_wan') return;
    const customerId = Number(payload?.customerId || vars.customerId || 0);
    if (!Number.isInteger(customerId) || customerId <= 0) return;
    const job = db.prepare('SELECT * FROM tech_onu_acs_wan_jobs WHERE customer_id=?').get(customerId);
    if (!job || String(job.acs_device_id || '') !== String(deviceId)) return;

    if (taskName === 'addObject') {
      const objectName = String(payload.objectName || payload.object || '').replace(/\.+$/, '');
      const stage = /\.WANPPPConnection$|\.WANIPConnection$/i.test(objectName)
        ? 'ppp_instance_created'
        : /\.WANConnectionDevice$/i.test(objectName)
          ? 'wan_container_created'
          : 'object_created';
      const message = stage === 'ppp_instance_created'
        ? 'AddObject PPP WAN berhasil; konfigurasi parameter dan verifikasi baca-balik sedang diproses. AddObject tidak akan diulang otomatis.'
        : stage === 'wan_container_created'
          ? 'AddObject WAN container berhasil; pembuatan PPP WAN dan konfigurasi dilanjutkan. AddObject tidak akan diulang otomatis.'
          : 'AddObject berhasil; tindak lanjut konfigurasi dilanjutkan tanpa membuat ulang objek.';
      db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage=?,last_message=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND acs_device_id=?`)
        .run(stage, message, customerId, String(deviceId));
      return;
    }

    if (taskName === 'getParameterValues' && result && typeof result === 'object') {
      const paths = Object.keys(result);
      const get = suffix => {
        const path = paths.find(k => new RegExp('\\.' + suffix + '$', 'i').test(k));
        if (!path) return null;
        let value = result[path];
        if (value && typeof value === 'object') {
          if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
          else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
        }
        return value == null ? null : String(value).trim();
      };
      const username = get('Username');
      const enable = get('Enable');
      const connectionType = get('ConnectionType');
      const vlan = get('VLANID');
      const connectionStatus = get('ConnectionStatus');
      const customer = db.prepare('SELECT pppoe_username FROM customers WHERE id=?').get(customerId);
      const expectedUsername = String(customer?.pppoe_username || '').trim();
      const vlanPath = paths.find(k => /\.WANPPPConnection\.\d+\.VLANID$/i.test(k));
      let expectedVlan = null;
      if (vlanPath) {
        // Search by the exact VLAN parameter path, not only the latest 100 writes.
        // Read-only telemetry and CR repair tasks can push an older successful VLAN write
        // out of a recency window even though it remains the active WAN configuration.
        const priorRows = db.prepare(`SELECT id,payload FROM acs_tasks WHERE device_id=? AND id<?
          AND name='setParameterValues' AND status='completed' AND payload LIKE ?
          ORDER BY id DESC LIMIT 100`).all(deviceId, Number(taskId), `%${vlanPath}%`);
        for (const row of priorRows) {
          let prior = {};
          try { prior = JSON.parse(row.payload || '{}'); } catch (_) {}
          const priorVars = prior.templateVars && typeof prior.templateVars === 'object' ? prior.templateVars : {};
          if (String(prior.workflowType || priorVars.workflowType || '') !== 'tech_binding_wan') continue;
          if (Number(prior.customerId || priorVars.customerId || 0) !== customerId) continue;
          const values = prior.parameterValues || prior.values || [];
          const found = Array.isArray(values) && values.find(pv => Array.isArray(pv) && String(pv[0]) === vlanPath);
          if (found) { expectedVlan = String(found[1]); break; }
        }
      }
      const enabled = /^(?:1|true|enabled)$/i.test(String(enable || ''));
      const usernameMatches = !!expectedUsername && String(username || '') === expectedUsername;
      const vlanMatches = expectedVlan !== null && vlan !== null && Number(vlan) === Number(expectedVlan);
      const valuesMatch = usernameMatches && enabled && !!connectionType && vlanMatches;
      const cpeStatus = String(connectionStatus || '').toLowerCase();
      let stage, message;
      if (!valuesMatch) {
        stage = 'verify_mismatch';
        message = `Read-back WAN belum cocok: username ${usernameMatches ? 'cocok' : 'tidak cocok'}, Enable ${enabled ? 'aktif' : 'belum aktif'}, VLAN ${vlanMatches ? 'cocok' : 'belum terverifikasi'}. Tidak ada AddObject ulang otomatis.`;
      } else if (cpeStatus === 'connected') {
        stage = 'wan_readback_connected';
        message = `Read-back WAN cocok: username, Enable, VLAN ${vlan}, ConnectionStatus=Connected. Status akhir pelanggan tetap menunggu sesi PPPoE aktif di MikroTik.`;
      } else if (cpeStatus === 'connecting') {
        stage = 'config_applied_waiting_link';
        message = `Read-back WAN cocok: username, Enable, VLAN ${vlan}; tetapi ConnectionStatus=Connecting. Menunggu ONU/link/PPPoE pulih; tidak membuat WAN kedua.`;
      } else {
        stage = 'config_applied_waiting_link';
        message = `Read-back WAN cocok untuk username, Enable dan VLAN ${vlan}; status koneksi CPE '${String(connectionStatus || 'tidak dilaporkan')}'. Menunggu sambungan pulih; tidak membuat WAN kedua.`;
      }
      db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage=?,last_message=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND acs_device_id=?`)
        .run(stage, message, customerId, String(deviceId));
    }
  } catch (err) {
    logger.warn(`[ACS] Could not sync technician WAN workflow status for task ${taskId}: ${String(err.message || err).slice(0, 180)}`);
  }
}

function queueDeleteVerificationTask(taskId, deviceId) {
  try {
    const row = db.prepare('SELECT name, payload FROM acs_tasks WHERE id = ? AND device_id = ?').get(taskId, deviceId);
    if (!row || row.name !== 'deleteObject') return null;
    const payload = JSON.parse(row.payload || '{}');
    const objectName = String(payload.objectName || payload.object || '').trim().replace(/\.+$/, '');
    const match = objectName.match(/^(.*\.(?:WANPPPConnection|WANIPConnection))\.(\d+)$/i);
    if (!match) return null;

    const now = nowLocal();
    const verifyPayload = {
      objectName: match[1],
      nextLevel: true,
      discoverWan: true,
      verifyDeleteTaskId: Number(taskId),
      verifyObjectPath: objectName + '.',
      timestamp: new Date().toISOString()
    };
    const existing = db.prepare(
      `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterNames'
       AND payload LIKE ? LIMIT 1`
    ).get(deviceId, '%"verifyDeleteTaskId":' + Number(taskId) + '%');
    if (existing) return Number(existing.id);
    const inserted = db.prepare(
      `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
       VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
    ).run(deviceId, JSON.stringify(verifyPayload), now, now);
    logger.info('[ACS] Queued WAN delete verification task ' + inserted.lastInsertRowid +
      ' after delete task ' + taskId + ' for ' + deviceId);
    return Number(inserted.lastInsertRowid);
  } catch (err) {
    logger.warn('[ACS] Could not queue WAN delete verification for task ' + taskId + ': ' + err.message);
    return null;
  }
}

function shouldThrottleFaultLog(deviceId, fault, taskName, payload) {
  const normalizedPayload = String(payload || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const key = [
    String(deviceId || '-'),
    String(fault?.faultCode || '-'),
    String(taskName || '-'),
    normalizedPayload
  ].join('|');
  const now = Date.now();
  const lastSeen = recentFaultLogs.get(key) || 0;
  recentFaultLogs.set(key, now);
  return !!lastSeen && (now - lastSeen) < 10 * 60 * 1000;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK → SOAP BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the SOAP request for a given task.
 * Returns the SOAP XML string or null if the task type is unknown.
 */
function buildTaskSoap(cwmpId, task) {
  let payload = {};
  try { payload = JSON.parse(task.payload || '{}'); } catch (_) { /* empty */ }

  switch (task.name) {
    case 'reboot':
      return buildReboot(cwmpId);

    case 'factoryReset':
      return buildFactoryReset(cwmpId);

    case 'setParameterValues': {
      const pvs = payload.parameterValues || payload.values || [];
      if (!Array.isArray(pvs) || pvs.length === 0) return null;
      return buildSetParameterValues(cwmpId, pvs);
    }

    case 'getParameterValues': {
      const names = payload.parameterNames || payload.names || [];
      if (!Array.isArray(names) || names.length === 0) return null;
      return buildGetParameterValues(cwmpId, names);
    }

    case 'getParameterNames': {
      const objName = payload.objectName || payload.object || payload.parameterPath || '';
      const nextLevel = payload.nextLevel ? 1 : 0;
      if (!objName) return null;
      return buildGetParameterNames(cwmpId, objName, nextLevel);
    }

    case 'refreshObject': {
      const objName = payload.objectName || payload.object || '';
      // Client/host tables are instance tables. Enumerate their immediate children,
      // otherwise some ONUs return only the table's own name and no client rows.
      const tablePath = String(objName).replace(/\.+$/, '');
      const tableNeedsEnumeration = /(?:\.AssociatedDevice|\.Hosts\.Host)$/i.test(tablePath);
      const nextLevel = payload.nextLevel === true || payload.nextLevel === 'true' || tableNeedsEnumeration;
      return buildGetParameterNames(cwmpId, objName, nextLevel ? 1 : 0);
    }

    case 'addObject': {
      const objName = payload.objectName || payload.object || '';
      if (!objName) return null;
      return buildAddObject(cwmpId, objName);
    }

    case 'deleteObject': {
      const objName = payload.objectName || payload.object || '';
      if (!objName) return null;
      return buildDeleteObject(cwmpId, objName);
    }

    default:
      logger.warn(`[ACS] Unknown task type: ${task.name}`);
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DETERMINE DEVICE ID
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the canonical device ID from DeviceId fields.
 * Format: {OUI}-{ProductClass}-{SerialNumber}
 */
function buildDeviceId(deviceInfo) {
  const oui = (deviceInfo.OUI || '000000').trim();
  const pc = (deviceInfo.ProductClass || '').trim();
  const sn = (deviceInfo.SerialNumber || '').trim();
  if (pc) {
    return `${oui}-${pc}-${sn}`;
  }
  return `${oui}-${sn}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN CWMP REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Express handler for POST /acs
 *
 * Must be mounted with:
 *   app.post('/acs', express.raw({ type: ['text/xml', 'application/soap+xml', 'application/xml'] }), handleCwmpRequest);
 */
const handleCwmpRequest = async (req, res) => {
  try {
    // Get body as string
    let body = '';
    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString('utf-8');
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body) {
      body = String(req.body);
    }

    // Determine CPE IP address
    const cpeIp = req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : req.socket?.remoteAddress || req.ip || '';

    // Get or create session
    const { sid, session } = getOrCreateSession(req, res);

    // ── EMPTY POST (step 2 or 3) ───────────────────────────────────────────
    if (!body || body.trim().length === 0) {
      return handleEmptyPost(session, sid, res, cpeIp);
    }

    // ── INFORM ─────────────────────────────────────────────────────────────
    if (hasCwmpMethod(body, 'Inform')) {
      return handleInform(body, session, sid, cpeIp, res);
    }

    // ── RESPONSE TO A TASK ─────────────────────────────────────────────────
    // Check for known response types
    if (hasCwmpMethod(body, 'SetParameterValuesResponse')) {
      return handleTaskResponse(body, session, sid, 'setParameterValues', res);
    }
    if (hasCwmpMethod(body, 'RebootResponse')) {
      return handleTaskResponse(body, session, sid, 'reboot', res);
    }
    if (hasCwmpMethod(body, 'FactoryResetResponse')) {
      return handleTaskResponse(body, session, sid, 'factoryReset', res);
    }
    if (hasCwmpMethod(body, 'GetParameterValuesResponse')) {
      return handleGetParameterValuesResponse(body, session, sid, res);
    }
    if (hasCwmpMethod(body, 'GetParameterNamesResponse')) {
      return handleGetParameterNamesResponse(body, session, sid, res);
    }
    if (hasCwmpMethod(body, 'AddObjectResponse')) {
      return handleAddObjectResponse(body, session, sid, res);
    }

    if (hasCwmpMethod(body, 'DeleteObjectResponse')) {
      return handleTaskResponse(body, session, sid, 'deleteObject', res);
    }

    // ── FAULT ──────────────────────────────────────────────────────────────
    const fault = parseFault(body);
    if (fault) {
      return handleFault(fault, session, sid, res);
    }

    // ── UNKNOWN / UNRECOGNIZED ─────────────────────────────────────────────
    // Treat as empty post (next task or 204)
    logger.debug(`[ACS] Unrecognized SOAP body from session ${sid.substring(0, 8)}, treating as empty`);
    return handleEmptyPost(session, sid, res, cpeIp);

  } catch (err) {
    logger.error(`[ACS] Error handling CWMP request: ${err.message}`);
    res.status(500).set('Content-Type', 'text/xml; charset=utf-8').send('');
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  HANDLER: Inform
// ═══════════════════════════════════════════════════════════════════════════════

function handleInform(body, session, sid, cpeIp, res) {
  const cwmpId = extractCwmpId(body);
  const deviceInfo = parseDeviceId(body);

  if (!deviceInfo || !deviceInfo.SerialNumber) {
    logger.warn(`[ACS] Inform received but could not parse DeviceId`);
    return sendSoapResponse(res, buildInformResponse(cwmpId));
  }

  const deviceId = buildDeviceId(deviceInfo);
  const params = parseParameterValues(body);

  logger.info(`[ACS] Inform from ${deviceId} (${deviceInfo.Manufacturer} ${deviceInfo.ProductClass}) IP=${cpeIp}`);

  // Upsert device in database
  let mergedParams = params;
  try {
    upsertDevice(deviceId, deviceInfo, params, cpeIp);
    const existing = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    if (existing) {
      mergedParams = JSON.parse(existing.params || '{}');
    }
  } catch (err) {
    logger.error(`[ACS] Failed to upsert device ${deviceId}: ${err.message}`);
  }

  // Queue bootstrap parameter fetch if needed
  queueBootstrapTasksIfNeeded(deviceId, mergedParams);
  queueRealtimeMonitoringTasks(deviceId, mergedParams);

  if (cpeIp) {
    lastDeviceByIp.set(String(cpeIp), { deviceId, ts: Date.now() });
    if (lastDeviceByIp.size > 5000) {
      const now = Date.now();
      for (const [k, v] of lastDeviceByIp.entries()) {
        if (!v || (now - (v.ts || 0)) > 10 * 60 * 1000) lastDeviceByIp.delete(k);
      }
    }
  }

  // Update session
  session.deviceId = deviceId;
  session.step = 'informed';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  return sendSoapResponse(res, buildInformResponse(cwmpId));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HANDLER: Empty POST (check task queue)
// ═══════════════════════════════════════════════════════════════════════════════

function handleEmptyPost(session, sid, res, cpeIp = '') {
  if (!session.deviceId) {
    const ipKey = String(cpeIp || '').trim();
    if (ipKey) {
      const rec = lastDeviceByIp.get(ipKey);
      if (rec && rec.deviceId && (Date.now() - (rec.ts || 0)) < SESSION_TIMEOUT_MS) {
        session.deviceId = rec.deviceId;
        session.step = 'inferred';
        logger.info(`[ACS] Inferred session deviceId=${rec.deviceId} from IP=${ipKey}`);
      }
    }
    if (!session.deviceId) return res.status(204).set('Content-Type', 'text/xml; charset=utf-8').send('');
  }

  // Look for a pending task for this device
  const task = getNextPendingTask(session.deviceId);
  if (!task) {
    // No more tasks – signal end of session
    logger.debug(`[ACS] No pending tasks for ${session.deviceId}, sending 204`);
    return res.status(204).set('Content-Type', 'text/xml; charset=utf-8').send('');
  }

  // Build SOAP request for this task
  const cwmpId = String(task.id);
  const soapXml = buildTaskSoap(cwmpId, task);

  if (!soapXml) {
    // Invalid task – mark as failed and try next
    logger.warn(`[ACS] Could not build SOAP for task ${task.id} (${task.name}), marking failed`);
    failTask(task.id, { error: 'Could not build SOAP request for task' });
    return handleEmptyPost(session, sid, res, cpeIp);
  }

  // Update session – we are now waiting for the response to this task
  session.currentTaskId = task.id;
  session.step = 'task_sent';
  session.lastActivity = Date.now();

  // Mark task as in-progress (optional, keeps it 'pending' until response)
  const now = nowLocal();
  db.prepare("UPDATE acs_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
    .run(now, task.id);

  logger.info(`[ACS] Sending task ${task.id} (${task.name}) to device ${session.deviceId}`);
  return sendSoapResponse(res, soapXml);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HANDLER: Task Responses
// ═══════════════════════════════════════════════════════════════════════════════

function handleTaskResponse(body, session, sid, taskType, res) {
  const taskId = session.currentTaskId;
  let verifyCrCredentialsAfterWrite = false;

  if (taskId) {
    let result = {};
    if (taskType === 'setParameterValues') {
      const status = parseSetParameterValuesResponseStatus(body);
      result = { status };
      
      // If setting parameter values succeeded, merge those values into the device's local record immediately
      if (status === '0' || status === 0) {
        try {
          const task = db.prepare('SELECT payload FROM acs_tasks WHERE id = ?').get(taskId);
          if (task) {
            const payload = JSON.parse(task.payload || '{}');
            verifyCrCredentialsAfterWrite = Number(payload.acsCrCredentialRepair?.version) >= 1;
            const pvs = payload.parameterValues || payload.values || [];
            if (Array.isArray(pvs) && pvs.length > 0) {
              const newParams = {};
              for (const pv of pvs) {
                if (pv && pv[0]) {
                  newParams[pv[0]] = pv[1];
                }
              }
              mergeDeviceParams(session.deviceId, newParams);
              logger.debug(`[ACS] Merged ${Object.keys(newParams).length} set parameters into local device record for ${session.deviceId}`);
            }
          }
        } catch (err) {
          logger.error(`[ACS] Failed to merge set parameters after task completion: ${err.message}`);
        }
      }
    } else {
      result = { status: 'ok' };
    }

    logger.info(`[ACS] Task ${taskId} (${taskType}) completed for device ${session.deviceId}`);
    completeTask(taskId, result);
    if (taskType === 'deleteObject') {
      queueDeleteVerificationTask(taskId, session.deviceId);
    }
    if (verifyCrCredentialsAfterWrite) {
      // The successful SetParameterValuesResponse has already persisted the known new
      // password. Verify it once with the CPE-advertised ConnectionRequestURL; never
      // retry a password rotation automatically if this health check fails.
      verifyCrCredentialsAfterTask(session.deviceId, taskId).catch(error => {
        logger.warn(`[ACS] Connection Request credential repair verification error for ${session.deviceId}: ${String(error.message || error).slice(0, 180)}`);
      });
    }
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  // Check for next task
  return handleEmptyPost(session, sid, res);
}

function markClientDataFreshIfIdle(deviceId) {
  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS count FROM acs_tasks WHERE device_id = ?
       AND status IN ('pending', 'in_progress') AND payload LIKE '%"clientRefresh":true%'`
    ).get(deviceId);
    if (Number(pending?.count || 0) > 0) return false;
    const recentFailures = db.prepare(
      `SELECT COUNT(*) AS count FROM acs_tasks WHERE device_id = ?
       AND status = 'failed' AND payload LIKE '%"clientRefresh":true%'
       AND julianday(updated_at) >= julianday('now', '-10 minutes')`
    ).get(deviceId);
    if (Number(recentFailures?.count || 0) > 0) return false;
    const now = nowLocal();
    db.prepare('UPDATE acs_devices SET client_data_updated_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, deviceId);
    return true;
  } catch (err) {
    logger.warn('[ACS] Could not update Wi-Fi client snapshot timestamp for ' + deviceId + ': ' + err.message);
    return false;
  }
}

function handleGetParameterValuesResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const params = parseGetParameterValuesResponse(body);
  let taskPayload = {};

  if (taskId) {
    try {
      const taskRow = db.prepare('SELECT payload FROM acs_tasks WHERE id=?').get(taskId);
      taskPayload = JSON.parse(taskRow?.payload || '{}');
    } catch (_) { taskPayload = {}; }
    logger.info(`[ACS] Task ${taskId} (getParameterValues/refreshObject) completed for device ${session.deviceId} – ${Object.keys(params).length} params`);
    completeTask(taskId, params);
    updateTechBindingWanJobFromTask(session.deviceId, taskId, 'getParameterValues', taskPayload, params);
  }

  // Merge returned params into the local device record, then use newly discovered
  // WLAN leaves to enqueue read-only client-table probes in the same session.
  if (session.deviceId && Object.keys(params).length > 0) {
    try {
      mergeDeviceParams(session.deviceId, params);
      if (taskPayload.clientRefresh === true || taskPayload.clientRefresh === 'true') {
        markClientDataFreshIfIdle(session.deviceId);
      }
      const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(session.deviceId);
      const mergedParams = row ? JSON.parse(row.params || '{}') : {};
      queueRealtimeMonitoringTasks(session.deviceId, mergedParams);
    } catch (err) {
      logger.error(`[ACS] Failed to merge/queue client telemetry for ${session.deviceId}: ${err.message}`);
    }
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  return handleEmptyPost(session, sid, res);
}

function reconcileWanTableCache(deviceId, objectName, names) {
  const root = String(objectName || '').trim().replace(/\.+$/, '');
  const isLegacyTable = /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.(?:WANPPPConnection|WANIPConnection)$/i.test(root);
  const isTr181Table = /^Device\.PPP\.Interface$/i.test(root);
  if (!isLegacyTable && !isTr181Table) return 0;

  const prefix = root + '.';
  const actualInstances = new Set();
  for (const rawName of Array.isArray(names) ? names : []) {
    const child = String(rawName || '').trim();
    if (!child.endsWith('.')) continue;
    const normalized = child.replace(/\.+$/, '');
    if (!normalized.startsWith(prefix)) continue;
    const suffix = normalized.slice(prefix.length);
    if (/^\d+$/.test(suffix)) actualInstances.add(suffix);
  }

  const stored = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!stored) return 0;
  let params = {};
  try { params = JSON.parse(stored.params || '{}'); } catch (_) { params = {}; }

  let removed = 0;
  for (const key of Object.keys(params)) {
    if (!key.startsWith(prefix)) continue;
    const match = key.slice(prefix.length).match(/^(\d+)(?:\.|$)/);
    if (match && !actualInstances.has(match[1])) {
      delete params[key];
      removed++;
    }
  }
  if (removed) {
    db.prepare('UPDATE acs_devices SET params = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(params), nowLocal(), deviceId);
    logger.info('[ACS] WAN cache reconciled for ' + deviceId + ' table ' + root +
      ': removed ' + removed + ' stale parameter(s); active instances=' + Array.from(actualInstances).join(','));
  }
  return removed;
}

// Reconcile only the instance rows that the ONU actually reports in a fresh
// read-only GetParameterNames response. This removes departed clients from the
// ACS cache without changing anything on the ONU.
function reconcileClientTableCache(deviceId, objectName, names) {
  const root = String(objectName || '').trim().replace(/\.+$/, '');
  if (!/(?:\.AssociatedDevice|\.Hosts\.Host)$/i.test(root)) return 0;
  const prefix = root + '.';
  const actualInstances = new Set();
  for (const rawName of Array.isArray(names) ? names : []) {
    const path = String(rawName || '').trim();
    if (!path.endsWith('.')) continue;
    const normalized = path.replace(/\.+$/, '');
    if (!normalized.startsWith(prefix)) continue;
    const suffix = normalized.slice(prefix.length);
    if (/^\d+$/.test(suffix)) actualInstances.add(suffix);
  }

  const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!row) return 0;
  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (_) {}
  let removed = 0;
  for (const key of Object.keys(params)) {
    if (!key.startsWith(prefix)) continue;
    const match = key.slice(prefix.length).match(/^(\d+)(?:\.|$)/);
    if (match && !actualInstances.has(match[1])) {
      delete params[key];
      removed++;
    }
  }
  if (removed) {
    db.prepare('UPDATE acs_devices SET params = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(params), nowLocal(), deviceId);
    logger.info(`[ACS] Client cache reconciled for ${deviceId} ${root}: removed ${removed} stale parameter(s); active instances=${Array.from(actualInstances).join(',') || 'none'}`);
  }
  return actualInstances.size;
}

function handleGetParameterNamesResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const names = parseGetParameterNamesResponse(body);

  if (taskId) {
    logger.info(`[ACS] Task ${taskId} (getParameterNames/refreshObject) completed for device ${session.deviceId} – ${names.length} names`);
    completeTask(taskId, { names });
  }

  // An empty response from a client table is also a valid fresh snapshot: it means
  // the ONU currently reports no clients on that table. Remove all cached instances.
  if (taskId && session.deviceId && Array.isArray(names) && names.length === 0) {
    try {
      const row = db.prepare('SELECT payload FROM acs_tasks WHERE id = ?').get(taskId);
      const payload = JSON.parse(row?.payload || '{}');
      const objectName = String(payload.objectName || payload.object || '').replace(/\.+$/, '');
      if (/(?:\.AssociatedDevice|\.Hosts\.Host)$/i.test(objectName)) {
        reconcileClientTableCache(session.deviceId, objectName, []);
        if (payload.clientRefresh === true || payload.clientRefresh === 'true') {
          markClientDataFreshIfIdle(session.deviceId);
        }
      }
    } catch (err) {
      logger.warn('[ACS] Empty client table reconciliation failed for ' + session.deviceId + ': ' + err.message);
    }
  }

  // Reconcile cached WAN instances even when GetParameterNames returns an empty list.
  // Without this, stale PPP objects remain visible and DeleteObject gets CWMP 9005.
  if (taskId && session.deviceId && Array.isArray(names)) {
    try {
      const wanTask = db.prepare('SELECT payload FROM acs_tasks WHERE id = ?').get(taskId);
      const wanPayload = JSON.parse(wanTask && wanTask.payload || '{}');
      if (wanPayload.discoverWan === true || wanPayload.discoverWan === 'true') {
        reconcileWanTableCache(session.deviceId, wanPayload.objectName || wanPayload.object || '', names);
      }
    } catch (err) {
      logger.warn('[ACS] WAN cache reconciliation failed for ' + session.deviceId + ': ' + err.message);
    }
  }

  if (taskId && session.deviceId && Array.isArray(names) && names.length > 0) {
    try {
      const taskRow = db.prepare('SELECT name, payload FROM acs_tasks WHERE id = ?').get(taskId);
      let objectName = '';
      let discoverMetrics = false;
      let discoverWifi = false;
      let discoverWan = false;
      let clientRefresh = false;
      if (taskRow && taskRow.payload) {
        try {
          const pl = JSON.parse(taskRow.payload || '{}');
          objectName = String(pl.objectName || pl.object || '');
          discoverMetrics = pl.discoverMetrics === true || pl.discoverMetrics === 'true';
          discoverWifi = pl.discoverWifi === true || pl.discoverWifi === 'true';
          discoverWan = pl.discoverWan === true || pl.discoverWan === 'true';
          clientRefresh = pl.clientRefresh === true || pl.clientRefresh === 'true';
        } catch {}
      }

      // A completed table enumeration is an authoritative snapshot of its current
      // instance numbers. Old cached clients that are no longer returned are removed.
      const isClientTableRoot = /(?:\.AssociatedDevice|\.Hosts\.Host)$/i.test(objectName.replace(/\.+$/, ''));
      let enumeratedClientInstances = 0;
      if (isClientTableRoot) {
        enumeratedClientInstances = reconcileClientTableCache(session.deviceId, objectName, names);
        if (enumeratedClientInstances === 0 && clientRefresh) {
          markClientDataFreshIfIdle(session.deviceId);
        }
      }

      const wantedHostSuffixes = [
        '.HostName',
        '.IPAddress',
        '.MACAddress',
        '.InterfaceType',
        '.Active',
        '.LeaseTimeRemaining',
        '.RemainingLeaseTime'
      ];
      const wantedAssocSuffixes = [
        // TR-098/legacy vendor-specific leaves (FiberHome and CMHI commonly use these).
        '.AssociatedDeviceMACAddress',
        '.AssociatedDeviceIPAddress',
        '.AssociatedDeviceHostName',
        '.AssociatedDeviceDeviceName',
        '.AssociatedDeviceSignalStrength',
        '.AssociatedDeviceRSSI',
        '.AssociatedDeviceLastDataDownlinkRate',
        '.AssociatedDeviceLastDataUplinkRate',
        // Other vendor aliases.
        '.MACAddress',
        '.IPAddress',
        '.HostName',
        '.DeviceName',
        '.SignalStrength',
        '.RSSI',
        '.X_HW_RSSI',
        '.LastDataTransmitRate',
        '.X_HW_TxRate'
      ];
      let filtered = names;
      const obj = String(objectName || '');
      const wanChildPaths = new Set();
      if (discoverWan) {
        // Walk only advertised WAN PPP table instances. Do not infer connection
        // indexes and never read the write-only PPP password.
        const root = obj.replace(/\.+$/, '');
        const addNumericChildren = () => {
          for (const rawName of names) {
            const path = String(rawName || '').trim();
            if (!path.endsWith('.')) continue;
            const normalized = path.replace(/\.+$/, '');
            if (!normalized.startsWith(root + '.')) continue;
            const suffix = normalized.slice(root.length + 1);
            if (/^\d+$/.test(suffix)) wanChildPaths.add(normalized);
          }
        };
        const addConnectionChildren = () => {
          for (const rawName of names) {
            const path = String(rawName || '').trim();
            if (!path.endsWith('.')) continue;
            const normalized = path.replace(/\.+$/, '');
            if (!normalized.startsWith(root + '.')) continue;
            const suffix = normalized.slice(root.length + 1);
            if (/^(?:WANPPPConnection|WANIPConnection)(?:\.\d+)?$/i.test(suffix)) wanChildPaths.add(normalized);
          }
        };
        if (/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice$/i.test(root)
            || root === 'Device.PPP.Interface'
            || /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.(?:WANPPPConnection|WANIPConnection)$/i.test(root)) {
          addNumericChildren();
          filtered = [];
        } else if (/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+$/i.test(root)) {
          addConnectionChildren();
          filtered = [];
        } else if (/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.(?:WANPPPConnection|WANIPConnection)\.\d+$/i.test(root)
                   || /^Device\.PPP\.Interface\.\d+$/i.test(root)) {
          const safePppLeaf = /(?:^|\.)(?:Username|ConnectionType|ExternalIPAddress|Enable|Name|TransportType|ConnectionStatus|Uptime|NATEnabled|Status|VLANID|X_FH_VLANID|X_HW_VLAN|X_HW_VLANID|X_ZTE_VLAN|VLANMode|X_HW_VLANMark|X_ZTE_VLANMode)$/i;
          filtered = names.filter(n => {
            const path = String(n || '').trim();
            return !!path && !path.endsWith('.') && safePppLeaf.test(path);
          });
        } else {
          filtered = [];
        }
      } else if (discoverMetrics) {
        // Metric discovery is read-only and whitelists telemetry leaves only. It must
        // never request credentials or object names as GetParameterValues parameters.
        const metricLeaf = /(?:\.RXPower$|\.TXPower$|\.ReceivePower$|\.TransmitPower$|\.OpticalSignalLevel$|\.MemoryStatus\.(?:Total|Free)$|\.ProcessStatus\.CPUUsage$|\.CPUUsage$|\.ProcessorLoad$|\.(?:Ethernet|Total)?Bytes(?:Sent|Received)(?:64)?$|\.Uptime$)/i;
        filtered = names.filter(n => {
          const path = String(n || '').trim();
          return !!path && !path.endsWith('.') && metricLeaf.test(path);
        });
      } else if (discoverWifi) {
        // Only read Wi-Fi identity/state leaves advertised by this CPE; never fetch keys.
        const tr181Wifi = /^Device\.WiFi\./i.test(obj);
        const wifiLeaf = tr181Wifi
          ? /^Device\.WiFi\.(?:SSID\.\d+\.SSID|AccessPoint\.\d+\.(?:Enable|Status|SSIDReference))$/i
          : /^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.\d+\.(?:SSID|Enable|Status)$/i;
        filtered = names.filter(n => {
          const path = String(n || '').trim();
          return !!path && !path.endsWith('.') && wifiLeaf.test(path);
        });
      } else if (obj.includes('Hosts.Host')) {
        filtered = names.filter(n => wantedHostSuffixes.some(s => String(n).endsWith(s)) && !String(n).trim().endsWith('.'));
      } else if (obj.includes('AssociatedDevice')) {
        filtered = names.filter(n => wantedAssocSuffixes.some(s => String(n).endsWith(s)) && !String(n).trim().endsWith('.'));
      }

      // GetParameterNames on an instance table can return only indexed child objects
      // (for example AssociatedDevice.1.) before it exposes the leaf parameters.
      // Queue a second read-only enumeration for each direct numeric instance.
      if (!discoverMetrics && (obj.includes('AssociatedDevice') || obj.includes('Hosts.Host'))) {
        const root = obj.replace(/\.+$/, '');
        const childInstances = new Set();
        for (const rawName of names) {
          const path = String(rawName || '').trim();
          if (!path.endsWith('.')) continue;
          const normalized = path.replace(/\.+$/, '');
          if (!normalized.startsWith(root + '.')) continue;
          const suffix = normalized.slice(root.length + 1);
          if (/^\d+$/.test(suffix)) childInstances.add(normalized);
        }
        if (childInstances.size) {
          const now = nowLocal();
          const insertChild = db.prepare(
            `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
             VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
          );
          const activeChild = db.prepare(
            `SELECT id FROM acs_tasks WHERE device_id = ? AND name IN ('getParameterNames', 'refreshObject')
             AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
          );
          for (const childPath of childInstances) {
            if (activeChild.get(session.deviceId, `%${childPath}%`)) continue;
            insertChild.run(session.deviceId, JSON.stringify({ objectName: childPath, nextLevel: true, ...(clientRefresh ? { clientRefresh: true } : {}) }), now, now);
          }
          logger.info(`[ACS] Enumerating ${childInstances.size} client/host table instance(s) for device ${session.deviceId}`);
        }
      }

      if (discoverWan && wanChildPaths.size) {
        const now = nowLocal();
        const insertChild = db.prepare(
          `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
           VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
        );
        const activeChild = db.prepare(
          `SELECT id FROM acs_tasks WHERE device_id = ? AND name = 'getParameterNames'
           AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
        );
        let queued = 0;
        for (const childPath of wanChildPaths) {
          if (activeChild.get(session.deviceId, `%${childPath}%`)) continue;
          insertChild.run(session.deviceId, JSON.stringify({ objectName: childPath, nextLevel: true, discoverWan: true }), now, now);
          queued++;
        }
        if (queued) logger.info(`[ACS] Queued ${queued} read-only WAN PPP subtree discovery task(s) for ${session.deviceId}`);
      }

      if (discoverWifi) {
        // Walk only the Wi-Fi object instances returned by the CPE. Never enumerate
        // PreSharedKey/KeyPassphrase objects during discovery.
        const root = String(obj || '').replace(/\.+$/, '');
        const isLegacyWifiRoot = root === 'InternetGatewayDevice.LANDevice.1.WLANConfiguration';
        const isTr181WifiRoot = root === 'Device.WiFi';
        const childPaths = new Set();
        if (isLegacyWifiRoot || isTr181WifiRoot) {
          for (const rawName of names) {
            const path = String(rawName || '').trim();
            if (!path.endsWith('.')) continue;
            const normalized = path.replace(/\.+$/, '');
            if (!normalized.startsWith(root + '.')) continue;
            const suffix = normalized.slice(root.length + 1);
            if (isLegacyWifiRoot && /^\d+$/.test(suffix)) childPaths.add(normalized + '.');
            if (isTr181WifiRoot && /^(?:SSID|AccessPoint)\.\d+$/.test(suffix)) childPaths.add(normalized + '.');
          }
        }
        if (childPaths.size) {
          const now = nowLocal();
          const insertChild = db.prepare(
            `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
             VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
          );
          const activeChild = db.prepare(
            `SELECT id FROM acs_tasks WHERE device_id = ?
             AND name IN ('getParameterNames', 'refreshObject')
             AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
          );
          for (const childPath of childPaths) {
            if (activeChild.get(session.deviceId, `%${childPath}%`)) continue;
            insertChild.run(session.deviceId, JSON.stringify({ objectName: childPath, nextLevel: true, discoverWifi: true }), now, now);
          }
        }
      }

      // A CPE that returns CWMP 9005 has explicitly rejected that parameter path.
      // Do not ask the same device for the same unsupported leaf again for 7 days;
      // keep other advertised leaves flowing so one vendor-specific field cannot
      // generate repeated failures on every client-table refresh.
      if (filtered.length && (obj.includes('AssociatedDevice') || obj.includes('Hosts.Host'))) {
        const unsupportedPath = db.prepare(
          `SELECT id FROM acs_tasks
           WHERE device_id = ? AND name = 'getParameterValues' AND status = 'failed'
             AND result LIKE '%9005%' AND payload LIKE ?
             AND julianday(updated_at) >= julianday('now', '-7 days')
           ORDER BY id DESC LIMIT 1`
        );
        filtered = filtered.filter(path => !unsupportedPath.get(session.deviceId, `%${path}%`));
      }

      const max = 200;
      if (filtered.length > max) filtered = filtered.slice(0, max);

      if (filtered.length > 0) {
        const now = nowLocal();
        const insertValuesTask = db.prepare(
          `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
           VALUES (?, 'getParameterValues', ?, 'pending', ?, ?)`
        );
        let batches = [filtered];
        if (obj.includes('AssociatedDevice')) {
          // Group similar leaves together and keep batches small: one unsupported vendor
          // parameter must not cause every MAC/IP/RSSI read for the ONU to fail with CWMP 9005.
          const bySuffix = new Map();
          for (const path of filtered) {
            const suffix = wantedAssocSuffixes.find(s => String(path).endsWith(s)) || 'other';
            if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
            bySuffix.get(suffix).push(path);
          }
          batches = [];
          for (const paths of bySuffix.values()) {
            for (let i = 0; i < paths.length; i += 20) {
              batches.push(paths.slice(i, i + 20));
            }
          }
        }
        for (const parameterNames of batches) {
          insertValuesTask.run(
            session.deviceId,
            JSON.stringify({ parameterNames, ...(clientRefresh ? { clientRefresh: true } : {}) }),
            now,
            now
          );
        }
      }
    } catch (err) {
      logger.error(`[ACS] Failed to enqueue getParameterValues after getParameterNames for ${session.deviceId}: ${err.message}`);
    }
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  return handleEmptyPost(session, sid, res);
}

function handleAddObjectResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const result = parseAddObjectResponse(body);
  const taskRow = taskId ? getTaskById(taskId) : null;
  let taskPayload = {};
  try { taskPayload = JSON.parse(taskRow?.payload || '{}'); } catch (_) { taskPayload = {}; }

  if (taskId) {
    logger.info(`[ACS] Task ${taskId} (addObject) completed – instance=${result.instanceNumber}`);
    // Preserve payload only until its nested follow-up tasks have been enqueued.
    completeTask(taskId, result, { preservePayload: true });
    updateTechBindingWanJobFromTask(session.deviceId, taskId, 'addObject', taskPayload, result);
  }

  if (session.deviceId && Array.isArray(taskPayload.followup) && taskPayload.followup.length > 0) {
    const inheritedVars = taskPayload.templateVars && typeof taskPayload.templateVars === 'object'
      ? taskPayload.templateVars
      : {};
    const instanceVarName = String(taskPayload.instanceVariable || taskPayload.instanceVar || 'instanceNumber').trim();
    const nextVars = { ...inheritedVars };
    if (instanceVarName && result.instanceNumber != null && result.instanceNumber !== '') {
      nextVars[instanceVarName] = String(result.instanceNumber);
    }

    const created = enqueueFollowupTasks(session.deviceId, taskPayload.followup, nextVars);
    if (created > 0) {
      logger.info(`[ACS] Enqueued ${created} follow-up task(s) after addObject for ${session.deviceId}`);
    }
  }

  if (taskId) redactCompletedTaskPayload(taskId);
  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  return handleEmptyPost(session, sid, res);
}

// Retry valid members of a GetParameterValues batch if the CPE returns CWMP
// fault 9005. If the fault identifies the rejected parameter, remove only that
// path; otherwise bisect the batch. Singleton failures are recorded, not retried.
function recoverInvalidGetParameterValuesTask(taskId, deviceId, fault) {
  try {
    const row = db.prepare('SELECT name, payload FROM acs_tasks WHERE id = ?').get(taskId);
    if (!row || row.name !== 'getParameterValues') return 0;
    const faultText = [fault?.faultCode, fault?.faultString, fault?.detail].filter(Boolean).join(' ');
    if (!/\b9005\b|invalid parameter name/i.test(faultText)) return 0;

    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
    const names = payload.parameterNames || payload.names || [];
    if (!Array.isArray(names) || names.length < 2) return 0;

    let batches = [];
    const match = faultText.match(/Invalid parameter name\s*:\s*([A-Za-z0-9_.:-]+)/i);
    if (match) {
      const badPath = match[1];
      const remaining = names.filter(name => String(name) !== badPath);
      if (remaining.length > 0 && remaining.length < names.length) batches = [remaining];
    }
    if (batches.length === 0) {
      const middle = Math.ceil(names.length / 2);
      batches = [names.slice(0, middle), names.slice(middle)].filter(batch => batch.length > 0);
    }

    const insert = db.prepare(
      "INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at) VALUES (?, 'getParameterValues', ?, 'pending', ?, ?)"
    );
    const now = nowLocal();
    let created = 0;
    for (const batch of batches) {
      const nextPayload = { ...payload, parameterNames: batch };
      delete nextPayload.names;
      insert.run(deviceId, JSON.stringify(nextPayload), now, now);
      created += 1;
    }
    if (created) {
      logger.info('[ACS] CWMP 9005 recovery queued ' + created + ' smaller GetParameterValues request(s) for device ' + deviceId + ' (task ' + taskId + ')');
    }
    return created;
  } catch (err) {
    logger.warn('[ACS] Could not recover GetParameterValues task ' + taskId + ': ' + err.message);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HANDLER: SOAP Fault
// ═══════════════════════════════════════════════════════════════════════════════

function handleFault(fault, session, sid, res) {
  const taskId = session.currentTaskId;

  try {
    let taskInfo = '';
    let taskName = '';
    let taskPayload = '';
    if (taskId) {
      const row = db.prepare('SELECT name, payload FROM acs_tasks WHERE id = ?').get(taskId);
      if (row) {
        taskName = String(row.name || '');
        taskPayload = String(row.payload || '');
        taskInfo = ` task=${taskName} payload=${redactSensitivePayloadText(taskPayload).substring(0, 500)}`;
      }
    }
    const det = fault.detail ? String(fault.detail).replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    const repeated = shouldThrottleFaultLog(session.deviceId, fault, taskName, taskPayload);
    const message = `[ACS] SOAP Fault from device ${session.deviceId}: code=${fault.faultCode} string=${fault.faultString}${det ? ' detail=' + det : ''}${taskInfo}`;
    if (repeated) logger.debug(`${message} (repeat suppressed)`);
    else logger.warn(message);
  } catch (e) {
    logger.warn(`[ACS] SOAP Fault from device ${session.deviceId}: code=${fault.faultCode} string=${fault.faultString}`);
  }

  if (taskId) {
    failTask(taskId, fault);
    try {
      const taskRow = db.prepare('SELECT payload FROM acs_tasks WHERE id=?').get(taskId);
      const taskPayload = JSON.parse(taskRow?.payload || '{}');
      if (Number(taskPayload.acsCrCredentialRepair?.version) >= 1) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='failed',last_message=?,updated_at=? WHERE device_id=? AND task_id=?`)
          .run(`CWMP menolak pengaturan Connection Request (fault ${String(fault?.faultCode || 'unknown')}); tidak ada rotasi ulang otomatis.`, nowLocal(), String(session.deviceId), Number(taskId));
      }
    } catch (repairError) {
      logger.warn(`[ACS] Could not update Connection Request repair status for task ${taskId}: ${String(repairError.message || repairError).slice(0, 180)}`);
    }
    try {
      const wanTask = db.prepare('SELECT name,payload FROM acs_tasks WHERE id=?').get(taskId);
      const wanPayload = JSON.parse(wanTask?.payload || '{}');
      const wanVars = wanPayload.templateVars && typeof wanPayload.templateVars === 'object' ? wanPayload.templateVars : {};
      const workflow = String(wanPayload.workflowType || wanVars.workflowType || '');
      const customerId = Number(wanPayload.customerId || wanVars.customerId || 0);
      if (workflow === 'tech_binding_wan' && customerId > 0) {
        const detail = `Task ${String(wanTask?.name || 'ACS')} mendapat CWMP fault ${String(fault?.faultCode || 'unknown')}; task AddObject tidak diulang. Status akan ditentukan dari read-back parameter inti.`;
        db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage='followup_fault',last_message=?,updated_at=CURRENT_TIMESTAMP
          WHERE customer_id=? AND acs_device_id=?`).run(detail, customerId, String(session.deviceId));
      }
    } catch (wanError) {
      logger.warn(`[ACS] Could not update technician WAN workflow after task fault ${taskId}: ${String(wanError.message || wanError).slice(0, 180)}`);
    }
    recoverInvalidGetParameterValuesTask(taskId, session.deviceId, fault);
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();

  // Try next task
  return handleEmptyPost(session, sid, res);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function sendSoapResponse(res, soapXml) {
  res.status(200)
    .set('Content-Type', 'text/xml; charset=utf-8')
    .set('SOAPAction', '')
    .send(soapXml);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONNECTION REQUEST TRIGGER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send an HTTP GET to the CPE's ConnectionRequestURL to trigger a new session.
 * Fire-and-forget. Supports Basic Auth.
 *
 * @param {string} deviceId
 * @returns {Promise<{success:boolean, message:string}>}
 */
const activeTriggers = new Map();
const lastTriggerTimes = new Map();

async function triggerConnectionRequest(deviceId) {
  // Coalesce duplicate requests instead of cancelling the existing timer. The old
  // implementation cleared the timer but left the first Promise unresolved forever.
  if (activeTriggers.has(deviceId)) {
    return { success: true, message: 'Connection request already scheduled (debounced).' };
  }

  return new Promise((resolve) => {
    const timeoutObj = setTimeout(async () => {
      activeTriggers.delete(deviceId);

      const lastTime = lastTriggerTimes.get(deviceId) || 0;
      if (Date.now() - lastTime < 3000) {
        logger.debug(`[ACS] Connection request to ${deviceId} throttled (already sent within 3s)`);
        resolve({ success: true, message: 'Throttled' });
        return;
      }

      lastTriggerTimes.set(deviceId, Date.now());

      try {
        const res = await performConnectionRequest(deviceId);
        resolve(res);
      } catch (err) {
        resolve({ success: false, message: err.message });
      }
    }, 1000); // 1-second debounce window

    activeTriggers.set(deviceId, timeoutObj);
  });
}

function parseWwwAuthenticate(header) {
  const params = {};
  const cleanHeader = String(header || '').replace(/^Digest\s+/i, '');
  // Digest values such as qop="auth,auth-int" may themselves contain commas;
  // parse quoted values as a whole instead of splitting the header on every comma.
  const expression = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
  let match;
  while ((match = expression.exec(cleanHeader)) !== null) {
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] || '');
    // HTTP authentication parameter names are case-insensitive. Some ONTs send
    // Algorithm="MD5" (capital A); normalize keys so the Digest builder emits the
    // advertised algorithm consistently instead of silently omitting it.
    params[match[1].toLowerCase()] = value;
  }
  return params;
}

function buildDigestAuthorization(method, uri, authParams, username, password) {
  const realm = authParams.realm;
  const nonce = authParams.nonce;
  const opaque = authParams.opaque;
  const offeredQop = String(authParams.qop || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const qop = offeredQop.includes('auth') ? 'auth' : (offeredQop.includes('auth-int') ? 'auth-int' : '');
  if (!realm || !nonce) throw new Error('Digest challenge tidak memiliki realm/nonce');
  if (offeredQop.length && !qop) throw new Error('Digest qop tidak didukung perangkat');

  const md5 = value => crypto.createHash('md5').update(value).digest('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const emptyEntityHash = md5('');
  const ha2 = qop === 'auth-int' ? md5(`${method}:${uri}:${emptyEntityHash}`) : md5(`${method}:${uri}`);
  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  if (authParams.algorithm) authHeader += `, algorithm=${authParams.algorithm}`;

  if (qop) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    authHeader += `, response="${response}"`;
  }
  if (opaque) authHeader += `, opaque="${opaque}"`;
  return authHeader;
}

async function performConnectionRequest(deviceId) {
  try {
    const device = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
    if (!device) {
      return { success: false, message: `Device ${deviceId} not found` };
    }

    // Older rows may have the credentials only in the merged TR-069 params JSON.
    // Prefer dedicated columns, then fall back to the exact standard parameter paths.
    let storedParams = {};
    try { storedParams = JSON.parse(device.params || '{}'); } catch (_) { /* empty */ }
    const paramText = value => {
      if (value && typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
        else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
      }
      return value == null ? '' : String(value).trim();
    };
    // Prefer the URL most recently reported by the CPE over the legacy dedicated
    // column. Older sync code rewrote that column to the PPPoE session IP, which is
    // not necessarily the Connection Request listener and may be stale after disconnect.
    const crUrl = paramText(storedParams['InternetGatewayDevice.ManagementServer.ConnectionRequestURL'])
      || paramText(storedParams['Device.ManagementServer.ConnectionRequestURL'])
      || paramText(device.connection_request_url);
    const crUser = paramText(device.connection_request_user)
      || paramText(storedParams['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername'])
      || paramText(storedParams['Device.ManagementServer.ConnectionRequestUsername']);
    const crPass = paramText(device.connection_request_pass)
      || paramText(storedParams['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword'])
      || paramText(storedParams['Device.ManagementServer.ConnectionRequestPassword']);

    if (!crUrl) {
      return { success: false, message: `No ConnectionRequestURL for device ${deviceId}` };
    }
    // Do not spam the CPE with Basic/Digest requests that cannot authenticate. A blank
    // stored password usually means TR-069 intentionally did not return the write-only
    // value; repair credentials over an authenticated CWMP Inform instead.
    if (!crUser || !crPass) {
      logger.warn(`[ACS] Connection request skipped for ${deviceId}: username/password missing in ACS cache; awaiting safe CWMP credential synchronization.`);
      return { success: false, message: 'Connection Request credentials missing; no HTTP request sent.' };
    }

    let url;
    try { url = new URL(crUrl); }
    catch (_) { return { success: false, message: `Invalid ConnectionRequestURL for device ${deviceId}` }; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return { success: false, message: `Unsupported ConnectionRequestURL scheme/host for device ${deviceId}` };
    }
    if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) {
      logger.warn(`[ACS] Connection request skipped for ${deviceId}: invalid URL port ${url.port}.`);
      return { success: false, message: `Invalid ConnectionRequestURL port for device ${deviceId}` };
    }
    // CPEs may place a unique authorization token in the URL path; log origin only.
    logger.info(`[ACS] Triggering connection request to ${deviceId} → ${url.origin} (path redacted)`);

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 10000,
      rejectUnauthorized: false, // Self-signed certs on CPE devices
    };

    // Initialize with Basic Auth
    if (crUser) {
      options.auth = `${crUser}:${crPass}`;
    }

    return new Promise((resolve) => {
      const executeRequest = (authHeader = null) => {
        const reqOptions = { ...options };
        if (authHeader) {
          delete reqOptions.auth;
          reqOptions.headers = reqOptions.headers || {};
          reqOptions.headers['Authorization'] = authHeader;
        }

        const req = transport.request(reqOptions, (resp) => {
          resp.resume();
          logger.info(`[ACS] Connection request to ${deviceId} returned HTTP ${resp.statusCode}`);

          if (resp.statusCode === 401 && resp.headers['www-authenticate'] && crUser && !authHeader) {
            const wwwAuth = resp.headers['www-authenticate'];
            logger.info(`[ACS] Got 401 challenge from ${deviceId}, retrying with Digest Auth`);
            try {
              const authParams = parseWwwAuthenticate(wwwAuth);
              const digestHeader = buildDigestAuthorization('GET', options.path, authParams, crUser, crPass);
              executeRequest(digestHeader);
            } catch (err) {
              logger.error(`[ACS] Failed to construct Digest Auth: ${err.message}`);
              resolve({ success: false, message: `Digest Auth failure: ${err.message}` });
            }
            return;
          }

          resolve({ success: resp.statusCode < 400, message: `Connection request completed with HTTP ${resp.statusCode}` });
        });

        req.on('error', (err) => {
          logger.warn(`[ACS] Connection request to ${deviceId} failed: ${err.message}`);
          resolve({ success: false, message: `Connection request failed: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          logger.warn(`[ACS] Connection request to ${deviceId} timed out`);
          resolve({ success: false, message: 'Connection request timed out' });
        });

        req.end();
      };

      // Start first connection request attempt
      executeRequest();
    });
  } catch (err) {
    logger.error(`[ACS] Connection request error for ${deviceId}: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API: Query Devices & Create Tasks
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query acs_devices with optional filtering.
 *
 * @param {Object} [query]  – Flat object of column → value filters (AND logic).
 *                            Special keys: 'search' (fuzzy across SN/manufacturer/product_class)
 * @param {string} [projection] – Comma-separated column names to select (default: '*')
 * @returns {Array}
 */
function getBuiltinDevices(query, projection) {
  try {
    let cols = '*';
    if (projection) {
      const allowed = new Set([
        'id', 'serial_number', 'manufacturer', 'product_class', 'oui',
        'software_version', 'hardware_version', 'ip_address', 'pppoe_ip_address',
        'connection_request_url', 'connection_request_user', 'connection_request_pass',
        'tags', 'params', 'last_inform', 'created_at', 'updated_at'
      ]);
      const requested = projection.split(',').map(c => c.trim()).filter(c => allowed.has(c));
      if (requested.length > 0) cols = requested.join(', ');
    }

    let sql = `SELECT ${cols} FROM acs_devices`;
    const conditions = [];
    const values = [];

    if (query && typeof query === 'object') {
      for (const [key, val] of Object.entries(query)) {
        if (key === 'search' && val) {
          conditions.push(
            `(serial_number LIKE ? OR manufacturer LIKE ? OR product_class LIKE ? OR id LIKE ?)`
          );
          const like = `%${val}%`;
          values.push(like, like, like, like);
        } else if (key === 'tags' && val) {
          conditions.push(`tags LIKE ?`);
          values.push(`%${val}%`);
        } else if (['id', 'serial_number', 'manufacturer', 'product_class', 'oui', 'ip_address', 'pppoe_ip_address'].includes(key)) {
          conditions.push(`${key} = ?`);
          values.push(val);
        }
      }
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY last_inform DESC';

    const rows = db.prepare(sql).all(...values);

    // Parse JSON fields
    return rows.map(row => {
      try { row.tags = JSON.parse(row.tags || '[]'); } catch (_) { row.tags = []; }
      try { row.params = JSON.parse(row.params || '{}'); } catch (_) { row.params = {}; }
      return row;
    });
  } catch (err) {
    logger.error(`[ACS] getBuiltinDevices error: ${err.message}`);
    return [];
  }
}

/**
 * Get a single device by its canonical ID.
 *
 * @param {string} deviceId
 * @returns {Object|null}
 */
function getBuiltinDevice(deviceId) {
  try {
    const row = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
    if (!row) return null;
    try { row.tags = JSON.parse(row.tags || '[]'); } catch (_) { row.tags = []; }
    try { row.params = JSON.parse(row.params || '{}'); } catch (_) { row.params = {}; }
    return row;
  } catch (err) {
    logger.error(`[ACS] getBuiltinDevice error: ${err.message}`);
    return null;
  }
}

/**
 * Create a new task for a device and trigger a connection request.
 *
 * @param {string}  deviceId  – acs_devices.id
 * @param {string}  taskName  – reboot | setParameterValues | getParameterValues | refreshObject | factoryReset | addObject
 * @param {Object}  payload   – Task-specific data
 * @returns {{ success: boolean, taskId?: number, message?: string }}
 */
function createBuiltinTask(deviceId, taskName, payload) {
  try {
    const now = nowLocal();
    const payloadStr = JSON.stringify(payload || {});

    const info = db.prepare(
      `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ).run(deviceId, taskName, payloadStr, now, now);

    const taskId = Number(info.lastInsertRowid);

    logger.info(`[ACS] Task ${taskId} (${taskName}) created for device ${deviceId}`);

    // Fire-and-forget connection request to wake up the CPE
    triggerConnectionRequest(deviceId).catch(err => {
      logger.warn(`[ACS] Failed to trigger connection request for ${deviceId}: ${err.message}`);
    });

    return { success: true, taskId, message: `Task ${taskName} created` };
  } catch (err) {
    logger.error(`[ACS] createBuiltinTask error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// Queue only read-only Wi-Fi client discovery for one known Built-in ACS device.
// This helper is idempotent and deliberately does not alter SSID, password, WAN, or PPPoE.
function queueConnectedClientRefreshForDevice(deviceId) {
  try {
    const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(String(deviceId || ''));
    if (!row) return { ok: false, queued: 0, message: 'Perangkat tidak ditemukan.' };
    const beforeId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM acs_tasks').get()?.id || 0);
    let params = {};
    try { params = JSON.parse(row.params || '{}'); } catch (_) {}
    queueRealtimeMonitoringTasks(String(deviceId), params);
    const newTasks = db.prepare(
      `SELECT id, name, payload, status FROM acs_tasks
       WHERE id > ? AND device_id = ? AND status = 'pending'`
    ).all(beforeId, String(deviceId));
    return {
      ok: true,
      queued: newTasks.length,
      tasks: newTasks.map(t => ({ id: t.id, name: t.name, payload: t.payload })),
      message: newTasks.length ? 'Read-only client discovery queued.' : 'No new read-only task needed.'
    };
  } catch (err) {
    logger.warn(`[ACS] Failed to queue client discovery for ${deviceId}: ${err.message}`);
    return { ok: false, queued: 0, message: err.message };
  }
}

function getCrCredentialRepairContext(device) {
  let params = {};
  try { params = JSON.parse(device?.params || '{}'); } catch (_) {}
  const text = value => {
    if (value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
      else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
    }
    return value == null ? '' : String(value).trim();
  };
  const url = text(params['InternetGatewayDevice.ManagementServer.ConnectionRequestURL'])
    || text(params['Device.ManagementServer.ConnectionRequestURL'])
    || text(device?.connection_request_url);
  const username = text(device?.connection_request_user)
    || text(params['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername'])
    || text(params['Device.ManagementServer.ConnectionRequestUsername']);
  const password = text(device?.connection_request_pass)
    || text(params['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword'])
    || text(params['Device.ManagementServer.ConnectionRequestPassword']);
  const usesTr181 = !Object.keys(params).some(k => k.startsWith('InternetGatewayDevice.ManagementServer.'))
    && Object.keys(params).some(k => k.startsWith('Device.ManagementServer.'));
  const passwordPath = usesTr181
    ? 'Device.ManagementServer.ConnectionRequestPassword'
    : 'InternetGatewayDevice.ManagementServer.ConnectionRequestPassword';
  let urlError = '';
  if (!url) urlError = 'ConnectionRequestURL belum tersedia dari ONT.';
  else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) urlError = 'ConnectionRequestURL bukan HTTP/HTTPS dengan host valid.';
      else if (parsed.port === '0') urlError = 'ConnectionRequestURL memakai port 0; tidak aman menebak port pengganti.';
    } catch (_) { urlError = 'ConnectionRequestURL dari ONT tidak valid.'; }
  }
  const reason = urlError || (!username ? 'Username Connection Request tidak tersedia; tidak akan ditebak.' : '');
  return { url, username, password, passwordPath, reason, params };
}

async function verifyCrCredentialsAfterTask(deviceId, taskId) {
  try {
    db.prepare(`UPDATE acs_cr_repair_jobs SET status='verifying', last_message='Password diterima melalui CWMP; menguji Connection Request.', updated_at=?
      WHERE device_id=? AND task_id=?`).run(nowLocal(), String(deviceId), Number(taskId));
  } catch (_) { /* manual one-off repair may not have a queue row */ }

  const result = await triggerConnectionRequest(deviceId);
  const m = String(result?.message || '');
  const statusCode = Number((m.match(/HTTP\s+(\d{3})/i) || [])[1] || 0);
  const verified = Boolean(result?.success && statusCode >= 200 && statusCode < 300);
  const state = verified ? 'verified' : 'failed';
  const message = verified
    ? `Kredensial diterima; Connection Request membalas HTTP ${statusCode}.`
    : `Password sudah dikirim, tetapi Connection Request belum terverifikasi: ${m || 'hasil tidak tersedia'}. Tidak ada rotasi ulang otomatis.`;
  db.prepare(`UPDATE acs_cr_repair_jobs SET status=?,last_message=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,updated_at=?
    WHERE device_id=? AND task_id=?`)
    .run(state, message.slice(0, 500), state, nowLocal(), nowLocal(), String(deviceId), Number(taskId));
  logger.info(`[ACS] Connection Request credential repair ${verified ? 'verified' : 'not verified'} for ${deviceId}: ${message.slice(0, 180)}`);
  return { verified, message };
}

function initializeCrCredentialRepairQueue() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS acs_cr_repair_jobs (
      device_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      task_id INTEGER,
      parameter_path TEXT,
      last_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT
    )`);
    const rows = db.prepare('SELECT id, manufacturer, product_class, connection_request_url, connection_request_user, connection_request_pass, params, last_inform FROM acs_devices').all();
    const insert = db.prepare(`INSERT OR IGNORE INTO acs_cr_repair_jobs
      (device_id,status,parameter_path,last_message,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
    const now = nowLocal();
    let queued = 0, manual = 0;
    for (const device of rows) {
      const context = getCrCredentialRepairContext(device);
      if (context.password) continue;
      // Missing Connection Request credentials are recorded for review only.
      // Never enqueue a credential write for every device automatically.
      const status = 'needs_manual';
      const message = context.reason || 'Perbaikan otomatis dinonaktifkan; pilih satu ONT untuk pemeriksaan manual setelah Inform diterima.';
      const result = insert.run(String(device.id), status, context.passwordPath, message, now, now);
      if (result.changes) {
        if (status === 'queued') queued++;
        else manual++;
      }
    }
    if (queued || manual) logger.info(`[ACS] Connection Request review queue initialized: ${queued} queued, ${manual} need manual review; automatic credential writes are opt-in.`);
  } catch (error) {
    logger.error(`[ACS] Failed to initialize Connection Request credential repair queue: ${String(error.message || error).slice(0, 220)}`);
  }
}

let crCredentialRepairWorkerRunning = false;
async function processCrCredentialRepairQueue() {
  if (crCredentialRepairWorkerRunning) return;
  const builtinEnabled = getSetting('use_builtin_acs', false) === true || getSetting('use_builtin_acs', false) === 'true';
  if (!builtinEnabled) return;
  crCredentialRepairWorkerRunning = true;
  try {
    const nowMs = Date.now();
    // Release a slot when an offline device has not taken its queued task for 15 minutes.
    // The original task is retained for the next Inform; it is never duplicated.
    const waiting = db.prepare(`SELECT j.device_id,j.task_id,j.status,j.updated_at,t.status AS task_status,t.created_at,d.last_inform
      FROM acs_cr_repair_jobs j LEFT JOIN acs_tasks t ON t.id=j.task_id
      LEFT JOIN acs_devices d ON d.id=j.device_id WHERE j.status IN ('waiting_task','waiting_device','verifying','probing')`).all();
    for (const job of waiting) {
      const taskAge = job.created_at ? nowMs - Date.parse(job.created_at) : 0;
      const verificationAge = job.updated_at ? nowMs - Date.parse(job.updated_at) : 0;
      if (job.status === 'probing') {
        if (job.task_status === 'completed') {
          const device = db.prepare('SELECT id,manufacturer,product_class,connection_request_url,connection_request_user,connection_request_pass,params,last_inform FROM acs_devices WHERE id=?').get(job.device_id);
          const context = getCrCredentialRepairContext(device);
          const nextStatus = context.reason ? 'needs_manual' : (context.password ? 'verified' : 'queued');
          const nextMessage = context.reason || (context.password
            ? 'Password Connection Request sudah tersimpan setelah pembacaan ulang; rotasi dilewati.'
            : 'URL dan username berhasil dibaca ulang; masuk antrean rotasi kredensial melalui CWMP.');
          db.prepare(`UPDATE acs_cr_repair_jobs SET status=?,last_message=?,updated_at=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END WHERE device_id=? AND task_id=?`)
            .run(nextStatus, nextMessage, nowLocal(), nextStatus, nowLocal(), job.device_id, job.task_id);
        } else if (job.task_status === 'failed') {
          db.prepare(`UPDATE acs_cr_repair_jobs SET status='needs_manual',last_message='Pembacaan ulang Connection Request ditolak oleh ONT; tidak mengubah nilai atau menebak kredensial.',updated_at=? WHERE device_id=? AND task_id=?`)
            .run(nowLocal(), job.device_id, job.task_id);
        } else if (!job.task_status) {
          db.prepare(`UPDATE acs_cr_repair_jobs SET status='needs_manual',last_message='Task pembacaan ulang tidak ditemukan; tidak membuat task duplikat otomatis.',updated_at=? WHERE device_id=? AND task_id=?`)
            .run(nowLocal(), job.device_id, job.task_id);
        }
        // A pending probe is retained as a single task until the CPE next Inform; no duplicate is created.
        continue;
      }
      if (job.task_status === 'completed') {
        // The task handler normally initiates this verification. Recover safely if the
        // process restarted between marking the task complete and finishing the check.
        if (job.status !== 'verifying' || verificationAge > 2 * 60 * 1000) {
          await verifyCrCredentialsAfterTask(job.device_id, job.task_id);
        }
      } else if (job.task_status === 'failed') {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='failed',last_message='CWMP task gagal; tidak diulang otomatis.',updated_at=? WHERE device_id=? AND task_id=?`)
          .run(nowLocal(), job.device_id, job.task_id);
      } else if (job.task_status === 'pending' && taskAge > 15 * 60 * 1000) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='waiting_device',last_message='Task tetap pending setelah 15 menit; menunggu Inform ONT berikutnya. Tidak ada task duplikat dibuat.',updated_at=? WHERE device_id=? AND task_id=? AND status='waiting_task'`)
          .run(nowLocal(), job.device_id, job.task_id);
      } else if (!job.task_status) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='failed',last_message='Task ACS tidak ditemukan; tidak membuat ulang secara otomatis.',updated_at=? WHERE device_id=? AND task_id=?`)
          .run(nowLocal(), job.device_id, job.task_id);
      }
    }

    // Keep verification/reconciliation of tasks already sent above, but gate ALL
    // new Connection Request credential writes and discovery probes behind explicit
    // opt-in from BOTH the process environment and the admin setting.
    const autoRepairEnabled =
      process.env.ACS_CR_AUTO_REPAIR_ENABLED === 'true' &&
      String(getSetting('acs_cr_auto_repair_enabled', false)).toLowerCase() === 'true';
    if (!autoRepairEnabled) return;

    const activeCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM acs_cr_repair_jobs j JOIN acs_tasks t ON t.id=j.task_id
      WHERE j.status IN ('waiting_task','probing') AND t.status IN ('pending','in_progress')
      AND julianday(t.created_at) >= julianday('now','-15 minutes')`).get()?.n || 0);
    const allowance = Math.max(0, Math.min(5, 10 - activeCount));
    if (!allowance) return;

    // HTTP 401 means the endpoint is reachable but the currently synchronized credential pair
    // is rejected. A proven test showed password-only rotation can leave this mismatch in place;
    // reconcile username + password together once, only for recent Informing CPEs and only when
    // the failed task was a version-1 password-only repair. Version-2 failures are never retried.
    let queued = 0;
    const authCandidates = db.prepare(`SELECT j.device_id,j.task_id,j.last_message,d.id,d.manufacturer,d.product_class,
      d.connection_request_url,d.connection_request_user,d.connection_request_pass,d.params,d.last_inform,t.payload AS prior_payload
      FROM acs_cr_repair_jobs j JOIN acs_devices d ON d.id=j.device_id
      JOIN acs_tasks t ON t.id=j.task_id
      WHERE j.status='failed' AND j.last_message LIKE '%HTTP 401%'
        AND d.last_inform IS NOT NULL AND julianday(d.last_inform) >= julianday('now','-10 minutes')
      ORDER BY j.updated_at DESC LIMIT 30`).all();
    for (const device of authCandidates) {
      if (queued >= Math.min(2, allowance)) break;
      let priorPayload = {};
      try { priorPayload = JSON.parse(device.prior_payload || '{}'); } catch (_) {}
      if (Number(priorPayload.acsCrCredentialRepair?.version) !== 1) continue;
      const busy = db.prepare("SELECT id FROM acs_tasks WHERE device_id=? AND status IN ('pending','in_progress') LIMIT 1").get(device.id);
      if (busy) continue;
      const context = getCrCredentialRepairContext(device);
      if (context.reason) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='needs_manual',last_message=?,updated_at=? WHERE device_id=? AND task_id=?`)
          .run(context.reason, nowLocal(), device.id, device.task_id);
        continue;
      }
      const username = 'acs' + crypto.randomBytes(5).toString('hex');
      const password = crypto.randomBytes(24).toString('base64url');
      const usernamePath = context.passwordPath.replace(/ConnectionRequestPassword$/, 'ConnectionRequestUsername');
      const stamp = nowLocal();
      const payload = {
        parameterValues: [[usernamePath, username, 'xsd:string'], [context.passwordPath, password, 'xsd:string']],
        acsCrCredentialRepair: { version: 2, createdAt: stamp, reason: 'reconcile both credentials after verified HTTP 401; no PPPoE credential change' }
      };
      const info = db.prepare(`INSERT INTO acs_tasks(device_id,name,payload,status,created_at,updated_at)
        VALUES(?,'setParameterValues',?,'pending',?,?)`).run(device.id, JSON.stringify(payload), stamp, stamp);
      db.prepare(`UPDATE acs_cr_repair_jobs SET status='waiting_task',task_id=?,parameter_path=?,last_message='HTTP 401 setelah rotasi password saja; username + password direkonsiliasi sekali via CWMP, menunggu verifikasi Digest.',updated_at=? WHERE device_id=?`)
        .run(Number(info.lastInsertRowid), `${usernamePath},${context.passwordPath}`, stamp, device.id);
      logger.info(`[ACS] Queued one-time paired Connection Request credential reconciliation task ${info.lastInsertRowid} for ${device.id}; credentials not logged.`);
      queued++;
    }

    // A small number of manual cases may be recoverable by refreshing the standard
    // ConnectionRequestURL/Username leaves. These are read-only and do not guess ports
    // or credentials; ONTs must have Inform'd recently and have no other active task.
    const probeCandidates = db.prepare(`SELECT j.device_id,d.id,d.manufacturer,d.product_class,d.connection_request_url,
      d.connection_request_user,d.connection_request_pass,d.params,d.last_inform
      FROM acs_cr_repair_jobs j JOIN acs_devices d ON d.id=j.device_id
      WHERE j.status='needs_manual' AND j.task_id IS NULL AND d.last_inform IS NOT NULL
        AND julianday(d.last_inform) >= julianday('now','-10 minutes')
      ORDER BY d.last_inform DESC LIMIT 30`).all();
    for (const device of probeCandidates) {
      if (queued >= Math.min(2, allowance)) break;
      const busy = db.prepare("SELECT id FROM acs_tasks WHERE device_id=? AND status IN ('pending','in_progress') LIMIT 1").get(device.id);
      if (busy) continue;
      let params = {};
      try { params = JSON.parse(device.params || '{}'); } catch (_) {}
      const hasIgdManagement = Object.keys(params).some(path => path.startsWith('InternetGatewayDevice.ManagementServer.'));
      const hasTr181Management = Object.keys(params).some(path => path.startsWith('Device.ManagementServer.'));
      const root = !hasIgdManagement && hasTr181Management ? 'Device.ManagementServer.' : 'InternetGatewayDevice.ManagementServer.';
      const parameterNames = [root + 'ConnectionRequestURL', root + 'ConnectionRequestUsername'];
      const stamp = nowLocal();
      const payload = { parameterNames, acsCrCredentialProbe: { version: 1, createdAt: stamp } };
      const info = db.prepare(`INSERT INTO acs_tasks(device_id,name,payload,status,created_at,updated_at)
        VALUES(?,'getParameterValues',?,'pending',?,?)`).run(device.id, JSON.stringify(payload), stamp, stamp);
      db.prepare(`UPDATE acs_cr_repair_jobs SET status='probing',task_id=?,parameter_path=?,last_message='Membaca ulang URL dan username Connection Request melalui CWMP; tidak mengubah konfigurasi.',updated_at=? WHERE device_id=? AND status='needs_manual' AND task_id IS NULL`)
        .run(Number(info.lastInsertRowid), parameterNames.join(','), stamp, device.id);
      logger.info(`[ACS] Queued read-only Connection Request probe ${info.lastInsertRowid} for ${device.id}; no credentials or URL are guessed.`);
      queued++;
    }

    const candidates = db.prepare(`SELECT j.device_id,d.id,d.manufacturer,d.product_class,d.connection_request_url,
      d.connection_request_user,d.connection_request_pass,d.params,d.last_inform
      FROM acs_cr_repair_jobs j JOIN acs_devices d ON d.id=j.device_id
      WHERE j.status='queued' AND d.last_inform IS NOT NULL
        AND julianday(d.last_inform) >= julianday('now','-10 minutes')
      ORDER BY d.last_inform DESC LIMIT 60`).all();
    for (const device of candidates) {
      if (queued >= allowance) break;
      const busy = db.prepare("SELECT id FROM acs_tasks WHERE device_id=? AND status IN ('pending','in_progress') LIMIT 1").get(device.id);
      if (busy) continue;
      const context = getCrCredentialRepairContext(device);
      if (context.password) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='verified',last_message='Password Connection Request sudah tersimpan; rotasi dilewati.',verified_at=?,updated_at=? WHERE device_id=? AND status='queued'`)
          .run(nowLocal(), nowLocal(), device.id);
        continue;
      }
      if (context.reason) {
        db.prepare(`UPDATE acs_cr_repair_jobs SET status='needs_manual',last_message=?,updated_at=? WHERE device_id=? AND status='queued'`)
          .run(context.reason, nowLocal(), device.id);
        continue;
      }
      const password = crypto.randomBytes(18).toString('base64url');
      const payload = {
        name: 'setParameterValues',
        parameterValues: [[context.passwordPath, password, 'xsd:string']],
        acsCrCredentialRepair: { version: 1, createdAt: nowLocal() }
      };
      const stamp = nowLocal();
      const info = db.prepare(`INSERT INTO acs_tasks(device_id,name,payload,status,created_at,updated_at)
        VALUES(?,'setParameterValues',?,'pending',?,?)`).run(device.id, JSON.stringify(payload), stamp, stamp);
      db.prepare(`UPDATE acs_cr_repair_jobs SET status='waiting_task',task_id=?,parameter_path=?,last_message='Kredensial baru dikirim lewat CWMP; menunggu respons ONT dan uji HTTP.',updated_at=? WHERE device_id=? AND status='queued'`)
        .run(Number(info.lastInsertRowid), context.passwordPath, stamp, device.id);
      logger.info(`[ACS] Queued Connection Request credential repair task ${info.lastInsertRowid} for ${device.id} (${device.manufacturer || '?'} ${device.product_class || '?'}); password not logged.`);
      queued++;
    }
  } catch (error) {
    logger.error(`[ACS] Connection Request repair worker failed: ${String(error.message || error).slice(0, 220)}`);
  } finally {
    crCredentialRepairWorkerRunning = false;
  }
}

initializeCrCredentialRepairQueue();
const crRepairWorkerTimer = setInterval(() => { processCrCredentialRepairQueue().catch(() => {}); }, 30_000);
if (typeof crRepairWorkerTimer.unref === 'function') crRepairWorkerTimer.unref();
processCrCredentialRepairQueue().catch(() => {});

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  handleCwmpRequest,
  triggerConnectionRequest,
  getBuiltinDevices,
  getBuiltinDevice,
  createBuiltinTask,
  queueConnectedClientRefreshForDevice,
};
