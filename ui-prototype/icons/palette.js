(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IconPalette = api;
})(globalThis, () => {
  'use strict';
  const DRAG_TYPE = 'application/x-mindmap-icon';
  const normalize = text => text.normalize('NFC').toLocaleLowerCase();
  function matches(icon, query, messages) {
    return ['ja', 'en'].some(lang => normalize(messages[lang][icon.nameKey]).includes(normalize(query.trim())));
  }
  // Screen orientation is independent of the keyboard's visual viewport.
  function device(env = globalThis) {
    const nav = env.navigator || {},
      ua = nav.userAgent || '',
      touch = nav.maxTouchPoints > 0;
    const ipad = /iPad/.test(ua) || (/Mac/.test(nav.platform || ua) && touch);
    const mobile =
      ipad ||
      /iPhone|iPod|Android|Mobile/.test(ua) ||
      (touch && !/Windows/.test(ua) && env.matchMedia?.('(pointer: coarse)').matches);
    const screen = env.screen || {};
    const type = screen.orientation?.type;
    const landscape = type
      ? type.startsWith('landscape')
      : typeof env.orientation === 'number'
        ? Math.abs(env.orientation) === 90
        : screen.width > screen.height;
    const phone = mobile && !ipad && (/iPhone|iPod/.test(ua) || Math.max(screen.width || 0, screen.height || 0) < 950);
    return { available: !mobile || !!landscape, phone };
  }
  class Application {
    constructor(io) {
      this.io = io;
      this.generation = 0;
      this.pending = false;
    }
    cancel() {
      this.generation++;
      this.controller?.abort();
    }
    async apply(icon, child, nodeId) {
      if (this.pending || !this.io.allowed()) return false;
      const target = this.io.capture(child, nodeId),
        generation = this.generation;
      const current = () => generation === this.generation && this.io.allowed() && this.io.current(target);
      this.pending = true;
      this.controller = new AbortController();
      this.io.update();
      try {
        const response = await this.io.fetch(icon.path, { signal: this.controller.signal });
        if (!response.ok) throw new Error(this.io.failure());
        const blob = await response.blob();
        if (!current()) return false;
        // attach checks current again after OPFS writes and immediately before commit.
        await this.io.attach(blob, { ...target, valid: current }, this.io.name(icon));
        return true;
      } catch (error) {
        if (generation === this.generation && error.name !== 'AbortError')
          this.io.error(error.message || this.io.failure());
        return false;
      } finally {
        this.pending = false;
        this.controller = null;
        this.io.update();
      }
    }
  }
  function create(io, { environment = globalThis, i18n = environment.I18n, catalog = environment.IconCatalog } = {}) {
    const { document } = environment;
    const I18n = i18n,
      IconCatalog = catalog;
    const $ = s => document.querySelector(s),
      panel = $('#iconPalette'),
      toggle = $('#paletteToggle'),
      dockToggle = $('#paletteDockToggle');
    const list = $('#paletteList'),
      search = $('#paletteSearch'),
      close = $('#paletteClose');
    let open = false,
      category = 'people',
      selected = null,
      last = io.state(),
      availability = device(environment),
      dragging = null;
    const failed = new Set(),
      cells = new Map();
    const name = icon => I18n.t(icon.nameKey);
    const runner = new Application({
      allowed: () => open && availability.available && !!selected && !failed.has(selected.id) && !io.state().blocked,
      capture: (child, nodeId) => ({ ...io.state(), nodeId: nodeId || io.state().selection || io.state().root, child }),
      current: target => {
        const s = io.state();
        return s.session === target.session && s.revision === target.revision && s.selection === target.selection;
      },
      fetch: (...args) => environment.fetch(...args),
      attach: io.attach,
      name,
      update: footer,
      error: io.error,
      failure: () => I18n.t('palette.failed'),
    });
    function footer() {
      const state = io.state(),
        icon = selected;
      $('#paletteTarget').textContent = icon
        ? `${name(icon)} → ${state.selection ? '「' + state.targetName + '」' : I18n.t('palette.root')}`
        : I18n.t('palette.choose');
      $('#paletteApply').textContent = I18n.t(state.hasImage ? 'palette.replace' : 'palette.apply');
      $('#paletteChild').disabled = !icon || failed.has(icon.id) || runner.pending || !!state.blocked;
      $('#paletteApply').disabled = $('#paletteChild').disabled || !state.selection;
      $('#paletteStatus').textContent = runner.pending ? I18n.t('palette.loading') : state.blocked || '';
    }
    function selectIcon(icon) {
      runner.cancel();
      selected = icon;
      for (const [id, el] of cells) el.setAttribute('aria-pressed', String(id === icon.id));
      footer();
    }
    function clearDrag() {
      dragging = null;
      io.clearDrop();
    }
    function canDrop() {
      const state = io.state();
      return (
        !!dragging &&
        open &&
        availability.available &&
        !runner.pending &&
        !state.blocked &&
        !failed.has(dragging.icon.id) &&
        state.session === dragging.session &&
        state.revision === dragging.revision
      );
    }
    function draw() {
      cells.clear();
      list.replaceChildren();
      for (const icon of IconCatalog.filter(i => i.category === category && matches(i, search.value, I18n.messages))) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'palette__cell';
        button.setAttribute('aria-label', name(icon));
        button.title = name(icon);
        button.draggable = true;
        button.setAttribute('aria-pressed', String(selected?.id === icon.id));
        const img = document.createElement('img');
        img.alt = '';
        img.width = 56;
        img.height = 49;
        img.loading = 'lazy';
        img.draggable = false;
        const label = document.createElement('span');
        label.textContent = name(icon);
        img.onerror = () => {
          failed.add(icon.id);
          img.hidden = true;
          button.disabled = true;
          button.setAttribute('aria-label', name(icon) + ': ' + I18n.t('image.loadFailed'));
          label.textContent = I18n.t('image.loadFailed');
          footer();
        };
        img.onload = () => {
          failed.delete(icon.id);
          button.disabled = false;
          footer();
        };
        img.src = icon.path;
        button.append(img, label);
        button.onclick = () => selectIcon(icon);
        button.ondragstart = e => {
          clearDrag();
          if (
            !open ||
            !availability.available ||
            failed.has(icon.id) ||
            runner.pending ||
            io.state().blocked ||
            !e.dataTransfer
          ) {
            e.preventDefault();
            return;
          }
          io.interrupt();
          selectIcon(icon);
          dragging = { ...io.state(), icon };
          e.dataTransfer.setData(DRAG_TYPE, icon.id);
          e.dataTransfer.effectAllowed = 'copy';
        };
        button.ondragend = clearDrag;
        cells.set(icon.id, button);
        list.append(button);
      }
      if (!cells.size) {
        const empty = document.createElement('p');
        empty.textContent = I18n.t('palette.empty');
        list.append(empty);
      }
      for (const cat of ['people', 'daily'])
        $('#palette-' + cat).setAttribute('aria-pressed', String(category === cat));
      footer();
    }
    function layout() {
      const width = open ? (availability.phone || environment.innerWidth < 1000 ? 240 : 320) : 0;
      document.body.style.setProperty(
        '--palette-width',
        (availability.phone || environment.innerWidth < 1000 ? 240 : 320) + 'px',
      );
      document.body.style.setProperty('--side', (open ? panel.offsetWidth || width : 0) + 'px');
      const canvasWidth = io.width();
      document.body.classList.toggle('canvas-compact', canvasWidth <= 720);
      document.body.classList.toggle('canvas-narrow', canvasWidth <= 560);
      io.layout();
    }
    function setOpen(next) {
      next = !!next && availability.available;
      if (next === open) return;
      runner.cancel();
      clearDrag();
      io.interrupt();
      const hadFocus = panel.contains(document.activeElement);
      open = next;
      panel.inert = !open;
      panel.setAttribute('aria-hidden', String(!open));
      panel.classList.toggle('is-open', open);
      toggle.textContent = I18n.t(open ? 'palette.hide' : 'palette.show');
      toggle.setAttribute('aria-expanded', String(open));
      dockToggle.setAttribute('aria-expanded', String(open));
      dockToggle.setAttribute('aria-label', toggle.textContent);
      dockToggle.title = toggle.textContent;
      layout();
      if (open) {
        draw();
        close.focus({ preventScroll: true });
      } else if (hadFocus) $('#fileBtn').focus({ preventScroll: true });
    }
    toggle.onclick = () => {
      io.closeMenu();
      setOpen(!open);
    };
    dockToggle.onclick = toggle.onclick;
    close.onclick = () => setOpen(false);
    search.oninput = () => {
      runner.cancel();
      draw();
    };
    for (const cat of ['people', 'daily'])
      $('#palette-' + cat).onclick = () => {
        runner.cancel();
        category = cat;
        selected = null;
        draw();
        list.scrollTop = 0;
      };
    $('#paletteChild').onclick = () => {
      if (selected) void runner.apply(selected, true);
    };
    $('#paletteApply').onclick = () => {
      if (selected && io.state().selection) void runner.apply(selected, false);
    };
    panel.addEventListener('keydown', e => {
      if (document.querySelector('dialog[open]')) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!io.closeMenus()) setOpen(false);
      }
    });
    panel.addEventListener('pointerdown', () => io.interrupt());
    panel.addEventListener('focusin', () => io.interrupt());
    for (const event of ['wheel', 'touchmove'])
      panel.addEventListener(event, e => e.stopPropagation(), { passive: true });
    function resize() {
      availability = device(environment);
      toggle.hidden = !availability.available;
      dockToggle.hidden = !availability.available;
      $('#paletteSeparator').hidden = !availability.available;
      if (!availability.available) setOpen(false);
      layout();
    }
    environment.addEventListener('resize', resize);
    environment.addEventListener('orientationchange', resize);
    environment.screen?.orientation?.addEventListener('change', resize);
    toggle.textContent = I18n.t('palette.show');
    resize();
    return {
      sync() {
        const state = io.state();
        if (state.session !== last.session) {
          runner.cancel();
          selected = null;
          for (const el of cells.values()) el.setAttribute('aria-pressed', 'false');
        } else if (
          state.selection !== last.selection ||
          state.revision !== last.revision ||
          state.blocked !== last.blocked
        )
          runner.cancel();
        last = state;
        if (open) footer();
      },
      isDrag: transfer => !!transfer?.types.includes(DRAG_TYPE),
      canDrop,
      async drop(transfer, nodeId) {
        const icon = dragging?.icon;
        const valid = canDrop() && transfer.getData(DRAG_TYPE) === icon.id;
        clearDrag();
        if (!valid || !nodeId) return false;
        return runner.apply(icon, false, nodeId);
      },
      selectionChanged() {
        runner.cancel();
      },
      focused: () => open && panel.contains(document.activeElement),
    };
  }
  return { DRAG_TYPE, normalize, matches, device, Application, create };
});
