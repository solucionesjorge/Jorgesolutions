/**
 * Soluciones Jorge — servidor web
 * ---------------------------------------------------------------
 * Servidor Node.js SIN dependencias externas (usa solo módulos nativos).
 * Sirve el sitio público, el blog (con SEO por artículo), la API del
 * catálogo (marcas → modelos → categorías), formularios (citas y
 * solicitud de piezas) y el panel de administración exclusivo de Jorge.
 *
 * Arrancar:   node server.js
 * Puerto:     process.env.PORT || 3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./lib/store');
const auth = require('./lib/auth');
const { parseMultipart } = require('./lib/multipart');
const { render, escapeHtml } = require('./lib/render');
const spam = require('./lib/spam-guard');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Carpeta de las fotos subidas desde el panel. Igual que con los datos:
// por defecto es la carpeta "uploads" del proyecto, y se puede apuntar a un
// disco permanente con la variable de entorno UPLOADS_DIR.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const MAX_BODY_BYTES = 14 * 1024 * 1024; // 14MB (formulario de solicitud puede llevar 2 fotos)
// Dominio público definitivo. Se usa para sitemap.xml, robots.txt y los
// enlaces canónicos del blog. Se puede sobrescribir con la variable de
// entorno SITE_URL sin tocar el código.
const SITE_URL = process.env.SITE_URL || 'https://solucionesjorge.com';

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

function sendJSON(res, status, data, extraHeaders) {
  send(res, status, JSON.stringify(data), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readFields(req) {
  const bodyBuf = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return { ...parseMultipart(bodyBuf, contentType), isMultipart: true };
  }
  try {
    return { fields: JSON.parse(bodyBuf.toString('utf8') || '{}'), files: {}, isMultipart: false };
  } catch (e) {
    const err = new Error('JSON inválido');
    err.status = 400;
    throw err;
  }
}

function safeJoin(base, target) {
  const targetPath = path.normalize(path.join(base, target));
  if (!targetPath.startsWith(base)) return null;
  return targetPath;
}

function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath.startsWith('/uploads/')) {
    filePath = safeJoin(UPLOADS_DIR, urlPath.replace('/uploads/', ''));
  } else {
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    filePath = safeJoin(PUBLIC_DIR, rel);
  }
  if (!filePath) return send(res, 400, 'Ruta inválida');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const htmlAttempt = filePath.endsWith('.html') ? null : `${filePath}.html`;
      if (htmlAttempt && fs.existsSync(htmlAttempt)) return streamFile(res, htmlAttempt);
      return send(res, 404, notFoundPage(), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    streamFile(res, filePath);
  });
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const cacheControl = ['.html', '.css', '.js'].includes(ext)
    ? 'no-cache, must-revalidate'
    : 'public, max-age=86400';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl });
  fs.createReadStream(filePath).pipe(res);
}

function notFoundPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>404 · Soluciones Jorge</title>
  <style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b1220;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  a{color:#4da3ff}</style></head><body><div style="text-align:center"><h1>404</h1><p>Página no encontrada.</p><p><a href="/">Volver al inicio</a></p></div></body></html>`;
}

function sanitizeString(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max || 2000);
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || crypto.randomUUID().slice(0, 8);
}

// ============================================================
// Validación: productos
// ============================================================
function validateProductInput(fields) {
  const errors = [];
  const brands = store.getBrands();
  const categories = store.getCategories();

  const name = sanitizeString(fields.name, 150);
  const brand = sanitizeString(fields.brand, 60);
  const model = sanitizeString(fields.model, 60); // puede quedar vacío = "varios modelos"
  const category = sanitizeString(fields.category, 60);
  const description = sanitizeString(fields.description, 2000);
  const sku = sanitizeString(fields.sku, 60);
  const priceRaw = fields.price;
  const stockRaw = fields.stock;
  const imageUrl = sanitizeString(fields.imageUrl, 500);
  const available = fields.available === 'true' || fields.available === true || fields.available === '1';
  let inStock = fields.inStock === 'true' || fields.inStock === true || fields.inStock === '1' || fields.inStock === undefined;

  if (!name) errors.push('El nombre de la pieza es obligatorio.');

  const brandObj = brands.find((b) => b.slug === brand);
  if (!brandObj) errors.push('La marca no es válida.');
  if (brandObj && model && !brandObj.models.some((m) => m.slug === model)) {
    errors.push('El modelo no pertenece a la marca seleccionada.');
  }
  if (!categories.some((c) => c.slug === category)) errors.push('La categoría no es válida.');

  let price = null;
  if (priceRaw !== undefined && priceRaw !== null && priceRaw !== '') {
    price = Number(priceRaw);
    if (!Number.isFinite(price) || price < 0) { errors.push('El precio debe ser un número válido.'); price = null; }
  }

  // Cantidad en stock: campo numérico opcional. Si se deja vacío, la
  // disponibilidad se sigue controlando a mano con la casilla "Disponible en
  // stock" (compatibilidad con piezas que no se cuentan una por una). Si se
  // indica una cantidad, esta manda: 0 unidades = agotado automáticamente.
  let stock = null;
  if (stockRaw !== undefined && stockRaw !== null && stockRaw !== '') {
    stock = Number(stockRaw);
    if (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock)) {
      errors.push('La cantidad en stock debe ser un número entero de 0 o más.');
      stock = null;
    } else {
      inStock = stock > 0;
    }
  }

  return { errors, value: { name, brand, model, category, description, sku, price, stock, imageUrl, available, inStock } };
}

function publicProduct(p) {
  if (!p || p.stock === undefined) return p;
  const { stock, ...rest } = p;
  return rest;
}

// ============================================================
// Subida de imágenes — validación real del archivo
// ============================================================
// No se confía en el nombre ni en la extensión que manda el navegador: se
// leen los primeros bytes del archivo (su "firma") para saber qué es de
// verdad. Así nadie puede colar una página o un script disfrazado de foto.
// La extensión guardada la decide el servidor a partir de esa firma.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB por foto

function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG:  89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return '.png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // GIF:  "GIF87a" / "GIF89a"
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return '.gif';
  // WEBP: "RIFF" .... "WEBP"
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

function handleImageUpload(files, fieldName) {
  const file = files && files[fieldName];
  if (!file || !file.data || !file.data.length) return null;

  if (file.data.length > MAX_IMAGE_BYTES) {
    throw Object.assign(
      new Error(`La imagen es demasiado grande (máximo ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB). Reduce la foto e inténtalo otra vez.`),
      { status: 400 }
    );
  }

  const ext = detectImageType(file.data);
  if (!ext) {
    throw Object.assign(
      new Error('El archivo no es una imagen válida. Solo se aceptan fotos JPG, PNG, GIF o WEBP.'),
      { status: 400 }
    );
  }

  const fileName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), file.data);
  return `/uploads/${fileName}`;
}

function deleteUpload(imagePath) {
  if (imagePath && imagePath.startsWith('/uploads/')) {
    fs.unlink(path.join(UPLOADS_DIR, path.basename(imagePath)), () => {});
  }
}

// ============================================================
// CRUD genérico para colecciones simples con id (testimonios, posts, etc.)
// ============================================================
function genericList(getFn) {
  return getFn();
}
function genericCreate(getFn, saveFn, obj) {
  const list = getFn();
  list.push(obj);
  saveFn(list);
  return obj;
}
function genericUpdate(getFn, saveFn, id, patch) {
  const list = getFn();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  list[idx] = Object.assign({}, list[idx], patch, { id: list[idx].id, updatedAt: new Date().toISOString() });
  saveFn(list);
  return list[idx];
}
function genericDelete(getFn, saveFn, id) {
  const list = getFn();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  saveFn(list);
  return removed;
}

// ============================================================
// Blog: render en servidor (para título/meta-descripción por artículo)
// ============================================================
function renderBlogIndex() {
  const posts = store.getPosts().filter((p) => p.published !== false).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const cards = posts.map((p) => `
    <a class="blog-card" href="/blog/${escapeHtml(p.slug)}">
      <div class="blog-card-media">${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy">` : '<span class="ph">📰</span>'}</div>
      <div class="blog-card-body">
        <span class="blog-date">${new Date(p.createdAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.excerpt || '')}</p>
        <span class="blog-readmore">Leer artículo →</span>
      </div>
    </a>`).join('');

  return render('blog-index.html', {
    POSTS_LIST: cards || '<p style="color:#79808c;text-align:center;padding:40px 0">Todavía no hay artículos publicados. Vuelve pronto.</p>'
  });
}

function renderBlogPost(slug) {
  const post = store.getPosts().find((p) => p.slug === slug && p.published !== false);
  if (!post) return null;
  const dateStr = new Date(post.createdAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
  const contentHtml = escapeHtml(post.content || '')
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return render('blog-post.html', {
    TITLE: escapeHtml(post.title) + ' · Soluciones Jorge',
    META_DESCRIPTION: escapeHtml(post.metaDescription || post.excerpt || ''),
    POST_TITLE: escapeHtml(post.title),
    POST_DATE: dateStr,
    POST_IMAGE: post.image ? `<img src="${escapeHtml(post.image)}" alt="${escapeHtml(post.title)}" style="width:100%;border-radius:20px;margin-bottom:24px">` : '',
    POST_CONTENT: contentHtml,
    CANONICAL_URL: SITE_URL ? `${SITE_URL}/blog/${encodeURIComponent(post.slug)}` : ''
  });
}

// ============================================================
// sitemap.xml / robots.txt
// ============================================================
function buildSitemap() {
  const base = SITE_URL || 'https://tu-dominio-aqui.com';
  const staticPages = ['/', '/catalogo.html', '/nosotros.html', '/taller.html', '/solicitar-pieza.html', '/testimonios.html', '/blog', '/publicaciones.html', '/privacidad.html', '/terminos.html', '/garantia.html'];
  const posts = store.getPosts().filter((p) => p.published !== false);
  const urls = [
    ...staticPages.map((p) => `<url><loc>${base}${p}</loc></url>`),
    ...posts.map((p) => `<url><loc>${base}/blog/${encodeURIComponent(p.slug)}</loc></url>`)
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}

// ============================================================
// API
// ============================================================
async function handleApi(req, res, pathname, query) {
  // --- Autenticación ---
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const { fields } = await readFields(req);
    const admin = store.getAdmin();
    if (!admin) return sendJSON(res, 400, { error: 'Aún no se ha configurado el administrador. Ejecuta: node scripts/set-admin-password.js' });
    const { username, password } = fields;
    if (username !== admin.username || !auth.verifyPassword(password || '', admin.salt, admin.hash)) {
      return sendJSON(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    }
    const cookie = auth.createSessionCookie(admin.username, req);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookie(req) });
  }

  if (pathname === '/api/admin/session' && req.method === 'GET') {
    return sendJSON(res, 200, { authenticated: auth.isAuthenticated(req) });
  }

  // --- Configurar la contraseña la PRIMERA vez, sin usar la terminal ---
  // Solo funciona mientras no exista ningún administrador todavía. En cuanto
  // se crea uno, esta ruta queda bloqueada para siempre (por seguridad) y el
  // único camino para cambiarla pasa a ser "Mi cuenta" ya con sesión iniciada,
  // o el script de terminal si alguien olvida la contraseña.
  if (pathname === '/api/admin/setup-status' && req.method === 'GET') {
    return sendJSON(res, 200, { configured: !!store.getAdmin() });
  }
  if (pathname === '/api/admin/setup-password' && req.method === 'POST') {
    if (store.getAdmin()) return sendJSON(res, 400, { error: 'Ya existe una contraseña configurada. Si la olvidaste, pide ayuda para restablecerla desde la terminal del servidor.' });
    const { fields } = await readFields(req);
    const password = typeof fields.password === 'string' ? fields.password : '';
    if (password.length < 6) return sendJSON(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    const { salt, hash } = auth.hashPassword(password);
    store.saveAdmin({ username: 'jorge', salt, hash, updatedAt: new Date().toISOString() });
    const cookie = auth.createSessionCookie('jorge', req);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  // --- Cambiar la contraseña, ya con sesión iniciada ---
  if (pathname === '/api/admin/password' && req.method === 'PUT') {
    if (!auth.isAuthenticated(req)) return sendJSON(res, 401, { error: 'No autorizado' });
    const { fields } = await readFields(req);
    const admin = store.getAdmin();
    const currentPassword = typeof fields.currentPassword === 'string' ? fields.currentPassword : '';
    const newPassword = typeof fields.newPassword === 'string' ? fields.newPassword : '';
    if (!auth.verifyPassword(currentPassword, admin.salt, admin.hash)) {
      return sendJSON(res, 401, { error: 'La contraseña actual no es correcta.' });
    }
    if (newPassword.length < 6) return sendJSON(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    const { salt, hash } = auth.hashPassword(newPassword);
    store.saveAdmin({ username: admin.username, salt, hash, updatedAt: new Date().toISOString() });
    return sendJSON(res, 200, { ok: true });
  }

  // --- Catálogo: marcas y categorías (lectura pública) ---
  if (pathname === '/api/categories' && req.method === 'GET') return sendJSON(res, 200, store.getCategories());
  if (pathname === '/api/brands' && req.method === 'GET') return sendJSON(res, 200, store.getBrands());

  // --- Productos (lectura pública) ---
  if (pathname === '/api/products' && req.method === 'GET') {
    let products = store.getProducts();
    const isAdmin = auth.isAuthenticated(req);
    if (!isAdmin) products = products.filter((p) => p.available !== false);

    const brand = query.get('brand');
    const model = query.get('model');
    const category = query.get('category');
    const inStockOnly = query.get('inStock') === '1';
    const q = (query.get('q') || '').trim().toLowerCase();
    const sort = query.get('sort'); // price_asc | price_desc | newest

    if (brand) products = products.filter((p) => p.brand === brand);
    if (model) products = products.filter((p) => p.model === model);
    if (category) products = products.filter((p) => p.category === category);
    if (inStockOnly) products = products.filter((p) => p.inStock !== false);
    if (q) {
      products = products.filter((p) => `${p.name} ${p.description || ''} ${p.sku || ''}`.toLowerCase().includes(q));
    }

    if (sort === 'price_asc') products.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    else if (sort === 'price_desc') products.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    else products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return sendJSON(res, 200, isAdmin ? products : products.map(publicProduct));
  }

  const productIdMatch = pathname.match(/^\/api\/products\/([\w-]+)$/);
  if (productIdMatch && req.method === 'GET') {
    const product = store.getProducts().find((p) => p.id === productIdMatch[1]);
    if (!product) return sendJSON(res, 404, { error: 'Pieza no encontrada' });
    if (product.available === false && !auth.isAuthenticated(req)) return sendJSON(res, 404, { error: 'Pieza no encontrada' });
    return sendJSON(res, 200, auth.isAuthenticated(req) ? product : publicProduct(product));
  }

  // --- Testimonios (lectura pública) ---
  if (pathname === '/api/testimonials' && req.method === 'GET') {
    const list = store.getTestimonials().filter((t) => t.published !== false);
    return sendJSON(res, 200, list);
  }

  // --- Publicaciones: secciones y feed (lectura pública) ---
  if (pathname === '/api/pub-sections' && req.method === 'GET') return sendJSON(res, 200, store.getPubSections());
  if (pathname === '/api/publications' && req.method === 'GET') {
    let list = store.getPublications().filter((p) => p.published !== false);
    const seccion = query.get('seccion');
    const q = (query.get('q') || '').trim().toLowerCase();
    if (seccion) list = list.filter((p) => p.section === seccion);
    if (q) list = list.filter((p) => `${p.title} ${p.summary || ''}`.toLowerCase().includes(q));
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJSON(res, 200, list);
  }
  const pubItemMatch = pathname.match(/^\/api\/publications\/([\w-]+)$/);
  if (pubItemMatch && req.method === 'GET') {
    const pub = store.getPublications().find((p) => p.id === pubItemMatch[1] && p.published !== false);
    if (!pub) return sendJSON(res, 404, { error: 'Publicación no encontrada' });
    return sendJSON(res, 200, pub);
  }

  // --- Formulario: solicitar cita en el taller ---
  if (pathname === '/api/appointments' && req.method === 'POST') {
    if (spam.isRateLimited(req, 'appointments')) return sendJSON(res, 429, { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' });
    const { fields } = await readFields(req);
    if (spam.isHoneypotTripped(fields)) return sendJSON(res, 200, { ok: true }); // finge éxito ante bots

    const errors = [];
    const name = sanitizeString(fields.name, 120);
    const phone = sanitizeString(fields.phone, 40);
    const brand = sanitizeString(fields.brand, 60);
    const model = sanitizeString(fields.model, 60);
    const problem = sanitizeString(fields.problem, 1000);
    const day = sanitizeString(fields.day, 60);
    if (!name) errors.push('El nombre es obligatorio.');
    if (!phone) errors.push('El teléfono o WhatsApp es obligatorio.');
    if (!problem) errors.push('Cuéntanos brevemente el problema del vehículo.');
    if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });

    const appointment = { id: crypto.randomUUID(), name, phone, brand, model, problem, day, status: 'pendiente', createdAt: new Date().toISOString() };
    genericCreate(store.getAppointments, store.saveAppointments, appointment);
    return sendJSON(res, 201, { ok: true, id: appointment.id });
  }

  // --- Formulario: solicitar una pieza que no está en el catálogo ---
  if (pathname === '/api/part-requests' && req.method === 'POST') {
    if (spam.isRateLimited(req, 'part-requests')) return sendJSON(res, 429, { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' });
    const { fields, files } = await readFields(req);
    if (spam.isHoneypotTripped(fields)) return sendJSON(res, 200, { ok: true });

    const errors = [];
    const name = sanitizeString(fields.name, 120);
    const phone = sanitizeString(fields.phone, 40);
    const brand = sanitizeString(fields.brand, 60);
    const model = sanitizeString(fields.model, 60);
    const year = sanitizeString(fields.year, 20);
    const partName = sanitizeString(fields.partName, 150);
    const comment = sanitizeString(fields.comment, 1000);
    if (!name) errors.push('El nombre es obligatorio.');
    if (!phone) errors.push('El teléfono o WhatsApp es obligatorio.');
    if (!partName) errors.push('Cuéntanos el nombre de la pieza que buscas.');
    if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });

    const partPhoto = handleImageUpload(files, 'partPhoto');
    const vehiclePhoto = handleImageUpload(files, 'vehiclePhoto');

    const request = {
      id: crypto.randomUUID(), name, phone, brand, model, year, partName, comment,
      partPhoto: partPhoto || '', vehiclePhoto: vehiclePhoto || '',
      status: 'pendiente', createdAt: new Date().toISOString()
    };
    genericCreate(store.getPartRequests, store.savePartRequests, request);
    return sendJSON(res, 201, { ok: true, id: request.id });
  }

  // ============================================================
  // Rutas de administración (todas requieren sesión)
  // ============================================================
  if (pathname.startsWith('/api/admin/')) {
    if (!auth.isAuthenticated(req)) return sendJSON(res, 401, { error: 'No autorizado' });

    // --- Productos ---
    if (pathname === '/api/admin/products' && req.method === 'GET') {
      const list = store.getProducts().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJSON(res, 200, list);
    }
    if (pathname === '/api/admin/products' && req.method === 'POST') {
      const { fields, files } = await readFields(req);
      const { errors, value } = validateProductInput(fields);
      if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });
      const uploaded = handleImageUpload(files, 'image');
      const product = {
        id: crypto.randomUUID(), brand: value.brand, model: value.model, category: value.category,
        name: value.name, sku: value.sku, price: value.price, stock: value.stock, currency: 'USD', description: value.description,
        image: uploaded || value.imageUrl || '', available: value.available !== false, inStock: value.inStock !== false,
        createdAt: new Date().toISOString()
      };
      genericCreate(store.getProducts, store.saveProducts, product);
      return sendJSON(res, 201, product);
    }
    const productEditMatch = pathname.match(/^\/api\/admin\/products\/([\w-]+)$/);
    if (productEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = productEditMatch[1];
      const list = store.getProducts();
      const existing = list.find((p) => p.id === id);
      if (!existing) return sendJSON(res, 404, { error: 'Pieza no encontrada' });

      if (req.method === 'DELETE') {
        genericDelete(store.getProducts, store.saveProducts, id);
        deleteUpload(existing.image);
        return sendJSON(res, 200, { ok: true });
      }

      const { fields, files } = await readFields(req);
      const { errors, value } = validateProductInput(fields);
      if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });
      const uploaded = handleImageUpload(files, 'image');
      let image = existing.image;
      if (uploaded) { deleteUpload(existing.image); image = uploaded; }
      else if (value.imageUrl) { image = value.imageUrl; }

      const patch = {
        brand: value.brand, model: value.model, category: value.category, name: value.name, sku: value.sku,
        price: value.price, stock: value.stock, description: value.description, available: value.available !== false,
        inStock: value.inStock !== false, image
      };
      const updated = genericUpdate(store.getProducts, store.saveProducts, id, patch);
      return sendJSON(res, 200, updated);
    }

    // --- Categorías ---
    if (pathname === '/api/admin/categories' && req.method === 'GET') return sendJSON(res, 200, store.getCategories());
    if (pathname === '/api/admin/categories' && req.method === 'POST') {
      const { fields } = await readFields(req);
      const name = sanitizeString(fields.name, 60);
      const icon = sanitizeString(fields.icon, 10) || '🔧';
      if (!name) return sendJSON(res, 400, { error: 'El nombre de la categoría es obligatorio.' });
      const slug = slugify(fields.slug || name);
      const list = store.getCategories();
      if (list.some((c) => c.slug === slug)) return sendJSON(res, 400, { error: 'Ya existe una categoría con ese nombre.' });
      const category = { slug, name, icon };
      list.push(category);
      store.saveCategories(list);
      return sendJSON(res, 201, category);
    }
    const categoryEditMatch = pathname.match(/^\/api\/admin\/categories\/([\w-]+)$/);
    if (categoryEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const slug = categoryEditMatch[1];
      let list = store.getCategories();
      const idx = list.findIndex((c) => c.slug === slug);
      if (idx === -1) return sendJSON(res, 404, { error: 'Categoría no encontrada' });
      if (req.method === 'DELETE') {
        const inUse = store.getProducts().some((p) => p.category === slug);
        if (inUse) return sendJSON(res, 400, { error: 'No puedes borrar una categoría que tiene piezas asignadas. Reasígnalas primero.' });
        list.splice(idx, 1);
        store.saveCategories(list);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields } = await readFields(req);
      list[idx] = { slug, name: sanitizeString(fields.name, 60) || list[idx].name, icon: sanitizeString(fields.icon, 10) || list[idx].icon };
      store.saveCategories(list);
      return sendJSON(res, 200, list[idx]);
    }

    // --- Marcas y modelos ---
    if (pathname === '/api/admin/brands' && req.method === 'GET') return sendJSON(res, 200, store.getBrands());
    if (pathname === '/api/admin/brands' && req.method === 'POST') {
      const { fields } = await readFields(req);
      const name = sanitizeString(fields.name, 60);
      if (!name) return sendJSON(res, 400, { error: 'El nombre de la marca es obligatorio.' });
      const slug = slugify(fields.slug || name);
      const list = store.getBrands();
      if (list.some((b) => b.slug === slug)) return sendJSON(res, 400, { error: 'Ya existe una marca con ese nombre.' });
      const brand = { slug, name, models: [] };
      list.push(brand);
      store.saveBrands(list);
      return sendJSON(res, 201, brand);
    }
    const brandEditMatch = pathname.match(/^\/api\/admin\/brands\/([\w-]+)$/);
    if (brandEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const slug = brandEditMatch[1];
      let list = store.getBrands();
      const idx = list.findIndex((b) => b.slug === slug);
      if (idx === -1) return sendJSON(res, 404, { error: 'Marca no encontrada' });
      if (req.method === 'DELETE') {
        const inUse = store.getProducts().some((p) => p.brand === slug);
        if (inUse) return sendJSON(res, 400, { error: 'No puedes borrar una marca que tiene piezas asignadas. Reasígnalas primero.' });
        list.splice(idx, 1);
        store.saveBrands(list);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields } = await readFields(req);
      if (fields.name) list[idx].name = sanitizeString(fields.name, 60);
      store.saveBrands(list);
      return sendJSON(res, 200, list[idx]);
    }
    // Modelos dentro de una marca
    const modelListMatch = pathname.match(/^\/api\/admin\/brands\/([\w-]+)\/models$/);
    if (modelListMatch && req.method === 'POST') {
      const brandSlug = modelListMatch[1];
      const list = store.getBrands();
      const brand = list.find((b) => b.slug === brandSlug);
      if (!brand) return sendJSON(res, 404, { error: 'Marca no encontrada' });
      const { fields } = await readFields(req);
      const name = sanitizeString(fields.name, 60);
      if (!name) return sendJSON(res, 400, { error: 'El nombre del modelo es obligatorio.' });
      const modelSlug = slugify(name);
      if (brand.models.some((m) => m.slug === modelSlug)) return sendJSON(res, 400, { error: 'Ese modelo ya existe en esta marca.' });
      brand.models.push({ slug: modelSlug, name });
      store.saveBrands(list);
      return sendJSON(res, 201, brand);
    }
    const modelEditMatch = pathname.match(/^\/api\/admin\/brands\/([\w-]+)\/models\/([\w-]+)$/);
    if (modelEditMatch && req.method === 'DELETE') {
      const [, brandSlug, modelSlug] = modelEditMatch;
      const list = store.getBrands();
      const brand = list.find((b) => b.slug === brandSlug);
      if (!brand) return sendJSON(res, 404, { error: 'Marca no encontrada' });
      const inUse = store.getProducts().some((p) => p.brand === brandSlug && p.model === modelSlug);
      if (inUse) return sendJSON(res, 400, { error: 'No puedes borrar un modelo que tiene piezas asignadas. Reasígnalas primero.' });
      brand.models = brand.models.filter((m) => m.slug !== modelSlug);
      store.saveBrands(list);
      return sendJSON(res, 200, brand);
    }

    // --- Testimonios ---
    if (pathname === '/api/admin/testimonials' && req.method === 'GET') return sendJSON(res, 200, store.getTestimonials());
    if (pathname === '/api/admin/testimonials' && req.method === 'POST') {
      const { fields, files } = await readFields(req);
      const name = sanitizeString(fields.name, 100);
      const comment = sanitizeString(fields.comment, 600);
      if (!name || !comment) return sendJSON(res, 400, { error: 'El nombre y el comentario son obligatorios.' });
      const rating = Math.min(5, Math.max(1, Number(fields.rating) || 5));
      const photo = handleImageUpload(files, 'photo') || sanitizeString(fields.photoUrl, 500);
      const testimonial = { id: crypto.randomUUID(), name, comment, rating, photo, published: fields.published !== 'false', createdAt: new Date().toISOString() };
      genericCreate(store.getTestimonials, store.saveTestimonials, testimonial);
      return sendJSON(res, 201, testimonial);
    }
    const testimonialEditMatch = pathname.match(/^\/api\/admin\/testimonials\/([\w-]+)$/);
    if (testimonialEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = testimonialEditMatch[1];
      if (req.method === 'DELETE') {
        const removed = genericDelete(store.getTestimonials, store.saveTestimonials, id);
        if (!removed) return sendJSON(res, 404, { error: 'No encontrado' });
        deleteUpload(removed.photo);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields, files } = await readFields(req);
      const patch = {
        name: sanitizeString(fields.name, 100),
        comment: sanitizeString(fields.comment, 600),
        rating: Math.min(5, Math.max(1, Number(fields.rating) || 5)),
        published: fields.published !== 'false'
      };
      const uploaded = handleImageUpload(files, 'photo');
      if (uploaded) patch.photo = uploaded;
      else if (fields.photoUrl) patch.photo = sanitizeString(fields.photoUrl, 500);
      const updated = genericUpdate(store.getTestimonials, store.saveTestimonials, id, patch);
      if (!updated) return sendJSON(res, 404, { error: 'No encontrado' });
      return sendJSON(res, 200, updated);
    }

    // --- Blog ---
    if (pathname === '/api/admin/posts' && req.method === 'GET') return sendJSON(res, 200, store.getPosts());
    if (pathname === '/api/admin/posts' && req.method === 'POST') {
      const { fields, files } = await readFields(req);
      const title = sanitizeString(fields.title, 150);
      const content = sanitizeString(fields.content, 20000);
      if (!title || !content) return sendJSON(res, 400, { error: 'El título y el contenido son obligatorios.' });
      let slug = slugify(fields.slug || title);
      const existing = store.getPosts();
      let uniqueSlug = slug, n = 2;
      while (existing.some((p) => p.slug === uniqueSlug)) { uniqueSlug = `${slug}-${n++}`; }
      const uploaded = handleImageUpload(files, 'image');
      const post = {
        id: crypto.randomUUID(), slug: uniqueSlug, title,
        excerpt: sanitizeString(fields.excerpt, 300),
        metaDescription: sanitizeString(fields.metaDescription, 160),
        content, image: uploaded || sanitizeString(fields.imageUrl, 500),
        published: fields.published !== 'false', createdAt: new Date().toISOString()
      };
      genericCreate(store.getPosts, store.savePosts, post);
      return sendJSON(res, 201, post);
    }
    const postEditMatch = pathname.match(/^\/api\/admin\/posts\/([\w-]+)$/);
    if (postEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = postEditMatch[1];
      if (req.method === 'DELETE') {
        const removed = genericDelete(store.getPosts, store.savePosts, id);
        if (!removed) return sendJSON(res, 404, { error: 'No encontrado' });
        deleteUpload(removed.image);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields, files } = await readFields(req);
      const patch = {
        title: sanitizeString(fields.title, 150),
        excerpt: sanitizeString(fields.excerpt, 300),
        metaDescription: sanitizeString(fields.metaDescription, 160),
        content: sanitizeString(fields.content, 20000),
        published: fields.published !== 'false'
      };
      const uploaded = handleImageUpload(files, 'image');
      if (uploaded) patch.image = uploaded;
      else if (fields.imageUrl) patch.image = sanitizeString(fields.imageUrl, 500);
      const updated = genericUpdate(store.getPosts, store.savePosts, id, patch);
      if (!updated) return sendJSON(res, 404, { error: 'No encontrado' });
      return sendJSON(res, 200, updated);
    }

    // --- Secciones de publicaciones ---
    if (pathname === '/api/admin/pub-sections' && req.method === 'GET') return sendJSON(res, 200, store.getPubSections());
    if (pathname === '/api/admin/pub-sections' && req.method === 'POST') {
      const { fields } = await readFields(req);
      const name = sanitizeString(fields.name, 60);
      const icon = sanitizeString(fields.icon, 10) || '📌';
      if (!name) return sendJSON(res, 400, { error: 'El nombre de la sección es obligatorio.' });
      const slug = slugify(fields.slug || name);
      const list = store.getPubSections();
      if (list.some((s) => s.slug === slug)) return sendJSON(res, 400, { error: 'Ya existe una sección con ese nombre.' });
      const section = { slug, name, icon };
      list.push(section);
      store.savePubSections(list);
      return sendJSON(res, 201, section);
    }
    const pubSectionEditMatch = pathname.match(/^\/api\/admin\/pub-sections\/([\w-]+)$/);
    if (pubSectionEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const slug = pubSectionEditMatch[1];
      let list = store.getPubSections();
      const idx = list.findIndex((s) => s.slug === slug);
      if (idx === -1) return sendJSON(res, 404, { error: 'Sección no encontrada' });
      if (req.method === 'DELETE') {
        const inUse = store.getPublications().some((p) => p.section === slug);
        if (inUse) return sendJSON(res, 400, { error: 'No puedes borrar una sección que tiene publicaciones asignadas. Reasígnalas primero.' });
        list.splice(idx, 1);
        store.savePubSections(list);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields } = await readFields(req);
      list[idx] = { slug, name: sanitizeString(fields.name, 60) || list[idx].name, icon: sanitizeString(fields.icon, 10) || list[idx].icon };
      store.savePubSections(list);
      return sendJSON(res, 200, list[idx]);
    }

    // --- Publicaciones (feed de novedades) ---
    if (pathname === '/api/admin/publications' && req.method === 'GET') {
      return sendJSON(res, 200, store.getPublications().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    }
    if (pathname === '/api/admin/publications' && req.method === 'POST') {
      const { fields, files } = await readFields(req);
      const title = sanitizeString(fields.title, 150);
      const summary = sanitizeString(fields.summary, 300);
      const section = sanitizeString(fields.section, 60);
      if (!title) return sendJSON(res, 400, { error: 'El título es obligatorio.' });
      if (!store.getPubSections().some((s) => s.slug === section)) return sendJSON(res, 400, { error: 'La sección no es válida.' });
      let slug = slugify(fields.slug || title);
      const existing = store.getPublications();
      let uniqueSlug = slug, n = 2;
      while (existing.some((p) => p.slug === uniqueSlug)) { uniqueSlug = `${slug}-${n++}`; }
      const uploaded = handleImageUpload(files, 'image');
      const publication = {
        id: crypto.randomUUID(), slug: uniqueSlug, title, summary, section,
        content: sanitizeString(fields.content, 5000),
        image: uploaded || sanitizeString(fields.imageUrl, 500),
        published: fields.published !== 'false', createdAt: new Date().toISOString()
      };
      genericCreate(store.getPublications, store.savePublications, publication);
      return sendJSON(res, 201, publication);
    }
    const pubEditMatch = pathname.match(/^\/api\/admin\/publications\/([\w-]+)$/);
    if (pubEditMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = pubEditMatch[1];
      if (req.method === 'DELETE') {
        const removed = genericDelete(store.getPublications, store.savePublications, id);
        if (!removed) return sendJSON(res, 404, { error: 'No encontrado' });
        deleteUpload(removed.image);
        return sendJSON(res, 200, { ok: true });
      }
      const { fields, files } = await readFields(req);
      const section = sanitizeString(fields.section, 60);
      if (section && !store.getPubSections().some((s) => s.slug === section)) {
        return sendJSON(res, 400, { error: 'La sección no es válida.' });
      }
      const patch = {
        title: sanitizeString(fields.title, 150),
        summary: sanitizeString(fields.summary, 300),
        section,
        content: sanitizeString(fields.content, 5000),
        published: fields.published !== 'false'
      };
      const uploaded = handleImageUpload(files, 'image');
      if (uploaded) patch.image = uploaded;
      else if (fields.imageUrl) patch.image = sanitizeString(fields.imageUrl, 500);
      const updated = genericUpdate(store.getPublications, store.savePublications, id, patch);
      if (!updated) return sendJSON(res, 404, { error: 'No encontrado' });
      return sendJSON(res, 200, updated);
    }

    // --- Citas del taller ---
    if (pathname === '/api/admin/appointments' && req.method === 'GET') {
      return sendJSON(res, 200, store.getAppointments().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    }
    const apptMatch = pathname.match(/^\/api\/admin\/appointments\/([\w-]+)$/);
    if (apptMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = apptMatch[1];
      if (req.method === 'DELETE') {
        const removed = genericDelete(store.getAppointments, store.saveAppointments, id);
        return removed ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'No encontrado' });
      }
      const { fields } = await readFields(req);
      const updated = genericUpdate(store.getAppointments, store.saveAppointments, id, { status: sanitizeString(fields.status, 30) });
      return updated ? sendJSON(res, 200, updated) : sendJSON(res, 404, { error: 'No encontrado' });
    }

    // --- Solicitudes de piezas ---
    if (pathname === '/api/admin/part-requests' && req.method === 'GET') {
      return sendJSON(res, 200, store.getPartRequests().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    }
    const reqMatch = pathname.match(/^\/api\/admin\/part-requests\/([\w-]+)$/);
    if (reqMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = reqMatch[1];
      if (req.method === 'DELETE') {
        const removed = genericDelete(store.getPartRequests, store.savePartRequests, id);
        if (removed) { deleteUpload(removed.partPhoto); deleteUpload(removed.vehiclePhoto); }
        return removed ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'No encontrado' });
      }
      const { fields } = await readFields(req);
      const updated = genericUpdate(store.getPartRequests, store.savePartRequests, id, { status: sanitizeString(fields.status, 30) });
      return updated ? sendJSON(res, 200, updated) : sendJSON(res, 404, { error: 'No encontrado' });
    }

    // --- Respaldo COMPLETO: todo el negocio en un solo archivo ---
    // Pensado para descargarlo cada cierto tiempo y guardarlo aparte. Con
    // este archivo se puede reconstruir el contenido del sitio entero.
    if (pathname === '/api/admin/export/all' && req.method === 'GET') {
      const backup = {
        respaldoDe: 'Soluciones Jorge',
        fecha: new Date().toISOString(),
        productos: store.getProducts(),
        marcas: store.getBrands(),
        categorias: store.getCategories(),
        publicaciones: store.getPublications(),
        seccionesPublicaciones: store.getPubSections(),
        testimonios: store.getTestimonials(),
        blog: store.getPosts(),
        citas: store.getAppointments(),
        solicitudes: store.getPartRequests()
      };
      return send(res, 200, JSON.stringify(backup, null, 2), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="respaldo-completo-soluciones-jorge-${new Date().toISOString().slice(0, 10)}.json"`
      });
    }

    // --- Exportar / respaldo ---
    const exportMatch = pathname.match(/^\/api\/admin\/export\/(products|testimonials|posts|appointments|part-requests|categories|brands|publications|pub-sections)$/);
    if (exportMatch && req.method === 'GET') {
      const map = {
        products: store.getProducts, testimonials: store.getTestimonials, posts: store.getPosts,
        appointments: store.getAppointments, 'part-requests': store.getPartRequests,
        categories: store.getCategories, brands: store.getBrands,
        publications: store.getPublications, 'pub-sections': store.getPubSections
      };
      const data = map[exportMatch[1]]();
      return send(res, 200, JSON.stringify(data, null, 2), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportMatch[1]}-${new Date().toISOString().slice(0, 10)}.json"`
      });
    }
  }

  return sendJSON(res, 404, { error: 'Ruta de API no encontrada' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
      return;
    }

    // Atajo cómodo: escribir "/admin" lleva al panel (o al login si no hay
    // sesión abierta). Antes esta dirección daba un 404 confuso.
    if (pathname === '/admin' || pathname === '/admin/') {
      const destino = auth.isAuthenticated(req) ? '/admin/index.html' : '/admin/login.html';
      return send(res, 302, '', { Location: destino });
    }

    if (pathname === '/sitemap.xml') {
      return send(res, 200, buildSitemap(), { 'Content-Type': 'application/xml; charset=utf-8' });
    }
    if (pathname === '/robots.txt') {
      const base = SITE_URL || 'https://tu-dominio-aqui.com';
      return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ${base}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (pathname === '/blog' || pathname === '/blog/') {
      return send(res, 200, renderBlogIndex(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    const blogPostMatch = pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
    if (blogPostMatch) {
      const html = renderBlogPost(blogPostMatch[1]);
      if (!html) return send(res, 404, notFoundPage(), { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    sendJSON(res, status, { error: err.message || 'Error interno del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`Soluciones Jorge escuchando en http://localhost:${PORT}`);
  if (!store.getAdmin()) {
    console.log('⚠️  No hay administrador configurado todavía.');
    console.log('   Ejecuta: node scripts/set-admin-password.js  para crear el usuario "jorge" y su contraseña del panel /admin');
  }
});
