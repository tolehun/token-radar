// radar-2: the token radar's scoring model.
//
// Input: one sealed DefiLlama snapshot (758 protocols, 40 on the watchlist).
// Output: a ranked board of every rankable pre-token protocol, each with an implied
// launch value and a concrete farm plan.
//
// A protocol is pre-token when the snapshot records no token for it at all: no market
// cap, no CoinGecko id, no symbol. "Records no token" is the honest phrase — the
// snapshot is an index entry, not proof. Live-token protocols are kept apart and shown
// with their market caps, never mixed into the ranking.
//
// Implied value is one function of the snapshot's own figures, applied identically to
// every row:
//
//   base    = tvl_usd x 0.25
//   growth  = clamp(change_7d, -50, 150) per cent
//   growth  = 1 + (growth / 100) x 0.5
//   age     = days from listed_at to the snapshot date (unknown: 365)
//   mature  = 0.6 + min(age, 1095) / 1095 x 0.4
//   chains  = 1 + 0.05 x min(chains - 1, 4)
//   implied = max(1, round(base x growth x mature x chains))
//
// What each factor means: TVL is the size of the economy a token would price. Seven-day
// growth is momentum — a fast-growing protocol's launch is worth more than a shrinking
// one's. Age without a token is patience: the longer a real economy runs tokenless, the
// more overdue its launch. Chain breadth is distribution: a protocol live on several
// chains reaches more wallets at launch than a single-chain one. No protocol name is
// ever special-cased.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_weight: number;
  chain_max: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_weight: 0.05,
  chain_max: 4,
};

export const MODEL_VERSION = 'radar-2';

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Whole days from `listedAt` to `asOf`, never negative; null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** The four multipliers and the implied value one protocol earns under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finiteOr(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.max(0, protocol.chains.length - 1);
  const chainMult = 1 + model.chain_weight * Math.min(extraChains, model.chain_max);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * model.base_multiple * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, age };
}

/** True when the snapshot records no token for the protocol at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the board may rank the protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

function byImpliedThenSlug(a: { implied: number; slug: string }, b: { implied: number; slug: string }): number {
  return b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

function byTvlThenSlug(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** The board: every watchlist slug, plus every rankable protocol below the floor, strongest first. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is scored, whatever else happens.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable protocol below the floor, by TVL. No cap, no hand-picking:
  // the board covers the whole rankable set, and a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort(byTvlThenSlug);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, slug: p.slug, ...v };
  });
  scored.sort(byImpliedThenSlug);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

// --------------------------------------------------------------------------- farm plans
//
// A farm plan is six steps, each an action with a cost and a time, derived only from
// the protocol's own record: its category picks the action, its TVL picks the capital,
// its age picks the hold. No name is ever special-cased. The tables below are the whole
// derivation: first matching rule wins, in table order.

type ActionBuilder = (name: string, capital: number, chain: string) => string;

const ACTIONS: { keys: string[]; build: ActionBuilder }[] = [
  { keys: ['lend', 'cdp', 'collateral'], build: (n, c, ch) => `Supply $${c} of USDC to ${n} on ${ch} and keep the position open.` },
  { keys: ['dex', 'yield', 'leveraged farm'], build: (n, c, ch) => `Provide $${c} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
  { keys: ['bridge'], build: (n, c, ch) => `Bridge $${c} of USDC to ${ch} through ${n} and use the bridged funds in its app.` },
  { keys: ['staking', 'restak'], build: (n, c) => `Stake $${c} of the chain's staking asset through ${n} and keep the receipt.` },
  { keys: ['perpetual', 'derivative'], build: (n, c) => `Deposit $${c} of USDC as margin on ${n} and open one small hedge.` },
  { keys: ['prediction'], build: (n, c) => `Fund $${c} and place one market position on ${n}.` },
  { keys: ['curator', 'allocator'], build: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and keep the shares.` },
  { keys: ['stable'], build: (n, c, ch) => `Mint or deposit $${c} of the stable asset through ${n} on ${ch}.` },
  { keys: ['rwa'], build: (n, c, ch) => `Mint $${c} of the protocol's yield asset on ${ch} and hold it.` },
  { keys: ['insurance'], build: (n, c, ch) => `Buy $${c} of cover from ${n} on ${ch} and keep the policy.` },
];

const WEEKLY: { keys: string[]; text: string }[] = [
  { keys: ['lend', 'cdp', 'collateral'], text: 'Make one qualifying action each week: top up the supply, borrow a little, or repay and re-supply.' },
  { keys: ['dex', 'yield', 'leveraged farm'], text: 'Make one qualifying action each week: a swap, a fresh deposit, or a rebalance of the pool position.' },
  { keys: ['bridge'], text: 'Make one qualifying action each week: a small bridge or a swap on the destination chain.' },
  { keys: ['staking', 'restak'], text: 'Make one qualifying action each week: add a little stake or claim and restake the rewards.' },
  { keys: ['perpetual', 'derivative'], text: 'Make one qualifying action each week: one small trade or a funding-fee check on the position.' },
  { keys: ['prediction'], text: 'Make one qualifying action each week: one market position or a resolution check.' },
  { keys: ['curator', 'allocator'], text: 'Make one qualifying action each week: a vault deposit or a rebalance vote.' },
];

const CAPITAL_TIERS: { minTvl: number; capital: number }[] = [
  { minTvl: 5_000_000_000, capital: 250 },
  { minTvl: 1_000_000_000, capital: 150 },
  { minTvl: 100_000_000, capital: 100 },
  { minTvl: 0, capital: 50 },
];

const HOLD_TIERS: { maxAge: number; days: number }[] = [
  { maxAge: 180, days: 60 },
  { maxAge: 365, days: 45 },
  { maxAge: Number.POSITIVE_INFINITY, days: 30 },
];

/** The chains a protocol names, up to two, or a neutral phrase. */
function chainsOf(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  if (p.chains.length === 1) return p.chains[0]!;
  return `${p.chains[0]!} and ${p.chains[1]!}`;
}

function capitalFor(p: SnapshotProtocol): number {
  return CAPITAL_TIERS.find((t) => p.tvl_usd >= t.minTvl)?.capital ?? 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  return HOLD_TIERS.find((t) => age < t.maxAge)?.days ?? 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const rule = ACTIONS.find((r) => r.keys.some((k) => c.includes(k)));
  if (rule) return rule.build(p.name, capital, chain);
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

function weeklyActionFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const rule = WEEKLY.find((r) => r.keys.some((k) => c.includes(k)));
  return rule ? rule.text : 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** One step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: six steps, each an action with a cost and a time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainsOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// --------------------------------------------------------------------------- live set, radar, validation

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const byMarketCap = (a: SnapshotProtocol, b: SnapshotProtocol): number =>
    (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd;
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  live.sort(byMarketCap);
  return live.slice(0, 24).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  const m = row.model;
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: m.growth_multiplier,
    maturity_multiplier: m.maturity_multiplier,
    chain_multiplier: m.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchlist.has(r.slug)).length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Read an optional number field, or null when it is absent or not a finite number. */
function optNumber(record: Record<string, unknown>, key: string): number | null {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read an optional string field, or null when it is absent or not a string. */
function optString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === 'string' ? v : null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const asOf = doc.as_of;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  const floor = doc.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  const watchlist = doc.watchlist;
  if (!Array.isArray(watchlist) || watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const chains = Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [];
    return {
      slug: p.slug,
      name: p.name,
      category: optString(p, 'category'),
      chains,
      tvl_usd: p.tvl_usd,
      change_7d: optNumber(p, 'change_7d'),
      mcap_usd: optNumber(p, 'mcap_usd'),
      listed_at: optString(p, 'listed_at'),
      gecko_id: optString(p, 'gecko_id'),
      symbol: optString(p, 'symbol'),
    };
  });
  return { as_of: asOf, source: doc.source, floor_usd: floor, protocols, watchlist: watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  const badRank = ranks.findIndex((rank, i) => rank !== i + 1);
  if (badRank >= 0) return `rank ${badRank + 1} is ${ranks[badRank]}`;
  const outOfOrder = board.findIndex((r, i) => i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd);
  if (outOfOrder > 0) return `row ${outOfOrder + 1} outranks row ${outOfOrder} on implied value`;
  const first = board[0]?.implied_value_usd;
  const last = board[board.length - 1]?.implied_value_usd;
  if (board.length >= 2 && first !== undefined && first === last) {
    return `all ${board.length} rows share the same implied value $${first}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    const badStep = r.farm_steps.find((s) => s.length < 20 || s.length > 600);
    if (badStep !== undefined) return `${r.slug} has a farm step of ${badStep.length} characters`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
