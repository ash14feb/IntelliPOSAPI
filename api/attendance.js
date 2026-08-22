const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authMiddleware, authorize } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(authMiddleware);

// @route   POST /api/attendance/clock-in
// @desc    Clock in for attendance
// @access  Private (Staff, Manager, Admin)
router.post('/clock-in', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { store_id, latitude, longitude, login_time } = req.body;
        const user_id = req.user.user_id;

        // Check if user is already clocked in today
        const today = login_time.split('T')[0];
        const existingAttendance = await db.query(
            'SELECT * FROM staff_attendance WHERE user_id = ? AND attendance_date = ? AND logout_time IS NULL',
            [user_id, today]
        );

        if (existingAttendance.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'You are already clocked in for today'
            });
        }

        // Clock in
        const result = await db.query(
            `INSERT INTO staff_attendance (
        user_id, store_id, login_latitude, login_longitude,login_time
      ) VALUES (?, ?, ?, ?,?)`,
            [user_id, store_id, latitude, longitude, login_time]
        );

        // Get store info
        const [stores] = await db.query(
            'SELECT store_name FROM stores WHERE store_id = ?',
            [store_id]
        );

        res.status(201).json({
            success: true,
            message: 'Clocked in successfully',
            attendance_id: result.insertId,
            store_name: stores[0]?.store_name,
            login_time: login_time
        });
    } catch (error) {
        console.error('Clock in error:', error);
        res.status(500).json({
            success: false,
            message: 'Error clocking in'
        });
    }
});

// @route   POST /api/attendance/clock-out
// @desc    Clock out for attendance
// @access  Private (Staff, Manager, Admin)
router.post('/clock-out', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const { latitude, longitude, date, logout_time } = req.body;
        const user_id = req.user.user_id;
        const today = date;

        // Find today's active attendance
        const attendance = await db.query(
            'SELECT * FROM staff_attendance WHERE user_id = ? AND attendance_date = ? AND logout_time IS NULL',
            [user_id, today]
        );

        if (attendance.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No active attendance found for today'
            });
        }

        const attendanceRecord = attendance[0];
        const loginTime = new Date(attendanceRecord.login_time);
        const logoutTime = logout_time;

        // Calculate work duration in minutes
        const workDurationMinutes = Math.round((logoutTime - loginTime) / (1000 * 60));

        // Update attendance with clock out        work_duration_minutes = ?
        await db.query(
            `UPDATE staff_attendance SET
        logout_time = ?,
        logout_latitude = ?,
        logout_longitude = ?
        WHERE attendance_id = ?`,
            [logoutTime, latitude, longitude, attendanceRecord.attendance_id]
        );

        res.json({
            success: true,
            message: 'Clocked out successfully',
            login_time: loginTime,
            logout_time: logoutTime,
            work_duration_minutes: workDurationMinutes,
            work_duration_hours: (workDurationMinutes / 60).toFixed(2)
        });
    } catch (error) {
        console.error('Clock out error:', error);
        res.status(500).json({
            success: false,
            message: 'Error clocking out'
        });
    }
});

// @route   GET /api/attendance/status
// @desc    Get attendance status for a specific date (defaults to today)
// @access  Private (Staff, Manager, Admin)
router.get('/status', authorize('staff', 'manager', 'admin'), async (req, res) => {
    try {
        const user_id = req.user.user_id;

        // Get date from query parameter, default to today
        let date = req.query.date;

        if (!date) {
            // Default to today if no date provided
            return res.status(400).json({
                success: false,
                message: 'Invalid date'
            });
        } else {
            // Validate date format (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date format. Please use YYYY-MM-DD'
                });
            }

            // Additional validation to ensure it's a valid date
            const parsedDate = new Date(date);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date provided'
                });
            }
        }

        const attendance = await db.query(
            `SELECT
        a.*,
        s.store_name,
        u.full_name,
        DATE_FORMAT(a.login_time, '%Y-%m-%d %H:%i:%s') as login_time_local,
        DATE_FORMAT(a.logout_time, '%Y-%m-%d %H:%i:%s') as logout_time_local,
        DATE_FORMAT(a.attendance_date, '%Y-%m-%d') as attendance_date_local
      FROM staff_attendance a
      JOIN stores s ON a.store_id = s.store_id
      JOIN users u ON a.user_id = u.user_id
      WHERE a.user_id = ? AND a.attendance_date = ?`,
            [user_id, date]
        );

        res.json({
            success: true,
            date: date,
            attendance: attendance.length > 0 ? attendance[0] : null,
            status: attendance.length > 0
                ? (attendance[0].logout_time ? 'clocked_out' : 'clocked_in')
                : 'not_clocked_in'
        });
    } catch (error) {
        console.error('Get attendance error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching attendance'
        });
    }
});
// @route   GET /api/attendance
// @desc    Get attendance records with filters
// @access  Private (Manager, Admin)
router.get('/', authorize('manager', 'admin','staff'), async (req, res) => {
    try {
        const {
            user_id,
            store_id,
            start_date,
            end_date
        } = req.query;

        let query = `
      SELECT 
        a.*,
        s.store_name,
        u.full_name,
        u.username,
        DATE_FORMAT(a.login_time, '%Y-%m-%d %H:%i:%s') as login_time_formatted,
        DATE_FORMAT(a.logout_time, '%Y-%m-%d %H:%i:%s') as logout_time_formatted,
        DATE_FORMAT(a.attendance_date, '%Y-%m-%d') as attendance_date_formatted
      FROM staff_attendance a
      JOIN stores s ON a.store_id = s.store_id
      JOIN users u ON a.user_id = u.user_id
      WHERE 1=1
    `;

        const params = [];

        if (user_id) {
            query += ' AND a.user_id = ?';
            params.push(user_id);
        }

        if (store_id) {
            query += ' AND a.store_id = ?';
            params.push(store_id);
        }

        if (start_date) {
            query += ' AND a.attendance_date >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND a.attendance_date <= ?';
            params.push(end_date);
        }

        query += ' ORDER BY a.attendance_date DESC, a.login_time DESC';

        const attendance = await db.query(query, params);

        // Format the response data
        const formattedData = attendance.map(record => ({
            attendance_id: record.attendance_id,
            user_id: record.user_id,
            store_id: record.store_id,
            login_time: record.login_time_formatted || record.login_time,
            logout_time: record.logout_time_formatted || record.logout_time,
            login_latitude: record.login_latitude,
            login_longitude: record.login_longitude,
            logout_latitude: record.logout_latitude,
            logout_longitude: record.logout_longitude,
            work_duration_minutes: record.work_duration_minutes,
            attendance_date: record.attendance_date_formatted || record.attendance_date,
            store_name: record.store_name,
            full_name: record.full_name,
            username: record.username
        }));

        res.json({
            success: true,
            data: formattedData,
            count: formattedData.length
        });
    } catch (error) {
        console.error('Get attendance records error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching attendance records'
        });
    }
});

// @route   GET /api/attendance/summary
// @desc    Get attendance summary in matrix format for reporting
// @access  Private (Manager, Admin)
router.get('/summary', authorize('manager', 'admin','staff'), async (req, res) => {
    try {
        const { store_id, start_date, end_date, user_id } = req.query;

        // Validate required parameters
        if (!start_date || !end_date) {
            return res.status(400).json({
                success: false,
                message: 'start_date and end_date are required parameters'
            });
        }

        // Generate all dates between start and end (INCLUSIVE)
        const dateList = [];
        const currentDate = new Date(start_date);

        // Set endDate to end of day to ensure inclusion
        const endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999); // Set to end of day

        // FIX: Use <= comparison and handle timezone issues
        const endDateOnly = new Date(end_date); // For comparison without time

        while (currentDate <= endDateOnly) {
            dateList.push(currentDate.toISOString().split('T')[0]);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Get all users first
        let usersQuery = `
            SELECT user_id, full_name, username 
            FROM users 
            WHERE user_type IN ('staff', 'manager')
        `;
        let usersParams = [];

        if (store_id) {
            usersQuery += ' AND user_id IN (SELECT user_id FROM user_stores WHERE store_id = ?)';
            usersParams.push(store_id);
        }

        usersQuery += ' ORDER BY full_name';

        const usersResult = await db.query(usersQuery, usersParams);
        const users = Array.isArray(usersResult) ? usersResult : (usersResult[0] || []);

        // Get attendance data with local time formatting
        let attendanceQuery = `
            SELECT 
                u.user_id,
                u.full_name,
                u.username,
                DATE(a.attendance_date) as attendance_date,
                -- Format times to local format (YYYY-MM-DD HH:MM:SS)
                DATE_FORMAT(a.login_time, '%Y-%m-%d %H:%i:%s') as login_time_local,
                DATE_FORMAT(a.logout_time, '%Y-%m-%d %H:%i:%s') as logout_time_local,
                a.attendance_id,
                CASE 
                    WHEN a.logout_time IS NOT NULL 
                    THEN TIMESTAMPDIFF(MINUTE, a.login_time, a.logout_time)
                    ELSE 0 
                END as work_duration_minutes
            FROM users u
            LEFT JOIN staff_attendance a ON u.user_id = a.user_id 
                AND DATE(a.attendance_date) BETWEEN ? AND ?
            WHERE u.user_type IN ('staff', 'manager')
                AND DATE(a.attendance_date) IS NOT NULL
        `;

        let attendanceParams = [start_date, end_date];

        if (store_id) {
            attendanceQuery += ' AND u.user_id IN (SELECT user_id FROM user_stores WHERE store_id = ?)';
            attendanceParams.push(store_id);
        }

        if (user_id) {
            attendanceQuery += ' AND u.user_id = ?';
            attendanceParams.push(user_id);
        }

        attendanceQuery += ' ORDER BY u.full_name, a.attendance_date';

        const attendanceResult = await db.query(attendanceQuery, attendanceParams);
        const attendanceData = Array.isArray(attendanceResult) ? attendanceResult : (attendanceResult[0] || []);

        // Group attendance data by user_id and date
        const attendanceMap = {};
        attendanceData.forEach(record => {
            if (!record.user_id || !record.attendance_date) return;

            const userId = record.user_id;
            const date = record.attendance_date.toISOString ?
                record.attendance_date.toISOString().split('T')[0] :
                String(record.attendance_date);

            if (!attendanceMap[userId]) {
                attendanceMap[userId] = {};
            }

            const workMinutes = record.work_duration_minutes || 0;
            const hours = workMinutes / 60;

            let status = 'absent';
            let color = 'red';

            if (record.attendance_id) {
                if (record.logout_time_local) {
                    if (hours >= 9) {
                        status = 'present';
                        color = 'green';
                    } else if (hours >= 8) {
                        status = 'short_hours';
                        color = 'orange';
                    } else if (hours > 0) {
                        status = 'very_short';
                        color = 'red';
                    } else {
                        status = 'clocked_in_only';
                        color = 'yellow';
                    }
                } else {
                    status = 'clocked_in_only';
                    color = 'yellow';
                }
            }

            attendanceMap[userId][date] = {
                status,
                hours: parseFloat(hours.toFixed(2)),
                minutes: workMinutes,
                color,
                attendance_id: record.attendance_id,
                login_time: record.login_time_local || record.login_time, // Use local format
                logout_time: record.logout_time_local || record.logout_time // Use local format
            };
        });

        // Build response
        const result = users.map(user => {
            const dateData = dateList.map(date => {
                const dayData = attendanceMap[user.user_id] && attendanceMap[user.user_id][date] ?
                    attendanceMap[user.user_id][date] : {
                        status: 'absent',
                        hours: 0,
                        minutes: 0,
                        color: 'red',
                        attendance_id: null,
                        login_time: null,
                        logout_time: null
                    };

                return {
                    date,
                    status: dayData.status,
                    hours: dayData.hours,
                    color: dayData.color,
                    attendance_id: dayData.attendance_id,
                    login_time: dayData.login_time,
                    logout_time: dayData.logout_time
                };
            });

            // Calculate summary
            let presentDays = 0;
            let totalHours = 0;
            let missingHours = 0;

            dateData.forEach(day => {
                if (day.status !== 'absent') {
                    presentDays++;
                    totalHours += day.hours;
                    if (day.hours > 0 && day.hours < 9) {
                        missingHours += (9 - day.hours);
                    }
                }
            });

            const averageHours = presentDays > 0 ? (totalHours / presentDays).toFixed(2) : 0;

            return {
                user_id: user.user_id,
                full_name: user.full_name,
                username: user.username,
                dates: dateData,
                summary: {
                    present_days: presentDays,
                    total_hours: parseFloat(totalHours.toFixed(2)),
                    missing_hours: parseFloat(missingHours.toFixed(2)),
                    average_hours: parseFloat(averageHours),
                    total_days: dateList.length,
                    absent_days: dateList.length - presentDays
                }
            };
        });

        res.json({
            success: true,
            data: result,
            columns: dateList,
            meta: {
                start_date,
                end_date,
                total_days: dateList.length,
                total_employees: result.length,
                store_id: store_id || 'all'
            }
        });

    } catch (error) {
        console.error('Get attendance summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching attendance summary'
        });
    }
});
module.exports = router;