/**
 * Віджет публікації сайту для Decap CMS (/admin/).
 * Показує кількість накопичених змін та дозволяє оновити сайт одним кліком.
 */
(function () {
  "use strict";

  const ENDPOINT = "/.netlify/functions/publish-site";
  const IDLE_POLL_MS = 25000;
  const BUILDING_POLL_MS = 6000;
  const BASIC_COOLDOWN_MS = 120000;

  const state = {
    user: null,
    status: null,
    loading: false,
    submitting: false,
    justFinished: false,
    errorMsg: "",
    popoverOpen: false,
    wasBuilding: false,
    basicCooldownUntil: 0,
    pollTimer: null,
    cmsRefreshTimer: null
  };

  let els = null;

  function pluralizeChanges(n) {
    const abs = Math.abs(n);
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return "зміна";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "зміни";
    return "змін";
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("uk-UA", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function injectStyles() {
    if (document.getElementById("ukg-publish-styles")) return;
    const style = document.createElement("style");
    style.id = "ukg-publish-styles";
    style.textContent = `
      #ukg-publish-widget {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1f2937;
        max-width: calc(100vw - 32px);
      }
      .ukg-card {
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 14px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
        padding: 10px 12px;
        min-width: 245px;
      }
      .ukg-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ukg-btn-main {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
        background: #1b5e20;
        color: #ffffff;
        white-space: nowrap;
      }
      .ukg-btn-main:hover:not(:disabled) {
        background: #2e7d32;
      }
      .ukg-btn-main:active:not(:disabled) {
        transform: translateY(1px);
      }
      .ukg-btn-main:disabled {
        cursor: default;
        opacity: 0.92;
      }
      .ukg-btn-main.is-clean {
        background: #ecfdf5;
        color: #065f46;
        border: 1px solid #a7f3d0;
      }
      .ukg-btn-main.is-building {
        background: #fff7ed;
        color: #9a3412;
        border: 1px solid #fed7aa;
      }
      .ukg-btn-main.is-pending {
        background: #d97706;
        color: #ffffff;
      }
      .ukg-btn-main.is-pending:hover:not(:disabled) {
        background: #b45309;
      }
      .ukg-btn-main:focus-visible,
      .ukg-btn-icon:focus-visible,
      .ukg-link-btn:focus-visible {
        outline: 3px solid #2563eb;
        outline-offset: 2px;
      }
      .ukg-btn-icon {
        border: 1px solid #d1d5db;
        background: #f9fafb;
        color: #374151;
        border-radius: 10px;
        width: 36px;
        height: 38px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 13px;
        flex-shrink: 0;
      }
      .ukg-btn-icon:hover {
        background: #f3f4f6;
      }
      .ukg-meta {
        margin-top: 7px;
        font-size: 12px;
        line-height: 1.35;
        color: #4b5563;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .ukg-meta.is-error {
        color: #b91c1c;
        font-weight: 600;
      }
      .ukg-meta.is-success {
        color: #065f46;
        font-weight: 600;
      }
      .ukg-link-btn {
        background: none;
        border: 0;
        padding: 0;
        color: #1b5e20;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-decoration: underline;
        white-space: nowrap;
      }
      .ukg-popover {
        margin-bottom: 10px;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 12px;
        box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
        padding: 10px 12px;
        width: 320px;
        max-width: calc(100vw - 32px);
      }
      .ukg-popover-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: #4b5563;
        margin: 0 0 8px 0;
      }
      .ukg-commit-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 200px;
        overflow-y: auto;
      }
      .ukg-commit-item {
        padding: 6px 0;
        border-top: 1px solid #f3f4f6;
        font-size: 12px;
        line-height: 1.35;
      }
      .ukg-commit-item:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .ukg-commit-msg {
        color: #111827;
        font-weight: 500;
        word-break: break-word;
      }
      .ukg-commit-sub {
        color: #6b7280;
        font-size: 11px;
        margin-top: 2px;
      }
      .ukg-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        display: inline-block;
        animation: ukgSpin 0.8s linear infinite;
      }
      @keyframes ukgSpin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .ukg-spinner { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function createWidgetDom() {
    if (els) return els;
    injectStyles();

    const root = document.createElement("aside");
    root.id = "ukg-publish-widget";
    root.setAttribute("aria-label", "Публікація змін на сайт");
    root.hidden = true;

    const popover = document.createElement("div");
    popover.className = "ukg-popover";
    popover.hidden = true;

    const popoverTitle = document.createElement("p");
    popoverTitle.className = "ukg-popover-title";
    popoverTitle.textContent = "Очікують публікації";

    const commitList = document.createElement("ul");
    commitList.className = "ukg-commit-list";

    popover.appendChild(popoverTitle);
    popover.appendChild(commitList);

    const card = document.createElement("div");
    card.className = "ukg-card";

    const row = document.createElement("div");
    row.className = "ukg-row";

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "ukg-btn-main";
    mainBtn.addEventListener("click", handlePublishClick);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ukg-btn-icon";
    toggleBtn.setAttribute("aria-label", "Показати список змін");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.textContent = "▾";
    toggleBtn.hidden = true;
    toggleBtn.addEventListener("click", () => {
      state.popoverOpen = !state.popoverOpen;
      render();
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "ukg-btn-icon";
    refreshBtn.setAttribute("aria-label", "Перевірити статус змін");
    refreshBtn.title = "Перевірити зараз";
    refreshBtn.textContent = "↻";
    refreshBtn.addEventListener("click", () => fetchStatus());

    row.appendChild(mainBtn);
    row.appendChild(toggleBtn);
    row.appendChild(refreshBtn);

    const meta = document.createElement("div");
    meta.className = "ukg-meta";
    meta.setAttribute("aria-live", "polite");

    const statusText = document.createElement("span");
    const siteLink = document.createElement("a");
    siteLink.className = "ukg-link-btn";
    siteLink.href = "/";
    siteLink.target = "_blank";
    siteLink.rel = "noopener";
    siteLink.textContent = "На сайт ↗";

    meta.appendChild(statusText);
    meta.appendChild(siteLink);

    card.appendChild(row);
    card.appendChild(meta);

    root.appendChild(popover);
    root.appendChild(card);
    document.body.appendChild(root);

    els = {
      root,
      popover,
      commitList,
      mainBtn,
      toggleBtn,
      refreshBtn,
      meta,
      statusText,
      siteLink
    };
    return els;
  }

  async function getToken(forceRefresh) {
    if (!state.user) return null;
    if (forceRefresh && window.netlifyIdentity?.refresh) {
      return window.netlifyIdentity.refresh();
    }
    return state.user.jwt();
  }

  async function apiRequest(method, body, retried) {
    const token = await getToken(Boolean(retried));
    if (!token) {
      throw new Error("Немає активної сесії авторизації.");
    }

    const res = await fetch(ENDPOINT, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    if (res.status === 401 && !retried) {
      return apiRequest(method, body, true);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Помилка (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function fetchStatus() {
    if (!state.user || state.loading) return;
    state.loading = true;
    render();

    try {
      const data = await apiRequest("GET");
      if (state.wasBuilding && !data.isBuilding && data.latestState === "ready") {
        state.justFinished = true;
        setTimeout(() => {
          state.justFinished = false;
          render();
        }, 12000);
      }
      state.wasBuilding = Boolean(data.isBuilding);
      state.status = data;
      state.errorMsg = "";
      if (!data.pendingCommits || data.pendingCommits.length === 0) {
        state.popoverOpen = false;
      }
    } catch (err) {
      state.errorMsg = err.message || "Не вдалося перевірити статус.";
    } finally {
      state.loading = false;
      schedulePoll();
      render();
    }
  }

  async function handlePublishClick() {
    if (!state.user || state.submitting) return;
    const s = state.status;
    if (s?.isBuilding) return;
    if (s?.mode === "full" && s.pendingCount === 0) return;

    const count = s?.pendingCount;
    const confirmText =
      typeof count === "number" && count > 0
        ? `Опублікувати ${count} ${pluralizeChanges(count)} на сайті?\n\nЗбірка триватиме приблизно 1 хвилину.`
        : "Опублікувати накопичені зміни на сайті?\n\nЗбірка триватиме приблизно 1 хвилину.";

    if (!window.confirm(confirmText)) return;

    state.submitting = true;
    state.errorMsg = "";
    state.justFinished = false;
    render();

    try {
      const res = await apiRequest("POST", {});
      if (res.skipped) {
        state.status = res.status || state.status;
      } else {
        state.wasBuilding = true;
        if (state.status) {
          state.status.isBuilding = true;
        }
        if (s?.mode === "basic") {
          state.basicCooldownUntil = Date.now() + BASIC_COOLDOWN_MS;
        }
      }
      schedulePoll();
      setTimeout(fetchStatus, 2500);
    } catch (err) {
      if (err.status === 409 && err.data?.status) {
        state.status = err.data.status;
        state.wasBuilding = true;
      } else {
        state.errorMsg = err.message || "Не вдалося запустити публікацію.";
      }
    } finally {
      state.submitting = false;
      render();
    }
  }

  function schedulePoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (!state.user) return;
    const delay = state.status?.isBuilding ? BUILDING_POLL_MS : IDLE_POLL_MS;
    state.pollTimer = setTimeout(() => {
      if (!document.hidden) {
        fetchStatus();
      } else {
        schedulePoll();
      }
    }, delay);
  }

  function renderCommits(commits) {
    els.commitList.textContent = "";
    commits.forEach((c) => {
      const li = document.createElement("li");
      li.className = "ukg-commit-item";

      const msg = document.createElement("div");
      msg.className = "ukg-commit-msg";
      msg.textContent = c.message || "(без опису)";

      const sub = document.createElement("div");
      sub.className = "ukg-commit-sub";
      const time = formatTime(c.date);
      sub.textContent = [c.sha, time].filter(Boolean).join(" • ");

      li.appendChild(msg);
      if (sub.textContent) li.appendChild(sub);
      els.commitList.appendChild(li);
    });
  }

  function render() {
    const dom = createWidgetDom();
    if (!state.user) {
      dom.root.hidden = true;
      return;
    }
    dom.root.hidden = false;

    const s = state.status;
    const inBasicCooldown = Date.now() < state.basicCooldownUntil;
    const isBuilding = Boolean(s?.isBuilding);
    const pending = typeof s?.pendingCount === "number" ? s.pendingCount : null;
    const commits = Array.isArray(s?.pendingCommits) ? s.pendingCommits : [];

    dom.mainBtn.className = "ukg-btn-main";
    dom.mainBtn.textContent = "";

    if (state.submitting) {
      const spin = document.createElement("span");
      spin.className = "ukg-spinner";
      dom.mainBtn.appendChild(spin);
      dom.mainBtn.appendChild(document.createTextNode(" Запускаю…"));
      dom.mainBtn.classList.add("is-building");
      dom.mainBtn.disabled = true;
    } else if (isBuilding) {
      const spin = document.createElement("span");
      spin.className = "ukg-spinner";
      dom.mainBtn.appendChild(spin);
      dom.mainBtn.appendChild(document.createTextNode(" Сайт оновлюється…"));
      dom.mainBtn.classList.add("is-building");
      dom.mainBtn.disabled = true;
    } else if (!s && state.loading) {
      dom.mainBtn.textContent = "Перевірка статусу…";
      dom.mainBtn.disabled = true;
    } else if (s && !s.configured) {
      dom.mainBtn.textContent = "Потрібне налаштування";
      dom.mainBtn.disabled = true;
    } else if (pending === 0) {
      dom.mainBtn.textContent = "✅ Сайт актуальний";
      dom.mainBtn.classList.add("is-clean");
      dom.mainBtn.disabled = true;
    } else if (pending > 0) {
      dom.mainBtn.textContent = `🚀 Оновити сайт (${pending} ${pluralizeChanges(pending)})`;
      dom.mainBtn.classList.add("is-pending");
      dom.mainBtn.disabled = false;
    } else if (inBasicCooldown) {
      dom.mainBtn.textContent = "⏳ Зачекайте 2 хв…";
      dom.mainBtn.classList.add("is-building");
      dom.mainBtn.disabled = true;
    } else {
      dom.mainBtn.textContent = "🚀 Оновити сайт";
      dom.mainBtn.classList.add("is-pending");
      dom.mainBtn.disabled = !s?.configured && Boolean(s);
    }

    dom.toggleBtn.hidden = commits.length === 0;
    dom.toggleBtn.setAttribute("aria-expanded", String(state.popoverOpen));
    dom.toggleBtn.textContent = state.popoverOpen ? "▴" : "▾";
    dom.popover.hidden = !(state.popoverOpen && commits.length > 0);
    if (commits.length > 0) {
      renderCommits(commits);
    }

    dom.meta.className = "ukg-meta";
    if (state.errorMsg) {
      dom.meta.classList.add("is-error");
      dom.statusText.textContent = state.errorMsg;
    } else if (s?.latestError) {
      dom.meta.classList.add("is-error");
      dom.statusText.textContent = "Помилка останньої збірки";
    } else if (state.justFinished) {
      dom.meta.classList.add("is-success");
      dom.statusText.textContent = "✅ Сайт оновлено!";
    } else if (isBuilding) {
      dom.statusText.textContent = "Збірка триває (~1 хв)…";
    } else if (s?.lastDeployAt) {
      dom.statusText.textContent = `Останній деплой: ${formatTime(s.lastDeployAt)}`;
    } else if (s?.compareWarning) {
      dom.statusText.textContent = "Кнопка готова (лічильник недоступний)";
    } else {
      dom.statusText.textContent = "Правки накопичуються без білду";
    }

    if (s?.siteUrl) {
      dom.siteLink.href = s.siteUrl;
    }
  }

  function observeCmsCommits() {
    if (typeof PerformanceObserver !== "function") return;
    try {
      const observer = new PerformanceObserver((list) => {
        const hasGitCall = list.getEntries().some((e) =>
          String(e.name || "").includes("/.netlify/git/github/")
        );
        if (!hasGitCall || !state.user) return;
        clearTimeout(state.cmsRefreshTimer);
        state.cmsRefreshTimer = setTimeout(fetchStatus, 2500);
      });
      observer.observe({ entryTypes: ["resource"] });
    } catch {
      // Ігноруємо, якщо браузер не підтримує resource PerformanceObserver
    }
  }

  function init() {
    createWidgetDom();
    observeCmsCommits();

    window.addEventListener("beforeunload", (e) => {
      if (state.status && typeof state.status.pendingCount === "number" && state.status.pendingCount > 0 && !state.status.isBuilding) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.user) {
        fetchStatus();
      }
    });

    if (!window.netlifyIdentity) return;

    window.netlifyIdentity.on("init", (user) => {
      state.user = user || null;
      render();
      if (state.user) fetchStatus();
    });

    window.netlifyIdentity.on("login", (user) => {
      state.user = user || null;
      render();
      if (state.user) fetchStatus();
    });

    window.netlifyIdentity.on("logout", () => {
      state.user = null;
      state.status = null;
      state.popoverOpen = false;
      if (state.pollTimer) clearTimeout(state.pollTimer);
      render();
    });

    const current = window.netlifyIdentity.currentUser?.();
    if (current) {
      state.user = current;
      render();
      fetchStatus();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
