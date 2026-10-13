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
 * ImgFetch — core/urls.js
 * Pure URL helpers shared by background, popup and options.
 * No chrome.* dependencies so this module is unit-testable in Node.
 */

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff',
]);

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:']);

/**
 * Resolve a possibly-relative URL against a base and return a normalized
 * absolute URL string, or null when it cannot be used safely.
 */
/**
 * L12: data: URL size limits — one per path, documented here (not unified,
 * because the paths have genuinely different needs):
 * - Scanner discovery uses SCAN_DATA_URL_MAX (2 MB, in content/scanner.js).
 *   Scan results travel through extension messaging; keep them small.
 * - Download resolution uses DATA_URL_DOWNLOAD_MAX (30 MB, below). Page
 *   blob: URLs resolved in-page arrive as data URLs and are routinely
 *   several MB (e.g. GIFs); rejecting them would break real downloads.
 */
export const DATA_URL_DOWNLOAD_MAX = 30_000_000;
export function normalizeUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 8192) return null;
  let url;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === 'data:') {
    // Only allow image data URLs; cap length to avoid memory blowups.
    if (!/^data:image\//i.test(value.slice(0, 64))) return null;
    if (value.length > DATA_URL_DOWNLOAD_MAX) return null;
    return value;
  }
  if (url.protocol === 'blob:') {
    // Page blob URLs (Giphy/Tenor media, editors) — resolved in-page to a
    // data URL by the service worker before downloading.
    return value;
  }
  // Reject credentials in URL and non-default weirdness.
  if (url.username || url.password) return null;
  url.hash = '';
  // Normalize host case.
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

/** True when ImgFetch is allowed to attempt a download/conversion of this URL. */
export function getExtensionFromUrl(raw, base) {
  const normalized = normalizeUrl(raw, base);
  if (!normalized || normalized.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9+.-]+)/i.exec(raw || '');
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  }
  try {
    const path = new URL(normalized).pathname;
    const last = path.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot > 0 && dot < last.length - 1) {
      const ext = last.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (IMAGE_EXTENSIONS.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Parse a srcset attribute into [{url, kind:'w'|'x'|'none', value}].
 * Malformed entries are skipped.
 */
export function parseSrcset(srcset) {
  if (typeof srcset !== 'string' || !srcset.trim()) return [];
  const out = [];
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const url = tokens[0];
    let kind = 'none';
    let value = 0;
    if (tokens[1]) {
      const m = /^(\d+(?:\.\d+)?)(w|x)$/.exec(tokens[1]);
      if (m) {
        kind = m[2];
        value = parseFloat(m[1]);
      }
    }
    out.push({ url, kind, value });
  }
  return out;
}

/**
 * Canonical host for site-preference matching (H9): lowercase, no port,
 * no trailing dot, leading "www." stripped. Single source of truth used
 * by the options page and the service worker so both sides always agree.
 */
export function normalizeHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  h = h.replace(/:\d+$/, '');
  h = h.replace(/\.$/, '');
  h = h.replace(/^www\./, '');
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) ? h : '';
}

/**
 * True when the URL targets a private network: loopback, link-local,
 * RFC-1918 / unique-local / CGNAT addresses, or internal hostnames
 * (M7, B2). Extension-privileged fetches (no CORS) must not hit these
 * unless the page itself is on that host — a malicious page could
 * otherwise make the browser GET internal URLs.
 *
 * B2: IPv6 is parsed properly (not string prefixes): IPv4-mapped
 * ::ffff:a.b.c.d forms are converted back to IPv4 and re-checked,
 * "::" (unspecified) is blocked, 100.64.0.0/10 (CGNAT) is blocked,
 * and .local/.internal/.lan/.home.arpa plus single-label hostnames
 * (router, printer, intranet) count as private.
 */
/** Single source of truth for the IPv4 private ranges (N1-pattern: one rule,
 *  one place — used for dotted IPv4 and for IPv4 embedded in IPv6). */
function isPrivateIPv4Octets(a, b) {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

export function isPrivateNetworkUrl(raw) {
  let host = '';
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return isPrivateIPv4Octets(+v4[1], +v4[2]);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIPv6(host.slice(1, -1));
  }
  // Single-label hostnames (printer, intranet, router) resolve through
  // local DNS / search domains — treat them as internal.
  if (host && !host.includes('.') && !host.includes(':')) return true;
  return false;
}

/** Parse an IPv6 literal (no brackets) into eight 16-bit groups, or null. */
function parseIPv6(host) {
  let h = String(host).toLowerCase();
  const pct = h.indexOf('%'); // zone id, e.g. fe80::1%eth0
  if (pct !== -1) h = h.slice(0, pct);
  if (!/^[0-9a-f:.]+$/.test(h)) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const expandHalf = (half) => {
    if (!half) return [];
    const out = [];
    for (const g of half.split(':')) {
      if (g.includes('.')) {
        // Embedded IPv4: ::ffff:192.0.2.1
        const m = g.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!m) return null;
        const n = m.slice(1).map(Number);
        if (n.some((x) => x > 255)) return null;
        out.push(((n[0] << 8) | n[1]) >>> 0, ((n[2] << 8) | n[3]) >>> 0);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const head = expandHalf(halves[0]);
  const tail = halves.length === 2 ? expandHalf(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 0) return null;
    return [...head, ...new Array(zeros).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** True when an IPv6 literal targets a private/loopback address. */
function isPrivateIPv6(host) {
  const g = parseIPv6(host);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // :: (unspecified)
  const isLoopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1; // ::1
  if (isLoopback) return true;
  // N3: extract an embedded IPv4 and re-check it against the single
  // IPv4 private-range rule.
  const embeddedV4 = (hi, lo) => {
    const n = ((hi & 0xffff) * 65536 + (lo & 0xffff)) >>> 0;
    return isPrivateIPv4Octets((n >>> 24) & 255, (n >>> 16) & 255);
  };
  // IPv4-mapped ::ffff:0:0/96.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return embeddedV4(g[6], g[7]);
  }
  // N3: IPv4-compatible ::/96 (first 96 bits zero, e.g. ::7f00:1).
  if (g.slice(0, 6).every((x) => x === 0)) {
    return embeddedV4(g[6], g[7]);
  }
  // N3: NAT64 64:ff9b::/96 — the last 32 bits are the IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return embeddedV4(g[6], g[7]);
  }
  // N3: 6to4 2002::/16 — bits 16..47 are the IPv4 address.
  if (g[0] === 0x2002) {
    return embeddedV4(g[1], g[2]);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * B2: one shared "should this extension-privileged fetch be blocked?"
 * check. Same-host exception lives here so the worker, the offscreen
 * document and the info page all apply the identical rule.
 */
export function isPrivateNetworkFetchBlocked(url, pageUrl) {
  if (!isPrivateNetworkUrl(url)) return false;
  try {
    const u = new URL(String(url));
    const p = new URL(String(pageUrl || ''));
    const norm = (h) => h.toLowerCase().replace(/\.$/, '');
    if (norm(u.hostname) && norm(u.hostname) === norm(p.hostname)) {
      return false; // same private host as the page — the user's own intranet
    }
  } catch {
    /* fall through to blocked */
  }
  return true;
}

/**
 * J1: Google Lens safety guard. Returns a NOTICE code when the image URL
 * must NOT be sent to Google, or null when it may be sent. Page-local
 * data:/blob: URLs are meaningless to Lens; private-network URLs
 * (intranet/localhost) must never leave the local network.
 */
export function lensUrlBlocked(imageUrl, pageUrl) {
  const lower = String(imageUrl || '').toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return 'bad-url';
  if (isPrivateNetworkFetchBlocked(imageUrl, pageUrl)) return 'private-network';
  return null;
}

/**
 * M1: one consistent rule for folder naming — the registrable domain
 * without a leading "www.", TLD kept (so example.com and example.org
 * never collide, and www.example.com matches example.com).
 * e.g. "images.example.co.uk" -> "example.co.uk". Best-effort, no PSL.
 */
export function getHostLabel(raw, base) {
  const normalized = normalizeUrl(raw, base);
  if (!normalized || normalized.startsWith('data:')) return 'download';
  try {
    let host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    host = host.replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.') || 'download';
    // Heuristic for common two-part public suffixes.
    const twoPartSuffix = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2,}$/.test(
      parts.slice(-2).join('.'),
    );
    const take = twoPartSuffix ? 3 : 2;
    return parts.slice(-take).join('.') || 'download';
  } catch {
    return 'download';
  }
}

/** Extract a filename hint from a URL path (unsanitized). */
export function filenameHintFromUrl(raw, base) {
  const normalized = normalizeUrl(raw, base);
  if (!normalized) return '';
  if (normalized.startsWith('data:')) return 'image';
  try {
    const path = new URL(normalized).pathname;
    const last = decodeURIComponent(path.split('/').pop() || '');
    return last.split('?')[0].split('#')[0];
  } catch {
    return '';
  }
}

