// 个人资料页签（R003 个人设置）：头像上传/移除 + 昵称修改；账号只读
// 昵称与头像均按服务端身份隔离存储；fnOS 模式下账号由 fnOS 系统管理，仅可调昵称（备注名）
import { apiUrl, getRuntime } from './base.js';
import { icon } from './icons.js';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 头像地址（带 avatarUpdatedAt 缓存穿透；未设置时返回 null） */
function avatarUrlOf(profile) {
  if (!profile?.hasAvatar) return null;
  const v = profile.avatarUpdatedAt ? `?v=${encodeURIComponent(profile.avatarUpdatedAt)}` : '';
  return `${apiUrl('profile/avatar')}${v}`;
}

/** 渲染头像预览：有头像显示图片，否则回退展示名首字 */
function paintAvatar(el, profile, displayName) {
  el.classList.remove('img');
  el.style.backgroundImage = '';
  const url = avatarUrlOf(profile);
  if (url) {
    el.textContent = '';
    el.classList.add('img');
    el.style.backgroundImage = `url("${url}")`;
  } else {
    el.textContent = (displayName || '—').trim().charAt(0) || '—';
  }
}

/**
 * 渲染「个人资料」页签。
 * @param {HTMLElement} pane
 * @param {{onProfileChanged?: () => void}} opts 变更回调（app.js 用于刷新左下角与菜单）
 */
export function renderUserProfilePane(pane, { onProfileChanged } = {}) {
  pane.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">头像</div>
      <div class="user-mgmt-avatar-row">
        <span class="user-avatar big" id="um-avatar">…</span>
        <div class="user-mgmt-avatar-actions">
          <div class="user-mgmt-avatar-btns">
            <button type="button" class="btn" id="um-avatar-upload">${icon('upload', 13)} 上传头像</button>
            <button type="button" class="btn" id="um-avatar-remove" hidden>${icon('trash', 13)} 移除头像</button>
          </div>
          <div class="pref-desc">支持 PNG / JPEG / WebP / GIF，不超过 2MB</div>
          <div class="pref-desc" id="um-avatar-status"></div>
        </div>
      </div>
      <input type="file" id="um-avatar-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
    </div>
    <div class="pref-section">
      <div class="pref-title">账号信息</div>
      <div class="pref-row">
        <div class="pref-label">账号<div class="pref-desc" id="um-account-desc">账号不可修改</div></div>
        <div class="um-account-value" id="um-account">…</div>
      </div>
      <div class="pref-row">
        <div class="pref-label">昵称<div class="pref-desc">仅在本应用内展示；留空保存即恢复为账号名</div></div>
        <input type="text" class="pref-input" id="um-nickname" maxlength="32" placeholder="未设置" style="width:200px" />
      </div>
      <div class="form-actions">
        <button type="button" class="btn primary" id="um-save">保存昵称</button>
      </div>
    </div>`;

  const avatarEl = pane.querySelector('#um-avatar');
  const uploadBtn = pane.querySelector('#um-avatar-upload');
  const removeBtn = pane.querySelector('#um-avatar-remove');
  const fileInput = pane.querySelector('#um-avatar-file');
  const statusEl = pane.querySelector('#um-avatar-status');
  const accountEl = pane.querySelector('#um-account');
  const accountDescEl = pane.querySelector('#um-account-desc');
  const nickInput = pane.querySelector('#um-nickname');
  const saveBtn = pane.querySelector('#um-save');

  let current = null; // 最近一次 GET /api/profile 结果

  const reload = async () => {
    const r = await fetch(apiUrl('profile'));
    if (!r.ok) return;
    current = await r.json();
    const account = current.username || current.id || '—';
    accountEl.textContent = account;
    nickInput.value = current.nickname ?? '';
    // 头像回退字优先昵称首字（与 app.js 展示格式「账号(昵称)」的头像字规则一致）
    paintAvatar(avatarEl, current, current.nickname || account);
    removeBtn.hidden = !current.hasAvatar;
    getRuntime().then((rt) => {
      if (rt.mode === 'fnos') {
        accountDescEl.textContent = '飞牛账号由 fnOS 系统管理，不可修改；昵称仅作为本应用内的展示备注名';
      }
    });
  };
  reload().catch(() => {
    statusEl.textContent = '用户信息加载失败，请刷新重试';
  });

  // —— 头像上传：本地选文件 → 前端体积预检 → 原始字节 POST（服务端 magic bytes 复核）——
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // 允许连续选择同一文件
    if (!file) return;
    if (file.size > AVATAR_MAX_BYTES) {
      statusEl.textContent = '文件超过 2MB，请压缩后再上传';
      return;
    }
    uploadBtn.disabled = true;
    statusEl.textContent = '上传中…';
    file
      .arrayBuffer()
      .then((buf) =>
        fetch(apiUrl('profile/avatar'), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: buf,
        })
      )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error?.message || `上传失败（${r.status}）`);
        }
        statusEl.textContent = '头像已更新';
        await reload();
        onProfileChanged?.();
      })
      .catch((e) => {
        statusEl.textContent = e.message || '上传失败，请重试';
      })
      .finally(() => {
        uploadBtn.disabled = false;
      });
  });

  // —— 头像移除：幂等；成功后回退首字头像 ——
  removeBtn.addEventListener('click', async () => {
    removeBtn.disabled = true;
    statusEl.textContent = '移除中…';
    try {
      const r = await fetch(apiUrl('profile/avatar'), { method: 'DELETE' });
      if (!r.ok) throw new Error();
      statusEl.textContent = '头像已移除';
      await reload();
      onProfileChanged?.();
    } catch {
      statusEl.textContent = '移除失败，请重试';
    } finally {
      removeBtn.disabled = false;
    }
  });

  // —— 昵称保存：空串=清除（回退账号名）——
  saveBtn.addEventListener('click', async () => {
    const nickname = nickInput.value.trim();
    saveBtn.disabled = true;
    try {
      const r = await fetch(apiUrl('profile'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error?.message || `保存失败（${r.status}）`);
      }
      statusEl.textContent = '昵称已保存';
      await reload();
      onProfileChanged?.();
    } catch (e) {
      statusEl.textContent = e.message || '保存失败，请重试';
    } finally {
      saveBtn.disabled = false;
    }
  });
}
