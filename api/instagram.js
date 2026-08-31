import { fetchAllPosts } from "../lib/instagram.js";

let cache = { at: 0, posts: null, error: "" };
const TTL_MS = 5 * 60 * 1000;

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
    cache = { at: now, posts, error: "" };
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ posts, cached: false });
  } catch (err) {
    console.error("Instagram feed failed:", err);
    if (cache.posts) {
      res.status(200).json({ posts: cache.posts, cached: true });
      return;
    }
    res.status(502).json({
      error: "Couldn't load Instagram right now.",
      posts: [],
    });
  }
}
