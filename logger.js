const JSONLogger = {
  _output(level, obj) {
    const entry = { level, timestamp: new Date().toISOString(), ...obj };
    const line = JSON.stringify(entry);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  },
  info(obj) { this._output('info', obj); },
  warn(obj) { this._output('warn', obj); },
  error(obj) { this._output('error', obj); },
  audit(action, details = {}) {
    this._output('info', { type: 'audit', action, ...details });
  },
};

module.exports = JSONLogger;
