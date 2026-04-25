# ⚡ Setup Cloudflare CDN (15 min)

**Por qué:** Cloudflare hace tu site **3-5x más rápido**, agrega HTTPS extra, y protege de ataques DDoS.

**Costo:** $0 (plan free funciona perfecto pa' sites como el tuyo)

**Beneficios SEO:**
- Google rankea mejor sites rápidos (Core Web Vitals)
- Menor bounce rate (gente no se va por lento)
- Mejor experiencia mobile

---

## 📋 Pasos

### 1. Crea cuenta Cloudflare
- https://dash.cloudflare.com/sign-up
- Usa tu email de Gmail
- Email confirmación → verifica

### 2. Agrega tu dominio

1. Dashboard → **"Add a site"**
2. Escribe: `aipickd.com`
3. Selecciona plan **"Free"** (abajo, 0 USD)
4. Click Continue

### 3. Cloudflare escanea DNS

Automático. Espera 30 seg. Te muestra los DNS records actuales (A records, CNAME de Hostinger, etc.).

**Verifica que estén:**
- `aipickd.com` → A record → IP de Hostinger
- `www.aipickd.com` → CNAME → aipickd.com

Si faltan, los agregas con el botón "+ Add record".

### 4. Cambiar nameservers en Namecheap

Esta es la parte "escalofriante" pero es fácil:

1. Cloudflare te da 2 nameservers tipo:
   - `paul.ns.cloudflare.com`
   - `lia.ns.cloudflare.com`

2. Copia esos 2 strings.

3. Abre Namecheap: https://ap.www.namecheap.com/Domains/DomainControlPanel/aipickd.com/domain

4. En "Nameservers" dropdown → selecciona **"Custom DNS"**

5. Borra los nameservers de Namecheap → pega los 2 de Cloudflare → **Save** ✅

### 5. Espera propagación

Cloudflare detecta el cambio en **5 min - 24 horas** (usualmente 1-2 horas).

Cuando pase, tu sitio Hostinger sigue funcionando IGUAL, pero **ahora pasa por Cloudflare antes** → 3-5x más rápido.

### 6. Configuración optimizada (una vez activado)

En Cloudflare Dashboard para aipickd.com:

#### Speed → Optimization
- ✅ Auto Minify: JavaScript, CSS, HTML (todos ON)
- ✅ Brotli: ON
- ✅ Early Hints: ON
- ✅ Rocket Loader: ON

#### Caching → Configuration
- **Caching Level:** Standard
- **Browser Cache TTL:** 4 hours
- ✅ Always Online: ON

#### SSL/TLS
- **Encryption mode:** Full (strict)
- ✅ Always Use HTTPS: ON
- ✅ Automatic HTTPS Rewrites: ON

#### Security → WAF
- **Security Level:** Medium
- ✅ Bot Fight Mode: ON (free, protege de scrapers)

#### Network
- ✅ HTTP/3 (with QUIC): ON

---

## 🎁 Bonus gratis que te da Cloudflare

### a) Page Rules (hasta 3 gratis)
Crea esta regla útil:
- Si URL = `https://www.aipickd.com/*` → Forwarding URL 301 → `https://aipickd.com/$1`
- Esto unifica www y non-www

### b) Workers (opcional, avanzado)
100k requests/día gratis. Podríamos usar pa' A/B testing, redirects de afiliados, etc.

### c) Analytics gratis
Cloudflare → Analytics → te muestra tráfico, países, device types, requests blocked.

---

## 🚨 Troubleshooting

**Si tu site no abre después de cambiar nameservers:**
- Espera 2 horas más (DNS propagation)
- Verifica que los nameservers de Cloudflare estén bien escritos en Namecheap
- Si sigue sin abrir después de 24h → me avisas y debuggeamos

**Si aparece error "525 Handshake failed":**
- Cloudflare Dashboard → SSL/TLS → cambia de "Full (strict)" a "Flexible" temporalmente
- Hostinger tiene SSL automático, debería funcionar en Full

---

## ⏱️ Timeline real

- **Minuto 0-10:** Setup en Cloudflare
- **Minuto 10-12:** Cambio nameservers en Namecheap
- **Hora 1-2:** Propagación DNS (tu sitio sigue vivo todo el tiempo)
- **Hora 2+:** Site notablemente más rápido (velocidad de carga de 3 seg → 800ms)

---

**Cuando quieras hacerlo, mándame screenshot de cada paso y te voy guiando.** 👊

Total: 15 min tuyos + 1-2h de espera pasiva.
