// Signal that JS is running (enables the scroll-reveal animation)
document.documentElement.classList.add("js");

// Mobile menu toggle
const burger = document.getElementById("navBurger");
const links = document.getElementById("navLinks");

burger.addEventListener("click", () => {
  const open = links.classList.toggle("is-open");
  burger.setAttribute("aria-expanded", open);
});

// Close the mobile menu after tapping a link
links.querySelectorAll("a").forEach((a) =>
  a.addEventListener("click", () => links.classList.remove("is-open"))
);

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
document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- Booking widget ---------- */

// Availability. Days: 1=Monday ... 4=Thursday. Times are session START
// times in 24h format — last start is 4 PM so lessons end by 5 PM.
const OPEN_DAYS = [1, 2, 3, 4];
const START_TIMES = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
const DAYS_AHEAD = 28; // how many days out parents can book

const SESSIONS = {
  single: { name: "Single Lesson", price: "$70 · 1 hour", label: "Pay $70 — Book Lesson", picks: 1 },
  group: { name: "Group Session", price: "$35 / player · 2 players · 1 hour", label: "Pay $70 — Book Group (2 players)", picks: 1 },
  membership: { name: "Membership", price: "$240 / month · 4 lessons", label: "Start Membership — $240/mo", picks: 4 },
};

const form = document.getElementById("bookingForm");
const dayChips = document.getElementById("dayChips");
const timeChips = document.getElementById("timeChips");
const pickedList = document.getElementById("pickedList");
const submitBtn = document.getElementById("bookingSubmit");
const statusEl = document.getElementById("bookingStatus");

let selectedType = "single";
let selectedDate = "";
let picked = []; // chosen sessions: [{ date: "2026-07-27", time: "9:00 AM" }]

function maxPicks() {
  return SESSIONS[selectedType].picks;
}

function setType(type) {
  if (!SESSIONS[type] || type === selectedType) return;
  selectedType = type;
  picked = [];
  document.getElementById("selName").textContent = SESSIONS[type].name;
  document.getElementById("selPrice").textContent = SESSIONS[type].price;
  updateTimeChipStates();
  updateDayChipMarks();
  renderPicked();
  refreshSubmit();
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

function chip(label, sub) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "booking__chip";
  b.innerHTML = sub ? `<strong>${label}</strong><span>${sub}</span>` : `<strong>${label}</strong>`;
  return b;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function renderDays() {
  const now = new Date();
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!OPEN_DAYS.includes(d.getDay())) continue;
    const value = isoDate(d);
    const c = chip(DAY_NAMES[d.getDay()], `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`);
    c.dataset.date = value;
    c.addEventListener("click", () => {
      selectedDate = value;
      dayChips.querySelectorAll(".booking__chip").forEach((x) => x.classList.remove("is-selected"));
      c.classList.add("is-selected");
      loadTimes(value);
    });
    dayChips.appendChild(c);
  }
}

function updateDayChipMarks() {
  dayChips.querySelectorAll(".booking__chip").forEach((c) => {
    c.classList.toggle("is-marked", picked.some((p) => p.date === c.dataset.date));
  });
}

function updateTimeChipStates() {
  timeChips.querySelectorAll(".booking__chip").forEach((c) => {
    if (c.disabled) return;
    const time = c.dataset.time;
    c.classList.toggle("is-selected", picked.some((p) => p.date === selectedDate && p.time === time));
  });
}

function renderPicked() {
  if (maxPicks() === 1) {
    pickedList.hidden = true;
    pickedList.innerHTML = "";
    return;
  }
  pickedList.hidden = false;
  pickedList.innerHTML = `<p class="booking__picked-title">Your lessons — ${picked.length} of ${maxPicks()} picked${picked.length < maxPicks() ? " · keep picking days &amp; times" : " ✓"}</p>`;
  picked.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "booking__picked-chip";
    b.innerHTML = `${prettyDate(p.date)} · ${p.time} <span aria-hidden="true">✕</span>`;
    b.title = "Remove this lesson";
    b.addEventListener("click", () => {
      picked.splice(i, 1);
      updateTimeChipStates();
      updateDayChipMarks();
      renderPicked();
      refreshSubmit();
    });
    pickedList.appendChild(b);
  });
}

function toggleTime(time) {
  statusEl.textContent = "";
  const idx = picked.findIndex((p) => p.date === selectedDate && p.time === time);
  if (idx >= 0) {
    picked.splice(idx, 1);
  } else if (maxPicks() === 1) {
    picked = [{ date: selectedDate, time }];
  } else if (picked.length >= maxPicks()) {
    statusEl.textContent = `You've already picked ${maxPicks()} lessons — remove one from the list below to change it.`;
    return;
  } else {
    picked.push({ date: selectedDate, time });
  }
  updateTimeChipStates();
  updateDayChipMarks();
  renderPicked();
  refreshSubmit();
}

async function loadTimes(date) {
  timeChips.innerHTML = '<p class="booking__hint">Checking open times…</p>';
  let booked = [];
  try {
    const res = await fetch(`/api/slots?date=${date}`);
    if (res.ok) booked = (await res.json()).booked || [];
  } catch {
    // Static preview or offline — show all times as open
  }
  timeChips.innerHTML = "";
  START_TIMES.forEach((t) => {
    const label = fmtTime(t);
    const c = chip(label);
    c.dataset.time = label;
    if (booked.includes(label)) {
      c.classList.add("is-booked");
      c.disabled = true;
      c.innerHTML = `<strong>${label}</strong><span>Booked</span>`;
    } else {
      c.addEventListener("click", () => toggleTime(label));
    }
    timeChips.appendChild(c);
  });
  updateTimeChipStates();
}

function refreshSubmit() {
  const need = maxPicks() - picked.length;
  if (selectedType === "membership" && need > 0) {
    submitBtn.textContent = `Pick ${need} more lesson${need === 1 ? "" : "s"} to continue`;
    submitBtn.disabled = true;
  } else {
    submitBtn.textContent = SESSIONS[selectedType].label;
    submitBtn.disabled = false;
  }
}

if (form) {
  renderDays();
  // "Pick Your Path" buttons carry the chosen session into the booking form
  document.querySelectorAll("[data-book]").forEach((a) =>
    a.addEventListener("click", () => setType(a.dataset.book))
  );
  refreshSubmit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.classList.remove("booking__status--ok");
    if (picked.length < maxPicks() || !form.elements.player.value.trim()) {
      statusEl.textContent =
        selectedType === "membership"
          ? "Please pick your 4 lesson days & times and enter the player's name."
          : "Please pick a day, a time, and enter the player's name.";
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
          player: form.elements.player.value.trim(),
          parent: form.elements.parent.value.trim(),
          phone: form.elements.phone.value.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      statusEl.textContent = data.error || "Online booking isn't live yet — call or text (405) 819-4401 to book.";
      if (res.status === 409 && selectedDate) loadTimes(selectedDate); // slot just taken — refresh times
    } catch {
      statusEl.textContent = "Online booking isn't live yet — call or text (405) 819-4401 to book.";
    }
    submitBtn.disabled = false;
    refreshSubmit();
  });

  // Success message after returning from Stripe
  if (new URLSearchParams(window.location.search).get("booked") === "1") {
    statusEl.innerHTML =
      '✅ You\'re booked! Training is at <a href="https://maps.google.com/?q=3701+S+Bryant+Ave,+Del+City,+OK+73115" target="_blank" rel="noopener">3701 S Bryant Ave, Del City, OK 73115</a>. Check your email for your receipt — see you there!';
    statusEl.classList.add("booking__status--ok");
    document.getElementById("book").scrollIntoView();
  }
}
