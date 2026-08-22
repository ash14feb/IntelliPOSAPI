







const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/sales
// @desc    Create a new sale
// @access  Private (Staff, Manager, Admin)
// @route   POST /api/sales
// @desc    Create or Update daily sale per store
// @access  Private (Staff, Manager, Admin)
router.post('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            cash_amount = 0,
            upi_amount = 0,
            card_amount = 0,
            booking_amount = 0,
            product_description = null,
            total_customers = 1,
            notes = null,
            sale_date,
            sale_time,
            sale_datetime
        } = req.body;

        const user_id = req.user.user_id;

        if (!store_id || !sale_date) {
            return res.status(400).json({
                success: false,
                message: 'store_id and sale_date are required'
            });
        }

        const total_amount =
            Number(cash_amount) +
            Number(upi_amount) +
            Number(card_amount) +
            Number(booking_amount);

        // 🔍 Check if sale already exists for store + date
        const existing = await db.query(
            `SELECT sale_id FROM sales 
             WHERE store_id = ? AND sale_date = ?`,
            [store_id, sale_date]
        );

        // 🔁 UPDATE existing record
        if (existing.length > 0) {
            const saleId = existing[0].sale_id;

            await db.query(
                `UPDATE sales SET
                    cash_amount =  ?,
                    upi_amount =  ?,
                    card_amount =  ?,
                    booking_amount =  ?,
                    total_customers =  ?,
                    total_amount =  ?,
                    notes = COALESCE(?, notes)
                 WHERE sale_id = ?`,
                [
                    cash_amount,
                    upi_amount,
                    card_amount,
                    booking_amount,
                    total_customers,
                    total_amount,
                    notes,
                    saleId
                ]
            );

            return res.json({
                success: true,
                message: 'Sale updated for the day',
                sale_id: saleId
            });
        }

        // ➕ INSERT new record
        const result = await db.query(
            `INSERT INTO sales (
                store_id,
                user_id,
                sale_date,
                sale_time,
                sale_datetime,
                cash_amount,
                upi_amount,
                card_amount,
                booking_amount,
                product_description,
                total_customers,
                total_amount,
                notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                store_id,
                user_id,
                sale_date,
                sale_time,
                sale_datetime,
                cash_amount,
                upi_amount,
                card_amount,
                booking_amount,
                product_description,
                total_customers,
                total_amount,
                notes
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Sale created for the day',
            sale_id: result.insertId
        });

    } catch (error) {
        console.error('Create/Update sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving sale'
        });
    }
});


// @route   GET /api/sales/day
// @desc    Get sales data for a specific day
// @access  Private (Staff, Manager, Admin)
router.get('/day', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'date is required in YYYY-MM-DD format'
            });
        }

        const user = req.user;

        let query = `
            SELECT
                s.sale_id,
                DATE(s.sale_date) AS sale_date,
                s.sale_time,
                s.store_id,
                st.store_name,
                st.store_type,
                s.cash_amount,
                s.upi_amount,
                s.card_amount,
                s.booking_amount,
                s.total_amount,
                s.total_customers,
                s.product_description,
                s.notes,
                u.full_name AS staff_name,
                s.created_at
            FROM sales s
            INNER JOIN stores st ON s.store_id = st.store_id
            INNER JOIN users u ON s.user_id = u.user_id
            WHERE DATE(s.sale_date) = ?
        `;

        const params = [date];

        // 🔐 Restrict staff to their store only
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length === 0) {
                return res.json({
                    success: true,
                    date,
                    count: 0,
                    data: []
                });
            }

            const storeIds = stores.map(s => s.store_id);
            query += ` AND s.store_id IN (${storeIds.map(() => '?').join(',')})`;
            params.push(...storeIds);
        }

        query += ' ORDER BY st.store_id ASC, s.sale_time ASC';

        const rows = await db.query(query, params);

        res.json({
            success: true,
            date,
            count: rows.length,
            data: rows
        });

    } catch (error) {
        console.error('Get daily sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching daily sales'
        });
    }
});

router.get('/monthly', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'date is required (YYYY-MM-DD)'
            });
        }

        const query = `
        WITH RECURSIVE calendar AS (
            SELECT DATE_FORMAT(?, '%Y-%m-01') AS sale_date
            UNION ALL
            SELECT DATE_ADD(sale_date, INTERVAL 1 DAY)
            FROM calendar
            WHERE sale_date < LAST_DAY(?)
        )
        SELECT 
            c.sale_date,

            /* ARCADE (1) */
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.cash_amount END), 0) AS arcade_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.upi_amount END), 0) AS arcade_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.card_amount END), 0) AS arcade_card,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.total_amount END), 0) AS arcade_total_sales,
            COALESCE(SUM(CASE WHEN s.store_id = 1 THEN s.total_customers END), 0) AS arcade_customers,

            /* DREAMCUBE (2) */
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.cash_amount END), 0) AS dreamcube_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.upi_amount END), 0) AS dreamcube_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.card_amount END), 0) AS dreamcube_card,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.total_amount END), 0) AS dreamcube_total_sales,
            COALESCE(SUM(CASE WHEN s.store_id = 2 THEN s.total_customers END), 0) AS dreamcube_customers,

            /* TOYS (4) */
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.cash_amount END), 0) AS toys_cash,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.upi_amount END), 0) AS toys_upi,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.card_amount END), 0) AS toys_card,
            COALESCE(SUM(CASE WHEN s.store_id = 4 THEN s.total_amount END), 0) AS toys_total_sales,

            /* BOOKING (3) */
            COALESCE(SUM(CASE WHEN s.store_id = 3 THEN s.booking_amount END), 0) AS booking_total_amount,

            /* FINAL TOTALS */
            COALESCE(SUM(s.cash_amount), 0) AS total_cash,
            COALESCE(SUM(s.upi_amount + s.card_amount), 0) AS total_upi_card,
            COALESCE(SUM(s.total_amount + s.booking_amount), 0) AS grand_total_sales

        FROM calendar c
        LEFT JOIN sales s 
            ON s.sale_date = c.sale_date
        GROUP BY c.sale_date
        ORDER BY c.sale_date;
        `;

        const rows = await db.query(query, [date, date]);

        res.json({
            success: true,
            month: date.substring(0, 7),
            days: rows   // ← THIS WILL NOW BE AN ARRAY (31 days)
        });

    } catch (error) {
        console.error('Monthly sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching monthly sales'
        });
    }
});

// @route   GET /api/sales
// @desc    Get sales with filters
// @access  Private (Staff, Manager, Admin)
router.get('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, start_date, end_date } = req.query;
        const user = req.user;

        let query = `
        SELECT 
            s.sale_id,
            s.store_id,
            st.store_name,
            st.store_type,
            s.sale_date,
            s.sale_time,
            s.cash_amount,
            s.upi_amount,
            s.card_amount,
            s.booking_amount,
            s.product_description,
            s.total_customers,
            s.total_amount,
            s.notes,
            u.full_name AS staff_name,
            s.created_at
        FROM sales s
        JOIN stores st ON s.store_id = st.store_id
        JOIN users u ON s.user_id = u.user_id
        WHERE 1=1
        `;

        const params = [];

        // 🔹 Filter by store_id (query param)
        if (store_id) {
            query += ' AND s.store_id = ?';
            params.push(Number(store_id));
        }

        // 🔹 Staff restriction (important)
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const stores = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                const storeIds = stores.map(s => s.store_id);
                query += ` AND s.store_id IN (${storeIds.map(() => '?').join(',')})`;
                params.push(...storeIds);
            } else {
                // Staff has no stores → return empty result safely
                return res.json({ success: true, data: [] });
            }
        }

        // 🔹 Date filters
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date);
        }

        // 🔹 Ordering
        query += ' ORDER BY s.sale_date DESC, s.sale_time DESC';

        // 🧪 Optional debug
        // console.log(query);
        // console.log(params);

        const sales = await db.query(query, params);

        res.json({
            success: true,
            count: sales.length,
            data: sales
        });
    } catch (error) {
        console.error('Get sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sales'
        });
    }
});


// @route   GET /api/sales/today
// @desc    Get today's sales summary
// @access  Private (Staff, Manager, Admin)
router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;
        const today = new Date().toISOString().split('T')[0];
        console.log(today);
        let query = `
      SELECT 
        st.store_id,
        st.store_name,
        st.store_type,
        COUNT(s.sale_id) as total_transactions,
        SUM(s.cash_amount) as total_cash,
        SUM(s.upi_amount) as total_upi,
        SUM(s.card_amount) as total_card,
        SUM(s.booking_amount) as total_booking,
        SUM(s.total_amount) as total_sales,
        SUM(s.total_customers) as total_customers
      FROM stores st
      LEFT JOIN sales s ON st.store_id = s.store_id AND s.sale_date = ?
    `;

        const params = [today];

        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            query += ' WHERE st.store_type = ?';
            params.push(user.assigned_store);
        }

        query += ' GROUP BY st.store_id, st.store_name, st.store_type ORDER BY st.store_name';

        const salesSummary = await db.query(query, params);

        // Get overall totals
        const totals = salesSummary.reduce((acc, store) => ({
            total_cash: acc.total_cash + (store.total_cash || 0),
            total_upi: acc.total_upi + (store.total_upi || 0),
            total_card: acc.total_card + (store.total_card || 0),
            total_booking: acc.total_booking + (store.total_booking || 0),
            total_sales: acc.total_sales + (store.total_sales || 0),
            total_customers: acc.total_customers + (store.total_customers || 0),
            total_transactions: acc.total_transactions + (store.total_transactions || 0)
        }), {
            total_cash: 0,
            total_upi: 0,
            total_card: 0,
            total_booking: 0,
            total_sales: 0,
            total_customers: 0,
            total_transactions: 0
        });

        res.json({
            success: true,
            date: today,
            stores: salesSummary,
            totals
        });
    } catch (error) {
        console.error('Get today sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching today sales'
        });
    }
});

// @route   GET /api/sales/:id
// @desc    Get single sale by ID
// @access  Private (Staff, Manager, Admin)
router.get('/:id', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const sales = await db.query(
            `SELECT 
        s.*,
        st.store_name,
        st.store_type,
        u.full_name as staff_name
      FROM sales s
      JOIN stores st ON s.store_id = st.store_id
      JOIN users u ON s.user_id = u.user_id
      WHERE s.sale_id = ?`,
            [id]
        );

        if (sales.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found'
            });
        }

        res.json({
            success: true,
            data: sales[0]
        });
    } catch (error) {
        console.error('Get sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sale'
        });
    }
});


// @route   GET /api/sales/monthly
// @desc    Get monthly day-wise consolidated sales
// @access  Private



// @route   PUT /api/sales/:id
// @desc    Update a sale
// @access  Private (Manager, Admin only)
router.put('/:id', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            cash_amount,
            upi_amount,
            card_amount,
            booking_amount,
            product_description,
            total_customers,
            notes
        } = req.body;

        // Check if sale exists
        const [existingSales] = await db.query(
            'SELECT * FROM sales WHERE sale_id = ?',
            [id]
        );

        if (existingSales.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found'
            });
        }

        const existingSale = existingSales[0];

        // Use existing values if not provided
        const updatedCash = cash_amount !== undefined ? cash_amount : existingSale.cash_amount;
        const updatedUpi = upi_amount !== undefined ? upi_amount : existingSale.upi_amount;
        const updatedCard = card_amount !== undefined ? card_amount : existingSale.card_amount;
        const updatedBooking = booking_amount !== undefined ? booking_amount : existingSale.booking_amount;
        const updatedProductDesc = product_description !== undefined ? product_description : existingSale.product_description;
        const updatedCustomers = total_customers !== undefined ? total_customers : existingSale.total_customers;
        const updatedNotes = notes !== undefined ? notes : existingSale.notes;

        // Calculate new total
        const total_amount = parseFloat(updatedCash) + parseFloat(updatedUpi) +
            parseFloat(updatedCard) + parseFloat(updatedBooking);

        // Update sale
        await db.query(
            `UPDATE sales SET
        cash_amount = ?,
        upi_amount = ?,
        card_amount = ?,
        booking_amount = ?,
        product_description = ?,
        total_customers = ?,
        total_amount = ?,
        notes = ?
      WHERE sale_id = ?`,
            [
                updatedCash, updatedUpi, updatedCard, updatedBooking,
                updatedProductDesc, updatedCustomers, total_amount, updatedNotes, id
            ]
        );

        res.json({
            success: true,
            message: 'Sale updated successfully'
        });
    } catch (error) {
        console.error('Update sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating sale'
        });
    }
});

module.exports = router;