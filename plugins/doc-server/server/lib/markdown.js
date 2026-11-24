const { escapeHtml, escapeAttr } = require("./utils");
const { resolveRelativePath, isExternalHref } = require("./links");
const { isDocumentFile, toRawUrl, toViewUrl } = require("./preview");

function getHeadingId(text, index) {
  const slug = String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `heading-${index}`;
}

function renderTextFormatting(value = "") {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
}

function renderInline(source = "", currentFile = "", options = {}, config) {
  let text = escapeHtml(source);
  const htmlTokens = [];
  const stash = (html) => {
    const token = `%%HTMLTOKEN${htmlTokens.length}%%`;
    htmlTokens.push(html);
    return token;
  };

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => {
    href = href.trim();
    if (!href) return _;
    const resolved = resolveRelativePath(href, currentFile);
    const src = resolved ? toRawUrl(`${resolved.file}${resolved.suffix}`) : href;
    return stash(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    href = href.trim();
    if (!href) return _;
    const renderedLabel = renderTextFormatting(label);
    const resolved = resolveRelativePath(href, currentFile);
    if (resolved && isDocumentFile(resolved.file, config)) {
      const target = toViewUrl(resolved.file, options, config) + resolved.suffix;
      return stash(`<a href="${escapeAttr(target)}">${renderedLabel}</a>`);
    }
    if (resolved) {
      const target = toRawUrl(`${resolved.file}${resolved.suffix}`);
      return stash(`<a href="${escapeAttr(target)}">${renderedLabel}</a>`);
    }
    const target = isExternalHref(href) ? ' target="_blank" rel="noreferrer"' : "";
    return stash(`<a href="${escapeAttr(href)}"${target}>${renderedLabel}</a>`);
  });

  const formatted = renderTextFormatting(text);
  return htmlTokens.reduce((result, html, index) => result.replaceAll(`%%HTMLTOKEN${index}%%`, html), formatted);
}

function isTableDivider(line = "") {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderTable(lines = [], currentFile = "", options = {}, config) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  );
  const head = rows[0] || [];
  const body = rows.slice(2);
  return `<table><thead><tr>${head
    .map((cell) => `<th>${renderInline(cell, currentFile, options, config)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, currentFile, options, config)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function getIndentSize(value = "") {
  return value.replace(/\t/g, "    ").length;
}

function renderNestedList(items = [], currentFile = "", options = {}, config) {
  const root = { children: [] };
  const stack = [{ indent: -1, node: root }];

  items.forEach((item) => {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const node = {
      type: item.type,
      text: item.text,
      children: [],
    };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: item.indent, node });
  });

  const renderGroups = (nodes = []) => {
    let output = "";
    let index = 0;

    while (index < nodes.length) {
      const type = nodes[index].type;
      output += `<${type}>`;

      while (index < nodes.length && nodes[index].type === type) {
        const node = nodes[index];
        const children = node.children.length ? renderGroups(node.children) : "";
        output += `<li>${renderInline(node.text, currentFile, options, config)}${children}</li>`;
        index += 1;
      }

      output += `</${type}>`;
    }

    return output;
  };

  return renderGroups(root.children);
}

function renderMarkdown(markdown = "", currentFile = "", options = {}, config) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let blockquote = [];
  let code = null;
  let headingIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "), currentFile, options, config)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    html.push(renderNestedList(listItems, currentFile, options, config));
    listItems = [];
  };
  const flushBlockquote = () => {
    if (!blockquote.length) return;
    html.push(`<blockquote>${blockquote.map((line) => `<p>${renderInline(line, currentFile, options, config)}</p>`).join("")}</blockquote>`);
    blockquote = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^```/.test(line.trim())) {
      if (code) {
        html.push(renderCodeBlock(code));
        code = null;
      } else {
        flushParagraph();
        flushList();
        flushBlockquote();
        code = { lang: line.trim().slice(3).trim(), lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(raw);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushBlockquote();
      headingIndex += 1;
      const level = heading[1].length;
      const content = renderInline(heading[2].trim(), currentFile, options, config);
      const id = getHeadingId(heading[2].trim(), headingIndex);
      html.push(`<h${level} id="${escapeAttr(id)}"><a class="anchor" href="#${escapeAttr(id)}">#</a>${content}</h${level}>`);
      continue;
    }

    if (i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      flushParagraph();
      flushList();
      flushBlockquote();
      html.push(renderTable(tableLines, currentFile, options, config));
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushBlockquote();
      const match = unordered || ordered;
      listItems.push({
        type: unordered ? "ul" : "ol",
        indent: getIndentSize(match[1]),
        text: match[2],
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blockquote.push(quote[1]);
      continue;
    }

    if (listItems.length) {
      // Soft-wrapped text belongs to the active item, including lazy continuations.
      listItems[listItems.length - 1].text += ` ${line.trim()}`;
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushBlockquote();
  if (code) html.push(renderCodeBlock(code));
  return html.join("\n");
}

function renderCodeBlock(code) {
  const source = code.lines.join("\n");
  if (/^mermaid$/i.test((code.lang || "").trim())) {
    return `<div class="mermaid" role="img" aria-label="mermaid diagram">${escapeHtml(source)}</div>`;
  }
  return `<pre><code class="language-${escapeAttr(code.lang || "")}">${escapeHtml(source)}</code></pre>`;
}

function extractHeadings(markdown = "") {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  let code = false;
  let headingIndex = 0;

  lines.forEach((raw) => {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      code = !code;
      return;
    }
    if (code) return;

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (!heading) return;
    headingIndex += 1;
    const level = heading[1].length;
    const text = heading[2].trim();
    headings.push({
      id: getHeadingId(text, headingIndex),
      level,
      text: text.replace(/<[^>]+>/g, ""),
    });
  });

  return headings;
}

function extractTitle(markdown = "", fallback = "") {
  const heading = markdown.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim().replace(/<[^>]+>/g, "");
  return fallback;
}

module.exports = {
  renderMarkdown,
  extractHeadings,
  extractTitle,
};
