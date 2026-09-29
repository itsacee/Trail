import { loadSettings } from "../lib/settings.js";
import { loadCoachStatus } from "../lib/coachStatus.js";

export default async function handler(req, res) {
  await loadCoachStatus();
  const s = await loadSettings();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    prices: s.prices,
    membershipDeposit: s.membershipDeposit,
    allowCash: s.allowCash !== false,
    allowDeposit: s.allowDeposit !== false,
  });
}
