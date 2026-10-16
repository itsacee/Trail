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
  let selectedMembershipId = "";
  let selectedDate = "";
  let selectedTime = "";
  const bookedCache = {};
  const slotErrors = {};

  const LESSON_MINUTES = 60;
  const memPurchaseField = document.getElementById("memPurchaseField");
  const memPurchase = document.getElementById("memPurchase");
  const membershipsBox = document.getElementById("acctMemberships");

  function membershipList(data) {
    const rows = Array.isArray(data?.memberships) ? data.memberships : [];
    if (rows.length) return rows;
    // Backward-compatible single-membership payload.
    if (data?.membershipId || data?.membershipType || data?.credits) {
      return [
        {
          id: data.membershipId || "",
          membershipId: data.membershipId || "",
          membershipType: data.membershipType,
          membershipTier: data.membershipTier,
          membershipLabel: data.membershipLabel,
          privacy: data.privacy,
          exclusive: data.exclusive,
          credits: data.credits,
          used: data.used,
          remaining: data.remaining,
          lastDay: data.lastDay,
          lastDayPretty: data.lastDayPretty,
          daysLeft: data.daysLeft,
          periodOpen: data.periodOpen !== false,
          expired: data.expired,
          bookingPaused: data.bookingPaused,
          cashDue: data.cashDue || 0,
          player: data.player || "",
          lessons: data.lessons || [],
        },
      ];
    }
    return [];
  }

  function openMemberships(data) {
    return membershipList(data).filter((m) => m.periodOpen !== false);
  }

  function bookableMemberships(data) {
    return openMemberships(data).filter((m) => (m.remaining || 0) > 0 && !m.expired && !m.bookingPaused);
  }

  function selectedMembership(data = account) {
    const rows = openMemberships(data);
    if (!rows.length) return null;
    const id = selectedMembershipId || data?.membershipId || "";
    return rows.find((m) => (m.membershipId || m.id) === id) || rows[0];
  }

  function ensureSelectedMembership(data) {
    const bookable = bookableMemberships(data);
    const open = openMemberships(data);
    const preferred = selectedMembershipId;
    if (preferred && open.some((m) => (m.membershipId || m.id) === preferred)) return;
    if (bookable.length) {
      selectedMembershipId = bookable[0].membershipId || bookable[0].id || "";
      return;
    }
    selectedMembershipId = open[0] ? open[0].membershipId || open[0].id || "" : data?.membershipId || "";
  }

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

  const otpEmailStep = document.getElementById("otpEmailStep");
  const otpCodeStep = document.getElementById("otpCodeStep");
  const otpForm = document.getElementById("otpForm");
  const otpStatus = document.getElementById("otpStatus");
  const otpInputs = [...(document.querySelectorAll("#otpInputs input") || [])];
  let pendingEmail = "";

  function setTab(name) {
    document.querySelectorAll(".tabbar button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.tab === name);
    });
    document.querySelectorAll("#dashCard .member-panel").forEach((p) => {
      p.classList.toggle("is-active", p.dataset.panel === name);
    });
  }

  function showLogin(msg) {
    dashCard.hidden = true;
    loginCard.hidden = false;
    loginCard.classList.add("is-active");
    if (otpEmailStep) otpEmailStep.hidden = false;
    if (otpCodeStep) otpCodeStep.hidden = true;
    if (msg && loginStatus) loginStatus.textContent = msg;
  }

  function showDash() {
    loginCard.hidden = true;
    loginCard.classList.remove("is-active");
    dashCard.hidden = false;
    setTab("home");
  }

  function otpCodeValue() {
    return otpInputs.map((i) => i.value.replace(/\D/g, "")).join("");
  }

  function wireOtpInputs() {
    otpInputs.forEach((input, idx) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 1);
        if (input.value && otpInputs[idx + 1]) otpInputs[idx + 1].focus();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !input.value && otpInputs[idx - 1]) {
          otpInputs[idx - 1].focus();
        }
      });
      input.addEventListener("paste", (e) => {
        const text = (e.clipboardData || window.clipboardData).getData("text") || "";
        const digits = text.replace(/\D/g, "").slice(0, 6);
        if (digits.length < 2) return;
        e.preventDefault();
        digits.split("").forEach((d, i) => {
          if (otpInputs[i]) otpInputs[i].value = d;
        });
        (otpInputs[Math.min(digits.length, 5)] || otpInputs[5]).focus();
      });
    });
  }
  if (otpInputs.length) wireOtpInputs();

  /* ---------- day & time picking ---------- */

  function addDaysIso(iso, n) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return AP.isoDate(d);
  }

  // Members can book any day from tomorrow through the selected membership's
  // expiry — not just the shorter public drop-in month window.
  function bookableWindow() {
    const mem = selectedMembership();
    const lastDay = (mem && mem.lastDay) || (account && account.lastDay) || "";
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

  function memberPrivacy() {
    const mem = selectedMembership();
    if (mem?.privacy) return mem.privacy;
    if (mem?.membershipType) return AP.privacyForPurchaseType(mem.membershipType);
    return account?.privacy || AP.privacyForPurchaseType(account?.membershipType || "membership");
  }

  function memberWant() {
    const privacy = memberPrivacy();
    const exclusive = privacy === "private";
    return {
      seats: exclusive ? AP.SLOT_CAPACITY : 1,
      exclusive,
      privacy,
    };
  }

  function openTimes(iso, booked) {
    const focus = focusSelect ? focusSelect.value : "";
    return AP.startsForDate(iso, AVAIL, LESSON_MINUTES)
      .map((t) => AP.fmtTime(t))
      .filter((label) => !AP.slotIsBlocked(booked || [], label, LESSON_MINUTES, focus, memberWant()));
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
    const privacy = memberPrivacy();
    const need = memberWant();
    let open = 0;
    AP.startsForDate(selectedDate, AVAIL, LESSON_MINUTES).forEach((t) => {
      const label = AP.fmtTime(t);
      const blocked = AP.slotIsBlocked(booked, label, LESSON_MINUTES, focus, need);
      const left = AP.seatsLeft(booked, label, LESSON_MINUTES, focus, privacy);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.disabled = blocked;
      chip.classList.toggle("is-off", blocked);
      const on = !blocked && selectedTime === label;
      chip.classList.toggle("is-selected", on);
      chip.setAttribute("aria-checked", on ? "true" : "false");
      const tag = blocked
        ? AP.slotBlockReason(booked, label, LESSON_MINUTES, focus, need) || "Booked"
        : left === 1
        ? "1 spot left"
        : "";
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
        ? focus
          ? `No open ${focus === "Both" ? "Hitting & Fielding" : focus} times this day. Times with a different focus stay unavailable.`
          : "No open times this day."
        : selectedTime
        ? ""
        : "Same focus can share a time (2 athletes), including Hitting & Fielding. A different focus is unavailable — pick another time.";
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

  function renderMembershipPicker(data) {
    const open = openMemberships(data);
    const multi = open.length > 1;
    if (membershipsBox) {
      if (!multi) {
        membershipsBox.hidden = true;
        membershipsBox.innerHTML = "";
      } else {
        membershipsBox.hidden = false;
        membershipsBox.innerHTML =
          '<p class="acct__memberships-title">Your memberships</p>' +
          open
            .map((m) => {
              const id = m.membershipId || m.id || "";
              const left = m.remaining || 0;
              const expires = m.lastDayPretty || (m.lastDay ? AP.prettyDate(m.lastDay) : "");
              const label = m.membershipLabel || (m.membershipTier === "private" ? "Private Membership" : "Standard Membership");
              const checked = id === selectedMembershipId ? " checked" : "";
              const selected = id === selectedMembershipId ? " is-selected" : "";
              const priv = m.membershipTier === "private" ? " · private hours" : "";
              return `<label class="acct__membership${selected}">
                <input type="radio" name="acctMembership" value="${id}"${checked} />
                <strong>${label}</strong>
                <span class="acct__membership-meta">${left} of ${m.credits || 4} lessons left${priv}${
                  expires ? ` · use by ${expires}` : ""
                }</span>
              </label>`;
            })
            .join("");
        membershipsBox.querySelectorAll('input[name="acctMembership"]').forEach((input) => {
          input.addEventListener("change", () => {
            selectedMembershipId = input.value;
            renderDash(account);
          });
        });
      }
    }

    if (memPurchaseField && memPurchase) {
      const bookable = bookableMemberships(data);
      if (bookable.length > 1 && !rescheduleId) {
        memPurchaseField.hidden = false;
        memPurchase.innerHTML = bookable
          .map((m) => {
            const id = m.membershipId || m.id || "";
            const label = m.membershipLabel || (m.membershipTier === "private" ? "Private Membership" : "Standard Membership");
            const expires = m.lastDayPretty || "";
            return `<option value="${id}">${label} · ${m.remaining || 0} left${
              expires ? ` · by ${expires}` : ""
            }</option>`;
          })
          .join("");
        memPurchase.value = selectedMembershipId;
        if (![...memPurchase.options].some((o) => o.value === selectedMembershipId) && bookable[0]) {
          selectedMembershipId = bookable[0].membershipId || bookable[0].id || "";
          memPurchase.value = selectedMembershipId;
        }
      } else {
        memPurchaseField.hidden = true;
        memPurchase.innerHTML = "";
      }
    }
  }

  function renderDash(data) {
    account = data;
    ensureSelectedMembership(data);
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

    renderMembershipPicker(data);
    const mem = selectedMembership(data) || data;
    const multi = openMemberships(data).length > 1;
    const left = mem.remaining || 0;
    const expires = mem.lastDayPretty || (mem.lastDay ? AP.prettyDate(mem.lastDay) : "");
    const tierLabel =
      mem.membershipLabel ||
      (mem.membershipTier === "private" ? "Private Membership" : "Standard Membership");
    const player = data.player || mem.player || "";
    document.getElementById("acctPlayer").textContent = multi
      ? player
        ? `${player}'s memberships`
        : "Your memberships"
      : player
      ? `${player}'s ${tierLabel}`
      : tierLabel;
    const whoName = document.getElementById("acctWhoName");
    if (whoName) whoName.textContent = data.email || player || "this member";
    const creditsEl = document.getElementById("acctCredits");
    if (creditsEl) {
      creditsEl.textContent = multi
        ? `${openMemberships(data).length} active · booking with ${tierLabel}`
        : `${left} of ${mem.credits || 4} lessons left${
            mem.membershipTier === "private" ? " · private hours" : ""
          }${
            expires ? (status.membershipFrozen ? ` · paused clock · use by ${expires}` : ` · use by ${expires}`) : ""
          }`;
    }
    const bookable = bookableMemberships(data);
    const canBook = bookable.length > 0;
    const titleEl = document.getElementById("acctTitle");
    const leadEl = document.getElementById("acctLead");
    if (titleEl) {
      titleEl.textContent =
        data.bookingPaused && !canBook
          ? "Membership paused"
          : canBook
            ? "Book Your Next Lesson"
            : "This membership is used up";
    }
    if (leadEl) {
      leadEl.textContent =
        !canBook && data.bookingPaused
          ? data.bookingPausedReason || "This membership is paused. Call or text (405) 819-4401."
          : canBook
            ? multi
              ? `Choose which membership to use below.`
              : `You have ${left} lesson${left === 1 ? "" : "s"} left${expires ? ` · use by ${expires}` : ""}.`
            : `You've used all available lessons. Buy another membership when you're ready for 4 more.`;
    }
    const homeRem = document.getElementById("homeRemaining");
    const homeUsed = document.getElementById("homeUsed");
    const used = Number(mem.used) || Math.max(0, (mem.credits || 4) - left);
    if (homeRem) homeRem.textContent = String(left);
    if (homeUsed) homeUsed.textContent = String(used);
    const bar = document.getElementById("creditBarFill");
    if (bar) bar.style.width = `${Math.min(100, (used / (mem.credits || 4)) * 100)}%`;
    const planLabel = document.getElementById("planLabel");
    if (planLabel) planLabel.textContent = tierLabel;
    const planProgress = document.getElementById("planProgress");
    if (planProgress) planProgress.textContent = `${used} of ${mem.credits || 4} used · ${left} remaining`;
    const planWindow = document.getElementById("planWindow");
    if (planWindow) {
      planWindow.textContent = expires
        ? `Use by ${expires}${mem.periodStartDate ? ` · started ${AP.prettyDate(mem.periodStartDate)}` : ""}`
        : "";
    }
    const nextBox = document.getElementById("homeNextLesson");
    if (nextBox) {
      const next = (data.lessons || [])[0];
      nextBox.innerHTML = next
        ? `<div class="lesson-row__when">${AP.prettyDate(next.date)} · ${next.time}</div>
           <div class="lesson-row__meta">${next.focus || "Training"}${next.membershipLabel ? ` · ${next.membershipLabel}` : ""}</div>`
        : "No upcoming lesson yet.";
    }

    const expiry = document.getElementById("acctExpiry");
    if (expiry) {
      if (expires && left && !multi) {
        expiry.hidden = false;
        const days = typeof mem.daysLeft === "number" ? mem.daysLeft : null;
        expiry.innerHTML =
          `⏳ <strong>${left} lesson${left === 1 ? "" : "s"} left</strong> · must be used by <strong>${expires}</strong>` +
          (days !== null && !status.membershipFrozen ? ` (${days} day${days === 1 ? "" : "s"} from today)` : "") +
          (status.membershipFrozen
            ? "<br />Your expiry clock is temporarily paused — booking a lesson still uses one credit."
            : "") +
          "<br />Unused lessons don't roll over, and your membership does not auto-renew.";
      } else if (multi && canBook) {
        expiry.hidden = false;
        expiry.innerHTML =
          "Each membership keeps its own credits and expiration. Unused lessons don't roll over between purchases.";
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

    if (mem.cashDue && !multi) {
      const msgEl = document.getElementById("acctExpiry");
      if (msgEl && !msgEl.hidden) {
        msgEl.innerHTML += `<br />💵 <strong>${AP.dollars(mem.cashDue)} in cash is due at your first lesson.</strong>`;
      }
    }

    renderLessons(data, status);

    exitReschedule();
    weekForm.hidden = !canBook;
    const msg = document.getElementById("acctMsg");
    if (!canBook && data.bookingPaused) {
      msg.hidden = false;
      msg.textContent = data.bookingPausedReason || "This membership is paused. Call or text (405) 819-4401.";
    } else if (!canBook && openMemberships(data).every((m) => m.expired || !(m.remaining > 0))) {
      msg.hidden = false;
      msg.innerHTML = `No open lesson credits right now. <a href="book.html?type=membership">Buy another month</a> when you're ready.`;
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
    const multi = openMemberships(data).length > 1;
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
          const memTag =
            multi && l.membershipLabel
              ? ` · ${l.membershipLabel.replace(" Membership", "")}`
              : "";
          return `<div class="acct__row">
        <div><strong>${AP.prettyDate(l.date)}</strong> · ${l.time}${l.focus ? ` · ${l.focus}` : ""}${memTag}</div>
        <span class="acct__actions">${
          locked
            ? '<span class="acct__locked">Less than 12 hours out — <a href="tel:+14058194401">call or text</a></span>'
            : `<button type="button" class="acct__btn" data-reschedule="${l.id}">Move</button>
          <button type="button" class="acct__btn acct__btn--quiet" data-cancel="${l.id}">Cancel</button>`
        }</span>
      </div>`;
        })
        .join("") +
      '<p class="acct__hint">Need a different day? Tap Move and pick a new time, at least 12 hours before the lesson. That credit stays on the same membership either way.</p>';
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
    if (lesson.membershipId) selectedMembershipId = lesson.membershipId;

    if (focusSelect && lesson.focus) focusSelect.value = lesson.focus;
    if (memPurchaseField) memPurchaseField.hidden = true;

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

  async function requestOtp(email) {
    const { data } = await api("/api/member-login", {
      method: "POST",
      body: JSON.stringify({ email, action: "otp" }),
    });
    return data;
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginStatus.textContent = "";
    loginSubmit.disabled = true;
    loginSubmit.textContent = "Sending…";
    try {
      const email = loginForm.elements.email.value.trim();
      pendingEmail = email;
      const data = await requestOtp(email);
      loginStatus.classList.toggle("booking__status--ok", data.sent !== false);
      loginStatus.textContent = data.message || "If that email has a membership, we sent a code.";
      if (data.sent !== false && otpCodeStep && otpEmailStep) {
        otpEmailStep.hidden = true;
        otpCodeStep.hidden = false;
        const hint = document.getElementById("otpHint");
        if (hint) hint.textContent = `Enter the 6-digit code we sent to ${email}.`;
        otpInputs.forEach((i) => (i.value = ""));
        otpInputs[0]?.focus();
      }
    } catch {
      loginStatus.classList.remove("booking__status--ok");
      loginStatus.textContent = "Couldn't send that. Call or text (405) 819-4401.";
    }
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Send sign-in code";
  });

  document.getElementById("useMagicLink")?.addEventListener("click", async () => {
    loginStatus.textContent = "";
    const email = loginForm.elements.email.value.trim();
    if (!email) {
      loginStatus.textContent = "Enter your email first.";
      return;
    }
    loginSubmit.disabled = true;
    try {
      const { data } = await api("/api/member-login", {
        method: "POST",
        body: JSON.stringify({ email, action: "magic" }),
      });
      loginStatus.classList.toggle("booking__status--ok", data.sent !== false);
      loginStatus.textContent = data.message || "Check your email for a sign-in link.";
    } catch {
      loginStatus.textContent = "Couldn't send that. Call or text (405) 819-4401.";
    }
    loginSubmit.disabled = false;
  });

  otpForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!otpStatus) return;
    otpStatus.textContent = "";
    const code = otpCodeValue();
    if (code.length !== 6) {
      otpStatus.textContent = "Enter all 6 digits.";
      return;
    }
    const btn = document.getElementById("otpSubmit");
    if (btn) btn.disabled = true;
    try {
      const { res, data } = await api("/api/member-login", {
        method: "POST",
        body: JSON.stringify({ email: pendingEmail, code, action: "verify" }),
      });
      if (!res.ok || !data.token) {
        otpStatus.textContent = data.error || "That code didn't work.";
        if (btn) btn.disabled = false;
        return;
      }
      setToken(data.token);
      await loadAccount();
    } catch {
      otpStatus.textContent = "Couldn't verify that code. Try again.";
    }
    if (btn) btn.disabled = false;
  });

  document.getElementById("otpResend")?.addEventListener("click", async () => {
    if (!pendingEmail || !otpStatus) return;
    otpStatus.textContent = "Sending a new code…";
    try {
      const data = await requestOtp(pendingEmail);
      otpStatus.classList.toggle("booking__status--ok", data.sent !== false);
      otpStatus.textContent = data.message || "Check your inbox for a new code.";
    } catch {
      otpStatus.textContent = "Couldn't resend. Wait a minute and try again.";
    }
  });

  document.getElementById("otpBack")?.addEventListener("click", () => {
    if (otpEmailStep) otpEmailStep.hidden = false;
    if (otpCodeStep) otpCodeStep.hidden = true;
    if (otpStatus) otpStatus.textContent = "";
  });

  document.getElementById("tabbar")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    setTab(btn.dataset.tab);
    if (btn.dataset.tab === "lessons") {
      const form = document.getElementById("weekForm");
      if (form && !form.hidden) form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  document.getElementById("homeBookBtn")?.addEventListener("click", () => {
    setTab("lessons");
    const form = document.getElementById("weekForm");
    if (form && !form.hidden) form.scrollIntoView({ behavior: "smooth", block: "start" });
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
        membershipId: moving ? undefined : selectedMembershipId || undefined,
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

  if (focusSelect) {
    focusSelect.addEventListener("change", async () => {
      selectedTime = "";
      if (selectedDate) {
        delete bookedCache[selectedDate];
        delete slotErrors[selectedDate];
        renderTimes();
        calendar.render();
        await loadSlots(selectedDate, { force: true });
        renderTimes();
        calendar.render();
        return;
      }
      resetPicker();
    });
  }

  if (memPurchase) {
    memPurchase.addEventListener("change", () => {
      selectedMembershipId = memPurchase.value;
      selectedTime = "";
      Object.keys(bookedCache).forEach((k) => delete bookedCache[k]);
      Object.keys(slotErrors).forEach((k) => delete slotErrors[k]);
      renderDash(account);
    });
  }

  async function signOut() {
    clearToken();
    account = null;
    try {
      await api("/api/member-login", {
        method: "POST",
        body: JSON.stringify({ action: "logout", email: "logout@local" }),
      });
    } catch {
      /* cookie clear best-effort */
    }
    if (loginStatus) {
      loginStatus.classList.remove("booking__status--ok");
      loginStatus.textContent = "";
    }
    const emailField = document.getElementById("loginEmail");
    if (emailField) emailField.value = "";
    showLogin();
  }

  document.getElementById("signOut")?.addEventListener("click", signOut);
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
