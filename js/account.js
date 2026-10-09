/* Member portal: sign in, see remaining lessons, book / move / cancel them.
 *
 * Wrapped in a function so nothing here collides with js/main.js, which the
 * page also loads. The slot math and the calendar come from js/booking-core.js.
 */
(function () {
  const AP = window.AP;
  const loginCard = document.getElementById("loginCard");
  const dashCard = document.getElementById("dashCard");
  if (!loginCard || !dashCard || !AP) return;

  const TOKEN_KEY = "ap_member_token";

  const loginForm = document.getElementById("loginForm");
  const loginStatus = document.getElementById("loginStatus");
  const loginSubmit = document.getElementById("loginSubmit");
  const weekForm = document.getElementById("weekForm");
  const weekStatus = document.getElementById("weekStatus");
  const focusSelect = document.getElementById("memFocus");
  const timesBox = document.getElementById("memTimes");
  const timesTitle = document.getElementById("memTimesTitle");
  const chips = document.getElementById("memTimeChips");
  const timesNote = document.getElementById("memTimesNote");

  let AVAIL = AP.DEFAULT_AVAILABILITY;
  let bookableDates = []; // from /api/availability → bookingWindow.dates
  let scheduleReady = false;
  let account = null;
  let rescheduleId = null;
  let selectedDate = "";
  let selectedTime = "";
  const bookedCache = {};
  const slotErrors = {};

  const LESSON_MINUTES = 60;

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

  /* ---------- day & time picking ---------- */

  function addDaysIso(iso, n) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return AP.isoDate(d);
  }

  // Members can book any day from tomorrow through membership expiry — not just
  // the shorter public drop-in month window on /api/availability.
  function bookableWindow() {
    const lastDay = (account && account.lastDay) || "";
    if (!lastDay) return bookableDates.length ? bookableDates : fallbackDates();
    const out = [];
    const now = new Date();
    let cur = AP.isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    for (; cur <= lastDay; cur = addDaysIso(cur, 1)) out.push(cur);
    return out;
  }

  // Fallback when availability hasn't loaded and we don't know lastDay yet.
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

  function openTimes(iso, booked) {
    const focus = focusSelect ? focusSelect.value : "";
    return AP.startsForDate(iso, AVAIL, LESSON_MINUTES)
      .map((t) => AP.fmtTime(t))
      .filter((label) => !AP.slotIsBlocked(booked || [], label, LESSON_MINUTES, focus, 1));
  }

  function dayHasCapacity(iso, booked) {
    return AP.startsForDate(iso, AVAIL, LESSON_MINUTES)
      .map((t) => AP.fmtTime(t))
      .some((label) => !AP.slotIsBlocked(booked || [], label, LESSON_MINUTES, "", 1, { ignoreFocus: true }));
  }

  function dayIsOpen(iso) {
    if (!scheduleReady) return false;
    if (!bookableWindow().includes(iso)) return false;
    if (!AP.startsForDate(iso, AVAIL, LESSON_MINUTES).length) return false;
    // A failed slots fetch must not grey the day; the times panel shows the error.
    if (slotErrors[iso]) return true;
    const booked = bookedCache[iso];
    if (booked && !dayHasCapacity(iso, booked)) return false;
    return true;
  }

  const calendar = AP.createCalendar(document.getElementById("memCalendar"), {
    isOpen: dayIsOpen,
    dates: () => bookableWindow(),
    onSelect: (iso) => pickDate(iso),
  });

  async function loadSlots(iso, { force = false } = {}) {
    if (!iso) return;
    if (!force && bookedCache[iso] && !slotErrors[iso]) return;
    try {
      const res = await fetch(`/api/slots?date=${iso}`);
      if (!res.ok) throw new Error("slot lookup failed");
      bookedCache[iso] = (await res.json()).booked || [];
      delete slotErrors[iso];
    } catch {
      delete bookedCache[iso];
      slotErrors[iso] = true;
    }
  }

  async function pickDate(iso) {
    selectedDate = iso;
    selectedTime = "";
    renderTimes();
    await loadSlots(iso, { force: Boolean(slotErrors[iso]) });
    if (selectedDate !== iso) return;
    renderTimes();
    calendar.render();
  }

  function renderTimes() {
    if (!chips || !timesBox) return;
    chips.innerHTML = "";
    if (!selectedDate) {
      timesBox.hidden = true;
      return;
    }
    timesBox.hidden = false;
    if (timesTitle) timesTitle.textContent = `Open times · ${AP.prettyDate(selectedDate)}`;
    const booked = bookedCache[selectedDate];
    if (slotErrors[selectedDate] && !booked) {
      if (timesNote) {
        timesNote.textContent =
          "We couldn't confirm live availability. Tap the day again to retry, or call/text (405) 819-4401.";
      }
      return;
    }
    if (!booked) {
      if (timesNote) timesNote.textContent = "Checking open times…";
      return;
    }
    const focus = focusSelect ? focusSelect.value : "";
    let open = 0;
    AP.startsForDate(selectedDate, AVAIL, LESSON_MINUTES).forEach((t) => {
      const label = AP.fmtTime(t);
      const blocked = AP.slotIsBlocked(booked, label, LESSON_MINUTES, focus, 1);
      const left = AP.seatsLeft(booked, label, LESSON_MINUTES, focus);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.disabled = blocked;
      chip.classList.toggle("is-off", blocked);
      const on = !blocked && selectedTime === label;
      chip.classList.toggle("is-selected", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
      const tag = blocked ? "Booked" : left === 1 ? "1 spot left" : "";
      chip.innerHTML = `<span class="chip__time">${label}</span>${tag ? `<span class="chip__tag">${tag}</span>` : ""}`;
      if (!blocked) {
        open++;
        chip.addEventListener("click", () => {
          selectedTime = label;
          weekStatus.textContent = "";
          renderTimes();
        });
      }
      chips.appendChild(chip);
    });
    if (timesNote) {
      timesNote.textContent = !open
        ? "No open times this day."
        : selectedTime
        ? ""
        : "Tap a time to pick it.";
    }
  }

  function resetPicker() {
    selectedTime = "";
    if (selectedDate && !dayIsOpen(selectedDate)) {
      selectedDate = "";
      calendar.clear();
    }
    renderTimes();
    calendar.render();
  }

  /* ---------- dashboard ---------- */

  function renderDash(data) {
    account = data;
    const status = data.siteStatus || {};
    const notice = document.getElementById("acctNotice");
    if (notice) {
      const parts = [];
      if (data.bookingPaused && data.bookingPausedReason) parts.push(data.bookingPausedReason);
      if (status.fieldingOnly && status.fieldingOnlyReason) parts.push(status.fieldingOnlyReason);
      if (status.membershipFrozen && status.membershipFrozenReason) parts.push(status.membershipFrozenReason);
      else if (status.blockNewMemberships && status.blockNewMembershipsReason) {
        parts.push(status.blockNewMembershipsReason);
      }
      notice.hidden = !parts.length;
      notice.innerHTML = parts.map((p) => `<p>${p}</p>`).join("");
    }

    const left = data.remaining || 0;
    const expires = data.lastDayPretty || (data.lastDay ? AP.prettyDate(data.lastDay) : "");
    document.getElementById("acctPlayer").textContent = data.player
      ? `${data.player}'s membership`
      : "Your membership";
    const whoName = document.getElementById("acctWhoName");
    if (whoName) whoName.textContent = data.email || data.player || "this member";
    document.getElementById("acctCredits").textContent =
      `${left} of ${data.credits || 4} lessons left${
        expires ? (status.membershipFrozen ? ` · paused clock · use by ${expires}` : ` · use by ${expires}`) : ""
      }`;
    document.getElementById("acctTitle").textContent = data.bookingPaused
      ? "Membership paused"
      : left && !data.expired
      ? "Book Your Next Lesson"
      : "This membership is used up";
    document.getElementById("acctLead").textContent = data.bookingPaused
      ? data.bookingPausedReason || "This membership is paused. Call or text (405) 819-4401."
      : left && !data.expired
      ? status.membershipFrozen
        ? `You have ${left} lesson${left === 1 ? "" : "s"} left. Your expiry date is temporarily paused, but each lesson you book uses one credit.`
        : `You have ${left} lesson${left === 1 ? "" : "s"} left. Pick any day that works${
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
          (days !== null && !status.membershipFrozen ? ` (${days} day${days === 1 ? "" : "s"} from today)` : "") +
          (status.membershipFrozen
            ? "<br />Your expiry clock is temporarily paused — booking a lesson still uses one credit."
            : "") +
          "<br />Unused lessons don't roll over, and your membership does not auto-renew.";
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

    if (data.cashDue) {
      const msgEl = document.getElementById("acctExpiry");
      if (msgEl && !msgEl.hidden) {
        msgEl.innerHTML += `<br />💵 <strong>${AP.dollars(data.cashDue)} in cash is due at your first lesson.</strong>`;
      }
    }

    renderLessons(data, status);

    exitReschedule();
    const canBook = left > 0 && !data.expired && !data.bookingPaused;
    weekForm.hidden = !canBook;
    const msg = document.getElementById("acctMsg");
    if (data.bookingPaused) {
      msg.hidden = false;
      msg.textContent = data.bookingPausedReason || "This membership is paused. Call or text (405) 819-4401.";
    } else if (data.expired) {
      msg.hidden = false;
      msg.innerHTML = `This membership ended${
        expires ? ` on ${expires}` : ""
      }. <a href="book.html?type=membership">Buy another month</a> when you're ready.`;
    } else if (!left) {
      msg.hidden = false;
      msg.innerHTML =
        'This membership is used up. <a href="book.html?type=membership">Buy another month</a> when you\'re ready for 4 more.';
    } else {
      msg.hidden = true;
    }

    if (canBook) {
      if (focusSelect && status.fieldingOnly) {
        focusSelect.querySelectorAll('option[value="Hitting"], option[value="Both"]').forEach((o) => {
          o.hidden = true;
        });
        focusSelect.value = "Fielding";
      }
      resetPicker();
    }
    showDash();
  }

  function renderLessons(data, status) {
    const list = document.getElementById("acctLessons");
    const upcoming = data.lessons || [];
    if (!upcoming.length) {
      list.innerHTML = '<p class="acct__empty">No lessons on the calendar yet.</p>';
      return;
    }
    list.innerHTML =
      '<p class="booking__picked-title">Upcoming</p>' +
      upcoming
        .map((l) => {
          // Inside the 12-hour window the buttons would only fail, so say so here.
          const locked = l.canChange === false;
          return `<div class="acct__row">
        <div><strong>${AP.prettyDate(l.date)}</strong> · ${l.time}${l.focus ? ` · ${l.focus}` : ""}</div>
        <span class="acct__actions">${
          locked
            ? '<span class="acct__locked">Less than 12 hours out — <a href="tel:+14058194401">call or text</a></span>'
            : `<button type="button" class="acct__btn" data-reschedule="${l.id}">Move</button>
          <button type="button" class="acct__btn acct__btn--quiet" data-cancel="${l.id}">Cancel</button>`
        }</span>
      </div>`;
        })
        .join("") +
      '<p class="acct__hint">Need a different day? Tap Move and pick a new time, at least 12 hours before the lesson. That credit stays on your membership either way.</p>';
    list.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => cancelLesson(btn.dataset.cancel));
    });
    list.querySelectorAll("[data-reschedule]").forEach((btn) => {
      btn.addEventListener("click", () => startReschedule(btn.dataset.reschedule));
    });
  }

  async function loadAccount() {
    const { res, data } = await api("/api/member");
    if (!res.ok) {
      showLogin(data.error || "");
      return;
    }
    renderDash(data);
  }

  /* ---------- move / cancel ---------- */

  function exitReschedule() {
    rescheduleId = null;
    const title = document.getElementById("weekFormTitle");
    if (title) title.innerHTML = '<span class="booking__step-num">+</span> Book another lesson';
    const submit = document.getElementById("weekSubmit");
    if (submit) submit.textContent = "Lock in this lesson";
    const keep = document.getElementById("keepTime");
    if (keep) keep.hidden = true;
    weekStatus.textContent = "";
    weekStatus.classList.remove("booking__status--ok");
  }

  function startReschedule(id) {
    const lesson = (account?.lessons || []).find((l) => l.id === id);
    if (!lesson) return;
    rescheduleId = id;

    if (focusSelect && lesson.focus) focusSelect.value = lesson.focus;

    const title = document.getElementById("weekFormTitle");
    if (title) {
      title.innerHTML = `<span class="booking__step-num">↻</span> Move ${AP.prettyDate(lesson.date)} · ${lesson.time}`;
    }
    const submit = document.getElementById("weekSubmit");
    if (submit) submit.textContent = "Move this lesson";

    // A one-click way back out of reschedule mode, created the first time it's needed.
    let keep = document.getElementById("keepTime");
    if (!keep) {
      keep = document.createElement("button");
      keep.type = "button";
      keep.id = "keepTime";
      keep.className = "booking__change";
      keep.style.marginTop = "0.6rem";
      keep.textContent = "Keep my current time";
      keep.addEventListener("click", () => renderDash(account));
      weekForm.appendChild(keep);
    }
    keep.hidden = false;

    weekStatus.classList.remove("booking__status--ok");
    weekStatus.textContent = "Pick a new day and time — your old slot is freed up when the change goes through.";

    weekForm.hidden = false;
    // Start on the day they already have, so a time-only change is two taps and
    // the open times are on screen immediately.
    if (bookableWindow().includes(lesson.date)) {
      calendar.set(lesson.date);
      pickDate(lesson.date);
    } else {
      resetPicker();
    }
    weekForm.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function cancelLesson(id) {
    const lesson = (account?.lessons || []).find((l) => l.id === id);
    const label = lesson ? `${AP.prettyDate(lesson.date)} at ${lesson.time}` : "this lesson";
    if (!window.confirm(`Cancel ${label}?\n\nYou'll get that credit back and can book another day.`)) return;
    weekStatus.textContent = "";
    const { res, data } = await api("/api/member", {
      method: "POST",
      body: JSON.stringify({ action: "cancel", id }),
    });
    if (!res.ok) {
      weekStatus.textContent = data.error || "Couldn't cancel that lesson.";
      return;
    }
    Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
    Object.keys(slotErrors).forEach((k) => delete slotErrors[k]);
    renderDash(data);
  }

  /* ---------- wiring ---------- */

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
      // Only show it green when a link actually went out.
      loginStatus.classList.toggle("booking__status--ok", data.sent !== false);
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
    if (!selectedDate || !selectedTime) {
      weekStatus.textContent = "Pick a day and a time.";
      return;
    }
    const moving = Boolean(rescheduleId);
    const btn = document.getElementById("weekSubmit");
    const restoreLabel = moving ? "Move this lesson" : "Lock in this lesson";
    btn.disabled = true;
    btn.textContent = moving ? "Moving…" : "Booking…";
    const date = selectedDate;
    const { res, data } = await api("/api/member", {
      method: "POST",
      body: JSON.stringify({
        action: moving ? "reschedule" : "book",
        id: rescheduleId || undefined,
        date,
        time: selectedTime,
        focus: focusSelect ? focusSelect.value : "",
      }),
    });
    btn.disabled = false;
    if (!res.ok) {
      weekStatus.textContent = data.error || (moving ? "Couldn't move that lesson." : "Couldn't book that time.");
      btn.textContent = restoreLabel;
      delete bookedCache[date];
      delete slotErrors[date];
      pickDate(date);
      return;
    }
    Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
    Object.keys(slotErrors).forEach((k) => delete slotErrors[k]);
    renderDash(data);
  });

  if (focusSelect) focusSelect.addEventListener("change", () => resetPicker());

  function signOut() {
    clearToken();
    account = null;
    loginStatus.classList.remove("booking__status--ok");
    loginStatus.textContent = "";
    const emailField = document.getElementById("loginEmail");
    if (emailField) emailField.value = "";
    showLogin();
  }

  document.getElementById("signOut").addEventListener("click", signOut);
  // Same thing, worded for someone who didn't expect to be signed in at all.
  document.getElementById("switchUser")?.addEventListener("click", signOut);

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
        if (Array.isArray(d?.bookingWindow?.dates)) bookableDates = d.bookingWindow.dates;
      }
    } catch {
      /* defaults */
    }
    scheduleReady = true;

    if (token()) loadAccount();
    else showLogin();
  })();
})();
