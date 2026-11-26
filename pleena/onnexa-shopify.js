/* =============================================================================
   onnexa-shopify.js — lo que la app escribe en Shopify (sin servidor propio).
   Una oferta = 1 producto de UNA variante con:
     · metafield onnexa.bundle (json) → lo lee el bloque "Packs" del theme Onnexa; cada pack = qty unidades
     · descuentos automáticos por cantidad que fijan el precio de cada pack (las ventas quedan por unidad)
     · regalos a $0 (productos ocultos) que el bloque agrega al carrito al desbloquear el pack; no se usa BXGY
       porque un producto dentro de un BXGY no admite otro descuento de producto fuera de Shopify Plus
   gql(query, variables) lo pone quien carga el archivo: App Bridge en el admin,
   el proxy local en desarrollo, o Node en las pruebas.
   ========================================================================== */
(function (root) {
  'use strict';
  var NS = 'onnexa', KEY = 'bundle', OPT = 'Paquete';
  var ONB = { gql: null };

  function q(query, variables) {
    return ONB.gql(query, variables || {}).then(function (r) {
      if (r.errors) throw new Error(r.errors.map(function (e) { return e.message; }).join(' · '));
      return r.data;
    });
  }
  function errs(res) {
    var ue = res && res.userErrors;
    if (ue && ue.length) throw new Error(ue.map(function (e) { return (e.field ? e.field.join('.') + ': ' : '') + e.message; }).join(' · '));
    return res;
  }
  var gid = function (type, id) { return String(id).indexOf('gid://') === 0 ? String(id) : 'gid://shopify/' + type + '/' + id; };
  var num = function (g) { return Number(String(g).split('/').pop()); };
  var packName = function (qty) { return qty === 1 ? '1 pieza' : qty + ' piezas'; };

  /* ------------------------------------------------------------ lectura */
  var PRODUCT = 'id title handle status featuredMedia { preview { image { url } } } ' +
    'options { id name values } ' +
    'variants(first: 100) { nodes { id title price compareAtPrice sku inventoryPolicy selectedOptions { name value } inventoryItem { tracked } image { url } } } ' +
    'metafield(namespace: "' + NS + '", key: "' + KEY + '") { value updatedAt } ' +
    // visitas/elecciones/carrito por día y paquete: lo escribe cada hora el dashboard de Onnexa
    'stats: metafield(namespace: "' + NS + '", key: "bundle_stats") { value } ' +
    // pruebas A/B de la oferta: [{ id, nombre, inicio, fin, ganador, variantes: [{ letra, nombre, nota, config, visitas }] }]
    'ab: metafield(namespace: "' + NS + '", key: "bundle_ab") { value }';

  // shortcut: lee hasta 250 productos sin paginar; las tiendas tienen ~20, paginar si pasan de 250
  ONB.listDeals = function () {
    return q('{ products(first: 250, sortKey: UPDATED_AT, reverse: true) { nodes { ' + PRODUCT + ' } } }').then(function (d) {
      return d.products.nodes.filter(function (p) { return p.metafield; }).map(function (p) {
        var cfg = {}; try { cfg = JSON.parse(p.metafield.value); } catch (e) {}
        return { product: p, config: cfg };
      });
    });
  };
  // Mercados de Shopify (Configuración → Mercados). Sin el permiso read_markets: solo la moneda de la tienda.
  ONB.mercados = function () {
    return q('{ shop { currencyCode } markets(first: 20) { nodes { name enabled primary currencySettings { baseCurrency { currencyCode } } regions(first: 250) { nodes { name ... on MarketRegionCountry { code } } } } } }').then(function (d) {
      return d.markets.nodes.filter(function (m) { return m.enabled; }).map(function (m) {
        return { nombre: m.name, principal: m.primary, moneda: (m.currencySettings && m.currencySettings.baseCurrency.currencyCode) || d.shop.currencyCode,
          paises: m.regions.nodes.map(function (x) { return { code: x.code, nombre: x.name }; }).filter(function (x) { return x.code; }) };
      });
    }).catch(function () {
      return q('{ shop { currencyCode } }').then(function (d) { return [{ nombre: 'Mexico', principal: true, moneda: d.shop.currencyCode, paises: [{ code: 'MX', nombre: 'Mexico' }] }]; });
    });
  };
  // precio de una variante en un país (con la conversión y redondeo de Shopify Markets)
  ONB.precioLocal = function (variantId, pais) {
    return q('query($id: ID!, $c: CountryCode!) { productVariant(id: $id) { price contextualPricing(context: { country: $c }) { price { amount currencyCode } } } }', { id: variantId, c: pais })
      .then(function (d) { var v = d.productVariant; return { base: Number(v.price), local: Number(v.contextualPricing.price.amount), moneda: v.contextualPricing.price.currencyCode }; });
  };
  ONB.getProduct = function (id) {
    return q('query($id: ID!) { product(id: $id) { ' + PRODUCT + ' } }', { id: gid('Product', id) }).then(function (d) {
      if (!d.product) throw new Error('No encontré el producto ' + id);
      return d.product;
    });
  };

  /* ------------------------------------------------- pedidos (métricas) */
  // Una línea es "de pack" si la marcó el bloque Onnexa (_pb_bar / _pb_deal) o Kaching (__kaching_bundles).
  // shortcut: hasta 1,000 pedidos; Shopify sin read_all_orders solo deja ver 60 días.
  ONB.loadOrders = function (days) {
    var desde = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), todos = [];
    var pagina = function (cursor, n) {
      return q('query($c: String, $q: String) { shop { timezoneOffsetMinutes } orders(first: 100, after: $c, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id name createdAt cancelledAt discountCodes displayFinancialStatus ' +
        'currentTotalPriceSet { shopMoney { amount } } lineItems(first: 25) { nodes { quantity variantTitle originalTotalSet { shopMoney { amount } } discountAllocations { allocatedAmountSet { shopMoney { amount } } } customAttributes { key value } product { id } } } } } }',
        { c: cursor, q: 'created_at:>=' + desde }).then(function (d) {
          ONB.offsetMin = d.shop.timezoneOffsetMinutes; // los períodos del panel van en días de la tienda
          d.orders.nodes.forEach(function (o) {
            if (o.cancelledAt) return;
            var lineas = o.lineItems.nodes.map(function (l) {
              var at = {}; (l.customAttributes || []).forEach(function (a) { at[a.key] = a.value; });
              var kb = at.__kaching_bundles || '';
              // neto = precio original − todas las asignaciones de descuento. No usar discountedTotal: en los packs de Onnexa
              // ya viene con el descuento aplicado y en los de Kaching no, así que restar ahí lo contaba doble (2 piezas a $400).
              var desc = (l.discountAllocations || []).reduce(function (a, x) { return a + Number(x.allocatedAmountSet.shopMoney.amount); }, 0);
              // piezas reales: en el esquema viejo el pack era una variante "2 piezas"/"3 piezas" con cantidad 1
              var m = String(l.variantTitle || '').match(/(\d+)\s*piezas?/i), piezas = (m ? Number(m[1]) : 1) * l.quantity;
              return { qty: l.quantity, piezas: piezas, ab: at._pb_ab || '', total: Number(l.originalTotalSet.shopMoney.amount) - desc, product: l.product && l.product.id,
                pack: !!(at._pb_bar || at._pb_deal || (kb && kb.indexOf('"gift"') < 0)) && piezas > 1, gift: !!(at._pb_gift || kb.indexOf('"gift"') >= 0) };
            });
            todos.push({ id: o.id, name: o.name, codigos: o.discountCodes || [], pago: o.displayFinancialStatus, t: new Date(o.createdAt).getTime(), total: Number(o.currentTotalPriceSet.shopMoney.amount), lineas: lineas, pack: lineas.some(function (l) { return l.pack; }) });
          });
          if (d.orders.pageInfo.hasNextPage && n < 10) return pagina(d.orders.pageInfo.endCursor, n + 1);
          return todos;
        });
    };
    return pagina(null, 1);
  };

  /* ------------------------------------------- estado del panel ↔ metafield */
  // state = el objeto del editor (mismo formato que la maqueta aprobada)
  ONB.configFromState = function (state, ctx) {
    var colors = Object.assign({}, state.style.colors);
    var badge = (state.on.badges && state.badges[0]) || {};
    colors.badgeBg = badge.bg || colors.labelBg; colors.badgeText = badge.color || colors.labelText;
    var bars = state.bars.map(function (b, i) {
      var bd = state.on.badges && state.badges.filter(function (x) { return x.bar === i; })[0];
      var out = { qty: b.qty, price: ctx.priceOf(b), title: b.title, subtitle: b.subtitle, label: b.label, image: b.img };
      var vid = ctx.variantOf(b.qty); if (vid) out.variantId = vid;
      if (bd && bd.text) out.badge = bd.text;
      return out;
    });
    var items = state.on.gifts ? state.gifts.items.map(function (g) {
      var base = { type: g.type, unlockAt: g.unlockAt, label: g.label, lockedTitle: g.locked, image: g.img };
      if (g.type === 'shipping') return Object.assign(base, { title: g.title });
      return Object.assign(base, { variantId: g.variant, value: g.value, title: (g.title || '').indexOf('{{') >= 0 ? g.product : g.title });
    }) : [];
    return {
      dealId: ctx.dealId, name: state.name, locale: 'es-MX', decimals: state.settings.noDecimals ? 0 : 2,
      variantId: (bars[0] && bars[0].variantId) || undefined, unitCompareAt: ctx.unitCompare,
      title: state.blockTitle, preselected: state.preselected, bars: bars,
      gifts: { title: state.gifts.title, items: items },
      style: { radius: state.style.radius, spacing: state.style.spacing, imageSize: 42, colors: colors, fonts: state.style.fonts },
      discounts: ctx.discounts || {},
      // Visibility → Markets: el bloque de la tienda solo se muestra en estos países (sin lista = en todos)
      market: state.market, paises: state.paises && state.paises.length ? state.paises : undefined
    };
  };
  // vuelve a llenar el editor con una oferta guardada (lo que no viene se queda como estaba)
  ONB.applyConfig = function (state, cfg) {
    if (!cfg || !cfg.bars) return state;
    state.name = cfg.name || state.name;
    state.market = cfg.market || 'All markets'; state.paises = cfg.paises || null;
    state.blockTitle = cfg.title || state.blockTitle;
    state.preselected = cfg.preselected != null ? cfg.preselected : state.preselected;
    state.bars = cfg.bars.map(function (b) {
      return { qty: b.qty, priceType: 'fixed', value: b.price, title: b.title, subtitle: b.subtitle, label: b.label, qtySelector: false, soldOut: false, img: b.image };
    });
    var badges = [];
    cfg.bars.forEach(function (b, i) { if (b.badge) badges.push({ bar: i, style: 'simple', text: b.badge, size: 12, color: (cfg.style && cfg.style.colors.badgeText) || '#ffffff', bg: (cfg.style && cfg.style.colors.badgeBg) || '#c9a08f' }); });
    state.badges = badges; state.on.badges = badges.length > 0;
    if (cfg.gifts) {
      state.on.gifts = (cfg.gifts.items || []).length > 0;
      state.gifts.title = cfg.gifts.title;
      state.gifts.items = (cfg.gifts.items || []).map(function (g) {
        return { type: g.type, product: g.title, value: g.value, variant: g.variantId, unlockAt: g.unlockAt, only: false, qty: 1, label: g.label, crossed: g.type === 'product' ? '{{original_total}}' : '', title: g.title, locked: g.lockedTitle, img: g.image, subsOnly: false, excludeRates: false };
      });
    }
    if (cfg.style) {
      state.style.radius = cfg.style.radius; state.style.spacing = cfg.style.spacing;
      Object.assign(state.style.colors, cfg.style.colors || {});
      if (cfg.style.fonts) Object.assign(state.style.fonts, cfg.style.fonts);
    }
    return state;
  };

  /* -------------------------------------------------------------- publicar */
  // log(msg) recibe cada paso, para mostrarlo en el panel.
  // El producto conserva UNA variante: cada pack es "qty unidades" de esa variante y el precio del pack
  // lo hacen descuentos automáticos por cantidad (así las ventas se registran por unidad, como con Kaching).
  // Pruebas A/B: la lista completa vive en el metafield onnexa.bundle_ab del producto (la lee el widget del theme).
  ONB.guardarAB = function (productId, pruebas) {
    return q('mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }',
      { m: [{ ownerId: gid('Product', productId), namespace: NS, key: 'bundle_ab', type: 'json', value: JSON.stringify(pruebas) }] }).then(function (d) { errs(d.metafieldsSet); });
  };
  // Ganadora B: su presentación pasa a la oferta (precios, piezas y variante no cambian; no hay que tocar descuentos).
  ONB.guardarConfig = function (productId, cfg) {
    return q('mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }',
      { m: [{ ownerId: gid('Product', productId), namespace: NS, key: KEY, type: 'json', value: JSON.stringify(cfg) }] }).then(function (d) { errs(d.metafieldsSet); });
  };

  ONB.publish = function (productId, state, log) {
    log = log || function () {};
    var p, cfgOld = {}, base, unitPrice, unitCompare;
    return ONB.getProduct(productId).then(function (prod) {
      p = prod;
      try { cfgOld = JSON.parse((p.metafield || {}).value || '{}'); } catch (e) {}
      var opts = p.options.map(function (o) { return o.name; });
      if (opts.length === 1 && opts[0] === OPT) return quitarVariantesPack(p, log).then(function (pp) { p = pp; });
      // con modelos (Oso/Conejo…): el pack cuenta piezas de CUALQUIER modelo, así que todos deben costar lo mismo
      var precios = p.variants.nodes.map(function (v) { return Number(v.price); });
      if (precios.some(function (x) { return x !== precios[0]; }))
        throw new Error('"' + p.title + '": sus variantes (' + opts.join(', ') + ') tienen precios distintos. Para los paquetes todas deben costar lo mismo.');
    }).then(function () {
      var multi = p.variants.nodes.length > 1;
      base = p.variants.nodes[0];
      unitPrice = Number(base.price); unitCompare = Number(base.compareAtPrice || base.price);
      var priceOf = function (b) { return b.priceType === 'fixed' ? Number(b.value) : b.priceType === 'percent' ? Math.round(unitPrice * b.qty * (1 - b.value / 100)) : b.priceType === 'amount' ? Math.max(0, unitPrice * b.qty - b.value) : unitPrice * b.qty; };
      return sincronizarDescuentos(p, state, base, unitPrice, priceOf, cfgOld.discounts || {}, log, multi).then(function (discounts) {
        var cfg = ONB.configFromState(state, {
          dealId: cfgOld.dealId || p.handle, unitCompare: unitCompare, discounts: discounts,
          // con modelos, el bloque agrega el modelo que la clienta eligió en la página: no se fija ninguno
          priceOf: priceOf, variantOf: function () { return multi ? null : num(base.id); }
        });
        // lo que el editor no maneja pero la oferta ya tenía (miniatura, tachado "N × precio"): se conserva
        if (cfgOld.thumb) cfg.thumb = cfgOld.thumb;
        var p1 = (cfg.bars.filter(function (b) { return b.qty === 1; })[0] || {}).price;
        cfg.bars.forEach(function (b) {
          var vieja = (cfgOld.bars || []).filter(function (x) { return x.qty === b.qty; })[0];
          if (vieja && vieja.compareAt && p1) b.compareAt = b.qty * p1;
        });
        log('Guardando la oferta en el producto…');
        return q('mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }',
          { m: [{ ownerId: p.id, namespace: NS, key: KEY, type: 'json', value: JSON.stringify(cfg) }] }).then(function (d) { errs(d.metafieldsSet); return { product: p, config: cfg }; });
      });
    });
  };

  // Migración: productos a los que una versión anterior les creó la opción "Paquete" con variantes 2/3 piezas.
  // Borra esas variantes, quita la opción (la de 1 pieza vuelve a ser la única, "Default Title") y limpia el SKU "-x1".
  function quitarVariantesPack(p, log) {
    var sobran = p.variants.nodes.filter(function (v) { return v.selectedOptions[0].value !== packName(1); }).map(function (v) { return v.id; });
    var una = p.variants.nodes.filter(function (v) { return v.selectedOptions[0].value === packName(1); })[0];
    if (!una) throw new Error('"' + p.title + '" no tiene la variante "1 pieza"; revisa las variantes a mano.');
    var paso = Promise.resolve();
    if (sobran.length) paso = paso.then(function () {
      log('Quitando ' + sobran.length + ' variante(s) pack…');
      return q('mutation($id: ID!, $v: [ID!]!) { productVariantsBulkDelete(productId: $id, variantsIds: $v) { userErrors { field message } } }', { id: p.id, v: sobran }).then(function (d) { errs(d.productVariantsBulkDelete); });
    });
    return paso.then(function () {
      log('Quitando la opción "' + OPT + '"…');
      return q('mutation($id: ID!, $o: [ID!]!) { productOptionsDelete(productId: $id, options: $o, strategy: DEFAULT) { userErrors { field message } } }', { id: p.id, o: [p.options[0].id] }).then(function (d) { errs(d.productOptionsDelete); });
    }).then(function () {
      var sku = (una.sku || '').replace(/-x1$/, '');
      if (sku === (una.sku || '')) return;
      return q('mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $v) { userErrors { field message } } }', { id: p.id, v: [{ id: una.id, inventoryItem: { sku: sku } }] }).then(function (d) { errs(d.productVariantsBulkUpdate); });
    }).then(function () { return ONB.getProduct(p.id); });
  }

  // Descuentos automáticos de la oferta (se recrean en cada publicación):
  //  · precio del pack: un descuento por cantidad mínima con el monto total del pack (no por unidad).
  //  · regalos: ver regalarGratis.
  function sincronizarDescuentos(p, state, base, unitPrice, priceOf, viejos, log, multi) {
    var nuevos = {}, paso = Promise.resolve();
    var regalos = state.on.gifts ? state.gifts.items.filter(function (g) { return g.type === 'product' && g.variant; }) : [];
    var nombre = (state.name || p.title).slice(0, 60);
    Object.keys(viejos).forEach(function (k) {
      paso = paso.then(function () {
        return q('mutation($id: ID!) { discountAutomaticDelete(id: $id) { userErrors { field message } } }', { id: viejos[k] })
          .then(function (d) { errs(d.discountAutomaticDelete); }).catch(function () { /* ya no existía */ });
      });
    });
    state.bars.slice().sort(function (a, b) { return a.qty - b.qty; }).forEach(function (b) {
      // Shopify aplica UN solo descuento de producto por línea (el mayor), aunque estén marcados como
      // combinables. El monto va TOTAL, no por unidad: así el pack más grande siempre descuenta más
      // (2 piezas = $399, 3 = $598) aunque su precio por pieza sea peor, gana el escalón que la clienta
      // eligió y el título del pedido corresponde a ese pack. Por unidad, Reedle Shot no podía ganar
      // nunca con 3 ($199.33/pieza contra $199.50 del pack de 2) y las unidades de más se descontaban.
      var extra = Math.round((unitPrice * b.qty - priceOf(b)) * 100) / 100; // descuento total del pack
      if (b.qty > 1 && extra > 0) {
        paso = paso.then(function () {
          log('Precio del pack de ' + b.qty + ' (−$' + extra + ' en total desde ' + b.qty + ' piezas)…');
          return q('mutation($d: DiscountAutomaticBasicInput!) { discountAutomaticBasicCreate(automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field message } } }', { d: {
            title: 'Onnexa · ' + nombre + ' · pack de ' + b.qty, startsAt: new Date().toISOString(),
            combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
            minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(b.qty) } },
            customerGets: { value: { discountAmount: { amount: extra.toFixed(2), appliesOnEachItem: false } }, items: { products: multi ? { productsToAdd: [p.id] } : { productVariantsToAdd: [base.id] } } }
          } }).then(function (d) { errs(d.discountAutomaticBasicCreate); nuevos['pack' + b.qty] = d.discountAutomaticBasicCreate.automaticDiscountNode.id; });
        });
      } else if (b.qty > 1) log('Pack de ' + b.qty + ': sin descuento (no es más barato por unidad que la unidad suelta).');
    });
    // Regalos: en planes que no son Plus, un producto dentro de un BXGY no puede llevar otro descuento de producto
    // (help.shopify.com/manual/discounts/discount-combinations), así que no se usa BXGY: el regalo se vende a $0
    // (precio tachado = su valor) y el bloque de packs solo lo agrega al carrito cuando el pack lo desbloquea.
    if (regalos.length) paso = paso.then(function () { log('Dejando ' + regalos.length + ' regalo(s) a $0…'); return regalarGratis(regalos); });
    return paso.then(function () { return nuevos; });
  }

  function regalarGratis(regalos) {
    var ids = regalos.map(function (g) { return gid('ProductVariant', g.variant); });
    return q('query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice product { id } } } }', { ids: ids }).then(function (d) {
      var porProducto = {};
      d.nodes.forEach(function (v, i) {
        if (!v) throw new Error('No existe la variante del regalo ' + regalos[i].variant);
        var valor = Number(regalos[i].value || v.compareAtPrice || v.price || 0);
        if (Number(v.price) === 0 && Number(v.compareAtPrice || 0) === valor) return;
        (porProducto[v.product.id] = porProducto[v.product.id] || []).push({ id: v.id, price: '0.00', compareAtPrice: valor ? valor.toFixed(2) : null });
      });
      return Object.keys(porProducto).reduce(function (p, pid) {
        return p.then(function () {
          return q('mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $v) { userErrors { field message } } }', { id: pid, v: porProducto[pid] }).then(function (r) { errs(r.productVariantsBulkUpdate); });
        });
      }, Promise.resolve());
    });
  }

  root.ONB = ONB;
})(typeof module !== 'undefined' ? module.exports : window);
