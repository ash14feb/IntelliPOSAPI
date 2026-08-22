const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/problems
// @desc    Report a game problem
// @access  Private (Staff, Manager, Admin)
router.post('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            game_description,
            problem_description
        } = req.body;

        const user_id = req.user.user_id;

        // Validate required fields
        if (!store_id || !game_description || !problem_description) {
            return res.status(400).json({
                success: false,
                message: 'Store ID, game description, and problem description are required'
            });
        }

        // Report problem
        const result = await db.query(
            `INSERT INTO game_problems (
        store_id, user_id, game_description, problem_description
      ) VALUES (?, ?, ?, ?)`,
            [store_id, user_id, game_description, problem_description]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Game problem reported successfully',
            problem_id: result.insertId,
            problem_data: {
                store_id,
                store_name: stores[0]?.store_name,
                game_description,
                problem_description,
                reported_datetime: new Date()
            }
        });
    } catch (error) {
        console.error('Report problem error:', error);
        res.status(500).json({
            success: false,
            message: 'Error reporting game problem'
        });
    }
});

// @route   GET /api/problems
// @desc    Get game problems with filters
// @access  Private (Staff, Manager, Admin)
router.get('/', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const {
            store_id,
            status,
            start_date,
            end_date,
            page = 1,
            limit = 50
        } = req.query;

        const user = req.user;
        const offset = (page - 1) * limit;

        let query = `
      SELECT 
        gp.*,
        s.store_name,
        u.full_name as reported_by,
        fu.full_name as fixed_by_name
      FROM game_problems gp
      JOIN stores s ON gp.store_id = s.store_id
      JOIN users u ON gp.user_id = u.user_id
      LEFT JOIN users fu ON gp.fixed_by = fu.user_id
      WHERE 1=1
    `;

        const params = [];

        if (store_id) {
            query += ' AND gp.store_id = ?';
            params.push(store_id);
        }

        if (status) {
            query += ' AND gp.status = ?';
            params.push(status);
        }

        // If user is staff, only show their store's problems
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND gp.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        if (start_date) {
            query += ' AND DATE(gp.reported_datetime) >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND DATE(gp.reported_datetime) <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY gp.reported_datetime DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const problems = await db.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM game_problems gp WHERE 1=1';
        const countParams = params.slice(0, -2);

        if (store_id) countQuery += ' AND gp.store_id = ?';
        if (status) countQuery += ' AND gp.status = ?';
        if (start_date) countQuery += ' AND DATE(gp.reported_datetime) >= ?';
        if (end_date) countQuery += ' AND DATE(gp.reported_datetime) <= ?';

        const [countResult] = await db.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: problems,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get problems error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching game problems'
        });
    }
});

// @route   GET /api/problems/open
// @desc    Get open (unresolved) problems
// @access  Private (Staff, Manager, Admin)
router.get('/open', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user = req.user;

        let query = `
      SELECT 
        gp.*,
        s.store_name,
        u.full_name as reported_by
      FROM game_problems gp
      JOIN stores s ON gp.store_id = s.store_id
      JOIN users u ON gp.user_id = u.user_id
      WHERE gp.status = 'reported'
    `;

        const params = [];

        // If user is staff, only show their store's problems
        if (user.user_type === 'staff' && user.assigned_store !== 'all') {
            const [stores] = await db.query(
                'SELECT store_id FROM stores WHERE store_type = ?',
                [user.assigned_store]
            );

            if (stores.length > 0) {
                query += ' AND gp.store_id IN (?)';
                params.push(stores.map(s => s.store_id));
            }
        }

        query += ' ORDER BY gp.reported_datetime DESC';

        const problems = await db.query(query, params);

        res.json({
            success: true,
            count: problems.length,
            problems
        });
    } catch (error) {
        console.error('Get open problems error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching open problems'
        });
    }
});

// @route   PUT /api/problems/:id/fix
// @desc    Mark problem as fixed
// @access  Private (Manager, Admin only)
router.put('/:id/fix', authorize('manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { fixed_notes } = req.body;
        const user_id = req.user.user_id;

        // Check if problem exists
        const [problems] = await db.query(
            'SELECT * FROM game_problems WHERE problem_id = ?',
            [id]
        );

        if (problems.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Problem not found'
            });
        }

        // Mark as fixed
        await db.query(
            `UPDATE game_problems SET
        status = 'fixed',
        fixed_datetime = NOW(),
        fixed_by = ?,
        fixed_notes = ?
      WHERE problem_id = ?`,
            [user_id, fixed_notes, id]
        );

        res.json({
            success: true,
            message: 'Problem marked as fixed'
        });
    } catch (error) {
        console.error('Fix problem error:', error);
        res.status(500).json({
            success: false,
            message: 'Error marking problem as fixed'
        });
    }
});

// @route   GET /api/problems/:id
// @desc    Get single problem by ID
// @access  Private (Staff, Manager, Admin)
router.get('/:id', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const [problems] = await db.query(
            `SELECT 
        gp.*,
        s.store_name,
        s.store_type,
        u.full_name as reported_by,
        fu.full_name as fixed_by_name
      FROM game_problems gp
      JOIN stores s ON gp.store_id = s.store_id
      JOIN users u ON gp.user_id = u.user_id
      LEFT JOIN users fu ON gp.fixed_by = fu.user_id
      WHERE gp.problem_id = ?`,
            [id]
        );

        if (problems.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Problem not found'
            });
        }

        res.json({
            success: true,
            data: problems[0]
        });
    } catch (error) {
        console.error('Get problem error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching problem'
        });
    }
});

module.exports = router;