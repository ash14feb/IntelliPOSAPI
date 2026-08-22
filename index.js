const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

// Import routes
const authRoutes = require('./api/auth');
const salesRoutes = require('./api/sales');
const attendanceRoutes = require('./api/attendance');
const cashRoutes = require('./api/cash');
const expensesRoutes = require('./api/expenses');
const problemsRoutes = require('./api/problems');
const reportsRoutes = require('./api/reports');
const mosquesRoutes = require('./api/mosques');
const arcadeRoutes = require('./api/arcadepayment');
const posRoutes = require('./api/pos');
const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Store Sales API',
    version: '1.0.0',
    status: 'running'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/cash', cashRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/problems', problemsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/mosques', mosquesRoutes);
app.use('/api/arcadepayment', arcadeRoutes);
app.use('/api/pos', posRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Something went wrong!',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 3000;

// For Vercel deployment
module.exports = app;

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
