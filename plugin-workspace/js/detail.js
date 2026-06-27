// 即页 uTools 插件 · 文件详情弹窗（详情 / 版本 / 标签 / 分类）

window.Detail = (function () {
  async function open(file, allTags, allCategories) {
    const detail = file;
    let templates = [];
    if (detail.file_type === 'markdown' && !detail.is_bundle) {
      try {
        const res = await window.jpage.listTemplates();
        templates = (res.templates || []);
      } catch (err) {
        console.warn('加载渲染模板失败', err);
      }
    }
    const shareUrl = window.jpage.getShareUrl(detail.share_key);

    const render = () => {
      const templateOptions = templates.map(
        (t) => `<option value="${t.id}" ${t.id === detail.template_id ? 'selected' : ''}>${JP.escapeHtml(t.name)}${t.is_builtin ? '（内置）' : ''}</option>`
      ).join('');
      const templateRow = detail.file_type === 'markdown' && !detail.is_bundle
        ? `<div class="label">渲染模板</div>
           <div class="value">
             <select id="d-template" class="select" style="max-width:220px">
               <option value="">默认</option>
               ${templateOptions}
             </select>
           </div>`
        : '';

      // 对比当前登录用户与文件上传者，帮助定位「无权操作」问题
      const currentUser = window.jpage.getConfig().user;
      const isOwner = currentUser && Number(detail.uploaded_by) === Number(currentUser.id);
      const isAdmin = currentUser && currentUser.role === 'admin';
      const ownerMatch = isOwner
        ? ' <span style="color:var(--success)">✓ 是你</span>'
        : isAdmin
        ? ' <span style="color:var(--success)">（管理员）</span>'
        : ' <span style="color:var(--danger)">⚠ 不是你（登录ID: ' + (currentUser ? currentUser.id : '?') + '）→ 无权修改</span>';
      const body = `
        <div class="detail-url-box">
          <input class="input" id="d-shareurl" value="${JP.escapeHtml(shareUrl)}" readonly />
          <button class="btn btn-sm jp-copy-url">复制链接</button>
          <button class="btn btn-sm btn-primary jp-open">打开</button>
        </div>

        <div class="detail-grid">
          <div class="label">文件名</div>
          <div class="value" id="d-name">${JP.escapeHtml(detail.original_name)}</div>
          <div class="label">类型</div>
          <div class="value">${detail.is_bundle ? '网站包 (bundle)' : JP.fileTypeLabel(detail.file_type)}</div>
          <div class="label">大小</div>
          <div class="value">${JP.formatSize(detail.size)}</div>
          <div class="label">可见性</div>
          <div class="value">
            <span id="d-visibility">${
        detail.is_public
          ? '🌐 公开'
          : '<span class="badge-private">🔒 私有</span>'
      }</span>
            <button class="btn btn-sm jp-toggle-public" style="margin-left:8px">
              切换为${detail.is_public ? '私有' : '公开'}
            </button>
          </div>
          <div class="label">更新时间</div>
          <div class="value">${JP.formatDate(detail.updated_at)}</div>
          <div class="label">上传者</div>
          <div class="value">ID: ${detail.uploaded_by}${ownerMatch}</div>
          <div class="label">浏览次数</div>
          <div class="value">${detail.view_count || 0}</div>
          <div class="label">标签</div>
          <div class="value">
            <div class="tag-editor" id="d-tags"></div>
          </div>
          <div class="label">分类</div>
          <div class="value">
            <select id="d-category" class="select" style="max-width:200px"></select>
          </div>
          ${templateRow}
        </div>

        <div style="margin-top:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <strong style="font-size:14px">版本历史</strong>
            <button class="btn btn-sm jp-load-versions">加载版本</button>
          </div>
          <div id="d-versions"></div>
        </div>

        <div style="display:flex;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
          <button class="btn jp-download">⬇ 下载</button>
          <button class="btn jp-rename">✏ 重命名</button>
          <button class="btn jp-share">🔗 分享设置</button>
          <div style="flex:1"></div>
          <button class="btn btn-danger jp-delete">🗑 删除</button>
        </div>
      `;
      return body;
    };

    const modal = JP.modal({
      title: detail.original_name,
      wide: true,
      bodyHtml: render(),
      // 不设 footer，操作按钮放 body 内
      onMount: (mask, close) => {
        // 复制/打开
        mask.querySelector('.jp-copy-url').onclick = () => {
          window.jpage.copyText(shareUrl);
          JP.toast('✓ 已复制分享链接');
        };
        mask.querySelector('.jp-open').onclick = () =>
          window.jpage.openExternal(shareUrl);

        // 标签编辑器
        renderTagEditor(mask, detail, allTags);

        // 分类下拉
        renderCategorySelect(mask, detail, allCategories);

        // 渲染模板切换
        const templateSel = mask.querySelector('#d-template');
        if (templateSel) {
          templateSel.onchange = async () => {
            try {
              const templateId = templateSel.value ? Number(templateSel.value) : null;
              await window.jpage.updateFile(detail.id, { templateId });
              detail.template_id = templateId;
              JP.toast('✓ 渲染模板已更新');
              document.dispatchEvent(new CustomEvent('jpage:refresh'));
            } catch (err) {
              JP.showError(err);
            }
          };
        }

        // 切换公开/私有
        mask.querySelector('.jp-toggle-public').onclick = async () => {
          try {
            await window.jpage.updateFile(detail.id, { isPublic: !detail.is_public });
            detail.is_public = detail.is_public ? 0 : 1;
            const vis = mask.querySelector('#d-visibility');
            vis.innerHTML = detail.is_public
              ? '🌐 公开'
              : '<span class="badge-private">🔒 私有</span>';
            mask.querySelector('.jp-toggle-public').textContent =
              '切换为' + (detail.is_public ? '私有' : '公开');
            JP.toast(detail.is_public ? '已设为公开' : '已设为私有');
            document.dispatchEvent(new CustomEvent('jpage:refresh'));
          } catch (err) {
            JP.showError(err);
          }
        };

        // 版本历史
        mask.querySelector('.jp-load-versions').onclick = () => loadVersions(mask, detail);

        // 下载：走 /api/files/:id/download（用文件 ID，不是 share_key）
        mask.querySelector('.jp-download').onclick = () => {
          const base = window.jpage.getConfig().base;
          window.jpage.openExternal(`${base}/api/files/${detail.id}/download`);
        };

        // 重命名
        mask.querySelector('.jp-rename').onclick = async () => {
          void JP.modal({
            title: '重命名',
            bodyHtml: `<input id="rn-input" class="input" value="${JP.escapeHtml(
              detail.original_name
            )}" />`,
            footerHtml: `<button class="btn jp-close">取消</button><button class="btn btn-primary jp-ok">保存</button>`,
            onMount: (m2, c2) => {
              const inp = m2.querySelector('#rn-input');
              setTimeout(() => {
                inp.focus();
                const dot = inp.value.lastIndexOf('.');
                inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
              }, 50);
              m2.querySelector('.jp-ok').onclick = async () => {
                const name = inp.value.trim();
                if (!name) return JP.toast('文件名不能为空');
                try {
                  await window.jpage.updateFile(detail.id, { name });
                  detail.original_name = name;
                  mask.querySelector('#d-name').textContent = name;
                  modal.el.querySelector('.modal-header h3').textContent = name;
                  c2();
                  JP.toast('✓ 已重命名');
                  document.dispatchEvent(new CustomEvent('jpage:refresh'));
                } catch (err) {
                  JP.showError(err);
                }
              };
            },
          });
        };

        // 分享设置
        mask.querySelector('.jp-share').onclick = () => openShareSettings(detail, (updated) => {
          Object.assign(detail, updated);
          const newUrl = window.jpage.getShareUrl(detail.share_key);
          mask.querySelector('#d-shareurl').value = newUrl;
        });

        // 删除
        mask.querySelector('.jp-delete').onclick = async () => {
          const ok = await JP.confirm({
            title: '删除文件',
            message: `确定删除「${detail.original_name}」？\n此操作不可撤销，将同时清理所有版本历史。`,
            danger: true,
            confirmText: '删除',
          });
          if (!ok) return;
          try {
            await window.jpage.deleteFile(detail.id);
            JP.toast('✓ 已删除');
            close();
            document.dispatchEvent(new CustomEvent('jpage:refresh'));
          } catch (err) {
            JP.showError(err);
          }
        };
      },
    });
  }

  // ---- 分享设置弹窗 ----
  function openShareSettings(file, onUpdate) {
    const shareUrl = window.jpage.getShareUrl(file.share_key);
    const expiresValue = file.share_expires_at
      ? new Date(file.share_expires_at).toISOString().slice(0, 16)
      : '';
    JP.modal({
      title: '分享设置',
      bodyHtml: `
        <div class="detail-url-box" style="margin-bottom:12px">
          <input class="input" value="${JP.escapeHtml(shareUrl)}" readonly />
          <button class="btn btn-sm jp-copy-url">复制</button>
        </div>
        <div class="detail-grid">
          <div class="label">自定义别名</div>
          <div class="value">
            <input id="share-alias" class="input" value="${JP.escapeHtml(file.share_key)}" placeholder="3-32位字母数字连字符" />
            <div style="font-size:12px;color:var(--text-mute);margin-top:4px">留空并保存可重新生成随机短链</div>
          </div>
          <div class="label">过期时间</div>
          <div class="value">
            <input id="share-expires" class="input" type="datetime-local" value="${expiresValue}" />
            <div style="font-size:12px;color:var(--text-mute);margin-top:4px">留空表示永不过期</div>
          </div>
          <div class="label">访问密码</div>
          <div class="value">
            <input id="share-password" class="input" type="password" placeholder="${file.has_share_password ? '已设置，留空保持不变' : '不设置密码请留空'}" />
            <div style="font-size:12px;color:var(--text-mute);margin-top:4px">4~128 位；留空可清除已有密码</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm jp-regenerate">🔄 重新生成短链</button>
        </div>`,
      footerHtml: `
        <button class="btn jp-close">取消</button>
        <button class="btn btn-primary jp-save">保存</button>`,
      onMount: (mask, close) => {
        mask.querySelector('.jp-copy-url').onclick = () => {
          window.jpage.copyText(shareUrl);
          JP.toast('✓ 已复制分享链接');
        };
        mask.querySelector('.jp-regenerate').onclick = async () => {
          const ok = await JP.confirm({
            title: '重新生成短链',
            message: '旧短链将立即失效，是否继续？',
            confirmText: '重新生成',
          });
          if (!ok) return;
          try {
            const data = await window.jpage.regenerateShareKey(file.id);
            file.share_key = data.share_key;
            file.share_expires_at = data.share_expires_at;
            file.has_share_password = data.has_share_password;
            JP.toast('✓ 已重新生成短链');
            onUpdate({ share_key: data.share_key, share_expires_at: data.share_expires_at, has_share_password: data.has_share_password });
            close();
          } catch (err) {
            JP.showError(err);
          }
        };
        mask.querySelector('.jp-save').onclick = async () => {
          const alias = mask.querySelector('#share-alias').value.trim();
          const expiresEl = mask.querySelector('#share-expires');
          const expiresValue = expiresEl.value.trim();
          const password = mask.querySelector('#share-password').value;

          const payload = {};
          if (alias !== file.share_key) payload.alias = alias;
          if (expiresValue) {
            payload.expiresAt = new Date(expiresValue).toISOString();
          } else if (file.share_expires_at && expiresValue === '') {
            payload.expiresAt = null;
          }
          if (password !== '') payload.password = password;
          else if (file.has_share_password && password === '') payload.password = null;

          if (Object.keys(payload).length === 0) {
            close();
            return;
          }
          try {
            const data = await window.jpage.updateShareSettings(file.id, payload);
            file.share_key = data.share_key;
            file.share_expires_at = data.share_expires_at;
            file.has_share_password = data.has_share_password;
            JP.toast('✓ 分享设置已保存');
            onUpdate({ share_key: data.share_key, share_expires_at: data.share_expires_at, has_share_password: data.has_share_password });
            close();
          } catch (err) {
            JP.showError(err);
          }
        };
      },
    });
  }

  // ---- 标签编辑器 ----
  function renderTagEditor(mask, detail, allTags) {
    const container = mask.querySelector('#d-tags');
    const selected = new Set((detail.tags || []).map((t) => t.id));

    function paint() {
      container.innerHTML = '';
      selected.forEach((tid) => {
        const t = allTags.find((x) => x.id === tid);
        if (!t) return;
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.innerHTML = `${JP.escapeHtml(t.name)} <span class="remove" data-id="${tid}">×</span>`;
        chip.querySelector('.remove').onclick = () => {
          selected.delete(tid);
          save();
          paint();
        };
        container.appendChild(chip);
      });
      // 输入框
      const input = document.createElement('input');
      input.className = 'tag-add-input';
      input.placeholder = selected.size ? '添加更多…' : '输入标签名回车添加';
      input.onkeydown = async (e) => {
        if (e.key === 'Enter') {
          const val = input.value.trim();
          if (!val) return;
          e.preventDefault();
          input.value = '';
          // 已存在则直接选中
          const exist = allTags.find((t) => t.name === val);
          if (exist) {
            if (!selected.has(exist.id)) {
              selected.add(exist.id);
              save();
            }
          } else {
            try {
              const created = await window.jpage.createTag(val);
              allTags.push(created);
              selected.add(created.id);
              save();
            } catch (err) {
              JP.showError(err);
            }
          }
          paint();
        }
      };
      container.appendChild(input);
    }

    async function save() {
      try {
        await window.jpage.setFileTags(detail.id, Array.from(selected));
        JP.toast('✓ 标签已更新');
      } catch (err) {
        JP.showError(err);
        console.error('[打标签失败]', 'fileId:', detail.id, 'uploaded_by:', detail.uploaded_by, 'err:', err);
      }
    }

    paint();
  }

  // ---- 分类下拉 ----
  function renderCategorySelect(mask, detail, allCategories) {
    const sel = mask.querySelector('#d-category');
    sel.innerHTML =
      '<option value="">（未分类）</option>' +
      allCategories
        .map(
          (c) =>
            `<option value="${c.id}" ${c.id === detail.category_id ? 'selected' : ''}>${JP.escapeHtml(
              c.name
            )} (${c.file_count || 0})</option>`
        )
        .join('');
    sel.onchange = async () => {
      try {
        await window.jpage.setFileCategory(detail.id, sel.value ? Number(sel.value) : null);
        JP.toast('✓ 分类已更新');
        document.dispatchEvent(new CustomEvent('jpage:refresh'));
      } catch (err) {
        JP.showError(err);
      }
    };
  }

  // ---- 版本历史 ----
  async function loadVersions(mask, detail) {
    const box = mask.querySelector('#d-versions');
    box.innerHTML = '<div class="loading"><span class="spinner"></span><div>加载中…</div></div>';
    try {
      const data = await window.jpage.listVersions(detail.id);
      const list = data.versions || [];
      if (!list.length) {
        box.innerHTML = '<div style="color:var(--text-mute);font-size:13px;padding:8px 0">暂无历史版本（仅当前版本）</div>';
        return;
      }
      box.innerHTML =
        '<div class="version-list">' +
        '<div class="version-item current"><div><strong>当前版本</strong></div><div>' +
        JP.formatSize(data.current.size) + ' · ' + JP.formatDate(data.current.updated_at) +
        '</div></div>' +
        list
          .map(
            (v) =>
              `<div class="version-item">
                 <div>v${v.version} · ${JP.formatSize(v.size)} · ${JP.formatDate(v.created_at)}</div>
                 <div style="display:flex;gap:6px">
                   <button class="btn btn-sm jp-restore" data-v="${v.version}">恢复</button>
                 </div>
               </div>`
          )
          .join('') +
        '</div>';
      box.querySelectorAll('.jp-restore').forEach((btn) => {
        btn.onclick = async () => {
          const v = btn.getAttribute('data-v');
          const ok = await JP.confirm({
            title: '恢复版本',
            message: `恢复到 v${v}？当前版本会自动备份到历史，不会丢失。`,
            confirmText: '恢复',
          });
          if (!ok) return;
          try {
            await window.jpage.restoreVersion(detail.id, v);
            JP.toast('✓ 已恢复到 v' + v);
            loadVersions(mask, detail);
            document.dispatchEvent(new CustomEvent('jpage:refresh'));
          } catch (err) {
            JP.showError(err);
          }
        };
      });
    } catch (err) {
      box.innerHTML = '<div style="color:var(--danger);font-size:13px">' + JP.escapeHtml(err.message) + '</div>';
    }
  }

  return { open };
})();
