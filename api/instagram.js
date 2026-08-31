import { fetchAllPosts, SEED_POSTS } from "../lib/instagram.js";
import { blobRead, blobWrite, storeConfigured } from "../lib/store.js";

let cache = { at: 0, posts: null };
const TTL_MS = 5 * 60 * 1000;
const FEED_FILE = "instagram.json";

async function savedPosts() {
  const raw = await blobRead(FEED_FILE);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.posts) && data.posts.length ? data.posts : null;
  } catch {
    return null;
  }
}

async function remember(posts) {
  if (!posts?.length || !storeConfigured()) return;
  await blobWrite(FEED_FILE, JSON.stringify({ at: Date.now(), posts }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const now = Date.now();
  if (cache.posts && now - cache.at < TTL_MS) {
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ posts: cache.posts, cached: true });
    return;
  }

  try {
    const posts = await fetchAllPosts();
    if (!posts.length) throw new Error("Instagram returned no posts.");
    cache = { at: now, posts };
    remember(posts).catch(() => {});
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ posts, cached: false });
  } catch (err) {
    console.error("Instagram feed failed:", err);
    const fallback = cache.posts || (await savedPosts()) || SEED_POSTS;
    cache = { at: now, posts: fallback };
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ posts: fallback, cached: true });
  }
}
