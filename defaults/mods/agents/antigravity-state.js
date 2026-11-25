// Shared by the mod and its standalone title bridge. Keep this function self-contained.
export function sessionReport(value, terminal) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.terminal !== terminal) return null;
  if (value.session === null || value.session === "") return { session: null, terminal };
  if (typeof value.session !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.session)) return null;
  const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const model = typeof value.model === "string" && value.model.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.model) ? value.model : undefined;
  return {
    session: value.session, terminal,
    model: model || "Antigravity",
    percent: Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100 ? value.percent : undefined,
    total: count(value.total) > 0 ? value.total : undefined,
    input: count(value.input), output: count(value.output),
    cost: Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : undefined,
    estimated: typeof value.estimated === "boolean" ? value.estimated : undefined,
  };
}

// Google documents the percentage, but not an exact current-context numerator or cumulative
// cached tokens. Keep those unknown instead of using the session totals as current context.
// https://antigravity.google/docs/cli/statusline
export function liveReport(state, terminal) {
  const context = state?.context_window;
  const pending = context?.current_usage === null;
  return sessionReport({
    session: state?.conversation_id ?? state?.session_id,
    terminal, model: state?.model?.display_name || state?.model?.id,
    percent: pending ? undefined : context?.used_percentage,
    total: context?.context_window_size,
    input: pending ? undefined : context?.total_input_tokens,
    output: pending ? undefined : context?.total_output_tokens,
    cost: pending ? undefined : state?.cost?.total_usd,
    estimated: state?.cost?.estimated,
  }, terminal);
}
