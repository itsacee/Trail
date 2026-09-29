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
    a.addEventListener("click", () => {
      links.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
    })
  );
}

const more = document.querySelector(".nav__more");
const moreBtn = more?.querySelector(".nav__more-btn");
if (more && moreBtn) {
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = more.classList.toggle("is-open");
    moreBtn.setAttribute("aria-expanded", open);
  });
  document.addEventListener("click", () => {
    more.classList.remove("is-open");
    moreBtn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      more.classList.remove("is-open");
      moreBtn.setAttribute("aria-expanded", "false");
    }
  });
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

/* ---------- Booking widget ----------
 *
 * Drives the form on book.html: month calendar, time chips, the add-another-
 * athlete toggle, and the pay options. The slot math and the calendar itself
 * come from js/booking-core.js (window.AP) so the member portal can reuse them.
 */
(function () {
  const AP = window.AP;

  let SITE_STATUS = {
    blockNewMemberships: false,
    blockNewMembershipsReason: "",
    membershipFrozen: false,
    membershipFrozenReason: "",
    fieldingOnly: false,
    fieldingOnlyReason: "",
    membershipPaused: false,
    membershipPausedReason: "",
  };

  /* ---------- membership availability (also used on the pricing page) ---------- */

  let membershipCapacity = { state: "loading", limit: 15, spotsAvailable: 0, available: false };
  const form = document.getElementById("bookingForm");

  function membershipsPaused() {
    return Boolean(SITE_STATUS.blockNewMemberships || SITE_STATUS.membershipPaused);
  }

  function membershipCapacityText() {
    if (membershipsPaused()) {
      return SITE_STATUS.blockNewMembershipsReason || SITE_STATUS.membershipPausedReason;
    }
    if (membershipCapacity.state === "loading") return "Checking membership availability…";
    if (membershipCapacity.state !== "ready") {
      return "Membership availability is temporarily unavailable. Please try again soon.";
    }
    if (!membershipCapacity.available) {
      return `Memberships are full — 0 of ${membershipCapacity.limit} spots available. A spot opens automatically when a current membership ends.`;
    }
    return `${membershipCapacity.spotsAvailable} of ${membershipCapacity.limit} membership spots available.`;
  }

  function membershipBlocked() {
    return (
      membershipsPaused() || membershipCapacity.state !== "ready" || !membershipCapacity.available
    );
  }

  function renderMembershipCapacity() {
    document.querySelectorAll("[data-membership-availability]").forEach((el) => {
      el.textContent = membershipCapacityText();
      el.classList.toggle("is-full", membershipBlocked());
    });
    document.querySelectorAll("[data-membership-purchase]").forEach((el) => {
      el.classList.toggle("is-unavailable", membershipBlocked());
      el.setAttribute("aria-disabled", membershipBlocked() ? "true" : "false");
    });
    if (form && AP) refreshSubmit();
  }

  async function loadMembershipCapacity() {
    renderMembershipCapacity();
    try {
      const response = await fetch("/api/membership-capacity", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.spotsAvailable !== "number") throw new Error("unavailable");
      membershipCapacity = { ...data, state: "ready" };
    } catch {
      membershipCapacity = { state: "error", limit: 15, spotsAvailable: 0, available: false };
    }
    renderMembershipCapacity();
  }

  document.querySelectorAll("[data-membership-purchase]").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (membershipBlocked()) event.preventDefault();
    });
  });

  // Pricing pages can fill their capacity line right away. book.html waits for
  // the boot sequence below, because rendering capacity also refreshes the
  // submit button, which needs the booking state further down this file.
  if (!form && document.querySelector("[data-membership-availability]")) loadMembershipCapacity();

  if (!form || !AP) return;

  /* ---------- state ---------- */

  const SESSIONS = {
    single: { name: "Regular Lesson", picks: 1, focus: "full", shared: true },
    private: { name: "Private 1-on-1", picks: 1, focus: "full", shared: false },
    membership: { name: "Membership", picks: 1, focus: "full", shared: false },
    thirty: { name: "30-Minute Lesson", picks: 1, focus: "one", shared: true },
  };

  let AVAIL = AP.DEFAULT_AVAILABILITY;
  let bookableDates = [];
  let PRICING = {
    prices: { single: 8000, thirty: 6000, membership: 28000, private: 10000 },
    membershipDeposit: 8000,
    allowCash: true,
    allowDeposit: true,
  };

  let selectedType = "single";
  let athletes = 1; // 1 or 2 — two names fill the hour
  let selectedDate = "";
  let selectedTime = "";
  let payMode = "card";
  const bookedCache = {}; // iso -> [{ time, mins, seats, exclusive, focuses }]

  const els = {
    calendar: document.getElementById("bkCalendar"),
    times: document.getElementById("bkTimes"),
    timesTitle: document.getElementById("bkTimesTitle"),
    chips: document.getElementById("bkTimeChips"),
    timesNote: document.getElementById("bkTimesNote"),
    where: document.getElementById("bookingWhere"),
    focusField: document.getElementById("focusField"),
    focusSelect: document.getElementById("bkFocus"),
    player: document.getElementById("bkPlayer"),
    player2: document.getElementById("bkPlayer2"),
    player2Field: document.getElementById("secondAthleteField"),
    player2Hint: document.getElementById("secondAthleteHint"),
    addAthlete: document.getElementById("addAthleteBtn"),
    email: document.getElementById("bkEmail"),
    phone: document.getElementById("bkPhone"),
    submit: document.getElementById("bookingSubmit"),
    status: document.getElementById("bookingStatus"),
    total: document.getElementById("bookingTotal"),
    typeNote: document.getElementById("typeNote"),
    notice: document.getElementById("siteNotice"),
    memberNote: document.getElementById("memberNote"),
  };

  const TYPE_NOTE = {
    single: "One hour. A second athlete can share the hour with you unless you add one yourself.",
    private: "One hour, yours alone. Nobody else can book into this time.",
    membership: "Four one-hour lessons a month. You pick lesson 1 today.",
    thirty: "A focused 30 minutes on one skill.",
  };

  // Starting checkout reserves the slot so nobody else can pay for it. That
  // reservation must never block the person who created it — otherwise backing
  // out of payment locks them out of the very time they were trying to buy.
  const HOLD_KEY = "ap_checkout_session";
  const myHold = () => {
    try {
      return sessionStorage.getItem(HOLD_KEY) || "";
    } catch {
      return "";
    }
  };
  const rememberHold = (id) => {
    try {
      id ? sessionStorage.setItem(HOLD_KEY, id) : sessionStorage.removeItem(HOLD_KEY);
    } catch {
      /* private mode */
    }
  };

  /* ---------- derived values ---------- */

  function sharedType() {
    return Boolean(SESSIONS[selectedType].shared);
  }

  function athleteCount() {
    return sharedType() ? athletes : 1;
  }

  function want() {
    // A private lesson buys the whole hour; two athletes fill both seats.
    if (selectedType === "private") return { seats: AP.SLOT_CAPACITY, exclusive: true };
    return { seats: AP.seatsFor(selectedType, athleteCount()), exclusive: false };
  }

  function unitPrice() {
    return PRICING.prices[selectedType] || 0;
  }

  function totalPrice() {
    return unitPrice() * athleteCount();
  }

  function depositAmount() {
    return Math.min(PRICING.membershipDeposit || 8000, totalPrice());
  }

  function currentFocus() {
    if (!els.focusField || els.focusField.hidden || !els.focusSelect) return "";
    return els.focusSelect.value;
  }

  function openDay(iso) {
    if (bookableDates.length && !bookableDates.includes(iso)) return false;
    if (!AP.startsForDate(iso, AVAIL, AP.durationFor(selectedType)).length) return false;
    // Days we've already checked and found nothing open on grey out too.
    const booked = bookedCache[iso];
    if (booked && !openTimesFor(iso, booked).length) return false;
    return true;
  }

  function openTimesFor(iso, booked) {
    const dur = AP.durationFor(selectedType);
    const focus = currentFocus();
    const need = want();
    return AP.startsForDate(iso, AVAIL, dur)
      .map((t) => AP.fmtTime(t))
      .filter((label) => !AP.slotIsBlocked(booked || [], label, dur, focus, need));
  }

  /* ---------- loading ---------- */

  async function loadAvailability() {
    try {
      const res = await fetch("/api/availability");
      if (res.ok) {
        const d = await res.json();
        if (d && d.availability && d.availability.days) AVAIL = d.availability;
        if (d && d.siteStatus) SITE_STATUS = d.siteStatus;
        if (Array.isArray(d?.bookingWindow?.dates)) bookableDates = d.bookingWindow.dates;
      }
    } catch {
      /* keep defaults — static preview or offline */
    }
    applySiteStatus();
  }

  async function loadPricing() {
    try {
      const res = await fetch("/api/pricing", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        PRICING = { ...PRICING, ...d, prices: { ...PRICING.prices, ...(d.prices || {}) } };
      }
    } catch {
      /* defaults */
    }
    renderPrices();
    syncPayOptions();
    refreshSubmit();
  }

  async function loadSlots(iso) {
    if (!iso || bookedCache[iso]) return;
    try {
      const mine = myHold();
      const res = await fetch(`/api/slots?date=${iso}${mine ? `&mine=${encodeURIComponent(mine)}` : ""}`);
      bookedCache[iso] = res.ok ? (await res.json()).booked || [] : [];
    } catch {
      bookedCache[iso] = []; // static preview or offline — show all as open
    }
  }

  // Check every day in the booking window up front so full days can grey out on
  // the calendar instead of only revealing themselves once tapped. The window is
  // one week and most days are closed, so this is a handful of requests.
  async function prefetchWindow() {
    const days = (bookableDates.length ? bookableDates : fallbackDates()).filter((iso) =>
      AP.startsForDate(iso, AVAIL, 60).length
    );
    await Promise.all(days.map((iso) => loadSlots(iso)));
    calendar.render();
  }

  function fallbackDates() {
    const out = [];
    const now = new Date();
    for (let i = 1; i <= 7; i++) {
      out.push(AP.isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
    }
    return out;
  }

  /* ---------- rendering ---------- */

  function applySiteStatus() {
    if (els.notice) {
      const parts = [];
      if (SITE_STATUS.fieldingOnly && SITE_STATUS.fieldingOnlyReason) parts.push(SITE_STATUS.fieldingOnlyReason);
      if (SITE_STATUS.membershipFrozen && SITE_STATUS.membershipFrozenReason) {
        parts.push(SITE_STATUS.membershipFrozenReason);
      } else if (SITE_STATUS.blockNewMemberships && SITE_STATUS.blockNewMembershipsReason) {
        parts.push(SITE_STATUS.blockNewMembershipsReason);
      }
      els.notice.hidden = !parts.length;
      els.notice.innerHTML = parts.map((p) => `<p>${p}</p>`).join("");
    }

    document.querySelectorAll('[data-book="membership"]').forEach((el) => {
      const paused = membershipsPaused();
      el.disabled = paused;
      el.classList.toggle("is-disabled", paused);
      el.setAttribute("aria-disabled", paused ? "true" : "false");
      const tag = el.querySelector(".booking__type-tag");
      if (tag) tag.hidden = !paused;
    });

    if (membershipsPaused()) {
      if (selectedType === "membership") setType("single");
      membershipCapacity = {
        state: "ready",
        limit: membershipCapacity.limit || 15,
        spotsAvailable: 0,
        available: false,
        paused: true,
      };
      renderMembershipCapacity();
    }

    updateFocusField();
  }

  function renderPrices() {
    document.querySelectorAll("[data-price]").forEach((el) => {
      const cents = PRICING.prices[el.dataset.price];
      if (cents) el.textContent = AP.dollars(cents);
    });
    const memPrice = document.getElementById("memberNotePrice");
    if (memPrice) memPrice.textContent = `${AP.dollars(PRICING.prices.membership)} for one month`;
    const memDeposit = document.getElementById("memberNoteDeposit");
    if (memDeposit) {
      const due = Math.max(0, (PRICING.prices.membership || 0) - depositAmount());
      memDeposit.innerHTML =
        `Pay <strong>by card</strong>, put <strong>${AP.dollars(depositAmount())} down by card</strong> and bring ` +
        `<strong>${AP.dollars(due)} cash to your first lesson</strong>, or <strong>pay all cash</strong> at the field.`;
    }
  }

  function syncTypeTabs() {
    document.querySelectorAll("[data-book]").forEach((el) => {
      const on = el.dataset.book === selectedType;
      el.classList.toggle("is-active", on);
      if (el.getAttribute("role") === "tab") el.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (els.typeNote) els.typeNote.textContent = TYPE_NOTE[selectedType] || "";
    const title = document.getElementById("bookTitle");
    const lead = document.getElementById("bookLead");
    const slotTitle = document.getElementById("slotStepTitle");
    const isMem = selectedType === "membership";
    if (els.memberNote) els.memberNote.hidden = !isMem;
    if (slotTitle) slotTitle.textContent = isMem ? "Pick your first lesson" : "Pick a day";
    if (title) title.textContent = isMem ? "Join. Pick Your First Day." : "Pick a Day. Grab Your Spot.";
    if (lead) {
      lead.textContent = isMem
        ? "Pay today and lock in lesson 1 of 4. Book the other 3 one at a time from the Members page. It does not auto-renew."
        : "Choose your lesson, pick a time, and we'll email the training address after you book.";
    }
  }

  // Show the Hitting/Fielding focus picker per session type:
  //   "full" → Hitting, Fielding, or Both (1-hour lessons)
  //   "one"  → Hitting or Fielding only (30-minute lessons)
  function updateFocusField() {
    if (!els.focusField) return;
    const mode = SESSIONS[selectedType].focus;
    els.focusField.hidden = false;
    const select = els.focusSelect;
    if (!select) return;
    const hitting = select.querySelector('option[value="Hitting"]');
    const both = select.querySelector('option[value="Both"]');
    const fieldingOnly = Boolean(SITE_STATUS.fieldingOnly);
    if (hitting) hitting.hidden = fieldingOnly;
    if (both) both.hidden = fieldingOnly || mode === "one";
    if (fieldingOnly) select.value = "Fielding";
    else if (mode === "one" && select.value === "Both") select.value = "Hitting";
  }

  function syncAthleteField() {
    const canAdd = sharedType();
    if (els.addAthlete) {
      els.addAthlete.hidden = !canAdd;
      els.addAthlete.classList.toggle("is-active", canAdd && athletes > 1);
      els.addAthlete.innerHTML =
        athletes > 1
          ? '<span aria-hidden="true">−</span> Remove second athlete'
          : '<span aria-hidden="true">+</span> Add another athlete';
    }
    const show = canAdd && athletes > 1;
    if (els.player2Field) els.player2Field.hidden = !show;
    if (els.player2) {
      els.player2.required = show;
      if (!show) els.player2.value = "";
    }
    if (els.player2Hint) {
      els.player2Hint.textContent = show
        ? `Two athletes fill the hour — nobody else can book it. ${AP.dollars(unitPrice())} each.`
        : "";
    }
  }

  function renderWhere() {
    if (!els.where) return;
    if (!selectedDate) {
      els.where.hidden = true;
      return;
    }
    els.where.hidden = false;
    els.where.innerHTML =
      "📍 Lessons train at <strong>Mustang High School</strong>'s baseball field in Mustang, OK. " +
      "You'll get the exact address and directions in your confirmation email.";
  }

  function renderTimes() {
    if (!els.chips || !els.times) return;
    els.chips.innerHTML = "";
    renderWhere();
    if (!selectedDate) {
      els.times.hidden = true;
      return;
    }
    els.times.hidden = false;
    if (els.timesTitle) els.timesTitle.textContent = `Open times · ${AP.prettyDate(selectedDate)}`;

    const booked = bookedCache[selectedDate];
    if (!booked) {
      if (els.timesNote) els.timesNote.textContent = "Checking open times…";
      return;
    }

    const dur = AP.durationFor(selectedType);
    const focus = currentFocus();
    const need = want();
    const starts = AP.startsForDate(selectedDate, AVAIL, dur);
    let open = 0;

    starts.forEach((t) => {
      const label = AP.fmtTime(t);
      const blocked = AP.slotIsBlocked(booked, label, dur, focus, need);
      const left = AP.seatsLeft(booked, label, dur, focus);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.disabled = blocked;
      chip.classList.toggle("is-off", blocked);
      const on = !blocked && selectedTime === label;
      chip.classList.toggle("is-selected", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
      const tag = blocked ? "Booked" : left === 1 && need.seats === 1 ? "1 spot left" : "";
      chip.innerHTML = `<span class="chip__time">${label}</span>${tag ? `<span class="chip__tag">${tag}</span>` : ""}`;
      if (!blocked) {
        open++;
        chip.addEventListener("click", () => {
          selectedTime = label;
          if (els.status) els.status.textContent = "";
          renderTimes();
          refreshSubmit();
        });
      }
      els.chips.appendChild(chip);
    });

    if (els.timesNote) {
      els.timesNote.textContent = !open
        ? need.exclusive
          ? "Nothing open for a private hour this day — try another day or book a regular lesson."
          : need.seats > 1
          ? "No hour on this day has room for two athletes. Try another day."
          : "No open times this day."
        : selectedTime
        ? ""
        : "Tap a time to pick it.";
    }
  }

  function syncPayOptions() {
    const isMem = selectedType === "membership";
    const total = totalPrice();
    const deposit = depositAmount();
    const due = Math.max(0, total - deposit);

    const depositBtn = document.getElementById("payDepositBtn");
    const cashBtn = document.getElementById("payCashBtn");
    if (depositBtn) depositBtn.hidden = !(isMem && PRICING.allowDeposit);
    if (cashBtn) cashBtn.hidden = !PRICING.allowCash;
    if (payMode === "deposit" && (!isMem || !PRICING.allowDeposit)) payMode = "card";
    if (payMode === "cash" && !PRICING.allowCash) payMode = "card";

    const cardHint = document.getElementById("payCardHint");
    const depositHint = document.getElementById("payDepositHint");
    const cardAmount = document.getElementById("payCardAmount");
    const depositAmountEl = document.getElementById("payDepositAmount");
    const cashAmount = document.getElementById("payCashAmount");
    if (cardHint) cardHint.textContent = "Pay in full online now";
    if (cardAmount) cardAmount.textContent = AP.dollars(total);
    if (depositHint) {
      depositHint.textContent = `${AP.dollars(due)} cash due at your first lesson`;
    }
    if (depositAmountEl) depositAmountEl.textContent = `${AP.dollars(deposit)} now`;
    if (cashAmount) cashAmount.textContent = AP.dollars(total);

    document.querySelectorAll("[data-pay]").forEach((el) => {
      const on = el.dataset.pay === payMode;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    });

    if (els.total) {
      const perAthlete =
        athleteCount() > 1 ? ` · 2 athletes × ${AP.dollars(unitPrice())}` : "";
      els.total.innerHTML =
        payMode === "deposit"
          ? `<strong>${AP.dollars(deposit)} today</strong> by card · <strong>${AP.dollars(due)} in cash at your first lesson</strong>`
          : payMode === "cash"
          ? `<strong>Total ${AP.dollars(total)}</strong>${perAthlete} — bring it in cash to the field`
          : `<strong>Total ${AP.dollars(total)}</strong>${perAthlete}`;
    }

    const note = document.getElementById("bookingPayNote");
    if (note) {
      note.textContent =
        payMode === "cash"
          ? "You'll reserve the spot now and pay cash at the field. We'll email the training address."
          : payMode === "deposit"
          ? "Card deposit today — the rest is due in cash at your first lesson. We'll email the training address."
          : "🔒 Secure payment by Stripe. We'll email the training address after you book.";
    }
  }

  function refreshSubmit() {
    if (!els.submit) return;
    syncPayOptions();
    if (selectedType === "membership" && membershipsPaused()) {
      els.submit.textContent = "Memberships Paused";
      els.submit.disabled = true;
      return;
    }
    if (selectedType === "membership" && membershipCapacity.state !== "ready") {
      els.submit.textContent =
        membershipCapacity.state === "loading" ? "Checking Membership Availability…" : "Membership Unavailable";
      els.submit.disabled = true;
      return;
    }
    if (selectedType === "membership" && !membershipCapacity.available) {
      els.submit.textContent = `Memberships Full — 0 of ${membershipCapacity.limit} Spots`;
      els.submit.disabled = true;
      return;
    }
    const total = totalPrice();
    els.submit.textContent =
      payMode === "cash"
        ? selectedType === "membership"
          ? `Reserve Membership — Pay ${AP.dollars(total)} Cash`
          : `Reserve — Pay ${AP.dollars(total)} Cash at the Field`
        : payMode === "deposit"
        ? `Pay ${AP.dollars(depositAmount())} Deposit — Start Membership`
        : selectedType === "membership"
        ? `Start Membership — ${AP.dollars(total)}`
        : `Pay ${AP.dollars(total)} — Book Lesson`;
    els.submit.disabled = false;
  }

  /* ---------- calendar ---------- */

  const calendar = AP.createCalendar(els.calendar, {
    isOpen: openDay,
    dates: () => (bookableDates.length ? bookableDates : fallbackDates()),
    onSelect: (iso) => pickDate(iso),
  });

  async function pickDate(iso) {
    selectedDate = iso;
    selectedTime = "";
    renderTimes();
    await loadSlots(iso);
    if (selectedDate !== iso) return; // they moved on mid-request
    renderTimes();
    calendar.render(); // the day may have just turned out to be full
    refreshSubmit();
  }

  function resetSlot() {
    selectedTime = "";
    if (selectedDate && !openDay(selectedDate)) {
      selectedDate = "";
      calendar.clear();
    }
    renderTimes();
    calendar.render();
    refreshSubmit();
  }

  function setType(type) {
    if (!SESSIONS[type]) return;
    if (type === "membership" && membershipsPaused()) return;
    if (type === selectedType) return;
    selectedType = type;
    if (!sharedType()) athletes = 1;
    syncTypeTabs();
    updateFocusField();
    syncAthleteField();
    resetSlot();
    const url = new URL(window.location.href);
    url.searchParams.set("type", type);
    url.searchParams.delete("booked");
    url.searchParams.delete("session_id");
    history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString());
  }

  /* ---------- wiring ---------- */

  document.querySelectorAll("[data-book]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return;
      setType(el.dataset.book);
    })
  );

  document.querySelectorAll("[data-pay]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      if (el.hidden) return;
      payMode = el.dataset.pay;
      syncPayOptions();
      refreshSubmit();
    })
  );

  if (els.focusSelect) {
    els.focusSelect.addEventListener("change", () => resetSlot());
  }

  if (els.addAthlete) {
    els.addAthlete.addEventListener("click", () => {
      athletes = athletes > 1 ? 1 : 2;
      syncAthleteField();
      resetSlot();
      if (athletes > 1 && els.player2) els.player2.focus();
    });
  }

  const params = new URLSearchParams(window.location.search);
  syncTypeTabs();
  updateFocusField();
  syncAthleteField();
  renderPrices();
  refreshSubmit();
  loadPricing();
  loadMembershipCapacity();
  loadAvailability().then(() => {
    const typeFromUrl = params.get("type");
    if (SESSIONS[typeFromUrl] && !(typeFromUrl === "membership" && membershipsPaused())) {
      selectedType = typeFromUrl;
      if (!sharedType()) athletes = 1;
      syncTypeTabs();
      updateFocusField();
      syncAthleteField();
    }
    calendar.render();
    refreshSubmit();
    prefetchWindow();
  });

  /* ---------- submit ---------- */

  function clearSlotCache() {
    Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.status.textContent = "";
    els.status.classList.remove("booking__status--ok");

    if (!selectedDate || !selectedTime) {
      els.status.textContent = "Please pick a day and a time.";
      return;
    }
    if (!els.player.value.trim()) {
      els.status.textContent = "Please enter the athlete's name.";
      els.player.focus();
      return;
    }
    if (athleteCount() > 1 && !els.player2.value.trim()) {
      els.status.textContent = "Please enter the second athlete's name, or remove the second athlete.";
      els.player2.focus();
      return;
    }
    if (!els.email.checkValidity() || !els.email.value.trim()) {
      els.status.textContent =
        "Please enter a valid email — that's where your confirmation and the training address are sent.";
      els.email.focus();
      return;
    }

    els.submit.disabled = true;
    els.submit.textContent = payMode === "cash" ? "Reserving your spot…" : "Setting up secure checkout…";

    const payload = {
      type: selectedType,
      sessions: [{ date: selectedDate, time: selectedTime }],
      focus: currentFocus(),
      player: els.player.value.trim(),
      player2: athleteCount() > 1 ? els.player2.value.trim() : "",
      athletes: athleteCount(),
      phone: els.phone ? els.phone.value.trim() : "",
      email: els.email.value.trim(),
      payMode,
      date: selectedDate,
      time: selectedTime,
      previousSession: myHold(),
    };

    const onConflict = () => {
      clearSlotCache();
      selectedTime = "";
      renderTimes();
      pickDate(selectedDate);
    };

    try {
      if (payMode === "cash") {
        const res = await fetch("/api/cash-book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          els.status.textContent = data.error || "Couldn't reserve that spot. Call or text (405) 819-4401.";
          if (data.code === "membership_full") {
            membershipCapacity = { state: "ready", limit: 15, spotsAvailable: 0, available: false };
            renderMembershipCapacity();
          } else if (res.status === 409) {
            onConflict();
          }
          els.submit.disabled = false;
          refreshSubmit();
          return;
        }
        els.status.classList.add("booking__status--ok");
        const when = (data.sessions || []).map((s) => `${AP.prettyDate(s.date)} · ${s.time}`).join("<br />");
        const due = data.amountDue ? AP.dollars(data.amountDue) : "";
        els.status.innerHTML =
          "<strong>✅ Spot reserved — pay cash at the field</strong>" +
          (when ? `<br />${when}` : "") +
          (due ? `<br />Bring ${due} cash.` : "") +
          (data.places?.[0]?.address
            ? `<br />Training: <a href="${data.places[0].mapUrl}" target="_blank" rel="noopener">${data.places[0].address}</a>`
            : "") +
          (data.member ? `<br />Next: <a href="account.html">Members</a> to book the rest.` : "") +
          (data.sent ? `<br />Details sent to ${data.email || "your inbox"}.` : "");
        history.replaceState({}, "", window.location.pathname);
        els.submit.disabled = false;
        refreshSubmit();
        return;
      }

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        rememberHold(data.sessionId || "");
        window.location.href = data.url;
        return;
      }
      els.status.textContent = data.error || "Online booking isn't live yet — call or text (405) 819-4401 to book.";
      if (data.code === "membership_full") {
        membershipCapacity = { state: "ready", limit: 15, spotsAvailable: 0, available: false };
        renderMembershipCapacity();
      } else if (res.status === 409) {
        onConflict();
      }
    } catch {
      els.status.textContent = "Online booking isn't live yet — call or text (405) 819-4401 to book.";
    }
    els.submit.disabled = false;
    refreshSubmit();
  });

  /* ---------- returning from Stripe ---------- */

  // Backed out of Stripe without paying — hand the slot straight back rather
  // than leaving it reserved against everyone else until the hold expires.
  const cancelled = params.get("cancelled") || "";
  if (/^cs_[A-Za-z0-9_]+$/.test(cancelled)) {
    rememberHold("");
    clearSlotCache();
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", sessionId: cancelled }),
    })
      .catch(() => {})
      .finally(() => {
        if (selectedDate) pickDate(selectedDate);
      });
    const url = new URL(window.location.href);
    url.searchParams.delete("cancelled");
    history.replaceState({}, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : ""));
  }

  // Back from Stripe: confirm the payment, send the confirmation email, and show
  // the training address on screen.
  if (params.get("booked") === "1") {
    rememberHold("");
    els.status.classList.add("booking__status--ok");
    els.status.textContent = "✅ You're booked! Getting your details…";
    document.getElementById("book")?.scrollIntoView();

    const finish = (d = {}) => {
      const when = (d.sessions || []).map((s) => `${AP.prettyDate(s.date)} · ${s.time}`).join("<br />");
      const where = (d.places || [])
        .map((p) =>
          p.mapUrl
            ? `<a href="${p.mapUrl}" target="_blank" rel="noopener">${p.address}</a>`
            : `${p.name} — we'll send you the exact address shortly`
        )
        .join("<br />");
      els.status.innerHTML =
        "<strong>✅ You're booked!</strong>" +
        (when ? `<br />${when}` : "") +
        (where ? `<br />Training location: ${where}` : "") +
        (d.amountDue
          ? `<br />Bring <strong>${AP.dollars(d.amountDue)} in cash</strong> to your first lesson.`
          : "") +
        (d.sent
          ? `<br />A confirmation with directions is on its way to ${d.email || "your inbox"}.`
          : "<br />Questions? Call or text (405) 819-4401.");
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
})();
