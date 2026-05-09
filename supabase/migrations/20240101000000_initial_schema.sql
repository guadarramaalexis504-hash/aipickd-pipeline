-- ============================================
-- AIPickd — Supabase Schema
-- ============================================
-- Ejecuta este archivo en Supabase SQL Editor
-- (Project > SQL Editor > New Query > paste > Run)
-- ============================================

-- Extensiones útiles
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- búsqueda por similitud

-- ============================================
-- Tabla: niches
-- ============================================
CREATE TABLE niches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    priority INT DEFAULT 5, -- 1-10, más alto = más foco
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO niches (slug, name, description, priority) VALUES
    ('ai-writing', 'AI Writing Tools', 'Jasper, Copy.ai, Writesonic, ChatGPT alternatives', 10),
    ('ai-business', 'AI Business & Productivity', 'Notion, ClickUp, Monday, Make.com', 9),
    ('ai-image-video', 'AI Image & Video', 'Midjourney, DALL-E, Runway, Synthesia', 8),
    ('ai-coding', 'AI Coding Tools', 'Cursor, Copilot, Tabnine, Claude Code', 8),
    ('ai-hosting', 'AI Infrastructure & Hosting', 'Hostinger, Vercel, Supabase, Railway', 7);

-- ============================================
-- Tabla: affiliates
-- Programas de afiliados activos
-- ============================================
CREATE TABLE affiliates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand TEXT NOT NULL,
    network TEXT, -- 'impact', 'partnerstack', 'amazon', 'direct'
    product_category TEXT,
    niche_id UUID REFERENCES niches(id),
    base_url TEXT NOT NULL, -- link con tu tracking ID
    commission_type TEXT, -- 'per_sale', 'recurring', 'per_lead'
    commission_amount NUMERIC, -- en USD
    commission_percentage NUMERIC, -- si aplica
    cookie_days INT DEFAULT 30,
    status TEXT DEFAULT 'pending', -- pending, active, paused, rejected
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Afiliados iniciales (el usuario debe actualizar base_url con su ID)
INSERT INTO affiliates (brand, network, product_category, commission_type, commission_amount, base_url, status) VALUES
    ('Jasper', 'impact', 'ai-writing', 'per_sale', 200, 'https://jasper.ai/?fp_ref=REPLACE_ME', 'pending'),
    ('Copy.ai', 'direct', 'ai-writing', 'recurring', 0, 'https://copy.ai/?via=REPLACE_ME', 'pending'),
    ('Writesonic', 'direct', 'ai-writing', 'recurring', 0, 'https://writesonic.com?ref=REPLACE_ME', 'pending'),
    ('Notion', 'partnerstack', 'ai-business', 'per_sale', 20, 'https://notion.so?ref=REPLACE_ME', 'pending'),
    ('ClickUp', 'impact', 'ai-business', 'per_sale', 100, 'https://clickup.com?ref=REPLACE_ME', 'pending'),
    ('Make.com', 'partnerstack', 'ai-business', 'recurring', 0, 'https://make.com?ref=REPLACE_ME', 'pending'),
    ('Hostinger', 'direct', 'ai-hosting', 'per_sale', 150, 'https://hostinger.com?ref=REPLACE_ME', 'pending'),
    ('Semrush', 'impact', 'ai-business', 'per_sale', 200, 'https://semrush.com?ref=REPLACE_ME', 'pending');

-- ============================================
-- Tabla: keywords
-- Keywords objetivo con datos SEO
-- ============================================
CREATE TABLE keywords (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword TEXT UNIQUE NOT NULL,
    niche_id UUID REFERENCES niches(id),
    search_volume INT, -- búsquedas mensuales
    keyword_difficulty INT, -- 0-100
    cpc NUMERIC, -- cost per click como proxy de valor comercial
    intent TEXT, -- 'informational', 'commercial', 'transactional', 'navigational'
    article_type TEXT, -- 'comparison', 'listicle', 'review', 'how-to', 'alternatives'
    status TEXT DEFAULT 'queued', -- queued, in_progress, published, skipped
    priority INT DEFAULT 5, -- 1-10
    discovered_at TIMESTAMPTZ DEFAULT NOW(),
    scheduled_for TIMESTAMPTZ,
    assigned_article_id UUID -- FK a articles cuando se genera
);

CREATE INDEX idx_keywords_status ON keywords(status);
CREATE INDEX idx_keywords_priority ON keywords(priority DESC);
CREATE INDEX idx_keywords_niche ON keywords(niche_id);

-- ============================================
-- Tabla: articles
-- Artículos generados y publicados
-- ============================================
CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword_id UUID REFERENCES keywords(id),
    niche_id UUID REFERENCES niches(id),
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    meta_description TEXT,
    content_markdown TEXT, -- versión completa en MD
    content_html TEXT, -- versión renderizada pa' WP
    word_count INT,
    article_type TEXT,
    affiliates_mentioned UUID[], -- array de affiliate IDs
    status TEXT DEFAULT 'draft', -- draft, reviewed, published, needs_update
    wp_post_id INT, -- ID del post en WordPress
    wp_url TEXT, -- URL pública
    featured_image_url TEXT,
    generated_by TEXT, -- 'claude', 'gpt', 'bridge'
    reviewed_by TEXT,
    generation_cost_usd NUMERIC, -- costo IA pa' traquear ROI
    published_at TIMESTAMPTZ,
    last_updated_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ, -- cuándo revisar y refrescar
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_articles_status ON articles(status);
CREATE INDEX idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX idx_articles_next_review ON articles(next_review_at);

-- ============================================
-- Tabla: article_versions
-- Histórico de versiones (pa' rollback y análisis)
-- ============================================
CREATE TABLE article_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    content_markdown TEXT,
    changelog TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(article_id, version_number)
);

-- ============================================
-- Tabla: metrics_daily
-- Métricas agregadas por día
-- ============================================
CREATE TABLE metrics_daily (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date DATE NOT NULL,
    article_id UUID REFERENCES articles(id),
    views INT DEFAULT 0,
    unique_visitors INT DEFAULT 0,
    avg_time_on_page INT, -- segundos
    bounce_rate NUMERIC,
    affiliate_clicks INT DEFAULT 0,
    affiliate_conversions INT DEFAULT 0,
    estimated_revenue_usd NUMERIC DEFAULT 0,
    google_position NUMERIC, -- posición promedio
    impressions INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date, article_id)
);

CREATE INDEX idx_metrics_date ON metrics_daily(date DESC);

-- ============================================
-- Tabla: affiliate_clicks
-- Traqueo de clicks a afiliados
-- ============================================
CREATE TABLE affiliate_clicks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID REFERENCES articles(id),
    affiliate_id UUID REFERENCES affiliates(id),
    click_timestamp TIMESTAMPTZ DEFAULT NOW(),
    user_agent TEXT,
    referrer TEXT,
    ip_hash TEXT, -- hasheado pa' privacidad
    converted BOOLEAN DEFAULT false,
    conversion_amount_usd NUMERIC
);

CREATE INDEX idx_clicks_article ON affiliate_clicks(article_id);
CREATE INDEX idx_clicks_affiliate ON affiliate_clicks(affiliate_id);
CREATE INDEX idx_clicks_timestamp ON affiliate_clicks(click_timestamp DESC);

-- ============================================
-- Tabla: ai_generation_log
-- Log de cada llamada a IA (pa' debugging y costos)
-- ============================================
CREATE TABLE ai_generation_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID REFERENCES articles(id),
    ai_provider TEXT, -- 'anthropic', 'openai'
    model TEXT,
    step TEXT, -- 'outline', 'draft', 'review', 'final', 'seo_meta'
    tokens_input INT,
    tokens_output INT,
    cost_usd NUMERIC,
    duration_ms INT,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_log_article ON ai_generation_log(article_id);
CREATE INDEX idx_ai_log_date ON ai_generation_log(created_at DESC);

-- ============================================
-- Tabla: system_config
-- Configuración runtime (sin tener que hacer deploys)
-- ============================================
CREATE TABLE system_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_config (key, value, description) VALUES
    ('daily_article_target', '2', 'Artículos a publicar por día'),
    ('min_word_count', '2000', 'Mínimo de palabras por artículo'),
    ('max_word_count', '3500', 'Máximo de palabras por artículo'),
    ('ai_bridge_enabled', 'true', 'Usar Claude + GPT pipeline vs solo uno'),
    ('auto_publish', 'false', 'Publicar automáticamente o marcar como draft pa' review'),
    ('review_cadence_days', '90', 'Cada cuántos días revisar y refrescar artículo');

-- ============================================
-- Vistas útiles pa' el dashboard
-- ============================================
CREATE VIEW v_dashboard_overview AS
SELECT
    (SELECT COUNT(*) FROM articles WHERE status = 'published') AS total_published,
    (SELECT COUNT(*) FROM articles WHERE created_at > NOW() - INTERVAL '7 days') AS articles_this_week,
    (SELECT COUNT(*) FROM keywords WHERE status = 'queued') AS keywords_queued,
    (SELECT COALESCE(SUM(estimated_revenue_usd), 0) FROM metrics_daily WHERE date > NOW() - INTERVAL '30 days') AS revenue_last_30d,
    (SELECT COALESCE(SUM(views), 0) FROM metrics_daily WHERE date > NOW() - INTERVAL '30 days') AS views_last_30d,
    (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_generation_log WHERE created_at > NOW() - INTERVAL '30 days') AS ai_cost_last_30d;

CREATE VIEW v_top_articles AS
SELECT
    a.title,
    a.wp_url,
    a.published_at,
    COALESCE(SUM(m.views), 0) AS total_views,
    COALESCE(SUM(m.affiliate_clicks), 0) AS total_clicks,
    COALESCE(SUM(m.estimated_revenue_usd), 0) AS total_revenue
FROM articles a
LEFT JOIN metrics_daily m ON m.article_id = a.id
WHERE a.status = 'published'
GROUP BY a.id, a.title, a.wp_url, a.published_at
ORDER BY total_revenue DESC NULLS LAST
LIMIT 50;

-- ============================================
-- RLS (seguridad) — opcional, pa' cuando expongas API público
-- ============================================
-- ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
-- (políticas específicas se agregan después según necesidad)

-- ============================================
-- FIN del schema
-- ============================================
