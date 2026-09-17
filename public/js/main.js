/* =========================================================================
   main.js — comportamiento común de todas las páginas públicas.

   Cada bloque va dentro de su propio try/catch a propósito: si un bloque
   falla (por ejemplo un error al leer SJ_CONFIG), los demás bloques igual
   se ejecutan — en particular, la animación de aparición (.reveal) nunca se
   queda a medias y el contenido siempre termina visible.
   ========================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     1) Animación de aparición al hacer scroll (.reveal -> .reveal.in)
     ---------------------------------------------------------------------
     REGLA DE ORO: el CSS deja los elementos .reveal invisibles
     (opacity: 0). Si este bloque no corriera, la página entera se vería
     en blanco. Por eso hay TRES redes de seguridad:
       a) IntersectionObserver para la animación normal al hacer scroll.
       b) MutationObserver, para el contenido que se inserta después
          (catálogo, publicaciones, marcas...) — se observa al instante.
       c) Un temporizador final que muestra todo pase lo que pase.
     -------------------------------------------------------------------*/
  var io = null;

  function revealNow(el) {
    if (el && el.classList) el.classList.add('in');
  }

  function revealAll() {
    try {
      var all = document.querySelectorAll('.reveal');
      for (var i = 0; i < all.length; i++) revealNow(all[i]);
    } catch (e) { /* nada que hacer */ }
  }

  function observe(el) {
    if (!el || !el.classList || el.classList.contains('in')) return;
    if (io) {
      // Si ya está dentro de la pantalla, se muestra de inmediato.
      try {
        var r = el.getBoundingClientRect();
        if (r.top < (window.innerHeight || 0) + 100) { revealNow(el); return; }
      } catch (e) { /* seguimos con el observer */ }
      io.observe(el);
    } else {
      revealNow(el);
    }
  }

  function scanReveals(root) {
    try {
      var scope = root && root.querySelectorAll ? root : document;
      if (scope.classList && scope.classList.contains('reveal')) observe(scope);
      var els = scope.querySelectorAll ? scope.querySelectorAll('.reveal:not(.in)') : [];
      for (var i = 0; i < els.length; i++) observe(els[i]);
    } catch (e) { revealAll(); }
  }

  // Disponible para los demás scripts (home.js, catalog.js, publicaciones.js)
  // después de insertar tarjetas nuevas en el DOM.
  window.SJRevealScan = scanReveals;

  try {
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            revealNow(entry.target);
            io.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -60px 0px', threshold: 0.05 });
    }

    scanReveals(document);

    // Contenido insertado dinámicamente más tarde.
    if ('MutationObserver' in window) {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType === 1) scanReveals(added[j]);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  } catch (e) {
    revealAll();
  }

  // Red de seguridad definitiva: pase lo que pase, a los 2.5 s todo se ve.
  setTimeout(revealAll, 2500);
  window.addEventListener('load', function () { setTimeout(revealAll, 800); });

  /* ---------------------------------------------------------------------
     2) Menú móvil (hamburguesa)
     -------------------------------------------------------------------*/
  try {
    var mobileNav = document.getElementById('mobile-nav');
    var hamburger = document.getElementById('hamburger-btn');

    var closeMenu = function () {
      if (mobileNav) mobileNav.classList.remove('open');
      document.body.style.overflow = '';
    };
    var openMenu = function () {
      if (mobileNav) mobileNav.classList.add('open');
      document.body.style.overflow = 'hidden';
    };

    if (hamburger && mobileNav) {
      hamburger.addEventListener('click', function () {
        if (mobileNav.classList.contains('open')) closeMenu(); else openMenu();
      });
    }
    if (mobileNav) {
      var closeBtn = mobileNav.querySelector('.close-mobile');
      if (closeBtn) closeBtn.addEventListener('click', closeMenu);
      // Al tocar cualquier enlace, el menú se cierra.
      mobileNav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', closeMenu);
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeMenu();
    });
  } catch (e) {
    console.error('Error en el menú móvil:', e);
  }

  /* ---------------------------------------------------------------------
     3) Sombra de la barra superior al hacer scroll
     -------------------------------------------------------------------*/
  try {
    var navbar = document.querySelector('.navbar');
    if (navbar) {
      var onScroll = function () {
        if (window.scrollY > 8) navbar.classList.add('is-scrolled');
        else navbar.classList.remove('is-scrolled');
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  } catch (e) { /* cosmético, no es crítico */ }

  /* ---------------------------------------------------------------------
     4) Enlaces y textos de contacto dinámicos
        data-sj-link="whatsapp|facebook|instagram|maps|..."
        data-sj-text="address|whatsapp-display|..."
        data-sj-src="maps-embed"
        data-sj-hide-if-empty  -> se oculta mientras no haya dato real
     -------------------------------------------------------------------*/
  try {
    if (window.SJ_CONFIG) {
      var cfg = window.SJ_CONFIG;
      var waLink = window.SJ_WHATSAPP_LINK || function (m) {
        return 'https://wa.me/' + cfg.whatsappNumber + (m ? '?text=' + encodeURIComponent(m) : '');
      };

      var links = {
        whatsapp: waLink('Hola, vengo de la página web de Soluciones Jorge y quisiera más información.'),
        'whatsapp-taller': waLink('Hola, quisiera agendar una cita en el taller de Soluciones Jorge.', cfg.workshopWhatsapp),
        facebook: cfg.facebookPage,
        'geely-facebook': cfg.geelyFacebookPage,
         instagram: cfg.instagram,
        channel: cfg.facebookChannel,
        'facebook-group': cfg.facebookGroupUrl,
        'whatsapp-channel': cfg.whatsappChannelUrl,
        youtube: cfg.youtubeUrl,
        linktree: cfg.linktreeUrl,
        maps: cfg.mapsUrl
      };

      document.querySelectorAll('[data-sj-link]').forEach(function (el) {
        var key = el.getAttribute('data-sj-link');
        var value = links[key];
        if (value) {
          el.setAttribute('href', value);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
          if (el.hasAttribute('data-sj-hide-if-empty')) el.style.display = '';
        } else if (el.hasAttribute('data-sj-hide-if-empty')) {
          el.style.display = 'none';
        }
      });

      var texts = {
        address: cfg.address,
        description: cfg.description,
        hours: cfg.hoursDisplay,
        'whatsapp-display': cfg.whatsappDisplay,
        'workshop-address': cfg.workshopAddress,
        'workshop-hours': cfg.workshopHoursDisplay,
        'workshop-whatsapp-display': cfg.workshopWhatsappDisplay
      };
      Object.keys(texts).forEach(function (key) {
        if (!texts[key]) return;
        document.querySelectorAll('[data-sj-text="' + key + '"]').forEach(function (el) {
          el.textContent = texts[key];
        });
      });

      document.querySelectorAll('[data-sj-src="maps-embed"]').forEach(function (el) {
        if (cfg.mapsEmbedSrc) el.setAttribute('src', cfg.mapsEmbedSrc);
      });

      // Google Analytics — solo si hay un ID configurado.
      if (cfg.gaId) {
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + cfg.gaId;
        document.head.appendChild(s);
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        window.gtag('config', cfg.gaId);
      }
    }
  } catch (err) {
    console.error('Error al aplicar la configuración del sitio (SJ_CONFIG):', err);
  }

  /* ---------------------------------------------------------------------
     5) Año del pie de página (por si la página no lo pone en línea)
     -------------------------------------------------------------------*/
  try {
    document.querySelectorAll('#year').forEach(function (el) {
      if (!el.textContent.trim()) el.textContent = new Date().getFullYear();
    });
  } catch (e) { /* cosmético */ }
})();
