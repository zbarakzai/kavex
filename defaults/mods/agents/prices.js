// API prices in US dollars per million tokens, by the exact model id an agent writes and by the
// token classes it reports. A model that isn't here reads "no price": nothing is worked out from
// a similar name. Every figure comes from the provider's own pricing page, and the list is
// checked at each release (see the release steps in AGENTS.md).
//
// Claude: platform.claude.com/docs/en/about-claude/pricing, read 2026-11-01.
// `fast` is fast mode: the page gives its input and output, and its caching multipliers apply on
// top of those. `over` is the price of a message whose prompt is over `tokens`, cache included.
//
// OpenAI: developers.openai.com/api/docs/pricing, read 2026-11-01.
// Standard and Fast tiers, short and long context; long is a response over 272K input tokens.
// `read` is cached input. Cache writes aren't listed: the page prices 30-minute and 12-hour ones
// and Codex writes one figure, so a session with any reads "no price". The page's "-" is no price
// too: GPT-5.5 and GPT-5.4 have no long Fast price. GPT-5.6 Sol's is promotional until at least
// 2026-11-21, so check it at the next release.

const claude = (input, write5m, write1h, read, output) => ({ input, write5m, write1h, read, output });

const LONG = 272000;
const rates = ([input, read, output]) => ({ input, read, output });
const openai = (short, long, fast, fastLong) => ({
  ...rates(short),
  over: { tokens: LONG, ...rates(long) },
  fast: { ...rates(fast), over: { tokens: LONG, ...(fastLong && rates(fastLong)) } },
});

export const PRICES = {
  "claude-fable-5-1": claude(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": claude(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": claude(10, 12.5, 20, 1, 50),
  "claude-mythos-5": claude(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": { ...claude(4, 5, 8, 0.2, 20), fast: claude(8, 10, 16, 0.4, 40) },
  "claude-opus-5": { ...claude(5, 6.25, 10, 0.5, 25), fast: claude(10, 12.5, 20, 1, 50) },
  "claude-opus-4-8": { ...claude(5, 6.25, 10, 0.5, 25), fast: claude(10, 12.5, 20, 1, 50) },
  "claude-opus-4-7": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5-20251101": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1-20250805": claude(15, 18.75, 30, 1.5, 75),
  "claude-opus-4-20250514": claude(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5-5": claude(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": claude(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5-20250929": claude(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-20250514": claude(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": { ...claude(0.1, 0.125, 0.2, 0.01, 0.5), over: { tokens: 100000, ...claude(0.5, 0.625, 1, 0.05, 2.5) } },
  "claude-haiku-4-5-20251001": claude(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku-20241022": claude(0.8, 1, 1.6, 0.08, 4),
  "gpt-6-astra": openai([10, 1, 50], [20, 2, 75], [20, 2, 100], [40, 4, 150]),
  "gpt-6.1-sol": openai([2, 0.1, 10], [4, 0.2, 15], [4, 0.2, 20], [8, 0.4, 30]),
  "gpt-6.1-terra": openai([1, 0.05, 5], [2, 0.1, 7.5], [2, 0.1, 10], [4, 0.2, 15]),
  "gpt-6-luna": openai([0.1, 0.01, 0.5], [0.2, 0.02, 0.75], [0.2, 0.02, 1], [0.4, 0.04, 1.5]),
  "gpt-6-sol": openai([2, 0.2, 10], [4, 0.4, 15], [4, 0.4, 20], [8, 0.8, 30]),
  "gpt-5.6-sol": openai([4, 0.4, 20], [8, 0.8, 30], [8, 0.8, 40], [16, 1.6, 60]),
  "gpt-5.6-terra": openai([2, 0.2, 12], [4, 0.4, 18], [4, 0.4, 24], [8, 0.8, 36]),
  "gpt-5.6-luna": openai([0.2, 0.02, 1.2], [0.4, 0.04, 1.8], [0.4, 0.04, 2.4], [0.8, 0.08, 3.6]),
  "gpt-5.5": openai([5, 0.5, 30], [10, 1, 45], [12.5, 1.25, 75]),
  "gpt-5.4": openai([2.5, 0.25, 15], [5, 0.5, 22.5], [5, 0.5, 30]),
};

// What Claude's `inference_geo` multiplies a message by: US-only inference is 1.1x on every class.
export const REGIONS = { global: 1, not_available: 1, us: 1.1 };

export function priced(rates, tokens) {
  if (!rates) return null;
  let dollars = 0;
  for (const [name, count] of Object.entries(tokens)) {
    if (!count) continue;
    if (rates[name] === undefined) return null;
    dollars += (count * rates[name]) / 1e6;
  }
  return dollars;
}
