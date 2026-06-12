# jpage

> Drop a file, get a page — instantly.

**[>>> View Product Introduction <<<](https://jpage.cn/)**

**jpage** is a zero-config HTML / Markdown instant preview and sharing tool. Drop in a document and instantly get a clean online page — no deployment pipeline, no server knowledge required. Especially great for one-click sharing of AI-generated content.

---

## Features

### Core

- **Instant Preview** — Upload HTML or Markdown files, get a rendered online page in seconds
- **Enhanced Markdown Rendering** — Syntax highlighting (highlight.js), math formulas (KaTeX), Mermaid diagrams, with automatic dark/light theme switching
- **Source View** — Toggle between rendered and source modes for easy comparison
- **Short Links** — Each file gets an auto-generated 8-character short link (`/s/xxxxxxxx`)
- **File Management** — Rename, delete, download, toggle public/private — simple and intuitive
- **Drag & Drop Upload** — Click or drag to upload, up to 50MB per file
- **Version History** — Overwrite uploads automatically preserve previous versions; rollback anytime
- **Responsive Design** — Adapts to desktop and mobile; dark mode follows system preference

### Organization

- **Tags** — Tag files for multi-dimensional categorization and search
- **Categories** — Organize files into categories for clear hierarchy
- **Favorites** — One-click bookmark for quick access to frequently used files

### Security & Permissions

- **Multi-user Support** — Admin can create and manage multiple users; regular users can only access their own files and public files
- **Open Registration** — Enable self-service registration via `ALLOW_REGISTRATION=true`, with optional SMTP email verification
- **Session Auth** — Cookie + bcrypt password hashing
- **API Tokens** — Each user can create multiple API tokens for scripts and AI tools
- **Public/Private Files** — Toggle visibility on upload; private files are only accessible to the owner and admin
- **Rate Limiting** — Login and upload endpoints are rate-limited to prevent brute force and abuse

### AI Integration

- **MCP Protocol** — Built-in MCP Streamable HTTP endpoint for direct AI tool integration
- **Skills Management** — Auto-discovers Claude Code/Desktop skill packs in the `skills/` directory
- **JSON Upload API** — `/api/files/upload-json` for programmatic uploads, ideal for AI workflows

### Deployment

- **Zero-Dependency Runtime** — Single container startup with built-in SQLite storage
- **Docker One-Click Deploy** — Multi-stage build, env var configuration, volume persistence
- **Database Migrations** — Automatic schema migration on startup; no manual upgrades needed

## Tech Stack

- **Backend**: Node.js + Express + express-session (SQLite session store)
- **Database**: SQLite3 (zero-config, auto-migration)
- **Frontend**: Vanilla JavaScript (no framework dependencies)
- **Rendering**: marked.js + highlight.js + KaTeX + Mermaid
- **Protocol**: MCP Streamable HTTP (@modelcontextprotocol/sdk)
- **Container**: Docker / Docker Compose

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

## Auth & Security

jpage supports a multi-user system. Admin manages all users and files; regular users can only access their own files and public files. Share links (`/api/files/:id/render`, `/s/:key`, download, source) are anonymously accessible when the file is marked public. Uncheck "Public access" on upload to make the file visible only to the owner and admin.

### Authentication Methods

API and MCP endpoints support three authentication methods:

1. **Session Cookie** — `jpage.sid` cookie after login, for browser access
2. **API Token** — User-created `jp_` prefixed tokens, for script integration
3. **MCP Token** — `MCP_TOKEN` environment variable, for AI tool connections (backward compatible)

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | No | Admin username for first startup when users table is empty; defaults to `admin` |
| `ADMIN_PASSWORD` | No | Admin password for first startup (≥8 chars); if empty, a random 16-char password is generated and printed to startup logs |
| `SESSION_SECRET` | Prod | Encrypts session cookies; in dev mode a temporary key is auto-generated (lost on restart) |
| `NODE_ENV` | No | When `production`, cookies are sent only over HTTPS; missing SESSION_SECRET will refuse to start |
| `PORT` | No | Default `8858` |
| `MCP_TOKEN` | No | Bearer token for the `/mcp` endpoint; MCP endpoint is not mounted if unset |
| `ALLOW_REGISTRATION` | No | Set to `true` to enable self-service registration; defaults to off (admin-only user creation) |
| `SMTP_HOST` | No | SMTP server address (e.g. `smtp.qq.com`); enables email verification when configured |
| `SMTP_PORT` | No | SMTP port (e.g. `465`) |
| `SMTP_SECURE` | No | Use SSL (`true`/`false`) |
| `SMTP_USER` | No | SMTP login username |
| `SMTP_PASS` | No | SMTP login password or authorization code |
| `SMTP_FROM` | No | Sender address (e.g. `"jpage <user@example.com>"`) |
| `APP_URL` | No | External app URL used to build verification links (e.g. `https://jpage.cn`) |

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

## Project Structure

```
jpage/
├── server.js           # Express server (REST API + auth + Markdown rendering)
├── logger.js           # Structured JSON Lines logger
├── mcp-server.js       # MCP Streamable HTTP endpoint (/mcp)
├── migrations.js       # Database migration runner
├── migrations/         # Sequential schema migration files
├── skills-registry.js  # Scans skills/ dir, provides skill list/details/zip packaging
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example        # Environment variable template
├── .mcp.json           # MCP client config example
├── docs/
│   ├── api.md          # Complete REST API reference
│   └── design/         # Design documents
├── skills/
│   └── jpage-upload/   # Claude Code / Desktop skill
│       └── SKILL.md
├── data/               # SQLite databases, uploaded files & sessions (auto-created)
│   ├── database.sqlite
│   ├── sessions.sqlite
│   └── uploads/
└── public/             # Frontend static assets
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## REST API

Port `8858` (overridable via `PORT`). All write endpoints require login or Bearer token.

### Auth

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/me` | GET | Current login info |
| `/api/auth/login` | POST | Login (`{username, password}`) |
| `/api/auth/register` | POST | Register (requires `ALLOW_REGISTRATION=true`) |
| `/api/auth/logout` | POST | Logout |
| `/api/auth/change-password` | POST | Change password (all users) |

### User Management (Admin only)

| Endpoint | Method | Description |
|---|---|---|
| `/api/users` | GET | List all users |
| `/api/users` | POST | Create user |
| `/api/users/:id` | PUT | Update role or reset password |
| `/api/users/:id` | DELETE | Delete user; files transfer to admin |

### API Tokens

| Endpoint | Method | Description |
|---|---|---|
| `/api/tokens` | GET | List own tokens |
| `/api/tokens` | POST | Create token (plaintext returned once only) |
| `/api/tokens/:id` | DELETE | Delete token |

### File Management

| Endpoint | Method | Description |
|---|---|---|
| `/api/files` | GET | List files (admin sees all; users see own + public) |
| `/api/files/upload` | POST | Multipart upload |
| `/api/files/upload-json` | POST | JSON upload (`{name, content, isPublic?}`) |
| `/api/files/:id` | PUT | Rename or toggle public/private |
| `/api/files/:id` | DELETE | Delete file |
| `/api/files/:id/content` | GET | Return raw text |
| `/api/files/:id/render` | GET | Return rendered HTML |
| `/api/files/:id/download` | GET | Stream download file |
| `/s/:key` | GET | Short link page render |

### Tags

| Endpoint | Method | Description |
|---|---|---|
| `/api/tags` | GET | List all tags (with file_count) |
| `/api/tags` | POST | Create tag |
| `/api/tags/:id` | DELETE | Delete tag |
| `/api/files/:id/tags` | PUT | Replace file's tag list |

### Favorites

| Endpoint | Method | Description |
|---|---|---|
| `/api/files/:id/star` | POST | Favorite file |
| `/api/files/:id/star` | DELETE | Unfavorite file |

### Categories

| Endpoint | Method | Description |
|---|---|---|
| `/api/categories` | GET | List categories (with file_count) |
| `/api/categories` | POST | Create category |
| `/api/categories/:id` | PUT | Rename category |
| `/api/categories/:id` | DELETE | Delete category |
| `/api/files/:id/category` | PUT | Set file category |

### Skills

| Endpoint | Method | Description |
|---|---|---|
| `/api/skills` | GET | List installed skill packs |
| `/api/skills/:name` | GET | Skill details |
| `/api/skills/:name/download` | GET | ZIP download of skill directory |

Full API documentation: [docs/api.md](docs/api.md).

## MCP / AI Integration

jpage includes a built-in [MCP Streamable HTTP](https://modelcontextprotocol.io) endpoint, enabling AI tools like Claude Code and Claude Desktop to directly upload and manage files.

### Enable

Set the `MCP_TOKEN` environment variable:

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

**Tools** (15):

| Tool | Purpose |
|---|---|
| `upload_file` | Upload HTML or Markdown, return preview link |
| `list_files` | List all files |
| `get_file_content` | Read file content |
| `get_file_url` | Get file preview URL |
| `rename_file` | Rename file |
| `delete_file` | Delete file |
| `list_file_versions` | View file version history |
| `restore_file_version` | Rollback to specified version |
| `list_tags` | List tags |
| `add_tags_to_file` | Add tags to file |
| `star_file` | Favorite file |
| `unstar_file` | Unfavorite file |
| `list_categories` | List categories |
| `create_category` | Create category |
| `set_file_category` | Set file category |

**Resources** (2):

| URI | Description |
|---|---|
| `jpage://files` | All file metadata (JSON list) |
| `jpage://file/{id}` | Single file content (≤ 256KB) |

### Companion Skill

The repo includes `skills/jpage-upload/SKILL.md`, a ready-to-use skill for Claude Code / Desktop. Once installed, AI-generated HTML, Markdown, reports, and visualizations are automatically uploaded to jpage with a preview link.

```bash
ln -s "$(pwd)/skills/jpage-upload" ~/.claude/skills/jpage-upload
```

### Web Management

After login, the homepage bottom section shows an **AI Skills** block where you can view details and download zip packages. Add new skills by creating `skills/<name>/SKILL.md` with YAML frontmatter — the service auto-discovers them on restart.

### Debug

```bash
npx -y @modelcontextprotocol/inspector http://localhost:8858/mcp
```

## Use Cases

- **AI Content Sharing** — One-click upload of HTML reports and visualizations generated by Claude Code, Cursor, and similar tools
- **Technical Documentation** — Markdown notes, meeting minutes, project reports with auto-rendered code highlighting, math formulas, and diagrams
- **Static Page Hosting** — Single-page HTML demos, prototypes, landing pages — no server configuration needed
- **Temporary File Sharing** — Any HTML/Markdown file, drag and drop to get a link — no account required
- **Version Management** — Iterative document updates automatically preserve history; rollback anytime

## Why

Existing solutions are either too heavy (requiring server setup, domains, CI) or too closed (locked to specific platforms).

jpage does one thing: make static content sharing simple again. Drop a file, get a link. No account system complexity, no learning curve — just open and use.

## License

MIT
