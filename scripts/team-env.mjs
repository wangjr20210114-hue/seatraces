/* 加密和解密团队环境配置文件。 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FORMAT = 'seatraces-team-env/v1';
const AAD = Buffer.from(FORMAT);
const MAX_BYTES = 1024 * 1024;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PASSWORD_FILE = resolve(ROOT, '.runtime/team-env/passphrase.txt');

function derive(password, salt) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('Expected the 43-character team passphrase.');
  const input = Buffer.from(password, 'utf8');
  try {
    return scryptSync(input, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  } finally { input.fill(0); }
}

function decode(value, size) {
  if (typeof value !== 'string') throw new Error('Invalid encrypted configuration.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) {
    throw new Error('Invalid encrypted configuration.');
  }
  return bytes;
}

export function encryptEnv(plaintext, password) {
  if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > MAX_BYTES) {
    throw new Error('Configuration must contain 1 byte to 1 MiB.');
  }
  const salt = randomBytes(32), iv = randomBytes(12), key = derive(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      format: FORMAT, cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N: 131072, r: 8, p: 1 },
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    };
  } finally { key.fill(0); }
}

export function decryptEnv(envelope, password) {
  if (envelope?.format !== FORMAT || envelope.cipher !== 'aes-256-gcm' ||
      envelope.kdf?.name !== 'scrypt' || envelope.kdf.N !== 131072 ||
      envelope.kdf.r !== 8 || envelope.kdf.p !== 1 ||
      typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > Math.ceil(MAX_BYTES / 3) * 4) {
    throw new Error('Unsupported encrypted configuration.');
  }
  const salt = decode(envelope.salt, 32), iv = decode(envelope.iv, 12);
  const tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ciphertext);
  const key = derive(password, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Incorrect passphrase or encrypted file was changed. No .env was written.');
  } finally { key.fill(0); }
}

export async function saveDecrypted(envelope, password, target) {
  const plaintext = decryptEnv(envelope, password);
  try {
    await writeFile(target, plaintext, { flag: 'wx', mode: 0o600 });
  } finally { plaintext.fill(0); }
}

async function promptPassword() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Use an interactive terminal, or --password-file with a private local file.');
  }
  process.stdout.write('Team passphrase (input hidden): ');
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let input = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolvePassword(input);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else if (/^[A-Za-z0-9_-]$/.test(char) && input.length < 256) input += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(args) {
  const [command, ...options] = args;
  if (!['encrypt', 'decrypt'].includes(command) ||
      (options.length && !(command === 'decrypt' && options.length === 2 && options[0] === '--password-file'))) {
    throw new Error('Usage: node scripts/team-env.mjs encrypt | decrypt [--password-file <private file>]');
  }
  const source = resolve(ROOT, '.env'), encrypted = resolve(ROOT, '.env.enc');
  if (command === 'encrypt') {
    const plaintext = await readFile(source);
    try {
      await mkdir(dirname(PASSWORD_FILE), { recursive: true, mode: 0o700 });
      let password;
      try { password = (await readFile(PASSWORD_FILE, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        password = randomBytes(32).toString('base64url');
        await writeFile(PASSWORD_FILE, password + '\n', { flag: 'wx', mode: 0o600 });
      }
      const envelope = encryptEnv(plaintext, password);
      const verified = decryptEnv(envelope, password);
      try { if (!verified.equals(plaintext)) throw new Error('Round-trip verification failed.'); }
      finally { verified.fill(0); }
      const temporary = resolve(ROOT, '.runtime/team-env/encrypted-' + randomBytes(8).toString('hex') + '.tmp');
      try {
        await writeFile(temporary, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, encrypted);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      console.log('Encrypted .env -> .env.enc; byte-for-byte round-trip verified.');
      console.log('Passphrase is only in .runtime/team-env/passphrase.txt; share it privately.');
    } finally { plaintext.fill(0); }
  } else {
    const password = options.length ? (await readFile(resolve(options[1]), 'utf8')).trim() : await promptPassword();
    const raw = await readFile(encrypted, 'utf8');
    if (raw.length > MAX_BYTES * 2) throw new Error('Encrypted file is too large.');
    await saveDecrypted(JSON.parse(raw), password, source);
    console.log('Created .env. Existing local configuration is never overwritten.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.code === 'EEXIST' ? '.env already exists. Back it up or move it before decrypting.' : error.message);
    process.exitCode = 1;
  });
}
