const express = require('express');
const router = express.Router();
const db = require('../utils/dbarcade'); // your mysql2 pool

router.post('/date-range', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const query = `
            SELECT *
            FROM es_payment
            WHERE DATE(created_at) BETWEEN ? AND ?
              AND is_deleted = 'NO'
            ORDER BY created_at DESC
        `;

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const rows = await db.query(query, [fromDateTime, toDateTime]);
        console.log("Rows length:", rows.length);
        console.log("Rows:", rows);
        res.json({
            success: true,
            count: rows.length,
            data: rows
        });

    } catch (error) {
        console.error("ArcadePayment date range error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

router.post('/date-range-summary', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        // 1️⃣ Total transactions + total sales
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_customers,
                IFNULL(SUM(recharge_amount),0) as total_sales
            FROM es_payment
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
        `;

        // 2️⃣ Recharge amount grouping
        const groupingQuery = `
            SELECT 
                recharge_amount,
                COUNT(*) as customer_count
            FROM es_payment
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
            GROUP BY recharge_amount
            ORDER BY recharge_amount ASC
        `;

        // 3️⃣ Detailed transaction list
        const detailsQuery = `
            SELECT 
                name,
                recharge_amount,
                created_at
            FROM es_payment
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
            ORDER BY created_at DESC
        `;

        // Proper destructuring
        const summaryRows = await db.query(summaryQuery, [fromDateTime, toDateTime]);
        const groupingRows = await db.query(groupingQuery, [fromDateTime, toDateTime]);
        const detailsRows = await db.query(detailsQuery, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            summary: summaryRows[0],
            recharge_breakdown: groupingRows,
            transactions: detailsRows
        });

    } catch (error) {
        console.error("ArcadePayment summary error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

router.post('/time-analysis', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const hourlyQuery = `
            SELECT 
                HOUR(created_at) as hour,
                COUNT(*) as customer_count
            FROM es_payment
            WHERE created_at >= ?
              AND created_at <= ?
              AND is_deleted = 'NO'
              AND HOUR(created_at) BETWEEN 10 AND 23
            GROUP BY HOUR(created_at)
            ORDER BY hour ASC
        `;

        const hourlyData = await db.query(hourlyQuery, [fromDateTime, toDateTime]);

        // Build only business hours (10–23)
        let businessHours = [];
        for (let i = 10; i <= 23; i++) {
            const found = hourlyData.find(h => h.hour === i);
            businessHours.push({
                hour: i,
                customer_count: found ? found.customer_count : 0
            });
        }

        // Peak hour
        const peak = businessHours.reduce((max, curr) =>
            curr.customer_count > max.customer_count ? curr : max
        );

        // Dry hours
        const dryHours = businessHours
            .filter(h => h.customer_count === 0)
            .map(h => h.hour);

        res.json({
            success: true,
            peak_hour: peak,
            dry_hours: dryHours,
            hourly_distribution: businessHours
        });

    } catch (error) {
        console.error("Time analysis error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

router.post('/refund-report', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const summaryQuery = `
            SELECT 
                COUNT(*) as total_refunds,
                IFNULL(SUM(amount),0) as total_refund_amount
            FROM es_billing
            WHERE is_refund = 'YES'
              AND refund_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
        `;

        const detailsQuery = `
            SELECT 
                id,
                name,
                log_game,
                amount,
                refund_at,
                refund_by
            FROM es_billing
            WHERE is_refund = 'YES'
              AND refund_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
            ORDER BY refund_at DESC
        `;

        const summary = await db.query(summaryQuery, [fromDateTime, toDateTime]);
        const details = await db.query(detailsQuery, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            summary: summary[0],
            data: details
        });

    } catch (error) {
        console.error("Refund report error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post('/game-wise-report', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const query = `
            SELECT 
                log_game,
                COUNT(*) as total_plays,
                IFNULL(SUM(amount),0) as total_revenue,
                IFNULL(SUM(token_earn),0) as total_tokens
            FROM es_billing
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
              AND is_refund = 'NO'
            GROUP BY log_game
            ORDER BY total_revenue DESC
        `;

        const rows = await db.query(query, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            count: rows.length,
            data: rows
        });

    } catch (error) {
        console.error("Game-wise report error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post('/top-games', async (req, res) => {
    try {
        const { from_date, to_date, limit = 5 } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        // ✅ Force limit to be safe integer
        const safeLimit = parseInt(limit) || 5;

        const query = `
            SELECT 
                log_game,
                COUNT(*) as plays
            FROM es_billing
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
              AND is_refund = 'NO'
            GROUP BY log_game
            ORDER BY plays DESC
            LIMIT ${safeLimit}
        `;

        const rows = await db.query(query, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error("Top games error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

router.post('/device-report', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const query = `
            SELECT 
                log_device_ip,
                COUNT(*) as total_plays,
                IFNULL(SUM(amount),0) as total_revenue
            FROM es_billing
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
              AND is_refund = 'NO'
            GROUP BY log_device_ip
            ORDER BY total_revenue DESC
        `;

        const rows = await db.query(query, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error("Device report error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});


router.post('/summary-report', async (req, res) => {
    try {
        const { from_date, to_date } = req.body;

        if (!from_date || !to_date) {
            return res.status(400).json({
                success: false,
                message: "from_date and to_date are required"
            });
        }

        const fromDateTime = from_date + " 00:00:00";
        const toDateTime = to_date + " 23:59:59";

        const query = `
            SELECT
                COUNT(*) as total_plays,
                IFNULL(SUM(amount),0) as total_revenue,
                IFNULL(SUM(customer_main_amount_used),0) as main_amount_used,
                IFNULL(SUM(customer_bonus_amount_used),0) as bonus_amount_used
            FROM es_billing
            WHERE created_at BETWEEN ? AND ?
              AND is_deleted = 'NO'
              AND is_refund = 'NO'
        `;

        const rows = await db.query(query, [fromDateTime, toDateTime]);

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error("Summary report error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
module.exports = router;