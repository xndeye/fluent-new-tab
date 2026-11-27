/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { launcherBookmarks } from '@/core/shared/dom-refs';
import { checkApiPermission, requestApiPermission } from '@/core/shared/permissions';

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode & { type?: 'bookmark' | 'folder' | 'separator' };

const expandedFolderIds = new Set<string>();
let initialized = false;
let active = false;
let revision = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let detachBookmarkListeners: (() => void) | null = null;
let savedScrollTop = 0;

function translate(key: string, fallback: string): string {
  const win = window as Window & { getTranslation?: (key: string, fallback: string) => string };
  return win.getTranslation?.(key, fallback) || fallback;
}

function createIcon(symbol: string, className = 'bookmark-icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', symbol);
  svg.appendChild(use);
  return svg;
}

function getSafeBookmarkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'ftp:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function createLinkIcon(url: string | null): SVGSVGElement | HTMLImageElement {
  const fallback = createIcon('#icon-link');
  if (!url || !/^https?:/i.test(url) || !chrome.runtime.getManifest().permissions?.includes('favicon')) {
    return fallback;
  }

  const image = document.createElement('img');
  const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
  favicon.searchParams.set('pageUrl', url);
  favicon.searchParams.set('size', '16');
  image.className = 'bookmark-icon';
  image.alt = '';
  image.loading = 'lazy';
  image.draggable = false;
  image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
  image.src = favicon.href;
  return image;
}

function createLabel(title: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'bookmark-label';
  label.textContent = title;
  return label;
}

function createList(nodes: BookmarkNode[], depth = 0): HTMLUListElement {
  const list = document.createElement('ul');
  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(createNode(node, depth));
  list.appendChild(fragment);
  return list;
}

function createNode(node: BookmarkNode, depth: number): HTMLLIElement {
  const item = document.createElement('li');
  if (node.type === 'separator') {
    const separator = document.createElement('hr');
    separator.className = 'bookmark-separator';
    item.appendChild(separator);
    return item;
  }

  const title = node.title || node.url || translate('folderNameLabel', 'Folder');
  const indent = 0.45 + Math.min(depth, 8) * 0.875;

  if (node.url !== undefined) {
    const url = getSafeBookmarkUrl(node.url);
    const row = url ? document.createElement('a') : document.createElement('span');
    row.className = 'bookmark-row';
    row.dataset.bookmarkId = node.id;
    row.style.paddingInlineStart = `${indent + 1.45}rem`;
    row.title = title;
    if (row instanceof HTMLAnchorElement && url) {
      row.href = url;
      row.draggable = false;
      row.rel = 'noopener noreferrer';
    } else {
      row.setAttribute('aria-disabled', 'true');
      row.title = `${title} — ${translate('bookmarksUnsupported', 'This bookmark cannot be opened.')}`;
    }
    row.append(createLinkIcon(url), createLabel(title));
    item.appendChild(row);
    return item;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bookmark-row';
  button.dataset.bookmarkId = node.id;
  button.style.paddingInlineStart = `${indent}rem`;
  button.title = title;
  button.append(createIcon('#icon-chevron-down-small', 'bookmark-chevron'), createIcon('#icon-folder'), createLabel(title));
  item.appendChild(button);

  let children: HTMLUListElement | null = null;
  const updateExpanded = () => {
    const expanded = expandedFolderIds.has(node.id);
    button.setAttribute('aria-expanded', String(expanded));
    if (expanded && !children) {
      children = createList(node.children || [], depth + 1);
      item.appendChild(children);
    }
    if (children) children.hidden = !expanded;
  };
  button.addEventListener('click', () => {
    if (expandedFolderIds.has(node.id)) expandedFolderIds.delete(node.id);
    else expandedFolderIds.add(node.id);
    updateExpanded();
  });
  updateExpanded();
  return item;
}

function renderTree(nodes: BookmarkNode[]): void {
  if (!launcherBookmarks) return;
  // Keep the browser's real top-level folders, omitting only the synthetic root.
  const roots = nodes.flatMap((root) => root.children || []);
  const folderIds = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.url === undefined && node.type !== 'separator') {
      folderIds.add(node.id);
      for (const child of node.children || []) pending.push(child);
    }
  }
  for (const id of expandedFolderIds) {
    if (!folderIds.has(id)) expandedFolderIds.delete(id);
  }
  if (!initialized) {
    const first = roots.find((node) => node.url === undefined && node.children?.length);
    if (first) expandedFolderIds.add(first.id);
    initialized = true;
  }

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.bookmarkId : undefined;
  const scrollTop = launcherBookmarks.querySelector('ul') ? launcherBookmarks.scrollTop : savedScrollTop;
  if (roots.length) launcherBookmarks.replaceChildren(createList(roots));
  else showStatus('bookmarksEmpty', 'No bookmarks');
  launcherBookmarks.scrollTop = scrollTop;
  if (focused) {
    launcherBookmarks.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(focused)}"]`)?.focus({
      preventScroll: true,
    });
  }
}

function showStatus(key: string, fallback: string, requestAccess = false): void {
  if (!launcherBookmarks) return;
  const status = document.createElement('div');
  status.className = 'bookmark-status';
  const message = document.createElement('span');
  message.dataset.i18n = key;
  message.textContent = translate(key, fallback);
  message.setAttribute('role', 'status');
  status.appendChild(message);
  if (requestAccess) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.i18n = 'grantPermissionLabel';
    button.textContent = translate('grantPermissionLabel', 'Grant Permission');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const granted = await requestApiPermission(['bookmarks']);
      if (!active) return;
      if (granted) void refreshBookmarkTree();
      else button.disabled = false;
    });
    status.appendChild(button);
  }
  launcherBookmarks.replaceChildren(status);
}

function scheduleRefresh(): void {
  if (!active) return;
  ++revision;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshBookmarkTree();
  }, 80);
}

function attachBookmarkListeners(): void {
  if (detachBookmarkListeners) return;
  const api = chrome.bookmarks;
  const events = [api.onCreated, api.onRemoved, api.onChanged, api.onMoved, api.onChildrenReordered, api.onImportEnded];
  const removers: (() => void)[] = [];
  detachBookmarkListeners = () => {
    for (const remove of removers) {
      try {
        remove();
      } catch {}
    }
    detachBookmarkListeners = null;
  };
  try {
    for (const event of events) {
      if (!event) continue;
      event.addListener(scheduleRefresh);
      removers.push(() => event.removeListener(scheduleRefresh));
    }
  } catch (error) {
    detachBookmarkListeners();
    throw error;
  }
}

function onPermissionAdded(permissions: chrome.permissions.Permissions): void {
  if (permissions.permissions?.includes('bookmarks')) scheduleRefresh();
}

function onPermissionRemoved(permissions: chrome.permissions.Permissions): void {
  if (!permissions.permissions?.includes('bookmarks')) return;
  ++revision;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
  detachBookmarkListeners?.();
  showStatus('permissionRequiredTitle', 'Permission Required', true);
}

async function refreshBookmarkTree(): Promise<void> {
  if (!active || !launcherBookmarks) return;
  const requestId = ++revision;
  try {
    const granted = await checkApiPermission(['bookmarks']);
    if (!active || requestId !== revision) return;
    if (!granted || !chrome.bookmarks?.getTree) {
      detachBookmarkListeners?.();
      showStatus('permissionRequiredTitle', 'Permission Required', true);
      return;
    }

    // Subscribe before taking the snapshot so changes during a read are not missed.
    attachBookmarkListeners();
    const nodes = await new Promise<BookmarkNode[]>((resolve, reject) => {
      chrome.bookmarks.getTree((tree) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(tree);
      });
    });
    if (!active || requestId !== revision) return;
    renderTree(nodes);
  } catch (error) {
    if (!active || requestId !== revision) return;
    console.error('Error reading bookmarks:', error);
    showStatus('bookmarksLoadError', 'Unable to load bookmarks');
  }
}

export function openBookmarkView(): void {
  if (active || !launcherBookmarks) return;
  active = true;
  showStatus('bookmarksLoading', 'Loading bookmarks…');
  chrome.permissions?.onAdded?.addListener(onPermissionAdded);
  chrome.permissions?.onRemoved?.addListener(onPermissionRemoved);
  void refreshBookmarkTree();
}

export function closeBookmarkView(): void {
  if (!active) return;
  active = false;
  ++revision;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
  detachBookmarkListeners?.();
  chrome.permissions?.onAdded?.removeListener(onPermissionAdded);
  chrome.permissions?.onRemoved?.removeListener(onPermissionRemoved);
  if (launcherBookmarks) {
    savedScrollTop = launcherBookmarks.scrollTop;
    launcherBookmarks.replaceChildren();
  }
}
