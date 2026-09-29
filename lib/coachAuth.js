// The single passcode that unlocks Coach Desk and the coach-only endpoints.
//
// Set COACH_PASS in Vercel to change it; the default below is the passcode the
// coach page ships with so the desk works on a fresh deploy.

export const DEFAULT_COACH_PASS = "Kruzeleo1502";

export function coachPass() {
  const fromEnv = String(process.env.COACH_PASS || "").trim();
  return fromEnv || DEFAULT_COACH_PASS;
}

export function isCoachPass(value) {
  return String(value || "") === coachPass();
}

// Answers a request when the passcode is missing or wrong, and returns null so
// callers can `if (!requireCoach(req, res)) return;`.
export function requireCoach(req, res) {
  const given = String(req.query?.key || req.body?.key || "");
  if (!isCoachPass(given)) {
    res.status(401).json({ error: "Wrong passcode." });
    return null;
  }
  return coachPass();
}
