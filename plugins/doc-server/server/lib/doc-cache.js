const fs = require("fs");
const path = require("path");

/** @type {Map<string, { mtimeMs: number, size: number, document: object }>} */
const documentCache = new Map();
const MAX_ENTRIES = 200;

function optionsKey(options = {}) {
  return [
    options.ignoreDocDirs === false ? "0" : "1",
    options.graphFile || "",
    options.graphState || "",
  ].join("\0");
}

/**
 * Cache identity is the absolute file path, not the root-relative path: one
 * DSH process runs several Session servers, and a relative key would let two
 * roots with the same file name and timestamp serve each other's HTML.
 */
function cacheKey(filePath = "", options = {}) {
  return `${path.resolve(filePath)}\0${optionsKey(options)}`;
}

function filePathOfKey(key = "") {
  const end = key.indexOf("\0");
  return end === -1 ? key : key.slice(0, end);
}

function getCachedDocument(file, filePath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return null;
  }
  const key = cacheKey(filePath, options);
  const hit = documentCache.get(key);
  if (!hit) return null;
  if (hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
    documentCache.delete(key);
    return null;
  }
  // Refresh LRU order
  documentCache.delete(key);
  documentCache.set(key, hit);
  return hit.document;
}

function setCachedDocument(file, filePath, options = {}, document) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return;
  }
  const key = cacheKey(filePath, options);
  if (documentCache.has(key)) documentCache.delete(key);
  documentCache.set(key, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    document,
  });
  while (documentCache.size > MAX_ENTRIES) {
    const oldest = documentCache.keys().next().value;
    documentCache.delete(oldest);
  }
}

function invalidateDocument(target = "") {
  const absolute = path.resolve(target);
  for (const key of [...documentCache.keys()]) {
    if (filePathOfKey(key) === absolute) documentCache.delete(key);
  }
}

/** Drop every rendered document so a switched root cannot serve stale HTML. */
function clearDocumentCache() {
  documentCache.clear();
}

/** Drop only the documents under one root; other Session servers keep theirs. */
function clearDocumentCacheForRoot(root = "") {
  const absoluteRoot = path.resolve(root);
  const prefix = `${absoluteRoot}${path.sep}`;
  for (const key of [...documentCache.keys()]) {
    const filePath = filePathOfKey(key);
    if (filePath === absoluteRoot || filePath.startsWith(prefix)) documentCache.delete(key);
  }
}

module.exports = {
  getCachedDocument,
  setCachedDocument,
  invalidateDocument,
  clearDocumentCache,
  clearDocumentCacheForRoot,
};
