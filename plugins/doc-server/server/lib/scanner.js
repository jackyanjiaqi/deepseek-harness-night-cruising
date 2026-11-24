const fs = require("fs");
const path = require("path");
const { readIgnoreRules, shouldIgnoreListedDir } = require("./ignore");
const { toRootRelativePath, isInsideRoot, normalizeRootRelative } = require("./utils");
const { isDocumentFile } = require("./preview");
const documentPathCollator = new Intl.Collator("zh-Hans-CN");

function shouldIgnoreDirName(name = "", config) {
  return config.ignoreDirs.has(name) || name.toLowerCase().endsWith("_files");
}

function resolveRootFile(file = "", config) {
  const relative = normalizeRootRelative(file);
  if (!relative) return null;
  const filePath = path.resolve(config.root, relative);
  if (!isInsideRoot(filePath, config.root)) return null;
  return { relative, filePath };
}

function walkDocumentFiles(config, options = {}, dir = config.root, result = [], ignoreRules = []) {
  collectDocumentFiles(config, options, dir, result, ignoreRules);
  return result.sort(documentPathCollator.compare);
}

function collectDocumentFiles(config, options, dir, result, ignoreRules) {
  const respectIgnoreList = options.ignoreDocDirs !== false;
  const rules = dir === config.root ? readIgnoreRules(dir, config) : ignoreRules;
  if (!fs.existsSync(dir)) return result;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldIgnoreDirName(entry.name, config)) return;
      if (respectIgnoreList && shouldIgnoreListedDir(fullPath, rules, config)) return;
      collectDocumentFiles(config, options, fullPath, result, rules);
      return;
    }
    if (!entry.isFile() || !isDocumentFile(entry.name, config)) return;
    result.push(toRootRelativePath(fullPath, config.root));
  });

}

function buildTree(files = []) {
  const root = { name: "", path: "", type: "dir", children: new Map() };
  files.forEach((file) => {
    const parts = file.split("/");
    let current = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const childPath = parts.slice(0, index + 1).join("/");
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: childPath,
          type: isFile ? "file" : "dir",
          children: new Map(),
        });
      }
      current = current.children.get(part);
    });
  });
  return root;
}

module.exports = {
  resolveRootFile,
  walkDocumentFiles,
  buildTree,
};
