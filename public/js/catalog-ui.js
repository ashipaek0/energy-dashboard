// catalog-ui.js — source-generic shared catalog mapping component (issue #108, wave 3)
//
// -----------------------------------------------------------------------------
// WHAT THIS IS
// -----------------------------------------------------------------------------
// A shared, source-agnostic UI for "profile/entity catalog" mapping: fetch a
// source's entity catalog (registers / fields / topics / entities …), render
// one `.metric-row` per catalog entry with an EMPTY metric dropdown, let the
// user pair each entity handle with an existing metric, and persist only the
// rows where the user chose a metric. It is the generalization of the LuxPower
// TCP entity-catalog helpers that used to live in settings.js (#106 Batch 2C);
// those helpers' logic now lives here, parameterized by an ADAPTER so that no
// family-specific string, endpoint or id rule appears in this file.
//
// ZERO AUTO-CREATION (standing rule): this component never POSTs the
// metrics-create endpoint and never pre-binds metric names. Fetch / render /
// save touch only the DOM and the family's read-only catalog endpoint. Metric
// names come exclusively from user selections in the dropdowns.
//
// -----------------------------------------------------------------------------
// LOAD ORDER & PAGE GLOBALS
// -----------------------------------------------------------------------------
// This file is loaded AFTER settings.js (see settings.html). It must not
// reference any settings.js runtime global at load time — the only settings.js
// functions it needs (createMetricDropdown / getAllUsedMetrics /
// refreshAllMetricDropdowns, all classic-script page globals) are resolved
// lazily inside handlers via window.* when rows are actually built. Guarded
// lookups return a harmless no-op/minimal element if settings.js is absent, so
// this file never throws on its own.
//
// DOM contract (kept identical to the pre-#108 code so the existing save
// collectors work unchanged):
//   row            = div.metric-row
//   handle         = lives on row.dataset.address (chip/select rows) — the save
//                    collectors write row.dataset.address verbatim as the
//                    mapping value, so a bare hex stays bare, a namespaced
//                    handle stays namespaced, an unresolvable raw chip round-
//                    trips byte-identical.
//   metric         = select.metric-name (first child; user-picked existing
//                    metric; exclusivity via the page's syncAllMetricDropdowns)
//   handle control = fixed chip (span.register-desc.entity-chip) for
//                    fetch/restore rows, or select.entity-select for
//                    "+ Add Mapping" rows, or a text input for input families
//   remove         = button.remove-btn.remove-metric ("✕")
//
// -----------------------------------------------------------------------------
// ADAPTER INTERFACE (required fields — documented; dongleLux in settings.js is
// the reference implementation)
// -----------------------------------------------------------------------------
//   fetch(ctx)      → Promise<entity[]>      Thin GET of the family's catalog
//                                             endpoint. ctx is opaque to the
//                                             component ({ profileId } for
//                                             profile-based families). Reject
//                                             with an Error whose message is
//                                             shown to the user.
//   entityId(e)     → string                  Source-native persisted handle.
//                                             MUST equal what the family's poll
//                                             decode consumes and what legacy
//                                             saves contain (e.g. for dongles:
//                                             namespaced 'input:0x0065').
//   entityLabel(e)  → string                  Chip text, e.g.
//                                             "Label (unit) - input:0x0065 - read".
//   resolveHandle(handle, entities)
//                   → { id, entity }          Restore-time resolution of a saved
//                                             value against the catalog: exact
//                                             match first, then family legacy
//                                             fallbacks (dongle bare-hex …).
//                                             Unresolvable → { id: raw,
//                                             entity: null } so the raw chip
//                                             round-trips (never dropped,
//                                             never re-bound).
//   handleCtrl      → 'chip' | 'select' | 'input'
//                                             Default row anatomy for this
//                                             family. (Input families — MQTT
//                                             topics, External jsonPaths — are
//                                             wired by later waves; createRow
//                                             accepts an explicit mode that
//                                             overrides this.)
//   defaultUnit(e)  → string | ''             Unit prefill for the D4 inline
//                                             metric-create affordance (AC-28,
//                                             wired below: every catalog row
//                                             gets a '+ New' inline editor).
//   applyMode(card, enabled) → void           Button visibility for the card's
//                                             mapping section (which buttons a
//                                             profile capability shows).
//
// OPTIONAL adapter fields:
//   cacheKey        → string                  Card property that holds the
//                                             fetched entity catalog (default
//                                             '_catalog'). Legacy families that
//                                             already cache entities on the card
//                                             under another name (LuxPower:
//                                             '_dongleEntities', still read by
//                                             populateDongleWriteControls) pass
//                                             that name so both share one store.
//   emptyEntitiesNote / emptySavedNote → string
//                                             Overrides for the two empty-state
//                                             notes (defaults below are generic
//                                             register-family wording).
//
// -----------------------------------------------------------------------------
// COMPONENT API
// -----------------------------------------------------------------------------
//   CatalogUI.adapters                       Registry for adapters registered
//                                            post-load (CatalogUI.register).
//   CatalogUI.adapter(name)                  Lazily resolves an adapter:
//                                            window.catalogAdapters[name] (the
//                                            page-side registry, where settings.js
//                                            registers dongleLux at load — the
//                                            component loads after settings.js,
//                                            so page adapters MUST register on
//                                            window.catalogAdapters, not here),
//                                            falling back to CatalogUI.adapters.
//   CatalogUI.createRow(adapter, opts)       One metric↔handle row. opts:
//                                            { metricName, handle, entity,
//                                              entities, mode }
//                                            ('chip' | 'select' | 'input';
//                                            defaults to adapter.handleCtrl).
//   CatalogUI.fetchAndRender(adapter, listEl, btn, ctx)
//                                            "Fetch Profile Entities": clears the
//                                            list, one empty-dropdown chip row
//                                            per catalog entity, caches the
//                                            catalog on the card, busy-state the
//                                            button, surface fetch errors as a
//                                            .note. ctx = { profileId, … }.
//   CatalogUI.addRow(adapter, card, ctx)     "+ Add Mapping": blank row with an
//                                            entity <select> (catalog fetched on
//                                            demand if not cached on the card).
//   CatalogUI.renderSaved(adapter, mappings, entities, listEl)
//                                            Restore saved mappings
//                                            { metricName → handle }: metric
//                                            dropdown preselected, handle
//                                            resolved via adapter.resolveHandle
//                                            (raw chip when unresolvable).
//   CatalogUI.applyMode(adapter, card, enabled)
//                                            Delegates to adapter.applyMode.
//
//   CatalogUI.createInlineMetricControl(adapter, row, metricSelect, getEntity)
//                                            D4 inline metric-create (AC-28):
//                                            appends a '+ New' affordance to a
//                                            catalog row that swaps the metric
//                                            dropdown for a name+unit editor
//                                            (unit prefilled from
//                                            adapter.defaultUnit(entity)) and
//                                            POSTs /api/metrics/create ONLY on
//                                            an explicit Create click — zero
//                                            auto-creation. createRow wires it
//                                            onto every chip/select row so all
//                                            adapters get it for free.
//   CatalogUI.createRow                        rows carry AC-29 row-state:
//                                            row.dataset.prevMetric (metric the
//                                            row held when rendered) and
//                                            row.dataset.cleared='1' once that
//                                            metric is flipped back to empty —
//                                            the save-collector reads these to
//                                            warn before persisting a removal.
(function () {
  'use strict';

  // ---- Lazy page-context access (settings.js globals, call-time only) ------

  // Returns a fresh metric dropdown (select.metric-name). Delegates to
  // settings.js createMetricDropdown when present; the fallback keeps the same
  // DOM shape so collectors and syncAllMetricDropdowns still work.
  function metricDropdown(selectedMetric, excludeMetrics) {
    if (typeof window.createMetricDropdown === 'function') {
      return window.createMetricDropdown(selectedMetric || '', excludeMetrics || []);
    }
    const select = document.createElement('select');
    select.className = 'metric-name';
    select.title = selectedMetric || 'Select a metric';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- Select Metric --';
    select.appendChild(emptyOpt);
    return select;
  }

  // Metrics currently selected anywhere on the page (exclusivity set).
  function usedMetrics() {
    if (typeof window.getAllUsedMetrics === 'function') {
      return Array.from(window.getAllUsedMetrics());
    }
    const used = [];
    document.querySelectorAll('.device-card .metric-row .metric-name').forEach(sel => {
      if (sel.value) used.push(sel.value);
    });
    return used;
  }

  // Re-fetch the metric list and re-sync every dropdown (exclusivity). Returns
  // a promise when settings.js's async refreshAllMetricDropdowns is present.
  function refreshDropdowns() {
    if (typeof window.refreshAllMetricDropdowns === 'function') {
      return window.refreshAllMetricDropdowns();
    }
    return Promise.resolve();
  }

  function removeNotes(listEl) {
    if (!listEl) return;
    Array.from(listEl.children).forEach(c => {
      if (c && c.classList && c.classList.contains('note')) c.remove();
    });
  }

  // Page hook (AC-29 save-count note): after any row-structural change on a
  // card (fetch render, add, restore, metric pick/clear, removal, inline
  // create) dispatch a bubbling CustomEvent on the document carrying the card.
  // settings.js listens and keeps its "Save will persist N of M mapped" note
  // current without this generic component knowing anything about the page.
  function notifyRowsChanged(cardOrEl) {
    if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
    let card = cardOrEl;
    if (card && card.closest) card = card.closest('.device-card');
    if (!card) return;
    try {
      document.dispatchEvent(new CustomEvent('catalog-rows-changed', { detail: { card: card } }));
    } catch (e) { /* page listener absent — note updates are optional */ }
  }

  function makeNote(text, error) {
    const note = document.createElement('div');
    note.className = 'note';
    if (error) note.style.color = 'var(--error)';
    note.textContent = text;
    return note;
  }

  // ---- Per-card entity-catalog cache ----------------------------------------
  // Cached on the card under adapter.cacheKey (default '_catalog') so fetch /
  // "+ Add Mapping" / legacy card code share one store per card.

  function cacheKeyOf(adapter) {
    return (adapter && typeof adapter.cacheKey === 'string' && adapter.cacheKey) ? adapter.cacheKey : '_catalog';
  }

  function setCatalogCache(adapter, card, entities) {
    if (!card) return;
    card[cacheKeyOf(adapter)] = entities;
  }

  function getCatalogCache(adapter, card) {
    if (!card) return null;
    return card[cacheKeyOf(adapter)];
  }

  // ---- Row building ---------------------------------------------------------

  // Fixed entity chip — mirrors the HA entity pill styling (register families).
  function createEntityChip(text) {
    const chip = document.createElement('span');
    chip.className = 'register-desc entity-chip';
    chip.textContent = text;
    chip.title = text;
    chip.style.flex = '1';
    chip.style.fontSize = '0.82em';
    chip.style.overflow = 'hidden';
    chip.style.textOverflow = 'ellipsis';
    chip.style.whiteSpace = 'nowrap';
    chip.style.minWidth = '0';
    chip.style.padding = '0.15rem 0.6rem';
    chip.style.border = '1px solid #39414f';
    chip.style.borderRadius = '999px';
    chip.style.background = 'rgba(120, 145, 190, 0.10)';
    chip.style.color = 'var(--text-secondary, #93a1b5)';
    return chip;
  }

  // Entity picker for blank "+ Add Mapping" rows, populated from the catalog.
  function createEntitySelect(adapter, entities) {
    const sel = document.createElement('select');
    sel.className = 'entity-select';
    sel.title = 'Select entity';
    sel.innerHTML = '<option value="">-- Select entity --</option>';
    (Array.isArray(entities) ? entities : []).forEach(e => {
      const id = adapter.entityId(e);
      if (!id) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = adapter.entityLabel(e);
      sel.appendChild(opt);
    });
    return sel;
  }

  // ---- D4 inline metric-create (AC-28) -------------------------------------
  // Zero auto-creation: POST /api/metrics/create fires ONLY on an explicit
  // "Create" click inside the inline editor. Opening the editor, typing a name
  // or cancelling never touches the server. On success the metric list is
  // re-fetched (window.refreshAllMetricDropdowns when present), the row's
  // metric dropdown is re-shown pre-selected to the new metric, and global
  // exclusivity re-syncs (syncAllMetricDropdowns). The same helper is used by
  // every adapter because createRow wires it onto every catalog row.

  function postCreateMetric(name, unit) {
    return window.fetch('/api/metrics/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ name: name, unit: unit || '' })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          throw new Error((d && d.error) || ('Failed to create metric (HTTP ' + res.status + ')'));
        });
      }
      return res;
    });
  }

  // Append a '+ New' affordance for one catalog row: swaps the row's metric
  // dropdown for an inline name+unit editor, unit prefilled from
  // adapter.defaultUnit(getEntity()) when the row knows its catalog entity.
  // Returns the button element (documented as CatalogUI.createInlineMetricControl).
  function createInlineMetricControl(adapter, row, metricSelect, getEntity) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-create-btn remove-btn';
    btn.textContent = '+ New';
    btn.title = 'Create a new metric (explicit only — nothing is created until you click Create)';
    btn.style.cssText = 'flex-shrink:0;padding:0.3rem 0.55rem;font-size:0.74em;min-height:30px;';

    const panel = document.createElement('div');
    panel.className = 'inline-create';
    panel.style.cssText = 'display:none;flex:1;gap:0.35rem;align-items:center;min-width:220px;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'inline-create-name';
    nameInput.placeholder = 'New metric name';
    nameInput.style.cssText = 'flex:1;min-width:110px;';
    panel.appendChild(nameInput);

    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'inline-create-unit';
    unitInput.placeholder = 'unit';
    unitInput.title = 'Unit (prefilled from the register)';
    unitInput.style.cssText = 'width:72px;flex:none;';
    panel.appendChild(unitInput);

    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'inline-create-go fetch-btn';
    goBtn.textContent = 'Create';
    panel.appendChild(goBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'inline-create-cancel remove-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel';
    panel.appendChild(cancelBtn);

    const flash = (text, error) => {
      const note = makeNote(text, error);
      panel.appendChild(note);
      setTimeout(() => note.remove(), 5000);
    };

    function unitForEntity() {
      const ent = (typeof getEntity === 'function') ? getEntity() : null;
      return (adapter && typeof adapter.defaultUnit === 'function' && ent)
        ? String(adapter.defaultUnit(ent) == null ? '' : adapter.defaultUnit(ent))
        : '';
    }

    function showEditor() {
      metricSelect.style.display = 'none';
      btn.style.display = 'none';
      unitInput.value = unitForEntity();
      nameInput.value = '';
      panel.style.display = 'flex';
      nameInput.focus();
    }

    function closeEditor(preSelectName) {
      panel.style.display = 'none';
      metricSelect.style.display = '';
      btn.style.display = '';
      if (preSelectName) metricSelect.value = preSelectName;
    }

    function runCreate() {
      const name = (nameInput.value || '').trim();
      if (!name) { flash('Metric name required', true); return; }
      goBtn.disabled = true;
      goBtn.textContent = 'Creating…';
      postCreateMetric(name, (unitInput.value || '').trim())
        .then(() => refreshDropdowns())
        .then(() => {
          closeEditor(name);
          // The row now carries the freshly created metric — commit row-state
          // so the AC-29 save-collector treats it as mapped, never cleared.
          row.dataset.prevMetric = name;
          delete row.dataset.cleared;
          notifyRowsChanged(row);
        })
        .catch(err => flash((err && err.message) || 'Failed to create metric', true))
        .finally(() => {
          goBtn.disabled = false;
          goBtn.textContent = 'Create';
        });
    }

    btn.addEventListener('click', showEditor);
    goBtn.addEventListener('click', runCreate);
    cancelBtn.addEventListener('click', () => { closeEditor(); refreshDropdowns(); notifyRowsChanged(row); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runCreate(); }
      else if (e.key === 'Escape') { closeEditor(); refreshDropdowns(); notifyRowsChanged(row); }
    });

    // The panel rides at the end of the row (flex row) so the DOM contract
    // stays intact: div.metric-row > select.metric-name (+ button) + chip.
    row.appendChild(btn);
    row.appendChild(panel);
    return btn;
  }

  // One metric↔handle row. mode 'chip' binds the row's entity (fetch / restore);
  // mode 'select' lets the user pick from the catalog ("+ Add Mapping"). The
  // handle always lives on row.dataset.address so the family save collector
  // writes it verbatim — bare hex stays bare, namespaced stays namespaced.
  // AC-29 row-state: rows rendered with a metric carry dataset.prevMetric, and
  // flipping that metric back to empty sets dataset.cleared='1' so the page's
  // save handler can warn before a removal is persisted.
  function createRow(adapter, opts) {
    opts = opts || {};
    const mode = opts.mode || (adapter && adapter.handleCtrl) || 'chip';
    const row = document.createElement('div');
    row.className = 'metric-row';
    row.dataset.address = opts.handle || '';
    // AC-38 (_catalogV2 migration marker): every row built by the shared catalog
    // component (fetch / + Add Mapping / saved-restore via renderSaved) carries
    // data-catalog. The family save collectors stamp _catalogV2:true on the
    // device when a card persists any such row, so future migrations can tell
    // catalog-era saves apart from legacy Load-Profile imports (the legacy row
    // builders never set data-catalog). Inert today — nothing reads it for
    // behavior; the collectors are the only consumers.
    row.dataset.catalog = '1';
    if (opts.metricName) row.dataset.prevMetric = opts.metricName;
    const metricSelect = metricDropdown(opts.metricName || '', usedMetrics());
    metricSelect.className = 'metric-name';
    metricSelect.addEventListener('change', () => {
      if (!metricSelect.value) {
        // Flipped to empty: remember the row previously held a mapping so the
        // page can confirm before save persists the removal (AC-29).
        if (row.dataset.prevMetric) row.dataset.cleared = '1';
      } else {
        row.dataset.prevMetric = metricSelect.value;
        delete row.dataset.cleared;
      }
      refreshDropdowns();
      notifyRowsChanged(row);
    });
    let entityCtrl;
    if (mode === 'select') {
      entityCtrl = createEntitySelect(adapter, opts.entities);
      entityCtrl.addEventListener('change', () => {
        row.dataset.address = entityCtrl.value;
        // Remember the chosen entity so the inline '+ New' unit prefill (D4)
        // resolves adapter.defaultUnit(entity) even for blank add-rows.
        const picked = (Array.isArray(opts.entities) ? opts.entities : [])
          .find(e => adapter.entityId(e) === entityCtrl.value);
        row._catalogEntity = picked || null;
      });
      if (opts.entities) {
        const picked = (Array.isArray(opts.entities) ? opts.entities : [])
          .find(e => adapter.entityId(e) === String(opts.handle || ''));
        row._catalogEntity = picked || null;
      }
    } else {
      // chip (default). Show the canonical label when the entity resolved,
      // otherwise the raw handle so unresolvable values round-trip visibly.
      entityCtrl = createEntityChip(opts.entity ? adapter.entityLabel(opts.entity) : String(opts.handle || ''));
      row._catalogEntity = opts.entity || null;
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn remove-metric';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove row';
    removeBtn.addEventListener('click', () => {
      const cardEl = row.closest('.device-card');
      row.remove();
      refreshDropdowns();
      notifyRowsChanged(cardEl);
    });
    row.appendChild(metricSelect);
    row.appendChild(entityCtrl);
    row.appendChild(removeBtn);
    // D4 inline metric-create: '+ New' on every catalog row (all adapters).
    createInlineMetricControl(adapter, row, metricSelect, () => row._catalogEntity || null);
    return row;
  }

  // ---- Flows ----------------------------------------------------------------

  // "Fetch … Entities": one row per catalog entity with an EMPTY metric
  // dropdown. No auto-creation — metric names come only from user selections.
  function fetchAndRender(adapter, listEl, btn, ctx) {
    if (!listEl) return Promise.resolve();
    if (!adapter || typeof adapter.fetch !== 'function') {
      return Promise.reject(new Error('CatalogUI: adapter.fetch is required'));
    }
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
    return Promise.resolve()
      .then(() => adapter.fetch(ctx || {}))
      .then(entities => {
        const list = Array.isArray(entities) ? entities : [];
        const card = listEl.closest ? listEl.closest('.device-card') : null;
        setCatalogCache(adapter, card, list);
        listEl.innerHTML = '';
        if (!list.length) {
          listEl.appendChild(makeNote(
            (adapter.emptyEntitiesNote) || 'This profile has no entities.'
          ));
          notifyRowsChanged(card);
          return;
        }
        list.forEach(e => {
          const id = adapter.entityId(e);
          if (!id) return;
          listEl.appendChild(createRow(adapter, {
            metricName: '', handle: id, entity: e, entities: list, mode: 'chip'
          }));
        });
        notifyRowsChanged(card);
        return refreshDropdowns();
      })
      .catch(err => {
        listEl.innerHTML = '';
        listEl.appendChild(makeNote((err && err.message) || 'Failed to load profile entities', true));
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = oldText || 'Fetch Profile Entities'; }
      });
  }

  // "+ Add Mapping": blank row (empty metric dropdown + entity <select>). The
  // catalog is fetched on demand, then cached on the card.
  function addRow(adapter, card, ctx) {
    const listEl = (ctx && ctx.listEl) || (card ? card.querySelector('.mappings-list') : null);
    if (!listEl) return Promise.resolve();
    if (!adapter || typeof adapter.fetch !== 'function') {
      return Promise.reject(new Error('CatalogUI: adapter.fetch is required'));
    }
    const cardEl = (ctx && ctx.card) || card;
    let entities = getCatalogCache(adapter, cardEl);
    if (!Array.isArray(entities) || entities.length === 0) {
      return Promise.resolve()
        .then(() => adapter.fetch(ctx || {}))
        .then(fetched => {
          const list = Array.isArray(fetched) ? fetched : [];
          setCatalogCache(adapter, cardEl, list);
          return list;
        })
        .then(list => {
          removeNotes(listEl);
          listEl.appendChild(createRow(adapter, {
            metricName: '', handle: '', entity: null, entities: list, mode: 'select'
          }));
          notifyRowsChanged(listEl);
          return refreshDropdowns();
        })
        .catch(err => {
          const note = makeNote((err && err.message) || 'Failed to load profile entities', true);
          listEl.appendChild(note);
          setTimeout(() => note.remove(), 6000);
        });
    }
    removeNotes(listEl);
    listEl.appendChild(createRow(adapter, {
      metricName: '', handle: '', entity: null, entities: entities, mode: 'select'
    }));
    notifyRowsChanged(listEl);
    return refreshDropdowns();
  }

  // Restore saved mappings: { metricName: handle } rows with the metric
  // dropdown pre-selected to the saved name and the handle resolved against the
  // catalog (raw chip when unresolvable). Round-trips through save/reload.
  function renderSaved(adapter, mappings, entities, listEl) {
    listEl.innerHTML = '';
    const entries = Object.entries(mappings || {}).filter(([, v]) => {
      return String(v == null ? '' : v).trim().length > 0;
    });
    if (!entries.length) {
      listEl.appendChild(makeNote(
        (adapter.emptySavedNote) || 'No saved mappings for this profile yet — “Fetch Profile Entities” lists every register, or “+ Add Mapping” adds a single row.'
      ));
      return;
    }
    entries.sort(([a], [b]) => a.localeCompare(b)).forEach(([metricName, handle]) => {
      const resolved = (adapter && typeof adapter.resolveHandle === 'function')
        ? adapter.resolveHandle(handle, entities)
        : { id: handle, entity: null };
      listEl.appendChild(createRow(adapter, {
        metricName: metricName,
        handle: resolved.id,
        entity: resolved.entity,
        entities: entities,
        mode: 'chip'
      }));
    });
    notifyRowsChanged(listEl);
    return refreshDropdowns();
  }

  // Delegate card mapping-mode/button visibility to the adapter.
  function applyMode(adapter, card, enabled) {
    if (adapter && typeof adapter.applyMode === 'function') adapter.applyMode(card, enabled);
  }

  function adapterByName(name) {
    if (!name) return null;
    if (window.catalogAdapters && window.catalogAdapters[name]) return window.catalogAdapters[name];
    if (window.CatalogUI && window.CatalogUI.adapters && window.CatalogUI.adapters[name]) {
      return window.CatalogUI.adapters[name];
    }
    return null;
  }

  const CatalogUI = {
    adapters: {},
    register(name, adapter) {
      if (name && adapter) this.adapters[name] = adapter;
    },
    adapter: adapterByName,
    createRow: createRow,
    fetchAndRender: fetchAndRender,
    addRow: addRow,
    renderSaved: renderSaved,
    applyMode: applyMode,
    createInlineMetricControl: createInlineMetricControl
  };

  window.CatalogUI = CatalogUI;
})();
