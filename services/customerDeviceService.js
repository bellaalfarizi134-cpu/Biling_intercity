/**
 * Logika GenieACS yang dipakai portal web dan bot WhatsApp.
 * Updated to support multi-server GenieACS setup.
 */
const axios = require('axios');
const db = require('../config/database');
const { getSettingsWithCache } = require('../config/settingsManager');
const auditTrail = require('./auditTrailService');
const { logger } = require('../config/logger');
const genieacsApi = require('../config/genieacs');
const mikrotikService = require('./mikrotikService');

// Helper: Search device across all servers (always get full data)
async function searchDeviceAcrossServers(query, fullData = true) {
  try {
    const servers = genieacsApi.getAllACSServers();
    
    for (const server of servers) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        const params = {
          query: JSON.stringify(query)
        };
        
        // Only add projection if explicitly requesting minimal data
        if (!fullData) {
          params.projection = '_id,_tags';
        }

        let response;
        try {
          response = await instance.get('/devices', {
            params,
            timeout: 2000
          });
        } catch (e) {
          response = await instance.get('/api/devices', {
            params,
            timeout: 2000
          });
        }
        
        if (response.data && response.data.length > 0) {
          const device = response.data[0];
          device._acs_server_id = server.id;
          device._acs_server_name = server.name;
          logger.debug(`[CustomerDevice] Device found on ${server.name}`);
          return device;
        }
      } catch (error) {
        logger.debug(`[CustomerDevice] Device not found on ${server.name}: ${error.message}`);
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`[CustomerDevice] Error searching device: ${error.message}`);
    return null;
  }
}

async function findDeviceByTag(tag) {
  try {
    const query = { $or: [{ _id: tag }, { _tags: tag }] };
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by tag: ${e.message}`);
    return null;
  }
}

async function findDeviceByPppoe(pppoeUser) {
  try {
    const user = String(pppoeUser || '').trim();
    if (!user) return null;
    const keys = [
      'VirtualParameters.pppoeUsername',
      'VirtualParameters.pppUsername',
      ...PPPOE_USER_KEYS
    ];
    const query = { $or: keys.map(k => ({ [k]: user })) };
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by PPPoE: ${e.message}`);
    return null;
  }
}

async function fetchFullDevice(tag) {
  try {
    const query = { $or: [{ _id: tag }, { _tags: tag }] };
    // Always get full data
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error fetching full device: ${e.message}`);
    return null;
  }
}

async function resolveDeviceToken(input) {
  const token = String(input ?? '').replace(/[\r\n\t]+/g, '').trim();
  if (!token) return null;
  // 'bootstrapped' is an internal ACS maintenance marker shared by many ONUs,
  // not a unique customer/device identifier. Refuse it to prevent wrong-device edits.
  if (token.toLowerCase() === 'bootstrapped') {
    logger.warn('[CustomerDevice] Rejected internal ACS tag as device selector');
    return null;
  }

  const direct = await findDeviceByTag(token);
  if (direct && direct._id) return direct;

  const byPppoe = await findDeviceByPppoe(token);
  if (byPppoe && byPppoe._id) return byPppoe;

  const found = await findDeviceWithTagVariants(token);
  if (found && found.device && found.device._id) return found.device;

  return null;
}

function buildTrafficCounterPaths(direction) {
  const sent = direction === 'tx';
  const common = sent ? 'TotalBytesSent' : 'TotalBytesReceived';
  const ethernet = sent ? 'BytesSent' : 'BytesReceived';
  const ppp = sent ? 'EthernetBytesSent' : 'EthernetBytesReceived';
  const paths = [
    'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.' + common,
    'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.Stats.' + ethernet,
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.Stats.' + ethernet,
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.Stats.' + ethernet,
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.Stats.' + ethernet,
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.Stats.' + ethernet
  ];
  for (const connectionDevice of [1, 2, 3]) {
    for (const kind of ['WANPPPConnection', 'WANIPConnection']) {
      for (const instance of [1, 2, 3]) {
        paths.push('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.' + connectionDevice + '.' + kind + '.' + instance + '.Stats.' + ppp);
      }
    }
  }
  for (const instance of [1, 2, 3, 4]) {
    paths.push('Device.PPP.Interface.' + instance + '.Stats.' + ethernet);
    paths.push('Device.IP.Interface.' + instance + '.Stats.' + ethernet);
    paths.push('Device.Ethernet.Interface.' + instance + '.Stats.' + ethernet);
  }
  return [...new Set(paths)];
}

const parameterPaths = {
  serialNumber: [
    'DeviceID.SerialNumber',
    'InternetGatewayDevice.DeviceInfo.SerialNumber',
    'Device.DeviceInfo.SerialNumber'
  ],
  model: [
    'DeviceID.ProductClass',
    'InternetGatewayDevice.DeviceInfo.ModelName',
    'Device.DeviceInfo.ModelName',
    'ModelName'
  ],
  softwareVersion: [
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'Device.DeviceInfo.SoftwareVersion'
  ],
  ssid: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
    ...Array.from({ length: 16 }, (_, i) => `Device.WiFi.SSID.${i + 1}.SSID`)
  ],
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANOAM.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_OpticalSignal.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower',
    'Device.Optical.Interface.1.OpticalSignalLevel',
    'Device.Optical.Interface.1.RXPower',
    'Device.Optical.Interface.1.ReceivePower',
    'Device.Optical.Interface.1.ReceiveSignalLevel',
    'Device.XPON.Interface.1.Stats.RXPower',
    'Device.XPON.Interface.1.Stats.RxPower',
    'Device.XPON.Interface.1.RXPower',
    'Device.XPON.Interface.1.OpticalSignalLevel'
  ],
  txPower: [
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TXPower',
    'Device.Optical.Interface.1.TransmitPower',
    'Device.XPON.Interface.1.Stats.TXPower'
  ],
  memoryTotal: [
    'InternetGatewayDevice.DeviceInfo.MemoryStatus.Total',
    'Device.DeviceInfo.MemoryStatus.Total'
  ],
  memoryFree: [
    'InternetGatewayDevice.DeviceInfo.MemoryStatus.Free',
    'Device.DeviceInfo.MemoryStatus.Free'
  ],
  cpuUsage: [
    'InternetGatewayDevice.DeviceInfo.ProcessStatus.CPUUsage',
    'Device.DeviceInfo.ProcessStatus.CPUUsage'
  ],
  trafficTx: buildTrafficCounterPaths('tx'),
  trafficRx: buildTrafficCounterPaths('rx'),
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.3.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
    'Device.PPP.Interface.1.Username',
    'Device.PPP.Interface.2.Username',
    'Device.PPP.Interface.3.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Associations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Associations',
    'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
    'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
    'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries',
    'Device.Hosts.HostNumberOfEntries'
  ]
};

// PPPoE IP search keys matching user's template
const PPPOE_IP_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress',
  'Device.PPP.Interface.1.ExternalIPAddress',
  'Device.IP.Interface.1.IPv4Address.1.IPAddress'
];

// PPPoE Username search keys matching user's template
const PPPOE_USER_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username',
  'Device.PPP.Interface.3.Username'
];

function getNestedValue(obj, path) {
  try {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (!current) return null;
      current = current[part];
    }
    if (current && typeof current === 'object' && '_value' in current) {
      return current._value;
    }
    if (current && typeof current === 'object' && current.hasOwnProperty('_value')) {
      return current._value;
    }
    return current;
  } catch (e) {
    return null;
  }
}

function getWildcardMatches(device, path) {
  const parts = path.split('.');
  const results = [];

  function recurse(current, index, currentPathParts) {
    if (current === undefined || current === null) return;
    
    if (index === parts.length) {
      let val = current;
      if (typeof current === 'object' && '_value' in current) {
        val = current._value;
      }
      results.push({
        path: currentPathParts.join('.'),
        value: val
      });
      return;
    }

    const part = parts[index];
    if (part === '*') {
      if (typeof current === 'object') {
        for (const key of Object.keys(current)) {
          if (!key.startsWith('_')) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    } else {
      if (typeof current === 'object') {
        const targetLower = part.toLowerCase();
        for (const key of Object.keys(current)) {
          if (key.toLowerCase() === targetLower) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    }
  }

  recurse(device, 0, []);
  return results;
}

function getDeviceParameterValue(device, keys, filterFn) {
  for (const key of keys) {
    const matches = getWildcardMatches(device, key);
    for (const match of matches) {
      if (filterFn) {
        if (filterFn(match.path, match.value, device)) {
          return match.value;
        }
      } else if (match.value !== undefined && match.value !== null && match.value !== '') {
        return match.value;
      }
    }
  }
  return '';
}

function extractPppoeIp(d) {
  const ip = getDeviceParameterValue(d, PPPOE_IP_KEYS, (matchedPath, value, device) => {
    if (!value || value === '0.0.0.0' || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('ExternalIPAddress', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'bridge') {
        return false;
      }
    }
    return true;
  });
  
  // Prefer the last verified RouterOS session IP over a possibly stale cached WAN value.
  if (d._pppoeIP && d._pppoeIP !== '-' && d._pppoeIP !== '0.0.0.0') return d._pppoeIP;
  if (ip) return ip;
  // _ip is the TR-069/management address and must never be mislabeled as PPPoE.
  return 'N/A';
}

function extractPppoeUser(d) {
  const user = getDeviceParameterValue(d, PPPOE_USER_KEYS, (matchedPath, value, device) => {
    if (!value || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('Username', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });
  
  return user || 'N/A';
}

function formatUptime(seconds) {
  if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
  if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
    return seconds;
  }
  const totalSecs = parseInt(seconds, 10);
  if (isNaN(totalSecs)) return seconds || 'N/A';
  const days = Math.floor(totalSecs / 86400);
  const rem = totalSecs % 86400;
  let hrs = Math.floor(rem / 3600);
  if (hrs < 10) hrs = "0" + hrs;
  const rem2 = rem % 3600;
  let mins = Math.floor(rem2 / 60);
  if (mins < 10) mins = "0" + mins;
  let secs = rem2 % 60;
  if (secs < 10) secs = "0" + secs;
  return days + "d " + hrs + ":" + mins + ":" + secs;
}

function formatDeviceTimestamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID');
}

function formatRelativeTime(value) {
  if (!value) return '-';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '-';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'baru saja';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} detik lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} jam lalu`;
  const day = Math.floor(hour / 24);
  return `${day} hari lalu`;
}

function collectRefreshObjects(device) {
  const objects = [];
  const isTr181 = !!device?.Device;
  const legacyWlan = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
  const aps = device?.Device?.WiFi?.AccessPoint || {};
  const hasLegacyWifiSsid = Object.entries(legacyWlan).some(([idx, cfg]) =>
    /^\d+$/.test(idx) && cfg?.SSID && (typeof cfg.SSID !== 'object' || cfg.SSID?._value)
  );
  const hasLegacyAssociatedEntries = Object.entries(legacyWlan).some(([idx, cfg]) =>
    /^\d+$/.test(idx) && cfg?.AssociatedDevice && Object.keys(cfg.AssociatedDevice).some(k => /^\d+$/.test(k))
  );
  const hasTr181AssociatedEntries = Object.values(aps).some(ap =>
    ap?.AssociatedDevice && Object.keys(ap.AssociatedDevice).some(k => /^\d+$/.test(k))
  );

  if (isTr181) {
    // TR-181: enumerate AP instances already present in the device cache.
    for (const [idx, ap] of Object.entries(aps)) {
      if (!/^\d+$/.test(idx) || !ap || typeof ap !== 'object') continue;
      objects.push(`Device.WiFi.AccessPoint.${idx}.AssociatedDevice`);
    }
    // Hosts.Host is a fallback only when no AssociatedDevice entries are cached.
    if (device?.Device?.Hosts?.Host && !hasTr181AssociatedEntries) objects.push('Device.Hosts.Host');
  } else {
    // TR-098: enumerate WLAN instances present in cache, not only 1 and 5.
    for (const [idx, cfg] of Object.entries(legacyWlan)) {
      if (!/^\d+$/.test(idx) || !cfg || typeof cfg !== 'object') continue;
      const ssid = cfg.SSID && (typeof cfg.SSID !== 'object' ? cfg.SSID : cfg.SSID._value);
      if (ssid) objects.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.AssociatedDevice`);
    }
    // Avoid scanning hundreds of Host rows when AssociatedDevice already works.
    if (!hasLegacyAssociatedEntries && (device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || hasLegacyWifiSsid)) {
      objects.push('InternetGatewayDevice.LANDevice.1.Hosts.Host');
    }
  }

  return Array.from(new Set(objects));
}

function getBuiltinSyncState(deviceId) {
  const empty = {
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueAt: '',
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle'
  };
  if (!deviceId) return empty;

  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS count, MAX(created_at) AS last_queue_at
       FROM acs_tasks
       WHERE device_id = ?
         AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
         AND status IN ('pending', 'in_progress')`
    ).get(deviceId);

    const count = Number(pending?.count || 0);
    const lastQueueAt = String(pending?.last_queue_at || '');
    return {
      syncInProgress: count > 0,
      syncPendingCount: count,
      syncLastQueueAt: lastQueueAt,
      syncLastQueueLabel: formatDeviceTimestamp(lastQueueAt),
      syncStatusLabel: count > 0 ? `Sinkronisasi berjalan (${count})` : 'Idle'
    };
  } catch (e) {
    logger.debug(`[CustomerDevice] Failed reading ACS sync state for ${deviceId}: ${e.message}`);
    return empty;
  }
}

const PPPOE_UPTIME_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Uptime',
  'Device.PPP.Interface.1.UpTime'
];

function extractPppoeUptime(d) {
  let uptimeVal = getDeviceParameterValue(d, PPPOE_UPTIME_KEYS, (matchedPath, value, device) => {
    if (value === undefined || value === null || value === '' || value === '-') return false;
    
    if (matchedPath.toLowerCase().includes('wanpppconnection')) {
      const connTypePath = matchedPath.substring(0, matchedPath.toLowerCase().lastIndexOf('.uptime')) + '.ConnectionType';
      const connTypeMatches = getWildcardMatches(device, connTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });

  if (!uptimeVal || uptimeVal === '-') {
    const UPTIME_PATHS = [
      'VirtualParameters.getdeviceuptime',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
      const val = getNestedValue(d, path);
      if (val && val !== '-' && val !== '') {
        uptimeVal = val;
        break;
      }
    }
  }

  if (uptimeVal) {
    return formatUptime(uptimeVal);
  }
  return 'N/A';
}

function getParameterWithPaths(device, paths) {
  let values = [];
  for (const p of paths) {
    const parts = p.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        if (value && value._value !== undefined) value = value._value;
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null && value !== '' && value !== 'N/A') {
      const isIpPath = p.toLowerCase().includes('ipaddress') || p.toLowerCase().includes('pppoeip') || p.toLowerCase().includes('pppip') || p.toLowerCase().includes('pppusername') || p.toLowerCase().includes('pppoeusername');
      if (isIpPath && String(value) === '0.0.0.0') {
        continue;
      }
      const isCountParam = p.includes('TotalAssociations') || 
                           p.includes('AssociatedDeviceNumberOfEntries') || 
                           p.includes('HostNumberOfEntries');
                           
      if (isCountParam) {
        // Ensure we push a number
        const val = (typeof value === 'object' && value._value !== undefined) ? value._value : value;
        values.push(parseInt(val) || 0);
      } else {
        // If it's still an object, try to get _value or stringify it
        if (typeof value === 'object') {
          if (value._value !== undefined) return String(value._value);
          return 'N/A'; // Don't return raw object
        }
        return String(value);
      }
    }
  }
  
  if (values.length > 0) {
    // If it's a count parameter, sum them up (for dual band)
    return values.reduce((a, b) => a + b, 0);
  }
  
  return 'N/A';
}

function getParameterEntryWithPaths(device, paths) {
  for (const path of paths) {
    const value = getNestedValue(device, path);
    if (value !== undefined && value !== null && value !== '' && value !== 'N/A' && value !== '-') {
      if (typeof value !== 'object') return { path, value: String(value) };
      if (value._value !== undefined) return { path, value: String(value._value) };
    }
  }
  return { path: '', value: 'N/A' };
}

function formatOpticalPowerValue(raw, path = '') {
  if (raw === undefined || raw === null || raw === '' || raw === 'N/A' || raw === '-') return '-';
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num)) return String(raw);
  // FiberHome X_FH firmware and TR-181 Optical.Interface already report dBm.
  // Other known ZTE/CMCC/CT-COM roots in this fleet report scaled raw readings.
  const alreadyDbm = /X_FH_GponInterfaceConfig/i.test(path)
    || /Device\.Optical\.Interface\.\d+\.(?:OpticalSignalLevel|TransmitPower)$/i.test(path);
  if (alreadyDbm || num <= 0) return String(num);
  const dbVal = 30 + (Math.log10(num * Math.pow(10, -7)) * 10);
  return (Math.ceil(dbVal * 100) / 100).toFixed(2);
}

function expandTagCandidates(input) {
  const t = String(input || '').trim();
  if (!t) return [];
  if (/^\d+$/.test(t)) {
    const d = t.replace(/\D/g, '');
    const set = new Set([d]);
    if (d.startsWith('62') && d.length > 2) set.add('0' + d.slice(2));
    if (d.startsWith('0')) set.add('62' + d.slice(1));
    return [...set];
  }
  return [t];
}

/** Coba beberapa varian tag (62/0 untuk nomor) sampai device ketemu */
async function findDeviceWithTagVariants(input) {
  for (const c of expandTagCandidates(input)) {
    const dev = await findDeviceByTag(c);
    if (dev) return { device: dev, canonicalTag: c };
  }
  return null;
}

/** Nomor dari JID WhatsApp @s.whatsapp.net */
function phoneFromPnJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const [user, host] = jid.split('@');
  if (!user || host !== 's.whatsapp.net') return null;
  return user.replace(/\D/g, '') || null;
}

function readWifiParameter(device, paths) {
  const maskedValues = new Set(['n/a', '-', '********', '**********', '*****', '[hidden]', '(hidden)', 'hidden']);
  for (const path of paths) {
    const value = getParameterWithPaths(device, [path]);
    const candidate = String(value ?? '').trim();
    const allStars = candidate.length > 0 && Array.from(candidate).every(ch => ch === '*');
    if (!candidate || maskedValues.has(candidate.toLowerCase()) || allStars) continue;
    return candidate;
  }
  return '';
}

function readWifiEnabled(device, enablePaths = [], statusPaths = []) {
  const parseEnable = (raw) => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value || value === 'n/a' || value === '-') return null;
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
    return null;
  };
  const enableFlags = enablePaths
    .map(path => parseEnable(getParameterWithPaths(device, [path])))
    .filter(value => value !== null);
  // If any related SSID/AP interface is explicitly disabled, do not label it active.
  if (enableFlags.length) return enableFlags.includes(false) ? false : true;

  for (const path of statusPaths) {
    const status = String(getParameterWithPaths(device, [path]) ?? '').trim().toLowerCase();
    if (['up', 'enabled', 'operational', 'online', 'associated'].includes(status)) return true;
    if (['disabled', 'down', 'notpresent', 'lowerlayerdown', 'error'].includes(status)) return false;
  }
  return null;
}

function mergeWifiEnabled(a, b) {
  // Positive client association is stronger evidence than a contradictory Enable
  // flag from firmware. A confirmed active table should not be hidden as disabled.
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

function hasAssociatedWifiClients(device, technology, index) {
  const path = technology === 'tr181'
    ? `Device.WiFi.AccessPoint.${index}.AssociatedDevice`
    : `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.AssociatedDevice`;
  const table = getNestedValue(device, path);
  if (!table || typeof table !== 'object') return false;
  const read = (entry, key) => {
    const raw = getNestedValue(entry, key);
    return raw === null || raw === undefined ? '' : String(raw).trim();
  };
  return Object.entries(table).some(([key, entry]) => {
    if (!/^\d+$/.test(key) || !entry || typeof entry !== 'object') return false;
    const mac = read(entry, 'AssociatedDeviceMACAddress') || read(entry, 'MACAddress');
    return !!mac && mac !== '-' && !/^0{2}([:-]0{2}){5}$/i.test(mac);
  });
}

function extractWifiBands(device) {
  if (!device || typeof device !== 'object') return [];
  const bands = [];
  const readLegacyBand = (index) => {
    const prefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.`;
    const ssid = readWifiParameter(device, [prefix + 'SSID']);
    const passwordPaths = [prefix + 'KeyPassphrase'];
    // Firmware revisions may expose a different PreSharedKey instance index.
    for (let keyIndex = 1; keyIndex <= 4; keyIndex++) {
      passwordPaths.push(
        prefix + `PreSharedKey.${keyIndex}.KeyPassphrase`,
        prefix + `PreSharedKey.${keyIndex}.PreSharedKey`
      );
    }
    const password = readWifiParameter(device, passwordPaths);
    const enabled = hasAssociatedWifiClients(device, 'legacy', index) ? true : readWifiEnabled(device, [prefix + 'Enable'], [prefix + 'Status']);
    // Some CPEs expose the secret but omit SSID in their current ACS snapshot.
    // Keep the genuine secret, while coalescing repeated write-only aliases across WLAN indexes.
    const label = index === 1 ? '2.4 GHz' : (index === 5 ? '5 GHz' : `WLAN ${index}`);
    if (!ssid && !password) return;

    const sameSecretBand = password
      ? bands.find(b => b.passwordAvailable && b.password === password && (!ssid || !b.ssid))
      : null;
    if (sameSecretBand) {
      // If a password-only alias is followed by its SSID-bearing path, enrich that row.
      if (ssid && !sameSecretBand.ssid) {
        sameSecretBand.index = index;
        sameSecretBand.label = label;
        sameSecretBand.ssid = ssid;
      }
      sameSecretBand.enabled = mergeWifiEnabled(sameSecretBand.enabled, enabled);
      return;
    }

    bands.push({
      index,
      label,
      ssid: ssid || '',
      password,
      passwordAvailable: Boolean(password),
      enabled
    });
  };

  for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) readLegacyBand(index);

  // TR-181 devices may expose more than two SSID/AP indexes. Read all common indexes,
  // and merge secret data into an existing band instead of discarding it on duplicate SSID.
  for (const index of Array.from({ length: 16 }, (_, i) => i + 1)) {
    const ssid = readWifiParameter(device, [`Device.WiFi.SSID.${index}.SSID`]);
    const password = readWifiParameter(device, [
      `Device.WiFi.AccessPoint.${index}.Security.KeyPassphrase`,
      `Device.WiFi.AccessPoint.${index}.Security.PreSharedKey`
    ]);
    if (!ssid && !password) continue;

    const ssidReference = readWifiParameter(device, [`Device.WiFi.AccessPoint.${index}.SSIDReference`]);
    const referenceIndex = (ssidReference.match(/Device\.WiFi\.SSID\.(\d+)/i) || [])[1];
    const referencedSsidIndex = referenceIndex || String(index);
    const enabled = hasAssociatedWifiClients(device, 'tr181', index) ? true : readWifiEnabled(device, [
      `Device.WiFi.AccessPoint.${index}.Enable`,
      `Device.WiFi.SSID.${referencedSsidIndex}.Enable`
    ], [
      `Device.WiFi.AccessPoint.${index}.Status`,
      `Device.WiFi.SSID.${referencedSsidIndex}.Status`
    ]);
    const matchingSsidBands = ssid ? bands.filter(b => b.ssid === ssid) : [];
    const existingBand = referenceIndex
      ? bands.find(b => String(b.index) === String(referenceIndex) || b.index === `tr181-${referenceIndex}`)
      : (matchingSsidBands.length === 1 ? matchingSsidBands[0] : null);
    if (existingBand) {
      if (!existingBand.passwordAvailable && password) {
        existingBand.password = password;
        existingBand.passwordAvailable = true;
      }
      existingBand.enabled = mergeWifiEnabled(existingBand.enabled, enabled);
      continue;
    }

    const sameSecretBand = password
      ? bands.find(b => b.passwordAvailable && b.password === password && (!ssid || !b.ssid))
      : null;
    if (sameSecretBand) {
      if (ssid && !sameSecretBand.ssid) {
        sameSecretBand.index = `tr181-${index}`;
        sameSecretBand.label = `WiFi ${index}`;
        sameSecretBand.ssid = ssid;
      }
      sameSecretBand.enabled = mergeWifiEnabled(sameSecretBand.enabled, enabled);
      continue;
    }

    bands.push({
      index: `tr181-${index}`,
      label: `WiFi ${index}`,
      ssid: ssid || '',
      password,
      passwordAvailable: Boolean(password),
      enabled
    });
  }

  // Filter at the API/service layer too, so disabled factory SSIDs never reach the UI.
  return bands.filter(band => {
    const ssid = String(band?.ssid || '').trim();
    if (!ssid || ssid === '-' || band.enabled === false) return false;
    if (band.enabled === true) return true;
    return !/^(?:fh[_-]?)?(?:5g[_-]?)?ssid\d*$/i.test(ssid);
  });
}

function mapDeviceData(device, tag, isPppoeActive = false, activePppoeIp = '') {
  if (!device) return null;

  const wifiBands = extractWifiBands(device);
  const wifiPassword = wifiBands.find(b => b.passwordAvailable)?.password || '';
  const ssid = getParameterWithPaths(device, parameterPaths.ssid);
  const ssidDisplay = ssid === 'N/A' ? '-' : ssid;

  const lastInformRaw =
    device?._lastInform ||
    device?.Events?.Inform ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value ||
    '';
  const lastInform = formatDeviceTimestamp(lastInformRaw);
  const clientDataUpdatedAtRaw = device?._clientDataUpdatedAt || '';
  const clientDataUpdatedAt = clientDataUpdatedAtRaw ? formatDeviceTimestamp(clientDataUpdatedAtRaw) : '';
  const clientDataAgeMs = clientDataUpdatedAtRaw ? (Date.now() - new Date(clientDataUpdatedAtRaw).getTime()) : Infinity;
  const clientDataFresh = Number.isFinite(clientDataAgeMs) && clientDataAgeMs >= -60_000 && clientDataAgeMs <= 60 * 60 * 1000;
  const lastSyncRaw = device?._updatedAt || lastInformRaw || '';
  const lastSync = formatDeviceTimestamp(lastSyncRaw);
  const syncState = getBuiltinSyncState(device?._id);

  let status = 'Unknown';
  if (device?._lastInform) {
    const diffMs = Date.now() - new Date(device._lastInform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  } else if (device?.Events?.Inform) {
    const diffMs = Date.now() - new Date(device.Events.Inform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  }

  if (status !== 'Online' && isPppoeActive) {
    status = 'Online';
  }

  let connectedUsers = [];
  try {
    const hosts = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || device?.Device?.Hosts?.Host;
    if (hosts && typeof hosts === 'object') {
      for (const key in hosts) {
        if (!isNaN(key)) {
          const entry = hosts[key];
          const activeRaw = typeof entry?.Active === 'object'
            ? (entry.Active?._value ?? entry.Active?.value)
            : entry?.Active;
          const activeText = String(activeRaw ?? '').trim().toLowerCase();
          const hostStatus = !clientDataFresh
            ? 'Unknown'
            : (['true', '1', 'online', 'active'].includes(activeText)
              ? 'Online'
              : (['false', '0', 'offline', 'inactive'].includes(activeText) ? 'Offline' : 'Unknown'));
          connectedUsers.push({
            hostname: typeof entry?.HostName === 'object' ? entry?.HostName?._value || entry?.HostName?.value || '-' : entry?.HostName || '-',
            ip: typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value || entry?.IPAddress?.value || '-' : entry?.IPAddress || '-',
            mac: typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value || entry?.MACAddress?.value || '-' : entry?.MACAddress || '-',
            iface: typeof entry?.InterfaceType === 'object' ? entry?.InterfaceType?._value || entry?.InterfaceType?.value || '-' : entry?.InterfaceType || entry?.Interface || '-',
            status: hostStatus
          });
        }
      }
    }

    const assocCandidates = [];
    // Search every common legacy WLAN index rather than assuming only WLAN 1 and 5.
    for (let index = 1; index <= 8; index++) {
      const assoc = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.[String(index)]?.AssociatedDevice;
      if (assoc) assocCandidates.push(assoc);
    }
    // TR-181 AP indexes are vendor-dependent; include the first 16 without changing device config.
    for (let index = 1; index <= 16; index++) {
      const assoc = device?.Device?.WiFi?.AccessPoint?.[String(index)]?.AssociatedDevice;
      if (assoc) assocCandidates.push(assoc);
    }
    for (const assoc of assocCandidates) {
      if (!assoc || typeof assoc !== 'object') continue;
      for (const key in assoc) {
        if (key === '_value' || key === '_type' || key === '_timestamp') continue;
        if (isNaN(key)) continue;
        const entry = assoc[key];
        const mac =
          (typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value : entry?.MACAddress) ||
          (typeof entry?.AssociatedDeviceMACAddress === 'object' ? entry?.AssociatedDeviceMACAddress?._value : entry?.AssociatedDeviceMACAddress) ||
          '-';
        const ip =
          (typeof entry?.AssociatedDeviceIPAddress === 'object' ? entry?.AssociatedDeviceIPAddress?._value : entry?.AssociatedDeviceIPAddress) ||
          (typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value : entry?.IPAddress) ||
          (typeof entry?.IP === 'object' ? entry?.IP?._value : entry?.IP) ||
          '-';
        const hostname =
          (typeof entry?.AssociatedDeviceHostName === 'object' ? entry?.AssociatedDeviceHostName?._value : entry?.AssociatedDeviceHostName) ||
          (typeof entry?.AssociatedDeviceDeviceName === 'object' ? entry?.AssociatedDeviceDeviceName?._value : entry?.AssociatedDeviceDeviceName) ||
          (typeof entry?.HostName === 'object' ? entry?.HostName?._value : entry?.HostName) ||
          (typeof entry?.DeviceName === 'object' ? entry?.DeviceName?._value : entry?.DeviceName) ||
          '-';
        const ssidName =
          (typeof entry?.SSID === 'object' ? entry?.SSID?._value : entry?.SSID) ||
          (typeof entry?.WLANConfiguration === 'object' ? entry?.WLANConfiguration?._value : entry?.WLANConfiguration) ||
          '';
        if (!mac || mac === '-') continue;
        connectedUsers.push({
          hostname: hostname || '-',
          ip: ip || '-',
          mac: mac || '-',
          iface: ssidName ? `WiFi ${ssidName}` : 'WiFi',
          status: clientDataFresh ? 'Online' : 'Unknown'
        });
      }
    }
  } catch (e) {}

  try {
    const byIdentity = new Map();
    const statusRank = status => status === 'Online' ? 2 : (status === 'Unknown' ? 1 : 0);
    const hasUsefulValue = value => {
      const text = String(value ?? '').trim();
      return !!text && text !== '-' && text !== 'Unknown';
    };
    for (const user of connectedUsers) {
      const mac = String(user?.mac || '').trim().toUpperCase();
      const ip = String(user?.ip || '').trim();
      // MAC is the primary identity across Wi-Fi bands and the LAN host table.
      const key = (mac && mac !== '-') ? mac : ip;
      if (!key || key === '-') continue;
      const previous = byIdentity.get(key);
      if (!previous) {
        byIdentity.set(key, { ...user, mac: mac || user.mac || '-' });
        continue;
      }
      const merged = { ...previous };
      for (const field of ['hostname', 'ip', 'mac', 'iface']) {
        if (!hasUsefulValue(merged[field]) && hasUsefulValue(user[field])) merged[field] = user[field];
      }
      // AssociatedDevice proves an active Wi-Fi connection, so it upgrades a
      // duplicate Hosts.Host row that has no Active flag or stale Offline status.
      if (statusRank(user.status) > statusRank(merged.status)) merged.status = user.status;
      if (user.status === 'Online' && /^wifi/i.test(String(user.iface || ''))) merged.iface = user.iface;
      byIdentity.set(key, merged);
    }
    connectedUsers = Array.from(byIdentity.values());
    if (!clientDataFresh) {
      // Do not infer Offline from an old ACS snapshot. Keep the entries marked
      // Unknown until a fresh read-only table scan confirms their current state.
      connectedUsers = connectedUsers.map(user => ({ ...user, status: 'Unknown' }));
    }
  } catch {}

  const rxPowerEntry = getParameterEntryWithPaths(device, parameterPaths.rxPower);
  const rxPower = formatOpticalPowerValue(rxPowerEntry.value, rxPowerEntry.path);
  const txPowerEntry = getParameterEntryWithPaths(device, parameterPaths.txPower);
  const txPower = formatOpticalPowerValue(txPowerEntry.value, txPowerEntry.path);

  const formatMemory = (raw) => {
    if (raw === 'N/A' || raw === '-' || raw === '' || raw == null) return '-';
    const n = Number(raw);
    return Number.isFinite(n) ? String(n.toLocaleString('id-ID')) + ' KB' : String(raw);
  };
  const formatByteCounter = (raw) => {
    if (raw === 'N/A' || raw === '-' || raw === '' || raw == null) return '-';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return String(raw);
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = n, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(unit === 0 ? 0 : 2) + ' ' + units[unit];
  };
  const memoryTotal = formatMemory(getParameterWithPaths(device, parameterPaths.memoryTotal));
  const memoryFree = formatMemory(getParameterWithPaths(device, parameterPaths.memoryFree));
  const cpuRaw = getParameterWithPaths(device, parameterPaths.cpuUsage);
  const cpuUsage = cpuRaw === 'N/A' || cpuRaw === '-' || cpuRaw === '' ? '-' : (/%$/.test(String(cpuRaw)) ? String(cpuRaw) : String(cpuRaw) + '%');
  const trafficSent = formatByteCounter(getParameterWithPaths(device, parameterPaths.trafficTx));
  const trafficReceived = formatByteCounter(getParameterWithPaths(device, parameterPaths.trafficRx));

  const pppoeIP = activePppoeIp || extractPppoeIp(device);
  const pppoeUsername = extractPppoeUser(device);
  const uptimeRaw = getParameterWithPaths(device, parameterPaths.uptime);
  let totalAssociations = 0;
  let associationCounterFound = false;
  for (let index = 1; index <= 8; index++) {
    const count = getParameterWithPaths(device, [
      `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.TotalAssociations`,
      `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.AssociatedDeviceNumberOfEntries`
    ]);
    if (count !== null && count !== undefined && !['N/A', '-', ''].includes(String(count)) && Number.isFinite(Number(count)) && Number(count) >= 0) {
      totalAssociations += Math.floor(Number(count));
      associationCounterFound = true;
    }
  }
  if (!associationCounterFound) {
    for (let index = 1; index <= 16; index++) {
      const count = getParameterWithPaths(device, [`Device.WiFi.AccessPoint.${index}.AssociatedDeviceNumberOfEntries`]);
      if (count !== null && count !== undefined && !['N/A', '-', ''].includes(String(count)) && Number.isFinite(Number(count)) && Number(count) >= 0) {
        totalAssociations += Math.floor(Number(count));
        associationCounterFound = true;
      }
    }
  }
  if (!associationCounterFound) totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);

  // Fallback: if the ONU did not report a count, use the known connected-host list.
  if (['N/A', '-', '', null, undefined, 0, '0'].includes(totalAssociations) && connectedUsers.length > 0) {
    totalAssociations = connectedUsers.filter(u => u.status === 'Online').length;
  }
  // Do not display a fabricated zero when telemetry is absent. '-' means unknown.
  if (['N/A', '-', '', null, undefined].includes(totalAssociations)) {
    totalAssociations = '-';
  }
  if (typeof totalAssociations === 'string' && /^\d+$/.test(totalAssociations)) {
    totalAssociations = parseInt(totalAssociations, 10);
  }

  function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
    if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
      return seconds;
    }
    const totalSecs = parseInt(seconds, 10);
    if (isNaN(totalSecs)) return seconds || 'N/A';
    const days = Math.floor(totalSecs / 86400);
    const rem = totalSecs % 86400;
    
    let hrs = Math.floor(rem / 3600);
    if (hrs < 10) hrs = "0" + hrs;
    
    const rem2 = rem % 3600;
    let mins = Math.floor(rem2 / 60);
    if (mins < 10) mins = "0" + mins;
    
    let secs = rem2 % 60;
    if (secs < 10) secs = "0" + secs;
    
    return days + "d " + hrs + ":" + mins + ":" + secs;
  }
  const uptime = formatUptime(uptimeRaw);
  const pppoeUptime = extractPppoeUptime(device);

  const serialNumber = getParameterWithPaths(device, parameterPaths.serialNumber);
  const productClass = getParameterWithPaths(device, parameterPaths.model);
  const softwareVersion = getParameterWithPaths(device, parameterPaths.softwareVersion);
  const model = productClass;

  let lokasi = device?._tags || '-';
  if (Array.isArray(lokasi)) lokasi = lokasi.join(', ');

  return {
    phone: tag,
    ssid: ssidDisplay,
    status,
    lastInform,
    lastInformRaw: lastInformRaw || '',
    lastInformAgo: formatRelativeTime(lastInformRaw),
    clientDataUpdatedAt: clientDataUpdatedAt || null,
    clientDataFresh,
    clientDataAgeSeconds: Number.isFinite(clientDataAgeMs) ? Math.max(0, Math.floor(clientDataAgeMs / 1000)) : null,
    lastSync,
    lastSyncRaw: lastSyncRaw || '',
    lastSyncAgo: formatRelativeTime(lastSyncRaw),
    syncInProgress: !!syncState.syncInProgress,
    syncPendingCount: Number(syncState.syncPendingCount || 0),
    syncLastQueueAt: syncState.syncLastQueueAt || '',
    syncLastQueueLabel: syncState.syncLastQueueLabel || '-',
    syncStatusLabel: syncState.syncStatusLabel || 'Idle',
    connectedUsers,
    wifiBands,
    // Expose only a genuine non-empty secret returned by ACS; many ONU models keep this value write-only.
    wifiPassword,
    rxPower: rxPower === 'N/A' ? '-' : rxPower,
    txPower: txPower === 'N/A' ? '-' : txPower,
    memoryTotal,
    memoryFree,
    cpuUsage,
    trafficSent,
    trafficReceived,
    pppoeIP: pppoeIP === 'N/A' ? '-' : pppoeIP,
    tr069IP: device?._ip && device._ip !== '0.0.0.0' ? device._ip : '-',
    pppoeUsername: pppoeUsername === 'N/A' ? '-' : pppoeUsername,
    pppoeUptime: pppoeUptime === 'N/A' ? '-' : pppoeUptime,
    serialNumber: serialNumber === 'N/A' ? '-' : serialNumber,
    productClass: productClass === 'N/A' ? '-' : productClass,
    lokasi,
    softwareVersion: softwareVersion === 'N/A' ? '-' : softwareVersion,
    model: model === 'N/A' ? '-' : model,
    uptime: uptime === 'N/A' ? '-' : uptime,
    totalAssociations
  };
}

async function getCustomerDeviceData(tag) {
  const base = await resolveDeviceToken(tag);
  if (!base || !base._id) return null;
  const device = await fetchFullDevice(base._id);
  
  let isPppoeActive = false;
  let activePppoeIp = '';
  try {
    const pppoeUser = extractPppoeUser(device);
    if (pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-') {
      const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
      const activeSession = activeSessionsMap.get(pppoeUser.toLowerCase());
      if (activeSession) {
        isPppoeActive = true;
        activePppoeIp = String(activeSession.ip || '').trim();
      }
    }
  } catch (e) {}

  return mapDeviceData(device, tag, isPppoeActive, activePppoeIp);
}

function fallbackCustomer(tag) {
  return {
    phone: tag,
    ssid: '-',
    status: 'Tidak ditemukan',
    lastInform: '-',
    lastInformAgo: '-',
    lastSync: '-',
    lastSyncAgo: '-',
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle',
    connectedUsers: [],
    wifiBands: [],
    wifiPassword: '',
    rxPower: '-',
    txPower: '-',
    memoryTotal: '-',
    memoryFree: '-',
    cpuUsage: '-',
    trafficSent: '-',
    trafficReceived: '-',
    pppoeIP: '-',
    pppoeUsername: '-',
    pppoeUptime: '-',
    serialNumber: '-',
    productClass: '-',
    lokasi: '-',
    softwareVersion: '-',
    model: '-',
    uptime: '-',
    totalAssociations: '-'
  };
}

async function updateSSID(tag, newSSID, actor = null) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device) return false;
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${deviceId}/tasks`;

    const parameterValues = [];
    
    // Check supported paths in DB
    const db = require('../config/database');
    const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(device._id);
    const flatParams = row && row.params ? JSON.parse(row.params) : null;
    
    if (flatParams) {
      // SSID 2.4G paths
      const paths24G = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'Device.WiFi.SSID.1.SSID'
      ];
      paths24G.forEach(p => {
        if (flatParams[p] !== undefined) {
          parameterValues.push([p, newSSID, 'xsd:string']);
        }
      });
      
      // SSID 5G paths
      const paths5G = [
        'Device.WiFi.SSID.2.SSID'
      ];
      for (const idx of [5, 6, 7, 8]) {
        paths5G.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`);
      }
      paths5G.forEach(p => {
        if (flatParams[p] !== undefined) {
          parameterValues.push([p, `${newSSID}-5G`, 'xsd:string']);
        }
      });
    }
    
    // Fallback if no parameters match or device not bootstrapped yet
    if (parameterValues.length === 0) {
      parameterValues.push(
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', newSSID, 'xsd:string'],
        ['Device.WiFi.SSID.1.SSID', newSSID, 'xsd:string']
      );
    }

    let ok = false;
    try {
      await instance.post(tasksUrl, {
        name: 'setParameterValues',
        parameterValues: parameterValues
      }, { timeout: 20000 });
      ok = true;
    } catch (e) {
      logger.error(`[updateSSID] Failed to set SSID: ${e.message}`);
    }

    // Refresh objects untuk trigger inform dari ONU
    try {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { timeout: 15000 });
    } catch (e) {}
    // Skip Device.WiFi.SSID refresh karena tidak semua ONU support (CIOT tidak support)

    // Trigger inform untuk force ONU komunikasi dengan ACS
    if (ok) {
      try {
        await instance.post(tasksUrl, { name: 'inform' }, { timeout: 15000 });
        logger.info(`[updateSSID] Inform task triggered untuk ${tag}`);
      } catch (e) {
        logger.warn(`[updateSSID] Failed to trigger inform: ${e.message}`);
      }
      
      // Wait untuk ACS mendapat data terbaru dari ONU (jangan terlalu lama, cukup 3 detik)
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_SSID',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          oldSSID: device._id || 'unknown',
          newSSID: newSSID
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    return false;
  }
}


// Queue a separate SSID rename for 2.4 GHz and/or 5 GHz.
// Only the primary WLAN for each band is touched; guest/secondary WLANs are never bulk-renamed.
async function requestWifiSsidUpdate(tag, ssid24, ssid5, actor = null) {
  const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, '').trim();
  const name24 = clean(ssid24);
  const name5 = clean(ssid5);
  if (!name24 && !name5) {
    return { handled: true, success: false, code: 'SSID_REQUIRED', message: 'Pilih minimal satu band dan isi nama Wi-Fi baru.' };
  }
  for (const [label, value] of [['2,4 GHz', name24], ['5 GHz', name5]]) {
    if (value && (Buffer.byteLength(value, 'utf8') > 32 || /[\x00-\x1f\x7f]/.test(value))) {
      return { handled: true, success: false, code: 'INVALID_SSID', message: 'Nama Wi-Fi ' + label + ' maksimal 32 byte dan tidak boleh berisi karakter kontrol.' };
    }
  }

  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) {
    return { handled: true, success: false, code: 'DEVICE_NOT_FOUND', message: 'ONT tidak ditemukan pada ACS.' };
  }
  const server = device._acs_server_id
    ? genieacsApi.getACSServer(device._acs_server_id)
    : genieacsApi.getACSServer('legacy');
  if (!server) {
    return { handled: true, success: false, code: 'ACS_NOT_FOUND', message: 'Server ACS untuk ONT tidak ditemukan.' };
  }

  const row = db.prepare('SELECT manufacturer,product_class,last_inform,params FROM acs_devices WHERE id=?').get(String(device._id));
  // The Built-in ACS keeps task IDs and CWMP read-back locally. External ACS devices
  // remain on the legacy path until their task-result adapter is available.
  if (!row || String(server.id) !== 'builtin') return { handled: false };

  const informMs = Date.parse(row.last_inform || '');
  const ageMs = Date.now() - informMs;
  const ageMinutes = Number.isFinite(ageMs) && ageMs >= 0 ? Math.round(ageMs / 60000) : null;
  if (!Number.isFinite(informMs) || ageMs < 0 || ageMs > 10 * 60 * 1000) {
    return {
      handled: true, success: false, code: 'ONT_INFORM_STALE',
      message: ageMinutes === null
        ? 'Waktu Inform ONT tidak valid. Nama Wi-Fi tidak dikirim.'
        : 'ONT belum Inform ke ACS selama ' + ageMinutes + ' menit. Nama Wi-Fi tidak dikirim demi keamanan.'
    };
  }

  const getValue = path => {
    let value = getNestedValue(device, path);
    if (value === null || value === undefined || value === '') {
      let flat = {};
      try { flat = JSON.parse(row.params || '{}'); } catch (_) {}
      value = flat[path];
    }
    if (value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
      else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
    }
    return value == null ? '' : String(value).trim();
  };
  const make = String(row.manufacturer || device._deviceId?._Manufacturer || device._deviceId?.Manufacturer || '').toLowerCase();
  const model = String(row.product_class || device._deviceId?._ProductClass || device._deviceId?.ProductClass || '').toUpperCase();
  const isFiberHome = make.includes('fiberhome');
  const supportedFiberHome = ['HG6045F3', 'HG6145F3', 'HG6145D2'].includes(model);
  if (isFiberHome && !supportedFiberHome) {
    return { handled: true, success: false, code: 'FIBERHOME_MODEL_UNVERIFIED', message: 'Pemetaan dual-band model FiberHome ini belum tervalidasi. Tidak ada perubahan yang dikirim.' };
  }

  const targets = [];
  const addTarget = (band, requested, candidates) => {
    if (!requested) return;
    let selected = null;
    for (const candidate of candidates) {
      const current = getValue(candidate.path);
      if (current) { selected = { ...candidate, current }; break; }
    }
    if (!selected) {
      targets.push({ band, error: true });
      return;
    }
    const prefix = selected.path.slice(0, selected.path.lastIndexOf('.') + 1);
    const enable = getValue(prefix + 'Enable').toLowerCase();
    const status = getValue(prefix + 'Status').toLowerCase();
    const radioEnabled = getValue(prefix + 'RadioEnabled').toLowerCase();
    const disabled = /^(0|false|no|off|disabled)$/.test(enable) ||
      /^(disabled|down|notpresent|lowerlayerdown|error)$/.test(status) ||
      /^(0|false|no|off|disabled)$/.test(radioEnabled);
    if (disabled) {
      targets.push({ band, error: true, disabled: true });
      return;
    }
    targets.push({ band, path: selected.path, value: requested, current: selected.current });
  };

  const path24 = [
    { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', index: 1 },
    { path: 'Device.WiFi.SSID.1.SSID', index: 'tr181-1' }
  ];
  let path5 = [];
  if (isFiberHome) {
    // Verified on the user's HG6045F3, HG6145F3 and HG6145D2 inventories:
    // primary 2.4 GHz = WLAN 1; primary 5 GHz = WLAN 5.
    path5 = [{ path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', index: 5 }];
  } else {
    path5 = [
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', index: 5 },
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID', index: 2 },
      { path: 'Device.WiFi.SSID.2.SSID', index: 'tr181-2' }
    ];
  }
  addTarget('2,4 GHz', name24, path24);
  addTarget('5 GHz', name5, path5);
  const failedTarget = targets.find(target => target.error);
  if (failedTarget) {
    return {
      handled: true, success: false, code: failedTarget.disabled ? 'WIFI_BAND_DISABLED' : 'WIFI_BAND_NOT_FOUND',
      message: 'SSID ' + failedTarget.band + (failedTarget.disabled ? ' terdeteksi nonaktif. Tidak ada perubahan yang dikirim.' : ' tidak ditemukan pada parameter ACS. Tidak ada perubahan yang dikirim.')
    };
  }
  if (!targets.length) return { handled: true, success: false, code: 'NO_SSID_TARGET', message: 'Tidak ada band Wi-Fi yang dipilih.' };

  const busy = db.prepare(
    `SELECT id FROM acs_tasks WHERE device_id=? AND name='setParameterValues'
     AND status IN ('pending','in_progress') AND payload LIKE '%WLANConfiguration%'
     AND payload LIKE '%.SSID%' LIMIT 1`
  ).get(String(device._id));
  if (busy) {
    return { handled: true, success: false, code: 'SSID_TASK_PENDING', taskId: Number(busy.id), message: 'Masih ada perubahan nama Wi-Fi yang menunggu ONT. Selesaikan dulu sebelum mengirim perubahan baru.' };
  }

  const parameterValues = targets.map(target => [target.path, target.value, 'xsd:string']);
  const parameterNames = targets.map(target => target.path);
  const instance = genieacsApi.createAxiosInstance(server);
  const endpoint = '/devices/' + encodeURIComponent(device._id) + '/tasks';
  try {
    const writeResponse = await instance.post(endpoint, { name: 'setParameterValues', parameterValues }, { timeout: 20000 });
    const taskId = Number(writeResponse?.data?._id || 0);
    if (!taskId) return { handled: true, success: false, code: 'TASK_ID_MISSING', message: 'ACS tidak mengembalikan ID task perubahan nama Wi-Fi.' };

    let verifyTaskId = 0;
    try {
      const verifyResponse = await instance.post(endpoint, { name: 'getParameterValues', parameterNames }, { timeout: 20000 });
      verifyTaskId = Number(verifyResponse?.data?._id || 0);
    } catch (verifyError) {
      logger.warn('[TechWiFi] Unable to queue SSID read-back for ' + device._id + ': ' + String(verifyError.message || verifyError).slice(0, 160));
    }
    if (!verifyTaskId) {
      return { handled: true, success: false, code: 'VERIFY_QUEUE_FAILED', taskId, message: 'Perintah perubahan sudah masuk antrean, tetapi pemeriksaan ulang ACS gagal dibuat. Jangan kirim ulang sampai status task diperiksa.' };
    }

    if (actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_SSID_QUEUED', entity_type: 'device', entity_id: tag,
        actor_type: actor.type || 'technician', actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: { device_id: device._id, bands: targets.map(target => target.band), parameter_paths: parameterNames, task_id: taskId, verify_task_id: verifyTaskId },
        ip_address: actor.ip || null, user_agent: actor.userAgent || null
      });
    }
    logger.info('[TechWiFi] SSID change queued for ' + device._id + ' on ' + targets.map(t => t.band).join(', ') + '; task=' + taskId + ', verify=' + verifyTaskId);
    return {
      handled: true, success: true, pending: true, taskId, verifyTaskId,
      message: 'Perintah perubahan nama Wi-Fi masuk antrean ACS. Menunggu ONT menerapkan dan membaca ulang SSID.'
    };
  } catch (error) {
    logger.error('[TechWiFi] Failed to queue SSID task for ' + device._id + ': ' + String(error.message || error).slice(0, 180));
    return { handled: true, success: false, code: 'TASK_QUEUE_FAILED', message: 'ACS gagal membuat antrean perubahan nama Wi-Fi.' };
  }
}

// Technician-only password path for FiberHome HG6145D2.
// Select only the requested radio band for the verified FiberHome HG6145D2 map.
function selectFiberHomeWifiIndexes(activeIndexes, band = 'both') {
  const normalizedBand = String(band || 'both').trim().toLowerCase();
  if (!['2g', '5g', 'both'].includes(normalizedBand)) {
    return { ok: false, code: 'INVALID_WIFI_BAND', indexes: [] };
  }
  const indexes = (Array.isArray(activeIndexes) ? activeIndexes : [])
    .filter(index => Number.isInteger(Number(index)) && Number(index) >= 1 && Number(index) <= 8)
    .map(Number);
  const selected = normalizedBand === '2g'
    ? indexes.filter(index => index <= 4)
    : normalizedBand === '5g'
      ? indexes.filter(index => index >= 5)
      : indexes;
  if (!selected.length) {
    return {
      ok: false,
      code: normalizedBand === '2g' ? 'WIFI_24G_NOT_ACTIVE'
        : normalizedBand === '5g' ? 'WIFI_5G_NOT_ACTIVE' : 'NO_ACTIVE_WLAN',
      indexes: []
    };
  }
  return { ok: true, code: null, indexes: [...new Set(selected)].sort((a, b) => a - b) };
}

// It targets only WLAN instances confirmed active in the last ACS snapshot,
// and refuses to queue a write when the CPE has stopped Informing.
async function updateTechnicianWifiPassword(tag, newPassword, band = 'both') {
  const pw = String(newPassword ?? '').replace(/[\r\n\t]+/g, '').trim();
  if (pw.length < 8) {
    return { handled: true, success: false, code: 'INVALID_PASSWORD', message: 'Password WiFi minimal 8 karakter.' };
  }

  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) {
    return { handled: true, success: false, code: 'DEVICE_NOT_FOUND', message: 'ONT tidak ditemukan pada ACS.' };
  }

  const server = device._acs_server_id
    ? genieacsApi.getACSServer(device._acs_server_id)
    : genieacsApi.getACSServer('legacy');
  if (!server) {
    return { handled: true, success: false, code: 'ACS_NOT_FOUND', message: 'Server ACS untuk ONT tidak ditemukan.' };
  }

  const make = String(device._deviceId?._Manufacturer || device._deviceId?.Manufacturer || '').toLowerCase();
  const model = String(device._deviceId?._ProductClass || device._deviceId?.ProductClass || '').toUpperCase();
  const db = require('../config/database');
  const row = db.prepare('SELECT manufacturer,product_class,last_inform,params FROM acs_devices WHERE id=?').get(String(device._id));
  if (!row) {
    // Non-built-in GenieACS devices do not have a local acs_devices row.
    return { handled: false };
  }

  const isFiberHomeHg6145d2 =
    (String(row.manufacturer || make).toLowerCase().includes('fiberhome')) &&
    String(row.product_class || model).toUpperCase().includes('HG6145D2');
  if (!isFiberHomeHg6145d2) {
    // Keep the existing vendor-specific path for other models unchanged.
    return { handled: false };
  }

  const informMs = Date.parse(row.last_inform || '');
  const ageMs = Date.now() - informMs;
  const ageMinutes = Number.isFinite(ageMs) && ageMs >= 0 ? Math.round(ageMs / 60000) : null;
  if (!Number.isFinite(informMs) || ageMs < 0 || ageMs > 10 * 60 * 1000) {
    return {
      handled: true, success: false, code: 'ONT_INFORM_STALE',
      lastInform: row.last_inform || null, minutesSinceInform: ageMinutes,
      message: ageMinutes === null
        ? 'Waktu Inform ONT tidak valid. Password tidak dikirim.'
        : 'ONT belum mengirim Inform ke ACS selama ' + ageMinutes + ' menit. Password belum dikirim. Pulihkan Inform ONT terlebih dahulu.'
    };
  }

  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (_) {}
  const getValue = value => {
    if (value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
      else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
    }
    return value == null ? '' : String(value).trim();
  };
  const activeIndexes = [];
  for (let index = 1; index <= 8; index++) {
    const prefix = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + index + '.';
    const ssid = getValue(params[prefix + 'SSID']);
    const enabled = getValue(params[prefix + 'Enable']).toLowerCase();
    const status = getValue(params[prefix + 'Status']).toLowerCase();
    const radioEnabled = getValue(params[prefix + 'RadioEnabled']).toLowerCase();

    const explicitlyEnabled = /^(1|true|yes|on|enabled)$/i.test(enabled);
    const explicitlyDisabled = /^(0|false|no|off|disabled)$/i.test(enabled);
    const statusActive = /^(up|enabled|online|operational)$/i.test(status);
    const statusInactive = /^(disabled|down|notpresent|lowerlayerdown|error)$/i.test(status);
    const radioInactive = /^(0|false|no|off|disabled)$/i.test(radioEnabled);

    // Fail closed on contradictory/inactive WLAN state. In particular, a stale
    // Enable=1 must not override Status=Disabled and cause writes to a disabled SSID.
    if (!ssid || explicitlyDisabled || statusInactive || radioInactive) continue;
    if (statusActive || (!status && explicitlyEnabled)) activeIndexes.push(index);
  }
  const selection = selectFiberHomeWifiIndexes(activeIndexes, band);
  if (!selection.ok) {
    const bandLabel = band === '2g' ? '2,4 GHz' : band === '5g' ? '5 GHz' : 'Wi-Fi aktif';
    return {
      handled: true, success: false, code: selection.code,
      activeWlanIndexes: activeIndexes,
      message: 'Jaringan ' + bandLabel + ' tidak aktif atau belum terbaca dari ACS. Tidak ada password yang dikirim.'
    };
  }
  const selectedIndexes = selection.indexes;

  const busy = db.prepare(
    "SELECT id FROM acs_tasks WHERE device_id=? AND name='setParameterValues' AND status IN ('pending','in_progress') AND payload LIKE '%KeyPassphrase%' LIMIT 1"
  ).get(String(device._id));
  if (busy) {
    return {
      handled: true, success: false, code: 'WIFI_TASK_PENDING', taskId: Number(busy.id),
      message: 'Masih ada perubahan password WiFi yang menunggu ONT. Jangan kirim perubahan kedua.'
    };
  }

  // HG6145D2 uses the standard legacy KeyPassphrase leaf only on selected active WLANs.
  // Confirmed mapping: WLAN 1-4 = 2.4 GHz; WLAN 5-8 = 5 GHz.
  const parameterValues = selectedIndexes.map(index => [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.' + index + '.KeyPassphrase',
    pw,
    'xsd:string'
  ]);
  try {
    const instance = genieacsApi.createAxiosInstance(server);
    const response = await instance.post('/devices/' + encodeURIComponent(device._id) + '/tasks', {
      name: 'setParameterValues',
      parameterValues
    }, { timeout: 20000 });
    const taskId = Number(response?.data?._id || 0);
    if (!taskId) {
      return {
        handled: true, success: false, code: 'TASK_ID_MISSING',
        message: 'ACS tidak mengembalikan ID task. Status perubahan tidak dapat dipastikan.'
      };
    }
    logger.info('[TechWiFi] Password task queued for FiberHome HG6145D2 ' + device._id +
      ' on selected WLAN indexes ' + selectedIndexes.join(',') + '; password not logged.');
    const selectedBandLabel = [...new Set(selectedIndexes.map(i => i <= 4 ? '2,4 GHz' : '5 GHz'))].join(' dan ');
    return {
      handled: true, success: true, pending: true, taskId,
      band: band || 'both',
      activeWlanIndexes: selectedIndexes,
      message: 'Perintah perubahan password untuk ' + selectedBandLabel +
        ' masuk antrean ACS. Menunggu ONT menerima perintah; band lain tidak disentuh.'
    };
  } catch (error) {
    logger.error('[TechWiFi] Failed to queue FiberHome HG6145D2 password task: ' + String(error.message || error).slice(0, 180));
    return {
      handled: true, success: false, code: 'TASK_QUEUE_FAILED',
      message: 'ACS gagal membuat antrean perubahan password WiFi.'
    };
  }
}

// Shared dispatcher used by customer, technician, admin and Telegram entry points.
// FiberHome writes are fail-closed: only models with a verified driver are allowed
// to proceed. Other vendors continue through the existing generic implementation.
async function requestWifiPasswordUpdate(tag, newPassword, band = 'both') {
  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) return { handled: false };

  const row = db.prepare(
    'SELECT manufacturer, product_class FROM acs_devices WHERE id=?'
  ).get(String(device._id));
  const manufacturer = String(
    row?.manufacturer ||
    device._deviceId?._Manufacturer ||
    device._deviceId?.Manufacturer ||
    ''
  ).trim().toLowerCase();
  const productClass = String(
    row?.product_class ||
    device._deviceId?._ProductClass ||
    device._deviceId?.ProductClass ||
    ''
  ).trim().toUpperCase();

  if (!manufacturer.includes('fiberhome')) return { handled: false };

  if (!productClass.includes('HG6145D2')) {
    return {
      handled: true,
      success: false,
      pending: false,
      code: 'FIBERHOME_MODEL_UNVERIFIED',
      message: 'Model FiberHome ini belum memiliki pemetaan parameter password yang tervalidasi. Tidak ada perintah yang dikirim.'
    };
  }

  return updateTechnicianWifiPassword(tag, newPassword, band);
}

async function updatePassword(tag, newPassword, actor = null) {
  try {
    const pwRaw = String(newPassword ?? '');
    const pw = pwRaw.replace(/[\r\n\t]+/g, '').trim();
    if (pw.length < 8) {
      logger.warn(`[updatePassword] Password too short for tag ${tag}`);
      return false;
    }
    const device = await resolveDeviceToken(tag);
    if (!device) {
      logger.warn(`[updatePassword] Device not found for tag ${tag}`);
      return false;
    }
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${deviceId}/tasks`;

    logger.info(`[updatePassword] Setting password for device ${deviceId}, tag ${tag}`);

    const parameterValues = [];
    
    // Check supported paths in DB. FiberHome must use a validated model driver;
    // never send the generic mixture of legacy/TR-181 password aliases.
    const db = require('../config/database');
    const row = db.prepare('SELECT manufacturer, product_class, params FROM acs_devices WHERE id = ?').get(device._id);
    const deviceManufacturer = String(row?.manufacturer || device._deviceId?._Manufacturer || device._deviceId?.Manufacturer || '').toLowerCase();
    if (deviceManufacturer.includes('fiberhome')) {
      logger.warn('[updatePassword] Blocked generic FiberHome Wi-Fi write; model-specific driver required for ' + String(device._id));
      return false;
    }
    const flatParams = row && row.params ? JSON.parse(row.params) : null;
    
    if (flatParams) {
      // Build candidates from all cached WLAN/AP indexes, not fixed 1/2/5-8 slots.
      // Only write parameters already present in the ACS snapshot for this modem.
      const candidatePaths = new Set();
      for (let idx = 1; idx <= 16; idx++) {
        const legacy = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.`;
        for (const leaf of ['KeyPassphrase', 'PreSharedKey.1.KeyPassphrase', 'PreSharedKey.1.PreSharedKey']) {
          candidatePaths.add(legacy + leaf);
        }
        const ap = `Device.WiFi.AccessPoint.${idx}.Security.`;
        candidatePaths.add(ap + 'KeyPassphrase');
        candidatePaths.add(ap + 'PreSharedKey');
      }
      for (const path of candidatePaths) {
        if (Object.prototype.hasOwnProperty.call(flatParams, path)) {
          parameterValues.push([path, pw, 'xsd:string']);
        }
      }
    }
    
    // Fallback if no parameters match or device not bootstrapped yet
    if (parameterValues.length === 0) {
      parameterValues.push(
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', pw, 'xsd:string'],
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase', pw, 'xsd:string'],
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', pw, 'xsd:string'],
        ['Device.WiFi.AccessPoint.1.Security.KeyPassphrase', pw, 'xsd:string']
      );
    }

    let ok = false;
    try {
      await instance.post(tasksUrl, {
        name: 'setParameterValues',
        parameterValues: parameterValues
      }, { timeout: 20000 });
      ok = true;
    } catch (e) {
      logger.error(`[updatePassword] Failed to set password: ${e.message}`);
    }

    // Refresh object - only refresh InternetGatewayDevice path yang lebih universal
    try {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { timeout: 15000 });
    } catch (e) {}
    // Skip Device.WiFi.AccessPoint refresh karena tidak semua ONU support (CIOT tidak support)

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_PASSWORD',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: deviceId
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    logger.error(`[updatePassword] Error: ${e.message}`, e.response?.data || '');
    return false;
  }
}

function collectClientRefreshObjects(device) {
  const read = (path) => {
    let value = device;
    for (const part of String(path || '').split('.')) {
      if (!value || typeof value !== 'object' || !(part in value)) return undefined;
      value = value[part];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
    }
    return value;
  };
  const enabled = value => {
    const text = String(value ?? '').trim().toLowerCase();
    if (['0', 'false', 'disabled', 'down', 'disable'].includes(text)) return false;
    if (['1', 'true', 'enabled', 'up', 'enable'].includes(text)) return true;
    return null;
  };
  const objects = [];
  let activeWifiFound = false;
  let associatedEntriesFound = false;

  // TR-098: probe only WLANs that are not explicitly disabled. FiberHome HG6145D2
  // normally exposes 2.4 GHz on WLAN 1 and 5 GHz on WLAN 5.
  for (let index = 1; index <= 8; index++) {
    const root = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}`;
    const ssid = String(read(root + '.SSID') ?? '').trim();
    if (!ssid || ssid === '-') continue;
    const isEnabled = enabled(read(root + '.Enable'));
    const status = enabled(read(root + '.Status'));
    if (isEnabled === false || status === false) continue;
    objects.push(root + '.AssociatedDevice');
    const associated = read(root + '.AssociatedDevice');
    const associatedCount = Number(read(root + '.AssociatedDeviceNumberOfEntries'));
    if ((associated && typeof associated === 'object' && Object.keys(associated).some(k => /^\d+$/.test(k)))
        || (Number.isFinite(associatedCount) && associatedCount > 0)) associatedEntriesFound = true;
    activeWifiFound = true;
  }

  // TR-181: use only advertised AP instances and do not guess instance IDs.
  for (let index = 1; index <= 16; index++) {
    const root = `Device.WiFi.AccessPoint.${index}`;
    const hasTree = read(root + '.Enable') !== undefined || read(root + '.Status') !== undefined || read(root + '.SSIDReference') !== undefined;
    if (!hasTree) continue;
    if (enabled(read(root + '.Enable')) === false || enabled(read(root + '.Status')) === false) continue;
    objects.push(root + '.AssociatedDevice');
    const associated = read(root + '.AssociatedDevice');
    const associatedCount = Number(read(root + '.AssociatedDeviceNumberOfEntries'));
    if ((associated && typeof associated === 'object' && Object.keys(associated).some(k => /^\d+$/.test(k)))
        || (Number.isFinite(associatedCount) && associatedCount > 0)) associatedEntriesFound = true;
    activeWifiFound = true;
  }

  const hasLegacyHosts = read('InternetGatewayDevice.LANDevice.1.Hosts.Host') !== undefined;
  const hasTr181Hosts = read('Device.Hosts.Host') !== undefined;
  if (activeWifiFound && !associatedEntriesFound && hasLegacyHosts) objects.push('InternetGatewayDevice.LANDevice.1.Hosts.Host');
  else if (activeWifiFound && !associatedEntriesFound && hasTr181Hosts) objects.push('Device.Hosts.Host');

  return [...new Set(objects)];
}

async function requestRefresh(tag, actor = null, options = {}) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device || !device._id) {
      return { ok: false, message: 'Perangkat tidak ditemukan.' };
    }

    const server = device._acs_server_id
      ? genieacsApi.getACSServer(device._acs_server_id)
      : genieacsApi.getACSServer('legacy');
    if (!server) {
      return { ok: false, message: 'Server ACS tidak ditemukan.' };
    }

    if (server.id === 'builtin' && !(options && options.clientDetails === true)) {
      try {
        const pending = db.prepare(
          `SELECT COUNT(*) AS c
           FROM acs_tasks
           WHERE device_id = ?
             AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
             AND status IN ('pending', 'in_progress')`
        ).get(device._id);
        if (pending && pending.c > 0) {
          return { ok: true, message: 'Sinkronisasi ONU masih berjalan. Mohon tunggu sebentar.' };
        }
      } catch (e) {
        logger.debug(`[CustomerDevice] Unable to check pending ACS tasks for ${device._id}: ${e.message}`);
      }
    }

    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${encodeURIComponent(device._id)}/tasks`;

    if (options && options.clientDetails === true) {
      const refreshObjects = collectClientRefreshObjects(device);
      if (refreshObjects.length === 0) {
        return { ok: false, queued: false, message: 'Jalur daftar klien Wi-Fi tidak tersedia pada data ACS ONT ini.' };
      }

      if (server.id === 'builtin') {
        const active = db.prepare(
          `SELECT id, name FROM acs_tasks WHERE device_id = ?
           AND status IN ('pending', 'in_progress') LIMIT 1`
        ).get(device._id);
        if (active) {
          if (['refreshObject', 'getParameterNames', 'getParameterValues'].includes(String(active.name || ''))) {
            db.prepare('UPDATE acs_devices SET client_data_updated_at = NULL WHERE id = ?').run(device._id);
          }
          return { ok: true, queued: false, busy: true, message: 'ACS masih memproses tugas ONT sebelumnya. Menunggu agar antrean tidak bertumpuk.', refreshObjects };
        }
        const previous = db.prepare(
          `SELECT created_at FROM acs_tasks WHERE device_id = ? AND name = 'refreshObject'
           AND payload LIKE '%"clientRefresh":true%' ORDER BY id DESC LIMIT 1`
        ).get(device._id);
        if (previous && Number.isFinite(new Date(previous.created_at).getTime())
            && Date.now() - new Date(previous.created_at).getTime() < 60_000) {
          return { ok: true, queued: false, busy: false, throttled: true,
            message: 'Permintaan pembaruan baru saja dikirim. Tunggu hasil baca dari ONT.', refreshObjects };
        }
      }

      let queued = 0;
      for (const objectName of refreshObjects) {
        const payload = { name: 'refreshObject', objectName, nextLevel: true };
        if (server.id === 'builtin') payload.clientRefresh = true;
        await instance.post(tasksUrl, payload, { timeout: 15000 });
        queued++;
      }

      if (server.id === 'builtin') {
        db.prepare('UPDATE acs_devices SET client_data_updated_at = NULL WHERE id = ?').run(device._id);
      }
      if (actor) {
        auditTrail.logAuditTrail({
          action: 'REFRESH_WIFI_CLIENTS', entity_type: 'device', entity_id: tag,
          actor_type: actor.type || 'unknown', actor_id: actor.id || null,
          actor_name: actor.name || null,
          details: { device_id: device._id, refreshObjects },
          ip_address: actor.ip || null, user_agent: actor.userAgent || null
        });
      }
      return { ok: true, queued: queued > 0, busy: false,
        message: `Permintaan pembacaan ulang daftar perangkat Wi-Fi dikirim ke ACS (${queued} tabel).`,
        deviceId: device._id, acsServerId: server.id, refreshObjects };
    }

    let refreshObjects = collectRefreshObjects(device);

    if (server.id === 'builtin') {
      // Prevent repeated client-table probes from piling up after a device rejects a path.
      const nowMs = Date.now();
      refreshObjects = refreshObjects.filter((objectName) => {
        const likePath = `%${objectName}%`;
        const active = db.prepare(
          `SELECT id FROM acs_tasks WHERE device_id = ?
           AND name IN ('refreshObject', 'getParameterNames', 'getParameterValues')
           AND status IN ('pending', 'in_progress') AND payload LIKE ? LIMIT 1`
        ).get(device._id, likePath);
        if (active) return false;
        const previous = db.prepare(
          `SELECT status, result, updated_at FROM acs_tasks
           WHERE device_id = ? AND name = 'refreshObject' AND payload LIKE ?
           ORDER BY id DESC LIMIT 1`
        ).get(device._id, likePath);
        if (!previous) return true;
        const ageHours = (nowMs - new Date(previous.updated_at).getTime()) / 3600000;
        if (previous.status === 'failed' && /9005/.test(String(previous.result || '')) && ageHours < 168) return false;
        return ageHours >= 24;
      });
    }

    for (const objectName of refreshObjects) {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName }, { timeout: 15000 });
    }

    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REFRESH_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id,
          refreshObjects
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return {
      ok: true,
      message: `Sinkronisasi ONU dimulai. ${refreshObjects.length} jalur TR-069 dipoll.`,
      deviceId: device._id,
      acsServerId: server.id,
      refreshObjects
    };
  } catch (e) {
    logger.error(`[CustomerDevice] Error requesting refresh for ${tag}: ${e.message}`);
    return { ok: false, message: 'Gagal memulai sinkronisasi ONU.' };
  }
}

async function requestReboot(tag, actor = null) {
  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    await instance.post(
      `/devices/${encodeURIComponent(device._id)}/tasks`,
      { name: 'reboot', timestamp: new Date().toISOString() }
    );

    // Catat audit trail jika berhasil
    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REBOOT_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return { ok: true, message: 'Perintah reboot terkirim. Tunggu beberapa menit hingga ONU online.' };
  } catch (e) {
    return { ok: false, message: 'Gagal mengirim reboot ke GenieACS.' };
  }
}

/** Daftar perangkat yang punya minimal satu tag (untuk admin WA). */
async function listDevicesWithTags(limit = 250) {
  const servers = genieacsApi.getAllACSServers();
  const queries = [
    { _tags: { $exists: true, $ne: [] } },
    { _tags: { $exists: true, $not: { $size: 0 } } },
    { '_tags.0': { $exists: true } }
  ];
  const projection = [
    '_id',
    '_tags',
    '_lastInform',
    'DeviceID.SerialNumber',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value'
  ].join(',');

  let allDevices = [];
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 250, 500));

  for (const server of servers) {
    let found = false;
    for (const query of queries) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        let response;
        try {
          response = await instance.get(`/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        } catch (e) {
          response = await instance.get(`/api/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        }
        const rows = Array.isArray(response.data) ? response.data : [];
        if (rows.length > 0) {
          rows.forEach(d => {
            d._acs_server_id = server.id;
            d._acs_server_name = server.name;
          });
          allDevices.push(...rows);
          found = true;
          break;
        }
      } catch (e) {
        /* coba query alternatif */
      }
    }
  }
  
  if (allDevices.length > 0) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS.' };
}

/** Mengambil semua perangkat tanpa melihat tag. */
async function listAllDevices(limit = 999999, acsId = null) {
  let servers = genieacsApi.getAllACSServers();
  if (acsId && acsId !== 'all') {
    servers = servers.filter(s => String(s.id) === String(acsId));
  }
  
  let allDevices = [];
  let lastError = null;

  // Query servers in parallel using Promise.allSettled
  const promises = servers.map(async (server) => {
    try {
      const instance = genieacsApi.createAxiosInstance(server);
      const params = {
        limit,
        projection: '_id,_tags,_lastInform,DeviceID.SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress,Device.PPP.Interface.1.Username,Device.PPP.Interface.1.ExternalIPAddress,InternetGatewayDevice.DeviceInfo.ModelName,InternetGatewayDevice.DeviceInfo.SoftwareVersion,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID,Device.WiFi.SSID.1.SSID,Device.WiFi.SSID.2.SSID,Device.WiFi.SSID.3.SSID,Device.WiFi.SSID.4.SSID,Device.WiFi.SSID.5.SSID,Device.WiFi.SSID.6.SSID,Device.WiFi.SSID.7.SSID,Device.WiFi.SSID.8.SSID,Device.WiFi.SSID.9.SSID,Device.WiFi.SSID.10.SSID,Device.WiFi.SSID.11.SSID,Device.WiFi.SSID.12.SSID,Device.WiFi.SSID.13.SSID,Device.WiFi.SSID.14.SSID,Device.WiFi.SSID.15.SSID,Device.WiFi.SSID.16.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations,InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries,Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries,Device.Hosts.HostNumberOfEntries,InternetGatewayDevice.LANDevice.1.Hosts.Host,Device.Hosts.Host'
      };
      let response;
      try {
        response = await instance.get(`/devices`, { params, timeout: 8000 });
      } catch (e) {
        response = await instance.get(`/api/devices`, { params, timeout: 8000 });
      }
      const rows = Array.isArray(response.data) ? response.data : [];
      rows.forEach(d => {
        d._acs_server_id = server.id;
        d._acs_server_name = server.name;
      });
      return rows;
    } catch (e) {
      logger.error(`[CustomerDevice] Error listing devices on ${server.name}: ${e.message}`);
      throw e;
    }
  });

  const results = await Promise.allSettled(promises);
  results.forEach((r) => {
    if (r.status === 'fulfilled') {
      allDevices.push(...r.value);
    } else {
      lastError = r.reason;
    }
  });
  
  if (allDevices.length > 0 || !lastError) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS: ' + (lastError ? lastError.message : 'Unknown error') };
}

async function updateCustomerTag(oldTag, newTag) {
  const device = await findDeviceByTag(oldTag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    const tags = Array.isArray(device._tags) ? device._tags.filter((t) => t !== oldTag) : [];
    tags.push(newTag);
    await instance.put(
      `/devices/${encodeURIComponent(device._id)}`,
      { _id: device._id, _tags: tags }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, message: 'Gagal mengubah tag.' };
  }
}

module.exports = {
  findDeviceByTag,
  findDeviceByPppoe,
  fetchFullDevice,
  resolveDeviceToken,
  mapDeviceData,
  extractPppoeUser,
  getCustomerDeviceData,
  fallbackCustomer,
  requestRefresh,
  updateSSID,
  updatePassword,
  updateTechnicianWifiPassword,
  requestWifiPasswordUpdate,
  requestWifiSsidUpdate,
  selectFiberHomeWifiIndexes,
  requestReboot,
  updateCustomerTag,
  listDevicesWithTags,
  listAllDevices,
  expandTagCandidates,
  findDeviceWithTagVariants,
  phoneFromPnJid
};
