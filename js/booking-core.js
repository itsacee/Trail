/* Shared booking helpers for the booking page and the member portal.
 *
 * Everything lives on one global (window.AP) so the two page scripts can share
 * the slot math and the calendar without declaring the same names twice.
 *
 * The seat rules mirror lib/schedule.js:
 *   an hour holds two athlete seats · one athlete leaves a seat open at the same
 *   focus · two athletes (or a private lesson) fill the hour.
 */
(function () {
  const SLOT_CAPACITY = 2;
  const STEP_MINUTES = 60;
  const DURATIONS = { single: 60, thirty: 30, private: 60, membership: 60 };

  const DEFAULT_AVAILABILITY = {
    slotMinutes: 60,
    days: {
      0: { open: false, start: "18:00", end: "20:00" },
      1: { open: true, start: "18:00", end: "20:00" }, // Mon 6–8
      2: { open: true, start: "18:00", end: "20:00" },
      3: { open: true, start: "18:00", end: "20:00" },
      4: { open: false, start: "18:00", end: "20:00" },
      5: { open: false, start: "18:00", end: "20:00" },
      6: { open: false, start: "18:00", end: "20:00" },
    },
    blocked: [],
  };

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function durationFor(type) {
    return DURATIONS[type] || 60;
  }

  function seatsFor(type, athletes) {
    if (type === "private") return SLOT_CAPACITY;
    const n = Math.round(Number(athletes) || 1);
    return Math.min(SLOT_CAPACITY, Math.max(1, n));
  }

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

  function fmtTime(t) {
    const [h, m] = String(t).split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function dateFromIso(iso) {
    return new Date(`${iso}T12:00:00`);
  }

  function prettyDate(iso) {
    const d = dateFromIso(iso);
    return `${DAY_NAMES[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  }

  function todayIso() {
    return isoDate(new Date());
  }

  // Slot start times ("HH:mm") for a date, only where a lesson of durationMin
  // still fits before closing.
  function startsForDate(iso, availability, durationMin) {
    const av = availability || DEFAULT_AVAILABILITY;
    const d = dateFromIso(iso);
    if (isNaN(d)) return [];
    if ((av.blocked || []).includes(iso)) return [];
    const cfg = (av.days || {})[d.getDay()];
    if (!cfg || !cfg.open) return [];
    const start = toMinutes(cfg.start);
    const end = toMinutes(cfg.end);
    const dur = durationMin || STEP_MINUTES;
    const step = av.slotMinutes || STEP_MINUTES;
    const out = [];
    for (let t = start; t + dur <= end; t += step) {
      out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
    }
    return out;
  }

  function focusMatches(row, focus) {
    const focuses = [...new Set((row.focuses || []).filter(Boolean))];
    return Boolean(focus && focuses.length === 1 && focuses[0] === focus);
  }

  function seatsTaken(row) {
    const seats = Number(row.seats);
    if (seats > 0) return seats;
    const count = Number(row.count);
    return count > 0 ? count : 1;
  }

  // `want` is how many athlete seats are needed, or { seats, exclusive } for a
  // private lesson that takes the whole hour.
  function slotIsBlocked(booked, label, dur, focus, want) {
    const need = typeof want === "object" && want ? want : { seats: Number(want) || 1, exclusive: false };
    const seats = Math.max(1, Number(need.seats) || 1);
    const exclusive = Boolean(need.exclusive) || seats >= SLOT_CAPACITY;
    const start = labelToMin(label);
    if (start === null) return true;
    const end = start + dur;
    for (const b of booked || []) {
      const bs = labelToMin(b.time);
      if (bs === null) continue;
      const be = bs + (b.mins || 60);
      if (!(start < be && bs < end)) continue;
      if (b.time !== label || (b.mins || 60) !== dur) return true;
      if (b.exclusive || exclusive) return true;
      if (!focusMatches(b, focus)) return true;
      if (seatsTaken(b) + seats > SLOT_CAPACITY) return true;
    }
    return false;
  }

  function seatsLeft(booked, label, dur, focus) {
    const start = labelToMin(label);
    if (start === null) return 0;
    const end = start + dur;
    let left = SLOT_CAPACITY;
    for (const b of booked || []) {
      const bs = labelToMin(b.time);
      if (bs === null) continue;
      const be = bs + (b.mins || 60);
      if (!(start < be && bs < end)) continue;
      if (b.time !== label || (b.mins || 60) !== dur) return 0;
      if (b.exclusive) return 0;
      if (!focusMatches(b, focus)) return 0;
      left -= seatsTaken(b);
    }
    return Math.max(0, left);
  }

  function dollars(cents) {
    const n = (Number(cents) || 0) / 100;
    return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  }

  /* ---------- calendar ---------- */

  // A month grid. Open days read bright and are tappable; closed, full, and
  // past days are dimmed so it's obvious they can't be picked.
  function createCalendar(mount, options) {
    const opts = options || {};
    const state = { view: null, selected: opts.selected || "" };

    const el = document.createElement("div");
    el.className = "cal";
    const head = document.createElement("div");
    head.className = "cal__head";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "cal__nav";
    prev.setAttribute("aria-label", "Previous month");
    prev.textContent = "‹";
    const label = document.createElement("div");
    label.className = "cal__month";
    label.setAttribute("aria-live", "polite");
    const next = document.createElement("button");
    next.type = "button";
    next.className = "cal__nav";
    next.setAttribute("aria-label", "Next month");
    next.textContent = "›";
    head.append(prev, label, next);

    const dows = document.createElement("div");
    dows.className = "cal__dows";
    DAY_INITIALS.forEach((d, i) => {
      const s = document.createElement("span");
      s.textContent = d;
      s.setAttribute("aria-label", DAY_NAMES[i]);
      dows.appendChild(s);
    });

    const grid = document.createElement("div");
    grid.className = "cal__grid";

    const legend = document.createElement("p");
    legend.className = "cal__legend";
    legend.innerHTML =
      `<span class="cal__key cal__key--open"></span> Open` +
      `<span class="cal__key cal__key--off"></span> Closed or full`;

    el.append(head, dows, grid, legend);
    mount.innerHTML = "";
    mount.appendChild(el);

    function firstOpenIso() {
      const dates = opts.dates ? opts.dates() : [];
      return dates.find((iso) => isOpen(iso)) || dates[0] || todayIso();
    }

    function isOpen(iso) {
      return opts.isOpen ? Boolean(opts.isOpen(iso)) : false;
    }

    function monthStart(iso) {
      const d = dateFromIso(iso);
      return new Date(d.getFullYear(), d.getMonth(), 1);
    }

    function render() {
      const view = state.view || monthStart(state.selected || firstOpenIso());
      state.view = view;
      label.textContent = `${MONTH_NAMES[view.getMonth()]} ${view.getFullYear()}`;
      grid.innerHTML = "";

      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      for (let i = 0; i < first.getDay(); i++) {
        const pad = document.createElement("span");
        pad.className = "cal__pad";
        pad.setAttribute("aria-hidden", "true");
        grid.appendChild(pad);
      }
      for (let day = 1; day <= daysInMonth; day++) {
        const iso = isoDate(new Date(view.getFullYear(), view.getMonth(), day));
        const open = isOpen(iso);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cal__day";
        cell.dataset.date = iso;
        cell.textContent = String(day);
        cell.disabled = !open;
        cell.classList.toggle("is-open", open);
        cell.classList.toggle("is-off", !open);
        if (iso === todayIso()) cell.classList.add("is-today");
        if (iso === state.selected) cell.classList.add("is-selected");
        cell.setAttribute(
          "aria-label",
          `${MONTH_NAMES[view.getMonth()]} ${day}${open ? "" : " — not available"}`
        );
        if (open) {
          cell.addEventListener("click", () => {
            state.selected = iso;
            render();
            if (opts.onSelect) opts.onSelect(iso);
          });
        }
        grid.appendChild(cell);
      }

      // Don't let them wander months away from anything bookable.
      const dates = opts.dates ? opts.dates() : [];
      const firstIso = dates[0] || todayIso();
      const lastIso = dates[dates.length - 1] || todayIso();
      const viewKey = view.getFullYear() * 12 + view.getMonth();
      const firstKey = dateFromIso(firstIso).getFullYear() * 12 + dateFromIso(firstIso).getMonth();
      const lastKey = dateFromIso(lastIso).getFullYear() * 12 + dateFromIso(lastIso).getMonth();
      prev.disabled = viewKey <= firstKey;
      next.disabled = viewKey >= lastKey;
    }

    prev.addEventListener("click", () => {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1);
      render();
    });
    next.addEventListener("click", () => {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1);
      render();
    });

    return {
      render,
      get value() {
        return state.selected;
      },
      set(iso) {
        state.selected = iso || "";
        if (iso) state.view = monthStart(iso);
        render();
      },
      clear() {
        state.selected = "";
        render();
      },
    };
  }

  window.AP = {
    SLOT_CAPACITY,
    STEP_MINUTES,
    DURATIONS,
    DEFAULT_AVAILABILITY,
    DAY_NAMES,
    MONTH_NAMES,
    MONTH_SHORT,
    durationFor,
    seatsFor,
    toMinutes,
    labelToMin,
    fmtTime,
    isoDate,
    dateFromIso,
    prettyDate,
    todayIso,
    startsForDate,
    slotIsBlocked,
    seatsLeft,
    dollars,
    createCalendar,
  };
})();
