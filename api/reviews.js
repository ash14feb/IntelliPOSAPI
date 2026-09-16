const express = require('express');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/reviews?date=YYYY-MM-DD — one row per order review, newest first.
router.get('/', async (req, res) => {
    try {
        const date = String(req.query.date || '').trim();
        let q = `SELECT r.*, t.table_no FROM pos_reviews r LEFT JOIN pos_tables t ON t.id = r.table_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = ?`;
        const p = [req.user.tenant_id];
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            q += ` AND DATE(r.created_at) = ?`;
            p.push(date);
        }
        q += ` ORDER BY r.created_at DESC LIMIT 200`;
        let rows;
        try {
            rows = await db.query(q, p);
        } catch (e) {
            // Reviews tables not migrated yet.
            if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return res.json({ success: true, data: [] });
            throw e;
        }
        res.json({
            success: true,
            data: rows.map((r) => ({
                id: r.id,
                orderCode: r.order_code,
                tableId: r.table_id,
                tableNo: r.table_no || null,
                customerName: r.customer_name || '',
                customerPhone: r.customer_phone || '',
                overallRating: Number(r.overall_rating || 0),
                reviewText: r.review_text || '',
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            })),
        });
    } catch (e) {
        console.error('Reviews list error:', e);
        res.status(500).json({ success: false, message: 'Error fetching reviews' });
    }
});

// GET /api/reviews/:id — full detail incl. per-item ratings.
router.get('/:id', async (req, res) => {
    try {
        let rows;
        try {
            rows = await db.query(
                `SELECT r.*, t.table_no FROM pos_reviews r LEFT JOIN pos_tables t ON t.id = r.table_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.id = ? LIMIT 1`,
                [req.user.tenant_id, req.params.id]
            );
        } catch (e) {
            if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return res.status(404).json({ success: false, message: 'Review not found' });
            throw e;
        }
        if (!rows.length) return res.status(404).json({ success: false, message: 'Review not found' });
        const r = rows[0];
        let items = [];
        try {
            items = await db.query(`SELECT item_name, rating FROM pos_review_items WHERE tenant_id = ? AND review_id = ? ORDER BY id ASC`, [req.user.tenant_id, r.id]);
        } catch {}
        res.json({
            success: true,
            data: {
                id: r.id,
                orderCode: r.order_code,
                tableId: r.table_id,
                tableNo: r.table_no || null,
                customerName: r.customer_name || '',
                customerPhone: r.customer_phone || '',
                overallRating: Number(r.overall_rating || 0),
                reviewText: r.review_text || '',
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                items: items.map((it) => ({ name: it.item_name, rating: Number(it.rating || 0) })),
            },
        });
    } catch (e) {
        console.error('Review detail error:', e);
        res.status(500).json({ success: false, message: 'Error fetching review' });
    }
});

module.exports = router;
