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
          _product: x.product, _config: c, _stats: (function () { try { return JSON.parse(x.product.stats.value); } catch (e) { return null; } })()
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
  var ETQ = { '24h': 'Today', '7d': '7 days', '30d': '30 days', all: '60 days (Shopify max)' };
  // Períodos = N días de calendario de la TIENDA (hoy desde las 00:00 de la tienda), iguales para pedidos y visitas:
  // las visitas de Shopify vienen por día, así que una ventana móvil de 24 h no se puede cruzar con ellas.
  var OFF = function () { return (ONB.offsetMin != null ? ONB.offsetMin : -300) * 6e4; };
  function inicioDias(n) { var hoy = Math.floor((Date.now() + OFF()) / 864e5) * 864e5; return hoy - (n - 1) * 864e5 - OFF(); }
  var diaDe = function (t) { return new Date(t + OFF()).toISOString().slice(0, 10); };
  var medianoche = function (dia) { return Date.parse(dia + 'T00:00:00Z') - OFF(); };
  var b24 = document.querySelector('#ovSeg [data-p="24h"]'); if (b24) b24.textContent = 'Today';
  function medir(lista) {
    var packs = lista.filter(function (o) { return o.pack; });
    var ventas = packs.reduce(function (a, o) { return a + o.lineas.reduce(function (b, l) { return b + (l.pack ? l.total : 0); }, 0); }, 0);
    var total = lista.reduce(function (a, o) { return a + o.total; }, 0);
    return [ventas, lista.length ? total / lista.length : 0, lista.length ? packs.length / lista.length * 100 : 0, packs.length];
  }
  function calcularResumen() {
    var ahora = Date.now();
    Object.keys(DIAS).forEach(function (p) {
      var ms = DIAS[p] * 864e5, ini = inicioDias(DIAS[p]), en = function (a, b) { return pedidos.filter(function (o) { return o.t >= a && o.t < b; }); };
      var cur = medir(en(ini, ahora + 1)), prev = p === 'all' ? null : medir(en(ini - ms, ini));
      var pts = [0, 1, 2, 3].map(function () { return []; }), paso = (ahora - ini) / 7;
      for (var i = 0; i < 7; i++) { var m = medir(en(ini + i * paso, ini + (i + 1) * paso)); m.forEach(function (v, j) { pts[j].push(v); }); }
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
  // al cambiar 24 h / 7 / 30 días / todo, la tabla de ofertas también se recalcula (la maqueta solo redibujaba los KPIs)
  document.getElementById('ovSeg').addEventListener('click', function (e) {
    if (e.target.closest('[data-p]') && pedidos.length) { metricasOfertas(); renderDeals(); }
  });
  // visitas y conversión necesitan el píxel de la Fase 3: mientras, "—" en vez de ceros falsos
  COLS.forEach(function (c) {
    if (['visitors', 'cr', 'rpv', 'atc', 'atcr', 'ppv'].indexOf(c.k) < 0) return;
    var v = c.v; c.v = function (d) { return d.visitors == null ? '—' : v(d); };
  });
  // Visitas, elecciones y "al carrito" por paquete entre desde y hasta (ms), del metafield onnexa.bundle_stats.
  // inicio = primer día con datos: la conversión solo se calcula sobre los días que sí tienen visitas medidas.
  function visitas(d, desde, hasta) {
    var s = d._stats; if (!s) return null;
    var r = { inicio: null, v: 0, e: {}, c: {}, atc: 0 }, d0 = diaDe(desde), d1 = diaDe(hasta), en = function (dia) { return dia >= d0 && dia <= d1; };
    // con historial de Shopify (sesiones que aterrizan en el producto, días completos): visitas y "al carrito" salen de ahí
    if (s.s && Object.keys(s.s).length) {
      Object.keys(s.s).forEach(function (dia) { if (!en(dia)) return; r.v += s.s[dia]; r.atc += (s.sc && s.sc[dia]) || 0;
        var t = medianoche(dia); if (r.inicio == null || t < r.inicio) r.inicio = t; });
      ['e', 'c'].forEach(function (k) { Object.keys(s[k] || {}).forEach(function (dia) { if (en(dia)) Object.keys(s[k][dia]).forEach(function (q) { r[k][q] = (r[k][q] || 0) + s[k][dia][q]; }); }); });
      if (r.inicio == null) return null;
      r.inicio = Math.max(r.inicio, desde); return r;
    }
    var marca = function (dia) { var t = medianoche(dia); if (r.inicio == null || t < r.inicio) r.inicio = t; };
    Object.keys(s.v || {}).forEach(function (dia) { if (en(dia)) { r.v += s.v[dia]; marca(dia); } });
    ['e', 'c'].forEach(function (k) { Object.keys(s[k] || {}).forEach(function (dia) { if (!en(dia)) return; marca(dia);
      Object.keys(s[k][dia]).forEach(function (q) { r[k][q] = (r[k][q] || 0) + s[k][dia][q]; }); }); });
    if (r.inicio == null) return null;
    // el primer día medido empieza a la hora del primer evento, no a medianoche (si no, el CR de ese día se infla)
    r.inicio = Math.max(r.inicio, desde, s.desde ? Date.parse(s.desde) : 0); return r;
  }
  var suma = function (o) { return Object.keys(o).reduce(function (a, k) { return a + o[k]; }, 0); };
  // Métricas como Kaching, para la oferta y para cada barra (paquete):
  //   Total revenue = total de los pedidos · AOV = total / pedidos · Added revenue = lo que el paquete suma sobre
  //   comprar 1 pieza (0 en la de 1) · CR y Revenue per visitor = sobre las visitas medidas, con los pedidos de esos días.
  function metricasOfertas() {
    var ahora = Date.now();
    deals.forEach(function (d) {
      if (!d._product) return;
      // mismo período que el Overview (24 h / 7 / 30 días / todo = 60 días de Shopify)
      var ini = inicioDias(DIAS[ovPeriod] || 60);
      var todo = porPaquete(d, ini, ahora), vs = visitas(d, ini, ahora);
      var med = vs && vs.v ? porPaquete(d, vs.inicio, ahora) : null;
      var tot = function (fs, k) { return fs.reduce(function (a, f) { return a + f[k]; }, 0); };
      d.visitors = med ? vs.v : null;
      d.total = tot(todo.filas, 'totalPedidos'); d.added = tot(todo.filas, 'extra');
      d.aov = todo.pedidos ? d.total / todo.pedidos : 0;
      if (med) { d.cr = med.pedidos / vs.v * 100; d.rpv = tot(med.filas, 'totalPedidos') / vs.v; d.atcRate = (vs.atc || suma(vs.c)) / vs.v * 100; }
      var bars = d._config.bars || [];
      d.share = bars.map(function (b) { var f = todo.filas.filter(function (x) { return x.u === b.qty; })[0]; return f && todo.pedidos ? f.pedidos / todo.pedidos : 0; });
      var extras = todo.filas.filter(function (f) { return !bars.some(function (b) { return b.qty === f.u; }); }).map(function (f) { return { qty: f.u, title: f.u + ' piezas (fuera de la oferta)' }; });
      d._barras = bars.concat(extras).map(function (b) {
        var f = todo.filas.filter(function (x) { return x.u === b.qty; })[0] || { pedidos: 0, totalPedidos: 0, extra: 0 };
        var m = med && med.filas.filter(function (x) { return x.u === b.qty; })[0];
        return { name: b.title || (b.qty === 1 ? '1 pieza' : b.qty + ' piezas'), visitors: d.visitors, cost: d.cost, share: [1],
          cr: m ? m.pedidos / vs.v * 100 : 0, rpv: m ? m.totalPedidos / vs.v : 0, atcRate: med ? (vs.c[b.qty] || 0) / vs.v * 100 : 0,
          aov: f.pedidos ? f.totalPedidos / f.pedidos : 0, added: f.extra, total: f.totalPedidos };
      });
    });
  }
  /* ------------------------------------- qué paquete compra cada clienta (1U, 2U, 3U…) */
  // El paquete = unidades del producto de la oferta en el pedido. No depende de que la línea venga marcada como pack
  // (Kaching, Onnexa o nada): regalos a $0, guías, protección y otros productos no cuentan porque son otro producto.
  function porPaquete(d, desde, hasta) {
    var grupos = {}, n = 0;
    // precio de 1 pieza (la barra de 1): base del "Added revenue"
    var uno = ((d._config && d._config.bars) || []).filter(function (b) { return b.qty === 1; })[0];
    pedidos.forEach(function (o) {
      if (o.t < desde || o.t > hasta) return;
      var ls = o.lineas.filter(function (l) { return l.product === d._product.id && !l.gift && l.total > 0; });
      var u = ls.reduce(function (a, l) { return a + l.piezas; }, 0); if (!u) return;
      var g = grupos[u] || (grupos[u] = { u: u, pedidos: 0, unidades: 0, ingresos: 0, totalPedidos: 0, extra: 0 });
      var lin = ls.reduce(function (a, l) { return a + l.total; }, 0);
      g.pedidos++; g.unidades += u; g.ingresos += lin; g.totalPedidos += o.total; n++;
      if (u > 1 && uno) g.extra += Math.max(0, lin - Number(uno.price));
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
    var ahora = Date.now(), ms = dias * 864e5, ini = inicioDias(dias), cur = porPaquete(d, ini, ahora), prev = porPaquete(d, ini - ms, ini);
    if (!cur.pedidos) return '<p style="color:var(--muted);margin:6px 0">Sin pedidos de este producto en los últimos ' + dias + ' días.</p>';
    var top = cur.filas.slice().sort(function (a, b) { return b.pedidos - a.pedidos; })[0];
    var ant = {}; prev.filas.forEach(function (f) { ant[f.u] = f; });
    // visitas medidas: conversión = pedidos del paquete / visitas, ambos desde el primer día medido
    var vs = visitas(d, ini, ahora), med = {};
    if (vs) porPaquete(d, vs.inicio, ahora).filas.forEach(function (f) { med[f.u] = f; });
    var conv = vs && vs.v ? ' Visitas a la página: <b>' + vs.v.toLocaleString('es-MX') + '</b> desde el ' + fecha(vs.inicio) + ' · conversión total <b>' + pct(suma(Object.keys(med).reduce(function (o, u) { o[u] = med[u].pedidos; return o; }, {})) / vs.v * 100) + '</b>.' : '';
    return '<p style="margin:4px 0 10px">El que más se vende: <b>' + mostrar.u(top.u) + '</b> — ' + pct(top.pct) + ' de ' + cur.pedidos + ' pedidos.' + conv + '</p>' +
      '<table class="subtbl"><thead><tr><th>Paquete</th><th class="num">Pedidos</th><th class="num">% de pedidos</th><th class="num">Unidades</th><th class="num">Ingresos</th><th class="num">Ticket promedio</th>' +
      (vs && vs.v ? '<th class="num">Lo eligieron</th><th class="num">Al carrito</th><th class="num">Conversión</th>' : '') +
      (conPrevio ? '<th class="num">Pedidos vs ' + dias + ' días antes</th>' : '') + '</tr></thead><tbody>' +
      cur.filas.map(function (f) {
        return '<tr><td><b>' + f.u + 'U</b> · ' + mostrar.u(f.u) + '</td><td class="num">' + f.pedidos + '</td><td class="num">' + pct(f.pct) + '</td><td class="num">' + f.unidades + '</td><td class="num">' + mx(f.ingresos) + '</td><td class="num">' + mx(f.ticket, 2) + '</td>' +
          (vs && vs.v ? '<td class="num">' + (vs.e[f.u] || 0) + '</td><td class="num">' + (vs.c[f.u] || 0) + '</td><td class="num">' + pct((med[f.u] ? med[f.u].pedidos : 0) / vs.v * 100) + '</td>' : '') +
          (conPrevio ? '<td class="num">' + (ant[f.u] ? ant[f.u].pedidos : 0) + ' → ' + f.pedidos + ' ' + (ant[f.u] ? mostrar.delta(f.pedidos, ant[f.u].pedidos) : '<span class="delta up">nuevo</span>') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table>';
  }
  // Pedido por pedido: qué paquete llevó cada clienta (mismo criterio que porPaquete), con enlace al pedido en Shopify
  function listaPedidos(d, desde, hasta) {
    var filas = [];
    pedidos.forEach(function (o) {
      if (o.t < desde || o.t > hasta) return;
      var ls = o.lineas.filter(function (l) { return l.product === d._product.id && !l.gift && l.total > 0; });
      var u = ls.reduce(function (a, l) { return a + l.piezas; }, 0); if (!u) return;
      filas.push({ o: o, u: u, lin: ls.reduce(function (a, l) { return a + l.total; }, 0) });
    });
    if (!filas.length) return '';
    filas.sort(function (a, b) { return b.o.t - a.o.t; });
    var hora = function (t) { return new Date(t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
    var PAGO = { PAID: 'Pagado', PENDING: 'Pendiente', PARTIALLY_REFUNDED: 'Reembolso parcial', REFUNDED: 'Reembolsado', AUTHORIZED: 'Autorizado', PARTIALLY_PAID: 'Pago parcial', VOIDED: 'Anulado' };
    return '<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Ver los ' + filas.length + ' pedidos uno por uno</summary>' +
      '<table class="subtbl" style="margin-top:8px"><thead><tr><th>Pedido</th><th>Fecha</th><th>Paquete</th><th class="num">Ingreso del producto</th><th class="num">Total del pedido</th><th>Código</th><th>Pago</th></tr></thead><tbody>' +
      filas.map(function (f) {
        var id = String(f.o.id || '').split('/').pop();
        return '<tr><td><a href="shopify://admin/orders/' + id + '" target="_top">' + esc(f.o.name) + '</a></td><td style="white-space:nowrap">' + hora(f.o.t) + '</td><td><b>' + f.u + 'U</b></td>' +
          '<td class="num">' + mx(f.lin, 2) + '</td><td class="num">' + mx(f.o.total, 2) + '</td><td>' + esc((f.o.codigos || []).join(', ') || '—') + '</td><td>' + esc(PAGO[f.o.pago] || f.o.pago || '') + '</td></tr>';
      }).join('') + '</tbody></table></details>';
  }
  // Analytics: tarjeta real arriba de las de ejemplo
  var diasPaq = 7;
  var tarjeta = document.createElement('div'); tarjeta.className = 'card'; tarjeta.id = 'paquetes';
  var analytics = document.getElementById('v-analytics'); analytics.insertBefore(tarjeta, analytics.querySelector('.card'));
  function renderPaquetes() {
    var ahora = Date.now(), ini = inicioDias(diasPaq), con = function (d) { return porPaquete(d, ini, ahora).pedidos > 0; };
    var todas = deals.filter(function (d) { return d._product; }), lista = todas.filter(con), sin = todas.filter(function (d) { return !con(d); });
    tarjeta.innerHTML = '<div class="row between"><h2>Qué paquete compran tus clientas</h2><div class="seg" id="paqSeg">' +
      [7, 14, 30].map(function (n) { return '<button data-d="' + n + '"' + (n === diasPaq ? ' class="on"' : '') + '>' + n + ' días</button>'; }).join('') + '</div></div>' +
      '<p style="color:var(--muted);margin:6px 0 4px">Pedidos reales de Shopify, sin cancelados. El paquete es cuántas unidades del producto llevó la clienta; los regalos a $0, guías y protección no cuentan. Ingresos netos de descuentos.</p>' +
      (!pedidos.length ? '<p style="color:var(--muted)">Cargando pedidos…</p>' : lista.length ? lista.map(function (d) {
        return '<div style="margin-top:16px"><b>' + esc(d._product.title) + '</b>' + tablaPaquetes(d, diasPaq, true) + listaPedidos(d, ini, ahora) + '</div>';
      }).join('') : '<p style="color:var(--muted)">' + (todas.length ? 'Ninguna oferta tuvo pedidos en los últimos ' + diasPaq + ' días.' : 'Todavía no hay ofertas publicadas.') + '</p>') +
      (pedidos.length && lista.length && sin.length ? '<p style="color:var(--muted);margin-top:14px">Sin pedidos en estos ' + diasPaq + ' días: ' + sin.map(function (d) { return esc(corto(d._product.title)); }).join(' · ') + '</p>' : '');
  }
  tarjeta.addEventListener('click', function (e) { var b = e.target.closest('[data-d]'); if (b) { diasPaq = Number(b.getAttribute('data-d')); renderPaquetes(); } });
  // tabla de ofertas: la flecha de una oferta sin A/B muestra una fila por barra en las mismas columnas, como Kaching
  var renderDealsOrig = renderDeals;
  renderDeals = function () {
    renderDealsOrig();
    var cols = TABLE_ORDER.map(function (k) { return COLS.filter(function (c) { return c.k === k; })[0]; }).filter(function (c) { return c && c.on; });
    document.querySelectorAll('#dealRows .notest').forEach(function (n) {
      var tr = n.closest('tr'), fila = tr.previousElementSibling, d = fila && deals[Number(fila.getAttribute('data-edit'))];
      if (!d || !d._barras) return;
      tr.outerHTML = d._barras.map(function (b) {
        return '<tr class="subv"><td class="cb"></td><td></td><td><b>' + esc(b.name) + '</b></td><td></td>' +
          cols.map(function (c) { return '<td class="num">' + (c.k === 'visitors' ? '' : c.v(b)) + '</td>'; }).join('') + '<td></td></tr>';
      }).join('');
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
