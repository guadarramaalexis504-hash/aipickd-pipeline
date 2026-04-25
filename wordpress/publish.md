# 🌐 Configuración de WordPress

Guía paso a paso pa' dejar WP listo pa' recibir contenido automatizado.

---

## 1. Instalación inicial

Tu hosting (Hostinger/SiteGround/etc.) tiene "one-click WordPress install". Úsalo.

Al terminar tendrás:
- **URL admin:** `https://tudominio.com/wp-admin`
- **Usuario admin** (elige uno NO-obvio, no "admin")
- **Contraseña fuerte**

## 2. Tema recomendado

**GeneratePress** (gratis) o **Kadence** (gratis) — ambos súper rápidos y SEO-friendly.

```
WP Admin → Appearance → Themes → Add New → buscar "GeneratePress" → Install → Activate
```

**Evita:** Astra (ya muy saturado), Divi (lento).

## 3. Plugins esenciales (TODOS GRATIS)

| Plugin | Pa' qué sirve |
|--------|---------------|
| **Yoast SEO** o **Rank Math** | SEO on-page |
| **WP Super Cache** | Velocidad |
| **WP-Optimize** | Limpieza DB |
| **Thirsty Affiliates** | Gestión links afiliados (pretty URLs) |
| **WPCode** (antes Insert Headers/Footers) | Inyectar Google Analytics |
| **WP Reset** | Por si necesitas reset en dev |

**Instalar:** WP Admin → Plugins → Add New → buscar → Install → Activate cada uno.

## 4. Estructura de permalinks (CRÍTICO pa' SEO)

```
WP Admin → Settings → Permalinks → "Post name"
```

Tus URLs quedarán: `tudominio.com/post-slug` → ideal pa' SEO.

## 5. Application Password pa' n8n

1. WP Admin → **Users → Your Profile**
2. Scroll hasta **"Application Passwords"**
3. New Application Password Name: `n8n`
4. Click **"Add New Application Password"**
5. Copia el password de 4x4 letras que aparece (ej: `abcd 1234 efgh 5678`)
6. ⚠️ **Sólo se muestra 1 vez.** Guárdalo en tu `.env`

## 6. Páginas legales requeridas (Google las pide pa' rankear)

Crea estas páginas con WP → Pages → Add New:

- **About** → explica quién eres/qué es el sitio
- **Contact** → un email pa' contacto
- **Privacy Policy** → usa [generador gratis](https://www.privacypolicygenerator.info)
- **Terms of Service** → usa [generador gratis](https://www.termsofservicegenerator.net)
- **Affiliate Disclosure** → importante pa' FTC compliance (ejemplo abajo)

### Texto sugerido pa' Affiliate Disclosure

```
AIPickd participates in affiliate programs, which means we may earn a commission
when you click on or make purchases through links on this site. This comes at no
additional cost to you. We only recommend tools we genuinely believe provide value.
Our opinions are our own and are not influenced by affiliate relationships.
```

## 7. Categorías iniciales

WP Admin → Posts → Categories → crea estas:

- AI Writing Tools
- AI for Business
- AI Image & Video
- AI Coding Tools
- AI Infrastructure
- Reviews
- Comparisons

(El pipeline de n8n puede asignarlas automáticamente en una versión v2.)

## 8. Velocidad (Core Web Vitals)

Google premia sitios rápidos. Minimal setup:

1. **Activa WP Super Cache** (Settings → WP Super Cache → Enable caching)
2. **Cloudflare (GRATIS):**
   - Crea cuenta en cloudflare.com
   - Agrega tu dominio
   - Cambia los nameservers en Namecheap/Porkbun a los de Cloudflare
   - Activa "Auto Minify" (CSS, JS, HTML)
   - Activa "Brotli compression"
3. **Optimiza imágenes:** el plugin `Smush` (free) o `ShortPixel` (free tier 100 imgs/mes)

Meta: **LCP < 2.5s**, medido en [PageSpeed Insights](https://pagespeed.web.dev).

## 9. Google Analytics + Search Console

### Analytics
1. analytics.google.com → crear propiedad GA4
2. Copiar el tag script
3. WP Admin → WPCode → + Add Snippet → pegar en `<head>`

### Search Console
1. search.google.com/search-console → Add Property
2. Verifica con método "HTML tag" (copia tag → WPCode → `<head>`)
3. Sube sitemap: `https://tudominio.com/sitemap.xml` (lo genera Yoast/Rank Math automáticamente)

**Search Console = el único medidor real de tu SEO.** Revísalo semanal.

## 10. Webhook de publicación (opcional, avanzado)

Si quieres que WP notifique a n8n cuando publica (pa' métricas):

```php
// Agregar a functions.php de tu tema o plugin custom
add_action('publish_post', function($post_id) {
    $post = get_post($post_id);
    wp_remote_post('https://tu-n8n.com/webhook/wp-publish', [
        'body' => json_encode([
            'post_id' => $post_id,
            'url' => get_permalink($post_id),
            'title' => $post->post_title
        ]),
        'headers' => ['Content-Type' => 'application/json'],
    ]);
});
```

## ✅ Checklist final

- [ ] Hosting contratado
- [ ] WordPress instalado
- [ ] Tema (GeneratePress/Kadence) activado
- [ ] 6 plugins instalados y activados
- [ ] Permalinks en "Post name"
- [ ] Application Password generado pa' n8n
- [ ] 5 páginas legales creadas
- [ ] 7 categorías creadas
- [ ] Cloudflare activado
- [ ] Google Analytics instalado
- [ ] Google Search Console verificado

Cuando todo esté ✅, mándame confirmación y seguimos con n8n.
