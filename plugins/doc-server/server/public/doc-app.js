(() => {
  const boot = window.DOC_VIEW_BOOT || {};
  if (!boot || boot.mode !== "view") return;

  const cache = new Map();
  const inflight = new Map();
  const queue = [];
  const queued = new Set();
  let pumping = false;
  let navigationId = 0;
  let foregroundLoads = 0;
  let prefetchDir = parentDir(boot.file || "");

  const article = document.querySelector(".doc-content");
  const headingCard = document.querySelector(".heading-card");
  const topActions = document.querySelector(".top-actions");
  const depthInput = document.getElementById("prefetchDepth");
  const countInput = document.getElementById("prefetchCount");
  const settingsKey = "doc-server:prefetch:v1";
  const rows = new Map();
  const directories = new Map();
  const fileStates = new Map();
  let settings = { depth: 1, count: 5 };

  function validInteger(value, fallback, minimum) {
    const number = Number(value);
    return value !== "" && value != null && Number.isSafeInteger(number) && number >= minimum ? number : fallback;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey)) || {};
    settings = { depth: validInteger(saved.depth, 1, 1), count: validInteger(saved.count, 5, 0) };
  } catch (_) { /* Storage may be disabled; defaults still work. */ }
  if (depthInput) depthInput.value = settings.depth;
  if (countInput) countInput.value = settings.count;

  function directory(dir) {
    if (!directories.has(dir)) {
      const entry = { files: [], children: [], element: null, bar: null, ready: 0, loading: 0 };
      directories.set(dir, entry);
      if (dir) directory(parentDir(dir)).children.push(dir);
    }
    return directories.get(dir);
  }

  // Index the static tree once. Progress updates only touch the affected directory.
  directory("");
  document.querySelectorAll(".tree-dir[data-dir]").forEach((element) => {
    const entry = directory(element.getAttribute("data-dir") || "");
    entry.element = element;
    entry.bar = element.querySelector(":scope > .tree-dir-cache-bar");
  });
  document.querySelectorAll(".tree-file-row[data-file]").forEach((row) => {
    const file = row.getAttribute("data-file");
    rows.set(file, { element: row, bar: row.querySelector(".tree-cache-bar > i") });
    directory(parentDir(file)).files.push(file);
  });

  function parentDir(file = "") {
    const idx = file.lastIndexOf("/");
    return idx === -1 ? "" : file.slice(0, idx);
  }

  function viewUrl(file = "") {
    const url = new URL(location.href);
    url.pathname = "/view";
    if (file) url.searchParams.set("file", file);
    else url.searchParams.delete("file");
    if (boot.ignoreDocDirs === false) url.searchParams.set(boot.ignoreParam || "ignoreDocDirs", "0");
    else url.searchParams.delete(boot.ignoreParam || "ignoreDocDirs");
    return url.pathname + url.search + url.hash;
  }

  function apiUrl(file = "") {
    const url = new URL("/api/document", location.origin);
    url.searchParams.set("file", file);
    if (boot.ignoreDocDirs === false) url.searchParams.set(boot.ignoreParam || "ignoreDocDirs", "0");
    if (boot.graphFile) url.searchParams.set("graphFile", boot.graphFile);
    if (boot.graphState) url.searchParams.set("graphState", boot.graphState);
    return url.toString();
  }

  function prefetchCandidates(dir = "") {
    const files = [];
    let level = [dir];
    for (let depth = 0; depth < settings.depth && level.length && files.length < settings.count; depth++) {
      const next = [];
      for (const path of level) {
        const entry = directories.get(path);
        if (!entry) continue;
        for (const file of entry.files) {
          files.push(file);
          if (files.length >= settings.count) return files;
        }
        for (const child of entry.children) next.push(child);
      }
      level = next;
    }
    return files;
  }

  function setFileState(file, state) {
    const previous = fileStates.get(file);
    if (previous === state) return;
    fileStates.set(file, state);
    const entry = directories.get(parentDir(file));
    if (entry && rows.has(file)) {
      entry.ready += Number(state === "ready") - Number(previous === "ready");
      entry.loading += Number(state === "pending" || state === "loading") - Number(previous === "pending" || previous === "loading");
      updateDirProgress(parentDir(file));
    }
    const indexed = rows.get(file);
    if (!indexed) return;
    const { element: row, bar } = indexed;
    row.classList.remove("cache-pending", "cache-loading", "cache-ready", "cache-error");
    if (state) row.classList.add(`cache-${state}`);
    if (!bar) return;
    if (state === "ready") bar.style.width = "100%";
    else if (state === "loading") bar.style.width = "42%";
    else if (state === "pending") bar.style.width = "12%";
    else if (state === "error") bar.style.width = "100%";
    else bar.style.width = "0%";
  }

  function cssEscape(value = "") {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function updateDirProgress(dirPath = "") {
    const entry = directories.get(dirPath);
    if (!entry || !entry.element || !entry.files.length) return;
    const { ready, loading, bar, element } = entry;
    const total = entry.files.length;
    if (bar) {
      const fill = bar.querySelector("i");
      if (fill) fill.style.width = `${(ready / total) * 100}%`;
      bar.title = `直属文档已缓存 ${ready}/${total}，加载中 ${loading}`;
    }
    element.classList.toggle("cache-ready", ready === total);
    element.classList.toggle("cache-loading", loading > 0);
  }

  function renderHeadingNav(headings = []) {
    if (!headingCard) return;
    const title = headingCard.querySelector(".brand");
    let nav = headingCard.querySelector(".heading-nav, .nav-empty");
    if (!nav) {
      nav = document.createElement("div");
      headingCard.appendChild(nav);
    }
    if (!headings.length) {
      nav.outerHTML = `<p class="nav-empty">当前文档没有标题。</p>`;
      return;
    }
    const minLevel = Math.min(...headings.map((heading) => heading.level));
    nav.outerHTML = `<ul class="heading-nav">${headings
      .map((heading) => {
        const depth = Math.max(0, heading.level - minLevel);
        return `<li style="--depth:${depth}"><a href="#${escapeAttr(heading.id)}">${escapeHtml(heading.text)}</a></li>`;
      })
      .join("")}</ul>`;
  }

  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value = "") {
    return escapeHtml(value);
  }

  function updateTopActions(file = "") {
    if (!topActions) return;
    const raw = topActions.querySelector('a.button-link[href^="/raw/"]');
    if (raw) {
      raw.href = `/raw/${file.split("/").map(encodeURIComponent).join("/")}`;
      raw.style.display = file ? "" : "none";
    }
  }

  function setActiveFile(file = "") {
    document.querySelectorAll(".tree-file.active").forEach((el) => el.classList.remove("active"));
    const link = document.querySelector(`.tree-file[data-file="${cssEscape(file)}"]`);
    if (link) link.classList.add("active");

    // Keep ancestor dirs open
    let dir = parentDir(file);
    while (dir) {
      const dirEl = document.querySelector(`.tree-dir[data-dir="${cssEscape(dir)}"]`);
      if (dirEl) {
        dirEl.classList.add("open");
        const toggle = dirEl.querySelector(":scope > .tree-toggle");
        if (toggle) toggle.setAttribute("aria-expanded", "true");
      }
      dir = parentDir(dir);
    }
  }

  function showDocument(doc) {
    if (!article || !doc) return;
    article.innerHTML = doc.html || `<div class="empty"><h1>Docs</h1><p>从左侧选择一个文档。</p></div>`;
    document.title = doc.title || doc.file || "Docs";
    renderHeadingNav(doc.headings || []);
    updateTopActions(doc.file || "");
    setActiveFile(doc.file || "");
    if (typeof window.renderMermaid === "function") {
      window.renderMermaid(article);
    }
  }

  async function fetchDocument(file) {
    if (!file) return null;
    if (cache.has(file)) return cache.get(file);
    if (inflight.has(file)) return inflight.get(file);

    setFileState(file, "loading");

    const task = fetch(apiUrl(file))
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        cache.set(file, payload);
        setFileState(file, "ready");
        return payload;
      })
      .catch((error) => {
        setFileState(file, "error");
        throw error;
      })
      .finally(() => {
        inflight.delete(file);
        queued.delete(file);
      });

    inflight.set(file, task);
    return task;
  }

  function enqueueFiles(files = []) {
    let added = false;
    files.forEach((file) => {
      if (!file || cache.has(file) || inflight.has(file) || queued.has(file)) return;
      queued.add(file);
      queue.push(file);
      setFileState(file, "pending");
      added = true;
    });
    if (added) {
      pumpQueue();
    }
  }

  function yieldToPaint() {
    return new Promise((resolve) => {
      let frame;
      const finish = () => {
        clearTimeout(timer);
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        resolve();
      };
      // The timer also allows progress in background tabs where RAF is suspended.
      const timer = setTimeout(finish, 100);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(finish);
      });
    });
  }

  async function pumpQueue() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      // Paint pending/completed states and let foreground navigation run first.
      await yieldToPaint();
      if (foregroundLoads) continue;
      const file = queue.shift();
      if (!file) continue;
      queued.delete(file);
      try {
        await fetchDocument(file);
      } catch (error) {
        console.warn("[doc-server] prefetch failed:", file, error);
      }
    }
    pumping = false;
  }

  function prefetchFolder(dir = "") {
    prefetchDir = dir;
    // Replace pending work when the user switches folders/settings. Keep an
    // already-running request, which may also be awaited by a document click.
    queue.splice(0).forEach((file) => {
      queued.delete(file);
      if (!inflight.has(file) && !cache.has(file)) setFileState(file, "");
    });
    enqueueFiles(prefetchCandidates(dir));
  }

  function changeSettings() {
    settings = {
      depth: validInteger(depthInput && depthInput.value, 1, 1),
      count: validInteger(countInput && countInput.value, 5, 0),
    };
    if (depthInput) depthInput.value = settings.depth;
    if (countInput) countInput.value = settings.count;
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (_) { /* Optional persistence. */ }
    prefetchFolder(prefetchDir);
  }

  async function openDocument(file, { push = true } = {}) {
    if (!file) return;
    const requestId = ++navigationId;
    foregroundLoads++;
    try {
      const doc = await fetchDocument(file);
      if (requestId !== navigationId) return;
      showDocument(doc);
      if (push) history.pushState({ file }, doc.title || file, viewUrl(file));
    } catch (error) {
      if (article && requestId === navigationId) {
        article.innerHTML = `<div class="empty"><h1>加载失败</h1><p>${escapeHtml(error.message || String(error))}</p></div>`;
      }
    } finally {
      foregroundLoads--;
    }
  }

  function onTreeFileClick(event) {
    const link = event.target.closest && event.target.closest("a.tree-file[data-file]");
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    openDocument(link.getAttribute("data-file") || "");
  }

  function onTreeToggle(event) {
    const button = event.target.closest && event.target.closest(".tree-toggle");
    if (!button) return;
    const item = button.closest(".tree-dir");
    if (!item) return;
    // sharedScript already toggles open; run after it via microtask
    queueMicrotask(() => {
      const open = item.classList.contains("open");
      const dir = item.getAttribute("data-dir") || "";
      if (open && dir) prefetchFolder(dir);
    });
  }

  function seedCurrent() {
    if (!boot.file || !article) return;
    cache.set(boot.file, {
      file: boot.file,
      title: boot.title || boot.file,
      kind: boot.kind || "markdown",
      editable: !!boot.editable,
      content: "",
      html: article.innerHTML,
      headings: boot.headings || [],
    });
    setFileState(boot.file, "ready");
  }

  document.addEventListener("click", onTreeFileClick);
  document.addEventListener("click", onTreeToggle);
  if (depthInput) depthInput.addEventListener("change", changeSettings);
  if (countInput) countInput.addEventListener("change", changeSettings);
  window.addEventListener("popstate", (event) => {
    const file = (event.state && event.state.file) || new URL(location.href).searchParams.get("file") || "";
    if (!file) return;
    openDocument(file, { push: false });
  });

  // Replace history entry so back/forward has state
  if (boot.file) {
    history.replaceState({ file: boot.file }, boot.title || boot.file, viewUrl(boot.file));
  }

  seedCurrent();
  prefetchFolder(prefetchDir);
})();
