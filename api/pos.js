const express = require('express');
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

const router = express.Router();

// Public bill fetch (no auth — opened on customer phone).
// Returns the same object POS stored via POST /api/pos/orders, looked up by order_code.
router.get('/bills/:orderId', async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '').trim();
        if (!orderId) return res.status(404).json({ success: false, message: 'Bill not found' });
        const orderRows = await db.query(
            `SELECT id, tenant_id, order_code, created_at, subtotal, discount, cgst_amount, sgst_amount,
                    total_amount, payment_mode, customer_name, customer_phone
             FROM pos_orders WHERE order_code = ? LIMIT 1`,
            [orderId]
        );
        if (!orderRows.length) return res.status(404).json({ success: false, message: 'Bill not found' });
        const o = orderRows[0];
        let store = {};
        try {
            const srows = await db.query(
                `SELECT restaurant_name, receipt_header, receipt_footer, currency_symbol
                 FROM pos_settings WHERE tenant_id = ? LIMIT 1`,
                [o.tenant_id]
            );
            store = srows[0] || {};
        } catch (e) { /* settings optional */ }
        const itemRows = await db.query(
            `SELECT oi.quantity, oi.unit_price, oi.line_total, oi.item_name, oi.item_category, oi.item_image
             FROM pos_order_items oi WHERE oi.order_id = ? ORDER BY oi.id ASC`,
            [o.id]
        );
        // Normalize possible legacy flexible field shapes
        const items = itemRows.map((r, i) => ({
            id: i + 1,
            name: r.item_name,
            price: Number(r.unit_price),
            qty: Number(r.quantity),
        }));
        res.json({
            success: true,
            data: {
                id: o.order_code,
                timestamp: new Date(o.created_at).getTime(),
                items,
                subtotal: Number(o.subtotal),
                discount: Number(o.discount),
                cgst: Number(o.cgst_amount),
                sgst: Number(o.sgst_amount),
                total: Number(o.total_amount),
                paymentMode: o.payment_mode,
                customerName: o.customer_name || undefined,
                customerPhone: o.customer_phone || undefined,
                businessName: store.restaurant_name || undefined,
                restaurantName: store.restaurant_name || undefined,
                receiptHeader: store.receipt_header || undefined,
                receiptFooter: store.receipt_footer || undefined,
                currencySymbol: store.currency_symbol || undefined,
            },
        });
    } catch (e) {
        console.error('Public bill fetch error:', e);
        res.status(500).json({ success: false, message: 'Error fetching bill' });
    }
});

router.use(authMiddleware);

const DEFAULT_SETTINGS = {
    restaurantName: 'Intelli Billing Software',
    currencySymbol: 'Rs.',
    cgstPercent: 2.5,
    sgstPercent: 2.5,
    taxInclusive: false,
    enableKot: true,
    printerConnectionType: 'bluetooth',
    paperWidth: '3inch',
    receiptHeader: 'Welcome to Intelli Billing!',
    receiptFooter: 'Thank you for visiting!',
    orderAfterBill: false,
    businessType: 'FOOD',
    enableBarcode: false,
    enableStock: false,
    allowSaleWhenOutOfStock: true
};

const mapSettingsRow = (row) => ({
    restaurantName: row?.restaurant_name ?? DEFAULT_SETTINGS.restaurantName,
    currencySymbol: row?.currency_symbol ?? DEFAULT_SETTINGS.currencySymbol,
    cgstPercent: Number(row?.cgst_percent ?? DEFAULT_SETTINGS.cgstPercent),
    sgstPercent: Number(row?.sgst_percent ?? DEFAULT_SETTINGS.sgstPercent),
    taxInclusive: Boolean(row?.tax_inclusive ?? DEFAULT_SETTINGS.taxInclusive),
    enableKot: Boolean(row?.enable_kot ?? DEFAULT_SETTINGS.enableKot),
    printerConnectionType: row?.printer_connection_type ?? DEFAULT_SETTINGS.printerConnectionType,
    paperWidth: row?.paper_width ?? DEFAULT_SETTINGS.paperWidth,
    receiptHeader: row?.receipt_header ?? DEFAULT_SETTINGS.receiptHeader,
    receiptFooter: row?.receipt_footer ?? DEFAULT_SETTINGS.receiptFooter,
    orderAfterBill: Boolean(row?.order_after_bill ?? DEFAULT_SETTINGS.orderAfterBill),
    businessType: row?.business_type ?? DEFAULT_SETTINGS.businessType,
    enableBarcode: Boolean(row?.enable_barcode ?? DEFAULT_SETTINGS.enableBarcode),
    enableStock: Boolean(row?.enable_stock ?? DEFAULT_SETTINGS.enableStock),
    allowSaleWhenOutOfStock: row?.allow_sale_out_of_stock === undefined || row?.allow_sale_out_of_stock === null
        ? DEFAULT_SETTINGS.allowSaleWhenOutOfStock
        : Boolean(row.allow_sale_out_of_stock)
});

const toDbFlag = (value, defaultValue) => {
    if (value === undefined || value === null) return defaultValue ? 1 : 0;
    return value ? 1 : 0;
};

const mapMenuItem = (row) => ({
    id: String(row.id),
    name: row.name,
    price: Number(row.price),
    image: row.image_url || '',
    category: row.category_name,
    barcode: row?.barcode || '',
    stock: row?.stock === undefined || row?.stock === null ? 0 : Number(row.stock)
});

async function getSettings(tenantId) {
    try {
        const rows = await db.query(
            `SELECT restaurant_name, currency_symbol, cgst_percent, sgst_percent, tax_inclusive, enable_kot, printer_connection_type, paper_width, receipt_header, receipt_footer, order_after_bill, business_type, enable_barcode, enable_stock, allow_sale_out_of_stock
             FROM pos_settings
             WHERE tenant_id = ?
             LIMIT 1`,
            [tenantId]
        );

        return mapSettingsRow(rows[0]);
    } catch (error) {
        // Fallback for databases where deltas were never applied
        // (missing order_after_bill / business_type / inventory columns).
        if (error && (error.code === 'ER_BAD_FIELD_ERROR' || (error.message || '').includes('Unknown column'))) {
            const rows = await db.query(
                `SELECT restaurant_name, currency_symbol, cgst_percent, sgst_percent, tax_inclusive, enable_kot, printer_connection_type, paper_width, receipt_header, receipt_footer
                 FROM pos_settings
                 WHERE tenant_id = ?
                 LIMIT 1`,
                [tenantId]
            );
            return mapSettingsRow(rows[0]);
        }
        throw error;
    }
}

async function getMenuItems(tenantId) {
    try {
        const rows = await db.query(
            `SELECT
                p.id,
                p.name,
                p.price,
                p.image_url,
                p.barcode,
                p.stock,
                c.name AS category_name
             FROM pos_products p
             INNER JOIN pos_categories c ON c.id = p.category_id
             WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
             ORDER BY c.sort_order ASC, c.name ASC, p.sort_order ASC, p.name ASC`,
            [tenantId, tenantId]
        );

        return rows.map(mapMenuItem);
    } catch (error) {
        // Fallback for databases where Delta_002 was never applied.
        if (error && (error.code === 'ER_BAD_FIELD_ERROR' || (error.message || '').includes('Unknown column'))) {
            const rows = await db.query(
                `SELECT
                    p.id,
                    p.name,
                    p.price,
                    p.image_url,
                    c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND c.tenant_id = ? AND p.is_active = 1 AND c.is_active = 1
                 ORDER BY c.sort_order ASC, c.name ASC, p.sort_order ASC, p.name ASC`,
                [tenantId, tenantId]
            );
            return rows.map(mapMenuItem);
        }
        throw error;
    }
}

async function getCategories(tenantId) {
    const rows = await db.query(
        `SELECT id, name, sort_order
         FROM pos_categories
         WHERE tenant_id = ? AND is_active = 1
         ORDER BY sort_order ASC, name ASC`,
        [tenantId]
    );

    return rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        sortOrder: Number(row.sort_order)
    }));
}

async function getOrders(tenantId, limit = 100) {
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;

    const orderRows = await db.query(
        `SELECT
            id,
            order_code,
            created_at,
            subtotal,
            discount,
            cgst_amount,
            sgst_amount,
            total_amount,
            payment_mode,
            customer_name,
            customer_phone
         FROM pos_orders
         WHERE tenant_id = ?
         ORDER BY created_at DESC
         LIMIT ${safeLimit}`,
        [tenantId]
    );

    if (orderRows.length === 0) {
        return [];
    }

    const orderIds = orderRows.map((order) => order.id);
    const placeholders = orderIds.map(() => '?').join(',');

    const itemRows = await db.query(
        `SELECT
            oi.order_id,
            oi.quantity,
            oi.unit_price,
            oi.line_total,
            oi.item_name,
            oi.item_image,
            oi.item_category
         FROM pos_order_items oi
         WHERE oi.tenant_id = ? AND oi.order_id IN (${placeholders})
         ORDER BY oi.id ASC`,
        [tenantId, ...orderIds]
    );

    const itemsByOrderId = itemRows.reduce((acc, row) => {
        const items = acc.get(row.order_id) || [];
        items.push({
            id: `${row.order_id}-${items.length + 1}`,
            name: row.item_name,
            price: Number(row.unit_price),
            image: row.item_image || '',
            category: row.item_category || 'General',
            qty: Number(row.quantity),
            lineTotal: Number(row.line_total)
        });
        acc.set(row.order_id, items);
        return acc;
    }, new Map());

    return orderRows.map((row) => ({
        id: row.order_code,
        timestamp: new Date(row.created_at).getTime(),
        items: itemsByOrderId.get(row.id) || [],
        subtotal: Number(row.subtotal),
        discount: Number(row.discount),
        cgst: Number(row.cgst_amount),
        sgst: Number(row.sgst_amount),
        total: Number(row.total_amount),
        paymentMode: row.payment_mode,
        customerName: row.customer_name || undefined,
        customerPhone: row.customer_phone || undefined
    }));
}

router.get('/bootstrap', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const [settings, menuItems, orders, categories] = await Promise.all([
            getSettings(tenantId),
            getMenuItems(tenantId),
            getOrders(tenantId, 200),
            getCategories(tenantId)
        ]);

        res.json({
            success: true,
            data: { settings, menuItems, orders, categories }
        });
    } catch (error) {
        console.error('POS bootstrap error:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading POS data'
        });
    }
});

router.put('/settings', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const {
            restaurantName,
            currencySymbol,
            cgstPercent,
            sgstPercent,
            taxInclusive,
            enableKot,
            printerConnectionType,
            paperWidth,
            receiptHeader,
            receiptFooter,
            orderAfterBill,
        businessType,
            enableBarcode,
            enableStock,
            allowSaleWhenOutOfStock
        } = req.body;

        const safeBusinessType = (['FOOD','RETAIL','SERVICES','GENERAL'].indexOf(businessType) >= 0 ? businessType : 'FOOD');

        try {
        await db.query(
            `INSERT INTO pos_settings (
                tenant_id,
                restaurant_name,
                currency_symbol,
                cgst_percent,
                sgst_percent,
                tax_inclusive,
                enable_kot,
                printer_connection_type,
                paper_width,
                receipt_header,
                receipt_footer,
                order_after_bill, business_type, enable_barcode, enable_stock, allow_sale_out_of_stock
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                restaurant_name = VALUES(restaurant_name),
                currency_symbol = VALUES(currency_symbol),
                cgst_percent = VALUES(cgst_percent),
                sgst_percent = VALUES(sgst_percent),
                tax_inclusive = VALUES(tax_inclusive),
                enable_kot = VALUES(enable_kot),
                printer_connection_type = VALUES(printer_connection_type),
                paper_width = VALUES(paper_width),
                receipt_header = VALUES(receipt_header),
                receipt_footer = VALUES(receipt_footer),
                order_after_bill = VALUES(order_after_bill),
                business_type = VALUES(business_type),
                enable_barcode = VALUES(enable_barcode),
                enable_stock = VALUES(enable_stock),
                allow_sale_out_of_stock = VALUES(allow_sale_out_of_stock)`,
            [
                tenantId,
                restaurantName,
                currencySymbol,
                Number(cgstPercent || 0),
                Number(sgstPercent || 0),
                taxInclusive ? 1 : 0,
                enableKot === false ? 0 : 1,
                printerConnectionType === 'usb' ? 'usb' : 'bluetooth',
                paperWidth === '2inch' ? '2inch' : '3inch',
                receiptHeader,
                receiptFooter,
                orderAfterBill ? 1 : 0,
            safeBusinessType,
                toDbFlag(enableBarcode, false),
                toDbFlag(enableStock, false),
                toDbFlag(allowSaleWhenOutOfStock, true)
            ]
        );
        } catch (dbError) {
            // Fallback when optional columns don't exist yet (Delta_001 not applied).
            if (dbError && (dbError.code === 'ER_BAD_FIELD_ERROR' || (dbError.message || '').includes('Unknown column'))) {
                await db.query(
                    `INSERT INTO pos_settings (
                        tenant_id,
                        restaurant_name,
                        currency_symbol,
                        cgst_percent,
                        sgst_percent,
                        tax_inclusive,
                        enable_kot,
                        printer_connection_type,
                        paper_width,
                        receipt_header,
                        receipt_footer
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        restaurant_name = VALUES(restaurant_name),
                        currency_symbol = VALUES(currency_symbol),
                        cgst_percent = VALUES(cgst_percent),
                        sgst_percent = VALUES(sgst_percent),
                        tax_inclusive = VALUES(tax_inclusive),
                        enable_kot = VALUES(enable_kot),
                        printer_connection_type = VALUES(printer_connection_type),
                        paper_width = VALUES(paper_width),
                        receipt_header = VALUES(receipt_header),
                        receipt_footer = VALUES(receipt_footer)`,
                    [
                        tenantId,
                        restaurantName,
                        currencySymbol,
                        Number(cgstPercent || 0),
                        Number(sgstPercent || 0),
                        taxInclusive ? 1 : 0,
                        enableKot === false ? 0 : 1,
                        printerConnectionType === 'usb' ? 'usb' : 'bluetooth',
                        paperWidth === '2inch' ? '2inch' : '3inch',
                        receiptHeader,
                        receiptFooter
                    ]
                );
            } else {
                throw dbError;
            }
        }

        res.json({
            success: true,
            data: await getSettings(tenantId)
        });
    } catch (error) {
        console.error('POS settings update error:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving POS settings'
        });
    }
});

router.get('/categories', async (req, res) => {
    try {
        res.json({
            success: true,
            data: await getCategories(req.user.tenant_id)
        });
    } catch (error) {
        console.error('POS get categories error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching categories'
        });
    }
});

router.post('/categories', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { name } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Category name is required'
            });
        }

        const trimmedName = name.trim();
        const existing = await db.query(
            'SELECT id, name, sort_order FROM pos_categories WHERE tenant_id = ? AND name = ? LIMIT 1',
            [tenantId, trimmedName]
        );

        if (existing.length > 0) {
            return res.json({
                success: true,
                data: {
                    id: String(existing[0].id),
                    name: existing[0].name,
                    sortOrder: Number(existing[0].sort_order)
                }
            });
        }

        const maxSortRows = await db.query(
            'SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM pos_categories WHERE tenant_id = ?',
            [tenantId]
        );
        const nextSortOrder = Number(maxSortRows[0]?.max_sort_order || 0) + 1;

        const result = await db.query(
            `INSERT INTO pos_categories (tenant_id, name, sort_order, is_active)
             VALUES (?, ?, ?, 1)`,
            [tenantId, trimmedName, nextSortOrder]
        );

        res.status(201).json({
            success: true,
            data: {
                id: String(result.insertId),
                name: trimmedName,
                sortOrder: nextSortOrder
            }
        });
    } catch (error) {
        console.error('POS create category error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating category'
        });
    }
});

router.put('/categories/:id', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { name } = req.body;
        const { id } = req.params;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Category name is required'
            });
        }

        const duplicate = await db.query(
            'SELECT id FROM pos_categories WHERE tenant_id = ? AND name = ? AND id <> ? LIMIT 1',
            [tenantId, name.trim(), id]
        );

        if (duplicate.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Category name already exists'
            });
        }

        await db.query(
            'UPDATE pos_categories SET name = ? WHERE tenant_id = ? AND id = ?',
            [name.trim(), tenantId, id]
        );

        res.json({
            success: true,
            data: (await getCategories(tenantId)).find(category => category.id === String(id))
        });
    } catch (error) {
        console.error('POS update category error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating category'
        });
    }
});

router.delete('/categories/:id', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { id } = req.params;

        const products = await db.query(
            'SELECT COUNT(*) AS product_count FROM pos_products WHERE tenant_id = ? AND category_id = ? AND is_active = 1',
            [tenantId, id]
        );

        if (Number(products[0]?.product_count || 0) > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete a category that still has active inventory items'
            });
        }

        await db.query(
            'UPDATE pos_categories SET is_active = 0 WHERE tenant_id = ? AND id = ?',
            [tenantId, id]
        );

        res.json({
            success: true,
            message: 'Category deleted successfully'
        });
    } catch (error) {
        console.error('POS delete category error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting category'
        });
    }
});

router.post('/menu-items', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { name, price, image, category, barcode, stock } = req.body;

        if (!name || price === undefined || price === null || !category) {
            return res.status(400).json({
                success: false,
                message: 'name, price, and category are required'
            });
        }

        const safeBarcode = (barcode || '').toString().trim() || null;
        const safeStock = Math.max(0, Number(stock ?? 0) || 0);

        const existingCategory = await db.query(
            'SELECT id FROM pos_categories WHERE tenant_id = ? AND name = ? LIMIT 1',
            [tenantId, category.trim()]
        );

        let categoryId = existingCategory[0]?.id;

        if (!categoryId) {
            const categoryResult = await db.query(
                `INSERT INTO pos_categories (tenant_id, name, sort_order, is_active)
                 VALUES (?, ?, 999, 1)`,
                [tenantId, category.trim()]
            );
            categoryId = categoryResult.insertId;
        }

        let result;
        try {
            result = await db.query(
                `INSERT INTO pos_products (
                    tenant_id,
                    category_id,
                    name,
                    price,
                    image_url,
                    barcode,
                    stock,
                    sort_order,
                    is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 999, 1)`,
                [tenantId, categoryId, name.trim(), Number(price), image || '', safeBarcode, safeStock]
            );
        } catch (insertError) {
            // Fallback when Delta_002 columns don't exist yet.
            if (insertError && (insertError.code === 'ER_BAD_FIELD_ERROR' || (insertError.message || '').includes('Unknown column'))) {
                result = await db.query(
                    `INSERT INTO pos_products (
                        tenant_id,
                        category_id,
                        name,
                        price,
                        image_url,
                        sort_order,
                        is_active
                    ) VALUES (?, ?, ?, ?, ?, 999, 1)`,
                    [tenantId, categoryId, name.trim(), Number(price), image || '']
                );
            } else {
                throw insertError;
            }
        }

        let createdRows;
        try {
            createdRows = await db.query(
                `SELECT
                    p.id,
                    p.name,
                    p.price,
                    p.image_url,
                    p.barcode,
                    p.stock,
                    c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND p.id = ?`,
                [tenantId, result.insertId]
            );
        } catch (selectError) {
            if (selectError && (selectError.code === 'ER_BAD_FIELD_ERROR' || (selectError.message || '').includes('Unknown column'))) {
                createdRows = await db.query(
                    `SELECT
                        p.id,
                        p.name,
                        p.price,
                        p.image_url,
                        c.name AS category_name
                     FROM pos_products p
                     INNER JOIN pos_categories c ON c.id = p.category_id
                     WHERE p.tenant_id = ? AND p.id = ?`,
                    [tenantId, result.insertId]
                );
            } else {
                throw selectError;
            }
        }

        res.status(201).json({
            success: true,
            data: mapMenuItem(createdRows[0])
        });
    } catch (error) {
        console.error('POS create menu item error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating menu item'
        });
    }
});

router.put('/menu-items/:id', async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { id } = req.params;
        const { name, price, image, category, barcode, stock } = req.body;

        if (!name || price === undefined || price === null || !category) {
            return res.status(400).json({
                success: false,
                message: 'name, price, and category are required'
            });
        }

        const existingItem = await db.query(
            'SELECT id FROM pos_products WHERE tenant_id = ? AND id = ? AND is_active = 1 LIMIT 1',
            [tenantId, id]
        );

        if (existingItem.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Menu item not found'
            });
        }

        const existingCategory = await db.query(
            'SELECT id FROM pos_categories WHERE tenant_id = ? AND name = ? AND is_active = 1 LIMIT 1',
            [tenantId, category.trim()]
        );

        let categoryId = existingCategory[0]?.id;

        if (!categoryId) {
            const categoryResult = await db.query(
                `INSERT INTO pos_categories (tenant_id, name, sort_order, is_active)
                 VALUES (?, ?, 999, 1)`,
                [tenantId, category.trim()]
            );
            categoryId = categoryResult.insertId;
        }

        const safeBarcode = (barcode || '').toString().trim() || null;
        const safeStock = Math.max(0, Number(stock ?? 0) || 0);

        try {
            await db.query(
                `UPDATE pos_products
                 SET category_id = ?, name = ?, price = ?, image_url = ?, barcode = ?, stock = ?
                 WHERE tenant_id = ? AND id = ?`,
                [categoryId, name.trim(), Number(price), image || '', safeBarcode, safeStock, tenantId, id]
            );
        } catch (updateError) {
            // Fallback when Delta_002 columns don't exist yet.
            if (updateError && (updateError.code === 'ER_BAD_FIELD_ERROR' || (updateError.message || '').includes('Unknown column'))) {
                await db.query(
                    `UPDATE pos_products
                     SET category_id = ?, name = ?, price = ?, image_url = ?
                     WHERE tenant_id = ? AND id = ?`,
                    [categoryId, name.trim(), Number(price), image || '', tenantId, id]
                );
            } else {
                throw updateError;
            }
        }

        let updatedRows;
        try {
            updatedRows = await db.query(
                `SELECT
                    p.id,
                    p.name,
                    p.price,
                    p.image_url,
                    p.barcode,
                    p.stock,
                    c.name AS category_name
                 FROM pos_products p
                 INNER JOIN pos_categories c ON c.id = p.category_id
                 WHERE p.tenant_id = ? AND p.id = ?`,
                [tenantId, id]
            );
        } catch (selectError) {
            if (selectError && (selectError.code === 'ER_BAD_FIELD_ERROR' || (selectError.message || '').includes('Unknown column'))) {
                updatedRows = await db.query(
                    `SELECT
                        p.id,
                        p.name,
                        p.price,
                        p.image_url,
                        c.name AS category_name
                     FROM pos_products p
                     INNER JOIN pos_categories c ON c.id = p.category_id
                     WHERE p.tenant_id = ? AND p.id = ?`,
                    [tenantId, id]
                );
            } else {
                throw selectError;
            }
        }

        res.json({
            success: true,
            data: mapMenuItem(updatedRows[0])
        });
    } catch (error) {
        console.error('POS update menu item error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating menu item'
        });
    }
});

router.delete('/menu-items/:id', async (req, res) => {
    try {
        await db.query(
            'UPDATE pos_products SET is_active = 0 WHERE tenant_id = ? AND id = ?',
            [req.user.tenant_id, req.params.id]
        );

        res.json({
            success: true,
            message: 'Menu item deleted successfully'
        });
    } catch (error) {
        console.error('POS delete menu item error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting menu item'
        });
    }
});

router.post('/orders', async (req, res) => {
    const connection = await db.getConnection();

    try {
        const tenantId = req.user.tenant_id;
        const {
            id,
            subtotal,
            discount,
            cgst,
            sgst,
            total,
            paymentMode,
            customerName,
            customerPhone,
            items = []
        } = req.body;

        if (!id || !Array.isArray(items) || items.length === 0) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: 'order id and items are required'
            });
        }

        await connection.beginTransaction();

        const [orderResult] = await connection.execute(
            `INSERT INTO pos_orders (
                tenant_id,
                order_code,
                subtotal,
                discount,
                cgst_amount,
                sgst_amount,
                total_amount,
                payment_mode,
                customer_name,
                customer_phone
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                id,
                Number(subtotal || 0),
                Number(discount || 0),
                Number(cgst || 0),
                Number(sgst || 0),
                Number(total || 0),
                paymentMode || 'CASH',
                customerName || null,
                customerPhone || null
            ]
        );

        for (const item of items) {
            await connection.execute(
                `INSERT INTO pos_order_items (
                    tenant_id,
                    order_id,
                    product_id,
                    item_name,
                    item_category,
                    item_image,
                    quantity,
                    unit_price,
                    line_total
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    orderResult.insertId,
                    Number(item.id) || null,
                    item.name,
                    item.category || 'General',
                    item.image || null,
                    Number(item.qty || 0),
                    Number(item.price || 0),
                    Number(item.price || 0) * Number(item.qty || 0)
                ]
            );
        }

        await connection.commit();
        connection.release();

        res.status(201).json({
            success: true,
            message: 'Order saved successfully'
        });
    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('POS save order error:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving order'
        });
    }
});

router.delete('/orders/:orderCode', authorize('admin'), async (req, res) => {
    const connection = await db.getConnection();

    try {
        const tenantId = req.user.tenant_id;
        const { orderCode } = req.params;

        await connection.beginTransaction();

        const orders = await connection.execute(
            'SELECT id FROM pos_orders WHERE tenant_id = ? AND order_code = ? LIMIT 1',
            [tenantId, orderCode]
        );

        const orderRow = orders[0][0];
        if (!orderRow) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({
                success: false,
                message: 'Sale record not found'
            });
        }

        await connection.execute(
            'DELETE FROM pos_order_items WHERE tenant_id = ? AND order_id = ?',
            [tenantId, orderRow.id]
        );

        await connection.execute(
            'DELETE FROM pos_orders WHERE tenant_id = ? AND id = ?',
            [tenantId, orderRow.id]
        );

        await connection.commit();
        connection.release();

        res.json({
            success: true,
            message: 'Sale record deleted successfully'
        });
    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('POS delete order error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting sale record'
        });
    }
});

module.exports = router;


