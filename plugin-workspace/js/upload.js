// 即页 uTools 插件 · 上传模块（弹窗：本地文件 / 粘贴文本）

window.Upload = (function () {
  function openFilePicker() {
    const result = window.jpage.selectFile('选择要上传到即页的文件');
    if (result && result[0]) {
      openModal('file', result[0]);
    }
  }

  function openTextEditor(prefillName, prefillContent) {
    openModal('text', null, prefillName, prefillContent);
  }

  // 拖拽单文件进入：直接弹上传确认框
  function openWithFile(filePath) {
    if (!filePath) return;
    openModal('file', filePath);
  }

  // 拖拽多文件进入：确认后批量依次上传
  function openBatch(filePaths) {
    if (!filePaths || !filePaths.length) return;
    const names = filePaths.map((p) => p.split(/[\\/]/).pop()).join('、');
    JP.modal({
      title: '批量上传到即页',
      bodyHtml: `
        <p style="font-size:14px;line-height:1.7;margin-bottom:14px">
          将上传 <strong>${filePaths.length}</strong> 个文件：
        </p>
        <div style="background:var(--bg-hover);padding:12px;border-radius:6px;font-size:13px;color:var(--text-soft);max-height:160px;overflow:auto;margin-bottom:16px;word-break:break-all">
          ${JP.escapeHtml(names)}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input id="up-public" type="checkbox" checked />
          <label for="up-public" style="font-size:13px;color:var(--text-soft)">公开（任何人可通过链接访问）</label>
        </div>`,
      footerHtml: `
        <button class="btn jp-close">取消</button>
        <button class="btn btn-primary jp-submit">开始上传</button>`,
      onMount: (mask, close) => {
        const submitBtn = mask.querySelector('.jp-submit');
        submitBtn.onclick = async () => {
          const isPublic = mask.querySelector('#up-public').checked;
          submitBtn.disabled = true;
          const ok = [];
          const fail = [];
          for (let i = 0; i < filePaths.length; i++) {
            submitBtn.textContent = `上传中 ${i + 1}/${filePaths.length}…`;
            try {
              const result = await window.jpage.uploadFile({ filePath: filePaths[i], isPublic });
              ok.push(result);
            } catch (err) {
              fail.push({ name: filePaths[i].split(/[\\/]/).pop(), error: err.message });
            }
          }
          close();
          JP.toast(`✅ 上传完成：成功 ${ok.length} 个${fail.length ? '，失败 ' + fail.length + ' 个' : ''}`);
          if (fail.length) {
            JP.modal({
              title: '部分文件上传失败',
              bodyHtml:
                '<div style="font-size:13px;line-height:1.8">' +
                fail.map((f) => `<div>${JP.escapeHtml(f.name)}：<span style="color:var(--danger)">${JP.escapeHtml(f.error)}</span></div>`).join('') +
                '</div>',
            });
          } else if (ok.length === 1) {
            // 单个成功直接问是否预览
            const shareUrl = window.jpage.getShareUrl(ok[0].share_key);
            const open = await JP.confirm({
              title: '上传成功',
              message: `文件「${ok[0].original_name}」已上传。\n\n分享链接：${shareUrl}`,
              confirmText: '打开预览',
            });
            if (open) window.jpage.openExternal(shareUrl);
          }
          document.dispatchEvent(new CustomEvent('jpage:refresh'));
        };
      },
    });
  }

  function openModal(mode, filePath, prefillName, prefillContent) {
    const isText = mode === 'text';
    const fileLine =
      filePath && !isText
        ? `<div class="detail-grid" style="margin-bottom:16px">
             <div class="label">已选文件</div>
             <div class="value">${JP.escapeHtml(filePath)}</div>
           </div>`
        : '';

    const textForm = isText
      ? `
        <div style="margin-bottom:16px">
          <label class="field-label">文件名</label>
          <input id="up-name" class="input" value="${JP.escapeHtml(
        prefillName || ''
      )}" placeholder="my-note.md" />
        </div>
        <div style="margin-bottom:16px">
          <label class="field-label">内容（HTML 或 Markdown）</label>
          <textarea id="up-content" class="textarea" style="min-height:240px" placeholder="在此粘贴 HTML / Markdown 内容…">${JP.escapeHtml(
        prefillContent || ''
      )}</textarea>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input id="up-public" type="checkbox" checked />
          <label for="up-public" style="font-size:13px;color:var(--text-soft)">公开（任何人可通过链接访问）</label>
        </div>`
      : '';

    const fileForm = !isText
      ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <input id="up-public" type="checkbox" checked />
          <label for="up-public" style="font-size:13px;color:var(--text-soft)">公开（任何人可通过链接访问）</label>
        </div>`
      : '';

    JP.modal({
      title: isText ? '新建文本文件' : '上传文件到即页',
      bodyHtml: fileLine + textForm + fileForm,
      footerHtml: `
        <button class="btn jp-close">取消</button>
        <button class="btn btn-primary jp-submit">
          ${isText ? '上传文本' : '上传文件'}
        </button>`,
      onMount: (mask, close) => {
        const submitBtn = mask.querySelector('.jp-submit');
        submitBtn.onclick = async () => {
          const isPublic = mask.querySelector('#up-public').checked;
          submitBtn.disabled = true;
          submitBtn.textContent = '上传中…';
          try {
            let result;
            if (isText) {
              const name = mask.querySelector('#up-name').value.trim();
              const content = mask.querySelector('#up-content').value;
              if (!name) throw new Error('请填写文件名');
              if (!content.trim()) throw new Error('内容不能为空');
              if (!/\.(html?|md|markdown)$/i.test(name)) {
                throw new Error('文件名需以 .html / .htm / .md / .markdown 结尾');
              }
              result = await window.jpage.uploadText({ name, content, isPublic });
            } else {
              if (!filePath) throw new Error('未选择文件');
              result = await window.jpage.uploadFile({ filePath, isPublic });
            }
            const shareUrl = window.jpage.getShareUrl(result.share_key);
            const isOverwrite = result.overwritten === true;
            JP.toast(
              isOverwrite
                ? '✅ 已覆盖更新（v' + result.version + '）'
                : '✅ 上传成功（新建）'
            );
            // 新建但服务器已存在同名（忽略大小写）→ 文件名有差异，提示用户
            if (!isOverwrite) {
              try {
                const lower = result.original_name.toLowerCase();
                const list = await window.jpage.listFiles({ limit: 200 });
                const dup = (list.files || []).find(
                  (f) => f.id !== result.id && f.original_name.toLowerCase() === lower
                );
                if (dup) {
                  JP.toast(
                    '⚠ 发现同名文件「' + dup.original_name + '」(id:' + dup.id +
                    ')，文件名可能大小写/空格不同，未覆盖',
                    5000
                  );
                }
              } catch {}
            }
            close();
            // 询问是否打开预览
            const open = await JP.confirm({
              title: '上传成功',
              message: `文件「${result.original_name}」已上传。\n是否立即在浏览器打开预览？\n\n分享链接：${shareUrl}`,
              confirmText: '打开预览',
            });
            if (open) window.jpage.openExternal(shareUrl);
            // 刷新列表
            document.dispatchEvent(new CustomEvent('jpage:refresh'));
          } catch (err) {
            JP.showError(err);
            submitBtn.disabled = false;
            submitBtn.textContent = isText ? '上传文本' : '上传文件';
          }
        };
      },
    });
  }

  return { openFilePicker, openTextEditor, openModal, openWithFile, openBatch };
})();
