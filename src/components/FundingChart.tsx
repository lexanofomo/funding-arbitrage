import React, { useMemo, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { AggregatedSeries } from "../types";

const EXCHANGES = ["hyperliquid", "variational", "extended", "lighter"] as const;
type Exchange = (typeof EXCHANGES)[number];

const COLORS: Record<Exchange, { stroke: string; fill: string }> = {
  hyperliquid: { stroke: "#10B981", fill: "rgba(16, 185, 129, 0.10)" },
  variational: { stroke: "#3B82F6", fill: "rgba(59, 130, 246, 0.10)" },
  extended: { stroke: "#F59E0B", fill: "rgba(245, 158, 11, 0.10)" },
  lighter: { stroke: "#EC4899", fill: "rgba(236, 72, 153, 0.10)" },
};

interface Props {
  chartData: AggregatedSeries | null;
  visibleExchanges: Record<string, boolean>;
  chartMode: "linear" | "cumulative";
  selectedSymbol: string;
  height?: number;
}

const fmtPct = (v: number) => `${(v * 100).toFixed(4)}%`;

export default function FundingChart({
  chartData,
  visibleExchanges,
  chartMode,
  selectedSymbol,
  height = 240,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // ---- Geometry -------------------------------------------------------
  const width = 600;
  const paddingLeft = 65;
  const paddingRight = 15;
  const paddingTop = 15;
  const paddingBottom = 35;
  const graphWidth = width - paddingLeft - paddingRight;
  const graphHeight = height - paddingTop - paddingBottom;

  // ---- Build the plot model (memoized, fully guarded) -----------------
  const model = useMemo(() => {
    if (!chartData || Object.keys(chartData).length === 0) return null;

    const combined = new Set<string>();
    EXCHANGES.forEach((ex) => {
      if (visibleExchanges[ex] && chartData[ex]) {
        chartData[ex].time.forEach((t) => combined.add(t));
      }
    });
    const sortedTimes = Array.from(combined).sort();
    if (sortedTimes.length === 0) return { sortedTimes, empty: true } as const;

    // Y bounds across visible series
    let gMin = Infinity;
    let gMax = -Infinity;
    EXCHANGES.forEach((ex) => {
      if (visibleExchanges[ex] && chartData[ex]) {
        (chartData[ex][chartMode] || []).forEach((r) => {
          if (r < gMin) gMin = r;
          if (r > gMax) gMax = r;
        });
      }
    });
    if (gMin === Infinity) gMin = -0.001;
    if (gMax === -Infinity) gMax = 0.001;
    if (gMin === gMax) {
      gMin -= 0.0001;
      gMax += 0.0001;
    }
    const range = gMax - gMin;
    const paddedMin = gMin - range * 0.08;
    const paddedMax = gMax + range * 0.08;

    // Per-exchange value aligned to the unified time axis (null = gap at that time)
    const aligned: Record<string, (number | null)[]> = {};
    EXCHANGES.forEach((ex) => {
      if (!visibleExchanges[ex] || !chartData[ex]) return;
      const idxByTime = new Map<string, number>();
      chartData[ex].time.forEach((t, i) => idxByTime.set(t, i));
      aligned[ex] = sortedTimes.map((t) => {
        const i = idxByTime.get(t);
        return i === undefined ? null : chartData[ex][chartMode][i];
      });
    });

    return { sortedTimes, paddedMin, paddedMax, aligned, empty: false } as const;
  }, [chartData, visibleExchanges, chartMode]);

  // ---- Empty / no-selection states ------------------------------------
  if (!model) {
    return (
      <div
        style={{ height }}
        className="flex flex-col items-center justify-center text-slate-500 font-mono text-xs gap-2"
      >
        <AlertCircle className="w-5 h-5 text-amber-500/80" />
        Нет данных по {selectedSymbol} за выбранный период.
        <span className="text-[10px] text-slate-600">Нажмите «Провести сбор данных» или смените тикер.</span>
      </div>
    );
  }
  if (model.empty) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-slate-500 font-mono text-xs text-center px-4"
      >
        Включите хотя бы одну биржу в легенде, чтобы построить кривые.
      </div>
    );
  }

  const { sortedTimes, paddedMin, paddedMax, aligned } = model;
  const n = sortedTimes.length;
  const paddedRange = paddedMax - paddedMin || 1;

  // Coordinate mappers — guarded against the single-point divide-by-zero
  // that previously produced NaN paths and a blank chart after data collection.
  const getX = (index: number) => {
    if (n <= 1) return paddingLeft + graphWidth / 2;
    return paddingLeft + (index / (n - 1)) * graphWidth;
  };
  const getY = (val: number) => paddingTop + (1 - (val - paddedMin) / paddedRange) * graphHeight;

  // ---- Lines / areas / single-point dots ------------------------------
  const seriesNodes = EXCHANGES.map((ex) => {
    const vals = aligned[ex];
    if (!vals) return null;

    const pts = vals
      .map((v, i) => (v === null ? null : { x: getX(i), y: getY(v), i }))
      .filter((p): p is { x: number; y: number; i: number } => p !== null);
    if (pts.length === 0) return null;

    // Single real point: draw a dot instead of a (broken) zero-length line.
    if (pts.length === 1) {
      return (
        <circle key={ex} cx={pts[0].x} cy={pts[0].y} r={3.5} fill={COLORS[ex].stroke} />
      );
    }

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;

    let areaD = "";
    if (chartMode === "cumulative") {
      const baseY = getY(Math.max(paddedMin, Math.min(paddedMax, 0)));
      areaD = `${d} L ${pts[pts.length - 1].x} ${baseY} L ${pts[0].x} ${baseY} Z`;
    }

    return (
      <g key={ex}>
        {areaD && <path d={areaD} fill={COLORS[ex].fill} />}
        <path
          d={d}
          stroke={COLORS[ex].stroke}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  });

  // ---- Grid + axis labels ---------------------------------------------
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }).map((_, i) => {
    const val = paddedMin + (i / gridCount) * paddedRange;
    const y = getY(val);
    return (
      <g key={i} opacity={0.4}>
        <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="#1e293b" strokeWidth={1} />
        <text x={paddingLeft - 8} y={y + 4} textAnchor="end" className="fill-slate-400 font-mono" fontSize={9}>
          {(val * 100).toFixed(4)}%
        </text>
      </g>
    );
  });

  const timeLabels = (() => {
    if (n < 2) {
      const t = new Date(sortedTimes[0]);
      return (
        <text x={getX(0)} y={height - 12} textAnchor="middle" className="fill-slate-500 font-mono" fontSize={9} opacity={0.7}>
          {t.toLocaleDateString("ru-RU", { month: "short", day: "numeric", hour: "2-digit" })}
        </text>
      );
    }
    const indices = [0, Math.floor(n / 2), n - 1];
    return indices.map((idx) => {
      const t = new Date(sortedTimes[idx]);
      return (
        <text
          key={idx}
          x={getX(idx)}
          y={height - 12}
          textAnchor={idx === 0 ? "start" : idx === indices[2] ? "end" : "middle"}
          className="fill-slate-500 font-mono"
          fontSize={9}
          opacity={0.7}
        >
          {t.toLocaleDateString("ru-RU", { month: "short", day: "numeric", hour: "2-digit" })}
        </text>
      );
    });
  })();

  // ---- Pointer interaction --------------------------------------------
  const handleMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * width; // into viewBox units
    if (n === 1) {
      setHoverIdx(0);
      return;
    }
    const ratio = (vbX - paddingLeft) / graphWidth;
    let idx = Math.round(ratio * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHoverIdx(idx);
  };

  // ---- Hover readout (values + deviation from cross-exchange mean) ----
  const hover = useMemo(() => {
    if (hoverIdx === null) return null;
    const entries: { ex: Exchange; val: number }[] = [];
    EXCHANGES.forEach((ex) => {
      const v = aligned[ex]?.[hoverIdx];
      if (v !== null && v !== undefined) entries.push({ ex, val: v });
    });
    if (entries.length === 0) return null;
    const mean = entries.reduce((s, e) => s + e.val, 0) / entries.length;
    const maxV = Math.max(...entries.map((e) => e.val));
    const minV = Math.min(...entries.map((e) => e.val));
    return {
      time: sortedTimes[hoverIdx],
      x: getX(hoverIdx),
      entries: entries.map((e) => ({ ...e, dev: e.val - mean })),
      mean,
      spread: maxV - minV,
    };
  }, [hoverIdx, aligned, sortedTimes, n, paddedMin, paddedMax]);

  // Tooltip horizontal placement (% of container), flipped near the right edge
  const tooltipLeftPct = hover ? (hover.x / width) * 100 : 0;
  const flip = tooltipLeftPct > 62;

  return (
    <div className="relative w-full select-none" style={{ minHeight: height }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="100%"
        className="overflow-visible touch-none"
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={(e) => e.touches[0] && handleMove(e.touches[0].clientX)}
        onTouchMove={(e) => e.touches[0] && handleMove(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIdx(null)}
      >
        {gridLines}
        {seriesNodes}

        {/* X axis baseline */}
        <line
          x1={paddingLeft}
          y1={height - paddingBottom}
          x2={width - paddingRight}
          y2={height - paddingBottom}
          stroke="#334155"
          strokeWidth={1.5}
        />
        {timeLabels}

        {/* Hover crosshair + per-series dots */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.x}
              y1={paddingTop}
              x2={hover.x}
              y2={height - paddingBottom}
              stroke="#64748b"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {hover.entries.map((e) => (
              <circle key={e.ex} cx={hover.x} cy={getY(e.val)} r={3.5} fill={COLORS[e.ex].stroke} stroke="#0b101b" strokeWidth={1.5} />
            ))}
          </g>
        )}
      </svg>

      {/* Tooltip */}
      {hover && (
        <div
          className="absolute z-20 pointer-events-none bg-[#0b101b] border border-slate-800 rounded-lg shadow-xl px-3 py-2 font-mono text-[10px] min-w-[164px]"
          style={{
            left: `${flip ? tooltipLeftPct - 2 : tooltipLeftPct + 2}%`,
            top: 4,
            transform: flip ? "translateX(-100%)" : "none",
          }}
        >
          <div className="text-slate-400 border-b border-slate-800 pb-1 mb-1.5">
            {new Date(hover.time).toLocaleString("ru-RU", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
          {hover.entries
            .slice()
            .sort((a, b) => b.val - a.val)
            .map((e) => (
              <div key={e.ex} className="flex items-center justify-between gap-3 leading-relaxed">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: COLORS[e.ex].stroke }} />
                  <span className="capitalize text-slate-300">{e.ex}</span>
                </span>
                <span className="text-right">
                  <span className="text-white font-semibold">{fmtPct(e.val)}</span>
                  <span className={`ml-1.5 ${e.dev >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {e.dev >= 0 ? "+" : ""}
                    {(e.dev * 100).toFixed(4)}%
                  </span>
                </span>
              </div>
            ))}
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 mt-1.5 pt-1.5 text-slate-400">
            <span>Спред (max−min)</span>
            <span className="text-emerald-400 font-semibold">{fmtPct(hover.spread)}</span>
          </div>
          <div className="text-[9px] text-slate-600 mt-0.5">
            «Отклонение» — разница ставки и среднего по биржам в этой точке.
          </div>
        </div>
      )}
    </div>
  );
}
