import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.runtime/catalog-access');
const config = JSON.parse(await readFile(path.join(directory, 'approved.json'), 'utf8'));
if (config.scope !== 'catalog-loopback-only' || !config.approvedAt || config.server !== '124.223.110.193' || config.user !== 'ubuntu')
  throw Error('Missing approved catalog connection configuration');
const identity = path.join(directory, 'id_ed25519');
const knownHosts = path.join(directory, 'known_hosts');
await access(identity); await access(knownHosts);
let child, timer, stopping = false, attempts = 0;
const stateFile = path.join(directory, 'connection.json');
let pendingRecord = Promise.resolve();
function record(state, extra = {}) {
  const snapshot = JSON.stringify({ state, pid: process.pid, sshPid: child?.pid, updatedAt: new Date().toISOString(), ...extra });
  pendingRecord = pendingRecord.then(() => writeFile(stateFile, snapshot));
  return pendingRecord;
}
async function connect() {
  if (stopping) return;
  if (++attempts > 5) { await record('stopped_after_repeated_failure'); process.exitCode = 1; return; }
  child = spawn(config.sshExecutable || 'ssh', ['-N','-T','-i',identity,
    '-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+knownHosts,'-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3',
    '-L','127.0.0.1:8791:127.0.0.1:8791','ubuntu@124.223.110.193'],
    { windowsHide: true, stdio:['ignore','ignore','pipe'] });
  let errorText = '';
  child.stderr.on('data', data => { errorText = (errorText + String(data)).slice(-2000); });
  child.on('error', async () => { stopping = true; await record('ssh_start_failed'); process.exitCode=1; });
  const initialState = record('connecting');
  child.on('exit', async code => {
    if (stopping) { await record('stopped'); return; }
    const permanent = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Address already in use|cannot listen to port/i.test(errorText);
    await record(permanent ? 'attention_required' : 'disconnected', { code, retry: !permanent });
    if (permanent) { stopping=true;process.exitCode=1;return; }
    timer=setTimeout(()=>connect().catch(()=>{process.exitCode=1;}),15000);
  });
  await initialState;
}
function stop() { stopping=true;clearTimeout(timer);child?.kill(); }
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>child?.kill());
await connect();
