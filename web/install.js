// "Install Tracy" — a mobile install bar, plus a small API (window.TracyInstall)
// that Settings uses as a backup entry point.
//
// Android/Chromium: real install via the `beforeinstallprompt` event.
// iOS/Safari: no programmatic install exists — we show instructions instead
// ("Share → Add to Home Screen"), and note that only Safari can do it on iOS.
(function () {
  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  var isMobile = isIOS || isAndroid;
  var isIOSSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios|opt\//i.test(ua);
  function standalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
  }
  function iosHint() {
    return isIOSSafari
      ? "Tap the Share icon (the box with an up-arrow) at the bottom of Safari, then scroll down and tap “Add to Home Screen.”"
      : "This only works in Safari on iPhone. Open this page in Safari, tap the Share icon, then “Add to Home Screen.”";
  }

  var deferred = null;

  // Public API for Settings.
  window.TracyInstall = {
    isIOS: isIOS,
    isIOSSafari: isIOSSafari,
    isMobile: isMobile,
    isStandalone: standalone,
    canPrompt: function () { return !!deferred; },
    iosHint: iosHint,
    prompt: function () {
      if (!deferred) return Promise.resolve("unavailable");
      deferred.prompt();
      var choice = deferred.userChoice || Promise.resolve({ outcome: "dismissed" });
      return choice.then(function (r) { deferred = null; return r && r.outcome; });
    },
  };

  // ---- The auto-shown bar ----
  var bar = document.getElementById("install-bar");
  var sub = document.getElementById("install-sub");
  var action = document.getElementById("install-action");
  var closeBtn = document.getElementById("install-close");
  var DISMISS_KEY = "tracy.installDismissed";
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    // Only auto-show the bar if not installed / not dismissed.
    if (bar && !standalone() && !get(DISMISS_KEY)) {
      if (action) action.hidden = false;
      if (sub) sub.textContent = "Add her to your home screen for a full-screen app.";
      bar.hidden = false; requestAnimationFrame(function () { bar.classList.add("show"); });
    }
  });
  window.addEventListener("appinstalled", function () { set(DISMISS_KEY, "1"); if (bar) { bar.classList.remove("show"); setTimeout(function () { bar.hidden = true; }, 250); } });

  if (!bar) return;
  function hide() { bar.classList.remove("show"); setTimeout(function () { bar.hidden = true; }, 250); }
  if (closeBtn) closeBtn.addEventListener("click", function () { set(DISMISS_KEY, "1"); hide(); });
  if (action) action.addEventListener("click", function () {
    if (!deferred) { set(DISMISS_KEY, "1"); hide(); return; }
    window.TracyInstall.prompt().then(function () { set(DISMISS_KEY, "1"); hide(); });
  });

  // iOS: no beforeinstallprompt — show the instructions bar (unless installed/dismissed).
  if (isIOS && !standalone() && !get(DISMISS_KEY)) {
    if (action) action.hidden = true;
    if (sub) sub.innerHTML = iosHint();
    setTimeout(function () { bar.hidden = false; requestAnimationFrame(function () { bar.classList.add("show"); }); }, 1200);
  }
})();
