const express = require('express');
const crypto = require('crypto');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

const newMenuCode = () => crypto.randomBytes(8).toString('hex');

// Reserved table_no for delivery/online ordering. Its public menu hides the
// table name, requires GPS + address, and every order is a fresh ONLINE order
// (never merged into a shared tab, never flips table status).
const ONLINE_TABLE_NO = 'ONLINETABLE';
const isOnlineTable = (table) => String(table?.table_no || '').trim().toUpperCase() === ONLINE_TABLE_NO;

// Active (unpaid) order summary for a table — shown on the public menu so the
// customer sees what was already ordered + the running total.
async function getPublicActiveOrder(table) {
    try {
        const st = String(table.status || '').toUpperCase();
        if ((st !== 'CUSTOMER_ORDERED' && st !== 'HAVING_FOOD') || !table.current_order_code) return null;
        const orows = await db.query(
            `SELECT id, order_code, subtotal, total_amount, customer_name, customer_phone, kitchen_notes, order_status FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1`,
            [table.tenant_id, table.current_order_code]
        );
        if (!orows.length) return null;
        const o = orows[0];
        if (['PAID', 'COMPLETED', 'CANCELLED'].includes(String(o.order_status || '').toUpperCase())) return null;
        const irows = await db.query(
            `SELECT item_name, quantity, unit_price, line_total FROM pos_order_items WHERE tenant_id=? AND order_id=? ORDER BY id ASC`,
            [table.tenant_id, o.id]
        );
        // Existing review for this order (if the customer already rated).
        let myReview = null;
        try {
            const rrows = await db.query(`SELECT id, overall_rating, review_text FROM pos_reviews WHERE tenant_id=? AND order_code=? LIMIT 1`, [table.tenant_id, o.order_code]);
            if (rrows.length) {
                const items = await db.query(`SELECT item_name, rating FROM pos_review_items WHERE tenant_id=? AND review_id=? ORDER BY id ASC`, [table.tenant_id, rrows[0].id]);
                myReview = {
                    overallRating: Number(rrows[0].overall_rating || 0),
                    reviewText: rrows[0].review_text || '',
                    items: items.map((it) => ({ name: it.item_name, rating: Number(it.rating || 0) })),
                };
            }
        } catch {}
        return {
            orderCode: o.order_code,
            orderStatus: o.order_status,
            customerName: o.customer_name || '',
            customerPhone: o.customer_phone || '',
            kitchenNotes: o.kitchen_notes || '',
            subtotal: Number(o.subtotal || 0),
            total: Number(o.total_amount ?? o.subtotal ?? 0),
            items: irows.map((r) => ({
                name: r.item_name,
                qty: Number(r.quantity || 0),
                price: Number(r.unit_price || 0),
                lineTotal: Number(r.line_total ?? (Number(r.unit_price || 0) * Number(r.quantity || 0))),
            })),
            myReview,
        };
    } catch { return null; }
}

async function ensureMenuCodeColumn() {
    try {
        await db.query('SELECT menu_code FROM pos_tables LIMIT 1');
        return true;
    } catch (e) {
        if (e && (e.code === 'ER_BAD_FIELD_ERROR' || (e.message || '').includes('Unknown column'))) return false;
        throw e;
    }
}

// ---- Public menu for a table (no auth): only menu items are exposed ----
router.get('/menu/:code', async (req, res) => {
    try {
        if (!(await ensureMenuCodeColumn())) {
            return res.status(500).json({ success: false, message: 'Table menu links are not set up yet' });
        }
        const tables = await db.query(
            'SELECT id, tenant_id, table_no, seats, status, current_order_code, menu_code FROM pos_tables WHERE menu_code = ? AND is_active = 1 LIMIT 1',
            [req.params.code]
        );
        if (tables.length === 0) {
            return res.status(404).json({ success: false, message: 'Menu link not found' });
        }
        const table = tables[0];

        let settings = null;
        try {
            const srows = await db.query(
                'SELECT restaurant_name, currency_symbol FROM pos_settings WHERE tenant_id = ? LIMIT 1',
                [table.tenant_id]
            );
            settings = srows[0] || null;
        } catch (e) { /* settings optional */ }

        let items = [];
        try {
            // Tier 1: with Delta_004 (description) + Delta_014 (availability, spice).
            // Falls back gracefully when a delta hasn't been applied yet.
            const base = (extra) => `SELECT p.id, p.name, p.price, p.image_url${extra} c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
                 ORDER BY c.sort_order ASC, c.name ASC, p.sort_order ASC, p.name ASC`;
            try {
                items = await db.query(base(`, p.description, p.is_available, p.spice_level,`), [table.tenant_id, table.tenant_id]);
            } catch (e1) {
                try {
                    items = await db.query(base(`, p.description,`), [table.tenant_id, table.tenant_id]);
                } catch (e2) {
                    items = await db.query(base(`,`), [table.tenant_id, table.tenant_id]);
                }
            }
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Error loading menu' });
        }

        let recommended = [];
        try {
            const rrows = await db.query(
                `SELECT r.product_id, r.price_delta, r.sort_order
                 FROM pos_recommended_items r
                 INNER JOIN pos_products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id AND p.is_active = 1
                 WHERE r.tenant_id = ?
                 ORDER BY r.sort_order ASC, r.id ASC`,
                [table.tenant_id]
            );
            recommended = rrows.map((r) => ({
                productId: String(r.product_id),
                priceDelta: Number(r.price_delta) || 0,
            }));
        } catch (e) { /* Delta_014 not applied yet -> no recommended section */ }

        res.json({
            success: true,
            data: {
                table: { table_no: table.table_no, seats: table.seats, status: table.status, current_order_code: table.current_order_code || null },
                isOnlineTable: isOnlineTable(table),
                restaurantName: settings?.restaurant_name || 'Our Menu',
                currencySymbol: settings?.currency_symbol || 'Rs.',
                tableStatus: table.status,
                activeOrder: await getPublicActiveOrder(table),
                recommended,
                upsells: await require('./upsell').getApprovedUpsellMap(table.tenant_id),
                menuItems: items.map(r => ({
                    id: String(r.id),
                    name: r.name,
                    price: Number(r.price),
                    image: r.image_url || '',
                    category: r.category_name,
                    description: r.description || '',
                    isAvailable: r.is_available === undefined || r.is_available === null ? true : Number(r.is_available) !== 0,
                    spiceLevel: r.spice_level === undefined || r.spice_level === null ? 0 : Number(r.spice_level) || 0
                }))
            }
        });
    } catch (e) {
        console.error('Public table menu error:', e);
        res.status(500).json({ success: false, message: 'Error loading menu' });
    }
});

// ---- Public self-order from a table QR menu (no auth) ----
// Body: { items: [{id?, name, price, qty}], customerName, customerPhone }
// Name + phone are mandatory. Creates a DINEIN/ACTIVE order (POS-save style)
// and marks the table CUSTOMER_ORDERED.
router.post('/order/:code', async (req, res) => {
    try {
        if (!(await ensureMenuCodeColumn())) {
            return res.status(500).json({ success: false, message: 'Table ordering is not set up yet' });
        }
        const { items, customerName, customerPhone, kitchenNotes, customerAddress, customerLandmark, lat, lng } = req.body || {};
        if (!customerName || !String(customerName).trim()) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }
        if (!customerPhone || !String(customerPhone).trim()) {
            return res.status(400).json({ success: false, message: 'Phone number is required' });
        }
        const notes = kitchenNotes ? String(kitchenNotes).slice(0, 500) : '';
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one item' });
        }
        const tables = await db.query(
            'SELECT id, tenant_id, table_no, status, current_order_code FROM pos_tables WHERE menu_code = ? AND is_active = 1 LIMIT 1',
            [req.params.code]
        );
        if (tables.length === 0) {
            return res.status(404).json({ success: false, message: 'Table link not found' });
        }
        const table = tables[0];
        const onlineMode = isOnlineTable(table);
        // Online orders: address + live GPS are mandatory (validated here too,
        // the public menu validates before sending).
        let onlineLoc = null;
        if (onlineMode) {
            const address = customerAddress ? String(customerAddress).trim().slice(0, 500) : '';
            const alat = Number(lat);
            const alng = Number(lng);
            if (!address) {
                return res.status(400).json({ success: false, message: 'Delivery address is required' });
            }
            if (!Number.isFinite(alat) || !Number.isFinite(alng) || alat === 0 || alng === 0) {
                return res.status(400).json({ success: false, message: 'Location is required — please enable GPS and try again' });
            }
            onlineLoc = {
                address,
                landmark: customerLandmark ? String(customerLandmark).trim().slice(0, 255) : null,
                lat: alat,
                lng: alng,
            };
        }
        const tableStatus = String(table.status || 'FREE').toUpperCase();
        const existingOrderCode = table.current_order_code || null;
        // Re-order flow: CUSTOMER_ORDERED or HAVING_FOOD with a live order ->
        // append items and flip status back to CUSTOMER_ORDERED.
        // (Never for the shared ONLINETABLE — every online order is fresh.)
        const isAppendFlow = !onlineMode && (tableStatus === 'CUSTOMER_ORDERED' || tableStatus === 'HAVING_FOOD') && existingOrderCode;

        const cleanItems = items
            .map((it) => ({
                id: Number(it.id) || null,
                name: String(it.name || '').slice(0, 200),
                category: String(it.category || 'General').slice(0, 100),
                image: it.image ? String(it.image).slice(0, 500) : null,
                qty: Math.max(1, Math.min(99, Number(it.qty ?? it.quantity ?? 1) || 1)),
                price: Math.max(0, Number(it.price || 0) || 0),
            }))
            .filter((it) => it.name);
        if (cleanItems.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one item' });
        }
        const subtotal = cleanItems.reduce((s, it) => s + it.price * it.qty, 0);

        // Append flow: table already CUSTOMER_ORDERED -> add items to the existing active order.
        if (isAppendFlow) {
            const connection = await db.getConnection();
            try {
                await connection.beginTransaction();
                const orows = await connection.execute(
                    `SELECT id, subtotal, total_amount, order_status, kitchen_notes FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1`,
                    [table.tenant_id, existingOrderCode]
                );
                const orow = (orows[0] && orows[0][0]) || null;
                if (!orow || ['PAID', 'COMPLETED', 'CANCELLED'].includes(String(orow.order_status || '').toUpperCase())) {
                    try { await connection.rollback(); } catch {}
                    connection.release();
                    return res.status(400).json({ success: false, message: 'This table already has an active order' });
                }
                for (const it of cleanItems) {
                    await connection.execute(
                        `INSERT INTO pos_order_items (tenant_id, order_id, product_id, item_name, item_category, item_image, quantity, unit_price, line_total)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [table.tenant_id, orow.id, it.id, it.name, it.category, it.image, it.qty, it.price, it.price * it.qty]
                    );
                }
                const newSubtotal = Number(orow.subtotal || 0) + subtotal;
                const newTotal = Number(orow.total_amount || 0) + subtotal;
                // New items need serving again -> flip order back to ACTIVE so
                // swipe-to-serve re-enables in Tables/POS.
                let mergedNotes = String(orow.kitchen_notes || '');
                if (notes) mergedNotes = mergedNotes ? `${mergedNotes} | ${notes}`.slice(0, 500) : notes;
                try {
                    await connection.execute(`UPDATE pos_orders SET subtotal=?, total_amount=?, order_status='ACTIVE', kitchen_notes=? WHERE tenant_id=? AND id=?`, [newSubtotal, newTotal, mergedNotes || null, table.tenant_id, orow.id]);
                } catch (e) {
                    // Delta_011 not applied yet: no kitchen_notes column.
                    if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
                        await connection.execute(`UPDATE pos_orders SET subtotal=?, total_amount=?, order_status='ACTIVE' WHERE tenant_id=? AND id=?`, [newSubtotal, newTotal, table.tenant_id, orow.id]);
                    } else { throw e; }
                }
                // Re-order flips the table back to CUSTOMER_ORDERED (needs staff attention again).
                try {
                    await connection.execute(`UPDATE pos_tables SET status='CUSTOMER_ORDERED', current_order_code=? WHERE tenant_id=? AND id=?`, [existingOrderCode, table.tenant_id, table.id]);
                } catch (e) {
                    if (!(e && (e.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' || (e.message || '').includes('CUSTOMER_ORDERED')))) throw e;
                }
                await connection.commit();
                connection.release();
                return res.status(201).json({ success: true, appended: true, data: { orderCode: existingOrderCode, tableNo: table.table_no, total: newTotal, addedTotal: subtotal } });
            } catch (e) {
                try { await connection.rollback(); } catch {}
                connection.release();
                throw e;
            }
        }
        if (!onlineMode && tableStatus !== 'FREE') {
            return res.status(400).json({ success: false, message: 'This table already has an active order' });
        }
        const orderCode = onlineMode ? `ONL-${Date.now()}` : `WEB-${Date.now()}`;
        const orderType = onlineMode ? 'ONLINE' : 'DINEIN';

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            let orderResult;
            const publicInsert = (mode) => connection.execute(
                `INSERT INTO pos_orders (tenant_id, order_code, subtotal, discount, cgst_amount, sgst_amount, total_amount, payment_mode, customer_name, customer_phone, kitchen_notes, order_type, order_status, table_id)
                 VALUES (?, ?, ?, 0, 0, 0, ?, '${mode}', ?, ?, ?, '${orderType}', 'ACTIVE', ?)`,
                [table.tenant_id, orderCode, subtotal, subtotal, String(customerName).trim(), String(customerPhone).trim(), notes || null, table.id]
            );
            try {
                try {
                    [orderResult] = await publicInsert('PENDING');
                } catch (e) {
                    // Delta_010 not applied yet: payment_mode enum lacks PENDING.
                    if (e && (e.errno === 1265 || e.code === 'WARN_DATA_TRUNCATED' || (e.message || '').includes('payment_mode'))) {
                        console.warn('Public order saved as CASH (Delta_010 not applied).');
                        [orderResult] = await publicInsert('CASH');
                    } else if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
                        // Delta_011 not applied yet: no kitchen_notes column.
                        const fallback = (m) => connection.execute(
                            `INSERT INTO pos_orders (tenant_id, order_code, subtotal, discount, cgst_amount, sgst_amount, total_amount, payment_mode, customer_name, customer_phone, order_type, order_status, table_id)
                             VALUES (?, ?, ?, 0, 0, 0, ?, '${m}', ?, ?, '${orderType}', 'ACTIVE', ?)`,
                            [table.tenant_id, orderCode, subtotal, subtotal, String(customerName).trim(), String(customerPhone).trim(), table.id]
                        );
                        try {
                            [orderResult] = await fallback('PENDING');
                        } catch (e2) {
                            if (e2 && (e2.errno === 1265 || e2.code === 'WARN_DATA_TRUNCATED' || (e2.message || '').includes('payment_mode'))) {
                                [orderResult] = await fallback('CASH');
                            } else { throw e2; }
                        }
                    } else { throw e; }
                }
            } catch (e) {
                if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054 || (e.message || '').includes('Unknown column'))) {
                    // Pre-Delta_001 schema: no order_type/table_id (and no PENDING mode).
                    [orderResult] = await connection.execute(
                        `INSERT INTO pos_orders (tenant_id, order_code, subtotal, discount, cgst_amount, sgst_amount, total_amount, payment_mode, customer_name, customer_phone)
                         VALUES (?, ?, ?, 0, 0, 0, ?, 'CASH', ?, ?)`,
                        [table.tenant_id, orderCode, subtotal, subtotal, String(customerName).trim(), String(customerPhone).trim()]
                    );
                } else { throw e; }
            }
            // Online delivery location (Delta_016; best-effort).
            if (onlineMode && onlineLoc) {
                try {
                    await connection.execute(
                        `UPDATE pos_orders SET customer_address=?, customer_landmark=?, customer_lat=?, customer_lng=? WHERE tenant_id=? AND id=?`,
                        [onlineLoc.address, onlineLoc.landmark, onlineLoc.lat, onlineLoc.lng, table.tenant_id, orderResult.insertId]
                    );
                } catch {}
            }
            for (const it of cleanItems) {
                await connection.execute(
                    `INSERT INTO pos_order_items (tenant_id, order_id, product_id, item_name, item_category, item_image, quantity, unit_price, line_total)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [table.tenant_id, orderResult.insertId, it.id, it.name, it.category, it.image, it.qty, it.price, it.price * it.qty]
                );
            }
            if (!onlineMode) {
                try {
                    await connection.execute(`UPDATE pos_tables SET status='CUSTOMER_ORDERED', current_order_code=? WHERE tenant_id=? AND id=?`, [orderCode, table.tenant_id, table.id]);
                } catch (e) {
                    // Delta_009 not applied yet: fall back to OCCUPIED.
                    if (e && (e.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' || (e.message || '').includes('CUSTOMER_ORDERED'))) {
                        await connection.execute(`UPDATE pos_tables SET status='OCCUPIED', current_order_code=? WHERE tenant_id=? AND id=?`, [orderCode, table.tenant_id, table.id]);
                    } else { throw e; }
                }
            }
            await connection.commit();
            connection.release();
        } catch (e) {
            try { await connection.rollback(); } catch {}
            connection.release();
            throw e;
        }

        res.status(201).json({ success: true, data: { orderCode, tableNo: table.table_no, total: subtotal, isOnline: onlineMode } });
    } catch (e) {
        console.error('Public table order error:', e);
        res.status(500).json({ success: false, message: 'Could not place order' });
    }
});

// ---- Public online-order status lookup by phone (no auth) ----
// GET /online-order/status/:code?phone=... — latest ONLINE order for this
// phone at this table. Lets a refreshed/returning customer see their order
// without being able to modify it.
router.get('/online-order/status/:code', async (req, res) => {
    try {
        if (!(await ensureMenuCodeColumn())) {
            return res.status(500).json({ success: false, message: 'Table menu links are not set up yet' });
        }
        const tables = await db.query(
            'SELECT id, tenant_id, table_no FROM pos_tables WHERE menu_code = ? AND is_active = 1 LIMIT 1',
            [req.params.code]
        );
        if (!tables.length) return res.status(404).json({ success: false, message: 'Table link not found' });
        const table = tables[0];
        if (!isOnlineTable(table)) return res.status(400).json({ success: false, message: 'Not an online ordering link' });
        const phone = String(req.query.phone || '').trim();
        if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
        const orows = await db.query(
            `SELECT id, order_code, subtotal, total_amount, payment_mode, customer_name, customer_phone, customer_address, customer_landmark, kitchen_notes, order_status, created_at
             FROM pos_orders
             WHERE tenant_id = ? AND table_id = ? AND order_type = 'ONLINE' AND customer_phone = ?
             ORDER BY created_at DESC LIMIT 10`,
            [table.tenant_id, table.id, phone]
        );
        if (!orows.length) return res.json({ success: true, data: { order: null, history: [] } });
        const FINAL = ['COMPLETED', 'PAID', 'CANCELLED', 'REJECTED'];
        const mapOrder = (o, items) => ({
            orderCode: o.order_code,
            orderStatus: o.order_status,
            paymentMode: o.payment_mode || '',
            paymentPending: !['PAID', 'COMPLETED'].includes(String(o.order_status || '').toUpperCase()),
            customerName: o.customer_name || '',
            customerPhone: o.customer_phone || '',
            address: o.customer_address || '',
            landmark: o.customer_landmark || '',
            kitchenNotes: o.kitchen_notes || '',
            subtotal: Number(o.subtotal || 0),
            total: Number(o.total_amount ?? o.subtotal ?? 0),
            createdAt: o.created_at,
            locked: !FINAL.includes(String(o.order_status || '').toUpperCase()),
            items,
        });
        const withItems = [];
        for (const o of orows) {
            const irows = await db.query(
                `SELECT item_name, quantity, unit_price, line_total FROM pos_order_items WHERE tenant_id = ? AND order_id = ? ORDER BY id ASC`,
                [table.tenant_id, o.id]
            );
            withItems.push(mapOrder(o, irows.map((r) => ({
                name: r.item_name,
                qty: Number(r.quantity || 0),
                price: Number(r.unit_price || 0),
                lineTotal: Number(r.line_total ?? (Number(r.unit_price || 0) * Number(r.quantity || 0))),
            }))));
        }
        // Existing review flags for past (final) orders.
        try {
            const codes = withItems.map((o) => o.orderCode);
            const ph = codes.map(() => '?').join(',');
            const rrows = await db.query(
                `SELECT order_code, overall_rating FROM pos_reviews WHERE tenant_id = ? AND order_code IN (${ph})`,
                [table.tenant_id, ...codes]
            );
            const rated = new Map(rrows.map((r) => [r.order_code, Number(r.overall_rating || 0)]));
            for (const o of withItems) o.userRating = rated.get(o.orderCode) || 0;
        } catch {}
        const live = withItems.find((o) => o.locked) || null;
        res.json({
            success: true,
            data: {
                order: live,
                history: withItems.filter((o) => !o.locked),
            }
        });
    } catch (e) {
        console.error('Online order status error:', e);
        res.status(500).json({ success: false, message: 'Could not load order status' });
    }
});

// ---- Public rating/review submit from a table QR menu (no auth) ----
// Body: { overallRating (1-5, required), reviewText (max 250), itemRatings: [{name, rating}] }
// Allowed only while the table is HAVING_FOOD with a live order. One review per
// order — resubmitting updates the previous review.
router.post('/review/:code', async (req, res) => {
    try {
        const { overallRating, reviewText, itemRatings, orderCode: bodyOrderCode } = req.body || {};
        const overall = Math.max(1, Math.min(5, Number(overallRating) || 0));
        if (!overall) return res.status(400).json({ success: false, message: 'Please give an overall rating' });
        const text = reviewText ? String(reviewText).slice(0, 250) : '';
        const tables = await db.query(
            'SELECT id, tenant_id, table_no, status, current_order_code FROM pos_tables WHERE menu_code = ? AND is_active = 1 LIMIT 1',
            [req.params.code]
        );
        if (!tables.length) return res.status(404).json({ success: false, message: 'Table link not found' });
        const table = tables[0];
        let orderCodeToRate;
        if (isOnlineTable(table) && bodyOrderCode) {
            // Online: rate any of your own PAID/COMPLETED delivery orders.
            const orows = await db.query(
                `SELECT id, order_code, customer_name, customer_phone, order_status FROM pos_orders
                 WHERE tenant_id = ? AND table_id = ? AND order_type = 'ONLINE' AND order_code = ? LIMIT 1`,
                [table.tenant_id, table.id, String(bodyOrderCode)]
            );
            if (!orows.length) return res.status(400).json({ success: false, message: 'Order not found' });
            if (!['PAID', 'COMPLETED'].includes(String(orows[0].order_status || '').toUpperCase())) {
                return res.status(400).json({ success: false, message: 'You can rate this order once it is completed' });
            }
            orderCodeToRate = orows[0].order_code;
        } else {
            if (String(table.status || '').toUpperCase() !== 'HAVING_FOOD' || !table.current_order_code) {
                return res.status(400).json({ success: false, message: 'Reviews open after your food is served' });
            }
            orderCodeToRate = table.current_order_code;
        }
        const orows = await db.query(`SELECT id, customer_name, customer_phone FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1`, [table.tenant_id, orderCodeToRate]);
        if (!orows.length) return res.status(400).json({ success: false, message: 'Order not found' });
        const ord = orows[0];
        const cleanItems = Array.isArray(itemRatings)
            ? itemRatings
                .map((r) => ({ name: String(r.name || '').slice(0, 200), rating: Math.max(1, Math.min(5, Number(r.rating) || 0)) }))
                .filter((r) => r.name && r.rating)
                .slice(0, 100)
            : [];
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const existing = await connection.execute(`SELECT id FROM pos_reviews WHERE tenant_id=? AND order_code=? LIMIT 1`, [table.tenant_id, orderCodeToRate]);
            let reviewId = existing[0] && existing[0][0] ? existing[0][0].id : null;
            if (reviewId) {
                await connection.execute(`UPDATE pos_reviews SET overall_rating=?, review_text=?, customer_name=?, customer_phone=? WHERE tenant_id=? AND id=?`, [overall, text || null, ord.customer_name || null, ord.customer_phone || null, table.tenant_id, reviewId]);
                await connection.execute(`DELETE FROM pos_review_items WHERE tenant_id=? AND review_id=?`, [table.tenant_id, reviewId]);
            } else {
                const [result] = await connection.execute(
                    `INSERT INTO pos_reviews (tenant_id, order_id, order_code, table_id, customer_name, customer_phone, overall_rating, review_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [table.tenant_id, ord.id, orderCodeToRate, table.id, ord.customer_name || null, ord.customer_phone || null, overall, text || null]
                );
                reviewId = result.insertId;
            }
            for (const it of cleanItems) {
                await connection.execute(`INSERT INTO pos_review_items (tenant_id, review_id, item_name, rating) VALUES (?, ?, ?, ?)`, [table.tenant_id, reviewId, it.name, it.rating]);
            }
            await connection.commit();
            connection.release();
        } catch (e) {
            try { await connection.rollback(); } catch {}
            connection.release();
            throw e;
        }
        res.status(201).json({ success: true, message: 'Thank you for your feedback!' });
    } catch (e) {
        console.error('Public review error:', e);
        const msg = (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) ? 'Reviews are not set up yet' : 'Could not save review';
        res.status(500).json({ success: false, message: msg });
    }
});

router.use(authMiddleware);
// tables only — no floor concept
router.get('/', async (req,res)=>{
    try{
        const hasCode = await ensureMenuCodeColumn();
        const r=await db.query(
            'SELECT t.* FROM pos_tables t WHERE t.tenant_id=? AND t.is_active=1 ORDER BY t.table_no',
            [req.user.tenant_id]
        );
        // Backfill missing menu codes so every table gets a unique link.
        if (hasCode) {
            for (const t of r) {
                if (!t.menu_code) {
                    const code = newMenuCode();
                    try {
                        await db.query('UPDATE pos_tables SET menu_code=? WHERE tenant_id=? AND id=?', [code, req.user.tenant_id, t.id]);
                        t.menu_code = code;
                    } catch (e) { /* ignore duplicate race */ }
                }
            }
        }
        // occupied_since: when the current order started (for live timers).
        try {
            const codes = r.filter((t) => t.current_order_code).map((t) => t.current_order_code);
            if (codes.length) {
                const ph = codes.map(() => '?').join(',');
                const orows = await db.query(
                    `SELECT order_code, created_at FROM pos_orders WHERE tenant_id = ? AND order_code IN (${ph})`,
                    [req.user.tenant_id, ...codes]
                );
                const m = new Map(orows.map((o) => [o.order_code, o.created_at]));
                for (const t of r) t.occupied_since = m.get(t.current_order_code) || null;
            }
        } catch { /* timers optional */ }
        res.json({success:true,data:r});
    } catch(e){ res.status(500).json({success:false,message:'Error fetching tables'}); }
});
router.post('/', async (req,res)=>{
    try{
        const {table_no,seats}=req.body;
        if(!table_no || !String(table_no).trim()) return res.status(400).json({success:false,message:'table name required'});
        const hasCode = await ensureMenuCodeColumn();
        if (hasCode) {
            const code = newMenuCode();
            const r=await db.query('INSERT INTO pos_tables (tenant_id,table_no,seats,menu_code) VALUES (?,?,?,?)',[req.user.tenant_id,String(table_no).trim(),Number(seats)||4,code]);
            return res.status(201).json({success:true,data:{id:r.insertId,menu_code:code}});
        }
        const r=await db.query('INSERT INTO pos_tables (tenant_id,table_no,seats) VALUES (?,?,?)',[req.user.tenant_id,String(table_no).trim(),Number(seats)||4]);
        res.status(201).json({success:true,data:{id:r.insertId}});
    } catch(e){ res.status(500).json({success:false,message:'Table exists or error'}); }
});
router.put('/:id/status', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET status=?,current_order_code=? WHERE tenant_id=? AND id=?',[req.body.status||'FREE',req.body.current_order_code||null,req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error updating table'}); } });
router.delete('/:id', async (req,res)=>{ try{ await db.query('UPDATE pos_tables SET is_active=0 WHERE tenant_id=? AND id=?',[req.user.tenant_id,req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({success:false,message:'Error deleting table'}); } });
module.exports = router;
