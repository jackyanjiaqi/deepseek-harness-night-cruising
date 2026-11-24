const path = require("path");
const { escapeHtml, escapeAttr } = require("./utils");
const { buildTree } = require("./scanner");
const { extractHeadings } = require("./markdown");
const { isGraphNodeFile, toGraphUrl, toViewUrl, toRawUrl, getPreviewKind } = require("./preview");

function renderTreeNode(node, activeFile = "", options = {}, config) {
  if (node.type === "file") {
    const active = node.path === activeFile ? " active" : "";
    const kind = getPreviewKind(node.path);
    const viewHref = toViewUrl(node.path, options, config);
    const graphLink = isGraphNodeFile(node.path, config)
      ? `<a class="tree-graph" title="打开图谱" href="${escapeAttr(toGraphUrl(node.path, options, config))}">graph</a>`
      : "";
    return `<li class="tree-file-row" data-file="${escapeAttr(node.path)}">
      <a class="tree-file ${escapeAttr(kind)}${active}" data-file="${escapeAttr(node.path)}" href="${escapeAttr(viewHref)}">${escapeHtml(node.name)}</a>${graphLink}
      <span class="tree-cache-bar" title="缓存进度" aria-hidden="true"><i></i></span>
    </li>`;
  }

  const children = Array.from(node.children.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  const open = node.path && (activeFile === node.path || activeFile.startsWith(`${node.path}/`)) ? " open" : "";
  const content = children.map((child) => renderTreeNode(child, activeFile, options, config)).join("");
  return `<li class="tree-dir${open}" data-dir="${escapeAttr(node.path)}">
    <button class="tree-toggle" type="button" aria-expanded="${open ? "true" : "false"}">
      <span class="chevron">›</span><span>${escapeHtml(node.name)}</span>
    </button>
    <span class="tree-dir-cache-bar" title="目录缓存进度" aria-hidden="true"><i></i></span>
    <ul>${content}</ul>
  </li>`;
}

function renderTree(files = [], activeFile = "", options = {}, config) {
  const root = buildTree(files);
  const children = Array.from(root.children.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return `<ul class="tree-root">${children.map((child) => renderTreeNode(child, activeFile, options, config)).join("")}</ul>`;
}

function renderHeadingNav(headings = []) {
  if (!headings.length) return `<p class="nav-empty">当前文档没有标题。</p>`;
  const minLevel = Math.min(...headings.map((heading) => heading.level));
  return `<ul class="heading-nav">${headings
    .map((heading) => {
      const depth = Math.max(0, heading.level - minLevel);
      return `<li style="--depth:${depth}"><a href="#${escapeAttr(heading.id)}">${escapeHtml(heading.text)}</a></li>`;
    })
    .join("")}</ul>`;
}

function appendGraphHash(url = "", hash = "") {
  const cleanHash = String(hash || "").replace(/^#/, "");
  if (!cleanHash) return url;
  return `${url}#${cleanHash}`;
}

function focusHash(file = "") {
  return file ? `focus=${encodeURIComponent(file)}` : "";
}

function sharedStyle() {
  return `<style>
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --panel: #fff;
      --text: #20242b;
      --muted: #667085;
      --border: #d7dde7;
      --accent: #1d5fd3;
      --accent-soft: #e9f1ff;
      --line: #8fa4c7;
      --danger: #b42318;
      --code-bg: #f0f2f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.7;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    button, input, textarea, select { font: inherit; }
    .button-link, .tool-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 4px 10px;
      cursor: pointer;
      text-decoration: none;
    }
    .tool-button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
    .tool-button:disabled { cursor: not-allowed; opacity: 0.52; }
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width, 320px) 6px minmax(0, 1fr);
      min-height: 100vh;
    }
    aside {
      position: sticky;
      top: 0;
      height: 100vh;
      overflow: auto;
      border-right: 1px solid var(--border);
      background: var(--panel);
      padding: 18px 14px;
    }
    .resizer {
      cursor: col-resize;
      background: transparent;
      border-left: 1px solid transparent;
      border-right: 1px solid transparent;
    }
    .resizer:hover, body.resizing .resizer { background: #dbe7ff; border-color: #b9cdfb; }
    .brand { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
    .hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; overflow-wrap: anywhere; }
    .nav-options { display: grid; gap: 8px; margin: 0 0 12px; }
    .checkbox-line { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
    .prefetch-setting { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--muted); }
    .prefetch-setting input { width: 76px; min-width: 0; padding: 3px 6px; border: 1px solid var(--border); border-radius: 5px; }
    .prefetch-hint { margin: 0; font-size: 12px; color: var(--muted); }
    .tree-root, .tree-root ul, .heading-nav { list-style: none; padding: 0; margin: 0; }
    .tree-root ul { display: none; padding-left: 14px; }
    .tree-dir.open > ul { display: block; }
    .tree-toggle {
      display: flex;
      width: 100%;
      gap: 6px;
      align-items: center;
      border: 0;
      background: transparent;
      color: var(--text);
      padding: 4px 6px;
      text-align: left;
      border-radius: 6px;
      cursor: pointer;
    }
    .tree-toggle:hover, .tree-file:hover, .tree-graph:hover { background: #f0f4fb; text-decoration: none; }
    .chevron { width: 14px; transition: transform .15s ease; color: var(--muted); }
    .tree-dir.open > .tree-toggle .chevron { transform: rotate(90deg); }
    .tree-file-row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px;
      align-items: center;
      padding-bottom: 3px;
    }
    .tree-file, .tree-graph {
      display: block;
      min-width: 0;
      padding: 4px 6px;
      border-radius: 6px;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
    }
    .tree-file.active { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
    .tree-graph { color: var(--muted); font-size: 12px; border: 1px solid transparent; }
    .tree-cache-bar, .tree-dir-cache-bar {
      position: absolute;
      left: 6px;
      right: 6px;
      bottom: 0;
      height: 2px;
      border-radius: 1px;
      background: transparent;
      overflow: hidden;
      pointer-events: none;
    }
    .tree-dir { position: relative; padding-bottom: 3px; }
    .tree-dir-cache-bar { left: 20px; }
    .tree-cache-bar > i, .tree-dir-cache-bar > i {
      display: block;
      height: 100%;
      width: 0;
      background: #22c55e;
      transition: width .18s ease;
    }
    .tree-file-row.cache-pending .tree-cache-bar > i,
    .tree-file-row.cache-loading .tree-cache-bar > i,
    .tree-dir.cache-loading > .tree-dir-cache-bar > i {
      background: #86efac;
    }
    .tree-file-row.cache-error .tree-cache-bar > i { background: #f97066; }
    main { min-width: 0; padding: 28px clamp(18px, 4vw, 54px); }
    .content-shell { max-width: 980px; margin: 0 auto; }
    .top-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
    .doc-content {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 28px;
      min-height: 70vh;
      overflow: auto;
    }
    .doc-content h1, .doc-content h2, .doc-content h3 { line-height: 1.3; margin-top: 1.35em; }
    .doc-content h1:first-child, .doc-content h2:first-child { margin-top: 0; }
    .doc-content img { max-width: 100%; }
    .asset-preview { margin: 0; text-align: center; }
    .asset-original { display: block; cursor: zoom-in; }
    .asset-preview img { display: block; width: auto; height: auto; max-width: 100%; max-height: 75vh; object-fit: contain; margin: 0 auto; }
    .asset-preview figcaption { margin-top: 12px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .anchor { color: var(--muted); margin-right: 8px; opacity: .55; }
    pre, code { background: var(--code-bg); border-radius: 5px; }
    code { padding: 1px 5px; }
    pre { padding: 14px; overflow: auto; }
    pre code { padding: 0; background: transparent; }
    table { border-collapse: collapse; width: 100%; overflow: auto; }
    th, td { border: 1px solid var(--border); padding: 7px 9px; text-align: left; }
    blockquote { border-left: 4px solid var(--border); color: var(--muted); margin-left: 0; padding-left: 14px; }
    .mermaid {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      margin: 14px 0;
      overflow-x: auto;
      line-height: 1.4;
    }
    .mermaid svg { max-width: 100%; height: auto; }
    .mermaid-fallback { white-space: pre-wrap; overflow-x: auto; }
    .heading-card { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 16px; }
    .heading-nav li { padding-left: calc(var(--depth) * 14px); }
    .heading-nav a { display: block; padding: 3px 4px; color: var(--muted); font-size: 13px; }
    .nav-empty, .empty { color: var(--muted); }
    .doc-frame { width: 100%; height: 74vh; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
    .plain-text { white-space: pre-wrap; }
    .unsupported-preview { max-width: 720px; }
    @media (max-width: 860px) {
      .layout { display: block; }
      aside { position: relative; height: auto; }
      .resizer { display: none; }
      main { padding: 16px; }
      .doc-content { padding: 18px; }
    }
  </style>`;
}

function sharedScript() {
  return `<script>
    document.querySelectorAll(".tree-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const item = button.closest(".tree-dir");
        const open = item.classList.toggle("open");
        button.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
    (() => {
      const resizer = document.querySelector(".resizer");
      if (!resizer) return;
      const layout = document.querySelector(".layout");
      let startX = 0;
      let startWidth = 0;
      resizer.addEventListener("pointerdown", (event) => {
        startX = event.clientX;
        startWidth = parseInt(getComputedStyle(layout).getPropertyValue("--sidebar-width"), 10) || 320;
        document.body.classList.add("resizing");
        resizer.setPointerCapture(event.pointerId);
      });
      resizer.addEventListener("pointermove", (event) => {
        if (!document.body.classList.contains("resizing")) return;
        const next = Math.max(220, Math.min(620, startWidth + event.clientX - startX));
        layout.style.setProperty("--sidebar-width", next + "px");
      });
      resizer.addEventListener("pointerup", () => document.body.classList.remove("resizing"));
    })();
  </script>`;
}

function mermaidAssets() {
  return `
  <style>
    .mermaid { cursor: zoom-in; }
    .mermaid-lightbox {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      background: rgba(10, 14, 22, 0.84);
      backdrop-filter: blur(2px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .mermaid-lightbox[hidden] { display: none; }
    .mermaid-lightbox-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #161b26;
      color: #e6eaf1;
      border-bottom: 1px solid #2a3140;
      user-select: none;
      -webkit-user-select: none;
    }
    .mermaid-lightbox-title { font-weight: 700; margin-right: auto; font-size: 14px; }
    .mermaid-lightbox-hint { color: #8b96a8; font-size: 12px; margin-right: 10px; }
    .mermaid-lightbox-zoom { min-width: 48px; text-align: center; color: #b6c0d0; font-variant-numeric: tabular-nums; font-size: 13px; }
    .mermaid-lightbox-toolbar button {
      min-width: 34px;
      height: 30px;
      border: 1px solid #3a4356;
      border-radius: 6px;
      background: #222a38;
      color: #e6eaf1;
      font-size: 14px;
      cursor: pointer;
    }
    .mermaid-lightbox-toolbar button:hover { background: #2c3648; }
    .mermaid-lightbox-stage {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .mermaid-lightbox.dragging .mermaid-lightbox-stage { cursor: grabbing; }
    .mermaid-lightbox-canvas {
      transform-origin: center center;
      will-change: transform;
      background: #fff;
      border-radius: 6px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
      padding: 16px;
      max-width: none;
    }
    .mermaid-lightbox-canvas .mermaid { border: 0; background: transparent; margin: 0; padding: 0; cursor: inherit; }
    .mermaid-lightbox-canvas .mermaid svg { max-width: none; height: auto; }
    .mermaid-lightbox-canvas .mermaid-fallback { max-width: 80vw; }
    body.mermaid-lightbox-open { overflow: hidden; }
  </style>
  <script src="/public/vendor/mermaid.min.js"></script>
  <script>
    (() => {
      if (typeof window.mermaid === "undefined") return;

      window.mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "loose",
        maxTextSize: 2000000,
        // useMaxWidth:false → SVG 按自然尺寸渲染（viewBox 全图、文字 1:1）。
        // 文档流内由 CSS .mermaid svg{max-width:100%} 约束缩放（视觉不变）；
        // 灯箱内 max-width:none 即自然尺寸，100% 就是清晰原图，放大不再模糊。
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
      });

      // 渲染 scope 内所有尚未处理的 .mermaid 元素（动态注入后调用）。
      // mermaid.run 会给处理过的元素打上 data-processed 标记，避免重复渲染。
      window.renderMermaid = function (scope) {
        const root = scope || document;
        if (!root || typeof root.querySelectorAll !== "function") return Promise.resolve();
        const nodes = Array.from(root.querySelectorAll(".mermaid:not([data-processed])"));
        if (!nodes.length || typeof window.mermaid === "undefined") return Promise.resolve();
        nodes.forEach((node) => {
          node.__mermaidSource = node.textContent; // 保留源码，供灯箱重渲染
        });
        return window.mermaid.run({ nodes, suppressErrors: true }).catch((err) => {
          console.warn("[doc-server] mermaid render failed:", err);
          nodes.forEach((node) => {
            if (node.hasAttribute("data-processed")) return;
            const pre = document.createElement("pre");
            pre.className = "mermaid-fallback";
            pre.textContent = node.textContent;
            node.replaceWith(pre);
          });
        });
      };

      // ---------- 灯箱：大图可交互放大/缩小/平移 ----------
      const MIN_SCALE = 0.25;
      const MAX_SCALE = 4;
      let lightbox = null;
      let lbScale = 1;
      let lbTranslate = { x: 0, y: 0 };
      let lbDrag = null;
      let lbDragMoved = false;

      function escapeHtmlClient(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function ensureLightbox() {
        if (lightbox) return lightbox;
        lightbox = document.createElement("div");
        lightbox.className = "mermaid-lightbox";
        lightbox.setAttribute("role", "dialog");
        lightbox.setAttribute("aria-modal", "true");
        lightbox.hidden = true;
        lightbox.innerHTML =
          '<div class="mermaid-lightbox-toolbar">' +
          '<span class="mermaid-lightbox-title">Mermaid 图</span>' +
          '<span class="mermaid-lightbox-hint">滚轮缩放 · 拖拽平移</span>' +
          '<span class="mermaid-lightbox-zoom">100%</span>' +
          '<button type="button" data-lb-action="zoom-out" title="缩小">−</button>' +
          '<button type="button" data-lb-action="zoom-in" title="放大">＋</button>' +
          '<button type="button" data-lb-action="reset" title="复位到 100%">100%</button>' +
          '<button type="button" data-lb-action="fit" title="适应窗口">适应</button>' +
          '<button type="button" data-lb-action="close" title="关闭（Esc）">✕</button>' +
          "</div>" +
          '<div class="mermaid-lightbox-stage">' +
          '<div class="mermaid-lightbox-canvas"></div>' +
          "</div>";
        document.body.appendChild(lightbox);

        lightbox.querySelectorAll("[data-lb-action]").forEach((btn) => {
          btn.addEventListener("click", (event) => {
            event.stopPropagation();
            const action = btn.getAttribute("data-lb-action");
            if (action === "close") closeLightbox();
            else if (action === "zoom-in") zoomBy(1.25);
            else if (action === "zoom-out") zoomBy(1 / 1.25);
            else if (action === "reset") {
              lbScale = 1;
              lbTranslate = { x: 0, y: 0 };
              applyTransform();
            } else if (action === "fit") fitLightbox(false);
          });
        });

        // 点击遮罩空白处关闭（点击画布/工具条不关闭）
        // 拖拽结束后的补发 click 会被 lbDragMoved 标记抑制，避免拖拽即关闭。
        lightbox.addEventListener("click", (event) => {
          if (lbDragMoved) {
            lbDragMoved = false;
            return;
          }
          if (event.target === lightbox || (event.target.classList && event.target.classList.contains("mermaid-lightbox-stage"))) {
            closeLightbox();
          }
        });

        // 滚轮缩放（以光标为中心）
        lightbox.addEventListener(
          "wheel",
          (event) => {
            event.preventDefault();
            zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 1 / 1.1);
          },
          { passive: false },
        );

        // 拖拽平移（任意缩放级别都可平移）。
        // 只在 stage 上开始拖拽，避免工具条按钮按下时 setPointerCapture
        // 把后续 click 重定向到灯箱本体而误触发关闭。
        lightbox.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          if (!event.target.closest || !event.target.closest(".mermaid-lightbox-stage")) return;
          lbDragMoved = false;
          lbDrag = { sx: event.clientX, sy: event.clientY, tx: lbTranslate.x, ty: lbTranslate.y };
          lightbox.setPointerCapture(event.pointerId);
          lightbox.classList.add("dragging");
        });
        lightbox.addEventListener("pointermove", (event) => {
          if (!lbDrag) return;
          if (Math.abs(event.clientX - lbDrag.sx) > 3 || Math.abs(event.clientY - lbDrag.sy) > 3) {
            lbDragMoved = true;
          }
          lbTranslate.x = lbDrag.tx + (event.clientX - lbDrag.sx);
          lbTranslate.y = lbDrag.ty + (event.clientY - lbDrag.sy);
          applyTransform();
        });
        const endDrag = () => {
          lbDrag = null;
          lightbox.classList.remove("dragging");
        };
        lightbox.addEventListener("pointerup", endDrag);
        lightbox.addEventListener("pointercancel", endDrag);

        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && lightbox && !lightbox.hidden) closeLightbox();
        });

        return lightbox;
      }

      function applyTransform() {
        const canvas = lightbox.querySelector(".mermaid-lightbox-canvas");
        canvas.style.transform =
          "translate(" + lbTranslate.x + "px," + lbTranslate.y + "px) scale(" + lbScale + ")";
        const zoomLabel = lightbox.querySelector(".mermaid-lightbox-zoom");
        if (zoomLabel) zoomLabel.textContent = Math.round(lbScale * 100) + "%";
      }

      function zoomAt(clientX, clientY, factor) {
        const rect = lightbox.getBoundingClientRect();
        const cx = clientX - rect.left - rect.width / 2;
        const cy = clientY - rect.top - rect.height / 2;
        const prev = lbScale;
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        lbTranslate.x = cx - ((cx - lbTranslate.x) / prev) * next;
        lbTranslate.y = cy - ((cy - lbTranslate.y) / prev) * next;
        lbScale = next;
        applyTransform();
      }

      function zoomBy(factor) {
        const rect = lightbox.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
      }

      // noZoomIn=true 时只缩小不放大（用于打开默认态，小图保持 100%）
      function fitLightbox(noZoomIn) {
        const svg = lightbox.querySelector(".mermaid-lightbox-canvas svg");
        const canvas = lightbox.querySelector(".mermaid-lightbox-canvas");
        const stage = lightbox.querySelector(".mermaid-lightbox-stage");
        if (!svg || !canvas || !stage) return;
        canvas.style.transform = "none";
        const rect = svg.getBoundingClientRect();
        canvas.style.transform = "";
        const pad = 56;
        const availW = Math.max(80, stage.clientWidth - pad);
        const availH = Math.max(80, stage.clientHeight - pad);
        if (!rect.width || !rect.height) {
          lbScale = 1;
          lbTranslate = { x: 0, y: 0 };
          applyTransform();
          return;
        }
        let next = Math.min(availW / rect.width, availH / rect.height);
        if (noZoomIn) next = Math.min(next, 1);
        lbScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
        lbTranslate = { x: 0, y: 0 };
        applyTransform();
      }

      function openMermaidLightbox(source, title) {
        const box = ensureLightbox();
        const canvas = box.querySelector(".mermaid-lightbox-canvas");
        const titleEl = box.querySelector(".mermaid-lightbox-title");
        if (titleEl && title) titleEl.textContent = title;
        // 先显示灯箱再渲染：mermaid 需要在可见容器内测量尺寸，
        // 隐藏状态下渲染会得到 16x16 的微型 viewBox。
        box.hidden = false;
        document.body.classList.add("mermaid-lightbox-open");
        canvas.innerHTML = '<div class="mermaid">' + escapeHtmlClient(source) + "</div>";
        const node = canvas.querySelector(".mermaid");
        window.mermaid
          .run({ nodes: [node], suppressErrors: true })
          .catch((err) => {
            console.warn("[doc-server] mermaid lightbox render failed:", err);
            if (!node.hasAttribute("data-processed")) {
              const pre = document.createElement("pre");
              pre.className = "mermaid-fallback";
              pre.textContent = source;
              node.replaceWith(pre);
            }
          })
          .finally(() => {
            fitLightbox(true); // 打开默认态：大图缩小铺满，小图保持 100%
          });
      }

      function closeLightbox() {
        if (!lightbox) return;
        lightbox.hidden = true;
        document.body.classList.remove("mermaid-lightbox-open");
        const canvas = lightbox.querySelector(".mermaid-lightbox-canvas");
        if (canvas) canvas.innerHTML = "";
      }

      window.openMermaidLightbox = openMermaidLightbox;

      // 事件委托：点击文档流内的 mermaid 图打开灯箱（图内 <a> 链接除外）
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!target || !target.closest) return;
        if (lightbox && !lightbox.hidden && lightbox.contains(target)) return;
        const block = target.closest(".mermaid");
        if (!block) return;
        if (target.closest("a")) return;
        event.preventDefault();
        openMermaidLightbox(block.__mermaidSource || block.textContent, "Mermaid 图");
      });

      const runOnReady = () => {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", () => window.renderMermaid(document));
        } else {
          window.renderMermaid(document);
        }
      };
      runOnReady();
    })();
  </script>`;
}

/**
 * Parent-frame bridge used by the DSH "文档服务" view. The doc server is
 * embedded in an iframe on a different port, so every in-app navigation is
 * announced through postMessage; the DSH tab keeps that session's last
 * location without reading the iframe document.
 */
function bridgeScript() {
  return `<script>
    (function () {
      var lastHref = "";
      function currentFile() {
        try { return new URL(location.href).searchParams.get("file") || ""; } catch (_) { return ""; }
      }
      function notify() {
        if (location.href === lastHref) return;
        lastHref = location.href;
        try {
          window.parent.postMessage({
            type: "dsh-doc-server:location",
            href: location.href,
            file: currentFile()
          }, "*");
        } catch (_) { /* The page also works standalone. */ }
      }
      var push = history.pushState;
      var replace = history.replaceState;
      history.pushState = function () { var result = push.apply(this, arguments); notify(); return result; };
      history.replaceState = function () { var result = replace.apply(this, arguments); notify(); return result; };
      window.addEventListener("popstate", notify);
      window.addEventListener("hashchange", notify);
      window.addEventListener("load", notify);
      window.addEventListener("message", function (event) {
        var data = event.data || {};
        if (data.type !== "dsh-doc-server:navigate" || typeof data.url !== "string") return;
        try {
          var next = new URL(data.url, location.origin);
          if (next.origin !== location.origin) return;
          location.href = next.href;
        } catch (_) { /* Ignore malformed navigation requests. */ }
      });
    })();
  </script>`;
}

function renderDocumentPage({
  file = "",
  content = "",
  rendered = "",
  files = [],
  ignoreDocDirs = true,
  graphFile = "",
  graphFocusFile = "",
  graphState = "",
  headings = [],
  title: docTitle = "",
  kind = "",
}, config) {
  const title = docTitle || file || "Docs";
  const renderOptions = { ignoreDocDirs, graphFile, graphState };
  const fileNav = renderTree(files, file, renderOptions, config);
  const resolvedHeadings = headings || (content ? extractHeadings(content) : []);
  const headingNav = file ? renderHeadingNav(resolvedHeadings) : `<p class="nav-empty">先选择一个文档。</p>`;
  const graphHash = graphState || focusHash(file);
  const graphBack = graphFile
    ? `<a class="button-link" href="${escapeAttr(appendGraphHash(toGraphUrl(graphFile, { ignoreDocDirs }, config), graphHash))}">返回图谱</a>`
    : "";
  const graphOpenFile = file && isGraphNodeFile(file, config) ? file : graphFocusFile;
  const graphOpenHash = graphOpenFile && graphOpenFile !== file ? focusHash(file) : "";
  const graphOpen = file && graphOpenFile && !graphBack
    ? `<a class="button-link" href="${escapeAttr(appendGraphHash(toGraphUrl(graphOpenFile, { ignoreDocDirs }, config), graphOpenHash))}">打开图谱</a>`
    : "";
  const rawOpen = file ? `<a class="button-link" href="${escapeAttr(toRawUrl(file))}">原始文件</a>` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${sharedStyle()}
</head>
<body>
  <div class="layout">
    <aside>
      <p class="brand">Docs</p>
      <p class="hint">${files.length} files · ${escapeHtml(config.root)}</p>
      <div class="nav-options">
        <label class="checkbox-line">
          <input id="ignoreToggle" type="checkbox" ${ignoreDocDirs ? "checked" : ""}>
          <span>忽略 .docignore/.gitignore 中的目录</span>
        </label>
        <label class="prefetch-setting" for="prefetchDepth">
          <span>预渲染层数</span>
          <input id="prefetchDepth" type="number" min="1" step="1" value="1" aria-describedby="prefetchHint">
        </label>
        <label class="prefetch-setting" for="prefetchCount">
          <span>预渲染数量</span>
          <input id="prefetchCount" type="number" min="0" step="1" value="5" aria-describedby="prefetchHint">
        </label>
        <p class="prefetch-hint" id="prefetchHint">1 层为当前目录，数量为所选层数内的总上限。其余文档点击后加载；数量为 0 时关闭预渲染。</p>
      </div>
      ${fileNav}
      <section class="heading-card">
        <p class="brand">Headings</p>
        ${headingNav}
      </section>
    </aside>
    <div class="resizer" aria-hidden="true"></div>
    <main>
      <div class="content-shell">
        <nav class="top-actions">${graphBack}${graphOpen}${rawOpen}</nav>
        <article class="doc-content">${rendered || `<div class="empty"><h1>Docs</h1><p>从左侧选择一个文档。</p></div>`}</article>
      </div>
    </main>
  </div>
  ${mermaidAssets()}
  ${sharedScript()}
  <script>
    const ignoreToggle = document.getElementById("ignoreToggle");
    if (ignoreToggle) {
      ignoreToggle.addEventListener("change", () => {
        const nextUrl = new URL(location.href);
        if (ignoreToggle.checked) {
          nextUrl.searchParams.delete("${escapeAttr(config.ignoreListQuery)}");
          nextUrl.searchParams.delete("ignoreGitignoreDirs");
        } else {
          nextUrl.searchParams.set("${escapeAttr(config.ignoreListQuery)}", "0");
        }
        location.href = nextUrl.toString();
      });
    }
  </script>
  <script>
    window.DOC_VIEW_BOOT = {
      mode: "view",
      file: ${JSON.stringify(file || "")},
      title: ${JSON.stringify(title || "")},
      kind: ${JSON.stringify(kind || "")},
      headings: ${JSON.stringify(resolvedHeadings || [])},
      ignoreDocDirs: ${ignoreDocDirs ? "true" : "false"},
      ignoreParam: ${JSON.stringify(config.ignoreListQuery)},
      graphFile: ${JSON.stringify(graphFile || "")},
      graphState: ${JSON.stringify(graphState || "")}
    };
  </script>
  <script src="/public/doc-app.js"></script>
  ${bridgeScript()}
</body>
</html>`;
}

function renderGraphPage({ file = "", ignoreDocDirs = true }, config) {
  const escapedFile = JSON.stringify(file);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Graph - ${escapeHtml(file || "Docs")}</title>
  ${sharedStyle()}
  <style>
    body { overflow: hidden; }
    .graph-app, .graph-pane, #graphStage, #graphStage * {
      user-select: none;
      -webkit-user-select: none;
    }
    .graph-app {
      display: grid;
      grid-template-columns: minmax(360px, var(--graph-width, 58vw)) 6px minmax(320px, 1fr);
      height: 100vh;
      background: var(--bg);
    }
    .graph-pane, .doc-pane { min-width: 0; min-height: 0; }
    .graph-pane { display: grid; grid-template-rows: auto minmax(0, 1fr); background: #eef2f7; }
    .graph-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      padding: 10px;
    }
    .graph-toolbar input[type="search"] { width: 220px; min-height: 32px; border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
    .depth-control { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 13px; }
    #graphStage { width: 100%; height: 100%; touch-action: none; cursor: grab; }
    #graphStage.dragging { cursor: grabbing; }
    .edge { stroke: var(--line); stroke-opacity: .78; cursor: pointer; }
    .edge.selected { stroke: var(--accent); stroke-opacity: 1; }
    .node circle { fill: #fff; stroke: #5e78a7; stroke-width: 2; cursor: pointer; }
    .node.catalog circle { fill: #e9f1ff; stroke: #1d5fd3; }
    .node.heading circle { fill: #f0f9ff; stroke: #0369a1; }
    .node.list circle { fill: #f7fee7; stroke: #4d7c0f; }
    .node.link circle { fill: #fff7ed; stroke: #b45309; }
    .node.document circle { fill: #fff; stroke: #3f6b5a; }
    .node.asset circle { fill: #fff7ed; stroke: #c2410c; }
    .node.missing circle { fill: #fff1f2; stroke: #b42318; stroke-dasharray: 4 3; }
    .node.external circle { fill: #f3f4f6; stroke: #667085; }
    .node.selected circle, .node.search-hit circle { stroke-width: 4; }
    .node text { font-size: 12px; paint-order: stroke; stroke: #fff; stroke-width: 4px; stroke-linejoin: round; fill: var(--text); pointer-events: none; user-select: none; -webkit-user-select: none; }
    .node-toggle { cursor: pointer; }
    .node-toggle .toggle-circle { fill: #fff; stroke: var(--accent); stroke-width: 1.5; }
    .node-toggle .toggle-text { font-size: 13px; font-weight: 800; fill: var(--accent); stroke: none; pointer-events: none; }
    .doc-pane { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--panel); border-left: 1px solid var(--border); }
    .doc-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--border); padding: 10px; }
    .doc-title { margin-right: auto; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .doc-body { min-height: 0; overflow: auto; padding: 18px; }
    .editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; height: 100%; }
    .editor-grid textarea { width: 100%; height: calc(100vh - 118px); resize: none; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: Consolas, "Courier New", monospace; line-height: 1.5; }
    .preview-pane { height: calc(100vh - 118px); overflow: auto; border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
    .split-resizer { cursor: col-resize; background: transparent; border-left: 1px solid transparent; border-right: 1px solid transparent; }
    .split-resizer:hover, body.graph-resizing .split-resizer { background: #dbe7ff; border-color: #b9cdfb; }
    .graph-app.doc-first { --graph-width: 36vw; }
    .graph-app.edit-mode { --graph-width: 48vw; }
    .graph-app.graph-full { grid-template-columns: minmax(0, 1fr) 0 0; }
    .graph-app.graph-full .doc-pane, .graph-app.graph-full .split-resizer { display: none; }
    @media (max-width: 900px) {
      body { overflow: auto; }
      .graph-app { display: block; height: auto; }
      .graph-pane { height: 70vh; }
      .doc-pane { min-height: 60vh; }
      .split-resizer { display: none; }
      .editor-grid { display: block; }
      .editor-grid textarea, .preview-pane { height: 45vh; margin-bottom: 10px; }
    }
  </style>
</head>
<body>
  <div class="graph-app" id="graphApp">
    <section class="graph-pane">
      <div class="graph-toolbar">
        <a class="tool-button" href="/">Docs</a>
        <button class="tool-button active" data-mode="graph">图谱优先</button>
        <button class="tool-button" data-mode="doc">文档优先</button>
        <button class="tool-button" data-mode="edit">分屏编辑</button>
        <button class="tool-button" id="fitBtn">适配</button>
        <button class="tool-button" id="focusBtn">聚焦</button>
        <button class="tool-button" id="toggleSelectedBtn" title="切换当前节点的展开状态">展开/收起当前节点</button>
        <button class="tool-button" id="toggleAllBtn" title="切换整张图谱的展开状态">展开全部</button>
        <button class="tool-button" id="fullBtn">全屏图谱</button>
        <input id="searchInput" type="search" placeholder="搜索节点">
      </div>
      <svg id="graphStage" role="img" aria-label="目录知识图谱"></svg>
    </section>
    <div class="split-resizer" aria-hidden="true"></div>
    <section class="doc-pane">
      <div class="doc-toolbar">
        <div class="doc-title" id="docTitle">选择节点</div>
        <a class="tool-button" id="openDocBtn" href="#">打开</a>
        <a class="tool-button" id="openGraphBtn" href="#">图谱</a>
        <button class="tool-button" id="saveBtn">保存</button>
      </div>
      <div class="doc-body" id="docBody"><p class="nav-empty">单击节点查看文档，双击进入详情。</p></div>
    </section>
  </div>
  ${mermaidAssets()}
  <script>
    window.DOC_GRAPH_BOOT = {
      file: ${escapedFile},
      ignoreDocDirs: ${ignoreDocDirs ? "true" : "false"},
      ignoreParam: ${JSON.stringify(config.ignoreListQuery)}
    };
  </script>
  <script src="/public/graph-app.js"></script>
  ${bridgeScript()}
</body>
</html>`;
}

module.exports = {
  renderDocumentPage,
  renderGraphPage,
};
