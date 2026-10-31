/* =============================================================================
   ebooks-app.js — panel "Onnexa Ebooks" dentro del admin de Shopify.
   Todo vive en Shopify: el PDF va a Archivos y se cuelga del producto en el
   metacampo onnexa.ebook_pdf. El dashboard solo lee ese metacampo para mandar
   el correo cuando el pedido se paga; este panel no habla con el dashboard.
   ========================================================================== */
(function () {
  'use strict';
  var API = '2025-01';
  var NS = 'onnexa', KEY = 'ebook_pdf';

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
  var nombreDeUrl = function (u) { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()); } catch (e) { return 'archivo.pdf'; } };

  function gql(query, variables) {
    var url = window.shopify ? 'shopify:admin/api/' + API + '/graphql.json' : '/__gql';
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query, variables: variables || {} }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.errors) throw new Error(d.errors.map(function (e) { return e.message; }).join(' · '));
        return d.data;
      });
  }
  function errores(res) {
    var ue = res && res.userErrors;
    if (ue && ue.length) throw new Error(ue.map(function (e) { return e.message; }).join(' · '));
    return res;
  }

  function aviso(msg, mal) {
    var t = $('#aviso');
    t.textContent = msg;
    t.className = 'aviso ' + (mal ? 'mal' : 'bien');
    t.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    clearTimeout(aviso.t);
    aviso.t = setTimeout(function () { t.style.display = 'none'; }, 7000);
  }

  var productos = [], tienda = 'tu tienda', abierto = null;

  /* ------------------------------------------------------------- cargar */
  function cargar() {
    var q = 'query($c:String){ shop{ name } products(first:100, after:$c, query:"status:active"){ pageInfo{ hasNextPage endCursor } ' +
      'nodes{ id title totalVariants featuredMedia{ preview{ image{ url } } } ' +
      'metafield(namespace:"' + NS + '", key:"' + KEY + '"){ reference{ ... on GenericFile { url } } } } } }';
    productos = [];
    var pagina = function (cursor) {
      return gql(q, { c: cursor }).then(function (d) {
        tienda = d.shop.name;
        d.products.nodes.forEach(function (p) {
          productos.push({
            id: p.id, titulo: p.title, variantes: p.totalVariants,
            foto: (((p.featuredMedia || {}).preview || {}).image || {}).url || '',
            pdf: p.metafield && p.metafield.reference ? p.metafield.reference.url : ''
          });
        });
        if (d.products.pageInfo.hasNextPage) return pagina(d.products.pageInfo.endCursor);
      });
    };
    return pagina(null).then(pintarLista).catch(function (e) {
      $('#lista').innerHTML = '<div class="vacio">No pude leer los productos: ' + esc(e.message) + '</div>';
    });
  }

  function pintarLista() {
    var filtro = ($('#buscar').value || '').toLowerCase();
    var vis = productos.filter(function (p) { return !filtro || p.titulo.toLowerCase().indexOf(filtro) >= 0; });
    // los que ya tienen ebook, arriba
    vis.sort(function (a, b) { return (b.pdf ? 1 : 0) - (a.pdf ? 1 : 0); });
    if (!vis.length) { $('#lista').innerHTML = '<div class="vacio">Ningún producto coincide.</div>'; return; }
    $('#lista').innerHTML = vis.map(function (p) {
      return '<div class="fila">' +
        '<div class="foto">' + (p.foto ? '<img src="' + esc(p.foto) + '" alt="">' : '') + '</div>' +
        '<div class="nom">' + esc(p.titulo) + '</div>' +
        '<div class="arch' + (p.pdf ? '' : ' cero') + '">' + (p.pdf ? '1' : '0') + '</div>' +
        '<div class="acc">' +
          '<button class="enlace" data-editar="' + esc(p.id) + '">Editar</button>' +
          (p.pdf ? '<button class="enlace rojo" data-quitar="' + esc(p.id) + '">Quitar</button>' : '') +
        '</div></div>';
    }).join('');
  }

  /* ------------------------------------------------------------- editor */
  function abrir(p) {
    abierto = p;
    $('#vLista').style.display = 'none';
    $('#vEditor').style.display = '';
    $('#edTitulo').textContent = p.pdf ? 'Editar ebook' : 'Nuevo ebook';
    $('#edFoto').innerHTML = p.foto ? '<img src="' + esc(p.foto) + '" alt="">' : '';
    $('#edNombre').textContent = p.titulo;
    $('#edVariantes').textContent = p.variantes === 1 ? 'Una sola versión' : p.variantes + ' versiones (el PDF va con todas)';
    $('#pvDe').textContent = tienda;
    $('#pvTitulo').textContent = p.titulo;
    pintarArchivo();
    window.scrollTo({ top: 0 });
  }

  function pintarArchivo() {
    var p = abierto;
    $('#tic3').className = 'tic' + (p.pdf ? '' : ' off');
    $('#edArchivo').innerHTML = p.pdf
      ? '<div class="archivo">📄 <span class="nomf">' + esc(nombreDeUrl(p.pdf)) + '</span>' +
        '<span class="pill">Listo</span>' +
        '<a class="enlace" href="' + esc(p.pdf) + '" target="_blank" rel="noreferrer">Ver</a>' +
        '<button class="enlace rojo" data-quitar="' + esc(p.id) + '">Quitar</button></div>'
      : '';
    $('#pvArchivo').textContent = p.pdf ? nombreDeUrl(p.pdf) : '(sin archivo todavía)';
  }

  function cerrar() {
    abierto = null;
    $('#vEditor').style.display = 'none';
    $('#vLista').style.display = '';
    pintarLista();
  }

  /* --------------------------------------------------------- subir el PDF */
  function subir(producto, archivo) {
    if (archivo.type !== 'application/pdf') return Promise.reject(new Error('El archivo debe ser un PDF.'));
    if (archivo.size > 25 * 1024 * 1024) return Promise.reject(new Error('El PDF pesa más de 25 MB.'));
    // Shopify reescribe los nombres con acentos o espacios y después la url no coincide
    var nombre = (archivo.name.replace(/\.pdf$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'ebook') + '.pdf';

    return gql('mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{name value} } userErrors{message} } }',
      { input: [{ resource: 'FILE', filename: nombre, mimeType: 'application/pdf', fileSize: String(archivo.size), httpMethod: 'POST' }] })
      .then(function (d) {
        errores(d.stagedUploadsCreate);
        var t = d.stagedUploadsCreate.stagedTargets[0];
        var fd = new FormData();
        t.parameters.forEach(function (p) { fd.append(p.name, p.value); });
        fd.append('file', archivo, nombre);
        return fetch(t.url, { method: 'POST', body: fd }).then(function (r) {
          if (!r.ok) throw new Error('La subida a Shopify falló (HTTP ' + r.status + ').');
          return t.resourceUrl;
        });
      })
      .then(function (resourceUrl) {
        return gql('mutation($files:[FileCreateInput!]!){ fileCreate(files:$files){ files{ id } userErrors{message} } }',
          { files: [{ contentType: 'FILE', originalSource: resourceUrl, filename: nombre }] });
      })
      .then(function (d) { errores(d.fileCreate); return d.fileCreate.files[0].id; })
      .then(function (fileId) {
        // Shopify procesa el archivo aparte: hay que esperar a que quede READY
        var intenta = function (n) {
          return gql('query($id:ID!){ node(id:$id){ ... on GenericFile{ fileStatus url } } }', { id: fileId })
            .then(function (d) {
              if (d.node && d.node.fileStatus === 'READY') return { id: fileId, url: d.node.url };
              if (d.node && d.node.fileStatus === 'FAILED') throw new Error('Shopify no pudo procesar el PDF.');
              if (n > 25) throw new Error('Shopify tardó demasiado; vuelve a intentar en un minuto.');
              return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return intenta(n + 1); });
            });
        };
        return intenta(0);
      })
      .then(function (f) {
        return gql('mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ id } userErrors{message} } }',
          { m: [{ ownerId: producto.id, namespace: NS, key: KEY, type: 'file_reference', value: f.id }] })
          .then(function (d) { errores(d.metafieldsSet); return f.url; });
      });
  }

  function quitar(producto) {
    return gql('mutation($m:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$m){ deletedMetafields{ key } userErrors{message} } }',
      { m: [{ ownerId: producto.id, namespace: NS, key: KEY }] })
      .then(function (d) { errores(d.metafieldsDelete); });
  }

  var porId = function (id) { return productos.filter(function (p) { return p.id === id; })[0]; };

  function recibirArchivo(f) {
    var p = abierto;
    if (!p || !f) return;
    $('#zona').innerHTML = 'Subiendo <b>' + esc(f.name) + '</b>…';
    subir(p, f).then(function (url) {
      p.pdf = url;
      pintarArchivo();
      $('#zona').innerHTML = 'PDF cargado. Arrastra otro aquí para reemplazarlo o <button class="b2" id="elegir" style="margin-left:4px">Elegir archivo</button>';
      aviso('Listo: "' + p.titulo + '" ya entrega su PDF solo.');
    }).catch(function (e) {
      aviso(e.message, true);
      $('#zona').innerHTML = 'Arrastra aquí el PDF o <button class="b2" id="elegir" style="margin-left:4px">Elegir archivo</button>' +
        '<div class="gris" style="margin-top:7px; font-size:12px">Solo PDF, hasta 25 MB</div>';
    });
  }

  /* ------------------------------------------------------------- eventos */
  document.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-editar]'), qu = e.target.closest('[data-quitar]');
    if (e.target.id === 'elegir') { $('#archivo').value = ''; $('#archivo').click(); }
    if (e.target.id === 'volver') cerrar();
    if (ed) { var p = porId(ed.getAttribute('data-editar')); if (p) abrir(p); }
    if (qu) {
      var q = porId(qu.getAttribute('data-quitar'));
      if (!q || !confirm('¿Quitar el ebook de "' + q.titulo + '"? El PDF sigue en Archivos de Shopify.')) return;
      qu.disabled = true;
      quitar(q).then(function () {
        q.pdf = '';
        aviso('Ebook quitado de ' + q.titulo);
        if (abierto && abierto.id === q.id) pintarArchivo(); else pintarLista();
      }).catch(function (err) { aviso(err.message, true); qu.disabled = false; });
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'archivo' && e.target.files[0]) recibirArchivo(e.target.files[0]);
  });
  document.addEventListener('input', function (e) { if (e.target.id === 'buscar') pintarLista(); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var z = e.target.closest && e.target.closest('#zona');
      if (!z) return;
      e.preventDefault(); z.classList.add('sobre');
    });
  });
  document.addEventListener('dragleave', function (e) {
    var z = e.target.closest && e.target.closest('#zona');
    if (z) z.classList.remove('sobre');
  });
  document.addEventListener('drop', function (e) {
    var z = e.target.closest && e.target.closest('#zona');
    if (!z) return;
    e.preventDefault(); z.classList.remove('sobre');
    if (e.dataTransfer.files[0]) recibirArchivo(e.dataTransfer.files[0]);
  });

  cargar();
})();
