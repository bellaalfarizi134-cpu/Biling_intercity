/**
 * Settings Encryption & Decryption
 * Untuk encrypt/decrypt sensitive fields di settings.json
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

// Master key is supplied by the environment or generated once outside the repository.
function loadOrCreateMasterKey() {
  const configured = String(process.env.SETTINGS_MASTER_KEY || '').trim();
  if (configured) return configured;
  const keyPath = path.join(__dirname, '../data/settings-master.key');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, generated + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrentlyCreated = fs.readFileSync(keyPath, 'utf8').trim();
    if (concurrentlyCreated) return concurrentlyCreated;
    throw error;
  }
  try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
  return generated;
}
const MASTER_KEY = loadOrCreateMasterKey();
// Temporary migration-only key for older encrypted settings.
const LEGACY_MASTER_KEY = String(process.env.SETTINGS_LEGACY_ENCRYPTION_KEY || '').trim();

function getMasterKeyForString(keyStr) {
  const hash = crypto.createHash('sha256');
  hash.update(keyStr || '');
  return hash.digest();
}

// Normalize master key ke 32 bytes untuk AES-256
function getMasterKey() {
  return getMasterKeyForString(MASTER_KEY);
}

// List field yang harus di-encrypt
const SENSITIVE_FIELDS = [
  'genieacs_password',
  'admin_password',
  'admin_api_key',
  'mikrotik_password',
  'tripay_api_key',
  'tripay_private_key',
  'midtrans_server_key',
  'telegram_bot_token',
  'xendit_api_key',
  'duitku_api_key',
  'session_secret'
];

/**
 * Encrypt value menggunakan AES-256-GCM
 */
function encryptValue(value) {
  if (!value || typeof value !== 'string') return value;

  try {
    const masterKey = getMasterKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    logger.error(`[encryption] Error encrypting value: ${error.message}`);
    return value;
  }
}

function decryptWithKey(encryptedValue, key) {
  const parts = encryptedValue.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted value format');
  }

  const [prefix, ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Decrypt value
 */
function decryptValue(encryptedValue) {
  if (!encryptedValue || typeof encryptedValue !== 'string') return encryptedValue;
  if (!encryptedValue.startsWith('enc:')) return encryptedValue; // Belum di-encrypt

  const primaryKey = getMasterKey();
  try {
    return decryptWithKey(encryptedValue, primaryKey);
  } catch (error) {
    // Optional migration path requires an explicitly supplied legacy key.
    if (LEGACY_MASTER_KEY && MASTER_KEY !== LEGACY_MASTER_KEY) {
      try {
        const fallbackKey = getMasterKeyForString(LEGACY_MASTER_KEY);
        const decrypted = decryptWithKey(encryptedValue, fallbackKey);
        logger.info('[encryption] Legacy value decrypted. Save settings to re-encrypt it with the current key.');
        return decrypted;
      } catch (fallbackError) {
        logger.error('[encryption] Error decrypting value with both configured keys: ' + fallbackError.message);
      }
    } else {
      logger.error('[encryption] Error decrypting value: ' + error.message);
    }
    return encryptedValue;
  }
}

/**
 * Encrypt sensitive fields dalam settings object
 */
function encryptSettings(settings) {
  const encrypted = { ...settings };

  SENSITIVE_FIELDS.forEach(field => {
    if (encrypted[field]) {
      encrypted[field] = encryptValue(encrypted[field]);
    }
  });

  return encrypted;
}

/**
 * Decrypt sensitive fields dalam settings object
 */
function decryptSettings(settings) {
  const decrypted = { ...settings };

  SENSITIVE_FIELDS.forEach(field => {
    if (decrypted[field]) {
      decrypted[field] = decryptValue(decrypted[field]);
    }
  });

  return decrypted;
}

/**
 * Mask sensitive values untuk display (show first 4 & last 4 chars)
 */
function maskValue(value) {
  if (!value || typeof value !== 'string') return value;
  if (value.length <= 8) return '****';

  const first = value.substring(0, 4);
  const last = value.substring(value.length - 4);
  return `${first}****${last}`;
}

/**
 * Get masked settings untuk display di UI
 */
function getMaskedSettings(settings) {
  const masked = { ...settings };

  SENSITIVE_FIELDS.forEach(field => {
    if (masked[field]) {
      masked[field] = maskValue(masked[field]);
    }
  });

  return masked;
}

/**
 * Check apakah field adalah sensitive
 */
function isSensitiveField(field) {
  return SENSITIVE_FIELDS.includes(field);
}

module.exports = {
  encryptValue,
  decryptValue,
  encryptSettings,
  decryptSettings,
  maskValue,
  getMaskedSettings,
  isSensitiveField,
  SENSITIVE_FIELDS
};
