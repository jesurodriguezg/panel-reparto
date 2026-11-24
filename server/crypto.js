'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SECRET_PATH = path.join(__dirname, '..', 'data', '.secret');

/**
 * Obtiene o genera la clave maestra de 32 bytes (AES-256).
 * En entornos serverless (Netlify), prioriza la variable de entorno PANEL_SECRET_KEY
 * (64 caracteres hex) cuando se usa la ruta por defecto, evitando depender del disco local.
 */
function getOrCreateSecretKey(secretPath = DEFAULT_SECRET_PATH) {
  if (secretPath === DEFAULT_SECRET_PATH && process.env.PANEL_SECRET_KEY) {
    const envRaw = String(process.env.PANEL_SECRET_KEY).trim();
    const envKey = Buffer.from(envRaw, 'hex');
    if (envKey.length === 32) {
      return envKey;
    }
  }
  const dir = path.dirname(secretPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(secretPath)) {
    const raw = fs.readFileSync(secretPath, 'utf8').trim();
    const keyBuf = Buffer.from(raw, 'hex');
    if (keyBuf.length === 32) {
      return keyBuf;
    }
  }
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, newKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return newKey;
}

/**
 * Cifra el token de API con AES-256-GCM en reposo.
 * Formato de salida: ivHex:authTagHex:cipherHex
 */
function encryptToken(plainToken, secretPath = DEFAULT_SECRET_PATH) {
  if (!plainToken || typeof plainToken !== 'string' || !plainToken.trim()) {
    throw new Error('El token no puede estar vacío.');
  }
  const key = getOrCreateSecretKey(secretPath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainToken.trim(), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descifra el token de API guardado con AES-256-GCM.
 */
function decryptToken(encryptedPayload, secretPath = DEFAULT_SECRET_PATH) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    return null;
  }
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de token cifrado inválido.');
  }
  const [ivHex, authTagHex, cipherHex] = parts;
  const key = getOrCreateSecretKey(secretPath);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(cipherHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Devuelve la representación enmascarada del token para la UI.
 * Nunca expone más de los últimos 4 caracteres.
 */
function maskToken(plainOrLast4) {
  if (!plainOrLast4 || typeof plainOrLast4 !== 'string' || !plainOrLast4.trim()) {
    return { configurado: false, ultimos4: null };
  }
  const clean = plainOrLast4.trim().replace(/^••••/, '');
  if (!clean) {
    return { configurado: false, ultimos4: null };
  }
  const last4 = clean.slice(-4);
  return {
    configurado: true,
    ultimos4: `••••${last4}`
  };
}

/**
 * Genera un hash seguro con scrypt para el PIN de acceso.
 */
function hashPin(pin) {
  if (!pin || typeof pin !== 'string' || pin.trim().length < 4) {
    throw new Error('El PIN debe tener al menos 4 caracteres.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin.trim(), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifica un PIN contra su hash scrypt usando comparación en tiempo constante.
 */
function verifyPin(pin, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  if (!pin || typeof pin !== 'string') return false;
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(pin.trim(), salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

/**
 * Firma un valor de cookie de sesión con HMAC-SHA256 usando la clave local.
 */
function signSessionToken(payloadObj, secretPath = DEFAULT_SECRET_PATH) {
  const key = getOrCreateSecretKey(secretPath);
  const data = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token, secretPath = DEFAULT_SECRET_PATH) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const key = getOrCreateSecretKey(secretPath);
  const expectedSig = crypto.createHmac('sha256', key).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_SECRET_PATH,
  getOrCreateSecretKey,
  encryptToken,
  decryptToken,
  maskToken,
  hashPin,
  verifyPin,
  signSessionToken,
  verifySessionToken
};
