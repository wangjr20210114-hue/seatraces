/* 展示账号信息，处理头像、昵称和邮箱绑定。 */

export async function renderAccountPage({ content, api, esc, isCurrent, onUser, onLogout }) {
  const $ = selector => content.querySelector(selector);
  const { user } = await api('/api/me');
  if (!user) { location.replace('/login.html'); return; }
  const config = await api('/api/auth/config');
  if (!isCurrent()) return;
  const choices = ['🌊','🌿','🧭','🌸','🏔️','☀️'];
  const icons = {
    camera: '<path d="m8 6 1.5-2h5L16 6h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
    pen: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L5 15Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
    swap: '<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/>',
    exit: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5m5-12 4 4-4 4m-7-4h11"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  const icon = name => `<svg class="account-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  content.className = 'account-page';
  content.innerHTML = `<form id="profile-form">
    <section class="account-pass" aria-label="旅行名片">
      <span class="pass-spark" aria-hidden="true">✦</span>
      <div class="account-pass-top">
        <div id="avatar-preview" class="avatar-preview"></div>
        <div class="account-pass-identity"><span class="account-kicker">我的旅行名片</span><h2 id="account-display-name">${esc(user.nickname)}</h2><span class="account-id" aria-label="账号，不可修改">ID · ${esc(user.username)}</span></div>
      </div>
      <div class="account-avatar-tools"><span>选个喜欢的头像</span><button id="upload-avatar" class="account-upload" type="button">${icon('camera')}<span>上传头像</span></button></div>
      <input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传自己的头像" hidden>
      <div class="avatar-options" role="group" aria-label="选择预设头像">${choices.map(a => `<button type="button" data-avatar="${a}" aria-label="头像 ${a}" aria-pressed="${!user.avatarUrl && a === user.avatar}"><span aria-hidden="true">${a}</span></button>`).join('')}</div>
    </section>
    <section class="account-details" aria-label="个人资料">
      <label class="field"><span>怎么称呼你</span><span class="account-input-wrap"><input name="nickname" aria-label="昵称" value="${esc(user.nickname)}" autocomplete="nickname" required maxlength="40">${icon('pen')}</span></label>
      
      <button class="primary account-save" type="submit">${icon('check')}<span>保存资料</span></button>
      <p id="profile-message" class="account-feedback" role="status"></p>
    </section>
  </form>
  <section class="account-mail" aria-labelledby="account-mail-title"><header><span class="account-mail-icon">${icon('mail')}</span><h2 id="account-mail-title">找回密码邮箱</h2><span class="account-badge ${user.emailVerified ? 'verified' : ''}">${user.emailVerified ? '已验证' : config.emailEnabled ? '待绑定' : '暂未开放'}</span></header>${user.emailVerified
    ? `<p class="account-email">${esc(user.email)}</p>`
    : config.emailEnabled ? `<form id="email-bind"><label class="field"><span>邮箱</span><input type="email" name="email" autocomplete="email" required maxlength="254"></label><label class="field"><span>当前密码</span><input name="password" type="password" autocomplete="current-password" required></label><button class="account-secondary" type="submit">${icon('mail')}<span>发送验证邮件</span></button></form>`
    : '<p>邮箱功能开放后，就能绑定邮箱找回密码。</p>'}<p id="email-message" class="account-feedback" role="status"></p></section>
  <div class="account-session-actions"><a href="/login.html?switch=1" class="account-secondary">${icon('swap')}<span>切换账号</span></a><button id="sign-out" class="account-secondary account-sign-out" type="button">${icon('exit')}<span>退出登录</span></button></div>
  <p id="session-message" class="account-feedback" role="status"></p>
  <p class="account-signoff" aria-hidden="true">≈ 一路去玩</p>`;
  function preview(u) {
    if (!isCurrent()) return;
    const slot = $('#avatar-preview'); slot.replaceChildren();
    if (u.avatarUrl) { const img = document.createElement('img'); img.src = u.avatarUrl; img.alt = '我的头像'; slot.append(img); }
    else slot.textContent = u.avatar;
  }
  preview(user);
  let selectedAvatar, uploading = false;
  const message = (text, kind = 'success', selector = '#profile-message') => {
    if (!isCurrent()) return;
    $(selector).textContent = text;
    $(selector).dataset.kind = kind;
  };
  const saved = data => {
    onUser(data.user); Object.assign(user, data.user); preview(data.user);
    if (isCurrent()) $('#account-display-name').textContent = data.user.nickname;
  };
  $('#upload-avatar').onclick = () => $('#avatar-file').click();
  content.querySelectorAll('[data-avatar]').forEach(b => b.onclick = () => {
    selectedAvatar = b.dataset.avatar;
    preview({ avatar: selectedAvatar });
    content.querySelectorAll('[data-avatar]').forEach(other => other.setAttribute('aria-pressed', other === b));
  });
  $('#avatar-file').onchange = async e => {
    const input = e.target, file = input.files[0]; if (!file || uploading) return;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { message('请选择 10 MB 以内的 JPG、PNG 或 WebP 图片', 'error'); input.value = ''; return; }
    uploading = true;
    const uploadText = $('#upload-avatar span');
    uploadText.textContent = '上传中…';
    content.querySelectorAll('#profile-form button').forEach(b => b.disabled = true);
    let url;
    try {
      url = URL.createObjectURL(file);
      const img = new Image(); img.src = url;
      try { await img.decode(); }
      catch { throw Error('图片无法读取，请选择完整的 JPG、PNG 或 WebP 图片'); }
      if (!img.naturalWidth || !img.naturalHeight) throw Error('图片无法读取，请重新选择图片');
      if (!isCurrent()) return;
      if (img.naturalWidth * img.naturalHeight > 16000000) throw Error('图片过大，请选择 1600 万像素以内的照片');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      saved(await api('/api/me/avatar', { image: canvas.toDataURL('image/png') }, 'PUT'));
      selectedAvatar = undefined;
      content.querySelectorAll('[data-avatar]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      message('头像已保存');
    } catch (error) { message(error.message || '图片暂时无法读取', 'error'); }
    finally { if (url) URL.revokeObjectURL(url); uploading = false; uploadText.textContent = '上传头像'; input.value = ''; content.querySelectorAll('#profile-form button').forEach(b => b.disabled = false); }
  };
  $('#profile-form').onsubmit = async e => {
    e.preventDefault(); if (uploading) return;
    const form = e.currentTarget, fields = new FormData(form), button = form.querySelector('[type=submit]'); button.disabled = true;
    button.querySelector('span').textContent = '保存中…';
    try {
      saved(await api('/api/me', { nickname: fields.get('nickname'), ...(selectedAvatar ? { avatar: selectedAvatar } : {}) }, 'PATCH'));
      message('资料已保存');
    } catch (error) { message(error.message, 'error'); }
    finally { button.disabled = false; button.querySelector('span').textContent = '保存资料'; }
  };
  if ($('#email-bind')) $('#email-bind').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget, button = form.querySelector('button'); button.disabled = true;
    try { const result = await api('/api/auth/email/request', Object.fromEntries(new FormData(form))); form.reset(); message(result.message, 'success', '#email-message'); }
    catch (error) { message(error.message, 'error', '#email-message'); }
    finally { button.disabled = false; }
  };
  $('#sign-out').onclick = async e => {
    const button = e.currentTarget; button.disabled = true;
    try { await api('/api/auth/logout', {}); onLogout(); }
    catch (error) { message(error.message, 'error', '#session-message'); button.disabled = false; }
  };
}
