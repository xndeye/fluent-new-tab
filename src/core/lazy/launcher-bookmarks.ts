/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { launcherBookmarks } from '@/core/shared/dom-refs';
import { checkApiPermission, requestApiPermission } from '@/core/shared/permissions';
import { showToast, warningModal } from '@/core/ui/ui-components';

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode & { type?: 'bookmark' | 'folder' | 'separator' };

const expandedFolderIds = new Set<string>();
let initialized = false;
let active = false;
let revision = 0;

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

function createRemoveButton(node: BookmarkNode, item: HTMLLIElement, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bookmark-remove-btn';
  const removeLabel = translate('removeLabel', 'Remove');
  button.title = removeLabel;
  button.setAttribute('aria-label', `${removeLabel}: ${title}`);
  button.appendChild(createIcon('#icon-trash'));
  button.addEventListener('click', () => {
    warningModal.show({
      title: translate('removeBookmarkTitle', 'Remove bookmark?'),
      message: `${translate('removeBookmarkMessage', 'This will remove the bookmark from your browser:')}\n${title}`,
      confirmText: removeLabel,
      cancelText: translate('btnCancel', 'Cancel'),
      confirmVariant: 'danger',
      onConfirm: async () => {
        if (!active || !item.isConnected || button.disabled) return;
        button.disabled = true;
        try {
          await new Promise<void>((resolve, reject) => {
            chrome.bookmarks.remove(node.id, () => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve();
            });
          });
          const list = item.parentElement;
          item.remove();
          if (list && list === launcherBookmarks?.firstElementChild && !list.childElementCount) {
            showStatus('bookmarksEmpty', 'No bookmarks');
          }
        } catch (error) {
          console.error('Error removing bookmark:', error);
          showToast(translate('removeBookmarkError', 'Unable to remove bookmark'), 'assets/icons/dimiss.svg');
          button.disabled = false;
        }
      },
    });
  });
  return button;
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
    item.className = 'bookmark-link-item';
    item.appendChild(row);
    if (!node.unmodifiable) item.appendChild(createRemoveButton(node, item, title));
    return item;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bookmark-row';
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

  if (roots.length) launcherBookmarks.replaceChildren(createList(roots));
  else showStatus('bookmarksEmpty', 'No bookmarks');
  launcherBookmarks.scrollTop = 0;
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
      const requestId = revision;
      const granted = await requestApiPermission(['bookmarks']);
      if (!active || requestId !== revision) return;
      if (granted) void loadBookmarkTree();
      else button.disabled = false;
    });
    status.appendChild(button);
  }
  launcherBookmarks.replaceChildren(status);
}

async function loadBookmarkTree(): Promise<void> {
  if (!active || !launcherBookmarks) return;
  const requestId = ++revision;
  try {
    const granted = await checkApiPermission(['bookmarks']);
    if (!active || requestId !== revision) return;
    if (!granted || !chrome.bookmarks?.getTree) {
      showStatus('permissionRequiredTitle', 'Permission Required', true);
      return;
    }

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
  void loadBookmarkTree();
}

export function closeBookmarkView(): void {
  if (!active) return;
  active = false;
  ++revision;
  launcherBookmarks?.replaceChildren();
}
