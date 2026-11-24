const fs = require("fs");
const path = require("path");
const { extractMarkdownLinks } = require("./links");
const { extractTitle } = require("./markdown");
const { resolveRootFile, walkDocumentFiles } = require("./scanner");
const { isGraphNodeFile, isMarkdownFile, getPreviewKind, toViewUrl } = require("./preview");

function fileTitle(file = "") {
  const base = path.posix.basename(file);
  return base.replace(/\.[^.]+$/, "") || file;
}

function classifyNode(file = "", exists = false, config) {
  if (!exists) return "missing";
  if (isGraphNodeFile(file, config)) return "catalog";
  return getPreviewKind(file) === "image" ? "asset" : "document";
}

function getNode(nodes, file, exists, config, title = "") {
  if (!nodes.has(file)) {
    nodes.set(file, {
      id: file,
      path: file,
      title: title || fileTitle(file),
      kind: classifyNode(file, exists, config),
      exists,
    });
  } else if (title && nodes.get(file).title === fileTitle(file)) {
    nodes.get(file).title = title;
  }
  return nodes.get(file);
}

function getVirtualNode(nodes, source = "", context = {}, parentId = "", config) {
  const id = `${source}#${context.type}:${context.line}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      path: source,
      title: context.text || context.type,
      kind: context.type,
      exists: true,
      virtual: true,
      line: context.line,
      level: context.level,
      href: toViewUrl(source, {}, config),
      parentId,
    });
  }
  return nodes.get(id);
}

function getLinkNode(nodes, source = "", link = {}, parentId = "", index = 0, config) {
  const context = (link.hierarchy || []).find((item) => item.line === link.line && item.type === "list");
  const id = context ? `${source}#list:${context.line}` : `${source}#link:${link.line}:${index}`;
  const resolvedFile = link.resolved ? link.resolved.file : "";
  const exists = link.external || !!resolvedFile;
  const href = link.external
    ? link.href
    : resolvedFile
      ? toViewUrl(resolvedFile, { graphFile: source }, config) + (link.resolved?.suffix || "")
      : link.href;
  const targetKind = link.external
    ? "external"
    : resolvedFile
      ? classifyNode(resolvedFile, exists, config)
      : "missing";

  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      path: source,
      title: link.label || link.href,
      kind: "link",
      exists: true,
      virtual: true,
      line: link.line,
      level: (link.hierarchy || []).length || link.level || 1,
      href,
      targetPath: resolvedFile || link.href,
      targetKind,
      external: link.external,
      parentId,
    });
  } else {
    const node = nodes.get(id);
    node.title = link.label || node.title;
    node.kind = "link";
    node.href = href;
    node.targetPath = resolvedFile || link.href;
    node.targetKind = targetKind;
    node.external = link.external;
  }

  return nodes.get(id);
}

function pushEdge(edges, edgeIds, edge) {
  const id = edge.id || `${edge.source}->${edge.target}:${edge.line || 0}:${edge.level || 1}`;
  if (edgeIds.has(id)) return;
  edgeIds.add(id);
  edges.push({ ...edge, id });
}

function readMarkdownTitle(file, config) {
  const resolved = resolveRootFile(file, config);
  if (!resolved || !fs.existsSync(resolved.filePath)) return fileTitle(file);
  try {
    return extractTitle(fs.readFileSync(resolved.filePath, "utf8"), fileTitle(file));
  } catch (_) {
    return fileTitle(file);
  }
}

function getH1Headings(markdown = "") {
  const headings = [];
  let code = false;
  markdown.replace(/\r\n/g, "\n").split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      code = !code;
      return;
    }
    if (code) return;
    const heading = line.match(/^#\s+(.+)$/);
    if (!heading) return;
    headings.push({
      text: heading[1].trim().replace(/<[^>]+>/g, ""),
      line: index + 1,
    });
  });
  return headings;
}

function getRootInfo(markdown = "", source = "") {
  const h1Headings = getH1Headings(markdown);
  if (h1Headings.length === 1) {
    return {
      title: h1Headings[0].text,
      mergedHeadingLine: h1Headings[0].line,
    };
  }

  return {
    title: fileTitle(source),
    mergedHeadingLine: null,
  };
}

function shouldSkipRootHeading(context = {}, rootInfo = {}) {
  return context.type === "heading" && context.line === rootInfo.mergedHeadingLine;
}

function buildGraph(config) {
  const allFiles = walkDocumentFiles(config, { ignoreDocDirs: false });
  const existing = new Set(allFiles);
  const graphFiles = allFiles.filter((file) => isGraphNodeFile(file, config) && isMarkdownFile(file));
  const nodes = new Map();
  const edges = [];
  const edgeIds = new Set();

  allFiles.forEach((file) => {
    if (isGraphNodeFile(file, config)) {
      getNode(nodes, file, true, config, readMarkdownTitle(file, config));
    }
  });

  graphFiles.forEach((source) => {
    const sourceResolved = resolveRootFile(source, config);
    if (!sourceResolved || !fs.existsSync(sourceResolved.filePath)) return;
    const markdown = fs.readFileSync(sourceResolved.filePath, "utf8");
    const rootInfo = getRootInfo(markdown, source);
    const sourceNode = getNode(nodes, source, true, config, rootInfo.title);
    sourceNode.title = rootInfo.title;
    const links = extractMarkdownLinks(markdown, source);
    links.forEach((link, index) => {
      let parent = source;
      const hierarchy = link.hierarchy || [];
      const linkContext = hierarchy.find((context) => context.type === "list" && context.line === link.line);
      const structuralHierarchy = (linkContext ? hierarchy.slice(0, hierarchy.indexOf(linkContext)) : hierarchy)
        .filter((context) => !shouldSkipRootHeading(context, rootInfo));

      structuralHierarchy.forEach((context, contextIndex) => {
        const node = getVirtualNode(nodes, source, context, parent, config);
        pushEdge(edges, edgeIds, {
          id: `${parent}->${node.id}`,
          source: parent,
          target: node.id,
          label: context.text,
          href: node.href,
          line: context.line,
          level: contextIndex + 1,
          hierarchy: true,
        });
        parent = node.id;
      });

      const linkNode = getLinkNode(nodes, source, link, parent, index, config);
      pushEdge(edges, edgeIds, {
        id: `${parent}->${linkNode.id}`,
        source: parent,
        target: linkNode.id,
        label: link.label,
        href: linkNode.href,
        line: link.line,
        level: structuralHierarchy.length + 1,
        link: true,
      });

      if (!link.resolved) {
        return;
      }

      const target = link.resolved.file;
      const existsTarget = existing.has(target) || fs.existsSync(path.resolve(config.root, target));
      linkNode.exists = existsTarget;
      linkNode.targetKind = classifyNode(target, existsTarget, config);
      if (isGraphNodeFile(target, config)) {
        getNode(nodes, target, existsTarget, config, existsTarget && isMarkdownFile(target) ? readMarkdownTitle(target, config) : fileTitle(target));
        linkNode.targetNodeId = target;
      }
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    graphFileNames: config.graphFileNames,
    nodes: Array.from(nodes.values()),
    edges,
  };
}

function subgraphFor(graph, center = "", depth = 1) {
  const normalizedDepth = Math.max(0, Math.min(5, Number(depth) || 1));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const start = nodeIds.has(center) ? center : graph.nodes[0]?.id || "";
  if (!start) return { ...graph, center: "", nodes: [], edges: [] };

  const visited = new Set([start]);
  let frontier = new Set([start]);
  for (let currentDepth = 0; currentDepth < normalizedDepth; currentDepth += 1) {
    const next = new Set();
    graph.edges.forEach((edge) => {
      if (frontier.has(edge.source) && !visited.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !visited.has(edge.source)) next.add(edge.source);
    });
    next.forEach((id) => visited.add(id));
    frontier = next;
  }

  const nodes = graph.nodes.filter((node) => visited.has(node.id));
  const edges = graph.edges.filter((edge) => visited.has(edge.source) && visited.has(edge.target));
  return {
    generatedAt: graph.generatedAt,
    graphFileNames: graph.graphFileNames,
    center: start,
    nodes,
    edges,
  };
}

function findNearestGraphFile(file = "", graph) {
  if (!file) return graph.nodes.find((node) => node.kind === "catalog")?.id || "";
  if (graph.nodes.some((node) => node.id === file && node.kind === "catalog")) return file;
  const source = graph.edges.find((edge) => edge.target === file)?.source;
  return source || graph.nodes.find((node) => node.kind === "catalog")?.id || "";
}

module.exports = {
  buildGraph,
  subgraphFor,
  findNearestGraphFile,
};
