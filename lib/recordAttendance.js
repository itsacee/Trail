import { listActiveMemberships } from "./membershipCapacity.js";
import { todayChicago } from "./members.js";
import {
  loadLessons,
  saveLessons,
  makeMemberLesson,
  scheduledFor,
  addLesson,
} from "./lessons.js";
import { getAvailability } from "./schedule.js";

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(player, query) {
  const p = normalizeName(player);
  const q = normalizeName(query);
  if (!p || !q) return false;
  if (p === q) return true;
  if (p.startsWith(q + " ") || p.endsWith(" " + q)) return true;
  return p.split(" ").some((part) => part === q || part.startsWith(q));
}

function findMembershipByPlayer(memberships, query) {
  const q = normalizeName(query);
  if (!q) return null;
  const hits = memberships.filter((m) => nameMatches(m.metadata?.player, q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exact = hits.find((m) => normalizeName(m.metadata?.player) === q);
    return exact || null;
  }
  return null;
}

function hasLessonOnDate(scheduled, date) {
  return scheduled.some((l) => l.date === date);
}

export async function recordMemberLessons(stripeKey, { players, date, time, focus = "Fielding" }) {
  const lessonDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : todayChicago();
  const lessonTime = /^\d{1,2}:\d{2} (AM|PM)$/.test(String(time || "")) ? String(time) : "6:00 PM";
  const names = Array.isArray(players) ? players.map((p) => String(p || "").trim()).filter(Boolean) : [];
  if (!names.length) {
    return { ok: false, error: "Name at least one player." };
  }

  const memberships = await listActiveMemberships(stripeKey);
  const stored = await loadLessons();
  const availability = await getAvailability();
  const results = [];

  for (const name of names) {
    const sub = findMembershipByPlayer(memberships, name);
    if (!sub) {
      results.push({ player: name, ok: false, error: "No active membership found for that name." });
      continue;
    }

    const scheduled = scheduledFor(sub, stored);
    if (hasLessonOnDate(scheduled, lessonDate)) {
      results.push({
        player: sub.metadata?.player || name,
        email: sub.metadata?.email || sub.email || "",
        ok: true,
        skipped: true,
        message: `Already has a lesson recorded on ${lessonDate}.`,
      });
      continue;
    }

    const lesson = makeMemberLesson({
      sub,
      date: lessonDate,
      time: lessonTime,
      focus,
      availability,
    });
    lesson.note = "coach-recorded";
    addLesson(stored, lesson);
    results.push({
      player: sub.metadata?.player || name,
      email: sub.metadata?.email || sub.email || "",
      ok: true,
      date: lessonDate,
      time: lessonTime,
      focus,
      lessonId: lesson.id,
    });
  }

  const saved = await saveLessons(stored);
  if (!saved) {
    return { ok: false, error: "Couldn't save lessons. Check the blob store.", results };
  }

  return { ok: true, date: lessonDate, time: lessonTime, results };
}
