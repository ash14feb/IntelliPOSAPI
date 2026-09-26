// AI Upselling Engine (Delta_015).
// - Generation + review/approve APIs are authenticated (owner/manager only).
// - OpenAI is called SERVER-SIDE only (key from env, never sent to browser).
// - Public menu NEVER calls OpenAI: it reads pre-approved rows via
//   getApprovedUpsellMap() (embedded in the public menu payload).

const express = require('express');
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const OWNER_ROLES = ['admin', 'super_admin', 'manager'];

const ALLOWED_TYPES = ['SIDE', 'STARTER', 'BEVERAGE', 'DESSERT', 'ADDON', 'COMPLEMENT'];
const MAX_PER_SOURCE = 4;

const UPSELL_SYSTEM_PROMPT = `You are an upselling engine for a restaurant point-of-sale.
Your objective: identify complementary items a customer may reasonably want to purchase TOGETHER with a given menu item.

Base recommendations on: complementary food pairing, meal completion, beverage pairing, side dishes, starters, desserts, add-ons, typical restaurant ordering patterns, cuisine compatibility.

Examples of good pairings:
- Chicken Biryani -> Raita, Chicken 65, Coke, Gulab Jamun
- Masala Dosa -> Vada, Sambar, Filter Coffee
- Burger -> French Fries, Coke, Extra Cheese
- Pizza -> Garlic Bread, Coke, Dessert

STRICT RULES:
1. ONLY recommend items from the supplied menu list. Use ONLY the exact numeric IDs given. Never invent items, IDs, prices, categories, or products.
2. NEVER recommend the source item itself. No exact duplicates. No clearly incompatible items. No substitutes when the goal is upselling (suggest additions, not replacements).
3. Generate 2-4 recommendations per source item where meaningful pairings exist. It is acceptable — preferred — for an item to have ZERO recommendations rather than forced, weak ones. Do not force recommendations for every item.
4. Each recommendation needs: the recommended item ID, a short human reason (max 80 chars), a priority (1 = best), and a type (one of SIDE, STARTER, BEVERAGE, DESSERT, ADDON, COMPLEMENT).
5. Respond with JSON ONLY, exactly in this shape: {"recommendations": [{"sourceItemId": 101, "items": [{"recommendedItemId": 102, "reason": "...", "priority": 1, "type": "SIDE"}]}]}`;

function generationId() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 6);
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${rand}`;
}

async function activeMenu(tenantId) {
    const rows = await db.query(
        `SELECT p.id, p.name, p.price, c.name AS category_name, p.description
         FROM pos_products p
         INNER JOIN pos_categories c ON c.id = p.category_id
         WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
           AND (p.is_available IS NULL OR p.is_available <> 0)
         ORDER BY p.id ASC`,
        [tenantId, tenantId]
    ).catch(() =>
        // Delta_014 not applied: no is_available column.
        db.query(
            `SELECT p.id, p.name, p.price, c.name AS category_name, p.description
             FROM pos_products p
             INNER JOIN pos_categories c ON c.id = p.category_id
             WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
             ORDER BY p.id ASC`,
            [tenantId, tenantId]
        ).catch(() =>
            db.query(
                `SELECT p.id, p.name, p.price, c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
                 ORDER BY p.id ASC`,
                [tenantId, tenantId]
            )
        )
    );
    return rows;
}

async function callOpenAI(menuPayload, onlySourceIds) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const e = new Error('OPENAI_API_KEY is not configured on the server');
        e.code = 'NO_API_KEY';
        throw e;
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const scopeNote = onlySourceIds && onlySourceIds.length
        ? ` Only generate recommendations for source item IDs in this list: [${onlySourceIds.join(', ')}]. You may recommend any item from the menu as the paired item.`
        : '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
        const res = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                input: [
                    { role: 'system', content: [{ type: 'input_text', text: UPSELL_SYSTEM_PROMPT }] },
                    {
                        role: 'user',
                        content: [{
                            type: 'input_text',
                            text: `Menu items (JSON):\n${JSON.stringify(menuPayload)}${scopeNote}\n\nReturn JSON only, exactly: {"recommendations": [{"sourceItemId": <id>, "items": [{"recommendedItemId": <id>, "reason": "<short>", "priority": <1..n>, "type": "<ONE OF SIDE|STARTER|BEVERAGE|DESSERT|ADDON|COMPLEMENT>"}]}]}`
                        }]
                    }
                ]
            })
        });
        if (!res.ok) {
            const e = new Error(res.status === 429 ? 'AI rate limit reached. Please try again in a minute.' : `AI request failed (status ${res.status})`);
            e.code = res.status === 429 ? 'RATE_LIMIT' : 'AI_HTTP';
            throw e;
        }
        const data = await res.json();
        let raw = '';
        try {
            const msg = data.output?.find((o) => o.type === 'message');
            raw = msg?.content?.[0]?.text || data.output?.[1]?.content?.[0]?.text || data.output?.[0]?.content?.[0]?.text || '';
        } catch { raw = ''; }
        if (!raw) {
            const e = new Error('AI returned an empty response. Please try again.');
            e.code = 'EMPTY_RESPONSE';
            throw e;
        }
        const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        let parsed;
        try {
            parsed = JSON.parse(clean);
        } catch {
            const e = new Error('AI returned invalid JSON. Please try again.');
            e.code = 'INVALID_JSON';
            throw e;
        }
        const recs = parsed?.recommendations;
        if (!Array.isArray(recs)) {
            const e = new Error('AI response had an unexpected shape. Please try again.');
            e.code = 'BAD_SHAPE';
            throw e;
        }
        return recs;
    } finally {
        clearTimeout(timer);
    }
}

// Validate AI output against the real menu. Returns { valid, skipped }.
function validateRecs(recs, menuById) {
    const valid = [];
    let skipped = 0;
    for (const r of recs) {
        const srcId = Number(r?.sourceItemId);
        if (!srcId || !menuById.has(srcId)) { skipped++; continue; }
        const items = Array.isArray(r.items) ? r.items.slice(0, MAX_PER_SOURCE) : [];
        const seen = new Set();
        let pri = 0;
        for (const it of items) {
            const recId = Number(it?.recommendedItemId);
            const type = String(it?.type || 'COMPLEMENT').toUpperCase();
            if (!recId || !menuById.has(recId) || recId === srcId || seen.has(recId)) { skipped++; continue; }
            seen.add(recId);
            valid.push({
                source_item_id: srcId,
                recommended_item_id: recId,
                priority: ++pri,
                recommendation_type: ALLOWED_TYPES.includes(type) ? type : 'COMPLEMENT',
                ai_reason: String(it?.reason || '').slice(0, 255),
            });
        }
    }
    return { valid, skipped };
}

async function saveDrafts(tenantId, pairs, genId) {
    if (!pairs.length) return 0;
    let saved = 0;
    for (const p of pairs) {
        try {
            // Never clobber APPROVED rows; refresh DRAFT rows for the same pair.
            await db.query(
                `INSERT INTO ai_upsell_recommendations
                 (tenant_id, source_item_id, recommended_item_id, priority, recommendation_type, ai_reason, status, generation_id, generated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, NOW())
                 ON DUPLICATE KEY UPDATE
                   priority = VALUES(priority),
                   recommendation_type = VALUES(recommendation_type),
                   ai_reason = VALUES(ai_reason),
                   status = IF(status = 'APPROVED', 'APPROVED', 'DRAFT'),
                   generation_id = IF(status = 'APPROVED', generation_id, VALUES(generation_id)),
                   generated_at = IF(status = 'APPROVED', generated_at, NOW())`,
                [tenantId, p.source_item_id, p.recommended_item_id, p.priority, p.recommendation_type, p.ai_reason, genId]
            );
            saved++;
        } catch { /* keep going; surfaced via counts */ }
    }
    return saved;
}

async function generateFor(tenantId, onlySourceIds) {
    const menu = await activeMenu(tenantId);
    if (!menu.length) {
        const e = new Error('No active menu items to analyze');
        e.code = 'NO_MENU';
        throw e;
    }
    const payload = menu.map((m) => ({
        id: Number(m.id),
        name: m.name,
        category: m.category_name || 'General',
        description: m.description || '',
        price: Number(m.price),
    }));
    const validSources = new Set(menu.map((m) => Number(m.id)));
    const scope = (onlySourceIds || []).map(Number).filter((id) => validSources.has(id));
    const raw = await callOpenAI(payload, scope.length ? scope : null);
    const menuById = new Map(menu.map((m) => [Number(m.id), m]));
    let recs = raw;
    if (scope.length) recs = raw.filter((r) => scope.includes(Number(r?.sourceItemId)));
    const { valid, skipped } = validateRecs(recs, menuById);
    if (!valid.length) {
        const e = new Error(skipped > 0
            ? 'AI returned no valid recommendations (unknown item IDs were discarded). Please try again.'
            : 'AI returned no recommendations. Please try again.');
        e.code = 'NO_VALID';
        throw e;
    }
    const genId = generationId();
    const saved = await saveDrafts(tenantId, valid, genId);
    return { generation_id: genId, saved, skipped, sources: new Set(valid.map((v) => v.source_item_id)).size };
}

// ---- Owner APIs ----

// Stats for the AI Upselling Engine page.
router.get('/stats', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const [[menuRow]] = [await db.query(
            `SELECT COUNT(*) AS c FROM pos_products p INNER JOIN pos_categories c ON c.id = p.category_id
             WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1`, [t, t])];
        let recs = [];
        try {
            recs = await db.query(
                `SELECT r.status, r.source_item_id, r.generation_id, r.generated_at
                 FROM ai_upsell_recommendations r
                 INNER JOIN pos_products p ON p.id = r.source_item_id AND p.tenant_id = r.tenant_id AND p.is_active = 1
                 INNER JOIN pos_products p2 ON p2.id = r.recommended_item_id AND p2.tenant_id = r.tenant_id AND p2.is_active = 1
                 WHERE r.tenant_id = ?`, [t]);
        } catch { /* Delta_015 missing */ }
        const byStatus = (s) => recs.filter((r) => r.status === s).length;
        const withRecs = new Set(recs.map((r) => r.source_item_id)).size;
        let lastGen = null;
        let lastGenAt = null;
        for (const r of recs) {
            if (r.generated_at && (!lastGenAt || new Date(r.generated_at) > new Date(lastGenAt))) {
                lastGenAt = r.generated_at;
                lastGen = r.generation_id;
            }
        }
        res.json({
            success: true,
            data: {
                menuItems: Number(menuRow?.c) || 0,
                itemsWithRecommendations: withRecs,
                total: recs.length,
                approved: byStatus('APPROVED'),
                pending: byStatus('DRAFT'),
                rejected: byStatus('REJECTED'),
                lastGenerationId: lastGen,
                lastGeneratedAt: lastGenAt,
                deltaMissing: false,
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error loading upsell stats' });
    }
});

// Generate (bulk, or scoped to selected source items via { source_item_ids: [...] }).
// New rows are DRAFT; APPROVED rows untouched.
router.post('/generate', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.source_item_ids)
            ? req.body.source_item_ids.map(Number).filter(Boolean)
            : null;
        const out = await generateFor(req.user.tenant_id, ids && ids.length ? ids : null);
        res.json({ success: true, data: out, message: `Generated ${out.saved} recommendations (${out.sources} items) as drafts` });
    } catch (e) {
        if (e.code === 'NO_API_KEY') return res.status(500).json({ success: false, message: 'AI is not configured. Set OPENAI_API_KEY on the server.' });
        res.status(502).json({ success: false, message: e.message || 'Unable to generate recommendations right now. Please try again.' });
    }
});

// Regenerate for a single source item.
router.post('/regenerate-item', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const srcId = Number(req.body?.source_item_id);
        if (!srcId) return res.status(400).json({ success: false, message: 'source_item_id required' });
        const out = await generateFor(req.user.tenant_id, [srcId]);
        res.json({ success: true, data: out });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message || 'Unable to generate recommendations right now. Please try again.' });
    }
});

// Review list, grouped by source. ?generation_id=...&status=DRAFT|APPROVED|...
router.get('/', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const { generation_id, status } = req.query;
        const conds = ['r.tenant_id = ?'];
        const params = [t];
        if (generation_id) { conds.push('r.generation_id = ?'); params.push(generation_id); }
        if (status) { conds.push('r.status = ?'); params.push(String(status).toUpperCase()); }
        const rows = await db.query(
            `SELECT r.*, p.name AS source_name, p.price AS source_price,
                    q.name AS rec_name, q.price AS rec_price, q.image_url AS rec_image
             FROM ai_upsell_recommendations r
             INNER JOIN pos_products p ON p.id = r.source_item_id AND p.tenant_id = r.tenant_id
             INNER JOIN pos_products q ON q.id = r.recommended_item_id AND q.tenant_id = r.tenant_id
             WHERE ${conds.join(' AND ')}
             ORDER BY p.name ASC, r.priority ASC, r.id ASC
             LIMIT 2000`,
            params
        );
        const groups = new Map();
        for (const r of rows) {
            if (!groups.has(r.source_item_id)) {
                groups.set(r.source_item_id, {
                    sourceItemId: String(r.source_item_id),
                    sourceName: r.source_name,
                    sourcePrice: Number(r.source_price),
                    generationId: r.generation_id,
                    items: [],
                });
            }
            groups.get(r.source_item_id).items.push({
                id: r.id,
                recommendedItemId: String(r.recommended_item_id),
                name: r.rec_name,
                price: Number(r.rec_price),
                image: r.rec_image || '',
                reason: r.ai_reason || '',
                priority: Number(r.priority),
                type: r.recommendation_type,
                status: r.status,
            });
        }
        res.json({ success: true, data: [...groups.values()] });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error loading recommendations' });
    }
});

// Approve / reject / disable / change priority (ownership validated).
router.put('/:id', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const { status, priority } = req.body || {};
        const sets = [];
        const vals = [];
        if (status !== undefined) {
            const s = String(status).toUpperCase();
            if (!['DRAFT', 'APPROVED', 'REJECTED', 'DISABLED'].includes(s)) {
                return res.status(400).json({ success: false, message: 'Invalid status' });
            }
            sets.push('status = ?');
            vals.push(s);
            if (s === 'APPROVED') sets.push('approved_at = NOW()');
        }
        if (priority !== undefined) {
            sets.push('priority = ?');
            vals.push(Math.max(1, Math.min(99, Number(priority) || 1)));
        }
        if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
        const r = await db.query(
            `UPDATE ai_upsell_recommendations SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
            [...vals, t, req.params.id]
        );
        if ((r.affectedRows ?? 0) === 0) return res.status(404).json({ success: false, message: 'Recommendation not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error updating recommendation' });
    }
});

// Manually add an existing menu item as a recommendation.
router.post('/add', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const srcId = Number(req.body?.source_item_id);
        const recId = Number(req.body?.recommended_item_id);
        if (!srcId || !recId || srcId === recId) {
            return res.status(400).json({ success: false, message: 'Valid source_item_id and recommended_item_id required' });
        }
        const ok = await db.query(
            `SELECT COUNT(*) AS c FROM pos_products WHERE tenant_id = ? AND is_active = 1 AND id IN (?, ?)`,
            [t, srcId, recId]
        );
        if (Number(ok[0]?.c) !== 2) {
            return res.status(400).json({ success: false, message: 'Both items must exist in your active menu' });
        }
        const type = ALLOWED_TYPES.includes(String(req.body?.recommendation_type || '').toUpperCase())
            ? String(req.body.recommendation_type).toUpperCase() : 'COMPLEMENT';
        await db.query(
            `INSERT INTO ai_upsell_recommendations
             (tenant_id, source_item_id, recommended_item_id, priority, recommendation_type, ai_reason, status, generation_id, generated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, NOW())
             ON DUPLICATE KEY UPDATE priority = VALUES(priority), recommendation_type = VALUES(recommendation_type),
               ai_reason = VALUES(ai_reason), status = IF(status = 'APPROVED', 'APPROVED', 'DRAFT')`,
            [t, srcId, recId, Math.max(1, Math.min(99, Number(req.body?.priority) || 9)), type, String(req.body?.ai_reason || '').slice(0, 255), generationId()]
        );
        res.status(201).json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error adding recommendation' });
    }
});

// Remove one recommended item.
router.delete('/:id', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        await db.query('DELETE FROM ai_upsell_recommendations WHERE tenant_id = ? AND id = ?', [req.user.tenant_id, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error removing recommendation' });
    }
});

// Approve / reject all DRAFT rows of a generation (only pairs still valid).
router.post('/approve-all', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const { generation_id } = req.body || {};
        if (!generation_id) return res.status(400).json({ success: false, message: 'generation_id required' });
        const r = await db.query(
            `UPDATE ai_upsell_recommendations r
             INNER JOIN pos_products p ON p.id = r.source_item_id AND p.tenant_id = r.tenant_id AND p.is_active = 1
             INNER JOIN pos_products q ON q.id = r.recommended_item_id AND q.tenant_id = r.tenant_id AND q.is_active = 1
             SET r.status = 'APPROVED', r.approved_at = NOW()
             WHERE r.tenant_id = ? AND r.generation_id = ? AND r.status = 'DRAFT'`,
            [t, generation_id]
        );
        res.json({ success: true, data: { approved: r.affectedRows ?? 0 } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error approving recommendations' });
    }
});

router.post('/reject-all', authorize(...OWNER_ROLES), async (req, res) => {
    try {
        const t = req.user.tenant_id;
        const { generation_id } = req.body || {};
        if (!generation_id) return res.status(400).json({ success: false, message: 'generation_id required' });
        const r = await db.query(
            `UPDATE ai_upsell_recommendations SET status = 'REJECTED'
             WHERE tenant_id = ? AND generation_id = ? AND status = 'DRAFT'`,
            [t, generation_id]
        );
        res.json({ success: true, data: { rejected: r.affectedRows ?? 0 } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error rejecting recommendations' });
    }
});

module.exports = router;

// ---- Public-menu helper (no auth, no AI): approved rows only, active items only ----
async function getApprovedUpsellMap(tenantId) {
    try {
        const rows = await db.query(
            `SELECT r.source_item_id, r.recommended_item_id, r.priority, r.recommendation_type, r.ai_reason,
                    q.name, q.price, q.image_url
             FROM ai_upsell_recommendations r
             INNER JOIN pos_products p ON p.id = r.source_item_id AND p.tenant_id = r.tenant_id AND p.is_active = 1
             INNER JOIN pos_products q ON q.id = r.recommended_item_id AND q.tenant_id = r.tenant_id AND q.is_active = 1
             LEFT JOIN pos_categories c ON c.id = q.category_id AND c.tenant_id = r.tenant_id
             WHERE r.tenant_id = ? AND r.status = 'APPROVED'
               AND (q.is_available IS NULL OR q.is_available <> 0)
               AND (c.id IS NULL OR c.is_active = 1)
             ORDER BY r.source_item_id ASC, r.priority ASC
             LIMIT 2000`,
            [tenantId]
        ).catch(() =>
            db.query(
                `SELECT r.source_item_id, r.recommended_item_id, r.priority, r.recommendation_type, r.ai_reason,
                        q.name, q.price, q.image_url
                 FROM ai_upsell_recommendations r
                 INNER JOIN pos_products p ON p.id = r.source_item_id AND p.tenant_id = r.tenant_id AND p.is_active = 1
                 INNER JOIN pos_products q ON q.id = r.recommended_item_id AND q.tenant_id = r.tenant_id AND q.is_active = 1
                 WHERE r.tenant_id = ? AND r.status = 'APPROVED'
                 ORDER BY r.source_item_id ASC, r.priority ASC
                 LIMIT 2000`,
                [tenantId]
            )
        );
        const map = {};
        for (const r of rows) {
            const k = String(r.source_item_id);
            (map[k] = map[k] || []).push({
                id: String(r.recommended_item_id),
                name: r.name,
                price: Number(r.price),
                image: r.image_url || '',
                reason: r.ai_reason || '',
                type: r.recommendation_type,
                priority: Number(r.priority),
            });
        }
        return map;
    } catch { return {}; /* Delta_015 missing -> no upsells */ }
}
module.exports.getApprovedUpsellMap = getApprovedUpsellMap;
