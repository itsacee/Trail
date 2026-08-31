const root = document.getElementById("igNews");
if (root) {
  const HANDLE = "apacademybsb";
  const soundHint = `<span class="ig-card__sound-phone">Tap for sound</span><span class="ig-card__sound-desk">Click for sound</span>`;

  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const ago = (takenAt) => {
    if (!takenAt) return "";
    const sec = Math.max(0, Math.floor(Date.now() / 1000) - takenAt);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 14) return `${day}d ago`;
    return new Date(takenAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const card = (post) => {
    const top = `<a class="ig-card__top" href="${esc(post.url)}" target="_blank" rel="noopener">
        <img src="/img/logo-mark.png" alt="" />
        <span class="ig-card__who">AP Academy<small>@${HANDLE}</small></span>
        <span class="ig-card__open">Open ↗</span>
      </a>`;
    if (!post.image && !post.video && post.code) {
      const kind = (post.url || "").includes("/p/") ? "p" : "reel";
      return `<article class="ig-card">
      ${top}
      <iframe class="ig-card__embed" src="https://www.instagram.com/${kind}/${esc(post.code)}/embed/captioned/" loading="lazy" title="Instagram post from @${HANDLE}"></iframe>
    </article>`;
    }
    const media = post.video
      ? `<video muted playsinline loop preload="metadata" poster="${esc(post.image)}" src="${esc(post.video)}"></video>
         <span class="ig-card__sound">${soundHint}</span>`
      : `<img src="${esc(post.image)}" alt="" loading="lazy" />`;
    const cap = post.caption
      ? `<p class="ig-card__cap">${esc(post.caption)}</p>`
      : "";
    return `<article class="ig-card">
      ${top}
      <div class="ig-card__media">${media}</div>
      ${cap}
      <p class="ig-card__time">${esc(ago(post.takenAt))}</p>
    </article>`;
  };

  const watchVideos = () => {
    const vids = [...root.querySelectorAll("video")];
    if (!vids.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.play().catch(() => {});
          else {
            e.target.pause();
            e.target.muted = true;
            e.target.classList.remove("is-live");
            const badge = e.target.parentElement?.querySelector(".ig-card__sound");
            if (badge) badge.innerHTML = soundHint;
          }
        });
      },
      { threshold: 0.55 }
    );
    vids.forEach((v) => {
      io.observe(v);
      v.addEventListener("click", (ev) => {
        ev.preventDefault();
        const live = !v.classList.contains("is-live");
        vids.forEach((other) => {
          other.muted = true;
          other.classList.remove("is-live");
          const otherBadge = other.parentElement?.querySelector(".ig-card__sound");
          if (otherBadge) otherBadge.innerHTML = soundHint;
        });
        const badge = v.parentElement?.querySelector(".ig-card__sound");
        if (live) {
          v.muted = false;
          v.classList.add("is-live");
          v.play().catch(() => {});
          if (badge) badge.textContent = "Sound on";
        } else if (badge) {
          badge.innerHTML = soundHint;
        }
      });
    });
  };

  root.innerHTML = `<p class="ig-news__status">Loading posts…</p>`;
  fetch("/api/instagram")
    .then((r) => r.json())
    .then((data) => {
      const posts = (Array.isArray(data.posts) ? data.posts : []).slice(0, 3);
      if (!posts.length) {
        root.innerHTML = `<p class="ig-news__status">Couldn't load the feed. <a href="https://instagram.com/${HANDLE}">Open Instagram</a></p>`;
        return;
      }
      root.innerHTML = posts.map(card).join("");
      watchVideos();
    })
    .catch(() => {
      root.innerHTML = `<p class="ig-news__status">Couldn't load the feed. <a href="https://instagram.com/${HANDLE}">Open Instagram</a></p>`;
    });
}
