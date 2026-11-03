const { Client } = require('ssh2');
const net = require('net');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

function sanitizeCliInput(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeParams(params) {
  const clean = {};
  if (!params || typeof params !== 'object') return clean;
  for (const k of Object.keys(params)) {
    clean[k] = typeof params[k] === 'string'
      ? params[k].replace(/[\r\n]+/g, ' ').trim()
      : params[k];
  }
  return clean;
}

// Normalize GPON serial representations for comparisons across all vendors.
// Standard short SN = four ASCII vendor characters + eight hex characters;
// some OLT firmware reports the same 8-byte prefix as 16 hex characters.
function hsgqSerialForms(value) {
  const sn = String(value || '').trim().toUpperCase();
  const forms = new Set([sn]);
  const alias = sn.match(/^([A-Z0-9]{4})([0-9A-F]{8})$/);
  if (alias) {
    const prefixHex = Buffer.from(alias[1], 'ascii').toString('hex').toUpperCase();
    forms.add(prefixHex + alias[2]);
  }
  const raw = sn.match(/^([0-9A-F]{8})([0-9A-F]{8})$/);
  if (raw) {
    const decodedPrefix = Buffer.from(raw[1], 'hex').toString('ascii').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(decodedPrefix)) forms.add(decodedPrefix + raw[2]);
  }
  return forms;
}
function hsgqSerialsMatch(a, b) {
  const aForms = hsgqSerialForms(a);
  for (const value of hsgqSerialForms(b)) if (aForms.has(value)) return true;
  return false;
}

/**
 * ONU Provision Service
 * Support untuk:
 * - ZTE C300/C320
 * - Huawei MA5800 Series
 * - Fiberhome AN5516 Series
 * - VSOL V1600/V2400 Series
 * - C-Data FD1600/FD1800 Series
 */

class ONUProvisionService {
  constructor() {
    this.connections = new Map();
  }

  /**
   * Connect ke OLT via SSH
   */
  async connectSSH(oltConfig) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('Connection timeout'));
      }, 30000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({
        host: oltConfig.host,
        port: oltConfig.port || 22,
        username: oltConfig.username,
        password: oltConfig.password,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      });
    });
  }

  /** Connect to HSGQ OLT using its Telnet CLI (the configured HSGQ port is commonly 23). */
  async runHSGQTelnet(oltConfig, commands) {
    const host = String(oltConfig.host || '').trim();
    const port = Number(oltConfig.port) || 23;
    if (!host) throw new Error('Alamat OLT belum diisi');
    const socket = new net.Socket();
    socket.setTimeout(20000);
    let closed = false;
    let stage = 'connect TCP socket';
    const close = () => { if (!closed) { closed = true; socket.destroy(); } };
    const readUntil = (matcher, timeoutMs = 10000) => new Promise((resolve, reject) => {
      let buf = '';
      let timer;
      const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
      // Treat timeout as an idle timeout, not a total command runtime. Running-config
      // may require several pager turns and legitimately take longer than 15 seconds.
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { cleanup(); reject(new Error('Timeout menunggu respons Telnet OLT')); }, timeoutMs);
      };
      const onData = chunk => {
        buf += chunk.toString('utf8').replace(/\u0000/g, '');
        resetTimer();
        // HSGQ sends ANSI terminal-control sequences around login and CLI prompts.
        // Strip them for prompt detection while preserving raw output for diagnostics.
        const normalized = buf.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\\\)/g, '')
          .replace(/[\u0000\u0008]/g, '');
        const tail = normalized.replace(/\r/g, '').split('\n').pop().trim();
        // HSGQ firmware may append ANSI cursor-control/backspace bytes after the
        // pager marker. Detect the marker anywhere in the final chunk, not only at
        // the exact end of the last line, otherwise running-config stalls at page 1.
        const pagerPrompt = /(?:-{2,}\s*More\s*-{2,}|Press any key to continue|More:\s*)/i;
        if (pagerPrompt.test(normalized.slice(-240)) || pagerPrompt.test(tail)) {
          buf = buf.replace(pagerPrompt, '');
          socket.write(' ');
          return;
        }
        if (matcher.test(tail) || matcher.test(normalized.trimEnd().split(/\r?\n/).slice(-2).join('\n'))) { cleanup(); resolve(buf); }
      };
      const onError = err => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('Koneksi Telnet OLT tertutup')); };
      socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
      resetTimer();
    });
    try {
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(port, host, () => { socket.off('error', reject); resolve(); }); });
      // This HSGQ firmware reliably opens with a username prompt. Match the prompt
      // without end-of-line anchoring because the terminal may append control bytes.
      stage = 'waiting for username prompt';
      const first = await readUntil(/(?:login|username)\s*[:>]/i, 10000);
      socket.write(String(oltConfig.username || '') + '\r\n');
      stage = 'waiting for login password prompt';
      await readUntil(/password\s*[:>]/i, 10000);
      socket.write(String(oltConfig.password || '') + '\r\n');
      stage = 'waiting for CLI prompt after login';
      await readUntil(/[^\r\n]*[>#]\s*$/i, 10000);
      let output = first;
      for (const raw of (Array.isArray(commands) ? commands : [commands])) {
        const cmd = sanitizeCliInput(raw);
        if (!cmd) continue;
        stage = `waiting for OLT response to command: ${cmd}`;
        socket.write(cmd + '\r\n');
        // Some HSGQ accounts request a separate enable password after `enable`.
        // Detect that prompt explicitly instead of waiting for a CLI prompt until timeout.
        const response = await readUntil(/(?:password|passwd)\s*[:>]\s*$|(?:OLT[^\r\n]*[>#]|[>#])\s*$/i, 15000);
        const tail = String(response).replace(/\r/g, '').trim().split('\n').pop() || '';
        if (/^(?:password|passwd)\s*[:>]\s*$/i.test(tail)) {
          const enablePassword = String(oltConfig.enablePassword || oltConfig.enable_password || getSetting('olt_enable_password', '') || '');
          if (!enablePassword) throw new Error('OLT meminta enable password, tetapi belum dikonfigurasi di Manajemen OLT');
          socket.write(enablePassword + '\r\n');
          stage = 'waiting for CLI prompt after enable password';
          output += '\n' + response + '\n' + await readUntil(/(?:OLT[^\r\n]*[>#]|[>#])\s*$/i, 15000);
        } else {
          output += '\n' + response;
        }
      }
      const cliError = output.match(/Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|vty%\s*Error|\bError,\s*(?:the|invalid|failed|unknown)/i);
      if (cliError) {
        const diagnostic = String(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '').replace(/\r/g, '').trim().split('\n').slice(-18).join('\n');
        throw new Error(`OLT menolak perintah CLI: ${cliError[0]}\nRespons OLT (akhir):\n${diagnostic.slice(-2200)}`);
      }
      return output;
    } catch (err) {
      throw new Error(`Telnet OLT ${host}:${port} [${stage}]: ${err.message}`);
    } finally { close(); }
  }

  /**
   * Execute multiple commands sequentially on a single SSH interactive shell stream
   */
  async executeCommands(conn, commands, promptPattern = /#|>/) {
    return new Promise((resolve, reject) => {
      conn.shell((err, stream) => {
        if (err) return reject(err);

        let output = '';
        let cmdIndex = 0;
        const cmdList = Array.isArray(commands) ? [...commands] : [commands];

        const timeout = setTimeout(() => {
          stream.end();
          reject(new Error('SSH command sequence timeout'));
        }, 60000);

        const writeNext = () => {
          if (cmdIndex < cmdList.length) {
            const rawCmd = cmdList[cmdIndex++];
            // Defense-in-depth: strip newlines from commands to make sure no multiline command gets injected
            const cmd = sanitizeCliInput(rawCmd);
            logger.info(`SSH command sent: ${cmd}`);
            stream.write(cmd + '\n');
          } else {
            clearTimeout(timeout);
            stream.end();
          }
        };

        let buffer = '';
        stream.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          buffer += chunk;

          const lines = buffer.split('\n');
          const lastLine = lines[lines.length - 1].trim();

          // If the last line matches the OLT prompt pattern, send the next command
          if (promptPattern.test(lastLine)) {
            buffer = '';
            setTimeout(writeNext, 50);
          }
        });

        stream.on('close', () => {
          clearTimeout(timeout);
          resolve(output);
        });

        stream.stderr.on('data', (data) => {
          logger.error('SSH stderr:', data.toString());
        });
      });
    });
  }

  /**
   * ZTE C300/C320 - Get unconfigured ONUs
   */
  async zteGetUnconfiguredONUs(oltConfig, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const cleanPon = sanitizeCliInput(pon);
      
      const commands = [
        'enable',
        `show gpon onu uncfg gpon-olt_${cleanPon}`
      ];
      
      const output = await this.executeCommands(conn, commands);
      const onus = this.parseZTEUnconfiguredONUs(output);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse ZTE unconfigured ONUs output robustly
   */
  parseZTEUnconfiguredONUs(output) {
    const onus = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const match = line.match(/gpon-onu_(\d+\/\d+\/\d+):(\d+)\s+(.+)/);
      if (match) {
        const pon = match[1];
        const onuId = match[2];
        const rest = match[3].trim().split(/\s+/);
        
        let sn = '';
        let model = 'Unknown';
        
        if (rest.length >= 2) {
          const isSn = (str) => /^[A-Z]{4}[0-9A-F]{8}$/i.test(str) || /^[0-9A-F]{12}$/i.test(str);
          
          if (isSn(rest[0])) {
            sn = rest[0];
            model = rest[1] || 'Unknown';
          } else if (isSn(rest[1])) {
            sn = rest[1];
            model = rest[0];
          } else {
            sn = rest[1] || rest[0];
            model = rest[0];
          }
        } else if (rest.length === 1) {
          sn = rest[0];
        }
        
        if (sn && sn.toLowerCase() !== 'sn-auth') {
          onus.push({
            pon,
            onuId,
            model,
            sn,
            vendor: 'ZTE'
          });
        }
      }
    }
    
    return onus;
  }

  /**
   * ZTE C300/C320 - Provision ONU
   */
  async zteProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'F660'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('tr069 enable');
        cmds.push(`tr069 acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`tr069 acs username ${tr069AcsUsername}`);
          cmds.push(`tr069 acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`tr069 periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('tr069 periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE provision ONU error:', error);
      throw error;
    }
  }

  /**
   * HSGQ / HIOSO - Get unconfigured ONUs
   */
  async hsgqGetUnconfiguredONUs(oltConfig, pon) {
    try {
      const cleanPon = sanitizeCliInput(pon);
      const ponLower = String(cleanPon || '').toLowerCase();
      const isEpon = ponLower.includes('epon');

      let commands;
      if (isEpon) {
        // Keep the existing EPON command path unchanged.
        commands = ['enable', 'show onu unregister'];
      } else {
        // HSGQ-G008ID GPON firmware exposes auto-found ONTs inside each PON view.
        // `show gpon onu uncfg` is not a supported command on this firmware.
        const match = ponLower.match(/(?:gpon-olt_)?(?:\d+\/)?(\d+)$/);
        const ponId = match ? Number(match[1]) : NaN;
        if (!Number.isInteger(ponId) || ponId < 1 || ponId > 16) {
          throw new Error(`Nomor port GPON tidak valid: ${cleanPon}`);
        }
        commands = ['enable', 'configure', `interface gpon ${ponId}`, 'show ont-autofind'];
      }

      const output = await this.runHSGQTelnet(oltConfig, commands);
      if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input)/i.test(output)) {
        throw new Error(`Perintah scan ONU HSGQ ditolak oleh CLI. PON yang diuji: ${cleanPon}.`);
      }
      return this.parseHSGQUnconfiguredONUs(output, cleanPon, oltConfig.vendor);
    } catch (error) {
      logger.error(`${oltConfig.vendor} get unconfigured ONUs error:`, error);
      throw error;
    }
  }

  /**
   * Parse HSGQ/HIOSO unconfigured ONUs output
   */
  parseHSGQUnconfiguredONUs(output, pon, vendor) {
    const onus = [];
    const clean = String(output || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    // Firmware revisions format `show ont-autofind` differently: some emit dashed
    // multi-line blocks, others emit rows or SN-labelled lines without separators.
    // Parse each line independently so one unseparated table cannot hide every ONT
    // except the first one.
    for (const line of clean.split('\n')) {
      const candidates = [];
      const labelled = line.match(/\b(?:ONU\s*)?SN\s*[:=]\s*([A-Z0-9-]{12,16})\b/i);
      if (labelled) {
        candidates.push(labelled[1]);
      } else {
        const tokens = line.match(/\b(?:[A-Z0-9]{4}[0-9A-F]{8}|[0-9A-F]{16})\b/gi) || [];
        candidates.push(...tokens);
      }
      for (const value of candidates) {
        const sn = String(value || '').trim().toUpperCase();
        if (!/^[A-Z0-9-]{12,16}$/.test(sn)) continue;
        if (!onus.some(existing => hsgqSerialsMatch(existing.sn, sn))) {
          onus.push({ pon: String(pon), onuId: '', model: 'Unknown', sn, vendor: vendor || 'HSGQ' });
        }
      }
    }
    return onus;
  }

  /**
   * Dedicated HSGQ GPON binding. This deliberately does not configure ONU name,
   * TR-069, WAN/PPPoE, Wi-Fi, VLAN, or service-port settings.
   */
  async hsgqBindOnlyONU(oltConfig, params) {
    params = sanitizeParams(params);
    const serial = String(params.sn || '').trim().toUpperCase();
    const requestedId = String(params.onuId == null ? '' : params.onuId).trim();
    let onuNumber = requestedId === '' ? null : Number(requestedId);
    const lineProfileId = Number(params.lineProfile ?? 0);
    const srvProfileId = Number(params.srvProfile ?? 1);
    const maxPon = Number(params.maxPon ?? 8);

    if (!/^[A-Z0-9-]{12,16}$/.test(serial)) throw new Error('Serial Number ONU tidak valid.');
    if (onuNumber !== null && (!Number.isInteger(onuNumber) || onuNumber < 1 || onuNumber > 127)) {
      throw new Error('Nomor modem tidak valid.');
    }
    if (!Number.isInteger(lineProfileId) || lineProfileId < 0 || lineProfileId > 2047 ||
        !Number.isInteger(srvProfileId) || srvProfileId < 0 || srvProfileId > 2047) {
      throw new Error('Profil registrasi tidak valid.');
    }
    if (!Number.isInteger(maxPon) || maxPon < 1 || maxPon > 8) throw new Error('Jumlah PON OLT tidak valid.');

    // Live autofind avoids parsing the large running-config output, which times out
    // on this firmware. Registered ONTs should not be present in the unconfigured list.
    const matches = [];
    for (let pon = 1; pon <= maxPon; pon++) {
      const discovered = await this.hsgqGetUnconfiguredONUs(oltConfig, String(pon));
      for (const item of (Array.isArray(discovered) ? discovered : [])) {
        if (hsgqSerialsMatch(item.sn, serial)) matches.push({ pon, discoveredSn: String(item.sn || '').trim().toUpperCase() });
      }
    }
    if (!matches.length) {
      throw new Error(`SN ${serial} tidak ditemukan di autofind PON 1–${maxPon}. ONT tidak ditambahkan. Jika SN sudah terdaftar, periksa status OLT sebelum mencoba ulang.`);
    }
    if (matches.length > 1) {
      throw new Error(`SN ${serial} ditemukan di lebih dari satu PON (${matches.map(m => m.pon).join(', ')}). Tidak ada perubahan dilakukan.`);
    }
    const ponId = matches[0].pon;

    // Auto-assign the first free ID using the OLT's SNMP inventory. Unlike
    // ont-version alone, this inventory includes configured ONTs even when offline.
    if (onuNumber === null) {
      const inventory = params.occupiedOnus;
      if (!Array.isArray(inventory) || inventory.length === 0) {
        throw new Error('Daftar modem OLT belum bisa diperiksa. Binding dibatalkan demi keamanan.');
      }
      const used = new Set();
      for (const item of inventory) {
        const rowPon = Number(item && item.pon);
        const rowId = Number(item && item.onuId);
        if (rowPon === ponId && Number.isInteger(rowId) && rowId >= 0 && rowId <= 127) used.add(rowId);
      }
      let nextId = 1;
      while (nextId <= 127 && used.has(nextId)) nextId++;
      if (nextId > 127) throw new Error('Port PON ini penuh. Tidak ada slot modem yang tersedia.');
      onuNumber = nextId;
    }

    const readField = (output, field) => {
      const row = String(output || '').replace(/\r/g, '').split('\n')
        .find(line => line.trimStart().toLowerCase().startsWith(field.toLowerCase()));
      if (!row) return '';
      const colon = row.indexOf(':');
      return colon >= 0 ? row.slice(colon + 1).trim() : '';
    };

    // HSGQ-G008ID V2.0.5 does not support `show ont-version`; it returns
    // "Unknown command". Use supported `show ont-info all` to verify slot occupancy.
    // Never interpret a rejected version command as an empty ONU.
    const before = await this.runHSGQTelnet(oltConfig, [
      'enable', 'configure', `interface gpon ${ponId}`, 'show ont-info all'
    ]);
    if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input)/i.test(String(before))) {
      throw new Error('OLT tidak mendukung pembacaan daftar ONT untuk memeriksa slot; binding dibatalkan.');
    }
    const occupiedRow = String(before).replace(/\r/g, '').split('\n').find(line =>
      new RegExp('^\\s*' + ponId + '/' + onuNumber + '\\s+(?:GPON|EPON)\\s+', 'i').test(line)
    );
    if (occupiedRow) {
      const occupiedSerial = occupiedRow.trim().split(/\s+/)[2] || 'SN tidak terbaca';
      throw new Error(`ONU ID ${onuNumber} di PON ${ponId} sudah terisi (${occupiedSerial}). Pilih ID kosong; tidak ada perubahan dilakukan.`);
    }

    // Verify that the requested registration profiles exist on this exact OLT.
    // HSGQ_LURING currently has line profiles 0/1/2/3, but only service profile 0;
    // never send a registration command with a missing profile ID.
    const lineProfileOutput = await this.runHSGQTelnet(oltConfig, [
      'enable', 'configure', 'show ont-lineprofile all'
    ]);
    const lineProfileIds = new Set(
      Array.from(String(lineProfileOutput).replace(/\r/g, '').matchAll(/^\s*(\d+)\s+\S+/gm), match => Number(match[1]))
    );
    if (!lineProfileIds.has(lineProfileId)) {
      throw new Error(`Line profile ID ${lineProfileId} ora ana ing OLT. Profil kasedhiya: ${Array.from(lineProfileIds).sort((a,b)=>a-b).join(', ')}. Binding dibatalake tanpa ngganti konfigurasi OLT.`);
    }
    const srvProfileOutput = await this.runHSGQTelnet(oltConfig, [
      'enable', 'configure', 'show ont-srvprofile all'
    ]);
    const srvProfileIds = new Set(
      Array.from(String(srvProfileOutput).replace(/\r/g, '').matchAll(/^\s*(\d+)\s+\S+/gm), match => Number(match[1]))
    );
    if (!srvProfileIds.has(srvProfileId)) {
      throw new Error(`Service profile ID ${srvProfileId} ora ana ing OLT. Profil kasedhiya: ${Array.from(srvProfileIds).sort((a,b)=>a-b).join(', ')}. Binding dibatalake tanpa ngganti konfigurasi OLT.`);
    }

    const addCommand = `ont add ${onuNumber} sn-auth ${serial} omci ont-lineprofile-id ${lineProfileId} ont-srvprofile-id ${srvProfileId}`;
    let addOutput = '';
    try {
      addOutput = await this.runHSGQTelnet(oltConfig, [
        'enable', 'configure', `interface gpon ${ponId}`, addCommand
      ]);
    } catch (error) {
      throw new Error(`OLT menolak atau tidak memberi respons pasti atas binding PON ${ponId}/ONU ${onuNumber}. Periksa status slot di OLT sebelum mencoba ulang. Detail: ${String(error.message || error).slice(-450)}`);
    }
    if (/(?:\bfail(?:ed|ure)?\b|already\s+(?:exists|registered|added|bound)|\b(?:occupied|in use)\b|(?:profile|service\s*profile|line\s*profile).{0,50}(?:not found|does not exist|invalid)|unknown command|invalid parameter|parameter error)/i.test(addOutput)) {
      const detail = String(addOutput).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-500);
      throw new Error(`OLT melaporkan gagal binding PON ${ponId}/ONU ${onuNumber}. Detail respons OLT: ${detail || 'respons OLT ora cetha'}. Ora diulang otomatis; periksa status slot sadurunge nyoba maneh.`);
    }
    const explicitSuccess = /\badd\b[\s\S]{0,120}\b(?:successfully|success)\b|\bsuccess\s*:\s*1\b/i.test(addOutput);

    let verified = false;
    let verificationError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const statusOutput = await this.runHSGQTelnet(oltConfig, [
          'enable', 'configure', `interface gpon ${ponId}`, 'show ont-info all'
        ]);
        const statusRow = String(statusOutput).replace(/\r/g, '').split('\n').find(line => {
          const row = line.match(/^\s*(\d+)\/(\d+)\s+(?:GPON|EPON)\s+([A-Z0-9-]{12,16})\b/i);
          return row && Number(row[1]) === ponId && Number(row[2]) === onuNumber && hsgqSerialsMatch(row[3], serial);
        });
        if (statusRow) {
          verified = true;
          break;
        }
        if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input)/i.test(String(statusOutput))) {
          verificationError = 'OLT menolak show ont-info all; status binding belum dapat dipastikan.';
        }
      } catch (error) {
        verificationError = String(error.message || error);
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700));
    }
    if (!verified && !explicitSuccess) {
      throw new Error(`Perintah binding sudah dikirim, tetapi hasil PON ${ponId}/ONU ${onuNumber} belum dapat dipastikan. Jangan ulangi dulu; periksa slot di OLT. ${verificationError}`);
    }

    try {
      // HSGQ CLI saves configuration with `save` from global config mode.
      // The old exit/exit/copy sequence dropped to OLT> and was rejected, leaving
      // a successful `ont add` reported as a binding failure.
      await this.runHSGQTelnet(oltConfig, ['enable', 'configure', 'save']);
    } catch (error) {
      throw new Error(`Binding PON ${ponId}/ONU ${onuNumber} sudah diterima, tetapi penyimpanan konfigurasi startup gagal. Jangan ulangi binding; periksa OLT. Detail: ${String(error.message || error).slice(-350)}`);
    }

    return {
      success: true,
      pon: ponId,
      onuId: onuNumber,
      sn: serial,
      verified,
      message: verified
        ? 'ONT berhasil didaftarkan dan slotnya terverifikasi di OLT.'
        : 'Perintah binding diterima dan konfigurasi disimpan; status versi ONT belum muncul saat pemeriksaan awal.'
    };
  }

  /**
   * HSGQ OLT - Provision ONU (Supports EPON & GPON)
   */
  async hsgqProvisionONU(oltConfig, params) {
    try {
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const ponRaw = String(pon || '').trim();
      const ponMatch = ponRaw.match(/^(?:gpon\s*)?(\d+)$/i);
      const ponId = ponMatch ? Number(ponMatch[1]) : NaN;
      const onuNumber = Number(onuId);
      // Existing working HSGQ internet ONUs use line profile 0 + service profile 1.
      // Preserve explicit profile ID 0; never treat it as a missing value.
      const lineProfileId = Number(params.lineProfile ?? params.ontLineProfileId ?? 0);
      const srvProfileId = Number(params.srvProfile ?? params.ontSrvProfileId ?? 1);
      const serial = String(sn || '').trim();
      // HSGQ stores the ONU label as the description on registration.
      // Keep it to a single safe CLI token to avoid breaking the command.
      const ontName = String(name || 'Pelanggan').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 32) || 'Pelanggan';

      if (!Number.isInteger(ponId) || ponId < 1 || ponId > 8) {
        throw new Error('Port GPON HSGQ harus angka 1-8 (contoh: 1)');
      }
      if (!Number.isInteger(onuNumber) || onuNumber < 0 || onuNumber > 127) {
        throw new Error('ONU ID HSGQ harus angka 0-127');
      }
      if (!/^[A-Za-z0-9-]{12,16}$/.test(serial)) {
        throw new Error('Serial Number ONU tidak valid (HSGQ menerima 12-16 karakter alfanumerik/tanda hubung)');
      }
      if (!Number.isInteger(lineProfileId) || lineProfileId < 0 || lineProfileId > 2047 || !Number.isInteger(srvProfileId) || srvProfileId < 0 || srvProfileId > 2047) {
        throw new Error('Line Profile dan Service Profile harus berupa ID angka 0-2047');
      }

      // HSGQ-G008ID GPON CLI uses `interface gpon N` and `ont add ... sn-auth ... omci`.
      // The old `onu ...` / `gpon-olt_...` commands belong to other vendors and were
      // being reported as success even when HSGQ rejected them.
      const cmds = [
        'enable',
        'configure',
        `interface gpon ${ponId}`,
        `ont add ${onuNumber} sn-auth ${serial} omci ont-lineprofile-id ${lineProfileId} ont-srvprofile-id ${srvProfileId}`
      ];

      // HSGQ-G02ID rejects `show ont-info all`; use running-config as the source of
      // truth for existing ONU IDs and serials. Never issue `ont add` if this read fails.
      const runningBefore = await this.runHSGQTelnet(oltConfig, [
        'enable', 'configure', 'show running-config'
      ]);
      if (/(?:Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|Connection timed out|Unable to connect)/i.test(String(runningBefore))) {
        throw new Error('Tidak bisa membaca running-config OLT untuk memeriksa binding yang sudah ada; ONU tidak ditambahkan.');
      }
      // Validate all required profiles BEFORE any OLT mutation. Firmware config uses
      // the name TR069 (not only 'acs'); accept either label but require a real profile.
      const configLines = String(runningBefore).replace(/\r/g, '').split('\n');
      const tr069ProfileLine = configLines.find(line => /ont-tr069-profile\s+add\s+profile-id\s+\d+\s+profile-name\s+[\"'](?:acs|tr069)[\"']/i.test(line));
      const tr069ProfileMatch = tr069ProfileLine && tr069ProfileLine.match(/ont-tr069-profile\s+add\s+profile-id\s+(\d+)/i);
      if (!tr069ProfileMatch) throw new Error('Profil TR-069 bernama acs/TR069 tidak ditemukan di running-config OLT; tidak ada perubahan dilakukan.');
      if (!configLines.some(line => { const m = line.match(/^\s*ont-lineprofile\s+gpon\s+profile-id\s+(\d+)\b/i); return m && Number(m[1]) === lineProfileId; })) {
        throw new Error(`Line profile ${lineProfileId} tidak ditemukan di running-config OLT; tidak ada perubahan dilakukan.`);
      }
      if (!configLines.some(line => { const m = line.match(/^\s*ont-srvprofile\s+gpon\s+profile-id\s+(\d+)\b/i); return m && Number(m[1]) === srvProfileId; })) {
        throw new Error(`Service profile ${srvProfileId} tidak ditemukan di running-config OLT; tidak ada perubahan dilakukan.`);
      }

      const expectedSerialForms = hsgqSerialForms(serial);
      const registered = [];
      let registeredPon = null;
      for (const line of String(runningBefore).replace(/\r/g, '').split('\n')) {
        const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
        if (iface) { registeredPon = Number(iface[1]); continue; }
        if (/^\s*exit\s*$/i.test(line)) { registeredPon = null; continue; }
        const row = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b/i);
        if (row && registeredPon === ponId) registered.push({ id: Number(row[1]), serial: row[2].toUpperCase() });
      }
      const atRequestedId = registered.find(o => o.id === onuNumber);
      const sameSerial = registered.find(o => expectedSerialForms.has(o.serial) || hsgqSerialsMatch(o.serial, serial));
      if (atRequestedId && !expectedSerialForms.has(atRequestedId.serial) && !hsgqSerialsMatch(atRequestedId.serial, serial)) {
        throw new Error(`ONU ID ${onuNumber} pada PON ${ponId} sudah dipakai serial ${atRequestedId.serial}; pilih ID kosong yang benar.`);
      }
      if (sameSerial && sameSerial.id !== onuNumber) {
        throw new Error(`Serial ONU ini sudah terdaftar pada PON ${ponId}, ID ${sameSerial.id}; jangan membuat binding ganda.`);
      }
      // Check saved configuration globally as well; same serial must not be bound twice.
      const configText = String(runningBefore).replace(/\r/g, '');
      let configPon = null;
      let configBinding = null;
      for (const line of configText.split('\n')) {
        const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
        if (iface) { configPon = Number(iface[1]); continue; }
        if (/^\s*exit\s*$/i.test(line)) { configPon = null; continue; }
        const add = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b/i);
        if (add && hsgqSerialsMatch(add[2], serial)) configBinding = { pon: configPon, id: Number(add[1]), serial: add[2].toUpperCase() };
      }
      if (configBinding && (configBinding.pon !== ponId || configBinding.id !== onuNumber)) {
        throw new Error(`Serial ONU ini sudah tercatat pada konfigurasi OLT di PON ${configBinding.pon}, ID ${configBinding.id}. Tidak dibuat binding ganda; periksa ONU yang dipilih.`);
      }
      const alreadyRegistered = Boolean(configBinding || (atRequestedId && (expectedSerialForms.has(atRequestedId.serial) || hsgqSerialsMatch(atRequestedId.serial, serial))));
      // ONU ID 0 is present on some HSGQ-G008ID installations. It may only be reused
      // when the exact SN is already registered; never issue `ont add 0` for a new ONU.
      if (onuNumber === 0 && !alreadyRegistered) {
        throw new Error('ONU ID 0 hanya boleh digunakan untuk SN yang sudah terdaftar; binding baru harus memakai ID 1–127.');
      }
      if (!alreadyRegistered) await this.runHSGQTelnet(oltConfig, cmds);

      // HSGQ GPON CLI exposes ONU naming separately from registration.
      // A naming failure must not prevent the service-port setup from being attempted.
      let oltNameSet = false;
      try {
        await this.runHSGQTelnet(oltConfig, [
          'enable',
          'configure',
          `interface gpon ${ponId}`,
          `ont setting ${onuNumber} name ${ontName}`
        ]);
        oltNameSet = true;
      } catch (nameError) {
        logger.warn(`HSGQ ONU ${ponId}/${onuNumber} berhasil ditambahkan tetapi nama OLT tidak berhasil diatur: ${nameError.message}`);
      }

      // Use the profile validated before any OLT mutation above.
      const tr069ProfileId = Number(tr069ProfileMatch[1]);
      await this.runHSGQTelnet(oltConfig, [
        'enable', 'configure', `interface gpon ${ponId}`,
        `ont tr069-profile ${onuNumber} profile-id ${tr069ProfileId}`,
        'exit', 'save'
      ]);

      // Verify the binding from the authoritative running-config before reporting success.
      const verifyConfig = await this.runHSGQTelnet(oltConfig, ['enable', 'configure', 'show running-config']);
      let verifyPon = null;
      let tr069BindingVerified = false;
      let registeredBindingVerified = false;
      for (const line of String(verifyConfig).replace(/\r/g, '').split('\n')) {
        const iface = line.match(/^\s*interface\s+gpon\s+(\d+)\s*$/i);
        if (iface) { verifyPon = Number(iface[1]); continue; }
        if (/^\s*exit\s*$/i.test(line)) { verifyPon = null; continue; }
        const bind = line.match(/^\s*ont\s+tr069-profile\s+(\d+)\s+profile-id\s+(\d+)/i);
        if (verifyPon === ponId && bind && Number(bind[1]) === onuNumber && Number(bind[2]) === tr069ProfileId) tr069BindingVerified = true;
        const add = line.match(/^\s*ont\s+add\s+(\d+)\s+sn-auth\s+([A-Za-z0-9-]{12,16})\b/i);
        if (verifyPon === ponId && add && Number(add[1]) === onuNumber && hsgqSerialsMatch(add[2], serial)) registeredBindingVerified = true;
      }
      if (!registeredBindingVerified) {
        throw new Error(`ONU ${ponId}/${onuNumber} belum terverifikasi dengan SN yang diminta pada running-config; periksa OLT sebelum mencoba ulang.`);
      }
      if (!tr069BindingVerified) {
        throw new Error(`ONU ${ponId}/${onuNumber} sudah terdaftar, tetapi binding TR-069 profile ${tr069ProfileId} belum terverifikasi dari running-config. VLAN/service-port tidak diubah.`);
      }

      // Service-port VLAN setup remains intentionally skipped per operator choice (option 2).
      // Never alter internet VLAN 100 automatically; management VLAN 1011 must be verified separately.
      logger.warn(`HSGQ ONU ${ponId}/${onuNumber}: TR-069 profile ${tr069ProfileId} applied and verified; Service Port VLAN 1011/100 checks remain skipped.`);
      return {
        success: true,
        registeredSerial: String(configBinding?.serial || sameSerial?.serial || atRequestedId?.serial || serial).toUpperCase(),
        message: `ONU terdaftar di OLT HSGQ. ${oltNameSet ? 'Nama ONU berhasil diatur.' : 'Nama ONU belum terverifikasi.'} Profil TR-069 ${tr069ProfileId} berhasil dipasang dan diverifikasi. Pemeriksaan/pembuatan Service Port VLAN 1011/100 tetap dilewati; jalur management VLAN 1011 harus diverifikasi terpisah.`
      };
    } catch (error) {
      logger.error('HSGQ provision ONU error:', error);
      throw error;
    }
  }

  /**
   * HIOSO OLT - Provision ONU (Supports EPON & GPON)
   */
  async hiosoProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon') || (!ponLower.includes('gpon'));
      
      const cmds = [
        'enable',
        'config'
      ];

      if (isEpon) {
        const epInterface = ponLower.includes('epon') ? pon : `epon 0/${pon}`;
        cmds.push(`interface ${epInterface}`);
        cmds.push(`onu add ${onuId} mac ${sn}`);
        cmds.push(`onu ${onuId} name ${name}`);
        if (vlan) {
          cmds.push(`onu ${onuId} vlan mode tag vlan ${vlan}`);
        }
      } else {
        const gpInterface = ponLower.includes('gpon') ? pon : `gpon-olt_1/${pon}`;
        cmds.push(`interface ${gpInterface}`);
        cmds.push(`onu ${onuId} type ${params.onuType || 'HIOSO-ONU'} sn ${sn}`);
        cmds.push('exit');
        const onuInterface = ponLower.includes('gpon') ? `${pon}:${onuId}` : `gpon-onu_1/${pon}:${onuId}`;
        cmds.push(`interface ${onuInterface}`);
        cmds.push(`name ${name}`);
        cmds.push(`tcont 1 profile ${bandwidth || 'default'}`);
        cmds.push('gemport 1 tcont 1');
        cmds.push('exit');
        cmds.push(`pon-onu-mng ${onuInterface}`);
        cmds.push(`service 1 gemport 1 vlan ${vlan}`);
        cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
        cmds.push('exit');
      }
      
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully on HIOSO${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('HIOSO provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Huawei MA5800 - Get unconfigured ONUs
   */
  async huaweiGetUnconfiguredONUs(oltConfig, frame, slot, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const cleanFrame = sanitizeCliInput(frame);
      const cleanSlot = sanitizeCliInput(slot);
      const cleanPon = sanitizeCliInput(pon);
      
      const commands = [
        'enable',
        `display ont autofind ${cleanFrame}/${cleanSlot}/${cleanPon}`
      ];
      
      const output = await this.executeCommands(conn, commands);
      const onus = this.parseHuaweiUnconfiguredONUs(output, cleanFrame, cleanSlot, cleanPon);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse Huawei unconfigured ONUs output robustly (handles both block and table formats)
   */
  parseHuaweiUnconfiguredONUs(output, frame, slot, pon) {
    const onus = [];
    
    if (output.includes('Ont SN') || output.includes('Slot/Port')) {
      const blocks = output.split(/----------------------------------------------------------------------/);
      for (const block of blocks) {
        const snMatch = block.match(/Ont\s+SN\s*:\s*(\S+)/i);
        if (snMatch) {
          let sn = snMatch[1];
          sn = sn.split('(')[0].trim();
          
          const portMatch = block.match(/Slot\/Port\s*:\s*(\d+\/\d+\/\d+)/i) || block.match(/Slot\/Port\s*:\s*(\d+\/\d+)/i);
          let blockPon = pon;
          let blockSlot = slot;
          let blockFrame = frame;
          
          if (portMatch) {
            const parts = portMatch[1].split('/');
            if (parts.length === 3) {
              blockFrame = parts[0];
              blockSlot = parts[1];
              blockPon = parts[2];
            } else if (parts.length === 2) {
              blockSlot = parts[0];
              blockPon = parts[1];
            }
          }
          
          const modelMatch = block.match(/Ont\s+EquipmentID\s*:\s*(\S+)/i) || block.match(/Ont\s+Type\s*:\s*(\S+)/i);
          const model = modelMatch ? modelMatch[1] : 'Unknown';
          
          onus.push({
            frame: blockFrame,
            slot: blockSlot,
            pon: blockPon,
            onuId: onus.length.toString(),
            sn,
            model,
            vendor: 'Huawei'
          });
        }
      }
    } else {
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/(?:^|\s)([0-9A-F]{16}|[A-Z]{4}[0-9A-F]{8}|HWTC[0-9A-F]{8})(?:\s|$)/i);
        if (match) {
          const sn = match[1];
          const parts = line.trim().split(/\s+/);
          let blockFrame = frame, blockSlot = slot, blockPon = pon;
          const portPart = parts.find(p => /^\d+\/\d+\/\d+$/.test(p) || /^\d+\/\d+$/.test(p));
          if (portPart) {
            const p = portPart.split('/');
            if (p.length === 3) {
              blockFrame = p[0];
              blockSlot = p[1];
              blockPon = p[2];
            } else if (p.length === 2) {
              blockSlot = p[0];
              blockPon = p[1];
            }
          }
          
          onus.push({
            frame: blockFrame,
            slot: blockSlot,
            pon: blockPon,
            onuId: parts[0] || onus.length.toString(),
            sn,
            model: 'Unknown',
            vendor: 'Huawei'
          });
        }
      }
    }
    
    return onus;
  }

  /**
   * Huawei MA5800 - Provision ONU
   */
  async huaweiProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { frame, slot, pon, onuId, sn, name, vlan, bandwidth, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont add ${pon} ${onuId} sn-auth ${sn} omci ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}`
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ont wifi-config ${pon} ${onuId} ssid ${wifiSsid} wpa-psk ${wifiPassword}`);
      }
      
      if (lanMode) {
        cmds.push(`ont port native-vlan ${pon} ${onuId} eth 1 vlan ${vlan} priority 0`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`ont wan-config ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push(`ont tr069-server ${pon} ${onuId} url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`ont tr069-server ${pon} ${onuId} username ${tr069AcsUsername} password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`ont tr069-server ${pon} ${onuId} periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push(`ont tr069-server ${pon} ${onuId} periodic-inform enable`);
        }
        cmds.push(`ont tr069-server ${pon} ${onuId} enable`);
      }
      
      cmds.push('quit');
      cmds.push(`service-port vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
      cmds.push('save');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Fiberhome AN5516 - Provision ONU
   */
  async fiberhomeProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { frame, slot, pon, onuId, sn, name, vlan, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont add ${pon} ${onuId} sn-auth ${sn} ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}`
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ont wlan ssid ${pon} ${onuId} 1 ${wifiSsid}`);
        cmds.push(`ont wlan security ${pon} ${onuId} 1 wpa2-psk aes ${wifiPassword}`);
        cmds.push(`ont wlan enable ${pon} ${onuId} 1`);
      }
      
      if (lanMode) {
        cmds.push(`ont port vlan ${pon} ${onuId} eth 1 mode tag vlan ${vlan}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`ont wan ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push(`ont cwmp ${pon} ${onuId} acs-url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`ont cwmp ${pon} ${onuId} acs-username ${tr069AcsUsername}`);
          cmds.push(`ont cwmp ${pon} ${onuId} acs-password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`ont cwmp ${pon} ${onuId} periodic-inform-interval ${tr069PeriodicInform}`);
          cmds.push(`ont cwmp ${pon} ${onuId} periodic-inform enable`);
        }
        cmds.push(`ont cwmp ${pon} ${onuId} enable`);
      }
      
      cmds.push('quit');
      cmds.push(`service-port ${vlan} vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Fiberhome provision ONU error:', error);
      throw error;
    }
  }

  /**
   * VSOL V1600/V2400 - Provision ONU
   */
  async vsolProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'V2802RGW'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('tr069 enable');
        cmds.push(`tr069 acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`tr069 acs username ${tr069AcsUsername}`);
          cmds.push(`tr069 acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`tr069 periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('tr069 periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('VSOL provision ONU error:', error);
      throw error;
    }
  }

  /**
   * C-Data FD1600/FD1800 - Provision ONU
   */
  async cdataProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'FD1104S'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('cwmp enable');
        cmds.push(`cwmp acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`cwmp acs username ${tr069AcsUsername}`);
          cmds.push(`cwmp acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`cwmp periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('cwmp periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('C-Data provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Get ONU details (works for both ZTE and Huawei)
   */
  async getONUDetails(oltConfig, vendor, params) {
    if (vendor === 'ZTE') {
      return this.zteGetONUDetails(oltConfig, params);
    } else if (vendor === 'Huawei') {
      return this.huaweiGetONUDetails(oltConfig, params);
    }
    throw new Error('Unsupported vendor');
  }

  /**
   * ZTE - Get ONU details
   */
  async zteGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const { pon, onuId } = params;
      const cmds = [
        'enable',
        `show gpon onu detail-info gpon-onu_${pon}:${onuId}`
      ];
      const output = await this.executeCommands(conn, cmds);
      conn.end();
      
      return this.parseZTEONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse ZTE ONU details
   */
  parseZTEONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Name:')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN:')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Status:')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('RX Power:')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Huawei - Get ONU details
   */
  async huaweiGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const { frame, slot, pon, onuId } = params;
      const cmds = [
        'enable',
        `display ont info ${frame} ${slot} ${pon} ${onuId}`
      ];
      const output = await this.executeCommands(conn, cmds);
      conn.end();
      
      return this.parseHuaweiONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse Huawei ONU details
   */
  parseHuaweiONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Description')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Run state')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('Rx optical power')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Delete ONU
   */
  async deleteONU(oltConfig, vendor, params) {
    params = sanitizeParams(params);
    const v = String(vendor || '').toUpperCase();
    if (v === 'ZTE') {
      return this.zteDeleteONU(oltConfig, params);
    } else if (v === 'HUAWEI') {
      return this.huaweiDeleteONU(oltConfig, params);
    } else if (v === 'FIBERHOME') {
      return this.fiberhomeDeleteONU(oltConfig, params);
    } else if (v === 'VSOL') {
      return this.vsolDeleteONU(oltConfig, params);
    } else if (v === 'CDATA') {
      return this.cdataDeleteONU(oltConfig, params);
    } else if (v === 'HSGQ') {
      return this.hsgqDeleteONU(oltConfig, params);
    } else if (v === 'HIOSO') {
      return this.hiosoDeleteONU(oltConfig, params);
    }
    throw new Error(`Unsupported vendor: ${vendor}`);
  }

  /**
   * ZTE - Delete ONU
   */
  async zteDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit',
        'write'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Huawei - Delete ONU
   */
  async huaweiDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, slot, pon, onuId } = params;
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont delete ${pon} ${onuId}`,
        'quit',
        'save'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Fiberhome - Delete ONU
   */
  async fiberhomeDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, slot, pon, onuId } = params;
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont delete ${pon} ${onuId}`,
        'quit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on Fiberhome' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * VSOL - Delete ONU
   */
  async vsolDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on VSOL' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * C-Data - Delete ONU
   */
  async cdataDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on C-Data' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * HSGQ - Delete ONU (Supports EPON & GPON)
   */
  async hsgqDeleteONU(oltConfig, params) {
    params = sanitizeParams(params);
    const ponRaw = String(params.pon || '').trim();
    const indexRaw = String(params.index || '').trim();
    let ponNumber = null;
    let onuId = params.onuId != null ? Number(params.onuId) : null;

    const formatted = (ponRaw + ' ' + indexRaw).match(/(?:0\/)?(\d+)\s*:\s*(\d+)/);
    if (formatted) {
      ponNumber = Number(formatted[1]);
      if (!Number.isInteger(onuId) || onuId < 0) onuId = Number(formatted[2]);
    } else if (ponRaw) {
      const matchPon = ponRaw.match(/(?:gpon|epon)(?:-olt)?[_\s-]*(\d+)/i) || ponRaw.match(/^(\d+)$/);
      if (matchPon) ponNumber = Number(matchPon[1]);
    }
    if ((ponNumber == null || !Number.isInteger(onuId) || onuId < 0) && /^\d+$/.test(indexRaw)) {
      const idx = Number(indexRaw);
      let port = (idx >> 16) & 0xff;
      if (port === 0 || port > 16) port = (idx >> 8) & 0xff;
      const onu = idx & 0xff;
      if (port > 0) ponNumber = port;
      if (Number.isInteger(onu) && onu >= 0) onuId = onu;
    }
    if (!Number.isInteger(ponNumber) || ponNumber < 1 || ponNumber > 16 ||
        !Number.isInteger(onuId) || onuId < 0 || onuId > 127) {
      throw new Error('PON/ONU ID HSGQ tidak valid; gunakan ID dari hasil pencarian SN.');
    }

    const normalizeSerial = (value) => {
      let serial = String(value || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
      const rawHex = serial.match(/^([0-9A-F]{8})([0-9A-F]{8})$/);
      if (rawHex) {
        const alias = Buffer.from(rawHex[1], 'hex').toString('ascii').toUpperCase();
        if (/^[A-Z0-9]{4}$/.test(alias)) serial = alias + rawHex[2];
      }
      return serial;
    };
    const expectedSn = normalizeSerial(params.sn);
    if (!expectedSn || !/^[A-Z0-9]{12,16}$/.test(expectedSn)) {
      throw new Error('SN ONT tidak valid. Cari SN melalui inventaris OLT terlebih dahulu.');
    }
    if (!Number.isSafeInteger(Number(oltConfig.id)) || Number(oltConfig.id) < 1) {
      throw new Error('ID OLT tidak tersedia; penghapusan dibatalkan karena target tidak bisa diverifikasi.');
    }

    const readInventory = async () => {
      const oltSvc = require('./oltService');
      const rows = await oltSvc.getConfiguredOnusForProvision(Number(oltConfig.id));
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Inventaris ONT OLT tidak tersedia atau kosong. Tidak ada perubahan dilakukan.');
      }
      return rows.map(row => {
        const location = String(row.id || row.index || '').match(/(?:^|\/)(\d+):(\d+)$/);
        if (!location) return null;
        return {
          pon: Number(location[1]),
          onuId: Number(location[2]),
          sn: normalizeSerial(row.sn || row.serialNumber || row.mac || ''),
          id: String(row.id || ''),
          status: String(row.status || '')
        };
      }).filter(Boolean);
    };

    // Compare exact SN and slot against the live configured ONU inventory before deleting.
    const beforeEntries = await readInventory();
    const target = beforeEntries.find(row => row.pon === ponNumber && row.onuId === onuId);
    if (!target) throw new Error('PON/ID ONU tidak ditemukan pada inventaris OLT saat ini. Cari SN ulang sebelum mencoba hapus.');
    if (target.sn !== expectedSn) {
      throw new Error('SN di slot PON ' + ponNumber + ', ONU ' + onuId + ' berbeda dari SN yang dipilih. Penghapusan dibatalkan.');
    }
    if (beforeEntries.filter(row => row.sn === expectedSn).length !== 1) {
      throw new Error('SN ini muncul lebih dari satu kali di inventaris OLT. Penghapusan otomatis dibatalkan demi keamanan.');
    }

    const result = await this.runHSGQTelnet(oltConfig, [
      'enable', 'configure', 'interface gpon ' + ponNumber,
      'ont delete ' + onuId, 'exit', 'save'
    ]);
    if (/Unknown command|There is no matched command|Command incomplete|%\s*Invalid input|vty%\s*Error/i.test(String(result))) {
      throw new Error('OLT menolak perintah penghapusan. Hasil tidak dianggap berhasil.');
    }
    if (!/Configuration saved successfully/i.test(String(result))) {
      throw new Error('OLT belum mengonfirmasi penyimpanan konfigurasi. Cari SN ulang dan periksa status sebelum mencoba lagi.');
    }

    // Verify deletion using the same inventory source that is responsive on this OLT.
    const afterEntries = await readInventory();
    if (afterEntries.some(row => row.sn === expectedSn) ||
        afterEntries.some(row => row.pon === ponNumber && row.onuId === onuId)) {
      throw new Error('Inventaris OLT masih menampilkan SN atau slot ONU setelah perintah hapus. Hasil belum terverifikasi; cari SN ulang sebelum mencoba lagi.');
    }
    return {
      success: true,
      message: 'SN ' + expectedSn + ' pada GPON ' + ponNumber + ', ONU ' + onuId +
        ' berhasil dihapus dan diverifikasi tidak ada lagi di inventaris OLT.'
    };
  }

  /**
   * HIOSO - Delete ONU (Supports EPON & GPON)
   */
  async hiosoDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon') || (!ponLower.includes('gpon'));
      
      const cmds = [
        'enable',
        'config'
      ];
      
      if (isEpon) {
        const epInterface = ponLower.includes('epon') ? pon : `epon 0/${pon}`;
        cmds.push(`interface ${epInterface}`);
        cmds.push(`no onu ${onuId}`);
      } else {
        const gpInterface = ponLower.includes('gpon') ? pon : `gpon-olt_1/${pon}`;
        cmds.push(`interface ${gpInterface}`);
        cmds.push(`no onu ${onuId}`);
      }
      cmds.push('exit');
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on HIOSO' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Create PPPoE Secret in MikroTik
   */
  async createMikrotikPPPoE(mikrotikConfig, params) {
    const mikrotikService = require('./mikrotikService');
    
    try {
      const { username, password, profile, comment, localAddress, remoteAddress } = params;
      
      const secretData = {
        name: username,
        password: password,
        service: 'pppoe',
        profile: profile || 'default'
      };
      
      if (comment) {
        secretData.comment = comment;
      }
      
      if (localAddress) {
        secretData['local-address'] = localAddress;
      }
      
      if (remoteAddress) {
        secretData['remote-address'] = remoteAddress;
      }
      
      await mikrotikService.addPppoeSecret(secretData, params.routerId ?? null);
      
      logger.info(`PPPoE secret created in MikroTik: ${username}`);
      return { success: true, message: 'PPPoE secret created successfully' };
    } catch (error) {
      logger.error('Create MikroTik PPPoE error:', error);
      throw error;
    }
  }

  /**
   * Delete PPPoE Secret from MikroTik
   */
  async deleteMikrotikPPPoE(mikrotikConfig, username) {
    const mikrotikService = require('./mikrotikService');
    const routerId = mikrotikConfig && typeof mikrotikConfig === 'object'
      ? (mikrotikConfig.routerId ?? mikrotikConfig.id ?? null)
      : (mikrotikConfig ?? null);
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername) throw new Error('Username PPPoE wajib diisi.');
    let conn = null;
    try {
      conn = await mikrotikService.getConnection(routerId);
      const secrets = await conn.client.menu('/ppp/secret')
        .where('name', normalizedUsername)
        .get();
      const secret = Array.isArray(secrets) ? secrets[0] : null;
      const secretId = secret?.['.id'] || secret?.id;
      if (secretId) {
        await conn.client.menu('/ppp/secret').remove(secretId);
        logger.info(`PPPoE secret deleted from MikroTik: ${normalizedUsername}`);
      }
      return { success: true, message: secretId ? 'PPPoE secret deleted successfully' : 'PPPoE secret tidak ditemukan' };
    } catch (error) {
      logger.error('Delete MikroTik PPPoE error:', error);
      throw error;
    } finally {
      if (conn && conn.api) await conn.api.close();
    }
  }

  /**
   * Full Provision: ONU + MikroTik PPPoE
   */
  async fullProvision(oltConfig, mikrotikConfig, params) {
    const results = {
      onu: null,
      pppoe: null,
      errors: []
    };
    
    try {
      const { vendor } = params;
      
      if (vendor === 'ZTE') {
        results.onu = await this.zteProvisionONU(oltConfig, params);
      } else if (vendor === 'Huawei') {
        results.onu = await this.huaweiProvisionONU(oltConfig, params);
      } else if (vendor === 'Fiberhome') {
        results.onu = await this.fiberhomeProvisionONU(oltConfig, params);
      } else if (vendor === 'VSOL') {
        results.onu = await this.vsolProvisionONU(oltConfig, params);
      } else if (vendor === 'CData') {
        results.onu = await this.cdataProvisionONU(oltConfig, params);
      } else if (vendor === 'HSGQ') {
        results.onu = await this.hsgqProvisionONU(oltConfig, params);
      } else if (vendor === 'Hioso') {
        results.onu = await this.hiosoProvisionONU(oltConfig, params);
      } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
      }
      
      logger.info(`ONU provisioned: ${params.name} (${vendor})`);
      
      if (params.pppoeUsername && params.pppoePassword && mikrotikConfig) {
        try {
          results.pppoe = await this.createMikrotikPPPoE(mikrotikConfig, {
            username: params.pppoeUsername,
            password: params.pppoePassword,
            profile: params.bandwidth || 'default',
            comment: `${params.name} - Auto-provisioned`,
            remoteAddress: params.remoteAddress,
            routerId: params.router_id ?? params.routerId ?? mikrotikConfig.routerId ?? null
          });
          
          logger.info(`PPPoE created: ${params.pppoeUsername}`);
        } catch (pppoeError) {
          results.errors.push(`PPPoE creation failed: ${pppoeError.message}`);
          logger.error('PPPoE creation failed:', pppoeError);
        }
      }
      
      return {
        success: true,
        message: 'Full provisioning completed',
        results
      };
    } catch (error) {
      results.errors.push(`Provisioning failed: ${error.message}`);
      logger.error('Full provision error:', error);
      throw error;
    }
  }

  /**
   * Reboot ONU via SSH CLI (for ZTE and Huawei)
   */
  async rebootONU(oltConfig, vendor, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, board, port, onuId } = params;
      const cmds = [];
      
      if (vendor === 'ZTE') {
        cmds.push('enable');
        cmds.push('configure terminal');
        cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
        cmds.push('reboot');
      } else if (vendor === 'Huawei') {
        cmds.push('enable');
        cmds.push('config');
        cmds.push(`interface gpon ${frame}/${board}`);
        cmds.push(`ont reset ${port} ${onuId}`);
        cmds.push('quit');
        cmds.push('save');
      } else {
        throw new Error('Unsupported vendor for SSH reboot');
      }
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU rebooted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Rename ONU via SSH CLI (for ZTE and Huawei)
   */
  async renameONU(oltConfig, vendor, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, board, port, onuId, newName } = params;
      const cmds = [];
      
      if (vendor === 'ZTE') {
        cmds.push('enable');
        cmds.push('configure terminal');
        cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
        cmds.push(`name ${newName}`);
        cmds.push('exit');
        cmds.push('write');
      } else if (vendor === 'Huawei') {
        cmds.push('enable');
        cmds.push('config');
        cmds.push(`interface gpon ${frame}/${board}`);
        cmds.push(`ont name ${port} ${onuId} "${newName}"`);
        cmds.push('quit');
        cmds.push('save');
      } else {
        throw new Error('Unsupported vendor for SSH rename');
      }
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU renamed successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }
}

module.exports = new ONUProvisionService();

// Made with Bob
