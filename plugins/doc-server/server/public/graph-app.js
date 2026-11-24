(function () {
  const boot = window.DOC_GRAPH_BOOT || {};
  const app = document.getElementById("graphApp");
  const svg = document.getElementById("graphStage");
  const docBody = document.getElementById("docBody");
  const docTitle = document.getElementById("docTitle");
  const openDocBtn = document.getElementById("openDocBtn");
  const openGraphBtn = document.getElementById("openGraphBtn");
  const saveBtn = document.getElementById("saveBtn");
  const searchInput = document.getElementById("searchInput");
  const fitBtn = document.getElementById("fitBtn");
  const focusBtn = document.getElementById("focusBtn");
  const toggleSelectedBtn = document.getElementById("toggleSelectedBtn");
  const toggleAllBtn = document.getElementById("toggleAllBtn");
  const fullBtn = document.getElementById("fullBtn");
  const ns = "http://www.w3.org/2000/svg";

  let fullGraph = { nodes: [], edges: [], center: "" };
  let graph = { nodes: [], edges: [], center: "" };
  let selectedNode = null;
  let selectedEdge = null;
  let editingDocument = null;
  let expanded = new Set();
  let transform = { x: 0, y: 0, scale: 1 };
  let draggingNode = null;
  let pointerState = null;
  let panning = null;
  let simulationTimer = null;
  let previewTimer = null;
  let hashWriteTimer = null;
  let applyingHashState = false;

  function clearSelection() {
    const selection = window.getSelection && window.getSelection();
    if (selection && selection.removeAllRanges) selection.removeAllRanges();
  }

  // 动态注入 HTML 后，让 mermaid 渲染其中的 .mermaid 图表
  function refreshMermaid(scope) {
    if (typeof window.renderMermaid === "function") {
      window.renderMermaid(scope || docBody);
    }
  }

  function params(extra) {
    const query = new URLSearchParams();
    Object.entries(extra || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== "") query.set(key, value);
    });
    if (boot.ignoreDocDirs === false) query.set(boot.ignoreParam || "ignoreDocDirs", "0");
    return query.toString();
  }

  function viewUrl(file) {
    return "/view?" + params({ file, graphFile: fullGraph.center || boot.file, graphState: graphStateForLink() });
  }

  function graphUrl(file) {
    return "/graph?" + params({ file });
  }

  function graphUrlWithFocus(file, focus) {
    const target = file || focus || "";
    const focusValue = focus || file || "";
    return graphUrl(target) + (focusValue ? `#focus=${encodeURIComponent(focusValue)}` : "");
  }

  function apiUrl(path, extra) {
    return path + "?" + params(extra);
  }

  function roundNumber(value, digits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    return Number(number.toFixed(digits));
  }

  function parseGraphHash() {
    const raw = location.hash ? location.hash.slice(1) : "";
    const params = new URLSearchParams(raw);
    const open = (params.get("open") || "").split(",").filter(Boolean);
    const x = Number(params.get("x"));
    const y = Number(params.get("y"));
    const z = Number(params.get("z"));
    return {
      node: params.get("node") || "",
      focus: params.get("focus") || "",
      open,
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      z: Number.isFinite(z) ? z : null,
      mode: params.get("mode") || "",
      full: params.get("full") === "1",
    };
  }

  function currentMode() {
    const active = document.querySelector("[data-mode].active");
    return active?.dataset.mode || "graph";
  }

  function serializeGraphHash() {
    const query = new URLSearchParams();
    if (selectedNode?.id) query.set("node", selectedNode.id);
    const openNodes = Array.from(expanded).filter(Boolean);
    if (openNodes.length) query.set("open", openNodes.join(","));
    query.set("x", String(roundNumber(transform.x, 1)));
    query.set("y", String(roundNumber(transform.y, 1)));
    query.set("z", String(roundNumber(transform.scale, 3)));
    const mode = currentMode();
    if (mode && mode !== "graph") query.set("mode", mode);
    if (app.classList.contains("graph-full")) query.set("full", "1");
    return query.toString();
  }

  function writeGraphHash() {
    if (applyingHashState) return;
    const hash = serializeGraphHash();
    const next = location.pathname + location.search + (hash ? `#${hash}` : "");
    history.replaceState(null, "", next);
  }

  function updateGraphHash(delay) {
    if (applyingHashState) return;
    if (hashWriteTimer) clearTimeout(hashWriteTimer);
    hashWriteTimer = setTimeout(writeGraphHash, delay === undefined ? 160 : delay);
  }

  function setDisplayMode(mode, options) {
    const nextMode = new Set(["graph", "doc", "edit"]).has(mode) ? mode : "graph";
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === nextMode);
    });
    app.classList.remove("doc-first", "edit-mode");
    if (nextMode === "doc") app.classList.add("doc-first");
    if (nextMode === "edit") app.classList.add("edit-mode");
    if (!options?.skipRender) {
      renderDocumentBody();
      render();
    }
  }

  function graphStateForLink() {
    return serializeGraphHash();
  }

  function clearSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function size() {
    const box = svg.getBoundingClientRect();
    return { width: Math.max(320, box.width), height: Math.max(240, box.height) };
  }

  function nodeById(id) {
    return fullGraph.nodes.find((node) => node.id === id);
  }

  function outgoingEdges(node) {
    if (!node) return [];
    const direct = fullGraph.edges.filter((edge) => edge.source === node.id);
    const targetSource = node.targetNodeId || "";
    if (!targetSource || targetSource === node.id) return direct;

    const proxied = fullGraph.edges
      .filter((edge) => edge.source === targetSource)
      .map((edge) => ({
        ...edge,
        id: `${node.id}::${edge.id}`,
        source: node.id,
        proxied: true,
      }));
    return direct.concat(proxied);
  }

  function hasChildren(node) {
    return outgoingEdges(node).length > 0;
  }

  function expandableNodes() {
    return fullGraph.nodes.filter((node) => hasChildren(node));
  }

  function selectedNodeIsVisible() {
    return !!selectedNode && graph.nodes.some((node) => node.id === selectedNode.id);
  }

  function allExpandableNodesOpen() {
    const nodes = expandableNodes();
    return nodes.length > 0 && nodes.every((node) => expanded.has(node.id));
  }

  function updateToggleButtons() {
    const selectedCanToggle = selectedNodeIsVisible() && hasChildren(selectedNode);
    if (toggleSelectedBtn) {
      toggleSelectedBtn.disabled = !selectedCanToggle;
      if (!selectedNode || !selectedNodeIsVisible()) {
        toggleSelectedBtn.textContent = "当前无子项";
      } else {
        toggleSelectedBtn.textContent = selectedCanToggle
          ? (expanded.has(selectedNode.id) ? "收起当前节点" : "展开当前节点")
          : "当前无子项";
      }
    }

    if (toggleAllBtn) {
      const hasExpandableNodes = expandableNodes().length > 0;
      toggleAllBtn.disabled = !hasExpandableNodes;
      toggleAllBtn.textContent = hasExpandableNodes && allExpandableNodesOpen() ? "收起全部" : "展开全部";
    }
  }

  function nodeHref(node) {
    if (!node) return "";
    if (node.href) return node.href;
    if (node.kind === "external") return node.path;
    if (node.exists && !node.virtual) return viewUrl(node.path);
    return "";
  }

  function findPathFromCenter(targetId) {
    const center = fullGraph.center || boot.file || fullGraph.nodes[0]?.id || "";
    if (!center || !targetId) return [];
    const queue = [[center]];
    const visited = new Set([center]);
    while (queue.length) {
      const path = queue.shift();
      const id = path[path.length - 1];
      if (id === targetId) return path;
      const node = nodeById(id);
      outgoingEdges(node).forEach((edge) => {
        if (visited.has(edge.target) || !nodeById(edge.target)) return;
        visited.add(edge.target);
        queue.push(path.concat(edge.target));
      });
    }
    return [];
  }

  function expandPathTo(node) {
    if (!node) return;
    const path = findPathFromCenter(node.id);
    path.slice(0, -1).forEach((id) => expanded.add(id));
  }

  function resolveFocusNode(value) {
    if (!value) return null;
    return fullGraph.nodes.find((node) => node.id === value)
      || fullGraph.nodes.find((node) => node.path === value)
      || fullGraph.nodes.find((node) => node.targetPath === value)
      || null;
  }

  function centerOnNode(node, scale) {
    if (!node) return;
    const box = size();
    const nextScale = scale || 1.35;
    transform = {
      x: node.x - box.width / (2 * nextScale),
      y: node.y - box.height / (2 * nextScale),
      scale: nextScale,
    };
  }

  function applyHashState(options) {
    applyingHashState = true;
    const state = parseGraphHash();
    const center = fullGraph.center || boot.file || fullGraph.nodes[0]?.id || "";
    expanded = new Set(center ? [center] : []);
    state.open.forEach((id) => {
      if (nodeById(id)) expanded.add(id);
    });
    const target = resolveFocusNode(state.node) || resolveFocusNode(state.focus) || nodeById(center);
    if (target) {
      expandPathTo(target);
      selectedNode = target;
      selectedEdge = null;
    }
    computeVisibleGraph();
    if (state.x !== null && state.y !== null && state.z !== null) {
      transform = {
        x: state.x,
        y: state.y,
        scale: Math.max(0.35, Math.min(3, state.z)),
      };
    } else if (target && (state.node || state.focus)) {
      centerOnNode(target);
    }
    app.classList.toggle("graph-full", state.full);
    setDisplayMode(state.mode || "graph", { skipRender: true });
    applyingHashState = false;
    if (!options?.skipRender) render();
  }

  function activateNode(node) {
    if (!node) return;
    if (node.kind === "link" || node.kind === "external") {
      const href = nodeHref(node);
      if (href) {
        location.href = href;
        return;
      }
    }
    selectedEdge = null;
    selectedNode = node;
    loadDocument(node);
    render();
    updateGraphHash();
  }

  function computeVisibleGraph() {
    const center = fullGraph.center || boot.file || fullGraph.nodes[0]?.id || "";
    const visibleIds = new Set();
    const visibleEdges = [];
    const edgeIds = new Set();

    function visit(id) {
      if (!id || visibleIds.has(id)) return;
      const node = nodeById(id);
      if (!node) return;
      visibleIds.add(id);
      if (!expanded.has(id)) return;

      outgoingEdges(node).forEach((edge) => {
        if (!nodeById(edge.target)) return;
        if (!edgeIds.has(edge.id)) {
          edgeIds.add(edge.id);
          visibleEdges.push(edge);
        }
        visit(edge.target);
      });
    }

    visit(center);
    graph = {
      ...fullGraph,
      nodes: fullGraph.nodes.filter((node) => visibleIds.has(node.id)),
      edges: visibleEdges,
    };
  }

  function initializePositions() {
    const box = size();
    const radius = Math.max(130, Math.min(box.width, box.height) * 0.34);
    fullGraph.nodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, fullGraph.nodes.length);
      node.x = node.x || box.width / 2 + Math.cos(angle) * radius;
      node.y = node.y || box.height / 2 + Math.sin(angle) * radius;
      node.vx = node.vx || 0;
      node.vy = node.vy || 0;
    });
  }

  function tick() {
    const box = size();
    const centerX = box.width / 2;
    const centerY = box.height / 2;
    const byId = new Map(fullGraph.nodes.map((node) => [node.id, node]));

    fullGraph.nodes.forEach((a, i) => {
      for (let j = i + 1; j < fullGraph.nodes.length; j += 1) {
        const b = fullGraph.nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(24, Math.sqrt(dx * dx + dy * dy));
        const force = 900 / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    });

    graph.edges.forEach((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const desired = 120 + Math.min(90, (edge.level || 1) * 14);
      const force = (distance - desired) * 0.006;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    });

    fullGraph.nodes.forEach((node) => {
      if (node.fixed) return;
      node.vx += (centerX - node.x) * 0.002;
      node.vy += (centerY - node.y) * 0.002;
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += node.vx;
      node.y += node.vy;
    });
  }

  function render() {
    clearSvg();
    svg.setAttribute("viewBox", `${transform.x} ${transform.y} ${size().width / transform.scale} ${size().height / transform.scale}`);

    const edgeLayer = document.createElementNS(ns, "g");
    const nodeLayer = document.createElementNS(ns, "g");
    svg.append(edgeLayer, nodeLayer);
    const byId = new Map(fullGraph.nodes.map((node) => [node.id, node]));

    graph.edges.forEach((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("class", "edge" + (selectedEdge && selectedEdge.id === edge.id ? " selected" : ""));
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
      line.setAttribute("stroke-width", Math.max(1.5, Math.min(7, 1 + (edge.level || 1))));
      line.setAttribute("stroke-dasharray", edge.external ? "5 5" : "");
      line.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        if (edge.href) {
          location.href = edge.href;
          return;
        }
        selectedEdge = edge;
        selectedNode = target;
        showEdge(edge);
        render();
        updateGraphHash();
      });
      edgeLayer.appendChild(line);
    });

    const search = (searchInput.value || "").trim().toLowerCase();
    graph.nodes.forEach((node) => {
      const group = document.createElementNS(ns, "g");
      const hit = search && `${node.title} ${node.path} ${node.targetPath || ""}`.toLowerCase().includes(search);
      group.setAttribute("class", `node ${node.kind}${selectedNode && selectedNode.id === node.id ? " selected" : ""}${hit ? " search-hit" : ""}`);
      group.setAttribute("transform", `translate(${node.x}, ${node.y})`);

      const radius = node.kind === "catalog" ? 22 : node.virtual ? 15 : 17;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("r", radius);
      group.appendChild(circle);

      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", 0);
      text.setAttribute("y", node.kind === "catalog" ? 36 : node.virtual ? 29 : 31);
      text.setAttribute("text-anchor", "middle");
      text.textContent = node.title.length > 24 ? node.title.slice(0, 23) + "..." : node.title;
      group.appendChild(text);

      if (hasChildren(node)) {
        const toggle = document.createElementNS(ns, "g");
        toggle.setAttribute("class", "node-toggle");
        toggle.setAttribute("transform", `translate(${radius * 0.72}, ${-radius * 0.72})`);
        const toggleCircle = document.createElementNS(ns, "circle");
        toggleCircle.setAttribute("r", 8);
        toggleCircle.setAttribute("class", "toggle-circle");
        const toggleText = document.createElementNS(ns, "text");
        toggleText.setAttribute("text-anchor", "middle");
        toggleText.setAttribute("dominant-baseline", "central");
        toggleText.setAttribute("class", "toggle-text");
        toggleText.textContent = expanded.has(node.id) ? "-" : "+";
        toggle.append(toggleCircle, toggleText);
        toggle.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearSelection();
        });
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearSelection();
          toggleNode(node);
        });
        group.appendChild(toggle);
      }

      group.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        draggingNode = node;
        node.fixed = true;
        pointerState = {
          node,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        if (group.setPointerCapture) group.setPointerCapture(event.pointerId);
      });
      group.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
      });
      group.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        const href = nodeHref(node);
        if (href) location.href = href;
      });
      nodeLayer.appendChild(group);
    });
    updateToggleButtons();
  }

  function runSimulation(rounds) {
    if (simulationTimer) clearInterval(simulationTimer);
    let remaining = rounds || 120;
    simulationTimer = setInterval(() => {
      tick();
      render();
      remaining -= 1;
      if (remaining <= 0) clearInterval(simulationTimer);
    }, 16);
  }

  async function loadGraph() {
    const response = await fetch(apiUrl("/api/graph", { file: boot.file, mode: "full" }));
    fullGraph = await response.json();
    initializePositions();
    applyHashState({ skipRender: true });
    if (!selectedNode) selectedNode = graph.nodes.find((node) => node.id === graph.center) || graph.nodes[0] || null;
    render();
    runSimulation(140);
    if (selectedNode) loadDocument(selectedNode);
    updateGraphHash(0);
  }

  async function loadDocument(node) {
    if (!node) return;
    docTitle.textContent = node.title || node.path;
    openDocBtn.href = node.href || (node.exists && node.kind !== "external" ? viewUrl(node.path) : node.path);
    openGraphBtn.href = graphUrlWithFocus(node.targetPath || node.path, node.targetPath || node.path || node.id);
    saveBtn.disabled = true;
    editingDocument = null;

    if (node.virtual || node.kind === "link") {
      docBody.innerHTML = `<section class="doc-content">
        <h2>${node.title || "层级节点"}</h2>
        <p>类型：${node.kind === "heading" ? "标题" : node.kind === "link" ? "链接" : "列表项"}</p>
        <p>来源：${node.path}</p>
        ${node.targetPath ? `<p>目标：${node.targetPath}</p>` : ""}
        <p>层级：${node.level || 1} · 行号：${node.line || "-"}</p>
        <p><a href="${node.href || viewUrl(node.path)}">打开</a></p>
      </section>`;
      return;
    }

    if (node.kind === "external") {
      docBody.innerHTML = `<p class="nav-empty">外部链接</p><p><a href="${node.path}" target="_blank" rel="noreferrer">${node.path}</a></p>`;
      return;
    }
    if (!node.exists) {
      docBody.innerHTML = `<p class="nav-empty">文件不存在：${node.path}</p>`;
      return;
    }

    const response = await fetch(apiUrl("/api/document", { file: node.path, graphFile: graph.center || boot.file }));
    const data = await response.json();
    if (data.error) {
      docBody.innerHTML = `<p class="nav-empty">${data.error}</p>`;
      return;
    }
    editingDocument = data;
    saveBtn.disabled = !data.editable;
    renderDocumentBody();
  }

  function renderDocumentBody() {
    if (!editingDocument) return;
    if (app.classList.contains("edit-mode") && editingDocument.editable) {
      docBody.innerHTML = `<div class="editor-grid">
        <textarea id="docEditor" spellcheck="false"></textarea>
        <div class="preview-pane" id="docPreview"></div>
      </div>`;
      const editor = document.getElementById("docEditor");
      const preview = document.getElementById("docPreview");
      editor.value = editingDocument.content || "";
      preview.innerHTML = editingDocument.html || "";
      refreshMermaid(preview);
      editor.addEventListener("input", () => {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(async () => {
          if (editingDocument.kind !== "markdown") {
            preview.textContent = editor.value;
            return;
          }
          const response = await fetch("/api/document/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: editingDocument.file, content: editor.value }),
          });
          const result = await response.json();
          preview.innerHTML = result.html || "";
          refreshMermaid(preview);
        }, 180);
      });
      return;
    }
    docBody.innerHTML = `<article class="doc-content">${editingDocument.html || ""}</article>`;
    refreshMermaid(docBody);
  }

  function showEdge(edge) {
    const target = nodeById(edge.target);
    docTitle.textContent = edge.label || "链接";
    openDocBtn.href = edge.href || (target ? target.href || viewUrl(target.path) : "#");
    openGraphBtn.href = target ? graphUrlWithFocus(target.targetPath || target.path, target.targetPath || target.path || target.id) : "#";
    saveBtn.disabled = true;
    docBody.innerHTML = `<section class="doc-content">
      <h2>${edge.label || "链接"}</h2>
      <p>来源：${edge.source}</p>
      <p>目标：${target ? target.title || target.path : edge.target}</p>
      <p>层级：${edge.level || 1} · 行号：${edge.line || "-"}</p>
      <p><a href="${edge.href || "#"}">打开目标</a></p>
    </section>`;
  }

  function toggleNode(node) {
    selectedNode = node;
    if (expanded.has(node.id)) expanded.delete(node.id);
    else expanded.add(node.id);
    computeVisibleGraph();
    render();
    updateGraphHash();
  }

  function expandAllNodes() {
    expandableNodes().forEach((node) => expanded.add(node.id));
  }

  function collapseAllNodes() {
    const center = fullGraph.center || boot.file || fullGraph.nodes[0]?.id || "";
    expanded = new Set(center ? [center] : []);
  }

  saveBtn.addEventListener("click", async () => {
    if (!editingDocument || saveBtn.disabled) return;
    const editor = document.getElementById("docEditor");
    if (!editor) return;
    saveBtn.textContent = "保存中";
    const response = await fetch("/api/document/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: editingDocument.file, content: editor.value }),
    });
    const result = await response.json();
    saveBtn.textContent = "保存";
    if (result.error) {
      alert(result.error);
      return;
    }
    editingDocument = result.document;
    renderDocumentBody();
    await loadGraph();
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setDisplayMode(button.dataset.mode);
      updateGraphHash();
    });
  });

  toggleSelectedBtn.addEventListener("click", () => {
    if (!selectedNode || !selectedNodeIsVisible() || !hasChildren(selectedNode)) return;
    toggleNode(selectedNode);
  });
  toggleAllBtn.addEventListener("click", () => {
    if (allExpandableNodesOpen()) collapseAllNodes();
    else expandAllNodes();
    computeVisibleGraph();
    render();
    updateGraphHash();
  });
  searchInput.addEventListener("input", render);
  fitBtn.addEventListener("click", () => {
    transform = { x: 0, y: 0, scale: 1 };
    render();
    updateGraphHash(0);
  });
  focusBtn.addEventListener("click", () => {
    if (!selectedNode) return;
    centerOnNode(selectedNode);
    render();
    updateGraphHash(0);
  });
  fullBtn.addEventListener("click", () => {
    app.classList.toggle("graph-full");
    render();
    updateGraphHash();
  });
  openDocBtn.addEventListener("pointerdown", () => {
    if (!selectedNode) return;
    openDocBtn.href = selectedNode.href || (selectedNode.exists && selectedNode.kind !== "external" ? viewUrl(selectedNode.path) : selectedNode.path);
  });

  svg.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    clearSelection();
    panning = { x: event.clientX, y: event.clientY, startX: transform.x, startY: transform.y };
    if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (event) => {
    event.preventDefault();
    clearSelection();
    if (draggingNode) {
      if (pointerState) {
        const dx = event.clientX - pointerState.startX;
        const dy = event.clientY - pointerState.startY;
        pointerState.moved = pointerState.moved || Math.sqrt(dx * dx + dy * dy) > 4;
      }
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = svg.getScreenCTM().inverse();
      const mapped = point.matrixTransform(ctm);
      draggingNode.x = mapped.x;
      draggingNode.y = mapped.y;
      render();
      return;
    }
    if (!panning) return;
    transform.x = panning.startX - (event.clientX - panning.x) / transform.scale;
    transform.y = panning.startY - (event.clientY - panning.y) / transform.scale;
    render();
  });
  svg.addEventListener("pointerup", (event) => {
    event.preventDefault();
    clearSelection();
    const completedPointer = pointerState;
    if (draggingNode) draggingNode.fixed = false;
    draggingNode = null;
    pointerState = null;
    panning = null;
    svg.classList.remove("dragging");
    if (completedPointer && completedPointer.pointerId === event.pointerId && !completedPointer.moved) {
      activateNode(completedPointer.node);
      return;
    }
    updateGraphHash();
  });
  svg.addEventListener("copy", (event) => {
    event.preventDefault();
    clearSelection();
  });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    transform.scale = Math.max(0.35, Math.min(3, transform.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
    render();
    updateGraphHash();
  }, { passive: false });

  (() => {
    const resizer = document.querySelector(".split-resizer");
    let startX = 0;
    let startWidth = 0;
    resizer.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startWidth = parseInt(getComputedStyle(app).getPropertyValue("--graph-width"), 10) || Math.round(window.innerWidth * 0.58);
      document.body.classList.add("graph-resizing");
      resizer.setPointerCapture(event.pointerId);
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!document.body.classList.contains("graph-resizing")) return;
      const next = Math.max(320, Math.min(window.innerWidth - 320, startWidth + event.clientX - startX));
      app.style.setProperty("--graph-width", next + "px");
      render();
    });
    resizer.addEventListener("pointerup", () => document.body.classList.remove("graph-resizing"));
  })();

  window.addEventListener("hashchange", () => {
    if (!fullGraph.nodes.length) return;
    applyHashState();
    if (selectedNode) loadDocument(selectedNode);
  });

  loadGraph().catch((error) => {
    docBody.innerHTML = `<p class="nav-empty">${error.message}</p>`;
  });
})();
