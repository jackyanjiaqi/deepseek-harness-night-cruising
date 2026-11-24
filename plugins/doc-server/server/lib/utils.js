const path = require("path");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function toPosixPath(value = "") {
  return String(value).replace(/\\/g, "/");
}

function toRootRelativePath(filePath = "", root = process.cwd()) {
  return toPosixPath(path.relative(root, filePath));
}

function isInsideRoot(filePath, root = process.cwd()) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeRootRelative(value = "") {
  const clean = decodeURIComponent(String(value || "")).replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(clean);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return "";
  }
  return normalized;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function wildcardToRegExp(pattern = "") {
  const source = pattern
    .split("")
    .map((char) => {
      if (char === "*") return "[^/]*";
      if (char === "?") return "[^/]";
      return escapeRegExp(char);
    })
    .join("");
  return new RegExp(`^${source}$`);
}

function matchesPattern(pattern = "", value = "") {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === value;
  return wildcardToRegExp(pattern).test(value);
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

module.exports = {
  escapeHtml,
  escapeAttr,
  toPosixPath,
  toRootRelativePath,
  isInsideRoot,
  normalizeRootRelative,
  escapeRegExp,
  wildcardToRegExp,
  matchesPattern,
  json,
  send,
};
