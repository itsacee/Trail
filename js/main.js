// Signal that JS is running (enables the scroll-reveal animation)
document.documentElement.classList.add("js");

// Mobile menu toggle
const burger = document.getElementById("navBurger");
const links = document.getElementById("navLinks");

if (burger && links) {
  burger.addEventListener("click", () => {
    const open = links.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", open);
  });
  links.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => links.classList.remove("is-open"))
  );
}

const nav = document.querySelector(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 20);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

// Fade-in sections as they scroll into view
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

// Current year in the footer
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const FILM_PAIRS = [
  [
    { src: "img/work/DcH1f6csW4H.mp4", poster: "img/work/DcH1f6csW4H.jpg" },
    { src: "img/work/DcMGqr2ua5P.mp4", poster: "img/work/DcMGqr2ua5P.jpg" },
  ],
  [
    { src: "img/work/DbgWOhvuin5.mp4", poster: "img/work/DbgWOhvuin5.jpg" },
    { src: "img/work/DbqzZQuKHbs.mp4", poster: "img/work/DbqzZQuKHbs.jpg" },
  ],
];
const filmPlayers = [...document.querySelectorAll(".film video")];
if (filmPlayers.length === 2) {
  let pair = 0;
  let finished = 0;
  let onScreen = false;

  const loadPair = (index) => {
    let ready = 0;
    FILM_PAIRS[index].forEach((clip, i) => {
      const v = filmPlayers[i];
      const onReady = () => {
        v.removeEventListener("loadeddata", onReady);
        ready += 1;
        if (ready === 2) playPair();
      };
      v.addEventListener("loadeddata", onReady);
      v.poster = clip.poster;
      v.src = clip.src;
      v.muted = true;
      v.classList.remove("is-live");
      v.load();
    });
  };

  const playPair = () => {
    if (!onScreen) return;
    filmPlayers.forEach((v) => v.play().catch(() => {}));
  };

  const nextPair = () => {
    finished = 0;
    pair = 1 - pair;
    loadPair(pair);
  };

  filmPlayers.forEach((v) => {
    v.addEventListener("ended", () => {
      finished += 1;
      if (finished >= 2) nextPair();
    });
    v.addEventListener("click", () => {
      const live = !v.classList.contains("is-live");
      filmPlayers.forEach((other) => {
        other.muted = true;
        other.classList.remove("is-live");
      });
      if (live) {
        v.muted = false;
        v.classList.add("is-live");
        v.play().catch(() => {});
      }
    });
  });

  new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) playPair();
      else {
        filmPlayers.forEach((v) => {
          v.pause();
          v.muted = true;
          v.classList.remove("is-live");
        });
      }
    },
    { threshold: 0.35 }
  ).observe(document.querySelector(".film"));
}

/* ---------- Booking widget ---------- */

// Availability defaults — MIRROR lib/schedule.js. The live values are fetched
// from /api/availability on load (the coach can edit them from the coach page);
// these defaults are only the fallback if that request fails.
const STEP_MINUTES = 30; // start times offered every 30 minutes
const DURATIONS = { single: 60, thirty: 30, membership: 60 };
function durationFor(type) { return DURATIONS[type] || 60; }

const DEFAULT_AVAILABILITY = {
  days: {
    0: { open: true, start: "09:00", end: "19:00" }, // Sun
    1: { open: true, start: "17:00", end: "21:00" }, // Mon
    2: { open: true, start: "17:00", end: "21:00" }, // Tue
    3: { open: true, start: "17:00", end: "21:00" }, // Wed
    4: { open: true, start: "17:00", end: "21:00" }, // Thu
    5: { open: true, start: "17:00", end: "21:00" }, // Fri
    6: { open: true, start: "09:00", end: "19:00" }, // Sat
  },
  blocked: [],
};
let AVAIL = DEFAULT_AVAILABILITY;

const PLACE_BLURB = {
  "Mustang": "Lessons train at <strong>Mustang High School</strong>'s baseball field in Mustang, OK.",
};

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// "5:00 PM" -> minutes since midnight
function labelToMin(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(label).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// Slot start times ("HH:mm") for a date — one every 30 min, but only if a
// lesson of durationMin fits before the day's close time.
function startsForDate(iso, durationMin) {
  const d = new Date(`${iso}T12:00:00`);
  if (isNaN(d)) return [];
  if ((AVAIL.blocked || []).includes(iso)) return [];
  const cfg = (AVAIL.days || {})[d.getDay()];
  if (!cfg || !cfg.open) return [];
  const start = toMinutes(cfg.start);
  const end = toMinutes(cfg.end);
  const dur = durationMin || STEP_MINUTES;
  const out = [];
  for (let t = start; t + dur <= end; t += STEP_MINUTES) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

function planFor(iso) {
  const times = startsForDate(iso);
  return times.length ? { times, place: "Mustang" } : null;
}

async function loadAvailability() {
  try {
    const res = await fetch("/api/availability");
    if (res.ok) {
      const d = await res.json();
      if (d && d.availability && d.availability.days) AVAIL = d.availability;
    }
  } catch {
    /* keep defaults — static preview or offline */
  }
}

const DAYS_AHEAD = 28; // how many days out parents can book

const SESSIONS = {
  single: { name: "Single Lesson", price: "$70 · 1 hour", label: "Pay $70 — Book Lesson", picks: 1, focus: "full" },
  thirty: { name: "30-Minute Lesson", price: "$50 · 30 min", label: "Pay $50 — Book Lesson", picks: 1, focus: "one" },
  membership: { name: "Membership", price: "$240 · 4 weeks", label: "Start Membership — $240", picks: 0, focus: "none" },
};

const form = document.getElementById("bookingForm");
const dateSelect = document.getElementById("bkDate");
const timeSelect = document.getElementById("bkTime");
const pickedList = document.getElementById("pickedList");
const submitBtn = document.getElementById("bookingSubmit");
const statusEl = document.getElementById("bookingStatus");
const focusField = document.getElementById("focusField");
const focusSelect = document.getElementById("bkFocus");

let selectedType = "single";
let picked = []; // chosen sessions: [{ date: "2026-08-06", time: "9:00 AM" }]
const bookedCache = {}; // date -> array of taken times

function maxPicks() {
  return SESSIONS[selectedType].picks;
}

function syncTypeTabs() {
  document.querySelectorAll("[data-book]").forEach((el) => {
    const on = el.dataset.book === selectedType;
    el.classList.toggle("is-active", on);
    if (el.getAttribute("role") === "tab") el.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function updateMemberCheckout() {
  const isMem = selectedType === "membership";
  const slotStep = document.getElementById("slotStep");
  const memberNote = document.getElementById("memberNote");
  const bookTitle = document.getElementById("bookTitle");
  const bookLead = document.getElementById("bookLead");
  if (slotStep) slotStep.hidden = isMem;
  if (memberNote) memberNote.hidden = !isMem;
  const whoNum = document.getElementById("whoStepNum");
  if (whoNum) whoNum.textContent = isMem ? "1" : "2";
  if (bookTitle) {
    bookTitle.textContent = isMem ? "Join. Then Pick Your Weeks." : "Pick a Day. Grab Your Spot.";
  }
  if (bookLead) {
    bookLead.textContent = isMem
      ? "Pay today. After that you'll sign in and book one lesson each week — when you know you can make it."
      : "Choose your lesson type, then lock in a time. We'll email the training address after you pay.";
  }
}

function setType(type, { syncUrl = true } = {}) {
  if (!SESSIONS[type]) return;
  if (type !== selectedType) {
    selectedType = type;
    picked = [];
  }
  const selName = document.getElementById("selName");
  const selPrice = document.getElementById("selPrice");
  if (selName) selName.textContent = SESSIONS[type].name;
  if (selPrice) selPrice.textContent = SESSIONS[type].price;
  syncTypeTabs();
  updateFocusField();
  updateMemberCheckout();
  renderTimeOptions();
  renderPicked();
  refreshSubmit();
  if (syncUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("type", type);
    url.searchParams.delete("booked");
    url.searchParams.delete("session_id");
    history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString());
  }
}

// Show the Hitting/Fielding focus picker per session type:
//   "full" → Hitting, Fielding, or Both (1-hour lessons)
//   "one"  → Hitting or Fielding only (30-minute lessons)
//   "none" → hidden (membership)
function updateFocusField() {
  if (!focusField) return;
  const mode = SESSIONS[selectedType].focus;
  if (mode === "none") { focusField.hidden = true; return; }
  focusField.hidden = false;
  const both = focusSelect ? focusSelect.querySelector('option[value="Both"]') : null;
  if (both) both.hidden = mode === "one";
  if (mode === "one" && focusSelect && focusSelect.value === "Both") focusSelect.value = "Hitting";
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function renderDays() {
  dateSelect.length = 1; // keep the "Choose a day" placeholder, rebuild the rest
  const now = new Date();
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = isoDate(d);
    if (!planFor(iso)) continue; // closed day or a blocked date — skip it
    dateSelect.append(new Option(prettyDate(iso), iso));
  }
}

function renderWhere() {
  const el = document.getElementById("bookingWhere");
  if (!el) return;
  const plan = planFor(dateSelect.value);
  if (!plan) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `📍 ${PLACE_BLURB[plan.place] || ""} You'll get the exact address and directions in your confirmation email.`;
}

function renderPicked() {
  if (maxPicks() === 1) {
    pickedList.hidden = true;
    pickedList.innerHTML = "";
    return;
  }
  pickedList.hidden = false;
  const done = picked.length === maxPicks();
  pickedList.innerHTML = `<p class="booking__picked-title">Your lessons — ${picked.length} of ${maxPicks()} picked${done ? " ✓" : " · keep adding days &amp; times"}</p>`;
  picked.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "booking__picked-chip";
    b.innerHTML = `${prettyDate(p.date)} · ${p.time} <span aria-hidden="true">✕</span>`;
    b.title = "Remove this lesson";
    b.addEventListener("click", () => {
      picked.splice(i, 1);
      renderTimeOptions();
      renderPicked();
      refreshSubmit();
    });
    pickedList.appendChild(b);
  });
}

// Rebuild the time dropdown for the currently selected day, marking
// times that are already booked or already added to this order.
function renderTimeOptions() {
  const date = dateSelect.value;
  timeSelect.innerHTML = "";
  renderWhere();
  if (!date) {
    timeSelect.append(new Option("Pick a day first", ""));
    timeSelect.disabled = true;
    return;
  }
  const dur = durationFor(selectedType);
  const starts = startsForDate(date, dur); // start times where this lesson fits
  const booked = bookedCache[date] || []; // [{ time, mins }]
  const bookedRanges = booked
    .map((b) => { const s = labelToMin(b.time); return s === null ? null : [s, s + (b.mins || 60)]; })
    .filter(Boolean);
  // Slots already added to THIS order block overlapping picks too
  const mineRanges = picked
    .filter((p) => p.date === date)
    .map((p) => { const s = labelToMin(p.time); return s === null ? null : [s, s + dur]; })
    .filter(Boolean);
  const overlaps = (ranges, s, e) => ranges.some(([bs, be]) => s < be && bs < e);
  timeSelect.disabled = false;
  timeSelect.append(new Option("Choose a time", ""));
  let open = 0;
  starts.forEach((t) => {
    const label = fmtTime(t);
    const s = toMinutes(t);
    const e = s + dur;
    const thisPick = picked.some((p) => p.date === date && p.time === label);
    const isBooked = overlaps(bookedRanges, s, e);
    const mineHit = !thisPick && overlaps(mineRanges, s, e);
    const opt = new Option(
      isBooked ? `${label} — booked` : thisPick ? `${label} — added` : mineHit ? `${label} — overlaps a pick` : label,
      label
    );
    opt.disabled = isBooked || thisPick || mineHit;
    if (!opt.disabled) open++;
    timeSelect.append(opt);
  });
  if (!open) {
    timeSelect.options[0].text = "No open times this day";
  }
  // For single & 30-min the current pick stays shown in the dropdown
  if (maxPicks() === 1 && picked.length && picked[0].date === date) {
    timeSelect.value = picked[0].time;
  }
}

async function loadTimes(date) {
  if (!date) {
    renderTimeOptions();
    return;
  }
  if (!bookedCache[date]) {
    timeSelect.innerHTML = "";
    timeSelect.append(new Option("Checking open times…", ""));
    timeSelect.disabled = true;
    try {
      const res = await fetch(`/api/slots?date=${date}`);
      bookedCache[date] = res.ok ? (await res.json()).booked || [] : [];
    } catch {
      bookedCache[date] = []; // static preview or offline — show all as open
    }
    if (dateSelect.value !== date) return; // parent changed day mid-request
  }
  renderTimeOptions();
}

function chooseTime(time) {
  statusEl.textContent = "";
  const date = dateSelect.value;
  if (!date || !time) return;

  if (maxPicks() === 1) {
    picked = [{ date, time }];
  } else if (picked.length >= maxPicks()) {
    statusEl.textContent = `You've already picked ${maxPicks()} lessons — remove one below to change it.`;
    timeSelect.value = "";
    return;
  } else {
    picked.push({ date, time });
    timeSelect.value = ""; // ready for the next pick
  }
  renderTimeOptions();
  renderPicked();
  refreshSubmit();
}

function refreshSubmit() {
  submitBtn.textContent = SESSIONS[selectedType].label;
  submitBtn.disabled = false;
}

if (form) {
  const params = new URLSearchParams(window.location.search);
  const typeFromUrl = params.get("type");
  if (SESSIONS[typeFromUrl]) selectedType = typeFromUrl;

  updateFocusField();
  updateMemberCheckout();
  syncTypeTabs();
  loadAvailability().then(renderDays);
  dateSelect.addEventListener("change", () => loadTimes(dateSelect.value));
  timeSelect.addEventListener("change", () => chooseTime(timeSelect.value));
  document.querySelectorAll("[data-book]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      setType(el.dataset.book);
    })
  );
  refreshSubmit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.classList.remove("booking__status--ok");
    if (picked.length < maxPicks() || !form.elements.player.value.trim()) {
      statusEl.textContent =
        selectedType === "membership"
          ? "Please enter the player's name and your email."
          : "Please pick a day, a time, and enter the player's name.";
      return;
    }
    if (!form.elements.email.checkValidity()) {
      statusEl.textContent = "Please enter a valid email — that's where your confirmation and the training address are sent.";
      form.elements.email.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Setting up secure checkout…";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          sessions: picked,
          focus: focusField && !focusField.hidden && focusSelect ? focusSelect.value : "",
          player: form.elements.player.value.trim(),
          parent: form.elements.parent.value.trim(),
          phone: form.elements.phone.value.trim(),
          email: form.elements.email.value.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      statusEl.textContent = data.error || "Online booking isn't live yet — call or text (405) 819-4401 to book.";
      if (res.status === 409) {
        // A slot was taken while they were filling the form — clear the
        // cached availability so the dropdown shows the truth.
        picked.forEach((p) => delete bookedCache[p.date]);
        picked = [];
        renderPicked();
        loadTimes(dateSelect.value);
      }
    } catch {
      statusEl.textContent = "Online booking isn't live yet — call or text (405) 819-4401 to book.";
    }
    submitBtn.disabled = false;
    refreshSubmit();
  });

  // Back from Stripe: confirm the payment, send the confirmation email,
  // and show the training address on screen.
  if (params.get("booked") === "1") {
    statusEl.classList.add("booking__status--ok");
    statusEl.textContent = "✅ You're booked! Getting your details…";
    document.getElementById("book")?.scrollIntoView();

    const finish = (d = {}) => {
      const when = (d.sessions || [])
        .map((s) => `${prettyDate(s.date)} · ${s.time}`)
        .join("<br />");
      const where = (d.places || [])
        .map((p) =>
          p.mapUrl
            ? `<a href="${p.mapUrl}" target="_blank" rel="noopener">${p.address}</a>`
            : `${p.name} — we'll send you the exact address shortly`
        )
        .join("<br />");
      statusEl.innerHTML =
        `<strong>✅ You're booked!</strong>` +
        (when ? `<br />${when}` : "") +
        (where ? `<br />Training location: ${where}` : "") +
        (d.sent
          ? `<br />A confirmation with directions is on its way to ${d.email || "your inbox"}.`
          : `<br />Questions? Call or text (405) 819-4401.`);
      // Clean the URL so a refresh doesn't re-run this
      history.replaceState({}, "", window.location.pathname);
    };

    const sid = params.get("session_id");
    if (sid) {
      fetch(`/api/confirm?session_id=${encodeURIComponent(sid)}`)
        .then((r) => r.json())
        .then(finish)
        .catch(() => finish());
    } else {
      finish();
    }
  }
}
