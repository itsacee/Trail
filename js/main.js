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

// Open training hours. Adjust to your real availability:
// weekday = Monday–Friday, weekend = Saturday–Sunday. 24h format.
const OPEN_HOURS = {
  weekday: ["16:00", "17:00", "18:00", "19:00", "20:00"],
  weekend: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
};

const PRICES = {
  single: { label: () => "Pay $70 — Book Lesson" },
  group: { label: (n) => `Pay $${50 * n} — Book Group (${n} players)` },
  membership: { label: () => "Start Membership — $240/mo" },
};

const form = document.getElementById("bookingForm");
const dateInput = document.getElementById("bkDate");
const timeSelect = document.getElementById("bkTime");
const playersField = document.getElementById("playersField");
const playersSelect = document.getElementById("bkPlayers");
const submitBtn = document.getElementById("bookingSubmit");
const statusEl = document.getElementById("bookingStatus");

function fmt(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function refreshTimes() {
  const v = dateInput.value;
  timeSelect.innerHTML = "";
  if (!v) {
    timeSelect.append(new Option("Pick a date first", ""));
    return;
  }
  const day = new Date(v + "T12:00:00").getDay();
  const slots = day === 0 || day === 6 ? OPEN_HOURS.weekend : OPEN_HOURS.weekday;
  timeSelect.append(new Option("Choose a time", ""));
  slots.forEach((t) => timeSelect.append(new Option(fmt(t), fmt(t))));
}

function refreshSubmit() {
  const type = form.elements.type.value;
  const n = parseInt(playersSelect.value, 10);
  playersField.hidden = type !== "group";
  submitBtn.textContent = PRICES[type].label(n);
}

if (form) {
  // Bookable window: today through 60 days out
  const today = new Date();
  const max = new Date(today.getTime() + 60 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  dateInput.min = iso(today);
  dateInput.max = iso(max);

  dateInput.addEventListener("change", refreshTimes);
  playersSelect.addEventListener("change", refreshSubmit);
  form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener("change", refreshSubmit));
  refreshTimes();
  refreshSubmit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    if (!dateInput.value || !timeSelect.value || !form.elements.player.value.trim()) {
      statusEl.textContent = "Please pick a date, a time, and enter the player's name.";
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
          date: dateInput.value,
          time: timeSelect.value,
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
