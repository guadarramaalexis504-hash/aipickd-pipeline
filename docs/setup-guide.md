# 🛠️ Guía de Setup — LEE ESTO PRIMERO MANITO

Estas son las **únicas tareas que tú debes hacer**. El resto lo hago yo (Claude).
Síguelas en orden. Inversión total: **~$60-$120 USD el primer mes**, luego ~$30-50/mes.

---

## ✅ Tarea 1: Comprar el dominio (~$12/año)

**Dónde:** [Namecheap](https://namecheap.com) o [Porkbun](https://porkbun.com) (más barato)

**Dominios sugeridos (elige 1 o propón el tuyo):**
1. `aipickd.com` (mi favorito — claro, moderno)
2. `airevi.com` (corto, memorable)
3. `aistacked.com`
4. `toolsofai.co`
5. `smartaipicks.com`

⚠️ **Evita:** guiones, números, palabras mal escritas. Google odia eso.

**Tu acción:** Compra el dominio y mándame el nombre por acá. Yo configuro el resto.

---

## ✅ Tarea 2: Contratar hosting WordPress (~$3-10/mes)

**Recomendación:** [Hostinger Premium WordPress](https://hostinger.com) (~$3/mes primer año)
- Ventaja extra: **tú mismo te puedes afiliar de Hostinger** → $65/venta 🎁

**Alternativas:**
- SiteGround ($5/mes) — mejor soporte
- Cloudways ($11/mes) — más rápido, escalable

**Qué incluir al contratar:**
- Plan con **al menos 100GB SSD**
- **SSL gratis** (Let's Encrypt, viene incluido)
- **Email profesional** (1-5 cuentas, ej: `hola@tudominio.com`)

**Tu acción:**
1. Contrata el hosting
2. Instala WordPress desde el panel (1 click usualmente)
3. Mándame las credenciales del admin WP (usuario + contraseña)

---

## ✅ Tarea 3: Crear cuenta Supabase (GRATIS)

**URL:** https://supabase.com/dashboard

**Pasos:**
1. Sign up con tu Google
2. Crea un proyecto nuevo → nombre: `aitoolshub`
3. Elige región cerca de Mexico (`us-west-1` o `us-east-1`)
4. Guarda tu **contraseña de DB** (la pide al crear)
5. Ve a **Settings → API** y copia:
   - `URL` (ej: `https://xxxx.supabase.co`)
   - `anon public key`
   - `service_role key` (cuidado, no la publiques)

**Tu acción:** Mándame los 3 valores de arriba (URL + 2 keys).

---

## ✅ Tarea 4: Conseguir API keys de IAs

### Claude (Anthropic)
1. Ve a https://console.anthropic.com
2. Agrega $20 USD de crédito inicial
3. Crea una API key → cópiala (formato: `sk-ant-api03-...`)

### OpenAI (GPT)
1. Ve a https://platform.openai.com/api-keys
2. Agrega $10 USD de crédito
3. Crea API key → cópiala (formato: `sk-proj-...`)

**Costo estimado:** $20-50 USD/mes al principio (escala cuando crezca el tráfico).

**Tu acción:** Mándame ambas API keys.

---

## ✅ Tarea 5: Dar de alta en programas de afiliados

Estos puedes hacerlos en paralelo, toma ~30 min total.

### 🥇 PRIORIDAD 1 (hazlos YA)

| Programa | URL | Qué esperar |
|----------|-----|-------------|
| **Impact** | impact.com/creators | Marketplace con Jasper, ClickUp, Semrush, etc. Aprobación 1-3 días. |
| **PartnerStack** | partnerstack.com | Notion, Monday, Make.com, otros SaaS. Aprobación 1-2 días. |
| **Amazon Associates** | affiliate-program.amazon.com | Libros IA, hardware. Aprobación inmediata (necesitas vender 3 items en 6 meses o cierran cuenta). |
| **Hostinger Affiliate** | hostinger.com/affiliates | Comisiones $65-$150/venta. Aprobación 1-2 días. |

### 🥈 PRIORIDAD 2 (cuando tengas el sitio arriba)

- **Jasper Direct** — si Impact rechaza
- **Copy.ai Partners**
- **Writesonic Affiliate**
- **ShareASale** — otro marketplace grande

**Tu acción:** Date de alta en los 4 de Prioridad 1 usando:
- Nombre del sitio: `AIPickd` (o el que elijas)
- URL: tu dominio (aunque aún no tenga contenido)
- Descripción: *"Blog that reviews AI tools and SaaS products, helping users choose the right tools for their workflows. We publish comparisons, deep reviews, and tutorials."*

Cuando te aprueben, mándame el ID de afiliado de cada uno (lo pongo en el sistema).

---

## ✅ Tarea 6: Levantar n8n (GRATIS self-hosted o $20/mes cloud)

### Opción A: Self-hosted en tu PC (GRATIS)
**Requiere:** Docker Desktop instalado.

```bash
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

Abre http://localhost:5678 → crea cuenta → listo.

**Pega:** tu PC debe estar prendida pa' que corra. No ideal.

### Opción B: Railway / Render (~$5-10/mes) ⭐ RECOMENDADO
1. Crea cuenta en [Railway](https://railway.app)
2. New Project → Deploy Template → busca "n8n"
3. Configura variables y deploy
4. Te da una URL tipo `n8n-prod.up.railway.app`

### Opción C: n8n Cloud ($20/mes)
Más fácil, pero más caro. Ve a [n8n.io](https://n8n.io/cloud).

**Tu acción:** Elige una opción. Si dudas, te recomiendo **Railway** — $5/mes, siempre prendido, sin líos.

Cuando lo tengas, mándame la URL de tu n8n y te guío a importar los workflows.

---

## ✅ Tarea 7 (OPCIONAL — mes 2): DataForSEO API

Pa' keyword research automatizado. Cuesta ~$10-30/mes según uso.

**URL:** https://dataforseo.com

Puedes empezar sin esto — yo puedo generar keywords con Claude basado en conocimiento.
Pero cuando crezcas, esto te da keywords exactas con volumen y competencia real.

---

## 📋 Checklist final de lo que me tienes que mandar

Cuando termines, mándame en un solo mensaje:

```
✅ Dominio: _______________
✅ WP admin URL: _______________
✅ WP usuario: _______________
✅ WP contraseña: _______________
✅ Supabase URL: _______________
✅ Supabase anon key: _______________
✅ Supabase service key: _______________
✅ Claude API key: _______________
✅ OpenAI API key: _______________
✅ n8n URL: _______________
✅ n8n usuario/contraseña: _______________
✅ Affiliate IDs (Impact, PartnerStack, Amazon, Hostinger): _______________
```

⚠️ **SEGURIDAD:** Estos datos son sensibles. Mándamelos y yo los guardo en `.env` local (encriptado). **Nunca los subas a GitHub ni a ningún lado público.**

---

## ⏱️ Tiempo estimado que te toma todo esto

- Tarea 1 (dominio): 10 min
- Tarea 2 (hosting + WP): 30 min
- Tarea 3 (Supabase): 10 min
- Tarea 4 (APIs): 15 min
- Tarea 5 (afiliados): 30 min (+ 1-3 días espera aprobación)
- Tarea 6 (n8n): 15-30 min

**Total tiempo activo tuyo: ~2 horas. El resto lo hago yo, manito 😎.**
