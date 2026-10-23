/* 处理注册、登录、邮件验证和密码找回。 */

import { setIconLabel, mountStaticIcons } from './ui-icons.js';
mountStaticIcons();
const $ = s => document.querySelector(s);
let mode = 'login', emailEnabled = false, busy = false, guestAvailable = false;
const link = new URLSearchParams(location.hash.slice(1));
const token = link.get('token');
const action = link.get('action');
if(new URLSearchParams(location.search).get('next')==='admin')location.replace('/admin-login.html');
if (location.hash) history.replaceState(null, '', '/login.html');
async function api(path, body) {
  let r;
  try { r = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Seatraces': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw Error('暂时连不上服务，请稍后再试'); }
  const data = await r.json();
  if (!r.ok) throw Error(data.error || '暂时无法完成，请再试一次');
  return data;
}
function setMode(next) {
  if (busy) return;
  mode = next;
  const regular = ['login','register'].includes(mode);
  $('#login-tabs').hidden = !regular;
  $('#login-form').reset();
  $('#login-error').textContent = '';
  $('#login-message').textContent = '';
  const fields = { username: regular, email: mode === 'forgot', password: mode !== 'forgot' && mode !== 'verify', confirm: mode === 'register' || mode === 'reset' };
  for (const [name, visible] of Object.entries(fields)) {
    $(`#${name}-field`).hidden = !visible;
    const input = $(`[name="${name}"]`);
    input.disabled = !visible; input.required = visible;
  }
  $('[name="password"]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#password-label').textContent = mode === 'reset' ? '新密码' : '密码';
  $('#forgot-password').hidden = mode !== 'login';
  $('#guest-field').hidden = !(mode === 'register' && guestAvailable);
  $('[name="claimGuest"]').disabled = mode !== 'register' || !guestAvailable;
  $('#back-login').hidden = regular;
  setIconLabel($('#submit-login'), ({ login: '登录', register: '创建账号', forgot: '发送重设邮件', reset: '保存新密码', verify: '确认绑定邮箱' })[mode], 'external');
  $('#login-title').textContent = ({ login: '收好行囊，出发吧', register: '第一程，从这里开始', forgot: '找回你的通行证', reset: '换一把新的钥匙', verify: '确认你的邮箱' })[mode];
  $('#login-subtitle').textContent = mode === 'forgot' ? (emailEnabled ? '使用之前验证绑定的邮箱。' : '邮箱服务尚未配置，暂时无法发送邮件。') : mode === 'verify' ? '确认后，可用此邮箱找回密码。' : mode === 'register' ? '账号唯一且固定，昵称之后可以修改。' : '登录，收好你的每一程。';
  $('#submit-login').disabled = mode === 'forgot' && !emailEnabled;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
}
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('#forgot-password').onclick = () => setMode('forgot');
$('#back-login').onclick = () => setMode('login');
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  if (busy) return;
  const form = e.currentTarget, fields = new FormData(form);
  $('#login-error').textContent = '';
  if (['register','reset'].includes(mode) && fields.get('password') !== fields.get('confirm')) { $('#login-error').textContent = '两次密码不一致'; return; }
  if (fields.get('password') && new TextEncoder().encode(fields.get('password')).length > 72) { $('#login-error').textContent = '密码过长，请控制在 72 个字节内'; return; }
  busy = true; $('#submit-login').disabled = true;
  const submittedMode = mode;
  try {
    const paths = { login: 'auth/login', register: 'auth/register', forgot: 'auth/forgot-password', reset: 'auth/reset-password', verify: 'auth/verify-email' };
    const body = mode === 'verify' ? { token } : mode === 'reset' ? { token, password: fields.get('password') } : Object.fromEntries([...fields].filter(([k]) => !['confirm','claimGuest'].includes(k)));
    if (mode === 'register') body.claimGuest = fields.has('claimGuest');
    const result = await api(paths[mode], body);
    if (['login','register'].includes(mode)) { try { sessionStorage.setItem('seatraces:inbox-login','1'); } catch {} localStorage.removeItem('seatraces-last-trip'); location.replace(new URLSearchParams(location.search).get('next')==='admin'?'/admin.html':'/'); return; }
    form.reset();
    busy = false;
    if (mode === 'reset' || mode === 'verify') setMode('login');
    $('#login-message').textContent = result.message;
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { busy = false; $('#submit-login').disabled = submittedMode === 'forgot' && !emailEnabled; }
};
setMode(action === 'reset_password' && token ? 'reset' : action === 'verify_email' && token ? 'verify' : 'login');
void api('auth/config').then(c => { emailEnabled = c.emailEnabled; if (mode === 'forgot') setMode(mode); }).catch(() => {});
void api('me').then(data => {
  guestAvailable = data.guestAvailable;
  $('#guest-field').hidden = !(mode === 'register' && guestAvailable);
  $('[name="claimGuest"]').disabled = mode !== 'register' || !guestAvailable;
  if (data.user && !token && new URLSearchParams(location.search).get('switch') !== '1') location.replace(new URLSearchParams(location.search).get('next')==='admin'?'/admin.html':'/');
}).catch(() => { $('#login-error').textContent = '暂时连不上服务，连接恢复后可重试登录。'; });
