(() => {
  'use strict';

  const DEFAULTS = Object.freeze({ enabled: true });
  const CONTROL_SELECTOR = 'button, a, [role="button"], [role="switch"]';
  const NATIVE_COLOR_SELECTOR = '.referral-banner-wrap';
  const VIEWER_FIT_HEIGHT_SELECTOR = 'button[aria-label="높이 맞춤 화면"]';
  const MEDIA_SELECTOR = 'img, picture, video, canvas, svg';
  const PREFERENCE_GUIDE_TEXT = /계약제안 메뉴가|각 폴더 별로/;
  const MEDIA_TAGS = new Set(['PICTURE', 'VIDEO', 'CANVAS', 'SOURCE', 'TRACK']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  const READER_SELECTOR = [
    '[class*="_contentArea_"]',
    '[class*="_scrollViewport_"]',
    '[class*="_scrollContainer_"]',
    '[class*="_scrollSpacer_"]',
    '[class*="_pageCanvas_"]',
    '[class*="_pageContent_"]',
    '[class*="_viewerText_"]'
  ].join(',');

  const root = document.documentElement;
  const pendingRoots = new Set();
  const pendingElements = new Set();
  const CLASSIFICATION_KEYS = [
    'mpNightSurface', 'mpNightText', 'mpNightBorder', 'mpNightContent',
    'mpNightIconFill', 'mpNightIconStroke', 'mpNightIconImage',
    'mpNightSkeleton', 'mpNightNovelScanned', 'mpNightLevelDigit', 'mpNightGuide'
  ];
  let settings = { ...DEFAULTS };
  let scanQueued = false;
  let observerStarted = false;
  let preloadSafetyTimer;
  let handledPreferenceEntry = '';

  // Paint black immediately; the first completed scan reveals the document.
  root.dataset.mpNight = 'on';
  root.dataset.mpNightReady = 'false';
  root.dataset.mpViewer = isViewerRoute() ? 'true' : 'false';

  function isHomeRoute() {
    return location.pathname === '/';
  }

  function isViewerRoute() {
    return location.pathname.startsWith('/novel/viewer/');
  }

  function isPreferenceRoute() {
    return location.pathname.startsWith('/apes/preference');
  }

  function revealDarkPage() {
    window.clearTimeout(preloadSafetyTimer);
    root.dataset.mpNightReady = 'true';
  }

  function armDarkPreload() {
    window.clearTimeout(preloadSafetyTimer);
    root.dataset.mpNightReady = 'false';
    preloadSafetyTimer = window.setTimeout(revealDarkPage, 1200);
  }

  armDarkPreload();

  function applySettings(next) {
    const wasEnabled = settings.enabled;
    settings = { enabled: next.enabled !== false };
    root.dataset.mpNight = settings.enabled ? 'on' : 'off';
    root.dataset.mpOverlayDrawer = settings.enabled ? 'true' : 'false';

    if (!settings.enabled) {
      pendingRoots.clear();
      pendingElements.clear();
      revealDarkPage();
      return;
    }

    if (!wasEnabled) armDarkPreload();
    if (document.body) scheduleScan(document.body);
  }

  function parseColor(value) {
    if (!value || value === 'transparent') return null;
    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;

    const parts = match[1]
      .replace(/\//g, ',')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);

    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: Number.isFinite(parts[3]) ? parts[3] : 1
    };
  }

  function luminance(color) {
    const channels = [color.r, color.g, color.b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  }

  function isReaderContent(element) {
    return Boolean(element.closest?.(READER_SELECTOR));
  }

  function preserveNativeColors(element) {
    if (!element.matches?.(NATIVE_COLOR_SELECTOR) && !element.closest?.(NATIVE_COLOR_SELECTOR)) return false;
    [
      'mpNightSurface',
      'mpNightText',
      'mpNightBorder',
      'mpNightContent',
      'mpNightIconFill',
      'mpNightIconStroke',
      'mpNightIconImage',
      'mpNightSkeleton'
    ].forEach((key) => { delete element.dataset[key]; });
    return true;
  }

  function classifyIconPart(element) {
    const control = element.closest(CONTROL_SELECTOR);
    if (!control) return;

    const style = getComputedStyle(element);
    const fill = parseColor(style.fill);
    const stroke = parseColor(style.stroke);

    if (fill && fill.a >= 0.35 && luminance(fill) <= 0.22) {
      element.dataset.mpNightIconFill = 'light';
    }
    if (stroke && stroke.a >= 0.35 && luminance(stroke) <= 0.22) {
      element.dataset.mpNightIconStroke = 'light';
    }
  }

  function classifyIconImage(image) {
    const control = image.closest(CONTROL_SELECTOR);
    if (!control) return;

    const identity = `${image.className || ''} ${image.currentSrc || image.src || ''} ${image.alt || ''}`.toLowerCase();
    const looksLikeIcon = /icon|ico|arrow|chevron|search|menu|close|share|heart|star|gift|bell/.test(identity);
    const looksLikeContent = /profile|avatar|cover|book|novel|sticker|banner|logo/.test(identity);
    if (!looksLikeIcon || looksLikeContent) return;

    const rect = image.getBoundingClientRect();
    if (rect.width <= 48 && rect.height <= 48) {
      image.dataset.mpNightIconImage = 'light';
    }
  }

  function classifySemanticText(element) {
    const className = `${element.className || ''}`.toLowerCase();
    if (/author|writer|creator|nickname/.test(className)) {
      element.dataset.mpNightContent = 'author';
    } else if (/genre|category|tag|metadata|meta-/.test(className)) {
      element.dataset.mpNightContent = 'meta';
    } else if (/novel[-_]?title|book[-_]?title|work[-_]?title|novel[-_]?name|book[-_]?name/.test(className)) {
      element.dataset.mpNightContent = 'title';
    }
  }

  function classifyNovelLink(link) {
    if (link.dataset.mpNightNovelScanned) return;
    link.dataset.mpNightNovelScanned = 'true';

    const blocks = Array.from(link.querySelectorAll('h1, h2, h3, h4, p, strong'))
      .filter((node) => {
        const text = node.textContent?.trim() || '';
        return text.length >= 2 && text.length <= 100;
      });

    if (blocks[0]) blocks[0].dataset.mpNightContent = 'title';
    if (blocks[1]) blocks[1].dataset.mpNightContent = 'author';

    if (!blocks.length) {
      const text = link.textContent?.trim() || '';
      if (text.length >= 2 && text.length <= 80) link.dataset.mpNightContent = 'title';
    }

    link.querySelectorAll('[class*="genre" i], [class*="category" i], [class*="tag" i]')
      .forEach((node) => { node.dataset.mpNightContent = 'meta'; });
  }

  function classifyProfileLevel(element) {
    const className = `${element.className || ''}`.toLowerCase();
    if (!className.includes('_levelrow_') && !className.includes('_popoverlevel_')) return;

    const label = className.includes('_levelrow_')
      ? (element.querySelector('span') || element)
      : element;
    const match = (label.textContent || '').trim().match(/^Lv\.\s*(\d+)$/i);
    if (match) label.dataset.mpNightLevelDigit = match[1].slice(-1);
  }

  function classifySurfaceAndText(element, onHomeRoute) {
    const needsSurface = !element.dataset.mpNightSurface;
    const needsText = !element.dataset.mpNightText;
    const needsBorder = !element.dataset.mpNightBorder;
    const inspectSkeleton = onHomeRoute || Boolean(element.dataset.mpNightSkeleton);

    if (!needsSurface && !needsText && !needsBorder && !inspectSkeleton) return;

    let text = '';
    let hasMedia = false;
    if (inspectSkeleton) {
      text = element.textContent?.trim() || '';
      hasMedia = Boolean(element.querySelector?.(MEDIA_SELECTOR));
      if (element.dataset.mpNightSkeleton && (text || hasMedia)) {
        delete element.dataset.mpNightSkeleton;
      }
    }

    if (!needsSurface && !needsText && !needsBorder) return;

    const style = getComputedStyle(element);
    const background = parseColor(style.backgroundColor);
    const foreground = parseColor(style.color);

    if (needsSurface && background && background.a >= 0.15) {
      const backgroundLuma = luminance(background);
      if (backgroundLuma >= 0.72) {
        // Geometry is expensive, so only measure elements that are actually light.
        const rect = element.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        const isPageSized = area > 350000 || element === document.body;
        const isControl = /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(element.tagName);

        if (
          onHomeRoute
          && !isPageSized
          && area >= 120
          && !text
          && !hasMedia
        ) {
          element.dataset.mpNightSkeleton = 'true';
        }

        element.dataset.mpNightSurface = isPageSized
          ? 'base'
          : (isControl || backgroundLuma < 0.9 ? 'raised' : 'surface');
      }
    }

    if (needsText && foreground && foreground.a >= 0.45) {
      const foregroundLuma = luminance(foreground);
      if (foregroundLuma <= 0.28) {
        element.dataset.mpNightText = 'primary';
      } else if (foregroundLuma <= 0.62) {
        element.dataset.mpNightText = 'muted';
      }
    }

    if (!needsBorder) return;
    const borderColors = [
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor
    ].map(parseColor).filter(Boolean);

    if (borderColors.some((color) => color.a >= 0.18 && luminance(color) >= 0.68)) {
      element.dataset.mpNightBorder = 'soft';
    }
  }

  function classifyElement(element, context) {
    if (!(element instanceof Element) || !element.isConnected) return;
    if (SKIP_TAGS.has(element.tagName) || MEDIA_TAGS.has(element.tagName)) return;
    if (preserveNativeColors(element)) return;
    if (isReaderContent(element)) return;

    if (element instanceof HTMLImageElement) {
      classifyIconImage(element);
      return;
    }

    if (element instanceof SVGElement) {
      classifyIconPart(element);
      return;
    }

    classifySemanticText(element);
    classifyProfileLevel(element);
    if (element instanceof HTMLAnchorElement && element.href.includes('/novel/detail/')) {
      classifyNovelLink(element);
    }
    classifySurfaceAndText(element, context.onHomeRoute);
  }

  function scanTree(scanRoot, manageMode = true) {
    if (!(scanRoot instanceof Element) || !scanRoot.isConnected) return;
    const context = { onHomeRoute: isHomeRoute() };
    // Read native colors, not our previous overrides. This synchronous section
    // restores the theme before the browser can paint.
    const mode = root.dataset.mpNight;
    if (manageMode) root.dataset.mpNight = 'off';
    try {
      classifyElement(scanRoot, context);
      scanRoot.querySelectorAll('*').forEach((element) => classifyElement(element, context));
    } finally {
      if (manageMode) root.dataset.mpNight = mode;
    }
  }

  function invalidateTree(scanRoot) {
    for (const element of [scanRoot, ...scanRoot.querySelectorAll('*')]) {
      for (const key of CLASSIFICATION_KEYS) delete element.dataset[key];
    }
  }

  function enforceViewerFitHeight() {
    if (root.dataset.mpViewer !== 'true') return;
    const button = document.querySelector(VIEWER_FIT_HEIGHT_SELECTOR);
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    button.click();
  }

  function removePreferenceGuides(scanRoot) {
    if (!isPreferenceRoute()) return;

    const elements = [scanRoot, ...scanRoot.querySelectorAll('div, span, p')];
    for (const element of elements.reverse()) {
      if (!PREFERENCE_GUIDE_TEXT.test(element.textContent || '')) continue;

      let candidate = element;
      for (let depth = 0; candidate && candidate !== document.body && depth < 6; depth += 1) {
        const className = `${candidate.className || ''}`;
        const textLength = (candidate.textContent || '').trim().length;
        const hasCloseControl = Boolean(candidate.querySelector('button, [aria-label*="닫기"], [aria-label*="close" i]'));
        const looksLikeGuide = /tooltip|guide|coach|onboard|popover|bubble|speech|help/i.test(className);
        if (textLength <= 240 && (looksLikeGuide || hasCloseControl)) {
          candidate.dataset.mpNightGuide = 'true';
          break;
        }
        candidate = candidate.parentElement;
      }
    }
  }

  function closePreferenceEntryOnce() {
    const url = new URL(location.href);
    if (!url.pathname.startsWith('/novel/detail/') || url.searchParams.get('mode') !== 'prefer') {
      handledPreferenceEntry = '';
      return;
    }
    if (!settings.enabled || handledPreferenceEntry === url.href) return;
    const button = document.querySelector('button[aria-label="리모컨 닫기"], button[aria-label="리모컨 열기"]');
    if (!button) return; // Wait for the site's drawer to mount.
    handledPreferenceEntry = url.href; // Consume before clicking to avoid observer loops.
    if (button.getAttribute('aria-label') === '리모컨 닫기') button.click();
  }

  function applyViewerBehavior() {
    closePreferenceEntryOnce();
    const onViewerRoute = isViewerRoute();
    root.dataset.mpViewer = onViewerRoute ? 'true' : 'false';
    root.dataset.mpPreference = isPreferenceRoute() ? 'true' : 'false';
    if (!onViewerRoute) return;
    enforceViewerFitHeight();
  }

  function addPendingRoot(scanRoot) {
    for (const queuedRoot of pendingRoots) {
      if (queuedRoot === scanRoot || queuedRoot.contains(scanRoot)) return false;
      if (scanRoot.contains(queuedRoot)) pendingRoots.delete(queuedRoot);
    }
    pendingRoots.add(scanRoot);
    return true;
  }

  function drainScans() {
    scanQueued = false;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    const elements = Array.from(pendingElements).filter((element) =>
      element.isConnected && !roots.some((scanRoot) => scanRoot.contains(element)));
    pendingElements.clear();
    if (!settings.enabled) {
      applyViewerBehavior();
      revealDarkPage();
      return;
    }

    if (!roots.length && !elements.length) return;
    const mode = root.dataset.mpNight;
    // One native-style window per batch, not one per changed subtree.
    root.dataset.mpNight = 'off';
    try {
      roots.forEach(invalidateTree);
      elements.forEach((element) => {
        for (const key of CLASSIFICATION_KEYS) delete element.dataset[key];
      });
      roots.forEach((scanRoot) => scanTree(scanRoot, false));
      const context = { onHomeRoute: isHomeRoute() };
      elements.forEach((element) => classifyElement(element, context));
      roots.forEach(removePreferenceGuides);
      applyViewerBehavior();
    } finally {
      root.dataset.mpNight = mode;
      if (observerStarted) revealDarkPage();
    }
  }

  function scheduleScan(scanRoot, subtree = true) {
    if (!(scanRoot instanceof Element) || !scanRoot.isConnected) return;
    if (subtree) addPendingRoot(scanRoot);
    else pendingElements.add(scanRoot);
    if (scanQueued) return;
    scanQueued = true;
    window.queueMicrotask(drainScans);
  }

  function isDrawerMotionOnly(mutation, target) {
    if (mutation.type !== 'attributes' || mutation.attributeName !== 'class' ||
        !target.matches('[class*="_drawerWrapper_"]')) return false;
    // Only these native classes control translation/animation. Other class or
    // style changes must still invalidate colors, including future site changes.
    const stableClasses = (value) => (value || '').split(/\s+/)
      .filter((name) => name && !/^_drawerWrapper(?:Open|Animated)_/.test(name))
      .sort().join(' ');
    return stableClasses(mutation.oldValue) === stableClasses(target.className);
  }

  function startObserver() {
    if (!document.body) return;

    if (settings.enabled) {
      try {
        scanTree(document.body);
      } catch {
        // CSS fallbacks still apply; the safety reveal prevents a stuck page.
      }
    }

    const observer = new MutationObserver((mutations) => {
      closePreferenceEntryOnce();
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element
          ? mutation.target : mutation.target.parentElement;
        if (!target || isDrawerMotionOnly(mutation, target)) continue;
        // Text replacement can change a novel link or its level-label parent.
        const scanRoot = target.closest('[data-mp-night-guide], a[href*="/novel/detail/"], [class*="_levelRow_"], [class*="_popoverLevel_"]') || target;
        if (mutation.type === 'childList' && scanRoot === target) {
          // An insertion does not require re-reading every existing sibling.
          // Refresh ancestors themselves for empty skeletons and added media.
          for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) {
            scheduleScan(ancestor, false);
          }
          mutation.addedNodes.forEach((node) => scheduleScan(node));
          if (isPreferenceRoute()) removePreferenceGuides(target);
        } else {
          // Class/style changes can affect inherited descendant colors.
          scheduleScan(scanRoot);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'src', 'href', 'open', 'aria-expanded', 'aria-pressed']
    });

    observerStarted = true;
    removePreferenceGuides(document.body);
    applyViewerBehavior();
    revealDarkPage();

    document.addEventListener('load', (event) => {
      if (event.target instanceof HTMLImageElement) scheduleScan(event.target);
    }, true);
  }

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    applySettings(stored);
  }).catch(() => {
    applySettings(DEFAULTS);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const next = { ...settings };
    if (changes.enabled) next.enabled = changes.enabled.newValue;
    applySettings(next);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
