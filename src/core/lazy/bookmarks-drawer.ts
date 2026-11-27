/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { getById, mountTemplate } from '@/core/shared/dom-utils';
import { checkApiPermission, requestApiPermission } from '@/core/shared/permissions';
import { showToast, warningModal } from '@/core/ui/ui-components';

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode & { type?: 'bookmark' | 'folder' | 'separator' };

function bookmarkRequest<T>(request: (callback: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    request((value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

function getChildren(id: string): Promise<BookmarkNode[]> {
  return bookmarkRequest<BookmarkNode[]>((callback) => chrome.bookmarks.getChildren(id, callback));
}

async function getRootChildren(): Promise<BookmarkNode[]> {
  const api = chrome.bookmarks as typeof chrome.bookmarks & { ROOT_NODE_ID?: string };
  const manifest = chrome.runtime.getManifest();
  return getChildren(api.ROOT_NODE_ID || ('browser_specific_settings' in manifest ? 'root________' : '0'));
}

function createIcon(id: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', id);
  svg.appendChild(use);
  return svg;
}

function getBookmarkUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'ftp:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch {}
  return undefined;
}

function createFavicon(url?: string): SVGSVGElement | HTMLImageElement {
  const fallback = createIcon('#icon-link');
  if (!url || !/^https?:/i.test(url) || !chrome.runtime.getManifest().permissions?.includes('favicon')) {
    return fallback;
  }

  const image = document.createElement('img');
  const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
  favicon.searchParams.set('pageUrl', url);
  favicon.searchParams.set('size', '16');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
  image.src = favicon.href;
  return image;
}

function label(key: string, fallback: string): string {
  const win = window as Window & { getTranslation?: (key: string, fallback: string) => string };
  return win.getTranslation?.(key, fallback) || fallback;
}

function setLabel(element: HTMLElement, text: string): void {
  element.title = text;
  element.setAttribute('aria-label', text);
}

class BookmarksDrawer {
  private root: HTMLElement;
  private panel: HTMLElement;
  private handle: HTMLButtonElement;
  private search: HTMLInputElement;
  private content: HTMLElement;
  private tree: HTMLElement;
  private results: HTMLUListElement;
  private events: AbortController | null = null;
  private hoverTimer = 0;
  private hoverAfter = 0;
  private deletedIds = new Set<string>();
  private removing = false;
  private session = 0;
  private searchRevision = 0;
  private touchStart: { x: number; y: number; id: number } | null = null;
  private confirming = false;
  private open = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.panel = root.querySelector<HTMLElement>('#bookmarksPanel')!;
    this.handle = root.querySelector<HTMLButtonElement>('#bookmarksHandle')!;
    this.search = root.querySelector<HTMLInputElement>('#bookmarksSearch')!;
    this.content = root.querySelector<HTMLElement>('#bookmarksContent')!;
    this.tree = root.querySelector<HTMLElement>('#bookmarksTree')!;
    this.results = root.querySelector<HTMLUListElement>('#bookmarksResults')!;
    this.clearContent();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === !!this.events) return;
    this.root.hidden = !enabled;
    if (!enabled) {
      this.closeDrawer();
      this.events?.abort();
      this.events = null;
      clearTimeout(this.hoverTimer);
      this.touchStart = null;
      return;
    }

    this.events = new AbortController();
    const { signal } = this.events;
    this.updateLabels();
    this.handle.addEventListener('click', () => {
      if (performance.now() < this.hoverAfter) return;
      if (this.open) this.closeDrawer();
      else void this.openDrawer();
    }, { signal });
    this.handle.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' || this.open || performance.now() < this.hoverAfter) return;
      this.hoverTimer = window.setTimeout(() => void this.openDrawer(true), 150);
    }, { signal });
    this.handle.addEventListener('pointerleave', () => clearTimeout(this.hoverTimer), { signal });
    this.search.addEventListener('input', () => void this.searchBookmarks(), { signal });
    this.root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true, signal });
    document.addEventListener('i18nReady', () => this.updateLabels(), { signal });
    document.addEventListener('click', (event) => {
      if (!this.open || this.confirming || document.querySelector('.modal-overlay.active')) return;
      // The handle moves during opening and closing.
      if (event.detail && performance.now() < this.hoverAfter &&
          event.clientX <= 24 && Math.abs(event.clientY - window.innerHeight / 2) <= 24) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target;
      if (target instanceof Node && !this.root.contains(target)) this.closeDrawer();
    }, { capture: true, signal });
    document.addEventListener('keydown', (event) => {
      if (!this.open || event.key !== 'Escape' || event.defaultPrevented) return;
      if (this.confirming && getById('warningModal')?.classList.contains('active')) {
        getById('warning-btn-cancel')?.click();
      } else if (document.querySelector('.modal-overlay.active')) {
        return;
      } else {
        this.closeDrawer();
        this.handle.focus({ preventScroll: true });
      }
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, signal });
    this.root.addEventListener('touchstart', (event) => {
      this.touchStart = null;
      if (event.touches.length !== 1 || document.querySelector('.modal-overlay.active')) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.bookmarks-edge, .bookmarks-handle')) return;
      const touch = event.touches[0];
      this.touchStart = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    }, { passive: true, signal });
    this.root.addEventListener('touchend', (event) => {
      const start = this.touchStart;
      this.touchStart = null;
      if (!start) return;
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if ((!this.open && dx > 0) || (this.open && dx < 0)) {
        if (event.cancelable) event.preventDefault();
        if (this.open) this.closeDrawer();
        else void this.openDrawer();
      }
    }, { passive: false, signal });
    this.root.addEventListener('touchcancel', () => { this.touchStart = null; }, { passive: true, signal });
  }

  private updateLabels(): void {
    const text = label('bookmarksLabel', 'Bookmarks');
    setLabel(this.handle, text);
    this.panel.setAttribute('aria-label', text);
    this.search.setAttribute('aria-label', `${label('searchTitle', 'Search')} · ${text}`);
  }

  private isCurrent(session: number): boolean {
    return this.open && session === this.session;
  }

  private clearContent(): void {
    this.deletedIds.clear();
    this.search.value = '';
    this.search.disabled = true;
    this.tree.hidden = false;
    this.results.hidden = true;
    this.tree.replaceChildren();
    this.results.replaceChildren();
    this.content.scrollTop = 0;
  }

  private async openDrawer(fromHover = false): Promise<void> {
    if (this.open || !this.events || document.querySelector('.modal-overlay.active')) return;
    clearTimeout(this.hoverTimer);
    this.open = true;
    this.hoverAfter = fromHover ? performance.now() + 380 : 0;
    const session = ++this.session;
    this.root.classList.add('open');
    this.panel.removeAttribute('inert');
    this.handle.setAttribute('aria-expanded', 'true');
    await this.loadRoots(session);
  }

  private closeDrawer(): void {
    if (!this.open) return;
    this.open = false;
    this.touchStart = null;
    ++this.session;
    ++this.searchRevision;
    this.root.classList.remove('open');
    if (this.panel.contains(document.activeElement) && !this.root.hidden) {
      this.handle.focus({ preventScroll: true });
    }
    this.panel.setAttribute('inert', '');
    this.handle.setAttribute('aria-expanded', 'false');
    this.hoverAfter = performance.now() + 380;
    clearTimeout(this.hoverTimer);
    if (this.confirming) {
      warningModal.close();
      this.confirming = false;
    }
    this.clearContent();
  }

  private status(container: HTMLElement, text: string): void {
    const message = document.createElement(container instanceof HTMLUListElement ? 'li' : 'div');
    message.className = 'bookmarks-status';
    message.textContent = text;
    message.setAttribute('role', 'status');
    container.replaceChildren(message);
  }

  private async loadRoots(session: number): Promise<void> {
    try {
      const granted = await checkApiPermission(['bookmarks']);
      if (!this.isCurrent(session)) return;
      if (!granted) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bookmarks-permission';
        button.dataset.i18n = 'grantPermissionLabel';
        button.textContent = label('grantPermissionLabel', 'Grant Permission');
        button.addEventListener('click', async () => {
          button.disabled = true;
          const allowed = await requestApiPermission(['bookmarks']);
          if (!this.isCurrent(session)) return;
          if (allowed) {
            this.tree.replaceChildren();
            await this.loadRoots(session);
          } else button.disabled = false;
        });
        this.tree.replaceChildren(button);
        return;
      }

      this.search.disabled = false;
      const roots = await getRootChildren();
      if (!this.isCurrent(session)) return;
      const groups = await Promise.all(roots.map(async (root) => ({
        root,
        children: root.url !== undefined || root.type === 'separator' ? [root] : await getChildren(root.id),
      })));
      if (!this.isCurrent(session)) return;
      const fragment = document.createDocumentFragment();
      for (const { root, children } of groups) {
        const list = this.createList(children, 0, session, !!root.unmodifiable);
        if (!list.childElementCount) continue;
        const group = document.createElement('section');
        group.className = 'bookmarks-group';
        if (root.url === undefined && root.type !== 'separator') {
          const heading = document.createElement('h3');
          heading.textContent = root.title;
          group.appendChild(heading);
        }
        group.appendChild(list);
        fragment.appendChild(group);
      }
      this.tree.replaceChildren(fragment);
    } catch (error) {
      if (!this.isCurrent(session)) return;
      console.error('Error loading bookmarks:', error);
      this.status(this.tree, label('bookmarksLoadError', 'Unable to load bookmarks'));
    }
  }

  private createList(nodes: BookmarkNode[], depth: number, session: number, managed = false): HTMLUListElement {
    const list = document.createElement('ul');
    for (const node of nodes) {
      if (!this.deletedIds.has(node.id)) list.appendChild(this.createItem(node, depth, session, managed));
    }
    return list;
  }

  private createItem(node: BookmarkNode, depth: number, session: number, managed = false): HTMLLIElement {
    const item = document.createElement('li');
    if (node.type === 'separator') {
      item.className = 'bookmarks-separator';
      item.setAttribute('role', 'separator');
      return item;
    }

    const title = node.title || node.url || '';
    const text = document.createElement('span');
    text.className = 'bookmarks-label';
    text.textContent = title;

    const indent = Math.min(depth, 8) * 0.75;
    if (node.url === undefined) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bookmarks-row bookmarks-folder';
      button.title = title;
      button.style.paddingInlineStart = `${0.45 + indent}rem`;
      button.setAttribute('aria-expanded', 'false');
      button.append(createIcon('#icon-chevron-down-small'), createIcon('#icon-folder'), text);
      item.appendChild(button);

      let children: HTMLUListElement | null = null;
      let loading = false;
      button.addEventListener('click', async () => {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        if (children) {
          children.hidden = !expanded;
          return;
        }
        if (!expanded || loading) return;
        loading = true;
        try {
          const nodes = await getChildren(node.id);
          if (!this.isCurrent(session) || !item.isConnected) return;
          children = this.createList(nodes, depth + 1, session, managed || !!node.unmodifiable);
          children.hidden = button.getAttribute('aria-expanded') !== 'true';
          item.appendChild(children);
        } catch (error) {
          if (!this.isCurrent(session)) return;
          button.setAttribute('aria-expanded', 'false');
          console.error('Error loading bookmark folder:', error);
          showToast(label('bookmarksLoadError', 'Unable to load bookmarks'), 'assets/icons/dimiss.svg');
        } finally {
          loading = false;
        }
      });
      return item;
    }

    item.className = 'bookmarks-link-item';
    item.dataset.bookmarkId = node.id;
    const url = getBookmarkUrl(node.url);
    const row = url ? document.createElement('a') : document.createElement('span');
    row.className = 'bookmarks-row';
    row.style.paddingInlineStart = `${1.65 + indent}rem`;
    row.title = title;
    if (row instanceof HTMLAnchorElement && url) {
      row.href = url;
      row.draggable = false;
      row.rel = 'noopener noreferrer';
    } else {
      row.setAttribute('aria-disabled', 'true');
      row.tabIndex = 0;
    }
    row.append(createFavicon(url), text);
    item.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'bookmarks-actions';
    if (url) {
      const link = document.createElement('a');
      link.className = 'bookmarks-action';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      setLabel(link, label('newTabTitle', 'New Tab'));
      link.appendChild(createIcon('#icon-open-new'));
      actions.appendChild(link);
    }
    if (!managed && !node.unmodifiable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bookmarks-action bookmarks-remove';
      remove.disabled = this.removing;
      setLabel(remove, label('removeLabel', 'Remove'));
      remove.appendChild(createIcon('#icon-trash'));
      remove.addEventListener('click', () => this.confirmRemoval(node, title, remove, session));
      actions.appendChild(remove);
    }
    item.appendChild(actions);
    return item;
  }

  private confirmRemoval(node: BookmarkNode, title: string, button: HTMLButtonElement, session: number): void {
    if (!this.isCurrent(session) || this.confirming || this.removing) return;
    this.confirming = true;
    const remove = label('removeLabel', 'Remove');
    warningModal.show({
      title: remove,
      message: title,
      confirmText: remove,
      cancelText: label('btnCancel', 'Cancel'),
      confirmVariant: 'danger',
      onCancel: () => {
        this.confirming = false;
        if (button.isConnected) button.focus({ preventScroll: true });
      },
      onConfirm: async () => {
        this.confirming = false;
        if (!this.isCurrent(session)) return;
        this.removing = true;
        this.setRemoveDisabled(true);
        try {
          await bookmarkRequest<void>((callback) => chrome.bookmarks.remove(node.id, callback));
          if (!this.open) return;
          this.deletedIds.add(node.id);
          this.root.querySelectorAll<HTMLElement>('[data-bookmark-id]').forEach((item) => {
            if (item.dataset.bookmarkId !== node.id) return;
            const group = item.closest('.bookmarks-group');
            item.remove();
            if (group && !group.querySelector('li')) group.remove();
          });
          if (!this.results.hidden && !this.results.childElementCount) {
            this.status(this.results, label('noResultsFound', 'No results found'));
          }
        } catch (error) {
          console.error('Error removing bookmark:', error);
          if (this.open) {
            showToast(label('removeBookmarkError', 'Unable to remove bookmark'), 'assets/icons/dimiss.svg');
          }
        } finally {
          this.removing = false;
          this.setRemoveDisabled(false);
        }
      },
    });
  }

  private setRemoveDisabled(disabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('.bookmarks-remove').forEach((button) => {
      button.disabled = disabled;
    });
  }

  private async searchBookmarks(): Promise<void> {
    if (!this.open || this.search.disabled) return;
    const query = this.search.value.trim();
    const revision = ++this.searchRevision;
    const session = this.session;
    this.tree.hidden = !!query;
    this.results.hidden = !query;
    this.results.replaceChildren();
    this.content.scrollTop = 0;
    if (!query) return;

    try {
      const nodes = await bookmarkRequest<BookmarkNode[]>((callback) => chrome.bookmarks.search(query, callback));
      if (!this.isCurrent(session) || revision !== this.searchRevision) return;
      const fragment = document.createDocumentFragment();
      for (const node of nodes) {
        if (node.url !== undefined && node.type !== 'separator' && !this.deletedIds.has(node.id)) {
          fragment.appendChild(this.createItem(node, 0, session));
        }
      }
      if (fragment.childElementCount) this.results.appendChild(fragment);
      else this.status(this.results, label('noResultsFound', 'No results found'));
    } catch (error) {
      if (!this.isCurrent(session) || revision !== this.searchRevision) return;
      console.error('Error searching bookmarks:', error);
      this.status(this.results, label('bookmarksLoadError', 'Unable to load bookmarks'));
    }
  }
}

let drawer: BookmarksDrawer | null = null;

export function setBookmarksDrawerEnabled(enabled: boolean): void {
  if (enabled && !drawer) {
    const root = mountTemplate('tpl-bookmarks-drawer');
    if (root) drawer = new BookmarksDrawer(root);
  }
  drawer?.setEnabled(enabled);
}
