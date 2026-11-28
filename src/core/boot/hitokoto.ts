/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

import { getLocalizedWarningText } from '@/core/shared/dom-utils';

const QUOTE_MAX_AGE = 10 * 60 * 1000;
let quoteRequest: AbortController | null = null;

export function getHitokotoCategories(): string[] {
  const categories = localStorage.getItem('hitokotoCategory');
  return categories ? categories.split(',') : [];
}

export function parseHitokotoUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function stopHitokoto(wrapper: HTMLElement): void {
  quoteRequest?.abort();
  quoteRequest = null;
  delete wrapper.dataset.hitokotoUrl;
}

function renderStatus(wrapper: HTMLElement, key: string, message: string): void {
  const heading = document.createElement('h1');
  heading.className = 'greeting-text';
  heading.setAttribute('role', 'status');
  heading.dataset.i18n = key;
  const localized = getLocalizedWarningText(key, message);
  heading.textContent = localized === key ? message : localized;
  wrapper.replaceChildren(heading);
}

export function refreshHitokotoIfStale(wrapper: HTMLElement): void {
  const updatedAt = wrapper.querySelector<HTMLHeadingElement>('.greeting-text')?.dataset.updatedAt;
  if (quoteRequest || !updatedAt || Date.now() - Number(updatedAt) <= QUOTE_MAX_AGE) return;

  delete wrapper.dataset.hitokotoUrl;
  void renderHitokoto(wrapper);
}

export async function renderHitokoto(wrapper: HTMLElement): Promise<void> {
  const api = localStorage.getItem('hitokotoApi');
  const officialUrl = api === 'international' ? 'https://international.v1.hitokoto.cn/' : 'https://v1.hitokoto.cn/';
  const url = api === 'custom' ? parseHitokotoUrl(localStorage.getItem('hitokotoUrl') || '') : new URL(officialUrl);
  if (url) {
    url.searchParams.set('encode', 'json');
    url.searchParams.delete('c');
    for (const category of getHitokotoCategories()) {
      url.searchParams.append('c', category);
    }
  }

  const requestUrl = url?.href || '';
  if (wrapper.dataset.hitokotoUrl === requestUrl) return;
  stopHitokoto(wrapper);
  wrapper.dataset.hitokotoUrl = requestUrl;

  const hasQuote = wrapper.querySelector('.greeting-text[data-updated-at]') !== null;
  if (!url) {
    if (!hasQuote) renderStatus(wrapper, 'hitokotoConfigure', 'Enter a self-hosted API URL in More options.');
    return;
  }

  const request = new AbortController();
  quoteRequest = request;
  const { signal } = request;
  if (!hasQuote) renderStatus(wrapper, 'hitokotoLoading', 'Loading quote…');

  try {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Hitokoto API returned HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (signal.aborted) return;
    if (
      !data ||
      typeof data !== 'object' ||
      !('hitokoto' in data) ||
      typeof data.hitokoto !== 'string' ||
      !data.hitokoto.trim()
    ) {
      throw new TypeError('Hitokoto API response is missing quote text');
    }

    const heading = document.createElement('h1');
    heading.className = 'greeting-text';
    heading.textContent = data.hitokoto;
    heading.dataset.updatedAt = String(Date.now());

    const author = 'from_who' in data && typeof data.from_who === 'string' ? data.from_who.trim() : '';
    const source = 'from' in data && typeof data.from === 'string' ? data.from.trim() : '';
    const attribution = [author, source].filter(Boolean).join(' · ');
    if (attribution) {
      const sourceLine = document.createElement('p');
      sourceLine.className = 'hitokoto-source';
      sourceLine.textContent = attribution;
      wrapper.replaceChildren(heading, sourceLine);
    } else {
      wrapper.replaceChildren(heading);
    }
  } catch (error) {
    if (signal.aborted) return;
    console.error('Could not load Hitokoto quote', { error });
    if (!hasQuote) {
      renderStatus(wrapper, 'hitokotoError', 'Could not load a quote. Check the endpoint in More options.');
    }
  } finally {
    if (quoteRequest === request) quoteRequest = null;
  }
}
