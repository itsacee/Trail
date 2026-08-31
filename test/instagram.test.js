import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItem, prettyAgo, permalink, fetchAllPosts, postsFromProfileHtml, latestPosts, SEED_POSTS } from "../lib/instagram.js";

test("normalizeItem maps a clip and a photo", () => {
  const clip = normalizeItem({
    pk: "1",
    code: "Abc123",
    product_type: "clips",
    caption: { text: "Tee work" },
    image_versions2: { candidates: [{ url: "https://img/a.jpg" }] },
    video_versions: [{ url: "https://vid/a.mp4" }],
    taken_at: 1700000000,
  });
  assert.equal(clip.url, "https://www.instagram.com/reel/Abc123/");
  assert.equal(clip.video, "https://vid/a.mp4");
  assert.equal(clip.caption, "Tee work");

  const photo = normalizeItem({
    pk: "2",
    code: "Def456",
    media_type: 1,
    caption: { text: "Tryouts" },
    image_versions2: { candidates: [{ url: "https://img/b.jpg" }] },
    taken_at: 1700000000,
  });
  assert.equal(photo.url, "https://www.instagram.com/p/Def456/");
  assert.equal(photo.video, "");

  const carousel = normalizeItem({
    pk: "3",
    code: "Car789",
    media_type: 8,
    caption: { text: "Day one" },
    carousel_media: [
      {
        image_versions2: { candidates: [{ url: "https://img/c.jpg" }] },
        video_versions: [{ url: "https://vid/c.mp4" }],
      },
    ],
    taken_at: 1700000000,
  });
  assert.equal(carousel.image, "https://img/c.jpg");
  assert.equal(carousel.video, "https://vid/c.mp4");
});

test("prettyAgo uses minutes, hours, and days", () => {
  const now = 1_700_000_000_000;
  assert.equal(prettyAgo(1_700_000_000 - 30, now), "just now");
  assert.equal(prettyAgo(1_700_000_000 - 120, now), "2m ago");
  assert.equal(prettyAgo(1_700_000_000 - 7200, now), "2h ago");
  assert.equal(prettyAgo(1_700_000_000 - 86400 * 3, now), "3d ago");
});

test("permalink picks reel vs post", () => {
  assert.equal(permalink("Xx", true), "https://www.instagram.com/reel/Xx/");
  assert.equal(permalink("Yy", false), "https://www.instagram.com/p/Yy/");
});

test("fetchAllPosts walks pages and de-dupes", async () => {
  const profile = { data: { user: { id: "405" } } };
  const page1 = {
    items: [
      { pk: "1", code: "AAA", caption: { text: "one" }, image_versions2: { candidates: [{ url: "a" }] }, taken_at: 1 },
      { pk: "2", code: "BBB", caption: { text: "two" }, image_versions2: { candidates: [{ url: "b" }] }, taken_at: 2 },
    ],
    more_available: true,
    next_max_id: "cursor2",
  };
  const page2 = {
    items: [
      { pk: "2", code: "BBB", caption: { text: "two" }, image_versions2: { candidates: [{ url: "b" }] }, taken_at: 2 },
      { pk: "3", code: "CCC", caption: { text: "three" }, image_versions2: { candidates: [{ url: "c" }] }, taken_at: 3 },
    ],
    more_available: false,
  };
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    if (url.includes("web_profile_info")) return profile;
    if (url.includes("max_id=cursor2")) return page2;
    return page1;
  };
  const posts = await fetchAllPosts({ getJson });
  assert.deepEqual(posts.map((p) => p.code), ["AAA", "BBB", "CCC"]);
  assert.equal(calls.filter((u) => u.includes("feed/user")).length, 2);
});

test("postsFromProfileHtml pulls posts out of JSON script tags", () => {
  const html = `<html><script type="application/json">${JSON.stringify({
    require: [
      {
        shortcode: "HtmlPost",
        display_url: "https://img/h.jpg",
        is_video: false,
        taken_at_timestamp: 1700000000,
        edge_media_to_caption: { edges: [{ node: { text: "From page" } }] },
      },
    ],
  })}</script></html>`;
  const posts = postsFromProfileHtml(html);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].code, "HtmlPost");
  assert.equal(posts[0].image, "https://img/h.jpg");
  assert.equal(posts[0].caption, "From page");
});

test("fetchAllPosts uses profile media when the feed endpoint fails", async () => {
  const profile = {
    data: {
      user: {
        id: "405",
        edge_owner_to_timeline_media: {
          edges: [
            {
              node: {
                shortcode: "FALL1",
                display_url: "https://img/f.jpg",
                is_video: false,
                taken_at_timestamp: 9,
              },
            },
          ],
        },
      },
    },
  };
  const getJson = async (url) => {
    if (url.includes("web_profile_info")) return profile;
    throw new Error("Instagram returned 429");
  };
  const posts = await fetchAllPosts({ getJson, getText: async () => { throw new Error("no html"); } });
  assert.equal(posts[0].code, "FALL1");
});

test("latestPosts keeps only the newest few", () => {
  const posts = [
    { code: "old", takenAt: 10 },
    { code: "new", takenAt: 30 },
    { code: "mid", takenAt: 20 },
    { code: "older", takenAt: 5 },
  ];
  assert.deepEqual(latestPosts(posts, 3).map((p) => p.code), ["new", "mid", "old"]);
});

test("seed posts cover known academy clips", () => {
  assert.ok(SEED_POSTS.length >= 4);
  assert.ok(SEED_POSTS.every((p) => p.code && p.url.includes(p.code)));
});
