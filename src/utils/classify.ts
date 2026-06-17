/**
 * Ticker category classification.
 *
 * These DEXs (Hyperliquid HIP-3, Variational, Extended, Lighter) are crypto-native
 * venues, so the overwhelming majority of symbols are crypto. A finite, known set of
 * symbols are tokenized US equities / indices / pre-IPO names, and a small set are
 * commodities & precious metals. We default everything to "crypto" and only override
 * when a symbol is on one of the curated lists, or when ticker_map.json declares an
 * explicit asset_class.
 *
 * Sources for the equity / commodity universe (mid-2026): Hyperliquid HIP-3 markets,
 * trade.xyz / Felix / Ventuals deployers, MetaMask Perps equity list.
 */

import tickerMapData from "../ticker_map.json";

const TICKER_MAP: Record<string, any> = tickerMapData;

export type AssetCategory = "crypto" | "equity" | "commodity";

// Tokenized US equities, indices and pre-IPO names offered as perps on these venues.
const EQUITY_SYMBOLS = new Set<string>([
  // Mega-cap tech
  "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "AMD",
  "AVGO", "NFLX", "ORCL", "CRM", "ADBE", "INTC", "MU", "QCOM", "PLTR",
  // Crypto-adjacent equities
  "COIN", "HOOD", "CRCL", "MSTR", "SBET", "BMNR",
  // Other liquid US names that have appeared as tokenized perps
  "BABA", "DIS", "BA", "JPM", "WMT", "NKE", "SHOP", "UBER", "ABNB",
  "PYPL", "SQ", "GME", "AMC", "SPY", "QQQ",
  // Synthetic indices
  "SPX", "SPX500", "SP500", "US500", "NDX", "NAS100", "US100",
  "NASDAQ", "XYZ100", "DJI", "DOW", "RUT",
  // Pre-IPO / private names listed via HIP-3
  "SPACEX", "OPENAI", "ANTHROPIC", "STRIPE", "XAI",
]);

// Commodities & precious metals.
const COMMODITY_SYMBOLS = new Set<string>([
  "XAU", "GOLD",        // gold
  "XAG", "SILVER",      // silver
  "XPT", "PLATINUM",    // platinum
  "XPD", "PALLADIUM",   // palladium
  "WTI", "CRUDE", "OIL", "BRENT", "USOIL", "UKOIL", // oil
  "NATGAS", "NGAS",     // natural gas
  "COPPER",             // copper
]);

/**
 * Strips common quote/perp suffixes so we match on the bare base symbol.
 * e.g. "BTC-USD" -> "BTC", "NVDA-PERP" -> "NVDA", "uAAPL" -> "AAPL".
 */
export function normalizeSymbol(symbol: string): string {
  let clean = (symbol || "").toUpperCase().trim();
  const suffixes = ["-USDT", "-USDC", "-USD", "-PERP", "USDT", "_USDC", "-PERP-USD"];
  for (const s of suffixes) {
    if (clean.endsWith(s)) {
      clean = clean.slice(0, clean.length - s.length);
      break;
    }
  }
  // uAAPL -> AAPL (some venues prefix tokenized equities with "u")
  if (clean.length > 2 && clean.startsWith("U") && !clean.includes("-") && !clean.includes("_")) {
    const after = clean.slice(1);
    if (/^[A-Z]+$/.test(after) && EQUITY_SYMBOLS.has(after)) {
      clean = after;
    }
  }
  return clean;
}

/**
 * Classifies a symbol into crypto / equity / commodity.
 * Precedence: explicit ticker_map asset_class -> curated commodity set ->
 * curated equity set -> default crypto.
 */
export function classifySymbol(symbol: string): AssetCategory {
  const base = normalizeSymbol(symbol);

  // 1. Explicit declaration in ticker_map.json wins.
  const mapEntry = TICKER_MAP[base];
  if (mapEntry && typeof mapEntry.asset_class === "string") {
    const ac = mapEntry.asset_class.toLowerCase();
    if (ac === "commodity" || ac === "metal") return "commodity";
    if (ac === "equity" || ac === "stock" || ac === "index") return "equity";
    if (ac === "crypto") return "crypto";
  }

  // 2. Curated lists.
  if (COMMODITY_SYMBOLS.has(base)) return "commodity";
  if (EQUITY_SYMBOLS.has(base)) return "equity";

  // 3. Default: crypto-native venue, so unknown symbols are crypto.
  return "crypto";
}

/** True when the symbol belongs to the "Stocks / Metals" bucket (equity or commodity). */
export function isStockOrMetal(symbol: string): boolean {
  return classifySymbol(symbol) !== "crypto";
}
