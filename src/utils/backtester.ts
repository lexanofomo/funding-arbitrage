/**
 * Math and Backtesting Engine
 * Port of synthetic_backtest.py and pandas analytics to TypeScript.
 */

import { FundingSnapshot, ArbitrageSpreadRow, BacktestResult, AggregatedSeries } from "../types";
import tickerMapData from "../ticker_map.json";
import { classifySymbol } from "./classify";

// Typed ticker mapping
const TICKER_MAP: Record<string, Record<string, string>> = tickerMapData;

const INTERVALS: Record<string, number> = {
  hyperliquid: 3600,
  lighter: 3600,
  extended: 3600,
  variational: 28800
};

/**
 * Standard Box-Muller transform for generating normally distributed values.
 */
function randomNormal(mean = 0, stdDev = 1): number {
  let u = 0, v = 0;
  while(u === 0) u = Math.random(); // Converting [0,1) to (0,1)
  while(v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdDev + mean;
}

/**
 * Simulates a mean-reverting Ornstein-Uhlenbeck (OU) process for hourly rates.
 */
function ouPath(nHours: number, mean: number, vol: number, theta = 0.05, x0: number | null = null): number[] {
  const path = new Array<number>(nHours);
  path[0] = x0 !== null ? x0 : mean;
  for (let t = 1; t < nHours; t++) {
    const prev = path[t - 1];
    path[t] = prev + theta * (mean - prev) + vol * randomNormal(0, 1);
  }
  return path;
}

/**
 * Generates synthetic snapshots representing target exchange behavior.
 */
export function generateSyntheticSnapshots(
  symbols: string[],
  exMeans: Record<string, number>,
  days: number,
  snapMin = 15,
  vol = 2e-5,
  marketCompVol = 1e-5,
  noise = 2e-6,
  basePriceOrMap?: number | Record<string, number>
): { snapshots: FundingSnapshot[]; truthHourly: Record<string, number[]> } {
  const nHours = days * 24;
  const snapshots: FundingSnapshot[] = [];
  const truthHourly: Record<string, number[]> = {};

  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const t0 = new Date(now.getTime() - days * 24 * 3600 * 1000);

  const defaultBasePrices: Record<string, number> = {
    BTC: 65000,
    ETH: 1800,
    SOL: 72,
    NVDA: 208,
    AAPL: 300,
    XAU: 4300
  };

  for (const sym of symbols) {
    // Shared market-wide component
    const marketComponent = ouPath(nHours, 0.0, marketCompVol, 0.03);

    // Share a single realistic price walk for this symbol across all exchanges
    const pricePath = new Array<number>(nHours);
    let startPrice = 100.0;
    if (basePriceOrMap !== undefined) {
      if (typeof basePriceOrMap === "number") {
        startPrice = basePriceOrMap;
      } else {
        startPrice = basePriceOrMap[sym] !== undefined ? basePriceOrMap[sym] : (defaultBasePrices[sym] || 100.0);
      }
    } else {
      startPrice = defaultBasePrices[sym] || 100.0;
    }

    pricePath[0] = startPrice;
    for (let h = 1; h < nHours; h++) {
      // Generate a small percentage wander with standard deviation of ~0.2% per hour
      const changePercent = randomNormal(0.00005, 0.002);
      pricePath[h] = Math.max(0.001, pricePath[h - 1] * (1 + changePercent));
    }

    for (const [ex, baseMean] of Object.entries(exMeans)) {
      const trueHourly = ouPath(nHours, baseMean, vol);
      
      // Combine with asset class / market component
      for (let h = 0; h < nHours; h++) {
        trueHourly[h] += marketComponent[h];
      }

      // Record theoretical clean truth for forward tests
      truthHourly[`${sym}_${ex}`] = trueHourly;

      const intervalH = INTERVALS[ex] / 3600;
      const perHour = Math.max(1, Math.floor(60 / snapMin));

      for (let h = 0; h < nHours; h++) {
        for (let k = 0; k < perHour; k++) {
          const tickTime = new Date(t0.getTime() + h * 3600 * 1000 + k * snapMin * 60 * 1000);
          
          // Multiply clean hourly rate by exchange interval to report native rates, adding minor precision noise
          const nativeRateReported = (trueHourly[h] + noise * randomNormal(0, 1)) * intervalH;

          snapshots.push({
            exchange: ex,
            symbol: sym,
            funding_rate: nativeRateReported,
            funding_interval_s: INTERVALS[ex],
            funding_rate_hourly: nativeRateReported / intervalH,
            mark_price: Number(pricePath[h].toFixed(4)),
            oi_usd: 12500000,
            volume_24h_usd: 150000000,
            time: tickTime.toISOString()
          });
        }
      }
    }
  }

  return { snapshots, truthHourly };
}

/**
 * Aggregates fine snapshots into 1-hour intervals (Hourly continuous aggregate representation).
 */
export function aggregateToHourly(snapshots: FundingSnapshot[]): FundingSnapshot[] {
  const grouped: Record<string, {
    rates: number[];
    markPrices: number[];
    ois: number[];
    vols: number[];
    time: string;
  }> = {};

  for (const s of snapshots) {
    // Floor timestamp to beginning of hour
    const d = new Date(s.time);
    d.setUTCMinutes(0, 0, 0);
    const bucket = d.toISOString();

    // Use "|" as the delimiter: it never appears in ISO timestamps, exchange names,
    // or symbols (symbols such as "R_BTC" contain underscores and previously corrupted
    // the split, dropping everything after the first "_").
    const key = `${bucket}|${s.exchange}|${s.symbol}`;
    if (!grouped[key]) {
      grouped[key] = {
        rates: [],
        markPrices: [],
        ois: [],
        vols: [],
        time: s.time
      };
    }
    grouped[key].rates.push(s.funding_rate_hourly);
    if (s.mark_price !== null) grouped[key].markPrices.push(s.mark_price);
    if (s.oi_usd !== null) grouped[key].ois.push(s.oi_usd);
    if (s.volume_24h_usd !== null) grouped[key].vols.push(s.volume_24h_usd);
  }

  const result: FundingSnapshot[] = [];
  for (const [key, val] of Object.entries(grouped)) {
    const parts = key.split("|");
    const bucketTime = parts[0];
    const exchange = parts[1];
    const symbol = parts[2];

    const meanRate = val.rates.reduce((sum, r) => sum + r, 0) / val.rates.length;
    const markPrice = val.markPrices.length ? val.markPrices[val.markPrices.length - 1] : 100;
    const oiUsd = val.ois.length ? val.ois[val.ois.length - 1] : null;
    const volumeUsd = val.vols.length ? val.vols[val.vols.length - 1] : null;

    result.push({
      exchange,
      symbol,
      funding_rate: meanRate, // For simplicity hourly represents standard unit
      funding_interval_s: 3600,
      funding_rate_hourly: meanRate,
      mark_price: markPrice,
      oi_usd: oiUsd,
      volume_24h_usd: volumeUsd,
      time: bucketTime
    });
  }

  return result.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Filters a series dataset to a moving lookback window.
 */
export function filterByWindow(hourly: FundingSnapshot[], days: number): FundingSnapshot[] {
  if (hourly.length === 0) return [];
  let maxTime = 0;
  for (const h of hourly) {
    const t = new Date(h.time).getTime();
    if (t > maxTime) maxTime = t;
  }
  const cutoff = maxTime - days * 24 * 3600 * 1000;
  return hourly.filter(h => new Date(h.time).getTime() >= cutoff);
}

/**
 * Computes arbitrage spreads between exchanges over a period.
 * Mimics SQL & Pandas analytical pivots.
 */
export function computeSpreads(hourly: FundingSnapshot[], days: number, minSpread = 0.0005): ArbitrageSpreadRow[] {
  if (hourly.length === 0) return [];

  // Group by symbol -> exchange -> cumulative sums
  const data: Record<string, Record<string, {
    cumFundingRate: number;
    lastPrice: number | null;
    lastOi: number | null;
  }>> = {};

  for (const h of hourly) {
    if (!data[h.symbol]) {
      data[h.symbol] = {};
    }
    if (!data[h.symbol][h.exchange]) {
      data[h.symbol][h.exchange] = { cumFundingRate: 0, lastPrice: null, lastOi: null };
    }
    data[h.symbol][h.exchange].cumFundingRate += h.funding_rate_hourly;
    if (h.mark_price !== null) data[h.symbol][h.exchange].lastPrice = h.mark_price;
    if (h.oi_usd !== null) data[h.symbol][h.exchange].lastOi = h.oi_usd;
  }

  const rows: ArbitrageSpreadRow[] = [];
  const totalHours = Math.max(days * 24, 1);

  for (const [symbol, exchanges] of Object.entries(data)) {
    const exEntries = Object.entries(exchanges);
    if (exEntries.length < 2) continue; // Must have at least two exchanges to form an arb sweep

    // Sort to extract min and max
    exEntries.sort((a, b) => b[1].cumFundingRate - a[1].cumFundingRate);
    
    const [shortEx, shortData] = exEntries[0];
    const [longEx, longData] = exEntries[exEntries.length - 1];

    const spread = shortData.cumFundingRate - longData.cumFundingRate;
    if (spread < minSpread) continue;

    // APR = (spread / total hours) * 24 * 365
    // which simplifies to spread / days * 365
    const spreadApr = (spread / totalHours) * 24 * 365;

    rows.push({
      symbol,
      category: classifySymbol(symbol),
      short_exchange: shortEx,
      short_cum_funding: Number(shortData.cumFundingRate.toFixed(8)),
      long_exchange: longEx,
      long_cum_funding: Number(longData.cumFundingRate.toFixed(8)),
      spread: Number(spread.toFixed(8)),
      spread_apr: Number(spreadApr.toFixed(6)),
      short_oi_usd: shortData.lastOi,
      long_oi_usd: longData.lastOi,
      mark_price: shortData.lastPrice
    });
  }

  return rows.sort((a, b) => b.spread - a.spread);
}

/**
 * Computes individual timeseries for graphing
 */
export function computeSeries(hourly: FundingSnapshot[], symbol: string): AggregatedSeries {
  const filtered = hourly.filter(h => h.symbol === symbol).sort((a, b) => a.time.localeCompare(b.time));
  
  const result: AggregatedSeries = {};
  
  for (const h of filtered) {
    if (!result[h.exchange]) {
      result[h.exchange] = { time: [], linear: [], cumulative: [] };
    }
    
    result[h.exchange].time.push(h.time);
    result[h.exchange].linear.push(Number(h.funding_rate_hourly.toFixed(10)));
    
    const cumSum = result[h.exchange].cumulative.length > 0 
      ? result[h.exchange].cumulative[result[h.exchange].cumulative.length - 1] + h.funding_rate_hourly
      : h.funding_rate_hourly;
    result[h.exchange].cumulative.push(Number(cumSum.toFixed(10)));
  }

  return result;
}

/**
 * Run forward test metric gathering
 */
function findRealizedSpread(
  truth: Record<string, number[]>,
  symbol: string,
  shortEx: string,
  longEx: string,
  h0: number,
  h1: number
): number {
  const shortArr = truth[`${symbol}_${shortEx}`];
  const longArr = truth[`${symbol}_${longEx}`];

  if (!shortArr || !longArr) return 0;

  let sumShort = 0;
  let sumLong = 0;
  for (let h = h0; h < h1; h++) {
    if (h < shortArr.length) sumShort += shortArr[h];
    if (h < longArr.length) sumLong += longArr[h];
  }

  return sumShort - sumLong;
}

/**
 * Comprehensive execution of synthetic test suites.
 *
 * `symbols`  : symbol universe used to label the synthetic ranking test (Test B).
 * `realHourly`/`realDays`: the ACTUAL collected/seeded hourly database, so the report
 *               can show a ranking computed on real numbers alongside the synthetic checks.
 */
export function runComprehensiveBacktest(
  symbols?: string[],
  realHourly?: FundingSnapshot[],
  realDays = 14
): BacktestResult {
  const chosenSymbols = (symbols && symbols.length > 0) ? symbols : ["BTC", "ETH", "SOL", "NVDA", "AAPL", "XAU"];

  // Test A: Normalization check. Same underlying, different reporting models.
  const meansA = { hyperliquid: 1e-4, extended: 1e-4, lighter: 1e-4, variational: 1e-4 };
  const snapsA = generateSyntheticSnapshots(["BTC"], meansA, 14, 15, 0.0, 0.0, 0.0).snapshots;
  const aggregatedA = aggregateToHourly(snapsA);
  const spreadsA = computeSpreads(aggregatedA, 14, 0.0);
  const normalizationSpread = spreadsA.length > 0 ? spreadsA[0].spread : 0;
  const passedNormalization = normalizationSpread < 1e-6;

  // Test B: Ranking under persistent spread. Variational high shorts, Lighter deep longs.
  const meansB = { variational: 8e-5, hyperliquid: 1e-5, extended: 0.0, lighter: -3e-5 };
  const snapsB = generateSyntheticSnapshots(chosenSymbols, meansB, 14).snapshots;
  const aggregatedB = aggregateToHourly(snapsB);
  const spreadsB = computeSpreads(aggregatedB, 14, 0.0);

  const rankedSpreads = spreadsB.map(s => ({
    symbol: s.symbol,
    short_exchange: s.short_exchange,
    long_exchange: s.long_exchange,
    spread: s.spread,
    spread_apr: s.spread_apr
  }));

  // Test C: Windowing sweeps (1, 7, 14, 30, 45, 60 days)
  const meansC = { variational: 6e-5, hyperliquid: 1e-5, extended: -1e-5, lighter: -2e-5 };
  // Generate 60 full days of simulation
  const snapsC = generateSyntheticSnapshots(["BTC"], meansC, 60).snapshots;
  const aggregatedC = aggregateToHourly(snapsC);
  
  const windowMetrics = [1, 7, 14, 30, 45, 60].map(d => {
    const filtered = filterByWindow(aggregatedC, d);
    const sw = computeSpreads(filtered, d, 0.0);
    return {
      days: d,
      spread: sw.length > 0 ? sw[0].spread : 0,
      spread_apr: sw.length > 0 ? sw[0].spread_apr : 0
    };
  });

  // Test D: Threshold sensitivity calculation
  // 12 symbols: 6 with healthy spread spreads, 6 flat ones
  const meansReal = { variational: 5e-5, hyperliquid: 1e-5, extended: 0.0, lighter: -2e-5 };
  const meansFlat = { variational: 1e-6, hyperliquid: 0.0, extended: -1e-6, lighter: 5e-7 };
  const symsReal = ["R_BTC", "R_ETH", "R_SOL", "R_NVDA", "R_AAPL", "R_XAU"];
  const symsFlat = ["F_BTC", "F_ETH", "F_SOL", "F_NVDA", "F_AAPL", "F_XAU"];

  const snapsReal = generateSyntheticSnapshots(symsReal, meansReal, 14).snapshots;
  // Use higher volatility and lower averages for flat ones
  const snapsFlat = generateSyntheticSnapshots(symsFlat, meansFlat, 14, 15, 1e-6, 1e-6, 2e-7).snapshots;
  
  const aggregatedD = aggregateToHourly([...snapsReal, ...snapsFlat]);
  const thresholds = [0.0, 0.0005, 0.002, 0.005, 0.01];
  const thresholdMetrics = thresholds.map(thr => {
    const sw = computeSpreads(aggregatedD, 14, thr);
    return {
      threshold: thr,
      passed_count: sw.length
    };
  });

  // Test E: Forward testing predictive strength
  const trainDays = 14;
  const fwdDays = 7;
  const totalDays = 56;
  const forwardSymbols = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11"];
  
  // Give each ticker a persistent exchange spread profile with some random noise
  const forwardSnapshotsList: FundingSnapshot[] = [];
  const forwardTruth: Record<string, number[]> = {};

  for (const s of forwardSymbols) {
    const persistentOffsets: Record<string, number> = {};
    for (const ex of Object.keys(INTERVALS)) {
      persistentOffsets[ex] = randomNormal(0, 4e-5);
    }
    const { snapshots, truthHourly } = generateSyntheticSnapshots([s], persistentOffsets, totalDays);
    forwardSnapshotsList.push(...snapshots);
    Object.assign(forwardTruth, truthHourly);
  }

  const forwardAggregated = aggregateToHourly(forwardSnapshotsList);
  const fwdHours = fwdDays * 24;
  const rebalanceIntervalHours = fwdDays * 24;
  const nRebalances = Math.floor((totalDays - trainDays - fwdDays) / fwdDays) + 1;

  const selSpreads: number[] = [];
  const antiSpreads: number[] = [];
  const allSpreads: number[] = [];

  for (let r = 0; r < nRebalances; r++) {
    const trainStartH = r * rebalanceIntervalHours;
    const trainEndH = trainStartH + trainDays * 24;
    const fwdEndH = trainEndH + fwdHours;

    const t0Time = new Date("2026-01-01T00:00:00Z").getTime();
    const rangeStartISO = new Date(t0Time + trainStartH * 3600 * 1000).toISOString();
    const rangeEndISO = new Date(t0Time + trainEndH * 3600 * 1000).toISOString();

    const winData = forwardAggregated.filter(h => h.time >= rangeStartISO && h.time < rangeEndISO);
    const ranked = computeSpreads(winData, trainDays, 0.0);
    
    if (ranked.length === 0) continue;

    // Pick top and bottom quantiles
    const k = Math.max(1, Math.floor(ranked.length / 4));
    const topGroup = ranked.slice(0, k);
    const bottomGroup = ranked.slice(ranked.length - k);

    for (const item of topGroup) {
      selSpreads.push(findRealizedSpread(forwardTruth, item.symbol, item.short_exchange, item.long_exchange, trainEndH, fwdEndH));
    }
    for (const item of bottomGroup) {
      antiSpreads.push(findRealizedSpread(forwardTruth, item.symbol, item.short_exchange, item.long_exchange, trainEndH, fwdEndH));
    }
    for (const item of ranked) {
      allSpreads.push(findRealizedSpread(forwardTruth, item.symbol, item.short_exchange, item.long_exchange, trainEndH, fwdEndH));
    }
  }

  const computeGroupStats = (arr: number[]) => {
    if (arr.length === 0) return { mean: 0, std: 0, winRate: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sqDiffs = arr.map(v => Math.pow(v - mean, 2));
    const variance = sqDiffs.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(variance);
    const wins = arr.filter(v => v > 0).length;
    return {
      mean,
      std,
      winRate: wins / arr.length
    };
  };

  const selStats = computeGroupStats(selSpreads);
  const allStats = computeGroupStats(allSpreads);
  const antiStats = computeGroupStats(antiSpreads);

  // Real-data ranking: run the SAME spread/normalization engine over the actual
  // collected (or seeded) database, restricted to the chosen symbols. This is the
  // concrete "what is really tested" component, separate from the synthetic checks.
  let realDataRanking: BacktestResult["realDataRanking"] = undefined;
  if (realHourly && realHourly.length > 0) {
    const windowed = filterByWindow(realHourly, realDays);
    const subset = chosenSymbols.length > 0
      ? windowed.filter(h => chosenSymbols.includes(h.symbol))
      : windowed;
    const realRows = computeSpreads(subset, realDays, 0.0);
    realDataRanking = {
      window_days: realDays,
      total_records: subset.length,
      rows: realRows.map(r => ({
        symbol: r.symbol,
        category: (r.category || "crypto") as "crypto" | "equity" | "commodity",
        short_exchange: r.short_exchange,
        long_exchange: r.long_exchange,
        spread: r.spread,
        spread_apr: r.spread_apr
      }))
    };
  }

  return {
    testedSymbols: chosenSymbols,
    symbolCount: chosenSymbols.length,
    passedNormalization,
    normalizationSpread,
    rankedSpreads,
    realDataRanking,
    windowMetrics,
    thresholdMetrics,
    forwardTest: {
      rebalances: nRebalances,
      train_days: trainDays,
      forward_days: fwdDays,
      groups: [
        { name: "Выбранные (топ)", avg_forward_spread: selStats.mean, std_dev: selStats.std, win_rate: selStats.winRate },
        { name: "Все связки", avg_forward_spread: allStats.mean, std_dev: allStats.std, win_rate: allStats.winRate },
        { name: "Анти-выбор (низ)", avg_forward_spread: antiStats.mean, std_dev: antiStats.std, win_rate: antiStats.winRate }
      ]
    }
  };
}
