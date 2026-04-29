/**
 * Web Wiki HTTP Server
 *
 * Serves the React SPA and provides REST API endpoints for wiki operations.
 * Uses Node's built-in http module — no Express dependency.
 *
 * API:
 *   GET  /api/pages                        — list pages grouped by PARA category
 *   GET  /api/pages/:category/:slug        — get page content + frontmatter
 *   PUT  /api/pages/:category/:slug        — update page body
 *   POST /api/pages/:category/:slug/move   — move page to different category
 *   GET  /api/search?q=query               — BM25 search via qmd store
 *   GET  /api/graph                        — nodes + edges from wikilinks
 *   GET  /api/log                          — activity log entries
 *   GET  /api/sessions                     — session digest entries
 *   GET  /                                 — serve React SPA
 *   GET  /*                                — serve static files, fallback to index.html
 */

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listPages,
  readPage,
  writePage,
  movePage,
  gitCommit,
  PARA_CATEGORIES,
} from "../wiki.js";
import type { ParaCategory, WikiPage, PageRef, PageFrontmatter } from "../wiki.js";
import { extractWikilinks } from "../link-utils.js";
import { redactSecrets } from "../redact.js";
import { searchWiki, reindex } from "../store.js";
import type { QMDStore } from "../store.js";
import { readSessionDigests } from "../raw.js";

// -- Types ------------------------------------------------------------------

export interface WebWikiConfig {
  enabled: boolean;
  host: string;
  port: number;
}

interface ServerHandle {
  close: () => Promise<void>;
  url: string;
}

interface GraphNode {
  id: string;
  title: string;
  category: ParaCategory;
  slug: string;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface RouteMatch {
  params: Record<string, string>;
}

// -- MIME types --------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

// -- Helpers ----------------------------------------------------------------

// extractWikilinks imported from ../link-utils.js

function json(res: ServerResponse, data: unknown, statusCode = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorResponse(res: ServerResponse, statusCode: number, message: string): void {
  json(res, { error: message }, statusCode);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 5 * 1024 * 1024; // 5MB limit

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isValidCategory(cat: string): cat is ParaCategory {
  return (PARA_CATEGORIES as readonly string[]).includes(cat);
}

function matchRoute(
  pattern: string,
  pathname: string,
): RouteMatch | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }
  return { params };
}

// -- Log parser -------------------------------------------------------------

interface ParsedLogEntry {
  date: string;
  operation: string;
  summary: string;
  pages: string[];
}

function parseLogEntries(content: string): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  const entryPattern = /^## \[([^\]]+)\] (\w+) \| (.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const date = match[1].trim();
    const operation = match[2].trim();
    const summary = match[3].trim();

    // Extract the block after this heading until the next heading or end
    const startIdx = match.index + match[0].length;
    const nextHeading = content.indexOf("\n## ", startIdx);
    const block = nextHeading === -1
      ? content.slice(startIdx)
      : content.slice(startIdx, nextHeading);

    // Parse "Pages: ..." line
    const pagesMatch = /^Pages:\s*(.+)$/m.exec(block);
    const pages: string[] = [];
    if (pagesMatch && pagesMatch[1].trim() !== "none") {
      for (const p of pagesMatch[1].split(",")) {
        const trimmed = p.trim();
        if (trimmed) pages.push(trimmed);
      }
    }

    entries.push({ date, operation, summary, pages });
  }

  return entries;
}

// -- Route handlers ---------------------------------------------------------

async function handleListPages(
  wikiDir: string,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const refs = await listPages(wikiDir);

  // Build flat list with metadata
  const allPages: Array<{
    slug: string;
    title: string;
    path: string;
    category: ParaCategory;
    scope: string[];
    tags: string[];
  }> = [];

  for (const ref of refs) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    allPages.push({
      slug: ref.slug,
      title: ref.title,
      path: ref.path,
      category: ref.category,
      scope: page?.frontmatter.scope ?? [],
      tags: page?.frontmatter.tags ?? [],
    });
  }

  const total = allPages.length;
  const rawPage = url.searchParams.get("page");
  const rawLimit = url.searchParams.get("limit");

  // Default: return grouped by category (what the SPA client expects)
  if (!rawPage && !rawLimit) {
    const grouped: Record<string, Array<{ slug: string; title: string; path: string; scope: string[]; tags: string[] }>> = {
      projects: [],
      areas: [],
      resources: [],
      archives: [],
    };
    for (const p of allPages) {
      grouped[p.category]?.push({ slug: p.slug, title: p.title, path: p.path, scope: p.scope, tags: p.tags });
    }
    json(res, grouped);
    return;
  }

  const pageParam = parseInt(rawPage ?? "1", 10);
  const limitParam = parseInt(rawLimit ?? "50", 10);
  const page = Math.max(1, isNaN(pageParam) ? 1 : pageParam);
  const limit = Math.max(1, Math.min(500, isNaN(limitParam) ? 50 : limitParam));
  const start = (page - 1) * limit;
  const paginatedPages = allPages.slice(start, start + limit);

  json(res, {
    pages: paginatedPages,
    total,
    page,
    limit,
  });
}

async function handleGetPage(
  wikiDir: string,
  params: Record<string, string>,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { category, slug } = params;

  if (!isValidCategory(category)) {
    errorResponse(res, 400, `Invalid category: ${category}`);
    return;
  }

  const page = await readPage(wikiDir, category, slug);
  if (!page) {
    errorResponse(res, 404, `Page not found: ${category}/${slug}`);
    return;
  }

  json(res, {
    category: page.category,
    slug: page.slug,
    frontmatter: page.frontmatter,
    body: page.body,
  });
}

async function handleUpdatePage(
  wikiDir: string,
  store: QMDStore | null,
  params: Record<string, string>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { category, slug } = params;

  if (!isValidCategory(category)) {
    errorResponse(res, 400, `Invalid category: ${category}`);
    return;
  }

  const rawBody = await readBody(req);
  const body = parseJsonBody(rawBody);
  if (!body || typeof body !== "object") {
    errorResponse(res, 400, "Invalid JSON body");
    return;
  }

  const payload = body as Record<string, unknown>;

  // Read existing page or create new
  const existing = await readPage(wikiDir, category, slug);
  if (!existing) {
    errorResponse(res, 404, `Page not found: ${category}/${slug}`);
    return;
  }

  // Update body if provided
  // Redact secrets before saving
  const pageBody = typeof payload.body === "string" ? payload.body : existing.body;
  const newBody = redactSecrets(pageBody).text;

  // Update frontmatter fields if provided
  const newFrontmatter: PageFrontmatter = { ...existing.frontmatter };
  if (typeof payload.title === "string") newFrontmatter.title = payload.title;
  if (Array.isArray(payload.tags)) newFrontmatter.tags = payload.tags.filter((t): t is string => typeof t === "string");
  if (Array.isArray(payload.scope)) newFrontmatter.scope = payload.scope.filter((s): s is string => typeof s === "string");
  newFrontmatter.updated = new Date().toISOString();

  // Extract wikilinks from new body
  newFrontmatter.links = extractWikilinks(newBody);

  const updatedPage: WikiPage = {
    category,
    slug,
    frontmatter: newFrontmatter,
    body: newBody,
  };

  await writePage(wikiDir, updatedPage);

  // Re-index for search
  if (store) {
    try {
      await reindex(store);
    } catch {
      // Non-fatal — search may be stale until next reindex
    }
  }

  // Git commit
  await gitCommit(wikiDir, `webui: update ${category}/${slug}`);

  json(res, {
    category: updatedPage.category,
    slug: updatedPage.slug,
    frontmatter: updatedPage.frontmatter,
    body: updatedPage.body,
  });
}

async function handleMovePage(
  wikiDir: string,
  store: QMDStore | null,
  params: Record<string, string>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { category, slug } = params;

  if (!isValidCategory(category)) {
    errorResponse(res, 400, `Invalid source category: ${category}`);
    return;
  }

  const rawBody = await readBody(req);
  const body = parseJsonBody(rawBody);
  if (!body || typeof body !== "object") {
    errorResponse(res, 400, "Invalid JSON body");
    return;
  }

  const payload = body as Record<string, unknown>;
  const toCategory = payload.to;
  if (typeof toCategory !== "string" || !isValidCategory(toCategory)) {
    errorResponse(res, 400, `Invalid target category: ${String(toCategory)}`);
    return;
  }

  if (category === toCategory) {
    errorResponse(res, 400, "Source and target category are the same");
    return;
  }

  // Check page exists
  const page = await readPage(wikiDir, category, slug);
  if (!page) {
    errorResponse(res, 404, `Page not found: ${category}/${slug}`);
    return;
  }

  const pageRef: PageRef = {
    category,
    slug,
    title: page.frontmatter.title,
    path: `${category}/${slug}.md`,
  };

  await movePage(wikiDir, pageRef, toCategory);

  // Re-index for search
  if (store) {
    try {
      await reindex(store);
    } catch {
      // Non-fatal
    }
  }

  json(res, { moved: true, from: category, to: toCategory, slug });
}

async function handleSearch(
  wikiDir: string,
  store: QMDStore | null,
  query: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!query) {
    errorResponse(res, 400, "Missing query parameter: q");
    return;
  }

  if (!store) {
    errorResponse(res, 503, "Search is unavailable: store not initialized");
    return;
  }

  const results = await searchWiki(store, query, { limit: 20 });
  json(res, results.map((r) => ({
    category: r.page.category,
    slug: r.page.slug,
    title: r.page.title,
    score: r.score,
    snippet: r.snippet,
    tags: r.frontmatter.tags,
    scope: r.frontmatter.scope,
    updated: r.frontmatter.updated,
  })));
}

async function handleGraph(
  wikiDir: string,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const maxNodesParam = parseInt(url.searchParams.get("maxNodes") ?? "100", 10);
  const maxNodes = Math.max(1, isNaN(maxNodesParam) ? 100 : maxNodesParam);

  const refs = await listPages(wikiDir);
  const slugToRef = new Map<string, PageRef>();
  for (const ref of refs) {
    slugToRef.set(ref.slug, ref);
  }

  // Build all nodes and edges first
  const allNodes: (GraphNode & { connectionCount: number })[] = [];
  const allEdges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const connectionCounts = new Map<string, number>();

  for (const ref of refs) {
    const page = await readPage(wikiDir, ref.category, ref.slug);
    if (!page) continue;

    const nodeId = `${ref.category}/${ref.slug}`;

    // Collect wikilinks from body and frontmatter
    const bodyLinks = extractWikilinks(page.body);
    const fmLinks = page.frontmatter.links;
    const allLinks = new Set([...bodyLinks, ...fmLinks]);

    for (const link of allLinks) {
      const targetRef = slugToRef.get(link);
      if (!targetRef) continue; // skip broken links

      const targetId = `${targetRef.category}/${targetRef.slug}`;
      const edgeKey = `${nodeId}->${targetId}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      allEdges.push({ source: nodeId, target: targetId });

      // Track connection counts for both source and target
      connectionCounts.set(nodeId, (connectionCounts.get(nodeId) ?? 0) + 1);
      connectionCounts.set(targetId, (connectionCounts.get(targetId) ?? 0) + 1);
    }

    allNodes.push({
      id: nodeId,
      title: ref.title,
      category: ref.category,
      slug: ref.slug,
      connectionCount: 0, // will be filled below
    });
  }

  // Fill connection counts and sort by most connected
  for (const node of allNodes) {
    node.connectionCount = connectionCounts.get(node.id) ?? 0;
  }
  allNodes.sort((a, b) => b.connectionCount - a.connectionCount);

  // Take top-N most connected nodes
  const topNodes = allNodes.slice(0, maxNodes);
  const topNodeIds = new Set(topNodes.map(n => n.id));

  // Filter edges to only include those between visible nodes
  const filteredEdges = allEdges.filter(
    e => topNodeIds.has(e.source) && topNodeIds.has(e.target)
  );

  // Strip connectionCount from response
  const nodes: GraphNode[] = topNodes.map(({ connectionCount, ...rest }) => rest);

  json(res, { nodes, edges: filteredEdges });
}

async function handleLog(
  wikiDir: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(wikiDir, "log.md"), "utf-8");
  } catch {
    json(res, []);
    return;
  }

  const entries = parseLogEntries(content);
  // Return newest first
  entries.reverse();
  json(res, entries);
}

async function handleSessions(
  wikiDir: string,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const limitParam = url.searchParams.get("limit");
  const scope = url.searchParams.get("scope") ?? undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  const digests = await readSessionDigests(wikiDir, { limit, scope });
  // Return newest first
  digests.reverse();
  json(res, digests);
}

// -- Static file serving ----------------------------------------------------

async function serveStaticFile(
  staticDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  // Prevent directory traversal
  const safePath = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
  const filePath = join(staticDir, safePath === "/" ? "index.html" : safePath);

  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return false;

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const content = await readFile(filePath);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function serveSpaFallback(
  staticDir: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const indexPath = join(staticDir, "index.html");
    const content = await readFile(indexPath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    errorResponse(res, 404, "SPA not built — run the client build first");
  }
}

// -- Server -----------------------------------------------------------------

export function startServer(
  wikiDir: string,
  store: QMDStore | null,
  config: WebWikiConfig,
): ServerHandle {
  // Static files directory — built React SPA
  // Resolve relative to this file: src/webui/server.ts -> src/webui/client/dist
  const thisDir = typeof __dirname !== "undefined"
    ? __dirname
    : fileURLToPath(new URL(".", import.meta.url));
  const staticDir = join(thisDir, "client", "dist");

  const server: Server = createServer(async (req, res) => {
    setCorsHeaders(res);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // -- API routes -------------------------------------------------------

      // GET /api/pages
      if (method === "GET" && pathname === "/api/pages") {
        await handleListPages(wikiDir, url, req, res);
        return;
      }

      // GET /api/search?q=...
      if (method === "GET" && pathname === "/api/search") {
        const query = url.searchParams.get("q") ?? "";
        await handleSearch(wikiDir, store, query, req, res);
        return;
      }

      // GET /api/graph
      if (method === "GET" && pathname === "/api/graph") {
        await handleGraph(wikiDir, url, req, res);
        return;
      }

      // GET /api/log
      if (method === "GET" && pathname === "/api/log") {
        await handleLog(wikiDir, req, res);
        return;
      }

      // GET /api/sessions
      if (method === "GET" && pathname === "/api/sessions") {
        await handleSessions(wikiDir, url, req, res);
        return;
      }

      // POST /api/pages/:category/:slug/move
      const moveMatch = matchRoute("/api/pages/:category/:slug/move", pathname);
      if (method === "POST" && moveMatch) {
        await handleMovePage(wikiDir, store, moveMatch.params, req, res);
        return;
      }

      // GET /api/pages/:category/:slug
      const pageMatch = matchRoute("/api/pages/:category/:slug", pathname);
      if (method === "GET" && pageMatch) {
        await handleGetPage(wikiDir, pageMatch.params, req, res);
        return;
      }

      // PUT /api/pages/:category/:slug
      if (method === "PUT" && pageMatch) {
        await handleUpdatePage(wikiDir, store, pageMatch.params, req, res);
        return;
      }

      // -- Static files / SPA fallback --------------------------------------

      if (method === "GET") {
        // Try exact static file first
        const served = await serveStaticFile(staticDir, pathname, res);
        if (served) return;

        // SPA fallback — serve index.html for client-side routing
        // Only for non-API, non-asset paths
        if (!pathname.startsWith("/api/")) {
          await serveSpaFallback(staticDir, res);
          return;
        }
      }

      // -- 404 for unmatched routes -----------------------------------------
      errorResponse(res, 404, "Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[webui] Request error: ${message}`);
      errorResponse(res, 500, `Internal server error: ${message}`);
    }
  });

  const { host, port } = config;

  server.listen(port, host, () => {
    // Server is listening — logged by caller
  });

  const serverUrl = host === "0.0.0.0"
    ? `http://localhost:${port}`
    : `http://${host}:${port}`;

  return {
    url: serverUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}
