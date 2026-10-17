/* =============================================================================
   onnexa-app.js — conecta la maqueta aprobada (index.html) con la tienda real.
   Usa lo que la maqueta ya expone (deals, state, renderDeals, go, toast…) y
   reemplaza solo: la lista de ofertas, abrir una oferta, "nueva oferta" y Publish.
   ========================================================================== */
(function () {
  'use strict';
  var API = '2025-01';
  // dentro del admin: Direct API access de App Bridge; en local: proxy del dev-server
  ONB.gql = function (query, variables) {
    var url = window.shopify ? 'shopify:admin/api/' + API + '/graphql.json' : '/__gql';
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query, variables: variables }) })
      .then(function (r) { return r.json(); });
  };

  var actual = null;                                  // producto abierto en el editor
  var plantilla = JSON.parse(JSON.stringify(state));  // estado de la maqueta = plantilla para ofertas nuevas
  var fecha = function (iso) { return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }); };
  var corto = function (t) { return t.length > 32 ? t.slice(0, 31) + '…' : t; };

  function cargarOfertas() {
    return ONB.listDeals().then(function (lista) {
      deals.length = 0;
      lista.forEach(function (x) {
        var c = x.config, bars = c.bars || [];
        deals.push({
          name: c.name || x.product.title, prod: corto(x.product.title), created: fecha(x.product.metafield.updatedAt),
          status: x.product.status === 'ACTIVE' ? 'active' : 'inactive',
          // métricas reales: Fase 3 (pedidos marcados con _pb_bar)
          visitors: 0, cr: 0, rpv: 0, aov: 0, added: 0, total: 0, atcRate: 0, cost: 0, share: bars.map(function () { return 0; }),
          prices: bars.map(function (b) { return b.price; }),
          _product: x.product, _config: c
        });
      });
      renderDeals(); if (typeof renderKpis === 'function') renderKpis();
    }).catch(function (e) { toast('No pude leer las ofertas: ' + e.message); });
  }

  function abrir(product, cfg) {
    actual = product;
    var v1 = product.variants.nodes[0];
    UNIT_PRICE = Number(v1.price); UNIT_COMPARE = Number(v1.compareAtPrice || v1.price);
    var nuevo = JSON.parse(JSON.stringify(plantilla));
    Object.keys(state).forEach(function (k) { delete state[k]; });
    Object.assign(state, nuevo);
    if (cfg && cfg.bars) ONB.applyConfig(state, cfg);
    else state.name = 'Oferta · ' + product.title.slice(0, 40);
    go('editor');
  }

  // abrir una oferta de la tabla (clic en la fila, no en sus botones)
  document.getElementById('dealRows').addEventListener('click', function (e) {
    if (e.target.closest('button, input, .menu, [data-abchip]')) return;
    var tr = e.target.closest('[data-edit]'); if (!tr) return;
    var d = deals[Number(tr.getAttribute('data-edit'))]; if (!d || !d._product) return;
    e.stopImmediatePropagation(); e.preventDefault();
    abrir(d._product, d._config);
  }, true);

  // nueva oferta: elegir el producto con el selector de Shopify
  document.getElementById('newDeal').onclick = function () {
    var elegir = window.shopify && shopify.resourcePicker
      ? shopify.resourcePicker({ type: 'product', multiple: false }).then(function (sel) { return sel && sel[0] && sel[0].id; })
      : Promise.resolve(window.prompt('ID del producto (en local no hay selector de Shopify):'));
    elegir.then(function (id) { if (id) return ONB.getProduct(id).then(function (p) { abrir(p, null); }); })
      .catch(function (e) { toast(e.message); });
  };

  // el editor de la maqueta trae fijo el Reedle Shot: mostrar el producto real
  var renderEditorOrig = renderEditor;
  renderEditor = function () {
    renderEditorOrig();
    if (!actual) return;
    var panel = document.getElementById('editorPanel');
    panel.querySelectorAll('b').forEach(function (b) { if (/Reedle Shot™ — Menos Caída/.test(b.textContent)) b.textContent = actual.title; });
  };

  // Publish = escribir en Shopify
  var pub = document.getElementById('publishBtn');
  pub.onclick = function () {
    if (!actual) { toast('Abre o crea una oferta primero'); return; }
    var aviso = actual.variants.nodes.length === 1
      ? 'Se crearán las variantes "1 pieza / 2 piezas / 3 piezas" en "' + actual.title + '".\n\nSi la página de este producto todavía usa el theme anterior con Kaching, esto la cambia. ¿Publicar?'
      : '¿Publicar los cambios de "' + actual.title + '" en la tienda?';
    if (!window.confirm(aviso)) return;
    pub.disabled = true; pub.textContent = 'Publicando…';
    ONB.publish(actual.id, state, function (m) { pub.textContent = m; })
      .then(function (r) { actual = r.product; pub.textContent = '✓ Publicado'; toast('Oferta publicada en tu tienda'); return cargarOfertas(); })
      .catch(function (e) { pub.textContent = 'Publish'; toast('No se pudo publicar: ' + e.message); })
      .finally(function () { pub.disabled = false; setTimeout(function () { pub.textContent = 'Publish'; }, 2500); });
  };
  document.getElementById('draftBtn').onclick = function () { toast('Los borradores llegan después: por ahora Publish guarda y aplica'); };

  cargarOfertas();
})();
