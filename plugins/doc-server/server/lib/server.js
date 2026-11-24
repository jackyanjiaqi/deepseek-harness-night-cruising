const fs = require("fs");
const path = require("path");
const http = require("http");
const { send, json, normalizeRootRelative, isInsideRoot } = require("./utils");
const { shouldRespectIgnoreList } = require("./ignore");
const { walkDocumentFiles, resolveRootFile } = require("./scanner");
const { renderMarkdown, extractHeadings, extractTitle } = require("./markdown");
const { buildGraph, subgraphFor, findNearestGraphFile } = require("./graph");
const {
  getMimeType,
  isDocumentFile,
  isMarkdownFile,
  isTextFile,
  renderFilePreview,
  toViewUrl,
  getPreviewKind,
  findCatalogNearFile,
} = require("./preview");
const { getCachedDocument, setCachedDocument, invalidateDocument } = require("./doc-cache");
const { renderDocumentPage, renderGraphPage } = require("./views");

function sendFile(res, filePath, config) {
  res.writeHead(200, {
    "Content-Type": getMimeType(filePath, config),
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function resolveRawPath(pathname = "", config) {
  const rawPrefix = "/raw/";
  if (!pathname.startsWith(rawPrefix)) return null;
  try {
    const requested = decodeURIComponent(pathname.slice(rawPrefix.length));
    const filePath = path.resolve(config.root, requested);
    if (!isInsideRoot(filePath, config.root)) return null;
    return filePath;
  } catch (_) {
    return null;
  }
}

function resolvePublicPath(pathname = "", config) {
  const publicPrefix = "/public/";
  if (!pathname.startsWith(publicPrefix)) return null;
  try {
    const requested = decodeURIComponent(pathname.slice(publicPrefix.length));
    const filePath = path.resolve(config.publicDir, requested);
    if (!isInsideRoot(filePath, config.publicDir)) return null;
    return filePath;
  } catch (_) {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function loadDocument(file, options, config) {
  const resolved = resolveRootFile(file, config);
  if (!resolved) return { status: 400, error: "Invalid document path" };
  if (!isDocumentFile(resolved.relative, config)) return { status: 400, error: "Unsupported document path" };
  if (!fs.existsSync(resolved.filePath) || !fs.statSync(resolved.filePath).isFile()) {
    return { status: 404, error: "Document not found" };
  }

  const cached = getCachedDocument(resolved.relative, resolved.filePath, options);
  if (cached) return { status: 200, document: cached };

  const kind = getPreviewKind(resolved.relative);
  const editable = isMarkdownFile(resolved.relative) || isTextFile(resolved.relative);
  const rawContent = editable ? fs.readFileSync(resolved.filePath, "utf8") : "";
  const html = isMarkdownFile(resolved.relative)
    ? renderMarkdown(rawContent, resolved.relative, options, config)
    : "";
  const rendered = renderFilePreview({
    file: resolved.relative,
    filePath: resolved.filePath,
    html,
    content: rawContent,
  });
  const title = isMarkdownFile(resolved.relative)
    ? extractTitle(rawContent, path.basename(resolved.relative))
    : path.basename(resolved.relative);

  const document = {
    file: resolved.relative,
    title,
    kind,
    editable,
    content: rawContent,
    html: rendered,
    headings: isMarkdownFile(resolved.relative) ? extractHeadings(rawContent) : [],
  };
  setCachedDocument(resolved.relative, resolved.filePath, options, document);
  return { status: 200, document };
}

function createDocServer(config) {
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, "http://127.0.0.1");
    const query = Object.fromEntries(parsed.searchParams.entries());
    const ignoreDocDirs = shouldRespectIgnoreList(query, config);
    const graphState = String(query.graphState || "").replace(/^#/, "");
    const renderOptions = { ignoreDocDirs, graphFile: normalizeRootRelative(query.graphFile || ""), graphState };

    try {
      if (parsed.pathname === "/") {
        const files = walkDocumentFiles(config, renderOptions);
        const first = files.find((file) => /readme?\.md$/i.test(path.basename(file))) || files[0] || "";
        res.writeHead(302, { Location: first ? toViewUrl(first, renderOptions, config) : "/view" });
        res.end();
        return;
      }

      if (parsed.pathname.startsWith("/public/")) {
        const filePath = resolvePublicPath(parsed.pathname, config);
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          send(res, 404, "Public file not found", "text/plain; charset=utf-8");
          return;
        }
        sendFile(res, filePath, config);
        return;
      }

      if (parsed.pathname.startsWith("/raw/")) {
        const filePath = resolveRawPath(parsed.pathname, config);
        if (!filePath) {
          send(res, 400, "Invalid static path", "text/plain; charset=utf-8");
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          send(res, 404, "Static file not found", "text/plain; charset=utf-8");
          return;
        }
        sendFile(res, filePath, config);
        return;
      }

      if (parsed.pathname === "/api/graph") {
        const graph = buildGraph(config);
        const requested = normalizeRootRelative(query.file || "");
        const center = findNearestGraphFile(requested, graph);
        if (query.mode === "full") {
          json(res, 200, { ...graph, center });
          return;
        }
        json(res, 200, subgraphFor(graph, center, query.depth || 1));
        return;
      }

      if (parsed.pathname === "/api/document") {
        const requested = normalizeRootRelative(query.file || "");
        const result = loadDocument(requested, renderOptions, config);
        if (result.status !== 200) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 200, result.document);
        return;
      }

      if (parsed.pathname === "/api/document/preview") {
        if (req.method !== "POST") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        const body = JSON.parse(await readBody(req));
        const requested = normalizeRootRelative(body.file || "");
        if (!requested || !isMarkdownFile(requested)) {
          json(res, 400, { error: "Only markdown preview is supported" });
          return;
        }
        json(res, 200, {
          html: renderMarkdown(String(body.content || ""), requested, renderOptions, config),
          headings: extractHeadings(String(body.content || "")),
        });
        return;
      }

      if (parsed.pathname === "/api/document/save") {
        if (req.method !== "POST") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        const body = JSON.parse(await readBody(req));
        const requested = normalizeRootRelative(body.file || "");
        const resolved = resolveRootFile(requested, config);
        if (!resolved || !fs.existsSync(resolved.filePath) || !fs.statSync(resolved.filePath).isFile()) {
          json(res, 404, { error: "Document not found" });
          return;
        }
        if (!isMarkdownFile(resolved.relative) && !isTextFile(resolved.relative)) {
          json(res, 400, { error: "Only markdown and text documents are editable" });
          return;
        }
        fs.writeFileSync(resolved.filePath, String(body.content || ""), "utf8");
        invalidateDocument(resolved.filePath);
        const result = loadDocument(resolved.relative, renderOptions, config);
        json(res, 200, { ok: true, document: result.document });
        return;
      }

      if (parsed.pathname === "/graph") {
        const graph = buildGraph(config);
        const requested = normalizeRootRelative(query.file || "");
        const file = findNearestGraphFile(requested, graph);
        send(res, 200, renderGraphPage({ file, ignoreDocDirs }, config));
        return;
      }

      if (parsed.pathname === "/view") {
        const files = walkDocumentFiles(config, renderOptions);
        const requested = normalizeRootRelative(query.file || "");
        if (!requested) {
          send(res, 200, renderDocumentPage({ files, ignoreDocDirs }, config));
          return;
        }
        const result = loadDocument(requested, renderOptions, config);
        if (result.status !== 200) {
          send(res, result.status, result.error, "text/plain; charset=utf-8");
          return;
        }
        const graphFocusFile = findCatalogNearFile(result.document.file, config);
        send(
          res,
          200,
          renderDocumentPage({
            file: result.document.file,
            content: result.document.content,
            rendered: result.document.html,
            files,
            ignoreDocDirs,
            graphFile: renderOptions.graphFile,
            graphFocusFile,
            graphState,
            headings: result.document.headings,
            title: result.document.title,
            kind: result.document.kind,
          }, config),
        );
        return;
      }

      send(res, 404, "Not found", "text/plain; charset=utf-8");
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
}

module.exports = {
  createDocServer,
};
