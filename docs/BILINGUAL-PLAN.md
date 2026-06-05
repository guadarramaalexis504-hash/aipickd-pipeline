# AIPickd — Plan Bilingüe (Español primero → Inglés después)

Decisión del usuario (2026-06-04): **Español primero** (impresiones rápidas en
Latam/México, menos competencia, ángulo "probé X y esta ganó") → **Inglés después**
(dinero afiliado SaaS en USD). Estructura: **Polylang** con inglés default en la
RAÍZ (los 121 existentes NO se mueven) + español en `/es/` + hreflang automático.
NO mezclar idiomas en una URL.

## Fases (ordenado, una a la vez)

### Fase 1 — Cimientos Polylang  🏗️ (producción WP)
- Instalar Polylang (plugin gratis).
- Idiomas: **English = default, sin prefijo** (raíz, los 121 quedan igual);
  **Español = `es`, con prefijo `/es/`**.
- Asignar los 121 posts existentes a English.
- hreflang lo emite Polylang automático.
- Ejecución: guiado en vivo (usuario clica, Claude dirige vía MCP) — el CDP
  resultó inestable pa' automatizar un cambio estructural de producción.

### Fase 2 — Pipeline bilingüe  ⚙️ (Claude, autónomo)
- Columna `language` ('en'/'es') en `keywords` + `articles` (Supabase).
- Generación: si `keyword.language='es'` → outline + draft + título + meta + FAQ
  + Quick Verdict, TODO en español, con el ángulo "probé/comparé X y esta ganó".
- Rutear el post nuevo al idioma `es` en Polylang (REST: `?lang=es` o el meta de
  Polylang) y slug en español.
- Títulos español con gancho (no "Mejores IA 2026"): "Probé 7 IAs para crear
  videos: solo 2 valen la pena", "Le pedí a 5 IAs una presentación: esta ganó".

### Fase 3 — Primeros 20 en español  ✍️
Lista prioritaria del usuario (sembrar + generar):
1. Mejor IA para crear videos: probé 7 y esta ganó
2. Mejor IA para hacer presentaciones: Gamma vs Canva vs PowerPoint
3. Mejor IA para hacer tareas sin copiar mal
4. ChatGPT vs Claude vs Gemini: cuál conviene para estudiar
5. Mejor IA para crear imágenes: DALL-E vs Midjourney vs Firefly
6. Mejor IA gratis para hacer videos: cuáles sí sirven
7. Mejor IA para hacer logos para negocios pequeños
8. Mejor IA para hacer un CV profesional
9. Mejor IA para thumbnails de YouTube
10. IA gratis vs IA de pago: cuándo sí vale pagar
(+ expandir a 20 con: mejor IA para resúmenes, para matemáticas, para Excel,
para traducir, para community managers, etc.)

### Fase 4 — Traducir ganadores a inglés  🌎 (después, por datos GSC)
Cuando un artículo ES muestre clics/CTR/buen tiempo en página/potencial afiliado
→ generar su gemelo EN en `/en/` + enlazarlos como traducción (Polylang) → hreflang.

## Timeline del usuario
- Mes 1-2: español (México/Latam). Mes 3: duplicar ganadores a inglés.
  Mes 4+: bilingüe completo `/es/` + `/en/`.

## Eslogan ES: "AIpickd: probamos las IAs por ti y elegimos la que sí sirve."
