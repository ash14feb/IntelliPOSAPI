
const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   GET /api/reports/daily-summary
// @desc    Get daily summary report
// @access  Private (Manager, Admin)
router.get('/daily-summary', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { date } = req.query;
        const report_date = date || new Date().toISOString().split('T')[0];

        // Get sales summary by store
        const salesSummary = await db.query(
            `SELECT 
        s.store_id,
        st.store_name,
        st.store_type,
        COUNT(s.sale_id) as total_transactions,
        SUM(s.cash_amount) as total_cash,
        SUM(s.upi_amount) as total_upi,
        SUM(s.card_amount) as total_card,
        SUM(s.booking_amount) as total_booking,
        SUM(s.total_amount) as total_sales,
        SUM(s.total_customers) as total_customers
      FROM sales s
      JOIN stores st ON s.store_id = st.store_id
      WHERE s.sale_date = ?
      GROUP BY s.store_id, st.store_name, st.store_type
      ORDER BY st.store_name`,
            [report_date]
        );

        // Get expenses summary
        const expensesSummary = await db.query(
            `SELECT 
        e.store_id,
        st.store_name,
        COUNT(e.expense_id) as expense_count,
        SUM(e.amount) as total_expenses
      FROM expenses e
      JOIN stores st ON e.store_id = st.store_id
      WHERE e.expense_date = ?
      GROUP BY e.store_id, st.store_name
      ORDER BY st.store_name`,
            [report_date]
        );

        // Get cash register status
        const cashRegister = await db.query(
            `SELECT 
        cr.*,
        st.store_name
      FROM cash_register cr
      JOIN stores st ON cr.store_id = st.store_id
      WHERE cr.register_date = ?
      ORDER BY st.store_name`,
            [report_date]
        );

        // Get open problems
        const openProblems = await db.query(
            `SELECT 
        COUNT(*) as open_problems
      FROM game_problems
      WHERE status = 'reported' AND DATE(reported_datetime) = ?`,
            [report_date]
        );

        // Calculate totals
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

        const totalExpenses = expensesSummary.reduce((acc, store) =>
            acc + (store.total_expenses || 0), 0
        );

        // Prepare response
        const report = {
            date: report_date,
            stores: salesSummary.map(store => {
                const storeExpenses = expensesSummary.find(e => e.store_id === store.store_id);
                const storeCash = cashRegister.find(c => c.store_id === store.store_id);

                return {
                    store_id: store.store_id,
                    store_name: store.store_name,
                    store_type: store.store_type,
                    sales: {
                        transactions: store.total_transactions,
                        cash: store.total_cash,
                        upi: store.total_upi,
                        card: store.total_card,
                        booking: store.total_booking,
                        total: store.total_sales,
                        customers: store.total_customers
                    },
                    expenses: storeExpenses ? {
                        count: storeExpenses.expense_count,
                        total: storeExpenses.total_expenses
                    } : { count: 0, total: 0 },
                    cash_register: storeCash || null,
                    net_amount: (store.total_sales || 0) - (storeExpenses?.total_expenses || 0)
                };
            }),
            summary: {
                sales: totals,
                expenses: {
                    total: totalExpenses,
                    count: expensesSummary.reduce((acc, e) => acc + e.expense_count, 0)
                },
                open_problems: openProblems[0]?.open_problems || 0,
                cash_registers_opened: cashRegister.length,
                net_total: totals.total_sales - totalExpenses
            }
        };

        res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Daily summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating daily summary'
        });
    }
});

// @route   GET /api/reports/range-summary
// @desc    Get summary for a date range
// @access  Private (Manager, Admin)
router.get('/range-summary', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }

        // Get sales summary by date and store
        const salesSummary = await db.query(
            `SELECT 
        s.sale_date,
        s.store_id,
        st.store_name,
        st.store_type,
        COUNT(s.sale_id) as total_transactions,
        SUM(s.cash_amount) as total_cash,
        SUM(s.upi_amount) as total_upi,
        SUM(s.card_amount) as total_card,
        SUM(s.booking_amount) as total_booking,
        SUM(s.total_amount) as total_sales,
        SUM(s.total_customers) as total_customers
      FROM sales s
      JOIN stores st ON s.store_id = st.store_id
      WHERE s.sale_date BETWEEN ? AND ?
      GROUP BY s.sale_date, s.store_id, st.store_name, st.store_type
      ORDER BY s.sale_date DESC, st.store_name`,
            [start_date, end_date]
        );

        // Get expenses summary
        const expensesSummary = await db.query(
            `SELECT 
        e.expense_date,
        e.store_id,
        st.store_name,
        COUNT(e.expense_id) as expense_count,
        SUM(e.amount) as total_expenses
      FROM expenses e
      JOIN stores st ON e.store_id = st.store_id
      WHERE e.expense_date BETWEEN ? AND ?
      GROUP BY e.expense_date, e.store_id, st.store_name
      ORDER BY e.expense_date DESC, st.store_name`,
            [start_date, end_date]
        );

        // Calculate daily totals
        const dailyTotals = {};
        salesSummary.forEach(day => {
            const date = day.sale_date;
            if (!dailyTotals[date]) {
                dailyTotals[date] = {
                    total_cash: 0,
                    total_upi: 0,
                    total_card: 0,
                    total_booking: 0,
                    total_sales: 0,
                    total_customers: 0,
                    total_transactions: 0,
                    total_expenses: 0
                };
            }

            dailyTotals[date].total_cash += parseFloat(day.total_cash || 0);
            dailyTotals[date].total_upi += parseFloat(day.total_upi || 0);
            dailyTotals[date].total_card += parseFloat(day.total_card || 0);
            dailyTotals[date].total_booking += parseFloat(day.total_booking || 0);
            dailyTotals[date].total_sales += parseFloat(day.total_sales || 0);
            dailyTotals[date].total_customers += parseInt(day.total_customers || 0);
            dailyTotals[date].total_transactions += parseInt(day.total_transactions || 0);
        });

        // Add expenses to daily totals
        expensesSummary.forEach(expense => {
            const date = expense.expense_date;
            if (dailyTotals[date]) {
                dailyTotals[date].total_expenses += parseFloat(expense.total_expenses || 0);
            } else {
                dailyTotals[date] = {
                    total_cash: 0,
                    total_upi: 0,
                    total_card: 0,
                    total_booking: 0,
                    total_sales: 0,
                    total_customers: 0,
                    total_transactions: 0,
                    total_expenses: parseFloat(expense.total_expenses || 0)
                };
            }
        });

        // Convert daily totals to array
        const dailySummary = Object.entries(dailyTotals).map(([date, totals]) => ({
            date,
            ...totals,
            net_amount: totals.total_sales - totals.total_expenses
        })).sort((a, b) => new Date(b.date) - new Date(a.date));

        // Calculate overall totals
        const overallTotals = dailySummary.reduce((acc, day) => ({
            total_cash: acc.total_cash + day.total_cash,
            total_upi: acc.total_upi + day.total_upi,
            total_card: acc.total_card + day.total_card,
            total_booking: acc.total_booking + day.total_booking,
            total_sales: acc.total_sales + day.total_sales,
            total_customers: acc.total_customers + day.total_customers,
            total_transactions: acc.total_transactions + day.total_transactions,
            total_expenses: acc.total_expenses + day.total_expenses,
            net_amount: acc.net_amount + day.net_amount
        }), {
            total_cash: 0,
            total_upi: 0,
            total_card: 0,
            total_booking: 0,
            total_sales: 0,
            total_customers: 0,
            total_transactions: 0,
            total_expenses: 0,
            net_amount: 0
        });

        res.json({
            success: true,
            range: { start_date, end_date },
            daily_summary: dailySummary,
            overall_totals: overallTotals,
            store_breakdown: {
                sales: salesSummary,
                expenses: expensesSummary
            }
        });
    } catch (error) {
        console.error('Range summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating range summary'
        });
    }
});

// @route   GET /api/reports/staff-performance
// @desc    Get staff performance report
// @access  Private (Manager, Admin)
router.get('/staff-performance', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        let dateFilter = '';
        const params = [];

        if (start_date && end_date) {
            dateFilter = 'AND s.sale_date BETWEEN ? AND ?';
            params.push(start_date, end_date);
        }

        const performanceReport = await db.query(
            `SELECT 
        u.user_id,
        u.username,
        u.full_name,
        u.user_type,
        COUNT(DISTINCT DATE(a.attendance_date)) as days_worked,
        COUNT(s.sale_id) as total_sales,
        SUM(s.total_amount) as total_revenue,
        AVG(s.total_amount) as average_sale_amount,
        SUM(s.total_customers) as total_customers_served
      FROM users u
      LEFT JOIN sales s ON u.user_id = s.user_id ${dateFilter}
      LEFT JOIN staff_attendance a ON u.user_id = a.user_id 
        AND a.logout_time IS NOT NULL
        ${dateFilter ? 'AND a.attendance_date BETWEEN ? AND ?' : ''}
      WHERE u.user_type = 'staff' AND u.is_active = 1
      GROUP BY u.user_id, u.username, u.full_name, u.user_type
      ORDER BY total_revenue DESC`,
            params
        );

        res.json({
            success: true,
            date_range: { start_date, end_date },
            performance: performanceReport
        });
    } catch (error) {
        console.error('Staff performance error:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating staff performance report'
        });
    }
});

module.exports = router;