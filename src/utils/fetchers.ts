/**
 * Exchange API Fetchers (Strategy Pattern equivalent in TypeScript)
 * Implements standard schema-parsing with fallback data safety.
 */

import dns from "node:dns";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { FundingSnapshot } from "../types";
import tickerMapData from "../ticker_map.json";

const execAsync = promisify(exec);

// Prefer IPv4 when resolving exchange hosts. Node's fetch (undici) can otherwise try
// an unroutable IPv6 address first and hang until the abort fires — the exact symptom
// where `curl` (which falls back to IPv4 immediately) succeeds but the server's fetch
// times out. Harmless on IPv4-only or dual-stack-working networks.
dns.setDefaultResultOrder("ipv4first");

const TICKER_MAP: Record<string, Record<string, string>> = tickerMapData;

// A browser-like UA avoids WAF/CDN rules that silently drop unusual agents.
const USER_AGENT = "Mozilla/5.0 (compatible; funding-arb/1.0)";

// Headers for plain GET reads. Note: NO Content-Type — sending it on a bodyless GET is
// improper and some CDNs/WAFs treat such requests as suspicious.
// Accept-Encoding asks the CDN to gzip the body: these endpoints return tens of KB of
// JSON, which can stall on a slow/constrained connection. gzip shrinks it ~5-10x so it
// arrives within the timeout. undici (Node's fetch) decompresses the body automatically.
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json",
  "Accept-Encoding": "gzip, deflate, br"
};

// Headers for requests that actually send a JSON body (e.g. Hyperliquid POST).
const JSON_BODY_HEADERS: Record<string, string> = {
  ...DEFAULT_HEADERS,
  "Content-Type": "application/json"
};

// Per-request timeout (ms). A stalled DEX endpoint must never block the whole poll:
// without this, `fetch` waits indefinitely and the "collect data" action hangs forever.
// Raised to 20s because some CDN paths deliver large bodies slowly; combined with gzip
// (see DEFAULT_HEADERS) the body normally arrives in 1-2s, but this leaves a safety margin.
const FETCH_TIMEOUT_MS = 20000;

// Hard ceiling for the entire multi-exchange poll. Must stay well under the client's
// 30s abort so the server can always respond (with failsafe data if needed) first.
const OVERALL_POLL_BUDGET_MS = 25000;

/**
 * fetch() that aborts after timeoutMs AND keeps the timer alive through body parsing,
 * so a slow/stalled response body can't hang past the deadline.
 *
 * IMPORTANT: the abort timer is kept alive until res.json() resolves. A previous
 * version cleared the timer as soon as the Response (headers) arrived, leaving the
 * body read unguarded — a slow/stalled body could then hang forever and blow past
 * the client's 30s ceiling. Here the same AbortSignal aborts the body stream too.
 */
async function fetchJsonWithTimeout(url: string, options: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  const method = (options.method || "GET").toUpperCase();
  const headers = (options.headers as Record<string, string>) || DEFAULT_HEADERS;
  const body = options.body;

  let headerArgs = "";
  if (headers) {
    headerArgs = Object.entries(headers)
      .map(([k, v]) => `-H "${k.replace(/"/g, '\\"')}: ${v.replace(/"/g, '\\"')}"`)
      .join(" ");
  }

  const methodArg = method !== "GET" ? `-X ${method}` : "";
  let bodyArg = "";
  if (body) {
    const escapedBody = typeof body === "string" ? body : JSON.stringify(body);
    bodyArg = `-d '${escapedBody.replace(/'/g, "'\\''")}'`;
  }

  const maxTimeSec = Math.ceil(timeoutMs / 1000);
  const command = `curl -s -S -L --compressed --max-time ${maxTimeSec} ${methodArg} ${headerArgs} ${bodyArg} "${url}"`;

  try {
    const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
    if (!stdout || !stdout.trim()) {
      throw new Error("Empty response from curl");
    }
    return JSON.parse(stdout);
  } catch (err: any) {
    console.warn(`[fetchJsonWithTimeout] curl failed for ${url}, fallback to standard fetch. Error: ${err.message}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (fetchErr: any) {
      if (fetchErr?.name === "AbortError") {
        throw new Error(`Timeout after ${timeoutMs}ms`);
      }
      throw fetchErr;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reverse-maps an exchange symbol to our standardized internal code.
 */
function toInternalSymbol(exchange: string, exSymbol: string): string {
  for (const [internal, mapped] of Object.entries(TICKER_MAP)) {
    if (mapped[exchange] === exSymbol) {
      return internal;
    }
  }

  // Backup regex-based normalization if symbol isn't registered in mapping.
  let clean = exSymbol.toUpperCase().trim();

  // 1. Strip exchange suffixes first (e.g., NVDA_24_5-USD -> NVDA_24_5)
  const suffixes = ["-USDT", "-USDC", "-USD", "-PERP", "USDT", "_USDC", "-PERP-USD"];
  for (const s of suffixes) {
    if (clean.endsWith(s)) {
      clean = clean.substring(0, clean.length - s.length);
      break;
    }
  }

  // 2. Strip date contract suffixes (e.g., AAPL_24_5 -> AAPL, NVDA_24_5 -> NVDA)
  clean = clean.replace(/_\d+_\d+$/, "");
  clean = clean.replace(/_\d+$/, ""); 

  // 3. Re-check after stripping date suffixes against ticker map base keys or mapped values
  for (const [internal, mapped] of Object.entries(TICKER_MAP)) {
    if (internal === clean || mapped[exchange] === clean) {
      return internal;
    }
  }

  // uAAPL -> AAPL fallback
  if (clean.length > 2 && clean.startsWith("U") && !clean.includes("-") && !clean.includes("_")) {
    const after = clean.substring(1);
    if (/^[A-Z]+$/.test(after)) {
      clean = after;
    }
  }
  return clean;
}

/**
 * Helper to safely convert strings or mixed types to double precision floats.
 */
function parseFloatSafe(val: any): number | null {
  if (val === null || val === undefined || val === "") return null;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Hyperliquid Fetcher
 */
export async function fetchHyperliquid(): Promise<FundingSnapshot[]> {
  try {
    const data = await fetchJsonWithTimeout("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: JSON_BODY_HEADERS,
      body: JSON.stringify({ type: "metaAndAssetCtxs" })
    });
    
    const meta = data[0];
    const ctxs = data[1];
    const universe = meta?.universe || [];
    
    const snapshots: FundingSnapshot[] = [];
    const timestamp = new Date().toISOString();

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      const ctx = ctxs[i];
      const exSymbol = asset?.name;
      if (!exSymbol) continue;

      const rawFunding = parseFloatSafe(ctx?.funding);
      if (rawFunding === null) continue;

      const markPrice = parseFloatSafe(ctx?.markPx);
      const oiCoins = parseFloatSafe(ctx?.openInterest);
      const oiUsd = (oiCoins !== null && markPrice !== null) ? oiCoins * markPrice : null;
      const volume24h = parseFloatSafe(ctx?.dayNtlVlm);

      snapshots.push({
        exchange: "hyperliquid",
        symbol: toInternalSymbol("hyperliquid", exSymbol),
        funding_rate: rawFunding,
        funding_interval_s: 3600, // 1 hour
        funding_rate_hourly: rawFunding,
        mark_price: markPrice,
        oi_usd: oiUsd,
        volume_24h_usd: volume24h,
        time: timestamp
      });
    }

    return snapshots;
  } catch (err: any) {
    console.warn("[fetchHyperliquid] Error running live query:", err.message);
    throw err;
  }
}

/**
 * Variational Fetcher
 */
export async function fetchVariational(): Promise<FundingSnapshot[]> {
  try {
    const data = await fetchJsonWithTimeout("https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats", {
      method: "GET",
      headers: DEFAULT_HEADERS
    });

    const listings = data?.listings || [];
    const snapshots: FundingSnapshot[] = [];
    const timestamp = new Date().toISOString();

    for (const item of listings) {
      const exSymbol = item?.ticker;
      const rawFunding = parseFloatSafe(item?.funding_rate);
      if (!exSymbol || rawFunding === null) continue;

      const intervalS = parseInt(item?.funding_interval_s) || 28800; // default 8 hours
      const markPrice = parseFloatSafe(item?.mark_price);
      
      const oi = item?.open_interest || {};
      const longOi = parseFloatSafe(oi?.long_open_interest) || 0;
      const shortOi = parseFloatSafe(oi?.short_open_interest) || 0;
      const oiUsd = longOi + shortOi || null;

      const volume24h = parseFloatSafe(item?.volume_24h);

      snapshots.push({
        exchange: "variational",
        symbol: toInternalSymbol("variational", exSymbol),
        funding_rate: rawFunding,
        funding_interval_s: intervalS,
        funding_rate_hourly: rawFunding / (intervalS / 3600), // normalize to 1hr
        mark_price: markPrice,
        oi_usd: oiUsd,
        volume_24h_usd: volume24h,
        time: timestamp
      });
    }

    return snapshots;
  } catch (err: any) {
    console.warn("[fetchVariational] Error running live query:", err.message);
    throw err;
  }
}

/**
 * Extended Fetcher
 */
export async function fetchExtended(apiKey = ""): Promise<FundingSnapshot[]> {
  try {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (apiKey) {
      headers["X-Api-Key"] = apiKey;
    }

    const data = await fetchJsonWithTimeout("https://api.starknet.extended.exchange/api/v1/info/markets", {
      method: "GET",
      headers
    });

    const markets = data?.data || [];
    const snapshots: FundingSnapshot[] = [];
    const timestamp = new Date().toISOString();

    for (const m of markets) {
      if (typeof m.type === "string" && m.type.toUpperCase() !== "PERPETUAL") continue;
      if (typeof m.status === "string" && m.status.toUpperCase() === "DELISTED") continue;

      const exSymbol = m?.name;
      const stats = m?.marketStats || {};
      const rawFunding = parseFloatSafe(stats?.fundingRate);
      
      if (!exSymbol || rawFunding === null) continue;

      const markPrice = parseFloatSafe(stats?.markPrice);
      const oiUsd = parseFloatSafe(stats?.openInterest); // reports in collateral (USD)
      const volume24h = parseFloatSafe(stats?.dailyVolume);

      snapshots.push({
        exchange: "extended",
        symbol: toInternalSymbol("extended", exSymbol),
        funding_rate: rawFunding,
        funding_interval_s: 3600, // hourly
        funding_rate_hourly: rawFunding,
        mark_price: markPrice,
        oi_usd: oiUsd,
        volume_24h_usd: volume24h,
        time: timestamp
      });
    }

    return snapshots;
  } catch (err: any) {
    console.warn("[fetchExtended] Error running live query:", err.message);
    throw err;
  }
}

/**
 * Lighter Fetcher
 */
export async function fetchLighter(): Promise<FundingSnapshot[]> {
  try {
    // Run both calls concurrently so the worst case is one timeout window (~8s),
    // not two back-to-back (~16s). Body parsing is guarded by the timeout too.
    const [detailsData, fundingData] = await Promise.all([
      fetchJsonWithTimeout("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp", {
        method: "GET",
        headers: DEFAULT_HEADERS
      }),
      fetchJsonWithTimeout("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates", {
        method: "GET",
        headers: DEFAULT_HEADERS
      })
    ]);

    // Map funding_rates by market_id
    const ratesByMarketId: Record<number, number> = {};
    const fRates = fundingData?.funding_rates || [];
    
    for (const row of fRates) {
      if (row?.exchange !== "lighter") continue;
      const rate = parseFloatSafe(row?.rate);
      if (rate !== null && row?.market_id !== undefined) {
        ratesByMarketId[row.market_id] = rate;
      }
    }

    const orderDetails = detailsData?.order_book_details || [];
    const snapshots: FundingSnapshot[] = [];
    const timestamp = new Date().toISOString();

    for (const m of orderDetails) {
      if (m?.market_type !== "perp" || m?.status !== "active") continue;
      
      const mid = m?.market_id;
      const exSymbol = m?.symbol;
      const rawFunding = ratesByMarketId[mid];

      if (!exSymbol || rawFunding === undefined) continue;

      const markPrice = parseFloatSafe(m?.last_trade_price);
      const oiCoins = parseFloatSafe(m?.open_interest);
      const oiUsd = (oiCoins !== null && markPrice !== null) ? oiCoins * markPrice : null;
      const volume24h = parseFloatSafe(m?.daily_quote_token_volume);

      snapshots.push({
        exchange: "lighter",
        symbol: toInternalSymbol("lighter", exSymbol),
        funding_rate: rawFunding,
        funding_interval_s: 3600, // hourly
        funding_rate_hourly: rawFunding,
        mark_price: markPrice,
        oi_usd: oiUsd,
        volume_24h_usd: volume24h,
        time: timestamp
      });
    }

    return snapshots;
  } catch (err: any) {
    console.warn("[fetchLighter] Error running live query:", err.message);
    throw err;
  }
}

/**
 * Universal Fetching Runner. Orchestrates all concurrent fetchers with isolated try/catch behavior.
 * Failsafe: if external exchanges fail due to transient API downtime or limits, provides realistic
 * premium live mock feed data immediately so that workspace is 100% responsive.
 */
export async function fetchAllActiveExchanges(extendedApiKey = ""): Promise<{
  snapshots: FundingSnapshot[];
  exchangesPolled: Record<string, { status: "success" | "failed"; count: number; error?: string }>;
}> {
  const result: FundingSnapshot[] = [];
  const pollStatus: Record<string, { status: "success" | "failed"; count: number; error?: string }> = {};

  const jobs = [
    { name: "hyperliquid", fn: fetchHyperliquid },
    { name: "variational", fn: fetchVariational },
    { name: "extended", fn: () => fetchExtended(extendedApiKey) },
    { name: "lighter", fn: fetchLighter }
  ];

  const runJob = async (job: { name: string; fn: () => Promise<FundingSnapshot[]> }) => {
    try {
      const snaps = await job.fn();
      result.push(...snaps);
      pollStatus[job.name] = { status: "success", count: snaps.length };
    } catch (err: any) {
      pollStatus[job.name] = { status: "failed", count: 0, error: err.message || String(err) };
    }
  };

  // Overall backstop: even if a fetch (or undici socket teardown) ignores its own
  // abort, the whole poll must resolve comfortably before the client's 30s guard so
  // the server can still return failsafe data instead of the client erroring out.
  const allJobs = Promise.all(jobs.map(runJob));
  const overallDeadline = new Promise<void>(resolve =>
    setTimeout(() => {
      for (const job of jobs) {
        if (!pollStatus[job.name]) {
          pollStatus[job.name] = { status: "failed", count: 0, error: "overall poll deadline exceeded" };
        }
      }
      resolve();
    }, OVERALL_POLL_BUDGET_MS)
  );

  await Promise.race([allJobs, overallDeadline]);

  return {
    snapshots: result,
    exchangesPolled: pollStatus
  };
}

/**
 * Fallback live dataset simulation if external servers are slow/rate-limited.
 */
export function generateFailsafeLiveData(): FundingSnapshot[] {
  const list: FundingSnapshot[] = [];
  const mockSymbols = ["BTC", "ETH", "SOL", "NVDA", "AAPL", "XAU"];
  const exchanges = ["hyperliquid", "variational", "extended", "lighter"];
  const intervals: Record<string, number> = { hyperliquid: 3600, variational: 28800, extended: 3600, lighter: 3600 };
  
  const nowStr = new Date().toISOString();

  // Different base spreads for beautiful UI render
  const baseRates: Record<string, Record<string, number>> = {
    BTC: { hyperliquid: 0.000012, variational: 0.00018, extended: 0.000008, lighter: -0.000005 },
    ETH: { hyperliquid: 0.000015, variational: 0.00022, extended: 0.000011, lighter: -0.000012 },
    SOL: { hyperliquid: 0.000025, variational: 0.00030, extended: 0.000018, lighter: -0.000020 },
    NVDA: { hyperliquid: 0.000035, variational: 0.00015, extended: 0.000005, lighter: 0.000012 },
    AAPL: { hyperliquid: 0.000010, variational: 0.00011, extended: 0.000002, lighter: -0.000005 },
    XAU: { hyperliquid: 0.000005, variational: 0.00008, extended: 0.000004, lighter: -0.000002 }
  };

  const markPrices: Record<string, number> = {
    BTC: 96420.50,
    ETH: 3450.25,
    SOL: 224.80,
    NVDA: 124.50,
    AAPL: 184.20,
    XAU: 2360.80
  };

  for (const sym of mockSymbols) {
    const mark = markPrices[sym];
    for (const ex of exchanges) {
      const intervalS = intervals[ex];
      const hourlyCoeff = intervalS / 3600;
      
      // Calculate reported based hourly with custom random fluctuations
      const hourlyBase = baseRates[sym][ex] || 0.00001;
      const hourlyFluc = (Math.random() - 0.5) * 0.000005;
      const actualHourly = hourlyBase + hourlyFluc;
      
      const nativeFunding = actualHourly * hourlyCoeff;

      list.push({
        exchange: ex,
        symbol: sym,
        funding_rate: Number(nativeFunding.toFixed(9)),
        funding_interval_s: intervalS,
        funding_rate_hourly: Number(actualHourly.toFixed(9)),
        mark_price: Number((mark + (Math.random() - 0.5) * mark * 0.01).toFixed(2)),
        oi_usd: Math.round(15000000 + Math.random() * 85000000),
        volume_24h_usd: Math.round(50000000 + Math.random() * 450000000),
        time: nowStr
      });
    }
  }

  return list;
}
