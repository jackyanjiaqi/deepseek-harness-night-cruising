const path = require("path");
const { normalizeRootRelative } = require("./utils");

function isExternalHref(href = "") {
  return /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//");
}

function splitHref(href = "") {
  const match = String(href).match(/^([^?#]*)([?#].*)?$/);
  return {
    filePart: match ? match[1] : href,
    suffix: match ? match[2] || "" : "",
  };
}

function resolveRelativePath(href = "", currentFile = "") {
  if (!currentFile || !href || isExternalHref(href) || href.startsWith("#")) return null;

  const { filePart, suffix } = splitHref(href);
  if (!filePart) return null;

  const baseDir = path.posix.dirname(currentFile.replace(/\\/g, "/"));
  const relativePath = filePart.startsWith("/")
    ? filePart.replace(/^\/+/, "")
    : path.posix.normalize(path.posix.join(baseDir, filePart));

  const normalized = normalizeRootRelative(relativePath);
  if (!normalized) return null;
  return { file: normalized, suffix };
}

function getIndentSize(value = "") {
  return value.replace(/\t/g, "    ").length;
}

function stripMarkdownLinks(value = "") {
  return String(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function extractLineLinks(raw = "", currentFile = "", level = 1) {
  const links = [];
  const markdownLink = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownLink.exec(raw))) {
    const isImage = match[0].startsWith("!");
    const href = match[2].trim();
    if (!href) continue;
    links.push({
      label: match[1] || href,
      href,
      level,
      isImage,
      external: isExternalHref(href),
      resolved: resolveRelativePath(href, currentFile),
    });
  }

  const htmlHref = /\bhref=["']([^"']+)["']/gi;
  while ((match = htmlHref.exec(raw))) {
    links.push({
      label: match[1],
      href: match[1],
      level,
      isImage: false,
      external: isExternalHref(match[1]),
      resolved: resolveRelativePath(match[1], currentFile),
    });
  }

  return links;
}

function parseHeading(raw = "", line = 0) {
  const match = raw.trimEnd().match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;
  return {
    type: "heading",
    level: match[1].length,
    text: stripMarkdownLinks(match[2]),
    line,
  };
}

function parseListItem(raw = "", line = 0) {
  const unordered = raw.match(/^(\s*)[-*+]\s+(.+)$/);
  const ordered = raw.match(/^(\s*)\d+[.)]\s+(.+)$/);
  const match = unordered || ordered;
  if (!match) return null;
  return {
    type: "list",
    level: 1,
    indent: getIndentSize(match[1]),
    text: stripMarkdownLinks(match[2]) || "未命名列表项",
    line,
  };
}

function buildHeadingHierarchy(lines = [], targetIndex = 0) {
  const stack = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const heading = parseHeading(lines[index], index + 1);
    if (!heading) continue;
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
  }
  return stack;
}

function buildListHierarchy(lines = [], targetIndex = 0) {
  const current = parseListItem(lines[targetIndex], targetIndex + 1);
  if (!current) return [];

  const parents = [];
  let childIndent = current.indent;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const heading = parseHeading(lines[index], index + 1);
    if (heading) break;

    const item = parseListItem(lines[index], index + 1);
    if (!item || item.indent >= childIndent) continue;
    parents.push(item);
    childIndent = item.indent;
    if (childIndent === 0) break;
  }

  return parents.reverse().concat(current).map((item, index) => ({
    ...item,
    level: index + 1,
  }));
}

function buildLinkHierarchy(lines = [], targetIndex = 0) {
  return buildHeadingHierarchy(lines, targetIndex).concat(buildListHierarchy(lines, targetIndex));
}

function extractMarkdownLinks(markdown = "", currentFile = "") {
  const links = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;

    const hierarchy = buildLinkHierarchy(lines, index);
    extractLineLinks(raw, currentFile, hierarchy.length || 1).forEach((link) => {
      links.push({
        ...link,
        line: index + 1,
        hierarchy,
      });
    });
  });

  return links;
}

module.exports = {
  isExternalHref,
  splitHref,
  resolveRelativePath,
  extractMarkdownLinks,
  stripMarkdownLinks,
  buildLinkHierarchy,
};
