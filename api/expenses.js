
const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);
// @route   POST /api/expenses
// @desc    Create a new expense
// @access  Private (Staff, Manager, Admin)
router.post('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, expense_date, amount, description } = req.body;
        const user_id = req.user.user_id;

        // Validate required fields
        if (!store_id || !expense_date || !amount || !description) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: store_id, expense_date, amount, and description are required'
            });
        }

        // Validate amount is a positive number
        if (isNaN(amount) || parseFloat(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be a positive number'
            });
        }

        // Validate date format (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(expense_date)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid expense_date format. Please use YYYY-MM-DD'
            });
        }

        // Check if store exists and user has access to it
        const [store] = await db.query(
            'SELECT store_id FROM stores WHERE store_id = ?',
            [store_id]
        );

        if (store.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // Insert expense
        const result = await db.query(
            `INSERT INTO expenses (store_id, user_id, expense_date, amount, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [store_id, user_id, expense_date, parseFloat(amount), description]
        );

        // Get created expense details
        const [expense] = await db.query(
            `SELECT e.*, s.store_name, u.full_name 
             FROM expenses e
             JOIN stores s ON e.store_id = s.store_id
             JOIN users u ON e.user_id = u.user_id
             WHERE e.expense_id = ?`,
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            message: 'Expense created successfully',
            data: expense[0]
        });

    } catch (error) {
        console.error('Create expense error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating expense'
        });
    }
});

// @route   GET /api/expenses/monthly
// @desc    Get expenses for a specific month and year
// @access  Private (Staff, Manager, Admin)
router.get('/monthly', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { month, year, store_id } = req.query;
        const user_id = req.user.user_id;
        const user_role = req.user.role;

        // Validate required parameters
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                message: 'month and year are required parameters'
            });
        }

        // Validate month (1-12) and year
        const monthNum = parseInt(month);
        const yearNum = parseInt(year);

        if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
                success: false,
                message: 'month must be a number between 1 and 12'
            });
        }

        if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
            return res.status(400).json({
                success: false,
                message: 'year must be a valid year'
            });
        }

        // Build query based on user role
        let query = `
            SELECT 
                e.expense_id,
                e.store_id,
                e.user_id,
                e.expense_date,
                e.amount,
                e.description,
                e.created_at,
                s.store_name,
                u.full_name,
                u.username
            FROM expenses e
            JOIN stores s ON e.store_id = s.store_id
            JOIN users u ON e.user_id = u.user_id
            WHERE YEAR(e.expense_date) = ? 
            AND MONTH(e.expense_date) = ?
        `;

        const params = [yearNum, monthNum];

        // For staff users, only show their own expenses
        if (user_role === 'staff') {
            query += ' AND e.user_id = ?';
            params.push(user_id);
        }

        // Filter by store if provided
        if (store_id) {
            query += ' AND e.store_id = ?';
            params.push(store_id);
        }

        query += ' ORDER BY e.expense_date DESC, e.created_at DESC';

        const expenses = await db.query(query, params);

        // Calculate summary statistics
        let totalAmount = 0;
        const storeTotals = {};
        const dailyTotals = {};

        expenses.forEach(expense => {
            totalAmount += parseFloat(expense.amount);

            // Store-wise totals
            const storeName = expense.store_name;
            storeTotals[storeName] = (storeTotals[storeName] || 0) + parseFloat(expense.amount);

            // Daily totals
            const dateStr = expense.expense_date.toISOString().split('T')[0];
            dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + parseFloat(expense.amount);
        });

        // Calculate average per day
        const totalDays = Object.keys(dailyTotals).length;
        const averagePerDay = totalDays > 0 ? totalAmount / totalDays : 0;

        res.json({
            success: true,
            data: expenses,
            summary: {
                total_amount: parseFloat(totalAmount.toFixed(2)),
                total_expenses: expenses.length,
                average_per_day: parseFloat(averagePerDay.toFixed(2)),
                total_days_with_expenses: totalDays
            },
            breakdown: {
                by_store: storeTotals,
                by_day: dailyTotals
            },
            filters: {
                month: monthNum,
                year: yearNum,
                store_id: store_id || 'all'
            }
        });

    } catch (error) {
        console.error('Get monthly expenses error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching monthly expenses'
        });
    }
});
module.exports = router;