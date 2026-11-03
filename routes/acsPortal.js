const express = require('express');
const router = express.Router();
const rawAxios = require('axios');
const db = require('../config/database');
const { getSetting, getSettings } = require('../config/settingsManager');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const customerDevice = require('../services/customerDeviceService');
const mikrotikSvc = require('../services/mikrotikService');
const fs = require('fs');
const path = require('path');
const { createAxiosInstance, isBuiltinAcsEnabled } = require('../config/genieacs');

// Proxy axios to support local built-in ACS proxy
const axios = {
    get: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && (url.startsWith('local/') || url === 'local')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.get(path, config);
        }
        return rawAxios.get(url, config);
    },
    post: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.post(path, data, config);
        }
        return rawAxios.post(url, data, config);
    },
    delete: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.delete(path, config);
        }
        return rawAxios.delete(url, config);
    },
    put: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.put(path, data, config);
        }
        return rawAxios.put(url, data, config);
    }
};

// Helper for DB queries (using better-sqlite3)
function getACSServers(id = null) {
    if (isBuiltinAcsEnabled()) {
        const builtinServer = {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
        // The local CWMP handler currently receives the main fleet, while a separate
        // GenieACS instance may still own additional devices. Keep both sources visible.
        const externalRows = db.prepare("SELECT * FROM genieacs_servers WHERE lower(coalesce(status, 'active')) = 'active'").all().filter(row => {
            const url = String(row?.url || '').trim();
            return /^https?:\/\//i.test(url);
        });
        if (id && id !== 'all') {
            if (id === 'builtin') return [builtinServer];
            const matching = externalRows.find(row => String(row.id) === String(id));
            return matching ? [matching] : [];
        }
        return [builtinServer, ...externalRows];
    }

    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        if (!row || String(row.status || 'active').toLowerCase() !== 'active') return [];
        const url = String(row.url || '').trim();
        return /^https?:\/\//i.test(url) ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    // Jangan kirim URL placeholder "local" ke axios saat Built-in ACS tidak aktif.
    // Server Built-in hanya boleh dipakai melalui adapter SQLite ketika use_builtin_acs=true.
    const validRows = rows.filter(row => {
        const url = String(row?.url || '').trim();
        return String(row?.status || 'active').toLowerCase() === 'active' && /^https?:\/\//i.test(url);
    });
    return legacyServer ? [legacyServer, ...validRows] : validRows;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', ''),
        acs_vparams: '', // Default empty for now
        acs_path_pppoe: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        acs_path_ip: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 15000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    return config;
}

// Helper to normalize URL
function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toBool(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

// FiberHome HG6145D2 reports PPPoE_Routed on working WANs. Keep the legacy
// vendor mapping for other models until their actual ConnectionType is discovered.
function getWanConnectionType(mode, manufacturer, productClass) {
    if (String(mode || '').toLowerCase() !== 'pppoe') return 'Bridged';
    const make = String(manufacturer || '').toLowerCase();
    const model = String(productClass || '').toUpperCase();
    if (make.includes('fiberhome') && model.includes('HG6145D2')) return 'PPPoE_Routed';
    return 'IP_Routed';
}

function normalizeSelectionArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return Array.from(new Set(
        items.map(v => String(v || '').trim()).filter(Boolean)
    ));
}

function buildSingleParamTasks(parameterValues) {
    return (parameterValues || [])
        .filter(pv => Array.isArray(pv) && pv.length >= 2 && pv[0])
        .map(pv => ({
            name: 'setParameterValues',
            payload: { parameterValues: [pv] }
        }));
}

function getParamLeafValue(obj, key) {
    if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    const value = obj[key];
    if (value && typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, '_value')) return value._value;
        if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
    }
    return value;
}

// Reuse a failed PPPoE entry with the same username rather than creating WAN.3/4/... on every retry.
// If state is not known, stop instead of risking a duplicate interface.
function findExistingPppoeByUsername(wanConnectionDevices, username) {
    const wanted = String(username || '').trim();
    if (!wanted) return null;
    for (const [wanDeviceInstance, wcd] of Object.entries(wanConnectionDevices || {})) {
        if (!/^\d+$/.test(wanDeviceInstance) || !wcd || typeof wcd !== 'object') continue;
        const table = wcd.WANPPPConnection || {};
        for (const [connectionInstance, ppp] of Object.entries(table)) {
            if (!/^\d+$/.test(connectionInstance) || !ppp || typeof ppp !== 'object') continue;
            const currentUser = String(getParamLeafValue(ppp, 'Username') ?? '').trim();
            if (!currentUser || currentUser !== wanted) continue;
            const hasIp = Object.prototype.hasOwnProperty.call(ppp, 'ExternalIPAddress');
            const ip = hasIp ? String(getParamLeafValue(ppp, 'ExternalIPAddress') ?? '').trim() : null;
            if (!hasIp) return { state: 'unknown', wanDeviceInstance, connectionInstance, ip: null };
            if (!ip || ip === '0.0.0.0') return { state: 'reusable', wanDeviceInstance, connectionInstance, ip };
            return { state: 'active', wanDeviceInstance, connectionInstance, ip };
        }
    }
    return null;
}

async function queueExistingWanFollowups(axiosClient, baseUrl, deviceId, followups, vars, config) {
    let firstTaskId = null;
    for (const spec of (Array.isArray(followups) ? followups : [])) {
        if (!spec || !spec.name) continue;
        const rawPayload = spec.payload && typeof spec.payload === 'object' ? spec.payload : {};
        const body = JSON.parse(JSON.stringify({ name: spec.name, ...rawPayload })
            .replace(/\{\{wanDeviceInstance\}\}/g, String(vars.wanDeviceInstance))
            .replace(/\{\{wanConnectionInstance\}\}/g, String(vars.wanConnectionInstance)));
        const response = await axiosClient.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, body, config);
        if (firstTaskId === null) {
            const parsed = parseInt(response?.data?._id, 10);
            if (Number.isFinite(parsed)) firstTaskId = parsed;
        }
    }
    return firstTaskId;
}

function attachWorkflowMeta(taskSpec, workflowMeta) {
    if (!taskSpec || typeof taskSpec !== 'object') return taskSpec;
    const meta = workflowMeta && typeof workflowMeta === 'object' ? workflowMeta : {};
    const next = { ...taskSpec };
    if (next.payload && typeof next.payload === 'object' && !Array.isArray(next.payload)) {
        next.payload = { ...next.payload };
    }

    if (meta.workflowId) {
        next.workflowId = meta.workflowId;
        if (next.payload) next.payload.workflowId = meta.workflowId;
    }
    if (meta.workflowType) {
        next.workflowType = meta.workflowType;
        if (next.payload) next.payload.workflowType = meta.workflowType;
    }
    if (meta.workflowLabel) {
        next.workflowLabel = meta.workflowLabel;
        if (next.payload) next.payload.workflowLabel = meta.workflowLabel;
    }
    if (Array.isArray(next.followup)) {
        next.followup = next.followup.map(item => attachWorkflowMeta(item, meta));
    }
    if (next.payload && Array.isArray(next.payload.followup)) {
        next.payload.followup = next.payload.followup.map(item => attachWorkflowMeta(item, meta));
    }
    return next;
}

function describeAddWanTask(task) {
    const name = String(task?.name || '').trim();
    const payload = task && task.payload && typeof task.payload === 'object' ? task.payload : {};

    if (name === 'addObject') {
        const objectName = String(payload.objectName || payload.object || '');
        if (/WANConnectionDevice\.\{\{wanDeviceInstance\}\}\.(WANPPPConnection|WANIPConnection)/.test(objectName)) {
            return 'Membuat koneksi WAN';
        }
        if (objectName.includes('WANConnectionDevice')) {
            return 'Membuat slot WAN';
        }
    }

    if (name === 'setParameterValues') {
        const firstParam = Array.isArray(payload.parameterValues) && payload.parameterValues[0]
            ? String(payload.parameterValues[0][0] || '')
            : '';
        if (firstParam.includes('DHCPServerEnable')) return 'Mengatur DHCP LAN';
        if (firstParam.includes('WLANConfiguration')) return 'Mengatur Wi-Fi';
        if (/(VLAN|LANBind|SSIDBind)/.test(firstParam)) return 'Mengatur VLAN dan binding';
        if (/(ConnectionType|NATEnabled|Username|Password|Enable)/.test(firstParam)) return 'Mengatur koneksi WAN';
        return 'Menerapkan parameter WAN';
    }

    if (name === 'getParameterValues') return 'Verifikasi hasil provisioning';
    if (name === 'refreshObject') return 'Menyegarkan data perangkat';
    return name || 'Task ACS';
}

function getBuiltinCachedInstanceMaps(deviceId) {
    // The built-in adapter projects device data differently from GenieACS REST.
    // Use the authoritative cached parameter names when the nested projection is absent,
    // so Add WAN reuses an existing WANConnectionDevice instead of adding the parent again.
    const wan = {};
    const wlan = {};
    try {
        const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(String(deviceId || ''));
        const params = JSON.parse(row?.params || '{}');
        for (const path of Object.keys(params)) {
            const wanMatch = path.match(/^InternetGatewayDevice\.WANDevice\.1\.WANConnectionDevice\.(\d+)\./);
            if (wanMatch) wan[wanMatch[1]] ||= {};
            const wlanMatch = path.match(/^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.(\d+)\./);
            if (wlanMatch) wlan[wlanMatch[1]] ||= {};
        }
    } catch (err) {
        console.warn(`[AddWAN] Could not derive cached WAN/WLAN instances for ${deviceId}: ${err.message}`);
    }
    return { wan, wlan };
}

function buildBuiltinAddWanWorkflow({
    mode,
    parsedVlan,
    pppoeUser,
    pppoePass,
    dhcp,
    lanPorts,
    wlanSsids,
    configureWifi,
    wifiSsid24,
    wifiPass24,
    wifiSsid5,
    wifiPass5,
    manufacturer,
    productClass,
    wlanConfig,
    wanConnectionDevices,
    workflowMeta
}) {
    const isPppoe = mode === 'pppoe';
    const manufacturerKey = String(manufacturer || '').toLowerCase();
    const productClassKey = String(productClass || '').toUpperCase();
    const isZteF6600P = manufacturerKey.includes('zte') && productClassKey.includes('F6600P');
    const isFiberHomeHG6145D2 = manufacturerKey.includes('fiberhome') && productClassKey.includes('HG6145D2');
    const connectionType = isPppoe ? 'WANPPPConnection' : 'WANIPConnection';
    const lanPortsArray = normalizeSelectionArray(lanPorts);
    const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
    const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.{{wanConnectionInstance}}`;
    const followup = [];

    const baseParamValues = [
        [`${baseConnPath}.ConnectionType`, getWanConnectionType(mode, manufacturer, productClass), 'xsd:string']
    ];

    if (isPppoe) {
        baseParamValues.push(
            [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
            [`${baseConnPath}.Username`, pppoeUser, 'xsd:string'],
            [`${baseConnPath}.Password`, pppoePass, 'xsd:string']
        );
    }

    followup.push(...buildSingleParamTasks(baseParamValues));

    const vendorParamValues = [];
    if (isFiberHomeHG6145D2) {
        // For HG6145D2 only send VLANID here: the live device confirmed it accepts this leaf,
        // while several similarly named vendor leaves are not yet present in discovered data.
        vendorParamValues.push([`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt']);
    } else if (manufacturerKey.includes('huawei')) {
        vendorParamValues.push(
            [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_HW_WANMode`, isPppoe ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else if (manufacturerKey.includes('zte') && productClassKey.includes('F6600P')) {
        // ZTE F6600P reports these vendor-specific names on its existing WAN tree.
        vendorParamValues.push(
            [`${baseConnPath}.X_ZTE-COM_ServiceList`, 'INTERNET', 'xsd:string'],
            [`${baseConnPath}.X_ZTE-COM_VLANEnable`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_ZTE-COM_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE-COM_8021P`, 0, 'xsd:unsignedInt']
        );
    } else if (manufacturerKey.includes('zte')) {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else {
        // Unknown models get only the commonly exposed VLANID field; avoid guessing
        // VLANIDMark/VLANMode because many ONTs reject those names with CWMP 9005.
        vendorParamValues.push([`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt']);
    }

    followup.push(...buildSingleParamTasks(vendorParamValues));
    // Enable last: some firmware rejects enabling a new WAN before required fields exist.
    followup.push({ name: 'setParameterValues', payload: { parameterValues: [[`${baseConnPath}.Enable`, true, 'xsd:boolean']] } });

    followup.push({
        name: 'setParameterValues',
        payload: {
            parameterValues: [[
                'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable',
                toBool(dhcp),
                'xsd:boolean'
            ]]
        }
    });

    const verifyNames = [
        `${baseConnPath}.Enable`,
        `${baseConnPath}.ConnectionType`,
        `${baseConnPath}.ExternalIPAddress`,
        `${baseConnPath}.Uptime`
    ];
    if (isPppoe) {
        verifyNames.push(`${baseConnPath}.Username`, `${baseConnPath}.NATEnabled`);
    }

    const wifiParamValues = [];
    const wlanObj = wlanConfig || {};
    if (toBool(configureWifi)) {
        if (wlanObj['1'] && wifiSsid24) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
            verifyNames.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            if (wifiPass24) {
                if (isZteF6600P) {
                    wifiParamValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']);
                } else {
                    wifiParamValues.push(
                        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', wifiPass24, 'xsd:string'],
                        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']
                    );
                }
            }
        }

        const fiveGIndex = wlanObj['5'] ? '5' : (wlanObj['2'] ? '2' : null);
        if (fiveGIndex && wifiSsid5) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
            verifyNames.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`);
            if (wifiPass5) {
                if (isZteF6600P) {
                    wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']);
                } else {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }
        }
    }

    followup.push(...buildSingleParamTasks(wifiParamValues));
    followup.push({
        name: 'getParameterValues',
        payload: {
            parameterNames: Array.from(new Set(verifyNames))
        }
    });

    const existingWanInstances = Object.keys(wanConnectionDevices || {})
        .filter(key => /^\d+$/.test(key)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    let rootTask;
    if (existingWanInstances.length > 0) {
        const wanDeviceInstance = existingWanInstances[0];
        rootTask = {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanDeviceInstance}.${connectionType}`,
            instanceVariable: 'wanConnectionInstance',
            templateVars: { wanDeviceInstance: String(wanDeviceInstance) },
            followup
        };
    } else {
        rootTask = {
            name: 'addObject',
            objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
            instanceVariable: 'wanDeviceInstance',
            followup: [{
                name: 'addObject',
                payload: {
                    objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}`,
                    instanceVariable: 'wanConnectionInstance',
                    followup
                }
            }]
        };
    }
    return attachWorkflowMeta(rootTask, workflowMeta);
}

// Read both GenieACS nested parameters and flat TR-069 parameter maps.
function getNestedValue(obj, path) {
    try {
        if (!obj || typeof obj !== 'object' || !path) return null;
        const unwrap = (value) => {
            if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value')) return value._value;
            if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
            return value;
        };
        // Built-in ACS stores parameter names as dotted keys; external GenieACS
        // returns the same paths as a nested object. Support both forms.
        if (Object.prototype.hasOwnProperty.call(obj, path)) return unwrap(obj[path]);
        const parts = String(path).split('.');
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined || typeof current !== 'object') return null;
            if (Object.prototype.hasOwnProperty.call(current, part)) {
                current = current[part];
            } else {
                const key = Object.keys(current).find(k => k.toLowerCase() === part.toLowerCase());
                if (!key) return null;
                current = current[key];
            }
        }
        return unwrap(current);
    } catch (_) {
        return null;
    }
}

// Standard paths for RX Power
const RX_POWER_PATHS = [
    'VirtualParameters.RXPower',
    'VirtualParameters.RXpower',
    'VirtualParameters.rx_power',
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
    'Device.XPON.Interface.1.Stats.RXPower',
    'Device.XPON.Interface.1.OpticalSignalLevel',
    'Device.Optical.Interface.1.RXPower',
    'Device.Optical.Interface.1.ReceivePower',
    'Device.Optical.Interface.1.ReceiveSignalLevel',
    'Device.XPON.Interface.1.RXPower',
    'Device.XPON.Interface.1.Stats.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_EponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RxPower'
];

const TX_POWER_PATHS = [
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
];
const MEMORY_TOTAL_PATHS = [
    'InternetGatewayDevice.DeviceInfo.MemoryStatus.Total',
    'Device.DeviceInfo.MemoryStatus.Total'
];
const MEMORY_FREE_PATHS = [
    'InternetGatewayDevice.DeviceInfo.MemoryStatus.Free',
    'Device.DeviceInfo.MemoryStatus.Free'
];
const CPU_USAGE_PATHS = [
    'InternetGatewayDevice.DeviceInfo.ProcessStatus.CPUUsage',
    'Device.DeviceInfo.ProcessStatus.CPUUsage'
];
function buildTrafficPaths(direction) {
    const sent = direction === 'sent';
    const total = sent ? 'TotalBytesSent' : 'TotalBytesReceived';
    const bytes = sent ? 'BytesSent' : 'BytesReceived';
    const ethernetBytes = sent ? 'EthernetBytesSent' : 'EthernetBytesReceived';
    const paths = [
        'InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.' + total,
        'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.Stats.' + bytes,
        'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.Stats.' + bytes,
        'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.Stats.' + bytes,
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.Stats.' + bytes,
        'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.Stats.' + bytes
    ];
    for (const connectionDevice of [1, 2, 3]) {
        for (const kind of ['WANPPPConnection', 'WANIPConnection']) {
            for (const instance of [1, 2, 3]) {
                paths.push('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.' + connectionDevice + '.' + kind + '.' + instance + '.Stats.' + ethernetBytes);
            }
        }
    }
    for (const instance of [1, 2, 3, 4]) {
        paths.push('Device.PPP.Interface.' + instance + '.Stats.' + bytes);
        paths.push('Device.IP.Interface.' + instance + '.Stats.' + bytes);
        paths.push('Device.Ethernet.Interface.' + instance + '.Stats.' + bytes);
    }
    return [...new Set(paths)];
}
const TRAFFIC_SENT_PATHS = buildTrafficPaths('sent');
const TRAFFIC_RECEIVED_PATHS = buildTrafficPaths('received');

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
    // Some ONTs expose their active WAN address under WANIPConnection rather than WANPPPConnection.
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress',
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
        
        if (matchedPath.includes('WANPPPConnection.') || matchedPath.includes('WANIPConnection.')) {
            const connectionTypePath = matchedPath.replace('ExternalIPAddress', 'ConnectionType');
            const connTypeMatches = getWildcardMatches(device, connectionTypePath);
            const connectionType = String(connTypeMatches[0]?.value || '').toLowerCase();
            if (connectionType.includes('bridge')) return false;
        }
        return true;
    });
    
    // For Built-in ACS, the last verified RouterOS session IP is fresher than cached WAN parameters.
    if (d._pppoeIP && d._pppoeIP !== '-' && d._pppoeIP !== '0.0.0.0') return d._pppoeIP;
    if (ip) return ip;
    // Never use GenieACS _ip here: it is the management/TR-069 source address, not PPPoE WAN IP.
    return '-';
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
    
    return user || '-';
}

function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || '-';
    if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
        return seconds;
    }
    const totalSecs = parseInt(seconds, 10);
    if (isNaN(totalSecs)) return seconds || '-';
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
    return '-';
}

function formatRxPower(val, path = '') {
    if (val === undefined || val === null || val === '-' || val === '') return '-';
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    const alreadyDbm = /X_FH_GponInterfaceConfig/i.test(path)
        || /Device\.Optical\.Interface\.\d+\.(?:OpticalSignalLevel|TransmitPower)$/i.test(path);
    if (alreadyDbm || num <= 0) return String(num);
    const dbVal = 30 + (Math.log10(num * Math.pow(10, -7)) * 10);
    return (Math.ceil(dbVal * 100) / 100).toFixed(2);
}

function extractRxPower(d) {
    let rxPower = '-';
    let rxPath = '';
    for (const path of RX_POWER_PATHS) {
        const val = getNestedValue(d, path);
        if (val !== undefined && val !== null && val !== '' && val !== '-') {
            rxPower = val;
            rxPath = path;
            break;
        }
    }
    return formatRxPower(rxPower, rxPath);
}

function extractTxPower(d) {
    let txPower = '-';
    let txPath = '';
    for (const path of TX_POWER_PATHS) {
        const val = getNestedValue(d, path);
        if (val !== undefined && val !== null && val !== '' && val !== '-') {
            txPower = val;
            txPath = path;
            break;
        }
    }
    return formatRxPower(txPower, txPath);
}

function firstMetricValue(d, paths) {
    for (const path of paths) {
        const val = getNestedValue(d, path);
        if (val !== undefined && val !== null && val !== '' && val !== '-') return val;
    }
    return '-';
}

function formatMemoryMetric(raw) {
    if (raw === '-' || raw === '' || raw == null) return '-';
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString('id-ID') + ' KB' : String(raw);
}

function formatTrafficMetric(raw) {
    if (raw === '-' || raw === '' || raw == null) return '-';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return String(raw);
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = n, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(unit === 0 ? 0 : 2) + ' ' + units[unit];
}

function extractDeviceMetrics(d) {
    const cpuRaw = firstMetricValue(d, CPU_USAGE_PATHS);
    return {
        memoryTotal: formatMemoryMetric(firstMetricValue(d, MEMORY_TOTAL_PATHS)),
        memoryFree: formatMemoryMetric(firstMetricValue(d, MEMORY_FREE_PATHS)),
        cpuUsage: cpuRaw === '-' ? '-' : (/%$/.test(String(cpuRaw)) ? String(cpuRaw) : String(cpuRaw) + '%'),
        trafficSent: formatTrafficMetric(firstMetricValue(d, TRAFFIC_SENT_PATHS)),
        trafficReceived: formatTrafficMetric(firstMetricValue(d, TRAFFIC_RECEIVED_PATHS))
    };
}

function extractSsid(d) {
    const paths = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'Device.WiFi.SSID.1.SSID',
        ...[2, 3, 4, 5, 6, 7, 8].map(i => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
        ...Array.from({ length: 16 }, (_, i) => `Device.WiFi.SSID.${i + 1}.SSID`)
    ];
    for (const path of paths) {
        const val = getNestedValue(d, path);
        if (val !== null && val !== undefined && String(val).trim() !== '' && String(val) !== '-') return String(val);
    }
    return '-';
}

function extractSsid5g(d) {
    const paths = [
        ...[5, 6, 7, 8].map(i => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
        'Device.WiFi.SSID.2.SSID',
        ...Array.from({ length: 15 }, (_, i) => `Device.WiFi.SSID.${i + 2}.SSID`)
    ];
    for (const path of paths) {
        const val = getNestedValue(d, path);
        if (val !== null && val !== undefined && String(val).trim() !== '' && String(val) !== '-') return String(val);
    }
    return '-';
}

function extractWifiClientCount(d) {
    const readCount = (path) => {
        const raw = getNestedValue(d, path);
        if (raw === null || raw === undefined || String(raw).trim() === '' || raw === '-') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    };

    // Collect vendor and standard counters across every legacy WLAN instance.
    // FiberHome firmware may return TotalAssociations=0 while its associated-device
    // table contains clients, so verify counters against observed MAC addresses below.
    const legacyCounts = [];
    for (let i = 1; i <= 8; i++) {
        let value = readCount(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.WLAN_AssociatedDeviceNumberOfEntries`);
        if (value === null) value = readCount(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`);
        if (value === null) value = readCount(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.AssociatedDeviceNumberOfEntries`);
        if (value !== null) legacyCounts.push(value);
    }

    let counterTotal = legacyCounts.length ? legacyCounts.reduce((sum, n) => sum + n, 0) : null;
    if (counterTotal === null) {
        const tr181Counts = [];
        for (let i = 1; i <= 16; i++) {
            const value = readCount(`Device.WiFi.AccessPoint.${i}.AssociatedDeviceNumberOfEntries`);
            if (value !== null) tr181Counts.push(value);
        }
        if (tr181Counts.length) counterTotal = tr181Counts.reduce((sum, n) => sum + n, 0);
    }

    // Prefer unique MAC addresses when tables are present. This avoids double-counting
    // one device exposed under aliases or both 2.4 GHz and 5 GHz by vendor firmware.
    const associatedTables = [
        ...Array.from({ length: 8 }, (_, i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i + 1}.AssociatedDevice`),
        ...Array.from({ length: 16 }, (_, i) => `Device.WiFi.AccessPoint.${i + 1}.AssociatedDevice`)
    ];
    const macAddresses = new Set();
    let sawAssociationTable = false;
    for (const path of associatedTables) {
        const table = getNestedValue(d, path);
        if (!table || typeof table !== 'object') continue;
        sawAssociationTable = true;
        const entries = Array.isArray(table) ? table : Object.entries(table)
            .filter(([key, value]) => key !== '' && Number.isInteger(Number(key)) && value && typeof value === 'object')
            .map(([, value]) => value);
        for (const entry of entries) {
            const mac = getNestedValue(entry, 'AssociatedDeviceMACAddress') ?? getNestedValue(entry, 'MACAddress');
            if (mac && String(mac).trim() && String(mac) !== '-') macAddresses.add(String(mac).trim().toUpperCase());
        }
    }
    if (macAddresses.size > 0) return macAddresses.size;
    if (counterTotal !== null) return counterTotal;
    if (sawAssociationTable) return 0;

    // Last fallback is a general LAN host count, which some models expose instead
    // of per-Wi-Fi counters. Unknown is shown as '-' rather than inventing zero.
    for (const path of [
        'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
        'Device.Hosts.HostNumberOfEntries'
    ]) {
        const value = readCount(path);
        if (value !== null) return value;
    }
    return '-';
}

function extractSoftwareVersion(d) {
    const SW_PATHS = [
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SoftwareVersion'
    ];
    for (const path of SW_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') return val;
    }
    return '-';
}

function extractUptime(d) {
    const UPTIME_PATHS = [
        'VirtualParameters.getdeviceuptime',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') {
            if (typeof val === 'string' && (val.includes('d') || val.includes(':')) && isNaN(val)) {
                return val;
            }
            const totalSecs = parseInt(val, 10);
            if (isNaN(totalSecs)) return val;
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
    }
    return '-';
}

// Middleware: Require Admin Session
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.status(403).json({ success: false, message: 'Forbidden' });
};

const requireAdminSession = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
};

function company() { return getSetting('company_header', 'ISP Admin'); }

function requireSidebarMenuAccess(menuKey) {
    return (req, res, next) => {
        const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
        if (access.allowed) return next();

        if (access.reason === 'hidden') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
            return res.redirect('/admin');
        }

        if (access.reason === 'locked') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password.` };
            return res.redirect('/admin/sidebar-settings');
        }

        req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
        return res.redirect('/admin');
    };
}

router.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
    res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
    res.locals.settings = getSettings();
    res.locals.company = company();
    next();
});

router.use(requireAdminSession, requireSidebarMenuAccess('acs_pro'));

async function getLANHosts(deviceId, serverConfig) {
    try {
        const baseUrl = normalizeUrl(serverConfig.url);
        const [hostsResponse, wifiResponse] = await Promise.all([
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.Hosts,Device.Hosts'
                }
            }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.AssociatedDevice,Device.WiFi.AccessPoint'
                }
            }).catch(() => ({ data: [] }))
        ]);

        const device = Array.isArray(hostsResponse.data) && hostsResponse.data.length > 0 ? hostsResponse.data[0] : null;
        if (!device) return [];

        // Some ONTs (notably part of the FiberHome fleet) expose the Wi-Fi
        // AssociatedDevice table without exposing the separate LAN Hosts table.
        // Do not return early when Hosts is absent; Wi-Fi associations are still valid clients.
        const hostTables = [
            device.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host,
            device.Device?.Hosts?.Host
        ];
        const hostArray = [];
        for (const hostTable of hostTables) {
            if (Array.isArray(hostTable)) {
                hostArray.push(...hostTable);
            } else if (hostTable && typeof hostTable === 'object') {
                hostArray.push(...Object.values(hostTable).filter(v => v && typeof v === 'object'));
            }
        }

        const wifiRssiMap = new Map();
        const wifiClients = [];
        const wifiDevice = Array.isArray(wifiResponse.data) && wifiResponse.data.length > 0 ? wifiResponse.data[0] : null;
        if (wifiDevice) {
            const wlanConfig = wifiDevice.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
            if (wlanConfig) {
                for (const bandKey of Object.keys(wlanConfig).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))) {
                    const band = wlanConfig[bandKey];
                    if (!band || !band.AssociatedDevice) continue;

                    let devArray = [];
                    if (Array.isArray(band.AssociatedDevice)) {
                        devArray = band.AssociatedDevice;
                    } else if (typeof band.AssociatedDevice === 'object') {
                        devArray = Object.values(band.AssociatedDevice).filter(v => v && typeof v === 'object');
                    }

                    const bandLabel = Number(bandKey) >= 5 ? '5GHz' : '2.4GHz';
                    devArray.forEach(dev => {
                        const getAssocVal = (...names) => {
                            for (const name of names) {
                                const item = dev?.[name];
                                const value = item && typeof item === 'object' && '_value' in item ? item._value : item;
                                if (value !== undefined && value !== null && String(value).trim() !== '') return value;
                            }
                            return null;
                        };
                        const mac = getAssocVal('AssociatedDeviceMACAddress', 'MACAddress');
                        const ip = getAssocVal('AssociatedDeviceIPAddress', 'IPAddress', 'IP') || '-';
                        const hostname = getAssocVal('AssociatedDeviceHostName', 'HostName', 'DeviceName') || 'Unknown';
                        const rssi = getAssocVal('AssociatedDeviceRSSI', 'AssociatedDeviceSignalStrength', 'X_HW_RSSI', 'SignalStrength', 'RSSI');
                        const rate = getAssocVal('AssociatedDeviceLastDataDownlinkRate', 'AssociatedDeviceLastDataUplinkRate', 'LastDataTransmitRate', 'LastDataUplinkRate', 'X_HW_TxRate');
                        if (mac && mac !== '-') {
                            const macLower = String(mac).toLowerCase();
                            const rssiNum = rssi !== null && Number.isFinite(parseInt(rssi, 10)) ? parseInt(rssi, 10) : null;
                            wifiRssiMap.set(macLower, { rssi: rssiNum, rate, band: bandLabel });
                            wifiClients.push({
                                index: wifiClients.length + 1,
                                mac: String(mac),
                                ip: String(ip),
                                hostname: String(hostname),
                                active: true,
                                isWiFi: true,
                                band: bandLabel,
                                rssi: rssiNum,
                                bytesReceived: 0,
                                bytesSent: 0
                            });
                        }
                    });
                }
            }

            // TR-181 WLAN clients (Device:2). Support any advertised AP instance.
            const tr181Aps = wifiDevice.Device?.WiFi?.AccessPoint;
            if (tr181Aps && typeof tr181Aps === 'object') {
                for (const [apKey, ap] of Object.entries(tr181Aps)) {
                    if (!ap || typeof ap !== 'object' || !ap.AssociatedDevice) continue;
                    const rows = Array.isArray(ap.AssociatedDevice)
                        ? ap.AssociatedDevice
                        : Object.values(ap.AssociatedDevice).filter(v => v && typeof v === 'object');
                    for (const entry of rows) {
                        const readAssoc = (...names) => {
                            for (const name of names) {
                                const item = entry?.[name];
                                const value = item && typeof item === 'object' && '_value' in item ? item._value : item;
                                if (value !== undefined && value !== null && String(value).trim() !== '') return value;
                            }
                            return null;
                        };
                        const mac = readAssoc('MACAddress', 'AssociatedDeviceMACAddress');
                        if (!mac || String(mac) === '-') continue;
                        const ip = readAssoc('IPAddress', 'AssociatedDeviceIPAddress', 'IP') || '-';
                        const hostname = readAssoc('HostName', 'AssociatedDeviceHostName', 'DeviceName') || 'Unknown';
                        const rssi = readAssoc('SignalStrength', 'RSSI', 'X_HW_RSSI', 'AssociatedDeviceRSSI');
                        const rssiNum = rssi !== null && Number.isFinite(parseInt(rssi, 10)) ? parseInt(rssi, 10) : null;
                        wifiRssiMap.set(String(mac).toLowerCase(), { rssi: rssiNum, rate: null, band: `WiFi AP ${apKey}` });
                        wifiClients.push({
                            index: wifiClients.length + 1,
                            mac: String(mac),
                            ip: String(ip),
                            hostname: String(hostname),
                            active: true,
                            isWiFi: true,
                            band: `WiFi AP ${apKey}`,
                            rssi: rssiNum,
                            bytesReceived: 0,
                            bytesSent: 0
                        });
                    }
                }
            }
        }

        const hostClients = hostArray.map((host, index) => {
            const getHostVal = (key) => {
                const val = host[key];
                if (val && typeof val === 'object' && '_value' in val) return val._value;
                return val;
            };

            const mac = getHostVal('MACAddress') || '-';
            const ip = getHostVal('IPAddress') || '-';
            const hostname = getHostVal('HostName') || 'Unknown';
            const activeRaw = getHostVal('Active');
            const interfaceType = getHostVal('InterfaceType') || '';
            const layer2Interface = getHostVal('Layer2Interface') || '';
            
            let bytesReceived = 0;
            let bytesSent = 0;
            const stats = host['X_HW_Stats'];
            if (stats && typeof stats === 'object') {
                bytesReceived = parseInt(stats.BytesReceived?._value || stats.BytesReceived || 0);
                bytesSent = parseInt(stats.BytesSent?._value || stats.BytesSent || 0);
            }

            const l2Str = layer2Interface.toString().toLowerCase();
            const isWiFi = interfaceType.toString().toLowerCase().includes('802.11') || l2Str.includes('wlan') || l2Str.includes('wifi');
            
            let finalRssi = null;
            let band = l2Str.includes('5') ? '5GHz' : '2.4GHz';
            const macLower = mac.toString().toLowerCase();

            if (isWiFi && wifiRssiMap.has(macLower)) {
                const wifiInfo = wifiRssiMap.get(macLower);
                finalRssi = wifiInfo.rssi;
                band = wifiInfo.band;
            }

            return {
                index: index + 1,
                mac, ip, hostname,
                active: activeRaw === true || activeRaw === 'true' || activeRaw === 1 || activeRaw === '1',
                isWiFi: isWiFi || wifiRssiMap.has(macLower),
                band, rssi: finalRssi,
                bytesReceived, bytesSent
            };
        });

        // Merge Host-table rows and Wi-Fi association rows by MAC. Some firmware has
        // only one of these tables, so taking HostTable.map() alone silently hid Wi-Fi clients.
        const byMac = new Map();
        for (const client of hostClients) {
            const key = String(client.mac || '').trim().toLowerCase();
            if (!key || key === '-') continue;
            byMac.set(key, client);
        }
        for (const client of wifiClients) {
            const key = String(client.mac || '').trim().toLowerCase();
            if (!key || key === '-') continue;
            const old = byMac.get(key);
            if (old) {
                byMac.set(key, {
                    ...old,
                    ip: old.ip && old.ip !== '-' ? old.ip : client.ip,
                    hostname: old.hostname && old.hostname !== 'Unknown' ? old.hostname : client.hostname,
                    active: true,
                    isWiFi: true,
                    band: client.band || old.band,
                    rssi: client.rssi ?? old.rssi
                });
            } else {
                byMac.set(key, client);
            }
        }
        return Array.from(byMac.values()).map((client, index) => ({ ...client, index: index + 1 }));
    } catch (err) {
        console.error(`[getLANHosts] Error:`, err.message);
        return [];
    }
}

// ============================================
// DEVICE FETCH HELPERS
// ============================================

async function fetchDevicesFromACS(server, vParams = [], paths = {}, options = {}) {
    const { page = 1, limit = null, activeSessionsMap = null } = options;
    try {
        const isBuiltinServer = server && (server.id === 'builtin' || server.url === 'local');
        // Built-in ACS tidak memiliki URL HTTP; gunakan adapter SQLite langsung.
        // Jangan panggil normalizeUrl('local') karena itu bukan URL yang valid.
        const baseUrl = isBuiltinServer ? '' : normalizeUrl(server.url);
        const requestClient = isBuiltinServer ? createAxiosInstance({ id: 'builtin', url: 'local' }) : axios;
        const requestUrl = isBuiltinServer ? '/devices' : `${baseUrl}/devices`;
        // Gabungkan proyeksi dasar dengan path pencarian
        const ssidProjectionPaths = [
            ...Array.from({ length: 8 }, (_, i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i + 1}.SSID`),
            ...Array.from({ length: 16 }, (_, i) => `Device.WiFi.SSID.${i + 1}.SSID`)
        ];
        const clientProjectionPaths = [
            ...Array.from({ length: 8 }, (_, i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i + 1}.WLAN_AssociatedDeviceNumberOfEntries`),
            ...Array.from({ length: 8 }, (_, i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i + 1}.TotalAssociations`),
            ...Array.from({ length: 8 }, (_, i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i + 1}.AssociatedDeviceNumberOfEntries`),
            ...Array.from({ length: 16 }, (_, i) => `Device.WiFi.AccessPoint.${i + 1}.AssociatedDeviceNumberOfEntries`),
            'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
            'Device.Hosts.HostNumberOfEntries'
        ];
        // Explicitly project the fields this table renders. Without these paths,
        // external GenieACS returned no SSID/optical/client telemetry even though
        // those values existed on the ONT.
        const projection = [...new Set([
            '_id', '_lastInform', '_ip', '_deviceId._Manufacturer',
            '_deviceId._ProductClass', '_deviceId._SerialNumber',
            'VirtualParameters',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
            ...ssidProjectionPaths,
            ...clientProjectionPaths,
            ...RX_POWER_PATHS,
            ...TX_POWER_PATHS,
            ...MEMORY_TOTAL_PATHS,
            ...MEMORY_FREE_PATHS,
            ...CPU_USAGE_PATHS
        ])].join(',');
        
        const params = { projection };
        if (limit !== null) {
            params.limit = limit + 1;
            params.skip = (page - 1) * limit;
        }

        const response = await requestClient.get(requestUrl, {
            ...getAxiosConfig(server),
            params
        });

        if (!Array.isArray(response.data)) return { server, devices: [], hasMore: false };

        const hasMore = limit !== null && response.data.length > limit;
        const devicesData = hasMore ? response.data.slice(0, limit) : response.data;

        const sessionsMap = activeSessionsMap || (await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map()));

        const devices = devicesData.map(d => {
            // Fallback PPPoE
            let pppoeUser = extractPppoeUser(d);

            // Normalize model-specific optical and system metrics.
            let rxPower = extractRxPower(d);
            let txPower = extractTxPower(d);
            const deviceMetrics = extractDeviceMetrics(d);

            // PPPoE comes from the live RouterOS session when available; _ip is TR-069 only.
            const activePppoeSession = pppoeUser && pppoeUser !== '-' ? sessionsMap.get(pppoeUser.toLowerCase()) : null;
            let ip = String(activePppoeSession?.ip || extractPppoeIp(d) || '-');
            const tr069Ip = String(d._ip || '-');

            // Customer Name
            const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') || 
                                getNestedValue(d, 'VirtualParameters.customer_name') || 
                                '-';

            const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                             (pppoeUser && pppoeUser !== '-' && sessionsMap.has(pppoeUser.toLowerCase()));

            return {
                id: d._id,
                sn: d._deviceId?._SerialNumber || d._id,
                last_inform: d._lastInform,
                isOnline: isOnline,
                manufacturer: d._deviceId?._Manufacturer || '-',
                model: d._deviceId?._ProductClass || '-',
                customer_name: customerName,
                rx_power: rxPower,
                tx_power: txPower,
                memory_total: deviceMetrics.memoryTotal,
                memory_free: deviceMetrics.memoryFree,
                cpu_usage: deviceMetrics.cpuUsage,
                traffic_sent: deviceMetrics.trafficSent,
                traffic_received: deviceMetrics.trafficReceived,
                ssid: extractSsid(d),
                ssid_5g: extractSsid5g(d),
                connected_clients: extractWifiClientCount(d),
                pppoe_user: pppoeUser,
                ip: ip,
                pppoe_ip: ip,
                tr069_ip: tr069Ip,
                acs_server_name: server.name,
                acs_server_id: server.id
            };
        });

        return { server, devices, hasMore };
    } catch (err) {
        console.error(`[fetchDevicesFromACS] Error on ${server.name}:`, err.message);
        return { server, devices: [], hasMore: false, error: err.message };
    }
}

function enrichDevicesWithCustomerNames(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return devices;

    let customers = [];
    try {
        customers = db.prepare(`
            SELECT id, name, genieacs_tag, pppoe_username, hotspot_username, static_ip
            FROM customers
        `).all();
    } catch (e) {
        console.error('[enrichDevicesWithCustomerNames] Error loading customers:', e.message);
        return devices;
    }

    const byTag = new Map();
    const byPppoe = new Map();
    const byHotspot = new Map();
    const byIp = new Map();

    for (const c of customers) {
        if (!c.name) continue;
        const name = String(c.name).trim();
        if (c.genieacs_tag) byTag.set(String(c.genieacs_tag).trim().toLowerCase(), name);
        if (c.pppoe_username) byPppoe.set(String(c.pppoe_username).trim().toLowerCase(), name);
        if (c.hotspot_username) byHotspot.set(String(c.hotspot_username).trim().toLowerCase(), name);
        if (c.static_ip) byIp.set(String(c.static_ip).trim().toLowerCase(), name);
    }

    return devices.map(d => {
        let matchedName = null;

        // 1. PPPoE Username Match
        const pppUser = String(d.pppoe_user || d.pppoeUser || d.pppoeUsername || '').trim().toLowerCase();
        if (pppUser && pppUser !== '-' && pppUser !== 'n/a' && byPppoe.has(pppUser)) {
            matchedName = byPppoe.get(pppUser);
        }

        // 2. Serial Number, Device ID, or Tags Match
        if (!matchedName) {
            const sn = String(d.sn || d.serialNumber || '').trim().toLowerCase();
            const devId = String(d.id || d.phone || '').trim().toLowerCase();
            if (sn && byTag.has(sn)) matchedName = byTag.get(sn);
            else if (devId && byTag.has(devId)) matchedName = byTag.get(devId);
            else if (Array.isArray(d.tags)) {
                for (const t of d.tags) {
                    const tagKey = String(t || '').trim().toLowerCase();
                    if (byTag.has(tagKey)) {
                        matchedName = byTag.get(tagKey);
                        break;
                    }
                }
            }
        }

        // 3. Hotspot Username Match
        if (!matchedName && pppUser && byHotspot.has(pppUser)) {
            matchedName = byHotspot.get(pppUser);
        }

        // 4. IP Address Match
        if (!matchedName) {
            const ip = String(d.ip || d.pppoe_ip || d.pppoeIP || '').trim().toLowerCase();
            if (ip && ip !== '-' && byIp.has(ip)) {
                matchedName = byIp.get(ip);
            }
        }

        const finalName = matchedName || (d.customer_name && d.customer_name !== '-' ? d.customer_name : (d.customerName && d.customerName !== '-' ? d.customerName : '-'));

        return {
            ...d,
            customer_name: finalName,
            customerName: finalName
        };
    });
}

// ============================================
// ROUTES
// ============================================

router.get('/', async (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim() || null;
        const acsServers = getACSServers();
        const legacyACS = getLegacyACS();
        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());
        
        const activeServers = acsServers.length > 0 ? acsServers :
            (legacyACS.acs_url ? [{ id: 'legacy', name: 'Default ACS', url: legacyACS.acs_url, username: legacyACS.acs_user, password: legacyACS.acs_pass }] : []);

        const selectedAcsId = req.query.acs || (activeServers.length > 1 ? 'all' : activeServers[0]?.id);
        const targetServers = selectedAcsId && selectedAcsId !== 'all' ? activeServers.filter(s => String(s.id) === String(selectedAcsId)) : activeServers;

        let allDevices = [];
        if (targetServers.length > 0) {
            if (searchQuery) {
                // Search mode: query devices with search filter
                const query = JSON.stringify({
                    $or: [
                        { '_deviceId._SerialNumber': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.CustomerName': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.customer_name': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.PPPoEUser': { $regex: searchQuery, $options: 'i' } },
                        { '_tags': searchQuery }
                    ]
                });
                
                for (const server of targetServers) {
                    try {
                        const isBuiltinServer = server && (server.id === 'builtin' || server.url === 'local');
                        const baseUrl = normalizeUrl(server.url);
                        const requestClient = isBuiltinServer ? createAxiosInstance({ id: 'builtin', url: 'local' }) : axios;
                        const requestUrl = isBuiltinServer ? '/devices' : `${baseUrl}/devices`;
                        const response = await requestClient.get(requestUrl, {
                            ...getAxiosConfig(server),
                            params: { query }
                        });
                        
                        if (Array.isArray(response.data)) {
                            const devices = response.data.map(d => {
                                 let rxPower = extractRxPower(d);
                                 let txPower = extractTxPower(d);
                                 const deviceMetrics = extractDeviceMetrics(d);
                                
                                let pppoeUser = extractPppoeUser(d);
                                const activePppoeSession = pppoeUser && pppoeUser !== '-' ? activeSessionsMap.get(pppoeUser.toLowerCase()) : null;
                                const ip = String(activePppoeSession?.ip || extractPppoeIp(d) || '-');
                                const tr069Ip = String(d._ip || '-');
                                
                                const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') ||
                                                    getNestedValue(d, 'VirtualParameters.customer_name') || '-';
                                
                                const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                                                 (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));
                                
                                return {
                                    id: d._id,
                                    sn: d._deviceId?._SerialNumber || d._id,
                                    last_inform: d._lastInform,
                                    isOnline: isOnline,
                                    manufacturer: d._deviceId?._Manufacturer || '-',
                                    model: d._deviceId?._ProductClass || '-',
                                    rx_power: rxPower,
                                    tx_power: txPower,
                                    memory_total: deviceMetrics.memoryTotal,
                                    memory_free: deviceMetrics.memoryFree,
                                    cpu_usage: deviceMetrics.cpuUsage,
                                    traffic_sent: deviceMetrics.trafficSent,
                                    traffic_received: deviceMetrics.trafficReceived,
                                    ssid: extractSsid(d),
                                    ssid_5g: extractSsid5g(d),
                                    connected_clients: extractWifiClientCount(d),
                                    ip: ip, // IP PPPoE remains the customer/session address used by the table.
                                    pppoe_ip: ip,
                                    tr069_ip: tr069Ip,
                                    pppoe_user: pppoeUser,
                                    customer_name: customerName,
                                    acs_server_id: server.id,
                                    acs_server_name: server.name
                                };
                            });
                            allDevices = allDevices.concat(devices);
                        }
                    } catch (err) {
                        console.error(`Search error on server ${server.name}:`, err.message);
                    }
                }
            } else {
                // Normal mode: fetch all devices
                const results = await Promise.allSettled(targetServers.map(s => fetchDevicesFromACS(s, [], legacyACS, { activeSessionsMap })));
                results.forEach(r => { if (r.status === 'fulfilled') allDevices = allDevices.concat(r.value.devices); });
            }
        }

        // De-duplicate devices that may be registered in both the local ACS and GenieACS.
        // Since the local CWMP handler is the primary fleet, keep its record when IDs overlap.
        const seenDeviceIds = new Set();
        allDevices = allDevices.filter(device => {
            const key = String(device?.id || '').trim();
            if (!key) return true;
            if (seenDeviceIds.has(key)) return false;
            seenDeviceIds.add(key);
            return true;
        });

        // Enrich devices with matching customer names from Billing DB
        allDevices = enrichDevicesWithCustomerNames(allDevices);

        if (searchQuery) {
            const qLower = searchQuery.toLowerCase();
            allDevices = allDevices.filter(d => 
                String(d.sn || '').toLowerCase().includes(qLower) ||
                String(d.id || '').toLowerCase().includes(qLower) ||
                String(d.customer_name || '').toLowerCase().includes(qLower) ||
                String(d.pppoe_user || '').toLowerCase().includes(qLower) ||
                String(d.ip || d.pppoe_ip || '').toLowerCase().includes(qLower) ||
                String(d.tr069_ip || '').toLowerCase().includes(qLower)
            );
        }

        let pppoeProfiles = [];
        try {
            // Get routerId dari query parameter jika ada (untuk multi-router support)
            const selectedRouterId = req.query.router_id ? Number(req.query.router_id) : null;
            pppoeProfiles = await mikrotikSvc.getPppoeProfiles(selectedRouterId);
        } catch (e) {
            console.error('Failed to load PPPoE profiles from MikroTik:', e.message);
        }

        res.render('admin/acs', {
            user: req.session,
            devices: allDevices,
            acsServers: activeServers,
            selectedAcsId,
            searchQuery,
            pppoeProfiles,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        console.error('ACS page error:', err);
        res.render('admin/acs', { user: req.session, devices: [], acsServers: [], selectedAcsId: null, searchQuery: null, pppoeProfiles: [], currentPage: 'acs_pro' });
    }
});

router.get('/search', async (req, res, next) => {
    req.url = '/';
    return router.handle(req, res, next);
});

router.get('/device/:deviceId', async (req, res) => {
    try {
        const acsId = String(req.query.acsId || req.query.acs || '').trim() || null;
        const deviceToken = String(req.params.deviceId || '');

        const legacyData = await customerDevice.getCustomerDeviceData(deviceToken);
        if (legacyData && legacyData.phone) {
            const isOnline = String(legacyData.status || '').toLowerCase() === 'online';
            let clients = Array.isArray(legacyData.connectedUsers) ? [...legacyData.connectedUsers] : [];

            // Merge the Host table and Wi-Fi AssociatedDevice table for both built-in
            // and external ACS. Some ONUs expose AssociatedDevice without Hosts.Host.
            try {
                const deviceRef = await customerDevice.fetchFullDevice(deviceToken).catch(() => null);
                const serverId = acsId || deviceRef?._acs_server_id || (isBuiltinAcsEnabled() ? 'builtin' : null);
                const clientServers = getACSServers(serverId || 'all');
                const clientServer = clientServers[0] || getACSServers()[0];
                if (clientServer) {
                    const rawClients = await getLANHosts(String(deviceRef?._id || deviceToken), clientServer);
                    const byMac = new Map();
                    for (const c of clients) {
                        const key = String(c.mac || c.ip || '').trim().toLowerCase();
                        if (key && key !== '-') byMac.set(key, c);
                    }
                    for (const c of (Array.isArray(rawClients) ? rawClients : [])) {
                        const key = String(c.mac || c.ip || '').trim().toLowerCase();
                        if (!key || key === '-') continue;
                        const mapped = {
                            hostname: c.hostname || 'Unknown',
                            ip: c.ip || '-',
                            mac: c.mac || '-',
                            iface: c.isWiFi ? `WiFi ${c.band || ''}`.trim() : 'LAN',
                            status: c.active ? 'Online' : 'Offline',
                            rssi: typeof c.rssi === 'number' ? c.rssi : null
                        };
                        byMac.set(key, { ...(byMac.get(key) || {}), ...mapped });
                    }
                    clients = Array.from(byMac.values());
                }
            } catch (clientErr) {
                console.warn('[ACS] Failed to merge ACS client list:', clientErr.message);
            }

            let clientsPending = false;
            if (clients.length === 0 && isBuiltinAcsEnabled()) {
                try {
                    const sync = await customerDevice.requestRefresh(deviceToken, {
                        type: 'admin',
                        name: String(req.session?.username || 'Admin'),
                        ip: req.ip,
                        userAgent: req.get('user-agent')
                    });
                    clientsPending = Boolean(sync?.ok && (
                        (Array.isArray(sync.refreshObjects) && sync.refreshObjects.some(p => String(p).includes('AssociatedDevice') || String(p).includes('Hosts.Host'))) ||
                        /masih berjalan/i.test(String(sync.message || ''))
                    ));
                } catch (_) {}
            }

            return res.render('admin/acs_device', {
                user: req.session,
                device: legacyData,
                clients,
                clientsPending,
                isOnline,
                acsId: acsId || (isBuiltinAcsEnabled() ? 'builtin' : 'legacy'),
                acsName: isBuiltinAcsEnabled() ? 'Built-in ACS' : 'Default ACS',
                currentPage: 'acs_pro'
            });
        }

        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).send('ACS Server not found');

        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = deviceToken;

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_lastInform,_deviceId,_registered,_ip,_tags,_events,VirtualParameters,InternetGatewayDevice,Device'
            }
        });

        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).send('Device not found');

        let pppoeUser = extractPppoeUser(deviceData);
        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());
        const activePppoeSession = pppoeUser && pppoeUser !== '-' ? activeSessionsMap.get(pppoeUser.toLowerCase()) : null;

        const lastInform = deviceData._lastInform;
        const isOnline = (lastInform && (Date.now() - new Date(lastInform).getTime() < 900000)) ||
                         (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));

        // Fallbacks for detail page using the same logic as listing
        let rxPower = extractRxPower(deviceData);
        let txPower = extractTxPower(deviceData);
        const deviceMetrics = extractDeviceMetrics(deviceData);

        const customerName = getNestedValue(deviceData, 'VirtualParameters.CustomerName') || 
                            getNestedValue(deviceData, 'VirtualParameters.customer_name') || 
                            '-';

        let ip = String(activePppoeSession?.ip || extractPppoeIp(deviceData) || '-');

        const rawClients = await getLANHosts(deviceData._id, server);
        const clients = (Array.isArray(rawClients) ? rawClients : []).map((c) => ({
            hostname: c.hostname || 'Unknown',
            ip: c.ip || '-',
            mac: c.mac || '-',
            iface: c.isWiFi ? `WiFi ${c.band || ''}`.trim() : 'LAN',
            status: c.active ? 'Online' : 'Offline',
            rssi: typeof c.rssi === 'number' ? c.rssi : null
        }));

        res.render('admin/acs_device', {
            user: req.session,
            device: {
                phone: deviceData._id,
                serialNumber: deviceData._deviceId?._SerialNumber || deviceData._id,
                model: deviceData._deviceId?._ProductClass || '-',
                softwareVersion: extractSoftwareVersion(deviceData),
                status: isOnline ? 'Online' : 'Offline',
                lastInform: lastInform || null,
                rxPower: rxPower,
                txPower: txPower,
                memoryTotal: deviceMetrics.memoryTotal,
                memoryFree: deviceMetrics.memoryFree,
                cpuUsage: deviceMetrics.cpuUsage,
                trafficSent: deviceMetrics.trafficSent,
                trafficReceived: deviceMetrics.trafficReceived,
                pppoeIP: ip,
                tr069IP: deviceData._ip || '-',
                pppoeUsername: pppoeUser,
                pppoeUptime: extractPppoeUptime(deviceData),
                ssid: extractSsid(deviceData),
                uptime: extractUptime(deviceData)
            },
            clients,
            isOnline,
            acsId: server.id,
            acsName: server.name,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /admin/acs/api/servers
router.post('/api/servers', requireAdmin, async (req, res) => {
    const { name, url, username, password, location } = req.body;
    try {
        db.prepare(
            'INSERT INTO genieacs_servers (name, url, username, password, location) VALUES (?, ?, ?, ?, ?)'
        ).run(name, url, username || null, password || null, location || '');
        res.json({ success: true, message: 'ACS server added' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/legacy (Default ACS)
router.put('/api/servers/legacy', requireAdmin, express.json(), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        if (!url) return res.status(400).json({ success: false, message: 'URL wajib diisi' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'URL harus diawali http:// atau https://' });

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);
        const usernameInput = String(req.body?.username || '').trim();
        const passwordInput = String(req.body?.password || '');

        const currentSettings = getSettings();
        currentSettings.genieacs_url = url;

        if (clearUsername) currentSettings.genieacs_username = '';
        else if (usernameInput) currentSettings.genieacs_username = usernameInput;

        if (clearPassword) currentSettings.genieacs_password = '';
        else if (String(passwordInput || '').trim()) currentSettings.genieacs_password = String(passwordInput || '');

        const settingsPath = path.join(__dirname, '../settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

        res.json({ success: true, message: 'Default ACS berhasil diperbarui.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/:id
router.put('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ success: false, message: 'Invalid server id' });

        const name = String(req.body?.name || '').trim();
        const url = String(req.body?.url || '').trim();
        if (!name || !url) return res.status(400).json({ success: false, message: 'Name and URL are required' });

        const existing = db.prepare('SELECT id, password FROM genieacs_servers WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ success: false, message: 'ACS server not found' });

        const usernameRaw = req.body?.username;
        const passwordRaw = req.body?.password;
        const location = String(req.body?.location || '');

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);

        const username = clearUsername ? null : (String(usernameRaw || '').trim() || null);

        let password = existing.password || null;
        if (clearPassword) password = null;
        else if (String(passwordRaw || '').trim()) password = String(passwordRaw || '');

        db.prepare(
            'UPDATE genieacs_servers SET name = ?, url = ?, username = ?, password = ?, location = ? WHERE id = ?'
        ).run(name, url, username, password, location, id);

        res.json({ success: true, message: 'ACS server updated' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/servers/:id
router.delete('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        db.prepare('DELETE FROM genieacs_servers WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'ACS server deleted' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/device/:deviceId
router.delete('/api/device/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.delete(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(server)
        );
        res.json({ success: true, message: 'Device deleted' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/remote-enable/:deviceId
router.post('/api/remote-enable/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { 
                name: 'setParameterValues',
                parameterValues: [['InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable', true, 'xsd:boolean']]
            },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Remote WAN enabled' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/reboot/:deviceId
// Uses the standard CWMP Reboot RPC. Never queue a delayed reboot for an offline/stale CPE.
router.post('/api/reboot/:deviceId', requireAdmin, async (req, res) => {
    try {
        const acsId = String(req.body?.acsId || '').trim() || null;
        const servers = getACSServers(acsId);
        if (servers.length === 0) {
            return res.status(404).json({ success: false, message: 'Server ACS tidak ditemukan.' });
        }

        const server = servers[0];
        const deviceId = String(req.params.deviceId || '').trim();
        if (!deviceId || deviceId.length > 255) {
            return res.status(400).json({ success: false, message: 'ID perangkat tidak valid.' });
        }

        const baseUrl = normalizeUrl(server.url);
        const devicePath = `/devices/${encodeURIComponent(deviceId)}`;
        const tasksPath = `${devicePath}/tasks`;
        const config = { ...getAxiosConfig(server), timeout: 15000 };
        const deviceResponse = await axios.get(`${baseUrl}${devicePath}`, config);
        const device = deviceResponse?.data;
        if (!device || device._id !== deviceId) {
            return res.status(404).json({ success: false, message: 'ONT tidak ditemukan pada server ACS yang dipilih.' });
        }

        const lastInform = device._lastInform || device.Events?.Inform || null;
        const informTime = Date.parse(lastInform || '');
        const ageMs = Date.now() - informTime;
        if (!Number.isFinite(informTime) || ageMs < 0 || ageMs > 15 * 60 * 1000) {
            return res.status(409).json({
                success: false,
                code: 'ONT_OFFLINE_OR_STALE',
                lastInform,
                message: 'ONT tidak mengirim Inform terbaru dalam 15 menit. Reboot tidak dimasukkan antrean agar modem tidak reboot terlambat saat tersambung kembali.'
            });
        }

        if (server.id === 'builtin' || server.url === 'local') {
            const pending = db.prepare(
                "SELECT id FROM acs_tasks WHERE device_id=? AND name='reboot' AND status IN ('pending','in_progress') ORDER BY id DESC LIMIT 1"
            ).get(deviceId);
            if (pending) {
                return res.status(409).json({
                    success: false,
                    code: 'REBOOT_ALREADY_PENDING',
                    taskId: Number(pending.id),
                    message: 'Perintah reboot sebelumnya masih diproses. Jangan kirim reboot kedua.'
                });
            }
        }

        let taskId = null;
        if (server.id === 'builtin' || server.url === 'local') {
            // Queue locally, then synchronously verify the Connection Request.
            // If CR fails (e.g. Digest 401), fail the task so it cannot reboot later
            // on an unrelated periodic Inform.
            const now = new Date().toISOString();
            const created = db.prepare(
                "INSERT INTO acs_tasks (device_id,name,payload,status,created_at,updated_at) VALUES (?,'reboot',?,'pending',?,?)"
            ).run(deviceId, JSON.stringify({ name: 'reboot', timestamp: now }), now, now);
            taskId = Number(created.lastInsertRowid);

            let triggerResult = null;
            try {
                triggerResult = await require('../services/acsServerService').triggerConnectionRequest(deviceId);
            } catch (triggerError) {
                triggerResult = { success: false, message: triggerError.message };
            }
            if (!triggerResult || triggerResult.success !== true) {
                const reason = String(triggerResult?.message || 'Connection Request gagal.').slice(0, 220);
                const failedAt = new Date().toISOString();
                db.prepare("UPDATE acs_tasks SET status='failed',result=?,updated_at=? WHERE id=? AND status='pending'")
                    .run(JSON.stringify({ message: 'Reboot dibatalkan karena Connection Request gagal: ' + reason }), failedAt, taskId);
                return res.status(502).json({
                    success: false,
                    code: 'ACS_CONNECTION_REQUEST_FAILED',
                    taskId,
                    message: 'ACS gagal menghubungi ONT. Task reboot dibatalkan agar tidak berjalan terlambat. Detail: ' + reason
                });
            }
        } else {
            const response = await axios.post(
                `${baseUrl}${tasksPath}`,
                { name: 'reboot' },
                config
            );
            taskId = response?.data?._id || response?.data?.id || null;
        }

        if (!taskId) {
            return res.status(502).json({
                success: false,
                code: 'REBOOT_TASK_ID_MISSING',
                message: 'ACS tidak mengembalikan ID task reboot; status perintah tidak dapat dipastikan.'
            });
        }

        return res.status(202).json({
            success: true,
            pending: true,
            taskId: String(taskId),
            acsServerId: server.id,
            message: 'Perintah Reboot CWMP diterima ACS dan koneksi ke ONT berhasil dipicu. Menunggu respons ONT; jangan tekan Reboot berulang kali.'
        });
    } catch (e) {
        const detail = String(e.response?.data?.message || e.response?.data || e.message || 'Unknown error').slice(0, 220);
        return res.status(502).json({ success: false, message: 'Gagal mengirim Reboot ke ACS: ' + detail });
    }
});

// Built-in ACS task status, used by the ACS page to confirm the CWMP RebootResponse.
router.get('/api/reboot/:deviceId/status/:taskId', requireAdmin, (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '').trim();
        const taskId = Number(req.params.taskId);
        if (!deviceId || !Number.isSafeInteger(taskId) || taskId <= 0) {
            return res.status(400).json({ success: false, done: true, message: 'ID task reboot tidak valid.' });
        }
        const task = db.prepare(
            'SELECT id,name,status,result FROM acs_tasks WHERE id=? AND device_id=?'
        ).get(taskId, deviceId);
        if (!task || task.name !== 'reboot') {
            return res.status(404).json({ success: false, done: true, message: 'Task reboot tidak ditemukan.' });
        }
        if (task.status === 'pending' || task.status === 'in_progress') {
            return res.json({ success: true, pending: true, done: false, taskId });
        }
        if (task.status === 'completed') {
            let result = {};
            try { result = JSON.parse(task.result || '{}'); } catch (_) {}
            const accepted = String(result.status || '').toLowerCase() === 'ok';
            return res.json({
                success: accepted,
                pending: false,
                done: true,
                taskId,
                message: accepted
                    ? 'ONT sudah mengirim RebootResponse ke ACS.'
                    : 'Task reboot selesai, tetapi respons ONT tidak menyatakan sukses.'
            });
        }
        return res.json({
            success: false,
            pending: false,
            done: true,
            taskId,
            message: task.status === 'failed'
                ? 'ONT menolak atau gagal menjalankan Reboot CWMP.'
                : 'Task reboot berstatus ' + String(task.status || 'tidak diketahui') + '.'
        });
    } catch (error) {
        return res.status(500).json({ success: false, done: true, message: 'Gagal membaca status task reboot ACS.' });
    }
});

// POST /admin/acs/api/refresh/:deviceId
router.post('/api/refresh/:deviceId', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const result = await customerDevice.requestRefresh(deviceId, {
            type: 'admin',
            id: req.session?.adminId || null,
            name: req.session?.username || req.session?.name || 'Admin',
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });
        res.json({ success: !!result.ok, message: result.message });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/refresh
router.post('/api/bulk/refresh', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const result = await customerDevice.requestRefresh(deviceId, {
                type: 'admin',
                id: req.session?.adminId || null,
                name: req.session?.username || req.session?.name || 'Admin',
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            return { id: deviceId, success: !!result.ok, message: result.message };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil mengirim perintah summon untuk ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/delete
router.post('/api/bulk/delete', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const acsId = String(d.acsId || '');
            const servers = getACSServers(acsId);
            if (servers.length === 0) return { id: deviceId, success: false, message: 'ACS tidak ditemukan' };
            const server = servers[0];
            const baseUrl = normalizeUrl(server.url);
            
            await axios.delete(
                `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
                getAxiosConfig(server)
            );
            return { id: deviceId, success: true };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil menghapus ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// POST /admin/acs/api/sync/all
router.post('/api/sync/all', requireAdmin, async (req, res) => {
    try {
        const servers = getACSServers();
        if (servers.length === 0) return res.json({ success: true, message: 'No servers to sync' });
        
        let total = 0;
        for (const s of servers) {
            const result = await fetchDevicesFromACS(s, [], {});
            total += result.devices.length;
            db.prepare('UPDATE genieacs_servers SET device_count = ?, last_sync = (NOW_LOCAL()) WHERE id = ?').run(result.devices.length, s.id);
        }
        res.json({ success: true, message: `Sync complete. Total ${total} devices.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /api/clients/:deviceId
router.get('/api/clients/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false });

        const hosts = await getLANHosts(String(deviceId || ''), servers[0]);
        let syncing = false;
        if (hosts.length === 0 && isBuiltinAcsEnabled()) {
            const refresh = await customerDevice.requestRefresh(String(deviceId || ''), {
                type: 'admin',
                name: String(req.session?.username || 'Admin'),
                ip: req.ip,
                userAgent: req.get('user-agent')
            }).catch(() => null);
            syncing = Boolean(refresh?.ok && (
                (Array.isArray(refresh.refreshObjects) && refresh.refreshObjects.some(p => String(p).includes('AssociatedDevice') || String(p).includes('Hosts.Host'))) ||
                /masih berjalan/i.test(String(refresh.message || ''))
            ));
        }
        res.json({
            success: true,
            data: hosts,
            syncing,
            message: syncing ? 'Data klien sedang dijupuk saka ONU liwat ACS; muat ulang sawise ONU nanggapi.' : undefined
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /admin/acs/api/wifi-settings/:deviceId
router.get('/api/wifi-settings/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).json({ success: false, message: 'ACS Server not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        
        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration,Device.WiFi.SSID,Device.WiFi.AccessPoint'
            }
        });
        
        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).json({ success: false, message: 'Device not found' });
        
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        
        // Return all SSID indices (1 to 8) that exist on the ONU
        for (let i = 1; i <= 8; i++) {
            if (wlanConfig[String(i)]) {
                bands.push({
                    index: String(i),
                    ssid: getNestedValue(wlanConfig[String(i)], 'SSID') || `SSID ${i}`,
                    name: i <= 4 ? `Wi-Fi 2.4GHz (SSID ${i})` : `Wi-Fi 5GHz (SSID ${i})`
                });
            }
        }

        // TR-181-only devices store SSIDs under Device.WiFi.SSID instead.
        const tr181Ssids = deviceData.Device?.WiFi?.SSID || {};
        for (let i = 1; i <= 16; i++) {
            const item = tr181Ssids[String(i)];
            const ssid = item ? getNestedValue(item, 'SSID') : null;
            if (ssid && !bands.some(b => b.ssid === ssid)) {
                bands.push({ index: `tr181-${i}`, ssid, name: `WiFi ${i}` });
            }
        }

        res.json({ success: true, bands });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// WAN management for an existing TR-098 WAN object. Every edit/delete re-reads
// the selected object from the selected ACS server; no new WAN object is created.
function unwrapWanValue(value) {
    return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value') ? value._value : value;
}
function wanValueText(value) {
    const v = unwrapWanValue(value);
    return v == null ? '' : String(v).trim();
}
function wanValueEnabled(value) {
    return value === true || value === 1 || /^(1|true|enabled|yes)$/i.test(String(unwrapWanValue(value) || '').trim());
}
function wanNumericKeys(obj) {
    return Object.keys(obj || {}).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
}
function flattenWanConnections(deviceData) {
    const rows = [];
    const wanDevices = deviceData && deviceData.InternetGatewayDevice && deviceData.InternetGatewayDevice.WANDevice || {};
    const vlanCandidates = ['VLANID', 'X_FH_VLANID', 'X_HW_VLAN', 'X_HW_VLANID', 'X_ZTE_VLAN'];
    for (const wdId of wanNumericKeys(wanDevices)) {
        const containers = (wanDevices[wdId] || {}).WANConnectionDevice || {};
        for (const connId of wanNumericKeys(containers)) {
            const conn = containers[connId] || {};
            const connBase = 'InternetGatewayDevice.WANDevice.' + wdId + '.WANConnectionDevice.' + connId + '.';
            const link = conn.X_FH_WANGponLinkConfig || {};
            for (const type of ['WANPPPConnection', 'WANIPConnection']) {
                const table = conn[type] || {};
                for (const instId of wanNumericKeys(table)) {
                    const obj = table[instId] || {};
                    const path = connBase + type + '.' + instId + '.';
                    const hasEnable = Object.prototype.hasOwnProperty.call(obj, 'Enable');
                    const enabled = hasEnable && wanValueEnabled(obj.Enable);
                    const connectionStatus = wanValueText(obj.ConnectionStatus);
                    const ipAddress = wanValueText(obj.ExternalIPAddress);
                    const validIp = Boolean(ipAddress && !['0.0.0.0', '::', '::0', '-', 'none'].includes(ipAddress.toLowerCase()));
                    const active = /^(connected|up|online)$/i.test(connectionStatus) || validIp;
                    const fallbackStatus = hasEnable ? (enabled ? 'Enabled' : 'Disabled') : (validIp ? 'IP terisi; status Enable belum terbaca' : 'Status belum terbaca');
                    const vlanKeys = vlanCandidates.filter(key => Object.prototype.hasOwnProperty.call(obj, key));
                    const linkVlanKey = Object.prototype.hasOwnProperty.call(link, 'VLANID') ? 'VLANID' : null;
                    const primaryVlanKey = vlanKeys.find(key => key === 'VLANID') || vlanKeys[0] || null;
                    const vlanValue = primaryVlanKey ? wanValueText(obj[primaryVlanKey]) : (linkVlanKey ? wanValueText(link[linkVlanKey]) : '');
                    rows.push({
                        path, type, typeLabel: type === 'WANPPPConnection' ? 'PPPoE' : 'WAN IP',
                        wanDeviceInstance: wdId, connectionInstance: connId, instance: instId,
                        name: wanValueText(obj.Name) || ((type === 'WANPPPConnection' ? 'PPPoE ' : 'WAN IP ') + wdId + '/' + connId + '/' + instId),
                        enabled, connectionStatus: connectionStatus || fallbackStatus,
                        ipAddress, username: wanValueText(obj.Username), connectionType: wanValueText(obj.ConnectionType),
                        natEnabled: wanValueEnabled(obj.NATEnabled), vlanId: vlanValue, vlanSupported: Boolean(primaryVlanKey || linkVlanKey),
                        vlanKeys, linkVlanKey,
                        hasEnable,
                        hasName: Object.prototype.hasOwnProperty.call(obj, 'Name'),
                        hasConnectionType: Object.prototype.hasOwnProperty.call(obj, 'ConnectionType'),
                        hasUsername: Object.prototype.hasOwnProperty.call(obj, 'Username'),
                        hasNatEnabled: Object.prototype.hasOwnProperty.call(obj, 'NATEnabled'),
                        isActive: active, _object: obj, _connection: conn
                    });
                }
            }
        }
    }
    return rows;
}
async function loadWanManagementContext(deviceId, acsId) {
    const servers = getACSServers(String(acsId || '').trim() || null);
    if (!servers.length) throw Object.assign(new Error('ACS server tidak ditemukan atau tidak aktif.'), { statusCode: 404 });
    const server = servers[0];
    const baseUrl = normalizeUrl(server.url);
    const response = await axios.get(baseUrl + '/devices', {
        ...getAxiosConfig(server), params: { query: JSON.stringify({ _id: String(deviceId || '') }) }
    });
    const device = Array.isArray(response.data) ? response.data[0] : null;
    if (!device) throw Object.assign(new Error('Perangkat tidak ditemukan pada ACS yang dipilih.'), { statusCode: 404 });
    const serial = String(
        (device._deviceId && (device._deviceId._SerialNumber || device._deviceId.SerialNumber)) ||
        (device.DeviceID && (device.DeviceID.SerialNumber && device.DeviceID.SerialNumber._value || device.DeviceID.SerialNumber)) ||
        (device.InternetGatewayDevice && device.InternetGatewayDevice.DeviceInfo && (device.InternetGatewayDevice.DeviceInfo.SerialNumber && device.InternetGatewayDevice.DeviceInfo.SerialNumber._value || device.InternetGatewayDevice.DeviceInfo.SerialNumber)) || ''
    ).trim();
    return { server, baseUrl, config: getAxiosConfig(server), device, serial: serial || String(deviceId) };
}
function validateWanObjectPath(value) {
    const path = String(value || '').trim();
    if (!/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.(?:WANPPPConnection|WANIPConnection)\.\d+\.$/.test(path)) {
        throw Object.assign(new Error('Path WAN tidak valid. Pilih interface dari daftar WAN yang dibaca ACS.'), { statusCode: 400 });
    }
    return path;
}
function getRowForWanPath(device, path) {
    return flattenWanConnections(device).find(row => row.path === path) || null;
}

function reconcileWanCacheForPortal(deviceId, device) {
    let removed = 0;
    const wanDevices = device && device.InternetGatewayDevice && device.InternetGatewayDevice.WANDevice || {};
    for (const wdId of wanNumericKeys(wanDevices)) {
        const containers = (wanDevices[wdId] || {}).WANConnectionDevice || {};
        for (const connId of wanNumericKeys(containers)) {
            const parent = 'InternetGatewayDevice.WANDevice.' + wdId + '.WANConnectionDevice.' + connId + '.';
            for (const type of ['WANPPPConnection', 'WANIPConnection']) {
                const tablePath = parent + type;
                const enumeration = latestBuiltinWanEnumerationForTable(deviceId, tablePath);
                if (enumeration) {
                    removed += pruneBuiltinWanCacheWithEnumeration(deviceId, tablePath, enumeration.names);
                }
            }
        }
    }
    return removed;
}

router.get('/api/wan-connections/:deviceId', requireAdmin, async (req, res) => {
    try {
        let ctx = await loadWanManagementContext(req.params.deviceId, req.query.acsId);
        if (String(ctx.server.id) === 'builtin') {
            const removed = reconcileWanCacheForPortal(String(req.params.deviceId), ctx.device);
            if (removed) ctx = await loadWanManagementContext(req.params.deviceId, req.query.acsId);
        }
        const rows = flattenWanConnections(ctx.device);
        return res.json({
            success: true, deviceId: String(req.params.deviceId), serialNumber: ctx.serial,
            acsId: String(ctx.server.id || ''), acsName: String(ctx.server.name || ctx.server.location || 'ACS'),
            lastInform: ctx.device._lastInform || null, count: rows.length,
            rows: rows.map(({ _object, _connection, ...row }) => row)
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: String(error.message || error) });
    }
});

router.post('/api/wan-connections/:deviceId/refresh', requireAdmin, async (req, res) => {
    try {
        const ctx = await loadWanManagementContext(req.params.deviceId, req.body && req.body.acsId);
        const wanDevices = ctx.device && ctx.device.InternetGatewayDevice && ctx.device.InternetGatewayDevice.WANDevice || {};
        const indices = wanNumericKeys(wanDevices).length ? wanNumericKeys(wanDevices) : ['1'];
        const tasks = [];
        for (const wanDeviceId of indices) {
            const response = await axios.post(ctx.baseUrl + '/devices/' + encodeURIComponent(String(req.params.deviceId)) + '/tasks', {
                name: 'getParameterNames',
                objectName: 'InternetGatewayDevice.WANDevice.' + wanDeviceId + '.WANConnectionDevice',
                nextLevel: true, discoverWan: true, timestamp: new Date().toISOString()
            }, ctx.config);
            tasks.push(response.data && response.data._id || null);
        }
        return res.json({ success: true, taskIds: tasks, message: 'Permintaan baca ulang status dan parameter WAN dikirim ke ACS. Data berubah setelah ONT merespons.' });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: String(error.message || error) });
    }
});

router.post('/api/wan-connections/:deviceId/edit', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const ctx = await loadWanManagementContext(deviceId, req.body && req.body.acsId);
        const objectPath = validateWanObjectPath(req.body && req.body.objectPath);
        const row = getRowForWanPath(ctx.device, objectPath);
        if (!row) return res.status(404).json({ success: false, message: 'Interface WAN pilihan tidak ditemukan pada data ACS terbaru. Muat ulang daftar WAN.' });
        const values = [];
        const add = (leaf, value, type) => values.push([objectPath + leaf, value, type]);
        if (row.hasEnable) add('Enable', !!(req.body && req.body.enable), 'xsd:boolean');
        const name = String(req.body && req.body.name || '').trim();
        if (row.hasName && name) {
            if (name.length > 64) return res.status(400).json({ success: false, message: 'Nama WAN maksimal 64 karakter.' });
            add('Name', name, 'xsd:string');
        }
        if (row.hasConnectionType) {
            const connectionType = String(req.body && req.body.connectionType || '').trim();
            const allowed = row.type === 'WANPPPConnection' ? ['PPPoE_Routed', 'IP_Routed', 'Bridged'] : ['IP_Routed', 'Bridged', 'IP_Bridged'];
            if (!allowed.includes(connectionType)) return res.status(400).json({ success: false, message: 'Connection Type tidak valid untuk jenis interface WAN ini.' });
            add('ConnectionType', connectionType, 'xsd:string');
        }
        if (row.type === 'WANPPPConnection') {
            const username = String(req.body && req.body.username || '').trim();
            if (!username) return res.status(400).json({ success: false, message: 'Username PPPoE tidak boleh kosong.' });
            if (username.length > 128) return res.status(400).json({ success: false, message: 'Username PPPoE terlalu panjang.' });
            if (row.hasUsername) add('Username', username, 'xsd:string');
            const password = String(req.body && req.body.password || '');
            if (password) {
                if (password.length > 256) return res.status(400).json({ success: false, message: 'Password PPPoE terlalu panjang.' });
                add('Password', password, 'xsd:string');
            }
        }
        if (row.hasNatEnabled) add('NATEnabled', !!(req.body && req.body.natEnabled), 'xsd:boolean');
        const vlanText = String(req.body && req.body.vlanId != null ? req.body.vlanId : '').trim();
        if (vlanText) {
            const vlan = Number(vlanText);
            if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return res.status(400).json({ success: false, message: 'VLAN harus bilangan bulat 1–4094.' });
            if (!row.vlanSupported) return res.status(400).json({ success: false, message: 'Model/firmware ini tidak melaporkan parameter VLAN yang bisa diedit lewat ACS.' });
            for (const key of row.vlanKeys || []) add(key, vlan, 'xsd:unsignedInt');
            if (row.linkVlanKey) {
                const prefix = objectPath.replace(/(?:WANPPPConnection|WANIPConnection)\.\d+\.$/, '');
                values.push([prefix + 'X_FH_WANGponLinkConfig.' + row.linkVlanKey, vlan, 'xsd:unsignedInt']);
            }
        }
        if (!values.length) return res.status(400).json({ success: false, message: 'Tidak ada parameter WAN yang dapat diubah.' });
        const task = await axios.post(ctx.baseUrl + '/devices/' + encodeURIComponent(deviceId) + '/tasks', {
            name: 'setParameterValues', parameterValues: values, timestamp: new Date().toISOString()
        }, ctx.config);
        return res.json({ success: true, queued: true, taskId: task.data && task.data._id || null,
            message: 'Perubahan WAN ' + row.wanDeviceInstance + '/' + row.connectionInstance + '/' + row.instance + ' dikirim ke ACS. Hasil akhir menunggu ONT merespons.' });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: String(error.message || error) });
    }
});

function normalizedWanPath(value) {
    return String(value || '').trim().replace(/\.+$/, '');
}

function latestBuiltinWanEnumerationForTable(deviceId, tablePath) {
    const root = normalizedWanPath(tablePath);
    const rows = db.prepare(
        "SELECT id, payload, status, result, updated_at FROM acs_tasks " +
        "WHERE device_id = ? AND name = 'getParameterNames' AND status = 'completed' " +
        "ORDER BY id DESC LIMIT 250"
    ).all(deviceId);
    for (const row of rows) {
        let payload = {};
        let result = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
        const queriedPath = normalizedWanPath(payload.objectName || payload.object || '');
        if (queriedPath !== root || !(payload.discoverWan === true || payload.discoverWan === 'true')) continue;
        try { result = JSON.parse(row.result || '{}'); } catch (_) {}
        return {
            taskId: Number(row.id), tablePath: root,
            names: Array.isArray(result.names) ? result.names : [],
            updatedAt: row.updated_at || null
        };
    }
    return null;
}

function latestBuiltinWanTableEnumeration(deviceId, objectPath) {
    const tablePath = normalizedWanPath(objectPath).replace(/\.\d+$/, '');
    const enumeration = latestBuiltinWanEnumerationForTable(deviceId, tablePath);
    if (!enumeration) return null;
    const wanted = normalizedWanPath(objectPath);
    return { ...enumeration, exists: enumeration.names.some(name => normalizedWanPath(name) === wanted) };
}

function pruneBuiltinWanCacheWithEnumeration(deviceId, tablePath, names) {
    const root = normalizedWanPath(tablePath);
    const prefix = root + '.';
    const actual = new Set();
    for (const rawName of Array.isArray(names) ? names : []) {
        const child = String(rawName || '').trim();
        if (!child.endsWith('.')) continue;
        const normalized = normalizedWanPath(child);
        if (!normalized.startsWith(prefix)) continue;
        const suffix = normalized.slice(prefix.length);
        if (/^\d+$/.test(suffix)) actual.add(suffix);
    }
    const stored = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    if (!stored) return 0;
    let params = {};
    try { params = JSON.parse(stored.params || '{}'); } catch (_) {}
    let removed = 0;
    for (const key of Object.keys(params)) {
        if (!key.startsWith(prefix)) continue;
        const match = key.slice(prefix.length).match(/^(\d+)(?:\.|$)/);
        if (match && !actual.has(match[1])) {
            delete params[key];
            removed++;
        }
    }
    if (removed) {
        db.prepare('UPDATE acs_devices SET params = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(params), new Date().toISOString(), deviceId);
    }
    return removed;
}

router.post('/api/wan-connections/:deviceId/delete', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const ctx = await loadWanManagementContext(deviceId, req.body && req.body.acsId);
        const objectPath = validateWanObjectPath(req.body && req.body.objectPath);
        const row = getRowForWanPath(ctx.device, objectPath);
        if (!row) return res.status(404).json({ success: false, message: 'Interface WAN pilihan tidak ditemukan pada data ACS terbaru. Muat ulang daftar WAN.' });
        if (String(req.body && req.body.confirmSerial || '').trim() !== ctx.serial) return res.status(400).json({ success: false, message: 'Konfirmasi SN tidak cocok. WAN tidak dihapus.' });
        if (row.isActive && !(req.body && req.body.confirmActive === true)) return res.status(409).json({ success: false, activeConfirmationRequired: true, message: 'WAN ini terdeteksi aktif. Konfirmasi tambahan wajib karena penghapusan dapat memutus internet.' });

        if (String(ctx.server.id) === 'builtin') {
            const enumeration = latestBuiltinWanTableEnumeration(deviceId, objectPath);
            if (enumeration && !enumeration.exists) {
                const removed = pruneBuiltinWanCacheWithEnumeration(deviceId, enumeration.tablePath, enumeration.names);
                return res.status(409).json({
                    success: false, stale: true,
                    message: 'WAN ini sudah tidak ada di daftar instance yang dilaporkan modem (hasil baca ACS terbaru). Cache WAN lama dibersihkan' +
                        (removed ? ' (' + removed + ' parameter basi dihapus)' : '') +
                        '. Muat ulang daftar sebelum memilih WAN yang masih ada.'
                });
            }

            const requestUrl = wanValueText(ctx.device.InternetGatewayDevice?.ManagementServer?.ConnectionRequestURL)
                || wanValueText(ctx.device.Device?.ManagementServer?.ConnectionRequestURL);
            let requestHost = '';
            try { requestHost = new URL(requestUrl).hostname; } catch (_) {}
            const deviceIp = String(ctx.device._ip || '');
            const looksLikeManagementWan = row.type === 'WANIPConnection' && row.ipAddress &&
                ((requestHost && row.ipAddress === requestHost) || (deviceIp && row.ipAddress === deviceIp)) &&
                /TR.?069|management|mgmt/i.test(String(row.name || ''));
            if (looksLikeManagementWan) {
                return res.status(409).json({
                    success: false, protectedManagementWan: true,
                    message: 'WAN ini tampak sebagai jalur manajemen TR-069/ACS. Penghapusan diblokir agar koneksi ACS ke modem tidak terputus.'
                });
            }
        }

        const response = await axios.post(ctx.baseUrl + '/devices/' + encodeURIComponent(deviceId) + '/tasks', {
            name: 'deleteObject', objectName: objectPath, timestamp: new Date().toISOString()
        }, ctx.config);
        return res.json({ success: true, queued: true, taskId: response.data && response.data._id || null, wasActive: row.isActive,
            message: 'Permintaan hapus WAN ' + row.wanDeviceInstance + '/' + row.connectionInstance + '/' + row.instance + ' dikirim ke ACS. Penghapusan baru selesai setelah ONT merespons.' });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: String(error.message || error) });
    }
});

router.get('/api/wan-connections/:deviceId/delete-status/:taskId', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const taskId = Number(req.params.taskId);
        const task = Number.isSafeInteger(taskId) && taskId > 0
            ? db.prepare('SELECT id, device_id, name, status, result, payload, updated_at FROM acs_tasks WHERE id = ? AND device_id = ?').get(taskId, deviceId)
            : null;
        if (!task || task.name !== 'deleteObject') {
            return res.status(404).json({ success: false, done: true, state: 'failed', message: 'Status task hapus tidak ditemukan di ACS lokal.' });
        }

        const parseJson = value => { try { return JSON.parse(value || '{}'); } catch (_) { return {}; } };
        const taskPayload = parseJson(task.payload);
        const objectPath = String(taskPayload.objectName || taskPayload.object || '');
        if (task.status === 'failed') {
            const result = parseJson(task.result);
            const detail = String(result.detail || result.faultString || result.message || '');
            const faultCode = (detail.match(/<FaultCode>\s*(\d+)\s*<\/FaultCode>/i) || [])[1] || result.faultCode || '';
            const faultText = (detail.match(/<FaultString>\s*([^<]+)\s*<\/FaultString>/i) || [])[1] || result.faultString || '';
            return res.json({
                success: false, done: true, state: 'failed', taskId,
                faultCode: String(faultCode || ''),
                message: (faultCode ? 'Modem menolak penghapusan (Fault ' + faultCode + '). ' : 'Penghapusan WAN gagal. ') +
                    (faultText || detail || 'ACS menandai task sebagai gagal.')
            });
        }
        if (task.status !== 'completed') {
            return res.json({
                success: true, done: false, state: 'running', taskId,
                message: task.status === 'in_progress'
                    ? 'Perintah penghapusan sedang diproses modem…'
                    : 'Menunggu ONT menghubungi ACS untuk menjalankan perintah hapus…'
            });
        }

        const verification = db.prepare(
            "SELECT id, status, result, payload, updated_at FROM acs_tasks " +
            "WHERE device_id = ? AND name = 'getParameterNames' AND payload LIKE ? ORDER BY id DESC LIMIT 1"
        ).get(deviceId, '%"verifyDeleteTaskId":' + taskId + '%');
        if (!verification) {
            return res.json({ success: true, done: false, state: 'verifying', taskId, message: 'Modem menerima perintah; menunggu pemeriksaan ulang daftar WAN…' });
        }
        if (verification.status === 'failed') {
            const result = parseJson(verification.result);
            return res.json({
                success: false, done: true, state: 'failed', taskId,
                message: 'Perintah hapus diterima, tetapi verifikasi ulang WAN gagal: ' +
                    String(result.faultString || result.message || 'ONT belum dapat mengonfirmasi objek yang hilang.')
            });
        }
        if (verification.status !== 'completed') {
            return res.json({ success: true, done: false, state: 'verifying', taskId, message: 'Memastikan objek WAN benar-benar sudah hilang dari modem…' });
        }

        const verifyPayload = parseJson(verification.payload);
        const verifyResult = parseJson(verification.result);
        const latestNames = Array.isArray(verifyResult.names) ? verifyResult.names : [];
        const normalizedTarget = normalizedWanPath(objectPath);
        const stillExists = latestNames.some(name => normalizedWanPath(name) === normalizedTarget);
        if (stillExists) {
            return res.json({
                success: false, done: true, state: 'failed', taskId,
                message: 'Modem menyelesaikan task, tetapi objek WAN masih muncul pada pemeriksaan ulang. Penghapusan belum terverifikasi; muat ulang daftar dan periksa firmware ONT.'
            });
        }
        return res.json({
            success: true, done: true, state: 'completed', taskId,
            message: 'WAN berhasil dihapus dan ketidakadaan objek sudah dikonfirmasi oleh modem.'
        });
    } catch (error) {
        return res.status(500).json({ success: false, done: true, state: 'failed', message: String(error.message || error) });
    }
});

router.get('/api/add-wan-status/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const workflowId = String(req.query.workflowId || '').trim();
        const rootTaskId = parseInt(req.query.rootTaskId, 10);

        if (!workflowId && !Number.isFinite(rootTaskId)) {
            return res.status(400).json({ success: false, message: 'workflowId atau rootTaskId wajib diisi' });
        }

        let rows = [];
        if (workflowId) {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND payload LIKE ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, `%"workflowId":"${workflowId}"%`);
        } else {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND id >= ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, rootTaskId);
        }

        const tasks = rows.map(row => {
            let payload = {};
            try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
            return {
                id: Number(row.id),
                name: String(row.name || ''),
                status: String(row.status || 'pending'),
                updatedAt: row.updated_at || null,
                label: describeAddWanTask({ name: row.name, payload }),
                payload
            };
        });

        const total = tasks.length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const completed = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const done = total > 0 && pending === 0 && inProgress === 0;
        const summary = failed > 0
            ? `Ada ${failed} task yang gagal dari ${total} task workflow.`
            : done
                ? `Workflow selesai. ${completed}/${total} task selesai.`
                : `Workflow berjalan. ${completed}/${total} task selesai.`;

        return res.json({
            success: true,
            supported: true,
            workflowId: workflowId || null,
            rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null,
            totals: { total, pending, inProgress, completed, failed },
            done,
            hasFailure: failed > 0,
            summary,
            tasks: tasks.map(t => ({
                id: t.id,
                name: t.name,
                status: t.status,
                label: t.label,
                updatedAt: t.updatedAt
            }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /admin/acs/api/add-wan/:deviceId
router.post('/api/add-wan/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const {
            acsId,
            mode,
            vlanId,
            pppoeUser,
            pppoePass,
            pppoeProfile,
            autoCreateMikrotik,
            lanPorts,
            wlanSsids,
            configureWifi,
            wifiSsid24,
            wifiPass24,
            wifiSsid5,
            wifiPass5,
            dhcp
        } = req.body;
        
        // 1. Validasi awal
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['pppoe', 'bridge'].includes(normalizedMode)) {
            return res.json({ success: false, message: 'Mode WAN tidak valid' });
        }

        const parsedVlan = parseInt(vlanId, 10);
        if (isNaN(parsedVlan) || parsedVlan < 1 || parsedVlan > 4094) {
            return res.json({ success: false, message: 'VLAN ID tidak valid (harus 1-4094)' });
        }
        
        const trimmedPppoeUser = String(pppoeUser || '').trim();
        const trimmedPppoePass = String(pppoePass || '').trim();
        if (normalizedMode === 'pppoe' && (!trimmedPppoeUser || !trimmedPppoePass)) {
            return res.json({ success: false, message: 'Username dan password PPPoE wajib diisi untuk mode PPPoE' });
        }
        
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS Server tidak ditemukan' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const config = getAxiosConfig(server);
        
        // 2. Jika Auto-create MikroTik diaktifkan
        if (normalizedMode === 'pppoe' && toBool(autoCreateMikrotik)) {
            try {
                await mikrotikSvc.createPppoeSecret({
                    username: trimmedPppoeUser,
                    password: trimmedPppoePass,
                    profile: pppoeProfile || 'default'
                });
            } catch (mErr) {
                console.error('[AddWAN] Failed to create PPPoE Secret in MikroTik:', mErr.message);
                return res.json({ success: false, message: `Gagal membuat akun PPPoE di MikroTik: ${mErr.message}` });
            }
        }
        
        // 3. Ambil data instansi WANConnectionDevice saat ini untuk menghitung nextInstance
        const getDeviceRes = await axios.get(`${baseUrl}/devices`, {
            ...config,
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_deviceId.Manufacturer,_deviceId._Manufacturer,_deviceId.ProductClass,_deviceId._ProductClass,InternetGatewayDevice.WANDevice.1.WANConnectionDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(getDeviceRes.data) && getDeviceRes.data.length > 0 ? getDeviceRes.data[0] : null;
        if (!deviceData) return res.json({ success: false, message: 'CPE/Device tidak ditemukan di GenieACS' });
        
        const manufacturer = (deviceData._deviceId?._Manufacturer || deviceData._deviceId?.Manufacturer || '').toLowerCase();
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const wanConnObj = deviceData.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
        const isBuiltinServer = String(server.id || '').trim() === 'builtin' || baseUrl === 'local';

        if (isBuiltinServer) {
            const cachedInstanceMaps = getBuiltinCachedInstanceMaps(deviceId);
            const workflowId = `addwan:${deviceId}:${Date.now()}`;
            const effectiveWanDevices = Object.keys(wanConnObj).length ? wanConnObj : cachedInstanceMaps.wan;
            const task = buildBuiltinAddWanWorkflow({
                mode: normalizedMode,
                parsedVlan,
                pppoeUser: trimmedPppoeUser,
                pppoePass: trimmedPppoePass,
                dhcp,
                lanPorts,
                wlanSsids,
                configureWifi,
                wifiSsid24,
                wifiPass24,
                wifiSsid5,
                wifiPass5,
                manufacturer,
                productClass: deviceData._deviceId?._ProductClass || deviceData._deviceId?.ProductClass || '',
                wlanConfig: Object.keys(wlanConfig).length ? wlanConfig : cachedInstanceMaps.wlan,
                wanConnectionDevices: effectiveWanDevices,
                workflowMeta: {
                    workflowId,
                    workflowType: 'add_wan',
                    workflowLabel: 'Add WAN'
                }
            });

            // Same username already exists but has no PPPoE address? Repair that failed interface
            // instead of creating WAN.3/4/... each time the operator retries provisioning.
            if (normalizedMode === 'pppoe') {
                const existing = findExistingPppoeByUsername(effectiveWanDevices, trimmedPppoeUser);
                if (existing?.state === 'active') {
                    return res.status(409).json({ success: false, message: `Username PPPoE sudah aktif pada WAN ${existing.wanDeviceInstance}/${existing.connectionInstance} dengan IP ${existing.ip}; tidak dibuat duplikat.` });
                }
                if (existing?.state === 'unknown') {
                    return res.status(409).json({ success: false, message: `Username PPPoE sudah ada pada WAN ${existing.wanDeviceInstance}/${existing.connectionInstance}, tetapi ExternalIPAddress belum terbaca. Segarkan data ACS terlebih dahulu; WAN baru tidak dibuat agar tidak duplikat.` });
                }
                if (existing?.state === 'reusable') {
                    const rootTaskId = await queueExistingWanFollowups(axios, baseUrl, deviceId, task.followup, {
                        wanDeviceInstance: existing.wanDeviceInstance,
                        wanConnectionInstance: existing.connectionInstance
                    }, config);
                    return res.json({
                        success: true,
                        reusedExistingWan: true,
                        workflowId,
                        rootTaskId,
                        trackingSupported: true,
                        message: `WAN PPPoE lama ${existing.wanDeviceInstance}/${existing.connectionInstance} memiliki IP kosong. Parameter diperbaiki pada instance yang sama; tidak menambah WAN duplikat.`
                    });
                }
            }

            const taskRes = await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, task, config);
            const rootTaskId = parseInt(taskRes?.data?._id, 10);
            return res.json({
                success: true,
                message: 'Workflow Add WAN built-in berhasil dikirim. Progress akan dimonitor otomatis.',
                trackingSupported: true,
                workflowId,
                rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null
            });
        }

        const existingKeys = Object.keys(wanConnObj).filter(k => /^\d+$/.test(k)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        const connectionType = normalizedMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection';
        let wanInstance;
        if (existingKeys.length > 0) {
            wanInstance = existingKeys[0];
        } else {
            await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                name: 'addObject',
                objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
            }, config);
            wanInstance = 1;
        }
        const connectionObj = wanConnObj[String(wanInstance)]?.[connectionType] || {};
        const childKeys = Object.keys(connectionObj).filter(k => /^\d+$/.test(k)).map(Number).filter(Number.isFinite);
        const nextConnectionInstance = childKeys.length > 0 ? Math.max(...childKeys) + 1 : 1;
        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanInstance}.${connectionType}.`
        }, config);

        const paramValues = [];
        const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanInstance}.${connectionType}.${nextConnectionInstance}`;
        paramValues.push([`${baseConnPath}.Enable`, true, 'xsd:boolean']);

        if (normalizedMode === 'pppoe') {
            paramValues.push(
                [`${baseConnPath}.ConnectionType`, getWanConnectionType(normalizedMode, manufacturer, deviceData._deviceId?._ProductClass || deviceData._deviceId?.ProductClass || ''), 'xsd:string'],
                [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
                [`${baseConnPath}.Username`, trimmedPppoeUser, 'xsd:string'],
                [`${baseConnPath}.Password`, trimmedPppoePass, 'xsd:string']
            );
        } else {
            paramValues.push([`${baseConnPath}.ConnectionType`, 'Bridged', 'xsd:string']);
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: [[`InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable`, toBool(dhcp), 'xsd:boolean']]
        }, config).catch(() => {});

        const lanPortsArray = normalizeSelectionArray(lanPorts);
        const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
        if (manufacturer.includes('huawei')) {
            paramValues.push(
                [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
                [`${baseConnPath}.X_HW_WANMode`, normalizedMode === 'pppoe' ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else if (manufacturer.includes('zte')) {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else {
            // Do not guess vendor-specific VLANIDMark/VLANMode names on unknown ONTs.
            paramValues.push([`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt']);
        }

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: paramValues
        }, config);

        if (toBool(configureWifi)) {
            const wifiParamValues = [];
            if (wlanConfig['1'] && wifiSsid24) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
                if (wifiPass24) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey`, wifiPass24, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase`, wifiPass24, 'xsd:string']
                    );
                }
            }

            const fiveGIndex = wlanConfig['5'] ? '5' : (wlanConfig['2'] ? '2' : null);
            if (fiveGIndex && wifiSsid5) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
                if (wifiPass5) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }

            if (wifiParamValues.length > 0) {
                await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                    name: 'setParameterValues',
                    parameterValues: wifiParamValues
                }, config);
            }
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'refreshObject',
            objectName: ''
        }, config).catch(() => {});
        
        res.json({
            success: true,
            message: 'Semua antrean tugas Add WAN (dan Wi-Fi) berhasil dikirimkan ke GenieACS.',
            trackingSupported: false
        });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// GET /admin/acs/search - Redirect to main page with query params
router.get('/search', requireAdminSession, async (req, res) => {
    const { q, acs } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (acs) params.append('acs', acs);
    res.redirect(`/admin/acs?${params.toString()}`);
});

module.exports = router;
