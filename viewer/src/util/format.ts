const grouped = new Intl.NumberFormat("en-US");

/** 231231 → `231,231` */
export function n(value: number): string {
  return grouped.format(Math.round(value));
}

/** 3210000 → `3.21M` · 47615 → `47.6K` */
export function compact(value: number): string {
  const v = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e5) return `${sign}${Math.round(v / 1e3)}K`;
  if (v >= 1e3) return `${sign}${(v / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(v)}`;
}

export function bytes(value: number): string {
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(2)} MB`;
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

export function ago(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  if (mins < 1) return "JUST NOW";
  if (mins < 60) return `${mins} MIN AGO`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} HR AGO`;
  return `${Math.round(hours / 24)} DAY AGO`;
}

export function year(ts: number): number {
  return new Date(ts * 1000).getUTCFullYear();
}
