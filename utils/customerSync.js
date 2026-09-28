// Auto-record customers from orders (POS + public menu + online).
// Never throws — customer sync must never break order placement.
const db = require('./database');

function normType(t) {
    const s = String(t || '').toUpperCase();
    if (s.includes('ONLINE')) return 'ONLINE';
    if (s.includes('DINE')) return 'DINEIN';
    return 'TAKEAWAY';
}

async function recordCustomerFromOrder(tenantId, { name, phone, amount, orderType }) {
    try {
        const cleanPhone = String(phone || '').trim().slice(0, 20);
        if (!cleanPhone) return;
        const cleanName = String(name || '').trim().slice(0, 150) || null;
        const total = Math.max(0, Number(amount || 0) || 0);
        const otype = normType(orderType);

        const existing = await db.query(
            'SELECT id FROM pos_customers WHERE tenant_id = ? AND phone = ? LIMIT 1',
            [tenantId, cleanPhone]
        );
        if (existing.length) {
            // Refresh name (latest wins when provided), bump counters.
            try {
                await db.query(
                    `UPDATE pos_customers
                     SET name = COALESCE(?, name), total_orders = total_orders + 1,
                         total_spent = total_spent + ?, last_order_type = ?, last_ordered_at = NOW()
                     WHERE tenant_id = ? AND id = ?`,
                    [cleanName, total, otype, tenantId, existing[0].id]
                );
            } catch (e) {
                // Delta_017 not applied yet: update without new columns.
                if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
                    await db.query(
                        `UPDATE pos_customers
                         SET name = COALESCE(?, name), total_orders = total_orders + 1,
                             total_spent = total_spent + ?
                         WHERE tenant_id = ? AND id = ?`,
                        [cleanName, total, tenantId, existing[0].id]
                    );
                } else { throw e; }
            }
        } else {
            try {
                await db.query(
                    `INSERT INTO pos_customers (tenant_id, name, phone, total_orders, total_spent, last_order_type, last_ordered_at)
                     VALUES (?, ?, ?, 1, ?, ?, NOW())`,
                    [tenantId, cleanName || cleanPhone, cleanPhone, total, otype]
                );
            } catch (e) {
                if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
                    await db.query(
                        `INSERT INTO pos_customers (tenant_id, name, phone, total_orders, total_spent)
                         VALUES (?, ?, ?, 1, ?)`,
                        [tenantId, cleanName || cleanPhone, cleanPhone, total]
                    );
                } else { throw e; }
            }
        }
    } catch {
        // Intentionally silent.
    }
}

module.exports = { recordCustomerFromOrder, normType };
