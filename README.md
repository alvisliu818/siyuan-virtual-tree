# Code Block Render

A SiYuan plugin that attaches **custom renderers** to code blocks. Ships with a built-in **MySQL / SQL** preset.

## Features

- **Pluggable renderers** — rules map a code block language to a renderer + mode; add or remove freely.
- **MySQL / SQL preset** with three modes:
  - **Pretty** — syntax highlighting, auto-formatting (uppercase keywords, clause breaks, indented field/condition lists), line numbers, copy, and "write formatted SQL back into the block".
  - **Schema** — parses `CREATE TABLE` into a schema card: columns (type / nullable / default / comment / PK / auto-increment), indexes (PRIMARY / UNIQUE / INDEX / FULLTEXT / FOREIGN KEY), table comment and ENGINE/CHARSET.
  - **Run** — executes the SQL against a data source and renders the result as a scrollable table with CSV export.
- **Data sources** — SiYuan's built-in SQLite (via `/api/query/sql`), or an HTTP proxy for external MySQL (browsers cannot open raw MySQL connections).

## Usage

1. Insert a code block and set its language to `mysql` (add another rule for `sql` if you like).
2. Click the render button at the top-right of the code block to expand / collapse the panel.
3. Switch between Pretty / Schema / Run from the panel header.
4. Enable "Auto expand" on a rule to render as soon as the document opens.

The panel is mounted as a **sibling** of the code block, so it never ends up inside the block content and is never saved into your notes.

## HTTP proxy protocol

```http
POST /query
Content-Type: application/json
Authorization: Bearer <token>      # optional

{ "sql": "SELECT * FROM t LIMIT 10", "maxRows": 200 }
```

Respond with any of:

```json
{ "columns": ["id", "name"], "rows": [[1, "a"], [2, "b"]] }
{ "data": [{ "id": 1, "name": "a" }] }
[{ "id": 1, "name": "a" }]
```

Return `{"affectedRows": 3}` for non-query statements and `{"error": "..."}` on failure. See `README_zh_CN.md` for a minimal Node + mysql2 proxy implementation.

## Security

- Data sources are **read-only by default**: only `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH` are allowed.
- With read-only off, non-query statements ask for confirmation before running.
- Proxy URL and token live in local plugin storage. Use a trusted network and restrict the proxy's DB account.

## Development

```bash
npm install
npm run build
node scripts/verify-load.cjs
node scripts/run-sql-test.mjs
```

MIT
