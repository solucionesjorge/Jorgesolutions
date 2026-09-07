// Datos de contacto y configuración compartida del sitio.
// Edita aquí si cambian los enlaces de redes sociales, el WhatsApp, la
// dirección o el horario. Los campos vacíos ('') simplemente no se muestran
// en la página — rellénalos cuando tengas el dato real.
window.SJ_CONFIG = {
  brand: 'Soluciones Jorge',

  // Dominio público definitivo (se usa para enlaces canónicos y para compartir).
  siteUrl: 'https://solucionesjorge.com',

  whatsappNumber: '5352467279', // formato internacional sin "+" (53 = Cuba)
  whatsappDisplay: '+53 5 246 7279',

  // Redes sociales confirmadas
  facebookPage: 'https://www.facebook.com/share/1FCr6JDNz8/',
  instagram: 'https://www.instagram.com/geelysjcuba',
  facebookChannel: 'https://www.facebook.com/share/g/1CrfAU2Kqe/',

  // Pendientes de recibir la URL real — se ocultan automáticamente mientras
  // queden vacíos. En cuanto tengas el enlace, pégalo aquí entre comillas.
  youtubeUrl: '',
  whatsappChannelUrl: '',
  facebookGroupUrl: '', // "Grupo Geely SJ Cuba"
  linktreeUrl: '',

  // Tienda
  address: 'Calle 25 #4411 A, entre 44 y 46, municipio Playa, La Habana, Cuba',
  hoursDisplay: 'Lunes a sábado, 8:00 am – 5:00 pm',

  // Taller — se asumió la misma dirección, teléfono y horario que la tienda.
  // Si el taller tiene su propio local, cambia estos 3 campos.
  workshopAddress: 'Calle 25 #4411 A, entre 44 y 46, municipio Playa, La Habana, Cuba',
  workshopWhatsapp: '5352467279',
  workshopWhatsappDisplay: '+53 5 246 7279',
  workshopHoursDisplay: 'Lunes a sábado, 8:00 am – 5:00 pm',

  mapsUrl: 'https://maps.app.goo.gl/oXtDwDvNvSbgo59p9?g_st=ac',
  mapsEmbedSrc: 'https://maps.google.com/maps?q=' + encodeURIComponent('Calle 25 #4411 A, entre 44 y 46, Playa, La Habana, Cuba') + '&output=embed',

  description: 'Más de 8 años manteniendo los Geely de Cuba en movimiento. Repuestos originales y alternativos, asesoría especializada y atención rápida para que encuentres exactamente lo que tu vehículo necesita. Tu Geely, en manos de especialistas.',

  // SEO / analítica — opcional. Pega tu propio ID cuando tengas cuentas de
  // Google Analytics / Search Console; si se dejan vacíos, no se activa nada.
  gaId: '', // ej. 'G-XXXXXXXXXX'
  gscVerification: '' // contenido del meta tag de verificación de Search Console
};

window.SJ_WHATSAPP_LINK = function (message, number) {
  var cfg = window.SJ_CONFIG || {};
  var base = 'https://wa.me/' + (number || cfg.whatsappNumber || '');
  return message ? base + '?text=' + encodeURIComponent(message) : base;
};
