# 📚 Content Bank — Artículos Pre-Generados

Este folder tiene **5 artículos completos listos pa' publicar**. Los escribí yo (Claude) mientras no estabas.

Cada uno:
- ~2000 palabras
- SEO optimizado (meta, keyword density, headers)
- Links de afiliado con placeholders `[AFFILIATE:brand]`
- Listo pa' pasar por `scripts/bulk-import-articles.sql` una vez que tengas Supabase

## Lista de artículos

| # | Keyword | Tipo | Palabras |
|---|---------|------|----------|
| 01 | Jasper vs Copy.ai vs Writesonic | comparison | ~2100 |
| 02 | Best AI Tools for Small Business Owners 2026 | listicle | ~2200 |
| 03 | Midjourney vs DALL-E 3 vs Stable Diffusion | comparison | ~2000 |
| 04 | Cursor vs GitHub Copilot 2026 | comparison | ~2000 |
| 05 | Supabase vs Firebase 2026 | comparison | ~2100 |

## Cómo cargarlos

Una vez que tengas Supabase corriendo con el schema:

```bash
# Desde tu terminal
cat scripts/bulk-import-articles.sql | pbcopy   # Mac
# o
cat scripts/bulk-import-articles.sql | clip     # Windows
```

Pega en Supabase SQL Editor → Run. Listo, los 5 artículos quedan como `status = 'draft'`.

Cuando n8n esté conectado, el workflow `03-publish-wordpress.json` los publica automáticamente en tu WP.

## Nota importante

Estos son **drafts honestos**. Antes de publicarlos, revisa:
1. Precios — los puse como "a partir de $X" pero verifica las páginas actuales de cada producto
2. Screenshots — Claude no puede generar screenshots reales; los insertamos después con Puppeteer o a mano
3. Fechas — dicen "2026" porque es el año actual; se actualizan automáticamente en el refresh de 90 días
