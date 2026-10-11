// Bounded compare-and-set transactions for versioned Blob JSON stores.
//
// Callers supply load / commit / mutator. On an ETag conflict the latest data
// is reloaded and the mutator runs again against that snapshot — never rewrite
// a stale in-memory array.

export const DEFAULT_TXN_ATTEMPTS = 5;

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.load
 * @param {(data: object) => Promise<{ ok: boolean, conflict?: boolean, unsafe?: boolean }>} opts.commit
 * @param {(data: object, ctx: { attempt: number }) => Promise<object>|object} opts.mutator
 * @param {number} [opts.attempts]
 * @param {string} [opts.unavailableError]
 */
export async function mutateVersioned({
  load,
  commit,
  mutator,
  attempts = DEFAULT_TXN_ATTEMPTS,
  unavailableError = "Couldn't safely update the schedule. Please try again.",
}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const data = await load();
    if (data?._readFailed) {
      return { ok: false, error: unavailableError, code: "schedule_unavailable" };
    }

    const decision = await mutator(data, { attempt });
    if (!decision) {
      return { ok: false, error: unavailableError, code: "schedule_unavailable" };
    }
    if (decision.ok === false) return decision;
    if (decision.skipSave) {
      return { ok: true, data, attempts: attempt + 1, ...decision };
    }

    const saved = await commit(data);
    if (saved?.ok) {
      return { ok: true, data, attempts: attempt + 1, ...decision };
    }
    if (saved?.conflict) continue;
    if (saved?.paused) {
      return {
        ok: false,
        error: unavailableError,
        code: "schedule_unavailable",
        paused: true,
      };
    }

    return {
      ok: false,
      error: unavailableError,
      code: "schedule_unavailable",
      unsafe: Boolean(saved?.unsafe),
    };
  }

  return {
    ok: false,
    conflict: true,
    exhausted: true,
    error: unavailableError,
    code: "schedule_unavailable",
  };
}
