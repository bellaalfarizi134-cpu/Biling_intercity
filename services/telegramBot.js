const TelegramBot = require('node-telegram-bot-api');
const { getSetting, getNowLocal } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikSvc = require('./mikrotikService');
const agentSvc = require('./agentService');
const customerDevice = require('./customerDeviceService');
const whatsappService = require('./whatsappService');
const db = require('../config/database');

let bot = null;

function initTelegram() {
  const enabled = getSetting('telegram_enabled', false);
  const token = getSetting('telegram_bot_token', '');

  if (!enabled || !token) {
    if (bot) {
      bot.stopPolling();
      bot = null;
      logger.info('Telegram Bot: Dihentikan (Nonaktif)');
    }
    return;
  }

  // Jika token berubah, kita harus stop bot lama dan buat baru
  if (bot && bot.token !== token) {
    bot.stopPolling();
    bot = null;
    logger.info('Telegram Bot: Token berubah, me-restart bot...');
  }

  if (bot) {
    logger.info('Telegram Bot: Sudah berjalan, melewati inisialisasi.');
    return; 
  }

  bot = new TelegramBot(token, { polling: true });
  
  // Clear webhook to ensure polling works (Sync)
  bot.deleteWebHook().then(() => {
    bot.getMe().then(me => {
      logger.info(`Telegram Bot: Terhubung sebagai @${me.username}`);
    }).catch(e => logger.error('Telegram Bot Error (getMe):', e.message));
  }).catch(e => logger.error('Telegram Bot Error (deleteWebHook):', e.message));

  // Middleware Admin Check (Fetch latest ID every time)
  const isAdmin = (msg) => {
    const currentAdminIds = getSetting('telegram_admin_id', '')
      .toString()
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    return currentAdminIds.includes(msg.from.id.toString());
  };

  // Helper Mikhmon Parser
  const parseMikhmon = (script) => {
    if (!script) return null;
    const s = String(script).trim();
    
    // Cari pattern :put (",rem, ... , ... , ...
    // Updated regex untuk support format: :put (",rem,4000,2d,5000,,Disable,");
    const putMatch = s.match(/:\s*put\s*\(\s*[",]rem[",]?\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)/i);
    if (putMatch) {
      const cost = String(putMatch[1] || '').trim();
      const validity = String(putMatch[2] || '').trim();
      const priceStr = String(putMatch[3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    // Fallback: split by comma
    const parts = s.split(',').map(p => String(p).trim());
    let remIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('rem')) {
        remIdx = i;
        break;
      }
    }
    
    if (remIdx >= 0 && remIdx + 3 < parts.length) {
      const cost = String(parts[remIdx + 1] || '').trim();
      const validity = String(parts[remIdx + 2] || '').trim();
      const priceStr = String(parts[remIdx + 3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    return null;
  };

  const isTruthy = (value) => {
    if (value === true || value === 1) return true;
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'on';
  };

  const formatGangguanCount = (scriptRow) => {
    const raw = scriptRow && scriptRow.source != null ? String(scriptRow.source) : '0';
    const count = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  };

  const loadPppoeSnapshot = async () => {
    const [secrets, active, scripts] = await Promise.all([
      mikrotikSvc.getPppoeSecrets(),
      mikrotikSvc.getPppoeActive(),
      mikrotikSvc.getSystemScripts()
    ]);
    const customers = customerSvc.getAllCustomers();

    const activeMap = new Map();
    (active || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) activeMap.set(name, row);
    });

    const scriptMap = new Map();
    (scripts || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) scriptMap.set(name, row);
    });

    const customerMap = new Map();
    (customers || []).forEach((row) => {
      const username = String(row && row.pppoe_username ? row.pppoe_username : '').trim();
      if (username) customerMap.set(username, row);
    });

    return {
      secrets: Array.isArray(secrets) ? secrets : [],
      active: Array.isArray(active) ? active : [],
      activeMap,
      scriptMap,
      customerMap
    };
  };

  const buildOfflineEntries = (snapshot) => {
    return snapshot.secrets
      .filter((secret) => {
        const username = String(secret && secret.name ? secret.name : '').trim();
        if (!username) return false;
        if (isTruthy(secret && secret.disabled)) return false;
        return !snapshot.activeMap.has(username);
      })
      .map((secret) => {
        const username = String(secret.name || '').trim();
        const customer = snapshot.customerMap.get(username) || null;
        const script = snapshot.scriptMap.get(username) || null;
        return {
          username,
          customerName: customer && customer.name ? customer.name : '-',
          phone: customer && customer.phone ? customer.phone : '-',
          profile: secret && secret.profile ? secret.profile : '-',
          service: secret && secret.service ? secret.service : '-',
          password: secret && secret.password ? secret.password : '-',
          failCount: formatGangguanCount(script)
        };
      })
      .sort((a, b) => {
        if (b.failCount !== a.failCount) return b.failCount - a.failCount;
        return a.username.localeCompare(b.username, 'id');
      });
  };

  const buildOfflineTelegramText = (snapshot) => {
    const now = getNowLocal();
    const offline = buildOfflineEntries(snapshot);
    const lines = [];
    lines.push('USER PPPoE OFFLINE');
    lines.push('============================');
    lines.push(`Waktu : ${now}`);
    lines.push('============================');
    lines.push('');
    lines.push('RINGKASAN');
    lines.push(`Total Secret : ${snapshot.secrets.length}`);
    lines.push(`Total Aktif  : ${snapshot.active.length}`);
    lines.push(`Total Offline: ${offline.length}`);
    lines.push('');
    lines.push('DAFTAR USER OFFLINE');

    if (offline.length === 0) {
      lines.push('Semua user sedang online.');
    } else {
      offline.slice(0, 20).forEach((row, index) => {
        lines.push(`${index + 1}. ${row.username}`);
        lines.push(`   Pelanggan : ${row.customerName}`);
        lines.push(`   WA        : ${row.phone}`);
        lines.push(`   Paket     : ${row.profile}`);
        lines.push(`   Gangguan  : ${row.failCount}x`);
      });
      if (offline.length > 20) {
        lines.push(`...dan ${offline.length - 20} user offline lainnya.`);
      }
    }

    lines.push('');
    lines.push('Cek detail 1 user: /cekpppoe username');
    lines.push('Contoh: /cekpppoe budi001');
    return lines.join('\n');
  };

  const buildPppoeUserDetailText = async (username) => {
    const target = String(username || '').trim();
    if (!target) throw new Error('Username PPPoE wajib diisi');

    const snapshot = await loadPppoeSnapshot();
    const secret = snapshot.secrets.find((row) => String(row && row.name ? row.name : '').trim() === target);
    if (!secret) {
      throw new Error(`PPPoE user "${target}" tidak ditemukan`);
    }

    const activeRow = snapshot.activeMap.get(target) || null;
    const customer = snapshot.customerMap.get(target) || null;
    const script = snapshot.scriptMap.get(target) || null;
    const offline = buildOfflineEntries(snapshot);

    const date = getNowLocal();
    const online = !!activeRow;
    const lines = [];
    lines.push('DETAIL CEK PPPoE');
    lines.push('============================');
    lines.push(`Waktu     : ${date}`);
    lines.push(`Status    : ${online ? 'ONLINE' : 'OFFLINE'}`);
    lines.push('============================');
    lines.push('INFO LAYANAN');
    lines.push(`Pelanggan : ${customer && customer.name ? customer.name : '-'}`);
    lines.push(`No. WA    : ${customer && customer.phone ? customer.phone : '-'}`);
    lines.push(`Username  : ${secret.name || '-'}`);
    lines.push(`Password  : ${secret.password || '-'}`);
    lines.push(`Service   : ${secret.service || '-'}`);
    lines.push(`Profile   : ${secret.profile || '-'}`);
    lines.push('');
    lines.push('INFO PERANGKAT');
    lines.push(`IP Aktif   : ${activeRow && activeRow.address ? activeRow.address : '-'}`);
    lines.push(`MAC/Caller : ${activeRow && (activeRow.callerId || activeRow['caller-id']) ? (activeRow.callerId || activeRow['caller-id']) : '-'}`);
    lines.push('');
    lines.push('STATUS GANGGUAN');
    lines.push(`Jumlah Gangguan : ${formatGangguanCount(script)}x Terputus`);
    lines.push(`Total Secret    : ${snapshot.secrets.length}`);
    lines.push(`Total Active    : ${snapshot.active.length}`);
    lines.push(`Total Offline   : ${offline.length}`);

    if (!online && offline.length) {
      lines.push('');
      lines.push('User Offline Lain');
      offline.slice(0, 10).forEach((row) => {
        lines.push(`- ${row.username} (${row.failCount}x)`);
      });
      if (offline.length > 10) lines.push(`...dan ${offline.length - 10} lainnya.`);
    }

    return lines.join('\n');
  };

  // Main Menu (Inline Keyboard for better visibility)
  const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 Statistik', callback_data: 'menu_stats' },
        { text: '👥 Pelanggan', callback_data: 'menu_cust' }
      ],
      [
        { text: '🧾 Tagihan', callback_data: 'menu_bill' },
        { text: '🎫 Voucher', callback_data: 'menu_vouch' }
      ],
      [
        { text: '⚡ MikroTik Status', callback_data: 'menu_mt' }
      ],
      [
        { text: '🔄 Refresh Dashboard', callback_data: 'menu_main' }
      ]
    ]
  }
};

  const getGreeting = () => {
    const hour = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: 'numeric',
      hour12: false
    });

    const h = Number(hour);

    if (h >= 5 && h < 11) return '🌅 Selamat pagi 😊';
    if (h >= 11 && h < 15) return '☀️ Selamat siang 😊';
    if (h >= 15 && h < 18) return '🌇 Selamat sore 😊';
    return '🌙 Selamat malam 😊';
  };

  bot.onText(/\/start|\/menu/i, (msg) => {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, `Maaf, Anda tidak memiliki akses admin.\nChat ID Anda: ${msg.from.id}`);

    const greeting = getGreeting();

    bot.sendMessage(
      msg.chat.id,
      `${greeting}\n\n🤖 *INTERCITY NETWORK*\nSilakan pilih menu yang ingin digunakan 👇`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  });

  const onuSearchWaiting = new Set();

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;

    const text = String(msg.text || '').trim();
    if (!text) return;

    if (text === '/start' || text === '/menu') return;

    if (onuSearchWaiting.has(msg.chat.id)) {
      onuSearchWaiting.delete(msg.chat.id);

      const keyword = text.toLowerCase();
      const billingCustomer = customerSvc.findCustomerByAny(text);

      try {
        let res = await customerDevice.listAllDevices(500);

        if (!res.ok || !res.devices.length) {
          res = await customerDevice.listDevicesWithTags(500);
        }

        if (!res.ok || !res.devices.length) {
          return bot.sendMessage(
            msg.chat.id,
            '📭 Tidak ada ONU yang terdeteksi di GenieACS.'
          );
        }

        const matches = [];

        for (const d of res.devices) {
          const id = String(d._id || '');
          const tags = Array.isArray(d._tags) ? d._tags : [];

          let customer = null;

          for (const candidate of tags) {
            customer = customerSvc.findCustomerByAny(candidate);
            if (customer) break;
          }

          if (!customer) {
            const pppoe =
              d?.VirtualParameters?.pppoeUsername?._value ||
              d?.VirtualParameters?.pppoeUsername ||
              d?.VirtualParameters?.pppUsername?._value ||
              d?.VirtualParameters?.pppUsername ||
              d?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
              d?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username;

            if (pppoe) {
              customer = customerSvc.findCustomerByAny(String(pppoe));
            }
          }

          const name = String(customer?.name || '').toLowerCase();
          const allTags = tags.join(' ').toLowerCase();

          /*
           * Bisa mencari:
           * 1. Nama pelanggan
           * 2. SN lengkap
           * 3. SN pendek
           * 4. Bagian dari nama / SN
           */
          const searchable = [
            id.toLowerCase(),
            allTags,
            name
          ].join(' ');

          if (searchable.includes(keyword)) {
            matches.push(d);
          }
        }

        if (!matches.length) {
          return bot.sendMessage(
            msg.chat.id,
            `🔎 *ONU TIDAK DITEMUKAN*\n\n` +
            `Pencarian: \`${text}\`\n\n` +
            `Coba nama pelanggan atau SN ONU.`,
            { parse_mode: 'Markdown' }
          );
        }

        /*
         * Jika banyak hasil, tampilkan pilihan.
         */
        if (matches.length > 1) {
          const buttons = [];

          for (const d of matches.slice(0, 10)) {
            const tags = Array.isArray(d._tags) ? d._tags : [];
            const tag = String(tags[0] || d._id || '-');

            let customer = null;

            for (const candidate of tags) {
              customer = customerSvc.findCustomerByAny(candidate);
              if (customer) break;
            }

            const label = customer?.name
              ? `${customer.name} • ${tag.slice(-18)}`
              : tag.slice(-24);

            buttons.push([{
              text: `📡 ${label}`,
              callback_data: `onu_result_${encodeURIComponent(tag)}`
            }]);
          }

          return bot.sendMessage(
            msg.chat.id,
            `🔎 *DITEMUKAN ${matches.length} ONU*\n\n` +
            `Pilih ONU:`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: buttons
              }
            }
          );
        }

        /*
         * Satu hasil → langsung tampilkan.
         */
        const d = matches[0];
        const id = String(d._id || '-');
        const tags = Array.isArray(d._tags) ? d._tags : [];
        const tag = tags[0] || id;

        let customer = null;

        for (const candidate of tags) {
          customer = customerSvc.findCustomerByAny(candidate);
          if (customer) break;
        }

        if (!customer) {
          const pppoe =
            d?.VirtualParameters?.pppoeUsername?._value ||
            d?.VirtualParameters?.pppoeUsername ||
            d?.VirtualParameters?.pppUsername?._value ||
            d?.VirtualParameters?.pppUsername;

          if (pppoe) {
            customer = customerSvc.findCustomerByAny(String(pppoe));
          }
        }

        const name = String(customer?.name || 'Belum Terhubung')
          .replace(/[*_`[\]]/g, '');

        const ssid =
          d?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value ||
          d?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID ||
          '-';

        const rx =
          d?.VirtualParameters?.RXPower?._value ||
          d?.VirtualParameters?.RXPower ||
          d?.VirtualParameters?.rxPower?._value ||
          d?.VirtualParameters?.rxPower ||
          '-';

        const lastInform = d._lastInform
          ? new Date(d._lastInform).getTime()
          : 0;

        const online =
          lastInform && (Date.now() - lastInform) < 10 * 60 * 1000;

        const status = online ? '🟢 Online' : '🔴 Offline';

        /*
         * Ambil SN pendek dari ID/tag.
         */
        let sn = tag;

        const snMatch = tag.match(
          /(ZTEGD[A-Z0-9]+|CMHI[A-Z0-9]+|FHTTC[A-Z0-9]+|HSGQ[A-Z0-9]+)$/i
        );

        if (snMatch) {
          sn = snMatch[1];
        } else {
          const parts = tag.split('-');
          const last = parts[parts.length - 1];

          if (last && last.length >= 8) {
            sn = last;
          }
        }

        const message =
          `👤 *${name}*\n` +
          `📡 SN: \`${sn}\`\n` +
          `${status}\n` +
          `📶 RX Power: \`${rx}\`\n` +
          `📶 WiFi: *${String(ssid).replace(/[*_`[\]]/g, '')}*\n\n` +
          `━━━━━━━━━━━━━━━━━━`;

        await bot.sendMessage(msg.chat.id, message, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✏️ GANTI WIFI',
                  callback_data: `onu_wifi_${encodeURIComponent(tag)}`
                },
              ]
            ]
          }
        });

      } catch (err) {
        console.error('[TELEGRAM ONU SEARCH]', err);

        await bot.sendMessage(
          msg.chat.id,
          '❌ Terjadi kesalahan saat mencari ONU.'
        );
      }

      return;
    }
  });


  // ============================================================
  // UNIFIED CUSTOMER CARD
  // Billing + MikroTik PPPoE + ONU
  // ============================================================
  async function sendUnifiedCustomerCard(chatId, customer, searchText) {
    const safe = (v) => String(v ?? '-').replace(/[*_`[\]]/g, '');
    const username = String(customer?.pppoe_username || '').trim();

    let snapshot = null;
    try {
      const [secrets, active] = await Promise.all([
        mikrotikSvc.getPppoeSecrets(customer?.router_id || null),
        mikrotikSvc.getPppoeActive(customer?.router_id || null)
      ]);

      const secret = (secrets || []).find(x =>
        String(x?.name || '').trim().toLowerCase() === username.toLowerCase()
      );

      const activeRow = (active || []).find(x =>
        String(x?.name || x?.user || '').trim().toLowerCase() === username.toLowerCase()
      );

      snapshot = { secret, activeRow };
    } catch (e) {
      console.error('[Telegram Unified PPPoE]', e.message);
    }

    let onu = null;
    try {
      const res = await customerDevice.listAllDevices(500);
      const devices = res?.ok && Array.isArray(res.devices) ? res.devices : [];

      for (const d of devices) {
        const tags = Array.isArray(d._tags) ? d._tags : [];
        let linked = false;

        for (const t of tags) {
          const c = customerSvc.findCustomerByAny(String(t));
          if (c && Number(c.id) === Number(customer.id)) {
            linked = true;
            break;
          }
        }

        if (!linked) {
          const pppoe =
            d?.VirtualParameters?.pppoeUsername?._value ||
            d?.VirtualParameters?.pppoeUsername ||
            d?.VirtualParameters?.pppUsername?._value ||
            d?.VirtualParameters?.pppUsername;

          if (pppoe && String(pppoe).trim().toLowerCase() === username.toLowerCase()) {
            linked = true;
          }
        }

        if (linked) {
          onu = d;
          break;
        }
      }
    } catch (e) {
      console.error('[Telegram Unified ONU]', e.message);
    }

    let message =
      `👤 *${safe(customer?.name || 'Pelanggan')}*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n`;

    message += `🌐 *PPPoE*\n`;
    message += `Username : \`${safe(username || '-')}\`\n`;

    const online = !!snapshot?.activeRow;
    message += `Status   : ${online ? '🟢 Online' : '🔴 Offline'}\n`;

    const ip =
      snapshot?.activeRow?.address ||
      snapshot?.activeRow?.['remote-address'] ||
      snapshot?.secret?.['remote-address'] ||
      '-';

    const profile =
      snapshot?.activeRow?.profile ||
      snapshot?.secret?.profile ||
      customer?.package_name ||
      '-';

    message += `IP       : ${safe(ip)}\n`;
    message += `Paket    : ${safe(profile)}\n\n`;

    if (onu) {
      const tags = Array.isArray(onu._tags) ? onu._tags : [];
      const tag = String(tags[0] || onu._id || '-');

      const ssid =
        onu?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value ||
        onu?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID ||
        '-';

      const rx =
        onu?.VirtualParameters?.RXPower?._value ||
        onu?.VirtualParameters?.RXPower ||
        onu?.VirtualParameters?.rxPower?._value ||
        onu?.VirtualParameters?.rxPower ||
        '-';

      const serial =
        onu?.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value ||
        onu?.InternetGatewayDevice?.DeviceInfo?.SerialNumber ||
        onu?.VirtualParameters?.SerialNumber?._value ||
        onu?.VirtualParameters?.SerialNumber ||
        (() => {
          const m = tag.match(/(ZTEGD[A-Z0-9]+|CMHI[A-Z0-9]+|FHTTC[A-Z0-9]+|HSGQ[A-Z0-9]+)$/i);
          return m ? m[1] : tag;
        })();

      const lastInform = onu?._lastInform
        ? new Date(onu._lastInform).getTime()
        : 0;

      const onuOnline =
        lastInform && (Date.now() - lastInform) < 10 * 60 * 1000;

      message += `📡 *ONU*\n`;
      message += `SN       : \`${safe(serial)}\`\n`;
      message += `Status   : ${onuOnline ? '🟢 Online' : '🔴 Offline'}\n`;
      message += `RX Power : \`${safe(rx)}\`\n`;
      message += `WiFi     : *${safe(ssid)}*\n\n`;

      message += `💰 *TAGIHAN*\n`;

      try {
        const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(customer.id) || [];

        if (unpaid.length) {
          const total = unpaid.reduce((sum, x) => sum + Number(x.amount || 0), 0);
          message += `Status   : 🔴 Belum Lunas\n`;
          message += `Tagihan  : Rp ${total.toLocaleString('id-ID')}\n`;
        } else {
          message += `Status   : 🟢 Lunas\n`;
          message += `Tagihan  : Rp 0\n`;
        }
      } catch (e) {
        message += `Status   : -\n`;
        message += `Tagihan  : -\n`;
      }

      message += `\n━━━━━━━━━━━━━━━━━━`;

      return bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✏️ GANTI WIFI',
                callback_data: `onu_wifi_${encodeURIComponent(tag)}`
              }
            ],
            [
              {
                text: '🔄 REFRESH',
                callback_data: `onu_refresh_${encodeURIComponent(tag)}`
              },
              {
                text: '🔌 REBOOT',
                callback_data: `onu_reboot_${encodeURIComponent(tag)}`
              }
            ]
          ]
        }
      });
    }

    message += `💰 *TAGIHAN*\n`;

    try {
      const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(customer.id) || [];

      if (unpaid.length) {
        const total = unpaid.reduce((sum, x) => sum + Number(x.amount || 0), 0);
        message += `Status   : 🔴 Belum Lunas\n`;
        message += `Tagihan  : Rp ${total.toLocaleString('id-ID')}\n`;
      } else {
        message += `Status   : 🟢 Lunas\n`;
        message += `Tagihan  : Rp 0\n`;
      }
    } catch (e) {
      message += `Status   : -\n`;
      message += `Tagihan  : -\n`;
    }

    message += `\n━━━━━━━━━━━━━━━━━━`;

    return bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  }

  // Callback Query Handling
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: 'Akses Ditolak' });

    if (data === 'menu_main') {
      bot.editMessageText('🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...mainMenu
      });
    }

    else if (data === 'menu_stats') {
      const stats = customerSvc.getCustomerStats();
      const billing = billingSvc.getDashboardStats();
      let res = `*📊 STATISTIK SISTEM*\n\n`;
      res += `👥 Pelanggan: ${stats.total}\n`;
      res += `✅ Aktif: ${stats.active}\n`;
      res += `🚫 Terisolir: ${stats.suspended}\n\n`;
      res += `💰 Pendapatan Bulan Ini: Rp ${billing.thisMonth.toLocaleString('id-ID')}\n`;
      res += `⏳ Belum Dibayar: ${billing.unpaidCount} Tagihan`;
      
      bot.sendMessage(chatId, res, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_main' }]] }
      });
    }

    else if (data === 'menu_cust') {
      const customers = customerSvc.getAllCustomers();
      const active = customers.filter(c => c.status !== 'suspended').length;
      const suspended = customers.filter(c => c.status === 'suspended').length;

      await bot.editMessageText(
        `👥 *DATA PELANGGAN*\n\n` +
        `👤 Total: *${customers.length}* pelanggan\n` +
        `🟢 Aktif: *${active}*\n` +
        `🔴 Terisolir: *${suspended}*\n\n` +
        `Pilih layanan:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔎 Cari Pelanggan', callback_data: 'cust_search' }],
              [{ text: '🚫 Pelanggan Terisolir', callback_data: 'cust_suspended' }],
              [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
            ]
          }
        }
      );
    }

    else if (data.startsWith('cust_page_')) {
      const page = Math.max(0, parseInt(data.replace('cust_page_', ''), 10) || 0);
      const perPage = 10;
      const customers = customerSvc.getAllCustomers();
      const totalPages = Math.max(1, Math.ceil(customers.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const startIndex = safePage * perPage;
      const rows = customers.slice(startIndex, startIndex + perPage);

      let txt = `👥 *DAFTAR PELANGGAN*\n`;
      txt += `Halaman *${safePage + 1} / ${totalPages}*\n\n`;

      rows.forEach((c, i) => {
        const number = startIndex + i + 1;
        const status = c.status === 'suspended' ? '🔴 Terisolir' : '🟢 Aktif';
        const name = String(c.name || 'Tanpa Nama').replace(/[*_`[\]]/g, '');
        const pppoe = c.pppoe_username || c.username || '-';
        const phone = c.phone || '-';

        txt += `*${number}. ${name}*\n`;
        txt += `   ${status} | PPPoE: \`${pppoe}\`\n`;
        txt += `   📱 ${phone}\n\n`;
      });

      if (rows.length === 0) {
        txt += '📭 Belum ada data pelanggan.';
      } else {
        txt += `_Menampilkan ${startIndex + 1}-${Math.min(startIndex + rows.length, customers.length)} dari ${customers.length}_`;
      }

      const nav = [];

      if (safePage > 0) {
        nav.push({
          text: '◀️ Sebelumnya',
          callback_data: `cust_page_${safePage - 1}`
        });
      }

      nav.push({
        text: `${safePage + 1}/${totalPages}`,
        callback_data: `cust_page_${safePage}`
      });

      if (safePage < totalPages - 1) {
        nav.push({
          text: 'Berikutnya ▶️',
          callback_data: `cust_page_${safePage + 1}`
        });
      }

      await bot.editMessageText(txt, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            nav,
            [{ text: '🔎 Cari Pelanggan', callback_data: 'cust_search' }],
            [{ text: '⬅️ Menu Pelanggan', callback_data: 'menu_cust' }]
          ]
        }
      });
    }

    else if (data === 'menu_bill') {
      bot.sendMessage(chatId, '💰 *MANAJEMEN TAGIHAN*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏳ Tagihan Belum Bayar', callback_data: 'bill_unpaid' }],
            [{ text: '📈 Pendapatan Hari Ini', callback_data: 'bill_today' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_vouch') {
      bot.sendMessage(chatId, '🎫 *MANAJEMEN VOUCHER*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Buat Voucher Baru', callback_data: 'vouch_create' }],
            [{ text: '📜 Daftar Hotspot Profile', callback_data: 'vouch_profiles' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }
    
    else if (data === 'menu_mt') {
      bot.sendMessage(chatId, '⚙️ *STATUS MIKROTIK*\nPilih data:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Resource System', callback_data: 'mt_resource' }],
            [{ text: '🟢 User Aktif (PPPoE/HS)', callback_data: 'mt_active' }],
            [{ text: '🔴 User Offline (PPPoE)', callback_data: 'mt_offline' }],
            [{ text: '🔑 List PPPoE Secrets', callback_data: 'mt_pppoe' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'mt_resource') {
      try {
        const res = await mikrotikSvc.getSystemResource();
        let txt = `*⚙️ MIKROTIK STATUS*\n\n`;
        txt += `Model: ${res.boardName || res['board-name'] || '-'}\n`;
        txt += `CPU: ${res.cpuLoad || res['cpu-load'] || '0'}%\n`;
        txt += `Uptime: ${res.uptime}\n`;
        txt += `Version: ${res.version}`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal mengambil data MikroTik: ' + e.message);
      }
    }

    else if (data === 'mt_active') {
      try {
        const pppoe = await mikrotikSvc.getPppoeActive();
        const hs = await mikrotikSvc.getHotspotActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        
        let txt = `*🟢 USER AKTIF*\n\n`;
        txt += `🌐 *PPPoE (${pppoe.length}):*\n`;
        pppoe.slice(0, 15).forEach(a => {
          const s = scripts.find(sc => sc.name === a.name);
          const failCount = s ? (s.source || '0') : '0';
          txt += `• \`${a.name}\` (${a.address}) [⚡${failCount}]\n`;
        });
        
        txt += `\n📶 *Hotspot (${hs.length}):*\n`;
        hs.slice(0, 5).forEach(h => {
          txt += `• \`${h.user}\` (${h.address})\n`;
        });
        
        txt += `\n_⚡ = Jumlah Gangguan Terdeteksi_`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_offline') {
      try {
        const snapshot = await loadPppoeSnapshot();
        bot.sendMessage(chatId, buildOfflineTelegramText(snapshot));
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_pppoe') {
      try {
        const secrets = await mikrotikSvc.getPppoeSecrets();
        let txt = `*🔑 PPPoE SECRETS (${secrets.length})*\n\n`;
        secrets.slice(0, 20).forEach(s => {
          txt += `• \`${s.name}\` (${s.profile})\n`;
        });
        if (secrets.length > 20) txt += `\n_Menampilkan 20 dari ${secrets.length}..._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'cust_search') {
      onuSearchWaiting.add(chatId);
      bot.sendMessage(
        chatId,
        '🔎 *CARI DATA PELANGGAN*\n' +
        '━━━━━━━━━━━━━━━━━━\n\n' +
        'Ketik nama pelanggan, username PPPoE, atau SN ONU.\n\n' +
        'Contoh:\n' +
        '`Gawa`\n' +
        '`gawa`\n' +
        '`ZTEGD228CC58`',
        { parse_mode: 'Markdown' }
      );
    }

    else if (data === 'cust_listonu' || data.startsWith('cust_listonu_')) {
      const customerDevice = require('./customerDeviceService');

      let total = 0;

      try {
        let res = await customerDevice.listAllDevices(500);

        if (!res.ok || !res.devices.length) {
          res = await customerDevice.listDevicesWithTags(500);
        }

        if (res.ok && Array.isArray(res.devices)) {
          total = res.devices.length;
        }
      } catch (e) {}

      onuSearchWaiting.add(chatId);

      await bot.sendMessage(
        chatId,
        `📡 *DAFTAR ONU*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 Total ONU: *${total}*\n\n` +
        `🔎 *CARI ONU*\n` +
        `Masukkan *nama pelanggan atau SN ONU*.\n\n` +
        `Contoh:\n` +
        `\`Khalimin\`\n` +
        `\`ZTEGD228CC58\`\n` +
        `\`F0E0D2-F609-ZTEGD228CC58\``,
        { parse_mode: 'Markdown' }
      );

      try {
        await bot.answerCallbackQuery(query.id, {
          text: 'Masukkan nama atau SN ONU'
        });
      } catch (e) {}
    }
else if (data.startsWith('onu_wifi_')) {
      const tag = decodeURIComponent(data.replace('onu_wifi_', ''));

      await bot.sendMessage(
        chatId,
        `✏️ *GANTI NAMA WIFI*\n\n` +
        `🏷️ ONU: \`${tag}\`\n\n` +
        `Ketik:\n` +
        `\`/gantissid ${tag} NAMA_WIFI_BARU\`\n\n` +
        `Contoh:\n` +
        `\`/gantissid ${tag} INTERCITY_HOME\``,
        { parse_mode: 'Markdown' }
      );
    }

    else if (data.startsWith('onu_pass_')) {
      const tag = decodeURIComponent(data.replace('onu_pass_', ''));

      await bot.sendMessage(
        chatId,
        `🔑 *GANTI PASSWORD WIFI*\n\n` +
        `🏷️ ONU: \`${tag}\`\n\n` +
        `Ketik:\n` +
        `\`/gantisandi ${tag} PASSWORD_BARU\`\n\n` +
        `⚠️ Password minimal 8 karakter.`,
        { parse_mode: 'Markdown' }
      );
    }

    else if (data === 'cust_suspended') {
      const customers = customerSvc.getAllCustomers().filter(c => c.status === 'suspended');
      if (customers.length === 0) return bot.sendMessage(chatId, '✅ Tidak ada pelanggan yang terisolir.');
      let txt = `*🚫 PELANGGAN TERISOLIR (${customers.length})*\n\n`;
      customers.slice(0, 15).forEach(c => {
        txt += `• *${c.name}* (${c.phone})\n`;
      });
      if (customers.length > 15) txt += `\n_...dan ${customers.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_unpaid') {
      const invoices = billingSvc.getAllInvoices().filter(i => i.status === 'unpaid');
      if (invoices.length === 0) return bot.sendMessage(chatId, '✅ Semua tagihan sudah lunas!');
      let txt = `*⏳ TAGIHAN BELUM BAYAR (${invoices.length})*\n\n`;
      invoices.slice(0, 15).forEach(i => {
        const c = customerSvc.getCustomerById(i.customer_id);
        txt += `• ${c ? c.name : 'Unknown'} - Rp ${i.amount.toLocaleString('id-ID')}\n`;
      });
      if (invoices.length > 15) txt += `\n_...dan ${invoices.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_today') {
      try {
        const stats = billingSvc.getTodayRevenue();
        const total = stats.total || 0;
        const count = stats.count || 0;
        
        let txt = `*📈 PENDAPATAN HARI INI*\n\n`;
        txt += `💰 Total: *Rp ${total.toLocaleString('id-ID')}*\n`;
        txt += `🧾 Jumlah: ${count} Transaksi\n\n`;
        txt += `_Data berdasarkan pembayaran yang diverifikasi hari ini (Waktu Lokal)._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'vouch_profiles') {
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const buttons = [];
        
        // Filter profiles that have Mikhmon Price
        const filtered = profiles.filter(p => parseMikhmon(p.onLogin));

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, '⚠️ Tidak ditemukan paket yang memiliki harga jual (Format Mikhmon).');
        }

        filtered.forEach((p, index) => {
          const meta = parseMikhmon(p.onLogin);
          if (index % 2 === 0) buttons.push([]);
          buttons[buttons.length - 1].push({ text: `🎫 ${p.name} (Rp ${meta.price})`, callback_data: `vouch_gen:${p.name}` });
        });
        buttons.push([{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]);
        
        bot.sendMessage(chatId, '*📜 PILIH PAKET VOUCHER*\nSilakan klik paket untuk langsung membuat PIN:', { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }
    
    else if (data.startsWith('vouch_gen:')) {
      const profileName = data.split(':')[1];
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const profile = profiles.find(p => p.name === profileName);
        if (!profile) throw new Error('Profil tidak ditemukan');

        const meta = parseMikhmon(profile.onLogin);
        if (!meta) throw new Error('Data harga/durasi profil tidak ditemukan (Format Mikhmon)');

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        
        await mikrotikSvc.addHotspotUser({
          server: 'all',
          name: pin,
          password: pin,
          profile: profileName,
          'limit-uptime': meta.validity,
          comment: `vc-${pin}-${profileName}`
        });
        
        let res = `*🎫 VOUCHER BERHASIL (INSTAN)*\n\n`;
        res += `🎫 KODE VOUCHER: \`${pin}\`\n`;
        res += `💰 Harga: Rp ${meta.price}\n`;
        res += `⏳ Durasi: ${meta.validity}\n`;
        res += `📦 Paket: ${profileName}\n`;
        res += `\n_Silakan masukkan kode di atas pada halaman login hotspot._`;
        
        bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal: ' + e.message);
      }
    }
    
    bot.answerCallbackQuery(query.id);
  });

  // Custom Commands
  bot.onText(/\/vouch (\S+) (\S+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const [_, profile, limit, comment] = match;
    try {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      await mikrotikSvc.addHotspotUser({
        server: 'all', name: pin, password: pin, profile, 'limit-uptime': limit, comment
      });
      bot.sendMessage(msg.chat.id, `*🎫 VOUCHER BERHASIL*\n\n🎫 KODE VOUCHER: \`${pin}\`\n📦 Paket: ${profile}\n⏳ Limit: ${limit}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/vcr\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const code = match[1];
    const profile = match[2];
    try {
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      const comment = `vc ${code} ${dateStr}`;

      await mikrotikSvc.addHotspotUser({
        name: code,
        password: code,
        profile: profile,
        comment: comment
      });

      bot.sendMessage(chatId, `✅ Voucher Hotspot *${code}* berhasil dibuat.\n\n👤 User: \`${code}\`\n🔑 Pass: \`${code}\`\n📦 Profile: *${profile}*\n📝 Comment: *${comment}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal buat voucher: ' + e.message);
    }
  });

  bot.onText(/\/kick (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const user = match[1];
      await mikrotikSvc.kickPppoeUser(user);
      await mikrotikSvc.kickHotspotUser(user);
      bot.sendMessage(msg.chat.id, `✅ Session *${user}* berhasil diputus.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/editpppoe (\S+) (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const [_, user, profile] = match;
      await mikrotikSvc.setPppoeProfile(user, profile);
      bot.sendMessage(msg.chat.id, `✅ Profile *${user}* diubah ke *${profile}*.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/cek (.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;

    const chatId = msg.chat.id;
    const query = String(match[1] || '').trim();

    if (!query) {
      return bot.sendMessage(
        chatId,
        'Gunakan: /cek nama, ID pelanggan, username PPPoE, atau SN ONU'
      );
    }

    try {
      const customer = customerSvc.findCustomerByAny(query);

      if (!customer) {
        return bot.sendMessage(
          chatId,
          `❌ Pelanggan "${query}" tidak ditemukan.`
        );
      }

      await sendUnifiedCustomerCard(chatId, customer, query);
    } catch (e) {
      console.error('[Telegram /cek]', e);
      await bot.sendMessage(
        chatId,
        '❌ Gagal mengambil data pelanggan: ' + (e?.message || e)
      );
    }
  });

  bot.onText(/\/cekpppoe (\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const username = match[1];
      const detail = await buildPppoeUserDetailText(username);
      bot.sendMessage(msg.chat.id, detail);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal cek PPPoE: ' + e.message);
    }
  });

  bot.onText(/\/cari (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const query = match[1].toLowerCase();
    const customers = customerSvc.getAllCustomers().filter(c => 
      c.name.toLowerCase().includes(query) || c.phone.includes(query)
    );
    
    if (customers.length === 0) return bot.sendMessage(msg.chat.id, `❌ Pelanggan dengan keyword "${query}" tidak ditemukan.`);
    
    let res = `*🔍 HASIL PENCARIAN (${customers.length})*\n\n`;
    customers.slice(0, 10).forEach(c => {
      res += `👤 *${c.name}*\n📞 ${c.phone}\n🚦 Status: ${c.status === 'active' ? '✅ Aktif' : '🚫 Terisolir'}\n\n`;
    });
    if (customers.length > 10) res += `_...dan ${customers.length - 10} lainnya._`;
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/ringkasan/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      const stats = billingSvc.getDashboardStats();
      const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      let res = `💰 *RINGKASAN BILLING*\n\n` +
        `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
        `📅 *Bulan Ini:* ${formatter.format(stats.thisMonth)}\n` +
        `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
        `🧾 *Tagihan Belum Lunas:* ${stats.unpaidCount} invoice\n\n` +
        `💡 _Gunakan perintah lain untuk detail._`;
      bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal mengambil ringkasan billing: ' + e.message);
    }
  });

  bot.onText(/\/lunas(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const keyRaw = String(match[1] || '').trim();
    if (!keyRaw) return bot.sendMessage(chatId, '❌ Format: `/lunas IDTAGIHAN` atau `/lunas nama/nohp/pppoe/tag`', { parse_mode: 'Markdown' });

    try {
      let targetInvId = null;
      let targetInv = null;
      const isNumeric = /^\d+$/.test(keyRaw);
      if (isNumeric) {
        targetInvId = Number(keyRaw);
        targetInv = billingSvc.getInvoiceById(targetInvId);
      }

      if (!targetInv) {
        let cust =
          (isNumeric ? customerSvc.getCustomerById(Number(keyRaw)) : null) ||
          customerSvc.findCustomerByAny(keyRaw);

        if (!cust) {
          const candidates = customerSvc.getAllCustomers(keyRaw) || [];
          const unique = Array.from(new Map(candidates.map(c => [c.id, c])).values());
          if (unique.length === 1) {
            cust = customerSvc.getCustomerById(unique[0].id);
          } else if (unique.length > 1) {
            const top = unique.slice(0, 5).map(c =>
              `- ID:${c.id} • ${c.name || '-'} • ${c.phone || '-'} • PPPoE:${c.pppoe_username || '-'}`
            ).join('\n');
            return bot.sendMessage(chatId, `⚠️ Nama/ID tidak spesifik. Ditemukan ${unique.length} pelanggan:\n\n${top}\n\nKirim ulang: \`/lunas IDPELANGGAN\``);
          }
        }

        if (cust) {
          const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
          if (unpaid && unpaid.length > 0) {
            targetInv = unpaid[0];
            targetInvId = targetInv.id;
          } else {
            return bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`, { parse_mode: 'Markdown' });
          }
        }
      }

      if (!targetInv) return bot.sendMessage(chatId, `❌ Tagihan atau Pelanggan *${keyRaw}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      if (targetInvId != null) {
        const enriched = billingSvc.getInvoiceById(targetInvId);
        if (enriched) targetInv = enriched;
      }
      if (targetInv && targetInv.status === 'paid') {
        return bot.sendMessage(chatId, `✅ Invoice *#${targetInv.id}* sudah berstatus LUNAS.`, { parse_mode: 'Markdown' });
      }

      billingSvc.markAsPaid(targetInvId, 'Telegram Bot Admin', 'Paid via Telegram Command');

      const customer = customerSvc.getCustomerById(targetInv.customer_id);
      const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      const customerName = String(targetInv.customer_name || customer?.name || targetInv.customer_name || '-');
      const notifyTag = customer?.genieacs_tag || customer?.pppoe_username || customer?.phone || targetInv.customer_phone || targetInv.genieacs_tag || '';
      
      const appUrl = (getSetting('public_base_url', '') || '').replace(/\/$/, '');
      const portalUrl = appUrl ? `${appUrl}/customer` : '';
      const template = db.getAppSetting('whatsapp_payment_success_message', '');

      const waMessage = whatsappService.formatPaymentSuccessMessage({
        customerName,
        invoiceId: targetInvId,
        customerUsername: customer?.pppoe_username || customer?.id || '-',
        packageName: targetInv.package_name || '-',
        periodMonth: targetInv.period_month,
        periodYear: targetInv.period_year,
        amount: targetInv.amount,
        paymentMethod: 'Telegram Admin / Kasir',
        paidAt: new Date(),
        companyName: getSetting('company_header', 'Irfan'),
        companyPhone: getSetting('company_phone', ''),
        portalUrl,
        customTemplate: template
      });
      
      // Dynamic import of whatsappBot
      const waBot = await import('./whatsappBot.mjs').catch(() => null);
      let waNotifStatus = 'tidak dikirim (WA offline)';

      if (customer && customer.status === 'suspended') {
        const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
        const unpaidCount = freshCustomer && Number.isFinite(Number(freshCustomer.unpaid_count)) ? Number(freshCustomer.unpaid_count) : 1;
        if (unpaidCount === 0) {
          await customerSvc.activateCustomer(targetInv.customer_id);
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n🟢 Layanan internet Anda sudah aktif kembali.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* LUNAS. Pelanggan *${customerName}* otomatis diaktifkan kembali.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
        } else {
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n⚠️ Masih ada ${unpaidCount} tagihan lain yang belum dibayar.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* LUNAS. Masih ada ${unpaidCount} tagihan lain.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
        }
      } else {
        if (waBot && waBot.currentSock) {
          const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage);
          waNotifStatus = ok ? 'terkirim' : 'gagal';
        }
        await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* (a.n ${customerName}) berhasil ditandai LUNAS.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal update status: ' + e.message);
    }
  });

  bot.onText(/\/generate\s+(\d+)\s+(\d+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const month = Number(match[1]);
    const year = Number(match[2]);
    try {
      const res = billingSvc.generateMonthlyInvoices(month, year);
      bot.sendMessage(chatId, `✅ Berhasil generate tagihan untuk periode *${month}/${year}*.\n🧾 Jumlah: ${res.generatedCount} tagihan baru.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal generate tagihan: ' + e.message);
    }
  });

  bot.onText(/\/isolir(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Format: `/isolir ID/Nama/PPPoE/NoHP`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ Pelanggan *${targetId}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      await customerSvc.suspendCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil di-isolir.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal isolir: ' + e.message);
    }
  });

  bot.onText(/\/buka(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Format: `/buka ID/Nama/PPPoE/NoHP`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ Pelanggan *${targetId}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      await customerSvc.activateCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil diaktifkan kembali.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal mengaktifkan pelanggan: ' + e.message);
    }
  });

  bot.onText(/\/saldodigi/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      const r = await agentSvc.digiflazzCheckBalance();
      bot.sendMessage(chatId, `💳 *SALDO DIGIFLAZZ*\n\n💰 Deposit: Rp ${Number(r?.deposit || 0).toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal cek saldo Digiflazz: ' + e.message);
    }
  });

  bot.onText(/\/topup\s+(\S+)\s+(\d+)(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const agentKeyRaw = String(match[1] || '').trim();
    const amount = Number(match[2]) || 0;
    const note = String(match[3] || 'Topup via Telegram').trim();

    try {
      if (!agentKeyRaw) throw new Error('Agent username/id tidak valid');
      if (!amount) throw new Error('Nominal tidak valid');

      const normalizeDigits = (v) => {
        let d = String(v || '').replace(/\D/g, '');
        if (!d) return '';
        if (d.startsWith('0')) d = '62' + d.slice(1);
        return d;
      };

      const agentKey = agentKeyRaw.startsWith('@') ? agentKeyRaw.slice(1) : agentKeyRaw;
      const agentKeyLc = agentKey.toLowerCase();
      const agentDigits = normalizeDigits(agentKey);

      const agent = agentSvc.getAllAgents().find(a => 
        String(a.id) === agentKey ||
        String(a.username || '').toLowerCase() === agentKeyLc ||
        (a.phone && normalizeDigits(a.phone) === agentDigits) ||
        String(a.name || '').toLowerCase() === agentKeyLc
      );

      if (!agent) throw new Error(`Agent "${agentKeyRaw}" tidak ditemukan`);

      const actorName = msg.from.first_name || 'Telegram Admin';
      const r = agentSvc.topupAgent(agent.id, amount, note, actorName);
      
      bot.sendMessage(chatId, 
        `💸 *TOPUP AGENT BERHASIL*\n\n` +
        `👤 Agent: *${agent.name}* (@${agent.username || '-'})\n` +
        `💰 Nominal: Rp ${Number(amount || 0).toLocaleString('id-ID')}\n` +
        `📈 Saldo: Rp ${Number(r.before || 0).toLocaleString('id-ID')} ➜ Rp ${Number(r.after || 0).toLocaleString('id-ID')}\n` +
        `📝 Catatan: ${note}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal topup agent: ' + e.message);
    }
  });

  bot.onText(/\/listonu/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      let res = await customerDevice.listDevicesWithTags(50);
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(50);
      }
      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 Tidak ada perangkat ONU terdeteksi di GenieACS.');
      }
      let txt = `*📡 DAFTAR ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal list ONU: ' + e.message);
    }
  });

  bot.onText(/\/(?:info|cekstatus)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;
      
      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }
      
      const data = await customerDevice.getCustomerDeviceData(targetTag);
      let t = `*📡 DETAIL ONU: ${data.lokasi || targetTag}*\n\n`;
      t += `🟢 Status: ${data.status || '-'}\n`;
      t += `📶 SSID: ${data.ssid || '-'}\n`;
      t += `⏱️ Last Inform: ${data.lastInform || '-'}\n`;
      t += `📡 RX Power: ${data.rxPower || '-'}\n`;
      t += `🌐 PPPoE IP: ${data.pppoeIP || '-'}\n`;
      t += `👤 PPPoE User: ${data.pppoeUsername || '-'}\n`;
      t += `⏳ Uptime: ${data.uptime || '-'}\n`;
      t += `⏳ PPPoE Uptime: ${data.pppoeUptime || '-'}\n`;
      t += `📱 User WiFi: ${data.totalAssociations || '0'}\n`;
      t += `🔧 Model: ${data.model || '-'}\n`;
      t += `🏷️ Serial Number: ${data.serialNumber || '-'}\n`;
      t += `💾 Firmware: ${data.softwareVersion || '-'}`;
      bot.sendMessage(chatId, t, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal cek status ONU: ' + e.message);
    }
  });

  bot.onText(/\/reboot\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Mencoba me-reboot ONU *${targetTag}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.rebootDevice(targetTag);
      if (ok) {
        bot.sendMessage(chatId, `✅ ONU *${targetTag}* berhasil diperintahkan untuk reboot.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal reboot ONU *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal reboot ONU: ' + e.message);
    }
  });

  bot.onText(/\/gantissid\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newSSID = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Mengubah SSID untuk *${targetTag}* menjadi *${newSSID}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.updateSSID(targetTag, newSSID);
      if (ok) {
        bot.sendMessage(chatId, `✅ SSID untuk *${targetTag}* berhasil diubah menjadi *${newSSID}*.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal mengubah SSID untuk *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal ganti SSID: ' + e.message);
    }
  });

  bot.onText(/\/gantisandi\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newPass = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      if (newPass.length < 8) {
        return bot.sendMessage(chatId, `⚠️ Password WiFi minimal harus 8 karakter.`);
      }

      await bot.sendMessage(chatId, `⏳ Mengubah sandi WiFi untuk *${targetTag}*...`);
      const fiberHomeResult = await customerDevice.requestWifiPasswordUpdate(targetTag, newPass);
      if (fiberHomeResult && fiberHomeResult.handled) {
        if (fiberHomeResult.success) {
          return bot.sendMessage(chatId,
            `⏳ Perintah perubahan Wi-Fi untuk *${targetTag}* sudah masuk antrean ACS. Menunggu ONT mengonfirmasi perubahan.${fiberHomeResult.taskId ? ' Task: ' + fiberHomeResult.taskId : ''}`,
            { parse_mode: 'Markdown' });
        }
        return bot.sendMessage(chatId, `❌ ${fiberHomeResult.message || 'Perubahan Wi-Fi ditolak oleh pemeriksaan ACS.'}`);
      }

      const ok = await customerDevice.updatePassword(targetTag, newPass);
      if (ok) {
        bot.sendMessage(chatId, `✅ Sandi WiFi untuk *${targetTag}* berhasil diubah menjadi: \`${newPass}\``, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal mengubah sandi WiFi untuk *${targetTag}*.`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal ganti sandi WiFi: ' + e.message);
    }
  });

  bot.on('polling_error', (error) => {
    logger.error('Telegram Polling Error:', error.message);
  });
}

// Export for manual re-init from settings
module.exports = { initTelegram };
