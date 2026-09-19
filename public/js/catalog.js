/* =========================================================================
   catalog.js — catálogo público de piezas.

   Filtros: marca (pestañas), modelo (select), categoría (chips), orden,
   "solo disponibles" y buscador. Todo el filtrado real lo hace el servidor
   en /api/products, así que lo que se ve siempre coincide con el inventario.
   ========================================================================= */
(function () {
  'use strict';

  var state = {
    brand: '',
    model: '',
    category: '',
    sort: 'newest',
    inStock: false,
    q: '',
    brands: [],
    categories: [],
    products: []
  };

  var grid = document.getElementById('products-grid');
  var empty = document.getElementById('empty-state');
  var brandTabs = document.getElementById('brand-tabs');
  var chipScroll = document.getElementById('chip-scroll');
  var modelSelect = document.getElementById('model-select');
  var sortSelect = document.getElementById('sort-select');
  var inStockCheck = document.getElementById('instock-check');
  var searchForm = document.getElementById('search-form');
  var searchInput = document.getElementById('search-input');
  var titleEl = document.getElementById('catalog-title');
  var filterToggle = document.getElementById('mobile-filter-toggle');
  var catalogFilters = document.getElementById('catalog-filters');

  var modal = document.getElementById('product-modal');
  var modalMedia = document.getElementById('modal-media');
  var modalInfo = document.getElementById('modal-info');
  var modalClose = document.getElementById('modal-close');

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(p) {
    if (p === null || p === undefined || p === '') return null;
    var n = Number(p);
    if (!isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function waLink(message) {
    if (typeof window.SJ_WHATSAPP_LINK === 'function') return window.SJ_WHATSAPP_LINK(message);
    var num = (window.SJ_CONFIG && window.SJ_CONFIG.whatsappNumber) || '';
    return 'https://wa.me/' + num + '?text=' + encodeURIComponent(message);
  }

  function nameOfCategory(slug) {
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].slug === slug) return state.categories[i].name;
    }
    return slug || '';
  }

  function nameOfBrand(slug) {
    for (var i = 0; i < state.brands.length; i++) {
      if (state.brands[i].slug === slug) return state.brands[i].name;
    }
    return slug || '';
  }

  function vehicleLabel(p) {
    var brand = nameOfBrand(p.brand);
    if (!p.model) return brand;
    var b = null;
    for (var i = 0; i < state.brands.length; i++) if (state.brands[i].slug === p.brand) b = state.brands[i];
    var modelName = p.model;
    if (b && b.models) {
      for (var j = 0; j < b.models.length; j++) if (b.models[j].slug === p.model) modelName = b.models[j].name;
    }
    return brand + ' ' + modelName;
  }

  async function getJSON(url) {
    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + url);
    return res.json();
  }

  /* ------------------------- Pintar filtros ------------------------- */
  function renderBrandTabs() {
    if (!brandTabs) return;
    var html = '<button class="brand-tab' + (state.brand ? '' : ' active') + '" data-brand="">Todas las marcas</button>';
    html += state.brands.map(function (b) {
      return '<button class="brand-tab' + (state.brand === b.slug ? ' active' : '') + '" data-brand="' + esc(b.slug) + '">' + esc(b.name) + '</button>';
    }).join('');
    brandTabs.innerHTML = html;
    brandTabs.querySelectorAll('.brand-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.brand = btn.getAttribute('data-brand') || '';
        state.model = '';
        renderBrandTabs();
        renderModelSelect();
        load();
      });
    });
  }

  function renderModelSelect() {
    if (!modelSelect) return;
    var brand = null;
    for (var i = 0; i < state.brands.length; i++) if (state.brands[i].slug === state.brand) brand = state.brands[i];

    if (!brand || !brand.models || !brand.models.length) {
      modelSelect.style.display = 'none';
      modelSelect.innerHTML = '<option value="">Todos los modelos</option>';
      state.model = '';
      return;
    }
    modelSelect.style.display = '';
    modelSelect.innerHTML = '<option value="">Todos los modelos</option>' + brand.models.map(function (m) {
      return '<option value="' + esc(m.slug) + '"' + (state.model === m.slug ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('');
  }

  function renderChips() {
    if (!chipScroll) return;
    var html = '<button class="chip' + (state.category ? '' : ' active') + '" data-category="">Todas las categorías</button>';
    html += state.categories.map(function (c) {
      return '<button class="chip' + (state.category === c.slug ? ' active' : '') + '" data-category="' + esc(c.slug) + '">' + esc(c.icon || '') + ' ' + esc(c.name) + '</button>';
    }).join('');
    chipScroll.innerHTML = html;
    chipScroll.querySelectorAll('.chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.category = btn.getAttribute('data-category') || '';
        renderChips();
        load();
      });
    });
  }

  function updateTitle() {
    if (!titleEl) return;
    if (state.brand && state.category) titleEl.textContent = nameOfCategory(state.category) + ' · ' + nameOfBrand(state.brand);
    else if (state.brand) titleEl.textContent = 'Piezas para ' + nameOfBrand(state.brand);
    else if (state.category) titleEl.textContent = nameOfCategory(state.category);
    else titleEl.textContent = 'Catálogo de piezas';
  }

  /* ------------------------- Pintar piezas ------------------------- */
  function cardHTML(p) {
    var agotado = p.inStock === false;
    var tag = agotado ? 'Agotado' : nameOfCategory(p.category);
    var media = p.image
      ? '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="ph" hidden>🔧</span>'
      : '<span class="ph">🔧</span>';
    var price = money(p.price);
    var priceHTML = price
      ? '<div class="product-price">' + price + ' <small>USD</small></div>'
      : '<div class="product-price"><small>Precio a consultar</small></div>';

    return '<article class="product-card" data-id="' + esc(p.id) + '">' +
             '<div class="product-media">' + media + '<span class="product-tag">' + esc(tag) + '</span></div>' +
             '<div class="product-body">' +
               '<h4>' + esc(p.name) + '</h4>' +
               '<div class="product-sku">' + esc(vehicleLabel(p)) + (p.sku ? ' · ' + esc(p.sku) : '') + '</div>' +
               '<p class="product-desc">' + esc((p.description || '').slice(0, 110)) + ((p.description || '').length > 110 ? '…' : '') + '</p>' +
               priceHTML +
               '<div class="product-actions">' +
                 '<button type="button" class="btn btn-outline" data-action="details">Ver detalles</button>' +
                 '<a class="btn btn-primary" target="_blank" rel="noopener noreferrer" href="' + esc(waLink('Hola, me interesa esta pieza: ' + p.name + (p.sku ? ' (código ' + p.sku + ')' : '') + '. ¿Está disponible?')) + '">Consultar</a>' +
               '</div>' +
             '</div>' +
           '</article>';
  }

  function renderProducts() {
    if (!grid) return;
    if (!state.products.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    grid.innerHTML = state.products.map(cardHTML).join('');

    grid.querySelectorAll('.product-card').forEach(function (card) {
      var id = card.getAttribute('data-id');
      var btn = card.querySelector('[data-action="details"]');
      if (btn) btn.addEventListener('click', function () { openModal(id); });
      card.querySelector('.product-media').addEventListener('click', function () { openModal(id); });
    });
  }

  /* ---------------------------- Modal ---------------------------- */
  function openModal(id) {
    var p = null;
    for (var i = 0; i < state.products.length; i++) if (state.products[i].id === id) p = state.products[i];
    if (!p || !modal) return;

    if (modalMedia) {
      modalMedia.innerHTML = p.image
        ? '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '">'
        : '<span style="font-size:64px;opacity:.3">🔧</span>';
    }
    if (modalInfo) {
      var price = money(p.price);
      modalInfo.innerHTML =
        '<span class="badge ' + (p.inStock === false ? 'badge-off' : 'badge-on') + '">' + (p.inStock === false ? 'Agotado' : 'Disponible') + '</span>' +
        '<h3>' + esc(p.name) + '</h3>' +
        '<div class="price">' + (price ? price + ' USD' : 'Precio a consultar') + '</div>' +
        '<p><strong>Vehículo:</strong> ' + esc(vehicleLabel(p)) + '<br>' +
        '<strong>Categoría:</strong> ' + esc(nameOfCategory(p.category)) +
        (p.sku ? '<br><strong>Código:</strong> ' + esc(p.sku) : '') + '</p>' +
        (p.description ? '<p>' + esc(p.description) + '</p>' : '') +
        '<div class="modal-actions">' +
          '<a class="btn btn-primary" target="_blank" rel="noopener noreferrer" href="' + esc(waLink('Hola, me interesa esta pieza: ' + p.name + (p.sku ? ' (código ' + p.sku + ')' : '') + '. ¿Está disponible?')) + '">Consultar por WhatsApp</a>' +
          // Pago online: aún no está activo. Se deja visible y desactivado,
          // con su aviso de "Próximamente", para que el cliente sepa que
          // viene en camino. Cuando se contrate la pasarela de pago, se
          // cambia este bloque por un enlace real.
          '<div class="tooltip-wrap">' +
            '<button type="button" class="btn btn-outline btn-block" disabled>Pagar online</button>' +
            '<span class="tooltip-bubble">Próximamente</span>' +
          '</div>' +
          '<a class="btn btn-outline" href="/solicitar-pieza.html">Solicitar una pieza parecida</a>' +
        '</div>';
    }
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', function (ev) { if (ev.target === modal) closeModal(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });

  /* ---------------------------- Carga ---------------------------- */
  function queryString() {
    var params = new URLSearchParams();
    if (state.brand) params.set('brand', state.brand);
    if (state.model) params.set('model', state.model);
    if (state.category) params.set('category', state.category);
    if (state.inStock) params.set('inStock', '1');
    if (state.q) params.set('q', state.q);
    if (state.sort) params.set('sort', state.sort);
    return params.toString();
  }

  async function load() {
    if (grid && !state.products.length) {
      grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#79808c">Cargando piezas…</p>';
    }
    try {
      state.products = await getJSON('/api/products?' + queryString());
      if (!Array.isArray(state.products)) state.products = [];
    } catch (err) {
      console.error('No se pudieron cargar las piezas:', err);
      state.products = [];
      if (grid) grid.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    updateTitle();
    renderProducts();
  }

  async function init() {
    // Filtros que vienen en el enlace (por ejemplo desde la página de inicio).
    try {
      var url = new URLSearchParams(window.location.search);
      state.brand = url.get('brand') || '';
      state.model = url.get('model') || '';
      state.category = url.get('category') || '';
      state.q = url.get('q') || '';
      if (state.q && searchInput) searchInput.value = state.q;
    } catch (e) { /* sin filtros iniciales */ }

    try {
      var res = await Promise.all([
        getJSON('/api/brands').catch(function () { return []; }),
        getJSON('/api/categories').catch(function () { return []; })
      ]);
      state.brands = Array.isArray(res[0]) ? res[0] : [];
      state.categories = Array.isArray(res[1]) ? res[1] : [];
    } catch (e) {
      state.brands = []; state.categories = [];
    }

    renderBrandTabs();
    renderModelSelect();
    renderChips();
    await load();
  }

  if (modelSelect) modelSelect.addEventListener('change', function () { state.model = modelSelect.value; load(); });
  if (sortSelect) sortSelect.addEventListener('change', function () { state.sort = sortSelect.value; load(); });
  if (inStockCheck) inStockCheck.addEventListener('change', function () { state.inStock = inStockCheck.checked; load(); });
  if (searchForm) {
    searchForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      state.q = searchInput ? searchInput.value.trim() : '';
      load();
    });
  }
  if (searchInput) {
    // Si borra el buscador, se vuelve a la lista completa sin tener que enviar.
    searchInput.addEventListener('search', function () {
      if (!searchInput.value.trim() && state.q) { state.q = ''; load(); }
    });
  }
  if (filterToggle && catalogFilters) {
    filterToggle.addEventListener('click', function () {
      var open = catalogFilters.classList.toggle('is-open');
      filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      filterToggle.querySelector('span:last-child').textContent = open ? '✕' : '☰';
    });
  }

  init();
})();
