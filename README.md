# Google Docs MCP Server

This is a Model Context Protocol (MCP) server that allows you to connect to Google Docs through Claude. With this server, you can:

## Features

- Read documents with **outline**, **word count** and **reading time**
- Append, insert, find/replace, and multi-step **`edit-document`** workflows
- **Text formatting** (color, bold, font, links) and **paragraph layout** (alignment, spacing, indents, headings)
- **Style presets** (MLA/APA essay, manuscript, cover letter, notes)
- **Lists**, **page breaks**, **title pages**, **scene breaks**
- **Comments**, **rename**, **copy**, **export** (PDF/DOCX/TXT/HTML)
- **Safer bulk edits** — warns when `findText` matches more than 10 places

## Prerequisites

- Node.js v16.0.0 or later
- Google Cloud project with **Google Docs API** and **Google Drive API** enabled
- OAuth 2.0 Desktop credentials (`credentials.json`)

## Setup

1. **Google Cloud OAuth** — create credentials before running the server:

   - Open [Google Cloud Console](https://console.cloud.google.com/)
   - Create a project (or select an existing one)
   - Enable **Google Docs API** and **Google Drive API** (APIs & Services → Library)
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - If prompted, configure the OAuth consent screen (External is fine for personal use)
   - Application type: **Desktop app**
   - Download the JSON file and save it as `credentials.json` in the project root

2. **Clone and build:**

```bash
git clone https://github.com/yourusername/MCP-Google-Doc.git
cd MCP-Google-Doc

npm install
npm run build
npm start
```

   First run opens Google OAuth in the browser and saves `token.json`.

3. **Connect Claude Desktop (Windows)** — add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "googledocs": {
      "command": "node",
      "args": ["C:\\path\\to\\MCP-Google-Doc\\build\\server.js"]
    }
  }
}
```

   Restart Claude Desktop. Use your actual path to `build/server.js` (not the repo’s example path if yours differs).

   **Cursor:** Settings → MCP → add the same `command` and `args`.

## Available Tools

### Read & analyze

| Tool | Purpose |
|------|---------|
| `get-doc` | Full text + outline + stats (words, reading time) |
| `get-outline` | Heading tree (H1–H6) for section-aware edits |
| `get-doc-stats` | Word/character/paragraph/heading counts |
| `list-docs` / `search-docs` | Find documents in Drive |
| `list-tabs` / `get-tab` | Multi-tab documents |

### Write & edit

| Tool | Purpose |
|------|---------|
| `create-doc` | New document |
| `update-doc` | Append, replace entire doc, or find-and-replace |
| `insert-text` | Insert at index, after heading, before/after text |
| **`edit-document`** | **All-in-one** — chain multiple operations in one call |
| `rename-doc` / `copy-doc` | Rename or duplicate |
| `delete-doc` | Delete document |

### Format (character)

| Tool | Purpose |
|------|---------|
| `format-text` | Color, bold, italic, underline, font, links, super/subscript |
| `clear-formatting` | Reset styling on matched text |

### Format (paragraph & document)

| Tool | Purpose |
|------|---------|
| `format-paragraph` | Alignment, line spacing, indents, heading styles |
| `apply-preset` | `essay-mla`, `essay-apa`, `manuscript`, `cover-letter`, `notes` |
| `generate-title-page` | Centered academic title block at document start |

### Structure

| Tool | Purpose |
|------|---------|
| `create-list` | Bullet or numbered lists |
| `insert-page-break` | Page break before References, new chapter, etc. |
| `insert-scene-break` | Page break or centered `* * *` between sections |

### Collaboration & export

| Tool | Purpose |
|------|---------|
| `list-comments` / `add-comment` | Drive comment panel (see note below) |
| `insert-review-note` | **Visible** yellow in-doc note (use when comments must show in body) |
| `export-doc` | Export to PDF, DOCX, TXT, or HTML (saved to `exports/`) |

## `edit-document` operations

Recommended for complex writer/student tasks. Operations run **in order**:

| Type | Use for |
|------|---------|
| `append` | Add text at end |
| `replaceText` | Find and replace |
| `formatText` | Character styling |
| `formatParagraph` | Alignment, spacing, headings |
| `insertText` | Insert in middle of doc |
| `insertPageBreak` | Page break |
| `createList` | Bullet/numbered list |
| `applyPreset` | MLA, APA, manuscript, etc. |
| `clearFormatting` | Strip bold/color/fonts |
| `insertSceneBreak` | Chapter/scene divider |

```json
{
  "docId": "YOUR_DOC_ID",
  "operations": [
    { "type": "applyPreset", "preset": "essay-mla" },
    { "type": "generate-title-page", "title": "My Essay", "author": "Jane Doe", "course": "ENG 101", "date": "June 5, 2026" },
    { "type": "insertPageBreak", "beforeText": "References" },
    { "type": "formatText", "findText": "Important", "bold": true, "foregroundColor": "red" },
    { "type": "createList", "append": true, "listType": "numbered", "items": ["First point", "Second point"] }
  ]
}
```

> Note: `generate-title-page` is a standalone tool, not an `edit-document` operation type — call it separately or ask Claude to chain tools.

## Style presets

| Preset | Applies |
|--------|---------|
| `essay-mla` | 1" margins, Times New Roman 12pt, double space, first-line indent |
| `essay-apa` | Same body formatting as MLA |
| `manuscript` | Courier New 12pt, double space |
| `cover-letter` | Arial 11pt, 1.15 spacing |
| `notes` | Arial 11pt, 1.15 spacing |

Use `findText` on `apply-preset` to limit scope to matching paragraphs.

## Formatting quick reference

| You want | How |
|----------|-----|
| Text color | `format-text` → `foregroundColor`: `"black"` or `"#000000"` |
| Align right | `format-paragraph` → `alignment`: `"right"` |
| Double spacing | `format-paragraph` → `lineSpacing`: `2` or `apply-preset` → `essay-mla` |
| Heading | `format-paragraph` → `namedStyle`: `"HEADING_1"` |
| Bullet list | `create-list` → `listType`: `"bullet"` |
| Page before References | `insert-page-break` → `beforeText`: `"References"` |
| Insert after section | `insert-text` → `afterHeading`: `"Introduction"` |

## Safer bulk edits

When `findText` matches **more than 10** occurrences, tools return an error unless you set:

```json
{ "confirmBulkEdit": true }
```

Or target one match with `occurrenceIndex: 0`.

## Writer & student recipes

Copy these prompts into Claude:

**MLA essay**
> Format doc `[ID]` as an MLA essay: apply `essay-mla` preset, add a title page with my name and course, double-check stats with `get-doc-stats`.

**Section-aware insert**
> Read the outline of doc `[ID]`, then insert a new paragraph after the "Methods" heading.

**Numbered assignment requirements**
> Append a numbered list to doc `[ID]`: "Read chapter 3", "Answer questions 1-5", "Submit by Friday".

**Polish draft**
> Read doc `[ID]`, fix inconsistent heading styles, clear stray formatting on body text, set line spacing to 1.5 for quotes only.

**Export for submission**
> Export doc `[ID]` as PDF to the exports folder.

**Feedback comments**
> Review doc `[ID]` and add comments on paragraphs that need citations.

**Essay length check**
> How many words is doc `[ID]`? Is it at least 1500?

**Chapter break**
> Insert a page break before "Chapter 2" in doc `[ID]`.

## Available Prompts

| Prompt | Purpose |
|--------|---------|
| `create-doc-template` | Create structured doc from topic + style |
| `analyze-doc` | Summarize and suggest improvements |
| `format-academic-essay` | MLA/APA formatting workflow |
| `polish-prose` | Read, suggest, apply safe edits |
| `create-outline-from-topic` | New doc with section outline |
| `bibliography-check` | Flag citation / References issues |

## Comments: where they appear

`add-comment` uses the **Google Drive API**. Those comments are saved, but Google Docs often **does not show them as inline yellow margin notes** next to text (known Google limitation).

**To see Drive API comments:**
1. Open the doc in Google Docs
2. Click the **comment bubble** icon in the top-right toolbar (or `Ctrl+Alt+Shift+O`)
3. Check the comments side panel — not the document margins

**For a note you can see in the document body** (recommended for testing/reviews):

```
insert-review-note on doc [ID] after "Step A" with note "Please review this section"
```

This inserts yellow highlighted `[REVIEW: ...]` text directly in the doc.

## API limitations (not implemented)

These are **not supported** by the Google Docs/Drive APIs (or are unreliable), so this server does not expose them:

- **Inline margin comments** anchored to text (Drive API saves them but Docs UI ignores anchors)
- Native horizontal rules (scene breaks use page break or `* * *` text instead)
- Headers/footers with page numbers
- Multi-column layout
- Footnotes/endnotes
- Images and charts
- Drive **file name** styling (only document body content)

## Troubleshooting

**Auth errors** — Delete `token.json`, run `npm start`, re-authenticate.

**Bulk match error** — Use `occurrenceIndex` or `confirmBulkEdit: true`.

**Changes not visible in Claude** — Run `npm run build` and restart Claude Desktop.

**Export path** — Files save to `exports/` in the project unless `outputPath` is set.

## Security

Never commit `credentials.json`, `token.json`, or exported files with sensitive content. All are in `.gitignore`.