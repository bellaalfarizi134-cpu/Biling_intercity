const snmp = require('net-snmp');
const net = require('net');
const Database = require('better-sqlite3');
const path = require('path');
const winston = require('winston');
const axios = require('axios');
const genieacs = require('../config/genieacs');
const { getSetting } = require('../config/settingsManager');

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const dbPath = path.join(__dirname, '../database/billing.db');
const db = new Database(dbPath);
// Persist the physical PON-port count as topology metadata only. This field never
// sends configuration commands to the OLT. Existing installations remain valid.
try {
  const oltColumns = new Set(db.prepare('PRAGMA table_info(olts)').all().map(column => column.name));
  if (oltColumns.size && !oltColumns.has('pon_port_count')) db.exec('ALTER TABLE olts ADD COLUMN pon_port_count INTEGER');
} catch (error) {
  logger.warn('[OLT] PON-port metadata migration skipped: ' + String(error.message || error));
}

/**
 * Profil SNMP per brand OLT
 * Setiap profil mendefinisikan OID tabel untuk status, nama, dan cara deteksi.
 */
const BRAND_PROFILES = {
  hioso: [
    {
      name: 'HIOSO_EPON_C',
      status_table: '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
      name_table:   '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
      sn_table:     '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
      tx_power_table: '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
      rx_power_table: '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
      probe_oid:    '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
      /** OLT_OID_REFERENCE: integer meter (bukan per 0,1 m seperti ZTE/Huawei) */
      distance_table: '1.3.6.1.4.1.25355.3.2.6.3.2.1.25',
      distance_tenths_meter: false,
    },
    {
      name: 'HIOSO_EPON_B',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      offline_reason_table: '1.3.6.1.4.1.3320.101.11.1.1.11',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
    {
      name: 'HIOSO_GPON',
      status_table: '1.3.6.1.4.1.25355.3.3.1.1.1.11',
      name_table:   '1.3.6.1.4.1.25355.3.3.1.1.1.2',
      sn_table:     '1.3.6.1.4.1.25355.3.3.1.1.1.5',
      tx_power_table: '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
      rx_power_table: '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
      probe_oid:    '1.3.6.1.4.1.25355.3.3.1.1.1.11',
    },
  ],
  hsgq: [
    {
      // Verified on the live HSGQ-G008ID: enterprise .50224; ONU table is .3.12.2.1.
      name: 'HSGQ_G008ID_SNMP',
      // Column 3 is not the live state (it reports 1 even when column 22 says Power down).
      status_table: '1.3.6.1.4.1.50224.3.12.2.1.3',
      name_table:   '1.3.6.1.4.1.50224.3.12.2.1.2',
      sn_table:     '1.3.6.1.4.1.50224.3.12.2.1.15',
      firmware_table: '1.3.6.1.4.1.50224.3.12.2.1.13',
      uptime_table: '1.3.6.1.4.1.50224.3.12.2.1.21',
      // Live-tested HSGQ-G008ID ONU distance column (integer metres).
      distance_table: '1.3.6.1.4.1.50224.3.12.2.1.19',
      distance_tenths_meter: false,
      probe_oid:    '1.3.6.1.4.1.50224.3.12.2.1.3',
    },
    {
      name: 'HSGQ_EPON',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      offline_reason_table: '1.3.6.1.4.1.3320.101.11.1.1.11',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
  ],
  zte: [
    {
      name: 'ZTE_GPON_C300',
      status_table: '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.9',
      name_table:   '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.6',
      tx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.1', // TX Optical power (0.01 dBm)
      rx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.2', // RX Optical power (0.01 dBm)
      offline_reason_table: '1.3.6.1.4.1.3902.1082.500.10.2.3.8.1.7',
      probe_oid:    '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.9',
      unauth_sn_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.2',
      unauth_type_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.10',
      distance_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.4',
      distance_tenths_meter: true,
      firmware_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.5',
      uptime_table:   '1.3.6.1.4.1.3902.1015.1010.11.2.1.6',
    },
    {
      name: 'ZTE_GPON_C600',
      status_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.10',
      name_table:   '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.3',
      tx_power_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.7.1.2',
      rx_power_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.7.1.3',
      offline_reason_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.8.1.7',
      probe_oid:    '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.10',
      unauth_sn_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.11.1.2',
      unauth_type_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.11.1.10',
    },
    {
      name: 'ZTE_GPON_OLD',
      status_table: '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
      name_table:   '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.6',
      tx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.1',
      rx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.2',
      probe_oid:    '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
      unauth_sn_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.2',
    }
  ],
  vsol: [
    {
      name: 'VSOL_EPON',
      status_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
      name_table:   '1.3.6.1.4.1.37950.1.1.5.13.1.1.10',
      sn_table:     '1.3.6.1.4.1.37950.1.1.5.13.1.1.2',
      tx_power_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.20', // 0.1 dBm
      rx_power_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
    },
  ],
  huawei: [
    {
      name: 'HUAWEI_GPON',
      status_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      name_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
      sn_table:     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
      tx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.3', // 0.01 dBm
      rx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.4', // 0.01 dBm
      offline_reason_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.24',
      probe_oid:    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      unauth_sn_table: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.4',
      unauth_type_table: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.5',
      distance_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.20',
      distance_tenths_meter: true,
      firmware_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.10',
      uptime_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.15',
    }
  ],
  fiberhome: [
    {
      name: 'FIBERHOME_GPON',
      status_table: '1.3.6.1.4.1.27332.1.1.1.8.1.7',
      name_table:   '1.3.6.1.4.1.27332.1.1.1.8.1.3',
      sn_table:     '1.3.6.1.4.1.27332.1.1.1.8.1.4',
      tx_power_table: '1.3.6.1.4.1.27332.1.1.1.11.1.3',
      rx_power_table: '1.3.6.1.4.1.27332.1.1.1.11.1.4',
      probe_oid:    '1.3.6.1.4.1.27332.1.1.1.8.1.7',
      unauth_sn_table: '1.3.6.1.4.1.27332.1.1.1.1.1.1.10',
    }
  ],
  bdcom: [
    {
      name: 'BDCOM_GPON',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.7',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.3',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.4',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.3.1.3',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.3.1.4',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.7',
    }
  ],
  cdata: [
    {
      name: 'CDATA_EPON',
      status_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
      name_table:   '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.10',
      sn_table:     '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.2', // LLID / MAC table (bukan .10)
      tx_power_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.20',
      rx_power_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
    }
  ],
  generic: [
    {
      name: 'GENERIC_EPON_CTC',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
    {
      name: 'GENERIC_GPON_STD',
      status_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      name_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
      sn_table:     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
      tx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.3',
      rx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.4',
      probe_oid:    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
    }
  ]
};

// Nilai status yang dianggap "online" per brand
const ONLINE_VALUES = {
  hioso: [1, 3, 4],
  hsgq:  [1, 3, 4],
  zte:   [1, 3, 'working', 'online'],
  vsol:  [1, 3, 4],
  huawei: [5, 1, 'active', 'online'], // 5: operation
  fiberhome: [1, 2, 3],
  bdcom: [1, 2, 3],
  cdata: [1, 3],
  generic: [1, 2, 3, 4, 5, 'online', 'active', 'working'],
};

const getOnlineValues = (brandKey, profile) => {
  const base = ONLINE_VALUES[brandKey] || [1, 3];
  const profileName = String(profile?.name || '').toLowerCase();
  const nameOid = String(profile?.name_table || '');
  const isHiosoGpon = (brandKey === 'hioso' || brandKey === 'hsgq')
    && (profileName.includes('gpon') || nameOid.includes('.25355.3.3.'));
  if (isHiosoGpon) return [2, 3, 4];
  return base;
};

/**
 * OID sistem per brand untuk mengambil metrics hardware.
 * Semua diambil dengan snmp.get (bukan walk).
 */
const SYSTEM_OIDS = {
  hioso: {
    temp:      '1.3.6.1.4.1.25355.3.2.1.1.1.0',  // Suhu (°C)
    cpu:       '1.3.6.1.4.1.25355.3.2.1.1.2.0',  // CPU Usage (%)
    ram:       '1.3.6.1.4.1.25355.3.2.1.1.3.0',  // RAM Usage (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',       // ifHCInOctets (uplink port 1)
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',      // ifHCOutOctets (uplink port 1)
  },
  hsgq: {
    // Live-tested HSGQ-G008ID system table (.3.1.1): temp 42°C, CPU %, RAM counters.
    temp:      '1.3.6.1.4.1.50224.3.1.1.22.0',
    cpu:       '1.3.6.1.4.1.50224.3.1.1.25.0',
    ram:       '1.3.6.1.4.1.50224.3.1.1.28.0', // used RAM counter; percentage computed from .26 total
    ram_total: '1.3.6.1.4.1.50224.3.1.1.26.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.265',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.265',
  },
  zte: {
    temp:      '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.19.1.1.1', // Temp sensor (zxAnCardCpuTemp)
    cpu:       '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.10.1.1.1', // CPU Usage
    ram:       '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.11.1.1.1', // RAM Usage
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  vsol: {
    temp:      '1.3.6.1.4.1.37950.1.1.5.1.1.11',
    cpu:       '1.3.6.1.4.1.37950.1.1.5.1.1.2',
    ram:       '1.3.6.1.4.1.37950.1.1.5.1.1.4',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  huawei: {
    temp:      '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.13.0.0', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.14.0.0', // CPU (%)
    ram:       '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.15.0.0', // RAM (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  fiberhome: {
    temp:      '1.3.6.1.4.1.27332.1.1.1.9.1.11.1.1', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.27332.1.1.1.9.1.12.1.1', // CPU (%)
    ram:       '1.3.6.1.4.1.27332.1.1.1.9.1.14.1.1', // RAM (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  bdcom: {
    temp:      '1.3.6.1.4.1.3320.101.11.1.12.1', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.3320.101.11.1.13.1', // CPU (%)
    ram:       '1.3.6.1.4.1.3320.101.11.1.14.1', // RAM (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  cdata: {
    temp:      '1.3.6.1.4.1.34592.1.3.100.1.1.1.2.0',
    cpu:       '1.3.6.1.4.1.34592.1.3.100.1.1.1.3.0',
    ram:       '1.3.6.1.4.1.34592.1.3.100.1.1.1.4.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
};

const CARD_OIDS = {
  zte: {
    type:   '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.4',
    status: '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.6',
    ports:  '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.7',
    cpu:    '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.10',
    ram:    '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.11',
    serial: '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.12',
  },
  huawei: {
    type:   '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.4',
    status: '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.6',
    ports:  '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.3',
    cpu:    '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.14',
    ram:    '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.15',
    serial: '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.9',
  },
  fiberhome: {
    type:   '1.3.6.1.4.1.27332.1.1.1.9.1.3',
    status: '1.3.6.1.4.1.27332.1.1.1.9.1.5',
    ports:  '1.3.6.1.4.1.27332.1.1.1.9.1.6',
    cpu:    '1.3.6.1.4.1.27332.1.1.1.9.1.12',
    ram:    '1.3.6.1.4.1.27332.1.1.1.9.1.14',
    serial: '1.3.6.1.4.1.27332.1.1.1.9.1.8',
  },
  bdcom: {
    type:   '1.3.6.1.4.1.3320.101.11.1.3',
    status: '1.3.6.1.4.1.3320.101.11.1.5',
    ports:  '1.3.6.1.4.1.3320.101.11.1.6',
    cpu:    '1.3.6.1.4.1.3320.101.11.1.13',
    ram:    '1.3.6.1.4.1.3320.101.11.1.14',
    serial: '1.3.6.1.4.1.3320.101.11.1.8',
  }
};

const CARD_STATUS_MAP = {
  1: 'INSERVICE',
  2: 'STANDBY',
  3: 'OFFLINE',
  4: 'FAILED',
  5: 'INIT',
};

// ─── DB CRUD ────────────────────────────────────────────────────────────────

function getAllOlts() {
  return db.prepare('SELECT * FROM olts ORDER BY created_at DESC').all();
}

function getActiveOlts() {
  return db.prepare('SELECT * FROM olts WHERE is_active = 1').all();
}

function getOltById(id) {
  return db.prepare('SELECT * FROM olts WHERE id = ?').get(id);
}

function normalizeOltPonPortCount(value, { allowBlank = true } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw && allowBlank) return null;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('Jumlah port PON OLT harus angka 1–64, atau dikosongkan jika belum diketahui.');
  return count;
}

function createOlt(data) {
  const apiBase = String(data.api_base_url || '').trim();
  const telnetPort = parseInt(data.telnet_port, 10);
  const ponPortCount = normalizeOltPonPortCount(data.pon_port_count);
  const stmt = db.prepare(`
    INSERT INTO olts (name, host, snmp_community, snmp_port, brand, description, is_active, web_user, web_password, api_base_url, telnet_port, enable_password, cli_user, cli_password, pon_port_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.host,
    data.snmp_community || 'public',
    data.snmp_port || 161,
    data.brand || 'hioso',
    data.description || '',
    data.is_active !== undefined ? data.is_active : 1,
    data.web_user || '',
    data.web_password || '',
    apiBase || null,
    Number.isFinite(telnetPort) && telnetPort > 0 ? telnetPort : 23,
    data.enable_password != null && String(data.enable_password).length ? String(data.enable_password) : null,
    String(data.cli_user || '').trim(),
    String(data.cli_password || ''),
    ponPortCount
  );
}

function updateOlt(id, data) {
  const prev = getOltById(id);
  if (!prev) throw new Error('OLT tidak ditemukan.');
  const apiBase = String(data.api_base_url || '').trim();
  const ponPortCount = Object.prototype.hasOwnProperty.call(data, 'pon_port_count')
    ? normalizeOltPonPortCount(data.pon_port_count)
    : (Number.isInteger(Number(prev.pon_port_count)) && Number(prev.pon_port_count) > 0 ? Number(prev.pon_port_count) : null);
  const telnetPort = parseInt(data.telnet_port, 10);
  const enablePass = String(data.enable_password || '').trim().length > 0
    ? String(data.enable_password).trim()
    : (prev && prev.enable_password) || null;
  const cliUser = String(data.cli_user || '').trim() || (prev && prev.cli_user) || '';
  const cliPassword = String(data.cli_password || '') || (prev && prev.cli_password) || '';
  const stmt = db.prepare(`
    UPDATE olts 
    SET name = ?, host = ?, snmp_community = ?, snmp_port = ?, brand = ?, description = ?, is_active = ?, web_user = ?, web_password = ?, api_base_url = ?, telnet_port = ?, enable_password = ?, cli_user = ?, cli_password = ?, pon_port_count = ?
    WHERE id = ?
  `);
  return stmt.run(
    data.name,
    data.host,
    data.snmp_community,
    data.snmp_port,
    data.brand,
    data.description,
    data.is_active ? 1 : 0,
    data.web_user || '',
    data.web_password || '',
    apiBase || null,
    Number.isFinite(telnetPort) && telnetPort > 0 ? telnetPort : 23,
    enablePass,
    cliUser,
    cliPassword,
    ponPortCount,
    id
  );
}

function deleteOlt(id) {
  return db.prepare('DELETE FROM olts WHERE id = ?').run(id);
}

// ─── SNMP HELPERS ────────────────────────────────────────────────────────────

/**
 * Normalisasi OID: hapus prefix 'iso.' atau awalan '1.' yang ganda
 */
const normalizeOid = (oid) => {
  if (!oid) return '';
  return oid.replace(/^iso\./, '1.').replace(/^\./, '');
};

/**
 * Ekstrak suffix index dari OID yang di-walk
 */
const extractIdx = (rawOid, baseOid) => {
  const normRaw  = normalizeOid(rawOid);
  const normBase = normalizeOid(baseOid);
  if (normRaw.startsWith(normBase + '.')) {
    return normRaw.substring(normBase.length + 1);
  }
  if (normRaw.startsWith(normBase)) {
    return normRaw.substring(normBase.length).replace(/^\./, '');
  }
  // fallback
  return rawOid.split('.').slice(-1)[0];
};

/**
 * Cek apakah OID yang di-return masih di bawah baseOid
 */
const oidUnderBase = (rawOid, baseOid) => {
  const normRaw  = normalizeOid(rawOid);
  const normBase = normalizeOid(baseOid);
  return normRaw.startsWith(normBase + '.') || normRaw === normBase;
};

const decodeSn = (val) => {
  if (!val) return 'N/A';
  if (Buffer.isBuffer(val)) {
    const ascii = val.toString('utf8').replace(/\0/g, '').trim();
    const looksAscii = ascii.length >= 4 && /^[\x20-\x7E]+$/.test(ascii);
    if (looksAscii) return ascii.toUpperCase();
    return val.toString('hex').toUpperCase();
  }
  return val.toString().toUpperCase();
};

/**
 * SN di SNMP sering jadi hex rapat (mis. 88D2742B900D); di CLI OLT bisa ditampilkan bertitik dua (88:D2:74:2B:90:0D).
 * Untuk perintah otorisasi, keduanya harus jadi bentuk yang sama (hex huruf besar tanpa separator, atau SN GPON vendor).
 */
function normalizeSnForOltProvision(sn) {
  const raw = String(sn == null ? '' : sn).trim();
  if (!raw) return raw;
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (/^[A-F0-9]+$/.test(alnum) && (alnum.length === 12 || alnum.length === 16)) return alnum;
  if (/^[A-Z]{4}/.test(alnum) && alnum.length >= 8) return alnum;
  return alnum;
}

const decodeUptime = (ticks) => {
  if (!ticks) return 'N/A';
  let seconds = Math.floor(ticks / 100);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  return `${days}d ${hours}h ${minutes}m`;
};

const hiosoOnuIdFromIndex = (index) => {
  if (index == null) return null;
  const s = String(index).trim();
  if (!s) return null;

  if (s.includes('.')) {
    const parts = s.split('.').filter(Boolean);
    if (parts.length >= 2) {
      const onu = parseInt(parts[parts.length - 1], 10);
      const port = parseInt(parts[parts.length - 2], 10);
      if (Number.isFinite(port) && Number.isFinite(onu)) return `0/${port}:${onu}`;
    }
    return null;
  }

  const intIdx = parseInt(s, 10);
  if (!Number.isFinite(intIdx)) return null;
  let port = (intIdx >> 16) & 0xff;
  if (port === 0 || port > 16) port = (intIdx >> 8) & 0xff;
  const onu = intIdx & 0xff;
  if (port === 0) return null;
  return `0/${port}:${onu}`;
};

const telnetReadUntil = (socket, matcher, timeoutMs) => {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.includes('--More--') || buf.includes('--Press Enter--')) {
        socket.write(' ');
      }
      // Firmware wraps prompts in ANSI cursor/control sequences; match on clean text.
      const normalized = buf.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
      if (typeof matcher === 'function' ? matcher(normalized) : matcher.test(normalized)) {
        cleanup();
        resolve(buf);
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('Telnet connection closed')); };
    const t = setTimeout(() => {
      const tail = buf.slice(-220).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');
      const clue = /incorrect|invalid|denied|authentication failed/i.test(tail) ? 'authentication rejected'
        : /username\s*:\s*$/i.test(tail) ? 'username prompt repeated'
        : /password\s*:\s*$/i.test(tail) ? 'password prompt repeated'
        : /[>#]\s*$/.test(tail) ? 'CLI prompt seen but response matcher did not settle'
        : 'no recognized CLI prompt';
      cleanup();
      reject(new Error(`Telnet timeout (${clue})`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
};

const telnetLoginAndRun = async (host, user, pass, commands, opts = {}) => {
  const telnetPort = Number(opts.port) > 0 ? Number(opts.port) : 23;
  const enablePassword = opts.enablePassword != null && String(opts.enablePassword).length > 0
    ? String(opts.enablePassword)
    : null;

  const socket = new net.Socket();
  socket.setTimeout(15000);

  await new Promise((resolve, reject) => {
    socket.connect(telnetPort, host, resolve);
    socket.once('error', reject);
  });

  // Match only the actual end of the latest response; multiline `$` caused premature CLI reads.
  const promptRe = /[>#]\s*$/;
  const loginRe = /(login|username)\s*[:>]\s*$/i;
  const passRe = /(password|passwd)\s*[:>]\s*$/i;

  let banner = '';
  try {
    banner = await telnetReadUntil(socket, (b) => loginRe.test(b) || passRe.test(b) || promptRe.test(b), 8000);
  } catch (e) {
    socket.destroy();
    throw new Error(`Telnet initial login prompt: ${e.message}`);
  }

  if (loginRe.test(banner)) {
    socket.write(String(user || 'admin') + '\r\n');
    try { await telnetReadUntil(socket, passRe, 8000); }
    catch (e) { socket.destroy(); throw new Error(`Telnet username rejected or password prompt missing: ${e.message}`); }
    socket.write(String(pass || 'admin') + '\r\n');
    try { await telnetReadUntil(socket, promptRe, 8000); }
    catch (e) { socket.destroy(); throw new Error(`Telnet authentication did not reach CLI prompt: ${e.message}`); }
  } else if (passRe.test(banner)) {
    socket.write(String(pass || 'admin') + '\r\n');
    try { await telnetReadUntil(socket, promptRe, 8000); }
    catch (e) { socket.destroy(); throw new Error(`Telnet password authentication did not reach CLI prompt: ${e.message}`); }
  } else if (promptRe.test(banner)) {
  } else {
    socket.destroy();
    throw new Error('Telnet prompt not detected');
  }

  if (enablePassword) {
    try {
      socket.write('enable\r\n');
      const enBuf = await telnetReadUntil(socket, (b) => /password\s*[:>]\s*$/im.test(b) || promptRe.test(b), 12000);
      if (/password\s*[:>]\s*$/im.test(enBuf)) {
        socket.write(enablePassword + '\r\n');
        await telnetReadUntil(socket, promptRe, 12000);
      }
    } catch (e) {
      socket.destroy();
      throw new Error('Telnet enable gagal: ' + (e.message || String(e)));
    }
  }

  let cmdList = Array.isArray(commands) ? [...commands] : [];
  while (cmdList.length && /^enable\s*$/i.test(String(cmdList[0]).trim())) {
    cmdList.shift();
  }

  const outputs = [];
  for (const cmd of cmdList) {
    socket.write(cmd + '\r\n');
    const out = await telnetReadUntil(socket, promptRe, 15000);
    outputs.push(out);
  }

  socket.end();
  socket.destroy();
  return outputs.join('\n');
};

const parseHiosoOnuTable = (text) => {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const rows = [];

  for (const line of lines) {
    const t = line.trim();
    if (!/^0\/\d+:\d+/.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 22) continue;

    const id = parts[0];
    const name = parts[1];
    const mac = parts[2];
    const status = parts[3];
    const fwVersion = parts[4];
    const chipId = parts[5];
    const ports = parts[6];
    const rtt = parts[7];
    const distance = parts[8];
    const ctcStatus = parts[9];
    const ctcVer = parts[10];
    const activate = parts[11];
    const temperature = parts[12];
    const txPower = parts[13];
    const rxPower = parts[14];
    const onlineTime = parts[15] + ' ' + parts[16];
    const offlineTime = parts[17] + ' ' + parts[18];
    const offlineReason = parts[19];
    const deregisterCnt = parts[parts.length - 1];
    const online = parts.slice(20, parts.length - 1).join(' ');

    rows.push({
      id,
      name: name === 'NA' ? null : name,
      mac,
      status,
      fwVersion,
      chipId,
      ports,
      rtt,
      distance,
      ctcStatus,
      ctcVer,
      activate,
      temperature,
      txPower,
      rxPower,
      onlineTime,
      offlineTime,
      offlineReason,
      online,
      deregisterCnt,
    });
  }

  return rows;
};

const hsgqSerialVendor = (value) => {
  const sn = String(value || '').trim().toUpperCase();
  const aliases = {
    FHTT: 'FiberHome', ZTEG: 'ZTE', HWTC: 'Huawei', ALCL: 'Nokia/Alcatel',
    CMHI: 'CMHI', ZXIC: 'ZXIC', ZION: 'ZIONCOM', RTEG: 'RTEG', ZICG: 'ZICG', CMDC: 'CMDC'
  };
  const hexPrefixes = {
    '46485454': 'FiberHome', '5A544547': 'ZTE', '48575443': 'Huawei', '414C434C': 'Nokia/Alcatel'
  };
  const alias = sn.match(/^([A-Z]{4})[0-9A-F]{8}$/);
  if (alias && aliases[alias[1]]) return aliases[alias[1]];
  const raw = sn.match(/^([0-9A-F]{8})[0-9A-F]{8}$/);
  if (raw && hexPrefixes[raw[1]]) return hexPrefixes[raw[1]];
  return 'Unknown';
};

const hsgqSerialMatchKey = (value) => {
  const sn = String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  // Some OLT SNMP tables return the vendor's four ASCII characters as hex,
  // while the CLI displays the same serial using the four-character alias.
  const raw = sn.match(/^([0-9A-F]{8})([0-9A-F]{8})$/);
  if (raw) {
    const alias = Buffer.from(raw[1], 'hex').toString('ascii').toUpperCase();
    if (/^[A-Z]{4}$/.test(alias)) return alias + raw[2];
  }
  return sn;
};

const parseHsgqGponOnuTable = (text) => {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').trim();
    // Actual HSGQ output columns: PON/ONU, ONU Type, Serial Number,
    // administrative State (Active), live Run State (Online/Offline), Config State, ...
    const m = line.match(/^(\d+\/\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m || /^-+$/.test(m[3]) || !/^[A-Z0-9]{8,}$/i.test(m[3])) continue;
    const [_, id, onuType, serial, adminState, runState, configState, rest] = m;
    const liveState = String(runState || '').trim().toLowerCase();
    const status = /^(online|up|on)$/i.test(liveState)
      ? 'Online'
      : /^(offline|down|off|initial)$/i.test(liveState)
        ? 'Offline'
        : 'Unknown';
    if (status === 'Unknown') continue;
    rows.push({
      id,
      name: null,
      mac: serial === '----------------' ? null : serial,
      serialNumber: serial === '----------------' ? null : serial,
      vendor: serial === '----------------' ? 'Unknown' : hsgqSerialVendor(serial),
      status,
      fwVersion: null,
      chipId: null,
      ports: null,
      rtt: null,
      distance: null,
      ctcStatus: configState || adminState || onuType,
      ctcVer: null,
      activate: adminState,
      temperature: null,
      txPower: null,
      rxPower: null,
      onlineTime: null,
      offlineTime: null,
      offlineReason: status === 'Offline' ? (rest || null) : null,
      deregisterCnt: null
    });
  }
  return rows;
};

const parseHsgqOpticalTable = (text) => {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').trim();
    // HSGQ show ont-optical all: PON/ONU SN Temp C Voltage V Bias mA Tx dBm Rx dBm OLT-Rx dBm Name
    const m = line.match(/^(\d+\/\d+)\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+C\s+(-?\d+(?:\.\d+)?)\s+V\s+(-?\d+(?:\.\d+)?)\s+mA\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBm\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBm\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBm\s+(.+)$/i);
    if (!m) continue;
    const power = (rawValue, min, max) => {
      const n = Number(rawValue);
      return Number.isFinite(n) && n >= min && n <= max ? n.toFixed(2) : 'N/A';
    };
    rows.push({
      id: m[1], serialNumber: m[2], mac: m[2],
      txPower: power(m[6], -20, 15),
      rxPower: power(m[7], -50, 10),
      oltRxPower: power(m[8], -50, 10),
      temperature: power(m[3], -20, 120),
      name: String(m[9] || '').trim()
    });
  }
  return rows;
};

const fetchHiosoOnuDetailViaTelnet = async (olt, includeOptical = false) => {
  const isHsgqGpon = String(olt.brand || '').toLowerCase() === 'hsgq';
  // Use the tested HSGQ Telnet driver for this firmware; the legacy generic login
  // helper can misread its ANSI login prompt and fall back to stale SNMP statuses.
  if (isHsgqGpon) {
    try {
      const { getSetting: getCfg } = require('../config/settingsManager');
      const host = String(getCfg('olt_host', '') || '').trim();
      const username = String(getCfg('olt_username', '') || '').trim();
      const password = String(getCfg('olt_password', '') || '');
      if (host === String(olt.host || '').trim() && username && password) {
        const hsgqDriver = require('./onuProvisionService');
        const commands = ['enable', 'configure'];
        for (let port = 1; port <= 8; port++) {
          commands.push(`interface gpon ${port}`, 'show ont-info all');
          if (includeOptical) commands.push('show ont-optical all');
          commands.push('exit');
        }
        const raw = await hsgqDriver.runHSGQTelnet({ host, port: 23, username, password }, commands);
        const rows = parseHsgqGponOnuTable(raw);
        if (rows.length > 0) {
          if (includeOptical) {
            const opticalBySn = new Map(parseHsgqOpticalTable(raw).map(r => [hsgqSerialMatchKey(r.serialNumber), r]));
            for (const row of rows) {
              const optical = opticalBySn.get(hsgqSerialMatchKey(row.serialNumber || row.mac));
              if (!optical) continue;
              row.txPower = optical.txPower;
              row.rxPower = optical.rxPower;
              row.oltRxPower = optical.oltRxPower;
              row.temperature = optical.temperature;
              if (optical.name) row.name = optical.name;
            }
          }
          return rows;
        }
      }
    } catch (e) {
      logger.warn(`[oltService] Tested HSGQ Telnet driver failed for OLT ${olt.id}: ${e.message}`);
    }
  }
  // Prefer global CLI credentials only when their configured host matches this OLT.
  // Dedicated cli_user/cli_password take precedence; legacy records may use web_user/web_password for Telnet.
  const configuredHost = String(getSetting('olt_host', '') || '').trim();
  const configuredUser = String(getSetting('olt_username', '') || '').trim();
  const configuredPass = String(getSetting('olt_password', '') || '');
  const credentialCandidates = [];
  if (configuredHost === String(olt.host || '').trim() && configuredUser && configuredPass) {
    credentialCandidates.push({ user: configuredUser, pass: configuredPass });
  }
  const dbUser = String(olt.cli_user || olt.web_user || olt.username || '').trim();
  const dbPass = String(olt.cli_password || olt.web_password || olt.password || '');
  if (dbUser && dbPass && !credentialCandidates.some(c => c.user === dbUser && c.pass === dbPass)) {
    credentialCandidates.push({ user: dbUser, pass: dbPass });
  }
  if (!credentialCandidates.length) {
    throw new Error('Kredensial CLI/Telnet belum dikonfigurasi untuk OLT ini.');
  }

  const cmds = isHsgqGpon
    ? Array.from({ length: 8 }, (_, i) => [`interface gpon ${i + 1}`, 'show ont-info all', 'exit']).flat()
    : ['show onu', 'show onu all', 'show onu info', 'show onu status'];

  let lastError = null;
  for (const cred of credentialCandidates) {
    try {
      const out = await telnetLoginAndRun(olt.host, cred.user, cred.pass, cmds);
      const rows = isHsgqGpon ? parseHsgqGponOnuTable(out) : parseHiosoOnuTable(out);
      if (rows.length > 0) return rows;
      lastError = new Error('Telnet login berhasil tetapi tabel ONU kosong');
    } catch (e) {
      lastError = e;
    }
  }

  logger.warn(`HSGQ/HIOSO Telnet ONU fallback gagal: ${lastError?.message || 'unknown error'}`);
  return null;
};

// ─── CORE SNMP FUNCTIONS ─────────────────────────────────────────────────────

const slowWalk = async (session, baseOid, maxEntries = 5000) => {
  const results  = {};
  let walkCount  = 0;

  return new Promise((resolve) => {
    session.subtree(
      baseOid,
      20, // maxRepetitions (GETBULK size)
      (varbinds) => {
        for (const vb of varbinds) {
          if (!vb || vb.oid == null) continue;
          if (snmp.isVarbindError(vb)) continue;
          if (!oidUnderBase(vb.oid, baseOid)) continue;

          const idx = extractIdx(vb.oid, baseOid);
          results[idx] = vb.value;
          walkCount++;
          if (walkCount >= maxEntries) {
            break;
          }
        }
      },
      (error) => {
        // Resolve results when done, ignoring errors
        resolve(results);
      }
    );
  });
};

const walkSample = async (session, baseOid, maxItems = 3) => {
  let currentOid = baseOid;
  let count = 0;
  const values = [];

  while (count < maxItems) {
    try {
      const vb = await new Promise((rv, rj) => {
        session.getNext([currentOid], (err, vbs) => {
          if (err) rj(err);
          else rv(vbs[0]);
        });
      });

      if (!vb || vb.oid == null) break;
      if (vb.type === snmp.ObjectType.EndOfMibView || vb.type === snmp.ObjectType.NoSuchObject || vb.type === snmp.ObjectType.NoSuchInstance) break;
      if (!oidUnderBase(vb.oid, baseOid)) break;

      values.push(vb.value);
      currentOid = normalizeOid(vb.oid);
      count++;
    } catch (e) {
      break;
    }
  }

  return values;
};

/**
 * Test apakah sebuah OID probe memberikan respons SNMP getNext yang valid
 */
const probeOid = async (session, oid) => {
  try {
    const vb = await new Promise((rv, rj) => {
      session.getNext([oid], (err, vbs) => {
        if (err) rj(err);
        else rv(vbs[0]);
      });
    });
    if (!vb || vb.type === snmp.ObjectType.EndOfMibView || vb.type === snmp.ObjectType.NoSuchObject) return false;
    // Cek apakah hasil masih di bawah OID ini atau sub-treenya ada data
    return oidUnderBase(vb.oid, oid);
  } catch (e) {
    return false;
  }
};

/**
 * Ambil satu atau beberapa OID sekaligus menggunakan snmp.get.
 * Kembalikan array nilai (atau null jika error/tidak ada).
 */
const snmpGet = async (session, oids) => {
  try {
    const vbs = await new Promise((rv, rj) => {
      session.get(oids, (err, result) => {
        if (err) rj(err);
        else rv(result);
      });
    });
    return vbs.map(vb => {
      if (!vb || vb.type === snmp.ObjectType.NoSuchObject ||
          vb.type === snmp.ObjectType.NoSuchInstance ||
          vb.type === snmp.ObjectType.EndOfMibView) return null;
      return vb.value;
    });
  } catch (e) {
    return oids.map(() => null);
  }
};

const bufferToInt = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') {
    if (val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(val);
    return null;
  }
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  if (Buffer.isBuffer(val)) {
    if (val.length === 1) return val.readUInt8(0);
    if (val.length === 2) return val.readInt16BE(0);
    if (val.length === 4) return val.readInt32BE(0);
    if (val.length === 8) {
      try {
        const bi = val.readBigUInt64BE(0);
        if (bi <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(bi);
      } catch (e) {}
      return null;
    }
    const s = val.toString();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const bufferToCounterBigInt = (val) => {
  if (val == null) return null;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return BigInt(Math.max(0, Math.floor(val)));
  }
  if (typeof val === 'string') {
    try {
      if (val.trim() === '') return null;
      return BigInt(val);
    } catch (e) {
      return null;
    }
  }
  if (Buffer.isBuffer(val)) {
    if (val.length === 0) return null;
    // Some HSGQ SNMP agents encode Counter64 octets in a variable-length
    // BER payload (observed 6 bytes), not always an 8-byte Buffer.
    // Parse all bytes as unsigned big-endian instead of treating it as text.
    try {
      let n = BigInt(0);
      for (const byte of val) n = (n << BigInt(8)) | BigInt(byte);
      return n;
    } catch (e) { return null; }
  }
  return null;
};

const getByIdx = (map, idx) => {
  if (!map) return undefined;
  if (map[idx] != null) return map[idx];

  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;

  const idxParts = String(idx).split('.').filter(Boolean);
  const maxSegments = Math.min(6, idxParts.length);

  for (let seg = 2; seg <= maxSegments; seg++) {
    const suffix = '.' + idxParts.slice(-seg).join('.');
    const matches = keys.filter(k => k.endsWith(suffix));
    if (matches.length === 1) return map[matches[0]];
  }

  return undefined;
};

const toSigned16 = (n) => {
  if (!Number.isFinite(n)) return null;
  const u = n & 0xffff;
  return u > 0x7fff ? u - 0x10000 : u;
};

const pickFirstPlausible = (candidates) => {
  for (const v of candidates) {
    if (!Number.isFinite(v)) continue;
    if (v < -50 || v > 10) continue;
    if (v > 0) continue;
    return v;
  }
  return null;
};

const computeRxDbm = (brand, raw) => {
  const signal = parseSignal(raw);
  if (signal != null) return signal;

  const n = bufferToInt(raw);
  if (n == null) return null;
  if (n === 0 || n === 65535) return null;

  const signed = (n >= 0 && n <= 65535) ? toSigned16(n) : n;
  if (signed == null) return null;

  if (typeof signed === 'number' && signed < 0 && signed >= -60 && signed <= 10) return signed;

  const ordered = brand === 'huawei'
    ? [signed / 100, signed / 10, signed / 1000, (signed / 100) - 100, (signed / 10) - 100]
    : [signed / 10, signed / 100, signed / 1000, (signed / 10) - 100, (signed / 100) - 100];

  const picked = pickFirstPlausible(ordered);
  if (picked != null) return picked;

  const fallback = pickFirstPlausible([signed / 10, signed / 100, signed / 1000]);
  return fallback;
};

const safeToString = (val) => {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'bigint') return val.toString();
  if (Buffer.isBuffer(val)) return val.toString();
  return String(val);
};

const walkValues = async (session, baseOid) => Object.values(await slowWalk(session, baseOid));

const isLikelySn = (sample) => {
  if (sample == null) return false;
  let s = safeToString(sample);
  if (!s) return false;
  s = s.replace(/["']/g, '').replace(/\s+/g, '').trim();
  if (s.length < 6) return false;
  if (/(registered|offline|active|online|down|up|power|alarm)/i.test(s)) return false;
  return true;
};

const pickSnTable = async (session, activeProfile) => {
  const nameOid = activeProfile.name_table || '';
  const lastDot = nameOid.lastIndexOf('.');
  const parentBranch = lastDot > 0 ? nameOid.slice(0, lastDot) : nameOid;

  const candidates = [
    activeProfile.sn_table,
    `${parentBranch}.11`,
    '1.3.6.1.4.1.25355.3.2.10.1.1.2',
    `${parentBranch}.12`,
    `${parentBranch}.2`,
    '1.3.6.1.4.1.25355.3.2.1.2.1.2',
    '1.3.6.1.4.1.25355.3.2.6.1.1.18',
    '1.3.6.1.4.1.25355.3.2.6.3.2.1.12',
    '1.3.6.1.4.1.25355.3.2.6.1.1.2.1.6',
    '1.3.6.1.4.1.25355.3.3.1.1.1.5',
    '1.3.6.1.4.1.3320.101.10.1.1.3',
  ].filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const oid of candidates) {
    const n = normalizeOid(oid);
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(oid);
  }

  for (const oid of unique) {
    const samples = await walkSample(session, oid, 2);
    if (samples.length === 0) continue;
    if (!isLikelySn(samples[0])) continue;
    const m = await slowWalk(session, oid);
    return { oid, map: m };
  }

  return { oid: activeProfile.sn_table || null, map: {} };
};

const parseSignal = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'bigint') return null;
  const s = safeToString(val);
  if (!s) return null;
  const m = s.match(/[-+]?\d*\.?\d+/);
  if (!m) return null;
  const num = Number(m[0]);
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  if (abs > 500) return num / 100;
  if (abs > 50) return num / 10;
  return num;
};

const getHrCpuPercent = async (session) => {
  const values = await walkValues(session, '1.3.6.1.2.1.25.3.3.1.2');
  const nums = values.map(v => bufferToInt(v)).filter(v => Number.isFinite(v));
  if (nums.length === 0) return null;
  const avg = nums.reduce((s, v) => s + v, 0) / nums.length;
  return Math.max(0, Math.min(100, Math.round(avg)));
};

const getHrRamPercent = async (session) => {
  const descrMap = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.3');
  const typeMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.2');
  const sizeMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.5');
  const usedMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.6');

  const hrStorageRamType = '1.3.6.1.2.1.25.2.1.2';

  const indices = new Set([
    ...Object.keys(descrMap),
    ...Object.keys(typeMap),
    ...Object.keys(sizeMap),
    ...Object.keys(usedMap),
  ]);

  let best = null;

  for (const idx of indices) {
    const descr = (safeToString(descrMap[idx]) || '').toLowerCase();
    const type  = safeToString(typeMap[idx]) || '';
    const size  = bufferToInt(sizeMap[idx]);
    const used  = bufferToInt(usedMap[idx]);
    if (!Number.isFinite(size) || !Number.isFinite(used) || size <= 0) continue;

    const isRam = type.includes(hrStorageRamType) || descr.includes('ram') || descr.includes('memory') || descr.includes('mem');
    if (!isRam) continue;

    const pct = Math.round((used / size) * 100);
    const entry = { pct, size, used };
    if (!best) best = entry;
    else if (entry.size > best.size) best = entry;
  }

  if (!best) return null;
  return Math.max(0, Math.min(100, best.pct));
};

const getEntityTemperatureC = async (session) => {
  const typeMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.1');
  const valueMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.4');
  const precisionMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.3');

  const indices = new Set([
    ...Object.keys(typeMap),
    ...Object.keys(valueMap),
    ...Object.keys(precisionMap),
  ]);

  const candidates = [];

  for (const idx of indices) {
    const t = bufferToInt(typeMap[idx]);
    if (t !== 8) continue;
    const v = bufferToInt(valueMap[idx]);
    const p = bufferToInt(precisionMap[idx]);
    if (!Number.isFinite(v) || !Number.isFinite(p)) continue;
    const c = v / Math.pow(10, p);
    if (Number.isFinite(c) && c >= -20 && c <= 120) candidates.push(c);
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b - a);
  return candidates[0];
};

const autoPickUplinkCandidates = async (session) => {
  const ifNameMap = await slowWalk(session, '1.3.6.1.2.1.31.1.1.1.1');
  const ifDescrMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.2');
  const ifOperMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.8');
  const ifHighSpeedMap = await slowWalk(session, '1.3.6.1.2.1.31.1.1.1.15');
  const ifSpeedMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.5');

  const indices = new Set([
    ...Object.keys(ifNameMap),
    ...Object.keys(ifDescrMap),
    ...Object.keys(ifOperMap),
    ...Object.keys(ifHighSpeedMap),
    ...Object.keys(ifSpeedMap),
  ]);

  const candidates = [];

  for (const idx of indices) {
    const name = (safeToString(ifNameMap[idx]) || safeToString(ifDescrMap[idx]) || '').toLowerCase();
    const oper = bufferToInt(ifOperMap[idx]);
    const hs = bufferToInt(ifHighSpeedMap[idx]);
    const sp = bufferToInt(ifSpeedMap[idx]);
    const speedScore = Number.isFinite(hs) && hs > 0 ? hs : (Number.isFinite(sp) ? (sp / 1_000_000) : 0);

    let nameScore = 0;
    if (name.includes('uplink')) nameScore += 50;
    if (name.includes('trunk')) nameScore += 30;
    if (name.includes('xge')) nameScore += 25;
    if (name.includes('10g')) nameScore += 25;
    if (name.includes('ge')) nameScore += 10;
    if (name.includes('eth')) nameScore += 5;
    if (name.includes('gpon') || name.includes('epon') || name.includes('pon') || name.includes('onu') || name.includes('llid')) nameScore -= 35;
    if (name.includes('mgmt') || name.includes('loopback') || name.includes('null')) nameScore -= 50;

    const operScore = oper === 1 ? 20 : 0;
    const score = nameScore + operScore + Math.min(100, speedScore);
    candidates.push({ idx, score, name });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
};

const autoPickUplinkIfIndex = async (session) => {
  const candidates = await autoPickUplinkCandidates(session);
  return candidates[0]?.idx || null;
};

const uplinkCache = new Map();

const pickUplinkIfIndexByTraffic = async (session, oltId) => {
  if (oltId) {
    const now = Date.now();
    const cached = uplinkCache.get(oltId);
    if (cached && (now - cached.timestamp < 3600000)) { // 1 hour cache
      return cached.ifIndex;
    }
  }

  const candidates = await autoPickUplinkCandidates(session);
  if (candidates.length === 0) return null;

  const top = candidates.slice(0, 6);
  let best = null;

  for (const c of top) {
    const first = await readInterfaceOctets(session, c.idx);
    await new Promise(rv => setTimeout(rv, 100)); // Jedah scan lebih cepat (100ms)
    const second = await readInterfaceOctets(session, c.idx);

    const wrap64 = BigInt(1) << BigInt(64);
    let sum = BigInt(0);
    let ok = false;

    if (first.rx != null && second.rx != null) {
      let d = second.rx - first.rx;
      if (d < BigInt(0)) d = d + wrap64;
      if (d > BigInt(0)) ok = true;
      sum += d;
    }
    if (first.tx != null && second.tx != null) {
      let d = second.tx - first.tx;
      if (d < BigInt(0)) d = d + wrap64;
      if (d > BigInt(0)) ok = true;
      sum += d;
    }

    if (!ok) continue;
    if (!best || sum > best.sum) best = { idx: c.idx, sum };
  }

  const ifIndex = best?.idx || candidates[0].idx;
  if (oltId && ifIndex) {
    uplinkCache.set(oltId, { ifIndex, timestamp: Date.now() });
  }
  return ifIndex;
};

const readInterfaceOctets = async (session, ifIndex) => {
  const [hcIn, hcOut] = await snmpGet(session, [
    `1.3.6.1.2.1.31.1.1.1.6.${ifIndex}`,
    `1.3.6.1.2.1.31.1.1.1.10.${ifIndex}`,
  ]);

  let rx = bufferToCounterBigInt(hcIn);
  let tx = bufferToCounterBigInt(hcOut);

  if (rx == null || tx == null) {
    const [in32, out32] = await snmpGet(session, [
      `1.3.6.1.2.1.2.2.1.10.${ifIndex}`,
      `1.3.6.1.2.1.2.2.1.16.${ifIndex}`,
    ]);
    if (rx == null) rx = bufferToCounterBigInt(in32);
    if (tx == null) tx = bufferToCounterBigInt(out32);
  }

  return {
    rx,
    tx,
  };
};

/**
 * Ambil system metrics (temp, cpu, ram, uplink) untuk brand tertentu.
 * Mengisi field stats secara langsung.
 */
const fetchSystemMetrics = async (session, brandKey, stats, oltId, oltConfig = null) => {
  const oids = SYSTEM_OIDS[brandKey] || SYSTEM_OIDS.hioso;
  try {
    const [temp, cpu, ram, rx, tx] = await snmpGet(session, [
      oids.temp, oids.cpu, oids.ram, oids.uplink_rx, oids.uplink_tx
    ]);
    const tempN = bufferToInt(temp);
    const cpuN  = bufferToInt(cpu);
    let ramN = bufferToInt(ram);
    if (brandKey === 'hsgq' && oids.ram_total) {
      // HSGQ exposes used/total memory counters, not a percentage.
      const [ramTotalRaw] = await snmpGet(session, [oids.ram_total]);
      const ramTotal = bufferToInt(ramTotalRaw);
      if (ramN != null && ramTotal > 0) ramN = Math.round((ramN / ramTotal) * 100);
    }
    if (Number.isFinite(tempN) && tempN >= -20 && tempN <= 120 && tempN !== 0) stats.temp = `${tempN}°C`;
    if (cpuN  != null) stats.cpu  = `${cpuN}%`;
    if (ramN  != null) stats.ram  = `${ramN}%`;
    if (stats.temp === 'N/A') {
      const c = await getEntityTemperatureC(session);
      if (c != null) stats.temp = `${c.toFixed(1)}°C`;
    }

    // HSGQ traffic polling gets a dedicated session so detailed SNMP table walks
    // cannot interfere with the two Counter64 samples used to calculate rate.
    const ownsTrafficSession = brandKey === 'hsgq' && oltConfig && oltConfig.host;
    const trafficSession = ownsTrafficSession
      ? snmp.createSession(oltConfig.host, oltConfig.snmp_community || 'public', {
          port: Number(oltConfig.snmp_port) || 161, timeout: 3000, retries: 1, version: snmp.Version2c
        })
      : session;
    try {
      // HSGQ-G008ID: GE01 is IF-MIB index 265. Keep baselines between requests
      // because HSGQ updates counters in batches; a short sample can falsely read zero.
      const ifIndex = brandKey === 'hsgq' ? 265 : await pickUplinkIfIndexByTraffic(trafficSession, oltId);
      if (ifIndex) {
        const current = await readInterfaceOctets(trafficSession, ifIndex);
        const sampleKey = `${oltId}:${ifIndex}`;
        const now = Date.now();
        const previous = hsgqTrafficSamples.get(sampleKey);
        const wrap64 = BigInt(1) << BigInt(64);
        let rxRate = previous?.rxRate || 0;
        let txRate = previous?.txRate || 0;
        if (current.rx != null && current.tx != null) {
          if (previous && now > previous.timestamp) {
            const elapsedSeconds = (now - previous.timestamp) / 1000;
            if (elapsedSeconds >= 5) {
              let rxDelta = current.rx - previous.rx;
              let txDelta = current.tx - previous.tx;
              if (rxDelta < BigInt(0)) rxDelta += wrap64;
              if (txDelta < BigInt(0)) txDelta += wrap64;
              if (rxDelta > BigInt(0)) rxRate = Math.max(0, Math.round(Number(rxDelta) / elapsedSeconds));
              if (txDelta > BigInt(0)) txRate = Math.max(0, Math.round(Number(txDelta) / elapsedSeconds));
            }
          }
          hsgqTrafficSamples.set(sampleKey, { rx: current.rx, tx: current.tx, timestamp: now, rxRate, txRate });
          stats.uplink_rx = rxRate;
          stats.uplink_tx = txRate;
        }
      } else {
        const rxN = bufferToInt(rx);
        const txN = bufferToInt(tx);
        if (rxN != null) stats.uplink_rx = rxN;
        if (txN != null) stats.uplink_tx = txN;
      }
    } finally {
      if (ownsTrafficSession) trafficSession.close();
    }

    if (stats.cpu === 'N/A') {
      const hrCpu = await getHrCpuPercent(session);
      if (hrCpu != null) stats.cpu = `${hrCpu}%`;
    }
    if (stats.ram === 'N/A') {
      const hrRam = await getHrRamPercent(session);
      if (hrRam != null) stats.ram = `${hrRam}%`;
    }
  } catch (e) {
  }
};

/**
 * Ambil daftar card/board OLT.
 */
const fetchCardMetrics = async (session, brandKey, stats) => {
  const oids = CARD_OIDS[brandKey];
  if (!oids) return;

  try {
    const typeMap   = await slowWalk(session, oids.type);
    const statusMap = await slowWalk(session, oids.status);
    const portMap   = await slowWalk(session, oids.ports);
    const serialMap = await slowWalk(session, oids.serial);
    const cpuMap    = await slowWalk(session, oids.cpu);
    const ramMap    = await slowWalk(session, oids.ram);

    const cards = [];
    const indices = Object.keys(typeMap);

    for (const idx of indices) {
      const type = safeToString(typeMap[idx]);
      if (!type || type === '0') continue;

      const statusNum = bufferToInt(statusMap[idx]);
      const statusText = CARD_STATUS_MAP[statusNum] || (statusNum != null ? String(statusNum) : 'UNKNOWN');
      
      const cpuVal = bufferToInt(cpuMap[idx]);
      const ramVal = bufferToInt(ramMap[idx]);

      cards.push({
        index: idx,
        type: type,
        status: statusText,
        ports: bufferToInt(portMap[idx]) || 0,
        serial: decodeSn(serialMap[idx]),
        cpu: cpuVal != null ? `${cpuVal}%` : 'N/A',
        ram: ramVal != null ? `${ramVal}%` : 'N/A',
      });
    }

    if (cards.length > 0) {
      stats.cards = cards.sort((a, b) => String(a.index).localeCompare(String(b.index), undefined, { numeric: true }));
    }
  } catch (e) {
    logger.error(`fetchCardMetrics error: ${e.message}`);
  }
};

/**
 * Ambil daftar ONU yang belum diotorisasi (Unregistered).
 */
const fetchUnauthOnus = async (session, profile, stats) => {
  if (!profile.unauth_sn_table) return;

  try {
    const snMap = await slowWalk(session, profile.unauth_sn_table);
    let typeMap = {};
    if (profile.unauth_type_table) {
      typeMap = await slowWalk(session, profile.unauth_type_table);
    }

    const indices = Object.keys(snMap);
    for (const idx of indices) {
      const sn = decodeSn(snMap[idx]);
      if (!sn || sn === 'N/A') continue;

      const type = safeToString(typeMap[idx]) || 'GENERIC';
      const onuId = hiosoOnuIdFromIndex(idx);

      stats.unauth_onus.push({
        index: idx,
        id: onuId || idx,
        sn: sn,
        type: type
      });
    }
  } catch (e) {
    logger.error(`fetchUnauthOnus error: ${e.message}`);
  }
};

const decodeRxPower = (brand, val) => {
  const rx = computeRxDbm(brand, val);
  if (rx == null) return 'N/A';
  return rx.toFixed(2);
};

function translateOfflineReason(brand, rawValue) {
  if (rawValue == null) return null;
  const valNum = bufferToInt(rawValue);
  if (valNum == null) {
    const valStr = String(rawValue).trim().toLowerCase();
    if (valStr.includes('dying_gasp') || valStr.includes('power_off') || valStr.includes('poweroff') || /power[\s_-]*down/.test(valStr)) {
      return 'Daya ONT mati / adaptor dicabut (indikasi OLT: Power Down)';
    }
    if (valStr.includes('los') || valStr.includes('wire_down') || valStr.includes('link_down')) {
      return 'Kabel Fiber Optik Putus (LOS)';
    }
    if (valStr.includes('mpcp') || valStr.includes('timeout') || valStr.includes('unregister')) {
      return 'Koneksi Terputus / Redaman Drop';
    }
    if (valStr.includes('manual') || valStr.includes('deactive')) {
      return 'Dimatikan dari OLT (Deactive)';
    }
    return valStr;
  }

  const bKey = String(brand || '').toLowerCase();
  
  if (bKey === 'zte') {
    switch (valNum) {
      case 2:
      case 3:
        return 'Kabel Fiber Optik Putus (LOS)';
      case 4:
        return 'Loss of Frame (Gangguan Sinyal)';
      case 5:
        return 'Signal Failure (Gangguan Sinyal)';
      case 8:
        return 'Gagal Otorisasi / Registrasi';
      case 9:
        return 'Mati Listrik / Adaptor Dicabut';
      case 10:
        return 'Dimatikan dari OLT (Deactive)';
      case 12:
        return 'ONU Reboot';
      case 13:
        return 'ONU Dimatikan';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  if (bKey === 'huawei') {
    switch (valNum) {
      case 1:
      case 2:
        return 'Kabel Fiber Optik Putus (LOS)';
      case 3:
        return 'Loss of Frame (Gangguan Sinyal)';
      case 4:
        return 'Signal Failure (Gangguan Sinyal)';
      case 7:
        return 'Gagal Deaktivasi';
      case 8:
        return 'Dimatikan dari OLT (Deactive)';
      case 9:
        return 'ONU Reboot / Reset';
      case 10:
        return 'ONU Re-registrasi';
      case 13:
        return 'Mati Listrik / Adaptor Dicabut';
      case 31:
      case 32:
      case 33:
        return 'Reset oleh Pelanggan (Tombol/Sistem)';
      case 30:
        return 'Modul Optik Dimatikan';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  if (bKey === 'hioso' || bKey === 'hsgq') {
    switch (valNum) {
      case 2:
        return 'Normal / Berhasil Terkoneksi';
      case 3:
        return 'Koneksi Terputus (MPCP Down)';
      case 4:
        return 'Gangguan Link (OAM Down)';
      case 7:
        return 'Dimatikan dari OLT (Admin Down)';
      case 8:
        return 'Kabel Fiber Optik Putus (Wire Down)';
      case 9:
        return 'Mati Listrik / Adaptor Dicabut (Power Off)';
      case 255:
        return 'Penyebab tidak diketahui';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  return `Kode (${valNum})`;
}

// ─── MAIN: getOltStats ────────────────────────────────────────────────────────

async function limitConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

const statsCache = new Map();
const pendingPromises = new Map();
// Persistent HSGQ counter baselines; interface counters may update in coarse batches.
const hsgqTrafficSamples = new Map();

async function getOltStats(id, full = false) {
  const cacheKey = `${id}:${full}`;
  const now = Date.now();
  const cached = statsCache.get(cacheKey);
  const cacheDuration = full ? 15000 : 10000; // 15s cache for full table, 10s for summary

  if (cached && (now - cached.timestamp < cacheDuration)) {
    logger.info(`[oltService] Returning cached stats for OLT ${id} (full: ${full})`);
    return cached.data;
  }

  if (pendingPromises.has(cacheKey)) {
    logger.info(`[oltService] Coalescing concurrent stats request for OLT ${id} (full: ${full})`);
    return pendingPromises.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const result = await getOltStatsInternal(id, full);
      if (result && !result.error) {
        statsCache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });
      }
      return result;
    } finally {
      pendingPromises.delete(cacheKey);
    }
  })();

  pendingPromises.set(cacheKey, promise);
  return promise;
}

/**
 * Fast ONU inventory for the provisioning screen. Avoids unrelated chassis/unauthorized
 * OID walks that can keep the browser request open until the reverse proxy drops it.
 * Returns null for non-HSGQ devices so their existing vendor-specific path is unchanged.
 */
async function getConfiguredOnusForProvision(id) {
  const olt = getOltById(id);
  if (!olt) throw new Error(`OLT ID ${id} tidak ditemukan`);
  const brandKey = String(olt.brand || '').toLowerCase();
  if (!brandKey.includes('hsgq')) return null;

  const profile = (BRAND_PROFILES.hsgq || []).find(p => p.name === 'HSGQ_G008ID_SNMP');
  if (!profile) throw new Error('Profil SNMP HSGQ-G008ID belum tersedia');

  const session = snmp.createSession(olt.host, olt.snmp_community || 'public', {
    port: olt.snmp_port || 161,
    timeout: 4000,
    retries: 1,
    version: snmp.Version2c
  });
  const hardTimeout = setTimeout(() => { try { session.close(); } catch (_) {} }, 12000);
  try {
    const reachable = await probeOid(session, profile.probe_oid);
    if (!reachable) throw new Error(`OID ONU HSGQ tidak merespons pada ${olt.host}`);
    const [statusMap, nameMap, snMap, distanceMap, uptimeMap] = await Promise.all([
      slowWalk(session, profile.status_table),
      slowWalk(session, profile.name_table),
      slowWalk(session, profile.sn_table),
      profile.distance_table ? slowWalk(session, profile.distance_table) : Promise.resolve({}),
      profile.uptime_table ? slowWalk(session, profile.uptime_table) : Promise.resolve({})
    ]);
    const indices = [...new Set([...Object.keys(statusMap), ...Object.keys(nameMap), ...Object.keys(snMap)])];
    if (!indices.length) throw new Error('OLT merespons SNMP, tetapi tabel ONU HSGQ kosong');
    const onlineValues = getOnlineValues('hsgq', profile);
    const onus = indices.map(index => {
      const rawStatus = statusMap[index];
      const statusInt = bufferToInt(rawStatus);
      const statusText = rawStatus == null ? '' : String(rawStatus).trim().toLowerCase();
      const online = statusInt != null
        ? onlineValues.includes(statusInt)
        : ['online', 'up', 'on', 'operation', 'active', 'working'].includes(statusText);
      const rawName = nameMap[index];
      const name = rawName == null ? '' : String(rawName).replace(/\0/g, '').trim();
      const rawSn = snMap[index];
      const snValue = rawSn == null ? '-' : decodeSn(rawSn);
      const rawDistance = bufferToInt(distanceMap[index]);
      const distance = rawDistance != null && rawDistance > 0
        ? `${profile.distance_tenths_meter ? (rawDistance / 10).toFixed(1) : rawDistance} m`
        : '-';
      // HSGQ OID .21 is a textual last-online/start timestamp (e.g.
      // 2026/10/17 12:30:44+07:00), not SNMP TimeTicks. Convert it to elapsed
      // uptime for online ONUs; never display the raw date as a duration.
      let uptime = '-';
      const rawUptimeValue = uptimeMap[index];
      const uptimeText = Buffer.isBuffer(rawUptimeValue)
        ? rawUptimeValue.toString('utf8').replace(/\0/g, '').trim()
        : String(rawUptimeValue == null ? '' : rawUptimeValue).trim();
      const timeMatch = uptimeText.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:?\d{2})?$/);
      if (online && timeMatch) {
        const zone = timeMatch[7] || '+00:00';
        const iso = `${timeMatch[1]}-${timeMatch[2]}-${timeMatch[3]}T${timeMatch[4]}:${timeMatch[5]}:${timeMatch[6]}${zone.length === 5 ? zone.slice(0, 3) + ':' + zone.slice(3) : zone}`;
        const elapsed = Math.floor((Date.now() - Date.parse(iso)) / 1000);
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 10 * 365 * 86400) {
          const days = Math.floor(elapsed / 86400);
          const hours = Math.floor((elapsed % 86400) / 3600);
          const minutes = Math.floor((elapsed % 3600) / 60);
          uptime = `${days}d ${hours}h ${minutes}m`;
        }
      }
      return {
        index,
        id: hiosoOnuIdFromIndex(index) || index,
        name: name || `ONU-${index}`,
        sn: snValue || '-',
        status: online ? 'Online' : 'Offline',
        tx: 'N/A', rx: 'N/A', distance, firmware: '-', uptime,
        vendor: 'HSGQ'
      };
    });

    // Provisioning inventory previously used SNMP identity/status only, so the UI
    // always showed N/A for optical levels. Merge live readings from the tested HSGQ CLI
    // by serial number; do not associate readings by table index (the index formats differ).
    try {
      const cliRows = await fetchHiosoOnuDetailViaTelnet(olt, true);
      if (Array.isArray(cliRows) && cliRows.length) {
        const bySerial = new Map();
        for (const row of cliRows) {
          const key = hsgqSerialMatchKey(row.serialNumber || row.mac);
          if (key) bySerial.set(key, row);
        }
        let matchedOptics = 0;
        for (const onu of onus) {
          const live = bySerial.get(hsgqSerialMatchKey(onu.sn));
          if (!live) continue;
          if (live.rxPower && live.rxPower !== 'N/A') onu.rx = `${live.rxPower} dBm`;
          if (live.txPower && live.txPower !== 'N/A') onu.tx = `${live.txPower} dBm`;
          if (live.name && (!onu.name || /^ONU-/.test(onu.name))) onu.name = live.name;
          if (live.status) onu.status = live.status;
          // Keep the offline cause supplied by the OLT CLI when available.
          if (String(live.status || '').toLowerCase() === 'offline') {
            const rawReason = String(live.offlineReason || live.offline_reason || '').trim();
            onu.offline_reason = rawReason ? (translateOfflineReason('hsgq', rawReason) || rawReason) : '';
          } else {
            onu.offline_reason = '';
          }
          if (onu.rx !== 'N/A' || onu.tx !== 'N/A') matchedOptics++;
        }
        logger.info(`[oltService] HSGQ provisioning live optics OLT ${olt.id}: ${matchedOptics}/${onus.length} ONU matched by serial`);
      }
    } catch (e) {
      logger.warn(`[oltService] HSGQ provisioning optical CLI unavailable for OLT ${olt.id}: ${e.message}`);
    }
    // Skip slow per-ONU IP Config polling on the configured-ONU list so the page opens faster.
    return enrichOnusWithCustomerData(onus.sort((a, b) => a.name.localeCompare(b.name)));
  } finally {
    clearTimeout(hardTimeout);
    try { session.close(); } catch (_) {}
  }
}

async function getOltStatsInternal(id, full = false) {
  const olt = getOltById(id);
  if (!olt) return null;

  const stats = {
    id:          olt.id,
    name:        olt.name,
    host:        olt.host,
    brand:       olt.brand,
    status:      'Offline',
    error:       null,
    uptime:      'N/A',
    temp:        'N/A',
    cpu:         'N/A',
    ram:         'N/A',
    onus_total:  0,
    onus_online: 0,
    onus_offline: 0,
    onus_weak:   0,
    onus:        [],
    unauth_onus: [],
    cards:       [],
    voltage:     'N/A',
    uplink_rx:   0,
    uplink_tx:   0,
  };

  const community  = olt.snmp_community || 'public';
  const brandKey   = (olt.brand || 'hioso').toLowerCase();
  
  // Gabungkan semua profil untuk deteksi otomatis jika brand yang dipilih tidak cocok
  const selectedProfiles = (BRAND_PROFILES[brandKey] || []).map(p => ({ ...p, __brandKey: brandKey }));
  const otherProfiles = Object.keys(BRAND_PROFILES)
    .filter(k => k !== brandKey)
    .reduce((acc, k) => acc.concat((BRAND_PROFILES[k] || []).map(p => ({ ...p, __brandKey: k }))), []);
  const allAvailableProfiles = [...selectedProfiles, ...otherProfiles];

  const session = snmp.createSession(olt.host, community, {
    port:     olt.snmp_port || 161,
    timeout:  full ? 8000 : 5000,
    retries:  full ? 2 : 1,
    version:  snmp.Version2c,
  });

  session.on('error', (err) => {
    logger.warn(`[SNMP Session Error] OLT ${olt.host}: ${err.message}`);
  });

  let isResolved = false;

  return new Promise((resolve) => {
    const safeResolve = (data) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(globalTimeout);
      try { session.close(); } catch (e) {}
      resolve(data);
    };

    // HSGQ G008ID needs a CLI fallback; allow its multi-port read to finish instead of
    // aborting at 15s while serially probing unrelated vendor OIDs.
    const timeoutMs = brandKey === 'hsgq' ? (full ? 90000 : 60000) : (full ? 15000 : 10000);
    const globalTimeout = setTimeout(() => {
      stats.error = `Koneksi Timeout (${Math.round(timeoutMs / 1000)}s) - OLT ${olt.host} tidak merespons SNMP/Telnet`;
      safeResolve(stats);
    }, timeoutMs);

    (async () => {
      try {
        // 1. Cek koneksi dasar (Uptime)
        const uptimeVbs = await new Promise(rv => {
          session.get(['1.3.6.1.2.1.1.3.0'], (err, vbs) => {
            if (err) {
              stats.error = err.message;
              rv([]);
            } else rv(vbs);
          });
        });

        if (!uptimeVbs[0] || uptimeVbs[0].type === snmp.ObjectType.NoSuchObject || uptimeVbs[0].type === snmp.ObjectType.EndOfMibView) {
          // Telnet Fallback for HIOSO/HSGQ if SNMP is not enabled
          if (brandKey === 'hioso' || brandKey === 'hsgq') {
            const telnetData = await fetchHiosoOnuDetailViaTelnet(olt);
            if (telnetData && telnetData.length > 0) {
              stats.status = 'Online';
              stats.error = null;
              stats.onus_total = telnetData.length;
              stats.onus_online = telnetData.filter(r => String(r.status).toLowerCase().includes('on')).length;
              stats.onus_offline = stats.onus_total - stats.onus_online;
              if (full) {
                stats.onus = telnetData.map((r, idx) => ({
                  index: r.id || idx,
                  id: r.id || '-',
                  name: r.name || r.mac || `ONU-${idx+1}`,
                  sn: r.mac || '-',
                  serialNumber: r.serialNumber || r.mac || '-',
                  vendor: r.vendor || hsgqSerialVendor(r.mac),
                  status: String(r.status).toLowerCase().includes('on') ? 'Online' : 'Offline',
                  offline_reason: translateOfflineReason(brandKey, r.offlineReason),
                  tx: r.txPower || 'N/A',
                  rx: r.rxPower || 'N/A',
                  distance: r.distance || '-',
                  firmware: r.fwVersion || '-',
                  uptime: r.onlineTime || '-'
                }));
              }
              safeResolve(stats);
              return;
            }
          }

          stats.error = `Tidak dapat terhubung ke OLT ${olt.host}:${olt.snmp_port || 161} (${stats.error || 'Offline / Socket Closed'}). Pastikan IP OLT aktif & Community string ('${community}') benar.`;
          safeResolve(stats);
          return;
        }

        stats.uptime = decodeUptime(uptimeVbs[0].value);
        stats.status = 'Online';

        // 3. Deteksi profil yang cocok
        let activeProfile = null;
        for (const profile of allAvailableProfiles) {
          const ok = await probeOid(session, profile.probe_oid);
          if (ok) {
            activeProfile = profile;
            break;
          }
        }

        if (!activeProfile) {
          // Telnet Fallback if profile not matched
          if (brandKey === 'hioso' || brandKey === 'hsgq') {
            const telnetData = await fetchHiosoOnuDetailViaTelnet(olt);
            if (telnetData && telnetData.length > 0) {
              stats.status = 'Online';
              stats.error = null;
              stats.onus_total = telnetData.length;
              stats.onus_online = telnetData.filter(r => String(r.status).toLowerCase().includes('on')).length;
              stats.onus_offline = stats.onus_total - stats.onus_online;
              if (full) {
                stats.onus = telnetData.map((r, idx) => ({
                  index: r.id || idx,
                  id: r.id || '-',
                  name: r.name || r.mac || `ONU-${idx+1}`,
                  sn: r.mac || '-',
                  serialNumber: r.serialNumber || r.mac || '-',
                  vendor: r.vendor || hsgqSerialVendor(r.mac),
                  status: String(r.status).toLowerCase().includes('on') ? 'Online' : 'Offline',
                  offline_reason: translateOfflineReason(brandKey, r.offlineReason),
                  tx: r.txPower || 'N/A',
                  rx: r.rxPower || 'N/A',
                  distance: r.distance || '-',
                  firmware: r.fwVersion || '-',
                  uptime: r.onlineTime || '-'
                }));
              }
              safeResolve(stats);
              return;
            }
          }

          stats.error = `Brand/Profile OID tidak cocok dengan perangkat OLT ${olt.host}. Silakan ganti Brand di menu 'Edit OLT'.`;
          safeResolve(stats);
          return;
        }

        const detectedBrandKey = activeProfile.__brandKey || brandKey;
        stats.activeProfile = activeProfile;
        stats.systemOids = SYSTEM_OIDS[detectedBrandKey] || null;
        stats.cardOids = CARD_OIDS[detectedBrandKey] || null;
        stats.snmpConfig = {
          host: olt.host,
          port: olt.snmp_port || 161,
          community: olt.snmp_community || 'public',
          brand: olt.brand
        };
        const onlineVals = getOnlineValues(detectedBrandKey, activeProfile);

        // System metrics use the same SNMP session as the detailed walks. Run them
        // after those walks finish; concurrent GET/WALK traffic made HSGQ counters
        // return stale/zero deltas in full dashboard mode.

        // 4. Mode Counter (ZTE)
        if (activeProfile.is_counter) {
          const [onlineMap, totalMap] = await Promise.all([
            slowWalk(session, activeProfile.status_table),
            slowWalk(session, activeProfile.name_table)
          ]);

          stats.onus_online  = Object.values(onlineMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_total   = Object.values(totalMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_offline = Math.max(0, stats.onus_total - stats.onus_online);

          await fetchSystemMetrics(session, detectedBrandKey, stats, olt.id, olt);
          safeResolve(stats);
          return;
        }

        // 5. Mode Table (Hioso, VSOL, HSGQ, etc)
        const [statusMap, nameMap] = await Promise.all([
          slowWalk(session, activeProfile.status_table),
          slowWalk(session, activeProfile.name_table)
        ]);

        let snMap = {};
        let rxMap = {};
        let txMap = {};
        let distMap = {};
        let fwMap = {};
        let upMap = {};
        let reasonMap = {};

        // OPTIMIZATION: Only fetch detailed metrics if full=true
        // Summary mode: skip rx/tx/distance/firmware/uptime/reason walks
        // This makes summary 5-10x faster
        if (full) {
          const tasks = [];

          // Walk OLT cards & unauth ONUs
          tasks.push(() => fetchCardMetrics(session, detectedBrandKey, stats));
          tasks.push(() => fetchUnauthOnus(session, activeProfile, stats));

          // 1. Pick SN Table
          tasks.push(() => pickSnTable(session, activeProfile).then(res => snMap = res.map || {}));

          // 2. Rx Power
          if (activeProfile.rx_power_table) {
            tasks.push(() => slowWalk(session, activeProfile.rx_power_table).then(res => rxMap = res));
          }
          // 3. Tx Power
          if (activeProfile.tx_power_table) {
            tasks.push(() => slowWalk(session, activeProfile.tx_power_table).then(res => txMap = res));
          }
          // 4. Distance
          if (activeProfile.distance_table) {
            tasks.push(() => slowWalk(session, activeProfile.distance_table).then(res => distMap = res));
          }
          // 5. Firmware
          if (activeProfile.firmware_table) {
            tasks.push(() => slowWalk(session, activeProfile.firmware_table).then(res => fwMap = res));
          }
          // 6. Uptime
          if (activeProfile.uptime_table) {
            tasks.push(() => slowWalk(session, activeProfile.uptime_table).then(res => upMap = res));
          }
          // 7. Offline Reason
          if (activeProfile.offline_reason_table) {
            tasks.push(() => slowWalk(session, activeProfile.offline_reason_table).then(res => reasonMap = res));
          }

          // OPTIMIZATION: Tune concurrency per brand
          // ZTE handles 5, others 3-4
          const concurrencyMap = {
            'zte': 5,
            'huawei': 4,
            'hioso': 3,
            'vsol': 4,
            'cdata': 3,
            'hsgq': 3
          };
          const concurrency = concurrencyMap[detectedBrandKey] || 4;
          await limitConcurrency(tasks, concurrency);
        }

        await fetchSystemMetrics(session, detectedBrandKey, stats, olt.id, olt);

        const allIndices = new Set([...Object.keys(statusMap), ...Object.keys(nameMap)]);
        stats.onus_total = allIndices.size;
        
        const onus = [];
        let weakCount = 0;

        for (const idx of allIndices) {
          const stRaw = getByIdx(statusMap, idx);
          const stInt = bufferToInt(stRaw);
          const stStr = stRaw == null ? '' : String(stRaw).trim().toLowerCase();
          const isUp = stInt != null
            ? onlineVals.includes(stInt)
            : (stStr === 'online' || stStr === 'up' || stStr === 'on' || stStr === 'operation');

          const nameRaw = getByIdx(nameMap, idx);
          const nameStr = nameRaw == null ? '' : String(nameRaw).replace(/\0/g, '').trim();
          const name = nameStr || ('ONU-' + idx);
          const snVal = getByIdx(snMap, idx);
          const rxVal = getByIdx(rxMap, idx);
          const txVal = getByIdx(txMap, idx);
          const distVal = getByIdx(distMap, idx);
          const fwVal = getByIdx(fwMap, idx);
          const upVal = getByIdx(upMap, idx);

          const sn   = snVal ? decodeSn(snVal) : '-';
          const rx   = decodeRxPower(detectedBrandKey, rxVal);
          const tx   = decodeRxPower(detectedBrandKey, txVal);
          const distInt = bufferToInt(distVal);
          let distance = '-';
          if (activeProfile.distance_table && distInt != null && distInt > 0) {
            const tenths = activeProfile.distance_tenths_meter !== false;
            distance = tenths ? (distInt / 10).toFixed(1) + ' m' : `${distInt} m`;
          }
          const firmware = safeToString(fwVal) || '-';
          const onuUptime = upVal ? decodeUptime(bufferToInt(upVal)) : '-';
          const onuId = hiosoOnuIdFromIndex(idx);
          
          if (isUp) stats.onus_online++;
          else stats.onus_offline++;

          if (rx !== 'N/A') {
            const n = parseFloat(rx);
            if (Number.isFinite(n) && n < -27) weakCount++;
          }

          if (full) {
            const rxShown = rx === 'N/A' ? rx : rx + ' dBm';
            const txShown = tx === 'N/A' ? tx : tx + ' dBm';

            const rawReason = getByIdx(reasonMap, idx);
            const offlineReason = translateOfflineReason(detectedBrandKey, rawReason);

            onus.push({
              index: idx,
              id: onuId || '-',
              name,
              sn,
              serialNumber: sn,
              vendor: detectedBrandKey === 'hsgq' ? hsgqSerialVendor(sn) : 'Unknown',
              status: isUp ? 'Online' : 'Offline',
              offline_reason: isUp ? null : (offlineReason || null),
              tx: txShown,
              rx: rxShown,
              distance,
              firmware,
              uptime: onuUptime
            });
          }
        }

        stats.onus_weak = weakCount;
        stats.onus = enrichOnusWithCustomerData(onus.sort((a, b) => a.name.localeCompare(b.name)));

        // HSGQ SNMP column 3 is not a trustworthy live-state column.
        // The CLI parser is based on the verified PON/ONU, Type, Serial, State, Run State columns.
        if (brandKey === 'hsgq') {
          const liveCliRows = await fetchHiosoOnuDetailViaTelnet(olt, full);
          if (Array.isArray(liveCliRows) && liveCliRows.length > 0) {
            if (!full) {
              // Summary requests have no ONU array to correlate; use the parsed live CLI states.
              stats.onus_total = liveCliRows.length;
              stats.onus_online = liveCliRows.filter(r => r.status === 'Online').length;
              stats.onus_offline = liveCliRows.length - stats.onus_online;
              logger.info('[oltService] HSGQ summary counts sourced from live CLI for OLT ' + olt.id);
            } else if (Array.isArray(stats.onus)) {
              const liveBySn = new Map();
              for (const row of liveCliRows.filter(r => r.mac)) {
                liveBySn.set(hsgqSerialMatchKey(row.mac), row);
              }
              let matched = 0;
              const mergedOnus = stats.onus.map(onu => {
                const live = liveBySn.get(hsgqSerialMatchKey(onu.serialNumber || onu.sn));
                if (!live) return onu;
                matched++;
                const tx = live.txPower && live.txPower !== 'N/A' ? `${live.txPower} dBm` : onu.tx;
                const rx = live.rxPower && live.rxPower !== 'N/A' ? `${live.rxPower} dBm` : onu.rx;
                return { ...onu, id: live.id || onu.id, serialNumber: live.serialNumber || live.mac || onu.sn, vendor: live.vendor || hsgqSerialVendor(live.mac), status: live.status, tx, rx, temperature: live.temperature || onu.temperature, oltRxPower: live.oltRxPower || 'N/A', offline_reason: live.status === 'Offline' ? translateOfflineReason('hsgq', live.offlineReason) : null };
              });
              const coverage = stats.onus.length ? matched / stats.onus.length : 0;
              if (coverage >= 0.5) {
                stats.onus = mergedOnus;
                stats.onus_total = mergedOnus.length;
                stats.onus_online = mergedOnus.filter(r => r.status === 'Online').length;
                stats.onus_offline = mergedOnus.length - stats.onus_online;
                // HSGQ optical power is read from CLI, not the generic SNMP profile.
                // Recalculate weak-signal count AFTER merging the live CLI RX values;
                // otherwise the earlier SNMP-only pass incorrectly leaves this at zero.
                stats.onus_weak = mergedOnus.reduce((count, row) => {
                  const rxValue = row.rx == null ? NaN : parseFloat(String(row.rx));
                  return count + (Number.isFinite(rxValue) && rxValue < -27 ? 1 : 0);
                }, 0);
                logger.info('[oltService] HSGQ CLI state merged for OLT ' + olt.id + ': ' + matched + '/' + stats.onus.length + ' serials matched; weak RX=' + stats.onus_weak);
              } else {
                logger.warn('[oltService] HSGQ CLI state ignored for OLT ' + olt.id + ': only ' + matched + '/' + stats.onus.length + ' serials matched; retaining SNMP-derived list/counts');
              }
            }
          } else {
            logger.warn('[oltService] HSGQ CLI live-state override unavailable for OLT ' + olt.id + '; retaining SNMP-derived list/counts');
          }
        }
        safeResolve(stats);
      } catch (err) {
        stats.error = err.message;
        safeResolve(stats);
      }
    })();
  });
}

function enrichOnusWithCustomerData(onus) {
  if (!Array.isArray(onus) || onus.length === 0) return onus;
  try {
    const custs = db.prepare(`
      SELECT id, name, pppoe_username, mac_address, genieacs_tag, phone
      FROM customers
    `).all() || [];

    const pppoeMap = new Map();
    const macMap = new Map();
    const tagMap = new Map();
    const nameMap = new Map();
    const customerById = new Map(custs.map(c => [Number(c.id), c]));
    const jobBySerial = new Map();

    // Provisioning jobs are the strongest binding: an ONU name can be duplicated
    // across customers, but its normalized serial should identify one customer.
    try {
      const jobs = db.prepare(`
        SELECT customer_id, onu_sn FROM tech_onu_jobs
        WHERE onu_sn IS NOT NULL AND TRIM(onu_sn) <> ''
        ORDER BY updated_at DESC, created_at DESC
      `).all() || [];
      for (const job of jobs) {
        const key = String(job.onu_sn || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (key && !jobBySerial.has(key)) jobBySerial.set(key, Number(job.customer_id));
      }
    } catch (_) { /* Older database schemas may not have provisioning jobs. */ }

    for (const c of custs) {
      if (c.pppoe_username) pppoeMap.set(String(c.pppoe_username).trim().toLowerCase(), c);
      if (c.mac_address) {
        const rawMac = String(c.mac_address).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (rawMac) macMap.set(rawMac, c);
      }
      if (c.genieacs_tag) tagMap.set(String(c.genieacs_tag).trim().toLowerCase(), c);
      if (c.name) {
        const key = String(c.name).trim().toLowerCase();
        // Never let a duplicate customer name silently overwrite another customer.
        if (nameMap.has(key)) nameMap.set(key, null);
        else nameMap.set(key, c);
      }
    }

    for (const onu of onus) {
      const snClean = String(onu.sn || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const nameClean = String(onu.name || '').trim().toLowerCase();

      let matched = null;
      const jobCustomerId = snClean ? jobBySerial.get(snClean) : null;
      if (jobCustomerId && customerById.has(jobCustomerId)) matched = customerById.get(jobCustomerId);
      else if (snClean && macMap.has(snClean)) matched = macMap.get(snClean);
      else if (snClean && tagMap.has(snClean)) matched = tagMap.get(snClean);
      else if (nameClean && pppoeMap.has(nameClean) && nameMap.get(nameClean) && nameMap.get(nameClean).id === pppoeMap.get(nameClean).id) matched = pppoeMap.get(nameClean);
      else if (nameClean && nameMap.get(nameClean)) matched = nameMap.get(nameClean);
      else if (snClean.length >= 6) {
        for (const [mac, c] of macMap.entries()) {
          if (mac.length >= 8 && (snClean.includes(mac) || mac.includes(snClean))) {
            matched = c;
            break;
          }
        }
      }

      if (matched) {
        onu.customer_id = matched.id;
        onu.customer_name = matched.name;
        onu.customer_phone = matched.phone || null;
      }
    }
  } catch (e) {
    logger.warn(`[OLT] Error enriching ONUs with customer data: ${e.message}`);
  }
  return onus;
}

// ─── ONU ACTIONS ─────────────────────────────────────────────────────────────

function decodeOltSnmpIndex(brand, index) {
  const idxNum = parseInt(index, 10);
  if (!Number.isFinite(idxNum)) {
    const s = String(index || '');
    let frame = '0', board = '1', port = '1', onuId = '1';
    const parts = s.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
    return { frame, board, port, onuId };
  }

  const bKey = String(brand || '').toLowerCase();
  if (bKey === 'zte') {
    const board = (idxNum >> 16) & 0xFF;
    const port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: '0', board: String(board), port: String(port), onuId: String(onuId) };
  } else if (bKey === 'huawei') {
    const frame = (idxNum >> 21) & 0x1F;
    const slot = (idxNum >> 16) & 0x1F;
    const port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: String(frame), board: String(slot), port: String(port), onuId: String(onuId) };
  } else {
    let port = (idxNum >> 16) & 0xFF;
    if (port === 0 || port > 16) port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: '0', board: '0', port: String(port), onuId: String(onuId) };
  }
}

async function rebootOnu(oltId, index) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  if (brand === 'zte' || brand === 'huawei') {
    const onuProvisionSvc = require('./onuProvisionService');
    const oltConfig = {
      vendor: olt.brand,
      host: olt.host,
      username: olt.web_user,
      password: olt.web_password
    };
    const portVal = parseInt(olt.telnet_port, 10);
    oltConfig.port = (Number.isFinite(portVal) && portVal > 0) ? portVal : 22;
    
    const parsed = decodeOltSnmpIndex(olt.brand, index);
    return await onuProvisionSvc.rebootONU(oltConfig, olt.brand, parsed);
  }

  const community = olt.snmp_community || 'public';
  const session = snmp.createSession(olt.host, community, { port: olt.snmp_port || 161, version: snmp.Version2c });
  const oid = `1.3.6.1.4.1.25355.3.2.6.3.2.1.40.${index}`;
  return new Promise((resolve, reject) => {
    session.set([{ oid, type: snmp.ObjectType.Integer, value: 1 }], (error) => {
      session.close();
      if (error) reject(error);
      else resolve(true);
    });
  });
}

// Reboot one HSGQ ONT through Telnet CLI after proving the SN still occupies the requested PON/ONU ID.
async function rebootOnuViaCli(oltId, index, serial) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  if (String(olt.brand || '').toLowerCase() !== 'hsgq') {
    throw new Error('Reboot via CLI hanya diaktifkan untuk driver HSGQ yang sudah diverifikasi.');
  }
  const parsed = String(index || '').trim().match(/^\d+\/([1-8]):(\d+)$/);
  if (!parsed) throw new Error('Indeks OLT tidak valid; diperlukan format 0/PON:ONU-ID.');
  const pon = Number(parsed[1]);
  const onuId = Number(parsed[2]);
  if (!Number.isInteger(onuId) || onuId < 0 || onuId > 127) throw new Error('ONU ID di luar rentang CLI HSGQ 0–127.');
  const wanted = normalizeAcsSerialTokens(serial);
  if (!wanted || !String(serial || '').trim()) throw new Error('SN ONT wajib diisi untuk memverifikasi target reboot.');

  const onuProvisionSvc = require('./onuProvisionService');
  const config = {
    host: String(olt.host || '').trim(),
    port: Number(olt.telnet_port || 23),
    username: String(olt.cli_user || olt.web_user || '').trim(),
    password: String(olt.cli_password || olt.web_password || ''),
    enablePassword: String(olt.enable_password || '')
  };
  if (!config.host || !config.username || !config.password) {
    throw new Error('Kredensial CLI/Telnet OLT belum lengkap.');
  }
  // Verify the target from the compact per-PON ONU table. The full running-config
  // repeatedly timed out on this OLT even though show ont-info all is supported by
  // the binding flow; using the live table avoids a large paginated read before reboot.
  const statusOutput = await onuProvisionSvc.runHSGQTelnet(config, [
    'enable', 'configure', 'interface gpon ' + pon, 'show ont-info all'
  ]);
  const clean = String(statusOutput || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '').replace(/\r/g, '');
  if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|Connection timed out|Unable to connect)/i.test(clean) ||
      !/PON\/ONU/i.test(clean)) {
    throw new Error('Daftar ONT pada PON ' + pon + ' tidak dapat diverifikasi; reboot dibatalkan.');
  }
  const sameSerial = value => {
    const forms = normalizeAcsSerialTokens(value);
    return [...wanted].some(token => forms.has(token));
  };
  const matches = [];
  for (const line of clean.split('\n')) {
    const row = line.trim().match(/^(\d+)\/(\d+)\s+(?:GPON|EPON)\s+([A-Z0-9-]{8,16})\s+\S+\s+\S+/i);
    if (!row || Number(row[1]) !== pon || !sameSerial(row[3])) continue;
    matches.push({ pon: Number(row[1]), onuId: Number(row[2]), sn: row[3].toUpperCase() });
  }
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? 'SN ONT ditemukan lebih dari sekali pada tabel ONU PON; reboot dibatalkan.'
      : 'SN ONT tidak ditemukan pada tabel ONU PON; reboot dibatalkan.');
  }
  if (matches[0].pon !== pon || matches[0].onuId !== onuId) {
    throw new Error('SN ONT tidak cocok dengan PON/ONU-ID tersimpan; reboot dibatalkan.');
  }

  const output = await onuProvisionSvc.runHSGQTelnet(config, [
    'enable', 'configure', `interface gpon ${pon}`, `ont reboot ${onuId}`
  ]);
  const safeOutput = String(output || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '');
  if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|\b(?:failed|failure|error)\b)/i.test(safeOutput)) {
    throw new Error('OLT tidak mengonfirmasi perintah reboot CLI: ' + safeOutput.trim().slice(-260));
  }
  return { success: true, message: `Perintah reboot CLI dikirim untuk SN ${matches[0].sn} pada PON ${pon}, ONU ${onuId}.` };
}

async function renameOnu(oltId, index, newName) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  if (brand === 'zte' || brand === 'huawei') {
    const onuProvisionSvc = require('./onuProvisionService');
    const oltConfig = {
      vendor: olt.brand,
      host: olt.host,
      username: olt.web_user,
      password: olt.web_password
    };
    const portVal = parseInt(olt.telnet_port, 10);
    oltConfig.port = (Number.isFinite(portVal) && portVal > 0) ? portVal : 22;
    
    const parsed = decodeOltSnmpIndex(olt.brand, index);
    parsed.newName = newName;
    return await onuProvisionSvc.renameONU(oltConfig, olt.brand, parsed);
  }

  const community = olt.snmp_community || 'public';
  const session = snmp.createSession(olt.host, community, { port: olt.snmp_port || 161, version: snmp.Version2c });
  const oid = `1.3.6.1.4.1.25355.3.2.6.3.2.1.37.${index}`;
  return new Promise((resolve, reject) => {
    session.set([{ oid, type: snmp.ObjectType.OctetString, value: newName }], (error) => {
      session.close();
      if (error) reject(error);
      else resolve(true);
    });
  });
}

/**
 * Otorisasi ONU (Provisioning) via Telnet CLI.
 */
async function authorizeOnu(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  const { index, sn, name, vlan } = data;
  const snCli = normalizeSnForOltProvision(sn);

  // Parsing index (format ZTE: 1/board/port:onuId)
  let board = 1, port = 1, onuId = 1;
  if (index.includes('/')) {
    const parts = index.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
  }

  const cmds = [];
  if (brand === 'zte') {
    cmds.push('enable');
    cmds.push('configure terminal');
    cmds.push(`interface gpon-olt_1/${board}/${port}`);
    cmds.push(`onu ${onuId} type ALL sn ${snCli}`);
    cmds.push('exit');
    cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
    if (name) cmds.push(`name ${name}`);
    cmds.push('tcont 1 profile UP-100M'); // Default profile
    cmds.push('gemport 1 tcont 1');
    if (vlan) cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    cmds.push('exit');
    cmds.push('end');
    cmds.push('write');
  } else if (brand === 'huawei') {
    cmds.push('enable');
    cmds.push('config');
    cmds.push(`interface gpon 0/${board}`);
    cmds.push(`ont add ${port} ${onuId} sn-auth ${snCli} omci ont-lineprofile-id 1 ont-srvprofile-id 1`);
    if (name) cmds.push(`ont name ${port} ${onuId} "${name}"`);
    cmds.push('quit');
    if (vlan) cmds.push(`service-port vlan ${vlan} gpon 0/${board}/${port} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
    cmds.push('save');
  } else {
    throw new Error(`Fitur otorisasi otomatis belum didukung untuk brand ${brand}`);
  }

  return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
}

/**
 * Read IP host configuration directly from HSGQ OLT CLI (read-only show command).
 * HSGQ-G008ID: interface gpon N -> show ont ipconfig ONT-ID.
 */
async function enrichOnusWithOltIpConfig(olt, onus) {
  const normalizeCli = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '').replace(/\r/g, '');
  const grouped = new Map();
  for (const onu of onus) {
    // Provision inventory ID is formatted like 0/1:31 (PON 1, ONU ID 31).
    const m = String(onu.id || '').match(/^\d+\/(\d+):(\d+)$/);
    if (!m) continue;
    const pon = Number(m[1]);
    const onuId = Number(m[2]);
    if (pon < 1 || pon > 8 || onuId < 0 || onuId > 127) continue;
    if (!grouped.has(pon)) grouped.set(pon, []);
    grouped.get(pon).push({ onu, onuId });
  }

  const host = String(olt.host || '').trim();
  const username = String(getSetting('olt_username', '') || '').trim();
  const password = String(getSetting('olt_password', '') || '');
  if (!host || !username || !password) {
    logger.warn(`[oltService] OLT IP config skipped for OLT ${olt.id}: Telnet credentials unavailable`);
    return onus;
  }

  let success = 0;
  let failed = 0;
  const driver = require('./onuProvisionService');
  for (const [pon, allEntries] of grouped.entries()) {
    const entries = allEntries.filter(entry => String(entry.onu.status || '').toLowerCase() === 'online');
    for (const entry of allEntries.filter(entry => !entries.includes(entry))) {
      entry.onu.ip_config = { source: 'OLT HSGQ-G008ID', status: 'ONU offline, IP config ora diwaca', hosts: [], ip: '', type: '', vlan: '', mask: '', gateway: '', primary_dns: '', secondary_dns: '' };
    }
    if (!entries.length) continue;
    try {
      const commands = ['enable', 'configure', `interface gpon ${pon}`];
      for (const entry of entries) commands.push(`show ont ipconfig ${entry.onuId}`);
      commands.push('exit');
      const raw = normalizeCli(await driver.runHSGQTelnet({ host, port: 23, username, password }, commands));
      // Split on the echoed command so every ONU is associated with its own IP Host table.
      const chunks = raw.split(/show\s+ont\s+ipconfig\s+(\d+)/ig);
      const byId = new Map();
      for (let i = 1; i < chunks.length; i += 2) {
        const onuId = Number(chunks[i]);
        const body = chunks[i + 1] || '';
        const hosts = [];
        for (const line of body.split('\n')) {
          const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+((?:\d{1,3}\.){3}\d{1,3})\s+((?:\d{1,3}\.){3}\d{1,3})\s+((?:\d{1,3}\.){3}\d{1,3})\s+((?:\d{1,3}\.){3}\d{1,3})\s+((?:\d{1,3}\.){3}\d{1,3})\s*$/);
          if (!row) continue;
          hosts.push({
            index: Number(row[1]), vlan: Number(row[2]), type: row[3],
            ip: row[4], mask: row[5], gateway: row[6], primary_dns: row[7], secondary_dns: row[8]
          });
        }
        byId.set(onuId, hosts);
      }
      for (const entry of entries) {
        const hosts = byId.get(entry.onuId) || [];
        const validHosts = hosts.filter(h => h.ip !== '0.0.0.0' && h.type.toLowerCase() !== 'none');
        const primary = validHosts.find(h => h.type.toLowerCase() === 'dhcp' || h.type.toLowerCase() === 'static') || validHosts[0] || null;
        entry.onu.ip_config = {
          source: 'OLT HSGQ-G008ID',
          status: hosts.length ? 'Data diwaca langsung dari OLT' : 'Ora ana data IP saka OLT',
          hosts,
          ip: primary?.ip || '',
          type: primary?.type || '',
          vlan: primary?.vlan ?? '',
          mask: primary?.mask || '',
          gateway: primary?.gateway || '',
          primary_dns: primary?.primary_dns || '',
          secondary_dns: primary?.secondary_dns || ''
        };
        success++;
      }
    } catch (e) {
      failed += entries.length;
      for (const entry of entries) {
        entry.onu.ip_config = { source: 'OLT HSGQ-G008ID', status: 'Gagal membaca OLT', hosts: [], ip: '', type: '', vlan: '', mask: '', gateway: '', primary_dns: '', secondary_dns: '' };
      }
      logger.warn(`[oltService] OLT IP config CLI failed on PON ${pon}: ${e.message}`);
    }
  }
  logger.info(`[oltService] HSGQ direct OLT IP config OLT ${olt.id}: ${success} online ONU checked, ${failed} failed`);
  return onus;
}

/**
 * Cari data tambahan ONU dari ACS (WiFi, Client Count, dll)
 */
async function enrichOnusWithAcsData(onus) {
  try {
    logger.info(`[ACS-Sync] Memulai sinkronisasi data untuk ${onus.length} ONU`);
    const acsDevices = await genieacs.getDevices();
    if (!acsDevices || !acsDevices.length) {
      logger.warn('[ACS-Sync] Tidak ada perangkat ditemukan di GenieACS');
      return onus;
    }

    const normalizeSN = (sn) => String(sn || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

    for (const onu of onus) {
      const targetSn = normalizeSN(onu.sn);
      if (!targetSn || targetSn === '-') continue;

      logger.debug(`[ACS-Sync] Mencari SN: ${targetSn}`);

      // Cari device di ACS berdasarkan SN (fuzzy match)
      const acsDev = acsDevices.find(d => {
        const sn1 = d.Device?.DeviceInfo?.SerialNumber?._value;
        const sn2 = d.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value;
        const sn3 = d._id;
        
        const acsSn = normalizeSN(sn1 || sn2 || sn3);
        const match = acsSn.includes(targetSn) || targetSn.includes(acsSn);
        if (match) logger.info(`[ACS-Sync] Match Found: ${targetSn} matches ${acsSn} (ID: ${d._id})`);
        return match;
      });

      if (acsDev) {
        // Ambil SSID (Cek beberapa path umum)
        const ssid = 
          acsDev.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value ||
          acsDev.Device?.WiFi?.SSID?.['1']?.SSID?._value || 
          acsDev.Device?.WiFi?.SSID?.['1']?.SSID || 
          acsDev.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['5']?.SSID?._value || '-';
        
        onu.wifi_ssid = ssid;
        
        // Hitung Client Connected (Sum up all radios if possible)
        let associations = 0;
        const paths = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
          'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
          'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries',
          'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
          'Device.Hosts.HostNumberOfEntries'
        ];

        for (const p of paths) {
          const val = getNestedValue(acsDev, p);
          if (val !== undefined && val !== null) {
            associations += parseInt(val) || 0;
          }
        }
        
        onu.client_count = associations;
        onu.acs_id = acsDev._id;
        logger.info(`[ACS-Sync] Updated ${onu.sn}: SSID=${onu.wifi_ssid}, Users=${onu.client_count}`);
      }
    }
  } catch (e) {
    logger.error(`[ACS-Sync] Error: ${e.message}`);
  }
  return onus;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((prev, curr) => {
    if (prev && prev[curr] !== undefined) {
      const val = prev[curr];
      return (val && val._value !== undefined) ? val._value : val;
    }
    return undefined;
  }, obj);
}

function parseZteOnuIndex(index) {
  let board = 1;
  let port = 1;
  let onuId = 1;
  const s = String(index || '');
  if (s.includes('/')) {
    const parts = s.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
  }
  return { board: String(board), port: String(port), onuId: String(onuId) };
}

const telnetOptsFromOlt = (olt) => ({
  port: Number(olt.telnet_port) > 0 ? Number(olt.telnet_port) : 23,
  enablePassword: olt.enable_password != null && String(olt.enable_password).length > 0 ? String(olt.enable_password) : null
});

/**
 * Delegasi VLAN / service-port ke [go-api-c320](https://github.com/s4lfanet/go-api-c320) — POST /api/v1/vlan/onu
 * Format pon_port: rack/shelf/slot (contoh 1/2/7) dari indeks gpon-onu_1/2/7:5
 */
async function configureZteWanViaGoApi(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const base = String(olt.api_base_url || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('Isi "API Base URL" pada data OLT (contoh http://10.0.0.5:8081) agar metode Go API dapat memanggil go-api-c320.');
  }

  const mode = String(data.mode || 'Bridge');
  if (mode === 'PPPoE') {
    throw new Error('Integrasi REST ini memetakan ke VLAN/service-port go-api-c320. Untuk PPPoE gunakan Telnet CLI (OMCI) atau TR069.');
  }

  const { board, port, onuId } = parseZteOnuIndex(data.index);
  const ponPort = `1/${board}/${port}`;
  if (!/^\d+\/\d+\/\d+$/.test(ponPort)) {
    throw new Error('Indeks ONU tidak valid untuk Go API (butuh slot/port/onu, mis. gpon-onu_1/2/7:5 → pon_port 1/2/7).');
  }

  const onu_id = parseInt(String(onuId), 10);
  if (!Number.isFinite(onu_id) || onu_id < 1 || onu_id > 128) {
    throw new Error('ONU ID tidak valid (1–128).');
  }

  const svlan = parseInt(String(data.vlan != null ? data.vlan : data.svlan), 10);
  const cvlanIn = data.cvlan != null && String(data.cvlan).trim() !== '' ? parseInt(String(data.cvlan), 10) : NaN;
  const cvlan = Number.isFinite(cvlanIn) ? cvlanIn : svlan;

  if (!Number.isFinite(svlan) || svlan < 1 || svlan > 4094) {
    throw new Error('VLAN / SVLAN harus antara 1 dan 4094.');
  }

  const vlan_mode = String(data.vlan_mode || 'tag').toLowerCase();
  const allowed = ['tag', 'translation', 'transparent'];
  if (!allowed.includes(vlan_mode)) {
    throw new Error('vlan_mode harus: tag, translation, atau transparent (sesuai go-api-c320).');
  }

  if (vlan_mode === 'translation' && (!Number.isFinite(cvlan) || cvlan < 1)) {
    throw new Error('Mode translation membutuhkan CVLAN.');
  }

  const priority = Number.isFinite(parseInt(data.priority, 10)) ? parseInt(data.priority, 10) : 0;
  if (priority < 0 || priority > 7) {
    throw new Error('Priority harus 0–7.');
  }

  const url = `${base}/api/v1/vlan/onu`;
  const body = {
    pon_port: ponPort,
    onu_id,
    svlan,
    cvlan: vlan_mode === 'translation' ? cvlan : (Number.isFinite(cvlan) ? cvlan : svlan),
    vlan_mode,
    priority
  };

  const res = await axios.post(url, body, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });

  const payload = res.data;
  const httpOk = res.status >= 200 && res.status < 300;
  const apiCode = payload != null && payload.code != null ? Number(payload.code) : null;
  if (!httpOk || (apiCode != null && apiCode >= 400)) {
    const msg = payload?.message || payload?.status || payload?.error || `HTTP ${res.status}`;
    throw new Error(`go-api-c320: ${msg}`);
  }

  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

/**
 * Konfigurasi WAN ONU via TR069 (GenieACS).
 */
// Track ACS AddObject requests for Binding Saja. AddObject is asynchronous, so
// repeatedly requesting it while ACS has not reported the new PPP object can create
// duplicate WAN interfaces. The record is scoped to one customer and exact ONU SN.
db.exec(`
  CREATE TABLE IF NOT EXISTS tech_onu_acs_wan_jobs (
    customer_id INTEGER PRIMARY KEY,
    onu_sn TEXT NOT NULL,
    acs_device_id TEXT NOT NULL DEFAULT '',
    acs_server_id TEXT,
    stage TEXT NOT NULL DEFAULT 'pending',
    last_message TEXT NOT NULL DEFAULT '',
    addobject_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
try {
  db.prepare(`
    INSERT INTO tech_onu_acs_wan_jobs
      (customer_id,onu_sn,stage,last_message,addobject_sent_at,created_at,updated_at)
    SELECT j.customer_id,j.onu_sn,'addobject_sent',j.last_message,j.updated_at,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM tech_onu_jobs j
    WHERE j.status='pending' AND UPPER(COALESCE(j.onu_vendor,''))='FIBERHOME'
      AND j.onu_sn IS NOT NULL AND TRIM(j.onu_sn)<>''
      AND j.last_message LIKE '%ACS diminta membuat interface WAN PPPoE%'
    ON CONFLICT(customer_id) DO NOTHING
  `).run();
} catch (error) {
  logger.warn('[ACS-WAN] Migration status AddObject lama dilewati: ' + error.message);
}

function normalizeAcsSerialTokens(sn) {
  const serial = String(sn || '').trim().toUpperCase();
  const compact = serial.replace(/[^A-Z0-9]/g, '');
  const tokens = new Set([serial, compact].filter(Boolean));
  // ACS may store a FiberHome/other vendor serial as either its 4-byte ASCII prefix
  // (e.g. FHTTxxxxxxxx) or the 16-character hexadecimal form (46485454xxxxxxxx).
  const serialHex = compact.match(/^([0-9A-F]{8})([0-9A-F]{8})$/i);
  if (serialHex) {
    const vendor = Buffer.from(serialHex[1], 'hex').toString('ascii').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(vendor)) tokens.add((vendor + serialHex[2]).toUpperCase());
  }
  const vendorAlias = compact.match(/^([A-Z0-9]{4})([0-9A-F]{8})$/i);
  if (vendorAlias) {
    tokens.add(Buffer.from(vendorAlias[1], 'ascii').toString('hex').toUpperCase() + vendorAlias[2]);
  }
  return tokens;
}

function acsSerialValues(device) {
  return [
    device?._deviceId?._SerialNumber, device?._deviceId?.SerialNumber,
    device?.DeviceID?.SerialNumber?._value, device?.DeviceID?.SerialNumber,
    device?.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value,
    device?.Device?.DeviceInfo?.SerialNumber?._value,
    device?._id
  ].filter(v => v != null).map(v => String(v).toUpperCase());
}

async function checkAcsDeviceBySerial(sn) {
  const serial = String(sn || '').trim();
  if (!serial) throw new Error('Serial ONU wajib diisi untuk pemeriksaan ACS.');
  const tokens = normalizeAcsSerialTokens(serial);
  const devices = await genieacs.getDevices();
  const device = devices.find(d => acsSerialValues(d).some(value => [...tokens].some(token => value === token || (value.includes(token) && value.length <= token.length + 32))));
  return { found: Boolean(device), serial, deviceId: device?._id || null, device: device || null };
}

async function configureWanViaAcs(sn, data) {
  const serial = String(sn || '').trim();
  if (!serial) throw new Error('Serial ONU wajib diisi untuk konfigurasi WAN ACS.');
  const acsCheck = await checkAcsDeviceBySerial(serial);
  const acsDev = acsCheck.device;
  if (!acsDev) return { success: true, configured: false, pending: true, message: `WAN_PENDING: SN ONU ${serial} belum ditemukan cocok di GenieACS. WAN PPPoE belum dibuat; sistem menunggu data ACS masuk.` };

  const serverId = acsDev._acs_server_id || null;
  const manufacturer = String(acsDev._deviceId?._Manufacturer || acsDev._deviceId?.Manufacturer || '').toLowerCase();
  const productClass = String(acsDev._deviceId?._ProductClass || acsDev._deviceId?.ProductClass || '').toUpperCase();
  const isFiberHomeHG6145D2 = manufacturer.includes('fiberhome') && productClass.includes('HG6145D2');
  const igd = acsDev.InternetGatewayDevice || {};
  const wanDevices = igd.WANDevice || {};
  const wanDeviceEntry = Object.entries(wanDevices).find(([k]) => /^\d+$/.test(k));
  if (!wanDeviceEntry) {
    await genieacs.refreshObject(acsDev._id, 'InternetGatewayDevice.WANDevice.', serverId);
    return { success: true, configured: false, pending: true, message: `WAN_PENDING: parameter WAN ONU ${serial} sedang diminta dari ACS.` };
  }
  const [wanDeviceId, wanDevice] = wanDeviceEntry;
  const connDevices = wanDevice.WANConnectionDevice || {};
  const connEntries = Object.entries(connDevices).filter(([k]) => /^\d+$/.test(k));
  if (!connEntries.length) {
    await genieacs.refreshObject(acsDev._id, `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.`, serverId);
    return { success: true, configured: false, pending: true, message: `WAN_PENDING: ACS sedang membaca WANConnectionDevice ONU ${serial}.` };
  }
  // Never create an empty WAN object when the PPPoE credentials or VLAN are missing.
  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  if (!username || !password) throw new Error('Username/password PPPoE pelanggan belum lengkap; AddObject WAN tidak dikirim.');
  const vlan = Number(data.vlan == null || data.vlan === '' ? 100 : data.vlan);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error('VLAN WAN harus bilangan bulat 1–4094; AddObject WAN tidak dikirim.');
  const pppEntries = [];
  for (const [connId, conn] of connEntries) {
    const ppp = conn.WANPPPConnection || {};
    for (const [pppId, obj] of Object.entries(ppp)) if (/^\d+$/.test(pppId)) pppEntries.push({ connId, pppId, obj });
  }
  const fiberHomeSharedTr069Wcd = isFiberHomeHG6145D2 && String(serverId || '') === 'builtin' &&
    pppEntries.some(entry => {
      const container = connDevices[entry.connId] || {};
      const ipWan = container.WANIPConnection || {};
      return Object.values(ipWan).some(ip => {
        const get = key => ip[key] && typeof ip[key] === 'object' && '_value' in ip[key] ? ip[key]._value : ip[key];
        return /TR[- ]?069/i.test(String(get('Name') || '')) || String(get('VLANID') || '') === '1011';
      });
    });
  if (!pppEntries.length || fiberHomeSharedTr069Wcd) {
    // HG6145D2's existing WANConnectionDevice normally contains TR-069 (IP_Routed,
    // VLAN 1011). Adding PPPoE to that same container can bind it to the management WAN
    // or leave the new PPP instance Unconfigured. On built-in ACS, create a fresh WCD first
    // and then add PPPoE beneath that new instance. Keep the legacy path for other models
    // and non-built-in GenieACS until their task-chaining semantics are verified.
    const chosen = connEntries.find(([, c]) => Object.keys(c.WANIPConnection || {}).some(k => /^\d+$/.test(k))) || connEntries[0];
    const separateFiberHomeWcd = isFiberHomeHG6145D2 && String(serverId || '') === 'builtin';
    const objectName = separateFiberHomeWcd
      ? `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.`
      : `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.${chosen[0]}.WANPPPConnection.`;
    const customerId = Number(data.customerId || 0);
    const prior = customerId > 0
      ? db.prepare('SELECT * FROM tech_onu_acs_wan_jobs WHERE customer_id=? LIMIT 1').get(customerId)
      : null;
    let samePendingRequest = prior &&
      String(prior.onu_sn || '').trim().toUpperCase() === serial.toUpperCase() &&
      ['addobject_requested','addobject_sent','addobject_uncertain'].includes(String(prior.stage || ''));

    if (samePendingRequest) {
      const ageMinutes = prior.addobject_sent_at
        ? Math.max(0, (Date.now() - Date.parse(String(prior.addobject_sent_at).replace(' ', 'T') + 'Z')) / 60000)
        : 0;
      let priorFailedForResources = false;
      if (String(serverId || '') === 'builtin') {
        const previousTasks = db.prepare(
          "SELECT id,status,result,payload FROM acs_tasks WHERE device_id=? AND name='addObject' ORDER BY id DESC LIMIT 50"
        ).all(String(acsDev._id || ''));
        const normalizeObjectName = value => String(value || '').trim().replace(/\.+$/, '');
        if (separateFiberHomeWcd) {
          // A previous version targeted WCD.1.WANPPPConnection (the TR-069 container).
          // Its completed task must not block the corrected AddObject for a NEW WCD.
          const exactNewWcdTask = previousTasks.find(row => {
            try { return normalizeObjectName(JSON.parse(row.payload || '{}').objectName) === normalizeObjectName(objectName); }
            catch (_) { return false; }
          });
          if (!exactNewWcdTask) {
            samePendingRequest = false;
            logger.warn(`[ACS] FiberHome HG6145D2 ${serial}: old shared-WCD AddObject marker found; allowing one corrected AddObject for a separate WANConnectionDevice.`);
          } else {
            priorFailedForResources = exactNewWcdTask.status === 'failed' &&
              /<FaultCode>\s*9004\s*<\/FaultCode>|\b9004\b|Resources exceeded/i.test(String(exactNewWcdTask.result || ''));
          }
        } else {
          const matchingTasks = previousTasks.filter(row => {
            try { return String(JSON.parse(row.payload || '{}').objectName || '').includes(objectName); }
            catch (_) { return false; }
          });
          const latestAddObject = matchingTasks[0];
          priorFailedForResources = Boolean(latestAddObject && latestAddObject.status === 'failed' &&
            /<FaultCode>\s*9004\s*<\/FaultCode>|\b9004\b|Resources exceeded/i.test(String(latestAddObject.result || '')));
        }
      }
      if (samePendingRequest && priorFailedForResources && data.allowAddObjectRetry === true) {
        // An explicit technician submission may retry once after a recorded CWMP 9004.
        samePendingRequest = false;
        logger.warn(`[ACS] Explicit Binding Saja retry allowed for AddObject after prior CWMP 9004: ${serial}`);
      } else if (samePendingRequest && priorFailedForResources) {
        const message = `[WAN_ADDOBJECT_MANUAL] Modem menolak AddObject sebelumnya dengan CWMP 9004 (Resources exceeded); WAN PPPoE/VLAN belum dikonfigurasi. Tekan Proses Binding sekali lagi untuk percobaan yang diawasi, atau periksa kapasitas/interface ONT dahulu.`;
        if (customerId > 0) db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage='addobject_failed',last_message=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?)`).run(message, customerId, serial);
        return { success: false, configured: false, pending: false, manual: true, message };
      } else if (samePendingRequest) {
        // Refresh is safe to repeat; AddObject is not.
        try { await genieacs.refreshObject(acsDev._id, objectName, serverId); } catch (_) {}
        const ageNote = ageMinutes >= 10
          ? ' ACS belum melaporkan objek setelah 10 menit; task sebelumnya belum membuktikan kegagalan Resources exceeded sehingga AddObject tidak diulang otomatis.'
          : ' Permintaan sebelumnya tidak dikirim ulang.';
        return { success: true, configured: false, pending: true, addObjectRequested: false,
          message: `WAN_PENDING: ACS masih menunggu interface WAN PPPoE untuk ONU ${serial}.${ageNote}` };
      }
    }

    if (customerId > 0) {
      db.prepare(`INSERT INTO tech_onu_acs_wan_jobs
        (customer_id,onu_sn,acs_device_id,acs_server_id,stage,last_message,addobject_sent_at,created_at,updated_at)
        VALUES(?,?,?,?, 'addobject_requested','Mengirim AddObject WAN PPPoE ke ACS.',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(customer_id) DO UPDATE SET onu_sn=excluded.onu_sn,acs_device_id=excluded.acs_device_id,
          acs_server_id=excluded.acs_server_id,stage='addobject_requested',last_message=excluded.last_message,
          addobject_sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      `).run(customerId, serial.toUpperCase(), String(acsDev._id || ''), serverId);
    }
    try {
      let addObjectOptions = {};
      if (String(serverId || '') === 'builtin') {
        const desiredType = 'IP_Routed'; // HG6145D2 uses routed PPP WAN; its TransportType leaf is read-only.
        const instancePath = separateFiberHomeWcd
          ? `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.{{wanDeviceInstance}}.WANPPPConnection.{{wanConnectionInstance}}`
          : objectName + '{{wanConnectionInstance}}';
        const pppFollowups = [
          { name: 'setParameterValues', payload: { parameterValues: [
            [instancePath + '.ConnectionType', desiredType, 'xsd:string'],
            [instancePath + '.NATEnabled', true, 'xsd:boolean'],
            [instancePath + '.Username', username, 'xsd:string'],
            [instancePath + '.Password', password, 'xsd:string']
          ] } },
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.VLANID', vlan, 'xsd:unsignedInt']] } },
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.Enable', true, 'xsd:boolean']] } },
          // Give the freshly added WAN a stable, VLAN-specific name for later audits/UI.
          // Keep this separate from credentials so a name parameter fault cannot roll back PPPoE.
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.Name', `2_INTERNET_R_VID_${vlan}`, 'xsd:string']] } },
          // The tested HG6145D2 exposes ConnectionTrigger, RouteProtocolRx, and
          // X_FH_ServiceList on the new PPP instance. TransportType is read-only (9008),
          // and ServiceType/ChannelMode/ConnectionMode/X_FH_VLANID return 9005; do not send them.
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.ConnectionTrigger', 'AlwaysOn', 'xsd:string']] } },
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.RouteProtocolRx', 'Off', 'xsd:string']] } },
          { name: 'setParameterValues', payload: { parameterValues: [[instancePath + '.X_FH_ServiceList', 'INTERNET', 'xsd:string']] } },
          { name: 'getParameterValues', payload: { parameterNames: [
            instancePath + '.Enable', instancePath + '.ConnectionType', instancePath + '.Username',
            instancePath + '.VLANID', instancePath + '.ConnectionStatus'
          ] } }
        ];
        const workflowVars = { workflowType: 'tech_binding_wan', workflowLabel: 'Binding Saja WAN PPPoE', customerId: String(customerId) };
        if (separateFiberHomeWcd) {
          const linkBase = `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.{{wanDeviceInstance}}.X_FH_WANGponLinkConfig`;
          const linkFollowups = [
            [linkBase + '.Enable', true, 'xsd:boolean'],
            [linkBase + '.Mode', 2, 'xsd:unsignedInt'],
            [linkBase + '.VLANID', vlan, 'xsd:unsignedInt'],
            [linkBase + '.VLANIDMark', vlan, 'xsd:unsignedInt'],
            [linkBase + '.802-1pMark', 0, 'xsd:unsignedInt']
          ].map(pv => ({ name: 'setParameterValues', payload: { parameterValues: [pv] } }));
          const nestedPppAdd = {
            name: 'addObject',
            payload: {
              objectName: `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.{{wanDeviceInstance}}.WANPPPConnection.`,
              instanceVariable: 'wanConnectionInstance',
              followup: [...linkFollowups, ...pppFollowups]
            }
          };
          addObjectOptions = {
            instanceVariable: 'wanDeviceInstance',
            templateVars: workflowVars,
            workflowType: 'tech_binding_wan', workflowLabel: 'Binding Saja WAN PPPoE', customerId,
            followup: [nestedPppAdd]
          };
        } else {
          addObjectOptions = {
            instanceVariable: 'wanConnectionInstance',
            templateVars: { wanDeviceInstance: String(wanDeviceId), ...workflowVars },
            workflowType: 'tech_binding_wan', workflowLabel: 'Binding Saja WAN PPPoE', customerId,
            followup: pppFollowups
          };
        }
      }
      await genieacs.addObject(acsDev._id, objectName, serverId, addObjectOptions);
      if (customerId > 0) {
        db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage='addobject_sent',
          last_message='ACS menerima AddObject dengan tindak lanjut Username/Password, VLAN, Enable, dan verifikasi.',
          updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?)
        `).run(customerId, serial);
      }
    } catch (error) {
      // The task may have been accepted before a network timeout. Preserve an uncertain
      // marker and never replay AddObject automatically.
      if (customerId > 0) {
        db.prepare(`UPDATE tech_onu_acs_wan_jobs SET stage='addobject_uncertain',
          last_message=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND UPPER(onu_sn)=UPPER(?)
        `).run('Hasil AddObject belum pasti: ' + String(error.message || error).slice(0, 250), customerId, serial);
      }
      return { success: true, configured: false, pending: true, addObjectRequested: true,
        message: `WAN_PENDING: Permintaan interface WAN untuk ONU ${serial} belum dapat dipastikan; task tidak akan dikirim ulang otomatis. Periksa status ACS.` };
    }
    return { success: true, configured: false, pending: true, addObjectRequested: true,
      message: `WAN_PENDING: ACS diminta membuat interface WAN PPPoE untuk ONU ${serial}.` };
  }

  const readWanValue = value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value') ? value._value : value;
  const usernameMatches = pppEntries.filter(x => String(readWanValue(x.obj.Username) || '').trim() === username);
  const namedInternet = pppEntries.filter(x => String(readWanValue(x.obj.Name) || '').trim().toUpperCase() === 'INTERNET');
  // On HG6145D2, old AddObject attempts left disabled, unconfigured placeholders.
  // A placeholder is eligible only if it is definitely not connected and has no credentials/IP/VLAN.
  const emptyFiberHomeSlots = isFiberHomeHG6145D2 ? pppEntries.filter(x => {
    const name = String(readWanValue(x.obj.Name) || '').trim();
    const user = String(readWanValue(x.obj.Username) || '').trim();
    const enableValue = readWanValue(x.obj.Enable);
    const enabled = enableValue === true || enableValue === 1 || /^(true|1|enabled)$/i.test(String(enableValue || ''));
    const status = String(readWanValue(x.obj.ConnectionStatus) || '').trim();
    const ip = String(readWanValue(x.obj.ExternalIPAddress) || '').trim();
    const vlanValue = readWanValue(x.obj.VLANID);
    return /^\d+_INTERNET_R_VID_$/.test(name) && !user && !enabled && /^unconfigured$/i.test(status) &&
      !ip && (vlanValue == null || String(vlanValue).trim() === '' || Number(vlanValue) === 0);
  }) : [];
  let current = null;
  if (usernameMatches.length === 1) current = usernameMatches[0];
  else if (usernameMatches.length > 1) current = null;
  else if (namedInternet.length === 1) current = namedInternet[0];
  else if (isFiberHomeHG6145D2 && emptyFiberHomeSlots.length > 0) {
    emptyFiberHomeSlots.sort((a, b) => Number(a.connId) - Number(b.connId) || Number(a.pppId) - Number(b.pppId));
    current = emptyFiberHomeSlots[0];
    logger.info(`[ACS] FiberHome HG6145D2 ${serial}: selecting disabled/unconfigured PPP placeholder ${current.connId}/${current.pppId} for credentials/VLAN; no active WAN will be selected.`);
  } else if (pppEntries.length === 1) current = pppEntries[0];
  if (!current) throw new Error(`ONU ${serial} memiliki beberapa WAN PPPoE dan username yang diminta tidak menunjuk tepat ke satu interface aman; tidak ada WAN yang diubah.`);
  const { connId, pppId, obj } = current;
  const base = `InternetGatewayDevice.WANDevice.${wanDeviceId}.WANConnectionDevice.${connId}.WANPPPConnection.${pppId}.`;
  const connBase = 'InternetGatewayDevice.WANDevice.' + wanDeviceId + '.WANConnectionDevice.' + connId + '.';
  const connObj = connDevices[connId] || {};
  const fhLink = connObj.X_FH_WANGponLinkConfig || {};
  const has = key => Object.prototype.hasOwnProperty.call(obj, key);
  const value = key => obj[key] && typeof obj[key] === 'object' && '_value' in obj[key] ? obj[key]._value : obj[key];
  const linkHas = key => Object.prototype.hasOwnProperty.call(fhLink, key);
  const linkValue = key => fhLink[key] && typeof fhLink[key] === 'object' && '_value' in fhLink[key] ? fhLink[key]._value : fhLink[key];
  // HG6145D2 was verified to support PPP WAN VLANID only. X_FH_VLANID is a
  // different, unsupported leaf on this model and must never be used as fallback.
  const existingVlanKey = isFiberHomeHG6145D2
    ? (has('VLANID') ? 'VLANID' : null)
    : (has('VLANID') ? 'VLANID' : (has('X_HW_VLAN') ? 'X_HW_VLAN' : (has('X_HW_VLANID') ? 'X_HW_VLANID' : null)));
  // Password is write-only on many ONUs and may not be present in ACS readback.
  const required = ['Enable', 'ConnectionType', 'Username'];
  // Do not block HG6145D2 provisioning when its firmware does not expose the optional
  // X_FH_WANGponLinkConfig object. The tested WANPPPConnection.VLANID field is supported.
  const fiberHomeLinkReady = !isFiberHomeHG6145D2 || Object.keys(fhLink).length === 0 || (linkHas('Enable') && linkHas('VLANID'));
  if (required.some(k => !has(k)) || !existingVlanKey || !fiberHomeLinkReady) {
    await genieacs.refreshObject(acsDev._id, base, serverId);
    if (isFiberHomeHG6145D2) await genieacs.refreshObject(acsDev._id, connBase + 'X_FH_WANGponLinkConfig.', serverId);
    return { success: true, configured: false, pending: true, message: `WAN_PENDING: ACS sedang memperbarui parameter PPPoE/VLAN ONU ${serial} sebelum konfigurasi.` };
  }
  const enabledValue = value('Enable');
  const enabled = enabledValue === true || enabledValue === 1 || /^(true|1|enabled)$/i.test(String(enabledValue || ''));
  const fiberHomeLinkVlanOk = !isFiberHomeHG6145D2 || !linkHas('VLANID') || Number(linkValue('VLANID')) === vlan;
  const fiberHomeLinkEnabled = !isFiberHomeHG6145D2 || !linkHas('Enable') || [true, 1, '1'].includes(linkValue('Enable')) || /^(true|enabled)$/i.test(String(linkValue('Enable') || ''));
  const desiredConnectionType = 'IP_Routed'; // HG6145D2 PPPoE is IP_Routed; do not write read-only TransportType.
  const serviceRequirements = [
    ['ConnectionTrigger', 'AlwaysOn'], ['RouteProtocolRx', 'Off'], ['X_FH_ServiceList', 'INTERNET']
  ].filter(([key]) => has(key));
  const serviceFieldsOk = serviceRequirements.every(([key, expected]) => String(value(key) ?? '').trim().toLowerCase() === String(expected).toLowerCase());
  const isConfigured = String(value('Username') || '') === username && enabled && Number(value(existingVlanKey)) === vlan && String(value('ConnectionType') || '') === desiredConnectionType && serviceFieldsOk && fiberHomeLinkVlanOk && fiberHomeLinkEnabled;
  if (isConfigured) return { success: true, configured: true, pending: false, message: `WAN PPPoE sudah terverifikasi di ACS pada WANConnectionDevice ${connId}, instance ${pppId}, VLAN ${vlan}.` };

  const params = {
    [base + 'Enable']: true,
    [base + 'ConnectionType']: desiredConnectionType,
    [base + 'Username']: username,
    [base + 'Password']: password,
    [base + existingVlanKey]: vlan
  };
  if (has('Name')) params[base + 'Name'] = isFiberHomeHG6145D2 ? ('2_INTERNET_R_VID_' + vlan) : 'INTERNET';
  // HG6145D2 rejected writes to TransportType (9008) and X_FH_ServiceType,
  // X_FH_ChannelMode, X_FH_ConnectionMode, X_FH_VLANID (9005). Only retry leaves
  // confirmed writable on this model; generic vendors retain their supported paths.
  if (has('ConnectionTrigger')) params[base + 'ConnectionTrigger'] = 'AlwaysOn';
  if (has('X_FH_ServiceList')) params[base + 'X_FH_ServiceList'] = 'INTERNET';
  if (!isFiberHomeHG6145D2) {
    if (has('TransportType')) params[base + 'TransportType'] = 'PPPoE';
    if (has('X_FH_ServiceType')) params[base + 'X_FH_ServiceType'] = 'INTERNET';
    if (has('X_FH_ChannelMode')) params[base + 'X_FH_ChannelMode'] = 'PPPoE';
    if (has('X_FH_ConnectionMode')) params[base + 'X_FH_ConnectionMode'] = 'Default';
    if (has('X_FH_VLANID')) params[base + 'X_FH_VLANID'] = vlan;
  }
  if (isFiberHomeHG6145D2) {
    if (linkHas('Enable')) params[connBase + 'X_FH_WANGponLinkConfig.Enable'] = true;
    if (linkHas('Mode')) params[connBase + 'X_FH_WANGponLinkConfig.Mode'] = 2;
    if (linkHas('VLANID')) params[connBase + 'X_FH_WANGponLinkConfig.VLANID'] = vlan;
    if (linkHas('VLANIDMark')) params[connBase + 'X_FH_WANGponLinkConfig.VLANIDMark'] = vlan;
    if (linkHas('802-1pMark')) params[connBase + 'X_FH_WANGponLinkConfig.802-1pMark'] = 0;
  }
  if (has('NATEnabled')) params[base + 'NATEnabled'] = true;
  if (has('X_HW_NATEnabled')) params[base + 'X_HW_NATEnabled'] = true;
  await genieacs.setParameterValues(acsDev._id, params, serverId);
  return { success: true, configured: false, pending: true, message: `WAN_PENDING: Tugas WAN PPPoE VLAN ${vlan} sudah dikirim ke ACS; menunggu nilai terlapor kembali dari ONU.` };
}

/**
 * Konfigurasi WAN ONU (PPPoE / Bridge) via Telnet CLI.
 */
 async function configureOnuWan(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  const method = String(data.method || 'telnet').toLowerCase();

  if (method === 'go-api' && brand !== 'zte') {
    throw new Error('Metode REST (go-api-c320) hanya untuk OLT brand ZTE.');
  }
  if (brand === 'zte' && method === 'go-api') {
    return configureZteWanViaGoApi(oltId, data);
  }

  const { index, mode, vlan, username, password, lans, ssids } = data;

  // HSGQ-G008ID supports WAN creation in the per-PON ONT context. Its inventory
  // index is 0/PON:ONU-ID (e.g. 0/4:11), not a ZTE/Huawei three-level shelf path.
  // Invoke this path for explicitly supported ZTE/Huawei/CMHI ONUs only; never guess
  // the ONU ID or write to the OLT without the full validated index.
  if (brand === 'hsgq') {
    const vendor = String(data.onuVendor || data.vendor || '').trim().toUpperCase();
    if (!['ZTE', 'HUAWEI', 'CMHI'].includes(vendor)) {
      throw new Error('HSGQ Add WAN hanya diizinkan untuk ONU vendor ZTE/Huawei/CMHI.');
    }
    if (String(mode || '').toUpperCase() !== 'PPPOE') {
      throw new Error('Driver HSGQ Add WAN saat ini hanya menerima mode PPPoE.');
    }
    const idx = String(index || '').trim().match(/^\d+\/([1-8]):(\d+)$/);
    if (!idx) throw new Error('Indeks HSGQ tidak valid; format yang diperlukan adalah 0/PON:ONU-ID.');
    const pon = Number(idx[1]);
    const onuId = Number(idx[2]);
    if (!Number.isInteger(onuId) || onuId < 1 || onuId > 127) throw new Error('ONU ID HSGQ harus berada pada rentang 1–127.');
    const vid = Number(vlan);
    if (!Number.isInteger(vid) || vid < 1 || vid > 4094) throw new Error('VLAN PPPoE harus berupa angka 1–4094.');
    const pppoeUser = String(username || '').trim();
    const pppoePass = String(password || '');
    // This HSGQ CLI accepts PPPoE username/password as single tokens. Reject values
    // that could split or inject CLI arguments; never log the secret-bearing command.
    if (!/^[A-Za-z0-9._@+-]{1,32}$/.test(pppoeUser)) {
      throw new Error('Username PPPoE tidak cocok untuk format token CLI HSGQ (maksimal 32 karakter tanpa spasi).');
    }
    if (!/^[A-Za-z0-9._@#$%+=:!*_-]{1,64}$/.test(pppoePass)) {
      throw new Error('Password PPPoE berisi karakter yang belum aman untuk token CLI HSGQ; tidak ada perintah WAN yang dikirim.');
    }
    const redact = value => String(value || '')
      .split(pppoeUser).join('[PPPOE_USER]')
      .split(pppoePass).join('[PPPOE_PASSWORD]');
    const cliCommand = `ont wanconfig add ${onuId} connection-type internet vlan tag ${vid} ipmode pppoe ${pppoeUser} ${pppoePass}`;
    let raw = '';
    try {
      const hsgqDriver = require('./onuProvisionService');
      raw = await hsgqDriver.runHSGQTelnet({
        host: olt.host,
        port: Number(olt.telnet_port || 23),
        username: olt.cli_user || olt.web_user,
        password: olt.cli_password || olt.web_password,
        enablePassword: olt.enable_password || ''
      }, [
        'enable',
        'configure',
        `interface gpon ${pon}`,
        cliCommand,
        // Return from interface config to global config, then persist using HSGQ's `save`.
        'exit',
        'save'
      ]);
    } catch (error) {
      throw new Error(`HSGQ Add WAN gagal: ${redact(error.message || error)}`);
    }
    const safeOutput = redact(raw);
    if (/(?:unknown command|invalid input|command incomplete|not support|\bfail(?:ed|ure)?\b|\berror\b)/i.test(safeOutput)) {
      throw new Error(`HSGQ menolak Add WAN. Periksa format WAN/PPPoE pada OLT; detail aman: ${safeOutput.slice(-450)}`);
    }
    return safeOutput;
  }

  // Parse physical OLT index: ZTE gpon-onu_1/2/7:5 or Huawei 0/1/2:5.
  // Frame/slot/PON/ONU are kept separately so the selected vendor driver gets the
  // exact physical interface and never guesses an ONU ID from a serial number.
  let frame = 0, board = 1, port = 1, onuId = 1;
  const normalizedIndex = String(index || '').trim().replace(/^gpon-onu_/i, '');
  const indexPathParts = normalizedIndex.split('/');
  const ponAndOnu = indexPathParts.length === 3 ? indexPathParts[2].split(':') : [];
  if (indexPathParts.length === 3 && ponAndOnu.length === 2 &&
      indexPathParts.every(part => /^\d+$/.test(part)) && ponAndOnu.every(part => /^\d+$/.test(part))) {
    frame = Number(indexPathParts[0]);
    board = Number(indexPathParts[1]);
    port = Number(ponAndOnu[0]);
    onuId = Number(ponAndOnu[1]);
  } else {
    throw new Error('Index OLT tidak valid; gunakan format fisik 1/2/7:5 untuk ZTE atau 0/1/2:5 untuk Huawei.');
  }

  const cmds = [];
  if (brand === 'zte') {
    cmds.push('enable');
    cmds.push('configure terminal');
    
    if (mode === 'PPPoE') {
      // ZTE C300/C320 PPPoE Config via OMCI (pon-onu-mng)
      cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
      
      // 1. Configure WAN IP with PPPoE
      // Note: vlan here is used as vlan-profile name. Usually named 'VLAN100' or just '100'
      cmds.push(`wan-ip 1 mode pppoe username ${username} password ${password} vlan-profile ${vlan} host 1`);
      
      // 2. Binding LAN & SSID
      if (lans || ssids) {
        let bindCmd = `wan 1`;
        if (lans) bindCmd += ` ethuni ${lans}`;
        if (ssids) bindCmd += ` ssid ${ssids}`;
        bindCmd += ` service internet host 1`;
        cmds.push(bindCmd);
      }
      
      cmds.push('exit');
      
      // OLT side service-port
      cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
      cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    } else {
      // Bridge Mode
      cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
      
      // Tagging each selected port to the target VLAN
      if (vlan) {
        if (lans) {
          lans.split(',').forEach(l => {
            cmds.push(`vlan port eth_0/${l} mode tag vlan ${vlan}`);
          });
        }
        if (ssids) {
          ssids.split(',').forEach(s => {
            cmds.push(`vlan port wifi_0/${s} mode tag vlan ${vlan}`);
          });
        }
      }
      
      cmds.push('exit');
      
      // OLT side service-port
      cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
      cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    }
    
    cmds.push('exit');
    cmds.push('end');
    cmds.push('write');
    return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
  } else if (brand === 'huawei') {
     // Do not guess Huawei ONT WAN CLI: syntax differs by OLT model/firmware.
     // Keep this path disabled until a model-specific, tested driver is available.
     throw new Error('WAN Huawei direct belum dijalankan: driver model/firmware belum tervalidasi. Tidak ada perintah konfigurasi yang dikirim.');
   } else {
     throw new Error(`Fitur konfigurasi WAN belum didukung untuk brand ${brand}`);
   }
 
   return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
 }
 
 async function getAllOltsStats(full = false) {
   const olts = getActiveOlts();
   if (!olts || olts.length === 0) {
     return {
       is_all: true,
       onus_total: 0,
       onus_online: 0,
       onus_offline: 0,
       onus_weak: 0,
       onus: [],
       unauth_onus: [],
       olts_summary: [],
       error: 'Tidak ada OLT aktif'
     };
   }

   const results = await Promise.all(olts.map(o => getOltStats(o.id, full)));

   let onus_total = 0;
   let onus_online = 0;
   let onus_offline = 0;
   let onus_weak = 0;
   const allOnus = [];
   const allUnauth = [];
   const olts_summary = [];

   for (let i = 0; i < results.length; i++) {
     const s = results[i];
     const oltInfo = olts[i];
     if (s) {
       onus_total += (s.onus_total || 0);
       onus_online += (s.onus_online || 0);
       onus_offline += (s.onus_offline || 0);
       onus_weak += (s.onus_weak || 0);

       olts_summary.push({
         id: oltInfo.id,
         name: oltInfo.name,
         host: oltInfo.host,
         brand: oltInfo.brand,
         status: s.status,
         onus_total: s.onus_total,
         onus_online: s.onus_online,
         onus_offline: s.onus_offline,
         onus_weak: s.onus_weak,
         temp: s.temp,
         cpu: s.cpu,
         ram: s.ram,
         uptime: s.uptime,
         uplink_rx: s.uplink_rx,
         uplink_tx: s.uplink_tx,
         error: s.error,
         activeProfile: s.activeProfile || null,
         systemOids: s.systemOids || null,
         snmpConfig: s.snmpConfig || null
       });

       if (Array.isArray(s.onus)) {
         s.onus.forEach(onu => {
           allOnus.push({ ...onu, olt_id: oltInfo.id, olt_name: oltInfo.name });
         });
       }

       if (Array.isArray(s.unauth_onus)) {
         s.unauth_onus.forEach(u => {
           allUnauth.push({ ...u, olt_id: oltInfo.id, olt_name: oltInfo.name });
         });
       }
     }
   }

   return {
     is_all: true,
     onus_total,
     onus_online,
     onus_offline,
     onus_weak,
     onus: allOnus,
     unauth_onus: allUnauth,
     olts_summary
   };
 }

 module.exports = {
  getAllOlts, getActiveOlts, getOltById, createOlt, updateOlt, deleteOlt, getOltStats, getConfiguredOnusForProvision, getAllOltsStats, rebootOnu, rebootOnuViaCli, renameOnu, authorizeOnu,
  configureOnuWan, configureZteWanViaGoApi, configureWanViaAcs, checkAcsDeviceBySerial,
  parseHsgqGponOnuTable
};
