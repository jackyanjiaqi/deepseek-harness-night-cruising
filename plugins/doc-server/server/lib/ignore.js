const fs = require("fs");
const path = require("path");
const { matchesPattern, toRootRelativePath } = require("./utils");

function getIgnoreListPath(dir, config) {
  const docignorePath = path.join(dir, config.docignoreFile);
  if (fs.existsSync(docignorePath) && fs.statSync(docignorePath).isFile()) {
    return docignorePath;
  }

  const fallbackPath = path.join(dir, config.fallbackIgnoreFile);
  if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isFile()) {
    return fallbackPath;
  }

  return null;
}

function readIgnoreRules(dir, config) {
  const ignorePath = getIgnoreListPath(dir, config);
  if (!ignorePath) return [];

  const base = toRootRelativePath(dir, config.root);
  return fs
    .readFileSync(ignorePath, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      let pattern = negated ? line.slice(1).trim() : line;
      const directoryOnly = pattern.endsWith("/");
      pattern = pattern.replace(/\\/g, "/").replace(/\/+$/g, "");
      const anchored = pattern.startsWith("/");
      pattern = pattern.replace(/^\/+/g, "");
      if (!pattern || pattern === ".") return null;
      return {
        base,
        pattern,
        negated,
        anchored,
        directoryOnly,
        hasSlash: pattern.includes("/"),
      };
    })
    .filter(Boolean);
}

function matchesIgnoreDirRule(dirPath = "", rule, config) {
  const basePath = rule.base ? path.join(config.root, ...rule.base.split("/")) : config.root;
  const relative = path.relative(basePath, dirPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;

  if (rule.anchored || rule.hasSlash) {
    return matchesPattern(rule.pattern, relative);
  }

  return relative.split("/").some((part) => matchesPattern(rule.pattern, part));
}

function shouldIgnoreListedDir(dirPath = "", rules = [], config) {
  return rules.reduce((ignored, rule) => {
    if (!matchesIgnoreDirRule(dirPath, rule, config)) return ignored;
    return !rule.negated;
  }, false);
}

function shouldRespectIgnoreList(query = {}, config) {
  const value = String(query[config.ignoreListQuery] || query.ignoreGitignoreDirs || "").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

module.exports = {
  readIgnoreRules,
  shouldIgnoreListedDir,
  shouldRespectIgnoreList,
};
