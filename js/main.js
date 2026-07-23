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

const PRICES = {
  single: { label: () => "Pay $70 — Book Lesson" },
  group: { label: (n) => `Pay $${40 * n} — Book Group (${n} players)` },
  membership: { label: () => "Start Membership — $240/mo" },
};

const form = document.getElementById("bookingForm");
const dayChips = document.getElementById("dayChips");
const timeChips = document.getElementById("timeChips");
const playersField = document.getElementById("playersField");
const playersSelect = document.getElementById("bkPlayers");
const submitBtn = document.getElementById("bookingSubmit");
const statusEl = document.getElementById("bookingStatus");

let selectedDate = "";
let selectedTime = "";

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

function renderDays() {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!OPEN_DAYS.includes(d.getDay())) continue;
    const value = isoDate(d);
    const c = chip(dayNames[d.getDay()], `${monthNames[d.getMonth()]} ${d.getDate()}`);
    c.addEventListener("click", () => {
      selectedDate = value;
      selectedTime = "";
      dayChips.querySelectorAll(".booking__chip").forEach((x) => x.classList.remove("is-selected"));
      c.classList.add("is-selected");
      loadTimes(value);
    });
    dayChips.appendChild(c);
  }
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
    if (booked.includes(label)) {
      c.classList.add("is-booked");
      c.disabled = true;
      c.innerHTML = `<strong>${label}</strong><span>Booked</span>`;
    } else {
      c.addEventListener("click", () => {
        selectedTime = label;
        timeChips.querySelectorAll(".booking__chip").forEach((x) => x.classList.remove("is-selected"));
        c.classList.add("is-selected");
      });
    }
    timeChips.appendChild(c);
  });
}

function refreshSubmit() {
  const type = form.elements.type.value;
  const n = parseInt(playersSelect.value, 10);
  playersField.hidden = type !== "group";
  submitBtn.textContent = PRICES[type].label(n);
}

if (form) {
  renderDays();
  playersSelect.addEventListener("change", refreshSubmit);
  form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener("change", refreshSubmit));
  refreshSubmit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.classList.remove("booking__status--ok");
    if (!selectedDate || !selectedTime || !form.elements.player.value.trim()) {
      statusEl.textContent = "Please pick a day, a time, and enter the player's name.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Setting up secure checkout…";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: form.elements.type.value,
          date: selectedDate,
          time: selectedTime,
          player: form.elements.player.value.trim(),
          parent: form.elements.parent.value.trim(),
          phone: form.elements.phone.value.trim(),
          players: playersSelect.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      statusEl.textContent = data.error || "Online booking isn't live yet — call or text (405) 819-4401 to book.";
      if (res.status === 409) loadTimes(selectedDate); // slot just taken — refresh times
    } catch {
      statusEl.textContent = "Online booking isn't live yet — call or text (405) 819-4401 to book.";
    }
    submitBtn.disabled = false;
    refreshSubmit();
  });

  // Success message after returning from Stripe
  if (new URLSearchParams(window.location.search).get("booked") === "1") {
    statusEl.textContent = "✅ You're booked! Check your email for the Stripe receipt. See you at training!";
    statusEl.classList.add("booking__status--ok");
    document.getElementById("book").scrollIntoView();
  }
}
