// Where and when lessons happen.
//
// IMPORTANT: the day/time map below is mirrored in js/main.js so the booking
// form can show times without a round trip. Change both together.

export const LOCATIONS = {
  delcity: {
    name: "Del City",
    // Shown publicly (before payment) — general area only
    area: "Del City — just off I-40, southeast OKC metro",
    // Shown only after payment, in the confirmation email
    address: "3701 S Bryant Ave, Del City, OK 73115",
  },
  mustang: {
    name: "Mustang",
    area: "Mustang — west side of the metro",
    address: "", // TODO: exact street address needed
  },
  mojo: {
    name: "Mojo Yard",
    area: "Mojo Yard — Oklahoma City",
    address: "", // TODO: exact street address needed (currently unused)
  },
};

// Session START times, 24h. Lessons run one hour, so the last start is one
// hour before closing.
const WEEKEND = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
const WEEKDAY = ["17:00", "18:00", "19:00", "20:00"];

// 0 = Sunday ... 6 = Saturday
export const SCHEDULE = {
  0: { times: WEEKEND, location: "delcity" },
  1: { times: WEEKDAY, location: "mustang" },
  2: { times: WEEKDAY, location: "mustang" },
  3: { times: WEEKDAY, location: "mustang" },
  4: { times: WEEKDAY, location: "mustang" },
  5: { times: WEEKDAY, location: "mustang" },
  6: { times: WEEKEND, location: "delcity" },
};

export function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Noon avoids any timezone shifting the day of the week
function dayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return isNaN(d) ? null : d.getDay();
}

export function planFor(isoDate) {
  const day = dayOf(isoDate);
  return day === null ? null : SCHEDULE[day] || null;
}

export function allowedTimes(isoDate) {
  const plan = planFor(isoDate);
  return plan ? plan.times.map(fmtTime) : [];
}

export function locationKeyFor(isoDate) {
  const plan = planFor(isoDate);
  return plan ? plan.location : "";
}

export function locationFor(isoDate) {
  const key = locationKeyFor(isoDate);
  return key ? LOCATIONS[key] : null;
}
