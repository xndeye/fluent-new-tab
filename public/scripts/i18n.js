const DEFAULT_LOCALE = 'en_US';
const TRANSLATION_VERSION = chrome.runtime.getManifest().version;
window.translationsCache = {};
let translationRequest = 0;

const hitokotoMessages = {
  displayHitokoto: ['Hitokoto', '一言', '一言'],
  hitokotoCategory: ['Categories', '类别', '類別'],
  hitokotoAnimation: ['Animation', '动画', '動畫'],
  hitokotoComics: ['Comics', '漫画', '漫畫'],
  hitokotoGames: ['Games', '游戏', '遊戲'],
  hitokotoLiterature: ['Literature', '文学', '文學'],
  hitokotoOriginal: ['Original', '原创', '原創'],
  hitokotoInternet: ['Internet', '来自网络', '來自網路'],
  hitokotoOther: ['Other', '其他', '其他'],
  hitokotoFilm: ['Film & TV', '影视', '影視'],
  hitokotoPoetry: ['Poetry', '诗词', '詩詞'],
  hitokotoMusic: ['NetEase Cloud Music', '网易云', '網易雲'],
  hitokotoPhilosophy: ['Philosophy', '哲学', '哲學'],
  hitokotoWit: ['Wit', '抖机灵', '抖機靈'],
  hitokotoApi: ['Endpoint', '路线', '路線'],
  hitokotoChina: ['Mainland China', '中国大陆', '中國大陸'],
  hitokotoInternational: ['International', '国际', '國際'],
  hitokotoCustom: ['Self-hosted', '自托管', '自架'],
  hitokotoUrl: ['Self-hosted API URL', '自托管 API 地址', '自架 API 網址'],
  hitokotoCors: [
    'The endpoint must allow cross-origin requests (CORS).',
    '接口需要允许跨域请求（CORS）。',
    '端點需允許跨來源請求（CORS）。',
  ],
  hitokotoInvalidUrl: [
    'Enter a valid HTTP or HTTPS URL without credentials.',
    '请输入不含用户名或密码的 HTTP 或 HTTPS 地址。',
    '請輸入不含使用者名稱或密碼的 HTTP 或 HTTPS 網址。',
  ],
  hitokotoConfigure: [
    'Enter a self-hosted API URL in More options.',
    '请在「更多选项」中填写自托管 API 地址。',
    '請在「更多選項」中填寫自架 API 網址。',
  ],
  hitokotoLoading: ['Loading quote…', '正在加载一言…', '正在載入一言…'],
  hitokotoError: [
    'Could not load a quote. Check the endpoint in More options.',
    '一言加载失败，请在「更多选项」中检查路线。',
    '一言載入失敗，請在「更多選項」中檢查路線。',
  ],
};

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
  const hitokotoLanguage = lang === 'zh_CN' ? 1 : lang === 'zh_TW' ? 2 : 0;
  const hitokotoTranslations = Object.fromEntries(
    Object.entries(hitokotoMessages).map(([key, labels]) => [key, { message: labels[hitokotoLanguage] }]),
  );
  messages = { ...hitokotoTranslations, ...messages };
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
