/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch — core/history.js
 * Lightweight download history helpers. Pure functions.
 */

export const MAX_RECORDS = 200;

/**
 * Record: { id, filename, site, pageHost, format, width, height, bytes, at, kind }
 * kind: 'single' | 'bulk' | 'screenshot'
 * bytes: actual on-disk file size measured at download completion (0 = unknown,
 * e.g. records written before this field existed).
 */
export function addRecord(records, record) {
  const list = Array.isArray(records) ? [...records] : [];
  list.unshift({
    id: record.id || `h${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    filename: String(record.filename || 'image').slice(0, 180),
    site: String(record.site || '').slice(0, 120),
    pageHost: String(record.pageHost || '').slice(0, 253),
    format: String(record.format || '').slice(0, 12),
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    bytes: Math.max(0, Math.round(Number(record.bytes) || 0)),
    at: Number(record.at) || Date.now(),
    kind: ['single', 'bulk', 'screenshot'].includes(record.kind) ? record.kind : 'single',
  });
  return list.slice(0, MAX_RECORDS);
}

/** Drop records older than retentionDays. */
export function pruneRecords(records, retentionDays = 30) {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  return (records || []).filter((r) => (r.at || 0) >= cutoff).slice(0, MAX_RECORDS);
}

function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Group records into [{key,label,items}] newest day first. */
export function groupByDay(records) {
  const groups = new Map();
  for (const r of records || []) {
    const key = dayKey(r.at || Date.now());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, items]) => ({
      key,
      label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : formatDay(key),
      count: items.length,
      items,
    }));
}

function formatDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
