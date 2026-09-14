/* 账单回到顶部：兼容页面和列表内部滚动，不读写账本。 */
(() => {
  'use strict';

  const view = document.getElementById('view-list');
  const content = document.getElementById('list-content');
  const button = document.getElementById('list-back-top');
  const summary = document.getElementById('list-summary');
  const nav = document.querySelector('.tab-bar');
  if (!view || !content || !button) return;

  let frame = 0;
  let idleTimer = 0;
  let scrolled = false;

  function showWhileActive() {
    clearTimeout(idleTimer);
    button.classList.remove('list-back-top--idle');
    if (button.hidden || document.activeElement === button) return;
    idleTimer = setTimeout(() => {
      button.classList.add('list-back-top--idle');
    }, 1000);
  }

  function update() {
    frame = 0;
    const wasHidden = button.hidden;
    const reveal = scrolled;
    scrolled = false;
    const active = view.classList.contains('main-view--active');
    const distance = Math.max(window.scrollY, view.scrollTop, content.scrollTop);
    const viewport = Math.min(window.innerHeight, content.clientHeight || window.innerHeight);
    button.hidden = !active || distance < Math.max(240, viewport * 0.75);
    if (button.hidden) {
      clearTimeout(idleTimer);
      button.classList.remove('list-back-top--idle');
      return;
    }
    if (wasHidden || reveal) showWhileActive();

    // 按实际底栏和汇总高度留出空间，兼容安全区、桌面和字体放大。
    const navHeight = nav ? window.innerHeight - nav.getBoundingClientRect().top : 0;
    const summaryRect = summary ? summary.getBoundingClientRect() : null;
    let bottom = Math.max(0, navHeight) + (summaryRect ? summaryRect.height : 0) + 24;
    if (summaryRect && summaryRect.height && summaryRect.top < window.innerHeight && summaryRect.bottom > 0) {
      bottom = Math.max(bottom, window.innerHeight - summaryRect.top + 12);
    }
    button.style.bottom = `${bottom}px`;
  }

  function scheduleUpdate(event) {
    // 只有实际滚动才重置停留计时，布局观察不会把已渐隐按钮重新唤起。
    if (event && event.type === 'scroll') scrolled = true;
    if (!frame) frame = requestAnimationFrame(update);
  }

  // 键盘聚焦时保留按钮，移走焦点后再开始计时。
  button.addEventListener('focus', showWhileActive);
  button.addEventListener('blur', showWhileActive);
  button.addEventListener('click', () => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    // 焦点回到标题，不聚焦搜索输入框，避免手机弹出键盘。
    if (document.activeElement === button) {
      view.querySelector('h1').focus({ preventScroll: true });
    }
    content.scrollTo({ top: 0, behavior });
    view.scrollTo({ top: 0, behavior });
    window.scrollTo({ top: 0, behavior });
    scheduleUpdate();
  });

  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  view.addEventListener('scroll', scheduleUpdate, { passive: true });
  content.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  window.addEventListener('pageshow', scheduleUpdate);
  new MutationObserver(scheduleUpdate).observe(view, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(scheduleUpdate).observe(content, { childList: true });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleUpdate);
    [content, summary, nav].filter(Boolean).forEach(el => observer.observe(el));
  }
  scheduleUpdate();
})();
