import { loadSettings } from "../lib/settings.js";

/** Public pricing + pay options for the booking form. */
export default async function handler(req, res) {
  const s = await loadSettings();
  res.status(200).json({
    prices: s.prices,
    membershipDeposit: s.membershipDeposit,
    allowCash: s.allowCash !== false,
    allowDeposit: s.allowDeposit !== false,
  });
}
