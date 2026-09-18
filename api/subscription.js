const express = require('express');
const db = require('../utils/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Free trial: 168 hours (7 days) from the moment the business registers.
const TRIAL_HOURS = 168;

async function ensureTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS pos_subscriptions (
            subscription_id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            plan VARCHAR(20) NOT NULL DEFAULT '1YR',
            starts_at DATETIME NOT NULL,
            ends_at DATETIME NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_pos_subscriptions_tenant (tenant_id)
        )
    `);
}

async function getStatus(tenantId) {
    await ensureTable();
    const tenants = await db.query(
        'SELECT tenant_id, business_name, created_at FROM pos_tenants WHERE tenant_id = ? LIMIT 1',
        [tenantId]
    );
    if (!tenants || tenants.length === 0) {
        return { access: true, subscribed: false, trial: false, reason: 'no-tenant' };
    }
    const registeredAt = new Date(tenants[0].created_at).getTime();
    const trialEndsAt = registeredAt + TRIAL_HOURS * 3600 * 1000;

    const subs = await db.query(
        'SELECT * FROM pos_subscriptions WHERE tenant_id = ? AND ends_at > NOW() ORDER BY ends_at DESC LIMIT 1',
        [tenantId]
    );
    const sub = subs && subs[0];
    const now = Date.now();
    const trialActive = now < trialEndsAt;
    const subscribed = !!sub;
    return {
        access: subscribed || trialActive,
        subscribed,
        trial: trialActive && !subscribed,
        expired: !subscribed && !trialActive,
        trialEndsAt: new Date(trialEndsAt).toISOString(),
        trialHoursLeft: Math.max(0, Math.ceil((trialEndsAt - now) / 3600000)),
        trialDaysLeft: Math.max(0, Math.ceil((trialEndsAt - now) / 86400000)),
        plan: sub?.plan || null,
        subscriptionEndsAt: sub ? new Date(sub.ends_at).toISOString() : null,
    };
}

// Super admin (tenant 0) bypasses trial checks.
function isSuperAdmin(req) {
    return req.user && (req.user.user_type === 'super_admin' || Number(req.user.tenant_id) === 0);
}

router.get('/status', authMiddleware, async (req, res) => {
    try {
        if (isSuperAdmin(req)) {
            return res.json({ success: true, access: true, subscribed: true, trial: false, expired: false, superAdmin: true });
        }
        res.json({ success: true, ...(await getStatus(req.user.tenant_id)) });
    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/subscribe', authMiddleware, async (req, res) => {
    try {
        if (isSuperAdmin(req)) {
            return res.json({ success: true, message: 'Super admin needs no subscription' });
        }
        const { plan } = req.body;
        if (!['1YR', '3YR'].includes(plan)) {
            return res.status(400).json({ success: false, message: 'plan must be 1YR or 3YR' });
        }
        await ensureTable();
        const years = plan === '3YR' ? 3 : 1;
        // Extend from the later of now / current expiry so renewals stack.
        const existing = await db.query(
            'SELECT ends_at FROM pos_subscriptions WHERE tenant_id = ? AND ends_at > NOW() ORDER BY ends_at DESC LIMIT 1',
            [req.user.tenant_id]
        );
        const base = existing && existing[0] ? new Date(existing[0].ends_at).getTime() : Date.now();
        const startsAt = new Date(base);
        const endsAt = new Date(base);
        endsAt.setFullYear(endsAt.getFullYear() + years);
        await db.query(
            'INSERT INTO pos_subscriptions (tenant_id, plan, starts_at, ends_at) VALUES (?, ?, ?, ?)',
            [req.user.tenant_id, plan, startsAt, endsAt]
        );
        res.status(201).json({
            success: true,
            message: 'Subscription activated',
            ...(await getStatus(req.user.tenant_id)),
        });
    } catch (error) {
        console.error('Subscribe error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
module.exports.getStatus = getStatus;
