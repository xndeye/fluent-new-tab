/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 */

import { getById, getLocalizedWarningText } from '@/core/shared/dom-utils';
import { requestApiPermission } from '@/core/shared/permissions';
import { setCollapsible } from '@/core/ui/ui-components';
import { bindPanelScroll, hasActivePopup } from './scroll';

interface DrawerView {
  tab: HTMLButtonElement;
  check: HTMLInputElement;
  content: HTMLElement;
  toolbar: HTMLElement;
  key: string;
}

export function initPanel(): void {
  const root = document.documentElement;
  const drawer = getById<HTMLDivElement>('panelDrawer')!;
  const header = drawer.querySelector<HTMLElement>('.panel-header')!;
  const tabs = header.querySelector<HTMLElement>('.panel-tabs')!;
  const toolbar = header.querySelector<HTMLElement>('.panel-toolbar')!;
  const homeTrigger = getById<HTMLButtonElement>('panelHomeTrigger')!;
  const headerTrigger = getById<HTMLButtonElement>('panelHeaderTrigger')!;
  const triggers = [homeTrigger, headerTrigger];
  const toggle = getById<HTMLInputElement>('togglePanel')!;
  const mode = getById<HTMLSelectElement>('panelModeSelect')!;
  const options = getById<HTMLDivElement>('panelOptionsGroup')!;
  const views: DrawerView[] = [
    {
      tab: getById<HTMLButtonElement>('bookmarksTab')!,
      check: getById<HTMLInputElement>('showPanelBookmarks')!,
      content: getById<HTMLElement>('bookmarksPanel')!,
      toolbar: getById<HTMLElement>('bookmarksToolbar')!,
      key: 'panelShowBookmarks',
    },
    {
      tab: getById<HTMLButtonElement>('feedTab')!,
      check: getById<HTMLInputElement>('showPanelFeed')!,
      content: getById<HTMLElement>('feedPanel')!,
      toolbar: getById<HTMLElement>('feedToolbar')!,
      key: 'panelShowFeed',
    },
  ];
  const [bookmarks, feed] = views;
  const supportsInert = 'inert' in HTMLElement.prototype;
  root.dataset.panelPreview = String(supportsInert);
  let selected: DrawerView | undefined;
  let open = false;
  let feedLoaded = false;
  let bookmarksModule: Promise<void> | undefined;
  let syncBookmarks: ((visible: boolean, open: boolean) => void) | undefined;
  const bindScroll = bindPanelScroll(drawer, () => open, setOpen);

  function render(): void {
    const active = selected !== undefined;
    const preview = supportsInert && mode.value === 'expanded';
    root.dataset.panelActive = String(active);
    root.dataset.panelMode = mode.value;
    root.dataset.panelOpen = String(open);
    drawer.classList.toggle('open', open);
    header.hidden = !open && mode.value === 'hidden';
    toolbar.hidden = !open;
    tabs.setAttribute('role', open ? 'tablist' : 'group');
    homeTrigger.hidden = !active || mode.value !== 'hidden';
    const triggerKey = open ? 'panelClose' : 'panelOpen';
    const fallback = open ? 'Collapse extension panel' : 'Open extension panel';
    const translation = getLocalizedWarningText(triggerKey, fallback);
    for (const trigger of triggers) {
      trigger.setAttribute('aria-expanded', String(open));
      trigger.dataset.i18nLabel = triggerKey;
      trigger.title = translation === triggerKey ? fallback : translation;
      trigger.setAttribute('aria-label', trigger.title);
    }

    for (const view of views) {
      const current = view === selected;
      view.tab.hidden = !view.check.checked;
      view.tab.tabIndex = !open || current ? 0 : -1;
      view.tab.toggleAttribute('data-current', current);
      if (open) {
        view.tab.setAttribute('role', 'tab');
        view.tab.setAttribute('aria-selected', String(current));
        view.tab.removeAttribute('aria-current');
      } else {
        view.tab.removeAttribute('role');
        view.tab.removeAttribute('aria-selected');
        view.tab.setAttribute('aria-current', String(current));
      }
      view.toolbar.hidden = !current || !open;
      view.content.hidden = !current || !(open || preview);
      view.content.inert = !open;
    }

    if (!bookmarks.content.hidden && !bookmarksModule) {
      bookmarksModule = import('./bookmarks').then(({ initBookmarksPanel }) => {
        syncBookmarks = initBookmarksPanel();
        render();
      });
    }
    syncBookmarks?.(!bookmarks.content.hidden, open && selected === bookmarks);

    if (!feed.content.hidden && !feedLoaded) {
      feedLoaded = true;
      void import('@/core/lazy/feed-engine').then(({ loadAndRenderFeeds }) => loadAndRenderFeeds());
    }
  }

  function setOpen(next: boolean): void {
    if (!selected || open === next) return;
    const focus = document.activeElement;
    open = next;
    render();
    if (!open && drawer.contains(focus)) {
      if (header.hidden) homeTrigger.focus({ preventScroll: true });
      else if (!header.contains(focus) || toolbar.contains(focus)) {
        headerTrigger.focus({ preventScroll: true });
      }
    } else if (open && focus?.closest('.container')) {
      selected.tab.focus({ preventScroll: true });
    }
  }

  function update(): void {
    selected = toggle.checked
      ? (selected?.check.checked ? selected : views.find((view) => view.check.checked))
      : undefined;
    if (!selected) open = false;
    bindScroll(selected !== undefined);
    render();
  }

  for (const view of views) {
    view.tab.addEventListener('click', () => {
      if (hasActivePopup()) return;
      selected = view;
      if (open) render();
      else setOpen(true);
    });
    view.tab.addEventListener('keydown', (event) => {
      if (!open) return;
      const visible = views.filter((entry) => !entry.tab.hidden);
      const index = visible.indexOf(view);
      let next: DrawerView;
      switch (event.key) {
        case 'ArrowLeft': next = visible[(index + visible.length - 1) % visible.length]; break;
        case 'ArrowRight': next = visible[(index + 1) % visible.length]; break;
        case 'Home': next = visible[0]; break;
        case 'End': next = visible[visible.length - 1]; break;
        default: return;
      }
      event.preventDefault();
      for (const entry of visible) entry.tab.tabIndex = entry === next ? 0 : -1;
      next.tab.focus();
    });
    view.check.addEventListener('change', async () => {
      if (view === bookmarks && view.check.checked) {
        view.check.disabled = true;
        view.check.checked = await requestApiPermission(['bookmarks']);
        view.check.disabled = false;
      }
      localStorage.setItem(view.key, String(view.check.checked));
      update();
    });
  }

  tabs.addEventListener('focusout', (event) => {
    if (!open || tabs.contains(event.relatedTarget as Node | null)) return;
    for (const view of views) view.tab.tabIndex = view === selected ? 0 : -1;
  });
  for (const trigger of triggers) {
    trigger.addEventListener('click', () => {
      if (hasActivePopup()) return;
      setOpen(!open);
      if (open) selected?.tab.focus({ preventScroll: true });
    });
  }
  document.querySelector('.container')?.addEventListener('focusin', () => setOpen(false));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && open && !hasActivePopup()) {
      setOpen(false);
    }
  });
  const editFeedButton = getById<HTMLButtonElement>('editFeedRssBtn')!;
  editFeedButton.addEventListener('click', () => {
    void import('@/core/lazy/feed-manager').then(({ openFeedModal }) => openFeedModal(editFeedButton));
  });

  toggle.checked = localStorage.getItem('feedEnabled') === 'true';
  const savedMode = localStorage.getItem('feedMode');
  mode.value = savedMode === 'expanded' ? 'expanded' :
    savedMode === 'hidden' || savedMode === 'autohide' ? 'hidden' : 'minimal';
  bookmarks.check.checked = localStorage.getItem(bookmarks.key) === 'true';
  feed.check.checked = localStorage.getItem(feed.key) !== 'false';
  setCollapsible(options, toggle.checked, false);
  update();

  toggle.addEventListener('change', () => {
    localStorage.setItem('feedEnabled', String(toggle.checked));
    setCollapsible(options, toggle.checked, true);
    update();
  });
  mode.addEventListener('change', () => {
    localStorage.setItem('feedMode', mode.value);
    render();
  });
}
