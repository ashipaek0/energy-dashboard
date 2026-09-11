/**
 * Epilykos Network Detector — TRUE auto-failover base-URL resolver (Phase 4, Slice 2)
 *
 * Responsibilities:
 * 1. Load network URLs from server config (via /api/network-config)
 * 2. Send URLs to Service Worker for routing (kept — SW uses them for offline cache / background sync)
 * 3. Resolve the active base URL (Auto/Local/Remote override persisted in localStorage)
 * 4. D-4A: origin-redirect the SPA to the reachable base once (reads stay relative/same-origin, no CORS)
 * 5. Periodic re-check with hysteresis (N consecutive failures) + backoff when both bases are down
 * 6. Live base-activity indicator (Local / Remote / Offline badge + Auto/Local/Remote select)
 *
 * The passive green "switch to local" banner is superseded by the live indicator.
 * Design notes (from the locked decisions):
 *   D-4A  -> origin-switch on failover, single reload
 *   D-4B  -> image-ping probes (no CORS needed, bypasses mixed-content)
 *   D-4C  -> this module is the SOLE owner of base selection
 *   D-4D  -> mode persisted in localStorage 'epilykos-network-mode' (default 'auto')
 *   D-4E  -> read-only public GETs only; authenticated POSTs are never touched
 */

// ── Constants ─────────────────────────────────────────────────────────
const NET_MODE_KEY = 'epilykos-network-mode';
const BASE_CHECK_MS = 12000;          // ~12s periodic re-check
const HYSTERESIS_THRESHOLD = 3;       // consecutive failing probes before we switch/failover
const OFFLINE_BACKOFF_MS = 30000;     // back off to 30s when both bases are down

// ── Constants: Phase 2b — network-mode pill auto-hide ──────────────────
// Every resolved Phase-2b choice is exactly one literal here, so any future
// revision stays a one-line change. The mechanism below is driven from these,
// never from a hard-coded value.
const AUTO_HIDE_MS = 5000;                              // 5s: the pill auto-hide window
const AUTO_HIDE_TARGET = '#epilykos-network-indicator'; // the WHOLE pill hides (badge + select + offline notice)
const AUTO_HIDE_REVEAL = 'handle';                      // a persistent handle toggles the pill

// ── State ─────────────────────────────────────────────────────────────
let cachedConfig = null;      // last {localURL, remoteURL} from /api/network-config
let activeBase = null;        // last known active base URL (exposed via getActiveBase)
let checkTimer = null;        // setTimeout handle for the periodic re-check
let currentInterval = BASE_CHECK_MS;
let consecutiveDown = 0;      // consecutive unreachable probes for the CURRENT origin
let offlineFlag = false;      // both bases down -> offline state + backoff

// Phase 2b state (independent of checkTimer — R1)
let autoHideTimer = null;     // setTimeout handle for the pill auto-hide countdown
let indicatorHidden = false;  // current hidden state of the pill (drives the handle's aria-expanded)
let pillFocused = false;      // true while focus is inside the pill -> auto-hide suspended (P2b.7)
let hideToken = 0;            // invalidates a pending faded-hide so it can never hide a re-revealed pill

// ── Mode helpers ──────────────────────────────────────────────────────
function getNetworkMode() {
  try {
    const m = localStorage.getItem(NET_MODE_KEY);
    return (m === 'local' || m === 'remote') ? m : 'auto';
  } catch (e) {
    return 'auto';
  }
}

function urlOrigin(u) {
  if (!u) return null;
  try { return new URL(u).origin; } catch (e) { return null; }
}

// ── Send config to SW ────────────────────────────────────────────────
function sendConfigToSW(localURL, remoteURL) {
  if (!navigator.serviceWorker?.controller) {
    // SW not ready yet — retry when it is
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(reg => {
        reg.active?.postMessage({ type: 'network-config', localURL, remoteURL });
      });
    }
    return;
  }
  navigator.serviceWorker.controller.postMessage({
    type: 'network-config',
    localURL,
    remoteURL
  });
  console.debug('[Network] Sent config to SW:', { localURL, remoteURL });
}

// ── Load from server ─────────────────────────────────────────────────
async function loadNetworkConfig() {
  try {
    const res = await fetch('/api/network-config');
    if (res.ok) {
      const config = await res.json();
      if (config.localURL || config.remoteURL) {
        sendConfigToSW(config.localURL || '', config.remoteURL || '');
        return config;
      }
    }
  } catch (e) {
    // Not logged in or endpoint not available — that's fine
  }
  return null;
}

// ── Probe a base (image ping) ─────────────────────────────────────────
// Uses an image ping instead of fetch — images bypass mixed-content
// blocking, so this works even from HTTPS pages, and cross-origin image
// loads need no CORS (D-4B). Adapted to probe ANY base.
function checkLocalReachable(baseURL) {
  if (!baseURL) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => { img.src = ''; resolve(false); }, 2000);
    img.onload = () => { clearTimeout(timeout); resolve(true); };
    img.onerror = () => { clearTimeout(timeout); resolve(false); };
    // Any small static asset — 404/200 doesn't matter, we just need the
    // TCP connection to succeed.
    img.src = `${baseURL}/icons/icon-192.png?${Date.now()}`;
  });
}

// ── Base-URL resolver (D-4C: sole owner of base selection) ────────────
// Given {localURL, remoteURL}, pick the active base honoring the mode.
async function resolveBase(config) {
  const mode = getNetworkMode();
  const localURL = config?.localURL;
  const remoteURL = config?.remoteURL;

  // Nothing configured.
  if (!localURL && !remoteURL) {
    return { active: null, single: true, mode, localReachable: false, remoteReachable: false };
  }

  // Only one base configured -> fixed base, no failover.
  if (!localURL || !remoteURL) {
    const active = (mode === 'remote' && remoteURL) ? remoteURL : (localURL || remoteURL);
    return {
      active,
      single: true,
      mode,
      localReachable: Boolean(localURL),
      remoteReachable: Boolean(remoteURL)
    };
  }

  // Both configured -> probe both.
  let localReachable = false;
  let remoteReachable = false;
  try {
    [localReachable, remoteReachable] = await Promise.all([
      checkLocalReachable(localURL),
      checkLocalReachable(remoteURL)
    ]);
  } catch (e) {
    localReachable = remoteReachable = false;
  }

  // Honor mode: local/remote pins override; auto prefers local when reachable.
  let active;
  if (mode === 'local') active = localURL;
  else if (mode === 'remote') active = remoteURL;
  else active = localReachable ? localURL : remoteURL;

  return { active, single: false, mode, localReachable, remoteReachable };
}

// ── D-4A origin-switch ────────────────────────────────────────────────
// If the resolved active base differs from the page's current origin (and the
// target is reachable), redirect the SPA to it once (a single reload on switch).
async function ensureCorrectOrigin(config) {
  const resolved = await resolveBase(config);
  const currentOrigin = window.location.origin;
  const activeOrigin = resolved.active ? urlOrigin(resolved.active) : null;

  if (!resolved.active || !activeOrigin) return null; // single-base / nothing to switch

  const activeReachable = resolved.active === config.localURL
    ? resolved.localReachable
    : resolved.active === config.remoteURL ? resolved.remoteReachable : true;

  if (currentOrigin !== activeOrigin && activeReachable) {
    activeBase = resolved.active;
    // D-4A: one reload on origin switch. Page navigates -> stop.
    window.location.href = resolved.active;
    return null;
  }

  activeBase = resolved.active;
  return resolved;
}

// ── Indicator: badge + Auto/Local/Remote select ───────────────────────
function showIndicator() {
  if (document.getElementById('epilykos-network-indicator')) {
    // P2b: the pill already exists (idempotent re-fire, e.g. a settings save at
    // line 394). Reveal it and restart the countdown instead of rebuilding it.
    if (AUTO_HIDE_REVEAL === 'handle') { revealIndicator(); scheduleAutoHide(); }
    return;
  }

  const container = document.createElement('div');
  container.id = 'epilykos-network-indicator';
  // P2b: right offset 64px = 12px viewport margin + 44px handle + 8px gap, so the
  // pill no longer sits under the persistent handle.
  container.style.cssText = 'position:fixed; top:12px; right:64px; z-index:100000; display:flex; align-items:center; gap:8px; background:#0f172a; color:#e2e8f0; padding:6px 10px; border-radius:999px; box-shadow:0 2px 10px rgba(0,0,0,0.35); font-family:system-ui,-apple-system,sans-serif; font-size:12px; line-height:1;';

  const badge = document.createElement('span');
  badge.id = 'epilykos-network-status';
  badge.style.cssText = 'font-weight:700; padding:3px 9px; border-radius:999px; background:#334155; color:#fff;';
  badge.textContent = '…';

  const select = document.createElement('select');
  select.id = 'epilykos-network-mode-select';
  select.title = 'Network base: Auto / Local / Remote';
  // P2b.7(4): `title` is not a reliable accessible name — give the select a real one.
  select.setAttribute('aria-label', 'Network base: Auto, Local, or Remote');
  select.style.cssText = 'background:#1e293b; color:#e2e8f0; border:1px solid #475569; border-radius:6px; font-size:11px; padding:2px 4px; cursor:pointer;';
  [['auto', 'Auto'], ['local', 'Local'], ['remote', 'Remote']].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = getNetworkMode();
  select.addEventListener('change', () => {
    // P2b.5 (N3): a mode change reveals the pill and restarts a full countdown.
    if (AUTO_HIDE_REVEAL === 'handle') { revealIndicator(); scheduleAutoHide(); }
    applyModeChange();
  });

  const notice = document.createElement('span');
  notice.id = 'epilykos-network-offline';
  notice.textContent = '⚠ offline';
  notice.style.cssText = 'display:none; color:#fca5a5; font-size:11px; font-weight:600;';

  container.appendChild(badge);
  container.appendChild(select);
  container.appendChild(notice);

  // P2b.7(1): suspend the countdown while focus is anywhere inside the pill.
  // The pending timer is CANCELLED (not deferred) so it can never fade out
  // from under a focused control; focusout restarts a full window.
  container.addEventListener('focusin', () => {
    pillFocused = true;
    cancelAutoHide();
  });
  container.addEventListener('focusout', () => {
    // focusout fires before the incoming target is known — re-check next tick.
    setTimeout(() => {
      pillFocused = container.contains(document.activeElement);
      if (!pillFocused && !indicatorHidden) scheduleAutoHide();
    }, 0);
  });

  document.body.appendChild(container);

  // P2b.4: the persistent, never-hidden handle. Built once, guarded by its own
  // existence check so a repeated showIndicator() can never add a second one.
  if (AUTO_HIDE_REVEAL === 'handle' && !document.getElementById('epilykos-network-handle')) {
    const handle = document.createElement('button');
    handle.id = 'epilykos-network-handle';
    handle.type = 'button';
    handle.dataset.autoHideReveal = AUTO_HIDE_REVEAL;
    // Real focusable element -> Enter/Space activation come free (P2b.7(2)).
    handle.setAttribute('aria-label', HANDLE_BASE_LABEL);
    handle.setAttribute('aria-expanded', 'true');
    handle.setAttribute('aria-controls', 'epilykos-network-indicator');
    handle.style.cssText = 'position:fixed; top:12px; right:12px; z-index:100000; width:44px; height:22px; display:flex; align-items:center; justify-content:center; background:#334155; color:#fff; border:none; border-radius:999px; box-shadow:0 2px 10px rgba(0,0,0,0.35); font-family:system-ui,-apple-system,sans-serif; font-size:12px; line-height:1; cursor:pointer; padding:0;';
    const glyph = document.createElement('span');
    glyph.id = 'epilykos-network-handle-cue';
    glyph.textContent = HANDLE_STATE_GLYPH.Active;   // state cue — a glyph, never colour alone (P2b.7(5))
    handle.appendChild(glyph);
    handle.addEventListener('click', () => { toggleIndicator(); });
    // P2b.7(3) fix: the handle must PRECEDE the pill in DOM/tab order, otherwise
    // forward-Tab from the handle skips over the pill's select (which sits
    // earlier in document order) instead of landing on it. Fixed positions and
    // z-index are unchanged, so both stay visually where they were.
    document.body.insertBefore(handle, container);
  }

  indicatorHidden = false;
  syncHandleState();
  // "Appears" is the trigger named in the requirement (P2b.5).
  scheduleAutoHide();
}

function setBadge(text, color) {
  const badge = document.getElementById('epilykos-network-status');
  if (!badge) return;
  badge.textContent = text;
  if (color) badge.style.background = color;
}

function setOffline(flag) {
  offlineFlag = flag;
  const notice = document.getElementById('epilykos-network-offline');
  if (notice) notice.style.display = flag ? 'inline' : 'none';
  // P2b.4a: the offline warning must survive the pill hiding — echo it on the
  // handle. Touches the cue only; never the auto-hide timer (P2b.5).
  setHandleCue(flag ? '#b91c1c' : null, flag ? HANDLE_STATE_GLYPH.Offline : HANDLE_STATE_GLYPH.Active, flag ? 'Offline' : null);
}

function updateIndicator(resolved) {
  const currentOrigin = window.location.origin;

  if (offlineFlag) {
    setBadge('Offline', '#b91c1c');
    setHandleCue('#b91c1c', HANDLE_STATE_GLYPH.Offline, 'Offline');
    return;
  }

  let label = 'Active';
  let color = '#334155';
  const config = cachedConfig;
  if (config) {
    const lo = urlOrigin(config.localURL);
    const ro = urlOrigin(config.remoteURL);
    if (lo && currentOrigin === lo) { label = 'Local'; color = '#15803d'; }
    else if (ro && currentOrigin === ro) { label = 'Remote'; color = '#1d4ed8'; }
  }
  setBadge(label, color);
  // P2b.7(5): distinct glyph per state (Local / Remote / Active) — never colour alone.
  setHandleCue(color, HANDLE_STATE_GLYPH[label] || HANDLE_STATE_GLYPH.Active, label);
}

function updateIndicatorOffline() {
  setOffline(true);
  updateIndicator(null);
}

// ── Phase 2b: pill auto-hide / reveal ─────────────────────────────────
// The WHOLE pill (AUTO_HIDE_TARGET) hides AUTO_HIDE_MS after it appears and is
// toggled back open by the persistent handle (AUTO_HIDE_REVEAL). The node is
// never removed or detached: the idempotency guard at line 175 and the
// getElementById lookups in setBadge()/setOffline() must keep succeeding while
// it is hidden, so the badge and the offline notice stay current (P2b.4).
// This mechanism owns its OWN timer and must never touch checkTimer,
// startRecheck() or stopRecheck() (R1).

function getAutoHideTarget() {
  return document.querySelector(AUTO_HIDE_TARGET);
}

function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    return false;
  }
}

// P2b.7(5): the handle's connection state must be perceivable WITHOUT hover
// and to a screen-reader user — never colour alone. The state text is folded
// into the handle's accessible name by setHandleCue(), and each state gets its
// own non-colour glyph (the base '⌄' cue is kept for the unknown/active case).
const HANDLE_BASE_LABEL = 'Show connection status and network mode';
const HANDLE_STATE_GLYPH = { Local: '⌂', Remote: '☁', Active: '⌄', Offline: '⚠' };

// P2b.4a: minimal state cue on the always-visible handle, so the failover
// warning is not silently lost while the pill is hidden. Colour is paired with
// a glyph and, for assistive tech, with the state in the accessible name and
// the title text — never colour alone (P2b.7(5)).
// This is the SINGLE place that updates the cue.
function setHandleCue(color, glyph, stateText) {
  const handle = document.getElementById('epilykos-network-handle');
  if (!handle) return;
  if (color) handle.style.background = color;
  const cue = document.getElementById('epilykos-network-handle-cue');
  if (cue && glyph) cue.textContent = glyph;
  if (stateText) handle.title = 'Connection: ' + stateText;
  // P2b.7(5): a hover-only title is not exposed on touch/keyboard, so the live
  // state goes into the accessible name too. The required base label text is
  // preserved verbatim as the prefix.
  handle.setAttribute('aria-label', stateText
    ? HANDLE_BASE_LABEL + ' — connection: ' + stateText
    : HANDLE_BASE_LABEL);
}

function syncHandleState() {
  const handle = document.getElementById('epilykos-network-handle');
  if (handle) handle.setAttribute('aria-expanded', indicatorHidden ? 'false' : 'true');
}

function cancelAutoHide() {
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
}

// ONE timer handle, always cleared before re-scheduling, so repeated
// showIndicator() calls and rapid handle toggles cannot accumulate timers.
function scheduleAutoHide() {
  cancelAutoHide();
  if (pillFocused) return;             // P2b.7(1): never hide under focus
  if (!getAutoHideTarget()) return;    // pill not built yet
  autoHideTimer = setTimeout(() => {
    autoHideTimer = null;
    if (pillFocused) return;           // focus arrived after scheduling (defensive)
    hideIndicator(true);               // P2b.6: fade on the timeout path
  }, AUTO_HIDE_MS);
}

function revealIndicator() {
  const target = getAutoHideTarget();
  if (!target) return;
  indicatorHidden = false;
  hideToken++;   // any pending faded-hide callback is now stale
  // Genuine visibility is restored (not bare opacity), so a following Tab lands
  // on #epilykos-network-mode-select when shown and never when hidden (P2b.7(3)).
  target.style.transition = prefersReducedMotion() ? 'none' : 'opacity 200ms ease';
  target.style.visibility = 'visible';
  target.style.opacity = '1';
  target.style.pointerEvents = 'auto';
  syncHandleState();
}

// animate=true: the auto-hide path fades (~200ms) then goes visibility:hidden,
// which removes the pill and its descendants from the tab order and a11y tree
// while leaving textContent/style updates working (P2b.6).
// animate=false: the user's explicit "close" hides instantly — a fade there is
// only delay.
function hideIndicator(animate) {
  const target = getAutoHideTarget();
  if (!target) return;
  cancelAutoHide();
  indicatorHidden = true;
  // P2b.7(1) hardening: a hide must NEVER leave the focus-suspension flag stuck.
  // `pillFocused` used to be cleared only from the focusout 0 ms callback; if a
  // browser does not fire focusout when the focused select's ancestor goes
  // visibility:hidden, the flag stayed true and every later scheduleAutoHide()
  // returned early — a re-revealed pill could then never auto-hide. The pill is
  // being hidden, so re-derive the flag from the live DOM instead of trusting
  // the callback (a focused node inside the hidden pill no longer holds focus).
  pillFocused = !indicatorHidden && target.contains(document.activeElement);
  const token = ++hideToken;   // invalidates any earlier pending faded-hide
  target.style.pointerEvents = 'none';
  if (animate && !prefersReducedMotion()) {
    target.style.transition = 'opacity 200ms ease';
    target.style.opacity = '0';
    // After the fade, take the pill (and its descendants) out of the tab order
    // and the a11y tree. The token makes a stale callback a no-op if the pill
    // was re-revealed in the meantime.
    setTimeout(() => {
      if (token === hideToken && indicatorHidden) target.style.visibility = 'hidden';
    }, 200);
  } else {
    target.style.transition = 'none';
    target.style.opacity = '0';
    target.style.visibility = 'hidden';
  }
  syncHandleState();
}

// Toggle semantics (P2b.4): hidden -> reveal + (re)start the countdown;
// shown -> hide immediately and cancel the pending timer.
function toggleIndicator() {
  if (!getAutoHideTarget()) return;
  if (indicatorHidden) {
    revealIndicator();
    scheduleAutoHide();
  } else {
    hideIndicator(false);
  }
}

// ── Periodic re-check with hysteresis + backoff ───────────────────────
// handleTick decides failover. `userChanged=true` when the mode select fired,
// which lets an explicit pin move us even when the current base is healthy.
async function handleTick(resolved, config, userChanged) {
  const currentOrigin = window.location.origin;
  const localOrigin = urlOrigin(config.localURL);
  const remoteOrigin = urlOrigin(config.remoteURL);

  // Is the origin the page is CURRENTLY served from reachable?
  let currentReachable = false;
  if (currentOrigin === localOrigin) currentReachable = resolved.localReachable;
  else if (currentOrigin === remoteOrigin) currentReachable = resolved.remoteReachable;

  const desiredBase = resolved.active;
  const desiredOrigin = desiredBase ? urlOrigin(desiredBase) : null;
  const desiredReachable = desiredBase === config.localURL
    ? resolved.localReachable
    : desiredBase === config.remoteURL ? resolved.remoteReachable : false;

  if (currentReachable) {
    // Healthy. Reset failure counter + backoff.
    consecutiveDown = 0;
    currentInterval = BASE_CHECK_MS;
    setOffline(false);

    // Move to a reachable desired base only when the user explicitly pinned a
    // mode (or just changed it) — avoids auto-bounce oscillation when both are up.
    const pinned = resolved.mode === 'local' || resolved.mode === 'remote';
    const shouldMove = desiredBase && desiredOrigin && desiredOrigin !== currentOrigin &&
      desiredReachable && (pinned || userChanged);

    if (shouldMove) {
      activeBase = desiredBase;
      window.location.href = desiredBase;
    } else {
      updateIndicator(resolved);
    }
    return;
  }

  // Current origin is unreachable (or unknown). Count consecutive failures.
  consecutiveDown++;
  if (consecutiveDown < HYSTERESIS_THRESHOLD) {
    updateIndicator(resolved);
    return;
  }

  // Hysteresis satisfied -> fail over.
  if (desiredReachable && desiredOrigin && desiredOrigin !== currentOrigin) {
    activeBase = desiredBase;
    window.location.href = desiredBase;
    return;
  }

  // Desired base down — try the other reachable base as a last resort.
  const otherBase = desiredBase === config.localURL ? config.remoteURL : config.localURL;
  const otherReachable = otherBase === config.localURL ? resolved.localReachable : resolved.remoteReachable;
  const otherOrigin = urlOrigin(otherBase);
  if (otherReachable && otherOrigin && otherOrigin !== currentOrigin) {
    activeBase = otherBase;
    window.location.href = otherBase;
    return;
  }

  // Both bases down -> offline state + back off (no redirect, no crash).
  updateIndicatorOffline();
  currentInterval = OFFLINE_BACKOFF_MS;
}

async function runCheck() {
  try {
    const config = cachedConfig;
    if (config?.localURL && config?.remoteURL) {
      const resolved = await resolveBase(config);
      activeBase = resolved.active;
      await handleTick(resolved, config, false);
    } else {
      updateIndicator(null);
    }
  } catch (e) {
    // Never throw unhandled from a background timer.
    console.error('[Network] Periodic check failed:', e);
  } finally {
    checkTimer = setTimeout(runCheck, currentInterval);
  }
}

function startRecheck() {
  if (checkTimer) clearTimeout(checkTimer);
  currentInterval = BASE_CHECK_MS;
  consecutiveDown = 0;
  setOffline(false);
  runCheck();
}

function stopRecheck() {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = null;
}

// ── Mode select handler (D-4D) ────────────────────────────────────────
async function applyModeChange() {
  const config = cachedConfig;
  if (!config?.localURL || !config?.remoteURL) return;

  consecutiveDown = 0;
  currentInterval = BASE_CHECK_MS;
  setOffline(false);

  let resolved;
  try {
    resolved = await resolveBase(config);
  } catch (e) {
    return;
  }
  activeBase = resolved.active;
  await handleTick(resolved, config, /*userChanged*/ true);
}

// ── Init ──────────────────────────────────────────────────────────────
async function initNetworkDetect() {
  const config = await loadNetworkConfig();
  cachedConfig = config;

  // No config / load failed -> nothing to do (no indicator for a single base).
  if (!config || !config.localURL || !config.remoteURL) {
    activeBase = (config?.localURL || config?.remoteURL) || null;
    return;
  }

  // Both bases configured -> enable TRUE failover.
  const resolved = await ensureCorrectOrigin(config);
  if (!resolved) return; // redirected (page reloading) -> stop

  showIndicator();
  startRecheck();

  // Re-load / re-evaluate after settings are saved.
  document.addEventListener('stg-save-complete', () => {
    if (config.localURL && config.remoteURL) {
      loadNetworkConfig().then(cfg => {
        if (cfg?.localURL && cfg?.remoteURL) {
          cachedConfig = cfg;
          stopRecheck();
          ensureCorrectOrigin(cfg).then(r => {
            if (!r) return; // redirected
            showIndicator();
            startRecheck();
          });
        }
      });
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────
window.EpilykosNetwork = {
  init: initNetworkDetect,
  sendConfig: sendConfigToSW,
  loadConfig: loadNetworkConfig,
  getActiveBase: () => activeBase
};

// Auto-init on non-login pages
if (!window.location.pathname.startsWith('/login')) {
  initNetworkDetect();
}
