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
          visitors: null, cr: 0, rpv: 0, aov: 0, added: 0, total: 0, atcRate: 0, cost: 0, share: bars.map(function () { return 0; }),
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

  /* ------------------------------------------------ métricas reales (pedidos) */
  var pedidos = [];
  Object.keys(overview).forEach(function (k) { delete overview[k]; }); // fuera los números de ejemplo de la maqueta
  var DIAS = { '24h': 1, '7d': 7, '30d': 30, all: 60 };
  var ETQ = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: '60 days (Shopify max)' };
  function medir(lista) {
    var packs = lista.filter(function (o) { return o.pack; });
    var ventas = packs.reduce(function (a, o) { return a + o.lineas.reduce(function (b, l) { return b + (l.pack ? l.total : 0); }, 0); }, 0);
    var total = lista.reduce(function (a, o) { return a + o.total; }, 0);
    return [ventas, lista.length ? total / lista.length : 0, lista.length ? packs.length / lista.length * 100 : 0, packs.length];
  }
  function calcularResumen() {
    var ahora = Date.now();
    Object.keys(DIAS).forEach(function (p) {
      var ms = DIAS[p] * 864e5, en = function (a, b) { return pedidos.filter(function (o) { return o.t > a && o.t <= b; }); };
      var cur = medir(en(ahora - ms, ahora)), prev = p === 'all' ? null : medir(en(ahora - 2 * ms, ahora - ms));
      var pts = [0, 1, 2, 3].map(function () { return []; });
      for (var i = 0; i < 7; i++) { var m = medir(en(ahora - ms + i * ms / 7, ahora - ms + (i + 1) * ms / 7)); m.forEach(function (v, j) { pts[j].push(v); }); }
      var fmt = [function (v) { return mx(v); }, function (v) { return mx(v, 2); }, function (v) { return pct(v); }, function (v) { return String(v); }];
      overview[p] = { label: ETQ[p], pts: pts, k: cur.map(function (v, j) {
        if (!prev || !prev[j]) return [fmt[j](v), '—', 'up'];
        var d = (v - prev[j]) / prev[j] * 100;
        return [fmt[j](v), Math.abs(d).toFixed(2) + '%', d >= 0 ? 'up' : 'down'];
      }) };
    });
  }
  renderKpis = function () {
    var t = ['Bundle revenue', 'Average order value', 'Orders with bundles', 'Bundle orders'], o = overview[ovPeriod];
    document.getElementById('kpis').innerHTML = o ? t.map(function (x, i) {
      var k = o.k[i];
      return '<div class="kpi"><div class="t"><i></i>' + x + '</div><div class="row between nowrap"><div><div class="v">' + k[0] + '</div>' +
        (k[1] === '—' ? '<div class="delta">—</div>' : '<div class="delta ' + k[2] + '">' + (k[2] === 'up' ? '↗' : '↘') + ' ' + k[1] + '</div>') + '</div>' + spark(o.pts[i]) + '</div><div class="d">' + o.label + '</div></div>';
    }).join('') : '<p style="color:var(--muted)">Cargando pedidos…</p>';
  };
  // visitas y conversión necesitan el píxel de la Fase 3: mientras, "—" en vez de ceros falsos
  COLS.forEach(function (c) {
    if (['visitors', 'cr', 'rpv', 'atc', 'atcr', 'ppv'].indexOf(c.k) < 0) return;
    var v = c.v; c.v = function (d) { return d.visitors == null ? '—' : v(d); };
  });
  function metricasOfertas() {
    deals.forEach(function (d) {
      if (!d._product) return;
      var suyos = pedidos.filter(function (o) { return o.lineas.some(function (l) { return l.pack && l.product === d._product.id; }); });
      var lineas = []; suyos.forEach(function (o) { o.lineas.forEach(function (l) { if (l.pack && l.product === d._product.id) lineas.push(l); }); });
      d.visitors = null;
      d.total = lineas.reduce(function (a, l) { return a + l.total; }, 0);
      d.added = d.total;
      d.aov = suyos.length ? suyos.reduce(function (a, o) { return a + o.total; }, 0) / suyos.length : 0;
      var bars = (d._config.bars || []).map(function (b) { return b.qty; });
      d.share = bars.map(function (q) { return lineas.length ? lineas.filter(function (l) { return l.qty === q; }).length / lineas.length : 0; });
    });
  }
  /* ------------------------------------- qué paquete compra cada clienta (1U, 2U, 3U…) */
  // El paquete = unidades del producto de la oferta en el pedido. No depende de que la línea venga marcada como pack
  // (Kaching, Onnexa o nada): regalos a $0, guías, protección y otros productos no cuentan porque son otro producto.
  function porPaquete(d, desde, hasta) {
    var grupos = {}, n = 0;
    pedidos.forEach(function (o) {
      if (o.t <= desde || o.t > hasta) return;
      var ls = o.lineas.filter(function (l) { return l.product === d._product.id && !l.gift && l.total > 0; });
      var u = ls.reduce(function (a, l) { return a + l.qty; }, 0); if (!u) return;
      var g = grupos[u] || (grupos[u] = { u: u, pedidos: 0, unidades: 0, ingresos: 0 });
      g.pedidos++; g.unidades += u; g.ingresos += ls.reduce(function (a, l) { return a + l.total; }, 0); n++;
    });
    var filas = Object.keys(grupos).map(Number).sort(function (a, b) { return a - b; }).map(function (u) {
      var g = grupos[u]; g.pct = g.pedidos / n * 100; g.ticket = g.ingresos / g.pedidos; return g;
    });
    return { pedidos: n, filas: filas };
  }
  var mostrar = { u: function (u) { return u + (u === 1 ? ' unidad' : ' unidades'); }, delta: function (a, b) {
    if (!b) return '<span style="color:var(--muted)">—</span>';
    var d = (a - b) / b * 100; return '<span class="delta ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '↗ ' : '↘ ') + Math.abs(d).toFixed(0) + '%</span>';
  } };
  function tablaPaquetes(d, dias, conPrevio) {
    var ahora = Date.now(), ms = dias * 864e5, cur = porPaquete(d, ahora - ms, ahora), prev = porPaquete(d, ahora - 2 * ms, ahora - ms);
    if (!cur.pedidos) return '<p style="color:var(--muted);margin:6px 0">Sin pedidos de este producto en los últimos ' + dias + ' días.</p>';
    var top = cur.filas.slice().sort(function (a, b) { return b.pedidos - a.pedidos; })[0];
    var ant = {}; prev.filas.forEach(function (f) { ant[f.u] = f; });
    return '<p style="margin:4px 0 10px">El que más se vende: <b>' + mostrar.u(top.u) + '</b> — ' + pct(top.pct) + ' de ' + cur.pedidos + ' pedidos.</p>' +
      '<table class="subtbl"><thead><tr><th>Paquete</th><th class="num">Pedidos</th><th class="num">% de pedidos</th><th class="num">Unidades</th><th class="num">Ingresos</th><th class="num">Ticket promedio</th>' +
      (conPrevio ? '<th class="num">Pedidos vs ' + dias + ' días antes</th>' : '') + '</tr></thead><tbody>' +
      cur.filas.map(function (f) {
        return '<tr><td><b>' + f.u + 'U</b> · ' + mostrar.u(f.u) + '</td><td class="num">' + f.pedidos + '</td><td class="num">' + pct(f.pct) + '</td><td class="num">' + f.unidades + '</td><td class="num">' + mx(f.ingresos) + '</td><td class="num">' + mx(f.ticket, 2) + '</td>' +
          (conPrevio ? '<td class="num">' + (ant[f.u] ? ant[f.u].pedidos : 0) + ' → ' + f.pedidos + ' ' + (ant[f.u] ? mostrar.delta(f.pedidos, ant[f.u].pedidos) : '<span class="delta up">nuevo</span>') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table>';
  }
  // Analytics: tarjeta real arriba de las de ejemplo
  var diasPaq = 7;
  var tarjeta = document.createElement('div'); tarjeta.className = 'card'; tarjeta.id = 'paquetes';
  var analytics = document.getElementById('v-analytics'); analytics.insertBefore(tarjeta, analytics.querySelector('.card'));
  function renderPaquetes() {
    var ahora = Date.now(), con = function (d) { return porPaquete(d, ahora - diasPaq * 864e5, ahora).pedidos > 0; };
    var todas = deals.filter(function (d) { return d._product; }), lista = todas.filter(con), sin = todas.filter(function (d) { return !con(d); });
    tarjeta.innerHTML = '<div class="row between"><h2>Qué paquete compran tus clientas</h2><div class="seg" id="paqSeg">' +
      [7, 14, 30].map(function (n) { return '<button data-d="' + n + '"' + (n === diasPaq ? ' class="on"' : '') + '>' + n + ' días</button>'; }).join('') + '</div></div>' +
      '<p style="color:var(--muted);margin:6px 0 4px">Pedidos reales de Shopify, sin cancelados. El paquete es cuántas unidades del producto llevó la clienta; los regalos a $0, guías y protección no cuentan. Ingresos netos de descuentos.</p>' +
      (!pedidos.length ? '<p style="color:var(--muted)">Cargando pedidos…</p>' : lista.length ? lista.map(function (d) {
        return '<div style="margin-top:16px"><b>' + esc(d._product.title) + '</b>' + tablaPaquetes(d, diasPaq, true) + '</div>';
      }).join('') : '<p style="color:var(--muted)">' + (todas.length ? 'Ninguna oferta tuvo pedidos en los últimos ' + diasPaq + ' días.' : 'Todavía no hay ofertas publicadas.') + '</p>') +
      (pedidos.length && lista.length && sin.length ? '<p style="color:var(--muted);margin-top:14px">Sin pedidos en estos ' + diasPaq + ' días: ' + sin.map(function (d) { return esc(corto(d._product.title)); }).join(' · ') + '</p>' : '');
  }
  tarjeta.addEventListener('click', function (e) { var b = e.target.closest('[data-d]'); if (b) { diasPaq = Number(b.getAttribute('data-d')); renderPaquetes(); } });
  // tabla de ofertas: la flecha de una oferta sin A/B muestra su desglose por paquete (30 días), como en Kaching
  var renderDealsOrig = renderDeals;
  renderDeals = function () {
    renderDealsOrig();
    document.querySelectorAll('#dealRows .notest').forEach(function (n) {
      var fila = n.closest('tr').previousElementSibling, d = fila && deals[Number(fila.getAttribute('data-edit'))];
      if (!d || !d._product || !pedidos.length) return;
      n.insertAdjacentHTML('beforebegin', '<div style="padding:4px 4px 10px"><b>Últimos 30 días por paquete</b>' + tablaPaquetes(d, 30, false) + '</div>');
    });
  };

  ONB.loadOrders(60).then(function (o) {
    pedidos = o; calcularResumen(); renderKpis(); metricasOfertas(); renderDeals(); renderPaquetes();
  }).catch(function (e) { toast('No pude leer los pedidos: ' + e.message); });
  renderPaquetes();
  renderKpis();

  // el menú de Shopify abre ./?v=analytics, etc.
  var v = new URLSearchParams(location.search).get('v');
  if (v && document.getElementById('v-' + v)) go(v);

  var cargadas = cargarOfertas();
  cargadas.then(function () { if (pedidos.length) { metricasOfertas(); renderDeals(); } renderPaquetes(); });
})();
