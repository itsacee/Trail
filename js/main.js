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

  const EMPTY_TIER = { limit: 0, active: 0, pending: 0, spotsAvailable: 0, available: false };
  let membershipCapacity = {
    state: "loading",
    standard: { ...EMPTY_TIER, limit: 8, tier: "standard" },
    private: { ...EMPTY_TIER, limit: 4, tier: "private" },
    unverifiedActive: 0,
    limit: 12,
    spotsAvailable: 0,
    available: false,
  };
  const form = document.getElementById("bookingForm");

  function membershipsPaused() {
    return Boolean(SITE_STATUS.blockNewMemberships || SITE_STATUS.membershipPaused);
  }

  function tierKeyFromType(type) {
    return type === "membership_private" || type === "private" ? "private" : "standard";
  }

  function tierCapacity(tier) {
    const key = tier === "private" ? "private" : "standard";
    return membershipCapacity[key] || { ...EMPTY_TIER, limit: key === "private" ? 4 : 8, tier: key };
  }

  function membershipCapacityText(tier) {
    const label = tier === "private" ? "Private" : "Standard";
    if (membershipsPaused()) {
      return SITE_STATUS.blockNewMembershipsReason || SITE_STATUS.membershipPausedReason;
    }
    if (membershipCapacity.state === "loading") return `Checking ${label} availability…`;
    if (membershipCapacity.state !== "ready") {
      return `${label} membership availability is temporarily unavailable. Please try again soon.`;
    }
    const cap = tierCapacity(tier);
    if (!cap.available || cap.spotsAvailable <= 0) {
      return `${label} Membership: SOLD OUT — 0 of ${cap.limit} spots available. A spot opens when a current ${label.toLowerCase()} membership ends or uses all four lessons.`;
    }
    const filled = Math.max(0, Number(cap.active) || 0) + Math.max(0, Number(cap.pending) || 0);
    return `${label} Membership: ${filled} of ${cap.limit} filled · ${cap.spotsAvailable} spot${cap.spotsAvailable === 1 ? "" : "s"} left`;
  }

  function membershipBlocked(tier) {
    if (membershipsPaused()) return true;
    if (membershipCapacity.state !== "ready") return true;
    const cap = tierCapacity(tier);
    return !cap.available || cap.spotsAvailable <= 0;
  }

  function selectedMembershipTier() {
    const tab = document.querySelector('[data-book][aria-selected="true"]');
    const type = tab?.dataset?.book || "membership";
    return tierKeyFromType(type);
  }

  function renderMembershipCapacity() {
    document.querySelectorAll("[data-membership-availability]").forEach((el) => {
      const attr = el.getAttribute("data-membership-availability") || "standard";
      const tier =
        attr === "selected" ? selectedMembershipTier() : attr === "private" ? "private" : "standard";
      el.textContent = membershipCapacityText(tier);
      el.classList.toggle("is-full", membershipBlocked(tier));
    });
    document.querySelectorAll("[data-membership-purchase]").forEach((el) => {
      const tier = el.getAttribute("data-membership-purchase") === "private" ? "private" : "standard";
      const blocked = membershipBlocked(tier);
      el.classList.toggle("is-unavailable", blocked);
      el.setAttribute("aria-disabled", blocked ? "true" : "false");
    });
    // Sold-out only disables that category's purchase tab — the other stays open.
    document.querySelectorAll('[data-book="membership"], [data-book="membership_private"]').forEach((el) => {
      if (membershipsPaused()) return;
      const tier = el.dataset.book === "membership_private" ? "private" : "standard";
      const soldOut = membershipCapacity.state === "ready" && membershipBlocked(tier);
      const tag = el.querySelector(".booking__type-tag");
      if (tag && !membershipsPaused()) {
        tag.hidden = !soldOut;
        tag.textContent = soldOut ? "Sold out" : "Paused";
      }
      if (soldOut) {
        el.classList.add("is-disabled");
        el.setAttribute("aria-disabled", "true");
      } else if (!membershipsPaused()) {
        el.classList.remove("is-disabled");
        el.disabled = false;
        el.setAttribute("aria-disabled", "false");
      }
    });
    if (form && typeof refreshSubmit === "function") refreshSubmit();
  }

  async function loadMembershipCapacity() {
    renderMembershipCapacity();
    try {
      const response = await fetch("/api/membership-capacity", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.standard || !data.private) throw new Error("unavailable");
      membershipCapacity = { ...data, state: "ready" };
    } catch {
      membershipCapacity = {
        state: "error",
        standard: { ...EMPTY_TIER, limit: 8, tier: "standard" },
        private: { ...EMPTY_TIER, limit: 4, tier: "private" },
        unverifiedActive: 0,
        limit: 12,
        spotsAvailable: 0,
        available: false,
      };
    }
    renderMembershipCapacity();
  }

  document.querySelectorAll("[data-membership-purchase]").forEach((el) => {
    el.addEventListener("click", (event) => {
      const tier = el.getAttribute("data-membership-purchase") === "private" ? "private" : "standard";
      if (membershipBlocked(tier)) event.preventDefault();
    });
  });

  // Pricing pages can fill their capacity line right away. book.html waits for
  // the boot sequence below, because rendering capacity also refreshes the
  // submit button, which needs the booking state further down this file.
  if (!form && document.querySelector("[data-membership-availability]")) loadMembershipCapacity();

  if (!form || !AP) return;

  /* ---------- state ---------- */

  // `pair` = you can put a second athlete on a standard booking. Private
  // drop-ins are always one athlete and reserve the whole hour.
  // Customer-facing purchase types only. Historical "thirty" stays in schedule
  // parsers and Coach Desk, but is not offered for new public purchases.
  const SESSIONS = {
    single: { name: "Standard Drop-In", picks: 1, focus: "full", pair: true },
    private: { name: "Private One-on-One Drop-In", picks: 1, focus: "full", pair: false },
    membership: { name: "Standard Membership", picks: 1, focus: "full", pair: false },
    membership_private: { name: "Private One-on-One Membership", picks: 1, focus: "full", pair: false },
  };

  let AVAIL = AP.DEFAULT_AVAILABILITY;
  let bookableDates = [];
  let scheduleReady = false;
  let PRICING = {
    prices: { single: 8000, thirty: 6000, membership: 28000, membership_private: 36000, private: 10000 },
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
  const slotErrors = {};

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

  // Functions, not strings, because the private note quotes live prices.
  const TYPE_NOTE = {
    single: () =>
      "Standard Drop-In: one 60-minute lesson. Up to two athletes may share the hour when both choose the same training focus. Shows 1 Spot Left when one place remains.",
    private: () =>
      `Private One-on-One: one 60-minute lesson for exactly one athlete. The entire hour is reserved — no sibling option. ${AP.dollars(PRICING.prices.private)}.`,
    membership: () =>
      `Standard Membership: 4 lessons / 30 days (${AP.dollars(PRICING.prices.membership)}, about $70 each). Shareable hours with matching focus. One-time purchase — does not auto-renew. You pick lesson 1 today.`,
    membership_private: () =>
      `Private One-on-One Membership: 4 lessons / 30 days (${AP.dollars(PRICING.prices.membership_private)}, about $90 each). Each credit reserves the full hour for one athlete. One-time purchase — does not auto-renew. You pick lesson 1 today.`,
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

  function pairType() {
    return Boolean(SESSIONS[selectedType].pair);
  }

  function athleteCount() {
    return pairType() ? athletes : 1;
  }

  function isMemberType(type = selectedType) {
    return type === "membership" || type === "membership_private";
  }

  function currentPrivacy() {
    return AP.privacyForPurchaseType(selectedType);
  }

  function want() {
    // Private buys the whole hour; two standard athletes fill both seats;
    // one standard athlete leaves a seat open (any matching focus, including Both).
    const privacy = currentPrivacy();
    if (AP.isExclusiveBooking(selectedType, currentFocus(), privacy)) {
      return { seats: AP.SLOT_CAPACITY, exclusive: true, privacy };
    }
    return { seats: AP.seatsFor(selectedType, athleteCount()), exclusive: false, privacy };
  }

  function unitPrice() {
    return AP.unitPriceFor(selectedType, athleteCount(), PRICING.prices);
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

  function windowDates() {
    return bookableDates.length ? bookableDates : fallbackDates();
  }

  function openDay(iso) {
    // Don't paint Mon–Wed defaults as open before live hours arrive — that is
    // what made Tuesday/Thursday flip between open and closed on load.
    if (!scheduleReady) return false;
    if (!windowDates().includes(iso)) return false;
    if (!AP.startsForDate(iso, AVAIL, AP.durationFor(selectedType)).length) return false;
    // A failed slots fetch must not grey the day; the times panel shows the error.
    if (slotErrors[iso]) return true;
    const booked = bookedCache[iso];
    if (booked && !dayHasCapacity(iso, booked)) return false;
    return true;
  }

  // Calendar cells ignore focus so a day with a free seat at another focus
  // stays tappable; time chips still enforce exact focus matching.
  function dayHasCapacity(iso, booked) {
    const dur = AP.durationFor(selectedType);
    const need = want();
    return AP.startsForDate(iso, AVAIL, dur)
      .map((t) => AP.fmtTime(t))
      .some((label) => !AP.slotIsBlocked(booked || [], label, dur, "", need, { ignoreFocus: true }));
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
    scheduleReady = true;
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
    syncTypeTabs(); // the private note quotes prices
    syncAthleteField();
    syncPayOptions();
    refreshSubmit();
  }

  async function loadSlots(iso, { force = false } = {}) {
    if (!iso) return;
    // Retry after a failed prefetch — don't keep the day stuck on an error.
    if (!force && bookedCache[iso] && !slotErrors[iso]) return;
    try {
      const mine = myHold();
      const res = await fetch(`/api/slots?date=${iso}${mine ? `&mine=${encodeURIComponent(mine)}` : ""}`);
      if (!res.ok) throw new Error("slot lookup failed");
      bookedCache[iso] = (await res.json()).booked || [];
      delete slotErrors[iso];
    } catch {
      // Don't cache an empty "booked" list on failure — pickDate will retry.
      delete bookedCache[iso];
      slotErrors[iso] = true;
    }
  }

  // Prefetch open days so full days can grey out, but never stampede Stripe:
  // a full-month parallel burst was rate-limiting /api/slots and breaking later weeks.
  async function prefetchWindow() {
    const days = windowDates().filter((iso) => AP.startsForDate(iso, AVAIL, 60).length);
    const concurrency = 2;
    for (let i = 0; i < days.length; i += concurrency) {
      await Promise.all(days.slice(i, i + concurrency).map((iso) => loadSlots(iso)));
      calendar.render();
    }
  }

  // Mirrors lib/members.js bookingWindow when /api/availability is unavailable.
  function fallbackDates() {
    const out = [];
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    let end = new Date(y, m + 1, 0);
    const daysLeft = end.getDate() - now.getDate();
    if (daysLeft < 7) end = new Date(y, m + 2, 0);
    for (let d = new Date(y, m, now.getDate() + 1); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(AP.isoDate(new Date(d)));
    }
    return out;
  }

  /* ---------- rendering ---------- */

  function applySiteStatus() {
    if (els.notice) {
      // The frozen-clock message belongs to existing members, so it lives on
      // the member page instead of being shown to everyone buying a lesson.
      const parts = [];
      if (SITE_STATUS.fieldingOnly && SITE_STATUS.fieldingOnlyReason) parts.push(SITE_STATUS.fieldingOnlyReason);
      if (SITE_STATUS.blockNewMemberships && SITE_STATUS.blockNewMembershipsReason) {
        parts.push(SITE_STATUS.blockNewMembershipsReason);
      }
      els.notice.hidden = !parts.length;
      els.notice.innerHTML = parts.map((p) => `<p>${p}</p>`).join("");
    }

    document.querySelectorAll('[data-book="membership"], [data-book="membership_private"]').forEach((el) => {
      const paused = membershipsPaused();
      el.disabled = paused;
      el.classList.toggle("is-disabled", paused);
      el.setAttribute("aria-disabled", paused ? "true" : "false");
      const tag = el.querySelector(".booking__type-tag");
      if (tag) tag.hidden = !paused;
    });

    if (membershipsPaused()) {
      if (isMemberType(selectedType)) setType("single");
      membershipCapacity = {
        ...membershipCapacity,
        state: "ready",
        standard: { ...(membershipCapacity.standard || {}), available: false, spotsAvailable: 0 },
        private: { ...(membershipCapacity.private || {}), available: false, spotsAvailable: 0 },
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
    if (memPrice) {
      memPrice.textContent =
        selectedType === "membership_private"
          ? `${AP.dollars(PRICING.prices.membership_private)} for 30 days · 4 private lessons`
          : `${AP.dollars(PRICING.prices.membership)} for 30 days · 4 shareable lessons`;
    }
    const memPrivacy = document.getElementById("memberNotePrivacy");
    if (memPrivacy) {
      memPrivacy.textContent =
        selectedType === "membership_private"
          ? "Private hours are exclusive — exactly one athlete; the full hour is reserved."
          : "Standard hours can be shared (up to 2 athletes, same focus).";
    }
    const memHeading = document.getElementById("memberNoteHeading");
    if (memHeading) {
      memHeading.textContent =
        selectedType === "membership_private"
          ? "How Private Membership works"
          : "How Standard Membership works";
    }
    const memDeposit = document.getElementById("memberNoteDeposit");
    if (memDeposit) {
      if (selectedType === "membership_private") {
        memDeposit.innerHTML =
          `Pay <strong>in full by card</strong> or <strong>pay all cash</strong> at the field. ` +
          `Card deposit is not offered on Private Membership yet.`;
      } else {
        const due = Math.max(0, (PRICING.prices.membership || 0) - depositAmount());
        memDeposit.innerHTML =
          `Pay <strong>by card</strong>, put <strong>${AP.dollars(depositAmount())} down by card</strong> and bring ` +
          `<strong>${AP.dollars(due)} cash to your first lesson</strong>, or <strong>pay all cash</strong> at the field.`;
      }
    }
  }

  function syncTypeTabs() {
    document.querySelectorAll("[data-book]").forEach((el) => {
      const on = el.dataset.book === selectedType;
      el.classList.toggle("is-active", on);
      if (el.getAttribute("role") === "tab") el.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (els.typeNote) els.typeNote.textContent = TYPE_NOTE[selectedType]?.() || "";
    const title = document.getElementById("bookTitle");
    const lead = document.getElementById("bookLead");
    const slotTitle = document.getElementById("slotStepTitle");
    const isMem = isMemberType();
    if (els.memberNote) els.memberNote.hidden = !isMem;
    if (slotTitle) slotTitle.textContent = isMem ? "Pick your first lesson" : "Pick a day";
    if (title) {
      title.textContent = isMem
        ? selectedType === "membership_private"
          ? "Private Membership. Pick Your First Day."
          : "Standard Membership. Pick Your First Day."
        : selectedType === "private"
        ? "Book a Private One-on-One."
        : "Book a Standard Drop-In.";
    }
    if (lead) {
      lead.textContent = isMem
        ? selectedType === "membership_private"
          ? "Pay today and lock in private lesson 1 of 4. Each credit reserves the full hour. Book the other 3 from the Members page. One-time purchase — does not auto-renew."
          : "Pay today and lock in lesson 1 of 4. Shareable hours with matching focus. Book the other 3 from the Members page. One-time purchase — does not auto-renew."
        : selectedType === "private"
        ? "Exclusive coaching for one athlete. Choose your focus, pick a time, and checkout reserves the full hour."
        : "Up to two athletes can share the hour with the same focus. Choose a time and checkout.";
    }
    renderPrices();
  }

  // Show the Hitting/Fielding focus picker. All current public types use "full"
  // (Hitting, Fielding, or Both). Historical 30-minute lessons used "one".
  function updateFocusField() {
    if (!els.focusField) return;
    const mode = (SESSIONS[selectedType] || SESSIONS.single).focus;
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
    const canAdd = pairType();
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
      els.player2Hint.textContent = !show
        ? ""
        : `Two athletes fill the hour — nobody else can book it. ${AP.dollars(unitPrice())} each.`;
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
      "📍 Lessons train at the <strong>Mustang High School indoor facility</strong> in Mustang, OK. " +
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
    if (slotErrors[selectedDate] && !booked) {
      if (els.timesNote) {
        els.timesNote.textContent =
          "We couldn't confirm live availability. Tap the day again to retry, or call/text (405) 819-4401.";
      }
      return;
    }
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
      const left = AP.seatsLeft(booked, label, dur, focus, currentPrivacy());
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.disabled = blocked;
      chip.classList.toggle("is-off", blocked);
      const on = !blocked && selectedTime === label;
      chip.classList.toggle("is-selected", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
      // Different focus must look taken. "1 spot left" for shareable standard hours.
      const tag = blocked
        ? AP.slotBlockReason(booked, label, dur, focus, need) || "Booked"
        : left === 1 && need.seats === 1 && currentPrivacy() === "standard"
        ? "1 spot left"
        : "";
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
          : focus
          ? `No open ${focus === "Both" ? "Hitting & Fielding" : focus} times this day. Times with a different focus stay unavailable.`
          : "No open times this day."
        : selectedTime
        ? ""
        : currentPrivacy() === "private"
        ? "Private lessons take the whole hour — pick an open time."
        : "Same focus can share a time (2 athletes), including Hitting & Fielding. A different focus is unavailable — pick another time.";
    }
  }

  function syncPayOptions() {
    const isMem = isMemberType();
    // Deposit remains standard-membership only until a private deposit policy is approved.
    const depositOk = selectedType === "membership" && PRICING.allowDeposit;
    const total = totalPrice();
    const deposit = depositAmount();
    const due = Math.max(0, total - deposit);

    const depositBtn = document.getElementById("payDepositBtn");
    const cashBtn = document.getElementById("payCashBtn");
    if (depositBtn) depositBtn.hidden = !depositOk;
    if (cashBtn) cashBtn.hidden = !PRICING.allowCash;
    if (payMode === "deposit" && !depositOk) payMode = "card";
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
    if (isMemberType() && membershipsPaused()) {
      els.submit.textContent = "Memberships Paused";
      els.submit.disabled = true;
      return;
    }
    if (isMemberType() && membershipCapacity.state !== "ready") {
      els.submit.textContent =
        membershipCapacity.state === "loading" ? "Checking Membership Availability…" : "Membership Unavailable";
      els.submit.disabled = true;
      return;
    }
    if (isMemberType() && membershipBlocked(tierKeyFromType(selectedType))) {
      const tier = tierKeyFromType(selectedType);
      const cap = tierCapacity(tier);
      const label = tier === "private" ? "Private" : "Standard";
      els.submit.textContent = `${label} Membership Sold Out — 0 of ${cap.limit} Spots`;
      els.submit.disabled = true;
      return;
    }
    const total = totalPrice();
    const memLabel = selectedType === "membership_private" ? "Private Membership" : "Membership";
    els.submit.textContent =
      payMode === "cash"
        ? isMemberType()
          ? `Reserve ${memLabel} — Pay ${AP.dollars(total)} Cash`
          : `Reserve — Pay ${AP.dollars(total)} Cash at the Field`
        : payMode === "deposit"
        ? `Pay ${AP.dollars(depositAmount())} Deposit — Start Membership`
        : isMemberType()
        ? `Start ${memLabel} — ${AP.dollars(total)}`
        : `Pay ${AP.dollars(total)} — Book Lesson`;
    els.submit.disabled = false;
  }

  /* ---------- calendar ---------- */

  const calendar = AP.createCalendar(els.calendar, {
    isOpen: openDay,
    dates: () => windowDates(),
    onSelect: (iso) => pickDate(iso),
  });

  async function pickDate(iso) {
    selectedDate = iso;
    selectedTime = "";
    renderTimes();
    await loadSlots(iso, { force: Boolean(slotErrors[iso]) });
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
    if (isMemberType(type) && membershipsPaused()) return;
    if (isMemberType(type) && membershipBlocked(tierKeyFromType(type))) return;
    if (type === selectedType) return;
    selectedType = type;
    if (!pairType()) athletes = 1;
    syncTypeTabs();
    updateFocusField();
    syncAthleteField();
    resetSlot();
    renderMembershipCapacity();
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
    els.focusSelect.addEventListener("change", async () => {
      selectedTime = "";
      // Re-check live bookings for this focus so a Hitting slot greys out for Fielding.
      if (selectedDate) {
        delete bookedCache[selectedDate];
        delete slotErrors[selectedDate];
        renderTimes();
        calendar.render();
        refreshSubmit();
        await loadSlots(selectedDate, { force: true });
        if (selectedTime && AP.slotIsBlocked(bookedCache[selectedDate] || [], selectedTime, AP.durationFor(selectedType), currentFocus(), want())) {
          selectedTime = "";
        }
        renderTimes();
        calendar.render();
        refreshSubmit();
        return;
      }
      resetSlot();
    });
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
    let typeFromUrl = params.get("type");
    // Retired public type — send old links to Standard Drop-In.
    if (typeFromUrl === "thirty") {
      typeFromUrl = "single";
      const url = new URL(window.location.href);
      url.searchParams.set("type", "single");
      history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString());
      if (els.status) {
        els.status.textContent =
          "30-minute lessons aren't offered for new bookings. Showing Standard Drop-In instead.";
      }
    }
    if (SESSIONS[typeFromUrl] && !(isMemberType(typeFromUrl) && membershipsPaused())) {
      selectedType = typeFromUrl;
      if (!pairType()) athletes = 1;
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
    Object.keys(slotErrors).forEach((k) => delete slotErrors[k]);
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
            await loadMembershipCapacity();
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
        await loadMembershipCapacity();
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
