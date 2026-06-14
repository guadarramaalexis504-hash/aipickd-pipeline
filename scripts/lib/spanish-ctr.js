"use strict";

// Spanish high-CTR title + meta-description engineering blocks.
//
// Research-backed (Latam/Mexico SERP behaviour, Google Oct-2025 spam update) and
// judged. Injected into the outline-generation prompt ONLY for Spanish articles,
// because the English TITLE ENGINEERING block bleeds into both languages and
// makes ES titles inherit English formulas/power-words/examples. Also reusable by
// a Spanish title/meta refresh tool. ASCII-safe so it survives any encoding.

const SPANISH_TITLE_BLOCK = `INGENIERIA DE TITULOS EN ESPANOL (CTR) — el mayor multiplicador de clics. Un titulo plano = cero clics. Como este articulo es EN ESPANOL, aplica EXCLUSIVAMENTE estas reglas e IGNORA cualquier formula de titulo en ingles que aparezca en otra parte del prompt.

LONGITUD (critica para espanol):
- Apunta a 50-55 caracteres; tope duro 60. El espanol corre ~15-20% mas largo que el ingles: NUNCA llenes la linea completa.
- Google trunca por ancho de PIXEL (~475px en movil), no por caracteres, y la mayoria del trafico Latam es MOVIL. Mete el keyword + el gancho + "2026" en las primeras ~40 letras (zona visible movil). Lo que DEBE verse va a la IZQUIERDA.

ESTRUCTURA:
- Front-load: el keyword principal a la IZQUIERDA, UNA sola vez (sin keyword stuffing). El ano "2026" cierra el titulo.
- Usa un NUMERO concreto cuando aplique (impares y listas funcionan: 5, 7, 9, $0, "20 USD").
- Maximo 1-2 power words (apilar mas se lee como spam): Mejores, Gratis, Comparamos, Evaluamos, Resena honesta, Vale la pena, Cual conviene, Cuando pagar, Sin gastar de mas, Paso a paso, Desde cero.
- Abre una brecha de curiosidad o pregunta de valor real, natural en Latam: "cual conviene", "cual gana", "vale la pena", "cuando pagar", "sin gastar de mas". Las preguntas suben CTR ~14% cuando la respuesta NO es obvia.
- Estructura con dos puntos o guion: "Keyword: gancho (2026)".
- Ortografia PERFECTA con acentos (a, e, i, n) — un acento faltante baja confianza y CTR en hispanohablantes. (Solo el SLUG va sin acentos.)
- Registro Latam/Mexico: "tu" neutral, "computadora/PC", "celular". Prohibido slang de Espana ("vale", "mola", "ordenador", "movil").

PROHIBIDO — clickbait / claims falsos (penalizable por el spam-update de Google oct-2025):
- Nada de absolutos no verificables: "La #1", "La mejor del mundo", "la unica que necesitas", "que nadie te dice", "secretos que nadie revela".
- Nada de pruebas propias sin evidencia: prohibido "Probe/Probamos/Probadas/[Tested]". Usa "Evaluamos", "Comparamos", "Analizamos".
- Nada de "mas baratos" si alguna opcion cuesta igual o mas. El titulo, el H1 y la meta DEBEN coincidir con lo que el articulo entrega.

PROHIBIDO — titulos frios y cliches (se leen como spam de IA):
- Frios: "Mejores herramientas IA 2026", "Guia de X", "Todo sobre X", "Guia definitiva de X".
- Cliches: "en el mundo actual", "en la era digital", "revoluciona", "descubre el poder", "lleva tu X al siguiente nivel", "sin duda alguna".

FORMULAS GANADORAS POR TIPO (elige la mas punchy y VARIA entre articulos; cada titulo UNICO en el sitio):
- Comparativa: "[A] vs [B] vs [C]: cual conviene de verdad en 2026" | "[A] vs [B]: cual elegir sin gastar de mas (2026)" | "[A] vs [B]: cual rinde mas en su plan gratis 2026".
- Listicle: "Evaluamos [N] IAs para [tarea]: estas [M] ganan en 2026" | "[N] mejores IAs para [tarea]: solo [M] valen la pena (2026)" | "Analizamos [N] IAs para [tarea], [M] no pasaron el filtro (2026)".
- Resena: "[Marca]: rinde los [precio USD]? Resena real 2026" | "Vale los [precio USD]? Resena honesta de [Marca] 2026" | "Conviene pagar [Marca]? Resena a fondo en 2026".
- Guia/how-to: "Domina [Marca] desde cero: guia rapida 2026" | "Como usar [Marca] en [N] pasos en 2026" | "[N] pasos para configurar [Marca] bien en 2026".
- Alternativas: "Comparamos [N] alternativas a [Marca] en 2026" | "[N] alternativas a [Marca] que si valen en 2026" | "[N] alternativas a [Marca] mas economicas y con plan gratis (2026)".
- Gratis vs pago: "[N] cosas que el plan gratis NO te da en 2026" | "El plan gratis alcanza hasta aqui: cuando pagar [Marca] en 2026" | "[Marca] gratis vs Pro: cuando conviene pagar? 2026".`;

const SPANISH_META_BLOCK = `META DESCRIPTION EN ESPANOL (CTR) — no afecta ranking pero dispara clics. Como el articulo es en espanol, usa estas reglas (ignora la guia de meta en ingles):
- 150-160 caracteres, pero escribe ~140-150 de contenido real (el espanol es mas largo y no quieres que se corte el cierre). En movil solo se ven ~120 caracteres: mete beneficio + keyword + gancho en los PRIMEROS 100-120.
- ARRANCA con el beneficio/resultado. PROHIBIDO empezar con "En este articulo", "Aprende sobre", "Te contamos", "Conoce", "Descubre el", "Si estas buscando".
- Keyword principal en los primeros 80 caracteres, natural (una vez).
- Incluye un NUMERO o dato concreto cuando se pueda (precio USD, cantidad de herramientas, de pasos).
- CIERRA con curiosidad o CTA suave Latam: "Mira cual conviene", "Aqui los resultados", "Te decimos cual te conviene", "Compara precios y funciones", "Antes de pagar, lee esto".
- Registro Latam neutral, acentos perfectos, cada meta UNICA. Maximo 1 emoji (✅ 🔥 ⭐) y solo en la meta, nunca en el titulo; jamas hagas que el sentido dependa del emoji.
Ejemplo: "Comparamos ChatGPT, Claude y Gemini en velocidad, precio y calidad. Te decimos cual conviene de verdad para tu caso en 2026. ✅"`;

// Normalize a Spanish title/phrase into a URL-safe slug: strip accents and ñ,
// lowercase, drop symbols, collapse to hyphens. Spanish titles carry accents
// that must NOT leak into the slug.
function spanishSlugify(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

module.exports = { SPANISH_TITLE_BLOCK, SPANISH_META_BLOCK, spanishSlugify };
