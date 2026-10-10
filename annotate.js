// chromium-bridge annotate overlay: the user's click-and-comment layer.
//
// page.js registers this alongside the chromiumBridge bootstrap, so it loads
// into every document chromium-bridge opens. The user holds Command and clicks
// an element to pick it, and writes comments that collect in a tray until
// they press Send. The agent resolves each comment through
// window.chromiumBridge, which this script extends with `resolve` and
// `comments` once it loads.
//
// Runs in the main world (agent-browser eval needs that) of the top frame
// only, and mounts all its own UI in one host element with a closed shadow
// root, so it never leaks into page CSS or agent-browser's accessibility
// snapshots.

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.__chromiumBridgeAnnotate) return;

  function boot() {
    if (window.__chromiumBridgeAnnotate) return;

    // === Constants =============================================================

    var MAX_ITEMS = 50;
    var MAX_COMMENT_CHARS = 2000;
    var MAX_TEXT_CHARS = 200;
    var MAX_HTML_CHARS = 2048;
    var MAX_NEARBY_CHARS = 300;

    var STYLE_PROPS = [
      "color", "background-color", "font-size", "font-weight",
      "display", "border", "border-radius", "text-align",
    ];

    var STABLE_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "name"];

    var SECRET_PATTERNS = [
      "access_token", "auth_token", "api_key", "apikey", "client_secret",
      "oauth_state", "session_id", "sessionid", "csrf", "secret", "password", "passwd",
    ];

    // === State ==================================================================
    //
    // One record per page (origin + pathname) in sessionStorage, so comments
    // survive a --watch reload but not closing the tab. Each item mirrors the
    // shape chromiumBridge.send eventually carries, plus lifecycle fields
    // (status, reply) the UI and the agent API both read and write.

    var storageKey = "chromiumBridgeAnnotate:" + location.origin + location.pathname;
    var state = loadState();
    var lastKnownPos = Object.create(null); // item id -> last resolved {x, y}, for stale pins

    function loadState() {
      try {
        var raw = sessionStorage.getItem(storageKey);
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && Array.isArray(parsed.items) && typeof parsed.nextId === "number") return parsed;
      } catch (e) {
        // Corrupt or unavailable storage falls through to a fresh state.
      }
      return { nextId: 1, items: [] };
    }

    function saveState() {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(state));
      } catch (e) {
        // Quota or a privacy mode that blocks storage: state just won't
        // survive a reload, which is a soft failure.
      }
    }

    function findItem(id) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === id) return state.items[i];
      }
      return null;
    }

    // === Selectors ===============================================================
    //
    // Builds the shortest selector that uniquely identifies an element: an id
    // first, then a stable test attribute, then a tag.class path with
    // :nth-of-type added only where siblings would otherwise collide. Walks
    // up from the element until the path is unique or document.body is hit.

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return "\\" + ch; });
    }

    function looksHashy(cls) {
      return /^[A-Za-z0-9_-]{12,}$/.test(cls) && /\d/.test(cls) && /[A-Z]/.test(cls);
    }

    // Class names that look generated (css-xxxx, a long mixed-case hash) make
    // poor selectors because a rebuild can change them; skip those.
    function stableClasses(el, max) {
      var out = [];
      if (!el.classList) return out;
      for (var i = 0; i < el.classList.length && out.length < max; i++) {
        var cls = el.classList[i];
        if (!cls || cls.length > 60 || /^css-[a-z0-9]+$/i.test(cls) || looksHashy(cls)) continue;
        out.push(cls);
      }
      return out;
    }

    function stableAttrSelector(el) {
      for (var i = 0; i < STABLE_ATTRS.length; i++) {
        var value = el.getAttribute(STABLE_ATTRS[i]);
        if (value) return "[" + STABLE_ATTRS[i] + '="' + cssEscape(value) + '"]';
      }
      return null;
    }

    function needsNth(el) {
      var parent = el.parentElement;
      if (!parent) return false;
      var count = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === el.tagName) count++;
        if (count > 1) return true;
      }
      return false;
    }

    function nthOfTypeSuffix(el) {
      var index = 1;
      var sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === el.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      return ":nth-of-type(" + index + ")";
    }

    function selectorPart(el) {
      var tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + cssEscape(el.id);
      var attr = stableAttrSelector(el);
      if (attr) return tag + attr;
      var classes = stableClasses(el, 2);
      var base = classes.length ? tag + classes.map(function (c) { return "." + cssEscape(c); }).join("") : tag;
      return needsNth(el) ? base + nthOfTypeSuffix(el) : base;
    }

    function isUnique(selector) {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch (e) {
        return false;
      }
    }

    function buildSelector(el) {
      var parts = [];
      var current = el;
      while (current && current.nodeType === 1 && current !== document.body && parts.length < 10) {
        parts.unshift(selectorPart(current));
        var selector = parts.join(" > ");
        if (isUnique(selector)) return selector;
        current = current.parentElement;
      }
      return parts.join(" > ") || el.tagName.toLowerCase();
    }

    // Absolute :nth-child path from <html>, as a fallback that is always
    // unique even when buildSelector's shorter path collides.
    function fullPathSelector(el) {
      var parts = [];
      var current = el;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        var parent = current.parentElement;
        var index = parent ? Array.prototype.indexOf.call(parent.children, current) + 1 : 1;
        parts.unshift(current.tagName.toLowerCase() + ":nth-child(" + index + ")");
        current = parent;
      }
      return parts.join(" > ");
    }

    function uniqueSelectorFor(el) {
      var selector = buildSelector(el);
      return safeQuery(selector) === el ? selector : fullPathSelector(el);
    }

    function safeQuery(selector) {
      try {
        return document.querySelector(selector);
      } catch (e) {
        return null;
      }
    }

    // === Capture =================================================================
    //
    // Turns a picked element into the JSON-safe payload fields Send carries.
    // Form field values are never read; redactedHtml blanks them out before
    // serializing, and attribute names or values that look like secrets are
    // stripped from both the html snippet and the raw attributes.

    function containsSecret(value) {
      if (!value) return false;
      var lower = String(value).toLowerCase();
      for (var i = 0; i < SECRET_PATTERNS.length; i++) {
        if (lower.indexOf(SECRET_PATTERNS[i]) !== -1) return true;
      }
      return false;
    }

    function clamp(str, max) {
      str = String(str || "");
      return str.length <= max ? str : str.slice(0, max) + "\u2026";
    }

    function isFormField(el) {
      return !!(el.matches && el.matches("input, textarea, select"));
    }

    // Never reads a form field's own text: that text is the value the user
    // typed or chose, not page copy.
    function boundedText(el, max) {
      if (isFormField(el)) return "";
      var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return clamp(text, max);
    }

    function computedStyleSubset(el) {
      var cs = window.getComputedStyle(el);
      var out = {};
      for (var i = 0; i < STYLE_PROPS.length; i++) out[STYLE_PROPS[i]] = cs.getPropertyValue(STYLE_PROPS[i]) || "";
      return out;
    }

    // A form field's name comes only from label-ish attributes, never from
    // boundedText, which would otherwise read its value back out.
    function accessibleName(el) {
      var label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
      if (label) return label;
      if (isFormField(el)) return el.getAttribute("placeholder") || el.getAttribute("name") || null;
      return boundedText(el, 60) || null;
    }

    // querySelectorAll only finds descendants, so the picked element itself
    // needs its own check: picking a form field directly, not just a
    // wrapper around one, must still strip its value.
    function stripFieldValue(node) {
      node.removeAttribute("value");
      node.value = "";
      if (node.tagName === "TEXTAREA") node.textContent = "";
      if (node.tagName === "SELECT") {
        var options = node.querySelectorAll("option");
        for (var i = 0; i < options.length; i++) {
          options[i].removeAttribute("selected");
          options[i].selected = false;
        }
        // One option is trivially "the" value by elimination, so its label
        // has to go too; with several, clearing selected on all of them
        // already hides which one was chosen.
        if (options.length === 1) options[0].textContent = "";
      }
    }

    function redactedHtml(el) {
      var clone = el.cloneNode(true);
      if (clone.matches && clone.matches("input, textarea, select")) stripFieldValue(clone);
      var fields = clone.querySelectorAll("input, textarea, select");
      for (var i = 0; i < fields.length; i++) stripFieldValue(fields[i]);
      var all = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
      for (var j = 0; j < all.length; j++) {
        var attrs = all[j].attributes;
        for (var k = attrs.length - 1; k >= 0; k--) {
          if (containsSecret(attrs[k].name) || containsSecret(attrs[k].value)) all[j].removeAttribute(attrs[k].name);
        }
      }
      return clamp(clone.outerHTML, MAX_HTML_CHARS);
    }

    function classList(el) {
      var raw = typeof el.className === "string" ? el.className.trim() : "";
      return raw ? raw.split(/\s+/).slice(0, 20) : [];
    }

    function captureElement(el) {
      var rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || null,
        name: accessibleName(el),
        text: boundedText(el, MAX_TEXT_CHARS),
        html: redactedHtml(el),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        classes: classList(el),
        styles: computedStyleSubset(el),
      };
    }

    function captureNearbyText(el) {
      var parent = el.parentElement;
      return parent ? boundedText(parent, MAX_NEARBY_CHARS) : "";
    }

    function anchorFraction(el, clientX, clientY) {
      var rect = el.getBoundingClientRect();
      var fx = rect.width ? (clientX - rect.left) / rect.width : 0.5;
      var fy = rect.height ? (clientY - rect.top) / rect.height : 0.5;
      return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
    }

    // === DOM helpers =============================================================

    function h(tag, props, children) {
      var node = document.createElement(tag);
      for (var key in props || {}) {
        if (key === "class") node.className = props[key];
        else if (key === "text") node.textContent = props[key];
        else node.setAttribute(key, props[key]);
      }
      (children || []).forEach(function (child) { node.appendChild(child); });
      return node;
    }

    // === Overlay host ============================================================
    //
    // One div in the light DOM with a closed shadow root. The host carries
    // aria-hidden so accessibility-tree snapshots (agent-browser's included)
    // skip it, and pointer-events:none keeps the page clickable everywhere
    // except the specific controls below that opt back in.

    var host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial; position:fixed; inset:0; pointer-events:none; z-index:2147483647;";
    document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: "closed" });

    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial;}",
      "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
      ".cb-highlight{position:fixed;pointer-events:none;display:none;border:2px solid rgba(255,255,255,.9);border-radius:3px;background:rgba(255,255,255,.08);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.25);}",
      ".cb-label{position:fixed;pointer-events:none;display:none;padding:3px 8px;background:rgba(28,28,30,.92);color:#f1f1f3;font-size:11px;line-height:1.4;border-radius:4px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.3);}",
      ".cb-pin{position:fixed;width:20px;height:20px;margin-left:-1px;margin-top:-19px;border-radius:50% 50% 50% 0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid rgba(255,255,255,.85);}",
      ".cb-pin-draft{background:#d6246e;}",
      ".cb-pin-sent{background:#2f6fed;}",
      ".cb-pin-resolved{background:#1ea672;}",
      ".cb-pin-stale{background:#6b7280;border-style:dashed;opacity:.75;}",
      ".cb-pin.cb-flash{animation:cb-flash .9s ease-out;}",
      "@keyframes cb-flash{0%{box-shadow:0 0 0 0 rgba(255,255,255,.9);}100%{box-shadow:0 0 0 14px rgba(255,255,255,0);}}",
      ".cb-toast{position:fixed;right:16px;bottom:54px;pointer-events:none;padding:6px 10px;border-radius:6px;background:rgba(28,28,30,.92);color:#f1f1f3;font-size:11px;opacity:0;transition:opacity .2s ease;}",
      ".cb-toast.cb-show{opacity:1;}",
      ".cb-popover{position:fixed;pointer-events:auto;width:280px;padding:10px;border-radius:10px;background:#1c1c1e;color:#f1f1f3;box-shadow:0 10px 28px rgba(0,0,0,.4);visibility:hidden;}",
      ".cb-popover-label{font-size:11px;color:#a1a1aa;margin-bottom:6px;word-break:break-word;}",
      ".cb-popover textarea{width:100%;height:70px;resize:vertical;border-radius:6px;border:1px solid #3a3a3c;background:#111113;color:#f1f1f3;font-size:12px;padding:6px 8px;font-family:inherit;}",
      ".cb-popover textarea:focus{outline:2px solid #2f6fed;outline-offset:1px;}",
      ".cb-intent{display:flex;gap:6px;margin-top:8px;}",
      ".cb-intent button{flex:1;padding:5px 0;font-size:11px;border-radius:6px;border:1px solid #3a3a3c;background:transparent;color:#d4d4d8;cursor:pointer;}",
      ".cb-intent button.cb-on{background:#2f6fed;border-color:#2f6fed;color:#fff;}",
      ".cb-popover-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:10px;}",
      ".cb-popover-actions button{padding:5px 10px;font-size:11px;border-radius:6px;border:none;cursor:pointer;}",
      ".cb-btn-cancel{background:#3a3a3c;color:#f1f1f3;}",
      ".cb-btn-add{background:#2f6fed;color:#fff;}",
      ".cb-btn-add:disabled{background:#3a3a3c;color:#808086;cursor:default;}",
      ".cb-tray{position:fixed;right:16px;bottom:56px;pointer-events:auto;width:290px;max-height:45vh;display:none;flex-direction:column;border-radius:10px;background:#1c1c1e;color:#f1f1f3;box-shadow:0 10px 28px rgba(0,0,0,.4);overflow:hidden;}",
      ".cb-tray.cb-open{display:flex;}",
      ".cb-tray-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 10px;border-bottom:1px solid #2d2d30;font-size:12px;font-weight:600;}",
      ".cb-tray-body{overflow-y:auto;padding:6px;}",
      ".cb-tray-item{padding:6px 8px;border-radius:6px;font-size:12px;margin-bottom:4px;}",
      ".cb-tray-item:hover{background:#26262a;}",
      ".cb-tray-row{display:flex;gap:6px;align-items:flex-start;}",
      ".cb-tray-num{flex:none;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}",
      ".cb-tray-main{flex:1;min-width:0;cursor:pointer;}",
      ".cb-tray-comment{color:#e4e4e7;word-break:break-word;}",
      ".cb-tray-meta{color:#8a8a90;font-size:10px;margin-top:2px;text-transform:capitalize;}",
      ".cb-tray-reply{margin-top:4px;padding:5px 6px;border-radius:5px;background:#10381f;color:#bdf2cf;font-size:11px;}",
      ".cb-tray-actions{flex:none;display:flex;gap:2px;}",
      ".cb-tray-actions button{background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:11px;padding:2px 4px;}",
      ".cb-tray-actions button:hover{color:#f1f1f3;}",
      ".cb-tray-foot{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #2d2d30;}",
      ".cb-tray-foot button{flex:1;font-size:11px;padding:5px 0;border-radius:6px;border:none;cursor:pointer;}",
      ".cb-btn-send{background:#2f6fed;color:#fff;}",
      ".cb-btn-send:disabled{background:#3a3a3c;color:#808086;cursor:default;}",
      ".cb-btn-neutral{background:#3a3a3c;color:#f1f1f3;}",
      ".cb-pill{position:fixed;right:16px;bottom:16px;pointer-events:auto;display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:none;cursor:pointer;background:rgba(28,28,30,.92);color:#f1f1f3;font-size:12px;font-weight:500;box-shadow:0 2px 10px rgba(0,0,0,.3);}",
      ".cb-pill-count{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:rgba(255,255,255,.25);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;}",
    ].join("\n");
    shadow.appendChild(style);

    // Paint order doubles as hit-test order for overlapping fixed elements,
    // so the pill goes last (always on top, always reachable).
    var highlight = h("div", { class: "cb-highlight" });
    var label = h("div", { class: "cb-label" });
    var pinsLayer = h("div", { class: "cb-pins" });
    var tray = buildTray();
    var popover = buildPopover();
    var toast = h("div", { class: "cb-toast" });
    var pill = buildPill();
    [highlight, label, pinsLayer, tray, popover, toast, pill].forEach(function (node) {
      shadow.appendChild(node);
    });

    // === Picker ==================================================================
    //
    // No mode, no full-viewport catcher. Command (the Meta key) is tracked
    // directly: held down, it shows a live hover highlight; released, the
    // highlight disappears. A Command-click picks whatever element the
    // click actually landed on. Ordinary clicks are never touched, so nothing
    // here can interfere with normal use of the page.
    //
    // Not Option: macOS hides the frontmost app when you Option-click into
    // another app's window, which collapses a tiled terminal beside it.

    var popoverOpen = false;
    var metaHeld = false;
    var lastMouse = { x: -1, y: -1 };

    function hideHighlight() {
      highlight.style.display = "none";
      label.style.display = "none";
    }

    function showHighlightFor(el) {
      var rect = el.getBoundingClientRect();
      highlight.style.left = rect.left + "px";
      highlight.style.top = rect.top + "px";
      highlight.style.width = rect.width + "px";
      highlight.style.height = rect.height + "px";
      highlight.style.display = "block";

      var cls = el.classList && el.classList.length ? "." + el.classList[0] : "";
      label.textContent = el.tagName.toLowerCase() + cls + " " + Math.round(rect.width) + "\u00d7" + Math.round(rect.height);
      var labelTop = rect.bottom + 6;
      if (labelTop + 24 > window.innerHeight) labelTop = rect.top - 24;
      label.style.left = Math.max(4, rect.left) + "px";
      label.style.top = labelTop + "px";
      label.style.display = "block";
    }

    function updateHighlightNow() {
      if (!metaHeld || popoverOpen) { hideHighlight(); return; }
      var el = document.elementFromPoint(lastMouse.x, lastMouse.y);
      if (!el || el === host || el === document.documentElement || el === document.body) { hideHighlight(); return; }
      showHighlightFor(el);
    }

    var highlightQueued = false;
    function scheduleHighlightUpdate() {
      if (highlightQueued) return;
      highlightQueued = true;
      requestAnimationFrame(function () { highlightQueued = false; updateHighlightNow(); });
    }

    // Always on, cheap: just records the pointer position and keeps metaHeld
    // in sync with the event's own metaKey. That sync is a safety net beyond
    // the keydown/keyup tracking below, in case a keyup is ever missed (for
    // example Command released while a different window had focus).
    window.addEventListener("mousemove", function (e) {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
      if (e.metaKey !== metaHeld) { metaHeld = e.metaKey; updateHighlightNow(); return; }
      if (metaHeld) scheduleHighlightUpdate();
    }, true);

    window.addEventListener("keydown", function (e) {
      if (e.key === "Meta" && !metaHeld) { metaHeld = true; updateHighlightNow(); }
      if (popoverOpen) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePopover(); return; }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submitPopover(); }
      }
    }, true);

    window.addEventListener("keyup", function (e) {
      if (e.key === "Meta") { metaHeld = false; hideHighlight(); }
    }, true);

    window.addEventListener("blur", function () { metaHeld = false; hideHighlight(); });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { metaHeld = false; hideHighlight(); }
    });

    // Swallows the gesture at the earliest possible point (capture on
    // window, ahead of document and the real target) so the page's own
    // listeners for these never run, and preventDefault blocks Chromium's
    // own default actions for a Command-held click, such as opening a link
    // in a new tab. Our own UI (host, via shadow retargeting) is
    // exempt so plain clicks on the pill or tray keep working normally.
    function onMetaIntercept(e) {
      if (!e.metaKey || e.target === host) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener("pointerdown", onMetaIntercept, true);
    window.addEventListener("mousedown", onMetaIntercept, true);
    window.addEventListener("auxclick", onMetaIntercept, true);

    window.addEventListener("click", function (e) {
      if (!e.metaKey || e.target === host) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var el = e.target;
      if (!el || el === document.documentElement || el === document.body) return;
      openPopoverForNew(el, e.clientX, e.clientY);
    }, true);

    // === Popover =================================================================

    var popoverDraft = null; // { mode: "new"|"edit", id?, selector, anchor, element, nearbyText, text, intent }

    function buildPopover() {
      var el = h("div", { class: "cb-popover" });
      el.appendChild(h("div", { class: "cb-popover-label" }));
      var textarea = h("textarea", { maxlength: String(MAX_COMMENT_CHARS), placeholder: "Describe what the agent should change here\u2026" });
      textarea.addEventListener("input", function () {
        if (popoverDraft) popoverDraft.text = textarea.value;
        updateAddButton();
      });
      el.appendChild(textarea);

      var intentRow = h("div", { class: "cb-intent" });
      var changeBtn = h("button", { type: "button", text: "Change" });
      var questionBtn = h("button", { type: "button", text: "Question" });
      changeBtn.addEventListener("click", function () { setPopoverIntent("change"); });
      questionBtn.addEventListener("click", function () { setPopoverIntent("question"); });
      intentRow.appendChild(changeBtn);
      intentRow.appendChild(questionBtn);
      el.appendChild(intentRow);

      var actions = h("div", { class: "cb-popover-actions" });
      var cancelBtn = h("button", { type: "button", class: "cb-btn-cancel", text: "Cancel" });
      var addBtn = h("button", { type: "button", class: "cb-btn-add", text: "Add" });
      cancelBtn.addEventListener("click", closePopover);
      addBtn.addEventListener("click", submitPopover);
      actions.appendChild(cancelBtn);
      actions.appendChild(addBtn);
      el.appendChild(actions);

      el._textarea = textarea;
      el._label = el.children[0];
      el._changeBtn = changeBtn;
      el._questionBtn = questionBtn;
      el._addBtn = addBtn;
      return el;
    }

    function setPopoverIntent(intent) {
      if (!popoverDraft) return;
      popoverDraft.intent = intent;
      popover._textarea.placeholder =
        intent === "question" ? "Ask the agent about this\u2026" : "Describe what the agent should change here\u2026";
      popover._changeBtn.classList.toggle("cb-on", intent === "change");
      popover._questionBtn.classList.toggle("cb-on", intent === "question");
    }

    function updateAddButton() {
      popover._addBtn.disabled = !popoverDraft || !popoverDraft.text.trim();
    }

    function openPopoverForNew(el, clientX, clientY) {
      if (state.items.length >= MAX_ITEMS) {
        showToast("Limit of " + MAX_ITEMS + " comments reached");
        return;
      }
      popoverDraft = {
        mode: "new",
        selector: uniqueSelectorFor(el),
        anchor: anchorFraction(el, clientX, clientY),
        element: captureElement(el),
        nearbyText: captureNearbyText(el),
        text: "",
        intent: "change",
      };
      showPopover(el.getBoundingClientRect(), { x: clientX, y: clientY });
    }

    function openPopoverForEdit(item) {
      var liveEl = safeQuery(item.anchor.selector);
      var rect = liveEl ? liveEl.getBoundingClientRect() : null;
      var point = rect
        ? { x: rect.left + item.anchor.fx * rect.width, y: rect.top + item.anchor.fy * rect.height }
        : lastKnownPos[item.id] || { x: window.innerWidth - 40, y: window.innerHeight - 80 };
      popoverDraft = {
        mode: "edit",
        id: item.id,
        selector: item.anchor.selector,
        anchor: item.anchor,
        element: item.element,
        nearbyText: item.nearbyText,
        text: item.comment,
        intent: item.intent,
      };
      showPopover(rect, point);
    }

    function showPopover(rect, point) {
      popoverOpen = true;
      hideHighlight();
      popover._label.textContent = (popoverDraft.element.name || popoverDraft.element.text || popoverDraft.element.tag) + "  \u00b7  " + popoverDraft.selector;
      popover._textarea.value = popoverDraft.text;
      setPopoverIntent(popoverDraft.intent);
      updateAddButton();

      popover.style.visibility = "hidden";
      popover.style.left = "0px";
      popover.style.top = "0px";
      popover.style.display = "block";
      var pw = popover.offsetWidth;
      var ph = popover.offsetHeight;
      positionNear(popover, rect, point, pw, ph);
      popover.style.visibility = "visible";
      popover._textarea.focus();
    }

    function positionNear(node, rect, point, width, height) {
      var vw = window.innerWidth, vh = window.innerHeight;
      var anchorX = rect ? rect.left + rect.width / 2 : point.x;
      var below = (rect ? rect.bottom : point.y) + 8 + height <= vh;
      var top = below ? (rect ? rect.bottom : point.y) + 8 : (rect ? rect.top : point.y) - 8 - height;
      top = Math.max(8, Math.min(top, vh - height - 8));
      var left = Math.max(8, Math.min(anchorX - width / 2, vw - width - 8));
      node.style.left = left + "px";
      node.style.top = top + "px";
    }

    function closePopover() {
      popoverOpen = false;
      popover.style.display = "none";
      popoverDraft = null;
    }

    function submitPopover() {
      if (!popoverDraft || !popoverDraft.text.trim()) return;
      var text = popoverDraft.text.trim().slice(0, MAX_COMMENT_CHARS);
      if (popoverDraft.mode === "new") {
        var id = "c" + state.nextId++;
        state.items.push({
          id: id,
          intent: popoverDraft.intent,
          comment: text,
          status: "draft",
          reply: null,
          anchor: { selector: popoverDraft.selector, fx: popoverDraft.anchor.fx, fy: popoverDraft.anchor.fy },
          element: popoverDraft.element,
          nearbyText: popoverDraft.nearbyText,
        });
      } else {
        var item = findItem(popoverDraft.id);
        if (item) {
          item.comment = text;
          item.intent = popoverDraft.intent;
        }
      }
      saveState();
      closePopover();
      trayCollapsed = false; // reveal the tray so the new comment is visible
      scheduleRender();
    }

    // === Tray ====================================================================

    var trayCollapsed = true; // starts closed; the pill or a new comment opens it

    // An empty tray has nothing to show, so it folds back to the button.
    function collapseIfEmpty() {
      if (!state.items.length) trayCollapsed = true;
    }

    function toggleTray() {
      trayCollapsed = !trayCollapsed;
      scheduleRender();
    }

    function buildTray() {
      var el = h("div", { class: "cb-tray" });
      var head = h("div", { class: "cb-tray-head" });
      var title = h("span", { text: "0 comments" });
      head.appendChild(title);
      el.appendChild(head);

      var body = h("div", { class: "cb-tray-body" });
      el.appendChild(body);

      var foot = h("div", { class: "cb-tray-foot" });
      var clearBtn = h("button", { type: "button", class: "cb-btn-neutral", text: "Clear resolved" });
      var collapseBtn = h("button", { type: "button", class: "cb-btn-neutral", text: "Collapse" });
      var sendBtn = h("button", { type: "button", class: "cb-btn-send", text: "Send" });
      clearBtn.addEventListener("click", function () {
        state.items = state.items.filter(function (item) { return item.status !== "resolved"; });
        collapseIfEmpty();
        saveState();
        scheduleRender();
      });
      collapseBtn.addEventListener("click", toggleTray);
      sendBtn.addEventListener("click", sendComments);
      foot.appendChild(clearBtn);
      foot.appendChild(collapseBtn);
      foot.appendChild(sendBtn);
      el.appendChild(foot);

      el._title = title;
      el._body = body;
      el._sendBtn = sendBtn;
      return el;
    }

    function statusClass(status, stale) {
      if (stale) return "cb-pin-stale";
      return "cb-pin-" + status;
    }

    function renderTray() {
      var items = state.items;
      tray.classList.toggle("cb-open", !trayCollapsed);
      tray._title.textContent = items.length === 1 ? "1 comment" : items.length + " comments";
      tray._sendBtn.disabled = !items.some(function (item) { return item.status === "draft"; });

      tray._body.innerHTML = "";
      items.forEach(function (item, index) {
        var stale = !safeQuery(item.anchor.selector);
        var row = h("div", { class: "cb-tray-item" });
        var line = h("div", { class: "cb-tray-row" });
        var num = h("div", { class: "cb-tray-num " + statusClass(item.status, stale), text: String(index + 1) });
        var main = h("div", { class: "cb-tray-main" });
        main.appendChild(h("div", { class: "cb-tray-comment", text: item.comment }));
        main.appendChild(h("div", { class: "cb-tray-meta", text: item.intent + " \u00b7 " + (stale ? "stale" : item.status) }));
        if (item.reply) main.appendChild(h("div", { class: "cb-tray-reply", text: item.reply }));
        main.addEventListener("click", function () { flashElement(item.anchor.selector); });
        line.appendChild(num);
        line.appendChild(main);

        if (item.status === "draft") {
          var actions = h("div", { class: "cb-tray-actions" });
          var editBtn = h("button", { type: "button", text: "Edit" });
          var deleteBtn = h("button", { type: "button", text: "Delete" });
          editBtn.addEventListener("click", function (e) { e.stopPropagation(); openPopoverForEdit(item); });
          deleteBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            state.items = state.items.filter(function (other) { return other.id !== item.id; });
            collapseIfEmpty();
            saveState();
            scheduleRender();
          });
          actions.appendChild(editBtn);
          actions.appendChild(deleteBtn);
          line.appendChild(actions);
        }

        row.appendChild(line);
        tray._body.appendChild(row);
      });
    }

    function flashElement(selector) {
      var el = safeQuery(selector);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      var original = el.style.outline;
      var originalOffset = el.style.outlineOffset;
      el.style.outline = "3px solid #2f6fed";
      el.style.outlineOffset = "2px";
      setTimeout(function () {
        el.style.outline = original;
        el.style.outlineOffset = originalOffset;
      }, 900);
    }

    // === Pins ====================================================================

    function pinPosition(item) {
      var el = safeQuery(item.anchor.selector);
      if (el) {
        var rect = el.getBoundingClientRect();
        var pos = { x: rect.left + item.anchor.fx * rect.width, y: rect.top + item.anchor.fy * rect.height, stale: false };
        lastKnownPos[item.id] = { x: pos.x, y: pos.y };
        return pos;
      }
      var last = lastKnownPos[item.id];
      if (last) return { x: last.x, y: last.y, stale: true };
      // lastKnownPos is in-memory only, so a reload that also removes the
      // anchor leaves nothing cached this session. Fall back to the rect
      // captured when the comment was made, so the pin still shows stale
      // instead of vanishing.
      var capturedRect = item.element && item.element.rect;
      if (!capturedRect) return null;
      return {
        x: capturedRect.x + item.anchor.fx * capturedRect.width,
        y: capturedRect.y + item.anchor.fy * capturedRect.height,
        stale: true,
      };
    }

    function renderPins() {
      pinsLayer.innerHTML = "";
      state.items.forEach(function (item, index) {
        var pos = pinPosition(item);
        if (!pos) return;
        var pin = h("div", { class: "cb-pin " + statusClass(item.status, pos.stale), text: String(index + 1) });
        pin.style.left = pos.x + "px";
        pin.style.top = pos.y + "px";
        pin.addEventListener("click", function () {
          flashElement(item.anchor.selector);
          pin.classList.remove("cb-flash");
          void pin.offsetWidth; // restart the animation on repeat clicks
          pin.classList.add("cb-flash");
        });
        pinsLayer.appendChild(pin);
      });
    }

    // === Entry: pill ============================================================

    function buildPill() {
      var el = h("button", { type: "button", class: "cb-pill", title: "\u2318-click to comment" });
      el.appendChild(h("span", { text: "Annotate" }));
      var count = h("span", { class: "cb-pill-count" });
      count.style.display = "none";
      el.appendChild(count);
      el.addEventListener("click", toggleTray);
      el._count = count;
      return el;
    }

    function renderPill() {
      var drafts = state.items.filter(function (item) { return item.status === "draft"; }).length;
      pill._count.style.display = drafts > 0 ? "flex" : "none";
      pill._count.textContent = String(drafts);
    }

    var toastTimer;
    function showToast(text, durationMs) {
      toast.textContent = text;
      toast.classList.add("cb-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.remove("cb-show"); }, durationMs || 2000);
    }

    function pluralize(n, word) {
      return n + " " + word + (n === 1 ? "" : "s");
    }

    // === Payload / Send ==========================================================

    function buildPagePayload() {
      return {
        url: location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        dpr: window.devicePixelRatio || 1,
      };
    }

    function toPayloadItem(item) {
      return {
        id: item.id,
        intent: item.intent,
        comment: item.comment,
        anchor: item.anchor,
        element: item.element,
        nearbyText: item.nearbyText,
      };
    }

    function sendComments() {
      var drafts = state.items.filter(function (item) { return item.status === "draft"; });
      if (!drafts.length) return;
      showToast("Sending " + pluralize(drafts.length, "comment") + "\u2026");
      window.chromiumBridge.send({ type: "comments", page: buildPagePayload(), items: drafts.map(toPayloadItem) });
      drafts.forEach(function (item) { item.status = "sent"; });
      saveState();
      scheduleRender();
    }

    // === Render loop =============================================================

    var renderQueued = false;
    function scheduleRender() {
      // With no comments, a collapsed tray, and nothing left on screen, a
      // render would change nothing, so a busy page's DOM churn costs nothing.

      var idle = state.items.length === 0 && trayCollapsed;
      if (idle && !tray.classList.contains("cb-open") && !pinsLayer.firstChild) return;
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(function () {
        renderQueued = false;
        renderPins();
        renderTray();
        renderPill();
      });
    }

    window.addEventListener("scroll", scheduleRender, true);
    window.addEventListener("resize", scheduleRender);
    new MutationObserver(scheduleRender).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
    });

    // === Agent API ===============================================================

    // Read-only, so a page script can't swap out what chromiumBridge
    // delegates to.

    var api = {
      resolve: function (id, reply) {
        var item = findItem(id);
        if (!item) return false;
        item.status = "resolved";
        item.reply = reply == null ? "" : String(reply);
        saveState();
        scheduleRender();
        return true;
      },
      comments: function () {
        return state.items.map(function (item) {
          return {
            id: item.id,
            intent: item.intent,
            comment: item.comment,
            status: item.status,
            reply: item.reply,
            selector: item.anchor.selector,
          };
        });
      },
      // The daemon's doorbell feedback: a delivery result, shown as a toast.
      notice: function (text) {
        showToast(String(text == null ? "" : text), 4000);
        return true;
      },
    };
    Object.defineProperty(window, "__chromiumBridgeAnnotate", { value: Object.freeze(api) });

    scheduleRender();
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
