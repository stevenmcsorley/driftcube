"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatLabel(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

const tooltipStyle = {
  background: "rgba(255, 255, 255, 0.98)",
  border: "1px solid rgba(23, 21, 19, 0.1)",
  borderRadius: 14,
  color: "#181614",
  boxShadow: "0 14px 28px rgba(58, 43, 28, 0.08)",
};

const crosshairCursor = {
  stroke: "rgba(24, 22, 20, 0.28)",
  strokeDasharray: "4 6",
  strokeWidth: 1,
};

const legendStyle = {
  paddingTop: 8,
  fontSize: 12,
};

export function SignalTrendChart(props: {
  data: Array<{
    label: string;
    entropy: number;
    pressure: number;
    incidents?: number;
  }>;
}) {
  if (props.data.length === 0) {
    return <p className="muted">Trend data will appear after this surface records memory frames.</p>;
  }

  return (
    <div className="chart-shell">
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={props.data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="rgba(23, 21, 19, 0.08)" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="rgba(110, 104, 98, 0.9)"
            tickLine={false}
            axisLine={false}
            minTickGap={18}
            tickMargin={10}
          />
          <YAxis
            stroke="rgba(110, 104, 98, 0.9)"
            tickLine={false}
            axisLine={false}
            width={34}
          />
          <Tooltip
            cursor={crosshairCursor}
            contentStyle={tooltipStyle}
          />
          <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={legendStyle} />
          <Area type="monotone" dataKey="entropy" stroke="#4d8fb8" fill="rgba(77, 143, 184, 0.12)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} name="Entropy" />
          <Line type="monotone" dataKey="pressure" stroke="#b8862f" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} name="Pressure" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ModulePressureChart(props: {
  data: Array<{
    name: string;
    pressure: number;
    entropy: number;
    aiRisk: number;
  }>;
}) {
  if (props.data.length === 0) {
    return <p className="muted">Module charts appear once component metrics are flowing.</p>;
  }

  return (
    <div className="chart-shell">
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={props.data} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 8 }} barGap={6} barCategoryGap={14}>
          <CartesianGrid stroke="rgba(23, 21, 19, 0.08)" horizontal={false} />
          <XAxis
            type="number"
            stroke="rgba(110, 104, 98, 0.9)"
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tickFormatter={formatLabel}
            width={104}
            stroke="rgba(110, 104, 98, 0.9)"
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(24, 22, 20, 0.04)" }}
            contentStyle={tooltipStyle}
          />
          <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={legendStyle} />
          <Bar dataKey="pressure" fill="#b8862f" radius={[0, 8, 8, 0]} name="Pressure" />
          <Bar dataKey="entropy" fill="#4d8fb8" radius={[0, 8, 8, 0]} name="Entropy" />
          <Bar dataKey="aiRisk" fill="#5d8d70" radius={[0, 8, 8, 0]} name="AI Risk" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LanguageCoverageChart(props: {
  data: Array<{
    language: string;
    watchedOnlyEvents: number;
    fullPipelineEvents: number;
  }>;
}) {
  if (props.data.length === 0) {
    return <p className="muted">Coverage charts appear after this surface sees file activity.</p>;
  }

  return (
    <div className="chart-shell">
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={props.data} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 8 }}>
          <CartesianGrid stroke="rgba(23, 21, 19, 0.08)" horizontal={false} />
          <XAxis type="number" stroke="rgba(110, 104, 98, 0.9)" tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="language"
            width={90}
            stroke="rgba(110, 104, 98, 0.9)"
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(24, 22, 20, 0.04)" }}
            contentStyle={tooltipStyle}
          />
          <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={legendStyle} />
          <Bar dataKey="fullPipelineEvents" stackId="coverage" fill="#5d8d70" radius={[0, 10, 10, 0]} name="Full Analysis" />
          <Bar dataKey="watchedOnlyEvents" stackId="coverage" fill="#c06d65" radius={[0, 10, 10, 0]} name="Watched Only" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
