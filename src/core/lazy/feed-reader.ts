/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { getById, mountTemplate } from '@/core/shared/dom-utils';
import { FeedContent, FeedItem } from '@/core/shared/types';
import { getFeedContent, parseFeedHtml } from '@/core/lazy/feed-manager';

const ALLOWED_TAGS = new Set([
  ...'p div span br hr h1 h2 h3 h4 h5 h6 strong b em i del ul ol li blockquote pre code'.split(' '),
  ...'img figure figcaption a table thead tbody tfoot tr th td'.split(' '),
]);
const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'form',
  'input', 'button', 'textarea', 'select', 'svg', 'math', 'video', 'audio',
]);

let active = false;
let requestId = 0;
let previousFocus: HTMLElement | null = null;

function t(key: string, fallback: string): string {
  return (window as any).getTranslation?.(key, fallback) || fallback;
}

function getHttpsUrl(value: string | null, base: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol === 'https:') return url.href;
  } catch {}
  return undefined;
}

function appendSafeNode(source: Node, target: Node, base: string): void {
  if (source.nodeType === Node.TEXT_NODE || source.nodeType === Node.CDATA_SECTION_NODE) {
    target.appendChild(document.createTextNode(source.textContent || ''));
    return;
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return;

  const element = source as Element;
  const tag = element.localName;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || BLOCKED_TAGS.has(tag)) return;

  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of Array.from(element.childNodes)) appendSafeNode(child, target, base);
    return;
  }

  const clean = document.createElement(tag);
  if (clean instanceof HTMLImageElement) {
    const src = getHttpsUrl(element.getAttribute('src'), base);
    if (!src) return;
    clean.alt = element.getAttribute('alt') || '';
    clean.loading = 'lazy';
    clean.decoding = 'async';
    clean.referrerPolicy = 'no-referrer';
    clean.src = src;
  } else if (clean instanceof HTMLAnchorElement) {
    const href = getHttpsUrl(element.getAttribute('href'), base);
    if (!href) {
      for (const child of Array.from(element.childNodes)) appendSafeNode(child, target, base);
      return;
    }
    clean.href = href;
    clean.target = '_blank';
    clean.rel = 'noopener noreferrer';
  }
  for (const child of Array.from(element.childNodes)) appendSafeNode(child, clean, base);
  target.appendChild(clean);
}

function renderContent(body: HTMLElement, data: FeedContent, base: string): boolean {
  if (data.contentType === 'text') {
    body.classList.add('plain-text');
    body.textContent = data.content;
  } else {
    body.classList.remove('plain-text');
    const fragment = document.createDocumentFragment();
    if (data.contentType === 'xhtml') {
      const parsed = new DOMParser().parseFromString(data.content, 'application/xml');
      appendSafeNode(parsed.documentElement, fragment, base);
    } else {
      const parsed = parseFeedHtml(data.content);
      for (const child of Array.from(parsed.childNodes)) appendSafeNode(child, fragment, base);
    }
    body.replaceChildren(fragment);
  }
  return !!body.textContent?.trim() || !!body.querySelector('img');
}

function handleKeydown(event: KeyboardEvent): void {
  if (!active) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFeedReader();
  } else if (event.key === 'Tab') {
    const modal = getById('feedReaderModal');
    const focusable = modal?.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"]');
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

export function closeFeedReader(): void {
  if (!active) return;
  active = false;
  ++requestId;
  document.removeEventListener('keydown', handleKeydown, true);
  const modal = getById('feedReaderModal');
  modal?.classList.remove('active');
  modal?.setAttribute('inert', '');
  const body = getById('feedReaderBody');
  body?.replaceChildren();
  body?.removeAttribute('aria-busy');
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}

function mountReader(): HTMLElement | null {
  const existing = getById('feedReaderModal');
  if (existing) return existing;
  const modal = mountTemplate('tpl-feed-reader-modal');
  if (!modal) return null;
  getById('feedReaderClose')?.addEventListener('click', closeFeedReader);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeFeedReader();
  });
  return modal;
}

function setActionLabel(element: HTMLElement, key: string, fallback: string): void {
  const label = t(key, fallback);
  element.title = label;
  element.setAttribute('aria-label', label);
}

function openOriginal(url: string): void {
  chrome.tabs.create({ url });
}

export async function openFeedReader(item: FeedItem, trigger: HTMLElement): Promise<void> {
  const url = getHttpsUrl(item.link, item.link);
  if (!url) return;
  const modal = mountReader();
  const original = getById<HTMLAnchorElement>('feedReaderOriginal');
  const close = getById<HTMLButtonElement>('feedReaderClose');
  const title = getById('feedReaderTitle');
  const meta = getById('feedReaderMeta');
  const body = getById('feedReaderBody');
  const scroll = getById('feedReaderScroll');
  if (!modal || !original || !close || !title || !meta || !body || !scroll) {
    openOriginal(url);
    return;
  }

  const id = ++requestId;
  if (!active) previousFocus = trigger;
  active = true;
  original.href = url;
  setActionLabel(original, 'feedReaderOriginal', 'Open original');
  setActionLabel(close, 'feedReaderClose', 'Close');
  title.textContent = item.title;
  const date = Date.parse(item.pubDate);
  const source = item.feedTitle || new URL(url).hostname;
  meta.textContent = [source, Number.isNaN(date) ? '' : new Date(date).toLocaleString()].filter(Boolean).join(' · ');
  body.replaceChildren();
  body.classList.remove('plain-text');
  body.setAttribute('aria-busy', 'true');
  scroll.scrollTop = 0;
  modal.removeAttribute('inert');
  modal.classList.add('active');
  document.addEventListener('keydown', handleKeydown, true);
  close.focus({ preventScroll: true });

  try {
    const content = await getFeedContent(item);
    if (!active || id !== requestId) return;
    if (content && renderContent(body, content, url)) {
      body.removeAttribute('aria-busy');
      return;
    }
  } catch (error) {
    console.error('Error rendering feed content:', error);
  }
  if (!active || id !== requestId) return;
  closeFeedReader();
  openOriginal(url);
}
