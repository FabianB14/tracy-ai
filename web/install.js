// "Install Tracy" prompt for mobile.
//
// Android/Chromium: a real install prompt via the `beforeinstallprompt` event —
// we capture it and wire it to the Install button.
// iOS/Safari: there is NO programmatic install on iOS, so we show instructions
// ("tap Share, then Add to Home Screen") instead. On iOS the only browser that
// can add to the home screen is Safari, so we say so if they're elsewhere.
//
// The bar never shows when already installed (standalone) or after it's dismissed.
(function () {
  var bar = document.getElementById("install-bar");
  if (!bar) return;
  var sub = document.getElementById("install-sub");
  var action = document.getElementById("install-action");
  var closeBtn = document.getElementById("install-close");

  var DISMISS_KEY = "tracy.installDismissed";
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  var isMobile = isIOS || isAndroid;
  // On iOS, only real Safari can Add to Home Screen (Chrome/Firefox iOS cannot).
  var isIOSSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios|opt\//i.test(ua);
  var isStandalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;

  // Don't show on desktop, when already installed, or once dismissed.
  if (!isMobile || isStandalone || get(DISMISS_KEY)) return;

  function show() { bar.hidden = false; requestAnimationFrame(function () { bar.classList.add("show"); }); }
  function hide() { bar.classList.remove("show"); setTimeout(function () { bar.hidden = true; }, 250); }
  function dismiss() { set(DISMISS_KEY, "1"); hide(); }
  closeBtn.addEventListener("click", dismiss);

  var deferred = null;

  // ---- Android / Chromium: real prompt ----
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    action.hidden = false;
    if (sub) sub.textContent = "Add her to your home screen for a full-screen app.";
    show();
  });
  action.addEventListener("click", function () {
    if (!deferred) { dismiss(); return; }
    deferred.prompt();
    var choice = deferred.userChoice || Promise.resolve({ outcome: "dismissed" });
    choice.then(function () { set(DISMISS_KEY, "1"); deferred = null; hide(); });
  });
  // If it installs, hide and remember.
  window.addEventListener("appinstalled", function () { set(DISMISS_KEY, "1"); hide(); });

  // ---- iOS: no prompt event exists — show instructions ----
  if (isIOS) {
    action.hidden = true; // nothing to click; it's a manual gesture
    if (sub) {
      sub.innerHTML = isIOSSafari
        ? 'Tap the Share button, then <strong>“Add to Home Screen.”</strong>'
        : 'Open this page in <strong>Safari</strong>, then Share → <strong>“Add to Home Screen.”</strong>';
    }
    // Small delay so it doesn't slam in on first paint.
    setTimeout(show, 1200);
  }
})();
