/* ================================================================
   v212 · 根层数字键盘状态同步
   独立真实文件路径确保旧 CDN 节点也会获取本次交互修复。
   ================================================================ */
(function () {
  'use strict';

  var appRoot = document.getElementById('app');
  var addView = document.getElementById('view-add');
  var numpad = document.getElementById('add-numpad');
  var locationInput = document.getElementById('add-location');
  var noteInput = document.getElementById('add-note');
  if (!appRoot || !addView || !numpad) return;

  function syncViewState() {
    var isAddActive = addView.classList.contains('main-view--active');
    numpad.hidden = !isAddActive;
    if (!isAddActive) appRoot.classList.remove('add-text-input-active');
  }

  function syncTextInputFocus() {
    var active = document.activeElement;
    var isTextInputActive = active === locationInput || active === noteInput;
    appRoot.classList.toggle('add-text-input-active', isTextInputActive);
  }

  addView.addEventListener('focusin', function (event) {
    if (event.target === locationInput || event.target === noteInput) {
      syncTextInputFocus();
    }
  });
  addView.addEventListener('focusout', function () {
    setTimeout(syncTextInputFocus, 0);
  });

  new MutationObserver(syncViewState).observe(addView, {
    attributes: true,
    attributeFilter: ['class'],
  });
  syncViewState();
})();
