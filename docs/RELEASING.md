# 发版指南

> 维护者文档。记录如何把 `@code2rich/jpage` 发布到 npm，以及 GitHub Actions 自动发版的配置与一次性设置。

## TL;DR

```bash
npm version patch          # 1.5.0 → 1.5.1（自动改 package.json + commit + 打 tag）
git push origin main       # 推 commit
git push origin v1.5.1     # 推 tag → 触发 GitHub Actions 自动发布
```

打完 tag 等 Actions 跑完（2-3 分钟），`npm view @code2rich/jpage version` 确认。

---

## 前置（一次性配置）

### 1. 生成 npm granular access token

专为 CI 用的 token，不要复用你本地的或之前的。

1. 访问 `https://www.npmjs.com/settings/code2richnpm/tokens/granular-access-tokens/new`
2. 按以下填：
   - **Name**: `jpage-ci-publish`（或任意易识别的名字）
   - **Expiration**: 建议 90 天（到期前轮换）
   - **Packages and scopes**: `Only select packages and scopes` → 勾 `@code2rich`
     - 包已存在时可选精确到 `@code2rich/jpage`，权限更小更安全
   - **Permissions**: `Read and write`
3. 生成后复制 `npm_xxxx...`（**只显示一次**）

> granular token 在生成时已勾选 bypass 2FA，CI 发布无需 OTP。

### 2. 把 token 存进 GitHub Secrets

1. 访问 `https://github.com/code2rich/jpage/settings/secrets/actions`
2. **New repository secret**
   - Name: `NPM_TOKEN`
   - Value: 上一步复制的 token
3. Add secret

token 从此只存在 GitHub Secrets，不出现在本地终端、代码、`.npmrc`。

### 3.（强烈建议）给 npm 账号开 2FA

访问 `https://www.npmjs.com/settings/code2richnpm/account/security` → 选 `auth-and-writes`。

- 2FA 保护**账号登录态**（防账号被盗后乱改设置）
- granular token 的 bypass 2FA 只针对**发布动作**，两者互补不冲突

---

## 发版流程

### 常规发版（推荐：自动 CI）

```bash
# 1. 确认在 main 分支且工作区干净
git checkout main
git status

# 2. 升版本号（npm version 会自动改 package.json + commit + 打 tag）
npm version patch    # 1.5.0 → 1.5.1  修 bug
# npm version minor  # 1.5.0 → 1.6.0  新功能
# npm version major  # 1.5.0 → 2.0.0  破坏性变更

# 3. 推送 commit 和 tag
git push origin main
git push origin v1.5.1

# 4. 等 GitHub Actions 跑完
#    进度：https://github.com/code2rich/jpage/actions
#    成功后验证：
npm view @code2rich/jpage version
```

**CI 会做什么**（见 `.github/workflows/release.yml`）：

1. checkout 代码
2. `npm ci`（用 lockfile 锁定的依赖）
3. lint + test（全绿才继续）
4. build 前端产物
5. **校验 tag 名 == package.json version**（防手滑：tag 标 v1.6.0 但 package.json 还写 1.5.0 会失败）
6. `npm publish`（用 `NPM_TOKEN` 鉴权）
7. 在 Actions Summary 写发布结果

### 手动发版（应急，CI 挂了时用）

```bash
# 1. 确认版本号已改、commit 已推
npm version patch
git push origin main
git push origin v1.5.1

# 2. 本地登录（首次需要）
npm login

# 3. 发布（账号开了 2FA 时需要 --otp）
npm publish --otp=<authenticator 当前的 6 位>

# 4. 验证
npm view @code2rich/jpage version
```

> 手动发版后建议补打 tag（如果 `npm version` 已打就不用），保持「每个 npm 版本对应一个 git tag」。

---

## 版本号约定（语义化版本）

| 改动类型 | 命令 | 例子 | 含义 |
|---|---|---|---|
| 修 bug、小优化 | `npm version patch` | 1.5.0 → 1.5.1 | 向后兼容的修复 |
| 新功能 | `npm version minor` | 1.5.0 → 1.6.0 | 向后兼容的新能力 |
| 破坏性变更 | `npm version major` | 1.5.0 → 2.0.0 | 不兼容旧版的改动 |

> 重大变更应同步更新 `CHANGELOG`（如果有）或在 GitHub Release 写说明。

---

## 预发版（可选，beta/rc）

npm 支持预发布版本号，如 `1.6.0-beta.1`：

```bash
npm version prerelease --preid=beta   # 1.5.0 → 1.6.0-beta.0
git push origin main
git push origin v1.6.0-beta.0

# 用户安装 beta：npm install -g @code2rich/jpage@beta
# 正式版：npm install -g @code2rich/jpage@latest（默认）
```

预发版默认不进 `latest` tag，用户不主动指定 `@beta` 不会装到。

---

## 回滚 / 撤回

**npm 版本一旦发布，版本号永久占用，无法删除**（只能 deprecate）。

### 标记弃用（deprecate）

```bash
# 弃用某个版本（用户安装时会看到警告）
npm deprecate @code2rich/jpage@1.5.1 "有严重 bug，请用 1.5.2"
```

### 发布修复版本

发一个新版本（如 `1.5.2`）修正问题，然后 deprecate 坏版本。**不要试图覆盖已发布的版本号**——npm 不允许重复发布同一版本。

### 完全撤下包（72 小时内）

```bash
# 包发布 72 小时内可 unpublish 整个包（慎用，会破坏所有依赖者）
# npm unpublish @code2rich/jpage --force
```

> 超过 72 小时无法 unpublish。一般用 deprecate + 发新版本代替。

---

## 故障排查

### CI 发版失败

| 错误 | 原因 | 处理 |
|---|---|---|
| `403 Forbidden - Two-factor authentication required` | `NPM_TOKEN` 是 session token 不是 granular token | 重新生成 granular token（bypass 2FA），更新 GitHub Secret |
| `403 Forbidden - You do not have permission` | token 权限不含 `@code2rich` scope | 重新生成 token，Packages 勾 `@code2rich` |
| `EPUBLISHCONFLICT - You cannot publish over` | 该版本号已发布过 | 升版本号再发，npm 不允许覆盖 |
| `tag (x) 与 package.json version (y) 不一致` | tag 名和 package.json 对不上 | 确保 `npm version` 自动打 tag，或手动对齐 |
| lint/test/build 失败 | 代码有问题 | 看 Actions 日志修，修完不用重打 tag（直接 push commit 到 main，tag 已存在不会重跑——需删 tag 重打） |

**删 tag 重跑**（修完代码后）：

```bash
git tag -d v1.5.1                  # 删本地
git push origin :refs/tags/v1.5.1  # 删远程
# 重新打 tag（指向最新 commit）
git tag v1.5.1
git push origin v1.5.1
```

### `NPM_TOKEN` 过期 / 轮换

1. npm 网站生成新 granular token
2. 更新 GitHub Secret：`https://github.com/code2rich/jpage/settings/secrets/actions` → `NPM_TOKEN` → Update
3. 下次发版自动用新 token

---

## 安全清单（每次发版前后自查）

- [ ] 没有把 npm token / `.npmrc` 含明文 token 的文件 commit 到仓库
- [ ] `.gitignore` 含 `.npmrc`（防误提交）
- [ ] CI 的 `NPM_TOKEN` 是 granular token（最小权限），不是账号 session token
- [ ] npm 账号开了 2FA（`auth-and-writes`）
- [ ] 过期的 token 已在 npm 网站撤销

---

## 相关文件

- `.github/workflows/release.yml` — 自动发版 workflow（tag 触发）
- `.github/workflows/ci.yml` — CI 测试 workflow（push/PR 触发）
- `package.json` 的 `publishConfig.access: "public"` — scoped 包公开发布（必须）
- `package.json` 的 `bin`、`engines`、`version` — 发布元信息
