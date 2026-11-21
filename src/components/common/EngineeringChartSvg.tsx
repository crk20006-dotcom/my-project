import React from 'react';
import type { EngineeringPlotSpec } from '../../types/genesis';

interface EngineeringChartSvgProps {
  chart: EngineeringPlotSpec;
}

export const EngineeringChartSvg: React.FC<EngineeringChartSvgProps> = ({ chart }) => {
  const W = 620;
  const H = 260;
  const padL = 56;
  const padR = 20;
  const padT = 26;
  const padB = 42;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const dx = chart.x_max - chart.x_min || 1;
  const dy = chart.y_max - chart.y_min || 1;

  const mapX = (x: number) => padL + ((x - chart.x_min) / dx) * innerW;
  const mapY = (y: number) => padT + innerH - ((y - chart.y_min) / dy) * innerH;

  const gridTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#0B1018] p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-200">{chart.title}</div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
          {chart.series.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-full inline-block"
                style={{ backgroundColor: s.color }}
              />
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-h-[280px] select-none">
        {gridTicks.map((f) => {
          const yPx = padT + f * innerH;
          const yVal = chart.y_max - f * dy;
          const xPx = padL + f * innerW;
          const xVal = chart.x_min + f * dx;
          return (
            <g key={f}>
              <line x1={padL} y1={yPx} x2={W - padR} y2={yPx} stroke="#1E293B" strokeWidth="1" />
              <text
                x={padL - 6}
                y={yPx + 3}
                textAnchor="end"
                fill="#64748B"
                fontSize="10"
                fontFamily="monospace"
              >
                {Number(yVal.toPrecision(3))}
              </text>
              <line x1={xPx} y1={padT} x2={xPx} y2={H - padB} stroke="#1E293B" strokeWidth="1" />
              <text
                x={xPx}
                y={H - padB + 14}
                textAnchor="middle"
                fill="#64748B"
                fontSize="10"
                fontFamily="monospace"
              >
                {Number(xVal.toPrecision(3))}
              </text>
            </g>
          );
        })}

        {/* Zero reference axis if visible */}
        {chart.y_min < 0 && chart.y_max > 0 && (
          <line
            x1={padL}
            y1={mapY(0)}
            x2={W - padR}
            y2={mapY(0)}
            stroke="#475569"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        )}

        <rect
          x={padL}
          y={padT}
          width={innerW}
          height={innerH}
          fill="none"
          stroke="#334155"
          strokeWidth="1"
        />

        {chart.series.map((s) => {
          if (s.id === 'data') {
            return (
              <g key={s.id}>
                {s.points.map((pt, idx) => (
                  <circle
                    key={`${s.id}-${idx}`}
                    cx={mapX(pt.x)}
                    cy={mapY(pt.y)}
                    r="3.5"
                    fill={s.color}
                  />
                ))}
              </g>
            );
          }
          const d = s.points
            .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${mapX(pt.x).toFixed(2)} ${mapY(pt.y).toFixed(2)}`)
            .join(' ');
          return (
            <path
              key={s.id}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
          );
        })}

        {chart.markers?.map((m, idx) => (
          <g key={`m-${idx}`}>
            <circle cx={mapX(m.x)} cy={mapY(m.y)} r="4.5" fill={m.color || '#34D399'} />
            <text
              x={mapX(m.x) + 6}
              y={mapY(m.y) - 6}
              fill={m.color || '#6EE7B7'}
              fontSize="10.5"
              fontFamily="monospace"
            >
              {m.label}
            </text>
          </g>
        ))}

        <text
          x={padL + innerW / 2}
          y={H - 6}
          textAnchor="middle"
          fill="#94A3B8"
          fontSize="11"
        >
          {chart.x_label}
        </text>
        <text
          x={14}
          y={padT + innerH / 2}
          textAnchor="middle"
          fill="#94A3B8"
          fontSize="11"
          transform={`rotate(-90 14 ${padT + innerH / 2})`}
        >
          {chart.y_label}
        </text>
      </svg>
    </div>
  );
};
