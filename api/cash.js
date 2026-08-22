const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

router.use(authMiddleware);

//////////////////////////////////////////////////////////
// OPEN CASH REGISTER
//////////////////////////////////////////////////////////

router.post('/open', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, opening_cash, date } = req.body;
        const user_id = req.user.user_id;
        const today = date;
        const notes = null;

        const existingRegister = await db.query(
            'SELECT * FROM cash_register WHERE store_id = ? AND register_date = ?',
            [store_id, today]
        );

        if (existingRegister.length > 0) {
            await db.query(
                `UPDATE cash_register 
                 SET opening_cash = ?, cash_taken = 0
                 WHERE store_id = ? AND register_date = ?`,
                [opening_cash, store_id, today]
            );

            return res.status(400).json({
                success: false,
                message: 'Cash register already opened for today and updated'
            });
        }

        const result = await db.query(
            `INSERT INTO cash_register 
            (store_id, user_id, register_date, opening_cash, cash_taken, notes)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [store_id, user_id, today, opening_cash, 0, notes]
        );

        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Cash register opened successfully',
            register_id: result.insertId,
            store_name: stores[0]?.store_name,
            date: today,
            opening_cash: parseFloat(opening_cash),
            cash_taken: 0
        });

    } catch (error) {
        console.error('Open cash register error:', error);
        res.status(500).json({ success: false, message: 'Error opening cash register' });
    }
});

//////////////////////////////////////////////////////////
// CLOSE CASH REGISTER
//////////////////////////////////////////////////////////

router.post('/close', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {

        const { store_id, closing_cash, date, cash_taken = 0 } = req.body;
        const notes = req.body.notes ?? null;  // ✅ FIX
        const today = date;

        const register = await db.query(
            'SELECT * FROM cash_register WHERE store_id = ? AND register_date = ?',
            [store_id, today]
        );

        if (register.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Cash register not opened for today'
            });
        }

        if (register[0].closing_cash !== null) {
            return res.status(400).json({
                success: false,
                message: 'Cash register already closed for today'
            });
        }

        const cashSales = await db.query(
            'SELECT COALESCE(SUM(cash_amount), 0) as total_cash_sales FROM sales WHERE store_id = ? AND sale_date = ?',
            [store_id, today]
        );

        const total_cash_sales = parseFloat(cashSales[0]?.total_cash_sales || 0);
        const opening_cash = parseFloat(register[0].opening_cash);
        const cashTaken = parseFloat(cash_taken) || 0;

        const calculated_cash = opening_cash + total_cash_sales - cashTaken;
        const cash_difference = parseFloat(closing_cash) - calculated_cash;

        await db.query(
            `UPDATE cash_register SET
                closing_cash = ?,
                cash_taken = ?,
                calculated_cash = ?,
                cash_difference = ?,
                closing_time = NOW(),
                notes = ?
            WHERE store_id = ? AND register_date = ?`,
            [
                closing_cash,
                cashTaken,
                calculated_cash,
                cash_difference,
                notes,      // now always null or string
                store_id,
                today
            ]
        );

        res.json({
            success: true,
            message: 'Cash register closed successfully'
        });

    } catch (error) {
        console.error('Close cash register error:', error);
        res.status(500).json({
            success: false,
            message: 'Error closing cash register'
        });
    }
});

//////////////////////////////////////////////////////////
// GET TODAY STATUS
//////////////////////////////////////////////////////////

router.get('/today', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const today = req.query.date;

        if (!today) {
            return res.status(400).json({
                success: false,
                message: 'Date parameter is required'
            });
        }

        const registers = await db.query(
            `SELECT cr.*, s.store_name, u.full_name as opened_by_name
             FROM cash_register cr
             JOIN stores s ON cr.store_id = s.store_id
             JOIN users u ON cr.user_id = u.user_id
             WHERE cr.register_date = ?
             ORDER BY s.store_name`,
            [today]
        );

        for (let register of registers) {
            const sales = await db.query(
                'SELECT COALESCE(SUM(cash_amount), 0) as cash_sales FROM sales WHERE store_id = ? AND sale_date = ?',
                [register.store_id, today]
            );

            register.cash_sales_today = parseFloat(sales[0]?.cash_sales || 0);
        }

        res.json({
            success: true,
            date: today,
            registers
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching cash register status' });
    }
});

//////////////////////////////////////////////////////////
// HISTORY
//////////////////////////////////////////////////////////

router.get('/history', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { store_id, start_date, end_date } = req.query;

        let query = `
            SELECT cr.*, s.store_name, u.full_name as opened_by_name
            FROM cash_register cr
            JOIN stores s ON cr.store_id = s.store_id
            JOIN users u ON cr.user_id = u.user_id
            WHERE 1=1
        `;

        const params = [];

        if (store_id) {
            query += ' AND cr.store_id = ?';
            params.push(store_id);
        }

        if (start_date) {
            query += ' AND cr.register_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND cr.register_date <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY cr.register_date DESC';

        const registers = await db.query(query, params);

        res.json({ success: true, data: registers });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching history' });
    }
});

//////////////////////////////////////////////////////////
// MONTHLY REPORT
//////////////////////////////////////////////////////////

router.get('/monthly', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { year, month } = req.query;

        const startDate = `${year}-${month.padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];

        const registers = await db.query(
            `SELECT cr.*, s.store_name, s.store_type,
                    COALESCE(SUM(sales.cash_amount),0) as total_cash_sales
             FROM cash_register cr
             JOIN stores s ON cr.store_id = s.store_id
             LEFT JOIN sales 
                ON sales.store_id = cr.store_id 
                AND DATE(sales.sale_date) = cr.register_date
             WHERE cr.register_date BETWEEN ? AND ?
             GROUP BY cr.register_id
             ORDER BY cr.register_date DESC`,
            [startDate, endDate]
        );

        const stats = calculateMonthlyStats(registers);

        res.json({
            success: true,
            month: `${year}-${month}`,
            start_date: startDate,
            end_date: endDate,
            data: registers,
            statistics: stats
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching monthly report' });
    }
});

//////////////////////////////////////////////////////////
// MONTHLY STATISTICS FUNCTION
//////////////////////////////////////////////////////////

function calculateMonthlyStats(registers) {
    const stats = {
        total_opening_cash: 0,
        total_closing_cash: 0,
        total_calculated_cash: 0,
        total_cash_difference: 0,
        total_cash_sales: 0,
        total_cash_taken: 0,
        days_opened: 0,
        days_closed: 0
    };

    registers.forEach(r => {
        const opening = parseFloat(r.opening_cash) || 0;
        const closing = parseFloat(r.closing_cash) || 0;
        const calculated = parseFloat(r.calculated_cash) || 0;
        const diff = parseFloat(r.cash_difference) || 0;
        const sales = parseFloat(r.total_cash_sales) || 0;
        const taken = parseFloat(r.cash_taken) || 0;

        stats.total_opening_cash += opening;
        stats.total_closing_cash += closing;
        stats.total_calculated_cash += calculated;
        stats.total_cash_difference += diff;
        stats.total_cash_sales += sales;
        stats.total_cash_taken += taken;

        stats.days_opened++;

        if (r.closing_cash !== null) {
            stats.days_closed++;
        }
    });

    return stats;
}

module.exports = router;
