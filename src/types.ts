/**
 * Shared types for the Funding Arbitrage Scanner
 */

export interface FundingSnapshot {
  exchange: string;
  symbol: string;             // Internal normalized format: BTC, ETH, etc.
  funding_rate: number;       // Raw rate as reported by the exchange
  funding_interval_s: number; // Funding interval in seconds (3600 for HL/Lighter/Extended, 28800 for Variational)
  funding_rate_hourly: number;// Normalized hourly rate: funding_rate / (interval_s / 3600)
  mark_price: number | null;
  oi_usd: number | null;
  volume_24h_usd: number | null;
  time: string;               // ISO Timestamp
}

export interface ArbitrageSpreadRow {
  symbol: string;
  category?: "crypto" | "equity" | "commodity";
  short_exchange: string;
  short_cum_funding: number;
  long_exchange: string;
  long_cum_funding: number;
  spread: number;             // Yield spread over selected window
  spread_apr: number;         // Projected Annual Percentage Rate
  short_oi_usd: number | null;
  long_oi_usd: number | null;
  mark_price: number | null;
}

export interface ChartPoint {
  time: string;
  [exchange: string]: number | string; // maps exchange name to current rate or cumulative sum
}

export interface ExchangeSeriesData {
  time: string[];
  linear: number[];
  cumulative: number[];
}

export interface AggregatedSeries {
  [exchange: string]: ExchangeSeriesData;
}

export interface BacktestResult {
  // Which symbols were fed into the synthetic ranking test, and how many.
  testedSymbols: string[];
  symbolCount: number;
  passedNormalization: boolean;
  normalizationSpread: number;
  rankedSpreads: Array<{
    symbol: string;
    short_exchange: string;
    long_exchange: string;
    spread: number;
    spread_apr: number;
  }>;
  // Ranking computed on the ACTUAL collected/seeded historical data (not synthetic),
  // so it is clear what is being tested against real numbers in the database.
  realDataRanking?: {
    window_days: number;
    total_records: number;
    rows: Array<{
      symbol: string;
      category: "crypto" | "equity" | "commodity";
      short_exchange: string;
      long_exchange: string;
      spread: number;
      spread_apr: number;
    }>;
  };
  windowMetrics: Array<{
    days: number;
    spread: number;
    spread_apr: number;
  }>;
  thresholdMetrics: Array<{
    threshold: number;
    passed_count: number;
  }>;
  forwardTest: {
    rebalances: number;
    train_days: number;
    forward_days: number;
    groups: Array<{
      name: string;
      avg_forward_spread: number;
      std_dev: number;
      win_rate: number;
    }>;
  };
}
