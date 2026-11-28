/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { getById } from '@/core/shared/dom-utils';
import { FeedData, FeedItem } from '@/core/shared/types';
import { fetchAndValidateFeed, getFeedUrls, openFeedModal } from '@/core/lazy/feed-manager';

const CACHE_TTL = 30 * 60 * 1000;
let loadedFeeds: FeedData[] = [];
let activeFeedId = 'all';
let loadRevision = 0;

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  const time = Date.parse(dateStr);
  if (isNaN(time)) return '';

  const diffSec = Math.floor((Date.now() - time) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return '';
  }
}

function t(k: string, fb: string): string {
  const v = (window as any).getTranslation?.(k, fb);
  return v && v !== k ? v : fb;
}

function getFaviconUrl(urlStr: string): string {
  const domain = getDomain(urlStr);
  return domain ? `https://favicon.vemetric.com/${domain}?size=32` : '';
}

function renderGridItems(items: FeedItem[]): void {
  const grid = getById<HTMLDivElement>('feedGrid');
  if (!grid) return;

  const editFocused = document.activeElement?.id === 'feedEmptyEditBtn';
  grid.innerHTML = '';

  if (items.length === 0) {
    const status = document.createElement('div');
    const message = document.createElement('span');
    status.className = 'panel-status';
    const hasSources = getFeedUrls().length > 0;
    message.setAttribute('role', 'status');
    message.dataset.i18n = hasSources ? 'feedEmptyTitle' : 'panelNoFeedSources';
    message.textContent = t(message.dataset.i18n, hasSources ? 'No feed items available' : 'No feed sources');
    status.append(message);
    if (!hasSources) {
      const edit = document.createElement('button');
      edit.id = 'feedEmptyEditBtn';
      edit.type = 'button';
      edit.className = 'accent-btn';
      edit.dataset.i18n = 'panelEditFeedSources';
      edit.textContent = t(edit.dataset.i18n, 'Edit feed sources');
      edit.addEventListener('click', () => openFeedModal(edit));
      status.append(edit);
    }
    grid.append(status);
  }

  if (editFocused) {
    (getById<HTMLButtonElement>('feedEmptyEditBtn') ??
      getById<HTMLButtonElement>('editFeedRssBtn'))?.focus({ preventScroll: true });
  }
  if (items.length === 0) return;

  const displayItems = items.slice(0, 25);
  const frag = document.createDocumentFragment();

  displayItems.forEach((it) => {
    const card = document.createElement('a');
    card.className = 'feed-post-card';
    card.href = it.link;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    if (it.hasContent) {
      card.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        import('@/core/lazy/feed-reader')
          .then(({ openFeedReader }) => openFeedReader(it, card))
          .catch((error) => {
            console.error('Error loading feed reader:', error);
            chrome.tabs.create({ url: card.href });
          });
      });
    }

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'feed-post-thumb-wrapper';

    const makePlaceholder = () => {
      const ph = document.createElement('div');
      ph.className = 'feed-post-thumb placeholder';
      ph.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.75 3A3.25 3.25 0 0 1 21 6.25v11.5A3.25 3.25 0 0 1 17.75 21H6.25A3.25 3.25 0 0 1 3 17.75V6.25A3.25 3.25 0 0 1 6.25 3zm.58 16.401-5.805-5.686a.75.75 0 0 0-.966-.071l-.084.07-5.807 5.687q.274.097.582.099h11.5c.203 0 .399-.035.58-.099l-5.805-5.686zM17.75 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25v11.5q.001.313.103.594l5.823-5.701a2.25 2.25 0 0 1 3.02-.116l.128.116 5.822 5.702q.102-.28.104-.595V6.25a1.75 1.75 0 0 0-1.75-1.75m-2.498 2a2.252 2.252 0 1 1 0 4.504 2.252 2.252 0 0 1 0-4.504m0 1.5a.752.752 0 1 0 0 1.504.752.752 0 0 0 0-1.504" fill="currentColor"/></svg>`;
      return ph;
    };

    if (it.imageUrl) {
      const img = document.createElement('img');
      img.className = 'feed-post-thumb';
      img.src = it.imageUrl;
      img.alt = it.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.setAttribute('fetchpriority', 'low');
      img.onerror = () => {
        img.remove();
        thumbWrap.appendChild(makePlaceholder());
      };
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(makePlaceholder());
    }

    const meta = document.createElement('div');
    meta.className = 'feed-post-meta';

    const faviconUrl = getFaviconUrl(it.link);
    if (faviconUrl) {
      const fav = document.createElement('img');
      fav.className = 'feed-post-favicon';
      fav.src = faviconUrl;
      fav.alt = '';
      fav.width = 16;
      fav.height = 16;
      fav.loading = 'lazy';
      fav.decoding = 'async';
      fav.setAttribute('fetchpriority', 'low');
      fav.onerror = () => fav.remove();
      meta.appendChild(fav);
    }

    const source = document.createElement('span');
    source.className = 'feed-post-source';
    source.textContent = it.feedTitle || getDomain(it.link);
    meta.appendChild(source);

    const relTime = formatRelativeTime(it.pubDate);
    if (relTime) {
      const dot = document.createElement('span');
      dot.className = 'feed-post-dot';
      dot.innerHTML = '&bull;';
      meta.appendChild(dot);

      const timeSpan = document.createElement('span');
      timeSpan.className = 'feed-post-time';
      timeSpan.textContent = relTime;
      meta.appendChild(timeSpan);
    }

    const title = document.createElement('h4');
    title.className = 'feed-post-title';
    title.textContent = it.title;

    card.appendChild(thumbWrap);
    card.appendChild(meta);
    card.appendChild(title);

    frag.appendChild(card);
  });

  grid.appendChild(frag);
}

function interleaveFeeds(feeds: FeedData[]): FeedItem[] {
  const queues = feeds
    .filter((f) => Array.isArray(f.items) && f.items.length > 0)
    .map((f) => {
      const copy = f.items.map((it) => ({
        ...it,
        feedTitle: it.feedTitle || f.title,
      }));
      copy.sort((a, b) => {
        const ta = Date.parse(a.pubDate) || 0;
        const tb = Date.parse(b.pubDate) || 0;
        return tb - ta;
      });
      return copy;
    });

  if (queues.length === 0) return [];

  const mixed: FeedItem[] = [];
  let idx = 0;
  let remaining = true;

  while (remaining && mixed.length < 50) {
    remaining = false;
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i];
      if (idx < q.length) {
        mixed.push(q[idx]);
        remaining = true;
      }
    }
    idx++;
  }

  return mixed;
}

function updateGridDisplay(): void {
  if (activeFeedId === 'all') {
    const mixed = interleaveFeeds(loadedFeeds);
    renderGridItems(mixed);
  } else {
    const targetFeed = loadedFeeds.find((feed) => feed.url === activeFeedId);
    renderGridItems(targetFeed ? targetFeed.items : []);
  }
}

function renderFeedNav(): void {
  const nav = getById<HTMLElement>('feedNav');
  if (!nav) return;

  const focused = (document.activeElement as HTMLElement | null)?.dataset.feedId;
  const sources = loadedFeeds.length ? [
    { id: 'all', title: t('feedAll', 'All') },
    ...loadedFeeds.map((feed) => ({ id: feed.url, title: feed.title })),
  ] : [];
  const buttons = sources.map(({ id, title }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-nav-item';
    button.dataset.feedId = id;
    button.textContent = title;
    if (id === 'all') button.dataset.i18n = 'feedAll';
    else button.title = title;
    if (id === activeFeedId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      activeFeedId = id;
      nav.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
      button.setAttribute('aria-current', 'true');
      updateGridDisplay();
    });
    return button;
  });
  nav.replaceChildren(...buttons);
  if (focused) {
    (buttons.find((button) => button.dataset.feedId === focused) ??
      getById<HTMLButtonElement>('editFeedRssBtn'))?.focus({ preventScroll: true });
  }
}

export async function loadAndRenderFeeds(): Promise<void> {
  const revision = ++loadRevision;
  const urls = getFeedUrls();
  if (activeFeedId !== 'all' && !urls.includes(activeFeedId)) activeFeedId = 'all';

  if (!Array.isArray(urls) || urls.length === 0) {
    loadedFeeds = [];
    activeFeedId = 'all';
    renderFeedNav();
    renderGridItems([]);
    return;
  }

  const cachedList: FeedData[] = [];
  const urlsToFetch: string[] = [];

  urls.forEach((u) => {
    const key = `feedCache_${u}`;
    try {
      const s = localStorage.getItem(key);
      if (s) {
        const d = JSON.parse(s) as FeedData;
        if (d && Array.isArray(d.items)) {
          cachedList.push(d);
          if (
            Date.now() - (d.updatedAt || 0) >= CACHE_TTL ||
            d.items.some((item) => typeof item.hasContent !== 'boolean')
          ) {
            urlsToFetch.push(u);
          }
          return;
        }
      }
    } catch {}
    urlsToFetch.push(u);
  });

  if (cachedList.length > 0) {
    loadedFeeds = cachedList;
    renderFeedNav();
    if (activeFeedId === 'all' || cachedList.some((feed) => feed.url === activeFeedId)) updateGridDisplay();
  }

  if (urlsToFetch.length === 0) return;

  const results = await Promise.allSettled(
    urlsToFetch.map(async (u) => {
      const fresh = await fetchAndValidateFeed(u);
      if (getFeedUrls().includes(u)) {
        try {
          localStorage.setItem(`feedCache_${u}`, JSON.stringify(fresh));
        } catch {}
      }
      return fresh;
    }),
  );

  if (revision !== loadRevision) return;

  const freshMap = new Map<string, FeedData>();
  results.forEach((r) => {
    if (r.status === 'fulfilled' && r.value) {
      freshMap.set(r.value.url, r.value);
    }
  });

  const updated: FeedData[] = [];
  getFeedUrls().forEach((u) => {
    const item = freshMap.get(u) || cachedList.find((c) => c.url === u);
    if (item) {
      updated.push(item);
    }
  });

  loadedFeeds = updated;
  if (activeFeedId !== 'all' && !loadedFeeds.some((feed) => feed.url === activeFeedId)) {
    activeFeedId = 'all';
  }
  renderFeedNav();
  updateGridDisplay();
}
