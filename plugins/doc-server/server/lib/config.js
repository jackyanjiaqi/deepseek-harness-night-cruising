const path = require("path");
const { IMAGE_MIME_TYPES } = require("./image-formats");

const GRAPH_FILE_NAMES = String(process.env.DOC_SERVER_GRAPH_FILES || "CATALOG.md")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "el_modules",
  "dist",
  "build",
  "out",
  ".vite",
  ".cache",
  ".VSCodeCounter",
]);

const IGNORE_DIR_LIST = [...IGNORE_DIRS];

const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".html",
  ".pdf",
  ".pptx",
  ".doc",
  ".docx",
  ...Object.keys(IMAGE_MIME_TYPES),
  ".txt",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ...IMAGE_MIME_TYPES,
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Build one isolated doc-server configuration. The original script bound a
 * single process-wide config; the DSH plugin runs one server per Session, so
 * every instance owns its own root, port, ignore rules, and public directory.
 *
 * @param {object} overrides - per-instance overrides.
 * @param {string} [overrides.root] - absolute directory to index.
 * @param {number} [overrides.port] - 0 asks the OS for a free port.
 * @param {string} [overrides.publicDir] - static asset directory.
 * @param {string[]|Set<string>} [overrides.ignoreDirs] - ignored directory names.
 * @param {string[]} [overrides.graphFileNames] - catalog file names.
 * @returns {object} frozen-in-shape config read by the server and renderers.
 */
function createConfig(overrides = {}) {
  const root = path.resolve(String(overrides.root || process.cwd()));
  const port = overrides.port !== undefined
    ? Number(overrides.port)
    : Number(process.env.DOC_SERVER_PORT || process.argv[2] || 4179);
  const graphFileNames = Array.isArray(overrides.graphFileNames) && overrides.graphFileNames.length > 0
    ? overrides.graphFileNames.map((name) => String(name).trim()).filter(Boolean)
    : GRAPH_FILE_NAMES;
  const ignoreDirs = overrides.ignoreDirs === undefined
    ? new Set(IGNORE_DIR_LIST)
    : new Set(overrides.ignoreDirs);

  return {
    root,
    port: Number.isSafeInteger(port) && port >= 0 ? port : 4179,
    ignoreDirs,
    documentExtensions: DOCUMENT_EXTENSIONS,
    graphFileNames,
    docignoreFile: ".docignore",
    fallbackIgnoreFile: ".gitignore",
    ignoreListQuery: "ignoreDocDirs",
    mimeTypes: MIME_TYPES,
    publicDir: overrides.publicDir || path.join(__dirname, "..", "public"),
  };
}

const config = createConfig();

module.exports = { config, createConfig, DOCUMENT_EXTENSIONS };
