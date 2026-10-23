/* 验证版本发布流程。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {forbiddenPath,scanForSecrets} from '../scripts/publish-deploy.mjs';

test('publishing excludes credentials, runtime data, database dumps and path escapes',()=>{
  for(const name of ['.env','nested/.env.production','.runtime/key','a/../secret','backup.dump','reader.json','dist/client.hap'])assert.equal(forbiddenPath(name),true,name);
  for(const name of ['.env.example','.env.enc','server/index.mjs','deploy/deploy-from-git.py'])assert.equal(forbiddenPath(name),false,name);
});
test('staged source cannot contain local secret values or private keys',()=>{
  assert.throws(()=>scanForSecrets('public/app.js',Buffer.from('secret-placeholder-123'),['secret-placeholder-123']));
  assert.throws(()=>scanForSecrets('file.txt',Buffer.from('-----BEGIN OPENSSH '+'PRIVATE KEY-----')));
  assert.doesNotThrow(()=>scanForSecrets('.env.example',Buffer.from('DEEPSEEK_API_KEY=')));
});
