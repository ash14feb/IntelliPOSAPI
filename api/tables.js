const express = require('express');
const crypto = require('crypto');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

const newMenuCode = () => crypto.randomBytes(8).toString('hex');

// Active (unpaid) order summary for a table — shown on the public menu so the
// customer sees what was already ordered + the running total.
async function getPublicActiveOrder(table) {
    try {
        const st = String(table.status || '').toUpperCase();
        if ((st !== 'CUSTOMER_ORDERED' && st !== 'HAVING_FOOD') || !table.current_order_code) return null;
        const orows = await db.query(
            `SELECT id, order_code, subtotal, total_amount, customer_name, order_status FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1`,
            [table.tenant_id, table.current_order_code]
        );
        if (!orows.length) return null;
        const o = orows[0];
        if (['PAID', 'COMPLETED', 'CANCELLED'].includes(String(o.order_status || '').toUpperCase())) return null;
        const irows = await db.query(
            `SELECT item_name, quantity, unit_price, line_total FROM pos_order_items WHERE tenant_id=? AND order_id=? ORDER BY id ASC`,
            [table.tenant_id, o.id]
        );
        return {
            orderCode: o.order_code,
            orderStatus: o.order_status,
            customerName: o.customer_name || '',
            subtotal: Number(o.subtotal || 0),
            total: Number(o.total_amount ?? o.subtotal ?? 0),
            items: irows.map((r) => ({
                name: r.item_name,
                qty: Number(r.quantity || 0),
                price: Number(r.unit_price || 0),
                lineTotal: Number(r.line_total ?? (Number(r.unit_price || 0) * Number(r.quantity || 0))),
            })),
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
            items = await db.query(
                `SELECT p.id, p.name, p.price, p.image_url, c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
                 ORDER BY c.sort_order ASC, c.name ASC, p.sort_order ASC, p.name ASC`,
                [table.tenant_id, table.tenant_id]
            );
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Error loading menu' });
        }

        res.json({
            success: true,
            data: {
                table: { table_no: table.table_no, seats: table.seats, status: table.status, current_order_code: table.current_order_code || null },
                restaurantName: settings?.restaurant_name || 'Our Menu',
                currencySymbol: settings?.currency_symbol || 'Rs.',
                tableStatus: table.status,
                activeOrder: await getPublicActiveOrder(table),
                menuItems: items.map(r => ({
                    id: String(r.id),
                    name: r.name,
                    price: Number(r.price),
                    image: r.image_url || '',
                    category: r.category_name
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
        const { items, customerName, customerPhone } = req.body || {};
        if (!customerName || !String(customerName).trim()) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }
        if (!customerPhone || !String(customerPhone).trim()) {
            return res.status(400).json({ success: false, message: 'Phone number is required' });
        }
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
        const tableStatus = String(table.status || 'FREE').toUpperCase();
        const existingOrderCode = table.current_order_code || null;
        // Re-order flow: CUSTOMER_ORDERED or HAVING_FOOD with a live order ->
        // append items and flip status back to CUSTOMER_ORDERED.
        const isAppendFlow = (tableStatus === 'CUSTOMER_ORDERED' || tableStatus === 'HAVING_FOOD') && existingOrderCode;

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
                    `SELECT id, subtotal, total_amount, order_status FROM pos_orders WHERE tenant_id=? AND order_code=? LIMIT 1`,
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
                await connection.execute(`UPDATE pos_orders SET subtotal=?, total_amount=?, order_status='ACTIVE' WHERE tenant_id=? AND id=?`, [newSubtotal, newTotal, table.tenant_id, orow.id]);
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
        if (tableStatus !== 'FREE') {
            return res.status(400).json({ success: false, message: 'This table already has an active order' });
        }
        const orderCode = `WEB-${Date.now()}`;

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            let orderResult;
            const publicInsert = (mode) => connection.execute(
                `INSERT INTO pos_orders (tenant_id, order_code, subtotal, discount, cgst_amount, sgst_amount, total_amount, payment_mode, customer_name, customer_phone, order_type, order_status, table_id)
                 VALUES (?, ?, ?, 0, 0, 0, ?, '${mode}', ?, ?, 'DINEIN', 'ACTIVE', ?)`,
                [table.tenant_id, orderCode, subtotal, subtotal, String(customerName).trim(), String(customerPhone).trim(), table.id]
            );
            try {
                try {
                    [orderResult] = await publicInsert('PENDING');
                } catch (e) {
                    // Delta_010 not applied yet: payment_mode enum lacks PENDING.
                    if (e && (e.errno === 1265 || e.code === 'WARN_DATA_TRUNCATED' || (e.message || '').includes('payment_mode'))) {
                        console.warn('Public order saved as CASH (Delta_010 not applied).');
                        [orderResult] = await publicInsert('CASH');
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
            for (const it of cleanItems) {
                await connection.execute(
                    `INSERT INTO pos_order_items (tenant_id, order_id, product_id, item_name, item_category, item_image, quantity, unit_price, line_total)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [table.tenant_id, orderResult.insertId, it.id, it.name, it.category, it.image, it.qty, it.price, it.price * it.qty]
                );
            }
            try {
                await connection.execute(`UPDATE pos_tables SET status='CUSTOMER_ORDERED', current_order_code=? WHERE tenant_id=? AND id=?`, [orderCode, table.tenant_id, table.id]);
            } catch (e) {
                // Delta_009 not applied yet: fall back to OCCUPIED.
                if (e && (e.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' || (e.message || '').includes('CUSTOMER_ORDERED'))) {
                    await connection.execute(`UPDATE pos_tables SET status='OCCUPIED', current_order_code=? WHERE tenant_id=? AND id=?`, [orderCode, table.tenant_id, table.id]);
                } else { throw e; }
            }
            await connection.commit();
            connection.release();
        } catch (e) {
            try { await connection.rollback(); } catch {}
            connection.release();
            throw e;
        }

        res.status(201).json({ success: true, data: { orderCode, tableNo: table.table_no, total: subtotal } });
    } catch (e) {
        console.error('Public table order error:', e);
        res.status(500).json({ success: false, message: 'Could not place order' });
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
