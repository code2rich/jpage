# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: 即页 (jpage)

零配置 HTML / Markdown 即时预览与分享工具。单文件 Express 服务（`server.js`） + MCP server 模块（`mcp-server.js`）。SQLite 存元数据与用户表，磁盘 `data/uploads/` 存原始文件，session 存 `data/sessions.sqlite`。单管理员鉴权（bcrypt）。

## Commands

- `npm install` — install deps
- `npm start` — run server in production mode (port 8858, see `PORT` env var)
- `npm run dev` — run with `nodemon` for hot reload
- `docker-compose up -d` — build & start container; `./data` is bind-mounted to persist DB and uploads
- `MCP_TOKEN=xxx npm start` — 同时启用 `/mcp` MCP 端点（不设置则端点不挂载）

There is no test suite, linter, or build step. Verify changes by hitting the API, loading the UI in a browser at http://localhost:8858, or using `npx @modelcontextprotocol/inspector http://localhost:8858/mcp` to debug the MCP server.

## Architecture

**Two-module backend**:
- `server.js` (~480 lines) — Express app, REST API, auth (session + bcrypt), multer upload, SQLite
- `mcp-server.js` (~280 lines) — MCP Streamable HTTP server. Exports `mountMcpServer(app, {port, mcpToken, adminUserId})` and `closeMcpTransports()`. 6 tools + 2 resources; tools call the REST API via loopback fetch with the same Bearer token.

**Storage**
- `data/database.sqlite` — `files` and `users` tables
- `data/sessions.sqlite` — express-session store (connect-sqlite3)
- `data/uploads/` — uploaded file contents, named `<timestamp>-<random><ext>`
- All auto-created on first run

**Database schema**:
- `files(id, original_name, stored_name, file_type, size, created_at, is_public, uploaded_by)` — `is_public=1` means anonymous can read; `uploaded_by` references `users.id`
- `users(id, username UNIQUE, password_hash, created_at)`

**REST API**:
- `GET /api/auth/me` — current user
- `POST /api/auth/login` — body `{username, password}`, sets `jpage.sid` cookie. Rate-limited 10/15min.
- `POST /api/auth/logout` — destroys session
- `GET /api/files` — list files (auth required)
- `POST /api/files/upload` — multipart via multer (auth, 50/15min, 50MB, .html/.htm/.md/.markdown)
- `POST /api/files/upload-json` — JSON `{name, content, isPublic?}` (auth, same rate limit / size / ext). Used by MCP.
- `PUT /api/files/:id` — body `{name?, isPublic?}` (at least one)
- `DELETE /api/files/:id` — removes DB row + disk file
- `GET /api/files/:id/content` — returns raw file text as JSON (loadFileWithPrivacy allows public files)
- `GET /api/files/:id/render` — returns rendered HTML (marked for markdown, charset-injected for HTML)
- `GET /api/files/:id/download` — streams the file
- `GET /api/skills` — list installed skill packages (auth required)
- `GET /api/skills/:name` — skill detail with SKILL.md body and file list
- `GET /api/skills/:name/download` — zip download of the entire skill directory

**Skills registry** — `skills-registry.js` auto-discovers `skills/*/SKILL.md` on every request. Parses minimal YAML frontmatter (`name`, `description`, `version`, `author`). The web UI shows a Skills section on the home page; admins can view details (modal) and download as zip. The zipped package mirrors the on-disk directory so it can be extracted directly into `~/.claude/skills/`.

**MCP endpoint** (mounted only when `MCP_TOKEN` env var is set):
- `POST`/`GET`/`DELETE /mcp` — Streamable HTTP transport
- Bearer auth via `Authorization: Bearer ${MCP_TOKEN}`
- Tools: `list_files`, `upload_file`, `get_file_content`, `delete_file`, `rename_file`, `get_file_url`
- Resources: `jpage://files` (list), `jpage://file/{id}` (content, ≤ 256KB)

**Static + SPA fallback** — `public/` served by `express.static`; catch-all `app.get('*')` returns `public/index.html` for client-side routing between home and preview views.

**Frontend** — `public/index.html` defines two `<template>` blocks (home / preview); `public/js/app.js` is a single-file vanilla-JS controller that swaps them in based on URL hash. No build, no bundler, no framework. CSS in `public/css/style.css` includes a system-color-scheme dark mode.

## Conventions & Gotchas

- **Default port is 8858** (not 3000). Configurable via `PORT` env var. `Dockerfile`, `docker-compose.yml`, and `README.md` all reference 8858 — keep them in sync.
- **Multer filename encoding** — the `decodeFilename` helper (`Buffer.from(name, 'latin1').toString('utf8')`) is needed because multer stores `originalname` as latin1. Don't remove it.
- **The catch-all route must come after all API routes and after the MCP mount** — Express matches in order; placing it earlier would shadow the API or `/mcp`.
- **DB is shared** — the single `db` connection is reused for all requests. The promise wrappers `dbRun`/`dbGet`/`dbAll` keep call sites clean.
- **Upload rate limit** is applied per-IP via `express-rate-limit` on `POST /api/files/upload` and `POST /api/files/upload-json` only.
- **HTML render endpoint** intentionally does not sanitize the HTML — it's a sandbox inside the user's own iframe (`sandbox="allow-scripts allow-same-origin"`). Be cautious about changing this CSP.
- **Container port mapping** — `docker-compose.yml` maps host 8858 → container 8858. The container itself doesn't need a port published if behind a reverse proxy.
- **`.dockerignore` excludes `data/`** so uploaded files don't get baked into the image; the `data/` volume mount in compose is what persists state.
- **Auth model** — `requireAuth` accepts `req.session.userId` OR `Authorization: Bearer ${MCP_TOKEN}`. When the MCP token is used, `req.session.userId` is set to the first `users.id` so `uploaded_by` records the admin user. `loadFileWithPrivacy` applies the same dual check.
- **`MCP_TOKEN` is opt-in** — when unset, `mountMcpServer` prints a message and returns; no `/mcp` routes are added. This is by design: the REST API is unaffected.
- **`uploaded_by` is set from `req.session.userId`** — when MCP uploads, this becomes the admin user id, not the MCP client. Don't add per-MCP-client identity.

## File layout

```
server.js                # Express + REST API + auth
mcp-server.js            # MCP Streamable HTTP server (POST/GET/DELETE /mcp)
skills-registry.js       # scans skills/ for SKILL.md, parses frontmatter, streams zip
package.json             # deps include @modelcontextprotocol/sdk, zod, archiver
Dockerfile               # node:20-alpine, EXPOSE 8858
docker-compose.yml       # port 8858, ./data:/app/data volume
.mcp.json                # example Claude Code / Desktop MCP client config
docs/api.md              # full REST API reference
skills/jpage-upload/     # example Claude Code / Desktop skill
  SKILL.md
public/
  index.html             # two <template>s: home + preview
  css/style.css
  js/app.js              # single-file vanilla JS controller (hash-based routing)
data/                    # gitignored — SQLite DB, sessions, uploads (auto-created at runtime)
docs/screenshot-home.png
```
