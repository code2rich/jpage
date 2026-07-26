# jpage

> Drop a file, get a page — instantly.

[![CI](https://github.com/code2rich/jpage/actions/workflows/ci.yml/badge.svg)](https://github.com/code2rich/jpage/actions/workflows/ci.yml)

[中文](README.md) | English

**jpage** is a zero-config HTML / Markdown instant preview and sharing tool. Drop in a document and instantly get a clean online page — no deployment pipeline, no server knowledge required. Especially great for one-click sharing of AI-generated content.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Auth & Security](#auth--security)
- [Project Structure](#project-structure)
- [REST API](#rest-api)
- [MCP / AI Integration](#mcp--ai-integration)
- [Use Cases](#use-cases)
- [Why jpage](#why-jpage)
- [License](#license)

---

## Features

### Core

- **Instant Preview** — Upload HTML or Markdown files and get a rendered online page in seconds.
- **Enhanced Markdown Rendering** — Syntax highlighting (highlight.js), math formulas (KaTeX), Mermaid diagrams, with automatic dark/light theme switching.
- **Source View** — Toggle between rendered and source modes for easy comparison.
- **Short Links** — Each file gets an auto-generated 8-character short link (`/s/xxxxxxxx`).
- **File Management** — Rename, delete, download, and toggle public/private with a simple UI.
- **Drag & Drop Upload** — Click or drag to upload, up to 50MB per file.
- **Version History** — Overwrite uploads automatically preserve previous versions; rollback anytime.
- **Responsive Design** — Adapts to desktop and mobile; dark mode follows system preference.

### Organization & Discovery

- **Tags** — Tag files for multi-dimensional categorization and search.
- **Categories** — Organize files into categories for a clear hierarchy.
- **Favorites** — One-click bookmark for quick access to frequently used files.

### Security & Permissions

- **Multi-user Support** — Admin can create and manage multiple users; regular users can only access their own files and public files.
- **Open Registration** — Enable self-service registration via `ALLOW_REGISTRATION=true`, with optional SMTP email verification.
- **Session Auth** — Cookie + bcrypt password hashing.
- **API Tokens** — Each user can create multiple API tokens for scripts and AI tools.
- **Public/Private Files** — Toggle visibility on upload; private files are only accessible to the owner and admin.
- **Rate Limiting** — Login and upload endpoints are rate-limited to prevent brute force and abuse.

### AI Integration

- **MCP Protocol** — Built-in MCP Streamable HTTP endpoint for direct AI tool integration.
- **Skills Management** — Auto-discovers Claude Code / Desktop skill packs in the `skills/` directory.
- **JSON Upload API** — `/api/files/upload-json` for programmatic uploads, ideal for AI workflows.
- **Content Template Marketplace** — Browse, learn from, and instantiate reusable HTML/Markdown templates.

### Deployment

- **Zero-Dependency Runtime** — Single container startup with built-in SQLite storage.
- **Docker One-Click Deploy** — Multi-stage build, env var configuration, volume persistence.
- **Database Migrations** — Automatic schema migration on startup; no manual upgrades needed.
- **Scheduled Backups** — Optional cron-based automated backups with configurable retention.

---

## Tech Stack

- **Backend**: Node.js + Express + express-session (SQLite session store), domain-split Router architecture (`routes/` + `lib/` shared layer).
- **Database**: SQLite3 (zero-config, auto-migration, WAL mode).
- **Frontend**: Vanilla JavaScript (no framework dependencies), ES modules.
- **Rendering**: marked.js + highlight.js + KaTeX + Mermaid.
- **Security**: helmet + layered CSP (strict policy for admin UI, iframe sandbox isolation + content-tiered CSP for render pages).
- **Protocol**: MCP Streamable HTTP (@modelcontextprotocol/sdk).
- **Testing**: node:test + supertest (unit + integration), GitHub Actions CI.
- **Container**: Docker / Docker Compose.

---

## Quick Start

### Docker Deploy (Recommended)

```bash
git clone https://github.com/code2rich/jpage.git
cd jpage
cp .env.example .env       # Edit .env with ADMIN_PASSWORD and SESSION_SECRET
docker-compose up -d
```

Visit http://localhost:8858 — you'll be redirected to the login page.

### Local Development

```bash
npm install
ADMIN_USER=admin ADMIN_PASSWORD=test1234 SESSION_SECRET=dev-secret npm start
```

Development mode (hot reload):

```bash
npm run dev
```

### Development & Testing

```bash
npm test            # Unit + integration tests (node:test + supertest)
npm run test:unit   # Unit tests only
npm run build       # Build frontend bundle (esbuild → public/dist)
```

End-to-end / benchmarks (start the server first with `npm start`):

```bash
node test/perf-harness.js 8858   # Core e2e (login/upload/render/short-link/tags)
node test/mcp-harness.js 8858    # MCP endpoint
node test/perf-bench.js 8858     # Render/list/cache latency benchmarks
```

### CLI Tool (Published on npm)

jpage ships with a `jpage` CLI for uploading, listing, and managing files via the REST API. For large files and ZIPs it uses multipart binary streaming, which is faster and cheaper than MCP's base64-in-token flow:

```bash
npm install -g @code2rich/jpage
jpage upload ./report.html --public --token <your-token>
jpage ls --kw quarterly
jpage cat 8
jpage --help
```

`jpage` and MCP are symmetric client entry points over the same REST API. See `jpage --help` for details.

Update to the latest version (no token required):

```bash
jpage update                  # Self-update to the latest version
jpage update --check          # Check for updates only
jpage update --registry https://registry.npmmirror.com   # Mirror registry
```

### Release Process

Maintainer release guide (GitHub Actions automated release, token rotation, troubleshooting) see [`docs/RELEASING.md`](docs/RELEASING.md).

---

## Auth & Security

jpage supports a multi-user system. The admin manages all users and files; regular users can only access their own files and public files.

Share links (`/api/files/:id/render`, `/s/:key`, download, source) are anonymously accessible when the file is marked public. Uncheck **Public access** on upload to make the file visible only to the owner and admin.

**Content Security (CSP)**: Hardened via helmet + layered policies — the admin UI gets a strict CSP (same-origin scripts only); user-content render pages are isolated by iframe sandbox (without `allow-same-origin`, blocking access to the parent window). Markdown pages use a strict CSP (inline mermaid init script whitelisted via nonce), while HTML pages use a relaxed CSP + sandbox fallback because user HTML often contains legitimate scripts.

### Authentication Methods

API and MCP endpoints support three authentication methods:

1. **Session Cookie** — `jpage.sid` cookie after login, for browser access.
2. **API Token** — User-created `jp_` prefixed tokens, for script and AI integration.
3. **MCP Token** — `MCP_TOKEN` environment variable, for AI tool connections (backward compatible).

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | No | Admin username for first startup when the users table is empty; defaults to `admin`. |
| `ADMIN_PASSWORD` | No | Admin password for first startup (≥8 chars); if empty, a random 16-char password is generated and printed to startup logs. |
| `SESSION_SECRET` | Production | Encrypts session cookies; in dev mode a temporary key is auto-generated (lost on restart). Missing in production refuses startup. |
| `NODE_ENV` | No | When `production`, cookies are sent only over HTTPS. |
| `PORT` | No | Default `8858`. |
| `MCP_TOKEN` | No | Global Bearer token for the `/mcp` endpoint (backward compatible); when unset, `/mcp` is still accessible via a user-level API token (`jp_` prefix). |
| `ALLOW_REGISTRATION` | No | Set to `true` to enable self-service registration; defaults to off (admin-only user creation). |
| `SMTP_HOST` | No | SMTP server address (e.g. `smtp.qq.com`); enables email verification when configured. |
| `SMTP_PORT` | No | SMTP port (e.g. `465`). |
| `SMTP_SECURE` | No | Use SSL (`true`/`false`). |
| `SMTP_USER` | No | SMTP login username. |
| `SMTP_PASS` | No | SMTP login password or authorization code. |
| `SMTP_FROM` | No | Sender address (e.g. `"jpage <user@example.com>"`). |
| `APP_URL` | No | External app URL used to build verification links (e.g. `https://jpage.cn`). |
| `GOOGLE_CLIENT_ID` | No | Google Web application OAuth Client ID; enables Google sign-in together with `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_SECRET` | No | Google Web application OAuth Client Secret; keep it only in the server-side environment. |
| `GOOGLE_HTTP_TIMEOUT_MS` | No | Timeout for Google token and OIDC certificate requests, clamped to 1000-60000 ms; defaults to 10000. |
| `GOOGLE_HTTPS_PROXY` | No | Trusted HTTP CONNECT proxy used only for Google OAuth egress; supports `http://` or `https://`. |
| `JPAGE_DATA_DIR` | No | Data directory, defaults to `./data`. |
| `COOKIE_SECURE` | No | When `true`, cookies are sent only over HTTPS (recommended for production). |
| `MCP_IP` | No | Hostname shown in MCP endpoint logs, defaults to `localhost`. |
| `MCP_PROTOCOL` | No | MCP endpoint protocol, defaults to `http`. |
| `TOKEN_ENCRYPTION_KEY` | No | API token encryption key (hex 32 bytes); if unset, a `token-key.key` is auto-generated in the data directory. |
| `MAX_FILE_VERSIONS` | No | Maximum number of versions kept per file, defaults to `20`. |
| `BACKUP_CRON` | No | Automatic backup cron expression (e.g. `0 3 * * *`). |
| `BACKUP_DIR` | No | Automatic backup directory, defaults to `<JPAGE_DATA_DIR>/backups`. |

If both `ADMIN_USER` and `ADMIN_PASSWORD` are left empty, the startup log will output:

```
[jpage] Created initial admin: admin
[jpage] Initial password (save this): 7Hk2mN9pq4rTv8wX
[jpage] ⚠️  Please change the password after first login
```

Copy the password from the log to log in.

Recommended `SESSION_SECRET` generation:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Reset or Change Password

All users can change their password in Settings after login. Admin can reset other users' passwords in User Management.

Manual method (SQLite command line):

```bash
node -e "console.log(require('bcryptjs').hashSync('new-password', 10))"
sqlite3 data/database.sqlite "UPDATE users SET password_hash='<hash-from-above>' WHERE username='admin';"
```

---

## Project Structure

```
jpage/
├── server.js           # Entry: app assembly + middleware + startup orchestration (logic split out)
├── routes/             # Domain-split Express Routers
│   ├── auth.js         # Login/register/email verification
│   ├── users.js        # User management (admin)
│   ├── tokens.js       # API tokens
│   ├── files/          # File CRUD/upload/render/versions/tags/star/stats
│   ├── tags.js         # Tags
│   ├── categories.js   # Categories + template metadata
│   ├── content-templates.js  # Content template marketplace
│   ├── admin.js        # Backup export/import/stats
│   └── skills.js       # Skills + MCP config
├── lib/                # Shared layer (reused by routes)
│   ├── db.js           # SQLite access (dbRun/dbGet/dbAll + PRAGMA)
│   ├── paths.js        # Data/upload dir constants
│   ├── util.js         # now/shareKey/clientIp/decodeFilename pure helpers
│   ├── csp.js          # Layered CSP policies + nonce
│   ├── auth-state.js   # Shared adminUserId state
│   ├── templates.js    # Template system + marked/hljs/KaTeX pipeline
│   ├── render.js       # File → HTML rendering (with CSP headers)
│   ├── render-cache.js # Render result LRU cache
│   ├── fts.js          # FTS5 full-text index
│   ├── categories.js   # Category name in-memory cache
│   ├── view-counts.js  # Buffered view-count batched flush
│   ├── zip.js          # ZIP upload (security validation/extraction/classification)
│   ├── dispatch.js     # MCP in-process request dispatch (bypass TCP self-call)
│   ├── crypto.js       # API token plaintext AES-256-GCM encryption
│   ├── usage.js        # User storage quota maintenance
│   └── middleware/     # Auth + file-loading + usage middleware
├── logger.js           # Structured JSON Lines logger
├── mailer.js           # SMTP mail (verification codes/links)
├── mcp-server.js       # MCP Streamable HTTP endpoint (/mcp)
├── migrations.js       # Database migration runner
├── migrations/         # Sequential schema migrations (001-022)
├── skills-registry.js  # Scans skills/ dir, provides skill list/details/zip packaging
├── templates/          # Markdown render style templates (default/github/academic/dark-pro)
├── package.json
├── build.js            # esbuild bundles frontend → public/dist
├── Dockerfile
├── docker-compose.yml
├── .env.example        # Environment variable template
├── .mcp.json           # MCP client config example
├── docs/
│   ├── api.md          # Complete REST API reference
│   └── design/         # Design documents
├── skills/
│   └── jpage/          # Claude Code / Desktop unified skill: upload, generate content, presentations, templates
├── test/               # Unit + integration tests (node:test + supertest) + e2e harness
├── data/               # SQLite databases, uploaded files & sessions (auto-created)
└── public/             # Frontend static assets
    ├── index.html
    ├── css/style.css
    ├── js/             # Page-split ES modules
    └── dist/           # Build output (npm run build, git-ignored)
```

---

## REST API

Port `8858` (overridable via `PORT`). All write endpoints require login or Bearer token. Full reference: [docs/api.md](docs/api.md).

### Auth

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/me` | GET | Current login info (`{id, username, email, emailVerified, role}`). |
| `/api/auth/login` | POST | Login (`{account, password}` or `{username, password}`, auto-detects username or email). |
| `/api/auth/register` | POST | Register (requires `ALLOW_REGISTRATION=true`). |
| `/api/auth/logout` | POST | Logout. |
| `/api/auth/change-password` | POST | Change password (all users). |
| `/api/auth/profile` | POST | Edit profile (username/email). |
| `/api/auth/send-register-code` | POST | Send registration verification code (requires open registration). |
| `/api/auth/verify-email` | GET | Verify email token. |
| `/api/auth/smtp-status` | GET | Whether SMTP is configured. |
| `/api/auth/registration-status` | GET | Whether registration is open. |

### User Management (Admin only)

| Endpoint | Method | Description |
|---|---|---|
| `/api/users` | GET | List all users. |
| `/api/users` | POST | Create user. |
| `/api/users/:id` | PUT | Update role or reset password. |
| `/api/users/:id` | DELETE | Delete user; files transfer to admin. |

### API Tokens

| Endpoint | Method | Description |
|---|---|---|
| `/api/tokens` | GET | List own tokens. |
| `/api/tokens` | POST | Create token (plaintext returned once only). |
| `/api/tokens/:id` | DELETE | Delete token. |

### File Management

| Endpoint | Method | Description |
|---|---|---|
| `/api/files` | GET | List files (admin sees all; users see own + public). |
| `/api/files/search` | GET | Full-text + filename search (pagination, filters). |
| `/api/files/upload` | POST | Multipart upload (`.html`/`.htm`/`.md`/`.markdown`/`.zip`, 50MB). |
| `/api/files/upload-json` | POST | JSON upload (`{name, content, isPublic?}`). |
| `/api/files/batch` | POST | Batch operations (delete/public/private/category, ≤200). |
| `/api/files/:id` | GET | Single file metadata. |
| `/api/files/:id` | PUT | Rename or toggle public/private. |
| `/api/files/:id` | DELETE | Delete file. |
| `/api/files/:id/content` | GET | Return raw text. |
| `/api/files/:id/render` | GET | Return rendered HTML. |
| `/api/files/:id/download` | GET | Stream download file (Bundle as ZIP). |
| `/api/files/:id/asset/*` | GET | Bundle resource file access. |
| `/api/files/:id/overwrite` | POST | Overwrite upload (auto version backup). |
| `/api/files/:id/versions` | GET | Version history list. |
| `/api/files/:id/versions/:ver/restore` | POST | Restore to specified version. |
| `/api/files/:id/stats` | GET | Visit stats (viewCount/daily7/daily30). |
| `/s/:key` | GET | Short link render page. |

### Tags

| Endpoint | Method | Description |
|---|---|---|
| `/api/tags` | GET | List all tags (with file_count). |
| `/api/tags` | POST | Create tag. |
| `/api/tags/:id` | DELETE | Delete tag. |
| `/api/files/:id/tags` | PUT | Replace file's tag list. |

### Favorites

| Endpoint | Method | Description |
|---|---|---|
| `/api/files/:id/star` | POST | Favorite file. |
| `/api/files/:id/star` | DELETE | Unfavorite file. |

### Categories

| Endpoint | Method | Description |
|---|---|---|
| `/api/categories` | GET | List categories (with file_count). |
| `/api/categories` | POST | Create category. |
| `/api/categories/:id` | PUT | Rename category (admin only). |
| `/api/categories/:id` | DELETE | Delete category (admin only). |
| `/api/files/:id/category` | PUT | Set file category. |

### Content Templates

| Endpoint | Method | Description |
|---|---|---|
| `/api/content-templates/market` | GET | Public template marketplace list (no login required). |
| `/api/content-templates` | GET | Current user's templates. |
| `/api/content-templates` | POST | Create template. |
| `/api/content-templates/:id` | PUT/DELETE | Update/delete template (owner only). |
| `/api/content-templates/:id/use` | POST | Record template usage count. |
| `/api/content-templates/:id/instantiate` | POST | Instantiate template into a new file. |
| `/api/templates` | GET | Markdown render style templates (skins). |

### Admin (Admin only)

| Endpoint | Method | Description |
|---|---|---|
| `/api/admin/export` | GET | Export database backup. |
| `/api/admin/import` | POST | Import backup. |
| `/api/admin/stats` | GET | System statistics. |

### Skills

| Endpoint | Method | Description |
|---|---|---|
| `/api/skills` | GET | List installed skill packs. |
| `/api/skills/:name` | GET | Skill details. |
| `/api/skills/:name/download` | GET | ZIP download of skill directory. |

---

## MCP / AI Integration

jpage includes a built-in [MCP Streamable HTTP](https://modelcontextprotocol.io) endpoint, enabling AI tools like Claude Code and Claude Desktop to directly upload and manage files.

### Enable

Set the `MCP_TOKEN` environment variable, or use any user-level API Token (`jp_` prefix). Both work:

```bash
MCP_TOKEN=your-secret-token
```

### Client Configuration

**Claude Code** — Add to your project's `.mcp.json` or merge into `~/.claude.json`:

```json
{
  "mcpServers": {
    "jpage": {
      "type": "http",
      "url": "http://localhost:8858/mcp",
      "headers": {
        "Authorization": "Bearer ${env.MCP_TOKEN}"
      }
    }
  }
}
```

**Claude Desktop** — Merge the `mcpServers` block into `~/Library/Application Support/Claude/claude_desktop_config.json`.

### Capabilities

**Tools** (17):

| Tool | Purpose |
|---|---|
| `upload_file` | Upload HTML, Markdown, or ZIP and return a preview link. |
| `list_files` | List all files. |
| `get_file_content` | Read file content. |
| `get_file_url` | Get file preview URL. |
| `rename_file` | Rename file or toggle public/private. |
| `delete_file` | Delete file. |
| `list_file_versions` | View file version history. |
| `restore_file_version` | Rollback to specified version. |
| `list_tags` | List tags. |
| `add_tags_to_file` | Add tags to file. |
| `star_file` | Favorite file. |
| `unstar_file` | Unfavorite file. |
| `list_categories` | List categories. |
| `create_category` | Create category. |
| `set_file_category` | Set file category. |
| `list_content_templates` | List content template marketplace. |
| `get_content_template` | Get content template details for style reference. |

**Resources** (2):

| URI | Description |
|---|---|
| `jpage://files` | All file metadata (JSON list). |
| `jpage://file/{id}` | Single file content (≤ 256KB). |

### Companion Skill

The repo includes `skills/jpage/SKILL.md`, a ready-to-use skill for Claude Code / Desktop. Once installed, AI-generated HTML, Markdown, reports, visualizations, presentations, and template-market-styled content are automatically uploaded to jpage with a preview link.

```bash
ln -s "$(pwd)/skills/jpage" ~/.claude/skills/jpage
```

Or install via CLI:

```bash
jpage skill install
```

### Web Management

After login, the homepage bottom section shows an **AI Skills** block where you can view details and download zip packages. Add new skills by creating `skills/<name>/SKILL.md` with YAML frontmatter — the service auto-discovers them on restart.

### Debug

```bash
npx -y @modelcontextprotocol/inspector http://localhost:8858/mcp
```

---

## Use Cases

- **AI Content Sharing** — One-click upload of HTML reports and visualizations generated by Claude Code, Cursor, and similar tools.
- **Technical Documentation** — Markdown notes, meeting minutes, project reports with auto-rendered code highlighting, math formulas, and diagrams.
- **Static Page Hosting** — Single-page HTML demos, prototypes, landing pages — no server configuration needed.
- **Temporary File Sharing** — Any HTML/Markdown file, drag and drop to get a link — no account required.
- **Version Management** — Iterative document updates automatically preserve history; rollback anytime.
- **Template-Driven Creation** — Use the content template marketplace to keep consistent styles across AI-generated pages.

---

## Why jpage

Existing solutions are either too heavy (requiring server setup, domains, CI) or too closed (locked to specific platforms).

jpage does one thing: make static content sharing simple again. Drop a file, get a link. An optional multi-user system exists, but the default is zero-friction — drop a file to get a link, share public files anonymously without registering.

---

## License

MIT
