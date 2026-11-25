/**
 * Netlify Function: publish-site
 * Перевіряє стан деплоїв та кількість неопублікованих комітів (GET)
 * і запускає один спільний production-білд через Build Hook (POST).
 */

const ACTIVE_STATES = new Set([
  "new",
  "enqueued",
  "building",
  "uploading",
  "processing",
  "preparing",
  "retrying"
]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function parseBody(rawBody) {
  if (!rawBody) return {};
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function stripSkipTags(message) {
  return String(message || "")
    .split("\n")[0]
    .replace(/\s*\[(?:skip netlify|netlify skip|skip ci|ci skip)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRepoFromCommitUrl(commitUrl) {
  const match = String(commitUrl || "").match(/github\.com\/([^/]+\/[^/]+)\/commit\//i);
  return match ? match[1] : null;
}

function mapCommits(commits) {
  if (!Array.isArray(commits)) return [];
  return commits
    .slice(-10)
    .reverse()
    .map((c) => ({
      sha: String(c.sha || "").slice(0, 7),
      message: stripSkipTags(c.commit?.message || ""),
      author: c.commit?.author?.name || "",
      date: c.commit?.author?.date || ""
    }));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchPendingCommits({ branch, baseSha, siteUrl, authHeader, commitUrl }) {
  const comparePath = `compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(branch)}`;

  if (siteUrl && authHeader) {
    try {
      const data = await fetchJson(`${siteUrl}/.netlify/git/github/${comparePath}`, {
        headers: { Authorization: authHeader }
      });
      return {
        pendingCount: typeof data.ahead_by === "number" ? data.ahead_by : 0,
        pendingCommits: mapCommits(data.commits),
        compareWarning: false
      };
    } catch {
      // Fallback до публічного GitHub API нижче
    }
  }

  const repo = process.env.GITHUB_REPO || extractRepoFromCommitUrl(commitUrl);
  if (repo) {
    try {
      const headers = { "User-Agent": "school8-admin-publish" };
      if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const data = await fetchJson(`https://api.github.com/repos/${repo}/${comparePath}`, {
        headers
      });
      return {
        pendingCount: typeof data.ahead_by === "number" ? data.ahead_by : 0,
        pendingCommits: mapCommits(data.commits),
        compareWarning: false
      };
    } catch {
      // Повертаємо м'яке попередження, щоб не блокувати публікацію
    }
  }

  return {
    pendingCount: null,
    pendingCommits: [],
    compareWarning: true
  };
}

async function getDeployStatus({ accessToken, siteId, buildHookUrl, branch, siteUrl, authHeader }) {
  if (!accessToken || !siteId) {
    return {
      mode: "basic",
      configured: Boolean(buildHookUrl),
      isBuilding: false,
      activeState: null,
      latestState: null,
      latestError: null,
      lastDeployAt: null,
      publishedSha: null,
      pendingCount: null,
      pendingCommits: [],
      compareWarning: false,
      siteUrl: siteUrl || null
    };
  }

  const deploysUrl =
    `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys` +
    `?branch=${encodeURIComponent(branch)}&per_page=15`;

  const deploys = await fetchJson(deploysUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const prodDeploys = Array.isArray(deploys)
    ? deploys.filter((d) => !d.context || d.context === "production")
    : [];

  const activeDeploy = prodDeploys.find((d) => !d.skipped && ACTIVE_STATES.has(d.state));
  const publishedDeploy = prodDeploys.find((d) => !d.skipped && d.state === "ready");
  const latestNonSkipped = prodDeploys.find((d) => !d.skipped);

  let pendingCount = null;
  let pendingCommits = [];
  let compareWarning = false;

  if (publishedDeploy?.commit_ref) {
    const compared = await fetchPendingCommits({
      branch,
      baseSha: publishedDeploy.commit_ref,
      siteUrl,
      authHeader,
      commitUrl: publishedDeploy.commit_url
    });
    pendingCount = compared.pendingCount;
    pendingCommits = compared.pendingCommits;
    compareWarning = compared.compareWarning;
  }

  return {
    mode: "full",
    configured: Boolean(buildHookUrl),
    isBuilding: Boolean(activeDeploy),
    activeState: activeDeploy?.state || null,
    latestState: latestNonSkipped?.state || null,
    latestError:
      latestNonSkipped?.state === "error"
        ? latestNonSkipped.error_message || "Помилка збірки сайту."
        : null,
    lastDeployAt: publishedDeploy?.published_at || publishedDeploy?.created_at || null,
    publishedSha: publishedDeploy?.commit_ref ? publishedDeploy.commit_ref.slice(0, 7) : null,
    pendingCount,
    pendingCommits,
    compareWarning,
    siteUrl: siteUrl || null
  };
}

async function triggerBuildHook(buildHookUrl, userEmail) {
  const triggerTitle = `Admin publish by ${userEmail || "editor"}`;
  const hookUrl = new URL(buildHookUrl);
  hookUrl.searchParams.set("trigger_title", triggerTitle);

  const res = await fetch(hookUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger_title: triggerTitle })
  });

  if (!res.ok) {
    throw new Error(`Build hook returned ${res.status}`);
  }
}

exports.handler = async (event, context) => {
  const user = context?.clientContext?.user;
  if (!user) {
    return json(401, { error: "Потрібна авторизація в адмін-панелі." });
  }

  const method = (event.httpMethod || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return json(405, { error: "Метод не підтримується." });
  }

  const buildHookUrl = process.env.NETLIFY_BUILD_HOOK_URL || "";
  const accessToken = process.env.NETLIFY_ACCESS_TOKEN || "";
  const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || "";
  const branch = process.env.GITHUB_BRANCH || "main";
  const siteUrl = (process.env.URL || event.headers?.origin || "").replace(/\/$/, "");
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";

  let status;
  try {
    status = await getDeployStatus({
      accessToken,
      siteId,
      buildHookUrl,
      branch,
      siteUrl,
      authHeader
    });
  } catch (err) {
    return json(502, {
      error: "Не вдалося отримати статус деплоїв із Netlify.",
      details: err.message
    });
  }

  if (method === "GET") {
    return json(200, status);
  }

  if (!buildHookUrl) {
    return json(503, {
      error: "Не налаштовано NETLIFY_BUILD_HOOK_URL у змінних оточення Netlify.",
      status
    });
  }

  const body = parseBody(event.body);
  if (status.isBuilding) {
    return json(409, {
      error: "Сайт уже оновлюється. Зачекайте завершення поточної збірки.",
      status
    });
  }

  if (status.mode === "full" && status.pendingCount === 0 && !body.force) {
    return json(200, {
      triggered: false,
      skipped: true,
      message: "Нових змін для публікації немає.",
      status
    });
  }

  try {
    await triggerBuildHook(buildHookUrl, user.email);
  } catch (err) {
    return json(502, {
      error: "Не вдалося запустити оновлення на Netlify.",
      details: err.message
    });
  }

  return json(202, {
    triggered: true,
    message: "Оновлення сайту запущено!",
    triggeredBy: user.email || "editor"
  });
};
