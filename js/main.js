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

// Availability. Days: 0=Sunday ... 6=Saturday (open every day). Times are
// session START times in 24h format — last start is 7 PM so lessons end by 8 PM.
const OPEN_DAYS = [0, 1, 2, 3, 4, 5, 6];
const START_TIMES = [
  "09:00", "10:00", "11:00", "12:00", "13:00", "14:00",
  "15:00", "16:00", "17:00", "18:00", "19:00",
];
const DAYS_AHEAD = 28; // how many days out parents can book

const SESSIONS = {
  single: { name: "Single Lesson", price: "$60 · 1 hour", label: "Pay $60 — Book Lesson", picks: 1 },
  group: { name: "Group Session", price: "$30 / player · 2 players · 30 min each", label: "Pay $60 — Book Group (2 players)", picks: 1 },
  membership: { name: "Membership", price: "$200 / month · 4 lessons", label: "Start Membership — $200/mo", picks: 4 },
};

const form = document.getElementById("bookingForm");
const dateSelect = document.getElementById("bkDate");
const timeSelect = document.getElementById("bkTime");
const pickedList = document.getElementById("pickedList");
const submitBtn = document.getElementById("bookingSubmit");
const statusEl = document.getElementById("bookingStatus");

let selectedType = "single";
let picked = []; // chosen sessions: [{ date: "2026-08-06", time: "9:00 AM" }]
const bookedCache = {}; // date -> array of taken times

function maxPicks() {
  return SESSIONS[selectedType].picks;
}

function setType(type) {
  if (!SESSIONS[type] || type === selectedType) return;
  selectedType = type;
  picked = [];
  document.getElementById("selName").textContent = SESSIONS[type].name;
  document.getElementById("selPrice").textContent = SESSIONS[type].price;
  renderTimeOptions();
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
    dateSelect.append(new Option(prettyDate(isoDate(d)), isoDate(d)));
  }
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
  if (!date) {
    timeSelect.append(new Option("Pick a day first", ""));
    timeSelect.disabled = true;
    return;
  }
  const booked = bookedCache[date] || [];
  timeSelect.disabled = false;
  timeSelect.append(new Option("Choose a time", ""));
  let open = 0;
  START_TIMES.forEach((t) => {
    const label = fmtTime(t);
    const isBooked = booked.includes(label);
    const isMine = picked.some((p) => p.date === date && p.time === label);
    const opt = new Option(
      isBooked ? `${label} — booked` : isMine ? `${label} — added` : label,
      label
    );
    opt.disabled = isBooked || isMine;
    if (!opt.disabled) open++;
    timeSelect.append(opt);
  });
  if (!open) {
    timeSelect.options[0].text = "No open times this day";
  }
  // For single/group the current pick stays shown in the dropdown
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
  dateSelect.addEventListener("change", () => loadTimes(dateSelect.value));
  timeSelect.addEventListener("change", () => chooseTime(timeSelect.value));
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

  // Success message after returning from Stripe
  if (new URLSearchParams(window.location.search).get("booked") === "1") {
    statusEl.innerHTML =
      '✅ You\'re booked! Training is at <a href="https://maps.google.com/?q=3701+S+Bryant+Ave,+Del+City,+OK+73115" target="_blank" rel="noopener">3701 S Bryant Ave, Del City, OK 73115</a>. Check your email for your receipt — see you there!';
    statusEl.classList.add("booking__status--ok");
    document.getElementById("book").scrollIntoView();
  }
}
