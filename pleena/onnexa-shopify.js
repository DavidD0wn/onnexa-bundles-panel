/* =============================================================================
   onnexa-shopify.js — lo que la app escribe en Shopify (sin servidor propio).
   Una oferta = 1 producto con:
     · variantes pack ("Paquete": 1 pieza / 2 piezas / 3 piezas) con su precio total
     · metafield onnexa.bundle (json) → lo lee el bloque "Packs" del theme Onnexa
     · 1 descuento automático "compra X llévate Y" por pack con regalos (Shopify no deja
       que un mismo artículo active 2 BXGY, por eso uno por pack)
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
    'options { name values } ' +
    'variants(first: 100) { nodes { id title price compareAtPrice sku inventoryPolicy selectedOptions { name value } inventoryItem { tracked } } } ' +
    'metafield(namespace: "' + NS + '", key: "' + KEY + '") { value updatedAt }';

  // shortcut: lee hasta 250 productos sin paginar; las tiendas tienen ~20, paginar si pasan de 250
  ONB.listDeals = function () {
    return q('{ products(first: 250, sortKey: UPDATED_AT, reverse: true) { nodes { ' + PRODUCT + ' } } }').then(function (d) {
      return d.products.nodes.filter(function (p) { return p.metafield; }).map(function (p) {
        var cfg = {}; try { cfg = JSON.parse(p.metafield.value); } catch (e) {}
        return { product: p, config: cfg };
      });
    });
  };
  ONB.getProduct = function (id) {
    return q('query($id: ID!) { product(id: $id) { ' + PRODUCT + ' } }', { id: gid('Product', id) }).then(function (d) {
      if (!d.product) throw new Error('No encontré el producto ' + id);
      return d.product;
    });
  };

  /* ------------------------------------------- estado del panel ↔ metafield */
  // state = el objeto del editor (mismo formato que la maqueta aprobada)
  ONB.configFromState = function (state, ctx) {
    var colors = Object.assign({}, state.style.colors);
    var badge = (state.on.badges && state.badges[0]) || {};
    colors.badgeBg = badge.bg || colors.labelBg; colors.badgeText = badge.color || colors.labelText;
    var bars = state.bars.map(function (b, i) {
      var bd = state.on.badges && state.badges.filter(function (x) { return x.bar === i; })[0];
      var out = { qty: b.qty, price: ctx.priceOf(b), title: b.title, subtitle: b.subtitle, label: b.label, image: b.img, variantId: ctx.variantOf(b.qty) };
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
      variantId: bars[0] && bars[0].variantId, unitCompareAt: ctx.unitCompare,
      title: state.blockTitle, preselected: state.preselected, bars: bars,
      gifts: { title: state.gifts.title, items: items },
      style: { radius: state.style.radius, spacing: state.style.spacing, imageSize: 42, colors: colors, fonts: state.style.fonts },
      discounts: ctx.discounts || {}
    };
  };
  // vuelve a llenar el editor con una oferta guardada (lo que no viene se queda como estaba)
  ONB.applyConfig = function (state, cfg) {
    if (!cfg || !cfg.bars) return state;
    state.name = cfg.name || state.name;
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
  // log(msg) recibe cada paso, para mostrarlo en el panel
  ONB.publish = function (productId, state, log) {
    log = log || function () {};
    var p, cfgOld = {}, packs = {}, unitCompare, unitPrice, base;
    return ONB.getProduct(productId).then(function (prod) {
      p = prod;
      try { cfgOld = JSON.parse((p.metafield || {}).value || '{}'); } catch (e) {}
      var opts = p.options.map(function (o) { return o.name; });
      var simple = p.variants.nodes.length === 1 && opts.length === 1 && opts[0] === 'Title';
      if (!simple && !(opts.length === 1 && opts[0] === OPT))
        throw new Error('"' + p.title + '" ya tiene variantes (' + opts.join(', ') + '). Por ahora Onnexa Bundles solo arma packs sobre productos de una sola variante.');
      // el precio unitario sale de la variante de 1 pieza (o la única)
      base = p.variants.nodes.filter(function (v) { return simple || v.selectedOptions[0].value === packName(1); })[0] || p.variants.nodes[0];
      unitPrice = Number(base.price); unitCompare = Number(base.compareAtPrice || base.price);
      if (simple) {
        log('Creando la opción "' + OPT + '"…');
        return q('mutation($id: ID!, $o: [OptionCreateInput!]!) { productOptionsCreate(productId: $id, options: $o, variantStrategy: LEAVE_AS_IS) { userErrors { field message } } }',
          { id: p.id, o: [{ name: OPT, values: [{ name: packName(1) }] }] }).then(function (d) { errs(d.productOptionsCreate); return ONB.getProduct(p.id); }).then(function (pp) { p = pp; });
      }
    }).then(function () {
      p.variants.nodes.forEach(function (v) { var m = /^(\d+) pieza/.exec(v.selectedOptions[0].value); if (m) packs[Number(m[1])] = v; });
      var priceOf = function (b) { return b.priceType === 'fixed' ? Number(b.value) : b.priceType === 'percent' ? Math.round(unitPrice * b.qty * (1 - b.value / 100)) : b.priceType === 'amount' ? Math.max(0, unitPrice * b.qty - b.value) : unitPrice * b.qty; };
      var sku = function (qty) { return (base.sku || p.handle.slice(0, 12).toUpperCase()).replace(/-x\d+$/, '') + '-x' + qty; };
      var nuevos = [], cambios = [];
      state.bars.forEach(function (b) {
        var datos = { price: String(priceOf(b)), compareAtPrice: String(unitCompare * b.qty) };
        if (packs[b.qty]) cambios.push(Object.assign({ id: packs[b.qty].id, inventoryItem: { sku: sku(b.qty) } }, datos));
        else nuevos.push(Object.assign({ optionValues: [{ optionName: OPT, name: packName(b.qty) }], inventoryPolicy: base.inventoryPolicy, inventoryItem: { sku: sku(b.qty), tracked: base.inventoryItem.tracked } }, datos));
      });
      var paso = Promise.resolve();
      if (cambios.length) paso = paso.then(function () {
        log('Actualizando precios de ' + cambios.length + ' pack(s)…');
        return q('mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $v) { userErrors { field message } } }', { id: p.id, v: cambios }).then(function (d) { errs(d.productVariantsBulkUpdate); });
      });
      if (nuevos.length) paso = paso.then(function () {
        log('Creando ' + nuevos.length + ' variante(s) pack…');
        return q('mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $id, variants: $v) { userErrors { field message } } }', { id: p.id, v: nuevos }).then(function (d) { errs(d.productVariantsBulkCreate); });
      });
      return paso.then(function () { return ONB.getProduct(p.id); }).then(function (pp) {
        p = pp; packs = {};
        p.variants.nodes.forEach(function (v) { var m = /^(\d+) pieza/.exec(v.selectedOptions[0].value); if (m) packs[Number(m[1])] = v; });
        return { priceOf: priceOf };
      });
    }).then(function (ctx) {
      return sincronizarDescuentos(p, state, packs, cfgOld.discounts || {}, log).then(function (discounts) {
        var cfg = ONB.configFromState(state, {
          dealId: cfgOld.dealId || p.handle, unitCompare: unitCompare, discounts: discounts,
          priceOf: ctx.priceOf, variantOf: function (qty) { return packs[qty] ? num(packs[qty].id) : null; }
        });
        log('Guardando la oferta en el producto…');
        return q('mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }',
          { m: [{ ownerId: p.id, namespace: NS, key: KEY, type: 'json', value: JSON.stringify(cfg) }] }).then(function (d) { errs(d.metafieldsSet); return { product: p, config: cfg }; });
      });
    });
  };

  // un BXGY por pack que tenga regalos de producto; se recrea en cada publicación
  function sincronizarDescuentos(p, state, packs, viejos, log) {
    var nuevos = {}, paso = Promise.resolve();
    var regalos = state.on.gifts ? state.gifts.items.filter(function (g) { return g.type === 'product' && g.variant; }) : [];
    Object.keys(viejos).forEach(function (qty) {
      paso = paso.then(function () {
        return q('mutation($id: ID!) { discountAutomaticDelete(id: $id) { userErrors { field message } } }', { id: viejos[qty] })
          .then(function (d) { errs(d.discountAutomaticDelete); }).catch(function () { /* ya no existía */ });
      });
    });
    state.bars.forEach(function (b) {
      var suyos = regalos.filter(function (g) { return g.unlockAt <= b.qty; });
      if (!suyos.length || !packs[b.qty]) return;
      paso = paso.then(function () {
        log('Descuento de regalo para ' + packName(b.qty) + '…');
        var titulo = 'Onnexa · ' + (state.name || p.title).slice(0, 60) + ' · regalo con ' + packName(b.qty);
        return q('mutation($d: DiscountAutomaticBxgyInput!) { discountAutomaticBxgyCreate(automaticBxgyDiscount: $d) { automaticDiscountNode { id } userErrors { field message } } }', { d: {
          title: titulo, startsAt: new Date().toISOString(), usesPerOrderLimit: '1',
          combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
          customerBuys: { value: { quantity: '1' }, items: { products: { productVariantsToAdd: [packs[b.qty].id] } } },
          customerGets: { value: { discountOnQuantity: { quantity: String(suyos.length), effect: { percentage: 1 } } },
            items: { products: { productVariantsToAdd: suyos.map(function (g) { return gid('ProductVariant', g.variant); }) } } }
        } }).then(function (d) { errs(d.discountAutomaticBxgyCreate); nuevos[b.qty] = d.discountAutomaticBxgyCreate.automaticDiscountNode.id; });
      });
    });
    return paso.then(function () { return nuevos; });
  }

  root.ONB = ONB;
})(typeof module !== 'undefined' ? module.exports : window);
