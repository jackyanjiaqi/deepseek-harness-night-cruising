const fs = require("fs");
const path = require("path");
const { escapeHtml, escapeAttr } = require("./utils");
const { IMAGE_MIME_TYPES } = require("./image-formats");

function ext(file = "") {
  return path.extname(file).toLowerCase();
}

function isMarkdownFile(file = "") {
  return ext(file) === ".md";
}

function isHtmlFile(file = "") {
  return ext(file) === ".html";
}

function isTextFile(file = "") {
  return ext(file) === ".txt";
}

function isImageFile(file = "") {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, ext(file));
}

function isPdfFile(file = "") {
  return ext(file) === ".pdf";
}

function isOfficeFile(file = "") {
  return new Set([".doc", ".docx", ".ppt", ".pptx"]).has(ext(file));
}

function isDocumentFile(file = "", config) {
  return config.documentExtensions.has(ext(file));
}

function getMimeType(filePath = "", config) {
  return config.mimeTypes[ext(filePath)] || "application/octet-stream";
}

function toRawUrl(file = "") {
  return `/raw/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function toViewUrl(file = "", options = {}, config) {
  const params = new URLSearchParams();
  params.set("file", file);
  if (options.ignoreDocDirs === false) params.set(config.ignoreListQuery, "0");
  if (options.graphFile) params.set("graphFile", options.graphFile);
  if (options.graphState) params.set("graphState", options.graphState);
  return `/view?${params.toString()}`;
}

function toGraphUrl(file = "", options = {}, config) {
  const params = new URLSearchParams();
  params.set("file", file);
  if (options.ignoreDocDirs === false) params.set(config.ignoreListQuery, "0");
  return `/graph?${params.toString()}`;
}

function isGraphNodeFile(file = "", config) {
  const name = path.posix.basename(file.replace(/\\/g, "/"));
  return config.graphFileNames.some((graphName) => graphName.toLowerCase() === name.toLowerCase());
}

/** Walk parent dirs for CATALOG.md (etc.) — avoids full buildGraph on every /view. */
function findCatalogNearFile(file = "", config) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (normalized && isGraphNodeFile(normalized, config)) return normalized;

  const parts = normalized.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const dir = parts.slice(0, i).join("/");
    for (const name of config.graphFileNames) {
      const relative = dir ? `${dir}/${name}` : name;
      const absolute = path.resolve(config.root, relative);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return relative;
    }
  }

  for (const name of config.graphFileNames) {
    const absolute = path.resolve(config.root, name);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return name;
  }
  return "";
}

function getPreviewKind(file = "") {
  if (isMarkdownFile(file)) return "markdown";
  if (isHtmlFile(file)) return "html";
  if (isTextFile(file)) return "text";
  if (isImageFile(file)) return "image";
  if (isPdfFile(file)) return "pdf";
  if (isOfficeFile(file)) return "office";
  return "download";
}

function renderFilePreview({ file, filePath, html = "", content = "" }) {
  const kind = getPreviewKind(file);
  const raw = toRawUrl(file);
  const basename = path.basename(file);

  if (kind === "markdown") return html;
  if (kind === "html") {
    return `<iframe class="doc-frame" src="${escapeAttr(raw)}" title="${escapeAttr(basename)}"></iframe>`;
  }
  if (kind === "text") {
    return `<pre class="plain-text">${escapeHtml(content)}</pre>`;
  }
  if (kind === "image") {
    return `<figure class="asset-preview">
      <a class="asset-original" href="${escapeAttr(raw)}" target="_blank" rel="noopener noreferrer" title="打开原图">
        <img src="${escapeAttr(raw)}" alt="${escapeAttr(basename)}" decoding="async">
      </a>
      <figcaption>${escapeHtml(file)} · 点击图片查看原图</figcaption>
    </figure>`;
  }
  if (kind === "pdf") {
    return `<iframe class="doc-frame" src="${escapeAttr(raw)}" title="${escapeAttr(basename)}"></iframe>`;
  }

  let size = "";
  try {
    size = `${fs.statSync(filePath).size} bytes`;
  } catch (_) {
    size = "unknown size";
  }
  return `<section class="unsupported-preview">
    <h1>${escapeHtml(basename)}</h1>
    <p>${escapeHtml(file)} · ${escapeHtml(size)}</p>
    <p>此格式已进入文档索引和图谱，可通过原始文件入口打开或下载。</p>
    <a class="button-link" href="${escapeAttr(raw)}">打开原始文件</a>
  </section>`;
}

module.exports = {
  isMarkdownFile,
  isHtmlFile,
  isTextFile,
  isDocumentFile,
  isGraphNodeFile,
  findCatalogNearFile,
  getMimeType,
  getPreviewKind,
  renderFilePreview,
  toRawUrl,
  toViewUrl,
  toGraphUrl,
};
