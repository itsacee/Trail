// Pulls @apacademybsb posts for the on-site news feed.
// Instagram does not offer a simple official "all posts" widget, so this
// reads the public profile the same way Instagram's own website does.

export const HANDLE = "apacademybsb";
const APP_ID = "936619743392459";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function igHeaders() {
  return {
    "User-Agent": UA,
    "X-IG-App-ID": APP_ID,
    Accept: "application/json, text/html",
    Referer: `https://www.instagram.com/${HANDLE}/`,
  };
}

export function permalink(code, isVideo) {
  return `https://www.instagram.com/${isVideo ? "reel" : "p"}/${code}/`;
}

export function normalizeItem(it) {
  const firstSlide = Array.isArray(it.carousel_media) ? it.carousel_media[0] : null;
  const video =
    it.video_versions?.[0]?.url ||
    it.video_url ||
    firstSlide?.video_versions?.[0]?.url ||
    "";
  const isVideo = Boolean(video) || it.media_type === 2 || it.product_type === "clips";
  const image =
    it.image_versions2?.candidates?.[0]?.url ||
    it.display_url ||
    it.thumbnail_src ||
    firstSlide?.image_versions2?.candidates?.[0]?.url ||
    "";
  const caption = it.caption?.text || it.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  const code = it.code || it.shortcode || "";
  const takenAt = Number(it.taken_at || it.taken_at_timestamp || 0);
  return {
    id: String(it.pk || it.id || code),
    code,
    url: code ? permalink(code, isVideo) : `https://www.instagram.com/${HANDLE}/`,
    caption: String(caption),
    image,
    video: isVideo ? video : "",
    takenAt,
  };
}

export function normalizeEdgeNode(node) {
  return normalizeItem({
    shortcode: node.shortcode,
    video_url: node.video_url,
    display_url: node.display_url,
    thumbnail_src: node.thumbnail_src,
    is_video: node.is_video,
    media_type: node.is_video ? 2 : 1,
    edge_media_to_caption: node.edge_media_to_caption,
    taken_at_timestamp: node.taken_at_timestamp,
    id: node.id,
  });
}

function looksLikePost(obj) {
  if (!obj || typeof obj !== "object") return false;
  const code = obj.code || obj.shortcode;
  return Boolean(
    code &&
      (obj.image_versions2 ||
        obj.display_url ||
        obj.thumbnail_src ||
        obj.video_versions ||
        obj.video_url)
  );
}

export function collectPosts(node, into = [], seen = new Set()) {
  if (!node || typeof node !== "object") return into;
  if (looksLikePost(node)) {
    const post = normalizeItem(node);
    if (post.code && post.image && !seen.has(post.code)) {
      seen.add(post.code);
      into.push(post);
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPosts(item, into, seen);
  } else {
    for (const value of Object.values(node)) collectPosts(value, into, seen);
  }
  return into;
}

export function postsFromProfileHtml(html) {
  const posts = [];
  const seen = new Set();
  const scripts = String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const body = match[1].trim();
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    if (!body.includes("shortcode") && !body.includes('"code"')) continue;
    try {
      collectPosts(JSON.parse(body), posts, seen);
    } catch {
      /* ignore non-JSON script blobs */
    }
  }
  return posts.sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
}

async function igGet(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(url, { headers: igHeaders() });
    if (r.ok) return r.json();
    lastErr = new Error(`Instagram returned ${r.status}`);
    if (r.status !== 429 && r.status < 500) break;
    await sleep(500 * (attempt + 1));
  }
  throw lastErr;
}

async function igText(url) {
  const r = await fetch(url, { headers: igHeaders() });
  if (!r.ok) throw new Error(`Instagram returned ${r.status}`);
  return r.text();
}

function postsFromProfile(profile) {
  const edges = profile?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  const posts = [];
  const seen = new Set();
  for (const { node } of edges) {
    const post = normalizeEdgeNode(node);
    if (post.code && !seen.has(post.code)) {
      seen.add(post.code);
      posts.push(post);
    }
  }
  return posts;
}

export async function fetchAllPosts({ getJson = igGet, getText = igText } = {}) {
  let profile = null;
  const profileUrls = [
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${HANDLE}`,
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${HANDLE}`,
  ];
  for (const url of profileUrls) {
    try {
      profile = await getJson(url);
      if (profile?.data?.user?.id) break;
      profile = null;
    } catch {
      profile = null;
    }
  }

  const posts = [];
  const seen = new Set();
  const id = profile?.data?.user?.id;
  if (id) {
    let maxId = "";
    for (let page = 0; page < 8; page += 1) {
      const url =
        `https://www.instagram.com/api/v1/feed/user/${id}/?count=12` +
        (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
      try {
        const feed = await getJson(url);
        for (const it of feed.items || []) {
          const post = normalizeItem(it);
          if (!post.code || seen.has(post.code)) continue;
          seen.add(post.code);
          posts.push(post);
        }
        if (!feed.more_available || !feed.next_max_id) break;
        maxId = feed.next_max_id;
      } catch {
        break;
      }
    }
  }

  if (!posts.length && profile) {
    for (const post of postsFromProfile(profile)) {
      if (!seen.has(post.code)) {
        seen.add(post.code);
        posts.push(post);
      }
    }
  }

  if (!posts.length) {
    try {
      const html = await getText(`https://www.instagram.com/${HANDLE}/`);
      const fromHtml = postsFromProfileHtml(html);
      if (fromHtml.length) return fromHtml;
    } catch {
      /* fall through */
    }
  }

  if (!posts.length) throw new Error("Could not load Instagram posts.");
  return posts;
}

// Known public posts from @apacademybsb. Used only when Instagram
// blocks the live feed so the page still shows real clips.
export const SEED_POSTS = [
  "DcMGqr2ua5P",
  "DcH1f6csW4H",
  "DcG5_ftOYAL",
  "DcDFd75u5Rp",
  "DbgWOhvuin5",
  "DbqzZQuKHbs",
  "Db6zzhqOxja",
].map((code) => ({
  id: code,
  code,
  url: permalink(code, true),
  caption: "",
  image: "",
  video: "",
  takenAt: 0,
}));

export function prettyAgo(takenAt, nowMs = Date.now()) {
  if (!takenAt) return "";
  const sec = Math.max(0, Math.floor(nowMs / 1000) - takenAt);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  const date = new Date(takenAt * 1000);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
