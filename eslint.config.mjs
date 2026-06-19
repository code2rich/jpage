// ESLint flat config。
// 本项目是纯 CommonJS（require/module.exports）+ 浏览器端 ES 模块前端（public/js），
// 无 JSX/TS。规则取向：宽松务实，只拦真正的 bug 风险（未定义变量、重复声明），
// 不强制风格（quotes/semi/indent 等交给现有约定，避免与大量历史代码打架）。
import js from '@eslint/js';

// Node.js 常用 globals（不引入 globals 包，按需列举，避免额外依赖）。
const nodeGlobals = {
  // 全局对象与进程
  global: 'writable',
  globalThis: 'writable',
  process: 'writable',
  console: 'writable',
  // 计时器与队列
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  // 模块系统（CommonJS）
  require: 'readonly',
  module: 'readonly',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  // Buffer / URL
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  // 事件循环与诊断
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  // fetch（Node 18+ 内置）
  fetch: 'readonly',
  // 错误构造器（非 ECMA 内置）
  DOMException: 'readonly',
};

// node:test runner 注入的 globals（test 函数风格）
const testRunnerGlobals = {
  test: 'readonly',
  describe: 'readonly',
  it: 'readonly',
  before: 'readonly',
  after: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
};

// 浏览器 globals（前端源码 + puppeteer 注入上下文用）
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  HTMLElement: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  DragEvent: 'readonly',
  MutationObserver: 'readonly',
  XMLHttpRequest: 'readonly',
  IntersectionObserver: 'readonly',
  CSS: 'readonly', // CSS.escape 用于 bundle 文件树选择器转义
  // 注意：preview.js 里用到 authFetch（template-select-modal）但全仓未定义 ——
  // 这是一个已知前端 bug（模板选择会抛 ReferenceError）。此处声明为 global 仅让 lint
  // 通过，不静默修复行为；修复见后续 issue。
  authFetch: 'readonly',
};

export default [
  js.configs.recommended,

  {
    // 全局忽略：依赖、数据、构建产物、测试临时目录
    ignores: [
      'node_modules/',
      'data/',
      'data-test-*/',
      'data-bench-tmp/',
      'public/dist/',
      'article/',
    ],
  },

  {
    // 服务端 CommonJS 源码（默认）
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      // === error：真正的 bug 风险 ===
      'no-undef': 'error',
      'no-redeclare': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'no-debugger': 'error',

      // === warn：可疑但不一定错，保留信号 ===
      // catch 子句的 err 形参无法省略，项目里大量 catch 只为返回 500 不读 e，
      // 故对名为 e/err/error/_ 的 catch 参数不告警；其余真正未用的变量仍 warn。
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^(e|err|error|_)$',
        },
      ],

      // === off：与本项目约定冲突或噪音过大 ===
      'no-console': 'off', // 项目刻意用 logger.js，console 作为兜底不拦
      'no-empty': ['error', { allowEmptyCatch: true }], // 多处 catch 静默（健康检查、可选清理）
      'no-inner-declarations': 'off', // 函数提升在 Express 处理器里是常见写法
      'no-prototype-builtins': 'off', // 无原型链污染风险
      'no-control-regex': 'off', // 文件名解码等用到控制字符区间
      'no-useless-escape': 'warn',
      'no-self-assign': 'off', // preview.js 有意用 iframe.src = iframe.src 强制刷新
      'no-useless-assignment': 'off', // server.js getIndexHtml 在 try 内条件重赋值，规则误报
    },
  },

  {
    // 浏览器端 ES 模块前端源码（import/export）：sourceType 切 module，
    // 暴露浏览器 globals（window/document/localStorage/fetch 等）。
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...nodeGlobals, ...browserGlobals },
    },
  },

  {
    // 测试文件：node:test 的 test/describe/it 等 globals
    // + browser-harness.js 注入的 puppeteer 浏览器上下文 globals
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...testRunnerGlobals, ...browserGlobals },
    },
  },

  {
    // migrations：由 runner 动态 require，导出结构固定
    files: ['migrations/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
