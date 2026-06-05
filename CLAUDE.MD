# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Build & Run

```bash
npm install
npm run build        # compile TypeScript → build/
npm start            # run MCP server (stdio)
npm run dev          # watch mode
```

Entry point: `build/server.js`. Requires `credentials.json` + `token.json` (OAuth).

## Architecture

Single-file MCP server (`src/server.ts`) — Google Docs/Drive over stdio. OAuth via `@google-cloud/local-auth`; tokens in `token.json`.

### Tools (writer/student focused)

**Read:** `get-doc`, `get-outline`, `get-doc-stats`, `list-docs`, `search-docs`, `list-tabs`, `get-tab`

**Write:** `create-doc`, `update-doc`, `insert-text`, `edit-document`, `rename-doc`, `copy-doc`, `delete-doc`

**Format:** `format-text`, `format-paragraph`, `clear-formatting`, `apply-preset`, `generate-title-page`

**Structure:** `create-list`, `insert-page-break`, `insert-scene-break`

**Collaboration:** `list-comments`, `add-comment`, `insert-review-note`, `export-doc`

**Resources:** `googledocs://list`, `googledocs://{docId}`

**Prompts:** `create-doc-template`, `analyze-doc`, `format-academic-essay`, `polish-prose`, `create-outline-from-topic`, `bibliography-check`

### Key design choices

- **`edit-document`** is the primary multi-step tool — prefer it for complex formatting workflows.
- **`get-outline`** before section edits — use `afterHeading` / `beforeText` on insert tools.
- **Bulk safety** — `findText` matching >10 requires `confirmBulkEdit: true` or `occurrenceIndex`.
- **Append** uses `endOfSegmentLocation` (not raw end index) to avoid segment boundary errors.
- **Presets** in `apply-preset`: `essay-mla`, `essay-apa`, `manuscript`, `cover-letter`, `notes`.
- **Exports** written to `exports/` (gitignored).

### Not supported (no reliable API)

Inline margin comments on text (use `insert-review-note` for visible in-doc feedback), horizontal rules, headers/footers/page numbers, columns, footnotes, images, Drive tab-title styling.

## Tool selection guide for Claude

| User intent | Tool |
|-------------|------|
| Multi-step format + edit | `edit-document` |
| MLA/APA whole doc | `apply-preset` |
| Align / spacing / headings | `format-paragraph` |
| Color / bold / font on words | `format-text` |
| Insert in middle | `insert-text` (not append) |
| Lists | `create-list` |
| Section map | `get-outline` |
| Word count | `get-doc-stats` |
| Submit as PDF | `export-doc` |
| Teacher feedback (visible in doc) | `insert-review-note` |
| Teacher feedback (comment panel) | `add-comment` + tell user to open comment bubble |

## Hard Rules

- **Never commit** `credentials.json`, `token.json`, or `exports/`.
- Run `npm run build` after changing `src/server.ts` — Claude Desktop uses `build/server.js`.
- Windows paths in MCP config need escaped backslashes: `C:\\Users\\...\\build\\server.js`.

## Connecting to Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "googledocs": {
      "command": "node",
      "args": ["C:/absolute/path/to/build/server.js"]
    }
  }
}
```

## Future: Vector RAG (planned, not built)

Target: support agents querying docs via Bedrock embeddings + OpenSearch. Modules `src/chunker.ts`, `src/bedrock.ts`, etc. are planned — not in current `server.ts`.
