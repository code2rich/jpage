// 命令间共享的输出辅助函数。
//
// 设计：命令模块只做「调 API + 格式化输出」，错误码由 bin/jpage.js 统一处理。
// 这里集中放格式化工具（人类可读的字节/时间、表格），避免命令文件互相重复。
//
// I/O 注入：out()/err() 默认写 process.stdout/stderr，但 run() 可通过 setIo()
// 注入自定义流（测试用），这样测试捕获输出时不必 monkeypatch process.stdout
// （那会破坏 node:test 自身的 TAP 输出）。

let _stdout = process.stdout;
let _stderr = process.stderr;

function setIo({ stdout, stderr } = {}) {
  if (stdout) _stdout = stdout;
  if (stderr) _stderr = stderr;
}

function resetIo() {
  _stdout = process.stdout;
  _stderr = process.stderr;
}

// 写一行到 stdout（自动补换行）。
function out(s) {
  _stdout.write(s);
}
// 写一行到 stderr。
function err(s) {
  _stderr.write(s);
}

// 字节 → 人类可读（B / KB / MB）。
function formatSize(bytes) {
  if (bytes == null) return '-';
  const n = Number(bytes);
  if (!isFinite(n)) return '-';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}

// ISO/SQLite 时间 → 简短显示。原样返回无法解析的输入。
function formatTime(t) {
  if (!t) return '-';
  return String(t).replace('T', ' ').replace(/\.\d+$/, '');
}

// 从文件元数据拼预览 URL：优先 /s/:key，无私有短链时返回 null。
function shareUrl(base, file) {
  if (!file || !file.share_key) return null;
  return `${base}/s/${file.share_key}`;
}

module.exports = { setIo, resetIo, out, err, formatSize, formatTime, shareUrl };
