import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptEnv, decryptEnv, saveDecrypted } from '../scripts/team-env.mjs';

test('team configuration authenticates the ciphertext and preserves existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seatraces-team-env-'));
  const password = randomBytes(32).toString('base64url');
  const input = Buffer.from('# 示例\r\nEXAMPLE_VALUE=only-test\r\n', 'utf8');
  const envelope = encryptEnv(input, password);
  const target = join(directory, '.env');
  try {
    assert.deepEqual(decryptEnv(envelope, password), input);
    assert.throws(() => decryptEnv(envelope, randomBytes(32).toString('base64url')), /Incorrect passphrase/);
    const altered = structuredClone(envelope);
    const bytes = Buffer.from(altered.ciphertext, 'base64'); bytes[0] ^= 1;
    altered.ciphertext = bytes.toString('base64');
    await assert.rejects(saveDecrypted(altered, password, target), /Incorrect passphrase/);
    await assert.rejects(access(target), { code: 'ENOENT' });
    await saveDecrypted(envelope, password, target);
    assert.deepEqual(await readFile(target), input);
    await writeFile(target, 'keep existing configuration');
    await assert.rejects(saveDecrypted(envelope, password, target), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), 'keep existing configuration');
    assert.throws(() => decryptEnv({ ...envelope, kdf: { ...envelope.kdf, N: 1 } }, password), /Unsupported/);
  } finally {
    await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});
