const TOKEN_KEY = "ap_member_token";
// Safety net only — the real cutoff is the membership's own expiry date,
// which the server sends back as `lastDay`.
const MAX_AHEAD = 60;

const loginCard = document.getElementById("loginCard");
const dashCard = document.getElementById("dashCard");
if (!loginCard || !dashCard) {
  /* not on the account page */
} else {

const loginForm = document.getElementById("loginForm");
const loginStatus = document.getElementById("loginStatus");
const loginSubmit = document.getElementById("loginSubmit");
const weekForm = document.getElementById("weekForm");
const weekStatus = document.getElementById("weekStatus");
const dateSelect = document.getElementById("memDate");
const timeSelect = document.getElementById("memTime");
const bookedCache = {};
let AVAIL = {
  days: {
    0: { open: true, start: "09:00", end: "19:00" },
    1: { open: true, start: "17:00", end: "21:00" },
    2: { open: true, start: "17:00", end: "21:00" },
    3: { open: true, start: "17:00", end: "21:00" },
    4: { open: true, start: "17:00", end: "21:00" },
    5: { open: true, start: "17:00", end: "21:00" },
    6: { open: true, start: "09:00", end: "19:00" },
  },
  blocked: [],
};
let account = null;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
  sessionStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function startsForDate(iso) {
  if (!AVAIL) return [];
  if ((AVAIL.blocked || []).includes(iso)) return [];
  const d = new Date(`${iso}T12:00:00`);
  const cfg = (AVAIL.days || {})[d.getDay()];
  if (!cfg || !cfg.open) return [];
  const start = toMinutes(cfg.start);
  const end = toMinutes(cfg.end);
  const out = [];
  for (let t = start; t + 60 <= end; t += 30) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearToken();
    showLogin();
  }
  return { res, data };
}

function showLogin(msg) {
  dashCard.hidden = true;
  loginCard.hidden = false;
  if (msg) loginStatus.textContent = msg;
}

function showDash() {
  loginCard.hidden = true;
  dashCard.hidden = false;
}

function renderDash(data) {
  account = data;
  const left = data.remaining || 0;
  const expires = data.lastDayPretty || (data.lastDay ? prettyDate(data.lastDay) : "");
  document.getElementById("acctPlayer").textContent = data.player ? `${data.player}'s membership` : "Your membership";
  document.getElementById("acctCredits").textContent =
    `${left} of ${data.credits || 4} lessons left${expires ? ` · use by ${expires}` : ""}`;
  document.getElementById("acctTitle").textContent = left ? "Book Your Next Lesson" : "This membership is used up";
  document.getElementById("acctLead").textContent = left
    ? `You have ${left} lesson${left === 1 ? "" : "s"} left. Pick any day that works${
        expires ? ` — they expire ${expires}` : ""
      }. Book one at a time; you don't have to plan them all now.`
    : `You've used all ${data.credits || 4} lessons. Buy another membership on the Book page when you're ready for 4 more.`;

  const expiry = document.getElementById("acctExpiry");
  if (expiry) {
    if (expires && left) {
      expiry.hidden = false;
      const days = typeof data.daysLeft === "number" ? data.daysLeft : null;
      expiry.innerHTML =
        `⏳ <strong>${left} lesson${left === 1 ? "" : "s"} left</strong> · must be used by <strong>${expires}</strong>` +
        (days !== null ? ` (${days} day${days === 1 ? "" : "s"} from today)` : "") +
        `<br />Unused lessons don't roll over, and your membership does not auto-renew.`;
    } else {
      expiry.hidden = true;
    }
  }

  const where = document.getElementById("acctWhere");
  if (data.location?.address) {
    where.hidden = false;
    const map = data.location.mapUrl
      ? ` <a href="${data.location.mapUrl}" target="_blank" rel="noopener">Directions</a>`
      : "";
    where.innerHTML = `📍 ${data.location.name} — ${data.location.address}.${map}<br />${data.location.note || ""}`;
  } else {
    where.hidden = true;
  }

  const list = document.getElementById("acctLessons");
  const upcoming = data.lessons || [];
  if (!upcoming.length) {
    list.innerHTML = `<p class="acct__empty">No lessons on the calendar yet.</p>`;
  } else {
    list.innerHTML = `<p class="booking__picked-title">Upcoming</p>` + upcoming.map((l) => {
      const canDrop = l.source !== "stripe";
      return `<div class="acct__row">
        <div><strong>${prettyDate(l.date)}</strong> · ${l.time}${l.focus ? ` · ${l.focus}` : ""}</div>
        ${canDrop ? `<button type="button" class="booking__change" data-cancel="${l.id}">Cancel</button>` : ""}
      </div>`;
    }).join("");
    list.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => cancelLesson(btn.dataset.cancel));
    });
  }

  const canBook = left > 0 && !data.expired;
  weekForm.hidden = !canBook;
  const msg = document.getElementById("acctMsg");
  if (data.expired) {
    msg.hidden = false;
    msg.innerHTML = `This membership ended${expires ? ` on ${expires}` : ""}. <a href="book.html?type=membership">Buy another month</a> when you're ready.`;
  } else if (!left) {
    msg.hidden = false;
    msg.innerHTML = `This membership is used up. <a href="book.html?type=membership">Buy another month</a> when you're ready for 4 more.`;
  } else {
    msg.hidden = true;
  }

  if (canBook) renderDays();
  showDash();
}

// Every open day from tomorrow through the day the membership expires — they
// can spend their remaining lessons on any of them.
function renderDays() {
  dateSelect.length = 1;
  const lastDay = (account && account.lastDay) || "";
  const now = new Date();
  for (let i = 1; i <= MAX_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = isoDate(d);
    if (lastDay && iso > lastDay) break;
    if (!startsForDate(iso).length) continue;
    dateSelect.append(new Option(prettyDate(iso), iso));
  }
  if (dateSelect.length === 1) {
    dateSelect.options[0].text = "No open days left in this membership";
  }
}

async function loadTimes(date) {
  timeSelect.innerHTML = "";
  if (!date) {
    timeSelect.append(new Option("Pick a day first", ""));
    timeSelect.disabled = true;
    return;
  }
  if (!bookedCache[date]) {
    timeSelect.append(new Option("Checking open times…", ""));
    timeSelect.disabled = true;
    try {
      const res = await fetch(`/api/slots?date=${date}`);
      bookedCache[date] = res.ok ? (await res.json()).booked || [] : [];
    } catch {
      bookedCache[date] = [];
    }
  }
  const taken = bookedCache[date] || [];
  const starts = startsForDate(date);
  timeSelect.innerHTML = "";
  timeSelect.append(new Option("Choose a time", ""));
  let open = 0;
  starts.forEach((t) => {
    const label = fmtTime(t);
    const hit = taken.some((b) => b.time === label);
    const opt = new Option(hit ? `${label} — booked` : label, label);
    opt.disabled = hit;
    if (!hit) open++;
    timeSelect.append(opt);
  });
  if (!open) timeSelect.options[0].text = "No open times this day";
  timeSelect.disabled = false;
}

async function loadAccount() {
  const { res, data } = await api("/api/member");
  if (!res.ok) {
    showLogin(data.error || "");
    return;
  }
  renderDash(data);
}

async function cancelLesson(id) {
  weekStatus.textContent = "";
  const { res, data } = await api("/api/member", {
    method: "POST",
    body: JSON.stringify({ action: "cancel", id }),
  });
  if (!res.ok) {
    weekStatus.textContent = data.error || "Couldn't cancel that lesson.";
    return;
  }
  delete bookedCache[""];
  Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
  renderDash(data);
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginStatus.textContent = "";
  loginSubmit.disabled = true;
  loginSubmit.textContent = "Sending…";
  try {
    const { data } = await api("/api/member-login", {
      method: "POST",
      body: JSON.stringify({ email: loginForm.elements.email.value.trim() }),
    });
    loginStatus.classList.add("booking__status--ok");
    loginStatus.textContent = data.message || "Check your email for a sign-in link.";
  } catch {
    loginStatus.classList.remove("booking__status--ok");
    loginStatus.textContent = "Couldn't send that. Call or text (405) 819-4401.";
  }
  loginSubmit.disabled = false;
  loginSubmit.textContent = "Email me a sign-in link";
});

weekForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  weekStatus.textContent = "";
  weekStatus.classList.remove("booking__status--ok");
  const date = dateSelect.value;
  const time = timeSelect.value;
  if (!date || !time) {
    weekStatus.textContent = "Pick a day and a time.";
    return;
  }
  const btn = document.getElementById("weekSubmit");
  btn.disabled = true;
  btn.textContent = "Booking…";
  const { res, data } = await api("/api/member", {
    method: "POST",
    body: JSON.stringify({
      action: "book",
      date,
      time,
      focus: document.getElementById("memFocus").value,
    }),
  });
  if (!res.ok) {
    weekStatus.textContent = data.error || "Couldn't book that time.";
    if (res.status === 409) delete bookedCache[date];
    btn.disabled = false;
    btn.textContent = "Lock in this lesson";
    loadTimes(date);
    return;
  }
  Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
  renderDash(data);
  btn.disabled = false;
  btn.textContent = "Lock in this lesson";
});

dateSelect.addEventListener("change", () => loadTimes(dateSelect.value));
document.getElementById("signOut").addEventListener("click", () => {
  clearToken();
  showLogin();
});

(async function init() {
  const params = new URLSearchParams(window.location.search);
  const k = params.get("k");
  if (k) {
    setToken(k);
    history.replaceState({}, "", window.location.pathname);
  }

  const sid = params.get("session_id");
  if (params.get("welcome") === "1" && sid) {
    loginStatus.textContent = "Finishing signup…";
    try {
      const conf = await fetch(`/api/confirm?session_id=${encodeURIComponent(sid)}`);
      const d = await conf.json().catch(() => ({}));
      if (d.memberToken) setToken(d.memberToken);
    } catch {
      /* still try the token we have */
    }
    history.replaceState({}, "", window.location.pathname);
  }

  try {
    const res = await fetch("/api/availability");
    if (res.ok) {
      const d = await res.json();
      if (d?.availability?.days) AVAIL = d.availability;
    }
  } catch {
    /* defaults unused — days stay empty until availability loads */
  }

  if (token()) loadAccount();
  else showLogin();
})();

}
