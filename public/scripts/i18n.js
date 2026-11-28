const DEFAULT_LOCALE = 'en_US';
const TRANSLATION_VERSION = chrome.runtime.getManifest().version;
window.translationsCache = {};
let translationRequest = 0;

async function fetchLocale(locale) {
  const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load locale ${locale} (HTTP ${response.status})`);
  return await response.json();
}

async function loadTranslations() {
  const request = ++translationRequest;
  const lang = localStorage.getItem('userLanguage') || DEFAULT_LOCALE;
  const cacheKey = `i18n_cache_${lang}`;
  let messages;
  try {
    const cache = JSON.parse(localStorage.getItem(cacheKey));
    if (cache?.version === TRANSLATION_VERSION && cache.messages && typeof cache.messages === 'object') {
      messages = cache.messages;
    }
  } catch {
    localStorage.removeItem(cacheKey);
  }

  if (!messages) {
    let cacheable = true;
    try {
      messages = await fetchLocale(DEFAULT_LOCALE);
      if (lang !== DEFAULT_LOCALE) {
        try {
          Object.assign(messages, await fetchLocale(lang));
        } catch (error) {
          cacheable = false;
          console.warn('Could not load selected locale', { lang, error });
        }
      }
      if (request !== translationRequest) return;
    } catch (error) {
      console.error('Could not load default translations', { error });
      messages = {};
      cacheable = false;
    }
    if (cacheable) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ version: TRANSLATION_VERSION, messages }));
      } catch (error) {
        console.warn('Could not cache translations', { lang, error });
      }
    }
  }

  if (request !== translationRequest) return;
  window.translationsCache = messages;
  applyToDOM(messages);
  document.body.classList.add('loaded');
  document.dispatchEvent(new Event('i18nReady'));
}

function applyToDOM(messages) {
  document.querySelectorAll('[data-i18n-label]').forEach((el) => {
    const message = messages[el.dataset.i18nLabel]?.message;
    if (message) {
      el.setAttribute('aria-label', message);
      if (el.hasAttribute('title')) el.title = message;
    }
  });

  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (messages[k]) {
      const v = messages[k].message;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = v;
      } else if (el.tagName === 'OPTION') {
        el.textContent = v;
      } else if (el.tagName === 'TITLE') {
        if (!localStorage.getItem('tabName')) {
          document.title = v;
        }
      } else {
        el.innerHTML = v;
      }
    }
  });
}

window.getTranslation = function (k, fb) {
  if (window.translationsCache && window.translationsCache[k]) {
    return window.translationsCache[k].message;
  }
  return fb !== undefined ? fb : k;
};

window.loadTranslations = loadTranslations;
window.applyToDOM = applyToDOM;

document.addEventListener('DOMContentLoaded', loadTranslations);
