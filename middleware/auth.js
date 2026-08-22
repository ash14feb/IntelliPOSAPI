const jwt = require('jsonwebtoken');
const db = require('../utils/database');

const JWT_SECRET = process.env.JWT_SECRET || 'dxMysore';

const authMiddleware = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No authentication token, access denied'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.userType === 'super_admin') {
            req.user = {
                user_id: decoded.userId || 0,
                tenant_id: 0,
                username: decoded.username || 'scanexsuperadmin',
                email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@scanexsystems.com',
                full_name: 'Super Admin',
                user_type: 'super_admin',
                assigned_store: 'all'
            };
            return next();
        }

        const users = await db.query(
            `SELECT
                user_id,
                tenant_id,
                username,
                email,
                full_name,
                user_type,
                assigned_store
             FROM users
             WHERE user_id = ? AND is_active = 1`,
            [decoded.userId]
        );

        if (!users || users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive'
            });
        }

        req.user = users[0];
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expired'
            });
        }

        console.error('Auth middleware error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication error'
        });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!roles.includes(req.user.user_type)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action'
            });
        }

        next();
    };
};

module.exports = { authMiddleware, authorize };
