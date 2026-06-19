// CLI 集成测试：通过注入 fetch shim，把 bin/ 的 HTTP 客户端接到 in-process 的 Express app。
//
// 不 spawn 子进程（项目既有测试都是 in-process 模式）。
// 关键：bin/client.js 用 fetch(url, init)，url 是完整 URL（http://host:port/api/...）。
// 这里写一个 fetchImpl，解析 url 的路径，转给 supertest 的 request(app)。
//
// 覆盖：upload（含 overwrite 分支）/ ls / cat / url / mv / rm / star+unstar / tags add+set+clear /
//       skills ls+get+download / whoami（有效 + 401）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('supertest');
const { createTestEnv } = require('../helpers/setup');
const { run } = require('../../bin/jpage');
const { resetIo } = require('../../bin/commands/_shared');

// fetch → supertest 桥。
// supertest 的 request(app) 返回可链式调用的 Test（支持 .send/.set/.buffer().parse()），
// 用 .then(res => makeResponse(res)) 包装成 Web Response（client.js 期望的形态）。
function makeFetchImpl(app, binaryPaths = []) {
  return async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const pathname = u.pathname + (u.search || '');
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};

    let req = request(app)[method.toLowerCase()](pathname);
    for (const [k, v] of Object.entries(headers)) {
      req = req.set(k, v);
    }
    // body 处理：JSON 字符串 / FormData / undefined
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        // JSON 字符串：supertest 用 .send(object) 才对；这里手动塞 body
        // supertest 会按 content-type 解析，这里直接传字符串 + 设 content-type
        req = req.set('content-type', 'application/json').send(init.body);
      } else if (init.body instanceof FormData) {
        // multipart：把 FormData 转成 supertest 的 .field / .attach
        req = await formDataToSupertest(req, init.body);
      }
    }
    const isBinary = binaryPaths.some((p) => pathname.startsWith(p));
    let res;
    if (isBinary) {
      res = await req.buffer(true).parse(binaryParser);
    } else {
      res = await req;
    }
    return makeResponse(res);
  };
}

// supertest 的 res（{status, headers, body, text}）→ Web Fetch Response 子集。
// client.js 用到：res.status、res.text()、res.arrayBuffer()。
function makeResponse(res) {
  const bodyText = res.text !== undefined ? res.text
    : (Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body || ''));
  const bodyBuf = Buffer.isBuffer(res.body) ? res.body
    : (res.text !== undefined ? Buffer.from(res.text) : Buffer.from(bodyText));
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: new Map(Object.entries(res.headers || {})),
    async text() { return bodyText; },
    async arrayBuffer() { return bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength); },
  };
}

function binaryParser(res, cb) {
  const data = [];
  res.on('data', (chunk) => data.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(data)));
}

// FormData → supertest：遍历 entries，文件（Blob）用 .attach，文本用 .field。
// supertest 的 .attach(field, buffer, filename) 和 .field(field, value)。
async function formDataToSupertest(req, formData) {
  for (const [key, value] of formData.entries()) {
    if (value instanceof Blob) {
      const buf = Buffer.from(await value.arrayBuffer());
      const filename = value.name || 'file';
      req = req.attach(key, buf, filename);
    } else {
      req = req.field(key, value);
    }
  }
  return req;
}

// 捕获 stdout/stderr/exitCode：通过注入内存 sink 流，不 monkeypatch process.stdout
// （那会破坏 node:test 自身的 TAP 输出）。run() 接受 { stdout, stderr, exit } 注入。
function makeSinks() {
  const outBuf = [];
  const errBuf = [];
  let exitCode = 0;
  return {
    stdout: { write: (chunk) => { outBuf.push(chunk); return true; } },
    stderr: { write: (chunk) => { errBuf.push(chunk); return true; } },
    exit: (code) => { exitCode = code; },
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
    code: () => exitCode,
  };
}

let env;
let agent;
let token;

test.before(async () => {
  env = createTestEnv();
  await env.ready();
  agent = request.agent(env.app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'testpassword123' });
  // 建一个 jp_ token 供 CLI 用
  const created = await agent.post('/api/tokens').send({ name: 'CLI Test' });
  token = created.body.token;
});

test.after(() => {
  resetIo();
  env.cleanup();
});

function ctx(sinks, extra = {}) {
  const fetchImpl = makeFetchImpl(env.app, ['/api/skills/', '/download']);
  return {
    fetchImpl,
    env: {},
    cwd: env.dataDir,
    stdout: sinks.stdout,
    stderr: sinks.stderr,
    exit: sinks.exit,
    ...extra,
  };
}

// --- upload ---
test('CLI upload: 上传 HTML 文件成功', async () => {
  const tmp = path.join(env.dataDir, 'report.html');
  fs.writeFileSync(tmp, '<h1>季度报告</h1>');
  const s = makeSinks();
  await run(['upload', tmp, '--public', '--token', token], ctx(s));
  assert.strictEqual(s.code(), 0, '不应非零退出');
  assert.match(s.out(), /上传成功/);
  assert.match(s.out(), /\/s\//);
});

test('CLI upload: 无文件参数 → UsageError 退出 2', async () => {
  const s = makeSinks();
  await run(['upload', '--token', token], ctx(s));
  assert.strictEqual(s.code(), 2);
  assert.match(s.err(), /用法/);
});

test('CLI upload: --overwrite 走覆盖端点', async () => {
  // 先上传一个
  const a = path.join(env.dataDir, 'ow.html');
  fs.writeFileSync(a, '<p>v1</p>');
  const s1 = makeSinks();
  await run(['upload', a, '--public', '--token', token], ctx(s1));
  const m = s1.out().match(/#(\d+)/);
  const id = m && m[1];
  assert.ok(id, '应拿到上传后的 id');

  // 覆盖（同名 → 自动版本备份）
  fs.writeFileSync(a, '<p>v2</p>');
  const s2 = makeSinks();
  await run(['upload', a, '--overwrite', id, '--token', token], ctx(s2));
  assert.strictEqual(s2.code(), 0);
  assert.match(s2.out(), /已更新|覆盖/);
});

// --- ls ---
test('CLI ls: 列出文件', async () => {
  const s = makeSinks();
  await run(['ls', '--token', token], ctx(s));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /#\d+/);
});

// 取一个文件 id 供后续命令用
let sharedId;
test('CLI ls: 取一个 id 备用', async () => {
  const s = makeSinks();
  await run(['ls', '--token', token], ctx(s));
  const m = s.out().match(/#(\d+)/);
  sharedId = m && m[1];
  assert.ok(sharedId);
});

// --- cat ---
test('CLI cat: 输出内容', async () => {
  const s = makeSinks();
  await run(['cat', sharedId, '--token', token], ctx(s));
  assert.strictEqual(s.code(), 0);
  assert.ok(s.out().length > 0);
});

// --- url ---
test('CLI url: 打印 /s/:key', async () => {
  const s = makeSinks();
  await run(['url', sharedId, '--token', token], ctx(s));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /\/s\//);
});

// --- star + unstar ---
test('CLI star/unstar', async () => {
  const s1 = makeSinks();
  await run(['star', sharedId, '--token', token], ctx(s1));
  assert.strictEqual(s1.code(), 0);
  assert.match(s1.out(), /收藏/);

  const s2 = makeSinks();
  await run(['unstar', sharedId, '--token', token], ctx(s2));
  assert.strictEqual(s2.code(), 0);
  assert.match(s2.out(), /取消收藏/);
});

// --- tags add/set/clear ---
test('CLI tags: add → set → clear', async () => {
  const add = makeSinks();
  await run(['tags', sharedId, 'add', '季度,财报', '--token', token], ctx(add));
  assert.strictEqual(add.code(), 0);
  assert.match(add.out(), /追加/);

  const set = makeSinks();
  await run(['tags', sharedId, 'set', 'only-one', '--token', token], ctx(set));
  assert.strictEqual(set.code(), 0);
  assert.match(set.out(), /设置/);

  // 验证现在只剩 only-one
  const list = makeSinks();
  await run(['tags', sharedId, '--token', token], ctx(list));
  assert.strictEqual(list.code(), 0);
  assert.match(list.out(), /only-one/);
  assert.doesNotMatch(list.out(), /季度/); // set 后旧标签没了

  const clr = makeSinks();
  await run(['tags', sharedId, 'clear', '--token', token], ctx(clr));
  assert.strictEqual(clr.code(), 0);
  assert.match(clr.out(), /清空/);
});

// --- skills ls/get/download ---
test('CLI skills: ls / get / download', async () => {
  const lsS = makeSinks();
  await run(['skills', 'ls', '--token', token], ctx(lsS));
  assert.strictEqual(lsS.code(), 0);
  assert.match(lsS.out(), /jpage-upload/);

  const getS = makeSinks();
  await run(['skills', 'get', 'jpage-upload', '--token', token], ctx(getS));
  assert.strictEqual(getS.code(), 0);
  assert.match(getS.out(), /jpage-upload/);

  // download：写到 env.dataDir，避免污染仓库
  const outFile = path.join(env.dataDir, 'skill.zip');
  const dlS = makeSinks();
  await run(['skills', 'download', 'jpage-upload', '--out', outFile, '--token', token], ctx(dlS));
  assert.strictEqual(dlS.code(), 0);
  assert.match(dlS.out(), /已下载/);
  assert.ok(fs.existsSync(outFile));
  const buf = fs.readFileSync(outFile);
  assert.strictEqual(buf[0], 0x50); // 'P' zip 魔数
});

// --- whoami ---
test('CLI whoami: 有效 token', async () => {
  const s = makeSinks();
  await run(['whoami', '--token', token], ctx(s));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /token 有效/);
});

test('CLI whoami: 无效 token → 退出 1', async () => {
  const s = makeSinks();
  await run(['whoami', '--token', 'jp_invalid_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'], ctx(s));
  assert.strictEqual(s.code(), 1);
  assert.match(s.err(), /无效|未设置|token/);
});

// --- 无 token ---
test('CLI: 未提供 token → 退出 2', async () => {
  const s = makeSinks();
  // cwd 用 /tmp，避免 loadEnvUp 向上遍历到项目根的 .env（含 MCP_TOKEN）
  await run(['ls'], ctx(s, { env: {}, cwd: os.tmpdir() }));
  assert.strictEqual(s.code(), 2);
  assert.match(s.err(), /token/);
});

// --- 未知命令 ---
test('CLI: 未知命令 → 退出 2', async () => {
  const s = makeSinks();
  await run(['bogus-cmd', '--token', token], ctx(s));
  assert.strictEqual(s.code(), 2);
  assert.match(s.err(), /未知命令/);
});

// --- help ---
test('CLI: --help 打印帮助', async () => {
  const s = makeSinks();
  await run(['--help'], ctx(s));
  assert.match(s.out(), /jpage —— 即页命令行/);
  assert.match(s.out(), /upload/);
});

// --- update ---
// update 纯本地操作（npm 自更新），不调后端 API，用注入的 npmExec 假执行器，
// 避免测试真的跑 npm。默认让 view 返回一个比当前版本更高的版本号。
function makeFakeNpmExec(calls, { latestVersion } = {}) {
  const current = require('../../package.json').version;
  const latest = latestVersion !== undefined ? latestVersion : bumpVersion(current);
  return (args) => {
    calls.push(args);
    if (args[0] === 'view') return latest + '\n';
    return ''; // install 不输出
  };
}

// 给 x.y.z 的 patch 位 +1，造一个"比当前新"的版本号（保证不等）。
function bumpVersion(v) {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

test('CLI update: 发现新版本 → 自动更新', async () => {
  const s = makeSinks();
  const calls = [];
  await run(['update'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls),
  }));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /发现新版本/);
  assert.match(s.out(), /已更新/);
  // 第二次调用是 install，应含 -g 和 @latest
  const installCall = calls.find((a) => a[0] === 'install');
  assert.ok(installCall, '应触发 npm install');
  assert.ok(installCall.includes('-g'), '应全局安装');
  assert.ok(installCall.includes('@code2rich/jpage@latest'), '应装 latest');
});

test('CLI update: --check 只查不更新', async () => {
  const s = makeSinks();
  const calls = [];
  await run(['update', '--check'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls),
  }));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /发现新版本/);
  assert.doesNotMatch(s.out(), /已更新/);
  // 只应有一次 view，不应有 install
  assert.ok(calls.find((a) => a[0] === 'view'), '应查版本');
  assert.ok(!calls.find((a) => a[0] === 'install'), '--check 不应触发 install');
});

test('CLI update: 已是最新版', async () => {
  const s = makeSinks();
  const calls = [];
  const current = require('../../package.json').version;
  await run(['update'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls, { latestVersion: current }),
  }));
  assert.strictEqual(s.code(), 0);
  assert.match(s.out(), /已是最新版/);
  assert.ok(!calls.find((a) => a[0] === 'install'), '无需 install');
});

test('CLI update: --registry 透传给 npm', async () => {
  const s = makeSinks();
  const calls = [];
  await run(['update', '--check', '--registry', 'https://registry.npmmirror.com'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls),
  }));
  const viewCall = calls.find((a) => a[0] === 'view');
  assert.ok(viewCall.includes('--registry'), 'view 应带 --registry');
  assert.ok(viewCall.includes('https://registry.npmmirror.com'), 'registry 值应透传');
});

test('CLI update: --registry 缺值 → UsageError 退出 2', async () => {
  const s = makeSinks();
  const calls = [];
  await run(['update', '--registry'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls),
  }));
  assert.strictEqual(s.code(), 2);
  assert.match(s.err(), /用法/);
});

test('CLI update: 不需要 token（无 token 也能跑）', async () => {
  const s = makeSinks();
  const calls = [];
  // 故意不传 token、cwd 指向 /tmp（排除 .env 的 MCP_TOKEN）
  await run(['update', '--check'], ctx(s, {
    env: {}, cwd: os.tmpdir(), npmExec: makeFakeNpmExec(calls),
  }));
  assert.strictEqual(s.code(), 0);
  assert.doesNotMatch(s.err(), /token/);
});
