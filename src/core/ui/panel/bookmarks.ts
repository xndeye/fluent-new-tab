/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 */

import { getById, getLocalizedWarningText, sanitizeUrl } from '@/core/shared/dom-utils';
import { getBrowserFaviconUrl } from '@/core/shared/favicon-resolver';
import { checkApiPermission, requestApiPermission } from '@/core/shared/permissions';
import { showToast, warningModal } from '@/core/ui/ui-components';

const PAGE_SIZE = 48;
const FIREFOX_ROOTS: [string, ...string[]] = ['toolbar_____', 'unfiled_____', 'menu________', 'mobile______'];

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode & { type?: 'bookmark' | 'folder' | 'separator' };
type BookmarkIcon = 'folder' | 'chevron-down-small' | 'link' | 'trash' | 'open';

const BOOKMARK_ACTION_LABELS = {
  open: ['bookmarksOpenNewTab', 'Open in new tab', 'bookmarksOpenNewTabNamed', 'Open $TITLE$ in a new tab'],
  remove: ['bookmarksDelete', 'Delete bookmark', 'bookmarksDeleteNamed', 'Delete bookmark: $TITLE$'],
} as const;

function translate(key: string, fallback: string): string {
  const text = getLocalizedWarningText(key, fallback);
  return text === key ? fallback : text;
}

function setLabel(element: HTMLElement, key: string, fallback: string): void {
  element.dataset.i18n = key;
  element.textContent = translate(key, fallback);
}

function isFolder(node: BookmarkNode): boolean {
  return node.type === 'folder' || (node.type === undefined && node.url === undefined);
}

function bookmarkRequest<T>(request: (callback: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    request((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function findFolder(id: string): Promise<BookmarkNode | undefined> {
  try {
    const [folder] = await bookmarkRequest<BookmarkNode[]>((done) => chrome.bookmarks.get(id, done));
    return folder;
  } catch (error) {
    if (error instanceof Error &&
      (error.message === "Can't find bookmark for id." || error.message === 'Bookmark not found')) return undefined;
    throw error;
  }
}

function icon(name: BookmarkIcon): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (name === 'open') {
    const path = document.createElementNS(namespace, 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M6.25 4.5c-.97 0-1.75.78-1.75 1.75v11.5c0 .97.78 1.75 1.75 1.75h11.5c.97 0 1.75-.78 1.75-1.75v-4a.75.75 0 0 1 1.5 0v4c0 1.8-1.46 3.25-3.25 3.25H6.25A3.25 3.25 0 0 1 3 17.75V6.25C3 4.45 4.46 3 6.25 3h4a.75.75 0 0 1 0 1.5zM13 3.75c0-.41.34-.75.75-.75h6.5c.41 0 .75.34.75.75v6.5a.75.75 0 0 1-1.5 0V5.56l-5.22 5.22a.75.75 0 0 1-1.06-1.06l5.22-5.22h-4.69a.75.75 0 0 1-.75-.75');
    svg.append(path);
    return svg;
  }
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', '#icon-' + name);
  svg.append(use);
  return svg;
}

export function initBookmarksPanel(): (visible: boolean, open: boolean) => void {
  const quickNav = getById<HTMLElement>('bookmarksQuickNav')!;
  const workspace = getById<HTMLElement>('bookmarksWorkspace')!;
  const breadcrumb = getById<HTMLElement>('bookmarksPath')!;
  const heading = getById<HTMLElement>('bookmarksHeading')!;
  const results = getById<HTMLElement>('bookmarksResults')!;
  const status = getById<HTMLElement>('bookmarksStatus')!;
  const resultStatus = getById<HTMLElement>('bookmarksResultsStatus')!;
  const search = getById<HTMLInputElement>('bookmarksSearch')!;
  const viewButtons = workspace.querySelectorAll<HTMLButtonElement>('button[data-view]');
  const firefox = window.location.protocol === 'moz-extension:';
  const pages = { folders: 0, links: 0 };
  let roots: BookmarkNode[] | undefined;
  let selected: BookmarkNode | undefined;
  let ancestors: BookmarkNode[] = [];
  let visible = false;
  let expanded = false;
  let revision = 0;
  let searchTimer = 0;
  let currentView: string | undefined;

  function folderName(node: BookmarkNode): string {
    const title = node.title || translate('bookmarksUntitledFolder', 'Untitled folder');
    if (!node.folderType || node.syncing === undefined ||
      !roots?.some((root) => root.folderType === node.folderType && root.title === node.title && root.syncing !== node.syncing)) {
      return title;
    }
    const location = node.syncing
      ? translate('bookmarksAccountLocation', 'Account')
      : translate('bookmarksDeviceLocation', 'On this device');
    return title + ' · ' + location;
  }

  function quickRoots(): BookmarkNode[] {
    const locations = roots ?? [];
    if (!locations.some((node) => node.folderType)) return locations.slice(0, 2);
    return ['bookmarks-bar', 'other'].flatMap((type) => {
      const folder = locations.find((node) => node.folderType === type);
      return folder ? [folder] : [];
    });
  }

  function updateQuickNavSelection(): void {
    const current = !search.value.trim() && (ancestors[0]?.id ?? selected?.id);
    for (const button of quickNav.querySelectorAll<HTMLButtonElement>('button[data-bookmark-location]')) {
      if (button.dataset.bookmarkLocation === current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  }

  function updateBookmarkActionLabel(
    element: HTMLElement,
    action: keyof typeof BOOKMARK_ACTION_LABELS,
    title: string,
  ): void {
    const [key, fallback, namedKey, namedFallback] = BOOKMARK_ACTION_LABELS[action];
    element.title = translate(key, fallback);
    element.setAttribute('aria-label', translate(namedKey, namedFallback).replace('$TITLE$', () => title));
  }

  function renderQuickNav(): void {
    if (!roots) return;
    const primaryRoots = quickRoots();
    const destinations = [...primaryRoots, ...roots.filter((root) => !primaryRoots.includes(root))];
    const focused = document.activeElement?.getAttribute('data-bookmark-location');
    const buttons = destinations.map((destination) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'panel-nav-item';
      button.dataset.bookmarkLocation = destination.id;
      button.textContent = folderName(destination);
      button.title = button.textContent;
      button.addEventListener('click', () => selectDestination(destination));
      return button;
    });
    quickNav.replaceChildren(...buttons);
    updateQuickNavSelection();
    buttons.find((button) => button.dataset.bookmarkLocation === focused)?.focus({ preventScroll: true });
  }

  async function loadFolderPath(folder: BookmarkNode, loadRevision: number): Promise<BookmarkNode[]> {
    const path: BookmarkNode[] = [];
    for (let node = folder; loadRevision === revision && node.parentId && !roots?.some((root) => root.id === node.id);) {
      const parentId = node.parentId;
      const parent = roots?.find((root) => root.id === parentId) ??
        (await bookmarkRequest<BookmarkNode[]>((done) => chrome.bookmarks.get(parentId, done)))[0];
      if (!parent.parentId) break;
      path.unshift(parent);
      node = parent;
    }
    return path;
  }

  function selectDestination(destination: BookmarkNode): void {
    window.clearTimeout(searchTimer);
    search.value = '';
    if (selected?.id !== destination.id) ancestors = [];
    selected = destination;
    void loadCurrent();
  }

  function renderLocation(): void {
    const query = search.value.trim();
    const current = selected;
    heading.removeAttribute('data-i18n');
    if (query || !current) {
      breadcrumb.replaceChildren();
      if (query) setLabel(heading, 'bookmarksSearchResults', 'Search results');
      else setLabel(heading, 'bookmarksLabel', 'Bookmarks');
      return;
    }

    heading.textContent = folderName(current);
    if (!ancestors.length) {
      breadcrumb.replaceChildren();
      return;
    }

    const focusedId = document.activeElement?.getAttribute('data-bookmark-ancestor');
    const list = document.createElement('ol');
    for (const folder of ancestors) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.bookmarkAncestor = folder.id;
      button.textContent = folderName(folder);
      button.title = button.textContent;
      button.addEventListener('click', () => {
        selectDestination(folder);
        heading.focus({ preventScroll: true });
      });
      item.append(button);
      list.append(item);
    }
    breadcrumb.replaceChildren(list);
    if (focusedId) {
      const button = Array.from(list.querySelectorAll('button')).find((item) => item.dataset.bookmarkAncestor === focusedId);
      (button ?? heading).focus({ preventScroll: true });
    }
  }

  function showError(container: HTMLElement, error: unknown, retry: () => void): void {
    console.error('Failed to read browser bookmarks', { error });
    const message = document.createElement('span');
    const button = document.createElement('button');
    setLabel(message, 'bookmarksLoadError', 'Couldn’t read bookmarks');
    setLabel(button, 'bookmarksRetry', 'Retry');
    button.type = 'button';
    button.className = 'accent-btn';
    button.addEventListener('click', retry);
    container.replaceChildren(message, button);
  }

  function renderCurrentView(query: string): void {
    const view = query ? 'search:' + query : 'folder:' + (selected?.id ?? '');
    if (currentView !== view) {
      pages.folders = pages.links = 0;
      results.replaceChildren();
      workspace.scrollTop = 0;
    }
    currentView = view;
    renderLocation();
  }

  async function loadCurrent(): Promise<boolean> {
    if (!visible || !roots) return false;
    const currentRevision = ++revision;
    const query = search.value.trim();
    renderCurrentView(query);
    const loading = document.createElement('span');
    setLabel(loading, 'bookmarksLoading', 'Loading bookmarks…');
    resultStatus.replaceChildren(loading);
    try {
      if (!query && selected) {
        const id = selected.id;
        const folder = roots.find((root) => root.id === id) ?? await findFolder(id);
        if (currentRevision !== revision) return false;
        if (folder) {
          selected = folder;
        } else {
          roots = roots.filter((root) => root.id !== id);
          selected = quickRoots()[0] ?? roots[0];
          ancestors = [];
          renderQuickNav();
          renderCurrentView(query);
        }
      }

      const destination = selected;
      const itemsRequest = query
        ? bookmarkRequest<BookmarkNode[]>((done) => chrome.bookmarks.search(query, done))
        : destination ? bookmarkRequest<BookmarkNode[]>((done) => chrome.bookmarks.getChildren(destination.id, done)) : [];
      const pathRequest = !query && destination ? loadFolderPath(destination, currentRevision) : undefined;
      const [entries, path] = await Promise.all([itemsRequest, pathRequest]);
      if (currentRevision !== revision) return false;
      if (path) ancestors = path;
      resultStatus.replaceChildren();
      renderLocation();
      updateQuickNavSelection();
      renderResults(entries.filter((node) => node.type !== 'separator'));
      return true;
    } catch (error) {
      if (currentRevision === revision) showError(resultStatus, error, () => void loadCurrent());
      return false;
    }
  }

  function siteIcon(url: URL | null): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'bookmarks-site-icon';
    wrapper.setAttribute('aria-hidden', 'true');
    const src = url && getBrowserFaviconUrl(url);
    if (!src) {
      wrapper.append(icon('link'));
      return wrapper;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(icon('link')), { once: true });
    img.src = src;
    wrapper.append(img);
    return wrapper;
  }

  function deleteButton(node: BookmarkNode, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-icon-button bookmarks-delete';
    updateBookmarkActionLabel(button, 'remove', title);
    button.append(icon('trash'));
    button.addEventListener('click', () => {
      const prompt = translate('bookmarksDeleteConfirm', 'Delete “$TITLE$” from your browser bookmarks?');
      warningModal.show({
        title: translate('bookmarksDelete', 'Delete bookmark'),
        message: prompt.replace('$TITLE$', () => title),
        confirmText: translate('removeLabel', 'Remove'),
        cancelText: translate('btnCancel', 'Cancel'),
        confirmVariant: 'danger',
        onConfirm: () => { void removeBookmark(); },
      }, button);
    });

    async function removeBookmark(): Promise<void> {
      if (!button.isConnected) return;
      const item = button.closest('li')!;
      const index = Array.from(item.parentElement!.children).indexOf(item);
      const origin = currentView;
      heading.focus({ preventScroll: true });
      button.disabled = true;
      try {
        await bookmarkRequest<void>((done) => chrome.bookmarks.remove(node.id, done));
      } catch (error) {
        button.disabled = false;
        console.error('Failed to delete bookmark', { id: node.id, error });
        showToast(translate('bookmarksDeleteFailed', 'Couldn’t delete the bookmark'), 'assets/icons/tip.svg');
        if (document.activeElement === heading) button.focus({ preventScroll: true });
        return;
      }
      window.clearTimeout(searchTimer);
      if (await loadCurrent() && currentView === origin && expanded && document.activeElement === heading) {
        const items = results.querySelectorAll<HTMLLIElement>('.bookmarks-cards[data-kind="links"] > li');
        const next = items[Math.min(index, items.length - 1)]?.querySelector<HTMLElement>('a[href], button:enabled');
        (next ?? heading).focus();
      }
    }
    return button;
  }

  function card(node: BookmarkNode): HTMLLIElement {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'bookmarks-card-title';
    if (isFolder(node)) {
      const button = document.createElement('button');
      const badge = document.createElement('span');
      const chevron = icon('chevron-down-small');
      button.type = 'button';
      button.className = 'bookmarks-card bookmarks-folder-card';
      title.textContent = folderName(node);
      button.title = title.textContent;
      badge.className = 'bookmarks-folder-icon';
      badge.append(icon('folder'));
      chevron.classList.add('bookmarks-folder-chevron');
      button.append(badge, title, chevron);
      button.addEventListener('click', () => {
        selectDestination(node);
        heading.focus({ preventScroll: true });
      });
      item.append(button);
      return item;
    }

    const href = sanitizeUrl(node.url);
    const url = href === '#' ? null : new URL(href, window.location.href);
    const main = document.createElement('span');
    const caption = document.createElement('span');
    const link = url ? document.createElement('a') : document.createElement('span');
    const actions = document.createElement('div');
    const label = node.title || url?.hostname || node.url || '';
    title.textContent = label;
    item.dataset.bookmarkTitle = label;
    main.className = 'bookmarks-card-main';
    caption.className = 'bookmarks-card-caption';
    if (url) caption.textContent = url.hostname || node.url || '';
    else setLabel(caption, 'bookmarksUnsupportedAddress', 'This bookmark address can’t be opened here');
    main.append(title, caption);
    link.className = 'bookmarks-card';
    link.title = label;
    if (link instanceof HTMLAnchorElement && url) link.href = url.href;
    else link.classList.add('bookmarks-card-unavailable');
    link.append(siteIcon(url), main);
    item.append(link);
    actions.className = 'bookmarks-card-actions';
    if (url) {
      const openLink = document.createElement('a');
      openLink.className = 'panel-icon-button bookmarks-open';
      openLink.href = url.href;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      updateBookmarkActionLabel(openLink, 'open', label);
      openLink.append(icon('open'));
      actions.append(openLink);
    }
    if (!node.unmodifiable) actions.append(deleteButton(node, label));
    if (actions.childElementCount) {
      item.classList.add('bookmarks-link-item');
      item.append(actions);
    }
    return item;
  }

  function showGroup(entries: BookmarkNode[], kind: 'folders' | 'links', key: string, title: string): void {
    if (!entries.length) return;
    const group = document.createElement('section');
    const header = document.createElement('h3');
    const list = document.createElement('ul');
    header.className = 'bookmarks-section-header';
    header.tabIndex = -1;
    setLabel(header, key, title);
    list.className = 'bookmarks-cards';
    list.dataset.kind = kind;
    group.append(header, list);
    results.append(group);
    const lastPage = Math.ceil(entries.length / PAGE_SIZE) - 1;
    const controls = document.createElement('div');
    const range = document.createElement('span');
    const previous = document.createElement('button');
    const next = document.createElement('button');
    let page = Math.min(pages[kind], lastPage);

    function renderPage(): void {
      pages[kind] = page;
      const start = page * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, entries.length);
      list.replaceChildren(...entries.slice(start, end).map(card));
      range.textContent = (start + 1).toLocaleString() + '–' + end.toLocaleString() + ' / ' + entries.length.toLocaleString();
      previous.disabled = page === 0;
      next.disabled = page === lastPage;
    }

    renderPage();
    if (lastPage === 0) return;
    controls.className = 'bookmarks-pagination';
    range.setAttribute('aria-live', 'polite');
    previous.type = next.type = 'button';
    setLabel(previous, 'bookmarksPreviousPage', 'Previous');
    setLabel(next, 'bookmarksNextPage', 'Next');
    previous.addEventListener('click', () => {
      page -= 1;
      renderPage();
      header.focus();
    });
    next.addEventListener('click', () => {
      page += 1;
      renderPage();
      header.focus();
    });
    controls.append(previous, range, next);
    group.append(controls);
  }

  function renderResults(shown: BookmarkNode[]): void {
    results.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'bookmarks-empty';
      if (search.value.trim()) setLabel(empty, 'bookmarksNoResults', 'No matching bookmarks or folders');
      else setLabel(empty, 'bookmarksFolderEmpty', 'This folder is empty');
      results.append(empty);
      return;
    }
    showGroup(shown.filter(isFolder), 'folders', 'bookmarksFolders', 'Folders');
    showGroup(shown.filter((node) => !isFolder(node)), 'links', 'bookmarksLabel', 'Bookmarks');
  }

  function showGrant(): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'accent-btn';
    setLabel(button, 'bookmarksGrant', 'Allow bookmark access');
    button.addEventListener('click', () => { void requestApiPermission(['bookmarks']); });
    status.replaceChildren(button);
    quickNav.replaceChildren();
  }

  async function loadRoots(): Promise<void> {
    const currentRevision = ++revision;
    if (!roots) {
      const loading = document.createElement('span');
      setLabel(loading, 'bookmarksLoading', 'Loading bookmarks…');
      status.replaceChildren(loading);
    }
    try {
      const allowed = await checkApiPermission(['bookmarks']);
      if (currentRevision !== revision) return;
      if (!allowed) {
        showGrant();
        return;
      }
      const api = chrome.bookmarks;
      const locations = await bookmarkRequest<BookmarkNode[]>((done) => {
        if (firefox) api.get(FIREFOX_ROOTS, done);
        else api.getChildren(api.ROOT_NODE_ID ?? '0', done);
      });
      if (currentRevision !== revision) return;
      roots = locations.filter(isFolder);
      selected ??= quickRoots()[0] ?? roots[0];
      renderQuickNav();
      status.replaceChildren();
      workspace.hidden = search.disabled = false;
      void loadCurrent();
    } catch (error) {
      if (currentRevision === revision) showError(roots ? resultStatus : status, error, () => void loadRoots());
    }
  }

  function setView(view: string): void {
    workspace.dataset.view = view;
    for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }

  setView(localStorage.getItem('bookmarksView') === 'list' ? 'list' : 'grid');
  for (const button of viewButtons) {
    button.addEventListener('click', () => {
      setView(button.dataset.view!);
      localStorage.setItem('bookmarksView', button.dataset.view!);
    });
  }
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    revision += 1;
    searchTimer = window.setTimeout(() => void loadCurrent(), 150);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault();
    window.clearTimeout(searchTimer);
    search.value = '';
    void loadCurrent();
  });
  document.addEventListener('i18nReady', () => {
    renderQuickNav();
    if (visible) renderLocation();
    for (const item of results.querySelectorAll<HTMLElement>('[data-bookmark-title]')) {
      const title = item.dataset.bookmarkTitle!;
      const openLink = item.querySelector<HTMLElement>('.bookmarks-open');
      const deleteButton = item.querySelector<HTMLElement>('.bookmarks-delete');
      if (openLink) updateBookmarkActionLabel(openLink, 'open', title);
      if (deleteButton) updateBookmarkActionLabel(deleteButton, 'remove', title);
    }
  });
  chrome.permissions.onRemoved.addListener(({ permissions }) => {
    if (!permissions?.includes('bookmarks')) return;
    const focusWasInContent = workspace.contains(document.activeElement) ||
      quickNav.contains(document.activeElement) || search === document.activeElement;
    revision += 1;
    window.clearTimeout(searchTimer);
    roots = selected = undefined;
    ancestors = [];
    currentView = undefined;
    breadcrumb.replaceChildren();
    results.replaceChildren();
    resultStatus.replaceChildren();
    heading.textContent = '';
    search.value = '';
    workspace.hidden = search.disabled = true;
    showGrant();
    if (expanded && focusWasInContent) status.querySelector('button')?.focus({ preventScroll: true });
  });
  chrome.permissions.onAdded.addListener(({ permissions }) => {
    if (visible && permissions?.includes('bookmarks')) void loadRoots();
  });

  return (isVisible, isOpen) => {
    const shouldRead = (isVisible && !visible) || (isOpen && !expanded);
    if (visible && !isVisible) {
      revision += 1;
      window.clearTimeout(searchTimer);
    }
    visible = isVisible;
    expanded = isOpen;
    if (shouldRead) void loadRoots();
  };
}
