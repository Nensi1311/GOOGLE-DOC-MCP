import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import * as fs from "fs";
import * as path from "path";
import * as process from "process";
import { fileURLToPath } from "url";
import { z } from "zod";
import { docs_v1, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

// Set up OAuth2.0 scopes - we need full access to Docs and Drive
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

// The token path is where we'll store the OAuth credentials
const TOKEN_PATH = path.join(PROJECT_ROOT, "token.json");

// The credentials path is where your OAuth client credentials are stored
const CREDENTIALS_PATH = path.join(PROJECT_ROOT, "credentials.json");

// Create an MCP server instance
const server = new McpServer({
  name: "google-docs",
  version: "1.0.0",
});

/** Avoid TS OOM: MCP SDK infers heavy Zod shapes for every tool registration. */
function registerTool(
  name: string,
  params: Record<string, z.ZodTypeAny>,
  handler: (args: any) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
): void {
  server.tool(name, params as never, handler as never);
}

function registerPrompt(
  name: string,
  args: Record<string, z.ZodTypeAny>,
  handler: (args: any) => { messages: Array<{ role: string; content: { type: string; text: string } }> }
): void {
  server.prompt(name, args as never, handler as never);
}

/** Escape single quotes for Google Drive query strings (fullText contains '...'). */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function persistTokensOnRefresh(client: OAuth2Client): void {
  client.on("tokens", (tokens) => {
    if (!fs.existsSync(TOKEN_PATH)) return;
    fs.promises.readFile(TOKEN_PATH, "utf-8")
      .then((raw) => {
        const current = JSON.parse(raw);
        return fs.promises.writeFile(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
      })
      .then(() => console.error("OAuth token refreshed and saved to:", TOKEN_PATH))
      .catch((err) => console.error("Failed to persist refreshed token:", err));
  });
}

async function authenticateFresh(): Promise<OAuth2Client> {
  console.error("Starting OAuth flow...");
  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  persistTokensOnRefresh(client);

  if (client.credentials) {
    console.error("Authentication successful, saving token...");
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials));
    console.error("Token saved successfully to:", TOKEN_PATH);
  } else {
    console.error("Authentication succeeded but no credentials returned");
  }

  return client;
}

/**
 * Load saved credentials if they exist, otherwise trigger the OAuth flow
 */
async function authorize() {
  try {
    // Load client secrets from a local file
    console.error("Reading credentials from:", CREDENTIALS_PATH);
    const content = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
    const keys = JSON.parse(content);
    const clientId = keys.installed.client_id;
    const clientSecret = keys.installed.client_secret;
    const redirectUri = keys.installed.redirect_uris[0];

    console.error("Using client ID:", clientId);
    console.error("Using redirect URI:", redirectUri);

    if (fs.existsSync(TOKEN_PATH)) {
      console.error("Found existing token, attempting to use it...");
      const oAuth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      oAuth2Client.setCredentials(token);
      persistTokensOnRefresh(oAuth2Client);
      try {
        await oAuth2Client.getAccessToken();
        return oAuth2Client;
      } catch (tokenErr: any) {
        // Only delete the stored token for real auth failures, not transient network errors
        const code: string = tokenErr?.response?.data?.error ?? tokenErr?.code ?? "";
        const isAuthError = ["invalid_grant", "invalid_token", "TOKEN_EXPIRED"].includes(code);
        if (isAuthError) {
          console.error("Saved token is invalid/expired, deleting and re-authenticating...");
          fs.unlinkSync(TOKEN_PATH);
        } else {
          console.error("Transient error refreshing token (keeping stored token):", tokenErr?.message ?? tokenErr);
          throw tokenErr;
        }
      }
    } else {
      console.error("No token found.");
    }

    return authenticateFresh();
  } catch (err) {
    const e = err as Error;
    console.error("Error authorizing with Google:", err);
    if (e.message) console.error("Error message:", e.message);
    if (e.stack) console.error("Stack trace:", e.stack);
    throw err;
  }
}

// Create Docs and Drive API clients
let docsClient: docs_v1.Docs | undefined;
let driveClient: drive_v3.Drive | undefined;

/**
 * Returns initialized API clients, or throws if OAuth has not completed.
 * Call this at the top of every tool handler.
 */
function getClients(): { docs: docs_v1.Docs; drive: drive_v3.Drive } {
  if (!docsClient || !driveClient) {
    throw new Error(
      "Google API clients not initialized. Check credentials and re-authenticate."
    );
  }
  return { docs: docsClient, drive: driveClient };
}

// Initialize Google API clients
async function initClients() {
  try {
    console.error("Starting client initialization...");
    const auth = await authorize();
    console.error("Auth completed successfully:", !!auth);
    docsClient = google.docs({ version: "v1", auth: auth as any });
    console.error("Docs client created:", !!docsClient);
    driveClient = google.drive({ version: "v3", auth: auth as any });
    console.error("Drive client created:", !!driveClient);
    return true;
  } catch (error) {
    console.error("Failed to initialize Google API clients:", error);
    return false;
  }
}


/** Exclusive end index of the document body (from API structure, not text length). */
function getBodyEndIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content;
  if (!content?.length) return 1;
  const last = content[content.length - 1];
  return last.endIndex ?? 1;
}

/** Append text to the document body using endOfSegmentLocation (avoids segment boundary errors). */
async function appendToDocument(
  documentId: string,
  text: string,
  options?: { leadingNewline?: boolean }
): Promise<void> {
  const leadingNewline = options?.leadingNewline ?? true;
  let textToInsert = text;

  if (leadingNewline) {
    const doc = await getClients().docs.documents.get({ documentId });
    const endIndex = getBodyEndIndex(doc.data);
    if (endIndex > 1 && !text.startsWith("\n")) {
      textToInsert = "\n" + text;
    }
  }

  await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          insertText: {
            endOfSegmentLocation: {
              segmentId: "",
            },
            text: textToInsert,
          },
        },
      ],
    },
  });
}

type IndexRange = { startIndex: number; endIndex: number };

/** Walk paragraphs, tables, etc. and invoke callback for each text run. */
function walkStructuralElements(
  elements: any[] | undefined,
  callback: (text: string, startIndex: number, endIndex: number) => void
): void {
  if (!elements) return;
  for (const element of elements) {
    if (element.paragraph?.elements) {
      for (const pe of element.paragraph.elements) {
        if (pe.textRun?.content != null && pe.startIndex != null && pe.endIndex != null) {
          callback(pe.textRun.content, pe.startIndex, pe.endIndex);
        }
      }
    }
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells || []) {
          walkStructuralElements(cell.content, callback);
        }
      }
    }
  }
}

/** Find UTF-16 index ranges for every occurrence of searchText in the document body. */
function findTextRanges(
  doc: docs_v1.Schema$Document,
  searchText: string,
  matchCase: boolean
): IndexRange[] {
  const ranges: IndexRange[] = [];
  const needle = matchCase ? searchText : searchText.toLowerCase();

  walkStructuralElements(doc.body?.content, (text, startIndex) => {
    const haystack = matchCase ? text : text.toLowerCase();
    let from = 0;
    while (from < haystack.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push({
        startIndex: startIndex + idx,
        endIndex: startIndex + idx + searchText.length,
      });
      from = idx + needle.length;
    }
  });

  return ranges;
}

/** Parse #RGB, #RRGGBB, or named colors to Google Docs rgbColor (0.0—1.0). */
function parseColor(color: string): { red: number; green: number; blue: number } {
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    red: [1, 0, 0],
    green: [0, 0.5, 0],
    blue: [0, 0, 1],
    yellow: [1, 1, 0],
    orange: [1, 0.5, 0],
    gray: [0.5, 0.5, 0.5],
    grey: [0.5, 0.5, 0.5],
  };

  const trimmed = color.trim().toLowerCase();
  if (named[trimmed]) {
    const [red, green, blue] = named[trimmed];
    return { red, green, blue };
  }

  if (trimmed.startsWith("#")) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length !== 6) {
      throw new Error(`Invalid color "${color}". Use #RRGGBB or a name like black, red.`);
    }
    return {
      red: parseInt(hex.slice(0, 2), 16) / 255,
      green: parseInt(hex.slice(2, 4), 16) / 255,
      blue: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }

  throw new Error(`Invalid color "${color}". Use #RRGGBB or a name like black, red.`);
}

interface TextFormatOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  foregroundColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontFamily?: string;
  linkUrl?: string;
  baselineOffset?: "SUPERSCRIPT" | "SUBSCRIPT" | "NONE";
}

interface ParagraphFormatOptions {
  alignment?: string;
  lineSpacing?: number;
  namedStyle?: string;
  spaceAbove?: number;
  spaceBelow?: number;
  indentStart?: number;
  indentEnd?: number;
  indentFirstLine?: number;
  /** Apply font/color to all text in the paragraph range */
  fontFamily?: string;
  fontSize?: number;
  foregroundColor?: string;
  bold?: boolean;
  italic?: boolean;
}

function parseAlignment(alignment: string): string {
  const map: Record<string, string> = {
    left: "START",
    start: "START",
    center: "CENTER",
    right: "END",
    end: "END",
    justify: "JUSTIFIED",
    justified: "JUSTIFIED",
  };
  const key = alignment.trim().toLowerCase();
  const value = map[key];
  if (!value) {
    throw new Error(
      `Invalid alignment "${alignment}". Use left, center, right, or justify.`
    );
  }
  return value;
}

/** 1 = single, 1.15, 1.5, 2 = double → Google Docs lineSpacing (percentage) */
function lineSpacingToApi(multiplier: number): number {
  if (multiplier <= 0) {
    throw new Error("lineSpacing must be positive (e.g. 1, 1.15, 1.5, 2)");
  }
  return Math.round(multiplier * 100);
}

async function resolveTextRanges(
  documentId: string,
  options: {
    findText?: string;
    startIndex?: number;
    endIndex?: number;
    occurrenceIndex?: number;
    matchCase?: boolean;
    confirmBulkEdit?: boolean;
  }
): Promise<IndexRange[]> {
  const { findText, startIndex, endIndex, occurrenceIndex, matchCase = true, confirmBulkEdit } = options;

  if (findText) {
    const doc = await getClients().docs.documents.get({ documentId });
    let ranges = findTextRanges(doc.data, findText, matchCase);
    if (ranges.length === 0) {
      throw new Error(`Text "${findText}" not found in document.`);
    }
    if (occurrenceIndex !== undefined) {
      if (occurrenceIndex < 0 || occurrenceIndex >= ranges.length) {
        throw new Error(
          `occurrenceIndex ${occurrenceIndex} is out of range (${ranges.length} match(es) found).`
        );
      }
      ranges = [ranges[occurrenceIndex]];
    } else {
      warnIfManyMatches(ranges.length, findText, confirmBulkEdit);
    }
    return ranges;
  }

  if (startIndex !== undefined && endIndex !== undefined) {
    if (startIndex >= endIndex) {
      throw new Error("startIndex must be less than endIndex");
    }
    return [{ startIndex, endIndex }];
  }

  throw new Error("Provide findText or both startIndex and endIndex.");
}

/** Paragraphs whose text contains findText (or all paragraphs if findText omitted). */
function findParagraphRanges(
  doc: docs_v1.Schema$Document,
  options: { findText?: string; matchCase?: boolean }
): IndexRange[] {
  const ranges: IndexRange[] = [];
  const { findText, matchCase = true } = options;

  function walk(elements: any[] | undefined): void {
    if (!elements) return;
    for (const element of elements) {
      if (
        element.paragraph &&
        element.startIndex != null &&
        element.endIndex != null
      ) {
        let text = "";
        for (const pe of element.paragraph.elements || []) {
          if (pe.textRun?.content) text += pe.textRun.content;
        }
        const matches =
          !findText ||
          (matchCase
            ? text.includes(findText)
            : text.toLowerCase().includes(findText.toLowerCase()));
        if (matches) {
          ranges.push({
            startIndex: element.startIndex,
            endIndex: element.endIndex,
          });
        }
      }
      if (element.table?.tableRows) {
        for (const row of element.table.tableRows) {
          for (const cell of row.tableCells || []) {
            walk(cell.content);
          }
        }
      }
    }
  }

  walk(doc.body?.content);
  return ranges;
}

/** Every stylable text run inside a paragraph (handles mixed font sizes in one paragraph). */
function getStylableTextRunRanges(element: any): IndexRange[] {
  const ranges: IndexRange[] = [];
  for (const pe of element.paragraph?.elements || []) {
    const content = pe.textRun?.content;
    if (
      content != null &&
      content !== "\n" &&
      pe.startIndex != null &&
      pe.endIndex != null &&
      pe.endIndex > pe.startIndex
    ) {
      ranges.push({ startIndex: pe.startIndex, endIndex: pe.endIndex });
    }
  }
  return ranges;
}

/** Expand paragraph element ranges into per-text-run ranges for reliable full-paragraph styling. */
function expandParagraphRangesToTextRunRanges(
  doc: docs_v1.Schema$Document,
  paragraphRanges: IndexRange[]
): IndexRange[] {
  const textRanges: IndexRange[] = [];
  const paraKeys = new Set(
    paragraphRanges.map((r) => `${r.startIndex}:${r.endIndex}`)
  );

  walkParagraphElements(doc.body?.content, (element) => {
    if (element.startIndex == null || element.endIndex == null) return;
    const key = `${element.startIndex}:${element.endIndex}`;
    if (paraKeys.has(key)) {
      textRanges.push(...getStylableTextRunRanges(element));
    }
  });

  if (textRanges.length === 0) {
    return paragraphRanges.map((r) => ({
      startIndex: r.startIndex,
      endIndex: Math.max(r.startIndex + 1, r.endIndex - 1),
    }));
  }
  return textRanges;
}

async function resolveParagraphRanges(
  documentId: string,
  options: {
    findText?: string;
    startIndex?: number;
    endIndex?: number;
    occurrenceIndex?: number;
    matchCase?: boolean;
    confirmBulkEdit?: boolean;
  }
): Promise<IndexRange[]> {
  const { findText, startIndex, endIndex, occurrenceIndex, matchCase = true, confirmBulkEdit } = options;

  if (startIndex !== undefined && endIndex !== undefined) {
    if (startIndex >= endIndex) {
      throw new Error("startIndex must be less than endIndex");
    }
    return [{ startIndex, endIndex }];
  }

  const doc = await getClients().docs.documents.get({ documentId });
  let ranges = findParagraphRanges(doc.data, { findText, matchCase });

  if (findText && ranges.length === 0) {
    throw new Error(`No paragraph containing "${findText}" found.`);
  }
  if (!findText && ranges.length === 0) {
    throw new Error("No paragraphs found in document.");
  }

  if (occurrenceIndex !== undefined) {
    if (occurrenceIndex < 0 || occurrenceIndex >= ranges.length) {
      throw new Error(
        `occurrenceIndex ${occurrenceIndex} is out of range (${ranges.length} paragraph(s) matched).`
      );
    }
    ranges = [ranges[occurrenceIndex]];
  } else if (findText) {
    // Same bulk-edit guard as resolveTextRanges
    warnIfManyMatches(ranges.length, findText, confirmBulkEdit);
  }

  return ranges;
}

function buildTextStyleRequests(
  ranges: IndexRange[],
  format: TextFormatOptions
): docs_v1.Schema$Request[] {
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];

  if (format.bold !== undefined) {
    textStyle.bold = format.bold;
    fields.push("bold");
  }
  if (format.italic !== undefined) {
    textStyle.italic = format.italic;
    fields.push("italic");
  }
  if (format.underline !== undefined) {
    textStyle.underline = format.underline;
    fields.push("underline");
  }
  if (format.strikethrough !== undefined) {
    textStyle.strikethrough = format.strikethrough;
    fields.push("strikethrough");
  }
  if (format.foregroundColor !== undefined) {
    const rgb = parseColor(format.foregroundColor);
    textStyle.foregroundColor = { color: { rgbColor: rgb } };
    fields.push("foregroundColor");
  }
  if (format.backgroundColor !== undefined) {
    const rgb = parseColor(format.backgroundColor);
    textStyle.backgroundColor = { color: { rgbColor: rgb } };
    fields.push("backgroundColor");
  }
  if (format.fontSize !== undefined) {
    textStyle.fontSize = { magnitude: format.fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (format.fontFamily !== undefined) {
    textStyle.weightedFontFamily = { fontFamily: format.fontFamily };
    fields.push("weightedFontFamily");
  }
  if (format.linkUrl !== undefined) {
    textStyle.link = { url: format.linkUrl };
    fields.push("link");
  }
  if (format.baselineOffset !== undefined) {
    textStyle.baselineOffset = format.baselineOffset;
    fields.push("baselineOffset");
  }

  if (fields.length === 0) {
    throw new Error("At least one format option is required (e.g. foregroundColor, bold, fontSize).");
  }

  const fieldsMask = fields.join(",");

  return ranges.map((range) => ({
    updateTextStyle: {
      range,
      textStyle,
      fields: fieldsMask,
    },
  }));
}

function buildParagraphStyleRequests(
  ranges: IndexRange[],
  format: ParagraphFormatOptions,
  textRunRanges?: IndexRange[]
): docs_v1.Schema$Request[] {
  const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
  const fields: string[] = [];

  if (format.alignment !== undefined) {
    paragraphStyle.alignment = parseAlignment(format.alignment);
    fields.push("alignment");
  }
  if (format.lineSpacing !== undefined) {
    paragraphStyle.lineSpacing = lineSpacingToApi(format.lineSpacing);
    fields.push("lineSpacing");
  }
  if (format.namedStyle !== undefined) {
    paragraphStyle.namedStyleType = format.namedStyle;
    fields.push("namedStyleType");
  }
  if (format.spaceAbove !== undefined) {
    paragraphStyle.spaceAbove = { magnitude: format.spaceAbove, unit: "PT" };
    fields.push("spaceAbove");
  }
  if (format.spaceBelow !== undefined) {
    paragraphStyle.spaceBelow = { magnitude: format.spaceBelow, unit: "PT" };
    fields.push("spaceBelow");
  }
  if (format.indentStart !== undefined) {
    paragraphStyle.indentStart = { magnitude: format.indentStart, unit: "PT" };
    fields.push("indentStart");
  }
  if (format.indentEnd !== undefined) {
    paragraphStyle.indentEnd = { magnitude: format.indentEnd, unit: "PT" };
    fields.push("indentEnd");
  }
  if (format.indentFirstLine !== undefined) {
    paragraphStyle.indentFirstLine = {
      magnitude: format.indentFirstLine,
      unit: "PT",
    };
    fields.push("indentFirstLine");
  }

  const requests: docs_v1.Schema$Request[] = [];

  if (fields.length > 0) {
    const fieldsMask = fields.join(",");
    for (const range of ranges) {
      requests.push({
        updateParagraphStyle: {
          range,
          paragraphStyle,
          fields: fieldsMask,
        },
      });
    }
  }

  const textFormat: TextFormatOptions = {};
  if (format.fontFamily) textFormat.fontFamily = format.fontFamily;
  if (format.fontSize) textFormat.fontSize = format.fontSize;
  if (format.foregroundColor) textFormat.foregroundColor = format.foregroundColor;
  if (format.bold !== undefined) textFormat.bold = format.bold;
  if (format.italic !== undefined) textFormat.italic = format.italic;

  if (Object.keys(textFormat).length > 0) {
    const targets =
      textRunRanges ??
      ranges.map((r) => ({
        startIndex: r.startIndex,
        endIndex: Math.max(r.startIndex + 1, r.endIndex - 1),
      }));
    requests.push(...buildTextStyleRequests(targets, textFormat));
  }

  if (requests.length === 0) {
    throw new Error(
      "At least one paragraph format option is required (alignment, lineSpacing, namedStyle, indent, font, etc.)."
    );
  }

  return requests;
}

async function buildParagraphStyleRequestsForDoc(
  documentId: string,
  ranges: IndexRange[],
  format: ParagraphFormatOptions
): Promise<{ requests: docs_v1.Schema$Request[]; textRunCount: number }> {
  const doc = await getClients().docs.documents.get({ documentId });
  const textRunRanges = expandParagraphRangesToTextRunRanges(doc.data, ranges);
  return {
    requests: buildParagraphStyleRequests(ranges, format, textRunRanges),
    textRunCount: textRunRanges.length,
  };
}

async function applyReplaceText(
  documentId: string,
  findText: string,
  content: string,
  matchCase: boolean
): Promise<number> {
  const response = await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: { text: findText, matchCase },
            replaceText: content,
          },
        },
      ],
    },
  });
  return response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
}

type DocumentEditOperation =
  | {
    type: "append";
    content: string;
    leadingNewline?: boolean;
  }
  | {
    type: "replaceText";
    findText: string;
    content: string;
    matchCase?: boolean;
  }
  | {
    type: "formatText";
    findText?: string;
    startIndex?: number;
    endIndex?: number;
    occurrenceIndex?: number;
    matchCase?: boolean;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    foregroundColor?: string;
    backgroundColor?: string;
    fontSize?: number;
    fontFamily?: string;
    linkUrl?: string;
    baselineOffset?: "SUPERSCRIPT" | "SUBSCRIPT" | "NONE";
    confirmBulkEdit?: boolean;
  }
  | {
    type: "formatParagraph";
    findText?: string;
    startIndex?: number;
    endIndex?: number;
    occurrenceIndex?: number;
    matchCase?: boolean;
    alignment?: string;
    lineSpacing?: number;
    namedStyle?: string;
    spaceAbove?: number;
    spaceBelow?: number;
    indentStart?: number;
    indentEnd?: number;
    indentFirstLine?: number;
    fontFamily?: string;
    fontSize?: number;
    foregroundColor?: string;
    bold?: boolean;
    italic?: boolean;
    confirmBulkEdit?: boolean;
  }
  | {
    type: "insertText";
    content: string;
    index?: number;
    afterHeading?: string;
    beforeText?: string;
    afterText?: string;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
  | {
    type: "insertPageBreak";
    index?: number;
    afterHeading?: string;
    beforeText?: string;
    afterText?: string;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
  | {
    type: "createList";
    items: string[];
    listType?: "bullet" | "numbered";
    afterHeading?: string;
    afterText?: string;
    beforeText?: string;
    append?: boolean;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
  | {
    type: "applyPreset";
    preset: StylePreset;
    findText?: string;
    matchCase?: boolean;
  }
  | {
    type: "clearFormatting";
    findText?: string;
    startIndex?: number;
    endIndex?: number;
    occurrenceIndex?: number;
    matchCase?: boolean;
    confirmBulkEdit?: boolean;
  }
  | {
    type: "insertSceneBreak";
    afterHeading?: string;
    afterText?: string;
    beforeText?: string;
    usePageBreak?: boolean;
    matchCase?: boolean;
    occurrenceIndex?: number;
  };

async function applyDocumentEdit(
  documentId: string,
  operation: DocumentEditOperation
): Promise<string> {
  switch (operation.type) {
    case "append": {
      await appendToDocument(documentId, operation.content, {
        leadingNewline: operation.leadingNewline,
      });
      return "Appended text";
    }
    case "replaceText": {
      const n = await applyReplaceText(
        documentId,
        operation.findText,
        operation.content,
        operation.matchCase ?? true
      );
      return `Replaced ${n} occurrence(s) of "${operation.findText}"`;
    }
    case "formatText": {
      const ranges = await resolveTextRanges(documentId, operation);
      const format: TextFormatOptions = {
        bold: operation.bold,
        italic: operation.italic,
        underline: operation.underline,
        strikethrough: operation.strikethrough,
        foregroundColor: operation.foregroundColor,
        backgroundColor: operation.backgroundColor,
        fontSize: operation.fontSize,
        fontFamily: operation.fontFamily,
        linkUrl: operation.linkUrl,
        baselineOffset: operation.baselineOffset,
      };
      const requests = buildTextStyleRequests(ranges, format);
      await getClients().docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });
      return `Formatted ${ranges.length} text range(s)`;
    }
    case "formatParagraph": {
      const ranges = await resolveParagraphRanges(documentId, operation);
      const format: ParagraphFormatOptions = {
        alignment: operation.alignment,
        lineSpacing: operation.lineSpacing,
        namedStyle: operation.namedStyle,
        spaceAbove: operation.spaceAbove,
        spaceBelow: operation.spaceBelow,
        indentStart: operation.indentStart,
        indentEnd: operation.indentEnd,
        indentFirstLine: operation.indentFirstLine,
        fontFamily: operation.fontFamily,
        fontSize: operation.fontSize,
        foregroundColor: operation.foregroundColor,
        bold: operation.bold,
        italic: operation.italic,
      };
      const { requests, textRunCount } = await buildParagraphStyleRequestsForDoc(
        documentId,
        ranges,
        format
      );
      await getClients().docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });
      return `Formatted ${ranges.length} paragraph(s), ${textRunCount} text run(s)`;
    }
    case "insertText": {
      const index = await resolveInsertIndex(documentId, operation);
      // Append a trailing newline when inserting before existing text so the
      // new content ends up on its own line rather than merged with the target.
      const suffix = operation.beforeText ? "\n" : "";
      await insertTextAtIndex(documentId, index, operation.content + suffix);
      return `Inserted text at index ${index}`;
    }
    case "insertPageBreak": {
      const index = await resolveInsertIndex(documentId, operation);
      await insertPageBreakAtIndex(documentId, index);
      return `Inserted page break at index ${index}`;
    }
    case "createList": {
      return await createListInDocument(documentId, operation.items, operation);
    }
    case "applyPreset": {
      return await applyStylePresetToDocument(documentId, operation.preset, {
        findText: operation.findText,
        matchCase: operation.matchCase,
      });
    }
    case "clearFormatting": {
      const ranges = await resolveTextRanges(documentId, operation);
      const requests = buildClearFormattingRequests(ranges);
      await getClients().docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });
      return `Cleared formatting on ${ranges.length} range(s)`;
    }
    case "insertSceneBreak": {
      return await insertSceneBreak(documentId, operation);
    }
    default:
      throw new Error(`Unknown operation type`);
  }
}

const BULK_MATCH_WARNING_THRESHOLD = 10;
const STYLE_PRESETS = [
  "essay-mla",
  "essay-apa",
  "manuscript",
  "cover-letter",
  "notes",
] as const;
type StylePreset = (typeof STYLE_PRESETS)[number];

interface OutlineEntry {
  level: number;
  style: string;
  text: string;
  startIndex: number;
  endIndex: number;
}

interface DocStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
  headings: number;
  readingTimeMinutes: number;
}

function headingLevelFromStyle(style?: string | null): number | null {
  if (!style) return null;
  if (style === "TITLE") return 0;
  if (style === "SUBTITLE") return 0;
  const m = style.match(/^HEADING_(\d)$/);
  return m ? parseInt(m[1], 10) : null;
}

function warnIfManyMatches(
  count: number,
  findText: string,
  confirmBulkEdit?: boolean
): void {
  if (count > BULK_MATCH_WARNING_THRESHOLD && !confirmBulkEdit) {
    throw new Error(
      `Found ${count} matches for "${findText}" (threshold ${BULK_MATCH_WARNING_THRESHOLD}). ` +
      `Use occurrenceIndex for one match, or set confirmBulkEdit: true to apply to all.`
    );
  }
}

function getParagraphText(element: any): string {
  let text = "";
  for (const pe of element.paragraph?.elements || []) {
    if (pe.textRun?.content) text += pe.textRun.content;
  }
  return text.replace(/\n$/, "");
}

function walkParagraphElements(
  elements: any[] | undefined,
  callback: (element: any) => void
): void {
  if (!elements) return;
  for (const element of elements) {
    if (element.paragraph) callback(element);
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells || []) {
          walkParagraphElements(cell.content, callback);
        }
      }
    }
  }
}

function extractOutlineFromDoc(doc: docs_v1.Schema$Document): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  walkParagraphElements(doc.body?.content, (element) => {
    const style = element.paragraph?.paragraphStyle?.namedStyleType;
    const level = headingLevelFromStyle(style);
    if (level === null) return;
    const text = getParagraphText(element).trim();
    if (!text) return;
    outline.push({
      level,
      style: style || "UNKNOWN",
      text,
      startIndex: element.startIndex ?? 1,
      endIndex: element.endIndex ?? 1,
    });
  });
  return outline;
}

function computeDocStats(text: string, outline: OutlineEntry[]): DocStats {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, "").length;
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0).length;
  return {
    words,
    characters,
    charactersNoSpaces,
    paragraphs,
    headings: outline.length,
    readingTimeMinutes: Math.max(1, Math.ceil(words / 200)),
  };
}

function formatOutlineText(outline: OutlineEntry[]): string {
  if (!outline.length) return "(no headings found)\n";
  return (
    outline
      .map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}H${h.level || "?"}: ${h.text}`)
      .join("\n") + "\n"
  );
}

function formatStatsText(stats: DocStats): string {
  return (
    `Words: ${stats.words}\n` +
    `Characters: ${stats.characters} (${stats.charactersNoSpaces} without spaces)\n` +
    `Paragraphs: ${stats.paragraphs}\n` +
    `Headings: ${stats.headings}\n` +
    `Est. reading time: ~${stats.readingTimeMinutes} min\n`
  );
}

function getAllBodyParagraphRanges(doc: docs_v1.Schema$Document): IndexRange[] {
  const ranges: IndexRange[] = [];
  walkParagraphElements(doc.body?.content, (element) => {
    if (element.startIndex != null && element.endIndex != null) {
      ranges.push({ startIndex: element.startIndex, endIndex: element.endIndex });
    }
  });
  return ranges;
}

function findParagraphContaining(
  doc: docs_v1.Schema$Document,
  searchText: string,
  options?: {
    matchCase?: boolean;
    headingOnly?: boolean;
    occurrenceIndex?: number;
  }
): IndexRange | null {
  const { matchCase = true, headingOnly = false, occurrenceIndex = 0 } = options || {};
  const matches: IndexRange[] = [];

  walkParagraphElements(doc.body?.content, (element) => {
    const style = element.paragraph?.paragraphStyle?.namedStyleType;
    if (headingOnly && headingLevelFromStyle(style) === null) return;

    const text = getParagraphText(element);
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? searchText : searchText.toLowerCase();
    if (!hay.includes(needle)) return;
    if (element.startIndex != null && element.endIndex != null) {
      matches.push({ startIndex: element.startIndex, endIndex: element.endIndex });
    }
  });

  return matches[occurrenceIndex] ?? null;
}

async function insertTextAtIndex(
  documentId: string,
  index: number,
  text: string
): Promise<void> {
  await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertText: { location: { index }, text } }],
    },
  });
}

async function insertPageBreakAtIndex(
  documentId: string,
  index: number
): Promise<void> {
  await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertPageBreak: { location: { index } } }],
    },
  });
}

async function resolveInsertIndex(
  documentId: string,
  options: {
    index?: number;
    afterHeading?: string;
    beforeText?: string;
    afterText?: string;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
): Promise<number> {
  if (options.index !== undefined) return options.index;

  const doc = await getClients().docs.documents.get({ documentId });
  const data = doc.data;

  if (options.afterHeading) {
    const para = findParagraphContaining(data, options.afterHeading, {
      headingOnly: true,
      matchCase: options.matchCase,
      occurrenceIndex: options.occurrenceIndex,
    });
    if (!para) {
      throw new Error(`Heading "${options.afterHeading}" not found.`);
    }
    return para.endIndex - 1;
  }

  if (options.beforeText) {
    const ranges = findTextRanges(data, options.beforeText, options.matchCase ?? true);
    if (!ranges.length) throw new Error(`Text "${options.beforeText}" not found.`);
    const idx = options.occurrenceIndex ?? 0;
    if (idx < 0 || idx >= ranges.length) {
      throw new Error(`occurrenceIndex ${idx} out of range (${ranges.length} matches).`);
    }
    return ranges[idx].startIndex;
  }

  if (options.afterText) {
    const ranges = findTextRanges(data, options.afterText, options.matchCase ?? true);
    if (!ranges.length) throw new Error(`Text "${options.afterText}" not found.`);
    const idx = options.occurrenceIndex ?? 0;
    if (idx < 0 || idx >= ranges.length) {
      throw new Error(`occurrenceIndex ${idx} out of range (${ranges.length} matches).`);
    }
    return ranges[idx].endIndex;
  }

  throw new Error("Provide index, afterHeading, beforeText, or afterText.");
}

function buildClearFormattingRequests(ranges: IndexRange[]): docs_v1.Schema$Request[] {
  return ranges.map((range) => ({
    updateTextStyle: {
      range,
      textStyle: {
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
        backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
        fontSize: { magnitude: 11, unit: "PT" },
        weightedFontFamily: { fontFamily: "Arial" },
        link: null,
        baselineOffset: "NONE",
      },
      fields:
        "bold,italic,underline,strikethrough,foregroundColor,backgroundColor,fontSize,weightedFontFamily,link,baselineOffset",
    },
  }));
}

function buildDocumentMarginRequest(marginPt: number): docs_v1.Schema$Request {
  const margin = { magnitude: marginPt, unit: "PT" as const };
  return {
    updateDocumentStyle: {
      documentStyle: {
        marginTop: margin,
        marginBottom: margin,
        marginLeft: margin,
        marginRight: margin,
      },
      fields: "marginTop,marginBottom,marginLeft,marginRight",
    },
  };
}

function presetParagraphFormat(preset: StylePreset): ParagraphFormatOptions {
  switch (preset) {
    case "essay-mla":
    case "essay-apa":
      return {
        lineSpacing: 2,
        fontFamily: "Times New Roman",
        fontSize: 12,
        indentFirstLine: 36,
      };
    case "manuscript":
      return {
        lineSpacing: 2,
        fontFamily: "Courier New",
        fontSize: 12,
      };
    case "cover-letter":
      return {
        lineSpacing: 1.15,
        fontFamily: "Arial",
        fontSize: 11,
        alignment: "left",
      };
    case "notes":
      return {
        lineSpacing: 1.15,
        fontFamily: "Arial",
        fontSize: 11,
      };
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

async function applyStylePresetToDocument(
  documentId: string,
  preset: StylePreset,
  scope?: { findText?: string; matchCase?: boolean }
): Promise<string> {
  const doc = await getClients().docs.documents.get({ documentId });
  let ranges = getAllBodyParagraphRanges(doc.data);

  if (scope?.findText) {
    ranges = findParagraphRanges(doc.data, {
      findText: scope.findText,
      matchCase: scope.matchCase,
    });
    if (!ranges.length) {
      throw new Error(`No paragraphs containing "${scope.findText}" found.`);
    }
  }

  const paragraphFormat = presetParagraphFormat(preset);
  const requests: docs_v1.Schema$Request[] = [];

  if (preset === "essay-mla" || preset === "essay-apa") {
    requests.push(buildDocumentMarginRequest(72));
  }

  const textRunRanges = expandParagraphRangesToTextRunRanges(doc.data, ranges);
  requests.push(
    ...buildParagraphStyleRequests(ranges, paragraphFormat, textRunRanges)
  );

  await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });

  return `Applied preset "${preset}" to ${ranges.length} paragraph(s), ${textRunRanges.length} text run(s)`;
}

async function createListInDocument(
  documentId: string,
  items: string[],
  options: {
    listType?: "bullet" | "numbered";
    afterHeading?: string;
    afterText?: string;
    beforeText?: string;
    append?: boolean;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
): Promise<string> {
  if (!items.length) throw new Error("At least one list item is required.");

  const listText = items.map((item) => `${item}\n`).join("");
  let insertIndex: number;

  if (options.append) {
    const doc = await getClients().docs.documents.get({ documentId });
    insertIndex = getBodyEndIndex(doc.data) - 1;
    const prefix = insertIndex > 1 ? "\n" : "";
    await insertTextAtIndex(documentId, insertIndex, prefix + listText);
    insertIndex += prefix.length;
  } else {
    insertIndex = await resolveInsertIndex(documentId, {
      afterHeading: options.afterHeading,
      afterText: options.afterText,
      beforeText: options.beforeText,
      matchCase: options.matchCase,
      occurrenceIndex: options.occurrenceIndex,
    });
    const leading = options.beforeText ? "" : "\n";
    await insertTextAtIndex(documentId, insertIndex, leading + listText);
    insertIndex += leading.length;
  }

  const endIndex = insertIndex + listText.length;
  const bulletPreset =
    options.listType === "numbered"
      ? "NUMBERED_DECIMAL_NESTED"
      : "BULLET_DISC_CIRCLE_SQUARE";

  await getClients().docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          createParagraphBullets: {
            range: { startIndex: insertIndex, endIndex },
            bulletPreset,
          },
        },
      ],
    },
  });

  return `Created ${options.listType || "bullet"} list with ${items.length} item(s)`;
}

async function generateTitlePageContent(
  documentId: string,
  fields: {
    title: string;
    subtitle?: string;
    author?: string;
    course?: string;
    instructor?: string;
    date?: string;
  }
): Promise<string> {
  const lines: string[] = ["\n"];
  lines.push(`${fields.title}\n`);
  if (fields.subtitle) lines.push(`${fields.subtitle}\n`);
  lines.push("\n");
  if (fields.author) lines.push(`${fields.author}\n`);
  if (fields.course) lines.push(`${fields.course}\n`);
  if (fields.instructor) lines.push(`${fields.instructor}\n`);
  if (fields.date) lines.push(`${fields.date}\n`);
  lines.push("\n");

  const block = lines.join("");
  await insertTextAtIndex(documentId, 1, block);

  let doc = await getClients().docs.documents.get({ documentId });
  const titlePara = findParagraphContaining(doc.data, fields.title, { matchCase: true });
  if (titlePara) {
    await getClients().docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          ...buildParagraphStyleRequests([titlePara], {
            alignment: "center",
            namedStyle: "TITLE",
            spaceBelow: 12,
          }),
          ...buildTextStyleRequests(
            [{ startIndex: titlePara.startIndex, endIndex: Math.max(titlePara.startIndex + 1, titlePara.endIndex - 1) }],
            { bold: true, fontSize: 24, fontFamily: "Times New Roman" }
          ),
        ],
      },
    });
  }

  doc = await getClients().docs.documents.get({ documentId });
  const centerLines = [fields.author, fields.course, fields.instructor, fields.date].filter(Boolean) as string[];
  const centerRequests: docs_v1.Schema$Request[] = [];
  for (const line of centerLines) {
    const para = findParagraphContaining(doc.data, line, { matchCase: true });
    if (para) {
      centerRequests.push(
        ...buildParagraphStyleRequests([para], { alignment: "center", fontFamily: "Times New Roman", fontSize: 12 })
      );
    }
  }
  if (centerRequests.length > 0) {
    await getClients().docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: centerRequests },
    });
  }

  return "Title page inserted at document start";
}

async function insertSceneBreak(
  documentId: string,
  options: {
    afterHeading?: string;
    afterText?: string;
    beforeText?: string;
    usePageBreak?: boolean;
    matchCase?: boolean;
    occurrenceIndex?: number;
  }
): Promise<string> {
  const index = await resolveInsertIndex(documentId, options);
  if (options.usePageBreak !== false) {
    await insertPageBreakAtIndex(documentId, index);
    return "Inserted page break";
  }
  const line = "\n* * *\n";
  await insertTextAtIndex(documentId, index, line);
  const doc = await getClients().docs.documents.get({ documentId });
  const para = findParagraphContaining(doc.data, "* * *", { matchCase: true });
  if (para) {
    await getClients().docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: buildParagraphStyleRequests([para], { alignment: "center", spaceAbove: 12, spaceBelow: 12 }),
      },
    });
  }
  return "Inserted scene break (* * *)";
}

// Recursively extract plain text from a document body
function extractTextFromBody(body: any): string {
  let text = "";
  walkStructuralElements(body?.content, (runText) => {
    text += runText;
  });
  return text;
}

// Walk the tab tree (tabs can be nested via childTabs) and return a flat list
function flattenTabs(tabs: any[]): { tabId: string; title: string; index: number; nestingLevel: number; body: any }[] {
  const result: { tabId: string; title: string; index: number; nestingLevel: number; body: any }[] = [];
  for (const tab of tabs || []) {
    const p = tab.tabProperties || {};
    result.push({
      tabId: p.tabId ?? "",
      title: p.title ?? `Tab ${p.index ?? ""}`,
      index: p.index ?? 0,
      nestingLevel: p.nestingLevel ?? 0,
      body: tab.documentTab?.body,
    });
    if (tab.childTabs?.length) result.push(...flattenTabs(tab.childTabs));
  }
  return result;
}

// TOOLS

// Tool to create a new document
registerTool(
  "create-doc",
  {
    title: z.string().describe("The title of the new document"),
    content: z.string().optional().describe("Optional initial content for the document"),
  },
  async ({ title, content = "" }) => {
    try {
      const { docs } = getClients();
      // Create a new document
      const doc = await docs.documents.create({
        requestBody: {
          title: title,
        },
      });

      const documentId = doc.data.documentId;

      // If content was provided, add it to the document
      if (content) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: {
                    index: 1,
                  },
                  text: content,
                },
              },
            ],
          },
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Document created successfully!\nTitle: ${title}\nDocument ID: ${documentId}\nYou can now reference this document using: googledocs://${documentId}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error creating document:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error creating document: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool to update an existing document
registerTool(
  "update-doc",
  {
    docId: z.string().describe("The ID of the document to update"),
    content: z.string().optional().describe("Text to append, new full document (when replaceEntireDocument is true), or replacement text (when findText is set)"),
    findText: z.string().optional().describe("Find/replace specific text. For middle-of-doc inserts use insert-text instead."),
    replaceEntireDocument: z.boolean().optional().describe("If true, delete entire document and insert content. If false, append content. Ignored when findText is set. Default: false"),
    matchCase: z.boolean().optional().describe("Case-sensitive search when using findText. Default: true"),
    leadingNewline: z.boolean().optional().describe("When appending, prepend a newline before content if the doc is non-empty. Default: true"),
    confirmBulkEdit: z.boolean().optional().describe("Required when findText matches more than 10 places. Default: false"),
  },
  async ({ docId, content, findText, replaceEntireDocument, matchCase = true, leadingNewline = true, confirmBulkEdit }) => {

    try {
      const { docs } = getClients();
      // Ensure docId is a string and not null/undefined
      if (!docId) {
        throw new Error("Document ID is required");
      }

      const wipeAndReplace = replaceEntireDocument ?? false;

      const documentId = docId.toString();

      if (findText) {
        if (content === undefined) {
          throw new Error("content is required when findText is set (used as the replacement text)");
        }

        const doc = await docs.documents.get({ documentId });
        const matchCount = findTextRanges(doc.data, findText, matchCase).length;
        warnIfManyMatches(matchCount, findText, confirmBulkEdit);

        const response = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                replaceAllText: {
                  containsText: {
                    text: findText,
                    matchCase,
                  },
                  replaceText: content,
                },
              },
            ],
          },
        });

        const occurrencesChanged =
          response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;

        return {
          content: [
            {
              type: "text",
              text: `Replaced ${occurrencesChanged} occurrence(s) of "${findText}" in document ${docId}`,
            },
          ],
        };
      }

      if (content === undefined) {
        throw new Error("content is required when findText is not set");
      }

      if (wipeAndReplace) {
        const doc = await docs.documents.get({ documentId });
        const endIndex = getBodyEndIndex(doc.data);

        const requests: docs_v1.Schema$Request[] = [];
        if (endIndex > 1) {
          requests.push({
            deleteContentRange: {
              range: {
                startIndex: 1,
                endIndex,
              },
            },
          });
        }
        requests.push({
          insertText: {
            location: { index: 1 },
            text: content,
          },
        });

        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests },
        });
      } else {
        await appendToDocument(documentId, content, { leadingNewline });
      }

      return {
        content: [
          {
            type: "text",
            text: `Document updated successfully!\nDocument ID: ${docId}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error updating document:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error updating document: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool to apply text formatting (color, bold, font size, etc.)
registerTool(
  "format-text",
  {
    docId: z
      .string()
      .describe(
        "Document ID. Character-level styling only. For ENTIRE paragraph font/size use format-paragraph, not format-text."
      ),
    findText: z.string().optional().describe("Apply formatting to every occurrence of this text (or use occurrenceIndex for one match)"),
    startIndex: z.number().optional().describe("Start index (UTF-16) of range to format; use with endIndex instead of findText"),
    endIndex: z.number().optional().describe("End index (UTF-16, exclusive) of range to format"),
    occurrenceIndex: z.number().optional().describe("0-based index when multiple findText matches exist; omit to format all matches"),
    matchCase: z.boolean().optional().describe("Case-sensitive search when using findText. Default: true"),
    bold: z.boolean().optional().describe("Bold text"),
    italic: z.boolean().optional().describe("Italic text"),
    underline: z.boolean().optional().describe("Underline text"),
    strikethrough: z.boolean().optional().describe("Strikethrough text"),
    foregroundColor: z
      .string()
      .optional()
      .describe("Text color: hex (#000000) or name (black, red, blue, white, etc.)"),
    backgroundColor: z
      .string()
      .optional()
      .describe("Highlight/background color: hex or name"),
    fontSize: z.number().optional().describe("Font size in points"),
    fontFamily: z.string().optional().describe("Font family name, e.g. Arial, Times New Roman"),
    linkUrl: z.string().optional().describe("Hyperlink URL for the selected text"),
    baselineOffset: z
      .enum(["SUPERSCRIPT", "SUBSCRIPT", "NONE"])
      .optional()
      .describe("Superscript or subscript"),
    confirmBulkEdit: z
      .boolean()
      .optional()
      .describe("Set true when findText matches more than 10 places"),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");

      const documentId = params.docId.toString();
      const {
        docId: _docId,
        findText,
        startIndex,
        endIndex,
        occurrenceIndex,
        matchCase = true,
        confirmBulkEdit,
        bold,
        italic,
        underline,
        strikethrough,
        foregroundColor,
        backgroundColor,
        fontSize,
        fontFamily,
        linkUrl,
        baselineOffset,
      } = params;

      const format: TextFormatOptions = {
        bold,
        italic,
        underline,
        strikethrough,
        foregroundColor,
        backgroundColor,
        fontSize,
        fontFamily,
        linkUrl,
        baselineOffset,
      };

      const ranges = await resolveTextRanges(documentId, {
        findText,
        startIndex,
        endIndex,
        occurrenceIndex,
        matchCase,
        confirmBulkEdit,
      });

      const requests = buildTextStyleRequests(ranges, format);

      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });

      return {
        content: [
          {
            type: "text",
            text: `Applied formatting to ${ranges.length} range(s) in document ${params.docId}.`,
          },
        ],
      };
    } catch (error) {
      console.error("Error formatting text:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error formatting text: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool for paragraph layout: alignment, line spacing, indents, heading styles
registerTool(
  "format-paragraph",
  {
    docId: z
      .string()
      .describe(
        "Document ID. Use for ENTIRE paragraph: fontSize, fontFamily, alignment, line spacing, indents, headings. findText matches any paragraph containing that phrase and styles the WHOLE paragraph."
      ),
    findText: z
      .string()
      .optional()
      .describe("Format paragraph(s) containing this text; omit to target by index only"),
    startIndex: z.number().optional().describe("Paragraph range start (UTF-16)"),
    endIndex: z.number().optional().describe("Paragraph range end (UTF-16, exclusive)"),
    occurrenceIndex: z.number().optional().describe("0-based paragraph match when findText matches multiple"),
    matchCase: z.boolean().optional().describe("Case-sensitive findText. Default: true"),
    alignment: z
      .string()
      .optional()
      .describe("left, center, right, or justify"),
    lineSpacing: z
      .number()
      .optional()
      .describe("Line spacing multiplier: 1 (single), 1.15, 1.5, 2 (double), etc."),
    namedStyle: z
      .string()
      .optional()
      .describe("Heading style: NORMAL_TEXT, TITLE, SUBTITLE, HEADING_1 … HEADING_6"),
    spaceAbove: z.number().optional().describe("Space before paragraph in points"),
    spaceBelow: z.number().optional().describe("Space after paragraph in points"),
    indentStart: z.number().optional().describe("Left indent in points"),
    indentEnd: z.number().optional().describe("Right indent in points"),
    indentFirstLine: z.number().optional().describe("First-line indent in points"),
    fontFamily: z.string().optional().describe("Font for all text in the paragraph"),
    fontSize: z.number().optional().describe("Font size in points for paragraph text"),
    foregroundColor: z.string().optional().describe("Text color for paragraph (hex or name)"),
    bold: z.boolean().optional().describe("Bold all text in the paragraph"),
    italic: z.boolean().optional().describe("Italic all text in the paragraph"),
    confirmBulkEdit: z.boolean().optional().describe("Set true when findText matches more than 10 paragraphs"),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

      const ranges = await resolveParagraphRanges(documentId, {
        findText: params.findText,
        startIndex: params.startIndex,
        endIndex: params.endIndex,
        occurrenceIndex: params.occurrenceIndex,
        matchCase: params.matchCase,
        confirmBulkEdit: params.confirmBulkEdit,
      });

      const format: ParagraphFormatOptions = {
        alignment: params.alignment,
        lineSpacing: params.lineSpacing,
        namedStyle: params.namedStyle,
        spaceAbove: params.spaceAbove,
        spaceBelow: params.spaceBelow,
        indentStart: params.indentStart,
        indentEnd: params.indentEnd,
        indentFirstLine: params.indentFirstLine,
        fontFamily: params.fontFamily,
        fontSize: params.fontSize,
        foregroundColor: params.foregroundColor,
        bold: params.bold,
        italic: params.italic,
      };
      const { requests, textRunCount } = await buildParagraphStyleRequestsForDoc(
        documentId,
        ranges,
        format
      );

      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });

      return {
        content: [
          {
            type: "text",
            text: `Applied paragraph formatting to ${ranges.length} paragraph(s) (${textRunCount} text runs) in document ${params.docId}. All words in the matched paragraph(s) were styled uniformly.`,
          },
        ],
      };
    } catch (error) {
      console.error("Error formatting paragraph:", error);
      return {
        content: [{ type: "text", text: `Error formatting paragraph: ${error}` }],
        isError: true,
      };
    }
  }
);

const documentEditOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("append"),
    content: z.string(),
    leadingNewline: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("replaceText"),
    findText: z.string(),
    content: z.string(),
    matchCase: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("formatText"),
    findText: z.string().optional(),
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    occurrenceIndex: z.number().optional(),
    matchCase: z.boolean().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    foregroundColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    fontSize: z.number().optional(),
    fontFamily: z.string().optional(),
    linkUrl: z.string().optional(),
    baselineOffset: z.enum(["SUPERSCRIPT", "SUBSCRIPT", "NONE"]).optional(),
    confirmBulkEdit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("formatParagraph"),
    findText: z.string().optional(),
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    occurrenceIndex: z.number().optional(),
    matchCase: z.boolean().optional(),
    alignment: z.string().optional(),
    lineSpacing: z.number().optional(),
    namedStyle: z.string().optional(),
    spaceAbove: z.number().optional(),
    spaceBelow: z.number().optional(),
    indentStart: z.number().optional(),
    indentEnd: z.number().optional(),
    indentFirstLine: z.number().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().optional(),
    foregroundColor: z.string().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    confirmBulkEdit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("insertText"),
    content: z.string(),
    index: z.number().optional(),
    afterHeading: z.string().optional(),
    beforeText: z.string().optional(),
    afterText: z.string().optional(),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  }),
  z.object({
    type: z.literal("insertPageBreak"),
    index: z.number().optional(),
    afterHeading: z.string().optional(),
    beforeText: z.string().optional(),
    afterText: z.string().optional(),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  }),
  z.object({
    type: z.literal("createList"),
    items: z.array(z.string()).min(1),
    listType: z.enum(["bullet", "numbered"]).optional(),
    afterHeading: z.string().optional(),
    afterText: z.string().optional(),
    beforeText: z.string().optional(),
    append: z.boolean().optional(),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  }),
  z.object({
    type: z.literal("applyPreset"),
    preset: z.enum(STYLE_PRESETS),
    findText: z.string().optional(),
    matchCase: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("clearFormatting"),
    findText: z.string().optional(),
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    occurrenceIndex: z.number().optional(),
    matchCase: z.boolean().optional(),
    confirmBulkEdit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("insertSceneBreak"),
    afterHeading: z.string().optional(),
    afterText: z.string().optional(),
    beforeText: z.string().optional(),
    usePageBreak: z.boolean().optional(),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  }),
]);

// All-in-one document editor: run multiple updates in one call
registerTool(
  "edit-document",
  {
    docId: z.string().describe("Document ID. Best for multi-step writer/student formatting workflows."),
    operations: z
      .array(documentEditOperationSchema)
      .min(1)
      .describe(
        "Ordered edits: append, replaceText, formatText, formatParagraph, insertText, insertPageBreak, createList, applyPreset, clearFormatting, insertSceneBreak."
      ),
  },
  async ({ docId, operations }) => {
    try {
      const { docs } = getClients();
      if (!docId) throw new Error("Document ID is required");
      const documentId = docId.toString();
      const results: string[] = [];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] as DocumentEditOperation;
        const summary = await applyDocumentEdit(documentId, op);
        results.push(`${i + 1}. ${summary}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Document ${docId} updated (${operations.length} operation(s)):\n${results.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error in edit-document:", error);
      return {
        content: [{ type: "text", text: `Error editing document: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool to search for documents
registerTool(
  "search-docs",
  {
    query: z.string().describe("The search query to find documents"),
  },
  async ({ query }) => {
    try {
      const { drive } = getClients();
      const safeQuery = escapeDriveQueryValue(query);
      const response = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.document' and fullText contains '${safeQuery}'`,
        fields: "files(id, name, createdTime, modifiedTime)",
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      });

      // Add better response validation
      if (!response || !response.data) {
        throw new Error("Invalid response from Google Drive API");
      }

      // Add null check and default to empty array
      const files = (response.data.files || []);

      let content = `Search results for "${query}":\n\n`;

      if (files.length === 0) {
        content += "No documents found matching your query.";
      } else {
        files.forEach((file: any) => {
          content += `Title: ${file.name}\n`;
          content += `ID: ${file.id}\n`;
          content += `Created: ${file.createdTime}\n`;
          content += `Last Modified: ${file.modifiedTime}\n\n`;
        });
        if (files.length >= 10) {
          content += "\nNote: Results are limited to 10. Refine your query to find specific documents.";
        }
      }

      return {
        content: [
          {
            type: "text",
            text: content,
          },
        ],
      };
    } catch (error) {
      console.error("Error searching documents:", error);
      // Include more detailed error information
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      return {
        content: [
          {
            type: "text",
            text: `Error searching documents: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool to delete a document
registerTool(
  "delete-doc",
  {
    docId: z.string().describe("The ID of the document to delete"),
    confirm: z.boolean().describe("Must be true to confirm permanent deletion. Fetch the document title first so the user knows what will be deleted."),
  },
  async ({ docId, confirm }) => {
    try {
      const { docs, drive } = getClients();
      // Get the document title first so the caller (and the user) knows what will be deleted
      const doc = await docs.documents.get({ documentId: docId });
      const title = doc.data.title;

      if (!confirm) {
        return {
          content: [{
            type: "text",
            text: `Document to be deleted: "${title}" (ID: ${docId}).\nTo permanently delete it, call delete-doc again with confirm: true.`,
          }],
        };
      }

      // Delete the document
      await drive.files.delete({
        fileId: docId,
      });

      return {
        content: [
          {
            type: "text",
            text: `Document "${title}" (ID: ${docId}) has been successfully deleted.`,
          },
        ],
      };
    } catch (error) {
      console.error(`Error deleting document ${docId}:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Error deleting document: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool to list all documents
registerTool(
  "list-docs",
  {},
  async () => {
    try {
      const { drive } = getClients();
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.document'",
        fields: "files(id, name, createdTime, modifiedTime)",
        pageSize: 50,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      });

      const files = response.data.files || [];
      let content = "Google Docs in your Drive:\n\n";

      if (files.length === 0) {
        content += "No Google Docs found.";
      } else {
        files.forEach((file: any) => {
          content += `Title: ${file.name}\n`;
          content += `ID: ${file.id}\n`;
          content += `Created: ${file.createdTime}\n`;
          content += `Last Modified: ${file.modifiedTime}\n\n`;
        });
        if (files.length >= 50) {
          content += "\nNote: Results are limited to 50. Use search-docs with a query to narrow results.";
        }
      }

      return {
        content: [
          {
            type: "text",
            text: content,
          },
        ],
      };
    } catch (error) {
      console.error("Error listing documents:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error listing documents: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool to get a specific document by ID
registerTool(
  "get-doc",
  {
    docId: z.string().describe("The ID of the document to retrieve"),
    includeOutline: z.boolean().optional().describe("Include heading outline. Default: true"),
    includeStats: z.boolean().optional().describe("Include word count and reading stats. Default: true"),
  },
  async ({ docId, includeOutline = true, includeStats = true }) => {
    try {
      const { docs } = getClients();
      const doc = await docs.documents.get({
        documentId: docId,
        includeTabsContent: true,
      } as any);

      const document = doc.data;
      let content = `Document: ${document.title}\nID: ${docId}\n\n`;

      const tabs = flattenTabs((document as any).tabs || []);
      let bodyText = "";
      if (tabs.length > 0) {
        tabs.forEach(({ title, tabId, body }) => {
          content += `=== Tab: ${title} (${tabId}) ===\n`;
          const tabText = extractTextFromBody(body);
          bodyText += tabText;
          content += tabText;
          content += "\n\n";
        });
      } else {
        bodyText = extractTextFromBody(document.body);
        content += bodyText;
      }

      const outline = extractOutlineFromDoc(document);
      if (includeOutline) {
        content += "\n--- OUTLINE ---\n";
        content += formatOutlineText(outline);
      }
      if (includeStats) {
        content += "\n--- STATS ---\n";
        content += formatStatsText(computeDocStats(bodyText, outline));
      }

      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      console.error(`Error getting document ${docId}:`, error);
      return {
        content: [{ type: "text", text: `Error getting document ${docId}: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool to list all tabs in a document
registerTool(
  "list-tabs",
  {
    docId: z.string().describe("The ID of the document"),
  },
  async ({ docId }) => {
    try {
      const { docs } = getClients();
      const doc = await docs.documents.get({
        documentId: docId,
        includeTabsContent: false,
      } as any);

      const tabs = flattenTabs((doc.data as any).tabs || []);
      if (tabs.length === 0) {
        return { content: [{ type: "text", text: "This document has no tabs (single-tab or legacy document)." }] };
      }

      let text = `Document: ${doc.data.title}\n${tabs.length} tab(s):\n\n`;
      tabs.forEach(({ tabId, title, index, nestingLevel }) => {
        const indent = "  ".repeat(nestingLevel);
        text += `${indent}Tab ID:   ${tabId}\n`;
        text += `${indent}Title:    ${title}\n`;
        text += `${indent}Index:    ${index}\n\n`;
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      console.error(`Error listing tabs for ${docId}:`, error);
      return {
        content: [{ type: "text", text: `Error listing tabs: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool to read the content of a specific tab by tabId
registerTool(
  "get-tab",
  {
    docId: z.string().describe("The ID of the document"),
    tabId: z.string().describe("The ID of the tab to read (from list-tabs)"),
  },
  async ({ docId, tabId }) => {
    try {
      const { docs } = getClients();
      const doc = await docs.documents.get({
        documentId: docId,
        includeTabsContent: true,
      } as any);

      const tabs = flattenTabs((doc.data as any).tabs || []);
      const tab = tabs.find((t) => t.tabId === tabId);

      if (!tab) {
        return {
          content: [{ type: "text", text: `Tab "${tabId}" not found. Use list-tabs to see available tab IDs.` }],
          isError: true,
        };
      }

      const text = extractTextFromBody(tab.body);
      const content = `Document: ${doc.data.title}\nTab: ${tab.title} (${tabId})\n\n${text}`;
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      console.error(`Error getting tab ${tabId} from ${docId}:`, error);
      return {
        content: [{ type: "text", text: `Error getting tab: ${error}` }],
        isError: true,
      };
    }
  }
);

registerTool(
  "get-outline",
  {
    docId: z.string().describe("Document ID. Returns headings with levels for section-aware editing."),
  },
  async ({ docId }) => {
    try {
      const { docs } = getClients();
      const doc = await docs.documents.get({ documentId: docId });
      const outline = extractOutlineFromDoc(doc.data);
      let text = `Outline for "${doc.data.title}":\n\n`;
      text += formatOutlineText(outline);
      if (outline.length) {
        text += "\n(Use afterHeading in insert-text / create-list to target sections.)";
      }
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting outline: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "get-doc-stats",
  {
    docId: z.string().describe("Document ID. Word count, reading time, paragraph/heading counts."),
  },
  async ({ docId }) => {
    try {
      const { docs } = getClients();
      const doc = await docs.documents.get({ documentId: docId });
      const text = extractTextFromBody(doc.data.body);
      const outline = extractOutlineFromDoc(doc.data);
      const stats = computeDocStats(text, outline);
      return {
        content: [
          {
            type: "text",
            text: `Stats for "${doc.data.title}":\n\n${formatStatsText(stats)}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting stats: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "insert-text",
  {
    docId: z.string().describe("Document ID"),
    content: z.string().describe("Text to insert"),
    index: z.number().optional().describe("UTF-16 index to insert at"),
    afterHeading: z.string().optional().describe("Insert after this heading text"),
    beforeText: z.string().optional().describe("Insert before this text"),
    afterText: z.string().optional().describe("Insert after this text"),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
    append: z.boolean().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();
      let index: number;
      let textToInsert = params.content;
      if (params.append) {
        const doc = await docs.documents.get({ documentId });
        index = getBodyEndIndex(doc.data) - 1;
        if (index > 1 && !textToInsert.startsWith("\n")) {
          textToInsert = "\n" + textToInsert;
        }
      } else {
        index = await resolveInsertIndex(documentId, params);
        const suffix = params.beforeText ? "\n" : "";
        textToInsert = textToInsert + suffix;
      }
      await insertTextAtIndex(documentId, index, textToInsert);
      return {
        content: [{ type: "text", text: `Inserted text at index ${index} in document ${params.docId}.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error inserting text: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "insert-page-break",
  {
    docId: z.string().describe("Document ID"),
    index: z.number().optional(),
    afterHeading: z.string().optional().describe("Insert page break after this heading"),
    beforeText: z.string().optional().describe("Insert before this text (e.g. References)"),
    afterText: z.string().optional(),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
    append: z.boolean().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();
            let index: number;
      if (params.append) {
        const doc = await docs.documents.get({ documentId });
        index = getBodyEndIndex(doc.data) - 1;
      } else {
        index = await resolveInsertIndex(documentId, params);
      }
      await insertPageBreakAtIndex(documentId, index);
      return {
        content: [{ type: "text", text: `Inserted page break at index ${index} in document ${params.docId}.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error inserting page break: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "insert-scene-break",
  {
    docId: z.string().describe("Document ID. Page break or centered * * * line between sections."),
    afterHeading: z.string().optional(),
    afterText: z.string().optional(),
    beforeText: z.string().optional(),
    usePageBreak: z.boolean().optional().describe("true = page break (default), false = * * * line"),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const summary = await insertSceneBreak(params.docId.toString(), params);
      return { content: [{ type: "text", text: `${summary} in document ${params.docId}.` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error inserting scene break: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "create-list",
  {
    docId: z.string().describe("Document ID"),
    items: z.array(z.string()).min(1).describe("List items"),
    listType: z.enum(["bullet", "numbered"]).optional().describe("Default: bullet"),
    afterHeading: z.string().optional(),
    afterText: z.string().optional(),
    beforeText: z.string().optional(),
    append: z.boolean().optional().describe("Append list at document end"),
    matchCase: z.boolean().optional(),
    occurrenceIndex: z.number().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const summary = await createListInDocument(params.docId.toString(), params.items, params);
      return { content: [{ type: "text", text: `${summary} in document ${params.docId}.` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error creating list: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "apply-preset",
  {
    docId: z.string().describe("Document ID"),
    preset: z
      .enum(STYLE_PRESETS)
      .describe("essay-mla, essay-apa, manuscript, cover-letter, or notes"),
    findText: z.string().optional().describe("Apply only to paragraphs containing this text"),
    matchCase: z.boolean().optional(),
  },
  async ({ docId, preset, findText, matchCase }) => {
    try {
      const { docs } = getClients();
      if (!docId) throw new Error("Document ID is required");
      const summary = await applyStylePresetToDocument(docId.toString(), preset, {
        findText,
        matchCase,
      });
      return { content: [{ type: "text", text: `${summary} in document ${docId}.` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error applying preset: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "clear-formatting",
  {
    docId: z.string().describe("Document ID. Reset bold, color, font, links on matched text."),
    findText: z.string().optional(),
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    occurrenceIndex: z.number().optional(),
    matchCase: z.boolean().optional(),
    confirmBulkEdit: z.boolean().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();
      const ranges = await resolveTextRanges(documentId, params);
      const requests = buildClearFormattingRequests(ranges);
      await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
      return {
        content: [
          { type: "text", text: `Cleared formatting on ${ranges.length} range(s) in document ${params.docId}.` },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error clearing formatting: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "generate-title-page",
  {
    docId: z.string().describe("Document ID. Inserts a centered academic title block at the start."),
    title: z.string(),
    subtitle: z.string().optional(),
    author: z.string().optional(),
    course: z.string().optional(),
    instructor: z.string().optional(),
    date: z.string().optional(),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      const { docId, title, subtitle, author, course, instructor, date } = params;
      const summary = await generateTitlePageContent(docId.toString(), {
        title,
        subtitle,
        author,
        course,
        instructor,
        date,
      });
      return { content: [{ type: "text", text: `${summary} in document ${docId}.` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error generating title page: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "rename-doc",
  {
    docId: z.string().describe("Document ID"),
    newTitle: z.string().describe("New document title in Google Drive"),
  },
  async ({ docId, newTitle }) => {
    try {
      const { drive } = getClients();
      await drive.files.update({
        fileId: docId,
        requestBody: { name: newTitle },
      });
      return { content: [{ type: "text", text: `Renamed document ${docId} to "${newTitle}".` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error renaming document: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "copy-doc",
  {
    docId: z.string().describe("Source document ID"),
    newTitle: z.string().describe("Title for the copy"),
  },
  async ({ docId, newTitle }) => {
    try {
      const { drive } = getClients();
      const copy = await drive.files.copy({
        fileId: docId,
        requestBody: { name: newTitle },
      });
      return {
        content: [
          {
            type: "text",
            text: `Copied document to "${newTitle}".\nNew ID: ${copy.data.id}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error copying document: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "export-doc",
  {
    docId: z.string().describe("Document ID"),
    format: z.enum(["pdf", "docx", "txt", "html"]).optional().describe("Export format. Default: pdf"),
    outputPath: z.string().optional().describe("Absolute path to save file. Default: ./exports/ in project"),
  },
  async ({ docId, format = "pdf", outputPath }) => {
    try {
      const { docs, drive } = getClients();
      const mimeTypes: Record<string, string> = {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        txt: "text/plain",
        html: "text/html",
      };
      const exportDir = path.join(PROJECT_ROOT, "exports");
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      const doc = await docs.documents.get({ documentId: docId });
      const safeName = (doc.data.title || "document").replace(/[<>:"/\\|?*]/g, "_");
      const dest =
        outputPath || path.join(exportDir, `${safeName}.${format}`);

      const res = await drive.files.export(
        { fileId: docId, mimeType: mimeTypes[format] },
        { responseType: "arraybuffer" }
      );
      fs.writeFileSync(dest, Buffer.from(res.data as ArrayBuffer));
      return {
        content: [{ type: "text", text: `Exported "${doc.data.title}" as ${format.toUpperCase()} to:\n${dest}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error exporting document: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "list-comments",
  {
    docId: z.string().describe("Document ID"),
  },
  async ({ docId }) => {
    try {
      const { drive } = getClients();
      const res = await drive.comments.list({
        fileId: docId,
        fields: "comments(id,content,author,createdTime,quotedFileContent)",
        pageSize: 50,
      });
      const comments = res.data.comments || [];
      if (!comments.length) {
        return { content: [{ type: "text", text: "No comments on this document." }] };
      }
      let text = `Comments (${comments.length}):\n\n`;
      comments.forEach((c, i) => {
        text += `${i + 1}. ${c.author?.displayName || "Unknown"} (${c.createdTime})\n`;
        if (c.quotedFileContent?.value) {
          text += `   Quoted: "${c.quotedFileContent.value.slice(0, 120)}"\n`;
        }
        text += `   ${c.content}\n\n`;
      });
      if (comments.length >= 50) {
        text += "Note: Results are limited to 50 comments. Older comments may not be shown.\n";
      }
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error listing comments: ${error}` }], isError: true };
    }
  }
);

async function resolveQuotedTextFromDoc(
  documentId: string,
  quotedText: string,
  matchCase: boolean,
  occurrenceIndex: number
): Promise<{ exactQuote: string; startIndex: number; length: number } | null> {
  const doc = await getClients().docs.documents.get({ documentId });
  const ranges = findTextRanges(doc.data, quotedText, matchCase);
  if (!ranges.length || occurrenceIndex < 0 || occurrenceIndex >= ranges.length) return null;
  const range = ranges[occurrenceIndex];
  return {
    exactQuote: quotedText,
    startIndex: range.startIndex,
    length: range.endIndex - range.startIndex,
  };
}

registerTool(
  "add-comment",
  {
    docId: z.string().describe("Document ID"),
    content: z.string().describe("Comment text"),
    quotedText: z.string().optional().describe("Text from the document this comment refers to"),
    matchCase: z.boolean().optional().describe("Case-sensitive quoted text match. Default: true"),
    occurrenceIndex: z.number().optional().describe("Which quotedText match to attach to. Default: 0"),
  },
  async ({ docId, content, quotedText, matchCase = true, occurrenceIndex = 0 }) => {
    try {
      const { drive } = getClients();
      const requestBody: drive_v3.Schema$Comment = { content };
      let anchorNote = "";

      if (quotedText) {
        const resolved = await resolveQuotedTextFromDoc(
          docId,
          quotedText,
          matchCase,
          occurrenceIndex
        );
        const quote = resolved?.exactQuote ?? quotedText;
        requestBody.quotedFileContent = {
          mimeType: "text/plain",
          value: quote,
        };
        if (resolved) {
          const anchor = JSON.stringify({
            r: "head",
            a: [{ txt: { o: resolved.startIndex, l: resolved.length, ml: quote.length } }],
          });
          requestBody.anchor = anchor;
          anchorNote = " Anchor attached (may not highlight inline — Google API limitation).";
        }
      }

      const res = await drive.comments.create({
        fileId: docId,
        fields: "id,content,createdTime,anchor,quotedFileContent",
        requestBody,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Drive comment added (ID: ${res.data.id}).\n\n` +
              `WHERE TO FIND IT: In Google Docs, open the document → click the **comment bubble icon** (top-right toolbar) or press Ctrl+Alt+Shift+O to open the comments panel.${anchorNote}\n\n` +
              `IMPORTANT: Drive API comments often do NOT appear as yellow inline margin notes on text. ` +
              `For a visible in-document note writers can see immediately, use **insert-review-note** instead.`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error adding comment: ${error}` }], isError: true };
    }
  }
);

registerTool(
  "insert-review-note",
  {
    docId: z.string().describe("Document ID"),
    findText: z.string().describe("Insert a visible review note after this text"),
    note: z.string().describe("Review note text (shown in yellow highlight in the doc)"),
    occurrenceIndex: z.number().optional().describe("Which findText match. Default: 0"),
    matchCase: z.boolean().optional(),
  },
  async ({ docId, findText, note, occurrenceIndex = 0, matchCase = true }) => {
    try {
      const { docs } = getClients();
      const documentId = docId.toString();
      const ranges = await resolveTextRanges(documentId, {
        findText,
        occurrenceIndex,
        matchCase,
      });
      const insertAt = ranges[0].endIndex;
      const noteText = ` [REVIEW: ${note}]`;
      await insertTextAtIndex(documentId, insertAt, noteText);
      const noteStart = insertAt;
      const noteEnd = insertAt + noteText.length;
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: buildTextStyleRequests(
            [{ startIndex: noteStart, endIndex: noteEnd }],
            { backgroundColor: "yellow", italic: true, fontSize: 10 }
          ),
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Visible review note inserted after "${findText}" in document ${docId}. Look for yellow highlighted [REVIEW: ...] text in the document body.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error inserting review note: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool to share a document
registerTool(
  "share-doc",
  {
    docId: z.string().describe("Document ID to share"),
    email: z.string().email().describe("Email address to share with"),
    role: z.enum(["reader", "commenter", "writer"]).describe("Role to grant"),
  },
  async ({ docId, email, role }) => {
    try {
      const { drive } = getClients();
      const documentId = docId.toString();

      await drive.permissions.create({
        fileId: documentId,
        sendNotificationEmail: true,
        requestBody: {
          role,
          type: "user",
          emailAddress: email,
        },
      });

      return {
        content: [{ type: "text", text: `Successfully shared document ${documentId} with ${email} as ${role}.` }],
      };
    } catch (error) {
      console.error("Error sharing document:", error);
      return {
        content: [{ type: "text", text: `Error sharing document: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool to insert an image from a URL
registerTool(
  "insert-image",
  {
    docId: z.string().describe("Document ID"),
    url: z.string().url().describe("Publicly accessible URL of the image"),
    width: z.number().optional().describe("Width in points (optional)"),
    height: z.number().optional().describe("Height in points (optional)"),
    beforeText: z.string().optional().describe("Insert before this text"),
    afterHeading: z.string().optional().describe("Insert after this heading"),
    afterText: z.string().optional().describe("Insert after this text"),
    index: z.number().optional().describe("Insert at exact 1-based index"),
    append: z.boolean().optional().describe("Append to end of document")
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

            let index: number;
      if (params.append) {
        const doc = await docs.documents.get({ documentId });
        index = getBodyEndIndex(doc.data) - 1;
      } else {
        index = await resolveInsertIndex(documentId, params);
      }

      const size: any = {};
      if (params.width !== undefined) size.width = { magnitude: params.width, unit: "PT" };
      if (params.height !== undefined) size.height = { magnitude: params.height, unit: "PT" };

      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertInlineImage: {
                location: { index },
                uri: params.url,
                objectSize: (params.width !== undefined || params.height !== undefined) ? size : undefined,
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Inserted image from URL at index ${index} in document ${documentId}.` }],
      };
    } catch (error) {
      console.error("Error inserting image:", error);
      return {
        content: [{ type: "text", text: `Error inserting image: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool to insert a table
registerTool(
  "insert-table",
  {
    docId: z.string().describe("Document ID"),
    rows: z.number().min(1).describe("Number of rows"),
    columns: z.number().min(1).describe("Number of columns"),
    beforeText: z.string().optional().describe("Insert before this text"),
    afterHeading: z.string().optional().describe("Insert after this heading"),
    afterText: z.string().optional().describe("Insert after this text"),
    index: z.number().optional().describe("Insert at exact 1-based index"),
    append: z.boolean().optional().describe("Append to end of document")
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

            let index: number;
      if (params.append) {
        const doc = await docs.documents.get({ documentId });
        index = getBodyEndIndex(doc.data) - 1;
      } else {
        index = await resolveInsertIndex(documentId, params);
      }

      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertTable: {
                location: { index },
                rows: params.rows,
                columns: params.columns,
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Inserted ${params.rows}x${params.columns} table at index ${index} in document ${documentId}.` }],
      };
    } catch (error) {
      console.error("Error inserting table:", error);
      return {
        content: [{ type: "text", text: `Error inserting table: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);



// Tool to insert a footnote
registerTool(
  "insert-footnote",
  {
    docId: z.string().describe("Document ID"),
    text: z.string().describe("Text of the footnote"),
    beforeText: z.string().optional().describe("Insert before this text"),
    afterHeading: z.string().optional().describe("Insert after this heading"),
    afterText: z.string().optional().describe("Insert after this text"),
    index: z.number().optional().describe("Insert at exact 1-based index"),
    append: z.boolean().optional().describe("Append to end of document")
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

            let index: number;
      if (params.append) {
        const doc = await docs.documents.get({ documentId });
        index = getBodyEndIndex(doc.data) - 1;
      } else {
        index = await resolveInsertIndex(documentId, params);
      }

      const response = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              createFootnote: {
                location: { index },
              },
            },
          ],
        },
      });

      const footnoteId = response.data.replies?.[0]?.createFootnote?.footnoteId;
      if (!footnoteId) {
        throw new Error("Failed to create footnote, no ID returned.");
      }

      // Insert text into the footnote. Footnotes start at index 1 internally.
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { segmentId: footnoteId, index: 1 },
                text: params.text,
              },
            },
          ],
        },
      });

      return {
        content: [{ type: "text", text: `Inserted footnote at index ${index} in document ${documentId}.` }],
      };
    } catch (error) {
      console.error("Error inserting footnote:", error);
      return {
        content: [{ type: "text", text: `Error inserting footnote: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool to set document header
registerTool(
  "set-header",
  {
    docId: z.string().describe("Document ID"),
    text: z.string().describe("Text of the header"),
    alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional().describe("Alignment of the header (default: START)"),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

      // We must fetch the doc to see if a header already exists
      const doc = await docs.documents.get({ documentId });
      let headerId = "";
      const requests: any[] = [];

      if (doc.data.documentStyle?.defaultHeaderId) {
        headerId = doc.data.documentStyle.defaultHeaderId;
        const header = doc.data.headers?.[headerId];
        if (header && header.content) {
          const lastElement = header.content[header.content.length - 1];
          if (lastElement && lastElement.endIndex && lastElement.endIndex > 2) {
            requests.push({
              deleteContentRange: {
                range: { segmentId: headerId, startIndex: 1, endIndex: lastElement.endIndex - 1 }
              }
            });
          }
        }
      } else {
        const response = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                createHeader: {
                  type: "DEFAULT",
                },
              },
            ],
          },
        });
        headerId = response.data.replies?.[0]?.createHeader?.headerId || "";
      }

      if (!headerId) throw new Error("Failed to resolve or create header.");

      requests.push({
        insertText: {
          location: { segmentId: headerId, index: 1 },
          text: params.text + "\n",
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { segmentId: headerId, startIndex: 1, endIndex: params.text.length + 1 },
          paragraphStyle: { alignment: params.alignment || "START" },
          fields: "alignment"
        }
      });

      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });

      return {
        content: [{ type: "text", text: `Set header in document ${documentId}.` }],
      };
    } catch (error) {
      console.error("Error setting header:", error);
      return {
        content: [{ type: "text", text: `Error setting header: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool to set document footer
registerTool(
  "set-footer",
  {
    docId: z.string().describe("Document ID"),
    text: z.string().describe("Text of the footer"),
    alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional().describe("Alignment of the footer (default: CENTER)"),
  },
  async (params) => {
    try {
      const { docs } = getClients();
      if (!params.docId) throw new Error("Document ID is required");
      const documentId = params.docId.toString();

      const doc = await docs.documents.get({ documentId });
      let footerId = "";
      const requests: any[] = [];

      if (doc.data.documentStyle?.defaultFooterId) {
        footerId = doc.data.documentStyle.defaultFooterId;
        const footer = doc.data.footers?.[footerId];
        if (footer && footer.content) {
          const lastElement = footer.content[footer.content.length - 1];
          if (lastElement && lastElement.endIndex && lastElement.endIndex > 2) {
            requests.push({
              deleteContentRange: {
                range: { segmentId: footerId, startIndex: 1, endIndex: lastElement.endIndex - 1 }
              }
            });
          }
        }
      } else {
        const response = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                createFooter: {
                  type: "DEFAULT",
                },
              },
            ],
          },
        });
        footerId = response.data.replies?.[0]?.createFooter?.footerId || "";
      }

      if (!footerId) throw new Error("Failed to resolve or create footer.");

      requests.push({
        insertText: {
          location: { segmentId: footerId, index: 1 },
          text: params.text + "\n",
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { segmentId: footerId, startIndex: 1, endIndex: params.text.length + 1 },
          paragraphStyle: { alignment: params.alignment || "CENTER" },
          fields: "alignment"
        }
      });

      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });

      return {
        content: [{ type: "text", text: `Set footer in document ${documentId}.` }],
      };
    } catch (error) {
      console.error("Error setting footer:", error);
      return {
        content: [{ type: "text", text: `Error setting footer: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// PROMPTS

// Prompt for document creation
registerPrompt(
  "create-doc-template",
  {
    title: z.string().describe("The title for the new document"),
    subject: z.string().describe("The subject/topic the document should be about"),
    style: z.string().describe("The writing style (e.g., formal, casual, academic)"),
  },
  ({ title, subject, style }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please create a Google Doc with the title "${title}" about ${subject} in a ${style} writing style. Make sure it's well-structured with an introduction, main sections, and a conclusion.`
      }
    }]
  })
);

// Prompt for document analysis
registerPrompt(
  "analyze-doc",
  {
    docId: z.string().describe("The ID of the document to analyze"),
  },
  ({ docId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please analyze the content of the document with ID ${docId}. Provide a summary of its content, structure, key points, and any suggestions for improvement.`
      }
    }]
  })
);

registerPrompt(
  "format-academic-essay",
  {
    docId: z.string().describe("Document ID"),
    style: z.enum(["mla", "apa"]).optional().describe("Citation style preset. Default: mla"),
  },
  ({ docId, style = "mla" }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Format Google Doc ${docId} as an academic essay (${style.toUpperCase()}). Use get-outline and get-doc-stats first, then edit-document with applyPreset essay-${style}, generate-title-page if missing, insert-page-break before References if present, and double-check line spacing and Times New Roman 12pt body text.`,
      },
    }],
  })
);

registerPrompt(
  "polish-prose",
  {
    docId: z.string().describe("Document ID"),
  },
  ({ docId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Read doc ${docId} with get-doc (outline + stats). Suggest prose improvements, then apply safe edits via edit-document (replaceText, formatParagraph, clearFormatting). Preserve meaning; fix repetition, weak verbs, and inconsistent heading styles.`,
      },
    }],
  })
);

registerPrompt(
  "create-outline-from-topic",
  {
    title: z.string().describe("Document title"),
    topic: z.string().describe("Essay or article topic"),
    sections: z.string().optional().describe("Number of main sections as string. Default: 4"),
  },
  ({ title, topic, sections = "4" }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Create a new Google Doc "${title}" with a structured outline for: ${topic}. Use create-doc, then create-list or insert-text with HEADING_1/HEADING_2 via format-paragraph namedStyle. Include ~${sections} main sections plus Introduction and Conclusion placeholders.`,
      },
    }],
  })
);

registerPrompt(
  "bibliography-check",
  {
    docId: z.string().describe("Document ID"),
  },
  ({ docId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Review doc ${docId} for citation issues. Use get-doc and get-outline. Flag missing References section, in-text citations without matching entries, and inconsistent citation format. Add comments via add-comment for each issue; do not invent sources.`,
      },
    }],
  })
);

registerPrompt(
  "format-professional-report",
  {
    docId: z.string().describe("Document ID"),
    headerText: z.string().describe("Text for the document header"),
    footerText: z.string().describe("Text for the document footer"),
  },
  ({ docId, headerText, footerText }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Format doc ${docId} as a professional report. Start by using set-header with "${headerText}" and set-footer with "${footerText}". Then use get-doc to review the structure. If it lacks data presentation, suggest using insert-table, and if visual aids are needed, use insert-image.`,
      },
    }],
  })
);

registerPrompt(
  "collaborative-review-setup",
  {
    docId: z.string().describe("Document ID"),
    reviewerEmail: z.string().describe("Email of the reviewer to share with"),
  },
  ({ docId, reviewerEmail }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Prepare doc ${docId} for review. First, use share-doc to grant "${reviewerEmail}" commenter access. Then use get-doc to read the content. For any claims that need academic citations, use insert-footnote to add placeholder citations.`,
      },
    }],
  })
);

// Connect to the transport and start the server
async function main() {
  const success = await initClients();
  if (!success) {
    console.error("Failed to initialize Google API clients. Server will not work correctly.");
  }

  // Create a transport for communicating over stdin/stdout
  const transport = new StdioServerTransport();

  // Connect the server to the transport
  await server.connect(transport);

  console.error("Google Docs MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});