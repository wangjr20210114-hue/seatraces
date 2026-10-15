import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const remote='https://github.com/wangjr20210114-hue/seatraces.git';
export function forbiddenPath(name){
  const parts=name.replaceAll('\\','/').split('/');
  return parts.some(p=>['..','.git','.runtime','node_modules','validation','dist','backups','screenshots','archive','.ssh'].includes(p)) ||
    parts.some(p=>p.startsWith('.env') && !['.env.example','.env.enc'].includes(p)) ||
    parts.some(p=>['backend.env','database.json','reader.json','business-credentials.json'].includes(p)) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|dump|sqlite3?|osm\.pbf|hap)$/i.test(name);
}
export function scanForSecrets(name,bytes,known=[]){
  if(forbiddenPath(name))throw Error('禁止提交运行数据或凭据文件：'+name);
  if(name.endsWith('.env.enc'))return;
  const text=bytes.toString('utf8');
  if(known.some(v=>v.length>=8&&text.includes(v)) || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/.test(text))
    throw Error('发现疑似密钥，已停止：'+name);
}
function executable(candidates){for(const value of candidates.filter(Boolean)){const r=spawnSync(value,['--version'],{encoding:'utf8',windowsHide:true});if(!r.error&&r.status===0)return value;}throw Error('找不到 Git，请安装 Git for Windows 并加入 PATH。');}
function run(exe,args,{inherit=false,input}={}){
  const r=spawnSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:inherit?'inherit':'pipe',input});
  if(r.error||r.status!==0)throw Error((r.stderr||r.error?.message||`命令退出：${r.status}`).trim());
  return r.stdout||'';
}
async function main(){
  const args=process.argv.slice(2);let message='',only=[],yes=false,check=false,retry='';
  for(let i=0;i<args.length;i++){
    if(args[i]==='--message')message=args[++i]||'';
    else if(args[i]==='--only')only.push(args[++i]||'');
    else if(args[i]==='--yes')yes=true;
    else if(args[i]==='--check')check=true;
    else if(args[i]==='--retry')retry=args[++i]||'';
    else throw Error('参数：--message "说明"、--only 相对文件、--yes、--check、--retry 提交SHA');
  }
  const git=executable([process.env.SEATRACES_GIT,'git', 'C:/Program Files/Git/cmd/git.exe','D:/Git/cmd/git.exe']);
  const g=(...a)=>run(git,a).trim();
  if(path.resolve(g('rev-parse','--show-toplevel')).toLowerCase()!==path.resolve(root).toLowerCase())throw Error('请先在此项目根目录克隆/配置 Git。');
  if(g('branch','--show-current')!=='main')throw Error('正式部署使用 main。请先把开发分支合并到 main，再运行此脚本。');
  if(![remote,remote.replace('.git',''),'git@github.com:wangjr20210114-hue/seatraces.git'].includes(g('remote','get-url','origin')))throw Error('origin 不是 SeaTraces 团队仓库。');
  const configPath=path.join(root,'.runtime/deploy-access/config.json');
  if(!existsSync(configPath))throw Error('尚未配置专用部署连接。先完成 deploy/README.md 中的一次性配置。');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  if(config.host!=='124.223.110.193'||config.user!=='ubuntu'||config.port!==22)throw Error('部署目标与当前团队服务器不一致。');
  const key=path.resolve(root,config.identityFile),knownHosts=path.resolve(root,config.knownHostsFile);
  if(!existsSync(key)||!existsSync(knownHosts))throw Error('缺少本机部署密钥或已验证的服务器主机密钥。');
  const ssh=process.platform==='win32'?path.join(process.env.WINDIR||'C:/Windows','System32/OpenSSH/ssh.exe'):'ssh';
  const sshArgs=['-i',key,'-p',String(config.port),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlgorithms=ssh-ed25519','-o','UserKnownHostsFile='+knownHosts,'-o','ConnectTimeout=10',config.user+'@'+config.host];
  const server=command=>{const answer=JSON.parse(run(ssh,[...sshArgs,command]));if(answer.error)throw Error(answer.error);return answer;};
  console.log('检查本机和部署连接…');
  const readiness=server('check');
  if(readiness.protocol!=='seatraces-git-deploy/1'||readiness.branch!=='main'||!readiness.clean)throw Error('服务器必须位于 main 且没有未提交修改。');
  const gatewayHash=createHash('sha256').update(readFileSync(path.join(root,'deploy/deploy-from-git.py'),'utf8').replaceAll('\r\n','\n')).digest('hex');
  if(readiness.gatewaySha256!==gatewayHash)throw Error('服务器部署程序与本机版本不同，请由管理员重新审查并安装部署连接。');
  run(git,['fetch','origin','main'],{inherit:true});
  if(spawnSync(git,['merge-base','--is-ancestor','origin/main','HEAD'],{cwd:root,windowsHide:true}).status!==0)throw Error('main 落后或分叉：先 git pull 并处理冲突。');
  if(check){console.log('预检查通过：本机 main、Git 远端、服务器部署连接均可用。');return;}
  let commit;
  if(retry){
    if(!/^[a-f0-9]{40}$/.test(retry)||g('rev-parse','origin/main')!==retry)throw Error('只能重试远端 main 当前的完整提交 SHA。');
    commit=retry;
  }else{
    const split=text=>text.split('\0').filter(Boolean);
    const changed=[...new Set([...split(run(git,['diff','--name-only','HEAD','-z'])),...split(run(git,['ls-files','--others','--exclude-standard','-z']))])];
    const files=only.length?changed.filter(f=>only.includes(f)):changed;
    if(only.some(f=>!changed.includes(f)))throw Error('--only 包含未变更或不存在的路径。');
    const staged=split(run(git,['diff','--cached','--name-only','-z']));
    if(staged.some(f=>!files.includes(f)))throw Error('暂存区包含本次范围外的文件，请先处理暂存区。');
    const known=[];const envFile=path.join(root,'.env');
    if(existsSync(envFile))for(const line of readFileSync(envFile,'utf8').split(/\r?\n/)){
      const m=line.match(/^\s*([^#=]+)=(.*)$/);if(m&&/KEY|TOKEN|PASSWORD|SECRET|SECURITY_CODE/.test(m[1]))known.push(m[2].trim().replace(/^['"]|['"]$/g,''));
    }
    const passphrase=path.join(root,'.runtime/team-env/passphrase.txt');if(existsSync(passphrase))known.push(readFileSync(passphrase,'utf8').trim());
    for(const file of files){if(forbiddenPath(file))throw Error('禁止自动提交：'+file);const p=path.resolve(root,file),rel=path.relative(root,p);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('文件路径越界');if(existsSync(p)){if(!statSync(p).isFile())throw Error('不支持的文件：'+file);scanForSecrets(file,readFileSync(p),known);}}
    console.log(files.length?'将提交：\n'+files.map(f=>'  '+f).join('\n'):'没有新的文件修改，将部署已提交版本。');
    const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
    if(!existsSync(npmCli))throw Error('找不到 npm CLI，请使用标准 Node.js 安装。');
    run(process.execPath,[npmCli,'run','check'],{inherit:true});
    if(!yes){const rl=createInterface({input:process.stdin,output:process.stdout});try{
      if(files.length&&!message)message=(await rl.question('提交说明：')).trim();
      if((await rl.question('推送 main 并部署团队服务器？输入 y 继续：')).trim().toLowerCase()!=='y')return;
    }finally{rl.close();}}
    if(files.length){
      if(!message.trim())throw Error('请提供 --message 提交说明。');
      for(let i=0;i<files.length;i+=80)run(git,['add','--',...files.slice(i,i+80)]);
      // Scan the exact staged blobs as well, including files edited during checks.
      for(const file of split(run(git,['diff','--cached','--name-only','--diff-filter=ACMR','-z'])))scanForSecrets(file,Buffer.from(run(git,['show',':'+file])),known);
      run(git,['commit','-m',message],{inherit:true});
    }
    commit=g('rev-parse','HEAD');
    run(git,['push','origin','HEAD:refs/heads/main'],{inherit:true});
    const remoteHead=g('ls-remote','origin','refs/heads/main').split(/\s/)[0];if(remoteHead!==commit)throw Error('远端 main 已变化，未部署其他版本。');
  }
  console.log('开始部署 '+commit+' …');let result=server('deploy '+commit),last='';
  const deadline=Date.now()+20*60*1000;
  while(Date.now()<deadline){
    if(result.phase!==last){console.log('服务器：'+result.phase);last=result.phase;}
    if(result.phase==='completed'){console.log('部署成功：https://trip.seatraces.com\n提交：'+commit);return;}
    if(['failed','rolled_back','rollback_failed'].includes(result.phase))throw Error('服务器：'+result.phase+'；'+(result.error||'请检查部署记录')+'。已推送的提交不会被删除。');
    await sleep(5000);result=server('status '+commit);
  }
  throw Error('等待超时，服务器任务可能仍在运行。不要重复提交；使用 --retry '+commit+' 核对/重试。');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
