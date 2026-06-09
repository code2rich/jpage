// 弹窗系统：confirm / prompt / alert 对话框

const dialogModal = {
  el: null, input: null, error: null, msg: null, field: null,
  confirmBtn: null, cancelBtn: null, closeBtn: null,
  _resolve: null, _mode: null, _validate: null, _escHandler: null,

  init() {
    this.el = document.getElementById('dialog-modal');
    this.input = document.getElementById('dialog-modal-input');
    this.error = document.getElementById('dialog-modal-error');
    this.msg = document.getElementById('dialog-modal-message');
    this.field = document.getElementById('dialog-modal-field');
    this.confirmBtn = document.getElementById('dialog-modal-confirm');
    this.cancelBtn = document.getElementById('dialog-modal-cancel');
    this.closeBtn = document.getElementById('dialog-modal-close');
    this.titleEl = document.getElementById('dialog-modal-title');
    this.labelEl = document.getElementById('dialog-modal-label');

    this.closeBtn.addEventListener('click', () => this._dismiss());
    this.cancelBtn.addEventListener('click', () => this._dismiss());
    this.el.addEventListener('click', e => { if (e.target === this.el) this._dismiss(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._accept();
      if (e.key === 'Escape') this._dismiss();
    });
    this.input.addEventListener('input', () => { this.error.hidden = true; });
    this.confirmBtn.addEventListener('click', () => this._accept());
  },

  _open(mode, opts) {
    this._mode = mode;
    this._resolve = null;
    this._validate = opts.validate || null;
    this.error.hidden = true;

    this.titleEl.textContent = opts.title || '';
    this.msg.innerHTML = opts.message || '';
    this.msg.hidden = !opts.message;

    if (mode === 'prompt') {
      this.field.hidden = false;
      this.labelEl.textContent = opts.label || '';
      this.input.value = opts.value || '';
      this.input.placeholder = opts.placeholder || '';
    } else {
      this.field.hidden = true;
    }

    this.confirmBtn.textContent = opts.confirmText || '确认';
    this.confirmBtn.className = opts.danger ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
    this.confirmBtn.disabled = false;
    this.cancelBtn.hidden = mode === 'alert';
    this.cancelBtn.textContent = opts.cancelText || '取消';

    this.el.hidden = false;
    this.el.setAttribute('aria-hidden', 'false');

    if (mode === 'prompt') {
      this.input.focus();
      this.input.select();
    } else {
      this.confirmBtn.focus();
    }

    this._escHandler = e => { if (e.key === 'Escape') this._dismiss(); };
    document.addEventListener('keydown', this._escHandler);

    return new Promise(resolve => { this._resolve = resolve; });
  },

  _accept() {
    if (this._mode === 'prompt') {
      const val = this.input.value.trim();
      if (this._validate) {
        const err = this._validate(val);
        if (err) { this.error.textContent = err; this.error.hidden = false; return; }
      }
      this._close(val);
    } else {
      this._close(true);
    }
  },

  _dismiss() {
    this._close(this._mode === 'prompt' ? null : false);
  },

  _close(result) {
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(result);
  },

  confirm(opts) { return this._open('confirm', opts); },
  prompt(opts)  { return this._open('prompt', opts);  },
  alert(opts)   { return this._open('alert', opts);   },
};

export { dialogModal };
