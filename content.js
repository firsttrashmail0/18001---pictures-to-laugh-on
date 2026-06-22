/**
 * Sticker Shortcuts - Content Script
 * 
 * Replaces text shortcuts (e.g. ":john") with images in
 * contenteditable rich text editors like Google Chat, Slack, etc.
 * 
 * Strategy:
 *   1. Listen for keydown on Space key (capture phase).
 *   2. Read the text content before the caret.
 *   3. If it ends with a known shortcut like ":john", prevent the
 *      default space, delete the shortcut text, then simulate a
 *      clipboard paste of the image so the editor accepts it natively.
 */

(function () {
  "use strict";

  // Bail out early if extension APIs are not available (e.g. in sandboxed iframes)
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
    return;
  }

  // ─── Shortcut Map ───────────────────────────────────────────────
  const SHORTCUTS = {
    ":john": "images/john.png",
    ":black-friday": "images/black-friday.png",
    ":static-guy": "images/static-guy.png"
  };

  const MAX_SHORTCUT_LEN = Math.max(...Object.keys(SHORTCUTS).map(s => s.length));

  // Pre-resolve all image URLs while chrome.runtime is guaranteed to be available.
  const RESOLVED_URLS = {};
  for (const [shortcut, path] of Object.entries(SHORTCUTS)) {
    RESOLVED_URLS[shortcut] = chrome.runtime.getURL(path);
  }

  console.log("[Sticker Shortcuts] Loaded on", window.location.href);
  console.log("[Sticker Shortcuts] Resolved URLs:", RESOLVED_URLS);

  // ─── Helpers ────────────────────────────────────────────────────

  /** Strip zero-width invisible characters that editors inject. */
  function stripInvisible(str) {
    return str.replace(/[\u200B-\u200D\uFEFF]/g, "");
  }

  /**
   * Walk backwards from caret across DOM nodes to collect up to `maxLen`
   * characters of visible text.
   */
  function collectTextBeforeCaret(maxLen) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;

    let node = range.startContainer;
    let offset = range.startOffset;

    // If caret is inside an element node, find the text node before it
    if (node.nodeType !== Node.TEXT_NODE) {
      if (offset > 0 && node.childNodes[offset - 1]) {
        let candidate = node.childNodes[offset - 1];
        while (candidate.lastChild) candidate = candidate.lastChild;
        if (candidate.nodeType === Node.TEXT_NODE) {
          node = candidate;
          offset = candidate.textContent.length;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    // Find the editable root
    let editableRoot = node.parentElement;
    while (editableRoot && editableRoot.contentEditable !== "true") {
      editableRoot = editableRoot.parentElement;
    }
    if (!editableRoot) return null;

    // Collect text segments walking backwards
    const segments = [];
    let collected = "";

    const firstChunk = node.textContent.substring(0, offset);
    segments.unshift({ node, start: 0, end: offset });
    collected = firstChunk;

    if (collected.length < maxLen) {
      const walker = document.createTreeWalker(editableRoot, NodeFilter.SHOW_TEXT);
      walker.currentNode = node;
      let prev;
      while ((prev = walker.previousNode()) && collected.length < maxLen) {
        segments.unshift({ node: prev, start: 0, end: prev.textContent.length });
        collected = prev.textContent + collected;
      }
    }

    return { text: collected, segments, editableRoot };
  }

  /**
   * Create a Range selecting the last `matchLen` characters
   * from the collected text segments.
   */
  function createRangeForMatch(segments, totalText, matchLen) {
    const startCharIdx = totalText.length - matchLen;
    const range = document.createRange();

    let charsSoFar = 0;
    let startSet = false;

    for (const seg of segments) {
      const segText = seg.node.textContent.substring(seg.start, seg.end);
      const segStart = charsSoFar;
      const segEnd = charsSoFar + segText.length;

      if (!startSet && startCharIdx < segEnd) {
        const localOffset = startCharIdx - segStart + seg.start;
        range.setStart(seg.node, localOffset);
        startSet = true;
      }

      if (segEnd >= totalText.length) {
        range.setEnd(seg.node, seg.end);
        break;
      }

      charsSoFar = segEnd;
    }

    return range;
  }

  /** Check if collected text ends with a known shortcut. */
  function findMatch(rawText) {
    for (const shortcut of Object.keys(SHORTCUTS)) {
      const len = shortcut.length;
      for (let extra = 0; extra <= 5; extra++) {
        const tail = rawText.slice(-(len + extra));
        if (stripInvisible(tail) === shortcut) {
          return { shortcut, rawMatchLen: len + extra };
        }
      }
    }
    return null;
  }

  /** Simulate a clipboard paste event with an image blob. */
  function simulatePaste(editableRoot, imageBlob) {
    const file = new File([imageBlob], "sticker.png", { type: imageBlob.type });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });

    editableRoot.dispatchEvent(pasteEvent);
  }

  // ─── Core handler ───────────────────────────────────────────────

  async function onKeyDown(e) {
    if (e.key !== " " && e.code !== "Space") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const data = collectTextBeforeCaret(MAX_SHORTCUT_LEN + 10);
    if (!data) return;

    const match = findMatch(data.text);
    if (!match) return;

    const imgUrl = RESOLVED_URLS[match.shortcut];
    if (!imgUrl) return;

    console.log("[Sticker Shortcuts] Matched:", match.shortcut);

    // ── Match found! ──
    e.preventDefault();
    e.stopImmediatePropagation();

    // 1. Select the shortcut text and delete it
    const replaceRange = createRangeForMatch(data.segments, data.text, match.rawMatchLen);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(replaceRange);
    document.execCommand("delete", false);

    // 2. Fetch the image from the pre-resolved extension URL
    try {
      const response = await fetch(imgUrl);
      const imageBlob = await response.blob();

      // 3. Simulate a paste with the image
      simulatePaste(data.editableRoot, imageBlob);
      console.log("[Sticker Shortcuts] Paste dispatched successfully");
    } catch (err) {
      console.error("[Sticker Shortcuts] Failed to fetch/paste image:", err);
    }
  }

  document.addEventListener("keydown", onKeyDown, true);

})();
