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
 * ImgFetch — core/folders.js
 * Smart folder resolution. Pure functions (no chrome.*) so the toggle logic
 * is unit-testable.
 */
import { getHostLabel } from './urls.js';

/** Smart folders: file-type bucket for the 'type' organize mode. */
export function typeFolderFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'gif') return 'GIFs';
  if (e === 'png') return 'Screenshots';
  if (['jpg', 'jpeg', 'webp', 'avif'].includes(e)) return 'Photos';
  return 'Graphics';
}

/**
 * Resolve the download subfolder from the organize mode.
 *
 * The subfolder is a master-switched root: when `settings.useSubfolder` is
 * off the name is ignored entirely (even if text is present) and the
 * organize mode alone decides. When on, the name prefixes the mode folder:
 * `img/example.com`, `img/Photos`, `img/2026-10-12`, or just `img`.
 */
export function resolveFolder(settings, pageUrl, url, ext) {
  const s = settings || {};
  const mode = s.folderMode || (s.organizeBySite ? 'site' : 'flat');
  const raw = String(s.subfolder || '').trim().replace(/^\/+|\/+$/g, '');
  const base = s.useSubfolder ? raw : '';
  if (mode === 'site') {
    const host = getHostLabel(pageUrl || url);
    return [base, host].filter(Boolean).join('/');
  }
  if (mode === 'type') return [base, typeFolderFor(ext)].filter(Boolean).join('/');
  if (mode === 'date') {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [base, day].filter(Boolean).join('/');
  }
  return base;
}
