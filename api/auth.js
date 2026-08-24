const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');
const { sendCredentialsEmail, sendPasswordResetEmail } = require('../utils/email');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dxMysore';
const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME || 'scanexsuperadmin';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Scanex@123';

function slugifyBusinessName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 12) || 'scanex';
}

function slugifyUsername(username) {
    return username
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 20) || 'user';
}

function generatePassword() {
    return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, 'A').slice(0, 10);
}

function signAuthToken(user) {
    return jwt.sign(
        {
            userId: user.user_id,
            userType: user.user_type,
            tenantId: user.tenant_id,
            username: user.username
        },
        JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
}

function buildStoreAdminUsername(businessName, tenantId) {
    return `${slugifyBusinessName(businessName)}${tenantId}`;
}

async function ensureUniqueUsername(baseUsername) {
    let candidate = baseUsername;
    let attempt = 0;

    while (attempt < 20) {
        const existing = await db.query('SELECT user_id FROM users WHERE username = ? LIMIT 1', [candidate]);
        if (existing.length === 0) {
            return candidate;
        }
        attempt += 1;
        candidate = `${baseUsername}${attempt}`;
    }

    return `${baseUsername}${Date.now()}`;
}

async function buildScopedUsername(adminUsername, requestedUsername) {
    const normalizedChild = slugifyUsername(requestedUsername);
    const base = `${adminUsername}.${normalizedChild}`;
    return ensureUniqueUsername(base);
}

async function getTenantDisplayName(tenantId) {
    const tenants = await db.query('SELECT business_name FROM pos_tenants WHERE tenant_id = ? LIMIT 1', [tenantId]);
    return tenants[0]?.business_name || 'Scanex POS Store';
}

async function getTenantUsers(tenantId) {
    return db.query(
        `SELECT 
            user_id,
            tenant_id,
            username,
            email,
            full_name,
            user_type,
            assigned_store,
            is_active,
            created_at
        FROM users
        WHERE tenant_id = ?
        ORDER BY created_at DESC`,
        [tenantId]
    );
}

router.post('/register', async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { name, email, business_name } = req.body;

        if (!name || !email || !business_name) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: 'name, email, and business_name are required'
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const existingTenant = await db.query(
            'SELECT tenant_id FROM pos_tenants WHERE owner_email = ? LIMIT 1',
            [normalizedEmail]
        );

        if (existingTenant.length > 0) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: 'A store is already registered with this email address'
            });
        }

        const password = generatePassword();
        const passwordHash = await bcrypt.hash(password, 10);

        await connection.beginTransaction();

        const [tenantResult] = await connection.execute(
            `INSERT INTO pos_tenants (
                business_name,
                owner_name,
                owner_email
            ) VALUES (?, ?, ?)`,
            [business_name.trim(), name.trim(), normalizedEmail]
        );

        const tenantId = tenantResult.insertId;
        const username = await ensureUniqueUsername(buildStoreAdminUsername(business_name.trim(), tenantId));

        await connection.execute(
            `INSERT INTO users (
                tenant_id,
                username,
                email,
                password_hash,
                full_name,
                user_type,
                assigned_store,
                is_active
            ) VALUES (?, ?, ?, ?, ?, 'admin', 'all', 1)`,
            [tenantId, username, normalizedEmail, passwordHash, name.trim()]
        );

        await connection.execute(
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
            ) VALUES (?, ?, 'Rs.', 2.50, 2.50, 0, 1, 'bluetooth', '3inch', 'Welcome to Scanex!', 'Thank you for visiting!')`,
            [tenantId, business_name.trim()]
        );

        await connection.commit();
        connection.release();

        await sendCredentialsEmail({
            name: name.trim(),
            email: normalizedEmail,
            businessName: business_name.trim(),
            username,
            password,
            accountLabel: 'admin'
        });

        res.status(201).json({
            success: true,
            message: 'Registration complete. Admin credentials have been emailed to you.'
        });
    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('Register tenant error:', error);
        res.status(500).json({
            success: false,
            message: 'Error registering store'
        });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        if (username === SUPER_ADMIN_USERNAME && password === SUPER_ADMIN_PASSWORD) {
            const superAdminUser = {
                user_id: 0,
                tenant_id: 0,
                username: SUPER_ADMIN_USERNAME,
                email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@scanexsystems.com',
                full_name: 'Super Admin',
                user_type: 'super_admin',
                assigned_store: 'all'
            };

            return res.json({
                success: true,
                message: 'Login successful',
                token: signAuthToken(superAdminUser),
                user: superAdminUser
            });
        }

        const users = await db.query(
            'SELECT * FROM users WHERE username = ? AND is_active = 1',
            [username]
        );

        if (!users || users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const user = users[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const { password_hash, ...userWithoutPassword } = user;

        res.json({
            success: true,
            message: 'Login successful',
            token: signAuthToken(userWithoutPassword),
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});

router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.user_id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        const users = await db.query(
            'SELECT password_hash FROM users WHERE user_id = ?',
            [userId]
        );

        if (!users || users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const isPasswordValid = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await db.query(
            'UPDATE users SET password_hash = ? WHERE user_id = ?',
            [hashedPassword, userId]
        );

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

router.post('/create-user', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const {
            username,
            email,
            full_name,
            user_type,
            assigned_store = 'all'
        } = req.body;

        if (!username || !email || !full_name || !user_type) {
            return res.status(400).json({
                success: false,
                message: 'username, email, full_name, and user_type are required'
            });
        }

        const validUserTypes = ['manager', 'staff'];
        if (!validUserTypes.includes(user_type)) {
            return res.status(400).json({
                success: false,
                message: 'user_type must be one of: manager, staff'
            });
        }

        const validStores = ['arcade', 'dreamcube', 'toys_merch', 'all'];
        if (!validStores.includes(assigned_store)) {
            return res.status(400).json({
                success: false,
                message: 'assigned_store must be one of: arcade, dreamcube, toys_merch, all'
            });
        }

        const generatedUsername = await buildScopedUsername(req.user.username, username);
        const normalizedEmail = email.trim().toLowerCase();
        const generatedPassword = generatePassword();
        const passwordHash = await bcrypt.hash(generatedPassword, 10);

        const existingEmail = await db.query(
            'SELECT user_id FROM users WHERE tenant_id = ? AND email = ? LIMIT 1',
            [req.user.tenant_id, normalizedEmail]
        );

        if (existingEmail.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'A user with this email already exists for the store'
            });
        }

        const result = await db.query(
            `INSERT INTO users (
                tenant_id,
                username,
                email,
                password_hash,
                full_name,
                user_type,
                assigned_store,
                is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [req.user.tenant_id, generatedUsername, normalizedEmail, passwordHash, full_name.trim(), user_type, assigned_store]
        );

        const tenantName = await getTenantDisplayName(req.user.tenant_id);
        await sendCredentialsEmail({
            name: full_name.trim(),
            email: normalizedEmail,
            businessName: tenantName,
            username: generatedUsername,
            password: generatedPassword,
            accountLabel: user_type
        });

        const newUser = await db.query(
            `SELECT 
                user_id,
                tenant_id,
                username,
                email,
                full_name,
                user_type,
                assigned_store,
                is_active,
                created_at
            FROM users 
            WHERE tenant_id = ? AND user_id = ?`,
            [req.user.tenant_id, result.insertId]
        );

        res.status(201).json({
            success: true,
            message: 'User created successfully and credentials emailed',
            user: newUser[0]
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating user'
        });
    }
});

router.get('/users', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const users = await getTenantUsers(req.user.tenant_id);

        res.json({
            success: true,
            users
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users'
        });
    }
});

router.put('/users/:id', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            email,
            full_name,
            user_type,
            assigned_store,
            is_active
        } = req.body;

        const existingUsers = await db.query(
            'SELECT * FROM users WHERE tenant_id = ? AND user_id = ?',
            [req.user.tenant_id, id]
        );

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const currentUser = existingUsers[0];
        if (currentUser.user_type === 'admin') {
            return res.status(400).json({
                success: false,
                message: 'Admin users cannot be edited from this screen'
            });
        }

        const updates = [];
        const values = [];

        if (email !== undefined) {
            const normalizedEmail = email.trim().toLowerCase();
            const duplicateEmail = await db.query(
                'SELECT user_id FROM users WHERE tenant_id = ? AND email = ? AND user_id <> ? LIMIT 1',
                [req.user.tenant_id, normalizedEmail, id]
            );

            if (duplicateEmail.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Another user in this store already uses this email'
                });
            }

            updates.push('email = ?');
            values.push(normalizedEmail);
        }

        if (full_name !== undefined) {
            updates.push('full_name = ?');
            values.push(full_name.trim());
        }

        if (user_type !== undefined) {
            const validUserTypes = ['manager', 'staff'];
            if (!validUserTypes.includes(user_type)) {
                return res.status(400).json({
                    success: false,
                    message: 'user_type must be one of: manager, staff'
                });
            }
            updates.push('user_type = ?');
            values.push(user_type);
        }

        if (assigned_store !== undefined) {
            const validStores = ['arcade', 'dreamcube', 'toys_merch', 'all'];
            if (!validStores.includes(assigned_store)) {
                return res.status(400).json({
                    success: false,
                    message: 'assigned_store must be one of: arcade, dreamcube, toys_merch, all'
                });
            }
            updates.push('assigned_store = ?');
            values.push(assigned_store);
        }

        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        values.push(req.user.tenant_id, id);

        await db.query(
            `UPDATE users SET ${updates.join(', ')} WHERE tenant_id = ? AND user_id = ?`,
            values
        );

        const updatedUser = await db.query(
            `SELECT 
                user_id,
                tenant_id,
                username,
                email,
                full_name,
                user_type,
                assigned_store,
                is_active,
                created_at
            FROM users 
            WHERE tenant_id = ? AND user_id = ?`,
            [req.user.tenant_id, id]
        );

        res.json({
            success: true,
            message: 'User updated successfully',
            user: updatedUser[0]
        });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user'
        });
    }
});

router.delete('/users/:id', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const existingUsers = await db.query(
            'SELECT * FROM users WHERE tenant_id = ? AND user_id = ?',
            [req.user.tenant_id, id]
        );

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const targetUser = existingUsers[0];
        if (targetUser.user_type === 'admin') {
            return res.status(400).json({
                success: false,
                message: 'Admin users cannot be deleted from this screen'
            });
        }

        await db.query(
            'UPDATE users SET is_active = 0 WHERE tenant_id = ? AND user_id = ?',
            [req.user.tenant_id, id]
        );

        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting user'
        });
    }
});

router.post('/users/:id/resend-credentials', authMiddleware, authorize('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const users = await db.query(
            'SELECT * FROM users WHERE tenant_id = ? AND user_id = ? LIMIT 1',
            [req.user.tenant_id, id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const targetUser = users[0];
        if (!targetUser.email) {
            return res.status(400).json({
                success: false,
                message: 'This user does not have an email address saved'
            });
        }

        const temporaryPassword = generatePassword();
        const passwordHash = await bcrypt.hash(temporaryPassword, 10);

        await db.query(
            'UPDATE users SET password_hash = ? WHERE tenant_id = ? AND user_id = ?',
            [passwordHash, req.user.tenant_id, id]
        );

        await sendCredentialsEmail({
            name: targetUser.full_name,
            email: targetUser.email,
            businessName: await getTenantDisplayName(req.user.tenant_id),
            username: targetUser.username,
            password: temporaryPassword,
            accountLabel: targetUser.user_type
        });

        res.json({
            success: true,
            message: 'User credentials resent successfully'
        });
    } catch (error) {
        console.error('Resend user credentials error:', error);
        res.status(500).json({
            success: false,
            message: 'Error resending user credentials'
        });
    }
});

router.get('/super-admin/stores', authMiddleware, authorize('super_admin'), async (req, res) => {
    try {
        const stores = await db.query(
            `SELECT
                t.tenant_id,
                t.business_name,
                t.owner_name,
                t.owner_email,
                t.created_at,
                admin.username AS admin_username,
                admin.email AS admin_email
             FROM pos_tenants t
             LEFT JOIN users admin
                ON admin.tenant_id = t.tenant_id
                AND admin.user_type = 'admin'
                AND admin.is_active = 1
             ORDER BY t.created_at DESC`
        );

        res.json({
            success: true,
            totalStores: stores.length,
            stores
        });
    } catch (error) {
        console.error('Get stores error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching stores'
        });
    }
});

router.post('/super-admin/stores/:tenantId/resend-admin-credentials', authMiddleware, authorize('super_admin'), async (req, res) => {
    try {
        const { tenantId } = req.params;

        const stores = await db.query(
            `SELECT
                t.business_name,
                t.owner_name,
                t.owner_email,
                admin.user_id,
                admin.username,
                admin.email
             FROM pos_tenants t
             INNER JOIN users admin
                ON admin.tenant_id = t.tenant_id
                AND admin.user_type = 'admin'
             WHERE t.tenant_id = ?
             LIMIT 1`,
            [tenantId]
        );

        if (stores.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        const store = stores[0];
        const temporaryPassword = generatePassword();
        const passwordHash = await bcrypt.hash(temporaryPassword, 10);

        await db.query(
            'UPDATE users SET password_hash = ? WHERE user_id = ?',
            [passwordHash, store.user_id]
        );

        await sendCredentialsEmail({
            name: store.owner_name,
            email: store.admin_email || store.owner_email,
            businessName: store.business_name,
            username: store.username,
            password: temporaryPassword,
            accountLabel: 'admin'
        });

        res.json({
            success: true,
            message: 'Admin credentials resent successfully'
        });
    } catch (error) {
        console.error('Resend admin credentials error:', error);
        res.status(500).json({
            success: false,
            message: 'Error resending admin credentials'
        });
    }
});

router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const users = await db.query(
            'SELECT user_id, full_name, email FROM users WHERE email = ? AND is_active = 1',
            [email]
        );

        // Always return success to prevent email enumeration
        if (!users || users.length === 0) {
            return res.json({
                success: true,
                message: 'If an account with that email exists, a reset link has been sent.'
            });
        }

        const user = users[0];

        // Invalidate any existing unused tokens for this user
        await db.query(
            'UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0',
            [user.user_id]
        );

        // Generate a secure token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.query(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
            [user.user_id, resetToken, expiresAt]
        );

        const resetUrl = `${process.env.FRONTEND_URL || 'https://intelli-posui.vercel.app'}/?token=${resetToken}`;

        await sendPasswordResetEmail({
            name: user.full_name,
            email: user.email,
            resetUrl
        });

        res.json({
            success: true,
            message: 'If an account with that email exists, a reset link has been sent.'
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Token and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        const tokens = await db.query(
            'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0',
            [token]
        );

        if (!tokens || tokens.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token'
            });
        }

        const resetRecord = tokens[0];

        // Check expiry
        if (new Date(resetRecord.expires_at) < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Reset token has expired. Please request a new one.'
            });
        }

        // Hash new password and update
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await db.query(
            'UPDATE users SET password_hash = ? WHERE user_id = ?',
            [hashedPassword, resetRecord.user_id]
        );

        // Mark token as used
        await db.query(
            'UPDATE password_reset_tokens SET used = 1 WHERE id = ?',
            [resetRecord.id]
        );

        res.json({
            success: true,
            message: 'Password has been reset successfully. You can now login with your new password.'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;
